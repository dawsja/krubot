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

/** How many bots may answer at once. */
export function concurrency() {
  return Math.max(1, Number(process.env.KRU_BOT_CONCURRENCY ?? 3) || 3);
}

/** How long a pending approval waits before the bot is told nobody answered. */
export function approvalTimeoutMs() {
  return Math.max(1, Number(process.env.KRU_APPROVAL_TIMEOUT_MINUTES ?? 30) || 30) * 60_000;
}

/** How hard Claude Code thinks per reply, when the bot has no setting of its own. */
export function defaultEffort(): string | null {
  const value = (process.env.KRU_BOT_EFFORT ?? "").trim();
  return /^(low|medium|high)$/.test(value) ? value : null;
}
