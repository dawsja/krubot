import { ensureKruDatabase } from "../db/init.ts";
import { newId, now } from "../ids.ts";

/*
 * A bot's reminder to itself. It sets one with `follow_up` ("check on
 * Bolt's build in 45 minutes"); when it is due the dispatcher posts a
 * hidden prompt in that conversation and the bot picks the work up again.
 */

export type FollowUp = { id: string; botId: string; threadId: string; note: string; dueAt: string; createdAt: string; firedAt: string | null };

type Row = { id: string; bot_id: string; thread_id: string; note: string; due_at: string; created_at: string; fired_at: string | null };

function toFollowUp(row: Row): FollowUp {
  return { id: row.id, botId: row.bot_id, threadId: row.thread_id, note: row.note, dueAt: row.due_at, createdAt: row.created_at, firedAt: row.fired_at };
}

export function createFollowUp(input: { botId: string; threadId: string; note: string; dueAt: Date }): FollowUp {
  const id = newId("f");
  ensureKruDatabase()
    .query("INSERT INTO kru_follow_ups (id, bot_id, thread_id, note, due_at, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(id, input.botId, input.threadId, input.note, input.dueAt.toISOString(), now());
  return listFollowUps(input.botId).find((f) => f.id === id)!;
}

/** A bot's follow-ups still to come, soonest first. */
export function listFollowUps(botId: string): FollowUp[] {
  const rows = ensureKruDatabase().query("SELECT * FROM kru_follow_ups WHERE bot_id = ? AND fired_at IS NULL ORDER BY due_at ASC").all(botId) as Row[];
  return rows.map(toFollowUp);
}

/** Drops one of the bot's own follow-ups still to come. */
export function cancelFollowUp(id: string, botId: string): boolean {
  return ensureKruDatabase().query("DELETE FROM kru_follow_ups WHERE id = ? AND bot_id = ? AND fired_at IS NULL").run(id, botId).changes > 0;
}

/** Drops the follow-ups still to come in a conversation (set since `since`, when given), when its work is stopped. */
export function cancelFollowUpsIn(threadId: string, since: string | null = null): number {
  return ensureKruDatabase()
    .query(`DELETE FROM kru_follow_ups WHERE thread_id = ? AND fired_at IS NULL ${since ? "AND created_at >= ?" : ""}`)
    .run(...(since ? [threadId, since] : [threadId])).changes;
}

/** Follow-ups that are due, marked as fired so each is posted once. */
export function claimDueFollowUps(at = new Date()): FollowUp[] {
  const db = ensureKruDatabase();
  const stamp = at.toISOString();
  const rows = db.query("SELECT * FROM kru_follow_ups WHERE fired_at IS NULL AND due_at <= ? ORDER BY due_at ASC").all(stamp) as Row[];
  for (const row of rows) db.query("UPDATE kru_follow_ups SET fired_at = ? WHERE id = ?").run(stamp, row.id);
  return rows.map((row) => toFollowUp({ ...row, fired_at: stamp }));
}
