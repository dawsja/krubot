import type { ChatAttachment, Message, MessageAuthor, MessageKind, Thread } from "@krubot/shared";
import { ensureKruDatabase, transaction } from "../db/init.ts";
import { botsChanged, threadChanged } from "../events.ts";
import { newId, now } from "../ids.ts";

/*
 * Conversations. A bot thread is one bot's 1:1 with you; a room holds
 * several bots. Messages carry who wrote them and what kind of line they
 * are: what someone said, an event ("Scout is working on…"), or an approval
 * card.
 */

type ThreadRow = {
  id: string;
  kind: "bot" | "room";
  bot_id: string | null;
  name: string;
  last_read_at: string | null;
  user_id: string | null;
  created_at: string;
  updated_at: string;
};

type MessageRow = {
  id: string;
  thread_id: string;
  author: string;
  kind: MessageKind;
  body: string;
  attachments: string;
  depth: number;
  approval_id: string | null;
  from_thread_id: string | null;
  claimed_by: string | null;
  answered_at: string | null;
  created_at: string;
};

function parseAttachments(text: string): ChatAttachment[] {
  try {
    const value = JSON.parse(text);
    return Array.isArray(value) ? (value as ChatAttachment[]) : [];
  } catch {
    return [];
  }
}

function toMessage(row: MessageRow): Message {
  return {
    id: row.id,
    threadId: row.thread_id,
    author: row.author,
    kind: row.kind,
    body: row.body,
    attachments: parseAttachments(row.attachments),
    depth: row.depth,
    approvalId: row.approval_id,
    fromThreadId: row.from_thread_id,
    createdAt: row.created_at,
  };
}

function members(threadId: string): string[] {
  const rows = ensureKruDatabase().query("SELECT bot_id FROM kru_thread_members WHERE thread_id = ? ORDER BY rowid").all(threadId) as { bot_id: string }[];
  return rows.map((r) => r.bot_id);
}

function toThread(row: ThreadRow): Thread {
  const db = ensureKruDatabase();
  const last = db
    .query("SELECT author, body, created_at FROM kru_messages WHERE thread_id = ? AND kind IN ('message', 'approval', 'signin') ORDER BY created_at DESC LIMIT 1")
    .get(row.id) as { author: string; body: string; created_at: string } | null;
  const unread = db
    .query("SELECT COUNT(*) AS n FROM kru_messages WHERE thread_id = ? AND author NOT IN ('you') AND kind IN ('message', 'approval', 'signin') AND created_at > ?")
    .get(row.id, row.last_read_at ?? "") as { n: number };
  return {
    id: row.id,
    userId: row.user_id ?? "",
    kind: row.kind,
    botId: row.bot_id,
    name: row.name,
    members: members(row.id),
    lastMessage: last ? { author: last.author, body: last.body, at: last.created_at } : null,
    unread: Number(unread.n),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function getThread(id: string): Thread | null {
  const row = ensureKruDatabase().query("SELECT * FROM kru_threads WHERE id = ?").get(id) as ThreadRow | null;
  return row ? toThread(row) : null;
}

/** A person's conversations (everyone's, when no user is given). */
export function listThreads(options: { kind?: "bot" | "room"; userId?: string } = {}): Thread[] {
  const where: string[] = [];
  const params: string[] = [];
  if (options.kind) {
    where.push("kind = ?");
    params.push(options.kind);
  }
  if (options.userId) {
    where.push("user_id = ?");
    params.push(options.userId);
  }
  const rows = ensureKruDatabase()
    .query(`SELECT * FROM kru_threads ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY updated_at DESC`)
    .all(...params) as ThreadRow[];
  return rows.map(toThread);
}

/** Whose conversation it is; null for none. */
export function threadOwner(threadId: string): string | null {
  const row = ensureKruDatabase().query("SELECT user_id FROM kru_threads WHERE id = ?").get(threadId) as { user_id: string | null } | null;
  return row?.user_id ?? null;
}

export function createRoom(name: string, botIds: string[], userId: string): Thread {
  const id = newId("room");
  const at = now();
  transaction((db) => {
    db.query("INSERT INTO kru_threads (id, kind, bot_id, name, user_id, created_at, updated_at) VALUES (?, 'room', NULL, ?, ?, ?, ?)").run(id, name, userId, at, at);
    for (const botId of new Set(botIds)) db.query("INSERT INTO kru_thread_members (thread_id, bot_id) VALUES (?, ?)").run(id, botId);
  });
  botsChanged();
  return getThread(id)!;
}

export function updateRoom(id: string, patch: { name?: string; members?: string[] }): Thread | null {
  const thread = getThread(id);
  if (!thread || thread.kind !== "room") return null;
  transaction((db) => {
    if (patch.name) db.query("UPDATE kru_threads SET name = ?, updated_at = ? WHERE id = ?").run(patch.name, now(), id);
    if (patch.members) {
      db.query("DELETE FROM kru_thread_members WHERE thread_id = ?").run(id);
      for (const botId of new Set(patch.members)) db.query("INSERT INTO kru_thread_members (thread_id, bot_id) VALUES (?, ?)").run(id, botId);
    }
  });
  botsChanged();
  return getThread(id);
}

export function deleteRoom(id: string): boolean {
  const thread = getThread(id);
  if (!thread || thread.kind !== "room") return false;
  ensureKruDatabase().query("DELETE FROM kru_threads WHERE id = ?").run(id);
  botsChanged();
  return true;
}

export function markThreadRead(id: string) {
  ensureKruDatabase().query("UPDATE kru_threads SET last_read_at = ? WHERE id = ?").run(now(), id);
  botsChanged();
}

// ---------- messages ----------

export type NewMessage = {
  threadId: string;
  author: MessageAuthor;
  body: string;
  kind?: MessageKind;
  attachments?: ChatAttachment[];
  depth?: number;
  approvalId?: string | null;
  fromThreadId?: string | null;
  /** True for lines nobody has to answer (bot replies, events). */
  answered?: boolean;
};

export function postMessage(input: NewMessage): Message {
  const id = newId("m");
  const at = now();
  const kind = input.kind ?? "message";
  const needsAnswer = !input.answered && ((kind === "message" && (input.author === "you" || input.author === "routine" || Boolean(input.fromThreadId))) || kind === "prompt");
  transaction((db) => {
    db.query(
      `INSERT INTO kru_messages (id, thread_id, author, kind, body, attachments, depth, approval_id, from_thread_id, answered_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, input.threadId, input.author, kind, input.body, JSON.stringify(input.attachments ?? []), input.depth ?? 0, input.approvalId ?? null, input.fromThreadId ?? null, needsAnswer ? null : at, at);
    db.query("UPDATE kru_threads SET updated_at = ? WHERE id = ?").run(at, input.threadId);
    if (input.author === "you") db.query("UPDATE kru_threads SET last_read_at = ? WHERE id = ?").run(at, input.threadId);
    for (const file of input.attachments ?? []) db.query("UPDATE kru_attachments SET message_id = ? WHERE id = ?").run(id, file.id);
  });
  threadChanged(input.threadId);
  return getMessage(id)!;
}

export function getMessage(id: string): Message | null {
  const row = ensureKruDatabase().query("SELECT * FROM kru_messages WHERE id = ?").get(id) as MessageRow | null;
  return row ? toMessage(row) : null;
}

/** Messages in a thread, oldest first; `after` returns only newer ones, `before` pages back. */
/**
 * A conversation's messages, oldest first. With `includeSent`, also what
 * its bot posted into other conversations (a brief, a question, a note to
 * a teammate), so the web can mark each hand-off where it happened.
 */
export function listMessages(threadId: string, options: { after?: string | null; before?: string | null; limit?: number; includeSent?: boolean } = {}): Message[] {
  const limit = Math.min(Math.max(options.limit ?? 200, 1), 500);
  const db = ensureKruDatabase();
  const where = options.includeSent ? "(thread_id = ? OR from_thread_id = ?)" : "thread_id = ?";
  const ids = options.includeSent ? [threadId, threadId] : [threadId];
  if (options.after) {
    const rows = db.query(`SELECT * FROM kru_messages WHERE ${where} AND created_at > ? ORDER BY created_at ASC, rowid ASC LIMIT ?`).all(...ids, options.after, limit) as MessageRow[];
    return rows.map(toMessage);
  }
  const rows = db
    .query(`SELECT * FROM kru_messages WHERE ${where} ${options.before ? "AND created_at < ?" : ""} ORDER BY created_at DESC, rowid DESC LIMIT ?`)
    .all(...(options.before ? [...ids, options.before, limit] : [...ids, limit])) as MessageRow[];
  return rows.reverse().map(toMessage);
}

/** Everything two conversations' bots said to each other, oldest first. */
export function listExchange(threadId: string, withThreadId: string, limit = 500): Message[] {
  const rows = ensureKruDatabase()
    .query(
      `SELECT * FROM kru_messages WHERE kind = 'message' AND ((thread_id = ? AND from_thread_id = ?) OR (thread_id = ? AND from_thread_id = ?)) ORDER BY created_at ASC, rowid ASC LIMIT ?`,
    )
    .all(threadId, withThreadId, withThreadId, threadId, limit) as MessageRow[];
  return rows.map(toMessage);
}

export function recentMessages(threadId: string, count: number): Message[] {
  const rows = ensureKruDatabase()
    .query("SELECT * FROM kru_messages WHERE thread_id = ? AND kind IN ('message', 'approval', 'signin') ORDER BY created_at DESC LIMIT ?")
    .all(threadId, count) as MessageRow[];
  return rows.reverse().map(toMessage);
}

/** Full-text-ish search across every thread, newest first. */
/** What was said in a person's conversations. */
export function searchMessages(query: string, userId: string, limit = 50): Message[] {
  const like = `%${query.replace(/[%_]/g, (c) => `\\${c}`)}%`;
  const rows = ensureKruDatabase()
    .query("SELECT m.* FROM kru_messages m JOIN kru_threads t ON t.id = m.thread_id WHERE t.user_id = ? AND m.kind = 'message' AND m.body LIKE ? ESCAPE '\\' ORDER BY m.created_at DESC LIMIT ?")
    .all(userId, like, limit) as MessageRow[];
  return rows.map(toMessage);
}

/**
 * Claims messages nobody is answering yet, for this process. Returns the
 * ones claimed. Used by the dispatcher every tick.
 */
export function claimPendingMessages(owner: string, limit: number): Message[] {
  return transaction((db) => {
    const rows = db
      .query("SELECT * FROM kru_messages WHERE answered_at IS NULL AND claimed_by IS NULL AND kind IN ('message', 'prompt') ORDER BY created_at ASC LIMIT ?")
      .all(limit) as MessageRow[];
    for (const row of rows) db.query("UPDATE kru_messages SET claimed_by = ? WHERE id = ?").run(owner, row.id);
    return rows.map(toMessage);
  });
}

export function markAnswered(id: string) {
  ensureKruDatabase().query("UPDATE kru_messages SET answered_at = ?, claimed_by = NULL WHERE id = ?").run(now(), id);
}

export function releaseClaim(id: string) {
  ensureKruDatabase().query("UPDATE kru_messages SET claimed_by = NULL WHERE id = ?").run(id);
}

/** True while something in the thread waits for an answer. */
export function threadBusy(threadId: string): boolean {
  const row = ensureKruDatabase().query("SELECT COUNT(*) AS n FROM kru_messages WHERE thread_id = ? AND answered_at IS NULL AND kind = 'message'").get(threadId) as { n: number };
  return Number(row.n) > 0;
}

export function clearThread(threadId: string) {
  ensureKruDatabase().query("DELETE FROM kru_messages WHERE thread_id = ?").run(threadId);
  threadChanged(threadId, true);
}

// ---------- attachments ----------

export function storeAttachment(file: { name: string; mediaType: string; data: Uint8Array }): ChatAttachment {
  const id = newId("f");
  ensureKruDatabase()
    .query("INSERT INTO kru_attachments (id, message_id, name, media_type, size, data, created_at) VALUES (?, NULL, ?, ?, ?, ?, ?)")
    .run(id, file.name, file.mediaType, file.data.byteLength, file.data, now());
  return { id, name: file.name, mediaType: file.mediaType, size: file.data.byteLength };
}

/** Whose conversation a file was posted in; null for a file not in one yet. */
export function attachmentOwner(id: string): string | null {
  const row = ensureKruDatabase()
    .query("SELECT t.user_id FROM kru_attachments a JOIN kru_messages m ON m.id = a.message_id JOIN kru_threads t ON t.id = m.thread_id WHERE a.id = ?")
    .get(id) as { user_id: string | null } | null;
  return row?.user_id ?? null;
}

export function getAttachment(id: string): { meta: ChatAttachment; data: Uint8Array } | null {
  const row = ensureKruDatabase().query("SELECT id, name, media_type, size, data FROM kru_attachments WHERE id = ?").get(id) as
    | { id: string; name: string; media_type: string; size: number; data: Uint8Array }
    | null;
  if (!row) return null;
  return { meta: { id: row.id, name: row.name, mediaType: row.media_type, size: row.size }, data: row.data };
}
