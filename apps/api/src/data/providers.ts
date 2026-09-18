import { PROVIDER_KINDS, type ProviderInput, type ProviderKind, type ProviderMeta } from "@krubot/shared";
import { ensureKruDatabase } from "../db/init.ts";
import { settingsChanged } from "../events.ts";
import { now, randomString } from "../ids.ts";
import { decryptSecret, encryptSecret } from "../secrets.ts";

/*
 * The API providers the bots can run on: an Anthropic-compatible and an
 * OpenAI-compatible endpoint. The key is encrypted at rest like a secret
 * and only decrypted in the LLM proxy (routes/llm.ts), at the moment a
 * request goes out. No route returns it and the box never gets it: the box
 * gets the proxy URL and the provider's proxy token.
 */

type Row = { kind: string; base_url: string; api_key: string; proxy_token: string; last_check: string | null; created_at: string; updated_at: string };

export function isProviderKind(value: string): value is ProviderKind {
  return (PROVIDER_KINDS as readonly string[]).includes(value);
}

/** A base URL as stored: no trailing slash, no query or fragment. */
export function normalizeBaseUrl(value: string): string {
  const url = new URL(value.trim());
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("The URL starts with http:// or https://");
  if (url.username || url.password) throw new Error("Leave the username and password out of the URL");
  url.search = "";
  url.hash = "";
  return url.href.replace(/\/+$/, "");
}

function toMeta(row: Row): ProviderMeta {
  let check: ProviderMeta["check"] = null;
  try {
    check = row.last_check ? (JSON.parse(row.last_check) as ProviderMeta["check"]) : null;
  } catch {
    /* no check */
  }
  return { kind: row.kind as ProviderKind, baseUrl: row.base_url, check, updatedAt: row.updated_at };
}

function row(kind: ProviderKind): Row | null {
  return ensureKruDatabase().query("SELECT * FROM kru_providers WHERE kind = ?").get(kind) as Row | null;
}

export function listProviders(): ProviderMeta[] {
  const rows = ensureKruDatabase().query("SELECT * FROM kru_providers ORDER BY kind").all() as Row[];
  return rows.filter((r) => isProviderKind(r.kind)).map(toMeta);
}

export function getProvider(kind: ProviderKind): ProviderMeta | null {
  const found = row(kind);
  return found ? toMeta(found) : null;
}

/** Saves a provider. A new one needs a key; an edit without one keeps the stored key. */
export function saveProvider(kind: ProviderKind, input: ProviderInput): ProviderMeta {
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  const current = row(kind);
  if (!current && !input.apiKey) throw new Error("Add the API key");
  const at = now();
  if (current) {
    ensureKruDatabase()
      .query("UPDATE kru_providers SET base_url = ?, api_key = ?, last_check = ?, updated_at = ? WHERE kind = ?")
      .run(baseUrl, input.apiKey ? encryptSecret(input.apiKey) : current.api_key, input.apiKey || baseUrl !== current.base_url ? null : current.last_check, at, kind);
  } else {
    ensureKruDatabase()
      .query("INSERT INTO kru_providers (kind, base_url, api_key, proxy_token, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(kind, baseUrl, encryptSecret(input.apiKey!), randomString(32), at, at);
  }
  settingsChanged();
  return getProvider(kind)!;
}

export function recordProviderCheck(kind: ProviderKind, check: { ok: boolean; detail: string }): ProviderMeta | null {
  ensureKruDatabase()
    .query("UPDATE kru_providers SET last_check = ? WHERE kind = ?")
    .run(JSON.stringify({ ...check, at: now() }), kind);
  settingsChanged();
  return getProvider(kind);
}

export function deleteProvider(kind: ProviderKind): boolean {
  const changed = ensureKruDatabase().query("DELETE FROM kru_providers WHERE kind = ?").run(kind).changes;
  if (changed) settingsChanged();
  return changed > 0;
}

/** The plain key, for the proxy only. Never send it to a route or the box. */
export function providerKey(kind: ProviderKind): string | null {
  const found = row(kind);
  return found ? decryptSecret(found.api_key) : null;
}

/** The token the box's CLI presents to the proxy in place of the key. */
export function providerProxyToken(kind: ProviderKind): string | null {
  return row(kind)?.proxy_token ?? null;
}

/** Where a provider's requests go, for the proxy. */
export function providerBaseUrl(kind: ProviderKind): string | null {
  return row(kind)?.base_url ?? null;
}

/** Every stored key, for redacting what the bots write. */
export function allProviderKeys(): string[] {
  const rows = ensureKruDatabase().query("SELECT api_key FROM kru_providers").all() as { api_key: string }[];
  const out: string[] = [];
  for (const r of rows) {
    try {
      out.push(decryptSecret(r.api_key));
    } catch {
      /* unreadable, can't leak */
    }
  }
  return out;
}
