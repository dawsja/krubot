import { Hono } from "hono";
import { ownThread, userId } from "../access.ts";
import { applyComposioKey } from "../composio.ts";
import type { Env } from "../app.ts";
import { getSecretRequest, resolveSecretRequest, setSecret } from "../data/secrets.ts";
import { answerSecretRequest } from "../secret-requests.ts";

/*
 * Secrets never come back out, and there is nowhere to browse or delete
 * them: a value only ever goes in, in answer to the bot that asked for it,
 * and only the API reads it again, at the moment it is used. To change a
 * key, ask the bot that uses it for a new one; its card comes back and the
 * new value replaces the old.
 */

export function secretsRoutes() {
  const app = new Hono<Env>();

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
      if (request.target === "composio") applyComposioKey(userId(c), String(body.value ?? ""));
      else setSecret(userId(c), request.name, String(body.value ?? ""), request.botId);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "Could not save" }, 400);
    }
    return c.json({ request: answerSecretRequest(request.id, "given") ?? resolveSecretRequest(request.id, "given") });
  });

  return app;
}
