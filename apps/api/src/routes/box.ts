import { CLI_ENGINES, type CliEngine } from "@krubot/shared";
import { Hono, type Context } from "hono";
import type { Env } from "../app.ts";
import {
  BoxError,
  boxConfig,
  cancelEngineSignIn,
  closeTerminal,
  connectDesktop,
  createTerminal,
  deleteBoxFile,
  desktopInput,
  desktopStatus,
  disconnectDesktop,
  engineSignIn,
  engineSignInCode,
  openBoxStream,
  readBoxFile,
  startDesktop,
  startEngineSignIn,
  stopDesktop,
  terminalInput,
  terminalResize,
  writeBoxFile,
  type BoxConfig,
} from "../box.ts";
import { ownBot, userId } from "../access.ts";
import { botHome } from "../memory.ts";
import { watchEngineSignIn } from "../status.ts";
import { isUpdating, startReset, startUpdate, updateReport } from "../updater.ts";

/*
 * The person's own use of the computer, inside their own account on it:
 * terminals, their desktop, and the files in their bots' homes (SOUL.md,
 * MEMORY.md and notes). Everything here answers for the signed-in person
 * and their own things; Update and Reset are the admin's (app.ts). The
 * box's event streams pass through unchanged.
 */

const STREAM_ID = /^[a-f0-9]{16}$/;

/** The box for the signed-in person: their account there. */
function requireBox(c: Context<Env>): BoxConfig | Response {
  try {
    const config = boxConfig(userId(c));
    if (config) return config;
  } catch (error) {
    return c.json({ error: (error as Error).message }, 503);
  }
  return c.json({ error: "No box is configured. Set KRU_BOX_URL." }, 404);
}

function boxErrorResponse(c: Context<Env>, error: unknown) {
  if (error instanceof BoxError) return c.json({ error: error.message }, (error.status || 503) as 503);
  return c.json({ error: error instanceof Error ? error.message : "Box request failed" }, 502);
}

async function proxyStream(c: Context<Env>, box: BoxConfig, route: string) {
  try {
    const upstream = await openBoxStream(box, route, c.req.raw.signal);
    return new Response(upstream.body, {
      status: 200,
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no" },
    });
  } catch (error) {
    return boxErrorResponse(c, error);
  }
}

/** A path inside a bot's home, from the browser's relative one. */
function botFilePath(botId: string, relative: string): string | null {
  const clean = relative.replace(/^\/+/, "");
  if (!clean || clean.split("/").some((part) => part === "..")) return null;
  return `${botHome(botId)}/${clean}`;
}

export function boxRoutes() {
  const app = new Hono<Env>();

  // ---------- updating the computer ----------

  app.get("/box/update", (c) => c.json(updateReport()));

  app.post("/box/update", async (c) => {
    const box = requireBox(c);
    if (box instanceof Response) return box;
    if (isUpdating()) return c.json({ error: "An update is already running" }, 409);
    const body = (await c.req.json().catch(() => ({}))) as { pull?: boolean };
    return c.json({ ...updateReport(), update: startUpdate({ pull: body.pull !== false }) });
  });

  app.post("/box/reset", (c) => {
    const box = requireBox(c);
    if (box instanceof Response) return box;
    if (isUpdating()) return c.json({ error: "An update is already running" }, 409);
    return c.json({ ...updateReport(), update: startReset() });
  });

  // ---------- terminals ----------

  app.post("/box/terminals", async (c) => {
    const box = requireBox(c);
    if (box instanceof Response) return box;
    const body = (await c.req.json().catch(() => ({}))) as { bot?: string; cols?: number; rows?: number };
    if (body.bot && !ownBot(c, body.bot)) return c.json({ error: "No such bot" }, 404);
    try {
      return c.json({ terminal: await createTerminal(box, { bot: body.bot ?? null, cols: Number(body.cols) || 80, rows: Number(body.rows) || 24 }) });
    } catch (error) {
      return boxErrorResponse(c, error);
    }
  });

  app.get("/box/terminals/:id/stream", (c) => {
    const id = c.req.param("id");
    if (!STREAM_ID.test(id)) return c.json({ error: "Bad terminal id" }, 400);
    const box = requireBox(c);
    if (box instanceof Response) return box;
    return proxyStream(c, box, `/terminals/${id}/stream`);
  });

  app.post("/box/terminals/:id/input", async (c) => {
    const id = c.req.param("id");
    if (!STREAM_ID.test(id)) return c.json({ error: "Bad terminal id" }, 400);
    const box = requireBox(c);
    if (box instanceof Response) return box;
    const body = (await c.req.json().catch(() => ({}))) as { data?: string };
    if (typeof body.data !== "string") return c.json({ error: "Missing data" }, 400);
    try {
      await terminalInput(box, id, body.data);
      return c.json({ ok: true });
    } catch (error) {
      return boxErrorResponse(c, error);
    }
  });

  app.post("/box/terminals/:id/resize", async (c) => {
    const id = c.req.param("id");
    if (!STREAM_ID.test(id)) return c.json({ error: "Bad terminal id" }, 400);
    const box = requireBox(c);
    if (box instanceof Response) return box;
    const body = (await c.req.json().catch(() => ({}))) as { cols?: number; rows?: number };
    try {
      await terminalResize(box, id, { cols: Number(body.cols) || 80, rows: Number(body.rows) || 24 });
      return c.json({ ok: true });
    } catch (error) {
      return boxErrorResponse(c, error);
    }
  });

  app.delete("/box/terminals/:id", async (c) => {
    const id = c.req.param("id");
    if (!STREAM_ID.test(id)) return c.json({ error: "Bad terminal id" }, 400);
    const box = requireBox(c);
    if (box instanceof Response) return box;
    try {
      await closeTerminal(box, id);
      return c.body(null, 204);
    } catch (error) {
      return boxErrorResponse(c, error);
    }
  });

  // ---------- signing a CLI in, without a terminal ----------

  /*
   * The computer runs the CLI's own login for the signed-in person and
   * says what they need to finish it in a browser: a link, and a code to
   * enter or to paste back. The sign-in lands in their own account on the
   * computer; nothing about it comes through here.
   */

  /** The engine in the path, when it is a CLI: calling an API directly has nothing to sign in to. */
  function engineParam(c: Context<Env>): CliEngine | null {
    const engine = c.req.param("engine") ?? "";
    return (CLI_ENGINES as readonly string[]).includes(engine) ? (engine as CliEngine) : null;
  }

  app.get("/box/engines/:engine/sign-in", async (c) => {
    const engine = engineParam(c);
    if (!engine) return c.json({ error: "No such engine" }, 404);
    const box = requireBox(c);
    if (box instanceof Response) return box;
    try {
      return c.json(await engineSignIn(box, engine));
    } catch (error) {
      return boxErrorResponse(c, error);
    }
  });

  app.post("/box/engines/:engine/sign-in", async (c) => {
    const engine = engineParam(c);
    if (!engine) return c.json({ error: "No such engine" }, 404);
    const box = requireBox(c);
    if (box instanceof Response) return box;
    try {
      const started = await startEngineSignIn(box, engine);
      // Followed here too, so the app catches up even if the person closed the sheet.
      watchEngineSignIn(box, userId(c), engine);
      return c.json(started);
    } catch (error) {
      return boxErrorResponse(c, error);
    }
  });

  app.post("/box/engines/:engine/sign-in/code", async (c) => {
    const engine = engineParam(c);
    if (!engine) return c.json({ error: "No such engine" }, 404);
    const box = requireBox(c);
    if (box instanceof Response) return box;
    const body = (await c.req.json().catch(() => ({}))) as { code?: unknown };
    const code = typeof body.code === "string" ? body.code.trim() : "";
    if (!/^[\x21-\x7e]{4,512}$/.test(code)) return c.json({ error: "That doesn't look like the code from the sign-in page" }, 400);
    try {
      return c.json(await engineSignInCode(box, engine, code));
    } catch (error) {
      return boxErrorResponse(c, error);
    }
  });

  app.delete("/box/engines/:engine/sign-in", async (c) => {
    const engine = engineParam(c);
    if (!engine) return c.json({ error: "No such engine" }, 404);
    const box = requireBox(c);
    if (box instanceof Response) return box;
    try {
      await cancelEngineSignIn(box, engine);
      return c.body(null, 204);
    } catch (error) {
      return boxErrorResponse(c, error);
    }
  });

  // ---------- desktop ----------


  app.get("/box/desktop", async (c) => {
    const box = requireBox(c);
    if (box instanceof Response) return box;
    try {
      return c.json({ desktop: await desktopStatus(box) });
    } catch (error) {
      return boxErrorResponse(c, error);
    }
  });

  app.post("/box/desktop", async (c) => {
    const box = requireBox(c);
    if (box instanceof Response) return box;
    const body = (await c.req.json().catch(() => ({}))) as { width?: number; height?: number };
    try {
      return c.json({ desktop: await startDesktop(box, { width: Number(body.width) || 1280, height: Number(body.height) || 800 }) });
    } catch (error) {
      return boxErrorResponse(c, error);
    }
  });

  app.delete("/box/desktop", async (c) => {
    const box = requireBox(c);
    if (box instanceof Response) return box;
    try {
      await stopDesktop(box);
      return c.body(null, 204);
    } catch (error) {
      return boxErrorResponse(c, error);
    }
  });

  app.post("/box/desktop/connections", async (c) => {
    const box = requireBox(c);
    if (box instanceof Response) return box;
    const body = (await c.req.json().catch(() => ({}))) as { width?: number; height?: number };
    try {
      return c.json({ connection: await connectDesktop(box, { width: Number(body.width) || 1280, height: Number(body.height) || 800 }) });
    } catch (error) {
      return boxErrorResponse(c, error);
    }
  });

  app.get("/box/desktop/connections/:id/stream", (c) => {
    const id = c.req.param("id");
    if (!STREAM_ID.test(id)) return c.json({ error: "Bad connection id" }, 400);
    const box = requireBox(c);
    if (box instanceof Response) return box;
    return proxyStream(c, box, `/desktop/connections/${id}/stream`);
  });

  app.post("/box/desktop/connections/:id/input", async (c) => {
    const id = c.req.param("id");
    if (!STREAM_ID.test(id)) return c.json({ error: "Bad connection id" }, 400);
    const box = requireBox(c);
    if (box instanceof Response) return box;
    const body = (await c.req.json().catch(() => ({}))) as { data?: string };
    if (typeof body.data !== "string") return c.json({ error: "Missing data" }, 400);
    try {
      await desktopInput(box, id, body.data);
      return c.json({ ok: true });
    } catch (error) {
      return boxErrorResponse(c, error);
    }
  });

  app.delete("/box/desktop/connections/:id", async (c) => {
    const id = c.req.param("id");
    if (!STREAM_ID.test(id)) return c.json({ error: "Bad connection id" }, 400);
    const box = requireBox(c);
    if (box instanceof Response) return box;
    try {
      await disconnectDesktop(box, id);
      return c.body(null, 204);
    } catch (error) {
      return boxErrorResponse(c, error);
    }
  });

  // ---------- a bot's files ----------

  app.get("/bots/:id/files", async (c) => {
    const bot = ownBot(c, c.req.param("id"));
    if (!bot) return c.json({ error: "No such bot" }, 404);
    const box = requireBox(c);
    if (box instanceof Response) return box;
    const target = botFilePath(bot.id, c.req.query("path") ?? ".");
    if (!target) return c.json({ error: "Bad path" }, 400);
    try {
      return c.json({ file: await readBoxFile(box, target) });
    } catch (error) {
      return boxErrorResponse(c, error);
    }
  });

  app.put("/bots/:id/files", async (c) => {
    const bot = ownBot(c, c.req.param("id"));
    if (!bot) return c.json({ error: "No such bot" }, 404);
    const box = requireBox(c);
    if (box instanceof Response) return box;
    const body = (await c.req.json().catch(() => ({}))) as { path?: string; content?: string };
    const target = botFilePath(bot.id, String(body.path ?? ""));
    if (!target || typeof body.content !== "string") return c.json({ error: "Bad path or content" }, 400);
    try {
      await writeBoxFile(box, target, body.content);
      return c.json({ ok: true });
    } catch (error) {
      return boxErrorResponse(c, error);
    }
  });

  app.delete("/bots/:id/files", async (c) => {
    const bot = ownBot(c, c.req.param("id"));
    if (!bot) return c.json({ error: "No such bot" }, 404);
    const box = requireBox(c);
    if (box instanceof Response) return box;
    const target = botFilePath(bot.id, c.req.query("path") ?? "");
    if (!target || target === botHome(bot.id) + "/") return c.json({ error: "Bad path" }, 400);
    try {
      await deleteBoxFile(box, target);
      return c.body(null, 204);
    } catch (error) {
      return boxErrorResponse(c, error);
    }
  });

  return app;
}
