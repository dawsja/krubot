import { BOT_TEMPLATES, botInputSchema, botPatchSchema, mcpToolkit, pickBotName } from "@krubot/shared";
import { Hono } from "hono";
import { admin, ownBot, userId } from "../access.ts";
import type { Env } from "../app.ts";
import { boxConfig, deleteBotHome } from "../box.ts";
import { createBot, deleteBot, listBots, updateBot } from "../data/bots.ts";
import { listRules, removeRule } from "../data/approvals.ts";
import { listMcpServers } from "../data/mcp.ts";
import { listConnections } from "../data/settings.ts";
import { clearThread, postMessage } from "../data/threads.ts";
import { interrupt, syncSoul } from "../responder.ts";
import { addFromTemplate, greet, templateById } from "../templates.ts";

/**
 * The apps and MCP servers a person may give a bot: the admin's bots can
 * have any, everyone else's only the ones the admin shared. Anything else
 * asked for is dropped, quietly, as an unknown toolkit would be.
 */
function allowedToolkits(isAdmin: boolean, toolkits: string[]): string[] {
  if (isAdmin) return toolkits;
  const allowed = new Set<string>([...listConnections().filter((c) => c.shared).map((c) => c.toolkit), ...listMcpServers().filter((s) => s.shared).map((s) => mcpToolkit(s.id))]);
  return toolkits.filter((t) => allowed.has(t));
}

export function botsRoutes() {
  const app = new Hono<Env>();

  app.get("/bots", (c) => c.json({ bots: listBots({ includeHidden: c.req.query("hidden") === "1", userId: userId(c) }) }));

  app.get("/bots/name", (c) => c.json({ name: pickBotName(listBots({ includeHidden: true, userId: userId(c) }).map((b) => b.name)) }));

  app.get("/templates", (c) => c.json({ templates: BOT_TEMPLATES }));

  app.post("/bots", async (c) => {
    const parsed = botInputSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? "Bad bot" }, 400);
    const bot = createBot({ ...parsed.data, toolkits: allowedToolkits(admin(c), parsed.data.toolkits) }, userId(c));
    postMessage({ threadId: bot.threadId, author: "system", kind: "event", body: `${bot.name} joined${bot.title ? ` as ${bot.title}` : ""}.`, answered: true });
    await syncSoul(bot);
    greet(bot);
    return c.json({ bot }, 201);
  });

  app.post("/bots/from-template", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { templateId?: string; toolkits?: string[]; enableRoutine?: boolean };
    const template = templateById(String(body.templateId ?? ""));
    if (!template) return c.json({ error: "No such template" }, 404);
    const bot = await addFromTemplate(template, userId(c), { toolkits: allowedToolkits(admin(c), Array.isArray(body.toolkits) ? body.toolkits.map(String) : template.toolkits), enableRoutine: body.enableRoutine === true });
    return c.json({ bot }, 201);
  });

  app.get("/bots/:id", (c) => {
    const bot = ownBot(c, c.req.param("id"));
    return bot ? c.json({ bot, rules: listRules(bot.id) }) : c.json({ error: "No such bot" }, 404);
  });

  app.patch("/bots/:id", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const parsed = botPatchSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? "Bad bot" }, 400);
    const extra: { hidden?: boolean; pinned?: boolean; position?: number } = {};
    if (typeof body.hidden === "boolean") extra.hidden = body.hidden;
    if (typeof body.pinned === "boolean") extra.pinned = body.pinned;
    if (typeof body.position === "number") extra.position = body.position;
    if (!ownBot(c, c.req.param("id"))) return c.json({ error: "No such bot" }, 404);
    const toolkits = parsed.data.toolkits !== undefined ? { toolkits: allowedToolkits(admin(c), parsed.data.toolkits) } : {};
    const bot = updateBot(c.req.param("id"), { ...parsed.data, ...toolkits, ...extra });
    if (!bot) return c.json({ error: "No such bot" }, 404);
    await syncSoul(bot);
    return c.json({ bot });
  });

  app.post("/bots/:id/duplicate", async (c) => {
    const source = ownBot(c, c.req.param("id"));
    if (!source) return c.json({ error: "No such bot" }, 404);
    const taken = new Set(listBots({ includeHidden: true, userId: userId(c) }).map((b) => b.name.toLowerCase()));
    let name = `${source.name} copy`;
    for (let i = 2; taken.has(name.toLowerCase()); i += 1) name = `${source.name} copy ${i}`;
    const bot = createBot(botInputSchema.parse({ ...source, name }), userId(c));
    await syncSoul(bot);
    return c.json({ bot }, 201);
  });

  app.delete("/bots/:id", async (c) => {
    const bot = ownBot(c, c.req.param("id"));
    if (!bot) return c.json({ error: "No such bot" }, 404);
    await interrupt(bot.threadId);
    deleteBot(bot.id);
    const box = boxConfig();
    if (box && c.req.query("keepFiles") !== "1") await deleteBotHome(box, bot.id).catch(() => undefined);
    return c.body(null, 204);
  });

  app.delete("/bots/:id/messages", async (c) => {
    const bot = ownBot(c, c.req.param("id"));
    if (!bot) return c.json({ error: "No such bot" }, 404);
    await interrupt(bot.threadId);
    clearThread(bot.threadId);
    return c.body(null, 204);
  });

  app.get("/bots/:id/rules", (c) => (ownBot(c, c.req.param("id")) ? c.json({ rules: listRules(c.req.param("id")) }) : c.json({ error: "No such bot" }, 404)));
  app.delete("/bots/:id/rules", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { rule?: string };
    if (!body.rule) return c.json({ error: "Missing rule" }, 400);
    if (!ownBot(c, c.req.param("id"))) return c.json({ error: "No such bot" }, 404);
    removeRule(c.req.param("id"), body.rule);
    return c.body(null, 204);
  });

  return app;
}
