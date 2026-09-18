import { SECRET_NAME, SECRET_REF, type SecretMeta, type SecretRequest } from "@krubot/shared";
import { ensureKruDatabase } from "../db/init.ts";
import { emit, settingsChanged, threadChanged } from "../events.ts";
import { newId, now } from "../ids.ts";
import { decryptSecret, encryptSecret } from "../secrets.ts";
import { allProviderKeys } from "./providers.ts";

/*
 * Secrets the bots use but never see. Values are encrypted at rest with
 * the master key and only ever decrypted inside the API, at the moment one
 * is injected into a request. Nothing here returns a value to a route.
 */

export function listSecrets(): SecretMeta[] {
  const rows = ensureKruDatabase().query("SELECT name, requested_by, created_at, updated_at FROM kru_secrets ORDER BY name").all() as { name: string; requested_by: string | null; created_at: string; updated_at: string }[];
  return rows.map((r) => ({ name: r.name, requestedBy: r.requested_by, createdAt: r.created_at, updatedAt: r.updated_at }));
}

export function hasSecret(name: string): boolean {
  return Boolean(ensureKruDatabase().query("SELECT 1 FROM kru_secrets WHERE name = ?").get(name));
}

export function setSecret(name: string, value: string, requestedBy: string | null = null): void {
  if (!SECRET_NAME.test(name)) throw new Error("A secret's name is letters, digits and underscores, like OPENAI_API_KEY");
  if (!value || value.length > 8_000) throw new Error("The value is empty or too long");
  const at = now();
  ensureKruDatabase()
    .query("INSERT INTO kru_secrets (name, value, requested_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value, requested_by = COALESCE(excluded.requested_by, kru_secrets.requested_by), updated_at = excluded.updated_at")
    .run(name, encryptSecret(value), requestedBy, at, at);
  settingsChanged();
}

export function deleteSecret(name: string): boolean {
  const changed = ensureKruDatabase().query("DELETE FROM kru_secrets WHERE name = ?").run(name).changes;
  if (changed) settingsChanged();
  return changed > 0;
}

/** The plain value, for injection only. Never send it to a route or the box. */
export function readSecret(name: string): string | null {
  const row = ensureKruDatabase().query("SELECT value FROM kru_secrets WHERE name = ?").get(name) as { value: string } | null;
  return row ? decryptSecret(row.value) : null;
}

/** Every plain value (and every AI provider key), for redaction of what the bots write. */
export function allSecretValues(): string[] {
  const rows = ensureKruDatabase().query("SELECT value FROM kru_secrets").all() as { value: string }[];
  const out: string[] = [];
  for (const row of rows) {
    try {
      out.push(decryptSecret(row.value));
    } catch {
      /* an unreadable secret can't leak either */
    }
  }
  return [...out, ...allProviderKeys()];
}

/** Replaces {{secret:NAME}} in a string; unknown names become empty. */
export function injectSecrets(text: string, missing?: (name: string) => void): string {
  return text.replace(SECRET_REF, (_match, name: string) => {
    const value = readSecret(name);
    if (value === null) missing?.(name);
    return value ?? "";
  });
}

// ---------- requests from bots ----------

type RequestRow = { id: string; bot_id: string; thread_id: string; name: string; reason: string; status: SecretRequest["status"]; created_at: string; resolved_at: string | null };

function toRequest(row: RequestRow): SecretRequest {
  return { id: row.id, botId: row.bot_id, threadId: row.thread_id, name: row.name, reason: row.reason, status: row.status, createdAt: row.created_at, resolvedAt: row.resolved_at };
}

export function createSecretRequest(input: { botId: string; threadId: string; name: string; reason: string }): SecretRequest {
  const id = newId("sr");
  ensureKruDatabase().query("INSERT INTO kru_secret_requests (id, bot_id, thread_id, name, reason, status, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?)").run(id, input.botId, input.threadId, input.name, input.reason, now());
  return getSecretRequest(id)!;
}

export function getSecretRequest(id: string): SecretRequest | null {
  const row = ensureKruDatabase().query("SELECT * FROM kru_secret_requests WHERE id = ?").get(id) as RequestRow | null;
  return row ? toRequest(row) : null;
}

export function resolveSecretRequest(id: string, status: Exclude<SecretRequest["status"], "pending">): SecretRequest | null {
  const current = getSecretRequest(id);
  if (!current || current.status !== "pending") return current;
  ensureKruDatabase().query("UPDATE kru_secret_requests SET status = ?, resolved_at = ? WHERE id = ?").run(status, now(), id);
  const next = getSecretRequest(id)!;
  threadChanged(next.threadId);
  emit({ topic: "approvals" });
  return next;
}
