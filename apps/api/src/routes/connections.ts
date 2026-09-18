import type { ComposioKeyStatus } from "@krubot/shared";
import { Hono } from "hono";
import { userId } from "../access.ts";
import type { Env } from "../app.ts";
import { appUrl } from "../config.ts";
import { composioKey, composioKeySource, disconnect, forgetComposioCache, offeredToolkits, refreshConnection, startConnection } from "../composio.ts";
import { clearComposioKey, setComposioKey } from "../data/composio-keys.ts";
import { listConnections, removeConnections } from "../data/settings.ts";

/*
 * Your connected apps, in your own Composio project: your key (write-only),
 * the connections made with it, and the callback Composio sends you back
 * to. Nobody sees or uses anyone else's.
 */

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
    const before = composioKey(me);
    try {
      setComposioKey(me, body.apiKey);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "Could not save the key" }, 400);
    }
    keyChanged(me, before);
    return c.json({ source: composioKeySource(me) } satisfies ComposioKeyStatus);
  });

  app.delete("/composio", (c) => {
    const me = userId(c);
    const before = composioKey(me);
    if (!clearComposioKey(me)) return c.json({ error: "No key saved" }, 404);
    keyChanged(me, before);
    return c.json({ source: composioKeySource(me) } satisfies ComposioKeyStatus);
  });

  app.post("/connections/:toolkit/connect", async (c) => {
    const toolkit = c.req.param("toolkit").toLowerCase();
    if (!offeredToolkits().some((a) => a.toolkit === toolkit)) return c.json({ error: "That app isn't in the catalog" }, 404);
    try {
      return c.json(await startConnection(userId(c), toolkit));
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "Could not start the connection" }, 502);
    }
  });

  app.post("/connections/:toolkit/refresh", async (c) => {
    const connection = await refreshConnection(userId(c), c.req.param("toolkit").toLowerCase());
    return connection ? c.json({ connection }) : c.json({ error: "Not connected" }, 404);
  });

  /** Where Composio sends the browser back after OAuth. */
  app.get("/connections/callback", async (c) => {
    const toolkit = (c.req.query("toolkit") ?? "").toLowerCase();
    if (toolkit) await refreshConnection(userId(c), toolkit);
    return c.redirect(`${appUrl()}/app/settings/apps?connected=${encodeURIComponent(toolkit)}`);
  });

  app.delete("/connections/:toolkit", async (c) => ((await disconnect(userId(c), c.req.param("toolkit").toLowerCase())) ? c.body(null, 204) : c.json({ error: "Not connected" }, 404)));

  return app;
}
