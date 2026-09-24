import { ENGINE_LABELS, isCliEngine, isOpenAiShaped, providerInputSchema, type Engine, type ModelChoice, type ModelGroup, type ModelList, type ProviderKind } from "@krubot/shared";
import { Hono } from "hono";
import type { Env } from "../app.ts";
import { userId } from "../access.ts";
import { getAi, releaseEngines } from "../data/ai.ts";
import { boxConfig, engineModels } from "../box.ts";
import { deleteProvider, getProvider, isProviderKind, listProviders, providerBaseUrl, providerByToken, providerKey, recordProviderCheck, saveProvider } from "../data/providers.ts";

/*
 * AI providers, each person's own: the settings (under the session, for
 * the signed-in person), and the proxy the bots' CLIs reach them through
 * (under the provider's proxy token, which names whose it is). The proxy
 * is the one place a provider key is added to a request, so the box, the
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
  if (isOpenAiShaped(kind)) return { authorization: `Bearer ${key}` };
  return isAnthropicHost(baseUrl) ? { "x-api-key": key } : { "x-api-key": key, authorization: `Bearer ${key}` };
}

/** Where a provider lists its models, and the headers that read it. */
function modelsRequest(kind: ProviderKind, baseUrl: string, key: string): { url: URL; headers: Record<string, string> } {
  return {
    url: upstreamUrl(baseUrl, isOpenAiShaped(kind) ? "models" : "v1/models", ""),
    headers: { ...authHeaders(kind, baseUrl, key), ...(isOpenAiShaped(kind) ? {} : { "anthropic-version": "2023-06-01" }) },
  };
}

/** The ids in a provider's model list, whichever of the two shapes it answers in. */
export function readModels(payload: unknown): ModelChoice[] {
  const rows = (payload as { data?: unknown; models?: unknown })?.data ?? (payload as { models?: unknown })?.models;
  if (!Array.isArray(rows)) return [];
  const out: ModelChoice[] = [];
  for (const row of rows) {
    const id = typeof row === "string" ? row : typeof (row as { id?: unknown })?.id === "string" ? (row as { id: string }).id : null;
    if (!id) continue;
    const name = typeof (row as { display_name?: unknown })?.display_name === "string" ? (row as { display_name: string }).display_name : undefined;
    out.push(name ? { id, name } : { id });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
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

/**
 * Where a proxied request goes: `suffix` under the base, and only there.
 * The suffix is whatever path the caller sent, and the caller is the box,
 * which a prompt injection can drive: `https://evil.example/x` or `..`
 * would otherwise carry the person's key to any host. Null when the
 * target leaves the base's origin or its path.
 */
export function proxiedUrl(baseUrl: string, suffix: string, search: string): URL | null {
  let base: URL;
  let target: URL;
  try {
    base = new URL(baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
    target = upstreamUrl(baseUrl, suffix, search);
  } catch {
    return null;
  }
  if (target.origin !== base.origin || target.username || target.password) return null;
  if (!target.pathname.startsWith(base.pathname)) return null;
  return target;
}

/** Asks the provider for its model list with the key: tells a bad key from a good one. */
async function checkProvider(owner: string, kind: ProviderKind): Promise<{ ok: boolean; detail: string }> {
  const baseUrl = providerBaseUrl(owner, kind);
  const key = providerKey(owner, kind);
  if (!baseUrl || !key) return { ok: false, detail: "Not set" };
  const { url, headers } = modelsRequest(kind, baseUrl, key);
  try {
    const res = await fetch(url, { headers, redirect: "manual", signal: AbortSignal.timeout(15_000) });
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

  app.get("/providers", (c) => c.json({ providers: listProviders(userId(c)) }));

  app.put("/providers/:kind", async (c) => {
    const kind = c.req.param("kind");
    if (!isProviderKind(kind)) return c.json({ error: "No such provider" }, 404);
    const parsed = providerInputSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? "Bad provider" }, 400);
    try {
      saveProvider(userId(c), kind, parsed.data);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "Could not save" }, 400);
    }
    const provider = recordProviderCheck(userId(c), kind, await checkProvider(userId(c), kind));
    return c.json({ provider });
  });

  app.post("/providers/:kind/check", async (c) => {
    const kind = c.req.param("kind");
    if (!isProviderKind(kind) || !getProvider(userId(c), kind)) return c.json({ error: "No such provider" }, 404);
    return c.json({ provider: recordProviderCheck(userId(c), kind, await checkProvider(userId(c), kind)) });
  });

  app.delete("/providers/:kind", (c) => {
    const kind = c.req.param("kind");
    if (!isProviderKind(kind)) return c.json({ error: "No such provider" }, 404);
    if (!deleteProvider(userId(c), kind)) return c.json({ error: "No such provider" }, 404);
    // The switch that put an engine on this key went with it: those engines go back to the plan.
    releaseEngines(userId(c), kind, (other) => Boolean(getProvider(userId(c), other)));
    return c.body(null, 204);
  });

  /**
   * The models to pick from: one group per engine the person has turned
   * on. A CLI is asked for its own list in their account on the computer;
   * an API key is asked for its list with the key. Either way a model id
   * can still be typed by hand, so a model that landed this morning works
   * today.
   */
  app.get("/models", async (c) => {
    const who = userId(c);
    const ai = getAi(who);
    const groups = await Promise.all(ai.enabled.map((engine) => modelsFor(who, engine)));
    return c.json({ groups } satisfies ModelList);
  });

  return app;
}

/** One engine's models, from wherever that engine keeps them. */
async function modelsFor(userId: string, engine: Engine): Promise<ModelGroup> {
  if (isCliEngine(engine)) {
    const box = boxConfig(userId);
    if (!box) return { engine, models: [], source: "none", detail: "The computer isn't reachable." };
    const { models } = await engineModels(box, engine).catch(() => ({ models: [] as ModelChoice[] }));
    return models.length ? { engine, models, source: "engine", detail: null } : { engine, models: [], source: "none", detail: `${ENGINE_LABELS[engine].name} didn't list its models. Type the model id you want.` };
  }
  const info = ENGINE_LABELS[engine];
  const kind = getAi(userId).engines[engine].provider ?? info.providers.find((p) => getProvider(userId, p)) ?? info.provider;
  const baseUrl = providerBaseUrl(userId, kind);
  const key = providerKey(userId, kind);
  if (!baseUrl || !key) return { engine, models: [], source: "none", detail: "No API key saved yet." };
  const { url, headers } = modelsRequest(kind, baseUrl, key);
  try {
    const res = await fetch(url, { headers, redirect: "manual", signal: AbortSignal.timeout(15_000) });
    const models = res.ok ? readModels(await res.json().catch(() => null)) : [];
    if (models.length) return { engine, models, source: "provider", detail: null };
    return { engine, models: [], source: "none", detail: res.ok ? "The API listed no models. Type the model id you want." : "The API wouldn't list its models. Type the model id you want." };
  } catch {
    return { engine, models: [], source: "none", detail: "The API didn't answer. Type the model id you want." };
  }
}

/**
 * The proxy: /api/llm/:kind/* → the provider's base URL, with the real key
 * in place of the proxy token the CLI presented. The token names the
 * person's provider, so each person's bots reach their own key and nobody
 * else's. Streams both ways, so server-sent events pass through as they
 * come.
 */
export function llmProxyRoutes() {
  const app = new Hono();

  app.all("/llm/:kind/*", async (c) => {
    const kind = c.req.param("kind");
    if (!isProviderKind(kind)) return c.json({ error: "No such provider" }, 404);
    const token = presentedToken(c.req.raw.headers);
    // Tokens are random and unique; the lookup is by equality in the database, never by prefix.
    const provider = token.length >= 16 && token.length <= 200 ? providerByToken(kind, token) : null;
    if (!provider) return c.json({ error: { type: "authentication_error", message: "Unauthorized" } }, 401);
    const { baseUrl, key } = provider;

    const suffix = c.req.path.replace(/^\/api\/llm\/[^/]+\/?/, "");
    const target = proxiedUrl(baseUrl, suffix, new URL(c.req.url).search);
    if (!target) return c.json({ error: { type: "invalid_request_error", message: "That path isn't under the provider's address" } }, 400);
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
