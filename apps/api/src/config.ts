import { mkdirSync, chmodSync } from "node:fs";
import path from "node:path";

/** Where Kru Bot keeps its database and secret key: `KRU_DATA_DIR`, else ./data. */
export function dataDir() {
  return path.resolve(process.env.KRU_DATA_DIR ?? path.join(process.cwd(), "data"));
}

/** Creates the data directory if needed and keeps it owner-only. */
export function ensureDataDir() {
  const dir = dataDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  return dir;
}

/** The address the person opens Kru Bot on, without a trailing slash. */
export function appUrl() {
  return (process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
}

export function apiPort() {
  return Number(process.env.PORT || 8790);
}

/**
 * How many of one person's bots may answer at once. It is per person, not
 * for the whole install: everyone's bots run on their own plan or key, so
 * one person's busy team must never hold up anyone else's.
 */
export const TURNS_PER_PERSON = 3;

/** How long a pending approval waits before the bot is told nobody answered. */
export function approvalTimeoutMs() {
  return Math.max(1, Number(process.env.KRU_APPROVAL_TIMEOUT_MINUTES ?? 30) || 30) * 60_000;
}

