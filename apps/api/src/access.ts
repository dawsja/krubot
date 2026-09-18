import type { Context, Next } from "hono";
import type { Env } from "./app.ts";
import { getBot } from "./data/bots.ts";
import { getThread } from "./data/threads.ts";
import { isAdmin } from "./data/users.ts";

/*
 * Who may do what. The admin (the first account) owns the server-wide
 * settings; everyone owns only their own bots and conversations, the admin
 * included. Routes answer 404 for someone else's bot or conversation, the
 * same as for one that doesn't exist, so ids can't be probed.
 */

export function userId(c: Context<Env>): string {
  return c.get("session").user.id;
}

export function admin(c: Context<Env>): boolean {
  return isAdmin(c.get("session").user);
}

/** Middleware: the admin only. */
export async function requireAdmin(c: Context<Env>, next: Next) {
  if (!admin(c)) return c.json({ error: "Only the admin can do that" }, 403);
  await next();
}

/** The bot, when it is the signed-in person's. */
export function ownBot(c: Context<Env>, id: string) {
  const bot = getBot(id);
  return bot && bot.userId === userId(c) ? bot : null;
}

/** The conversation, when it is the signed-in person's. */
export function ownThread(c: Context<Env>, id: string) {
  const thread = getThread(id);
  return thread && thread.userId === userId(c) ? thread : null;
}
