import { ensureKruDatabase } from "../db/init.ts";
import { settingsChanged } from "../events.ts";
import { now } from "../ids.ts";
import { decryptSecret, encryptSecret } from "../secrets.ts";

/*
 * Each person's Composio project key. Encrypted at rest like a secret and
 * write-only: only composio.ts decrypts it, at the moment it talks to
 * Composio. No route returns it and the box never gets it.
 */

export function readComposioKey(userId: string): string | null {
  const row = ensureKruDatabase().query("SELECT api_key FROM kru_composio_keys WHERE user_id = ?").get(userId) as { api_key: string } | null;
  if (!row) return null;
  try {
    return decryptSecret(row.api_key);
  } catch {
    return null;
  }
}

export function hasComposioKey(userId: string): boolean {
  return Boolean(ensureKruDatabase().query("SELECT 1 FROM kru_composio_keys WHERE user_id = ?").get(userId));
}

export function setComposioKey(userId: string, apiKey: string): void {
  const key = apiKey.trim();
  if (!key || key.length > 500 || /\s/.test(key)) throw new Error("That doesn't look like a Composio API key");
  ensureKruDatabase()
    .query("INSERT INTO kru_composio_keys (user_id, api_key, updated_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET api_key = excluded.api_key, updated_at = excluded.updated_at")
    .run(userId, encryptSecret(key), now());
  settingsChanged();
}

export function clearComposioKey(userId: string): boolean {
  const changed = ensureKruDatabase().query("DELETE FROM kru_composio_keys WHERE user_id = ?").run(userId).changes;
  if (changed) settingsChanged();
  return changed > 0;
}

/** Every stored key, for redaction of what the bots write. */
export function allComposioKeys(): string[] {
  const rows = ensureKruDatabase().query("SELECT api_key FROM kru_composio_keys").all() as { api_key: string }[];
  const out: string[] = [];
  for (const row of rows) {
    try {
      out.push(decryptSecret(row.api_key));
    } catch {
      /* an unreadable key can't leak either */
    }
  }
  return out;
}
