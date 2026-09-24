import { ensureKruDatabase } from "../db/init.ts";
import { boardChanged } from "../events.ts";
import { now } from "../ids.ts";

/*
 * Which finished cards a person cleared off their board. Only the card
 * goes: what it stands for (a handoff, a routine run) is untouched.
 */

/** How long a clearing is kept: past the board's one-day window, so a card never comes back. */
const KEEP_MS = 2 * 24 * 60 * 60 * 1000;

export function clearedBoardItems(userId: string): Set<string> {
  const db = ensureKruDatabase();
  db.query("DELETE FROM kru_board_cleared WHERE cleared_at < ?").run(new Date(Date.now() - KEEP_MS).toISOString());
  const rows = db.query("SELECT item_id FROM kru_board_cleared WHERE user_id = ?").all(userId) as { item_id: string }[];
  return new Set(rows.map((r) => r.item_id));
}

export function clearBoardItems(userId: string, itemIds: string[]) {
  if (itemIds.length === 0) return;
  const db = ensureKruDatabase();
  const at = now();
  const insert = db.query("INSERT OR REPLACE INTO kru_board_cleared (user_id, item_id, cleared_at) VALUES (?, ?, ?)");
  db.transaction(() => {
    for (const id of itemIds) insert.run(userId, id, at);
  })();
  boardChanged(userId);
}
