/**
 * Persistent Claude Code sessions for the bots. One `claude` process per
 * (bot, thread), kept across turns and closed after an idle timeout; a turn
 * is one NDJSON user message on stdin and settles when the CLI prints a
 * `result`. The session id is kept, so a closed process resumes where it
 * left off: this is what makes a bot live between messages.
 *
 * The CLI sees Kru Bot's tools through the `kru` MCP server (kru-mcp.mjs),
 * which forwards each call over a per-session unix socket to this file, and
 * from here to the API on the turn's event stream. The API executes the
 * tool and answers; the CLI never talks to anything but this bridge. Its
 * permission prompts travel the same road, as calls to the `permission`
 * tool the API answers after asking the person.
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BridgedSession, EXIT_GRACE_MS, IDLE_MS, MAX_STDERR, killTree, systemReminder } from "./bridge.mjs";
import { CLAUDE_BIN, writeSystemPrompt } from "./claude.mjs";

export { IDLE_MS, systemReminder };

const MAX_LINE = 256 * 1024;

/**
 * Flags that don't exist on older CLIs, with the first version that has
 * them. A flag under its floor is left out with a warning rather than
 * crashing the session; a wrong floor is caught the other way too, since a
 * launch failing on an unknown option relaunches without the optional ones.
 */
export const FLAG_FLOORS = {
  "--input-format": "1.0.0",
  "--strict-mcp-config": "1.0.30",
  "--setting-sources": "1.0.100",
  "--effort": "2.0.30",
  "--max-turns": "1.0.0",
};

/** Optional flags, dropped together on an "unknown option" launch failure. */
const OPTIONAL_FLAGS = ["--strict-mcp-config", "--setting-sources", "--effort"];

/** `[major, minor, patch]` from `claude --version` output, or null. */
export function parseVersion(text) {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(text ?? "");
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

export function atLeast(version, floor) {
  const want = parseVersion(floor);
  if (!version || !want) return false;
  for (let i = 0; i < 3; i += 1) {
    if (version[i] > want[i]) return true;
    if (version[i] < want[i]) return false;
  }
  return true;
}

/** The optional flags this CLI version is known to accept. Unknown version: all of them. */
export function flagsFor(version) {
  const allowed = new Set();
  for (const [flag, floor] of Object.entries(FLAG_FLOORS)) {
    if (!version || atLeast(version, floor)) allowed.add(flag);
  }
  return allowed;
}

let cachedVersion;
/** Runs `claude --version` once per process. */
/** After an update the CLI may be newer: read its version (and flags) again. */
export function forgetClaudeVersion() {
  cachedVersion = undefined;
}

export function claudeVersion({ bin = CLAUDE_BIN, env, uid, gid } = {}) {
  if (cachedVersion !== undefined) return cachedVersion;
  try {
    const result = spawnSync(bin, ["--version"], { env, uid, gid, encoding: "utf8", timeout: 15_000 });
    cachedVersion = parseVersion(`${result.stdout}\n${result.stderr}`);
  } catch {
    cachedVersion = null;
  }
  return cachedVersion;
}

/** Credentials the parent may carry; a bot must not inherit them. */
export const CREDENTIAL_ENV = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_CUSTOM_HEADERS",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
];

export function stripCredentialEnv(env) {
  const clean = { ...env };
  for (const name of CREDENTIAL_ENV) delete clean[name];
  return clean;
}

/**
 * How a session reaches its model. `plan` is the person's own sign-in on
 * the box; `api` is Kru's LLM proxy, with the proxy token standing in for
 * the key (the API adds the real one on the way out).
 *
 * @typedef {{ kind: "plan" } | { kind: "api"; baseUrl: string; token: string; smallModel?: string | null }} Access
 */

/** Reads the access a turn asked for; anything malformed is the plan. */
export function parseAccess(value) {
  if (!value || value.kind !== "api") return { kind: "plan" };
  const baseUrl = typeof value.baseUrl === "string" ? value.baseUrl : "";
  const token = typeof value.token === "string" ? value.token : "";
  if (!/^https?:\/\/[^\s]+$/.test(baseUrl) || !/^[A-Za-z0-9_-]{16,200}$/.test(token)) return { kind: "plan" };
  const smallModel = typeof value.smallModel === "string" && /^[A-Za-z0-9._:/-]{1,120}$/.test(value.smallModel) ? value.smallModel : null;
  return { kind: "api", baseUrl, token, smallModel };
}

/** The environment Claude Code gets for an API access: the proxy, as a gateway with a bearer token. */
export function claudeAccessEnv(access) {
  if (access?.kind !== "api") return {};
  return {
    ANTHROPIC_BASE_URL: access.baseUrl,
    ANTHROPIC_AUTH_TOKEN: access.token,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    // A provider that isn't Anthropic may not have the small model Claude Code uses for background work.
    ...(access.smallModel ? { ANTHROPIC_DEFAULT_HAIKU_MODEL: access.smallModel, ANTHROPIC_SMALL_FAST_MODEL: access.smallModel } : {}),
  };
}

/** How a session's own tool calls (shell, file edits, web) are gated. */
export const PERMISSION_MODES = ["ask", "edits", "full"];

/**
 * The argv for a session. The container and its unprivileged user are the
 * sandbox; what the person sees is decided by the permission mode:
 *
 *   ask    every permission prompt the CLI would show goes to the API as a
 *          call to the `permission` MCP tool, and waits for the person.
 *   edits  file edits are accepted; everything else asks the same way.
 *   full   permissions are skipped outright.
 *
 * @param {{
 *   model: string; effort?: string | null; maxTurns?: number;
 *   systemPromptFile: string; mcpConfigFile?: string | null; permission?: string;
 *   sessionId: string; resume: boolean; allowed: Set<string>; optional?: boolean;
 * }} input
 */
export function sessionArgs({ model, effort, maxTurns, systemPromptFile, mcpConfigFile, permission = "ask", sessionId, resume, allowed, optional = true }) {
  const has = (flag) => optional && allowed.has(flag);
  const args = ["-p", "--output-format", "stream-json", "--input-format", "stream-json", "--verbose", "--model", model];
  if (effort && has("--effort")) args.push("--effort", effort);
  if (maxTurns && allowed.has("--max-turns")) args.push("--max-turns", String(maxTurns));
  if (permission === "full" || !mcpConfigFile) {
    args.push("--dangerously-skip-permissions");
  } else {
    args.push("--permission-mode", permission === "edits" ? "acceptEdits" : "default");
    args.push("--permission-prompt-tool", "mcp__kru__permission");
  }
  args.push("--append-system-prompt-file", systemPromptFile);
  if (mcpConfigFile) {
    args.push("--mcp-config", mcpConfigFile, "--allowedTools", "mcp__kru");
    if (has("--strict-mcp-config")) args.push("--strict-mcp-config");
  }
  if (has("--setting-sources")) args.push("--setting-sources", "project");
  args.push(resume ? "--resume" : "--session-id", sessionId);
  return args;
}

/**
 * Everything that would make a running process the wrong one for a turn.
 * @param {{ model: string; effort?: string | null; maxTurns?: number | null; toolNames: string[]; permission?: string }} input
 */
export function argsKeyFor({ model, effort, maxTurns, toolNames, permission, mcpServers = [], access = { kind: "plan" } }) {
  return createHash("sha256").update(JSON.stringify({ model, effort: effort ?? null, maxTurns: maxTurns ?? null, toolNames, permission: permission ?? "ask", mcpServers, access })).digest("hex").slice(0, 16);
}

/**
 * The person's own MCP servers as the CLI's config wants them, next to the
 * kru bridge. Only the two shapes Kru sends: an HTTP server (reached
 * through the API, which holds the real headers) and a stdio command.
 */
export function mcpServersConfig(servers) {
  const out = {};
  for (const server of Array.isArray(servers) ? servers : []) {
    if (!server || typeof server.name !== "string" || !/^[a-z0-9][a-z0-9_-]*$/i.test(server.name) || server.name === "kru") continue;
    if (server.type === "http" && typeof server.url === "string") {
      out[server.name] = { type: "http", url: server.url, headers: server.headers && typeof server.headers === "object" ? server.headers : {} };
    } else if (server.type === "stdio" && typeof server.command === "string" && server.command) {
      out[server.name] = { command: server.command, args: Array.isArray(server.args) ? server.args.map(String) : [], env: server.env && typeof server.env === "object" ? server.env : {} };
    }
  }
  return out;
}

/**
 * Reads a `result` line. Null when it isn't one, or when it is a background
 * task notification, which is not the end of the submitted turn.
 */
export function settle(event) {
  if (!event || event.type !== "result") return null;
  if (event.origin?.kind === "task-notification") return null;
  const usage = event.usage ?? {};
  const cached = (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
  return {
    ok: event.is_error !== true,
    text: typeof event.result === "string" ? event.result : "",
    stopReason: event.stop_reason ?? event.terminal_reason ?? null,
    cost: typeof event.total_cost_usd === "number" ? event.total_cost_usd : null,
    usage: { input: (usage.input_tokens ?? 0) + cached, output: usage.output_tokens ?? 0, cachedInput: cached },
  };
}

/** A resume the CLI refused before reading the prompt. */
export function isResumeFailure({ resume, sawInit, stderr, exitCode }) {
  if (!resume || sawInit || exitCode === 0) return false;
  return /no conversation found|session.*(not found|does not exist|invalid)|could not resume|resume/i.test(stderr ?? "");
}

/** A launch that died on an argument this CLI doesn't know. */
export function isUnknownOption(stderr) {
  return /unknown option|unrecognized option|unknown argument|too many arguments/i.test(stderr ?? "");
}

/**
 * The user message the CLI reads: text only, or with images and PDFs as
 * content blocks ahead of it. Anything else is left out.
 */
export function userMessage(prompt, images = []) {
  const blocks = images.flatMap((file) => {
    if (!file || typeof file.data !== "string" || typeof file.mediaType !== "string") return [];
    const source = { type: "base64", media_type: file.mediaType, data: file.data };
    if (file.mediaType === "application/pdf") {
      return [{ type: "document", source, ...(typeof file.name === "string" ? { title: file.name } : {}) }];
    }
    return file.mediaType.startsWith("image/") ? [{ type: "image", source }] : [];
  });
  if (!blocks.length) return { type: "user", message: { role: "user", content: prompt } };
  return { type: "user", message: { role: "user", content: [...blocks, { type: "text", text: prompt }] } };
}

/** A user message for the protocol log, with file contents left out. */
export function loggable(message) {
  const content = message.message.content;
  if (!Array.isArray(content)) return message;
  return {
    ...message,
    message: {
      ...message.message,
      content: content.map((block) =>
        block.source?.data ? { ...block, source: { ...block.source, data: `[${block.source.data.length} base64 characters]` } } : block,
      ),
    },
  };
}

/**
 * One agent: its process, session cursor, bridge socket, and the turn in
 * flight. Owned by the box server; Kru drives it over HTTP.
 */
export class AgentSession extends BridgedSession {
  /**
   * @param {{
   *   id: string; cwd: string; env: NodeJS.ProcessEnv; uid?: number; gid?: number;
   *   bin?: string; socketDir: string; mcpScript: string; logDir?: string | null;
   *   onWarning?: (text: string) => void;
   * }} options
   */
  constructor(options) {
    super(options);
    this.engine = "claude";
    this.env = stripCredentialEnv(options.env);
    this.launchEnv = this.env;
    this.bin = options.bin ?? CLAUDE_BIN;
    this.cleanups = [];
    this.sawInit = false;
  }

  /** Writes the MCP config the CLI reads; owner-only, gone when the turn settles. */
  writeMcpConfig(socketPath, servers = []) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kru-mcp-"));
    const file = path.join(dir, "mcp.json");
    const config = { mcpServers: { kru: { command: process.execPath, args: [this.mcpScript, socketPath] }, ...mcpServersConfig(servers) } };
    fs.writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
    if (this.uid !== undefined) {
      fs.chownSync(dir, this.uid, this.gid);
      fs.chownSync(file, this.uid, this.gid);
    }
    return { file, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
  }

  /**
   * Makes sure a process for these settings is running: reuses the live one
   * when the args match, otherwise closes it and launches afresh (resuming
   * the saved session where there is one).
   */
  async ensure({ model, effort, maxTurns, systemPrompt, tools, permission = "ask", mcpServers = [], access = { kind: "plan" } }) {
    const toolNames = tools.map((tool) => tool.name).sort();
    const argsKey = argsKeyFor({ model, effort, maxTurns, toolNames, permission, mcpServers: mcpServersConfig(mcpServers), access });
    this.tools = tools;
    if (this.running && this.argsKey === argsKey) return { launched: false };
    if (this.running) await this.close({ keepSession: true });
    this.launchEnv = { ...this.env, ...claudeAccessEnv(access) };

    const version = claudeVersion({ bin: this.bin, env: this.env, uid: this.uid, gid: this.gid });
    const allowed = flagsFor(version);
    for (const flag of Object.keys(FLAG_FLOORS)) {
      if (!allowed.has(flag)) this.onWarning(`Claude Code ${version?.join(".") ?? "?"} predates ${flag}; bots run without it.`);
    }
    const socketPath = await this.listen();
    const persona = writeSystemPrompt(systemPrompt, { uid: this.uid, gid: this.gid });
    const mcp = this.writeMcpConfig(socketPath, mcpServers);
    this.cleanups = [persona.cleanup, mcp.cleanup];
    this.systemPromptHash = createHash("sha256").update(systemPrompt).digest("hex");

    const resume = Boolean(this.sessionId);
    const sessionId = this.sessionId ?? randomUUID();
    const launch = (optional) =>
      this.spawn(
        sessionArgs({ model, effort, maxTurns, systemPromptFile: persona.file, mcpConfigFile: mcp.file, permission, sessionId, resume, allowed, optional }),
        { resume },
      );
    let outcome = await launch(true);
    if (outcome.failed && isUnknownOption(outcome.stderr)) {
      this.onWarning(`Claude Code rejected an optional flag (${outcome.stderr.trim().slice(0, 120)}); relaunching without ${OPTIONAL_FLAGS.join(", ")}.`);
      outcome = await launch(false);
    }
    if (outcome.failed) throw new Error(`Claude Code didn't start: ${outcome.stderr.trim().slice(0, 300) || "no output"}`);
    this.argsKey = argsKey;
    this.sessionId = sessionId;
    return { launched: true, resumed: resume };
  }

  /**
   * Starts the process and waits briefly for it to stay up. A CLI that
   * exits at once (bad flag, refused resume, not signed in) is reported
   * with its stderr instead of being handed a prompt.
   */
  spawn(args, { resume }) {
    this.stderr = "";
    this.sawInit = false;
    this.resume = resume;
    this.log("spawn", { args });
    const child = spawn(this.bin, args, {
      cwd: this.cwd,
      env: this.launchEnv,
      ...(this.uid !== undefined ? { uid: this.uid, gid: this.gid } : {}),
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    let pending = "";
    // utf8 before buffering, or a multibyte character split across reads
    // comes out as garbage.
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      pending += chunk;
      let newline = pending.indexOf("\n");
      while (newline !== -1) {
        const line = pending.slice(0, newline).replace(/\r$/, "");
        pending = pending.slice(newline + 1);
        if (line) this.onLine(line.length > MAX_LINE ? line.slice(0, MAX_LINE) : line);
        newline = pending.indexOf("\n");
      }
      if (pending.length > MAX_LINE) pending = pending.slice(-MAX_LINE);
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      this.stderr = (this.stderr + chunk).slice(-MAX_STDERR);
      this.log("stderr", chunk);
    });
    child.stdin.on("error", () => undefined);
    child.on("close", (code, signal) => {
      if (this.child !== child) return;
      this.log("exit", { code, signal, resume: this.resume, sawInit: this.sawInit });
      const turn = this.turn;
      this.child = null;
      if (turn) {
        this.turn = null;
        turn.finish({
          ok: false,
          text: "",
          stopReason: turn.interrupted ? "interrupted" : "exited",
          cost: null,
          usage: null,
          error: turn.interrupted ? "The turn was interrupted" : this.stderr.trim().slice(0, 500) || `Claude Code exited (${signal ?? code})`,
          resumeFailed: isResumeFailure({ resume: this.resume, sawInit: this.sawInit, stderr: this.stderr, exitCode: code }),
        });
      }
      this.cleanup();
    });
    return new Promise((resolve) => {
      const settleLaunch = (failed) => resolve({ failed, stderr: this.stderr });
      child.once("error", (error) => {
        this.stderr = error.message;
        this.child = null;
        settleLaunch(true);
      });
      child.once("close", () => settleLaunch(true));
      // No exit within a moment means the CLI is up and waiting on stdin.
      setTimeout(() => {
        if (this.child === child && child.exitCode === null) settleLaunch(false);
      }, 1_500);
    });
  }

  onLine(line) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }
    this.log("out", event);
    if (event.type === "system" && event.subtype === "init") {
      this.sawInit = true;
      // The CLI may hand back a different cursor than it was given.
      if (typeof event.session_id === "string") this.sessionId = event.session_id;
      this.turn?.onEvent({ type: "init", sessionId: this.sessionId, permissionMode: event.permissionMode ?? null });
      return;
    }
    if (!this.turn) return;
    // Subagent narration interleaves into the same stream; not this turn's words.
    if (event.parent_tool_use_id) return;
    const result = settle(event);
    if (result) {
      const turn = this.turn;
      this.turn = null;
      turn.finish(result);
      return;
    }
    this.turn.onEvent({ type: "line", line });
  }

  /**
   * Runs one turn: writes the prompt, streams events to `onEvent`, resolves
   * with the settled result. Rejects when a turn is already in flight.
   */
  turnWith({ prompt, images, timeoutMs, onEvent, systemPrompt, signal }) {
    if (this.turn) return Promise.reject(new Error("A turn is already in flight"));
    if (!this.running) return Promise.reject(new Error("No session"));
    this.clearIdle();
    let text = prompt;
    const hash = createHash("sha256").update(systemPrompt).digest("hex");
    if (hash !== this.systemPromptHash) {
      // The process launched with the old persona; say what changed instead of relaunching.
      text = systemReminder(systemPrompt) + prompt;
      this.systemPromptHash = hash;
    }
    return new Promise((resolve) => {
      const turn = {
        onEvent,
        interrupted: false,
        finish: (result) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", interrupt);
          this.dropPendingCalls();
          if (this.running) this.armIdle();
          resolve(result);
        },
      };
      const interrupt = () => {
        if (this.turn !== turn) return;
        turn.interrupted = true;
        this.kill();
      };
      const timer = setTimeout(interrupt, timeoutMs);
      if (signal?.aborted) {
        clearTimeout(timer);
        resolve({ ok: false, text: "", stopReason: "interrupted", cost: null, usage: null, error: "Aborted before the turn started" });
        return;
      }
      signal?.addEventListener("abort", interrupt, { once: true });
      this.turn = turn;
      const message = userMessage(text, images);
      this.log("in", loggable(message));
      const stdin = this.child.stdin;
      if (!stdin.writable || stdin.destroyed) {
        this.turn = null;
        clearTimeout(timer);
        resolve({ ok: false, text: "", stopReason: "stdin_write_failed", cost: null, usage: null, error: "The CLI's stdin is closed" });
        void this.close();
        return;
      }
      stdin.write(`${JSON.stringify(message)}\n`, (error) => {
        if (!error || this.turn !== turn) return;
        this.turn = null;
        clearTimeout(timer);
        resolve({ ok: false, text: "", stopReason: "stdin_write_failed", cost: null, usage: null, error: error.message });
        void this.close();
      });
    });
  }

  kill() {
    const child = this.child;
    if (!child) return;
    killTree(child, "SIGTERM");
    setTimeout(() => killTree(child, "SIGKILL"), EXIT_GRACE_MS).unref?.();
  }

  cleanup() {
    for (const fn of this.cleanups) {
      try {
        fn();
      } catch {
        /* already gone */
      }
    }
    this.cleanups = [];
  }

  /** Ends the process: EOF first, then the signal. The session cursor stays unless told otherwise. */
  async close({ keepSession = true } = {}) {
    this.clearIdle();
    await this.stopChild();
    this.child = null;
    this.cleanup();
    if (!keepSession) this.sessionId = null;
    await this.closeBridge();
  }
}

/**
 * Whether the CLI is signed in, from `claude auth status --json`. Only the
 * display identity is returned, never the CLI's whole answer.
 */
export function authStatus({ bin = CLAUDE_BIN, env, uid, gid } = {}) {
  try {
    const result = spawnSync(bin, ["auth", "status", "--json"], { env, uid, gid, encoding: "utf8", timeout: 10_000 });
    const text = `${result.stdout ?? ""}`.trim();
    const start = text.indexOf("{");
    if (start === -1) return { known: false, loggedIn: null };
    const data = JSON.parse(text.slice(start));
    const loggedIn = data.loggedIn ?? data.logged_in ?? data.isLoggedIn ?? null;
    return {
      known: typeof loggedIn === "boolean",
      loggedIn: typeof loggedIn === "boolean" ? loggedIn : null,
      email: typeof data.email === "string" ? data.email : (data.account?.email ?? null),
      org: typeof data.orgName === "string" ? data.orgName : (data.organization?.name ?? data.org ?? null),
      method: typeof data.method === "string" ? data.method : (data.authMethod ?? null),
    };
  } catch {
    return { known: false, loggedIn: null };
  }
}
