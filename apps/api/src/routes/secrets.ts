import { SECRET_NAME } from "@krubot/shared";
import { Hono } from "hono";
import { ownThread } from "../access.ts";
import type { Env } from "../app.ts";
import { deleteSecret, getSecretRequest, listSecrets, resolveSecretRequest, setSecret } from "../data/secrets.ts";
import { answerSecretRequest } from "../secret-requests.ts";

/*
 * Secrets: names in, names out, never a value out. A bot's request is
 * answered here too: the value goes straight into the store and the bot
 * only hears that it's there.
 */

export function secretsRoutes() {
  const app = new Hono<Env>();

  app.get("/secrets", (c) => c.json({ secrets: listSecrets() }));

  app.put("/secrets/:name", async (c) => {
    const name = c.req.param("name");
    if (!SECRET_NAME.test(name)) return c.json({ error: "A secret's name is letters, digits and underscores, like OPENAI_API_KEY" }, 400);
    const body = (await c.req.json().catch(() => ({}))) as { value?: string };
    try {
      setSecret(name, String(body.value ?? ""));
      return c.json({ ok: true });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "Could not save" }, 400);
    }
  });

  app.delete("/secrets/:name", (c) => (deleteSecret(c.req.param("name")) ? c.body(null, 204) : c.json({ error: "No such secret" }, 404)));

  app.get("/secret-requests/:id", (c) => {
    const request = getSecretRequest(c.req.param("id"));
    return request && ownThread(c, request.threadId) ? c.json({ request }) : c.json({ error: "No such request" }, 404);
  });

  /** Give the value (stored, never echoed) or decline. */
  app.post("/secret-requests/:id", async (c) => {
    const request = getSecretRequest(c.req.param("id"));
    if (!request || !ownThread(c, request.threadId)) return c.json({ error: "No such request" }, 404);
    if (request.status !== "pending") return c.json({ request });
    const body = (await c.req.json().catch(() => ({}))) as { value?: string; decline?: boolean };
    if (body.decline) return c.json({ request: answerSecretRequest(request.id, "declined") });
    try {
      setSecret(request.name, String(body.value ?? ""), request.botId);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "Could not save" }, 400);
    }
    return c.json({ request: answerSecretRequest(request.id, "given") ?? resolveSecretRequest(request.id, "given") });
  });

  return app;
}
