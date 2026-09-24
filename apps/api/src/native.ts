import { isOpenAiShaped, type ProviderKind } from "@krubot/shared";
import type { DriverTool } from "./driver.ts";
import { authHeaders, upstreamUrl } from "./routes/llm.ts";

/*
 * The engine that needs no CLI: Kru Bot calls the person's own API itself
 * and runs the loop here. The model gets the same tools a CLI would be
 * given plus the computer (computer.ts), and every tool call runs through
 * the same approvals. The call goes out through Kru's own LLM proxy with
 * the provider's proxy token, exactly as a CLI's would, so the key is
 * still only ever decrypted there.
 *
 * Two shapes cover what people actually have: Anthropic's Messages API
 * (Anthropic itself, and anything that speaks it, like MiniMax's Anthropic
 * endpoint) and the OpenAI chat API (OpenAI, xAI, and the rest). The
 * difference is confined to `send` and the two small translators under it;
 * everything above is one loop.
 */

/** Most times round the loop before a turn is called off; a long job is many tool calls. */
const MAX_STEPS = 80;
/** What the model may write in one reply. A tool-heavy turn needs far less. */
const MAX_OUTPUT_TOKENS = 8_000;
/** Longest tool answer handed back; the model re-reads it every step after. */
const MAX_TOOL_RESULT = 24_000;

export type NativeAccess = {
  /** Which of the person's APIs this is: it decides the shape of the calls. */
  kind: ProviderKind;
  /** Kru's LLM proxy for that API; it adds the real key on the way out. */
  baseUrl: string;
  /** The provider's proxy token, which names whose key to use. */
  token: string;
};

export type NativeTurn = {
  access: NativeAccess;
  model: string;
  /** The bot's SOUL and everything else the CLI would have been told. */
  instructions: string;
  prompt: string;
  attachments?: { name: string; mediaType: string; data: string }[];
  tools: Record<string, DriverTool>;
  maxSteps?: number;
  signal?: AbortSignal;
  /** What it is doing, for the activity line. */
  onLog?: (line: string) => void;
  /** What the person sends while it works, read between steps. */
  steers?: SteerQueue;
};

/**
 * The person's messages for a native turn that is running. The loop reads
 * them between steps, after the tool results; one that arrives as the
 * model answers sends it round once more. Once the turn is over, a push is
 * refused, and the message waits for the next turn.
 */
export class SteerQueue {
  private items: string[] = [];
  private open = true;

  push(text: string): boolean {
    if (!this.open) return false;
    this.items.push(text);
    return true;
  }

  take(): string[] {
    return this.items.splice(0);
  }

  /** At the model's answer: what is still to read, and when nothing is, no more. */
  last(): string[] {
    const rest = this.take();
    if (!rest.length) this.open = false;
    return rest;
  }

  shut() {
    this.open = false;
  }
}

export type NativeResult = {
  ok: boolean;
  text: string;
  stopReason: string | null;
  error: string | null;
  usage: { input: number; output: number; cachedInput: number } | null;
};

/** A tool call the model made, in the one shape the loop works with. */
type Call = { id: string; name: string; input: Record<string, unknown> };
/** One step's answer: what it said, what it wants to run, and why it stopped. */
type Step = { text: string; calls: Call[]; stopReason: string | null; usage: { input: number; output: number; cachedInput: number } | null; raw: unknown };

function clip(text: string) {
  return text.length > MAX_TOOL_RESULT ? `${text.slice(0, MAX_TOOL_RESULT)}\n[… ${text.length - MAX_TOOL_RESULT} more characters]` : text;
}

/** An image or PDF the person attached, as the two APIs take them. */
function mediaBlocks(kind: ProviderKind, attachments: NativeTurn["attachments"]): unknown[] {
  const out: unknown[] = [];
  for (const file of attachments ?? []) {
    const image = file.mediaType.startsWith("image/");
    if (isOpenAiShaped(kind)) {
      // The OpenAI chat API takes images only, as a data URL.
      if (image) out.push({ type: "image_url", image_url: { url: `data:${file.mediaType};base64,${file.data}` } });
    } else if (image) {
      out.push({ type: "image", source: { type: "base64", media_type: file.mediaType, data: file.data } });
    } else if (file.mediaType === "application/pdf") {
      out.push({ type: "document", source: { type: "base64", media_type: file.mediaType, data: file.data } });
    }
  }
  return out;
}

/** What the person's API is told the model may call. */
function toolList(kind: ProviderKind, tools: Record<string, DriverTool>): unknown[] {
  return Object.entries(tools).map(([name, tool]) => {
    const parameters = (tool.inputSchema as object | undefined) ?? { type: "object", properties: {} };
    return isOpenAiShaped(kind) ? { type: "function", function: { name, description: tool.description, parameters } } : { name, description: tool.description, input_schema: parameters };
  });
}

/** The API's own error text, as far as it can be found in whatever it answered. */
export function providerError(status: number, body: unknown): string {
  const error = (body as { error?: unknown })?.error;
  const message = typeof error === "string" ? error : ((error as { message?: unknown })?.message ?? (body as { message?: unknown })?.message);
  const detail = typeof message === "string" && message.trim() ? message.trim() : typeof body === "string" && body.trim() ? body.trim() : "";
  if (status === 401 || status === 403) return `The API refused the key${detail ? `: ${detail}` : "."}`;
  if (status === 404) return `The API has no such endpoint or model${detail ? `: ${detail}` : ". Check the base URL and the model id."}`;
  return `The API answered ${status}${detail ? `: ${detail}` : "."}`;
}

/** One request to the person's API, in whichever shape it speaks. */
async function send(turn: NativeTurn, messages: unknown[]): Promise<Step> {
  const { kind, baseUrl, token } = turn.access;
  const openai = isOpenAiShaped(kind);
  const url = upstreamUrl(baseUrl, openai ? "chat/completions" : "v1/messages", "");
  const body = openai
    ? { model: turn.model, messages: [{ role: "system", content: turn.instructions }, ...messages], tools: toolList(kind, turn.tools), max_tokens: MAX_OUTPUT_TOKENS }
    : { model: turn.model, system: turn.instructions, messages, tools: toolList(kind, turn.tools), max_tokens: MAX_OUTPUT_TOKENS };
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders(kind, baseUrl, token), ...(openai ? {} : { "anthropic-version": "2023-06-01" }) },
    body: JSON.stringify(body),
    redirect: "manual",
    signal: turn.signal,
  });
  const payload: unknown = await res.json().catch(() => null);
  if (!res.ok) throw new Error(providerError(res.status, payload));
  return openai ? readOpenAi(payload) : readAnthropic(payload);
}

/** What Anthropic's Messages API answered. */
export function readAnthropic(payload: unknown): Step {
  const data = (payload ?? {}) as { content?: unknown; stop_reason?: unknown; usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number } };
  const blocks = Array.isArray(data.content) ? (data.content as { type?: string; text?: string; id?: string; name?: string; input?: unknown }[]) : [];
  const text = blocks
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("")
    .trim();
  const calls: Call[] = blocks
    .filter((block) => block.type === "tool_use" && typeof block.name === "string")
    .map((block) => ({ id: String(block.id ?? ""), name: block.name as string, input: (block.input && typeof block.input === "object" ? block.input : {}) as Record<string, unknown> }));
  return {
    text,
    calls,
    stopReason: typeof data.stop_reason === "string" ? data.stop_reason : null,
    usage: data.usage ? { input: data.usage.input_tokens ?? 0, output: data.usage.output_tokens ?? 0, cachedInput: data.usage.cache_read_input_tokens ?? 0 } : null,
    raw: { role: "assistant", content: blocks },
  };
}

/** What an OpenAI-shaped chat API answered. */
export function readOpenAi(payload: unknown): Step {
  const data = (payload ?? {}) as { choices?: unknown; usage?: { prompt_tokens?: number; completion_tokens?: number } };
  const choice = (Array.isArray(data.choices) ? data.choices[0] : null) as { message?: { content?: unknown; tool_calls?: unknown }; finish_reason?: unknown } | null;
  const message = choice?.message ?? {};
  const content = message.content;
  // Some servers answer with the content split into blocks rather than a string.
  const text = typeof content === "string" ? content.trim() : Array.isArray(content) ? (content as { text?: string }[]).map((part) => part.text ?? "").join("").trim() : "";
  const calls: Call[] = (Array.isArray(message.tool_calls) ? (message.tool_calls as { id?: string; function?: { name?: string; arguments?: string } }[]) : [])
    .filter((call) => typeof call.function?.name === "string")
    .map((call) => {
      let input: Record<string, unknown> = {};
      try {
        const parsed: unknown = JSON.parse(call.function?.arguments || "{}");
        if (parsed && typeof parsed === "object") input = parsed as Record<string, unknown>;
      } catch {
        /* a model that writes broken JSON gets the tool's own complaint back */
      }
      return { id: String(call.id ?? ""), name: call.function!.name as string, input };
    });
  return {
    text,
    calls,
    stopReason: typeof choice?.finish_reason === "string" ? choice.finish_reason : null,
    usage: data.usage ? { input: data.usage.prompt_tokens ?? 0, output: data.usage.completion_tokens ?? 0, cachedInput: 0 } : null,
    raw: message,
  };
}

/** A tool's answer, in the shape the API expects the next message to carry. */
function toolAnswer(kind: ProviderKind, call: Call, content: string, isError: boolean): unknown {
  if (isOpenAiShaped(kind)) return { role: "tool", tool_call_id: call.id, content };
  return { type: "tool_result", tool_use_id: call.id, content, is_error: isError };
}

/** What the activity line says while the model works. */
function describe(call: Call): string {
  const input = call.input;
  if (call.name === "Bash" && typeof input.command === "string") return `$ ${input.command.replace(/\s+/g, " ").slice(0, 160)}`;
  if (typeof input.file_path === "string") return `${call.name === "Read" ? "Reading" : call.name === "Write" ? "Writing" : call.name === "Edit" ? "Editing" : call.name} ${input.file_path}`;
  const first = Object.values(input).find((value) => typeof value === "string") as string | undefined;
  return `${call.name}${first ? ` ${first.replace(/\s+/g, " ").slice(0, 120)}` : ""}`;
}

/**
 * One turn: ask, run what it asks for, ask again, until it answers in
 * words or the steps run out. Tool calls in one step run together, since
 * the model asked for them together.
 */
export async function nativeTurn(turn: NativeTurn): Promise<NativeResult> {
  const { kind } = turn.access;
  const openai = isOpenAiShaped(kind);
  const media = mediaBlocks(kind, turn.attachments);
  const first = media.length ? [...media, openai ? { type: "text", text: turn.prompt } : { type: "text", text: turn.prompt }] : turn.prompt;
  const messages: unknown[] = [{ role: "user", content: first }];
  const usage = { input: 0, output: 0, cachedInput: 0 };
  const maxSteps = turn.maxSteps ?? MAX_STEPS;
  // What it answered before a late steer sent it round again; still part of the reply.
  const said: string[] = [];

  for (let step = 0; step < maxSteps; step += 1) {
    if (turn.signal?.aborted) return { ok: false, text: "", stopReason: "aborted", error: null, usage };
    let answer: Step;
    try {
      answer = await send(turn, messages);
    } catch (error) {
      // Stopping a bot aborts the request it was waiting on; that is not a failure.
      if (turn.signal?.aborted) return { ok: false, text: "", stopReason: "aborted", error: null, usage };
      throw error;
    }
    if (answer.usage) {
      usage.input += answer.usage.input;
      usage.output += answer.usage.output;
      usage.cachedInput += answer.usage.cachedInput;
    }
    if (answer.text && turn.onLog) turn.onLog(answer.text.replace(/\s+/g, " ").slice(0, 200));
    if (!answer.calls.length) {
      const late = turn.steers?.last() ?? [];
      if (late.length) {
        if (answer.text) said.push(answer.text);
        messages.push(answer.raw, { role: "user", content: late.join("\n\n") });
        continue;
      }
      const text = [...said, answer.text].filter(Boolean).join("\n\n");
      return { ok: Boolean(text), text, stopReason: answer.stopReason, error: text ? null : "The API answered with nothing.", usage };
    }
    messages.push(answer.raw);
    const answers = await Promise.all(
      answer.calls.map(async (call) => {
        turn.onLog?.(describe(call));
        const tool = turn.tools[call.name];
        try {
          if (!tool) throw new Error(`No such tool: ${call.name}`);
          const value = await tool.execute(call.input, call.id);
          return toolAnswer(kind, call, clip(typeof value === "string" ? value : JSON.stringify(value ?? "")), false);
        } catch (error) {
          return toolAnswer(kind, call, clip(error instanceof Error ? error.message : "Tool failed"), true);
        }
      }),
    );
    // Anthropic takes every result in one user message; the chat API takes one message each.
    const steers = turn.steers?.take() ?? [];
    if (openai) messages.push(...answers, ...(steers.length ? [{ role: "user", content: steers.join("\n\n") }] : []));
    else messages.push({ role: "user", content: [...answers, ...steers.map((text) => ({ type: "text", text }))] });
  }
  return { ok: false, text: "", stopReason: "max_steps", error: `The model was still working after ${maxSteps} steps, so the turn was stopped.`, usage };
}
