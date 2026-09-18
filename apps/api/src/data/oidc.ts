import { OIDC_DEFAULT_SCOPES, type OidcPatch, type OidcSettings } from "@krubot/shared";
import { ensureKruDatabase } from "../db/init.ts";
import { settingsChanged } from "../events.ts";
import { now } from "../ids.ts";
import { decryptSecret, encryptSecret } from "../secrets.ts";

/*
 * The OIDC provider people sign in with. One row's worth of JSON in
 * kru_settings; the client secret is encrypted like every other secret and
 * only ever read by auth.ts when it builds the provider. A route sees
 * `hasClientSecret`, never the value.
 */

type Stored = { enabled?: boolean; name?: string; issuer?: string; clientId?: string; clientSecret?: string; scopes?: string; updatedAt?: string };

function read(): Stored {
  const row = ensureKruDatabase().query("SELECT oidc FROM kru_settings WHERE id = 1").get() as { oidc: string | null } | null;
  try {
    return row?.oidc ? (JSON.parse(row.oidc) as Stored) : {};
  } catch {
    return {};
  }
}

function write(stored: Stored) {
  ensureKruDatabase().query("UPDATE kru_settings SET oidc = ?, updated_at = ? WHERE id = 1").run(JSON.stringify(stored), now());
}

export function getOidcSettings(): OidcSettings {
  const stored = read();
  return {
    enabled: stored.enabled === true,
    name: stored.name?.trim() || "SSO",
    issuer: stored.issuer ?? "",
    clientId: stored.clientId ?? "",
    scopes: stored.scopes?.trim() || OIDC_DEFAULT_SCOPES,
    hasClientSecret: Boolean(stored.clientSecret),
    updatedAt: stored.updatedAt ?? null,
  };
}

/** Everything auth.ts needs to build the provider, or null while it isn't set up. */
export function oidcProvider(): { name: string; issuer: string; clientId: string; clientSecret: string; scopes: string[] } | null {
  const stored = read();
  if (stored.enabled !== true || !stored.issuer || !stored.clientId || !stored.clientSecret) return null;
  return {
    name: stored.name?.trim() || "SSO",
    issuer: stored.issuer.replace(/\/+$/, ""),
    clientId: stored.clientId,
    clientSecret: decryptSecret(stored.clientSecret),
    scopes: (stored.scopes?.trim() || OIDC_DEFAULT_SCOPES).split(/\s+/).filter(Boolean),
  };
}

/** Whether a sign-in with the provider can work: on, with an issuer, a client id and a secret. */
export function oidcReady(): boolean {
  return oidcProvider() !== null;
}

export function updateOidcSettings(patch: OidcPatch): OidcSettings {
  const stored = read();
  const next: Stored = { ...stored, updatedAt: now() };
  if (patch.enabled !== undefined) next.enabled = patch.enabled;
  if (patch.name !== undefined) next.name = patch.name;
  if (patch.issuer !== undefined) next.issuer = patch.issuer.replace(/\/+$/, "");
  if (patch.clientId !== undefined) next.clientId = patch.clientId;
  if (patch.scopes !== undefined) next.scopes = patch.scopes || OIDC_DEFAULT_SCOPES;
  // An empty secret leaves the stored one alone; there is no way to read it back.
  if (patch.clientSecret) next.clientSecret = encryptSecret(patch.clientSecret);
  write(next);
  settingsChanged();
  return getOidcSettings();
}

/** Turns the provider off and forgets its secret. */
export function clearOidcSecret(): OidcSettings {
  const stored = read();
  write({ ...stored, enabled: false, clientSecret: undefined, updatedAt: now() });
  settingsChanged();
  return getOidcSettings();
}
