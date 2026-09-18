import type { Composio } from "@composio/core";
import { APP_CATALOG, appLogoUrl, type AppCatalogEntry, type Connection } from "@krubot/shared";
import { appUrl } from "./config.ts";
import { readComposioKey } from "./data/composio-keys.ts";
import { getConnection, listConnections, removeConnection, saveConnection } from "./data/settings.ts";
import { getUser, isAdmin } from "./data/users.ts";

/*
 * Connected apps through Composio: each person's own project key (set in
 * Settings → Apps; the admin falls back to COMPOSIO_API_KEY), one Composio
 * "user" per person, and one connected account per toolkit. Bots reach a
 * connected app's actions as tools through the `kru` MCP bridge; the API
 * executes them here with the Composio SDK, so no credential ever reaches
 * the box.
 *
 * A connection starts with a Composio Connect Link on the toolkit's auth
 * config (the project's own when there is one, else a Composio-managed one
 * made on first use); the person signs in there and comes back to
 * /api/connections/callback.
 */

/** The Composio user the admin's connections belong to, as they did when there was one. */
export const COMPOSIO_ADMIN_USER_ID = "krubot-owner";

/** The Composio user a person's connections belong to, inside their project. */
export function composioUserId(userId: string): string {
  return isAdmin(getUser(userId)) ? COMPOSIO_ADMIN_USER_ID : `kru-${userId}`;
}

export type ComposioTool = {
  slug: string;
  name: string;
  description?: string;
  toolkit?: { slug: string; name?: string };
  inputParameters?: unknown;
};

const clients = new Map<string, Promise<Composio>>();

/** COMPOSIO_API_KEY from the environment: the admin's key when they haven't set one in Settings. */
export function serverComposioKey(): string | null {
  const key = (process.env.COMPOSIO_API_KEY ?? "").trim();
  return key || null;
}

/** Where a person's key comes from: their own, the server's (the admin only), or nowhere. */
export function composioKeySource(userId: string): "own" | "server" | null {
  if (readComposioKey(userId)) return "own";
  if (serverComposioKey() && isAdmin(getUser(userId))) return "server";
  return null;
}

/** The key a person's calls to Composio use. Never leaves the API: not in a route's answer, not to the box. */
export function composioKey(userId: string): string | null {
  const source = composioKeySource(userId);
  return source === "own" ? readComposioKey(userId) : source === "server" ? serverComposioKey() : null;
}

export function composioConfigured(userId: string) {
  return composioKeySource(userId) !== null;
}

async function sdk(userId: string): Promise<Composio> {
  const key = composioKey(userId);
  if (!key) throw new Error("Connected apps need your Composio API key. Add it under Settings → Apps.");
  const hit = clients.get(key);
  if (hit) return hit;
  const ready = import("@composio/core").then((mod) => new mod.Composio({ apiKey: key }));
  clients.set(key, ready);
  return ready;
}

/** The toolkits the marketplace offers: the catalog, limited by COMPOSIO_TOOLKITS when set. */
export function offeredToolkits() {
  const allow = (process.env.COMPOSIO_TOOLKITS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return allow.length ? APP_CATALOG.filter((a) => allow.includes(a.toolkit)) : APP_CATALOG;
}

/** Per key: each project may offer different toolkits. */
const catalogCache = new Map<string, { at: number; apps: AppCatalogEntry[] }>();
const CATALOG_CACHE_MS = 10 * 60 * 1000;

/**
 * The apps the person can actually connect: the catalog, narrowed to the
 * toolkits Composio reports when a key is set, each with Composio's own
 * logo. Without a key, the catalog as is (with Composio's public logos).
 */
export async function availableToolkits(userId: string): Promise<AppCatalogEntry[]> {
  const offered = offeredToolkits().map((app) => ({ ...app, logo: appLogoUrl(app.toolkit) }));
  const key = composioKey(userId);
  if (!key) return offered;
  const hit = catalogCache.get(key);
  if (hit && Date.now() - hit.at < CATALOG_CACHE_MS) return hit.apps;
  try {
    const client = await sdk(userId);
    const found = await Promise.allSettled(offered.map((app) => client.toolkits.get(app.toolkit)));
    if (found.every((r) => r.status === "rejected")) throw (found[0] as PromiseRejectedResult | undefined)?.reason ?? new Error("no toolkits");
    const apps = offered.flatMap((app, i) => {
      const result = found[i]!;
      if (result.status === "rejected") return result.reason instanceof Error && result.reason.name === "ComposioToolkitNotFoundError" ? [] : [app];
      return [{ ...app, name: result.value.name || app.name, logo: result.value.meta?.logo || app.logo }];
    });
    const narrowed = apps.length ? apps : offered;
    catalogCache.set(key, { at: Date.now(), apps: narrowed });
    return narrowed;
  } catch (error) {
    console.warn(`[kru] could not list Composio toolkits: ${error instanceof Error ? error.message : error}`);
    return offered;
  }
}

function nameOf(toolkit: string) {
  return APP_CATALOG.find((a) => a.toolkit === toolkit)?.name ?? toolkit;
}

/** Composio's account statuses, as ours. */
function statusOf(raw: string): Connection["status"] {
  const value = raw.toUpperCase();
  if (value === "ACTIVE") return "active";
  if (value === "FAILED" || value === "EXPIRED" || value === "INACTIVE") return "failed";
  return "pending";
}

/** The toolkit's auth config: the project's first one, or a Composio-managed one made now. */
async function authConfigFor(client: Composio, toolkit: string): Promise<string> {
  const existing = await client.authConfigs.list({ toolkit });
  const id = existing.items.find((c) => c.status !== "DISABLED")?.id;
  if (id) return id;
  const created = await client.authConfigs.create(toolkit, { type: "use_composio_managed_auth", name: `${nameOf(toolkit)} (Kru Bot)` });
  return created.id;
}

/**
 * Starts a connection: a Composio Connect Link the person finishes in the
 * browser, landing back on /api/connections/callback. An account that is
 * already active for this person is reused instead.
 */
export async function startConnection(userId: string, toolkit: string): Promise<{ redirectUrl: string | null; accountId: string }> {
  const client = await sdk(userId);
  const authConfigId = await authConfigFor(client, toolkit);
  const active = await client.connectedAccounts.list({ userIds: [composioUserId(userId)], authConfigIds: [authConfigId], statuses: ["ACTIVE"] });
  const current = active.items[0];
  if (current) {
    saveConnection(userId, { toolkit, name: nameOf(toolkit), accountId: current.id, status: "active" });
    return { redirectUrl: null, accountId: current.id };
  }
  const callbackUrl = `${appUrl()}/api/connections/callback?toolkit=${encodeURIComponent(toolkit)}`;
  const request = await client.connectedAccounts.link(composioUserId(userId), authConfigId, { callbackUrl });
  saveConnection(userId, { toolkit, name: nameOf(toolkit), accountId: request.id, status: request.redirectUrl ? "pending" : statusOf(request.status ?? "") });
  return { redirectUrl: request.redirectUrl ?? null, accountId: request.id };
}

/** Asks Composio how a connection is doing and records the answer. */
export async function refreshConnection(userId: string, toolkit: string): Promise<Connection | null> {
  const stored = getConnection(userId, toolkit);
  if (!stored) return null;
  try {
    const client = await sdk(userId);
    const account = await client.connectedAccounts.get(stored.accountId);
    return saveConnection(userId, { toolkit, name: stored.name, accountId: stored.accountId, status: statusOf(account.status) });
  } catch {
    return stored;
  }
}

export async function disconnect(userId: string, toolkit: string): Promise<boolean> {
  const stored = getConnection(userId, toolkit);
  if (!stored) return false;
  try {
    const client = await sdk(userId);
    await client.connectedAccounts.delete(stored.accountId);
  } catch {
    /* the local record goes either way */
  }
  return removeConnection(userId, toolkit);
}

const toolCache = new Map<string, { at: number; tools: ComposioTool[] }>();
const TOOL_CACHE_MS = 10 * 60 * 1000;

/** Drops what was cached for a person's old key, when they change it. */
export function forgetComposioCache(userId: string) {
  for (const key of toolCache.keys()) if (key.startsWith(`${userId}:`)) toolCache.delete(key);
}

/** The actions of the toolkits a person has connected, cached for a while. */
export async function toolsFor(userId: string, toolkits: string[]): Promise<ComposioTool[]> {
  const active = new Set(listConnections(userId).filter((c) => c.status === "active").map((c) => c.toolkit));
  const wanted = toolkits.filter((t) => active.has(t)).sort();
  if (wanted.length === 0 || !composioConfigured(userId)) return [];
  const key = `${userId}:${wanted.join(",")}`;
  const hit = toolCache.get(key);
  if (hit && Date.now() - hit.at < TOOL_CACHE_MS) return hit.tools;
  const client = await sdk(userId);
  const tools: ComposioTool[] = await client.tools.getRawComposioTools({ toolkits: wanted, limit: 200 });
  toolCache.set(key, { at: Date.now(), tools });
  return tools;
}

/** True for an action that only reads: no card for those. */
export function isReadOnlyAction(slug: string) {
  return /(_GET_|_LIST_|_FETCH_|_SEARCH_|_READ_|_FIND_|_RETRIEVE_|_QUERY_|_LOOKUP_|_CHECK_|_COUNT_|_DOWNLOAD_)|(_GET|_LIST|_FETCH|_SEARCH|_READ|_FIND|_RETRIEVE)$/.test(slug.toUpperCase());
}

/**
 * Runs an action on the toolkit's connected account. Tools are listed at
 * the latest toolkit version, so they run at it too.
 */
export async function executeAction(userId: string, slug: string, args: Record<string, unknown>, toolkit?: string): Promise<unknown> {
  const client = await sdk(userId);
  const account = toolkit ? getConnection(userId, toolkit.toLowerCase()) : null;
  if (!account || account.status !== "active") throw new Error(`${toolkit ?? slug} isn't connected for this person.`);
  const result = await client.tools.execute(slug, { userId: composioUserId(userId), arguments: args, connectedAccountId: account.accountId, dangerouslySkipVersionCheck: true });
  if (!result.successful) throw new Error(`${result.error ?? `${slug} failed`}${result.logId ? ` (Composio log ${result.logId})` : ""}`);
  return result.data;
}
