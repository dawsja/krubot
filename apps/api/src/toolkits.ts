import { mcpToolkit, type Bot } from "@krubot/shared";
import { listMcpServers } from "./data/mcp.ts";
import { getUser, isAdmin } from "./data/users.ts";

/*
 * The apps and MCP servers a person's bots may be given. An app is a
 * Composio toolkit, any of the hundreds they support: it only ever runs on
 * its owner's own connection (see composio.ts), so naming one they haven't
 * connected does nothing. An MCP server must be one of theirs. Checked when
 * a bot is given them and again every turn, so a server that changed hands
 * or is gone never reaches it.
 */

/** A Composio toolkit slug, as their catalog spells them. */
const TOOLKIT_SLUG = /^[a-z0-9_-]{1,64}$/;

export function ownerIsAdmin(userId: string): boolean {
  return isAdmin(getUser(userId));
}

export function allowedToolkits(userId: string, toolkits: string[]): string[] {
  const servers = new Set(listMcpServers(userId).map((s) => mcpToolkit(s.id)));
  return toolkits.filter((t) => (t.startsWith("mcp:") ? servers.has(t) : TOOLKIT_SLUG.test(t)));
}

/** The bot as its owner may run it: its toolkits narrowed to what they may use. */
export function usableBot<T extends Pick<Bot, "toolkits" | "userId">>(bot: T): T {
  return { ...bot, toolkits: allowedToolkits(bot.userId, bot.toolkits) };
}
