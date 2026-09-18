/**
 * What every bot session shares, whichever CLI it runs: the unix socket the
 * `kru` MCP server (kru-mcp.mjs) connects to, the tool calls relayed from
 * there to the API on the turn's event stream, permission questions asked
 * the same way, the idle timer and the protocol log. The CLI-specific
 * sessions (agents.mjs for Claude Code, codex.mjs, grok.mjs) extend it.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

/** A session with nothing to do is closed after this long. */
export const IDLE_MS = Math.max(30_000, Number(process.env.BOT_IDLE_MS) || 10 * 60 * 1000);
/** Grace between asking a CLI to exit and killing it. */
export const EXIT_GRACE_MS = 5_000;
/** Longest stderr kept for error reports. */
export const MAX_STDERR = 4_000;
/** The protocol log is rolled over past this size. */
const MAX_LOG_BYTES = 5 * 1024 * 1024;

/** The note prepended when the persona changed under a live session. */
export function systemReminder(text) {
  return `<system-reminder>\nThis part of your instructions changed since this session started. It replaces the earlier copy:\n\n${text}\n</system-reminder>\n\n`;
}

export function killTree(child, signal) {
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      /* gone */
    }
  }
}

/** Appends one line to the per-agent protocol log, rolling it over when big. */
export function protocolLogger(dir, id) {
  if (!dir) return () => undefined;
  const file = path.join(dir, `${id}.ndjson`);
  return (direction, payload) => {
    try {
      fs.mkdirSync(dir, { recursive: true });
      try {
        if (fs.statSync(file).size > MAX_LOG_BYTES) fs.renameSync(file, `${file}.1`);
      } catch {
        /* no file yet */
      }
      fs.appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), direction, payload })}\n`, { mode: 0o600 });
    } catch {
      /* logging never breaks a turn */
    }
  };
}

/**
 * Reads the API's answer to a `permission` call: `{ behavior, message }`
 * as JSON (what the permission tool returns). Anything else is a denial.
 */
export function permissionDecision(answer) {
  if (!answer || answer.isError) return { allow: false, message: typeof answer?.content === "string" ? answer.content : "No answer" };
  try {
    const parsed = JSON.parse(typeof answer.content === "string" ? answer.content : JSON.stringify(answer.content));
    return { allow: parsed?.behavior === "allow", message: typeof parsed?.message === "string" ? parsed.message : "" };
  } catch {
    return { allow: false, message: "Unreadable answer" };
  }
}

/**
 * One bot session's plumbing, minus the CLI. Subclasses implement
 * `ensure`, `turnWith`, `kill` and `close`, and keep `child`, `turn` and
 * `sessionId` up to date.
 */
export class BridgedSession {
  /**
   * @param {{
   *   id: string; cwd: string; env: NodeJS.ProcessEnv; uid?: number; gid?: number;
   *   bin?: string; socketDir: string; mcpScript: string; logDir?: string | null;
   *   onWarning?: (text: string) => void;
   * }} options
   */
  constructor(options) {
    this.id = options.id;
    this.cwd = options.cwd;
    this.baseEnv = options.env;
    this.uid = options.uid;
    this.gid = options.gid;
    this.socketDir = options.socketDir;
    this.mcpScript = options.mcpScript;
    this.log = protocolLogger(options.logDir, options.id);
    this.onWarning = options.onWarning ?? (() => undefined);
    this.child = null;
    this.sessionId = null;
    this.argsKey = null;
    this.systemPromptHash = null;
    this.turn = null;
    this.idleTimer = null;
    this.bridge = null;
    this.tools = [];
    this.stderr = "";
    this.pendingCalls = new Map();
  }

  get running() {
    return Boolean(this.child && this.child.exitCode === null && !this.child.killed);
  }

  /** The tools the CLI sees on `kru`. Only Claude Code asks for permission through a tool. */
  bridgeTools() {
    return this.tools;
  }

  /** Opens the unix socket the MCP proxy connects to. One per agent. */
  async listen() {
    if (this.bridge) return this.bridge.path;
    fs.mkdirSync(this.socketDir, { recursive: true, mode: 0o755 });
    const socketPath = path.join(this.socketDir, `${this.id}.sock`);
    fs.rmSync(socketPath, { force: true });
    const server = net.createServer((socket) => {
      socket.setEncoding("utf8");
      let pending = "";
      socket.on("data", (chunk) => {
        pending += chunk;
        let newline = pending.indexOf("\n");
        while (newline !== -1) {
          const line = pending.slice(0, newline);
          pending = pending.slice(newline + 1);
          newline = pending.indexOf("\n");
          if (line.trim()) void this.onBridgeMessage(socket, line);
        }
      });
      socket.on("error", () => undefined);
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => resolve());
    });
    if (this.uid !== undefined) fs.chownSync(socketPath, this.uid, this.gid);
    fs.chmodSync(socketPath, 0o600);
    this.bridge = { server, path: socketPath };
    return socketPath;
  }

  async onBridgeMessage(socket, line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    this.log("mcp", message);
    const answer = (result, error) => {
      if (!socket.destroyed) socket.write(`${JSON.stringify(error ? { id: message.id, error } : { id: message.id, result })}\n`);
    };
    if (message.method === "tools/list") {
      answer({ tools: this.bridgeTools() });
      return;
    }
    if (message.method === "tools/call") {
      if (!this.turn) {
        answer(null, "No turn in flight");
        return;
      }
      const callId = randomUUID();
      this.pendingCalls.set(callId, answer);
      this.turn.onEvent({ type: "tool_call", callId, name: message.params?.name, input: message.params?.arguments ?? {} });
      return;
    }
    answer(null, `Unknown method ${message.method}`);
  }

  /** Kru's answer to a tool call the CLI made (or a permission question this session asked). */
  answerTool(callId, { content, isError = false }) {
    const answer = this.pendingCalls.get(callId);
    if (!answer) return false;
    this.pendingCalls.delete(callId);
    answer({ content, isError });
    return true;
  }

  /**
   * Asks the person, through the API's `permission` tool, whether the CLI
   * may run `tool` with `input`. Resolves `{ allow, message }`; a turn that
   * ends first counts as a denial.
   */
  askPermission(tool, input) {
    if (!this.turn) return Promise.resolve({ allow: false, message: "No turn in flight" });
    const callId = randomUUID();
    return new Promise((resolve) => {
      this.pendingCalls.set(callId, (result, error) => resolve(error ? { allow: false, message: String(error) } : permissionDecision(result)));
      this.turn.onEvent({ type: "tool_call", callId, name: "permission", input: { tool_name: tool, input } });
    });
  }

  /** Ends every question still waiting, as denials, when a turn settles. */
  dropPendingCalls() {
    for (const answer of this.pendingCalls.values()) {
      try {
        answer(null, "The turn ended");
      } catch {
        /* the socket is gone */
      }
    }
    this.pendingCalls.clear();
  }

  armIdle() {
    this.clearIdle();
    this.idleTimer = setTimeout(() => void this.close({ keepSession: true }), IDLE_MS);
    this.idleTimer.unref?.();
  }

  clearIdle() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  /** Closes the socket after the child, so a replacement session binding the same path isn't unlinked by the dying one. */
  async closeBridge() {
    if (!this.bridge) return;
    const { server, path: socketPath } = this.bridge;
    this.bridge = null;
    await new Promise((resolve) => server.close(() => resolve()));
    fs.rmSync(socketPath, { force: true });
  }

  /** Stops a child: stdin EOF and SIGTERM, then SIGKILL after the grace. */
  async stopChild() {
    const child = this.child;
    if (!child) return;
    try {
      child.stdin.end();
    } catch {
      /* closed */
    }
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        killTree(child, "SIGKILL");
        resolve();
      }, EXIT_GRACE_MS);
      child.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
      killTree(child, "SIGTERM");
    });
  }
}
