import { defaultOAuthRedirect, mcpToolkit, type McpAuthStatus, type McpOAuthRedirect, type McpServer, type McpServerInput } from "@krubot/shared";
import { ensureKruDatabase } from "../db/init.ts";
import { botsChanged, settingsChanged } from "../events.ts";
import { newId, now, randomString } from "../ids.ts";
import { decryptSecret, encryptSecret } from "../secrets.ts";

/*
 * Your MCP servers. Each HTTP server gets a proxy token: the box's Claude
 * Code sessions reach the server through the API with that token, and the
 * API adds the real headers (and any secrets in them) on the way.
 */

type Row = { id: string; name: string; transport: McpServer["transport"]; url: string | null; headers: string; command: string | null; args: string; env: string; enabled: number; proxy_token: string; oauth: string | null; auth_status: McpAuthStatus; auth_error: string | null; oauth_redirect: McpOAuthRedirect; shared: number; created_at: string; updated_at: string };

function json<T>(text: string, fallback: T): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

function toServer(row: Row): McpServer {
  return {
    id: row.id,
    name: row.name,
    transport: row.transport,
    url: row.url ?? undefined,
    headers: json<Record<string, string>>(row.headers, {}),
    command: row.command ?? undefined,
    args: json<string[]>(row.args, []),
    env: json<Record<string, string>>(row.env, {}),
    enabled: row.enabled === 1,
    shared: row.shared === 1,
    oauthRedirect: row.oauth_redirect === "localhost" ? "localhost" : "app",
    authStatus: row.auth_status ?? "none",
    authError: row.auth_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ---------- OAuth state (encrypted at rest, never returned by a route) ----------

export type McpOAuthState = {
  /** The authorization server's metadata we need. */
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  /** RFC 8707: the MCP server's canonical URL, sent as `resource`. */
  resource: string;
  scope?: string;
  clientId: string;
  clientSecret?: string;
  accessToken?: string;
  refreshToken?: string;
  /** Epoch ms. */
  expiresAt?: number;
  /** The redirect URI the client was registered with; a different one registers again. */
  redirectUri?: string;
};

export function getMcpOAuth(id: string): McpOAuthState | null {
  const row = ensureKruDatabase().query("SELECT oauth FROM kru_mcp_servers WHERE id = ?").get(id) as { oauth: string | null } | null;
  if (!row?.oauth) return null;
  try {
    return JSON.parse(decryptSecret(row.oauth)) as McpOAuthState;
  } catch {
    return null;
  }
}

export function setMcpOAuth(id: string, state: McpOAuthState | null): void {
  ensureKruDatabase().query("UPDATE kru_mcp_servers SET oauth = ?, updated_at = ? WHERE id = ?").run(state ? encryptSecret(JSON.stringify(state)) : null, now(), id);
}

export function setMcpAuthStatus(id: string, status: McpAuthStatus, error: string | null = null): void {
  ensureKruDatabase().query("UPDATE kru_mcp_servers SET auth_status = ?, auth_error = ?, updated_at = ? WHERE id = ?").run(status, error, now(), id);
  settingsChanged();
}

export function listMcpServers(): McpServer[] {
  const rows = ensureKruDatabase().query("SELECT * FROM kru_mcp_servers ORDER BY name COLLATE NOCASE").all() as Row[];
  return rows.map(toServer);
}

export function getMcpServer(id: string): McpServer | null {
  const row = ensureKruDatabase().query("SELECT * FROM kru_mcp_servers WHERE id = ?").get(id) as Row | null;
  return row ? toServer(row) : null;
}

/** The proxy token an HTTP server's requests must carry; null for stdio. */
export function mcpProxyToken(id: string): string | null {
  const row = ensureKruDatabase().query("SELECT proxy_token FROM kru_mcp_servers WHERE id = ?").get(id) as { proxy_token: string } | null;
  return row?.proxy_token ?? null;
}

export function createMcpServer(input: McpServerInput): McpServer {
  const id = newId("mcp");
  const at = now();
  ensureKruDatabase()
    .query("INSERT INTO kru_mcp_servers (id, name, transport, url, headers, command, args, env, enabled, oauth_redirect, shared, proxy_token, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(id, input.name, input.transport, input.url ?? null, JSON.stringify(input.headers), input.command ?? null, JSON.stringify(input.args), JSON.stringify(input.env), input.enabled ? 1 : 0, input.oauthRedirect ?? defaultOAuthRedirect(input.url), input.shared ? 1 : 0, randomString(32), at, at);
  settingsChanged();
  return getMcpServer(id)!;
}

export function updateMcpServer(id: string, patch: Partial<McpServerInput>): McpServer | null {
  const current = getMcpServer(id);
  if (!current) return null;
  const next = { ...current, ...patch };
  ensureKruDatabase()
    .query("UPDATE kru_mcp_servers SET name = ?, transport = ?, url = ?, headers = ?, command = ?, args = ?, env = ?, enabled = ?, oauth_redirect = ?, shared = ?, updated_at = ? WHERE id = ?")
    .run(next.name, next.transport, next.url ?? null, JSON.stringify(next.headers), next.command ?? null, JSON.stringify(next.args), JSON.stringify(next.env), next.enabled ? 1 : 0, next.oauthRedirect ?? "app", next.shared ? 1 : 0, now(), id);
  settingsChanged();
  return getMcpServer(id);
}

export function deleteMcpServer(id: string): boolean {
  const db = ensureKruDatabase();
  const changed = db.query("DELETE FROM kru_mcp_servers WHERE id = ?").run(id).changes;
  if (changed) {
    // No bot keeps a server that's gone.
    db.query("UPDATE kru_bots SET toolkits = (SELECT json_group_array(value) FROM json_each(kru_bots.toolkits) WHERE value != ?) WHERE EXISTS (SELECT 1 FROM json_each(kru_bots.toolkits) WHERE value = ?)").run(mcpToolkit(id), mcpToolkit(id));
    settingsChanged();
    botsChanged();
  }
  return changed > 0;
}
