import { mcpToolkit, type Bot, type McpServer } from "@krubot/shared";
import { listMcpServers, mcpProxyToken } from "./data/mcp.ts";

/*
 * What the box gets for each of your MCP servers when it starts a bot's
 * session: the ones given to that bot (`mcp:<id>` in its toolkits). HTTP servers point at the API's proxy with their
 * proxy token; the real URL, headers and secrets stay here. Stdio servers
 * run on the box as given.
 */

export type BoxMcpServer = { name: string; type: "http"; url: string; headers: Record<string, string> } | { name: string; type: "stdio"; command: string; args: string[]; env: Record<string, string> };

/** Where the box reaches this API: KRU_API_INTERNAL_URL, `http://api:8790` in Compose. */
export function apiInternalUrl(): string {
  return (process.env.KRU_API_INTERNAL_URL ?? `http://127.0.0.1:${process.env.PORT || 8790}`).replace(/\/$/, "");
}

/** The enabled servers a bot was given. */
export function mcpServersFor(bot: Pick<Bot, "toolkits">): McpServer[] {
  return listMcpServers().filter((server) => server.enabled && bot.toolkits.includes(mcpToolkit(server.id)));
}

export function boxMcpServers(bot: Pick<Bot, "toolkits">): BoxMcpServer[] {
  return mcpServersFor(bot).map(toBoxServer);
}

function toBoxServer(server: McpServer): BoxMcpServer {
  if (server.transport === "http") {
    // The sign-in state rides along so a sign-in (or sign-out) changes the session's config and
    // relaunches it: a session started before the sign-in listed no tools and would keep none.
    return { name: server.name, type: "http", url: `${apiInternalUrl()}/api/mcp/${server.id}/mcp`, headers: { "X-Kru-Mcp-Token": mcpProxyToken(server.id) ?? "", "X-Kru-Mcp-Auth": server.authStatus } };
  }
  return { name: server.name, type: "stdio", command: server.command ?? "", args: server.args, env: server.env };
}
