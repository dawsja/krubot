import type { Database } from "bun:sqlite";
import { now } from "../ids.ts";
import { runMigrations } from "./migrations.ts";
import { dbPath, getDb } from "./sqlite.ts";

const holder = globalThis as typeof globalThis & { __kruDbReady?: string };

/**
 * Claims from a previous process mean nothing now: every message being
 * answered when the server stopped goes back to pending, so the dispatcher
 * picks it up again.
 */
function releaseClaims(db: Database) {
  db.query("UPDATE kru_messages SET claimed_by = NULL WHERE claimed_by IS NOT NULL").run();
  const at = now();
  db.query("UPDATE kru_approvals SET status = 'expired', resolved_at = ? WHERE status = 'pending'").run(at);
}

/** Opens the database, applies migrations, and readies the settings row. Idempotent per process. */
export function ensureKruDatabase(): Database {
  const db = getDb();
  const key = dbPath();
  if (holder.__kruDbReady === key) return db;
  runMigrations(db);
  db.query("INSERT OR IGNORE INTO kru_settings (id, updated_at) VALUES (1, ?)").run(now());
  releaseClaims(db);
  holder.__kruDbReady = key;
  return db;
}

/**
 * Runs `fn` inside an immediate write transaction on the prepared database.
 * `fn` must be synchronous, so no network call can happen while the
 * transaction is open.
 */
export function transaction<T>(fn: (db: Database) => T): T {
  const db = ensureKruDatabase();
  return db.transaction(() => fn(db)).immediate();
}

/** Forgets that the database was prepared; tests use it between data directories. */
export function resetDbReady() {
  holder.__kruDbReady = undefined;
}
