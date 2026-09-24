import type { Engine } from "@krubot/shared";
import { answerAgentTool, runAgentTurn, type AgentTool, type BoxAccess, type BoxConfig } from "./box.ts";
import type { StepUpdate } from "./work.ts";

/*
 * The bots' engine: a coding CLI (Claude Code, Codex or Grok) running as a
 * persistent session in the box. The API is the harness: it owns the
 * tools, the approvals and the conversation; the box keeps one CLI process
 * per bot and thread and relays its tool calls and permission questions
 * here over the turn's event stream. The CLI only ever sees text in, text
 * out, and the `kru` MCP bridge.
 */

export type DriverTool = {
  description: string;
  inputSchema: unknown;
  execute: (input: Record<string, unknown>, callId: string) => Promise<unknown>;
};

export function agentToolsFor(tools: Record<string, DriverTool>): AgentTool[] {
  return Object.entries(tools).map(([name, tool]) => ({ name, description: tool.description, inputSchema: tool.inputSchema ?? { type: "object", properties: {} } }));
}

/** Longest tool answer relayed back; the CLI re-reads it on every later call. */
const MAX_TOOL_RESULT = 24_000;

function clip(text: string) {
  return text.length > MAX_TOOL_RESULT ? `${text.slice(0, MAX_TOOL_RESULT)}\n[… ${text.length - MAX_TOOL_RESULT} more characters]` : text;
}

export type CliTurn = {
  box: BoxConfig;
  engine: Engine;
  access: BoxAccess;
  /** Names the process in the box: one per bot and thread, kept across turns. */
  agentId: string;
  botId: string;
  modelId: string;
  maxTurns?: number;
  permission: "ask" | "full";
  instructions: string;
  prompt: string;
  attachments?: { name: string; mediaType: string; data: string }[];
  tools: Record<string, DriverTool>;
  /** Your MCP servers for this session (see mcp.ts). */
  mcpServers?: unknown[];
  timeoutMs: number;
  signal?: AbortSignal;
  /** The CLI's own words and tool uses as they stream, for the activity line. */
  onLog?: (line: string) => void;
  /** The same, whole, with what each command printed: the work log behind the line. */
  onStep?: (step: StepUpdate) => void;
};

export type CliTurnResult = {
  ok: boolean;
  text: string;
  stopReason: string | null;
  error: string | null;
  recovered: boolean;
  usage: { input: number; output: number; cachedInput: number } | null;
  cost: number | null;
};

type StreamEvent = { type?: string; message?: { content?: unknown }; parent_tool_use_id?: string | null };
type ContentBlock = { type?: string; id?: string; text?: string; name?: string; input?: Record<string, unknown>; tool_use_id?: string; content?: unknown; is_error?: boolean };

/** A tool use in one line, as the activity line shows it; null for one nobody should see. */
function toolTitle(name: string, input: Record<string, unknown>, relative: (file: string) => string): string | null {
  if (name === "Bash" && typeof input.command === "string") return `$ ${input.command.replace(/\s+/g, " ").slice(0, 160)}`;
  if (typeof input.file_path === "string") return `${name === "Read" ? "Reading" : name === "Edit" ? "Editing" : name === "Write" ? "Writing" : name} ${relative(input.file_path)}`;
  if (typeof input.url === "string") return `Opening ${input.url.slice(0, 120)}`;
  const first = Object.values(input).find((v) => typeof v === "string") as string | undefined;
  if (name.startsWith("mcp__kru__")) {
    const tool = name.slice("mcp__kru__".length);
    if (tool === "permission") return null;
    return `${tool}${first ? ` ${first.replace(/\s+/g, " ").slice(0, 120)}` : ""}`;
  }
  return `${name}${first ? ` ${first.replace(/\s+/g, " ").slice(0, 120)}` : ""}`;
}

function parseStream(line: string): StreamEvent | null {
  try {
    return JSON.parse(line) as StreamEvent;
  } catch {
    return null;
  }
}

const relativeTo = (home?: string) => (file: string) => (home && file.startsWith(`${home}/`) ? file.slice(home.length + 1) : file);

/** One stream-json line as a short activity line, or nothing. */
export function activityLine(line: string, home?: string): string[] {
  const event = parseStream(line);
  if (event?.type !== "assistant") return [];
  const blocks = Array.isArray(event.message?.content) ? (event.message.content as ContentBlock[]) : [];
  const out: string[] = [];
  for (const block of blocks) {
    if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
      out.push(block.text.trim().replace(/\s+/g, " ").slice(0, 200));
    } else if (block.type === "tool_use") {
      const title = toolTitle(block.name ?? "tool", block.input ?? {}, relativeTo(home));
      if (title) out.push(title);
    }
  }
  return out;
}

/** What a tool answered, as text: a string, or the text parts of a content list. */
function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as ContentBlock[])
    .map((part) => (part.type === "text" && typeof part.text === "string" ? part.text : part.type === "image" ? "[image]" : ""))
    .filter(Boolean)
    .join("\n");
}

/**
 * One stream-json line as work steps: a tool use starts one (the whole
 * command or input as its detail), its result finishes it with what it
 * printed, and what the model says on the way is a note.
 */
export function workSteps(line: string, home?: string): StepUpdate[] {
  const event = parseStream(line);
  if (event?.type !== "assistant" && event?.type !== "user") return [];
  const blocks = Array.isArray(event.message?.content) ? (event.message.content as ContentBlock[]) : [];
  const out: StepUpdate[] = [];
  for (const block of blocks) {
    if (event.type === "assistant" && block.type === "text" && typeof block.text === "string" && block.text.trim()) {
      out.push({ id: `note-${crypto.randomUUID()}`, kind: "note", title: block.text.trim().replace(/\s+/g, " ").slice(0, 200), detail: block.text.trim(), status: "done" });
    } else if (event.type === "assistant" && block.type === "tool_use" && typeof block.id === "string") {
      const name = block.name ?? "tool";
      const input = block.input ?? {};
      const title = toolTitle(name, input, relativeTo(home));
      if (!title) continue;
      const command = name === "Bash" && typeof input.command === "string" ? input.command : null;
      out.push({
        id: block.id,
        kind: command !== null ? "command" : typeof input.file_path === "string" ? "file" : "tool",
        title,
        detail: command ?? (Object.keys(input).length ? JSON.stringify(input, null, 2) : null),
        status: "running",
      });
    } else if (event.type === "user" && block.type === "tool_result" && typeof block.tool_use_id === "string") {
      out.push({ id: block.tool_use_id, output: resultText(block.content), status: block.is_error ? "failed" : "done" });
    }
  }
  return out;
}

/**
 * Runs one turn and executes every tool call the CLI makes along the way.
 * Calls run as they arrive, so the CLI's parallel tool use isn't serialised
 * here; each answer goes back through the box by call id.
 */
export async function cliTurn(turn: CliTurn): Promise<CliTurnResult> {
  const inflight: Promise<void>[] = [];
  const handleCall = async (callId: string, name: string, input: Record<string, unknown>) => {
    const tool = turn.tools[name];
    let content: string;
    let isError = false;
    try {
      if (!tool) throw new Error(`No such tool: ${name}`);
      const value = await tool.execute(input, callId);
      content = typeof value === "string" ? value : JSON.stringify(value ?? "");
    } catch (error) {
      content = error instanceof Error ? error.message : "Tool failed";
      isError = true;
    }
    await answerAgentTool(turn.box, turn.agentId, { callId, content: clip(content), isError }).catch(() => undefined);
  };

  // A stop breaks the stream: its tool calls are still waited for, never left running on their own.
  const result = await runAgentTurn(
    turn.box,
    turn.agentId,
    {
      bot: turn.botId,
      engine: turn.engine,
      access: turn.access,
      model: turn.modelId,
      maxTurns: turn.maxTurns ?? null,
      permission: turn.permission,
      systemPrompt: turn.instructions,
      prompt: turn.prompt,
      ...(turn.attachments?.length ? { attachments: turn.attachments } : {}),
      tools: agentToolsFor(turn.tools),
      ...(turn.mcpServers?.length ? { mcpServers: turn.mcpServers } : {}),
      timeoutMs: turn.timeoutMs,
    },
    {
      signal: turn.signal,
      onEvent: (event) => {
        if (event.type === "tool_call") {
          inflight.push(handleCall(event.callId, event.name, event.input));
        } else if (event.type === "line") {
          if (turn.onLog) for (const line of activityLine(event.line)) turn.onLog(line);
          if (turn.onStep) for (const step of workSteps(event.line)) turn.onStep(step);
        } else if (event.type === "activity" && turn.onLog) {
          turn.onLog(event.line);
        } else if (event.type === "step" && turn.onStep) {
          turn.onStep(event.step);
        }
      },
    },
  ).finally(() => Promise.allSettled(inflight));
  if (!result) return { ok: false, text: "", stopReason: "no_result", error: "The box closed the stream without a result", recovered: false, usage: null, cost: null };
  return {
    ok: result.ok,
    text: result.text,
    stopReason: result.stopReason,
    error: result.error ?? null,
    recovered: result.recovered,
    usage: result.usage,
    cost: result.cost,
  };
}
