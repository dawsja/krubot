import { Database } from "bun:sqlite";
import { chmodSync, closeSync, existsSync, openSync } from "node:fs";
import path from "node:path";
import { dataDir, ensureDataDir } from "../config.ts";

export function dbPath() {
  return path.join(dataDir(), "krubot.db");
}

type DbCache = { path: string; db: Database };
const holder = globalThis as typeof globalThis & { __kruSqlite?: DbCache };

/**
 * Opens the database once per process. The file is created owner-only before
 * WAL mode is turned on, so the -wal and -shm files SQLite adds get the same
 * 0600 permissions.
 */
export function getDb(): Database {
  const file = dbPath();
  const cached = holder.__kruSqlite;
  if (cached && cached.path === file) return cached.db;

  ensureDataDir();
  if (!existsSync(file)) closeSync(openSync(file, "a", 0o600));
  chmodSync(file, 0o600);

  const db = new Database(file, { create: true, strict: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA synchronous = NORMAL");
  holder.__kruSqlite = { path: file, db };
  return db;
}

/** Closes the cached handle. Tests use this between data directories. */
export function closeDb() {
  holder.__kruSqlite?.db.close();
  holder.__kruSqlite = undefined;
}

