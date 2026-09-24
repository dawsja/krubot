import { APPROVAL_LEVELS, BOT_EXPRESSIONS, DEFAULT_MODEL, type ApprovalLevel, type Bot, type BotExpression, type BotInput } from "@krubot/shared";
import { ensureKruDatabase, transaction } from "../db/init.ts";
import { botsChanged } from "../events.ts";
import { newId, now } from "../ids.ts";

type Row = {
  id: string;
  name: string;
  title: string;
  description: string;
  voice: string;
  color: string;
  expression: string;
  tilt: number;
  model: string;
  approval: string;
  is_chief: number;
  toolkits: string;
  thread_id: string;
  hidden: number;
  pinned: number;
  notify: number;
  position: number;
  user_id: string | null;
  created_at: string;
  updated_at: string;
};

function parseJson<T>(text: string, fallback: T): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

function toBot(row: Row): Bot {
  return {
    id: row.id,
    userId: row.user_id ?? "",
    name: row.name,
    title: row.title,
    description: row.description,
    color: row.color,
    expression: (BOT_EXPRESSIONS as readonly string[]).includes(row.expression) ? (row.expression as BotExpression) : "happy",
    approval: (APPROVAL_LEVELS as readonly string[]).includes(row.approval) ? (row.approval as ApprovalLevel) : "ask",
    isChief: row.is_chief === 1,
    toolkits: parseJson<string[]>(row.toolkits, []),
    threadId: row.thread_id,
    hidden: row.hidden === 1,
    pinned: row.pinned === 1,
    notify: row.notify !== 0,
    position: row.position,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const SELECT = "SELECT * FROM kru_bots";

/** A person's bots (every bot without a user, when none is given). */
export function listBots(options: { includeHidden?: boolean; userId?: string } = {}): Bot[] {
  const db = ensureKruDatabase();
  const where: string[] = [];
  const params: string[] = [];
  if (!options.includeHidden) where.push("hidden = 0");
  if (options.userId) {
    where.push("user_id = ?");
    params.push(options.userId);
  }
  const rows = db.query(`${SELECT} ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY pinned DESC, position ASC, created_at ASC`).all(...params) as Row[];
  return rows.map(toBot);
}

export function getBot(id: string): Bot | null {
  const row = ensureKruDatabase().query(`${SELECT} WHERE id = ?`).get(id) as Row | null;
  return row ? toBot(row) : null;
}

export function getBotByThread(threadId: string): Bot | null {
  const row = ensureKruDatabase().query(`${SELECT} WHERE thread_id = ?`).get(threadId) as Row | null;
  return row ? toBot(row) : null;
}

/** A person's Chief of Staff, when one exists (the first, if several). */
export function getChief(userId: string): Bot | null {
  const row = ensureKruDatabase().query(`${SELECT} WHERE user_id = ? AND is_chief = 1 AND hidden = 0 ORDER BY position ASC LIMIT 1`).get(userId) as Row | null;
  return row ? toBot(row) : null;
}

/** Creates a person's bot and its 1:1 thread together. */
export function createBot(input: BotInput, userId: string): Bot {
  const id = newId("bot");
  const threadId = newId("t");
  const at = now();
  return transaction((db) => {
    const max = db.query("SELECT COALESCE(MAX(position), 0) AS p FROM kru_bots WHERE user_id = ?").get(userId) as { p: number };
    db.query(
      `INSERT INTO kru_threads (id, kind, bot_id, name, user_id, created_at, updated_at) VALUES (?, 'bot', ?, ?, ?, ?, ?)`,
    ).run(threadId, id, input.name, userId, at, at);
    db.query("INSERT INTO kru_thread_members (thread_id, bot_id) VALUES (?, ?)").run(threadId, id);
    db.query(
      `INSERT INTO kru_bots (id, name, title, description, voice, color, expression, tilt, model, approval, is_chief, toolkits, notify, thread_id, position, user_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.name,
      input.title,
      input.description,
      // Legacy columns: voice and tilt are gone from the profile, and the
      // model lives under Settings → AI now, each person's own.
      "",
      input.color,
      input.expression,
      0,
      DEFAULT_MODEL,
      input.approval,
      input.isChief ? 1 : 0,
      JSON.stringify(input.toolkits),
      input.notify ? 1 : 0,
      threadId,
      Number(max.p) + 1,
      userId,
      at,
      at,
    );
    botsChanged();
    return toBot(db.query(`${SELECT} WHERE id = ?`).get(id) as Row);
  });
}

export function updateBot(id: string, patch: Partial<BotInput> & { hidden?: boolean; pinned?: boolean; position?: number }): Bot | null {
  const current = getBot(id);
  if (!current) return null;
  const next = { ...current, ...patch, updatedAt: now() };
  transaction((db) => {
    db.query(
      `UPDATE kru_bots SET name = ?, title = ?, description = ?, color = ?, expression = ?, approval = ?, is_chief = ?, toolkits = ?, notify = ?, hidden = ?, pinned = ?, position = ?, updated_at = ? WHERE id = ?`,
    ).run(
      next.name,
      next.title,
      next.description,
      next.color,
      next.expression,
      next.approval,
      next.isChief ? 1 : 0,
      JSON.stringify(next.toolkits),
      next.notify ? 1 : 0,
      next.hidden ? 1 : 0,
      next.pinned ? 1 : 0,
      next.position,
      next.updatedAt,
      id,
    );
    if (patch.name) db.query("UPDATE kru_threads SET name = ? WHERE id = ?").run(patch.name, current.threadId);
  });
  botsChanged();
  return getBot(id);
}

/** Removes the bot, its thread, messages, approvals, routines and room memberships. */
export function deleteBot(id: string): Bot | null {
  const bot = getBot(id);
  if (!bot) return null;
  transaction((db) => {
    db.query("DELETE FROM kru_threads WHERE id = ?").run(bot.threadId);
    db.query("DELETE FROM kru_thread_members WHERE bot_id = ?").run(id);
    db.query("DELETE FROM kru_approvals WHERE bot_id = ?").run(id);
    db.query("DELETE FROM kru_approval_rules WHERE bot_id = ?").run(id);
    db.query("DELETE FROM kru_routines WHERE bot_id = ?").run(id);
    db.query("DELETE FROM kru_follow_ups WHERE bot_id = ?").run(id);
    db.query("DELETE FROM kru_bots WHERE id = ?").run(id);
  });
  botsChanged();
  return bot;
}

/** Finds a bot by its id, name or @handle (loosely: case-insensitive, spaces ignored). */
export function findBot(ref: string, bots = listBots({ includeHidden: true })): Bot | null {
  const wanted = ref.trim().replace(/^@/, "").toLowerCase();
  if (!wanted) return null;
  const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9_-]+/g, "");
  return bots.find((b) => b.id === ref) ?? bots.find((b) => b.name.toLowerCase() === wanted) ?? bots.find((b) => squash(b.name) === squash(wanted)) ?? null;
}
