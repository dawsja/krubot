import { Hono } from "hono";
import { admin } from "../access.ts";
import type { Env } from "../app.ts";
import { appUrl } from "../config.ts";
import { composioConfigured, disconnect, offeredToolkits, refreshConnection, startConnection } from "../composio.ts";
import { listConnections, setConnectionShared } from "../data/settings.ts";

export function connectionsRoutes() {
  const app = new Hono<Env>();

  app.get("/connections", (c) => {
    if (admin(c)) return c.json({ configured: composioConfigured(), connections: listConnections() });
    // A user sees the apps the admin shared, enough to pick them for a bot.
    return c.json({ configured: composioConfigured(), connections: listConnections().filter((x) => x.shared && x.status === "active").map((x) => ({ ...x, accountId: "" })) });
  });

  /** Whether every user's bots may use the app. */
  app.patch("/connections/:toolkit", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { shared?: unknown };
    if (typeof body.shared !== "boolean") return c.json({ error: "Say whether it is shared" }, 400);
    const connection = setConnectionShared(c.req.param("toolkit").toLowerCase(), body.shared);
    return connection ? c.json({ connection }) : c.json({ error: "Not connected" }, 404);
  });

  app.post("/connections/:toolkit/connect", async (c) => {
    const toolkit = c.req.param("toolkit").toLowerCase();
    if (!offeredToolkits().some((a) => a.toolkit === toolkit)) return c.json({ error: "That app isn't in the catalog" }, 404);
    try {
      return c.json(await startConnection(toolkit));
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "Could not start the connection" }, 502);
    }
  });

  app.post("/connections/:toolkit/refresh", async (c) => {
    const connection = await refreshConnection(c.req.param("toolkit").toLowerCase());
    return connection ? c.json({ connection }) : c.json({ error: "Not connected" }, 404);
  });

  /** Where Composio sends the browser back after OAuth. */
  app.get("/connections/callback", async (c) => {
    const toolkit = (c.req.query("toolkit") ?? "").toLowerCase();
    if (toolkit) await refreshConnection(toolkit);
    return c.redirect(`${appUrl()}/app/settings/apps?connected=${encodeURIComponent(toolkit)}`);
  });

  app.delete("/connections/:toolkit", async (c) => ((await disconnect(c.req.param("toolkit").toLowerCase())) ? c.body(null, 204) : c.json({ error: "Not connected" }, 404)));

  return app;
}
