/**
 * The Kru Bot box: the computer every bot works on. A small HTTP server
 * that the Kru Bot API drives. Each bot gets its own home under BOTS_DIR
 * (the agent user's ~/.bots/<id>), where its Claude Code session runs, and
 * where it keeps its MEMORY.md, notes and scripts between turns. Everything
 * a bot runs happens as the unprivileged `agent` user; this server runs as
 * root only so it can drop to that user.
 *
 * Bots run on persistent CLI sessions: Claude Code (agents.mjs), OpenAI
 * Codex (codex.mjs) or Grok Build (grok.mjs), one process per bot and
 * thread, kept across turns, with Kru Bot's tools and its permission
 * prompts reaching the API over the `kru` MCP bridge (bridge.mjs).
 *
 * People get the same computer: interactive terminals (PTYs, via node-pty)
 * and a desktop, a GNOME session on a VNC server bound to loopback,
 * bridged to the browser over the HTTP API (VNC bytes out as server-sent
 * events, input back as POSTs).
 *
 * The API authenticates with a bearer token that is read from BOX_TOKEN or
 * generated once into STATE_DIR/token.
 */
import { spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import { createServer } from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkClaude } from "./claude.mjs";
import { AgentSession, PERMISSION_MODES, authStatus, forgetClaudeVersion, parseAccess } from "./agents.mjs";
import { CODEX_BIN, CodexSession } from "./codex.mjs";
import { GROK_BIN, GrokSession } from "./grok.mjs";

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "0.0.0.0";
const STATE_DIR = process.env.STATE_DIR || "/state";
/** The user commands run as; the bots' homes belong to it. */
const AGENT_UID = Number(process.env.AGENT_UID || 1001);
const AGENT_GID = Number(process.env.AGENT_GID || 1001);
const AGENT_HOME = process.env.AGENT_HOME || "/home/agent";
/**
 * Package caches, kept on a volume so installs come from disk instead of
 * the network. Every package manager is pointed here.
 */
const CACHE_DIR = process.env.CACHE_DIR || path.join(AGENT_HOME, ".cache");
/**
 * Where the Claude Code CLI keeps its login and settings, on a volume so a
 * sign-in survives restarts. The box never reads what's in it.
 */
const CLAUDE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(AGENT_HOME, ".claude");
/** Codex's and Grok's homes: their sign-ins, sessions and config, on the home volume. */
const CODEX_HOME = process.env.CODEX_HOME || path.join(AGENT_HOME, ".codex");
const GROK_HOME = process.env.GROK_HOME || path.join(AGENT_HOME, ".grok");
/** Where the CLIs keep a person's sign-in: never readable through the files API. */
const LOGIN_DIRS = [CLAUDE_CONFIG_DIR, CODEX_HOME, GROK_HOME];
/** Where every bot has its home: BOTS_DIR/<bot id>. On a volume. */
const BOTS_DIR = process.env.BOTS_DIR || path.join(AGENT_HOME, ".bots");
/** The team's shared space and the skills library mirror. Hidden, like the bots' homes, so the home looks like a person's. */
const TEAM_DIR = path.join(AGENT_HOME, ".team");
const SKILLS_DIR = path.join(AGENT_HOME, ".skills");
/** Unix sockets the bots' MCP bridge connects to, one per session. */
const AGENT_SOCKET_DIR = process.env.AGENT_SOCKET_DIR || "/tmp/kru-agents";
/** The bridge script Claude Code launches as the `kru` MCP server. */
const KRU_MCP_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "kru-mcp.mjs");
/** Longest one bot turn may take before it is interrupted. */
const MAX_AGENT_TURN_MS = 60 * 60 * 1000;
const ID = /^[A-Za-z0-9_-]{1,64}$/;
/** Group that may read the generated token file: the API's uid 1000 `node` user. */
const TOKEN_READER_GID = Number(process.env.TOKEN_READER_GID || 1000);

export const MAX_OUTPUT = 64 * 1024;
export const MAX_FILE_BYTES = 1024 * 1024;
/** Largest file a bot can hand the person in the chat. */
export const MAX_SHARE_BYTES = 25 * 1024 * 1024;
const MAX_BODY_BYTES = 4 * 1024 * 1024;
/** A bot's turn may carry the files attached in the chat. */
const MAX_TURN_BODY_BYTES = 16 * 1024 * 1024;
const DEFAULT_EXEC_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_EXEC_TIMEOUT_MS = 30 * 60 * 1000;
/** Scrollback replayed to a viewer who joins a stream late. */
const FEED_BYTES = 256 * 1024;
const MAX_TERMINALS = 8;
/** A terminal nobody is looking at is closed after this long. */
const TERMINAL_IDLE_MS = 30 * 60 * 1000;
const SSE_KEEPALIVE_MS = 15_000;

/** The X display and loopback VNC port the desktop runs on. */
const DESKTOP_DISPLAY = Number(process.env.DESKTOP_DISPLAY || 1);
const DESKTOP_VNC_PORT = Number(process.env.DESKTOP_VNC_PORT || 5901);
const DESKTOP_SCRIPT = process.env.DESKTOP_SCRIPT || path.join(path.dirname(fileURLToPath(import.meta.url)), "desktop.sh");
/** Per-user runtime dir for the session bus, dconf and friends. */
const RUNTIME_DIR = process.env.XDG_RUNTIME_DIR_AGENT || path.join(AGENT_HOME, ".run");
const MAX_DESKTOP_CONNECTIONS = 4;
/** How long the desktop gets to come up before a connection is refused. */
const DESKTOP_START_MS = 30_000;
/** A desktop nobody is looking at is stopped after this long. */
const DESKTOP_IDLE_MS = 2 * 60 * 60 * 1000;
/** A connection opened but never streamed is dropped after this long. */
const CONNECTION_CLAIM_MS = 30_000;
/** The script Settings → Computer → Update runs in the box (as root). */
const UPDATE_SCRIPT = process.env.UPDATE_SCRIPT || path.join(path.dirname(fileURLToPath(import.meta.url)), "update.sh");
/** Longest an in-place update may take before it is killed. */
const UPDATE_TIMEOUT_MS = 30 * 60 * 1000;
/** Log kept from an update, for the API to show. */
const UPDATE_LOG_BYTES = 64 * 1024;

/** Hands a path to the agent user; a no-op when the box isn't root (development). */
function own(target) {
  try {
    fs.chownSync(target, AGENT_UID, AGENT_GID);
  } catch {
    /* not root */
  }
}

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ---------- live feeds ----------

/**
 * An append-only event log with subscribers: recent events are replayed to
 * whoever joins, then new ones are pushed as they happen. Backs terminal
 * output.
 */
export class Feed {
  constructor(limit = FEED_BYTES) {
    this.limit = limit;
    this.lines = [];
    this.size = 0;
    this.subscribers = new Set();
    this.closed = false;
  }

  publish(event) {
    const line = JSON.stringify(event);
    this.lines.push(line);
    this.size += line.length;
    while (this.size > this.limit && this.lines.length > 1) {
      this.size -= this.lines.shift().length;
    }
    for (const send of this.subscribers) send(line);
  }

  /** Replays history to `send`, then keeps sending. Returns an unsubscribe. */
  subscribe(send) {
    for (const line of this.lines) send(line);
    if (this.closed) {
      send(JSON.stringify({ type: "end" }));
      return () => undefined;
    }
    this.subscribers.add(send);
    return () => this.subscribers.delete(send);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.publish({ type: "end" });
    this.subscribers.clear();
  }
}

function streamFeed(request, response, feed) {
  response.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  response.write(": connected\n\n");
  const send = (line) => response.write(`data: ${line}\n\n`);
  const unsubscribe = feed.subscribe(send);
  const keepalive = setInterval(() => response.write(": ping\n\n"), SSE_KEEPALIVE_MS);
  const stop = () => {
    clearInterval(keepalive);
    unsubscribe();
    response.end();
  };
  request.on("close", stop);
  if (feed.closed) stop();
  return stop;
}

// ---------- paths ----------

/**
 * Resolves a relative path inside `root`, or throws. Anything climbing out
 * of the root or touching .git is refused.
 */
export function inside(root, relative) {
  if (typeof relative !== "string" || !relative.trim()) throw new HttpError(400, "Missing path");
  const full = path.resolve(root, relative);
  if (full !== root && !full.startsWith(root + path.sep)) {
    throw new HttpError(400, "Path is outside the agent's home");
  }
  const parts = path.relative(root, full).split(path.sep);
  if (parts.some((part) => part.toLowerCase() === ".git")) {
    throw new HttpError(400, "Path is inside .git");
  }
  return full;
}

/**
 * Resolves a path inside the agent's home, for the bots' own use of the
 * box: anywhere under home except the CLIs' logins, and never .git.
 */
export function insideHome(relative, home = AGENT_HOME, forbidden = LOGIN_DIRS) {
  const full = inside(home, relative);
  for (const dir of Array.isArray(forbidden) ? forbidden : [forbidden]) {
    if (full === dir || full.startsWith(dir + path.sep)) throw new HttpError(400, "Path is inside a CLI's sign-in");
  }
  return full;
}

/**
 * insideHome for a file that is read: the path with its symlinks followed
 * must still be inside, so a link can't point a read at a sign-in or at
 * the rest of the machine.
 */
export function realInsideHome(relative, home = AGENT_HOME, forbidden = LOGIN_DIRS) {
  const full = insideHome(relative, home, forbidden);
  let real;
  try {
    real = fs.realpathSync(full);
  } catch {
    throw new HttpError(404, "No such file");
  }
  const realHome = fs.realpathSync(home);
  return insideHome(path.relative(realHome, real) || ".", realHome, (Array.isArray(forbidden) ? forbidden : [forbidden]).map((dir) => (fs.existsSync(dir) ? fs.realpathSync(dir) : dir)));
}

/**
 * The working directory for a command on the box: the agent's home, or a
 * folder under it. Absolute paths must stay inside.
 */
export function boxCwd(given, home = AGENT_HOME, forbidden = LOGIN_DIRS) {
  if (given === undefined || given === null || given === "") return home;
  if (typeof given !== "string") throw new HttpError(400, "cwd must be a string");
  const relative = path.isAbsolute(given) ? path.relative(home, given) || "." : given;
  if (relative.startsWith("..")) throw new HttpError(400, "cwd is outside the agent's home");
  return insideHome(relative, home, forbidden);
}

/** A bot's home folder, created as the agent user on first use. */
export function botDir(id) {
  if (!ID.test(id)) throw new HttpError(400, "Bad bot id");
  const dir = path.join(BOTS_DIR, id);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    own(dir);
  }
  return dir;
}

// ---------- processes ----------

/** uid/gid to drop to; none when the box isn't root (development). */
const asAgent = process.getuid?.() === 0 ? { uid: AGENT_UID, gid: AGENT_GID } : {};

function agentEnv(extra = {}) {
  return {
    PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    HOME: AGENT_HOME,
    USER: "agent",
    LANG: "C.UTF-8",
    TERM: "dumb",
    CI: "1",
    GIT_TERMINAL_PROMPT: "0",
    npm_config_update_notifier: "false",
    npm_config_fund: "false",
    XDG_CACHE_HOME: CACHE_DIR,
    BUN_INSTALL_CACHE_DIR: path.join(CACHE_DIR, "bun"),
    npm_config_cache: path.join(CACHE_DIR, "npm"),
    npm_config_store_dir: path.join(CACHE_DIR, "pnpm"),
    YARN_CACHE_FOLDER: path.join(CACHE_DIR, "yarn"),
    PIP_CACHE_DIR: path.join(CACHE_DIR, "pip"),
    UV_CACHE_DIR: path.join(CACHE_DIR, "uv"),
    NEXT_TELEMETRY_DISABLED: "1",
    DO_NOT_TRACK: "1",
    // Shared by bots, terminals and the desktop, so one sign-in serves all.
    CLAUDE_CONFIG_DIR,
    CODEX_HOME,
    GROK_HOME,
    ...extra,
  };
}

/** Keeps the start and end of long output, which is where errors usually are. */
export function capOutput(text, limit = MAX_OUTPUT) {
  if (text.length <= limit) return { text, truncated: false };
  const head = Math.floor(limit / 4);
  const tail = limit - head;
  const dropped = text.length - head - tail;
  return {
    text: `${text.slice(0, head)}\n\n[… ${dropped} characters omitted …]\n\n${text.slice(-tail)}`,
    truncated: true,
  };
}

/**
 * Runs a command as the agent user in `cwd`, in its own process group so a
 * timeout kills everything it started. Resolves with the exit code and the
 * combined, capped output.
 */
export function runAsAgent(argv, { cwd, timeoutMs, env, onChunk }) {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), {
      cwd,
      env: agentEnv(env),
      ...asAgent,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks = [];
    let size = 0;
    const collect = (chunk) => {
      if (size < MAX_OUTPUT * 4) chunks.push(chunk);
      size += chunk.length;
      onChunk?.(chunk);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }, timeoutMs);

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const { text, truncated } = capOutput(Buffer.concat(chunks).toString("utf8"));
      resolve({
        exitCode: code ?? (signal ? 128 : 1),
        signal: signal ?? null,
        output: text,
        truncated,
        timedOut,
      });
    });
  });
}

// ---------- files ----------

function readFile(relative) {
  const full = realInsideHome(relative);
  let stat;
  try {
    stat = fs.statSync(full);
  } catch {
    throw new HttpError(404, "No such file");
  }
  if (stat.isDirectory()) {
    return { directory: fs.readdirSync(full).sort() };
  }
  if (stat.size > MAX_FILE_BYTES) throw new HttpError(413, "File is larger than 1 MB");
  const buffer = fs.readFileSync(full);
  if (buffer.includes(0)) return { binary: true, size: stat.size };
  return { content: buffer.toString("utf8"), size: stat.size };
}

/** A file's bytes, for a bot handing it to the person. */
function sendRawFile(response, relative) {
  const full = realInsideHome(relative);
  const stat = fs.statSync(full);
  if (!stat.isFile()) throw new HttpError(400, "That's a folder, not a file");
  if (stat.size > MAX_SHARE_BYTES) throw new HttpError(413, `File is larger than ${MAX_SHARE_BYTES / 1024 / 1024} MB`);
  const buffer = fs.readFileSync(full);
  response.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": buffer.byteLength });
  response.end(buffer);
  return STREAMED;
}

function writeFile(relative, content) {
  if (typeof content !== "string") throw new HttpError(400, "Content must be a string");
  if (Buffer.byteLength(content, "utf8") > MAX_FILE_BYTES) {
    throw new HttpError(413, "Content is larger than 1 MB");
  }
  const full = insideHome(relative);
  // Create parent folders as the agent so it can keep working in them.
  let parent = path.dirname(full);
  const created = [];
  while (!fs.existsSync(parent)) {
    created.push(parent);
    parent = path.dirname(parent);
  }
  for (const folder of created.reverse()) {
    fs.mkdirSync(folder);
    own(folder);
  }
  // Atomic: a crash mid-write leaves the old file intact.
  const tmp = `${full}.${randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, content, { mode: 0o600 });
  own(tmp);
  fs.renameSync(tmp, full);
  return { ok: true };
}

function deleteFile(relative) {
  const full = insideHome(relative);
  if (full === AGENT_HOME || full === BOTS_DIR) throw new HttpError(400, "Refusing to delete that folder");
  fs.rmSync(full, { recursive: true, force: true });
  return { ok: true };
}

// ---------- terminals ----------

const terminals = new Map();

/**
 * Where a terminal starts: a bot's home, or the agent's home. Never
 * anywhere else, so a stray path can't open a shell outside the agent's
 * home.
 */
export function terminalCwd(bot) {
  if (bot === undefined || bot === null || bot === "") return AGENT_HOME;
  return botDir(bot);
}

function terminalSize(body) {
  const cols = Math.min(Math.max(Math.floor(Number(body.cols)) || 80, 20), 500);
  const rows = Math.min(Math.max(Math.floor(Number(body.rows)) || 24, 5), 200);
  return { cols, rows };
}

async function createTerminal(body) {
  if (terminals.size >= MAX_TERMINALS) throw new HttpError(429, `At most ${MAX_TERMINALS} terminals at once`);
  const cwd = terminalCwd(body.bot);
  const { cols, rows } = terminalSize(body);
  // Loaded on demand: node-pty is native, and nothing else needs it.
  const { default: pty } = await import("node-pty");
  const id = randomBytes(8).toString("hex");
  const shell = pty.spawn("bash", ["-l"], {
    name: "xterm-256color",
    cols,
    rows,
    cwd,
    ...asAgent,
    env: agentEnv({ TERM: "xterm-256color", COLORTERM: "truecolor", SHELL: "/bin/bash" }),
  });
  const terminal = { id, shell, feed: new Feed(), viewers: 0, idle: null };
  terminals.set(id, terminal);
  shell.onData((data) => terminal.feed.publish({ data: Buffer.from(data).toString("base64") }));
  shell.onExit(({ exitCode }) => {
    terminal.feed.publish({ exit: exitCode });
    terminal.feed.close();
    terminals.delete(id);
  });
  touchTerminal(terminal);
  return { id, cwd };
}

function touchTerminal(terminal) {
  if (terminal.idle) clearTimeout(terminal.idle);
  terminal.idle = null;
  if (terminal.viewers === 0) {
    terminal.idle = setTimeout(() => closeTerminal(terminal.id), TERMINAL_IDLE_MS);
  }
}

function existingTerminal(id) {
  const terminal = terminals.get(id);
  if (!terminal) throw new HttpError(404, "No such terminal");
  return terminal;
}

function closeTerminal(id) {
  const terminal = terminals.get(id);
  if (!terminal) return { ok: true };
  terminals.delete(id);
  if (terminal.idle) clearTimeout(terminal.idle);
  try {
    terminal.shell.kill("SIGHUP");
  } catch {
    /* already gone */
  }
  terminal.feed.close();
  return { ok: true };
}

// ---------- desktop ----------

/**
 * One desktop per box: desktop.sh starts a VNC X server on loopback and a
 * GNOME session as the agent user, in its own process group. It starts when
 * someone opens it, keeps running while the panel is hidden, and stops after
 * a long idle or on request. Browsers never reach the VNC port; each viewer
 * gets a loopback TCP connection bridged over the HTTP API instead.
 */
let desktop = null;
const connections = new Map();

/** Clamps a requested desktop size to something an X server will accept. */
export function desktopSize(body) {
  const width = Math.min(Math.max(Math.floor(Number(body.width)) || 1280, 640), 4096);
  const height = Math.min(Math.max(Math.floor(Number(body.height)) || 800, 480), 4096);
  return { width, height };
}

/** Tries a TCP connect to the VNC port, resolving with the socket. */
function connectVnc() {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port: DESKTOP_VNC_PORT });
    socket.once("connect", () => {
      socket.removeAllListeners("error");
      resolve(socket);
    });
    socket.once("error", reject);
  });
}

function desktopStatus() {
  return {
    running: Boolean(desktop),
    ready: Boolean(desktop?.ready),
    width: desktop?.width ?? null,
    height: desktop?.height ?? null,
    viewers: connections.size,
  };
}

/** The system D-Bus the desktop needs; a container has none until this starts one. */
let systemBus = null;

/**
 * gnome-session aborts outright when it can't reach the system bus ("Failed
 * to connect to system bus ... aborting"), and a container has no init to
 * run one. So the box runs dbus-daemon itself, as root, the first time the
 * desktop is wanted, and keeps it for the container's life. Without the
 * daemon on the image (a dev checkout) the desktop is left to try anyway.
 */
function ensureSystemBus() {
  if (systemBus && systemBus.exitCode === null) return;
  if (process.getuid?.() !== 0) return;
  const runDir = "/run/dbus";
  try {
    fs.mkdirSync(runDir, { recursive: true });
    fs.rmSync(path.join(runDir, "pid"), { force: true });
  } catch (error) {
    console.warn(`[box] could not prepare ${runDir}: ${error.message}`);
    return;
  }
  const child = spawn("dbus-daemon", ["--system", "--nofork", "--nopidfile"], { stdio: ["ignore", "ignore", "pipe"] });
  let log = "";
  child.stderr.on("data", (chunk) => {
    log = (log + chunk.toString("utf8")).slice(-1000);
  });
  child.on("error", (error) => console.warn(`[box] system bus didn't start: ${error.message}`));
  child.on("exit", (code, signal) => {
    if (systemBus === child) systemBus = null;
    console.warn(`[box] system bus exited (${signal ?? code}): ${log.trim().slice(-300)}`);
  });
  systemBus = child;
}

/** Starts the desktop if it isn't running and waits until VNC answers. */
async function ensureDesktop(body = {}) {
  if (desktop) {
    await desktop.readyPromise;
    return desktopStatus();
  }
  const { width, height } = desktopSize(body);
  ensureSystemBus();
  fs.mkdirSync(RUNTIME_DIR, { recursive: true, mode: 0o700 });
  own(RUNTIME_DIR);
  const child = spawn("bash", [DESKTOP_SCRIPT], {
    cwd: AGENT_HOME,
    env: agentEnv({
      DISPLAY: `:${DESKTOP_DISPLAY}`,
      DESKTOP_VNC_PORT: String(DESKTOP_VNC_PORT),
      DESKTOP_WIDTH: String(width),
      DESKTOP_HEIGHT: String(height),
      XDG_RUNTIME_DIR: RUNTIME_DIR,
      XDG_CONFIG_HOME: path.join(AGENT_HOME, ".config"),
      XDG_DATA_HOME: path.join(AGENT_HOME, ".local", "share"),
    }),
    ...asAgent,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const started = { child, width, height, ready: false, idle: null, readyPromise: null };
  desktop = started;
  let log = "";
  const collect = (chunk) => {
    log = (log + chunk.toString("utf8")).slice(-4000);
  };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  child.on("exit", (code, signal) => {
    const unexpected = desktop === started;
    if (unexpected) desktop = null;
    if (started.idle) clearTimeout(started.idle);
    for (const connection of connections.values()) closeConnection(connection.id);
    if (unexpected) console.warn(`[box] desktop exited (${signal ?? code}): ${log.trim().slice(-500)}`);
  });
  child.on("error", (error) => console.error("[box] desktop failed to start", error));

  started.readyPromise = (async () => {
    const deadline = Date.now() + DESKTOP_START_MS;
    while (Date.now() < deadline) {
      if (desktop !== started) throw new HttpError(502, `The desktop didn't start: ${log.trim().slice(-300) || "no output"}`);
      try {
        const probe = await connectVnc();
        probe.destroy();
        started.ready = true;
        touchDesktop();
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    stopDesktop();
    throw new HttpError(504, "The desktop didn't start in time");
  })();
  await started.readyPromise;
  return desktopStatus();
}

function touchDesktop() {
  if (!desktop) return;
  if (desktop.idle) clearTimeout(desktop.idle);
  desktop.idle = null;
  if (connections.size === 0) desktop.idle = setTimeout(stopDesktop, DESKTOP_IDLE_MS);
}

function stopDesktop() {
  const current = desktop;
  desktop = null;
  for (const connection of connections.values()) closeConnection(connection.id);
  if (!current) return { ok: true };
  if (current.idle) clearTimeout(current.idle);
  try {
    process.kill(-current.child.pid, "SIGTERM");
  } catch {
    /* already gone */
  }
  const force = setTimeout(() => {
    try {
      process.kill(-current.child.pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }, 5000);
  current.child.once("exit", () => clearTimeout(force));
  return { ok: true };
}

/** Opens a loopback VNC connection for one viewer; the stream claims it. */
async function createConnection(body) {
  if (connections.size >= MAX_DESKTOP_CONNECTIONS) {
    throw new HttpError(429, `At most ${MAX_DESKTOP_CONNECTIONS} desktop viewers at once`);
  }
  await ensureDesktop(body);
  let socket;
  try {
    socket = await connectVnc();
  } catch (error) {
    throw new HttpError(502, `Could not reach the desktop's VNC server: ${error.message}`);
  }
  const id = randomBytes(8).toString("hex");
  const connection = { id, socket, response: null, claim: null };
  socket.pause();
  socket.on("error", () => closeConnection(id));
  socket.on("close", () => closeConnection(id));
  connection.claim = setTimeout(() => closeConnection(id), CONNECTION_CLAIM_MS);
  connections.set(id, connection);
  touchDesktop();
  return { id, width: desktop?.width ?? null, height: desktop?.height ?? null };
}

function existingConnection(id) {
  const connection = connections.get(id);
  if (!connection) throw new HttpError(404, "No such desktop connection");
  return connection;
}

function closeConnection(id) {
  const connection = connections.get(id);
  if (!connection) return { ok: true };
  connections.delete(id);
  if (connection.claim) clearTimeout(connection.claim);
  connection.socket.destroy();
  connection.response?.end();
  connection.response = null;
  touchDesktop();
  return { ok: true };
}

/**
 * Streams VNC bytes to one viewer as base64 server-sent events. Nothing is
 * replayed: a VNC connection is one stateful conversation, so when the
 * stream ends the connection ends with it.
 */
function streamConnection(request, response, connection) {
  if (connection.response) throw new HttpError(409, "That connection already has a viewer");
  if (connection.claim) clearTimeout(connection.claim);
  connection.claim = null;
  connection.response = response;
  response.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  response.write(": connected\n\n");
  const { socket } = connection;
  socket.on("data", (chunk) => {
    if (!response.write(`data: ${chunk.toString("base64")}\n\n`)) socket.pause();
  });
  response.on("drain", () => socket.resume());
  const keepalive = setInterval(() => response.write(": ping\n\n"), SSE_KEEPALIVE_MS);
  request.on("close", () => {
    clearInterval(keepalive);
    closeConnection(connection.id);
  });
  socket.resume();
}

async function desktopRoute(request, response, parts) {
  if (parts.length === 1) {
    if (request.method === "GET") return desktopStatus();
    if (request.method === "POST") return ensureDesktop(await readJson(request));
    if (request.method === "DELETE") return stopDesktop();
    throw new HttpError(404, "Not found");
  }
  if (parts[1] !== "connections") throw new HttpError(404, "Not found");
  const id = parts[2];
  const action = parts[3];
  if (request.method === "POST" && !id) return createConnection(await readJson(request));
  if (!id) throw new HttpError(404, "Not found");
  if (request.method === "DELETE" && !action) return closeConnection(id);
  const connection = existingConnection(id);
  if (request.method === "GET" && action === "stream") {
    streamConnection(request, response, connection);
    return STREAMED;
  }
  if (request.method === "POST" && action === "input") {
    const body = await readJson(request);
    if (typeof body.data !== "string") throw new HttpError(400, "Missing data");
    connection.socket.write(Buffer.from(body.data, "base64"));
    return { ok: true };
  }
  throw new HttpError(404, "Not found");
}

// ---------- auth ----------

function loadToken() {
  if (process.env.BOX_TOKEN) return process.env.BOX_TOKEN;
  const file = path.join(STATE_DIR, "token");
  try {
    const existing = fs.readFileSync(file, "utf8").trim();
    if (existing) return existing;
  } catch {
    /* generate below */
  }
  const token = randomBytes(32).toString("hex");
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(file, `${token}\n`, { mode: 0o640 });
  try {
    fs.chownSync(file, 0, TOKEN_READER_GID);
    fs.chmodSync(STATE_DIR, 0o750);
    fs.chownSync(STATE_DIR, 0, TOKEN_READER_GID);
  } catch (error) {
    console.warn(`[box] could not set token file ownership: ${error.message}`);
  }
  return token;
}

function authorized(request, token) {
  const header = request.headers.authorization ?? "";
  const given = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

// ---------- updates ----------

/**
 * An in-place update (Debian, Bun, Claude Code): the box pauses first,
 * closing every bot session, terminal and the desktop, then runs update.sh
 * as root and keeps its output for the API to show. While it runs, every
 * route that would use the computer answers 503. The API drives this from
 * Settings → Computer → Update, after pulling a newer image when it can.
 */
let update = null;

export function updateStatus() {
  if (!update) return { running: false };
  return {
    running: update.finishedAt === null,
    startedAt: update.startedAt,
    finishedAt: update.finishedAt,
    ok: update.ok,
    exitCode: update.exitCode,
    log: update.log,
  };
}

function refuseWhileUpdating() {
  if (update && update.finishedAt === null) throw new HttpError(503, "The computer is updating; try again in a few minutes.");
}

/** Stops everything that uses the computer, keeping the bots' sessions resumable. */
async function pauseEverything() {
  stopDesktop();
  for (const id of [...terminals.keys()]) closeTerminal(id);
  await Promise.allSettled([...agents.values()].map((agent) => agent.close({ keepSession: true })));
  agents.clear();
}

async function startUpdate() {
  if (update && update.finishedAt === null) throw new HttpError(409, "An update is already running");
  update = { startedAt: new Date().toISOString(), finishedAt: null, ok: null, exitCode: null, log: "" };
  const append = (text) => {
    update.log = (update.log + text).slice(-UPDATE_LOG_BYTES);
  };
  append("== Pausing the computer\n");
  await pauseEverything();
  append("Bots, terminals and the desktop are paused.\n");
  const child = spawn("bash", [UPDATE_SCRIPT], { env: { ...process.env, DEBIAN_FRONTEND: "noninteractive" }, stdio: ["ignore", "pipe", "pipe"] });
  const current = update;
  const timer = setTimeout(() => {
    append("\n== Timed out; stopping the update\n");
    child.kill("SIGKILL");
  }, UPDATE_TIMEOUT_MS);
  child.stdout.on("data", (chunk) => append(chunk.toString("utf8")));
  child.stderr.on("data", (chunk) => append(chunk.toString("utf8")));
  child.on("error", (error) => {
    clearTimeout(timer);
    append(`\nCould not run the update script: ${error.message}\n`);
    current.ok = false;
    current.exitCode = 1;
    current.finishedAt = new Date().toISOString();
  });
  child.on("close", (code, signal) => {
    clearTimeout(timer);
    current.exitCode = code ?? (signal ? 128 : 1);
    current.ok = current.exitCode === 0;
    current.finishedAt = new Date().toISOString();
    versionsCache = null;
    forgetClaudeVersion();
  });
  return { ok: true, startedAt: update.startedAt };
}

/**
 * Reset: the agent's home goes back to empty, except the bots' homes, the
 * team's shared files, the skills library and the Claude sign-in. Global
 * installs, dotfiles, browser profiles and caches go. The API rebuilds the
 * container afterwards when it can, so the image's own layer is fresh too.
 */
const RESET_KEEPS = new Set([path.basename(BOTS_DIR), path.basename(TEAM_DIR), path.basename(SKILLS_DIR), ...LOGIN_DIRS.map((dir) => path.basename(dir))]);

async function resetHome() {
  if (update && update.finishedAt === null) throw new HttpError(409, "An update is running");
  await pauseEverything();
  const removed = [];
  for (const entry of fs.readdirSync(AGENT_HOME)) {
    if (RESET_KEEPS.has(entry)) continue;
    const full = path.join(AGENT_HOME, entry);
    // A mounted volume can't be removed, only emptied.
    try {
      fs.rmSync(full, { recursive: true, force: true });
    } catch {
      for (const inner of fs.readdirSync(full)) fs.rmSync(path.join(full, inner), { recursive: true, force: true });
    }
    removed.push(entry);
  }
  for (const dir of [CACHE_DIR, RUNTIME_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
    own(dir);
  }
  versionsCache = null;
  return { ok: true, removed };
}

/**
 * Whether Codex and Grok are installed and signed in, for Settings and the
 * setup. Codex answers `codex login status`; Grok has no such command, so
 * its sign-in file's presence stands in (never its contents).
 */
async function enginesAuth() {
  const codex = await new Promise((resolve) => {
    if (!fs.existsSync(CODEX_HOME)) {
      commandVersion(CODEX_BIN, ["--version"]).then((version) => resolve({ installed: version !== null, loggedIn: false, detail: "Not logged in" }));
      return;
    }
    const child = spawn(CODEX_BIN, ["login", "status"], { env: agentEnv(), ...asAgent, stdio: ["ignore", "pipe", "pipe"] });
    const chunks = [];
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.stderr.on("data", (chunk) => chunks.push(chunk));
    const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ installed: false, loggedIn: false, detail: "Not installed" });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const lines = Buffer.concat(chunks).toString("utf8").split("\n").map((line) => line.trim()).filter((line) => line && !/^WARNING/.test(line));
      resolve({ installed: true, loggedIn: code === 0, detail: (lines.at(-1) ?? "").slice(0, 200) });
    });
  });
  const grokVersion = await commandVersion(GROK_BIN, ["--version"]);
  const grokSignedIn = fs.existsSync(path.join(GROK_HOME, "auth.json"));
  return { codex, grok: { installed: grokVersion !== null, loggedIn: grokSignedIn, detail: grokSignedIn ? "Signed in" : "Not signed in" } };
}

/** What runs here: reported under Settings → Computer. Cached for a while. */
let versionsCache = null;
const VERSIONS_CACHE_MS = 5 * 60 * 1000;

function commandVersion(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { env: agentEnv(), ...asAgent, stdio: ["ignore", "pipe", "ignore"] });
    const chunks = [];
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.on("error", () => resolve(null));
    child.on("close", () => resolve(Buffer.concat(chunks).toString("utf8").trim().split("\n")[0] || null));
  });
}

async function versions() {
  if (versionsCache && Date.now() - versionsCache.at < VERSIONS_CACHE_MS) return versionsCache.value;
  const [bun, claude, codex, grok] = await Promise.all([commandVersion("bun", ["--version"]), commandVersion("claude", ["--version"]), commandVersion(CODEX_BIN, ["--version"]), commandVersion(GROK_BIN, ["--version"])]);
  const value = { node: process.versions.node, bun, claude, codex, grok };
  versionsCache = { at: Date.now(), value };
  return value;
}

// ---------- http ----------

function readJson(request, maxBytes = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new HttpError(413, "Request body too large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new HttpError(400, "Body must be JSON"));
      }
    });
    request.on("error", reject);
  });
}

function send(response, status, body) {
  const json = JSON.stringify(body);
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(json),
  });
  response.end(json);
}

/** Streaming routes write the response themselves and return STREAMED. */
const STREAMED = Symbol("streamed");

// ---------- bots: persistent CLI sessions ----------

/** The CLIs a bot can run on, and the session class that drives each. */
export const ENGINES = { claude: AgentSession, codex: CodexSession, grok: GrokSession };
const ENGINE_BINS = { claude: "claude", codex: CODEX_BIN, grok: GROK_BIN };
/** Model ids are plain tokens (a provider's may carry a slash or colon), or empty for the CLI's default; anything else is refused before it reaches argv. */
export const MODEL_ID = /^[A-Za-z0-9._:/-]{0,120}$/;

/** @type {Map<string, AgentSession | CodexSession | GrokSession>} */
const agents = new Map();

/**
 * The session for one (bot, thread) pair on one engine. Its process runs
 * in the bot's home, so the CLI's own file tools and shell work there. A
 * switch of engine closes the old session: its memory lives in that CLI.
 */
async function agentFor(id, bot, engine = "claude") {
  if (!ID.test(id)) throw new HttpError(400, "Bad agent id");
  const cwd = botDir(bot);
  let agent = agents.get(id);
  if (agent && agent.engine !== engine) {
    agents.delete(id);
    await agent.close({ keepSession: false });
    agent = undefined;
  }
  if (!agent) {
    const Session = ENGINES[engine];
    agent = new Session({
      id,
      cwd,
      env: agentEnv(),
      ...asAgent,
      socketDir: AGENT_SOCKET_DIR,
      mcpScript: KRU_MCP_SCRIPT,
      logDir: path.join(BOTS_DIR, ".protocol"),
      onWarning: (text) => console.warn(`[box] ${id}: ${text}`),
    });
    agents.set(id, agent);
  }
  return agent;
}

/**
 * One turn of a bot's Claude Code session, streamed as server-sent events:
 * `init`, raw stream-json `line`s, `tool_call`s for the API to answer
 * through /agents/:id/tool-result (permission prompts arrive the same way,
 * as calls to the `permission` tool), and a final `result`. Closing the
 * response interrupts the turn. A refused resume is retried once on a fresh
 * session, reported with `recovered: true` so the API can replay context.
 */
async function agentTurnRoute(request, response, id) {
  const body = await readJson(request, MAX_TURN_BODY_BYTES);
  const engine = body.engine ?? "claude";
  if (!Object.hasOwn(ENGINES, engine)) throw new HttpError(400, "Unknown engine");
  // An empty model is the CLI's own default; Claude Code always gets one.
  if (typeof body.model !== "string" || !MODEL_ID.test(body.model) || (engine === "claude" && !body.model)) throw new HttpError(400, "Bad model id");
  if (typeof body.prompt !== "string" || !body.prompt.trim()) throw new HttpError(400, "Missing prompt");
  if (typeof body.bot !== "string" || !ID.test(body.bot)) throw new HttpError(400, "Bad bot id");
  const systemPrompt = typeof body.systemPrompt === "string" ? body.systemPrompt : "";
  const tools = Array.isArray(body.tools) ? body.tools.filter((tool) => tool && typeof tool.name === "string") : [];
  const effort = typeof body.effort === "string" && /^[a-z]+$/.test(body.effort) ? body.effort : null;
  const maxTurns = Number.isInteger(body.maxTurns) && body.maxTurns > 0 ? Math.min(body.maxTurns, 500) : null;
  const permission = PERMISSION_MODES.includes(body.permission) ? body.permission : "ask";
  const timeoutMs = Math.min(Math.max(Number(body.timeoutMs) || MAX_AGENT_TURN_MS, 1000), MAX_AGENT_TURN_MS);
  const images = Array.isArray(body.attachments) ? body.attachments : [];
  if (agents.get(id)?.turn) throw new HttpError(409, "This bot is already answering");
  const agent = await agentFor(id, body.bot, engine);

  response.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  response.write(": connected\n\n");
  const sendEvent = (event) => response.write(`data: ${JSON.stringify(event)}\n\n`);
  const keepalive = setInterval(() => response.write(": ping\n\n"), SSE_KEEPALIVE_MS);
  const stop = new AbortController();
  response.on("close", () => stop.abort());
  try {
    const settings = { model: body.model, effort, maxTurns, systemPrompt, tools, permission, mcpServers: Array.isArray(body.mcpServers) ? body.mcpServers : [], access: parseAccess(body.access) };
    let launch = await agent.ensure(settings);
    let result = await agent.turnWith({ prompt: body.prompt, images, timeoutMs, systemPrompt, onEvent: sendEvent, signal: stop.signal });
    let recovered = Boolean(launch.recovered);
    if (result.resumeFailed && !stop.signal.aborted) {
      await agent.close({ keepSession: false });
      launch = await agent.ensure(settings);
      recovered = true;
      result = await agent.turnWith({ prompt: body.prompt, images, timeoutMs, systemPrompt, onEvent: sendEvent, signal: stop.signal });
    }
    sendEvent({ type: "result", ...result, sessionId: agent.sessionId, launched: launch.launched, resumed: launch.resumed ?? false, recovered });
  } catch (error) {
    const missing = error.code === "ENOENT" || error.code === "EACCES";
    sendEvent({ type: "error", missing, message: missing ? `The ${ENGINE_BINS[engine]} CLI isn't installed in the box` : error.message });
  } finally {
    clearInterval(keepalive);
    response.end();
  }
  return STREAMED;
}

async function agentRoute(request, response, parts) {
  const id = parts[1];
  const action = parts[2];
  if (request.method === "GET" && !id) {
    return { agents: [...agents.values()].map((agent) => ({ id: agent.id, running: agent.running, busy: Boolean(agent.turn) })) };
  }
  if (!id) throw new HttpError(404, "Not found");
  if (request.method === "POST" && action === "turn") return agentTurnRoute(request, response, id);
  if (request.method === "POST" && action === "tool-result") {
    const body = await readJson(request);
    const agent = agents.get(id);
    if (!agent || typeof body.callId !== "string") throw new HttpError(404, "No such call");
    const content = typeof body.content === "string" ? body.content : JSON.stringify(body.content ?? "");
    if (!agent.answerTool(body.callId, { content, isError: Boolean(body.isError) })) throw new HttpError(404, "No such call");
    return { ok: true };
  }
  if (request.method === "POST" && action === "interrupt") {
    const agent = agents.get(id);
    if (agent?.turn) agent.kill();
    return { ok: true, interrupted: Boolean(agent?.turn) };
  }
  if (request.method === "DELETE" && !action) {
    const agent = agents.get(id);
    if (agent) {
      agents.delete(id);
      await agent.close({ keepSession: false });
    }
    return { ok: true };
  }
  throw new HttpError(404, "Not found");
}

async function terminalRoute(request, response, parts) {
  const id = parts[1];
  const action = parts[2];
  if (request.method === "POST" && !id) return createTerminal(await readJson(request));
  if (!id) throw new HttpError(404, "Not found");
  if (request.method === "DELETE" && !action) return closeTerminal(id);
  const terminal = existingTerminal(id);
  if (request.method === "GET" && action === "stream") {
    terminal.viewers += 1;
    touchTerminal(terminal);
    streamFeed(request, response, terminal.feed);
    request.on("close", () => {
      terminal.viewers -= 1;
      if (terminals.has(id)) touchTerminal(terminal);
    });
    return STREAMED;
  }
  if (request.method === "POST" && action === "input") {
    const body = await readJson(request);
    if (typeof body.data !== "string") throw new HttpError(400, "Missing data");
    terminal.shell.write(Buffer.from(body.data, "base64").toString("utf8"));
    return { ok: true };
  }
  if (request.method === "POST" && action === "resize") {
    const { cols, rows } = terminalSize(await readJson(request));
    terminal.shell.resize(cols, rows);
    return { ok: true };
  }
  throw new HttpError(404, "Not found");
}

async function route(request, response, url) {
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts[0] === "update") {
    if (request.method === "GET" && parts.length === 1) return updateStatus();
    if (request.method === "POST" && parts.length === 1) return startUpdate();
    throw new HttpError(404, "Not found");
  }
  if (request.method === "POST" && parts.length === 1 && parts[0] === "reset") return resetHome();
  if (request.method === "GET" && parts.length === 1 && parts[0] === "versions") return versions();
  // Reads of a bot's files still work while updating; anything that runs on the computer waits.
  if (parts[0] !== "files" && !(parts[0] === "agents" && request.method === "GET" && parts.length === 1)) refuseWhileUpdating();
  if (parts[0] === "terminals") return terminalRoute(request, response, parts);
  if (parts[0] === "desktop") return desktopRoute(request, response, parts);
  if (parts[0] === "agents") return agentRoute(request, response, parts);
  if (request.method === "GET" && parts.length === 2 && parts[0] === "claude" && parts[1] === "auth") {
    return authStatus({ env: agentEnv(), ...asAgent });
  }
  if (request.method === "POST" && parts.length === 2 && parts[0] === "claude" && parts[1] === "check") {
    return checkClaude({ cwd: AGENT_HOME, env: agentEnv(), ...asAgent });
  }
  if (request.method === "GET" && parts.length === 2 && parts[0] === "engines" && parts[1] === "auth") return enginesAuth();

  // A bot's home: created on first use, deleted with the bot.
  if (parts.length === 2 && parts[0] === "bots") {
    if (!ID.test(parts[1])) throw new HttpError(400, "Bad bot id");
    if (request.method === "POST") return { ok: true, dir: botDir(parts[1]) };
    if (request.method === "DELETE") {
      for (const [id, agent] of agents) {
        if (id === parts[1] || id.startsWith(`${parts[1]}--`)) {
          agents.delete(id);
          await agent.close({ keepSession: false });
        }
      }
      fs.rmSync(path.join(BOTS_DIR, parts[1]), { recursive: true, force: true });
      return { ok: true };
    }
  }

  // A command or a file anywhere in the agent's home.
  if (request.method === "POST" && parts.length === 1 && parts[0] === "exec") {
    const body = await readJson(request);
    if (typeof body.command !== "string" || !body.command.trim()) {
      throw new HttpError(400, "Missing command");
    }
    const timeoutMs = Math.min(
      Math.max(Number(body.timeoutMs) || DEFAULT_EXEC_TIMEOUT_MS, 1000),
      MAX_EXEC_TIMEOUT_MS,
    );
    const cwd = boxCwd(body.cwd);
    if (!fs.existsSync(cwd)) throw new HttpError(404, "No such directory");
    return runAsAgent(["bash", "-lc", body.command], { cwd, timeoutMs });
  }
  if (request.method === "GET" && parts.length === 2 && parts[0] === "files" && parts[1] === "raw") return sendRawFile(response, url.searchParams.get("path"));
  if (parts.length === 1 && parts[0] === "files") {
    if (request.method === "GET") return readFile(url.searchParams.get("path"));
    if (request.method === "PUT") {
      const body = await readJson(request);
      return writeFile(body.path, body.content);
    }
    if (request.method === "DELETE") return deleteFile(url.searchParams.get("path"));
  }
  throw new HttpError(404, "Not found");
}

/**
 * Earlier boxes kept the bots' homes, the team space and the skills library
 * as plain `bots`, `team` and `skills` in the home. They are hidden now;
 * what an old home still has under the visible names moves over once, and
 * the empty old folders go. A copy where a rename can't cross volumes.
 */
function adoptVisibleDirs() {
  for (const [old, dir] of [["bots", BOTS_DIR], ["team", TEAM_DIR], ["skills", SKILLS_DIR]]) {
    const from = path.join(AGENT_HOME, old);
    if (from === dir || !fs.existsSync(from)) continue;
    try {
      fs.mkdirSync(dir, { recursive: true });
      for (const entry of fs.readdirSync(from)) {
        const source = path.join(from, entry);
        const target = path.join(dir, entry);
        if (fs.existsSync(target)) continue;
        try {
          fs.renameSync(source, target);
        } catch {
          fs.cpSync(source, target, { recursive: true });
          fs.rmSync(source, { recursive: true, force: true });
        }
      }
      if (fs.readdirSync(from).length === 0) fs.rmdirSync(from);
      console.info(`[box] moved ${old} to ${path.basename(dir)}`);
    } catch (error) {
      console.warn(`[box] could not move ${old} to ${path.basename(dir)}: ${error.message}`);
    }
  }
}

export function startServer({ port = PORT, host = HOST } = {}) {
  const token = loadToken();
  adoptVisibleDirs();
  for (const dir of [BOTS_DIR, TEAM_DIR, SKILLS_DIR, CODEX_HOME, GROK_HOME]) {
    fs.mkdirSync(dir, { recursive: true });
    own(dir);
  }
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://box");
    if (url.pathname === "/health") return send(response, 200, { ok: true, agents: agents.size, desktop: desktopStatus(), updating: Boolean(update && update.finishedAt === null) });
    if (!authorized(request, token)) return send(response, 401, { error: "Unauthorized" });
    try {
      const result = await route(request, response, url);
      if (result !== STREAMED) send(response, 200, result);
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      if (status === 500) console.error("[box]", error);
      if (!response.headersSent) send(response, status, { error: error.message });
      else response.end();
    }
  });
  server.listen(port, host, () => console.info(`[box] listening on ${host}:${port}`));
  const shutdown = async () => {
    server.close();
    stopDesktop();
    systemBus?.kill("SIGTERM");
    for (const terminal of terminals.keys()) closeTerminal(terminal);
    await Promise.allSettled([...agents.values()].map((agent) => agent.close({ keepSession: true })));
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startServer();
}
