import { APP_CATALOG, BOT_COLORS, BOT_EXPRESSIONS, MAX_ATTACHMENT_BYTES, botInputSchema, composioCard, handleOf, mcpToolkit, mediaTypeFor, mcpServerInputSchema, pickBotName, type Bot, type BotExpression, type McpServer, type Message, type Thread } from "@krubot/shared";
import { requestApproval, summarize } from "./approvals.ts";
import { boxHome, readBoxFile, readBoxFileBytes, writeBoxFile, type BoxConfig } from "./box.ts";
import { availableToolkits, composioConfigured, executeAction, isReadOnlyAction, startConnection, toolsFor, type ComposioTool } from "./composio.ts";
import { createBot, findBot, getBot, listBots, updateBot } from "./data/bots.ts";
import { createDelegation } from "./data/delegations.ts";
import { createMcpServer, getMcpServer, listMcpServers } from "./data/mcp.ts";
import { allSecretValues, listSecrets } from "./data/secrets.ts";
import { listConnections } from "./data/settings.ts";
import { createSkill, getSkillBySlug, listSkills } from "./data/skills.ts";
import { createRoutine, listRoutines, previewRuns } from "./data/routines.ts";
import { getSettings } from "./data/settings.ts";
import { getThread, postMessage, recentMessages, storeAttachment } from "./data/threads.ts";
import type { DriverTool } from "./driver.ts";
import { probeMcpServer } from "./mcp-oauth.ts";
import { botHome, LEGACY_TEAM_MEMORY_PATH, memoryPath, MAX_MEMORY_BYTES, teamDir, teamMemoryPath } from "./memory.ts";
import { requestSecret } from "./secret-requests.ts";
import { syncSkills } from "./skills.ts";
import { ownerIsAdmin, usableBot } from "./toolkits.ts";

/*
 * What a bot can do beyond its own computer. Every bot gets the team
 * tools; connected-app actions come from Composio for the toolkits the bot
 * was given; the Chief of Staff gets delegation. The `permission` tool is
 * how Claude Code asks whether it may run something: the broker answers.
 */

/** Longest tool result handed back to the model. */
const MAX_TOOL_RESULT = 24_000;
/** Bot-to-bot hops from the person's message before a chain stops. */
export const MAX_CHAIN = 4;
/** How long a sign-in card stays the one to use before asking again posts a new one. */
const SIGNIN_CARD_FRESH_MS = 30 * 60_000;

function clip(text: string, limit = MAX_TOOL_RESULT) {
  return text.length > limit ? `${text.slice(0, limit)}\n[… ${text.length - limit} more characters]` : text;
}

export const TOOL_NOTES = [
  "set_profile changes your own name, job title, how you work (your SOUL), mascot colour or expression, and whether you are the Chief of Staff. When the person tells you who you are or what you do from now on, update your description with it so your SOUL.md carries it. When the person tells you that you are the Chief of Staff, or to coordinate and hand tasks to the other bots, call it with chiefOfStaff: true and a description of the new role; from your next reply on you have delegate_bot and ask_bot. Use it too when the person gives you a lasting new job.",
  "memory_update replaces MEMORY.md, the notes that load into every turn. Keep it under a few hundred lines: stable preferences, how the person works, what you learned. You can also edit it, and memory/<topic>.md, with your own file tools; they live in your home folder.",
  "send_file hands the person a file from the computer as a download in this conversation (a document, an HTML page, an image, a spreadsheet, up to 25 MB). When the person asks for a file, or a teammate made one for them, send it; don't only say where it is on the computer.",
  "post_message adds a line to the conversation you are in before your final answer, e.g. to say what you are starting on. Your final answer is posted for you; don't repeat it.",
  "list_bots shows the team with each bot's id, job and whether it is busy.",
  "message_bot posts to a teammate's own conversation (its 1:1 with the person) and returns at once; the teammate answers there. Use it to hand something over without waiting.",
  "create_routine schedules a prompt for yourself on a cron in the person's time zone, paused until they turn it on unless they asked for it in this conversation. list_routines shows yours.",
  "Connected-app tools (names starting with the app, like GMAIL_SEND_EMAIL) act on the person's real accounts. Reads go through; writes may wait for the person's approval. Say what you sent, created or changed.",
  "team_memory_update replaces the team memory (its path is in the Team memory section), shared by every bot of the person. Keep it to what the whole team needs.",
  "use_skill returns a skill's full instructions by slug; save_skill adds a new one to the library (name, one-line description, Markdown instructions: steps, decision rules, expected output, what to check with the person first). Every teammate gets it at once.",
  "connect_app connects one of the person's own apps (in their Composio project): it checks whether Kru can connect it through Composio, asks for their Composio key with a masked card when there isn't one yet (set_composio_key does that on its own), and posts a Connect card they tap to sign in. When the app isn't there but has an MCP server, use add_mcp_server with its URL (from the person, or its official docs; never guess one): it asks the person to approve, adds the server and gives it to you, and posts a Sign in card when the server needs one. Its tools reach you on your next reply; the person gives it to other bots in their profiles.",
  "request_secret asks the person for a secret by name (like STRIPE_API_KEY) with a reason; the value is stored for injection and you never see it. list_secrets shows the names that exist. set_composio_key asks for their Composio API key the same way and turns connected apps on; never ask for either as plain text in the conversation.",
].join("\n");

export const CHIEF_TOOL_NOTES = [
  "delegate_bot hands a teammate a self-contained brief (outcome, sources, constraints, deliverable, review point) in its own conversation and returns immediately. The result comes back to you here as a new message from that teammate; report it to the person then, not before.",
  "ask_bot asks a teammate a short question and waits for the answer. Only for a consultation you need before you can reply; never for assigned work.",
  "create_bot adds a new teammate when the person asks for one: a name, a job title, a description of how it works (what it owns, sources, boundaries, what it returns; it becomes its SOUL), and optionally a mascot colour, expression and connected apps. Then brief it with delegate_bot if there is work for it.",
  "update_bot changes a teammate's profile when the person asks you to: its name, title, description (its SOUL), mascot colour or expression. 'Make @Web Designer a Coder' means title: Coder and a matching description.",
].join("\n");

type Context = {
  box: BoxConfig;
  bot: Bot;
  thread: Thread;
  message: Message;
  /** Runs a teammate's turn now and returns its text; the responder supplies it. */
  askBot: (bot: Bot, prompt: string, depth: number) => Promise<string>;
  /** Writes the bot's SOUL.md to its home after a profile change. */
  syncSoul: (bot: Bot) => Promise<void>;
};

const schema = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false });

/** The profile fields a bot may change, checked; an unknown colour or expression is an error, not a silent skip. */
function profilePatch(input: Record<string, unknown>): { name?: string; title?: string; description?: string; color?: string; expression?: BotExpression; isChief?: boolean } | { error: string } {
  const patch: { name?: string; title?: string; description?: string; color?: string; expression?: BotExpression } = {};
  if (typeof input.name === "string" && input.name.trim()) patch.name = input.name.trim().slice(0, 40);
  if (typeof input.title === "string") patch.title = input.title.trim().slice(0, 80);
  if (typeof input.description === "string") patch.description = input.description.trim().slice(0, 4000);
  if (typeof input.color === "string" && input.color.trim()) {
    const color = input.color.trim().toUpperCase();
    const known = (BOT_COLORS as readonly string[]).find((c) => c.toUpperCase() === color) ?? NAMED_COLORS[input.color.trim().toLowerCase()];
    if (!known) return { error: `NOT changed: colour must be one of ${BOT_COLORS.join(", ")} (or a name: ${Object.keys(NAMED_COLORS).join(", ")}).` };
    patch.color = known;
  }
  if (typeof input.expression === "string" && input.expression.trim()) {
    const expression = input.expression.trim().toLowerCase();
    if (!(BOT_EXPRESSIONS as readonly string[]).includes(expression)) return { error: `NOT changed: expression must be one of ${BOT_EXPRESSIONS.join(", ")}.` };
    patch.expression = expression as BotExpression;
  }
  return patch;
}

/** Colour names the person is likely to say, mapped to the mascot palette. */
const NAMED_COLORS: Record<string, string> = { orange: "#FF5A0F", blue: "#3B82F6", red: "#EF4444", yellow: "#F59E0B", amber: "#F59E0B", purple: "#8B5CF6", violet: "#8B5CF6", pink: "#EC4899", teal: "#14B8A6", green: "#22C55E", sky: "#0EA5E9", "light blue": "#0EA5E9", coral: "#F97316" };

/**
 * Where a file a bot names lives, relative to its owner's home: "~/x" and
 * "<home>/x" from the home, anything else from the bot's own folder. Null
 * when it climbs out, or names an absolute path outside the home; the box
 * checks again, links included.
 */
export function sharePath(given: string, botId: string, home: string | null = null): string | null {
  const prefix = home ? `${home.replace(/\/+$/, "")}/` : null;
  const raw = given.startsWith("~/") ? given.slice(2) : prefix && given.startsWith(prefix) ? given.slice(prefix.length) : given.startsWith("/") ? null : `${botHome(botId)}/${given}`;
  if (raw === null) return null;
  const parts: string[] = [];
  for (const part of raw.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!parts.pop()) return null;
    } else parts.push(part);
  }
  return parts.length ? parts.join("/") : null;
}

/** What the person does with a Sign in card, for the bot to pass on in a line. */
function signInHow(server: McpServer): string {
  return server.oauthRedirect === "localhost"
    ? ` ${server.name} only sends sign-ins back to localhost: the card opens the sign-in in a new tab, and the person pastes the address it ends on into the card (the desktop app finishes it on its own). Don't call connect_app or add_mcp_server for it again.`
    : " Don't call connect_app or add_mcp_server for it again.";
}

/** Whether a file carries a stored secret's value, so it never reaches the chat. */
function containsSecret(data: Uint8Array): boolean {
  const secrets = allSecretValues().filter((s) => s.length >= 8);
  if (!secrets.length) return false;
  const bytes = Buffer.from(data);
  return secrets.some((secret) => bytes.includes(secret));
}

/** A name for an MCP server from what the bot called it: "Robinhood Trading" → robinhood-trading. */
export function mcpServerName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "")
    .slice(0, 40);
}

export function baseTools(context: Context): Record<string, DriverTool> {
  const { box, bot, thread, message } = context;
  const depth = message.depth + 1;
  /**
   * The card that lets the person sign in to a server without leaving the
   * conversation. One is enough: a card follows the server's state live, so
   * a recent one for the same server (connect_app then add_mcp_server in one
   * turn) isn't posted again.
   */
  /** A server that exists but wasn't given to this bot: say how it gets it. */
  const notYours = (server: McpServer) => ((getBot(bot.id) ?? bot).toolkits.includes(mcpToolkit(server.id)) ? "" : ` It isn't given to you yet: ask the person to turn on ${server.name} in your profile (Settings → the bot → Connected apps).`);
  const postSignInCard = (server: McpServer) => {
    const recent = recentMessages(thread.id, 30).some((m) => m.kind === "signin" && m.approvalId === server.id && Date.now() - Date.parse(m.createdAt) < SIGNIN_CARD_FRESH_MS);
    if (!recent) postMessage({ threadId: thread.id, author: bot.id, kind: "signin", body: `Sign in to ${server.name}`, approvalId: server.id, depth, answered: true });
  };
  /*
   * A connected app's sign-in is a card too, not a link in the text: the
   * card asks the API for a fresh Connect Link when the person taps it, so
   * nothing expires while the message sits there, and it follows the
   * connection's state live.
   */
  const postConnectCard = (app: { toolkit: string; name: string }) => {
    const id = composioCard(app.toolkit);
    const recent = recentMessages(thread.id, 30).some((m) => m.kind === "signin" && m.approvalId === id && Date.now() - Date.parse(m.createdAt) < SIGNIN_CARD_FRESH_MS);
    if (!recent) postMessage({ threadId: thread.id, author: bot.id, kind: "signin", body: `Connect ${app.name}`, approvalId: id, depth, answered: true });
  };
  /** Asks for the person's Composio key with the masked card. Returns what to say when it didn't arrive. */
  const askComposioKey = async (reason: string): Promise<string | null> => {
    const status = await requestSecret({ bot, threadId: thread.id, name: "COMPOSIO_API_KEY", reason, target: "composio" });
    if (status === "given" || status === "exists") return null;
    if (status === "declined") return "The person declined to give their Composio API key, so connected apps stay off. Say what you can do without them.";
    return "Nobody gave the Composio API key in time. Say so; they can also add it under Settings → Apps.";
  };
  return {
    set_profile: {
      description: "Update your own profile: name, job title, how you work (your SOUL), your mascot's colour and expression, and whether you are the Chief of Staff who coordinates the other bots.",
      inputSchema: schema({
        name: { type: "string", description: "A new name, when the person renames you." },
        title: { type: "string", description: "Your job, one line." },
        description: { type: "string", description: "How you work: what you own, sources, boundaries, what you return. Replaces the current one." },
        color: { type: "string", description: `Mascot colour, one of: ${BOT_COLORS.join(", ")}.` },
        expression: { type: "string", description: `Mascot expression, one of: ${BOT_EXPRESSIONS.join(", ")}.` },
        chiefOfStaff: { type: "boolean", description: "True to become the Chief of Staff (coordinate and delegate to the team); false to step down." },
      }),
      execute: async (input) => {
        const patch = profilePatch(input);
        if ("error" in patch) return patch.error;
        if (typeof input.chiefOfStaff === "boolean") patch.isChief = input.chiefOfStaff;
        if (Object.keys(patch).length === 0) return "Nothing to change.";
        const updated = updateBot(bot.id, patch);
        if (!updated) return "NOT changed: your profile is gone.";
        await context.syncSoul(updated);
        const changed = [patch.title !== undefined ? "title" : "", patch.description !== undefined ? "description" : "", patch.isChief !== undefined ? (patch.isChief ? "you are now the Chief of Staff" : "you are no longer the Chief of Staff") : ""].filter(Boolean).join(", ");
        return `Profile updated (${changed}).${patch.isChief ? " delegate_bot and ask_bot are yours from your next reply; finish this one by telling the person what you'll coordinate." : ""}`;
      },
    },
    memory_update: {
      description: "Replace MEMORY.md, the notes that load into every one of your turns.",
      inputSchema: schema({ content: { type: "string", description: "The whole new file." } }, ["content"]),
      execute: async (input) => {
        const content = String(input.content ?? "");
        if (Buffer.byteLength(content, "utf8") > MAX_MEMORY_BYTES * 4) return `MEMORY.md would be too long (${Buffer.byteLength(content, "utf8")} bytes). Move notes into memory/<topic>.md and keep this file short.`;
        await writeBoxFile(box, memoryPath(bot.id), content);
        return "MEMORY.md saved.";
      },
    },
    post_message: {
      description: "Post a line to this conversation now, before your final answer.",
      inputSchema: schema({ text: { type: "string" } }, ["text"]),
      execute: async (input) => {
        const text = String(input.text ?? "").trim();
        if (!text) return "Nothing to post.";
        postMessage({ threadId: thread.id, author: bot.id, body: text.slice(0, 4000), depth, answered: true });
        return "Posted.";
      },
    },
    send_file: {
      description: "Hand the person a file from the computer: it appears in this conversation with a download button. Paths are relative to your home folder, or start with ~/ for the person's home on the computer (like ~/.team/<team>/report.html).",
      inputSchema: schema({ path: { type: "string", description: "The file, like report.pdf or ~/.team/<team>/hello-world.html." }, note: { type: "string", description: "A line to go with it, optional." } }, ["path"]),
      execute: async (input) => {
        const given = String(input.path ?? "").trim();
        if (!given) return "NOT sent: which file?";
        const relative = sharePath(given, bot.id, boxHome(bot.userId));
        if (!relative) return "NOT sent: the file must be inside the person's home on the computer (~).";
        let data: Uint8Array;
        try {
          data = await readBoxFileBytes(box, relative);
        } catch (error) {
          return `NOT sent: ${error instanceof Error ? error.message : "the file couldn't be read"}.`;
        }
        if (data.byteLength > MAX_ATTACHMENT_BYTES) return `NOT sent: the file is larger than ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB.`;
        if (containsSecret(data)) return "NOT sent: the file contains a stored secret. Take it out first.";
        const name = relative.split("/").pop() || "file";
        const file = storeAttachment({ name: name.slice(0, 200), mediaType: mediaTypeFor(name), data });
        const note = String(input.note ?? "").trim().slice(0, 4000);
        postMessage({ threadId: thread.id, author: bot.id, body: note, attachments: [file], depth, answered: true });
        return `Sent ${name} to the person; it's in the conversation with a download button. Don't repeat the path.`;
      },
    },
    list_bots: {
      description: "The team: every bot with its id, job, and whether it is a Chief of Staff.",
      inputSchema: schema({}),
      execute: async () =>
        listBots({ userId: bot.userId })
          .map((b) => `- ${b.id} · ${b.name} (@${handleOf(b.name)})${b.title ? ` · ${b.title}` : ""}${b.isChief ? " · Chief of Staff" : ""}${b.id === bot.id ? " · (you)" : ""}`)
          .join("\n") || "No bots.",
    },
    message_bot: {
      description: "Post a message into a teammate's own conversation and return at once. It answers there.",
      inputSchema: schema({ bot: { type: "string", description: "The teammate's id, name or @handle." }, text: { type: "string" } }, ["bot", "text"]),
      execute: async (input) => {
        if (depth > MAX_CHAIN) return "NOT sent: too many bot-to-bot hops. Bring the person in.";
        const target = findBot(String(input.bot ?? ""), listBots({ includeHidden: true, userId: bot.userId }));
        if (!target) return `NOT sent: no bot called "${String(input.bot ?? "")}". Use list_bots.`;
        if (target.id === bot.id) return "NOT sent: that's you.";
        const text = String(input.text ?? "").trim();
        if (!text) return "NOT sent: empty message.";
        postMessage({ threadId: target.threadId, author: bot.id, body: text.slice(0, 8000), depth, fromThreadId: thread.id });
        return `Sent to ${target.name}. It will answer in its own conversation.`;
      },
    },
    team_memory_update: {
      description: `Replace ~/${teamMemoryPath(bot.userId)}, the memory shared by every bot on your person's team.`,
      inputSchema: schema({ content: { type: "string", description: "The whole new file." } }, ["content"]),
      execute: async (input) => {
        const content = String(input.content ?? "");
        if (Buffer.byteLength(content, "utf8") > MAX_MEMORY_BYTES * 2) return `The team memory would be too long (${Buffer.byteLength(content, "utf8")} bytes). Keep it to what everyone needs; longer notes go in ~/${teamDir(bot.userId)}/<topic>.md.`;
        await writeBoxFile(box, teamMemoryPath(bot.userId), content);
        return `${teamMemoryPath(bot.userId)} saved for the whole team.`;
      },
    },
    use_skill: {
      description: "Read a skill from the team's library by its slug (see the Skills list).",
      inputSchema: schema({ slug: { type: "string" } }, ["slug"]),
      execute: async (input) => {
        const skill = getSkillBySlug(String(input.slug ?? "").replace(/^\//, "").trim());
        if (!skill) return `No skill called "${String(input.slug ?? "")}". The library: ${listSkills().map((s) => `/${s.slug}`).join(", ") || "(empty)"}.`;
        return clip(`# ${skill.name} (/${skill.slug})\n${skill.description}\n\n${skill.instructions}`);
      },
    },
    save_skill: {
      description: "Save a way of doing a job to the team's library, for every bot to reuse.",
      inputSchema: schema(
        {
          name: { type: "string", description: "Short, like 'Weekly pipeline review'." },
          description: { type: "string", description: "One line: what it does." },
          instructions: { type: "string", description: "Markdown: steps, decision rules, expected output, what to check with the person first." },
        },
        ["name", "instructions"],
      ),
      execute: async (input) => {
        const name = String(input.name ?? "").trim().slice(0, 60);
        const instructions = String(input.instructions ?? "").trim().slice(0, 20_000);
        if (!name || !instructions) return "NOT saved: a skill needs a name and instructions.";
        const skill = createSkill({ name, description: String(input.description ?? "").trim().slice(0, 200), instructions }, "bot");
        void syncSkills();
        return `Saved as /${skill.slug}. The person can hand it to any bot by typing /${skill.slug}, and edit it under Settings → Skills.`;
      },
    },
    request_secret: {
      description: "Ask the person for a secret (an API key, a token) by name. It is stored for injection; you never see it.",
      inputSchema: schema({ name: { type: "string", description: "UPPER_SNAKE_CASE, like STRIPE_API_KEY." }, reason: { type: "string", description: "What it's for, in one line." } }, ["name", "reason"]),
      execute: async (input) => {
        const name = String(input.name ?? "").trim();
        if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name)) return "NOT asked: name it in UPPER_SNAKE_CASE, like STRIPE_API_KEY.";
        const status = await requestSecret({ bot, threadId: thread.id, name, reason: String(input.reason ?? "").trim().slice(0, 300) });
        if (status === "exists") return `${name} is already stored. Reference it as {{secret:${name}}} where secrets are injected (an MCP server's headers under Settings).`;
        if (status === "given") return `${name} is stored. It is filled in where it's used; you never see the value. Carry on.`;
        if (status === "declined") return `The person declined to give ${name}. Say what you can do without it.`;
        return `Nobody gave ${name} in time. Say so and stop, or ask again later.`;
      },
    },
    set_composio_key: {
      description: "Ask the person for their Composio API key and store it as their Composio project key, which turns on connected apps (Gmail, Slack, Notion and the rest). A masked card asks for it; you never see the value. Use this when they have no key yet and want their apps connected.",
      inputSchema: schema({ reason: { type: "string", description: "What they asked for, in one line, like 'to connect your Gmail'." } }),
      execute: async (input) => {
        if (composioConfigured(bot.userId)) return "A Composio key is already in place. Connect an app with connect_app.";
        const failed = await askComposioKey(String(input.reason ?? "").trim().slice(0, 200) || "to connect your apps");
        if (failed) return failed;
        return "Stored. Connected apps are on. Connect one with connect_app; a free key comes from platform.composio.dev if they need another.";
      },
    },
    list_secrets: {
      description: "The names of the stored secrets (never their values).",
      inputSchema: schema({}),
      execute: async () => listSecrets(bot.userId).map((s) => `- ${s.name}`).join("\n") || "No secrets stored.",
    },
    connect_app: {
      description: "Connect one of the person's apps: looks it up among the apps Kru can connect (Composio); starts the connection and returns the sign-in link, or says how to attach it as an MCP server when it isn't there.",
      inputSchema: schema({ app: { type: "string", description: "The app, like notion, slack, github, linear." } }, ["app"]),
      execute: async (input) => {
        const wanted = String(input.app ?? "").trim().toLowerCase();
        if (!wanted) return "Which app?";
        const squash = (t: string) => t.toLowerCase().replace(/[^a-z0-9]/g, "");
        const already = listConnections(bot.userId).find((c) => squash(c.toolkit) === squash(wanted) || squash(c.name) === squash(wanted));
        if (already?.status === "active") return `${already.name} is already connected. Ask the person to add it to your profile (Settings → the bot → Connected apps) if you don't have its tools yet.`;
        const mcp = listMcpServers(bot.userId).find((m) => squash(m.name) === squash(wanted));
        if (mcp) {
          if (mcp.authStatus === "needed" && mcp.enabled) {
            postSignInCard(mcp);
            return `${mcp.name} is attached as an MCP server but needs the person to sign in; a Sign in card is in the conversation.${signInHow(mcp)}${notYours(mcp)}`;
          }
          return `${mcp.name} is attached as an MCP server${mcp.enabled ? "" : " but turned off (Settings → Apps → MCP servers)"}.${notYours(mcp)}`;
        }
        const catalog = await availableToolkits(bot.userId).catch(() => APP_CATALOG);
        const entry = catalog.find((a) => squash(a.toolkit) === squash(wanted) || squash(a.name) === squash(wanted) || squash(a.name).includes(squash(wanted)));
        if (entry) {
          if (!composioConfigured(bot.userId)) {
            const key = await askComposioKey(`to connect ${entry.name} and your other apps`);
            if (key) return key;
          }
          postConnectCard(entry);
          return `A Connect card for ${entry.name} is in the conversation; the person taps it to sign in to ${entry.name}. Once they do, ask them to add ${entry.name} to your profile (Settings → the bot → Connected apps) so you get its tools.`;
        }
        return `${wanted} isn't among the apps Kru can connect through Composio. If it offers an MCP server, add it with add_mcp_server and its URL (the one the person gave you, or from the app's official docs; don't guess). A server that runs as a command goes under Settings → Apps → MCP servers instead. If it has neither, use the browser on the computer.`;
      },
    },
    add_mcp_server: {
      description: "Attach an app's remote MCP server (an HTTP URL), for an app connect_app can't connect. The person approves it first; it is given to you, and the person can give it to other bots. When the server wants a sign-in, a Sign in card goes into the conversation. Its tools reach you from your next reply.",
      inputSchema: schema(
        {
          name: { type: "string", description: "What to call it, like robinhood or linear." },
          url: { type: "string", description: "The server's URL, exactly as the person or the app's docs give it, like https://mcp.example.com/mcp." },
        },
        ["name", "url"],
      ),
      execute: async (input) => {
        const name = mcpServerName(String(input.name ?? ""));
        const url = String(input.url ?? "").trim();
        let parsed: URL;
        try {
          parsed = new URL(url);
        } catch {
          return "NOT added: that isn't a URL. Ask the person for the server's address.";
        }
        if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return "NOT added: an MCP server's URL starts with https://.";
        if (parsed.username || parsed.password) return "NOT added: leave credentials out of the URL. When the server needs a key, ask for it with request_secret and tell the person to put it in the server's headers under Settings → Apps → MCP servers.";
        if (!name) return "NOT added: give the server a name, like the app's.";
        const existing = listMcpServers(bot.userId).find((m) => m.name === name || m.url === parsed.href || m.url === url);
        if (existing) {
          if (existing.authStatus === "needed" && existing.enabled) {
            postSignInCard(existing);
            return `${existing.name} is already attached and needs the person to sign in; a Sign in card is in the conversation.${signInHow(existing)}${notYours(existing)}`;
          }
          return `${existing.name} is already attached (${existing.url ?? "a command"})${existing.enabled ? "" : ", but turned off under Settings → Apps → MCP servers"}.${notYours(existing)}`;
        }
        const checked = mcpServerInputSchema.safeParse({ name, transport: "http", url: parsed.href });
        if (!checked.success) return `NOT added: ${checked.error.issues[0]?.message ?? "bad server"}.`;
        const decision = await requestApproval({ bot, threadId: thread.id, tool: "add_mcp_server", input: { name, url: parsed.href }, summary: `Add the MCP server ${name} (${parsed.href}) and give it to ${bot.name}` });
        if (decision === "deny") return "NOT added: the person said no.";
        if (decision === "expired") return "NOT added: nobody approved it in time.";
        let server: McpServer;
        try {
          server = createMcpServer(checked.data, bot.userId);
        } catch (error) {
          return `NOT added: ${/UNIQUE/.test(String(error)) ? "a server with that name exists" : "the server couldn't be saved"}.`;
        }
        // The bot that asked gets it; the person gives it to others in their profiles.
        const me = getBot(bot.id) ?? bot;
        updateBot(bot.id, { toolkits: [...new Set([...me.toolkits, mcpToolkit(server.id)])] });
        const probe = await probeMcpServer(server.id).catch(() => ({ status: "error" as const, detail: "no answer" }));
        const fresh = getMcpServer(server.id) ?? server;
        if (probe.status === "needed") {
          postSignInCard(fresh);
          return `Added ${name}. It needs the person to sign in: a Sign in card is in the conversation. Tell them so in a line; once they do, you'll hear about it and its tools are yours.${signInHow(fresh)}`;
        }
        if (probe.status === "error") return `Added ${name}, but it isn't usable yet: ${fresh.authError ?? probe.detail ?? "the server didn't answer"}. Tell the person; they can fix it under Settings → Apps → MCP servers.`;
        return `Added ${name}; it answered without a sign-in. Its tools are yours from your next reply.`;
      },
    },
    list_routines: {
      description: "Your scheduled routines.",
      inputSchema: schema({}),
      execute: async () =>
        listRoutines(bot.id)
          .map((r) => `- ${r.id} · ${r.name} · ${r.cron} (${r.timezone}) · ${r.enabled ? `next ${r.nextRunAt ?? "?"}` : "paused"}`)
          .join("\n") || "No routines yet.",
    },
    create_routine: {
      description: "Schedule a prompt for yourself on a five-field cron in the person's time zone.",
      inputSchema: schema(
        {
          name: { type: "string" },
          cron: { type: "string", description: "minute hour day-of-month month day-of-week" },
          prompt: { type: "string", description: "What to do each time." },
          enabled: { type: "boolean", description: "True only when the person asked for it now." },
        },
        ["name", "cron", "prompt"],
      ),
      execute: async (input) => {
        const timezone = getSettings().timezone;
        const cron = String(input.cron ?? "").trim();
        let preview: string[];
        try {
          preview = previewRuns(cron, timezone, 3);
        } catch (error) {
          return `NOT created: bad cron (${error instanceof Error ? error.message : "invalid"}).`;
        }
        const routine = createRoutine(bot.id, { name: String(input.name ?? "Routine").slice(0, 80), cron, timezone, prompt: String(input.prompt ?? "").slice(0, 4000), enabled: input.enabled === true });
        return `Created "${routine.name}" (${routine.enabled ? "on" : "paused; the person can turn it on under Routines"}). Next runs: ${preview.join(", ")}.`;
      },
    },
  };
}

/** The Chief of Staff's extra tools. */
export function chiefTools(context: Context): Record<string, DriverTool> {
  const { bot, thread, message, askBot } = context;
  const depth = message.depth + 1;
  return {
    delegate_bot: {
      description: "Hand a teammate a self-contained brief in its own conversation. Returns at once; the result comes back to you here.",
      inputSchema: schema({ bot: { type: "string", description: "The teammate's id, name or @handle." }, brief: { type: "string" } }, ["bot", "brief"]),
      execute: async (input) => {
        if (depth > MAX_CHAIN) return "NOT delegated: too many bot-to-bot hops. Bring the person in.";
        const target = findBot(String(input.bot ?? ""), listBots({ includeHidden: true, userId: bot.userId }));
        if (!target) return `NOT delegated: no bot called "${String(input.bot ?? "")}". Use list_bots.`;
        if (target.id === bot.id) return "NOT delegated: that's you.";
        const brief = String(input.brief ?? "").trim();
        if (!brief) return "NOT delegated: empty brief.";
        const posted = postMessage({ threadId: target.threadId, author: bot.id, body: brief.slice(0, 12_000), depth, fromThreadId: thread.id });
        createDelegation({ fromBotId: bot.id, fromThreadId: thread.id, toBotId: target.id, toThreadId: target.threadId, messageId: posted.id, brief });
        postMessage({ threadId: thread.id, author: "system", kind: "event", body: `${bot.name} handed a task to ${target.name}.`, answered: true });
        return `Assigned to ${target.name}. Its result will arrive here as a message from ${target.name}; end your turn after acknowledging the handoff.`;
      },
    },
    create_bot: {
      description: "Add a new teammate: name, job title, how it works (its SOUL), mascot colour and expression, and the connected apps it may use.",
      inputSchema: schema(
        {
          name: { type: "string", description: "Its name; one is picked when left out." },
          title: { type: "string", description: "Its job, one line, like Developer." },
          description: { type: "string", description: "How it works: what it owns, sources, boundaries, what it returns." },
          color: { type: "string", description: `One of: ${BOT_COLORS.join(", ")}.` },
          expression: { type: "string", description: `One of: ${BOT_EXPRESSIONS.join(", ")}.` },
          apps: { type: "array", items: { type: "string" }, description: "Connected apps it may use, like github or notion." },
        },
        ["title", "description"],
      ),
      execute: async (input) => {
        const patch = profilePatch(input);
        if ("error" in patch) return patch.error.replace("NOT changed", "NOT created");
        if (!patch.title || !patch.description) return "NOT created: give it a job title and a description of how it works.";
        const taken = listBots({ includeHidden: true, userId: bot.userId }).map((b) => b.name);
        const takenLower = new Set(taken.map((n) => n.toLowerCase()));
        let name = patch.name ?? pickBotName(taken);
        for (let i = 2, base = name; takenLower.has(name.toLowerCase()); i += 1) name = `${base} ${i}`;
        const connected = listConnections(bot.userId).filter((c) => c.status === "active");
        const asked = Array.isArray(input.apps) ? input.apps.map((a) => String(a).toLowerCase().replace(/[^a-z0-9]/g, "")) : [];
        const toolkits = connected.filter((c) => asked.includes(c.toolkit) || asked.includes(c.name.toLowerCase().replace(/[^a-z0-9]/g, ""))).map((c) => c.toolkit);
        const missing = asked.filter((a) => !connected.some((c) => c.toolkit === a || c.name.toLowerCase().replace(/[^a-z0-9]/g, "") === a));
        const created = createBot(botInputSchema.parse({ name, title: patch.title, description: patch.description, color: patch.color ?? BOT_COLORS[taken.length % BOT_COLORS.length], expression: patch.expression ?? "happy", toolkits }), bot.userId);
        postMessage({ threadId: created.threadId, author: "system", kind: "event", body: `${bot.name} added ${created.name}${created.title ? ` as ${created.title}` : ""}.`, answered: true });
        postMessage({ threadId: thread.id, author: "system", kind: "event", body: `${bot.name} added ${created.name} to the team.`, answered: true });
        await context.syncSoul(created);
        return `Created ${created.name} (@${handleOf(created.name)}, id ${created.id}) as ${created.title}${toolkits.length ? ` with ${toolkits.join(", ")}` : ""}.${missing.length ? ` Not connected yet, so not given: ${missing.join(", ")}; use connect_app, then update its apps under Settings.` : ""} Brief it with delegate_bot when there is work for it.`;
      },
    },
    update_bot: {
      description: "Change a teammate's profile when the person asks: name, job title, how it works (its SOUL), mascot colour or expression.",
      inputSchema: schema({
        bot: { type: "string", description: "The teammate's id, name or @handle." },
        name: { type: "string" },
        title: { type: "string" },
        description: { type: "string", description: "Replaces its current one." },
        color: { type: "string", description: `One of: ${BOT_COLORS.join(", ")}.` },
        expression: { type: "string", description: `One of: ${BOT_EXPRESSIONS.join(", ")}.` },
      }, ["bot"]),
      execute: async (input) => {
        const target = findBot(String(input.bot ?? ""), listBots({ includeHidden: true, userId: bot.userId }));
        if (!target) return `NOT changed: no bot called "${String(input.bot ?? "")}". Use list_bots.`;
        if (target.id === bot.id) return "That's you: use set_profile.";
        const patch = profilePatch(input);
        if ("error" in patch) return patch.error;
        if (Object.keys(patch).length === 0) return "Nothing to change.";
        const updated = updateBot(target.id, patch);
        if (!updated) return "NOT changed: that bot is gone.";
        await context.syncSoul(updated);
        return `${updated.name}'s profile updated (${Object.keys(patch).join(", ")}). It reads its new SOUL on its next turn.`;
      },
    },
    ask_bot: {
      description: "Ask a teammate a short question and wait for the answer.",
      inputSchema: schema({ bot: { type: "string" }, question: { type: "string" } }, ["bot", "question"]),
      execute: async (input) => {
        if (depth > MAX_CHAIN) return "NOT asked: too many bot-to-bot hops.";
        const target = findBot(String(input.bot ?? ""), listBots({ includeHidden: true, userId: bot.userId }));
        if (!target) return `NOT asked: no bot called "${String(input.bot ?? "")}".`;
        if (target.id === bot.id) return "NOT asked: that's you.";
        const question = String(input.question ?? "").trim();
        if (!question) return "NOT asked: empty question.";
        const answer = await askBot(target, `${bot.name} (${bot.title || "teammate"}) asks you, briefly: ${question}`, depth);
        return clip(answer || "(no answer)");
      },
    },
  };
}

/**
 * The permission prompt tool: Claude Code calls it with the tool it wants
 * to use and the input; the broker decides. The answer is the JSON the CLI
 * expects, as text.
 */
export function permissionTool(context: Context): DriverTool {
  const { bot, thread } = context;
  return {
    description: "Internal: Kru Bot's permission prompt.",
    // Loose on purpose: the CLI may add fields (suggestions, ids) over time.
    inputSchema: { type: "object", properties: { tool_name: { type: "string" }, input: { type: "object" }, tool_use_id: { type: "string" } }, required: ["tool_name", "input"] },
    execute: async (raw) => {
      const tool = String(raw.tool_name ?? "");
      const input = (raw.input && typeof raw.input === "object" ? raw.input : {}) as Record<string, unknown>;
      const decision = await requestApproval({ bot, threadId: thread.id, tool, input });
      if (decision === "allow" || decision === "always") return JSON.stringify({ behavior: "allow", updatedInput: input });
      const message = decision === "expired" ? `Nobody answered the approval for "${summarize(tool, input)}" in time. Say so and stop, or ask again later.` : `The person denied "${summarize(tool, input)}". Do something else, or say what you would need.`;
      return JSON.stringify({ behavior: "deny", message });
    },
  };
}

/** Connected-app actions for the toolkits the bot was given, each gated like a write. */
export async function appTools(context: Context): Promise<Record<string, DriverTool>> {
  const { bot, thread } = context;
  let tools: ComposioTool[] = [];
  try {
    tools = await toolsFor(bot.userId, usableBot(bot).toolkits);
  } catch (error) {
    console.warn(`[kru] connected apps unavailable for ${bot.name}: ${error instanceof Error ? error.message : error}`);
    return {};
  }
  const out: Record<string, DriverTool> = {};
  for (const tool of tools) {
    const slug = tool.slug.toUpperCase();
    out[slug] = {
      description: `${tool.toolkit?.name ?? tool.toolkit?.slug ?? "App"}: ${tool.description ?? tool.name}`.slice(0, 1000),
      inputSchema: tool.inputParameters ?? { type: "object", properties: {} },
      execute: async (input) => {
        if (!isReadOnlyAction(slug)) {
          const first = Object.entries(input).find(([, v]) => typeof v === "string") as [string, string] | undefined;
          const decision = await requestApproval({ bot, threadId: thread.id, tool: slug, input, summary: `${tool.name}${first ? `: ${first[1].slice(0, 160)}` : ""}` });
          if (decision === "deny") return "NOT done: the person denied this action.";
          if (decision === "expired") return "NOT done: nobody approved this action in time.";
        }
        const result = await executeAction(bot.userId, slug, input, tool.toolkit?.slug);
        return clip(typeof result === "string" ? result : JSON.stringify(result, null, 1));
      },
    };
  }
  return out;
}

/** The bot's memory, as loaded into its prompt. */
export async function loadMemory(box: BoxConfig, botId: string): Promise<{ text: string | null; truncated: boolean }> {
  try {
    const file = await readBoxFile(box, memoryPath(botId));
    const text = file.content ?? "";
    const lines = text.split("\n");
    let out = lines.slice(0, 200).join("\n");
    let truncated = lines.length > 200;
    if (Buffer.byteLength(out, "utf8") > MAX_MEMORY_BYTES) {
      out = Buffer.from(out, "utf8").subarray(0, MAX_MEMORY_BYTES).toString("utf8");
      truncated = true;
    }
    return { text: out, truncated };
  } catch {
    return { text: null, truncated: false };
  }
}

/**
 * A person's team memory, as loaded into every prompt of their bots. The
 * admin's bots fall back to the file from before it was kept per person.
 */
export async function loadTeamMemory(box: BoxConfig, userId: string): Promise<string | null> {
  const read = (path: string) =>
    readBoxFile(box, path)
      .then((file) => file.content ?? null)
      .catch(() => null);
  const own = await read(teamMemoryPath(userId));
  if (own !== null || !ownerIsAdmin(userId)) return own;
  return read(LEGACY_TEAM_MEMORY_PATH);
}

/** The recent lines of a thread as the CLI reads them. */
export function transcript(thread: Thread, bots: Bot[], self: Bot, upTo: Message, count = 30): string {
  const names = new Map(bots.map((b) => [b.id, b.name]));
  const lines = recentMessages(thread.id, count).filter((m) => m.createdAt <= upTo.createdAt);
  return lines
    .map((m) => {
      const who = m.author === "you" ? "Person" : m.author === "routine" ? "Routine" : m.author === "system" ? "Kru Bot" : (names.get(m.author) ?? m.author) + (m.author === self.id ? " (you)" : "");
      const files = m.attachments.length ? ` [attached: ${m.attachments.map((a) => a.name).join(", ")}]` : "";
      return `${who}: ${m.kind === "approval" ? `(asked for approval: ${m.body})` : m.kind === "signin" ? `(posted a sign-in card: ${m.body})` : m.body}${files}`;
    })
    .join("\n");
}

export function threadFor(id: string): Thread | null {
  return getThread(id);
}
