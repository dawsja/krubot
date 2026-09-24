import { WORK_OUTPUT_MAX, WORK_STEPS_MAX, type WorkStep } from "@krubot/shared";
import { emit } from "./events.ts";

/*
 * What a bot is doing, step by step, behind its one activity line: the
 * commands it ran and what they printed, the files it read or changed, the
 * tools it called. The web opens it from the line. It lives here in memory
 * for as long as the turn runs and goes when the turn ends, like the line;
 * nothing of it is written to the database.
 */

/** A step as a driver reports it: its id and whatever it knows so far. */
export type StepUpdate = { id: string } & Partial<Omit<WorkStep, "id" | "at">>;

const holder = globalThis as typeof globalThis & { __kruWork?: Map<string, Map<string, WorkStep>> };

function logs(): Map<string, Map<string, WorkStep>> {
  return (holder.__kruWork ??= new Map());
}

const keyOf = (threadId: string, botId: string) => `${threadId}\n${botId}`;

/** Cuts a step's output to what the page can show, keeping the end, where errors are. */
export function clipOutput(text: string, max = WORK_OUTPUT_MAX): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.25);
  return `${text.slice(0, head)}\n[… ${text.length - max} characters …]\n${text.slice(text.length - (max - head))}`;
}

/**
 * Adds a step or brings one up to date, and tells the person's page. A step
 * the log has never seen needs a title; an update to one that aged out is
 * dropped.
 */
export function recordStep(threadId: string, botId: string, update: StepUpdate): WorkStep | null {
  const key = keyOf(threadId, botId);
  let log = logs().get(key);
  const known = log?.get(update.id);
  if (!known && !update.title) return null;
  if (!log) logs().set(key, (log = new Map()));
  const step: WorkStep = {
    id: update.id,
    kind: update.kind ?? known?.kind ?? "tool",
    title: update.title ?? known?.title ?? "",
    detail: update.detail !== undefined ? update.detail : (known?.detail ?? null),
    output: update.output !== undefined ? (update.output === null ? null : clipOutput(update.output)) : (known?.output ?? null),
    status: update.status ?? known?.status ?? "running",
    at: known?.at ?? new Date().toISOString(),
  };
  log.set(step.id, step);
  while (log.size > WORK_STEPS_MAX) log.delete(log.keys().next().value!);
  emit({ topic: "work", threadId, botId, step });
  return step;
}

/** The steps of a conversation's turns in flight, per bot, oldest first. */
export function workFor(threadId: string): Record<string, WorkStep[]> {
  const out: Record<string, WorkStep[]> = {};
  for (const [key, log] of logs()) {
    const [thread, bot] = key.split("\n");
    if (thread === threadId && bot) out[bot] = [...log.values()];
  }
  return out;
}

/** A turn ended (or a new one began): its steps go. */
export function clearWork(threadId: string, botId: string) {
  logs().delete(keyOf(threadId, botId));
}
