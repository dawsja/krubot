import type { Composio } from "@composio/core";
import { APP_CATALOG, appLogoUrl, type AppCatalogEntry, type Connection } from "@krubot/shared";
import { appUrl } from "./config.ts";
import { getConnection, listConnections, removeConnection, saveConnection } from "./data/settings.ts";

/*
 * Connected apps through Composio: one project key, one Composio "user"
 * (this install), and one connected account per toolkit. Bots reach a
 * connected app's actions as tools through the `kru` MCP bridge; the API
 * executes them here with the Composio SDK, so no credential ever reaches
 * the box.
 *
 * A connection starts with a Composio Connect Link on the toolkit's auth
 * config (the project's own when there is one, else a Composio-managed one
 * made on first use); the person signs in there and comes back to
 * /api/connections/callback.
 */

/** The Composio user every connection belongs to: this install's owner. */
export const COMPOSIO_USER_ID = "krubot-owner";

export type ComposioTool = {
  slug: string;
  name: string;
  description?: string;
  toolkit?: { slug: string; name?: string };
  inputParameters?: unknown;
};

let cached: { key: string; sdk: Promise<Composio> } | null = null;

export function composioKey(): string | null {
  const key = (process.env.COMPOSIO_API_KEY ?? "").trim();
  return key || null;
}

export function composioConfigured() {
  return Boolean(composioKey());
}

async function sdk(): Promise<Composio> {
  const key = composioKey();
  if (!key) throw new Error("Connected apps need a Composio project key. Set COMPOSIO_API_KEY (see .env.example).");
  if (cached?.key === key) return cached.sdk;
  const ready = import("@composio/core").then((mod) => new mod.Composio({ apiKey: key }));
  cached = { key, sdk: ready };
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

const catalogCache = { at: 0, apps: null as AppCatalogEntry[] | null };
const CATALOG_CACHE_MS = 10 * 60 * 1000;

/**
 * The apps the person can actually connect: the catalog, narrowed to the
 * toolkits Composio reports when a key is set, each with Composio's own
 * logo. Without a key, the catalog as is (with Composio's public logos).
 */
export async function availableToolkits(): Promise<AppCatalogEntry[]> {
  const offered = offeredToolkits().map((app) => ({ ...app, logo: appLogoUrl(app.toolkit) }));
  if (!composioConfigured()) return offered;
  if (catalogCache.apps && Date.now() - catalogCache.at < CATALOG_CACHE_MS) return catalogCache.apps;
  try {
    const client = await sdk();
    const found = await Promise.allSettled(offered.map((app) => client.toolkits.get(app.toolkit)));
    if (found.every((r) => r.status === "rejected")) throw (found[0] as PromiseRejectedResult | undefined)?.reason ?? new Error("no toolkits");
    const apps = offered.flatMap((app, i) => {
      const result = found[i]!;
      if (result.status === "rejected") return result.reason instanceof Error && result.reason.name === "ComposioToolkitNotFoundError" ? [] : [app];
      return [{ ...app, name: result.value.name || app.name, logo: result.value.meta?.logo || app.logo }];
    });
    catalogCache.at = Date.now();
    catalogCache.apps = apps.length ? apps : offered;
    return catalogCache.apps;
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
 * already active for this install is reused instead.
 */
export async function startConnection(toolkit: string): Promise<{ redirectUrl: string | null; accountId: string }> {
  const client = await sdk();
  const authConfigId = await authConfigFor(client, toolkit);
  const active = await client.connectedAccounts.list({ userIds: [COMPOSIO_USER_ID], authConfigIds: [authConfigId], statuses: ["ACTIVE"] });
  const current = active.items[0];
  if (current) {
    saveConnection({ toolkit, name: nameOf(toolkit), accountId: current.id, status: "active" });
    return { redirectUrl: null, accountId: current.id };
  }
  const callbackUrl = `${appUrl()}/api/connections/callback?toolkit=${encodeURIComponent(toolkit)}`;
  const request = await client.connectedAccounts.link(COMPOSIO_USER_ID, authConfigId, { callbackUrl });
  saveConnection({ toolkit, name: nameOf(toolkit), accountId: request.id, status: request.redirectUrl ? "pending" : statusOf(request.status ?? "") });
  return { redirectUrl: request.redirectUrl ?? null, accountId: request.id };
}

/** Asks Composio how a connection is doing and records the answer. */
export async function refreshConnection(toolkit: string): Promise<Connection | null> {
  const stored = getConnection(toolkit);
  if (!stored) return null;
  try {
    const client = await sdk();
    const account = await client.connectedAccounts.get(stored.accountId);
    return saveConnection({ toolkit, name: stored.name, accountId: stored.accountId, status: statusOf(account.status) });
  } catch {
    return stored;
  }
}

export async function disconnect(toolkit: string): Promise<boolean> {
  const stored = getConnection(toolkit);
  if (!stored) return false;
  try {
    const client = await sdk();
    await client.connectedAccounts.delete(stored.accountId);
  } catch {
    /* the local record goes either way */
  }
  return removeConnection(toolkit);
}

const toolCache = new Map<string, { at: number; tools: ComposioTool[] }>();
const TOOL_CACHE_MS = 10 * 60 * 1000;

/** The actions a toolkit offers, cached for a while. */
export async function toolsFor(toolkits: string[]): Promise<ComposioTool[]> {
  const active = new Set(listConnections().filter((c) => c.status === "active").map((c) => c.toolkit));
  const wanted = toolkits.filter((t) => active.has(t)).sort();
  if (wanted.length === 0 || !composioConfigured()) return [];
  const key = wanted.join(",");
  const hit = toolCache.get(key);
  if (hit && Date.now() - hit.at < TOOL_CACHE_MS) return hit.tools;
  const client = await sdk();
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
export async function executeAction(slug: string, args: Record<string, unknown>, toolkit?: string): Promise<unknown> {
  const client = await sdk();
  const account = toolkit ? getConnection(toolkit.toLowerCase()) : null;
  const result = await client.tools.execute(slug, { userId: COMPOSIO_USER_ID, arguments: args, connectedAccountId: account?.accountId, dangerouslySkipVersionCheck: true });
  if (!result.successful) throw new Error(`${result.error ?? `${slug} failed`}${result.logId ? ` (Composio log ${result.logId})` : ""}`);
  return result.data;
}
