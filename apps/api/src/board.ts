import { BOARD_COLUMNS, boardItemClearable, type Approval, type Board, type BoardColumn, type BoardItem, type Routine } from "@krubot/shared";
import type { Delegation } from "./data/delegations.ts";
import type { RunForBoard } from "./data/routines.ts";

/*
 * The board is a view, not a table: it sorts what the rest of the API
 * already keeps (handoffs, approvals, routine runs, turns in flight) into
 * five columns. Pure, so every rule is tested without a database.
 */

/** How far back Done (and a failed run under Needs you) reaches. */
export const BOARD_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Most finished items Done shows. */
export const BOARD_DONE_LIMIT = 20;

export type TurnForBoard = { botId: string; threadId: string; threadName: string; startedAt: number };

export type BoardInput = {
  delegations: Delegation[];
  approvals: Approval[];
  turns: TurnForBoard[];
  runs: RunForBoard[];
  upcoming: (Routine & { threadId: string })[];
  /** Finished cards the person cleared off. */
  cleared?: Set<string>;
};

/** The first line of a text, cut short enough for a card. */
export function oneLine(text: string, max = 200): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

export function buildBoard(input: BoardInput, now: number = Date.now()): Board {
  const since = now - BOARD_WINDOW_MS;
  const recent = (at: string | null) => at !== null && Date.parse(at) >= since;
  const columns = Object.fromEntries(BOARD_COLUMNS.map((c) => [c, [] as BoardItem[]])) as Record<BoardColumn, BoardItem[]>;
  const add = (item: BoardItem) => {
    if (boardItemClearable(item) && input.cleared?.has(item.id)) return;
    columns[item.column].push(item);
  };

  for (const a of input.approvals) {
    if (a.status !== "pending") continue;
    add({ id: `approval:${a.id}`, kind: "approval", column: "needs-you", botId: a.botId, threadId: a.threadId, title: oneLine(a.summary), detail: a.tool, at: a.createdAt });
  }

  for (const d of input.delegations) {
    const base = { id: `handoff:${d.id}`, kind: "handoff" as const, botId: d.fromBotId, toBotId: d.toBotId, threadId: d.fromThreadId, toThreadId: d.toThreadId, title: oneLine(d.brief) };
    if (d.status === "open") {
      if (d.escalatedAt) add({ ...base, column: "needs-you", detail: "Reported stuck", at: d.escalatedAt });
      else if (d.nudgedAt) add({ ...base, column: "stalled", detail: "Checked in, no answer yet", at: d.nudgedAt });
      else add({ ...base, column: "waiting", detail: "Handed off", at: d.createdAt });
    } else if (recent(d.finishedAt)) {
      add({ ...base, column: "done", detail: d.status === "done" ? oneLine(d.result ?? "", 140) || "Finished" : d.status === "cancelled" ? "Withdrawn" : "Couldn't finish", at: d.finishedAt! });
    }
  }

  const working = new Set(input.turns.map((t) => t.threadId));
  for (const t of input.turns) {
    add({ id: `turn:${t.botId}:${t.threadId}`, kind: "turn", column: "working", botId: t.botId, threadId: t.threadId, title: t.threadName, at: new Date(t.startedAt).toISOString() });
  }

  for (const r of input.runs) {
    const base = { id: `run:${r.id}`, kind: "run" as const, botId: r.botId, threadId: r.threadId, title: r.routineName };
    // A run in flight is already a turn under Working; one still in the queue waits.
    if (r.status === "started") {
      if (!working.has(r.threadId)) add({ ...base, column: "waiting", detail: "Queued", at: r.startedAt });
    } else if (r.status === "failed" && recent(r.finishedAt ?? r.startedAt)) {
      add({ ...base, column: "needs-you", detail: "Routine failed", at: r.finishedAt ?? r.startedAt });
    } else if (r.status === "done" && recent(r.finishedAt ?? r.startedAt)) {
      add({ ...base, column: "done", detail: "Routine ran", at: r.finishedAt ?? r.startedAt });
    }
  }

  const byNewest = (a: BoardItem, b: BoardItem) => Date.parse(b.at) - Date.parse(a.at);
  const byOldest = (a: BoardItem, b: BoardItem) => Date.parse(a.at) - Date.parse(b.at);
  columns["needs-you"].sort(byNewest);
  columns.working.sort(byOldest);
  columns.stalled.sort(byOldest);
  columns.waiting.sort(byOldest);
  columns.done = columns.done.sort(byNewest).slice(0, BOARD_DONE_LIMIT);

  // What is scheduled comes after what is already queued, soonest first.
  for (const r of input.upcoming) {
    if (!r.nextRunAt) continue;
    columns.waiting.push({ id: `upcoming:${r.id}`, kind: "upcoming", column: "waiting", botId: r.botId, threadId: r.threadId, title: r.name, detail: "Scheduled", at: r.nextRunAt });
  }

  return { columns };
}
