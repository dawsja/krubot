import { providerInputSchema, type ProviderKind } from "@krubot/shared";
import { Hono } from "hono";
import type { Env } from "../app.ts";
import { deleteProvider, getProvider, isProviderKind, listProviders, providerBaseUrl, providerKey, providerProxyToken, recordProviderCheck, saveProvider } from "../data/providers.ts";
import { timingSafeEqualString } from "../ids.ts";

/*
 * AI providers: the settings (under the session), and the proxy the bots'
 * CLIs reach them through (under the provider's proxy token). The proxy is
 * the one place a provider key is added to a request, so the box, the
 * CLIs and the web never hold it.
 */

/** Headers that belong to one hop, or carry what the proxy replaces. */
const HOP = new Set(["host", "connection", "content-length", "transfer-encoding", "keep-alive", "cookie", "authorization", "x-api-key", "x-kru-llm-token", "accept-encoding"]);

/** Anthropic's own API wants `x-api-key`; others that speak its API mostly want a bearer token. */
export function isAnthropicHost(baseUrl: string): boolean {
  try {
    return /(^|\.)anthropic\.com$/i.test(new URL(baseUrl).hostname);
  } catch {
    return false;
  }
}

/** The auth headers a provider's key goes out in. */
export function authHeaders(kind: ProviderKind, baseUrl: string, key: string): Record<string, string> {
  if (kind === "openai") return { authorization: `Bearer ${key}` };
  return isAnthropicHost(baseUrl) ? { "x-api-key": key } : { "x-api-key": key, authorization: `Bearer ${key}` };
}

/** The token the CLI sent, in whichever header it puts a key. */
export function presentedToken(headers: Headers): string {
  const bearer = /^Bearer\s+(.+)$/i.exec(headers.get("authorization") ?? "")?.[1];
  return (headers.get("x-kru-llm-token") ?? headers.get("x-api-key") ?? bearer ?? "").trim();
}

/** Where `suffix` lands under a base URL that may have its own path. */
export function upstreamUrl(baseUrl: string, suffix: string, search: string): URL {
  const target = new URL(suffix.replace(/^\/+/, ""), baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  target.search = search;
  return target;
}

/** Asks the provider for its model list with the key: tells a bad key from a good one. */
async function checkProvider(kind: ProviderKind): Promise<{ ok: boolean; detail: string }> {
  const baseUrl = providerBaseUrl(kind);
  const key = providerKey(kind);
  if (!baseUrl || !key) return { ok: false, detail: "Not set" };
  const url = upstreamUrl(baseUrl, kind === "anthropic" ? "v1/models" : "models", "");
  try {
    const res = await fetch(url, {
      headers: { ...authHeaders(kind, baseUrl, key), ...(kind === "anthropic" ? { "anthropic-version": "2023-06-01" } : {}) },
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    });
    await res.body?.cancel().catch(() => undefined);
    if (res.ok) return { ok: true, detail: "The key works." };
    if (res.status === 401 || res.status === 403) return { ok: false, detail: "The provider refused the key." };
    // Not every compatible server lists its models; a server that answered at all is reachable.
    if (res.status === 404 || res.status === 405) return { ok: true, detail: "Saved. The server answered but doesn't list models, so the key wasn't checked." };
    return { ok: false, detail: `The provider answered ${res.status}.` };
  } catch (error) {
    return { ok: false, detail: `The provider didn't answer: ${error instanceof Error ? error.message : "unknown error"}` };
  }
}

export function providerRoutes() {
  const app = new Hono<Env>();

  app.get("/providers", (c) => c.json({ providers: listProviders() }));

  app.put("/providers/:kind", async (c) => {
    const kind = c.req.param("kind");
    if (!isProviderKind(kind)) return c.json({ error: "No such provider" }, 404);
    const parsed = providerInputSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? "Bad provider" }, 400);
    try {
      saveProvider(kind, parsed.data);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "Could not save" }, 400);
    }
    const provider = recordProviderCheck(kind, await checkProvider(kind));
    return c.json({ provider });
  });

  app.post("/providers/:kind/check", async (c) => {
    const kind = c.req.param("kind");
    if (!isProviderKind(kind) || !getProvider(kind)) return c.json({ error: "No such provider" }, 404);
    return c.json({ provider: recordProviderCheck(kind, await checkProvider(kind)) });
  });

  app.delete("/providers/:kind", (c) => {
    const kind = c.req.param("kind");
    if (!isProviderKind(kind)) return c.json({ error: "No such provider" }, 404);
    return deleteProvider(kind) ? c.body(null, 204) : c.json({ error: "No such provider" }, 404);
  });

  return app;
}

/**
 * The proxy: /api/llm/:kind/* → the provider's base URL, with the real key
 * in place of the proxy token the CLI presented. Streams both ways, so
 * server-sent events pass through as they come.
 */
export function llmProxyRoutes() {
  const app = new Hono();

  app.all("/llm/:kind/*", async (c) => {
    const kind = c.req.param("kind");
    if (!isProviderKind(kind)) return c.json({ error: "No such provider" }, 404);
    const expected = providerProxyToken(kind) ?? "";
    const token = presentedToken(c.req.raw.headers);
    if (!expected || token.length !== expected.length || !timingSafeEqualString(token, expected)) return c.json({ error: { type: "authentication_error", message: "Unauthorized" } }, 401);
    const baseUrl = providerBaseUrl(kind);
    const key = providerKey(kind);
    if (!baseUrl || !key) return c.json({ error: { type: "not_found", message: "This provider isn't set up. Add it under Settings → AI." } }, 404);

    const suffix = c.req.path.replace(/^\/api\/llm\/[^/]+\/?/, "");
    const target = upstreamUrl(baseUrl, suffix, new URL(c.req.url).search);
    const headers = new Headers();
    for (const [name, value] of c.req.raw.headers) if (!HOP.has(name.toLowerCase())) headers.set(name, value);
    for (const [name, value] of Object.entries(authHeaders(kind, baseUrl, key))) headers.set(name, value);

    let upstream: Response;
    try {
      upstream = await fetch(target, {
        method: c.req.method,
        headers,
        body: c.req.method === "GET" || c.req.method === "HEAD" ? undefined : c.req.raw.body,
        redirect: "manual",
        signal: c.req.raw.signal,
        ...({ duplex: "half" } as object),
      });
    } catch (error) {
      return c.json({ error: { type: "api_error", message: `The provider didn't answer: ${error instanceof Error ? error.message : "unknown error"}` } }, 502);
    }
    const out = new Headers();
    for (const [name, value] of upstream.headers) {
      const lower = name.toLowerCase();
      // fetch already decoded the body, so its encoding and length no longer apply.
      if (HOP.has(lower) || lower === "set-cookie" || lower === "content-encoding") continue;
      out.set(name, value);
    }
    return new Response(upstream.body, { status: upstream.status, headers: out });
  });

  return app;
}
