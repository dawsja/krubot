import { ATTACHMENT_TYPES, MAX_ATTACHMENTS, MAX_ATTACHMENT_BYTES, type ChatAttachment } from "@krubot/shared";
import { Hono } from "hono";
import { ownThread, userId } from "../access.ts";
import type { Env } from "../app.ts";
import { getBot, listBots } from "../data/bots.ts";
import { attachmentOwner, createRoom, deleteRoom, getAttachment, listExchange, listMessages, listThreads, markThreadRead, postMessage, searchMessages, storeAttachment, updateRoom, clearThread } from "../data/threads.ts";
import { activeTurns, postFromPerson, stopAll, stopThread } from "../responder.ts";
import { workFor } from "../work.ts";

const MAX_BODY = 20_000;

/** Attachments that open in the browser's tab; everything else is a download. */
const INLINE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf", "text/plain", "text/csv", "application/json"]);

export function threadsRoutes() {
  const app = new Hono<Env>();

  app.get("/threads", (c) => {
    const busy = new Set([...activeTurns().values()].map((t) => t.threadId));
    return c.json({ threads: listThreads({ userId: userId(c) }).map((t) => ({ ...t, busy: busy.has(t.id) })) });
  });

  app.get("/threads/:id", (c) => {
    const thread = ownThread(c, c.req.param("id"));
    if (!thread) return c.json({ error: "No such conversation" }, 404);
    const bot = thread.botId ? getBot(thread.botId) : null;
    const turns = [...activeTurns().values()].filter((t) => t.threadId === thread.id);
    // Which messages those turns are answering: editing one of them stops its turn first, and only then.
    return c.json({ thread, bot, busy: turns.map((t) => t.botId), answering: turns.map((t) => t.messageId) });
  });

  // What the bots working here have done so far, step by step, behind their activity lines.
  app.get("/threads/:id/work", (c) => {
    const thread = ownThread(c, c.req.param("id"));
    if (!thread) return c.json({ error: "No such conversation" }, 404);
    return c.json({ work: workFor(thread.id) });
  });

  app.get("/threads/:id/messages", (c) => {
    const thread = ownThread(c, c.req.param("id"));
    if (!thread) return c.json({ error: "No such conversation" }, 404);
    const messages = listMessages(thread.id, { after: c.req.query("after") ?? null, before: c.req.query("before") ?? null, limit: Number(c.req.query("limit")) || 200, includeSent: true });
    return c.json({ messages });
  });

  // The bot-to-bot side conversation behind a "Messaged" or "Message from" line.
  app.get("/threads/:id/exchange", (c) => {
    const thread = ownThread(c, c.req.param("id"));
    const other = ownThread(c, c.req.query("with") ?? "");
    if (!thread || !other) return c.json({ error: "No such conversation" }, 404);
    return c.json({ thread, other, messages: listExchange(thread.id, other.id) });
  });

  app.post("/threads/:id/messages", async (c) => {
    const thread = ownThread(c, c.req.param("id"));
    if (!thread) return c.json({ error: "No such conversation" }, 404);
    let body = "";
    // "Send after": wait for the bot to finish instead of steering what it's doing.
    let after = false;
    const attachments: ChatAttachment[] = [];
    const type = c.req.header("content-type") ?? "";
    if (type.startsWith("multipart/form-data")) {
      const form = await c.req.formData();
      body = String(form.get("body") ?? "");
      after = form.get("after") === "1";
      const files = form.getAll("files").filter((f): f is File => f instanceof File);
      if (files.length > MAX_ATTACHMENTS) return c.json({ error: `At most ${MAX_ATTACHMENTS} files per message` }, 400);
      for (const file of files) {
        if (file.size > MAX_ATTACHMENT_BYTES) return c.json({ error: `${file.name} is larger than ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB` }, 400);
        const mediaType = (ATTACHMENT_TYPES as readonly string[]).includes(file.type) ? file.type : file.type.startsWith("text/") ? "text/plain" : "";
        if (!mediaType) return c.json({ error: `${file.name}: images, PDFs and text files only` }, 400);
        attachments.push(storeAttachment({ name: file.name.slice(0, 200), mediaType, data: new Uint8Array(await file.arrayBuffer()) }));
      }
    } else {
      const json = (await c.req.json().catch(() => ({}))) as { body?: string; after?: boolean };
      body = String(json.body ?? "");
      after = json.after === true;
    }
    body = body.trim();
    if (!body && attachments.length === 0) return c.json({ error: "Say something" }, 400);
    if (body.length > MAX_BODY) return c.json({ error: "That message is too long" }, 400);
    const message = await postFromPerson(thread, { body, attachments, after });
    return c.json({ message }, 201);
  });

  app.post("/threads/:id/read", (c) => {
    if (!ownThread(c, c.req.param("id"))) return c.json({ error: "No such conversation" }, 404);
    markThreadRead(c.req.param("id"));
    return c.json({ ok: true });
  });

  app.post("/threads/:id/interrupt", async (c) => {
    if (!ownThread(c, c.req.param("id"))) return c.json({ error: "No such conversation" }, 404);
    const { stopped, dropped } = await stopThread(c.req.param("id"));
    return c.json({ ok: true, stopped, dropped });
  });

  // Stop all: every bot of the person's, and everything they set going.
  app.post("/stop", async (c) => c.json({ ok: true, ...(await stopAll(userId(c))) }));

  app.delete("/threads/:id/messages", async (c) => {
    const thread = ownThread(c, c.req.param("id"));
    if (!thread) return c.json({ error: "No such conversation" }, 404);
    await stopThread(thread.id);
    clearThread(thread.id);
    return c.body(null, 204);
  });

  app.post("/rooms", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { name?: string; members?: string[] };
    const name = String(body.name ?? "").trim().slice(0, 80);
    const known = new Set(listBots({ includeHidden: true, userId: userId(c) }).map((b) => b.id));
    const members = (Array.isArray(body.members) ? body.members.map(String) : []).filter((id) => known.has(id));
    if (!name) return c.json({ error: "Give the room a name" }, 400);
    if (members.length === 0) return c.json({ error: "Add at least one bot" }, 400);
    const thread = createRoom(name, members, userId(c));
    postMessage({ threadId: thread.id, author: "system", kind: "event", body: `Room created with ${members.length} bot${members.length === 1 ? "" : "s"}. Mention a bot with @ to address it; with nobody named, the Chief of Staff answers.`, answered: true });
    return c.json({ thread }, 201);
  });

  app.patch("/rooms/:id", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { name?: string; members?: string[] };
    if (!ownThread(c, c.req.param("id"))) return c.json({ error: "No such room" }, 404);
    const known = new Set(listBots({ includeHidden: true, userId: userId(c) }).map((b) => b.id));
    const thread = updateRoom(c.req.param("id"), { name: body.name ? String(body.name).trim().slice(0, 80) : undefined, members: Array.isArray(body.members) ? body.members.map(String).filter((id) => known.has(id)) : undefined });
    return thread ? c.json({ thread }) : c.json({ error: "No such room" }, 404);
  });

  app.delete("/rooms/:id", async (c) => {
    if (!ownThread(c, c.req.param("id"))) return c.json({ error: "No such room" }, 404);
    await stopThread(c.req.param("id"));
    return deleteRoom(c.req.param("id")) ? c.body(null, 204) : c.json({ error: "No such room" }, 404);
  });

  app.get("/attachments/:id", (c) => {
    const file = attachmentOwner(c.req.param("id")) === userId(c) ? getAttachment(c.req.param("id")) : null;
    if (!file) return c.json({ error: "No such file" }, 404);
    // Only types that can't run script open in the tab; the rest (HTML, SVG, anything a bot made) download.
    const inline = c.req.query("download") === undefined && INLINE_TYPES.has(file.meta.mediaType);
    return new Response(Buffer.from(file.data), {
      headers: {
        "Content-Type": file.meta.mediaType || "application/octet-stream",
        "Content-Disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(file.meta.name)}`,
        "Content-Security-Policy": "sandbox",
        "Cache-Control": "private, max-age=3600",
        "X-Content-Type-Options": "nosniff",
      },
    });
  });

  app.get("/search", (c) => {
    const q = (c.req.query("q") ?? "").trim();
    if (q.length < 2) return c.json({ messages: [] });
    return c.json({ messages: searchMessages(q, userId(c)) });
  });

  return app;
}
