import { USAGE_RANGES } from "@krubot/shared";
import { Hono } from "hono";
import { userId } from "../access.ts";
import type { Env } from "../app.ts";
import { getSettings } from "../data/settings.ts";
import { usageSummary } from "../data/usage.ts";

/** What the signed-in person's bots used, over 7, 30 or 90 days. Nobody else's. */
export function usageRoutes() {
  const app = new Hono<Env>();
  app.get("/usage", (c) => {
    const days = Number(c.req.query("days") ?? 30);
    if (!(USAGE_RANGES as readonly number[]).includes(days)) return c.json({ error: `days must be one of ${USAGE_RANGES.join(", ")}` }, 400);
    return c.json(usageSummary(userId(c), days, getSettings().timezone));
  });
  return app;
}
