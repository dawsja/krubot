import { APP_CATALOG, BOT_COLORS, BOT_EXPRESSIONS, MAX_SENT_FILE_BYTES, SKILL_LIMITS, botInputSchema, composioCard, handleOf, joinCommandLine, mcpToolkit, mentionsIn, mediaTypeFor, mcpServerInputSchema, pickBotName, skillFilePath, type Bot, type BotExpression, type McpServer, type McpServerInput, type Message, type SkillInput, type Thread } from "@krubot/shared";
import { requestApproval, summarize } from "./approvals.ts";
import { boxHome, readBoxFile, readBoxFileBytes, writeBoxFile, type BoxConfig } from "./box.ts";
import { exactApp, searchIndex } from "./catalog.ts";
import { catalogIndex, composioConfigured, executeAction, isReadOnlyAction, startConnection, toolsFor, type ComposioTool } from "./composio.ts";
import { createBot, findBot, getBot, listBots, updateBot } from "./data/bots.ts";
import { createDelegation, finishDelegation, getDelegation, handoffWorkedOn, listDelegationsForBot, openChildren, type Delegation } from "./data/delegations.ts";
import { cancelFollowUp, createFollowUp, listFollowUps } from "./data/follow-ups.ts";
import { createMcpServer, getMcpServer, listMcpServers } from "./data/mcp.ts";
import { allSecretValues, hideSecrets, listSecrets } from "./data/secrets.ts";
import { listConnections } from "./data/settings.ts";
import { createSkill, getSkill, getSkillBySlug, listSkills, skillFiles, updateSkill } from "./data/skills.ts";
import { createRoutine, deleteRoutine, listRoutines, previewRuns, recordRoutineRun, routinePrompt, updateRoutine } from "./data/routines.ts";
import { getSettings } from "./data/settings.ts";
import { createRoom, getThread, listMessages, listThreads, markAnswered, postMessage, recentMessages, searchMessages, storeAttachment } from "./data/threads.ts";
import type { DriverTool } from "./driver.ts";
import { probeMcpServer } from "./mcp-oauth.ts";
import { botHome, LEGACY_TEAM_MEMORY_PATH, memoryPath, MAX_MEMORY_BYTES, teamDir, teamMemoryPath } from "./memory.ts";
import { requestSecret } from "./secret-requests.ts";
import { looksExecutable, nameFromFolder, parseSkillMd, type BundleFile } from "./skill-bundle.ts";
import { readSkillFromBox, skillBrief, skillsReady, syncSkills } from "./skills.ts";
import { ownerIsAdmin, usableBot } from "./toolkits.ts";

/*
 * What a bot can do beyond its own computer. Every bot gets the same team
 * tools, delegation and create_bot included: being the Chief of Staff is a
 * job, not a set of permissions. Connected-app actions come from Composio
 * for the toolkits the bot was given. The `permission` tool is how Claude
 * Code asks whether it may run something: the broker answers.
 */

/** Longest tool result handed back to the model. */
const MAX_TOOL_RESULT = 24_000;
/** Bot-to-bot hops from the person's message before a chain stops. */
export const MAX_CHAIN = 4;

/**
 * The depth a teammate's result lands at in the delegator's thread: the
 * depth of the message the delegator was answering when it wrote the brief.
 * A handoff that comes back is the end of a hop, not another one, so a
 * Chief of Staff can run wave after wave off its teammates' results; only
 * briefs nested inside briefs count towards MAX_CHAIN.
 */
export function resultDepth(briefDepth: number): number {
  return Math.max(0, briefDepth - 1);
}

/** Lines bots may write in a room, @mentioning each other, before it waits for the person. */
export const MAX_ROOM_LINES = 20;
/** Most bots a bot may put in one room. */
const MAX_ROOM_MEMBERS = 12;

/**
 * A bot's opening line in a room, with every other member it is meant for
 * @mentioned: in a room only a mention wakes a bot, so a line that names
 * nobody would sit there unanswered.
 */
export function roomOpener(text: string, invited: Bot[]): string {
  const named = new Set(mentionsIn(text));
  const missing = invited.filter((b) => !named.has(handleOf(b.name)));
  return missing.length ? `${missing.map((b) => `@${handleOf(b.name)}`).join(" ")} ${text}` : text;
}

/** Most follow-ups one bot may have waiting at once. */
const MAX_FOLLOW_UPS = 10;
/** Longest a follow-up may wait: a week. */
const MAX_FOLLOW_UP_MINUTES = 7 * 24 * 60;
/** How far back list_handoffs reaches for finished ones. */
const HANDOFF_WINDOW_MS = 24 * 60 * 60 * 1000;

/** How long ago a moment was, the way a person says it. */
export function ago(at: string, from = Date.now()): string {
  const minutes = Math.max(0, Math.round((from - Date.parse(at)) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

/** A text on one line, cut short. */
function oneLineOf(text: string, max: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

/** A stretch of a text around the first place a query appears, on one line. */
export function snippetAround(text: string, query: string, width = 240): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= width) return flat;
  const at = Math.max(0, flat.toLowerCase().indexOf(query.toLowerCase()));
  const start = Math.max(0, Math.min(at - Math.floor(width / 3), flat.length - width));
  return `${start > 0 ? "…" : ""}${flat.slice(start, start + width).trim()}${start + width < flat.length ? "…" : ""}`;
}

/** Models sometimes write a profile field as HTML ("Platform &amp; Systems"); store the text. */
export function plainText(value: string): string {
  return value
    .replace(/&(lt|gt|quot|apos|#39|#x27|nbsp);/gi, (_, name: string) => ({ lt: "<", gt: ">", quot: '"', apos: "'", "#39": "'", "#x27": "'", nbsp: " " })[name.toLowerCase()] ?? "")
    .replace(/&amp;/gi, "&");
}
/** How long a sign-in card stays the one to use before asking again posts a new one. */
const SIGNIN_CARD_FRESH_MS = 30 * 60_000;

function clip(text: string, limit = MAX_TOOL_RESULT) {
  return text.length > limit ? `${text.slice(0, limit)}\n[… ${text.length - limit} more characters]` : text;
}

export const TOOL_NOTES = [
  "set_profile changes your own name, job title, how you work (your SOUL), mascot colour or expression, and whether you are the Chief of Staff. When the person tells you who you are or what you do from now on, update your description with it so your SOUL.md carries it. When they tell you that you are the Chief of Staff, or to coordinate the team, call it with chiefOfStaff: true and a description of the new role. Use it too when the person gives you a lasting new job.",
  "memory_update replaces MEMORY.md, the notes that load into every turn. Keep it under a few hundred lines: stable preferences, how the person works, what you learned. You can also edit it, and memory/<topic>.md, with your own file tools; they live in your home folder.",
  "send_file hands the person a file from the computer as a download in this conversation (a document, an HTML page, an image, a spreadsheet, up to 100 MB). When the person asks for a file, or a teammate made one for them, send it; don't only say where it is on the computer.",
  "Your reply is what you write after your last tool call. Make your calls first (handoffs included), then write the whole answer; don't end a turn on a tool call with the answer half written before it.",
  "post_message adds a line to the conversation you are in before your final answer, e.g. to say what you are starting on. Your final answer is posted for you; don't repeat it.",
  "list_bots shows the team with each bot's id, job and whether it is busy.",
  "message_bot posts to a teammate's own conversation (its 1:1 with the person) and returns at once; the teammate answers there. Use it to hand something over without waiting.",
  "delegate_bot hands a teammate a self-contained brief (outcome, sources, constraints, deliverable, review point) in its own conversation and returns immediately. The result comes back to you here as a new message from that teammate; report it to the person then, not before. When you hand on part of a task that was handed to you, it stays open: the results come back to you, and your reply once the last of them is in is what goes back to whoever handed it to you, so don't relay results with message_bot.",
  "list_handoffs is the truth about what you handed out: check it before you tell anyone what is in flight or done, and before you plan the next round. When the plan changes under a brief that is out, amend_handoff replaces it and cancel_handoff withdraws it; don't send a second brief and leave the teammate to guess which one wins.",
  "follow_up wakes you later in this conversation with a note to yourself. Use it when you are waiting on something that doesn't message you (a build, a deadline, a quiet teammate) so the work carries on without the person having to nudge you.",
  "read_conversation reads a teammate's conversation or a room, and search_messages searches everything said in the person's conversations: use them to see where work got to instead of asking.",
  "ask_bot asks a teammate a short question and waits for the answer. Only for a consultation you need before you can reply; never for assigned work.",
  "create_room opens a group chat with teammates (and you and the person) when the person asks for one or a discussion needs several of you at once; its first message @mentions who should answer. For assigned work, delegate_bot is still the way: its result comes back to you, a room's talk doesn't.",
  "create_bot adds a new teammate when the person asks for one: a name, a job title, a description of how it works (what it owns, sources, boundaries, what it returns; it becomes its SOUL), and optionally a mascot colour, expression and connected apps. Then brief it with delegate_bot if there is work for it.",
  "update_bot changes a teammate's profile when the person asks you to: its name, title, description (its SOUL), mascot colour or expression. 'Make @Web Designer a Coder' means title: Coder and a matching description.",
  "Those are every bot's, not only the Chief of Staff's: who adds teammates and hands out work is a matter of the job, not of what you are allowed to call. Unless you are the Chief of Staff, use them when the person asks you to, not on your own.",
  "create_routine schedules a prompt for yourself on a cron in the person's time zone, paused until they turn it on unless they asked for it in this conversation. list_routines shows yours; update_routine changes or pauses one, delete_routine removes it, run_routine runs it once now.",
  "Connected-app tools (names starting with the app, like GMAIL_SEND_EMAIL) act on the person's real accounts. Reads go through; writes may wait for the person's approval. Say what you sent, created or changed.",
  "team_memory_update replaces the team memory (its path is in the Team memory section), shared by every bot of the person. Keep it to what the whole team needs.",
  "use_skill returns a skill's full instructions and its files by slug. save_skill adds one to the person's library: best from a folder you built in your home (SKILL.md with name and description frontmatter, then the Markdown instructions: steps, decision rules, expected output, what to check with the person first, and how to run each script; beside it scripts/, references/, assets/), or a .skill file, or instructions and text files in the call. update_skill changes one. Every one of the person's bots gets it at once, at ~/.skills/<slug>/.",
  "connect_app connects one of the person's own apps (in their Composio project): it checks whether Kru can connect it through Composio, asks for their Composio key with a masked card when there isn't one yet (set_composio_key does that on its own), and posts a Connect card they tap to sign in. When the app isn't there but has an MCP server, use add_mcp_server with its URL (from the person, or its official docs; never guess one): it asks the person to approve, adds the server and gives it to you, and posts a Sign in card when the server needs one. A server that runs as a command on the computer (like `uv run -m some_mcp`) goes in with add_mcp_server too: install it first, check it starts, then give the command and its args with absolute paths or names on PATH (~/.local/bin is on it) and any environment it needs, never a secret. Its tools reach you on your next reply; the person gives it to other bots in their profiles.",
  "request_secret asks the person for a secret by name (like STRIPE_API_KEY) with a reason; the value is stored for injection and you never see it. list_secrets shows the names that exist. set_composio_key asks for their Composio API key the same way and turns connected apps on; never ask for either as plain text in the conversation.",
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
  /** Stops the turn answering a message, if one is; the responder supplies it. */
  stopWork: (messageId: string) => Promise<boolean>;
  /** Whether a bot is mid-turn in a conversation. */
  isWorking: (botId: string, threadId: string) => boolean;
  /** The turn's own signal: an approval it waits on closes when the turn is stopped. */
  signal?: AbortSignal;
};

const schema = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false });

/** The profile fields a bot may change, checked; an unknown colour or expression is an error, not a silent skip. */
function profilePatch(input: Record<string, unknown>): { name?: string; title?: string; description?: string; color?: string; expression?: BotExpression; isChief?: boolean } | { error: string } {
  const patch: { name?: string; title?: string; description?: string; color?: string; expression?: BotExpression } = {};
  if (typeof input.name === "string" && input.name.trim()) patch.name = plainText(input.name).trim().slice(0, 40);
  if (typeof input.title === "string") patch.title = plainText(input.title).trim().slice(0, 80);
  if (typeof input.description === "string") patch.description = plainText(input.description).trim().slice(0, 4000);
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

/** Text files a bot passed inline for a skill, checked. */
function inlineSkillFiles(given: unknown): BundleFile[] | { error: string } {
  if (given === undefined || given === null) return [];
  if (!Array.isArray(given)) return { error: "files must be a list of { path, content }" };
  const files: BundleFile[] = [];
  for (const item of given as { path?: unknown; content?: unknown }[]) {
    const path = skillFilePath(String(item?.path ?? ""));
    if (!path || typeof item?.content !== "string") return { error: `"${String(item?.path ?? "")}" isn't a usable file (a path inside the skill and text content)` };
    const data = new TextEncoder().encode(item.content);
    files.push({ path, data, executable: looksExecutable(data) });
  }
  return files;
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
   * A skill from what save_skill or update_skill was given: a folder or a
   * .skill on the computer (its SKILL.md read for whatever the call left
   * out), or instructions and text files passed in the call.
   */
  const skillBundleFrom = async (input: Record<string, unknown>): Promise<{ input: SkillInput; files: BundleFile[]; meta: string } | { error: string }> => {
    const folder = typeof input.folder === "string" ? input.folder.trim() : "";
    let parsed: ReturnType<typeof parseSkillMd> = { name: null, description: "", instructions: "", meta: "" };
    let files: BundleFile[] = [];
    let folderName: string | null = null;
    if (folder) {
      const relative = sharePath(folder, bot.id, boxHome(bot.userId));
      if (!relative) return { error: "the folder must be inside the person's home on the computer (~)" };
      const read = await readSkillFromBox(box, relative);
      if ("error" in read) return { error: read.error };
      if (read.skillMd === null && typeof input.instructions !== "string") return { error: `there's no SKILL.md in ${folder}. Write one (frontmatter with name and description, then the instructions) and try again` };
      if (read.skillMd !== null) parsed = parseSkillMd(read.skillMd);
      files = read.files;
      folderName = read.folder;
    } else {
      const inline = inlineSkillFiles(input.files);
      if ("error" in inline) return inline;
      files = inline;
    }
    if (containsSecret(Buffer.from(JSON.stringify([input.instructions ?? "", parsed.instructions])))) return { error: "the instructions contain a stored secret. Take it out; a skill asks for secrets with request_secret instead" };
    if (files.some((file) => containsSecret(file.data))) return { error: "a file contains a stored secret. Take it out; a skill asks for secrets with request_secret instead" };
    const name = (typeof input.name === "string" && input.name.trim() ? plainText(input.name).trim() : parsed.name ?? (folderName ? nameFromFolder(folderName) : "")).slice(0, SKILL_LIMITS.name);
    const description = (typeof input.description === "string" && input.description.trim() ? input.description.trim() : parsed.description).slice(0, SKILL_LIMITS.description);
    const instructions = (typeof input.instructions === "string" && input.instructions.trim() ? input.instructions.trim() : parsed.instructions).slice(0, SKILL_LIMITS.instructions);
    if (!name || !instructions) return { error: "a skill needs a name and instructions" };
    return { input: { name, description, instructions }, files, meta: parsed.meta };
  };
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
  const alreadyAttached = (server: McpServer) => `${server.name} is already attached (${server.url ?? joinCommandLine([server.command ?? "", ...server.args])})${server.enabled ? "" : ", but turned off under Settings → Apps → MCP servers"}.${notYours(server)}`;
  /** Saves an approved server and gives it to the bot that asked; the person gives it to others in their profiles. */
  const saveMcpServer = (input: McpServerInput): McpServer | string => {
    let server: McpServer;
    try {
      server = createMcpServer(input, bot.userId);
    } catch (error) {
      return `NOT added: ${/UNIQUE/.test(String(error)) ? "a server with that name exists" : "the server couldn't be saved"}.`;
    }
    const me = getBot(bot.id) ?? bot;
    updateBot(bot.id, { toolkits: [...new Set([...me.toolkits, mcpToolkit(server.id)])] });
    return server;
  };
  /**
   * A server that runs as a command on the computer, as the bot's owner. Its
   * command line and environment are visible there, so a stored secret in
   * either is refused rather than written out.
   */
  const addCommandServer = async (name: string, command: string, rawArgs: unknown, rawEnv: unknown): Promise<string> => {
    if (rawArgs !== undefined && (!Array.isArray(rawArgs) || rawArgs.some((a) => typeof a !== "string"))) return "NOT added: args is a list of strings, one argument each.";
    if (rawEnv !== undefined && (typeof rawEnv !== "object" || rawEnv === null || Array.isArray(rawEnv) || Object.values(rawEnv).some((v) => typeof v !== "string"))) return "NOT added: env maps names to string values.";
    const args = (rawArgs ?? []) as string[];
    const env = (rawEnv ?? {}) as Record<string, string>;
    const secrets = allSecretValues().filter((s) => s.length >= 8);
    if ([command, ...args, ...Object.values(env)].some((part) => secrets.some((secret) => part.includes(secret)))) return "NOT added: that holds a stored secret, and a command's arguments and environment are visible on the computer. A server that needs a key should be a remote one with the key in its headers.";
    const line = joinCommandLine([command, ...args]);
    const existing = listMcpServers(bot.userId).find((m) => m.name === name || (m.transport === "stdio" && joinCommandLine([m.command ?? "", ...m.args]) === line));
    if (existing) return alreadyAttached(existing);
    const checked = mcpServerInputSchema.safeParse({ name, transport: "stdio", command, args, env });
    if (!checked.success) return `NOT added: ${checked.error.issues[0]?.message ?? "bad server"}.`;
    const envNote = Object.keys(env).length ? ` with ${Object.keys(env).join(", ")} set` : "";
    const decision = await requestApproval({ bot, threadId: thread.id, signal: context.signal, tool: "add_mcp_server", input: { name, command, args, env }, summary: `Add the MCP server ${name} (runs ${line}${envNote}) and give it to ${bot.name}` });
    if (decision === "deny") return "NOT added: the person said no.";
    if (decision === "expired") return "NOT added: nobody approved it in time.";
    const server = saveMcpServer(checked.data);
    if (typeof server === "string") return server;
    return `Added ${name}; it starts with your next reply. If its tools don't appear then, run the command yourself to see why.`;
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
        postMessage({ threadId: thread.id, author: bot.id, body: hideSecrets(text.slice(0, 4000)), depth, answered: true });
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
        if (data.byteLength > MAX_SENT_FILE_BYTES) return `NOT sent: the file is larger than ${MAX_SENT_FILE_BYTES / 1024 / 1024} MB.`;
        if (containsSecret(data)) return "NOT sent: the file contains a stored secret. Take it out first.";
        const name = relative.split("/").pop() || "file";
        const file = storeAttachment({ name: name.slice(0, 200), mediaType: mediaTypeFor(name), data });
        const note = hideSecrets(String(input.note ?? "").trim().slice(0, 4000));
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
        postMessage({ threadId: target.threadId, author: bot.id, body: hideSecrets(text.slice(0, 8000)), depth, fromThreadId: thread.id });
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
      description: "Read a skill from the person's library by its slug (see the Skills list): its instructions and the files in its folder.",
      inputSchema: schema({ slug: { type: "string" } }, ["slug"]),
      execute: async (input) => {
        const skill = getSkillBySlug(bot.userId, String(input.slug ?? "").replace(/^\//, "").trim());
        if (!skill) return `No skill called "${String(input.slug ?? "")}". The library: ${listSkills(bot.userId).map((s) => `/${s.slug}`).join(", ") || "(empty)"}.`;
        await skillsReady(bot.userId);
        return clip(`# ${skill.name} (/${skill.slug})\n${skill.description}\n\n${skillBrief(skill)}`);
      },
    },
    save_skill: {
      description:
        "Save a skill to the person's library, for all of their bots to reuse, from a folder you built on the computer (SKILL.md plus scripts/, references/, assets/…), from a .skill file, or from instructions (and optional text files) given here. Use it when the person asks you to make something into a skill.",
      inputSchema: schema({
        folder: { type: "string", description: "The skill's folder on the computer, relative to your home (like skills/weekly-report) or ~/…, with SKILL.md in it; or a .skill / .zip file. Everything in it but hidden files, caches and virtualenvs is saved." },
        name: { type: "string", description: "Short, like 'Weekly pipeline review'. Taken from SKILL.md when a folder is given and this is left out." },
        description: { type: "string", description: "What it does and when to use it, one or two sentences." },
        instructions: { type: "string", description: "Markdown, when no folder is given: the steps, decision rules, expected output, what to check with the person first, and how to run each file." },
        files: {
          type: "array",
          description: "Text files to go with the instructions when no folder is given, like scripts/report.py.",
          items: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"], additionalProperties: false },
        },
      }),
      execute: async (input) => {
        const bundle = await skillBundleFrom(input);
        if ("error" in bundle) return `NOT saved: ${bundle.error}.`;
        try {
          const skill = createSkill(bot.userId, bundle.input, "bot", { files: bundle.files, meta: bundle.meta });
          await syncSkills(bot.userId);
          return `Saved as /${skill.slug}${skill.files.length ? ` with ${skill.files.length} file${skill.files.length === 1 ? "" : "s"} (${skill.files.map((f) => f.path).join(", ")}), now in ~/.skills/${skill.slug}/` : ""}. The person can hand it to any of their bots by typing /${skill.slug}, and edit or download it as a .skill under Settings → Skills. Tell them so in a line.`;
        } catch (error) {
          return `NOT saved: ${error instanceof Error ? error.message : "the skill couldn't be saved"}`;
        }
      },
    },
    update_skill: {
      description: "Change a skill in the person's library by its slug: new instructions, name or description, or its whole folder again from the computer. Only when the person asks, or to fix a skill you just saved.",
      inputSchema: schema(
        {
          slug: { type: "string" },
          folder: { type: "string", description: "A folder or .skill file to replace the skill with entirely (SKILL.md and every file)." },
          name: { type: "string" },
          description: { type: "string" },
          instructions: { type: "string", description: "New Markdown instructions; the files stay unless a folder or files are given." },
          files: {
            type: "array",
            description: "Text files to add or replace, like scripts/report.py; the others stay.",
            items: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"], additionalProperties: false },
          },
        },
        ["slug"],
      ),
      execute: async (input) => {
        const skill = getSkillBySlug(bot.userId, String(input.slug ?? "").replace(/^\//, "").trim());
        if (!skill) return `No skill called "${String(input.slug ?? "")}".`;
        try {
          if (typeof input.folder === "string" && input.folder.trim()) {
            const bundle = await skillBundleFrom({ ...input, name: input.name ?? skill.name });
            if ("error" in bundle) return `NOT changed: ${bundle.error}.`;
            updateSkill(skill.id, { ...bundle.input, files: bundle.files, meta: bundle.meta });
          } else {
            const patch: { name?: string; description?: string; instructions?: string } = {};
            if (typeof input.name === "string" && input.name.trim()) patch.name = input.name.trim().slice(0, SKILL_LIMITS.name);
            if (typeof input.description === "string") patch.description = input.description.trim().slice(0, SKILL_LIMITS.description);
            if (typeof input.instructions === "string" && input.instructions.trim()) patch.instructions = input.instructions.trim().slice(0, SKILL_LIMITS.instructions);
            const files = inlineSkillFiles(input.files);
            if ("error" in files) return `NOT changed: ${files.error}.`;
            if (files.length) {
              const byPath = new Map(skillFiles(skill.id).map((f) => [f.path, f]));
              for (const file of files) byPath.set(file.path, file);
              updateSkill(skill.id, { ...patch, files: [...byPath.values()] });
            } else updateSkill(skill.id, patch);
          }
        } catch (error) {
          return `NOT changed: ${error instanceof Error ? error.message : "the skill couldn't be saved"}`;
        }
        await syncSkills(bot.userId);
        const next = getSkill(skill.id)!;
        return `Updated /${next.slug}${next.files.length ? ` (files: ${next.files.map((f) => f.path).join(", ")})` : ""}.`;
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
        return "Stored. Connected apps are on. Connect one with connect_app; a free key comes from dashboard.composio.dev if they need another.";
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
        // Every toolkit Composio offers: the exact one when it is named, else the best the search finds.
        const catalog = await catalogIndex(bot.userId);
        const entry = exactApp(catalog, wanted) ?? searchIndex(catalog, wanted)[0];
        if (entry) {
          if (!composioConfigured(bot.userId)) {
            const key = await askComposioKey(`to connect ${entry.name} and your other apps`);
            if (key) return key;
          }
          postConnectCard(entry);
          return `A Connect card for ${entry.name} is in the conversation; the person taps it to sign in to ${entry.name}. Once they do, ask them to add ${entry.name} to your profile (Settings → the bot → Connected apps) so you get its tools.`;
        }
        return `${wanted} isn't among the apps Kru can connect through Composio. If it offers an MCP server, add it with add_mcp_server and its URL (the one the person gave you, or from the app's official docs; don't guess). A server that runs as a command on the computer goes in with add_mcp_server too, once it is installed. If it has neither, use the browser on the computer.`;
      },
    },
    add_mcp_server: {
      description: "Attach an MCP server, for an app connect_app can't connect: a remote one by its HTTP URL, or one that runs as a command on the computer (install it first and check it starts). The person approves it first; it is given to you, and the person can give it to other bots. When a remote server wants a sign-in, a Sign in card goes into the conversation. Its tools reach you from your next reply.",
      inputSchema: schema(
        {
          name: { type: "string", description: "What to call it, like robinhood or aseprite." },
          url: { type: "string", description: "A remote server's URL, exactly as the person or the app's docs give it, like https://mcp.example.com/mcp. Leave out for a command." },
          command: { type: "string", description: "A command server's program: an absolute path or a name on PATH, like /home/agent/.local/bin/uv or npx. Leave out for a URL." },
          args: { type: "array", items: { type: "string" }, description: "The command's arguments, one per item, unquoted; use absolute paths, since it starts in your folder." },
          env: { type: "object", additionalProperties: { type: "string" }, description: "Environment the command needs, like ASEPRITE_PATH. It is visible on the computer, so never a secret." },
        },
        ["name"],
      ),
      execute: async (input) => {
        const name = mcpServerName(String(input.name ?? ""));
        const url = String(input.url ?? "").trim();
        const command = String(input.command ?? "").trim();
        if (url && command) return "NOT added: give a URL or a command, not both.";
        if (!url && !command) return "NOT added: give the server's URL, or the command that starts it.";
        if (!name) return "NOT added: give the server a name, like the app's.";
        if (command) return addCommandServer(name, command, input.args, input.env);
        let parsed: URL;
        try {
          parsed = new URL(url);
        } catch {
          return "NOT added: that isn't a URL. Ask the person for the server's address.";
        }
        if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return "NOT added: an MCP server's URL starts with https://.";
        if (parsed.username || parsed.password) return "NOT added: leave credentials out of the URL. When the server needs a key, ask for it with request_secret and tell the person to put it in the server's headers under Settings → Apps → MCP servers.";
        const existing = listMcpServers(bot.userId).find((m) => m.name === name || m.url === parsed.href || m.url === url);
        if (existing) {
          if (existing.authStatus === "needed" && existing.enabled) {
            postSignInCard(existing);
            return `${existing.name} is already attached and needs the person to sign in; a Sign in card is in the conversation.${signInHow(existing)}${notYours(existing)}`;
          }
          return alreadyAttached(existing);
        }
        const checked = mcpServerInputSchema.safeParse({ name, transport: "http", url: parsed.href });
        if (!checked.success) return `NOT added: ${checked.error.issues[0]?.message ?? "bad server"}.`;
        const decision = await requestApproval({ bot, threadId: thread.id, signal: context.signal, tool: "add_mcp_server", input: { name, url: parsed.href }, summary: `Add the MCP server ${name} (${parsed.href}) and give it to ${bot.name}` });
        if (decision === "deny") return "NOT added: the person said no.";
        if (decision === "expired") return "NOT added: nobody approved it in time.";
        const server = saveMcpServer(checked.data);
        if (typeof server === "string") return server;
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
    update_routine: {
      description: "Change one of your routines: its name, cron, prompt, or whether it is on.",
      inputSchema: schema(
        {
          routine: { type: "string", description: "Its id or name (list_routines)." },
          name: { type: "string" },
          cron: { type: "string", description: "minute hour day-of-month month day-of-week" },
          prompt: { type: "string" },
          enabled: { type: "boolean", description: "Turn it on only when the person asked for that; pause it freely." },
        },
        ["routine"],
      ),
      execute: async (input) => {
        const routine = ownRoutine(String(input.routine ?? ""));
        if (!routine) return `NOT changed: you have no routine "${String(input.routine ?? "")}". Use list_routines.`;
        const patch: { name?: string; cron?: string; prompt?: string; enabled?: boolean } = {};
        if (typeof input.name === "string" && input.name.trim()) patch.name = input.name.trim().slice(0, 80);
        if (typeof input.prompt === "string" && input.prompt.trim()) patch.prompt = input.prompt.trim().slice(0, 4000);
        if (typeof input.enabled === "boolean") patch.enabled = input.enabled;
        if (typeof input.cron === "string" && input.cron.trim()) {
          try {
            previewRuns(input.cron.trim(), routine.timezone, 1);
          } catch (error) {
            return `NOT changed: bad cron (${error instanceof Error ? error.message : "invalid"}).`;
          }
          patch.cron = input.cron.trim();
        }
        if (Object.keys(patch).length === 0) return "Nothing to change.";
        const updated = updateRoutine(routine.id, patch)!;
        return `Updated "${updated.name}" (${Object.keys(patch).join(", ")}): ${updated.enabled ? `on, next run ${updated.nextRunAt ?? "?"}` : "paused"}.`;
      },
    },
    delete_routine: {
      description: "Delete one of your routines for good. To stop it for a while, pause it with update_routine instead.",
      inputSchema: schema({ routine: { type: "string", description: "Its id or name (list_routines)." } }, ["routine"]),
      execute: async (input) => {
        const routine = ownRoutine(String(input.routine ?? ""));
        if (!routine) return `NOT deleted: you have no routine "${String(input.routine ?? "")}". Use list_routines.`;
        deleteRoutine(routine.id);
        return `Deleted "${routine.name}".`;
      },
    },
    run_routine: {
      description: "Run one of your routines now, once, whether it is on or paused. It runs in your own conversation after this reply.",
      inputSchema: schema({ routine: { type: "string", description: "Its id or name (list_routines)." } }, ["routine"]),
      execute: async (input) => {
        const routine = ownRoutine(String(input.routine ?? ""));
        if (!routine) return `NOT run: you have no routine "${String(input.routine ?? "")}". Use list_routines.`;
        const posted = postMessage({ threadId: bot.threadId, author: "routine", body: routinePrompt(routine) });
        recordRoutineRun(routine.id, posted.id);
        return `"${routine.name}" is queued in your own conversation; it runs once you're free there.`;
      },
    },
    follow_up: {
      description: "Wake yourself later in this conversation: 'check on Bolt's build in 45 minutes'. When it is due you get a prompt with your note and carry on. With cancel, drops one you set.",
      inputSchema: schema({
        minutes: { type: "number", description: `How long from now, 1 to ${MAX_FOLLOW_UP_MINUTES}.` },
        note: { type: "string", description: "What to check or do then, for your future self." },
        cancel: { type: "string", description: "The id of a follow-up to drop instead." },
      }),
      execute: async (input) => {
        if (typeof input.cancel === "string" && input.cancel.trim()) {
          return cancelFollowUp(input.cancel.trim(), bot.id) ? "Dropped that follow-up." : "NOT dropped: you have no such follow-up waiting.";
        }
        const minutes = Number(input.minutes);
        if (!Number.isFinite(minutes) || minutes < 1 || minutes > MAX_FOLLOW_UP_MINUTES) return `NOT set: minutes must be between 1 and ${MAX_FOLLOW_UP_MINUTES}.`;
        const note = String(input.note ?? "").trim();
        if (!note) return "NOT set: say what to check then.";
        const waiting = listFollowUps(bot.id);
        if (waiting.length >= MAX_FOLLOW_UPS) return `NOT set: you already have ${waiting.length} follow-ups waiting (list_handoffs shows them). Drop one with cancel first.`;
        // A hidden prompt only reaches a bot in its own conversation, so a room's follow-up lands there.
        const where = thread.kind === "room" ? bot.threadId : thread.id;
        const followUp = createFollowUp({ botId: bot.id, threadId: where, note: `${note.slice(0, 2000)}${thread.kind === "room" ? ` (set in the room "${thread.name}")` : ""}`, dueAt: new Date(Date.now() + Math.round(minutes) * 60_000) });
        return `Set (id ${followUp.id}): you'll be woken at ${followUp.dueAt}${where !== thread.id ? " in your own conversation" : ""}.`;
      },
    },
    read_conversation: {
      description: "Read the latest messages in one of the person's conversations: a teammate's (by its name) or a room (by its name or id). Read-only.",
      inputSchema: schema({
        conversation: { type: "string", description: "A teammate's id, name or @handle, or a room's name or id." },
        limit: { type: "number", description: "How many messages, newest last; 20 when left out, at most 60." },
      }, ["conversation"]),
      execute: async (input) => {
        const ref = String(input.conversation ?? "").trim();
        const bots = listBots({ includeHidden: true, userId: bot.userId });
        const threads = listThreads({ userId: bot.userId });
        const teammate = findBot(ref, bots);
        const target =
          (teammate ? threads.find((t) => t.id === teammate.threadId) : undefined) ??
          threads.find((t) => t.id === ref) ??
          threads.find((t) => t.kind === "room" && t.name.toLowerCase() === ref.toLowerCase());
        if (!target) return `NOT found: no conversation "${ref}". Name a teammate, or a room (${threads.filter((t) => t.kind === "room").map((t) => `"${t.name}"`).join(", ") || "there are none"}).`;
        const limit = Math.min(Math.max(Math.round(Number(input.limit) || 20), 1), 60);
        const names = new Map(bots.map((b) => [b.id, b.name]));
        const lines = listMessages(target.id, { limit: limit * 2 })
          .filter((m) => m.kind !== "prompt" && m.kind !== "activity")
          .slice(-limit)
          .map((m) => {
            const who = m.author === "you" ? "Person" : m.author === "routine" ? "Routine" : m.author === "system" ? "Kru Bot" : `${names.get(m.author) ?? m.author}${m.author === bot.id ? " (you)" : ""}`;
            const body = m.body.length > 3000 ? `${m.body.slice(0, 3000)} [… ${m.body.length - 3000} more characters]` : m.body;
            return `[${ago(m.createdAt)}] ${who}: ${m.kind === "approval" ? `(asked for approval: ${body})` : body}`;
          });
        return clip(`${target.kind === "room" ? `Room "${target.name}"` : `${target.name}'s conversation`}, last ${lines.length} message${lines.length === 1 ? "" : "s"}:\n${lines.join("\n\n") || "(nothing said yet)"}`);
      },
    },
    search_messages: {
      description: "Search everything said in the person's conversations, yours and your teammates' and the rooms', newest first.",
      inputSchema: schema({ query: { type: "string" }, limit: { type: "number", description: "At most 30; 10 when left out." } }, ["query"]),
      execute: async (input) => {
        const query = String(input.query ?? "").trim().slice(0, 200);
        if (query.length < 2) return "NOT searched: give at least two characters.";
        const limit = Math.min(Math.max(Math.round(Number(input.limit) || 10), 1), 30);
        const names = new Map(listBots({ includeHidden: true, userId: bot.userId }).map((b) => [b.id, b.name]));
        const threads = new Map(listThreads({ userId: bot.userId }).map((t) => [t.id, t]));
        const found = searchMessages(query, bot.userId, limit);
        if (found.length === 0) return `Nothing said matches "${query}".`;
        return clip(
          found
            .map((m) => {
              const where = threads.get(m.threadId);
              const who = m.author === "you" ? "Person" : m.author === "routine" ? "Routine" : m.author === "system" ? "Kru Bot" : (names.get(m.author) ?? m.author);
              return `- [${ago(m.createdAt)}] in ${where?.kind === "room" ? `the room "${where.name}"` : `${where?.name ?? "a conversation"}'s conversation`}, ${who}: ${snippetAround(m.body, query)}`;
            })
            .join("\n"),
        );
      },
    },
  };

  /** One of this bot's own routines, by id or name. */
  function ownRoutine(ref: string) {
    const mine = listRoutines(bot.id);
    return mine.find((r) => r.id === ref) ?? mine.find((r) => r.name.toLowerCase() === ref.trim().toLowerCase()) ?? null;
  }
}

/**
 * The tools a bot uses on the team around it: hand work over, ask, add a
 * teammate, change one's profile. Every bot has them; the Chief of Staff is
 * the one whose job it is to use them (see its SOUL and the house rules),
 * not the only one who may.
 */
export function teamTools(context: Context): Record<string, DriverTool> {
  const { bot, thread, message, askBot } = context;
  const depth = message.depth + 1;
  const team = () => listBots({ includeHidden: true, userId: bot.userId });

  /**
   * Posts a brief in the teammate's conversation and opens the handoff. One
   * given out while this bot works on a handoff of its own is part of that
   * one, which then waits for its result.
   */
  const handOver = (target: Bot, given: string, parentId = handoffWorkedOn(message.id)?.id ?? null) => {
    const brief = hideSecrets(given);
    const posted = postMessage({ threadId: target.threadId, author: bot.id, body: brief.slice(0, 12_000), depth, fromThreadId: thread.id });
    return createDelegation({ fromBotId: bot.id, fromThreadId: thread.id, toBotId: target.id, toThreadId: target.threadId, messageId: posted.id, brief, parentId });
  };

  /** One of this bot's open handoffs: by its id, or the only one open to a teammate. */
  const openHandoff = (ref: string): Delegation | string => {
    const byId = getDelegation(ref.trim());
    if (byId) return byId.fromBotId === bot.id && byId.status === "open" ? byId : byId.fromBotId === bot.id ? `that handoff is already ${byId.status}.` : "that handoff isn't yours.";
    const target = findBot(ref, team());
    if (!target) return `no handoff or teammate "${ref}". Use list_handoffs.`;
    const open = listDelegationsForBot(bot.id, new Date().toISOString()).filter((d) => d.fromBotId === bot.id && d.toBotId === target.id && d.status === "open");
    if (open.length === 0) return `you have no open handoff to ${target.name}.`;
    if (open.length > 1) return `you have ${open.length} open handoffs to ${target.name}; name one by id (list_handoffs).`;
    return open[0]!;
  };

  /** Closes a handoff, stops the teammate if it is on it, and tells it so in its conversation. */
  const withdraw = async (handoff: Delegation, why: string) => {
    finishDelegation(handoff.id, "cancelled", why);
    // Stopped mid-turn, or never started: either way that brief is not to be answered.
    if (!(await context.stopWork(handoff.messageId))) markAnswered(handoff.messageId);
    const to = getBot(handoff.toBotId);
    postMessage({ threadId: handoff.toThreadId, author: bot.id, body: `I've withdrawn the task I handed you ${ago(handoff.createdAt)} ("${oneLineOf(handoff.brief, 120)}"): ${why}`, depth, fromThreadId: thread.id, answered: true });
    return to;
  };

  return {
    delegate_bot: {
      description: "Hand a teammate a self-contained brief in its own conversation. Returns at once; the result comes back to you here.",
      inputSchema: schema({ bot: { type: "string", description: "The teammate's id, name or @handle." }, brief: { type: "string" } }, ["bot", "brief"]),
      execute: async (input) => {
        if (depth > MAX_CHAIN) return "NOT delegated: too many bot-to-bot hops, so nothing was sent. Tell the person the handoff didn't go out and ask them to send it on.";
        const target = findBot(String(input.bot ?? ""), listBots({ includeHidden: true, userId: bot.userId }));
        if (!target) return `NOT delegated: no bot called "${String(input.bot ?? "")}". Use list_bots.`;
        if (target.id === bot.id) return "NOT delegated: that's you.";
        const brief = String(input.brief ?? "").trim();
        if (!brief) return "NOT delegated: empty brief.";
        const handoff = handOver(target, brief);
        postMessage({ threadId: thread.id, author: "system", kind: "event", body: `${bot.name} handed a task to ${target.name}.`, answered: true });
        return `Assigned to ${target.name} (handoff ${handoff.id}). Its result will arrive here as a message from ${target.name}. When your handoffs are out, finish with your reply to the person; say what went to whom.`;
      },
    },
    list_handoffs: {
      description: "What you handed out and what was handed to you: open ones, and those finished in the last day with their results. Also your follow-ups still to come. With id, one handoff's full brief and result.",
      inputSchema: schema({ id: { type: "string", description: "A handoff's id, for its full brief and result." } }),
      execute: async (input) => {
        const names = new Map(team().map((b) => [b.id, b.name]));
        if (typeof input.id === "string" && input.id.trim()) {
          const one = getDelegation(input.id.trim());
          if (!one || (one.fromBotId !== bot.id && one.toBotId !== bot.id)) return "NOT found: no such handoff of yours.";
          return clip(`Handoff ${one.id}, ${names.get(one.fromBotId) ?? "?"} → ${names.get(one.toBotId) ?? "?"}, ${one.status}, handed over ${ago(one.createdAt)}${one.finishedAt ? `, closed ${ago(one.finishedAt)}` : ""}.\n\nBrief:\n${one.brief}${one.result ? `\n\nResult:\n${one.result}` : ""}`);
        }
        const all = listDelegationsForBot(bot.id, new Date(Date.now() - HANDOFF_WINDOW_MS).toISOString());
        const waitingOn = (d: Delegation) => {
          const n = openChildren(d.id);
          return n ? `, waiting on ${n} handed on` : "";
        };
        const describe = (d: Delegation, other: string) => {
          const state =
            d.status === "open"
              ? `open, handed over ${ago(d.createdAt)}${context.isWorking(d.toBotId, d.toThreadId) ? ", being worked on now" : ""}${waitingOn(d)}${d.nudgedAt ? ", chased once" : ""}`
              : `${d.status === "cancelled" ? "withdrawn" : d.status} ${ago(d.finishedAt ?? d.createdAt)}`;
          const result = d.status === "done" && d.result ? `\n  result: ${oneLineOf(d.result, 300)}` : "";
          return `- ${d.id} · ${other} · ${state}\n  brief: ${oneLineOf(d.brief, 160)}${result}`;
        };
        const out = all.filter((d) => d.fromBotId === bot.id).map((d) => describe(d, `to ${names.get(d.toBotId) ?? "a removed bot"}`));
        const given = all.filter((d) => d.toBotId === bot.id).map((d) => describe(d, `from ${names.get(d.fromBotId) ?? "a removed bot"}`));
        const followUps = listFollowUps(bot.id).map((f) => `- ${f.id} · due ${f.dueAt} · ${oneLineOf(f.note, 160)}`);
        return clip(
          [
            `Handed out by you:\n${out.join("\n") || "(none in the last day)"}`,
            `Handed to you:\n${given.join("\n") || "(none in the last day)"}`,
            `Your follow-ups:\n${followUps.join("\n") || "(none)"}`,
          ].join("\n\n"),
        );
      },
    },
    cancel_handoff: {
      description: "Withdraw a brief you handed out that is no longer wanted: the teammate stops if it is working on it, hears why, and nothing comes back.",
      inputSchema: schema({ handoff: { type: "string", description: "Its id (list_handoffs), or the teammate when you have one open handoff to it." }, reason: { type: "string" } }, ["handoff", "reason"]),
      execute: async (input) => {
        const handoff = openHandoff(String(input.handoff ?? ""));
        if (typeof handoff === "string") return `NOT withdrawn: ${handoff}`;
        const reason = String(input.reason ?? "").trim().slice(0, 2000) || "it isn't needed any more.";
        const to = await withdraw(handoff, reason);
        postMessage({ threadId: thread.id, author: "system", kind: "event", body: `${bot.name} withdrew a task from ${to?.name ?? "a teammate"}.`, answered: true });
        return `Withdrawn from ${to?.name ?? "the teammate"}; it has been told why.`;
      },
    },
    amend_handoff: {
      description: "Replace a brief you handed out with a corrected one when the plan changed: the teammate stops the old one and gets the new brief, which replaces it on the board. Its work so far stays in its session and files.",
      inputSchema: schema({ handoff: { type: "string", description: "Its id (list_handoffs), or the teammate when you have one open handoff to it." }, brief: { type: "string", description: "The whole corrected brief, self-contained; say what changed." } }, ["handoff", "brief"]),
      execute: async (input) => {
        if (depth > MAX_CHAIN) return "NOT amended: too many bot-to-bot hops, so nothing was changed. Tell the person.";
        const handoff = openHandoff(String(input.handoff ?? ""));
        if (typeof handoff === "string") return `NOT amended: ${handoff}`;
        const brief = String(input.brief ?? "").trim();
        if (!brief) return "NOT amended: empty brief.";
        const target = getBot(handoff.toBotId);
        if (!target) return "NOT amended: that teammate is gone.";
        await withdraw(handoff, "a corrected brief follows and replaces it.");
        const next = handOver(target, `Updated brief, replacing the one from ${ago(handoff.createdAt)}. Keep what still holds from your work so far.\n\n${brief}`, handoff.parentId);
        postMessage({ threadId: thread.id, author: "system", kind: "event", body: `${bot.name} sent ${target.name} a corrected brief.`, answered: true });
        return `Sent ${target.name} the corrected brief (handoff ${next.id}, replacing ${handoff.id}). Its result comes back here.`;
      },
    },
    create_room: {
      description: "Open a group chat (a room) with teammates and you in it. With a first message, the teammates it names answer there; in a room only an @mention wakes a bot.",
      inputSchema: schema(
        {
          name: { type: "string", description: "The room's name, like Launch plan." },
          bots: { type: "array", items: { type: "string" }, description: "The teammates to add: ids, names or @handles. You are added too." },
          message: { type: "string", description: "Optional first message from you in the room; the teammates in it are @mentioned when you don't name any." },
        },
        ["name", "bots"],
      ),
      execute: async (input) => {
        const name = plainText(String(input.name ?? "")).trim().slice(0, 80);
        if (!name) return "NOT created: give the room a name.";
        const team = listBots({ userId: bot.userId });
        const asked = Array.isArray(input.bots) ? input.bots.map(String) : [];
        const invited: Bot[] = [];
        const unknown: string[] = [];
        for (const ref of asked) {
          const found = findBot(ref, team);
          if (!found) unknown.push(ref);
          else if (found.id !== bot.id && !invited.some((b) => b.id === found.id)) invited.push(found);
        }
        if (unknown.length) return `NOT created: no bot called ${unknown.map((r) => `"${r}"`).join(", ")}. Use list_bots.`;
        if (invited.length === 0) return "NOT created: name at least one teammate besides you.";
        if (invited.length >= MAX_ROOM_MEMBERS) return `NOT created: a room holds at most ${MAX_ROOM_MEMBERS} bots.`;
        const room = createRoom(name, [bot.id, ...invited.map((b) => b.id)], bot.userId);
        postMessage({ threadId: room.id, author: "system", kind: "event", body: `${bot.name} opened this room with ${invited.map((b) => b.name).join(", ")}. Mention a bot with @ to address it.`, answered: true });
        postMessage({ threadId: thread.id, author: "system", kind: "event", body: `${bot.name} opened the room "${name}".`, answered: true });
        const text = String(input.message ?? "").trim();
        if (text) postMessage({ threadId: room.id, author: bot.id, body: hideSecrets(roomOpener(text, invited).slice(0, 8000)), depth: message.depth, wake: true });
        return `Opened the room "${name}" (id ${room.id}) with ${invited.map((b) => b.name).join(", ")} and you.${text ? " Your message is posted; those it names answer there, and you answer there when they @mention you." : " Nothing is said there yet."} What is said there stays in the room: it doesn't come back to this conversation.`;
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
      const decision = await requestApproval({ bot, threadId: thread.id, signal: context.signal, tool, input });
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
          const decision = await requestApproval({ bot, threadId: thread.id, signal: context.signal, tool: slug, input, summary: `${tool.name}${first ? `: ${first[1].slice(0, 160)}` : ""}` });
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
