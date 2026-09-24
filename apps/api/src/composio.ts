import type { Composio } from "@composio/core";
import { APP_CATALOG, appLogoUrl, type AppCatalogEntry, type Connection } from "@krubot/shared";
import { indexApps, type AppIndex } from "./catalog.ts";
import { appUrl } from "./config.ts";
import { readComposioKey, setComposioKey } from "./data/composio-keys.ts";
import { getConnection, listConnections, removeConnection, removeConnections, saveConnection } from "./data/settings.ts";
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

/**
 * Stores a person's own Composio key. A key for a different project can't
 * see what the old one connected, so those connections are forgotten. The
 * settings route and a bot's request both come through here.
 */
export function applyComposioKey(userId: string, apiKey: string) {
  const before = composioKey(userId);
  setComposioKey(userId, apiKey);
  if (composioKey(userId) === before) return;
  removeConnections(userId);
  forgetComposioCache(userId);
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

/** COMPOSIO_TOOLKITS narrows the marketplace to a few toolkits; unset, every app Composio offers is there. */
function toolkitAllowList(): Set<string> | null {
  const allow = (process.env.COMPOSIO_TOOLKITS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return allow.length ? new Set(allow) : null;
}

/** The familiar few, with Composio's public logos: what the marketplace shows before a key is set. */
let fallbackIndex: AppIndex | null = null;
function fallbackCatalog(): AppIndex {
  fallbackIndex ??= indexApps(narrowed(APP_CATALOG.map((app) => ({ ...app, logo: appLogoUrl(app.toolkit) }))));
  return fallbackIndex;
}

/** The catalog as this install offers it: every app, or the few COMPOSIO_TOOLKITS names. */
function narrowed(apps: AppCatalogEntry[]): AppCatalogEntry[] {
  const allow = toolkitAllowList();
  return allow ? apps.filter((a) => allow.has(a.toolkit)) : apps;
}

/** One of Composio's toolkits as an app in the catalog. Native slugs are lowercase, as ours are. */
function entryOf(item: { slug: string; name?: string; meta?: { logo?: string; description?: string; categories?: { name?: string }[] } }): AppCatalogEntry {
  const toolkit = item.slug.toLowerCase();
  const known = APP_CATALOG.find((a) => a.toolkit === toolkit);
  const description = item.meta?.description?.trim();
  return {
    toolkit,
    name: item.name?.trim() || known?.name || toolkit,
    icon: known?.icon ?? toolkit,
    category: item.meta?.categories?.[0]?.name?.trim() || known?.category || "Apps",
    logo: item.meta?.logo || appLogoUrl(toolkit),
    ...(description ? { description } : {}),
  };
}

/** Per key: each project may offer different toolkits. Indexed once, here, so a search is free. */
const catalogCache = new Map<string, { at: number; index: AppIndex }>();
/** A page asks for the catalog from several cards at once; they wait on one fetch. */
const catalogFetches = new Map<string, Promise<AppIndex>>();
const CATALOG_CACHE_MS = 10 * 60 * 1000;
/** Composio takes 1000 at most; a handful of pages covers everything they support. */
const TOOLKIT_PAGE = 500;
const TOOLKIT_PAGES = 40;

/**
 * Every toolkit Composio offers the person's project, page by page. The
 * SDK's own list drops the cursor, so this asks the API client under it.
 */
async function fetchToolkits(userId: string): Promise<AppCatalogEntry[]> {
  const client = (await sdk(userId)).getClient();
  const apps = new Map<string, AppCatalogEntry>();
  let cursor: string | undefined;
  for (let page = 0; page < TOOLKIT_PAGES; page++) {
    const answer = await client.toolkits.list({ limit: TOOLKIT_PAGE, ...(cursor ? { cursor } : {}) });
    for (const item of answer.items) {
      // A project's own custom toolkits are its registered MCP servers
      // (slug CUSTOM_…); Kru Bot has its own section for those.
      if (item.type === "custom") continue;
      const entry = entryOf(item);
      if (!apps.has(entry.toolkit)) apps.set(entry.toolkit, entry);
    }
    cursor = answer.next_cursor ?? undefined;
    if (!cursor || answer.items.length === 0) break;
  }
  return [...apps.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The catalog the person can connect from: every toolkit Composio supports,
 * with their own names, logos and categories, read and indexed once and
 * kept for a while per key. Without a key, or when Composio can't be
 * reached, the familiar few. COMPOSIO_TOOLKITS narrows either one.
 */
export async function catalogIndex(userId: string): Promise<AppIndex> {
  const key = composioKey(userId);
  if (!key) return fallbackCatalog();
  const hit = catalogCache.get(key);
  if (hit && Date.now() - hit.at < CATALOG_CACHE_MS) return hit.index;
  const running = catalogFetches.get(key);
  if (running) return running;
  const ready = fetchToolkits(userId)
    .then((apps) => {
      if (!apps.length) throw new Error("Composio listed no toolkits");
      const index = indexApps(narrowed(apps));
      catalogCache.set(key, { at: Date.now(), index });
      return index;
    })
    .catch((error: unknown) => {
      console.warn(`[kru] could not list Composio toolkits: ${error instanceof Error ? error.message : error}`);
      return fallbackCatalog();
    })
    .finally(() => catalogFetches.delete(key));
  catalogFetches.set(key, ready);
  return ready;
}

/** One app of the catalog, or null when the person can't connect it. */
export async function catalogEntry(userId: string, toolkit: string): Promise<AppCatalogEntry | null> {
  const index = await catalogIndex(userId).catch(() => fallbackCatalog());
  return index.bySlug.get(toolkit.toLowerCase()) ?? null;
}

/** What to call a toolkit in a card, a connection or an error. */
async function nameOf(userId: string, toolkit: string): Promise<string> {
  return (await catalogEntry(userId, toolkit))?.name ?? APP_CATALOG.find((a) => a.toolkit === toolkit)?.name ?? toolkit;
}

/** Composio's account statuses, as ours. */
function statusOf(raw: string): Connection["status"] {
  const value = raw.toUpperCase();
  if (value === "ACTIVE") return "active";
  if (value === "FAILED" || value === "EXPIRED" || value === "INACTIVE") return "failed";
  return "pending";
}

/**
 * The toolkit's auth config: the project's first one, or a Composio-managed
 * one made now. Some apps (X, and every app whose owner hands out its own
 * client ids) have no credentials Composio manages, so that last step
 * fails; say what to do about it rather than passing Composio's raw answer
 * on to the person.
 */
async function authConfigFor(client: Composio, toolkit: string, name: string): Promise<string> {
  const existing = await client.authConfigs.list({ toolkit });
  const id = existing.items.find((c) => c.status !== "DISABLED")?.id;
  if (id) return id;
  try {
    const created = await client.authConfigs.create(toolkit, { type: "use_composio_managed_auth", name: `${name} (Kru Bot)` });
    return created.id;
  } catch (error) {
    const said = error instanceof Error ? error.message : String(error);
    if (!/managed|default auth config|auth_config_default/i.test(said)) throw error;
    throw new Error(`${name} needs credentials of your own: Composio has none it manages for it. Make an auth config for ${toolkit} in your Composio project (dashboard.composio.dev → Auth Configs) with your own client id and secret, then connect again.`);
  }
}

/**
 * Starts a connection: a Composio Connect Link the person finishes in the
 * browser, landing back on /api/connections/callback. An account that is
 * already active for this person is reused instead.
 */
export async function startConnection(userId: string, toolkit: string, threadId?: string | null): Promise<{ redirectUrl: string | null; accountId: string }> {
  const client = await sdk(userId);
  const name = await nameOf(userId, toolkit);
  const authConfigId = await authConfigFor(client, toolkit, name);
  const active = await client.connectedAccounts.list({ userIds: [composioUserId(userId)], authConfigIds: [authConfigId], statuses: ["ACTIVE"] });
  const current = active.items[0];
  if (current) {
    saveConnection(userId, { toolkit, name, accountId: current.id, status: "active" });
    return { redirectUrl: null, accountId: current.id };
  }
  const callbackUrl = `${appUrl()}/api/connections/callback?toolkit=${encodeURIComponent(toolkit)}${threadId ? `&thread=${encodeURIComponent(threadId)}` : ""}`;
  const request = await client.connectedAccounts.link(composioUserId(userId), authConfigId, { callbackUrl });
  saveConnection(userId, { toolkit, name, accountId: request.id, status: request.redirectUrl ? "pending" : statusOf(request.status ?? "") });
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
