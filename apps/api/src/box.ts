import type { Engine, EngineStatus } from "@krubot/shared";
import { readFileSync } from "node:fs";
import path from "node:path";

/*
 * Client for the box (packages/box/server.mjs): the computer every bot
 * works on. Configured with KRU_BOX_URL; the token comes from KRU_BOX_TOKEN
 * or the file the box writes into the shared state volume
 * (KRU_BOX_STATE_DIR/token, /box-state in Docker).
 */

export type BoxConfig = { url: string; token: string };

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

export function boxConfig(): BoxConfig | null {
  const url = boxUrl();
  return url ? { url, token: boxToken() } : null;
}

/** Bots can't run without the box; Kru Bot is the containers together. */
export function requireBoxConfig(): BoxConfig {
  const config = boxConfig();
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

async function call<T>(config: BoxConfig, method: string, route: string, body?: unknown, timeoutMs = 60_000): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${config.url}${route}`, {
      method,
      headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown error";
    throw new BoxError(`The box at ${config.url} isn't reachable (${detail}). Is the box service running?`, 0);
  }
  const data = (await res.json().catch(() => ({}))) as { error?: string } & T;
  if (!res.ok) throw new BoxError(data.error ?? `Box request failed (${res.status})`, res.status);
  return data;
}

export const EXEC_TIMEOUT_MS = 10 * 60 * 1000;

export function health(config: BoxConfig): Promise<{ ok: boolean; agents: number; updating?: boolean }> {
  return fetch(`${config.url}/health`, { signal: AbortSignal.timeout(5_000) }).then((r) => r.json() as Promise<{ ok: boolean; agents: number; updating?: boolean }>);
}

// ---------- updates and versions ----------

export type BoxUpdateStatus = { running: boolean; startedAt?: string; finishedAt?: string | null; ok?: boolean | null; exitCode?: number | null; log?: string };

/** Starts the in-place update (update.sh) on the box; the box pauses itself first. */
export function startBoxUpdate(config: BoxConfig): Promise<{ ok: true; startedAt: string }> {
  return call(config, "POST", "/update", {}, 120_000);
}

/** Wipes the agent's home except the bots, the team's files and the Claude sign-in. The box pauses itself first. */
export function resetBox(config: BoxConfig): Promise<{ ok: true; removed: string[] }> {
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

/** A file's bytes, up to 25 MB, for handing it to the person in the chat. */
export async function readBoxFileBytes(config: BoxConfig, filePath: string): Promise<Uint8Array> {
  let res: Response;
  try {
    res = await fetch(`${config.url}/files/raw?path=${encodeURIComponent(filePath)}`, { headers: { Authorization: `Bearer ${config.token}` }, redirect: "error", signal: AbortSignal.timeout(120_000) });
  } catch (error) {
    throw new BoxError(`The box at ${config.url} isn't reachable (${error instanceof Error ? error.message : "unknown error"}).`, 0);
  }
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
  let res: Response;
  try {
    res = await fetch(`${config.url}${route}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${config.token}`,
        Accept: "text/event-stream",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "error",
      signal,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown error";
    throw new BoxError(`The box at ${config.url} isn't reachable (${detail}). Is the box service running?`, 0);
  }
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

// ---------- Claude Code ----------

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
  effort?: string | null;
  maxTurns?: number | null;
  permission: "ask" | "edits" | "full";
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

export function interruptAgent(config: BoxConfig, agentId: string): Promise<{ ok: true; interrupted: boolean }> {
  return call(config, "POST", `/agents/${agentId}/interrupt`, {});
}

export async function closeAgent(config: BoxConfig, agentId: string): Promise<void> {
  await call(config, "DELETE", `/agents/${agentId}`);
}

export function listAgents(config: BoxConfig): Promise<{ agents: { id: string; running: boolean; busy: boolean }[] }> {
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
