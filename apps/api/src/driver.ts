import type { Engine } from "@krubot/shared";
import { answerAgentTool, runAgentTurn, type AgentTool, type BoxAccess, type BoxConfig } from "./box.ts";

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
  effort?: string | null;
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
type ContentBlock = { type?: string; text?: string; name?: string; input?: Record<string, unknown> };

/** One stream-json line as a short activity line, or nothing. */
export function activityLine(line: string, home?: string): string[] {
  let event: StreamEvent;
  try {
    event = JSON.parse(line) as StreamEvent;
  } catch {
    return [];
  }
  if (event.type !== "assistant") return [];
  const blocks = Array.isArray(event.message?.content) ? (event.message.content as ContentBlock[]) : [];
  const out: string[] = [];
  const relative = (file: string) => (home && file.startsWith(`${home}/`) ? file.slice(home.length + 1) : file);
  for (const block of blocks) {
    if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
      out.push(block.text.trim().replace(/\s+/g, " ").slice(0, 200));
    } else if (block.type === "tool_use") {
      const input = block.input ?? {};
      const name = block.name ?? "tool";
      if (name === "Bash" && typeof input.command === "string") out.push(`$ ${input.command.replace(/\s+/g, " ").slice(0, 160)}`);
      else if (typeof input.file_path === "string") out.push(`${name === "Read" ? "Reading" : name === "Edit" ? "Editing" : name === "Write" ? "Writing" : name} ${relative(input.file_path)}`);
      else if (typeof input.url === "string") out.push(`Opening ${input.url.slice(0, 120)}`);
      else if (name.startsWith("mcp__kru__")) {
        const tool = name.slice("mcp__kru__".length);
        if (tool === "permission") continue;
        const first = Object.values(input).find((v) => typeof v === "string") as string | undefined;
        out.push(`${tool}${first ? ` ${first.replace(/\s+/g, " ").slice(0, 120)}` : ""}`);
      } else {
        const first = Object.values(input).find((v) => typeof v === "string") as string | undefined;
        out.push(`${name}${first ? ` ${first.replace(/\s+/g, " ").slice(0, 120)}` : ""}`);
      }
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

  const result = await runAgentTurn(
    turn.box,
    turn.agentId,
    {
      bot: turn.botId,
      engine: turn.engine,
      access: turn.access,
      model: turn.modelId,
      effort: turn.effort ?? null,
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
        } else if (event.type === "line" && turn.onLog) {
          for (const line of activityLine(event.line)) turn.onLog(line);
        } else if (event.type === "activity" && turn.onLog) {
          turn.onLog(event.line);
        }
      },
    },
  );
  await Promise.allSettled(inflight);
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
