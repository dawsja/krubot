import { BOT_TEMPLATES, CATALOG_PAGE_SIZE, ENGINE_ACCESS, ENGINES, MODEL_ID_PATTERN, PROVIDER_KINDS, type CatalogPage, type Engine, type EngineAccess, type EngineSettings, type ProviderKind } from "@krubot/shared";
import { Hono } from "hono";
import { admin, userId } from "../access.ts";
import type { Env } from "../app.ts";
import { pageOf, searchIndex } from "../catalog.ts";
import { catalogEntry, catalogIndex } from "../composio.ts";
import { getAi, updateAi } from "../data/ai.ts";
import { getSettings, updateSettings } from "../data/settings.ts";
import { boxStatus, forgetClaudeCheck } from "../status.ts";
import { addFromTemplate, templateById } from "../templates.ts";

export function settingsRoutes() {
  const app = new Hono<Env>();

  app.get("/settings", (c) => {
    const settings = getSettings();
    // A user never sees onboarding (it is the admin's) and needs only the time zone.
    return c.json({ settings: admin(c) ? settings : { ...settings, onboarding: { done: true, apps: [], templates: [] } } });
  });

  app.patch("/settings", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { timezone?: string };
    const patch: Parameters<typeof updateSettings>[0] = {};
    if (typeof body.timezone === "string" && body.timezone.length <= 64) patch.timezone = body.timezone;
    return c.json({ settings: updateSettings(patch) });
  });

  // Settings → AI, each person's own: their engine, and its access and model.
  app.get("/ai", (c) => c.json({ ai: getAi(userId(c)) }));

  app.patch("/ai", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { engine?: string; enabled?: unknown; engines?: Record<string, unknown> };
    const patch: Parameters<typeof updateAi>[1] = {};
    if (body.engine !== undefined) {
      if (!(ENGINES as readonly string[]).includes(String(body.engine))) return c.json({ error: "The engine is claude, codex or grok" }, 400);
      patch.engine = body.engine as Engine;
    }
    if (body.enabled !== undefined) {
      if (!Array.isArray(body.enabled) || !body.enabled.length) return c.json({ error: "Turn on at least one engine" }, 400);
      const enabled = body.enabled.map(String);
      if (enabled.some((engine) => !(ENGINES as readonly string[]).includes(engine))) return c.json({ error: "The engines are claude, codex, grok and api" }, 400);
      patch.enabled = enabled as Engine[];
    }
    if (body.engines !== undefined) {
      if (!body.engines || typeof body.engines !== "object") return c.json({ error: "Bad engines" }, 400);
      const current = getAi(userId(c)).engines;
      const engines: Partial<Record<Engine, EngineSettings>> = {};
      for (const [name, value] of Object.entries(body.engines)) {
        if (!(ENGINES as readonly string[]).includes(name)) return c.json({ error: `No engine called ${name}` }, 400);
        const given = (value ?? {}) as { access?: unknown; model?: unknown; provider?: unknown };
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
        if (given.provider !== undefined) {
          if (given.provider !== null && !(PROVIDER_KINDS as readonly string[]).includes(String(given.provider))) return c.json({ error: "No such API" }, 400);
          next.provider = given.provider === null ? null : (String(given.provider) as ProviderKind);
        }
        engines[name as Engine] = next;
      }
      patch.engines = engines;
    }
    return c.json({ ai: updateAi(userId(c), patch) });
  });

  // The computer as this person sees it: their own sign-ins; the admin also gets every live session.
  app.get("/status", async (c) => {
    if (c.req.query("fresh") === "1") forgetClaudeCheck(userId(c));
    return c.json({ status: await boxStatus(userId(c), { fresh: c.req.query("fresh") === "1", admin: admin(c) }) });
  });

  /**
   * The marketplace: every app Composio can connect for this person, a page
   * at a time. `q` searches the indexed catalog (forgivingly, see
   * catalog.ts), `page` and `per` say which slice, so a list of hundreds
   * never crosses the wire whole.
   */
  app.get("/catalog", async (c) => {
    const index = await catalogIndex(userId(c));
    const query = (c.req.query("q") ?? "").trim().slice(0, 64);
    const found = searchIndex(index, query);
    const per = Math.min(Math.max(Number(c.req.query("per")) || CATALOG_PAGE_SIZE, 1), 100);
    const slice = pageOf(found, Number(c.req.query("page")) || 1, per);
    return c.json({ apps: slice.items, total: slice.total, page: slice.page, pages: slice.pages } satisfies CatalogPage);
  });

  /** One app, for a card that knows only its toolkit. */
  app.get("/catalog/:toolkit", async (c) => {
    const entry = await catalogEntry(userId(c), c.req.param("toolkit"));
    return entry ? c.json({ app: entry }) : c.json({ error: "No such app" }, 404);
  });

  /**
   * Finishes onboarding in one call: remembers the apps and the picked
   * teammates, creates the teammates, and marks the tour done. It runs once
   * per install.
   */
  app.post("/onboarding/complete", async (c) => {
    if (getSettings().onboarding.done) return c.json({ error: "Setup is already done" }, 409);
    const body = (await c.req.json().catch(() => ({}))) as { apps?: string[]; templates?: string[]; timezone?: string };
    // Any toolkit Composio offers, not only the familiar few the step shows.
    const apps = Array.isArray(body.apps) ? body.apps.map((a) => String(a).toLowerCase()).filter((a) => /^[a-z0-9_-]{1,64}$/.test(a)).slice(0, 50) : [];
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
