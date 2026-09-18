import { APP_CATALOG, mcpToolkit, type Bot } from "@krubot/shared";
import { listMcpServers } from "./data/mcp.ts";
import { getUser, isAdmin } from "./data/users.ts";

/*
 * The apps and MCP servers a person's bots may be given. An app is a
 * catalog toolkit: it only ever runs on its owner's own connection (see
 * composio.ts), so naming one they haven't connected does nothing. An MCP
 * server must be one of theirs. Checked when a bot is given them and again
 * every turn, so a server that changed hands or is gone never reaches it.
 */

export function ownerIsAdmin(userId: string): boolean {
  return isAdmin(getUser(userId));
}

export function allowedToolkits(userId: string, toolkits: string[]): string[] {
  const servers = new Set(listMcpServers(userId).map((s) => mcpToolkit(s.id)));
  const apps = new Set(APP_CATALOG.map((a) => a.toolkit));
  return toolkits.filter((t) => (t.startsWith("mcp:") ? servers.has(t) : apps.has(t)));
}

/** The bot as its owner may run it: its toolkits narrowed to what they may use. */
export function usableBot<T extends Pick<Bot, "toolkits" | "userId">>(bot: T): T {
  return { ...bot, toolkits: allowedToolkits(bot.userId, bot.toolkits) };
}
