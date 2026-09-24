import { ensureKruDatabase } from "../db/init.ts";
import { boardChanged } from "../events.ts";
import { newId, now } from "../ids.ts";

/*
 * A handoff between bots: the Chief of Staff (or any bot allowed to) briefs
 * a teammate in that teammate's own thread, and the teammate's answer comes
 * back to the thread the brief was written from.
 */

export type Delegation = {
  id: string;
  fromBotId: string;
  fromThreadId: string;
  toBotId: string;
  toThreadId: string;
  messageId: string;
  brief: string;
  /** `cancelled`: the bot that wrote the brief withdrew it (or replaced it with a newer one). */
  status: "open" | "done" | "failed" | "cancelled";
  result: string | null;
  createdAt: string;
  finishedAt: string | null;
  /** When the delegating bot chased it, and when the wait was reported. */
  nudgedAt: string | null;
  escalatedAt: string | null;
  /** The handoff this one was given out for: the delegating bot was working on it. */
  parentId: string | null;
  /** The message the result came back as, in the delegating bot's thread. */
  resultMessageId: string | null;
};

type Row = {
  id: string;
  from_bot_id: string;
  from_thread_id: string;
  to_bot_id: string;
  to_thread_id: string;
  message_id: string;
  brief: string;
  status: Delegation["status"];
  result: string | null;
  created_at: string;
  finished_at: string | null;
  nudged_at: string | null;
  escalated_at: string | null;
  parent_id: string | null;
  result_message_id: string | null;
};

function toDelegation(row: Row): Delegation {
  return {
    id: row.id,
    fromBotId: row.from_bot_id,
    fromThreadId: row.from_thread_id,
    toBotId: row.to_bot_id,
    toThreadId: row.to_thread_id,
    messageId: row.message_id,
    brief: row.brief,
    status: row.status,
    result: row.result,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
    nudgedAt: row.nudged_at,
    escalatedAt: row.escalated_at,
    parentId: row.parent_id,
    resultMessageId: row.result_message_id,
  };
}

export function createDelegation(
  input: Omit<Delegation, "id" | "status" | "result" | "createdAt" | "finishedAt" | "nudgedAt" | "escalatedAt" | "parentId" | "resultMessageId"> & { parentId?: string | null },
): Delegation {
  const id = newId("d");
  ensureKruDatabase()
    .query("INSERT INTO kru_delegations (id, from_bot_id, from_thread_id, to_bot_id, to_thread_id, message_id, brief, status, created_at, parent_id) VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)")
    .run(id, input.fromBotId, input.fromThreadId, input.toBotId, input.toThreadId, input.messageId, input.brief, now(), input.parentId ?? null);
  changed(id);
  return getDelegation(id)!;
}

export function getDelegation(id: string): Delegation | null {
  const row = ensureKruDatabase().query("SELECT * FROM kru_delegations WHERE id = ?").get(id) as Row | null;
  return row ? toDelegation(row) : null;
}

/** The open delegation a message in a teammate's thread is answering, if any. */
export function delegationForMessage(messageId: string): Delegation | null {
  const row = ensureKruDatabase().query("SELECT * FROM kru_delegations WHERE message_id = ? AND status = 'open'").get(messageId) as Row | null;
  return row ? toDelegation(row) : null;
}

/**
 * The open handoff a turn on this message works on: the one it is the
 * brief of, or, when it is the result of a handoff the bot gave out for
 * another, that other one. A bot that hands part of its task on is still
 * on its task when the results come back.
 */
export function handoffWorkedOn(messageId: string): Delegation | null {
  const brief = delegationForMessage(messageId);
  if (brief) return brief;
  const row = ensureKruDatabase()
    .query("SELECT p.* FROM kru_delegations c JOIN kru_delegations p ON p.id = c.parent_id WHERE c.result_message_id = ? AND p.status = 'open'")
    .get(messageId) as Row | null;
  return row ? toDelegation(row) : null;
}

/** How many handoffs given out for this one are still open. */
export function openChildren(id: string): number {
  return (ensureKruDatabase().query("SELECT COUNT(*) AS n FROM kru_delegations WHERE parent_id = ? AND status = 'open'").get(id) as { n: number }).n;
}

export function finishDelegation(id: string, status: "done" | "failed" | "cancelled", result: string, resultMessageId: string | null = null) {
  ensureKruDatabase()
    .query("UPDATE kru_delegations SET status = ?, result = ?, finished_at = ?, result_message_id = ? WHERE id = ?")
    .run(status, result.slice(0, 20_000), now(), resultMessageId, id);
  changed(id);
}

/** The open handoffs to one conversation. */
export function openDelegationsTo(threadId: string): Delegation[] {
  const rows = ensureKruDatabase().query("SELECT * FROM kru_delegations WHERE status = 'open' AND to_thread_id = ? ORDER BY created_at").all(threadId) as Row[];
  return rows.map(toDelegation);
}

export function listOpenDelegations(fromBotId?: string): Delegation[] {
  const rows = ensureKruDatabase()
    .query(`SELECT * FROM kru_delegations WHERE status = 'open' ${fromBotId ? "AND from_bot_id = ?" : ""} ORDER BY created_at`)
    .all(...(fromBotId ? [fromBotId] : [])) as Row[];
  return rows.map(toDelegation);
}

/** The open handoffs out of one conversation (opened since `since`, when given). */
export function openDelegationsFrom(threadId: string, since: string | null = null): Delegation[] {
  const rows = ensureKruDatabase()
    .query(`SELECT * FROM kru_delegations WHERE status = 'open' AND from_thread_id = ? ${since ? "AND created_at >= ?" : ""} ORDER BY created_at`)
    .all(...(since ? [threadId, since] : [threadId])) as Row[];
  return rows.map(toDelegation);
}

export function markNudged(id: string) {
  ensureKruDatabase().query("UPDATE kru_delegations SET nudged_at = ? WHERE id = ?").run(now(), id);
  changed(id);
}

export function markEscalated(id: string) {
  ensureKruDatabase().query("UPDATE kru_delegations SET escalated_at = ? WHERE id = ?").run(now(), id);
  changed(id);
}

/**
 * One bot's handoffs: every open one it wrote or was handed, and those
 * finished since `since`, newest first.
 */
export function listDelegationsForBot(botId: string, since: string, limit = 40): Delegation[] {
  const rows = ensureKruDatabase()
    .query(
      `SELECT * FROM kru_delegations WHERE (from_bot_id = ? OR to_bot_id = ?) AND (status = 'open' OR finished_at >= ?)
       ORDER BY created_at DESC LIMIT ?`,
    )
    .all(botId, botId, since, limit) as Row[];
  return rows.map(toDelegation);
}

/**
 * A person's handoffs for the board: every open one, and those finished
 * since `since`. Whose they are is the delegating bot's owner.
 */
export function listDelegationsForUser(userId: string, since: string): Delegation[] {
  const rows = ensureKruDatabase()
    .query(
      `SELECT d.* FROM kru_delegations d JOIN kru_bots b ON b.id = d.from_bot_id
       WHERE b.user_id = ? AND (d.status = 'open' OR d.finished_at >= ?) ORDER BY d.created_at DESC LIMIT 200`,
    )
    .all(userId, since) as Row[];
  return rows.map(toDelegation);
}

/** Tells the delegating bot's owner that the board moved. */
function changed(id: string) {
  const row = ensureKruDatabase().query("SELECT b.user_id FROM kru_delegations d JOIN kru_bots b ON b.id = d.from_bot_id WHERE d.id = ?").get(id) as { user_id: string | null } | null;
  boardChanged(row?.user_id);
}
