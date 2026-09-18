import { routineInputSchema, routinePatchSchema } from "@krubot/shared";
import { Hono } from "hono";
import { ownBot, userId } from "../access.ts";
import type { Env } from "../app.ts";
import { listBots } from "../data/bots.ts";
import { createRoutine, deleteRoutine, getRoutine, listRoutineRuns, listRoutines, previewRuns, recordRoutineRun, routinePrompt, updateRoutine } from "../data/routines.ts";
import { getSettings } from "../data/settings.ts";
import { postMessage } from "../data/threads.ts";

function badCron(error: unknown) {
  return `That schedule isn't valid: ${error instanceof Error ? error.message : "bad cron"}`;
}

export function routinesRoutes() {
  const app = new Hono<Env>();

  app.get("/routines", (c) => {
    const wanted = c.req.query("bot") || undefined;
    if (wanted) return ownBot(c, wanted) ? c.json({ routines: listRoutines(wanted) }) : c.json({ error: "No such bot" }, 404);
    const mine = new Set(listBots({ includeHidden: true, userId: userId(c) }).map((b) => b.id));
    return c.json({ routines: listRoutines().filter((r) => mine.has(r.botId)) });
  });

  /** The routine, when its bot is the signed-in person's. */
  const ownRoutine = (c: Parameters<typeof ownBot>[0], id: string) => {
    const routine = getRoutine(id);
    return routine && ownBot(c, routine.botId) ? routine : null;
  };

  app.post("/routines/preview", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { cron?: string; timezone?: string };
    try {
      return c.json({ runs: previewRuns(String(body.cron ?? ""), String(body.timezone || getSettings().timezone), 5) });
    } catch (error) {
      return c.json({ error: badCron(error) }, 400);
    }
  });

  app.post("/bots/:id/routines", async (c) => {
    const bot = ownBot(c, c.req.param("id"));
    if (!bot) return c.json({ error: "No such bot" }, 404);
    const parsed = routineInputSchema.safeParse({ timezone: getSettings().timezone, ...((await c.req.json().catch(() => ({}))) as object) });
    if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? "Bad routine" }, 400);
    try {
      previewRuns(parsed.data.cron, parsed.data.timezone, 1);
    } catch (error) {
      return c.json({ error: badCron(error) }, 400);
    }
    return c.json({ routine: createRoutine(bot.id, parsed.data) }, 201);
  });

  app.patch("/routines/:id", async (c) => {
    const parsed = routinePatchSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? "Bad routine" }, 400);
    const current = ownRoutine(c, c.req.param("id"));
    if (!current) return c.json({ error: "No such routine" }, 404);
    try {
      previewRuns(parsed.data.cron ?? current.cron, parsed.data.timezone ?? current.timezone, 1);
    } catch (error) {
      return c.json({ error: badCron(error) }, 400);
    }
    return c.json({ routine: updateRoutine(current.id, parsed.data) });
  });

  app.delete("/routines/:id", (c) => (ownRoutine(c, c.req.param("id")) && deleteRoutine(c.req.param("id")) ? c.body(null, 204) : c.json({ error: "No such routine" }, 404)));

  app.get("/routines/:id/runs", (c) => (ownRoutine(c, c.req.param("id")) ? c.json({ runs: listRoutineRuns(c.req.param("id")) }) : c.json({ error: "No such routine" }, 404)));

  /** Runs a routine now, whatever its schedule. */
  app.post("/routines/:id/run", (c) => {
    const routine = ownRoutine(c, c.req.param("id"));
    if (!routine) return c.json({ error: "No such routine" }, 404);
    const bot = ownBot(c, routine.botId);
    if (!bot) return c.json({ error: "That routine's bot is gone" }, 404);
    const message = postMessage({ threadId: bot.threadId, author: "routine", body: routinePrompt(routine) });
    recordRoutineRun(routine.id, message.id);
    return c.json({ message }, 201);
  });

  return app;
}
