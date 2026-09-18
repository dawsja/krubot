import { mcpServerInputSchema } from "@krubot/shared";
import { Hono } from "hono";
import { admin } from "../access.ts";
import type { Env } from "../app.ts";
import { appUrl } from "../config.ts";
import { createMcpServer, deleteMcpServer, getMcpServer, listMcpServers, mcpProxyToken, setMcpAuthStatus, updateMcpServer } from "../data/mcp.ts";
import { getThread } from "../data/threads.ts";
import { bearerFor, completeMcpLogin, completeMcpLoginFrom, probeMcpServer, signOutMcp, startMcpLogin } from "../mcp-oauth.ts";
import { injectSecrets } from "../data/secrets.ts";
import { resolveMcpIcon } from "../mcp-icon.ts";
import { timingSafeEqualString } from "../ids.ts";

/*
 * Your MCP servers: the settings, and the proxy the box reaches HTTP
 * servers through. The proxy is the one place secrets get added to a
 * request, so a bot's session never holds them.
 */

function validate(input: unknown) {
  const parsed = mcpServerInputSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Bad server" };
  const data = parsed.data;
  if (data.transport === "http" && !data.url) return { error: "An HTTP server needs a URL" };
  if (data.transport === "stdio" && !data.command) return { error: "A stdio server needs a command" };
  return { data };
}

export function mcpRoutes() {
  const app = new Hono<Env>();

  app.get("/mcp-servers", (c) => {
    if (admin(c)) return c.json({ servers: listMcpServers() });
    // A user sees the servers the admin shared: the name and the kind, not the headers or the sign-in.
    return c.json({ servers: listMcpServers().filter((s) => s.shared && s.enabled).map((s) => ({ ...s, headers: {}, env: {}, args: [], command: s.command ? "(command)" : undefined, authError: null })) });
  });

  app.post("/mcp-servers", async (c) => {
    const result = validate(await c.req.json().catch(() => ({})));
    if ("error" in result) return c.json({ error: result.error }, 400);
    try {
      const server = createMcpServer(result.data!);
      // Does it want a sign-in? The card shows a Sign in button when it does.
      if (server.transport === "http") void probeMcpServer(server.id).catch(() => undefined);
      return c.json({ server }, 201);
    } catch (error) {
      return c.json({ error: /UNIQUE/.test(String(error)) ? "A server with that name exists" : "Could not save the server" }, 400);
    }
  });

  app.patch("/mcp-servers/:id", async (c) => {
    const current = getMcpServer(c.req.param("id"));
    if (!current) return c.json({ error: "No such server" }, 404);
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const result = validate({ ...current, ...body });
    if ("error" in result) return c.json({ error: result.error }, 400);
    const server = updateMcpServer(current.id, result.data!);
    if (server?.transport === "http" && server.url !== current.url) void probeMcpServer(server.id).catch(() => undefined);
    return c.json({ server });
  });

  // The server's picture for the settings row and the bot's profile: its site icon, or 404 for the plug.
  app.get("/mcp-servers/:id/icon", async (c) => {
    const server = getMcpServer(c.req.param("id"));
    if (!server) return c.json({ error: "No such server" }, 404);
    const icon = await resolveMcpIcon(server);
    if (!icon) return c.body(null, 404, { "Cache-Control": "private, max-age=3600" });
    if (icon.kind === "redirect") return c.redirect(icon.url, 302);
    return new Response(icon.bytes, { status: 200, headers: { "Content-Type": icon.type, "Cache-Control": "private, max-age=86400", "X-Content-Type-Options": "nosniff" } });
  });

  // ---------- sign-in for servers that ask for one ----------

  app.post("/mcp-servers/:id/probe", async (c) => {
    const server = getMcpServer(c.req.param("id"));
    if (!server) return c.json({ error: "No such server" }, 404);
    return c.json({ result: await probeMcpServer(server.id), server: getMcpServer(server.id) });
  });

  app.post("/mcp-servers/:id/login", async (c) => {
    const server = getMcpServer(c.req.param("id"));
    if (!server) return c.json({ error: "No such server" }, 404);
    // A card in a conversation passes its thread, so the sign-in comes back there.
    const body = (await c.req.json().catch(() => ({}))) as { threadId?: unknown };
    const threadId = typeof body.threadId === "string" && getThread(body.threadId) ? body.threadId : undefined;
    try {
      return c.json({ url: await startMcpLogin(server.id, { threadId }) });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not start the sign-in";
      setMcpAuthStatus(server.id, "error", message);
      return c.json({ error: message }, 502);
    }
  });

  app.get("/mcp-servers/oauth/callback", async (c) => {
    const result = await completeMcpLogin({ code: c.req.query("code"), state: c.req.query("state"), error: c.req.query("error"), errorDescription: c.req.query("error_description") });
    if (result.threadId) return c.redirect(`${appUrl()}/app/t/${result.threadId}`);
    return c.redirect(`${appUrl()}/app/settings/apps?${result.ok ? `mcp=${encodeURIComponent(result.name ?? "")}` : `mcp_error=${encodeURIComponent(result.reason ?? "")}`}`);
  });

  // A localhost sign-in in a browser: the person pastes the address the page landed on.
  app.post("/mcp-servers/oauth/complete", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { url?: unknown };
    if (typeof body.url !== "string" || !body.url.trim() || body.url.length > 8000) return c.json({ error: "Paste the address the sign-in ended on." }, 400);
    const result = await completeMcpLoginFrom(body.url);
    return result.ok ? c.json({ name: result.name, threadId: result.threadId }) : c.json({ error: result.reason }, 400);
  });

  app.delete("/mcp-servers/:id/login", (c) => {
    const server = getMcpServer(c.req.param("id"));
    if (!server) return c.json({ error: "No such server" }, 404);
    signOutMcp(server.id);
    return c.json({ server: getMcpServer(server.id) });
  });

  app.delete("/mcp-servers/:id", (c) => {
    const ok = deleteMcpServer(c.req.param("id"));
    return ok ? c.body(null, 204) : c.json({ error: "No such server" }, 404);
  });

  return app;
}

/**
 * The proxy: /api/mcp/:id/* → the server's URL, with the configured
 * headers and their secrets filled in. Authenticated by the server's proxy
 * token (the box carries it), not by the session cookie. Streams both
 * ways, so Streamable HTTP and SSE transports pass through unchanged.
 */
export function mcpProxyRoutes() {
  const app = new Hono();
  const HOP = new Set(["host", "connection", "content-length", "transfer-encoding", "x-kru-mcp-token", "x-kru-mcp-auth", "cookie"]);

  app.all("/mcp/:id/*", async (c) => {
    const server = getMcpServer(c.req.param("id"));
    if (!server || server.transport !== "http" || !server.url) return c.json({ error: "No such MCP server" }, 404);
    const token = c.req.header("x-kru-mcp-token") ?? "";
    const expected = mcpProxyToken(server.id) ?? "";
    if (!expected || token.length !== expected.length || !timingSafeEqualString(token, expected)) return c.json({ error: "Unauthorized" }, 401);
    if (!server.enabled) return c.json({ error: "This MCP server is turned off" }, 503);

    // The box calls /api/mcp/:id/mcp (see mcp.ts); that is the server's own URL, whatever
    // path it has (Robinhood's ends in /mcp/trading). Anything past it is appended.
    const suffix = c.req.path.replace(/^\/api\/mcp\/[^/]+(\/mcp)?\/?/, "");
    const base = new URL(server.url);
    const target = suffix ? new URL(suffix, base.href.endsWith("/") ? base.href : `${base.href}/`) : new URL(base.href);
    target.search = new URL(c.req.url).search;
    const headers = new Headers();
    for (const [key, value] of c.req.raw.headers) if (!HOP.has(key.toLowerCase())) headers.set(key, value);
    const missing: string[] = [];
    for (const [key, value] of Object.entries(server.headers)) headers.set(key, injectSecrets(value, (name) => missing.push(name)));
    if (missing.length) return c.json({ error: `Secret${missing.length > 1 ? "s" : ""} not set: ${missing.join(", ")}. Add ${missing.length > 1 ? "them" : "it"} under Settings → Secrets.` }, 424);
    // A server the person signed in to gets the bearer token; one that asked and wasn't answered gets told so.
    if (server.authStatus === "signed_in") {
      const bearer = await bearerFor(server.id);
      if (bearer) headers.set("Authorization", `Bearer ${bearer}`);
    } else if (server.authStatus === "needed") {
      return c.json({ error: `${server.name} needs the person to sign in first: Settings → Apps → MCP servers → ${server.name} → Sign in.` }, 401);
    }

    let upstream: Response;
    try {
      upstream = await fetch(target, { method: c.req.method, headers, body: c.req.method === "GET" || c.req.method === "HEAD" ? undefined : c.req.raw.body, redirect: "manual", signal: c.req.raw.signal, ...({ duplex: "half" } as object) });
    } catch (error) {
      return c.json({ error: `The MCP server didn't answer: ${error instanceof Error ? error.message : "unknown error"}` }, 502);
    }
    if (upstream.status === 401) {
      // The server wants a sign-in (or the one we had stopped working): remember, and tell the bot plainly.
      await upstream.body?.cancel().catch(() => undefined);
      void probeMcpServer(server.id).catch(() => undefined);
      return c.json({ error: `${server.name} needs the person to sign in: Settings → Apps → MCP servers → ${server.name} → Sign in.` }, 401);
    }
    const out = new Headers();
    for (const [key, value] of upstream.headers) if (!HOP.has(key.toLowerCase()) && key.toLowerCase() !== "set-cookie") out.set(key, value);
    return new Response(upstream.body, { status: upstream.status, headers: out });
  });

  return app;
}
