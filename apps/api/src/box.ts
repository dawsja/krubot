import type { Engine, EngineSignIn, EngineStatus, ModelChoice } from "@krubot/shared";
import { readFileSync } from "node:fs";
import path from "node:path";
import { getUser, isAdmin } from "./data/users.ts";

/*
 * Client for the box (packages/box/server.mjs): the computer every bot
 * works on. Configured with KRU_BOX_URL; the token comes from KRU_BOX_TOKEN
 * or the file the box writes into the shared state volume
 * (KRU_BOX_STATE_DIR/token, /box-state in Docker).
 *
 * Every person has their own account on the box, so a config is made for
 * a person (`boxConfig(userId)`) and every request about a home carries
 * them in X-Kru-User. The box answers `no_account` for someone it hasn't
 * met; the account is made then (POST /accounts, the admin as `agent`,
 * anyone else as a new Linux user with a home of their own) and the
 * request tried again, so nothing has to be set up ahead of time.
 */

export type BoxConfig = { url: string; token: string; user: string | null };

export type ExecResult = {
  exitCode: number;
  signal: string | null;
  output: string;
  truncated: boolean;
  timedOut: boolean;
};

export function boxUrl(): string | null {
  const url = (process.env.KRU_BOX_URL ?? "").trim().replace(/\/+$/, "");
  return url || null;
}

function boxToken(): string {
  const fromEnv = (process.env.KRU_BOX_TOKEN ?? "").trim();
  if (fromEnv) return fromEnv;
  const file = path.join(process.env.KRU_BOX_STATE_DIR || "/box-state", "token");
  try {
    const token = readFileSync(file, "utf8").trim();
    if (token) return token;
  } catch {
    /* fall through */
  }
  throw new Error(`No box token: set KRU_BOX_TOKEN on the API and the box, or mount the box's state volume at ${path.dirname(file)}.`);
}

/** The box for one person's things; without a person, only for what is nobody's (update, reset, versions). */
export function boxConfig(userId: string | null = null): BoxConfig | null {
  const url = boxUrl();
  return url ? { url, token: boxToken(), user: userId } : null;
}

/** Bots can't run without the box; Kru Bot is the containers together. */
export function requireBoxConfig(userId: string | null = null): BoxConfig {
  const config = boxConfig(userId);
  if (!config) {
    throw new Error("Kru Bot needs its box to run bots. Start the box container and set KRU_BOX_URL (docker-compose.yml does both).");
  }
  return config;
}

export class BoxError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "BoxError";
    this.status = status;
  }
}

function headersFor(config: BoxConfig, extra: Record<string, string> = {}): Record<string, string> {
  return { Authorization: `Bearer ${config.token}`, ...(config.user ? { "X-Kru-User": config.user } : {}), ...extra };
}

/**
 * One request to the box. A `no_account` answer for a person means the box
 * hasn't met them yet: their account is made and the request sent once
 * more. Bodies are re-sent from `body`, so a stream's body is never read
 * twice.
 */
async function request(config: BoxConfig, route: string, init: { method: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }, retried = false): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(`${config.url}${route}`, { method: init.method, headers: headersFor(config, init.headers), body: init.body, redirect: "error", signal: init.signal });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown error";
    throw new BoxError(`The box at ${config.url} isn't reachable (${detail}). Is the box service running?`, 0);
  }
  if (res.status === 404 && config.user && !retried) {
    const peek = (await res.clone().json().catch(() => ({}))) as { code?: string };
    if (peek.code === "no_account") {
      await res.body?.cancel().catch(() => undefined);
      await ensureBoxAccount(config);
      return request(config, route, init, true);
    }
  }
  return res;
}

async function call<T>(config: BoxConfig, method: string, route: string, body?: unknown, timeoutMs = 60_000): Promise<T> {
  const res = await request(config, route, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string } & T;
  if (!res.ok) throw new BoxError(data.error ?? `Box request failed (${res.status})`, res.status);
  return data;
}

// ---------- accounts ----------

export type BoxAccount = { id: string; name: string; uid: number | null; home: string };

/** The accounts this API has made or met, by person: their home's path is what `boxHome` answers. */
const knownAccounts = new Map<string, BoxAccount>();

/**
 * Makes sure the person a config is for has an account on the box. The
 * admin is the agent; anyone else gets a Linux user and a home of their own.
 */
export async function ensureBoxAccount(config: BoxConfig): Promise<BoxAccount> {
  if (!config.user) throw new BoxError("No person to make an account for", 400);
  const user = getUser(config.user);
  if (!user) throw new BoxError("No such person", 404);
  const { account } = await call<{ ok: true; account: BoxAccount }>({ ...config, user: null }, "POST", "/accounts", { id: user.id, name: user.name, email: user.email, admin: isAdmin(user) }, 30_000);
  knownAccounts.set(user.id, account);
  return account;
}

/**
 * Forgets every account this API has met: after a reset there are none on
 * the box, and the account a person gets next may have another name, uid
 * and home. The next request about a home makes it again.
 */
export function forgetBoxAccounts(): void {
  knownAccounts.clear();
}

/** Where a person's home is on the box, once their account has been made or met this process; null before. */
export function boxHome(userId: string): string | null {
  return knownAccounts.get(userId)?.home ?? null;
}

/** Removes a person's account from the box: their user, their home, their bots' files and their sign-ins. */
export async function removeBoxAccount(config: BoxConfig, userId: string): Promise<void> {
  await call({ ...config, user: null }, "DELETE", `/accounts/${userId}`, undefined, 120_000);
  knownAccounts.delete(userId);
}

// ---------- each person's skills library ----------

/** One file of a skill folder on its way to the box, SKILL.md included. */
export type BoxSkillFile = { path: string; data: string; executable: boolean };

/** The skills folders in a person's library on the box, by slug. */
export function listBoxSkills(config: BoxConfig): Promise<{ skills: string[] }> {
  return call(config, "GET", "/skills", undefined, 10_000);
}

/** Writes one skill's whole folder (bytes in base64), replacing what was there. */
export function writeBoxSkill(config: BoxConfig, slug: string, files: BoxSkillFile[]): Promise<{ ok: true }> {
  return call(config, "PUT", `/skills/${slug}`, { files }, 120_000);
}

export async function deleteBoxSkill(config: BoxConfig, slug: string): Promise<void> {
  await call(config, "DELETE", `/skills/${slug}`);
}

export const EXEC_TIMEOUT_MS = 10 * 60 * 1000;

export function health(config: BoxConfig): Promise<{ ok: boolean; agents: number; desktops?: number; updating?: boolean }> {
  return fetch(`${config.url}/health`, { signal: AbortSignal.timeout(5_000) }).then((r) => r.json() as Promise<{ ok: boolean; agents: number; updating?: boolean }>);
}

// ---------- updates and versions ----------

export type BoxUpdateStatus = { running: boolean; startedAt?: string; finishedAt?: string | null; ok?: boolean | null; exitCode?: number | null; log?: string };

/** Starts the in-place update (update.sh) on the box; the box pauses itself first. */
export function startBoxUpdate(config: BoxConfig): Promise<{ ok: true; startedAt: string }> {
  return call(config, "POST", "/update", {}, 120_000);
}

/**
 * Puts the computer back to how it was built: every person's account and
 * home goes, the admin's home is emptied, and only the CLI sign-ins are
 * kept, for the account each person gets next. The box pauses itself
 * first; the API writes the skills and the bots' SOUL.md back afterwards.
 */
export function resetBox(config: BoxConfig): Promise<{ ok: true; removed: string[]; accounts: string[] }> {
  return call(config, "POST", "/reset", {}, 300_000);
}

export function boxUpdateStatus(config: BoxConfig): Promise<BoxUpdateStatus> {
  return call(config, "GET", "/update", undefined, 10_000);
}

export type BoxVersions = { node: string | null; bun: string | null; claude: string | null; codex?: string | null; grok?: string | null };

export function boxVersions(config: BoxConfig): Promise<BoxVersions> {
  return call(config, "GET", "/versions", undefined, 30_000);
}

// ---------- the bot's computer ----------

export function execOnBox(config: BoxConfig, command: string, options: { cwd?: string | null; timeoutMs?: number } = {}): Promise<ExecResult> {
  const timeoutMs = options.timeoutMs ?? EXEC_TIMEOUT_MS;
  return call(config, "POST", "/exec", { command, cwd: options.cwd ?? null, timeoutMs }, timeoutMs + 30_000);
}

export function readBoxFile(config: BoxConfig, filePath: string): Promise<{ content?: string; directory?: string[]; binary?: boolean; size?: number }> {
  return call(config, "GET", `/files?path=${encodeURIComponent(filePath)}`);
}

/** A file's bytes, up to 100 MB, for handing it to the person in the chat. */
export async function readBoxFileBytes(config: BoxConfig, filePath: string): Promise<Uint8Array> {
  const res = await request(config, `/files/raw?path=${encodeURIComponent(filePath)}`, { method: "GET", signal: AbortSignal.timeout(120_000) });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new BoxError(data.error ?? `Box request failed (${res.status})`, res.status);
  }
  return new Uint8Array(await res.arrayBuffer());
}

export function writeBoxFile(config: BoxConfig, filePath: string, content: string): Promise<{ ok: true }> {
  return call(config, "PUT", "/files", { path: filePath, content });
}

export async function deleteBoxFile(config: BoxConfig, filePath: string): Promise<void> {
  await call(config, "DELETE", `/files?path=${encodeURIComponent(filePath)}`);
}

export function ensureBotHome(config: BoxConfig, botId: string): Promise<{ ok: true; dir: string }> {
  return call(config, "POST", `/bots/${botId}`);
}

export async function deleteBotHome(config: BoxConfig, botId: string): Promise<void> {
  await call(config, "DELETE", `/bots/${botId}`);
}

// ---------- live streams and terminals ----------

/**
 * Opens one of the box's server-sent event streams and returns the raw
 * response, for a route handler to pass through to the browser. A `body`
 * makes it a POST, for streams that start something.
 */
export async function openBoxStream(config: BoxConfig, route: string, signal?: AbortSignal, body?: unknown): Promise<Response> {
  const res = await request(config, route, {
    method: body === undefined ? "GET" : "POST",
    headers: { Accept: "text/event-stream", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new BoxError(data.error ?? `Box request failed (${res.status})`, res.status);
  }
  return res;
}

export function createTerminal(config: BoxConfig, input: { bot?: string | null; cols: number; rows: number }): Promise<{ id: string; cwd: string }> {
  return call(config, "POST", "/terminals", input);
}

export function terminalInput(config: BoxConfig, id: string, data: string): Promise<{ ok: true }> {
  return call(config, "POST", `/terminals/${id}/input`, { data });
}

export function terminalResize(config: BoxConfig, id: string, size: { cols: number; rows: number }): Promise<{ ok: true }> {
  return call(config, "POST", `/terminals/${id}/resize`, size);
}

export async function closeTerminal(config: BoxConfig, id: string): Promise<void> {
  await call(config, "DELETE", `/terminals/${id}`);
}

// ---------- Claude Code, in this person's account ----------

export type ClaudeCheck = { status: "ok" | "missing" | "unauthenticated" | "error"; detail: string };

export function checkClaude(config: BoxConfig): Promise<ClaudeCheck> {
  return call(config, "POST", "/claude/check", {}, 45_000);
}

export type ClaudeAuth = { known: boolean; loggedIn: boolean | null; email?: string | null; org?: string | null; method?: string | null };

export function claudeAuth(config: BoxConfig): Promise<ClaudeAuth> {
  return call(config, "GET", "/claude/auth", undefined, 20_000);
}

// ---------- Codex and Grok ----------

export type EnginesAuth = { codex: EngineStatus; grok: EngineStatus };

export function enginesAuth(config: BoxConfig): Promise<EnginesAuth> {
  return call(config, "GET", "/engines/auth", undefined, 30_000);
}

/**
 * The models a CLI itself says it can run, in this person's account: Codex
 * over its app-server, Grok from `grok models`, Claude Code's aliases. A
 * plan has no /models endpoint, so this is the only honest source.
 */
export function engineModels(config: BoxConfig, engine: Engine): Promise<{ models: ModelChoice[] }> {
  return call(config, "GET", `/engines/${engine}/models`, undefined, 45_000);
}

// ---------- signing a CLI in, without a terminal ----------

/**
 * The computer runs the CLI's own login for this person and hands back the
 * link to open and the code to enter. Nothing about the credentials comes
 * this way: they are written in that person's account on the box.
 */
export function startEngineSignIn(config: BoxConfig, engine: Engine): Promise<{ signIn: EngineSignIn }> {
  return call(config, "POST", `/engines/${engine}/sign-in`, {}, 30_000);
}

export function engineSignIn(config: BoxConfig, engine: Engine): Promise<{ signIn: EngineSignIn | null }> {
  return call(config, "GET", `/engines/${engine}/sign-in`, undefined, 15_000);
}

/** The code from the sign-in page, for the CLI that asks for one. */
export function engineSignInCode(config: BoxConfig, engine: Engine, code: string): Promise<{ signIn: EngineSignIn }> {
  return call(config, "POST", `/engines/${engine}/sign-in/code`, { code }, 15_000);
}

export async function cancelEngineSignIn(config: BoxConfig, engine: Engine): Promise<void> {
  await call(config, "DELETE", `/engines/${engine}/sign-in`, undefined, 15_000);
}

/** Reads server-sent events off a response body: the JSON after each `data:` line. */
export async function* readEvents<T>(body: ReadableStream<Uint8Array>): AsyncGenerator<T> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    pending += decoder.decode(value, { stream: true });
    let end = pending.indexOf("\n\n");
    while (end !== -1) {
      const frame = pending.slice(0, end);
      pending = pending.slice(end + 2);
      for (const line of frame.split("\n")) {
        if (line.startsWith("data:")) yield JSON.parse(line.slice(5).trim()) as T;
      }
      end = pending.indexOf("\n\n");
    }
  }
}

// ---------- bots on Claude Code ----------

/** A tool as the CLI's `kru` MCP server lists it. */
export type AgentTool = { name: string; description: string; inputSchema: unknown };

/** How a session reaches its model: the plan signed in on the box, or the LLM proxy with its token. */
export type BoxAccess = { kind: "plan" } | { kind: "api"; baseUrl: string; token: string; smallModel?: string | null };

export type AgentTurnInput = {
  bot: string;
  /** The CLI to run: Claude Code, Codex or Grok. */
  engine: Engine;
  access: BoxAccess;
  /** Your MCP servers, as the box writes them next to the kru bridge. */
  mcpServers?: unknown[];
  model: string;
  maxTurns?: number | null;
  permission: "ask" | "full";
  systemPrompt: string;
  prompt: string;
  attachments?: { name: string; mediaType: string; data: string }[];
  tools: AgentTool[];
  timeoutMs: number;
};

export type AgentEvent =
  | { type: "init"; sessionId: string; permissionMode: string | null }
  | { type: "line"; line: string }
  /** Codex and Grok: an activity line the box already put in words. */
  | { type: "activity"; line: string }
  | { type: "tool_call"; callId: string; name: string; input: Record<string, unknown> }
  | AgentTurnResult
  | { type: "error"; missing: boolean; message: string };

export type AgentTurnResult = {
  type: "result";
  ok: boolean;
  text: string;
  stopReason: string | null;
  cost: number | null;
  usage: { input: number; output: number; cachedInput: number } | null;
  error?: string;
  sessionId: string | null;
  launched: boolean;
  resumed: boolean;
  recovered: boolean;
};

/**
 * Runs one turn of a bot's persistent CLI session. Tool calls
 * arrive as events and must be answered with `answerAgentTool` while the
 * turn runs. Resolves with the result, or null when the stream ended
 * without one.
 */
export async function runAgentTurn(
  config: BoxConfig,
  agentId: string,
  input: AgentTurnInput,
  options: { signal?: AbortSignal; onEvent: (event: AgentEvent) => void },
): Promise<AgentTurnResult | null> {
  const res = await openBoxStream(config, `/agents/${agentId}/turn`, options.signal, input);
  if (!res.body) throw new BoxError("The box sent no stream", 502);
  let result: AgentTurnResult | null = null;
  for await (const event of readEvents<AgentEvent>(res.body)) {
    options.onEvent(event);
    if (event.type === "result") result = event;
    if (event.type === "error") throw new BoxError(event.message, event.missing ? 424 : 502);
  }
  return result;
}

export function answerAgentTool(config: BoxConfig, agentId: string, answer: { callId: string; content: string; isError?: boolean }): Promise<{ ok: true }> {
  return call(config, "POST", `/agents/${agentId}/tool-result`, answer, 30_000);
}

/** Hands the person's message to a bot's turn in flight; `steered` is false when it couldn't take it. */
export function steerAgent(config: BoxConfig, agentId: string, text: string): Promise<{ steered: boolean }> {
  return call(config, "POST", `/agents/${agentId}/steer`, { text }, 15_000);
}

export function interruptAgent(config: BoxConfig, agentId: string): Promise<{ ok: true; interrupted: boolean }> {
  return call(config, "POST", `/agents/${agentId}/interrupt`, {});
}

export async function closeAgent(config: BoxConfig, agentId: string): Promise<void> {
  await call(config, "DELETE", `/agents/${agentId}`);
}

/** Every live session on the box, everyone's, with whose it is. */
export function listAgents(config: BoxConfig): Promise<{ agents: { id: string; user: string | null; running: boolean; busy: boolean }[] }> {
  return call(config, "GET", "/agents", undefined, 10_000);
}

// ---------- desktop ----------

export type DesktopStatus = { running: boolean; ready: boolean; width: number | null; height: number | null; viewers: number };

export function desktopStatus(config: BoxConfig): Promise<DesktopStatus> {
  return call(config, "GET", "/desktop", undefined, 10_000);
}

export function startDesktop(config: BoxConfig, size: { width: number; height: number }): Promise<DesktopStatus> {
  return call(config, "POST", "/desktop", size, 45_000);
}

export async function stopDesktop(config: BoxConfig): Promise<void> {
  await call(config, "DELETE", "/desktop");
}

export function connectDesktop(config: BoxConfig, size: { width: number; height: number }): Promise<{ id: string; width: number | null; height: number | null }> {
  return call(config, "POST", "/desktop/connections", size, 45_000);
}

export function desktopInput(config: BoxConfig, id: string, data: string): Promise<{ ok: true }> {
  return call(config, "POST", `/desktop/connections/${id}/input`, { data });
}

export async function disconnectDesktop(config: BoxConfig, id: string): Promise<void> {
  await call(config, "DELETE", `/desktop/connections/${id}`);
}
