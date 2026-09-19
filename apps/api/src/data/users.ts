import type { Me, SignInProvider, UserRole, UserSummary } from "@krubot/shared";
import { ensureKruDatabase, transaction } from "../db/init.ts";
import { emit } from "../events.ts";
import { now } from "../ids.ts";
import { adoptLegacyAi } from "./ai.ts";

/*
 * The people, as Better Auth keeps them in its `user` and `account` tables
 * (this module only reads those), and what Kru keeps per person: their
 * picture, and which bots and conversations are theirs. The first account
 * is the admin; everyone from the OIDC provider is a user.
 */

type UserRow = { id: string; name: string; email: string; role: string | null; createdAt: string | number };

function toRole(value: string | null | undefined): UserRole {
  return value === "admin" ? "admin" : "user";
}

function providerOf(userId: string): SignInProvider {
  const row = ensureKruDatabase().query('SELECT providerId FROM "account" WHERE userId = ? ORDER BY createdAt LIMIT 1').get(userId) as { providerId: string } | null;
  return row?.providerId === "credential" ? "local" : "oidc";
}

function toIso(value: string | number): string {
  const date = typeof value === "number" ? new Date(value) : new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}

export function getUser(id: string): Me | null {
  const row = ensureKruDatabase().query('SELECT id, name, email, role, createdAt FROM "user" WHERE id = ?').get(id) as UserRow | null;
  if (!row) return null;
  return { id: row.id, name: row.name, email: row.email, role: toRole(row.role), provider: providerOf(row.id), avatar: avatarUrl(row.id) };
}

export function isAdmin(user: object | null | undefined): boolean {
  return toRole((user as { role?: string | null } | null | undefined)?.role) === "admin";
}

export function listUsers(): UserSummary[] {
  const db = ensureKruDatabase();
  const rows = db.query('SELECT id, name, email, role, createdAt FROM "user" ORDER BY createdAt ASC').all() as UserRow[];
  return rows.map((row) => {
    const bots = db.query("SELECT COUNT(*) AS n FROM kru_bots WHERE user_id = ? AND hidden = 0").get(row.id) as { n: number };
    return { id: row.id, name: row.name, email: row.email, role: toRole(row.role), provider: providerOf(row.id), avatar: avatarUrl(row.id), createdAt: toIso(row.createdAt), bots: Number(bots.n) };
  });
}

export function countUsers(): number {
  const row = ensureKruDatabase().query('SELECT COUNT(*) AS n FROM "user"').get() as { n: number };
  return Number(row.n);
}

/** The admin: the account with the role, else the oldest account (which then gets it). */
export function ensureAdmin(): string | null {
  const db = ensureKruDatabase();
  const admin = db.query('SELECT id FROM "user" WHERE role = ? ORDER BY createdAt ASC LIMIT 1').get("admin") as { id: string } | null;
  if (admin) return admin.id;
  const first = db.query('SELECT id FROM "user" ORDER BY createdAt ASC LIMIT 1').get() as { id: string } | null;
  if (!first) return null;
  db.query('UPDATE "user" SET role = ? WHERE id = ?').run("admin", first.id);
  return first.id;
}

/**
 * Rows from before there were users (bots, conversations, subscriptions,
 * the one picture) become the admin's. Runs at start; a no-op after that.
 */
export function adoptOrphans(adminId: string) {
  transaction((db) => {
    db.query("UPDATE kru_bots SET user_id = ? WHERE user_id IS NULL").run(adminId);
    db.query("UPDATE kru_threads SET user_id = ? WHERE user_id IS NULL").run(adminId);
    db.query("UPDATE kru_push_subscriptions SET user_id = ? WHERE user_id IS NULL").run(adminId);
    db.query("UPDATE kru_connections SET user_id = ? WHERE user_id IS NULL").run(adminId);
    db.query("UPDATE kru_mcp_servers SET user_id = ? WHERE user_id IS NULL").run(adminId);
    db.query("UPDATE kru_secrets SET user_id = ? WHERE user_id IS NULL").run(adminId);
    db.query("UPDATE kru_providers SET user_id = ? WHERE user_id IS NULL").run(adminId);
    adoptLegacyAi(adminId);
    const legacy = db.query("SELECT media_type, data, updated_at FROM kru_avatar WHERE id = 1").get() as { media_type: string; data: Uint8Array; updated_at: string } | null;
    if (legacy) {
      db.query("INSERT OR IGNORE INTO kru_user_avatars (user_id, media_type, data, updated_at) VALUES (?, ?, ?, ?)").run(adminId, legacy.media_type, legacy.data, legacy.updated_at);
      db.query("DELETE FROM kru_avatar WHERE id = 1").run();
    }
  });
}

/**
 * Removes what Kru keeps for a person; Better Auth's own rows (the user,
 * its accounts and sessions) go through its admin API, and their account
 * on the computer, home and all, is the caller's to remove.
 */
export function deleteUserData(userId: string): { bots: string[] } {
  return transaction((db) => {
    const bots = (db.query("SELECT id FROM kru_bots WHERE user_id = ?").all(userId) as { id: string }[]).map((r) => r.id);
    for (const id of bots) {
      db.query("DELETE FROM kru_routines WHERE bot_id = ?").run(id);
      db.query("DELETE FROM kru_approvals WHERE bot_id = ?").run(id);
      db.query("DELETE FROM kru_approval_rules WHERE bot_id = ?").run(id);
      db.query("DELETE FROM kru_delegations WHERE from_bot_id = ? OR to_bot_id = ?").run(id, id);
    }
    db.query("DELETE FROM kru_thread_members WHERE thread_id IN (SELECT id FROM kru_threads WHERE user_id = ?)").run(userId);
    db.query("DELETE FROM kru_threads WHERE user_id = ?").run(userId);
    db.query("DELETE FROM kru_bots WHERE user_id = ?").run(userId);
    db.query("DELETE FROM kru_push_subscriptions WHERE user_id = ?").run(userId);
    db.query("DELETE FROM kru_user_avatars WHERE user_id = ?").run(userId);
    db.query("DELETE FROM kru_connections WHERE user_id = ?").run(userId);
    db.query("DELETE FROM kru_mcp_servers WHERE user_id = ?").run(userId);
    db.query("DELETE FROM kru_secrets WHERE user_id = ?").run(userId);
    db.query("DELETE FROM kru_composio_keys WHERE user_id = ?").run(userId);
    db.query("DELETE FROM kru_providers WHERE user_id = ?").run(userId);
    db.query("DELETE FROM kru_user_ai WHERE user_id = ?").run(userId);
    return { bots };
  });
}

// ---------- your picture ----------

export const AVATAR_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;

type AvatarRow = { media_type: string; data: Uint8Array; updated_at: string };

export function getAvatar(userId: string): { mediaType: string; data: Uint8Array; updatedAt: string } | null {
  const row = ensureKruDatabase().query("SELECT media_type, data, updated_at FROM kru_user_avatars WHERE user_id = ?").get(userId) as AvatarRow | null;
  return row ? { mediaType: row.media_type, data: row.data, updatedAt: row.updated_at } : null;
}

/** The picture's URL with a version in it, so a new picture shows at once; null without one. */
export function avatarUrl(userId: string): string | null {
  const row = ensureKruDatabase().query("SELECT updated_at FROM kru_user_avatars WHERE user_id = ?").get(userId) as { updated_at: string } | null;
  return row ? `/api/me/avatar?v=${encodeURIComponent(row.updated_at)}` : null;
}

export function setAvatar(userId: string, input: { mediaType: string; data: Uint8Array }): string {
  if (!AVATAR_TYPES.has(input.mediaType)) throw new Error("Use a PNG, JPEG, WebP or GIF");
  if (input.data.byteLength > AVATAR_MAX_BYTES) throw new Error("The picture must be under 2 MB");
  const at = now();
  ensureKruDatabase()
    .query("INSERT INTO kru_user_avatars (user_id, media_type, data, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET media_type = excluded.media_type, data = excluded.data, updated_at = excluded.updated_at")
    .run(userId, input.mediaType, input.data, at);
  emit({ topic: "me", userId });
  return avatarUrl(userId)!;
}

export function clearAvatar(userId: string): boolean {
  const changed = ensureKruDatabase().query("DELETE FROM kru_user_avatars WHERE user_id = ?").run(userId).changes > 0;
  if (changed) emit({ topic: "me", userId });
  return changed;
}
