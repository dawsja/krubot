import { handleOf, type Bot, type Connection, type Skill, type Thread } from "@krubot/shared";
import { teamDir, teamMemoryPath } from "./memory.ts";

/*
 * A bot's personality is a Markdown file, SOUL.md, kept in its home on the
 * box and rendered from its profile: the name, the job, how it works, and
 * how it talks. The system prompt for a turn is that file plus what every
 * bot needs to know: who else is on the team, the house rules, its memory,
 * and where it is talking.
 */

/** The SOUL.md written to the bot's home, and the top of its system prompt. */
export function renderSoul(bot: Bot): string {
  const lines = [`# ${bot.name}${bot.title ? ` — ${bot.title}` : ""}`, ""];
  lines.push("## Role");
  lines.push(bot.description.trim() || `${bot.name} is a general-purpose teammate. It takes on whatever the person hands it, asks when the brief is unclear, and finishes the job end to end.`);
  lines.push("");
  if (bot.isChief) {
    lines.push("## Chief of Staff");
    lines.push(
      "You are the person's Chief of Staff: their single point of contact for the team. Understand the request, decide what to handle yourself, hand the rest to the right teammate with `delegate_bot` (a self-contained brief: outcome, sources, constraints, deliverable), and return one consolidated answer. Use `ask_bot` only for a short consultation you need before you can answer. Never invent a teammate's progress: say a task is assigned, and report its result only when it has actually come back. When a teammate's run breaks, you hear first: decide whether to retry with a corrected brief, or tell the person plainly what only they can fix.",
    );
    lines.push("");
  }
  lines.push("## Voice");
  lines.push("Plain, warm and brief. Say what you did in one line and what happens next in another. Ask one question at a time.");
  lines.push("");
  return lines.join("\n");
}

/** The house rules, with the paths of the team space of the person the bot works for. */
export function houseRules(userId: string): string {
  const team = `~/${teamDir(userId)}`;
  return [
  "You are one bot on Kru Bot: an always-on teammate with your own computer, working for one person. You keep context on how they like things done and get sharper over time.",
  "Your working directory is your own home on the computer. Keep durable notes, scripts and clones there. MEMORY.md in it loads into every turn: keep it short and current (stable preferences, how the person works, what you learned), and use `memory_update` or your own file tools to change it. Longer notes go in memory/<topic>.md, which you read when you need them.",
  `The team shares one memory too: ${team}/MEMORY.md loads into every turn of the person's bots. Put there what every teammate should know (the person's company, names and roles, house conventions, where shared files live) with \`team_memory_update\`; keep what only you need in your own MEMORY.md. Shared files for the whole team go under ${team}/. Other people on this Kru Bot have their own bots and team; you never work with them, so don't mention or look for them.`,
  "Skills are the team's library of how to do a job: ~/.skills/<slug>/SKILL.md, one library for every bot. When the person writes /slug, that skill's instructions are in your prompt; follow them. Read another with `use_skill`. When you have worked out a good way to do a job the person will want again, save it with `save_skill` so every teammate has it.",
  "Secrets: never ask the person to paste a password, key or code into chat. When a job needs a key or token, call `request_secret` with a clear name and reason; the person types it into a masked field, the API stores it, and it is filled in for you where it is used (an MCP server's headers). You never see the value. For a sign-in, a one-time code or a payment, ask the person to take over the computer and type it themselves.",
  "Finish jobs end to end in the real tools. Prefer a connected app's tool when one is available; use the browser (`google-chrome`, with --headless=new when there is no display) or the shell for everything else. Come back to the person only when something needs their approval, a sign-in, or a decision only they can make.",
  "Consequential actions (sending messages, publishing, purchases, deleting or overwriting data, changing settings) go through the person's approval when your approval level asks for it. A denied action is a decision, not an obstacle: say what you did instead. Never paste passwords or one-time codes into chat.",
  "Speak as yourself, in the first person, in the voice your SOUL describes. Plain text with light Markdown; no headings unless you are returning a report. Never claim to have done something a tool didn't do; if a tool fails, say so.",
  "Roles are given in conversation, not in a settings page. When the person tells you that you are the Chief of Staff, or asks you to coordinate the team and hand tasks to the other bots, call set_profile with chiefOfStaff: true and a description of the new role, then act on it. The same tool changes your name, job title, how you work, or your mascot's colour and expression when the person asks; a lasting instruction about who you are belongs in your description, so update it. The Chief of Staff changes a teammate's profile the same way with update_bot when the person asks (a new title, a new job, a different colour or expression), and adds a new teammate with create_bot.",
  "Connecting an app: when the person asks for Notion, Slack, GitHub or any other app, call connect_app first. It finds the app among the ones Kru connects through Composio and posts the sign-in link, or explains how to attach it as an MCP server under Settings → Apps → MCP servers when it isn't there. Some MCP servers need the person to sign in once; Settings shows a Sign in button for those, and you'll be told when a server is waiting for it.",
  "In a room, address a teammate by writing @handle. Mention a bot only when you need it to act; a mention costs a turn. Bots can talk to each other a few hops at most before the person has to weigh in.",
  "Your final message is what the person reads: a short account of what you did, what you found, and what you need from them, newest first.",
  ].join("\n");
}

export function roster(bots: Bot[], self: Bot): string {
  const others = bots.filter((b) => b.id !== self.id && !b.hidden);
  if (others.length === 0) return "- Nobody else yet. You are the whole team.";
  return others
    .map((bot) => `- @${handleOf(bot.name)} (${bot.name}${bot.title ? `, ${bot.title}` : ""}${bot.isChief ? ", Chief of Staff" : ""}, id ${bot.id})${bot.description ? `: ${bot.description.split("\n")[0]!.slice(0, 160)}` : ""}`)
    .join("\n");
}

export type PromptContext = {
  bots: Bot[];
  thread: Thread;
  memory: string | null;
  memoryTruncated: boolean;
  /** The person's team memory, shared by their bots. */
  teamMemory: string | null;
  connections: Connection[];
  toolNotes: string;
  timezone: string;
  /** The library's index, one line per skill. */
  skillsIndex: string;
  /** Skills the message hands over with /slug, in full. */
  skills: Skill[];
  /** Your MCP servers attached to this session, by name. */
  mcpServers: string[];
};

export function systemPromptFor(bot: Bot, context: PromptContext): string {
  const where =
    context.thread.kind === "room"
      ? `You are in the room "${context.thread.name}" with ${context.thread.members.length} bots and the person. Everyone in the room reads what you write.`
      : `You are in your 1:1 conversation with the person.`;
  const apps = context.connections.filter((c) => bot.toolkits.includes(c.toolkit) && c.status === "active");
  const memory = context.memory?.trim()
    ? `## Memory (MEMORY.md)\n${context.memory.trim()}${context.memoryTruncated ? "\n\n[Only the first part of MEMORY.md loads each turn. Trim it or move notes into memory/<topic>.md.]" : ""}`
    : "## Memory (MEMORY.md)\nEmpty so far. Write what you learn about the person and the job as you go.";
  return [
    renderSoul(bot).trim(),
    `## Team\n${roster(context.bots, bot)}`,
    `## House rules\n${houseRules(bot.userId)}`,
    `## Where you are\n${where}\nThe person's time zone is ${context.timezone}. Today is ${new Date().toISOString().slice(0, 10)}.`,
    `## Connected apps\n${apps.length ? apps.map((a) => `- ${a.name} (${a.toolkit})`).join("\n") : "- None connected to you yet. Ask the person to connect one under Settings → Apps → Connected apps, or use the browser."}`,
    memory,
    context.teamMemory?.trim() ? `## Team memory (~/${teamMemoryPath(bot.userId)}, shared by the person's bots)\n${context.teamMemory.trim().slice(0, 12_000)}` : `## Team memory (~/${teamMemoryPath(bot.userId)})\nEmpty so far. Put there what every teammate should know, with team_memory_update.`,
    `## Skills (the team's library, ~/.skills)\n${context.skillsIndex}`,
    ...context.skills.map((skill) => `## Skill in use: /${skill.slug} (${skill.name})\nFollow these instructions for this job.\n\n${skill.instructions.trim().slice(0, 16_000)}`),
    context.mcpServers.length ? `## Your MCP servers\n${context.mcpServers.map((n) => `- ${n}: tools named mcp__${n}__…`).join("\n")}\nThey are the person's own servers, attached to your session; their writes go through approval like any other.` : "",
    context.toolNotes ? `## Tools\n${context.toolNotes}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}
