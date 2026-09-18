import { APP_CATALOG, BOT_TEMPLATES, EFFORT_LEVELS, ENGINE_ACCESS, ENGINES, MODEL_ID_PATTERN, type EffortLevel, type Engine, type EngineAccess, type EngineSettings } from "@krubot/shared";
import { Hono } from "hono";
import { admin, userId } from "../access.ts";
import type { Env } from "../app.ts";
import { availableToolkits } from "../composio.ts";
import { getSettings, updateSettings } from "../data/settings.ts";
import { boxStatus, forgetClaudeCheck } from "../status.ts";
import { addFromTemplate, templateById } from "../templates.ts";

export function settingsRoutes() {
  const app = new Hono<Env>();

  app.get("/settings", (c) => {
    const settings = getSettings();
    // A user never sees onboarding (it is the admin's) and needs only the time zone and the engine's name.
    return c.json({ settings: admin(c) ? settings : { ...settings, onboarding: { done: true, apps: [], templates: [] } } });
  });

  app.patch("/settings", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { timezone?: string; concurrency?: number; engine?: string; engines?: Record<string, unknown>; effort?: string | null };
    const patch: Parameters<typeof updateSettings>[0] = {};
    if (body.engine !== undefined) {
      if (!(ENGINES as readonly string[]).includes(String(body.engine))) return c.json({ error: "The engine is claude, codex or grok" }, 400);
      patch.engine = body.engine as Engine;
    }
    if (body.engines !== undefined) {
      if (!body.engines || typeof body.engines !== "object") return c.json({ error: "Bad engines" }, 400);
      const current = getSettings().engines;
      const engines: Partial<Record<Engine, EngineSettings>> = {};
      for (const [name, value] of Object.entries(body.engines)) {
        if (!(ENGINES as readonly string[]).includes(name)) return c.json({ error: `No engine called ${name}` }, 400);
        const given = (value ?? {}) as { access?: unknown; model?: unknown };
        const next = { ...current[name as Engine] };
        if (given.access !== undefined) {
          if (!(ENGINE_ACCESS as readonly string[]).includes(String(given.access))) return c.json({ error: "Access is plan or api" }, 400);
          next.access = given.access as EngineAccess;
        }
        if (given.model !== undefined) {
          const model = String(given.model).trim();
          if (!MODEL_ID_PATTERN.test(model)) return c.json({ error: "A model id is letters, digits and . _ : / -, up to 120 characters" }, 400);
          next.model = model;
        }
        engines[name as Engine] = next;
      }
      patch.engines = engines as Record<Engine, EngineSettings>;
    }
    if (body.effort === null) patch.effort = null;
    else if (typeof body.effort === "string") {
      if (!(EFFORT_LEVELS as readonly string[]).includes(body.effort)) return c.json({ error: "Effort is low, medium or high" }, 400);
      patch.effort = body.effort as EffortLevel;
    }
    if (typeof body.timezone === "string" && body.timezone.length <= 64) patch.timezone = body.timezone;
    if (typeof body.concurrency === "number") patch.concurrency = Math.min(Math.max(Math.floor(body.concurrency), 1), 10);
    return c.json({ settings: updateSettings(patch) });
  });

  app.get("/status", async (c) => {
    if (c.req.query("fresh") === "1") forgetClaudeCheck();
    return c.json({ status: await boxStatus(userId(c), c.req.query("fresh") === "1") });
  });

  app.get("/catalog", async (c) => c.json({ apps: await availableToolkits(userId(c)), all: APP_CATALOG }));

  /**
   * Finishes onboarding in one call: remembers the apps and the picked
   * teammates, creates the teammates, and marks the tour done. It runs once
   * per install.
   */
  app.post("/onboarding/complete", async (c) => {
    if (getSettings().onboarding.done) return c.json({ error: "Setup is already done" }, 409);
    const body = (await c.req.json().catch(() => ({}))) as { apps?: string[]; templates?: string[]; timezone?: string };
    const apps = Array.isArray(body.apps) ? body.apps.map(String).filter((a) => APP_CATALOG.some((e) => e.toolkit === a)) : [];
    const templates = Array.isArray(body.templates) ? body.templates.map(String).filter((t) => BOT_TEMPLATES.some((e) => e.id === t)) : [];
    const created = [];
    for (const id of templates) {
      const template = templateById(id);
      if (!template) continue;
      // Give each teammate only the apps the person actually uses.
      const toolkits = template.toolkits.filter((t) => apps.includes(t));
      created.push(await addFromTemplate(template, userId(c), { toolkits: toolkits.length ? toolkits : [] }));
    }
    const settings = updateSettings({
      ...(typeof body.timezone === "string" ? { timezone: body.timezone.slice(0, 64) } : {}),
      onboarding: { done: true, apps, templates },
    });
    return c.json({ settings, bots: created });
  });

  return app;
}
