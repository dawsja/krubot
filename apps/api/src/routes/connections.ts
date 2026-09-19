import type { ComposioKeyStatus } from "@krubot/shared";
import { Hono } from "hono";
import { ownThread, userId } from "../access.ts";
import type { Env } from "../app.ts";
import { appUrl } from "../config.ts";
import { applyComposioKey, composioKey, composioKeySource, disconnect, forgetComposioCache, offeredToolkits, refreshConnection, startConnection } from "../composio.ts";
import { clearComposioKey } from "../data/composio-keys.ts";
import { listConnections, removeConnections } from "../data/settings.ts";

/*
 * Your connected apps, in your own Composio project: your key (write-only),
 * the connections made with it, and the callback Composio sends you back
 * to. Nobody sees or uses anyone else's.
 */

/** Clearing the key forgets what it connected; storing one goes through applyComposioKey. */
function keyChanged(me: string, before: string | null) {
  if (composioKey(me) === before) return;
  removeConnections(me);
  forgetComposioCache(me);
}

export function connectionsRoutes() {
  const app = new Hono<Env>();

  app.get("/connections", (c) => c.json({ configured: composioKeySource(userId(c)) !== null, connections: listConnections(userId(c)) }));

  app.get("/composio", (c) => c.json({ source: composioKeySource(userId(c)) } satisfies ComposioKeyStatus));

  /** Your key. A different key forgets the connections made with the old one: they live in its project. */
  app.put("/composio", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { apiKey?: unknown };
    if (typeof body.apiKey !== "string" || !body.apiKey.trim()) return c.json({ error: "Paste your Composio API key" }, 400);
    const me = userId(c);
    try {
      applyComposioKey(me, body.apiKey);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "Could not save the key" }, 400);
    }
    return c.json({ source: composioKeySource(me) } satisfies ComposioKeyStatus);
  });

  app.delete("/composio", (c) => {
    const me = userId(c);
    const before = composioKey(me);
    if (!clearComposioKey(me)) return c.json({ error: "No key saved" }, 404);
    keyChanged(me, before);
    return c.json({ source: composioKeySource(me) } satisfies ComposioKeyStatus);
  });

  /** `threadId` brings the person back to the conversation the bot asked from. */
  app.post("/connections/:toolkit/connect", async (c) => {
    const toolkit = c.req.param("toolkit").toLowerCase();
    if (!offeredToolkits().some((a) => a.toolkit === toolkit)) return c.json({ error: "That app isn't in the catalog" }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { threadId?: unknown };
    const thread = typeof body.threadId === "string" && ownThread(c, body.threadId) ? body.threadId : null;
    try {
      return c.json(await startConnection(userId(c), toolkit, thread));
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "Could not start the connection" }, 502);
    }
  });

  app.post("/connections/:toolkit/refresh", async (c) => {
    const connection = await refreshConnection(userId(c), c.req.param("toolkit").toLowerCase());
    return connection ? c.json({ connection }) : c.json({ error: "Not connected" }, 404);
  });

  /** Where Composio sends the browser back after OAuth; to the conversation it started from, else Settings. */
  app.get("/connections/callback", async (c) => {
    const toolkit = (c.req.query("toolkit") ?? "").toLowerCase();
    if (toolkit) await refreshConnection(userId(c), toolkit);
    const thread = c.req.query("thread") ?? "";
    const where = thread && ownThread(c, thread) ? `/app/t/${thread}` : "/app/settings/apps";
    return c.redirect(`${appUrl()}${where}?connected=${encodeURIComponent(toolkit)}`);
  });

  app.delete("/connections/:toolkit", async (c) => ((await disconnect(userId(c), c.req.param("toolkit").toLowerCase())) ? c.body(null, 204) : c.json({ error: "Not connected" }, 404)));

  return app;
}
