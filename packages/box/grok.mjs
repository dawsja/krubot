/**
 * Persistent Grok Build sessions for the bots, through `grok agent stdio`
 * (the Agent Client Protocol: JSON-RPC 2.0 over stdio). One process per
 * (bot, thread), kept across turns and closed after an idle timeout, like
 * the Claude Code sessions in agents.mjs; the session id is kept, so a
 * closed process picks the same session up again.
 *
 * Kru's tools reach Grok as the `kru` MCP server (the same bridge Claude
 * Code uses); Grok finds them with its tool search and calls them as
 * `kru__<tool>`, and they are let through: the API gates them itself.
 * Grok's own permission questions (`session/request_permission`) go to the
 * person as `permission` calls. Grok has no system prompt flag in this
 * mode, so the persona opens a session's first message and later changes
 * arrive as a reminder, as with the other CLIs.
 *
 * The person signs in once in a terminal (`grok login --device-auth`) and
 * the login stays in ~/.grok on the home volume; or the bots run on an
 * OpenAI-compatible API (xAI's own, typically) through Kru's LLM proxy,
 * which holds the key. Grok's compatibility with Claude Code and Cursor is
 * off, so it never picks up the Claude bots' instructions, skills or hooks.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { BridgedSession, MAX_STDERR, killTree, systemReminder } from "./bridge.mjs";
import { RpcPeer } from "./rpc.mjs";

/** The CLI to run; tests point this at a script. */
export const GROK_BIN = process.env.GROK_BIN || "grok";
const SETUP_TIMEOUT_MS = 60_000;
const INTERRUPT_GRACE_MS = 10_000;

/** Credentials the parent may carry; a Grok session must not inherit them. */
export const GROK_CREDENTIAL_ENV = ["XAI_API_KEY", "GROK_XAI_API_BASE_URL", "GROK_MODELS_BASE_URL", "GROK_MODELS_LIST_URL"];

/** What Grok would otherwise borrow from Claude Code and Cursor on a shared box. */
const COMPAT_OFF = Object.fromEntries(
  ["CLAUDE", "CURSOR"].flatMap((tool) => ["SKILLS", "RULES", "AGENTS", "MCPS", "HOOKS"].map((what) => [`GROK_${tool}_${what}_ENABLED`, "0"])),
);

/** The environment a Grok session runs with. */
export function grokEnv(base, access) {
  const env = { ...base };
  for (const name of GROK_CREDENTIAL_ENV) delete env[name];
  Object.assign(env, COMPAT_OFF, { GROK_DISABLE_AUTOUPDATER: "1" });
  if (access?.kind === "api") {
    env.XAI_API_KEY = access.token;
    env.GROK_XAI_API_BASE_URL = access.baseUrl;
  }
  return env;
}

/** `grok agent` flags for a session. Full access skips Grok's own questions. */
export function grokArgs({ model, effort, permission }) {
  const args = ["agent"];
  if (permission === "full") args.push("--always-approve");
  if (model) args.push("--model", model);
  if (effort) args.push("--reasoning-effort", effort);
  args.push("stdio");
  return args;
}

/** The MCP servers for `session/new`, in ACP's shape: env and headers as name/value lists. */
export function acpMcpServers({ node, mcpScript, socketPath, mcpServers = [] }) {
  const pairs = (record) => Object.entries(record && typeof record === "object" ? record : {}).map(([name, value]) => ({ name, value: String(value) }));
  const out = [{ name: "kru", command: node, args: [mcpScript, socketPath], env: [] }];
  for (const server of mcpServers) {
    if (!server || typeof server.name !== "string" || !/^[a-z0-9][a-z0-9_-]*$/i.test(server.name) || server.name === "kru") continue;
    if (server.type === "http" && typeof server.url === "string") out.push({ type: "http", name: server.name, url: server.url, headers: pairs(server.headers) });
    else if (server.type === "stdio" && typeof server.command === "string" && server.command) out.push({ name: server.name, command: server.command, args: Array.isArray(server.args) ? server.args.map(String) : [], env: pairs(server.env) });
  }
  return out;
}

/** The opening of a session's first message: the persona, since Grok takes no system prompt here. */
export function withPersona(persona, prompt) {
  return `<instructions>\n${persona}\n</instructions>\n\n${prompt}`;
}

function oneLine(text, max = 160) {
  return String(text ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

/** A tool call Grok announced, as a short activity line, or null. */
export function grokActivity(toolCall, cwd) {
  const input = toolCall?.rawInput && typeof toolCall.rawInput === "object" ? toolCall.rawInput : {};
  const name = toolCall?._meta?.["x.ai/tool"]?.name ?? toolCall?.title ?? "tool";
  const relative = (file) => (cwd && typeof file === "string" && file.startsWith(`${cwd}/`) ? file.slice(cwd.length + 1) : file);
  if (name === "use_tool" && typeof input.tool_name === "string") {
    const [server, ...rest] = input.tool_name.split("__");
    const tool = rest.join("__") || server;
    const first = Object.values(input.tool_input ?? {}).find((v) => typeof v === "string");
    if (server === "kru" && tool === "permission") return null;
    return `${server === "kru" ? tool : `${server}: ${tool}`}${first ? ` ${oneLine(first, 120)}` : ""}`;
  }
  if (name === "search_tool") return null;
  if (typeof input.command === "string") return `$ ${oneLine(input.command)}`;
  const file = input.path ?? input.file_path ?? input.target_file ?? toolCall?.locations?.[0]?.path;
  if (typeof file === "string") return `${/read/i.test(name) ? "Reading" : /write|replace|edit/i.test(name) ? "Editing" : name} ${relative(file)}`;
  if (typeof input.query === "string") return `Searching ${oneLine(input.query, 120)}`;
  if (typeof input.url === "string") return `Opening ${oneLine(input.url, 120)}`;
  return oneLine(toolCall?.title ?? name, 120) || null;
}

/** How a permission question reads to the person: Claude Code's tool names, which the approval card knows. */
export function permissionSubject(toolCall) {
  const input = toolCall?.rawInput && typeof toolCall.rawInput === "object" ? { ...toolCall.rawInput } : {};
  const kind = toolCall?.kind;
  if (kind === "execute" || typeof input.command === "string") return { tool: "Bash", input: { command: String(input.command ?? toolCall?.title ?? ""), ...(input.description ? { description: String(input.description) } : {}) } };
  if (kind === "edit" || kind === "delete" || kind === "move") {
    const file = input.path ?? input.file_path ?? input.target_file ?? toolCall?.locations?.[0]?.path ?? "";
    return { tool: kind === "edit" ? "Edit" : "Write", input: { file_path: String(file) } };
  }
  if (kind === "fetch") return { tool: "WebFetch", input: { url: String(input.url ?? toolCall?.title ?? "") } };
  const name = toolCall?._meta?.["x.ai/tool"]?.name ?? toolCall?.title ?? "tool";
  return { tool: String(name), input };
}

/** Picks the option id for an answer: once, never "always", so every later call asks again. */
export function permissionOutcome(options, allow) {
  const list = Array.isArray(options) ? options : [];
  const want = allow ? ["allow_once", "allow_always"] : ["reject_once", "reject_always"];
  for (const kind of want) {
    const option = list.find((o) => o?.kind === kind);
    if (option) return { outcome: { outcome: "selected", optionId: option.optionId } };
  }
  return { outcome: { outcome: "cancelled" } };
}

/** Images as ACP content blocks; other files are left out. */
export function grokPrompt(text, images = [], imagesSupported = false) {
  const prompt = [{ type: "text", text }];
  if (!imagesSupported) return prompt;
  for (const file of images) {
    if (file && typeof file.data === "string" && typeof file.mediaType === "string" && file.mediaType.startsWith("image/")) {
      prompt.push({ type: "image", data: file.data, mimeType: file.mediaType });
    }
  }
  return prompt;
}

export class GrokSession extends BridgedSession {
  constructor(options) {
    super(options);
    this.engine = "grok";
    this.bin = options.bin ?? GROK_BIN;
    this.node = options.node ?? process.execPath;
    this.rpc = null;
    this.permission = "ask";
    this.imagesSupported = false;
    /** True once the persona is in the session's history. */
    this.personaSent = false;
    this.replaying = false;
  }

  bridgeTools() {
    return this.tools.filter((tool) => tool.name !== "permission");
  }

  async ensure({ model, effort, systemPrompt, tools, permission = "ask", mcpServers = [], access = { kind: "plan" } }) {
    this.tools = tools;
    this.permission = permission;
    const argsKey = createHash("sha256")
      .update(JSON.stringify({ engine: "grok", model, effort: effort ?? null, permission, mcpServers, access, tools: tools.map((t) => t.name).sort() }))
      .digest("hex")
      .slice(0, 16);
    if (this.running && this.argsKey === argsKey) return { launched: false };
    if (this.running) await this.close({ keepSession: true });

    const socketPath = await this.listen();
    const args = grokArgs({ model, effort, permission });
    this.stderr = "";
    this.log("spawn", { args });
    const child = spawn(this.bin, args, {
      cwd: this.cwd,
      env: grokEnv(this.baseEnv, access),
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
      jsonrpc: true,
      log: this.log,
      onRequest: (method, params) => this.onAgentRequest(method, params),
      onNotification: (method, params) => this.onNotification(method, params),
    });

    const describe = (error) => new Error(`Grok didn't start: ${(error.message || this.stderr.trim()).slice(0, 300)}`);
    const init = await this.rpc
      .request("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } }, { timeoutMs: SETUP_TIMEOUT_MS })
      .catch((error) => {
        throw describe(error);
      });
    this.imagesSupported = Boolean(init?.agentCapabilities?.promptCapabilities?.image);
    const methods = (init?.authMethods ?? []).map((m) => m?.id);
    const method = access.kind === "api" ? "xai.api_key" : methods.includes("cached_token") ? "cached_token" : null;
    if (method && methods.includes(method)) {
      await this.rpc.request("authenticate", { methodId: method, _meta: { headless: true } }, { timeoutMs: SETUP_TIMEOUT_MS }).catch((error) => {
        throw new Error(access.kind === "api" ? `Grok refused the API key: ${error.message}` : `Grok isn't signed in: ${error.message}. Run grok login --device-auth in a terminal on the computer.`);
      });
    }

    const servers = acpMcpServers({ node: this.node, mcpScript: this.mcpScript, socketPath, mcpServers });
    let resumed = false;
    let recovered = false;
    if (this.sessionId) {
      const caps = init?.agentCapabilities ?? {};
      const attempts = [...(caps.sessionCapabilities?.resume ? ["session/resume"] : []), ...(caps.loadSession ? ["session/load"] : [])];
      for (const call of attempts) {
        try {
          // A load replays the history as updates; none of it belongs to a turn.
          this.replaying = true;
          await this.rpc.request(call, { sessionId: this.sessionId, cwd: this.cwd, mcpServers: servers }, { timeoutMs: SETUP_TIMEOUT_MS });
          resumed = true;
          break;
        } catch (error) {
          this.onWarning(`Grok couldn't ${call.slice(8)} session ${this.sessionId} (${error.message}).`);
        } finally {
          this.replaying = false;
        }
      }
      if (!resumed) {
        this.sessionId = null;
        recovered = true;
      }
    }
    if (!this.sessionId) {
      const created = await this.rpc.request("session/new", { cwd: this.cwd, mcpServers: servers }, { timeoutMs: SETUP_TIMEOUT_MS }).catch((error) => {
        throw describe(error);
      });
      this.sessionId = created?.sessionId ?? null;
      if (!this.sessionId) throw new Error("Grok started no session");
      this.personaSent = false;
    }
    if (!this.personaSent) this.systemPromptHash = null;
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
      turn.finish({ ok: false, text: turn.text, stopReason: turn.interrupted ? "interrupted" : "exited", cost: null, usage: null, error: turn.interrupted ? "The turn was interrupted" : this.stderr.trim().slice(0, 500) || `Grok exited (${signal ?? code})` });
    }
  }

  onNotification(method, params) {
    const turn = this.turn;
    if (!turn || this.replaying || (params?.sessionId && params.sessionId !== this.sessionId)) return;
    const update = params?.update ?? {};
    if (method === "session/update") {
      switch (update.sessionUpdate) {
        case "agent_message_chunk":
          if (update.content?.type === "text" && typeof update.content.text === "string") turn.text += update.content.text;
          return;
        case "tool_call": {
          // What it said before reaching for a tool was narration; the answer comes after the last one.
          if (turn.text.trim()) turn.onEvent({ type: "activity", line: oneLine(turn.text, 200) });
          turn.text = "";
          const line = grokActivity(update, this.cwd);
          if (line) turn.onEvent({ type: "activity", line });
          return;
        }
        default:
          return;
      }
    }
    if (method === "_x.ai/session_notification" && update.sessionUpdate === "turn_completed" && update.usage) {
      const usage = update.usage;
      turn.usage = { input: (usage.inputTokens ?? 0) + (usage.cachedReadTokens ?? 0), output: usage.outputTokens ?? 0, cachedInput: usage.cachedReadTokens ?? 0 };
    }
  }

  /** Grok asking us something: permission questions go to the person, file and terminal access isn't offered. */
  async onAgentRequest(method, params) {
    if (method !== "session/request_permission") throw new Error(`${method} isn't supported by Kru Bot`);
    const toolCall = params?.toolCall ?? {};
    const options = params?.options ?? [];
    if (!this.turn) return { outcome: { outcome: "cancelled" } };
    const input = toolCall.rawInput && typeof toolCall.rawInput === "object" ? toolCall.rawInput : {};
    // Kru's own tools gate themselves in the API.
    if (typeof input.tool_name === "string" && input.tool_name.startsWith("kru__")) return permissionOutcome(options, true);
    if (this.permission === "full") return permissionOutcome(options, true);
    if (this.permission === "edits" && toolCall.kind === "edit") return permissionOutcome(options, true);
    const subject = permissionSubject(toolCall);
    const answer = await this.askPermission(subject.tool, subject.input);
    return permissionOutcome(options, answer.allow);
  }

  turnWith({ prompt, images, timeoutMs, onEvent, systemPrompt, signal }) {
    if (this.turn) return Promise.reject(new Error("A turn is already in flight"));
    if (!this.running || !this.rpc) return Promise.reject(new Error("No session"));
    this.clearIdle();
    let text = prompt;
    const hash = createHash("sha256").update(systemPrompt).digest("hex");
    if (!this.personaSent) text = withPersona(systemPrompt, prompt);
    else if (hash !== this.systemPromptHash) text = systemReminder(systemPrompt) + prompt;
    this.systemPromptHash = hash;
    this.personaSent = true;
    return new Promise((resolve) => {
      const turn = {
        onEvent,
        interrupted: false,
        text: "",
        usage: null,
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
        this.rpc?.notify("session/cancel", { sessionId: this.sessionId });
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
        .request("session/prompt", { sessionId: this.sessionId, prompt: grokPrompt(text, images, this.imagesSupported) })
        .then((done) => {
          if (this.turn !== turn) return;
          this.turn = null;
          const stopReason = turn.interrupted ? "interrupted" : (done?.stopReason ?? "end_turn");
          const ok = stopReason === "end_turn" || stopReason === "max_tokens" || stopReason === "max_turn_requests";
          turn.finish({ ok: ok && !turn.interrupted, text: turn.text.trim(), stopReason, cost: null, usage: turn.usage, error: ok ? null : stopReason === "interrupted" || stopReason === "cancelled" ? "The turn was interrupted" : `Grok stopped (${stopReason})` });
        })
        .catch((error) => {
          if (this.turn !== turn) return;
          this.turn = null;
          turn.finish({ ok: false, text: turn.text.trim(), stopReason: "error", cost: null, usage: null, error: error.message });
        });
    });
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
      this.personaSent = false;
    }
    await this.closeBridge();
  }
}
