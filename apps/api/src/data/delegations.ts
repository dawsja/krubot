import { ensureKruDatabase } from "../db/init.ts";
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
  status: "open" | "done" | "failed";
  result: string | null;
  createdAt: string;
  finishedAt: string | null;
  /** When the delegating bot chased it, and when the wait was reported. */
  nudgedAt: string | null;
  escalatedAt: string | null;
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
  };
}

export function createDelegation(input: Omit<Delegation, "id" | "status" | "result" | "createdAt" | "finishedAt" | "nudgedAt" | "escalatedAt">): Delegation {
  const id = newId("d");
  ensureKruDatabase()
    .query("INSERT INTO kru_delegations (id, from_bot_id, from_thread_id, to_bot_id, to_thread_id, message_id, brief, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?)")
    .run(id, input.fromBotId, input.fromThreadId, input.toBotId, input.toThreadId, input.messageId, input.brief, now());
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

export function finishDelegation(id: string, status: "done" | "failed", result: string) {
  ensureKruDatabase().query("UPDATE kru_delegations SET status = ?, result = ?, finished_at = ? WHERE id = ?").run(status, result.slice(0, 20_000), now(), id);
}

export function listOpenDelegations(fromBotId?: string): Delegation[] {
  const rows = ensureKruDatabase()
    .query(`SELECT * FROM kru_delegations WHERE status = 'open' ${fromBotId ? "AND from_bot_id = ?" : ""} ORDER BY created_at`)
    .all(...(fromBotId ? [fromBotId] : [])) as Row[];
  return rows.map(toDelegation);
}

export function markNudged(id: string) {
  ensureKruDatabase().query("UPDATE kru_delegations SET nudged_at = ? WHERE id = ?").run(now(), id);
}

export function markEscalated(id: string) {
  ensureKruDatabase().query("UPDATE kru_delegations SET escalated_at = ? WHERE id = ?").run(now(), id);
}
