import { APP_CATALOG, appLogoUrl, type McpServer } from "@krubot/shared";

/*
 * A picture for one of your own MCP servers. Nothing says what a manually
 * added server is, so we go by what we have: a name that matches an app in
 * the catalog gets that app's logo, and otherwise the server's host gives
 * its site icon, looked up through DuckDuckGo's icon service (which answers
 * 404 for a site without one). The lookup happens here rather than in the
 * browser so the answer can be checked (the service's 404 carries a
 * placeholder image a browser would happily show) and so the person's
 * server hosts go out from the API, like the OAuth probe, not from their
 * browser. A command has no host, so it has no picture.
 */

export type McpIconResult = { kind: "redirect"; url: string } | { kind: "image"; type: string; bytes: ArrayBuffer } | null;

const ICON_SERVICE = "https://icons.duckduckgo.com/ip3/";
const CACHE_MS = 24 * 60 * 60 * 1000;
const cache = new Map<string, { at: number; result: McpIconResult }>();

/** The hosts to try for a site icon: the server's own, then the site above it. */
export function iconHosts(url: string | undefined): string[] {
  if (!url) return [];
  let host = "";
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return [];
    host = parsed.hostname.toLowerCase();
  } catch {
    return [];
  }
  if (!host || host === "localhost" || host.endsWith(".localhost") || /^[\d.]+$/.test(host) || host.includes(":")) return [];
  const labels = host.split(".");
  return labels.length > 2 ? [host, labels.slice(-2).join(".")] : [host];
}

/** The catalog app a server's name points at, when it does. */
export function catalogLogoFor(name: string): string | null {
  const wanted = name.trim().toLowerCase();
  const app = APP_CATALOG.find((entry) => entry.toolkit === wanted || entry.name.toLowerCase() === wanted);
  return app ? appLogoUrl(app.toolkit) : null;
}

async function fetchIcon(url: string): Promise<McpIconResult> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8_000), redirect: "follow" });
    const type = res.headers.get("content-type") ?? "";
    if (!res.ok || !type.startsWith("image/")) {
      await res.body?.cancel().catch(() => undefined);
      return null;
    }
    const bytes = await res.arrayBuffer();
    return bytes.byteLength > 0 && bytes.byteLength <= 512 * 1024 ? { kind: "image", type, bytes } : null;
  } catch {
    return null;
  }
}

/** Finds the server's picture; null means show the plug. Answers are kept for a day. */
export async function resolveMcpIcon(server: Pick<McpServer, "id" | "name" | "transport" | "url">, options: { iconService?: string; now?: number } = {}): Promise<McpIconResult> {
  if (server.transport !== "http") return null;
  const key = `${server.id}:${server.name}:${server.url ?? ""}`;
  const now = options.now ?? Date.now();
  const cached = cache.get(key);
  if (cached && now - cached.at < CACHE_MS) return cached.result;
  let result: McpIconResult = null;
  const logo = catalogLogoFor(server.name);
  if (logo) result = { kind: "redirect", url: logo };
  for (const host of logo ? [] : iconHosts(server.url)) {
    result = await fetchIcon(`${options.iconService ?? ICON_SERVICE}${host}.ico`);
    if (result) break;
  }
  cache.set(key, { at: now, result });
  return result;
}

