import { Hono } from "hono";
import { userId } from "../access.ts";
import type { Env } from "../app.ts";
import { countSubscriptions, removeSubscription, saveSubscription } from "../data/push.ts";
import { sendPush, vapidKeys } from "../push.ts";

export function pushRoutes() {
  const app = new Hono<Env>();

  app.get("/push", (c) => c.json({ publicKey: vapidKeys().publicKey, subscriptions: countSubscriptions(userId(c)) }));

  app.post("/push/subscriptions", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
    if (!body.endpoint || !body.keys?.p256dh || !body.keys.auth) return c.json({ error: "Not a push subscription" }, 400);
    saveSubscription({ endpoint: body.endpoint, keys: { p256dh: body.keys.p256dh, auth: body.keys.auth } }, userId(c), c.req.header("user-agent") ?? "");
    return c.json({ ok: true, subscriptions: countSubscriptions(userId(c)) }, 201);
  });

  app.delete("/push/subscriptions", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { endpoint?: string };
    if (!body.endpoint) return c.json({ error: "Which subscription?" }, 400);
    removeSubscription(body.endpoint, userId(c));
    return c.json({ ok: true, subscriptions: countSubscriptions(userId(c)) });
  });

  /** A test notification to every browser you subscribed. */
  app.post("/push/test", async (c) => {
    const sent = await sendPush({ title: "Kru Bot", body: "Notifications are on. You'll hear when a bot finishes or needs you.", url: "/app", tag: "test", threadId: "" }, userId(c));
    return c.json({ sent });
  });

  return app;
}
