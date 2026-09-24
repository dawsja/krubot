import { PROVIDER_KINDS, type ProviderInput, type ProviderKind, type ProviderMeta } from "@krubot/shared";
import { ensureKruDatabase } from "../db/init.ts";
import { emit } from "../events.ts";
import { newId, now, randomString } from "../ids.ts";
import { decryptSecret, encryptSecret } from "../secrets.ts";

/*
 * The API providers a person's bots can run on: an Anthropic-compatible
 * and an OpenAI-compatible endpoint, each person's own. The key is
 * encrypted at rest like a secret and only decrypted in the LLM proxy
 * (routes/llm.ts), at the moment a request goes out. No route returns it
 * and the box never gets it: the box gets the proxy URL and the provider's
 * proxy token, which names the person's row.
 */

type Row = { id: string; user_id: string | null; kind: string; base_url: string; api_key: string; proxy_token: string; last_check: string | null; created_at: string; updated_at: string };

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

function row(userId: string, kind: ProviderKind): Row | null {
  return ensureKruDatabase().query("SELECT * FROM kru_providers WHERE user_id = ? AND kind = ?").get(userId, kind) as Row | null;
}

export function listProviders(userId: string): ProviderMeta[] {
  const rows = ensureKruDatabase().query("SELECT * FROM kru_providers WHERE user_id = ? ORDER BY kind").all(userId) as Row[];
  return rows.filter((r) => isProviderKind(r.kind)).map(toMeta);
}

export function getProvider(userId: string, kind: ProviderKind): ProviderMeta | null {
  const found = row(userId, kind);
  return found ? toMeta(found) : null;
}

/** Saves a person's provider. A new one needs a key; an edit without one keeps the stored key. */
export function saveProvider(userId: string, kind: ProviderKind, input: ProviderInput): ProviderMeta {
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  const current = row(userId, kind);
  if (!current && !input.apiKey) throw new Error("Add the API key");
  const at = now();
  if (current) {
    ensureKruDatabase()
      .query("UPDATE kru_providers SET base_url = ?, api_key = ?, last_check = ?, updated_at = ? WHERE id = ?")
      .run(baseUrl, input.apiKey ? encryptSecret(input.apiKey) : current.api_key, input.apiKey || baseUrl !== current.base_url ? null : current.last_check, at, current.id);
  } else {
    ensureKruDatabase()
      .query("INSERT INTO kru_providers (id, user_id, kind, base_url, api_key, proxy_token, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(newId("prov_"), userId, kind, baseUrl, encryptSecret(input.apiKey!), randomString(32), at, at);
  }
  emit({ topic: "ai", userId });
  return getProvider(userId, kind)!;
}

export function recordProviderCheck(userId: string, kind: ProviderKind, check: { ok: boolean; detail: string }): ProviderMeta | null {
  ensureKruDatabase()
    .query("UPDATE kru_providers SET last_check = ? WHERE user_id = ? AND kind = ?")
    .run(JSON.stringify({ ...check, at: now() }), userId, kind);
  emit({ topic: "ai", userId });
  return getProvider(userId, kind);
}

export function deleteProvider(userId: string, kind: ProviderKind): boolean {
  const changed = ensureKruDatabase().query("DELETE FROM kru_providers WHERE user_id = ? AND kind = ?").run(userId, kind).changes;
  if (changed) emit({ topic: "ai", userId });
  return changed > 0;
}

/** The plain key, for the proxy only. Never send it to a route or the box. */
export function providerKey(userId: string, kind: ProviderKind): string | null {
  const found = row(userId, kind);
  return found ? decryptSecret(found.api_key) : null;
}

/** The token the box's CLI presents to the proxy in place of the key. */
export function providerProxyToken(userId: string, kind: ProviderKind): string | null {
  return row(userId, kind)?.proxy_token ?? null;
}

/** Where a provider's requests go, for the proxy. */
export function providerBaseUrl(userId: string, kind: ProviderKind): string | null {
  return row(userId, kind)?.base_url ?? null;
}

/**
 * The provider a proxy token stands for: whose it is, where it goes and
 * its key. For the LLM proxy, which knows nothing but the token the CLI
 * presented. Null for a token nobody has.
 */
export function providerByToken(kind: ProviderKind, token: string): { userId: string; baseUrl: string; key: string } | null {
  if (!token) return null;
  const found = ensureKruDatabase().query("SELECT * FROM kru_providers WHERE kind = ? AND proxy_token = ? AND user_id IS NOT NULL").get(kind, token) as Row | null;
  if (!found) return null;
  try {
    return { userId: found.user_id!, baseUrl: found.base_url, key: decryptSecret(found.api_key) };
  } catch {
    return null;
  }
}

/** Every stored key, everyone's, for redacting what the bots write. */
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
