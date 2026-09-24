/**
 * Persistent OpenAI Codex sessions for the bots, through `codex app-server`
 * (JSON-RPC over stdio). One app-server process per (bot, thread), kept
 * across turns and closed after an idle timeout, like the Claude Code
 * sessions in agents.mjs; the thread id is kept, so a closed process
 * resumes the same thread with `thread/resume`.
 *
 * Kru's tools reach Codex as the `kru` MCP server (the same bridge Claude
 * Code uses), marked pre-approved: the API gates them itself. Codex's own
 * approvals (a shell command, a file change) arrive as requests from the
 * app-server and go to the person as `permission` calls, the way Claude
 * Code's permission prompts do.
 *
 * The person signs in once in a terminal (`codex login --device-auth`) and
 * the login stays in ~/.codex on the home volume; or the bots run on an
 * OpenAI-compatible API through Kru's LLM proxy, which holds the key.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { BridgedSession, MAX_STDERR, ReplyText, killTree, systemReminder } from "./bridge.mjs";
import { RpcPeer } from "./rpc.mjs";

/** The CLI to run; tests point this at a script. */
export const CODEX_BIN = process.env.CODEX_BIN || "codex";
/** How long the app-server gets to answer a setup request. */
const SETUP_TIMEOUT_MS = 60_000;
/** After an interrupt, how long the turn gets to wind down before the process is killed. */
const INTERRUPT_GRACE_MS = 10_000;

/** Credentials the parent may carry; a Codex session must not inherit them. */
export const CODEX_CREDENTIAL_ENV = ["OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_ACCESS_TOKEN", "OPENAI_BASE_URL", "KRU_LLM_TOKEN"];

/** A value as TOML, for `-c key=value`: strings JSON-quoted (valid TOML basic strings), tables inline. */
export function tomlValue(value) {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `[${value.map(tomlValue).join(", ")}]`;
  if (value && typeof value === "object") {
    return `{ ${Object.entries(value)
      .map(([key, inner]) => `${JSON.stringify(key)} = ${tomlValue(inner)}`)
      .join(", ")} }`;
  }
  return '""';
}

/**
 * The app-server's argv: the kru bridge and the person's MCP servers, and
 * for an API access the proxy as a Responses API provider.
 *
 * @param {{ node: string; mcpScript: string; socketPath: string; mcpServers?: any[]; access: { kind: string; baseUrl?: string } }} input
 */
export function codexArgs({ node, mcpScript, socketPath, mcpServers = [], access }) {
  const args = ["app-server"];
  const set = (key, value) => args.push("-c", `${key}=${tomlValue(value)}`);
  set("mcp_servers.kru", { command: node, args: [mcpScript, socketPath], default_tools_approval_mode: "approve", startup_timeout_sec: 30 });
  for (const server of mcpServers) {
    if (!server || typeof server.name !== "string" || !/^[a-z0-9][a-z0-9_-]*$/i.test(server.name) || server.name === "kru") continue;
    if (server.type === "http" && typeof server.url === "string") {
      set(`mcp_servers.${server.name}`, { url: server.url, http_headers: server.headers && typeof server.headers === "object" ? server.headers : {} });
    } else if (server.type === "stdio" && typeof server.command === "string" && server.command) {
      set(`mcp_servers.${server.name}`, { command: server.command, args: Array.isArray(server.args) ? server.args.map(String) : [], env: server.env && typeof server.env === "object" ? server.env : {} });
    }
  }
  if (access?.kind === "api") {
    set("model_provider", "kru");
    // Codex speaks the Responses API to every provider; the proxy passes it through.
    set("model_providers.kru", { name: "Kru Bot", base_url: access.baseUrl, env_key: "KRU_LLM_TOKEN", wire_api: "responses" });
  }
  return args;
}

/** The environment a Codex session runs with: no inherited keys, and the proxy token for an API access. */
export function codexEnv(base, access) {
  const env = { ...base };
  for (const name of CODEX_CREDENTIAL_ENV) delete env[name];
  if (access?.kind === "api") env.KRU_LLM_TOKEN = access.token;
  return env;
}

/** Codex's approval policy for a bot's permission level. The container is the sandbox either way. */
export function codexApprovalPolicy(permission) {
  return permission === "full" ? "never" : "untrusted";
}

/** `/bin/bash -lc 'echo hi'` as `echo hi`: what the person would have typed. */
export function unwrapCommand(command) {
  if (Array.isArray(command)) command = command.join(" ");
  const text = String(command ?? "");
  const match = /^(?:\/usr)?\/bin\/(?:ba|z)?sh\s+-l?c\s+(['"])([\s\S]*)\1$/.exec(text.trim());
  return match ? match[2] : text;
}

function firstString(input) {
  const value = Object.values(input && typeof input === "object" ? input : {}).find((v) => typeof v === "string");
  return typeof value === "string" ? ` ${value.replace(/\s+/g, " ").slice(0, 120)}` : "";
}

/** One thread item as a short activity line, or null. */
export function codexActivity(item, cwd) {
  const relative = (file) => (cwd && typeof file === "string" && file.startsWith(`${cwd}/`) ? file.slice(cwd.length + 1) : file);
  switch (item?.type) {
    case "commandExecution":
      return `$ ${unwrapCommand(item.command).replace(/\s+/g, " ").slice(0, 160)}`;
    case "fileChange": {
      const paths = (Array.isArray(item.changes) ? item.changes : []).map((c) => relative(c.path)).filter(Boolean);
      return paths.length ? `Editing ${paths.slice(0, 3).join(", ")}${paths.length > 3 ? ` and ${paths.length - 3} more` : ""}` : "Editing files";
    }
    case "mcpToolCall":
      if (item.server === "kru") return item.tool === "permission" ? null : `${item.tool}${firstString(item.arguments)}`;
      return `${item.server}: ${item.tool}${firstString(item.arguments)}`;
    case "webSearch":
      return item.query ? `Searching ${String(item.query).slice(0, 120)}` : "Searching the web";
    case "agentMessage":
      return typeof item.text === "string" && item.text.trim() ? item.text.trim().replace(/\s+/g, " ").slice(0, 200) : null;
    default:
      return null;
  }
}

/** The text parts of an MCP tool's answer. */
function contentText(content) {
  return (Array.isArray(content) ? content : [])
    .map((part) => (part?.type === "text" && typeof part.text === "string" ? part.text : part?.type === "image" ? "[image]" : ""))
    .filter(Boolean)
    .join("\n");
}

/**
 * One thread item as a step of the work log (the API's WorkStep): begun,
 * with the whole command or input, or done, with what it printed. Null for
 * what isn't a step (messages, reasoning, the permission tool).
 */
export function codexStep(item, cwd, done) {
  const title = codexActivity(item, cwd);
  if (!title || !item?.id || item.type === "agentMessage") return null;
  const failed = item.status === "failed" || item.status === "declined" || (typeof item.exitCode === "number" && item.exitCode !== 0);
  switch (item.type) {
    case "commandExecution":
      return done
        ? { id: item.id, output: typeof item.aggregatedOutput === "string" ? item.aggregatedOutput : "", status: failed ? "failed" : "done" }
        : { id: item.id, kind: "command", title, detail: unwrapCommand(item.command), status: "running" };
    case "fileChange": {
      const changes = Array.isArray(item.changes) ? item.changes : [];
      return done
        ? { id: item.id, output: changes.map((c) => (typeof c.diff === "string" ? c.diff : "")).filter(Boolean).join("\n") || null, status: failed ? "failed" : "done" }
        : { id: item.id, kind: "file", title, detail: changes.map((c) => c.path).filter(Boolean).join("\n") || null, status: "running" };
    }
    case "mcpToolCall":
      return done
        ? { id: item.id, output: item.error?.message ?? contentText(item.result?.content), status: item.error || failed ? "failed" : "done" }
        : { id: item.id, kind: "tool", title, detail: item.arguments && Object.keys(item.arguments).length ? JSON.stringify(item.arguments, null, 2) : null, status: "running" };
    case "webSearch":
      return done ? { id: item.id, status: "done" } : { id: item.id, kind: "tool", title, detail: null, status: "running" };
    default:
      return null;
  }
}

/** A turn's token use: what the thread's running total grew by. */
export function usageDelta(before, after) {
  if (!after) return null;
  const b = before ?? { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
  return {
    input: Math.max(0, (after.inputTokens ?? 0) - (b.inputTokens ?? 0)),
    output: Math.max(0, (after.outputTokens ?? 0) - (b.outputTokens ?? 0)),
    cachedInput: Math.max(0, (after.cachedInputTokens ?? 0) - (b.cachedInputTokens ?? 0)),
  };
}

/** Images ride along as data URLs; other files (PDFs) are left out, Codex can't read them here. */
export function codexInput(text, images = []) {
  const input = [{ type: "text", text, text_elements: [] }];
  for (const file of images) {
    if (file && typeof file.data === "string" && typeof file.mediaType === "string" && file.mediaType.startsWith("image/")) {
      input.push({ type: "image", url: `data:${file.mediaType};base64,${file.data}` });
    }
  }
  return input;
}

export class CodexSession extends BridgedSession {
  constructor(options) {
    super(options);
    this.engine = "codex";
    this.bin = options.bin ?? CODEX_BIN;
    this.node = options.node ?? process.execPath;
    this.rpc = null;
    this.permission = "ask";
    this.usageTotal = null;
    this.fileChanges = new Map();
  }

  bridgeTools() {
    return this.tools.filter((tool) => tool.name !== "permission");
  }

  async ensure({ model, systemPrompt, tools, permission = "ask", mcpServers = [], access = { kind: "plan" } }) {
    this.tools = tools;
    this.permission = permission;
    const argsKey = createHash("sha256")
      .update(JSON.stringify({ engine: "codex", model, permission, mcpServers, access, tools: tools.map((t) => t.name).sort() }))
      .digest("hex")
      .slice(0, 16);
    if (this.running && this.argsKey === argsKey) return { launched: false };
    if (this.running) await this.close({ keepSession: true });

    // Codex refuses a CODEX_HOME that doesn't exist yet (a fresh home volume).
    const codexHome = this.baseEnv.CODEX_HOME ?? path.join(this.baseEnv.HOME ?? this.cwd, ".codex");
    if (!fs.existsSync(codexHome)) {
      fs.mkdirSync(codexHome, { recursive: true, mode: 0o700 });
      if (this.uid !== undefined) fs.lchownSync(codexHome, this.uid, this.gid);
    }
    const socketPath = await this.listen();
    const args = codexArgs({ node: this.node, mcpScript: this.mcpScript, socketPath, mcpServers, access });
    this.stderr = "";
    this.log("spawn", { args: args.map((a) => a.replace(/"env_key" = "[^"]*"/, '"env_key" = "…"')) });
    const child = spawn(this.bin, args, {
      cwd: this.cwd,
      env: codexEnv(this.baseEnv, access),
      ...(this.uid !== undefined ? { uid: this.uid, gid: this.gid } : {}),
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      this.stderr = (this.stderr + chunk).slice(-MAX_STDERR);
      this.log("stderr", chunk);
    });
    const spawned = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("spawn", resolve);
    });
    child.on("close", (code, signal) => this.onExit(child, code, signal));
    await spawned;
    this.rpc = new RpcPeer(child, {
      jsonrpc: false,
      log: this.log,
      onRequest: (method, params) => this.onServerRequest(method, params),
      onNotification: (method, params) => this.onNotification(method, params),
    });

    const describe = (error) => new Error(`Codex didn't start: ${(this.stderr.trim() || error.message).slice(0, 300)}`);
    await this.rpc.request("initialize", { clientInfo: { name: "krubot", title: "Kru Bot", version: "1.0.0" } }, { timeoutMs: SETUP_TIMEOUT_MS }).catch((error) => {
      throw describe(error);
    });
    this.rpc.notify("initialized", {});

    const params = { ...(model ? { model } : {}), cwd: this.cwd, approvalPolicy: codexApprovalPolicy(permission), sandbox: "danger-full-access", developerInstructions: systemPrompt };
    let resumed = false;
    let recovered = false;
    if (this.sessionId) {
      try {
        await this.rpc.request("thread/resume", { threadId: this.sessionId, ...params }, { timeoutMs: SETUP_TIMEOUT_MS });
        resumed = true;
      } catch (error) {
        this.onWarning(`Codex couldn't resume thread ${this.sessionId} (${error.message}); starting a new one.`);
        this.sessionId = null;
        recovered = true;
      }
    }
    if (!this.sessionId) {
      const started = await this.rpc.request("thread/start", params, { timeoutMs: SETUP_TIMEOUT_MS }).catch((error) => {
        throw describe(error);
      });
      this.sessionId = started?.thread?.id ?? null;
      if (!this.sessionId) throw new Error("Codex started no thread");
      this.usageTotal = null;
    }
    this.systemPromptHash = createHash("sha256").update(systemPrompt).digest("hex");
    this.argsKey = argsKey;
    return { launched: true, resumed, recovered };
  }

  onExit(child, code, signal) {
    if (this.child !== child) return;
    this.log("exit", { code, signal });
    this.child = null;
    this.rpc = null;
    const turn = this.turn;
    if (turn) {
      this.turn = null;
      turn.finish({ ok: false, text: turn.reply.text(), stopReason: turn.interrupted ? "interrupted" : "exited", cost: null, usage: null, error: turn.interrupted ? "The turn was interrupted" : this.stderr.trim().slice(0, 500) || `Codex exited (${signal ?? code})` });
    }
  }

  onNotification(method, params) {
    const turn = this.turn;
    if (method === "thread/tokenUsage/updated") {
      if (params?.threadId === this.sessionId && params.tokenUsage?.total) this.usageTotal = params.tokenUsage.total;
      return;
    }
    if (!turn || (params?.threadId && params.threadId !== this.sessionId)) return;
    switch (method) {
      case "turn/started":
        if (params?.turn?.id) turn.turnId = params.turn.id;
        return;
      case "item/started": {
        const item = params?.item;
        if (item?.type === "fileChange") this.fileChanges.set(item.id, item.changes ?? []);
        if (item?.type === "agentMessage") return;
        if (item?.type && item.type !== "userMessage" && item.type !== "reasoning") turn.reply.tool();
        const line = codexActivity(item, this.cwd);
        if (line) turn.onEvent({ type: "activity", line });
        const step = codexStep(item, this.cwd, false);
        if (step) turn.onEvent({ type: "step", step });
        return;
      }
      case "item/completed": {
        const item = params?.item;
        const step = codexStep(item, this.cwd, true);
        if (step) turn.onEvent({ type: "step", step });
        if (item?.type === "agentMessage" && typeof item.text === "string") {
          turn.reply.block(item.text);
          const line = codexActivity(item, this.cwd);
          if (line) turn.onEvent({ type: "activity", line });
        }
        return;
      }
      case "error":
        if (params?.willRetry) turn.onEvent({ type: "activity", line: "Reconnecting to the model…" });
        else if (params?.error?.message) turn.error = params.error.message;
        return;
      case "turn/completed": {
        const status = params?.turn?.status ?? "failed";
        const error = params?.turn?.error?.message ?? turn.error ?? null;
        this.turn = null;
        turn.finish({
          ok: status === "completed",
          text: turn.reply.text(),
          stopReason: turn.interrupted ? "interrupted" : status,
          cost: null,
          usage: usageDelta(turn.usageBefore, this.usageTotal),
          error: status === "completed" ? null : turn.interrupted ? "The turn was interrupted" : error || `The turn ${status}`,
        });
        return;
      }
      default:
    }
  }

  /** The app-server asking us something: approvals go to the person, the rest is declined. */
  async onServerRequest(method, params) {
    switch (method) {
      case "item/commandExecution/requestApproval": {
        if (this.permission === "full") return { decision: "accept" };
        const command = unwrapCommand(params?.command ?? "");
        const answer = await this.askPermission("Bash", { command, ...(params?.reason ? { description: params.reason } : {}) });
        return { decision: answer.allow ? "accept" : "decline" };
      }
      case "item/fileChange/requestApproval": {
        if (this.permission !== "ask") return { decision: "accept" };
        const changes = this.fileChanges.get(params?.itemId) ?? [];
        const file = changes[0]?.path ?? "";
        const answer = await this.askPermission("Edit", { file_path: file, ...(changes.length > 1 ? { files: changes.map((c) => c.path) } : {}), ...(params?.reason ? { description: params.reason } : {}) });
        return { decision: answer.allow ? "accept" : "decline" };
      }
      case "mcpServer/elicitation/request": {
        const answer = await this.askPermission(`mcp__${params?.serverName ?? "server"}`, { message: params?.message ?? "" });
        return { action: answer.allow ? "accept" : "decline", content: answer.allow ? {} : null, _meta: null };
      }
      default:
        throw new Error(`${method} isn't supported by Kru Bot`);
    }
  }

  turnWith({ prompt, images, timeoutMs, onEvent, systemPrompt, signal }) {
    if (this.turn) return Promise.reject(new Error("A turn is already in flight"));
    if (!this.running || !this.rpc) return Promise.reject(new Error("No session"));
    this.clearIdle();
    let text = prompt;
    const hash = createHash("sha256").update(systemPrompt).digest("hex");
    if (hash !== this.systemPromptHash) {
      text = systemReminder(systemPrompt) + prompt;
      this.systemPromptHash = hash;
    }
    return new Promise((resolve) => {
      const turn = {
        onEvent,
        interrupted: false,
        turnId: null,
        reply: new ReplyText(),
        error: null,
        usageBefore: this.usageTotal,
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
        if (turn.turnId && this.rpc) void this.rpc.request("turn/interrupt", { threadId: this.sessionId, turnId: turn.turnId }).catch(() => undefined);
        setTimeout(() => {
          if (this.turn === turn) this.kill();
        }, INTERRUPT_GRACE_MS).unref?.();
      };
      const timer = setTimeout(interrupt, timeoutMs);
      if (signal?.aborted) {
        clearTimeout(timer);
        resolve({ ok: false, text: "", stopReason: "interrupted", cost: null, usage: null, error: "Aborted before the turn started" });
        return;
      }
      signal?.addEventListener("abort", interrupt, { once: true });
      this.turn = turn;
      this.log("in", { prompt: text.length, images: images?.length ?? 0 });
      this.rpc
        .request("turn/start", { threadId: this.sessionId, input: codexInput(text, images) })
        .then((started) => {
          if (started?.turn?.id) turn.turnId ??= started.turn.id;
          if (turn.interrupted && this.rpc) void this.rpc.request("turn/interrupt", { threadId: this.sessionId, turnId: turn.turnId }).catch(() => undefined);
        })
        .catch((error) => {
          if (this.turn !== turn) return;
          this.turn = null;
          turn.finish({ ok: false, text: "", stopReason: "error", cost: null, usage: null, error: error.message });
        });
    });
  }

  /**
   * Hands the person's message to the turn in flight with `turn/steer`,
   * which the app-server works in at the model's next step. It answers an
   * error when that turn has already ended, and the message waits instead.
   */
  async steer(text) {
    const turn = this.turn;
    if (!turn || turn.interrupted || !turn.turnId || !this.rpc) return false;
    this.log("in", { steer: text.length });
    try {
      await this.rpc.request("turn/steer", { threadId: this.sessionId, expectedTurnId: turn.turnId, input: codexInput(text, []) }, { timeoutMs: 10_000 });
      return true;
    } catch {
      return false;
    }
  }

  kill() {
    const child = this.child;
    if (!child) return;
    killTree(child, "SIGTERM");
    setTimeout(() => killTree(child, "SIGKILL"), 5_000).unref?.();
  }

  async close({ keepSession = true } = {}) {
    this.clearIdle();
    await this.stopChild();
    this.child = null;
    this.rpc = null;
    if (!keepSession) {
      this.sessionId = null;
      this.usageTotal = null;
    }
    await this.closeBridge();
  }
}
