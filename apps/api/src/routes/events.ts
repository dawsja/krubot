import { Hono } from "hono";
import { userId } from "../access.ts";
import type { Env } from "../app.ts";
import { threadOwner } from "../data/threads.ts";
import { subscribe } from "../events.ts";

const KEEPALIVE_MS = 25_000;
const RETRY_MS = 3_000;

/**
 * What changed, as server-sent events. The sidebar, the open conversation
 * and the approvals badge fetch again when they hear one; activity events
 * carry the bot's current line. Anything about a conversation or a person
 * goes only to the person it belongs to; the rest is a bare "fetch again".
 */
export function eventsRoutes() {
  const app = new Hono<Env>();
  app.get("/events", (c) => {
    const me = userId(c);
    const encoder = new TextEncoder();
    let cleanup = () => {};
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const send = (text: string) => {
          try {
            controller.enqueue(encoder.encode(text));
          } catch {
            cleanup();
          }
        };
        send(`retry: ${RETRY_MS}\n: connected\n\n`);
        const unsubscribe = subscribe((event) => {
          if ("userId" in event && event.userId !== me) return;
          if ("threadId" in event && event.threadId && threadOwner(event.threadId) !== me) return;
          send(`data: ${JSON.stringify(event)}\n\n`);
        });
        const keepalive = setInterval(() => send(": ping\n\n"), KEEPALIVE_MS);
        cleanup = () => {
          clearInterval(keepalive);
          unsubscribe();
          try {
            controller.close();
          } catch {
            /* closed */
          }
        };
        c.req.raw.signal.addEventListener("abort", () => cleanup(), { once: true });
      },
      cancel() {
        cleanup();
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" },
    });
  });
  return app;
}
