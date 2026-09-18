import { handleOf, mentionsIn, type Bot, type Message, type Thread } from "@krubot/shared";
import { boxConfig, ensureBotHome, interruptAgent, writeBoxFile, type BoxConfig } from "./box.ts";
import { isUpdating } from "./updater.ts";
import { defaultEffort } from "./config.ts";
import { getBot, getChief, listBots } from "./data/bots.ts";
import { delegationForMessage, finishDelegation } from "./data/delegations.ts";
import { allSecretValues } from "./data/secrets.ts";
import { getSettings, listConnections } from "./data/settings.ts";
import { listSkills } from "./data/skills.ts";
import { getAttachment, getThread, markAnswered, postMessage, releaseClaim } from "./data/threads.ts";
import { cliTurn } from "./driver.ts";
import { EngineSetupError, engineRun } from "./engines.ts";
import { activity } from "./events.ts";
import { boxMcpServers, mcpServersFor } from "./mcp.ts";
import { soulPath, TEAM_MEMORY_PATH } from "./memory.ts";
import { sendPush } from "./push.ts";
import { createRedactor, redact } from "./redact.ts";
import { skillsFor, skillsIndex } from "./skills.ts";
import { renderSoul, systemPromptFor } from "./souls.ts";
import { appTools, baseTools, CHIEF_TOOL_NOTES, chiefTools, loadMemory, loadTeamMemory, MAX_CHAIN, permissionTool, TOOL_NOTES, transcript } from "./tools.ts";

/*
 * A bot's turn: the SOUL as the system prompt, the last few dozen lines of
 * the conversation as context, the team's tools in hand, and one reply
 * posted at the end. Runs on the bot's persistent CLI session in the box
 * (Claude Code, Codex or Grok, as Settings → AI says), so the bot
 * remembers the conversation between turns even when its process was
 * closed in between.
 */

/** Lines of a conversation a bot reads before answering. */
const CONTEXT_LINES = 30;
/** Longest one reply may take: real work happens in the box. */
const TURN_TIMEOUT_MS = 45 * 60 * 1000;

type Active = { botId: string; threadId: string; controller: AbortController; startedAt: number };
const holder = globalThis as typeof globalThis & { __kruActiveTurns?: Map<string, Active> };

/** Turns in flight, by agent id (bot + thread). */
export function activeTurns(): Map<string, Active> {
  return (holder.__kruActiveTurns ??= new Map());
}

export function agentIdFor(bot: Bot, thread: Thread) {
  return `${bot.id}--${thread.id}`;
}

export function isBusy(botId: string, threadId?: string) {
  for (const turn of activeTurns().values()) {
    if (turn.botId === botId && (!threadId || turn.threadId === threadId)) return true;
  }
  return false;
}

/** Stops whatever a bot is doing in a thread. */
export async function interrupt(threadId: string) {
  const box = boxConfig();
  let stopped = 0;
  for (const [agentId, turn] of activeTurns()) {
    if (turn.threadId !== threadId) continue;
    turn.controller.abort();
    if (box) await interruptAgent(box, agentId).catch(() => undefined);
    stopped += 1;
  }
  return stopped;
}

/** The bots a message is for: the thread's bot, or the mentioned members of a room. */
export function targetsFor(message: Message, thread: Thread, bots: Bot[]): Bot[] {
  const members = thread.members.map((id) => bots.find((b) => b.id === id)).filter((b): b is Bot => Boolean(b) && !b!.hidden);
  if (thread.kind === "bot") return members.filter((b) => b.id !== message.author);
  const mentioned = mentionsIn(message.body);
  const named = members.filter((b) => mentioned.includes(handleOf(b.name)) && b.id !== message.author);
  if (mentioned.includes("everyone") || mentioned.includes("all")) return members.filter((b) => b.id !== message.author);
  if (named.length) return named;
  // Nobody named: the room's Chief of Staff answers, else the first member.
  if (message.author !== "you") return [];
  const chief = members.find((b) => b.isChief);
  return chief ? [chief] : members.slice(0, 1);
}

/** Writes the bot's SOUL.md to its home, so it can read it (and you can edit it). */
export async function syncSoul(bot: Bot) {
  const box = boxConfig();
  if (!box) return;
  try {
    await ensureBotHome(box, bot.id);
    await writeBoxFile(box, soulPath(bot.id), renderSoul(bot));
  } catch (error) {
    console.warn(`[kru] could not write SOUL.md for ${bot.name}: ${error instanceof Error ? error.message : error}`);
  }
}

async function attachmentsFor(message: Message): Promise<{ name: string; mediaType: string; data: string }[]> {
  const out: { name: string; mediaType: string; data: string }[] = [];
  for (const meta of message.attachments) {
    const file = getAttachment(meta.id);
    if (!file) continue;
    if (file.meta.mediaType.startsWith("image/") || file.meta.mediaType === "application/pdf") {
      out.push({ name: file.meta.name, mediaType: file.meta.mediaType, data: Buffer.from(file.data).toString("base64") });
    }
  }
  return out;
}

/** Text files ride along inside the prompt. */
function textAttachments(message: Message): string {
  const parts: string[] = [];
  for (const meta of message.attachments) {
    if (!meta.mediaType.startsWith("text/") && meta.mediaType !== "application/json") continue;
    const file = getAttachment(meta.id);
    if (!file) continue;
    const text = Buffer.from(file.data).toString("utf8").slice(0, 60_000);
    parts.push(`<attachment name="${meta.name}">\n${text}\n</attachment>`);
  }
  return parts.join("\n");
}

function promptFor(bot: Bot, thread: Thread, message: Message, bots: Bot[]): string {
  const names = new Map(bots.map((b) => [b.id, b.name]));
  const who =
    message.author === "you"
      ? "the person"
      : message.author === "routine"
        ? "a scheduled routine"
        : message.author === "system"
          ? "Kru Bot itself (a system report, not the person)"
          : `${names.get(message.author) ?? message.author}, a teammate`;
  const history = transcript(thread, bots, bot, message, CONTEXT_LINES);
  const files = textAttachments(message);
  const from = message.fromThreadId && message.author !== "you" ? `\n\nThis message came from ${names.get(message.author) ?? "a teammate"}. Do the work it asks for and answer with the result; your answer goes back to them.` : "";
  return [
    `The conversation so far (newest last):\n${history}`,
    files,
    `Now answer the last message, which is from ${who}.${from}\n${message.author === "routine" ? "This is a scheduled routine: do the job and report, addressing the person." : ""}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/**
 * One bot answers one message. Posts the reply (or what went wrong) and
 * marks the message answered. A message that came from a teammate's
 * delegation reports back to that teammate's thread.
 */
export async function botTurn(bot: Bot, thread: Thread, message: Message): Promise<string> {
  const box = boxConfig();
  if (!box) {
    postMessage({ threadId: thread.id, author: "system", kind: "event", body: "No box is running, so no bot can work. Start the box container and set KRU_BOX_URL.", answered: true });
    return "";
  }
  if (isUpdating()) throw new Error("The computer is updating; the bots answer when it's back.");
  const agentId = agentIdFor(bot, thread);
  if (activeTurns().has(agentId)) throw new Error("already answering");
  const controller = new AbortController();
  activeTurns().set(agentId, { botId: bot.id, threadId: thread.id, controller, startedAt: Date.now() });
  activity(thread.id, bot.id, "Thinking…");
  const bots = listBots({ includeHidden: true, userId: thread.userId });
  const askBot = async (target: Bot, prompt: string, depth: number): Promise<string> => {
    if (depth > MAX_CHAIN) return "(too many bot-to-bot hops)";
    const targetThread = getThread(target.threadId);
    if (!targetThread) return "(no conversation)";
    const posted = postMessage({ threadId: target.threadId, author: bot.id, body: prompt, depth, fromThreadId: thread.id, answered: true });
    return botTurn(target, targetThread, posted).catch((error: unknown) => `(${target.name} could not answer: ${error instanceof Error ? error.message : "error"})`);
  };
  const context = { box, bot, thread, message, askBot, syncSoul };
  let reply = "";
  try {
    await ensureBotHome(box, bot.id);
    const [memory, teamMemory] = await Promise.all([loadMemory(box, bot.id), loadTeamMemory(box)]);
    const settings = getSettings();
    const skills = listSkills();
    const mcpServers = boxMcpServers(bot);
    // What a bot writes never carries a stored secret, whatever it managed to read.
    const hide = createRedactor(allSecretValues());
    const tools = {
      ...baseTools(context),
      ...(bot.isChief ? chiefTools(context) : {}),
      ...(await appTools(context)),
      permission: permissionTool(context),
    };
    const instructions = systemPromptFor(bot, {
      bots,
      thread,
      memory: memory.text,
      memoryTruncated: memory.truncated,
      teamMemory,
      connections: listConnections(),
      toolNotes: bot.isChief ? `${TOOL_NOTES}\n${CHIEF_TOOL_NOTES}` : TOOL_NOTES,
      timezone: settings.timezone,
      skillsIndex: skillsIndex(skills),
      skills: skillsFor(message.body, skills),
      mcpServers: mcpServersFor(bot).map((m) => (m.authStatus === "needed" ? `${m.name} (waiting for the person to sign in: Settings → Apps → MCP servers → ${m.name} → Sign in; its tools fail until then)` : m.authStatus === "error" ? `${m.name} (sign-in problem: ${m.authError ?? "unknown"})` : m.name)),
    });
    // One engine, model and effort for the whole team, chosen under Settings → AI.
    const run = engineRun(settings);
    const result = await cliTurn({
      box,
      agentId,
      botId: bot.id,
      engine: run.engine,
      access: run.access,
      modelId: run.model,
      effort: settings.effort ?? defaultEffort(),
      permission: bot.approval,
      instructions,
      prompt: promptFor(bot, thread, message, bots),
      attachments: await attachmentsFor(message),
      tools,
      mcpServers,
      timeoutMs: TURN_TIMEOUT_MS,
      signal: controller.signal,
      onLog: (line) => activity(thread.id, bot.id, hide(line)),
    });
    if (result.ok && result.text.trim()) {
      reply = hide(result.text.trim());
      postMessage({ threadId: thread.id, author: bot.id, body: reply, depth: message.depth + 1, answered: true });
      // A finished job for the person (not a teammate's ask) reaches their browser.
      if (bot.notify && (message.author === "you" || message.author === "routine")) {
        void sendPush({ title: bot.name, body: reply.replace(/\s+/g, " ").slice(0, 140), url: `/app/t/${thread.id}`, tag: thread.id, threadId: thread.id }, thread.userId);
      }
    } else if (controller.signal.aborted) {
      postMessage({ threadId: thread.id, author: "system", kind: "event", body: `${bot.name} was stopped.`, answered: true });
    } else {
      const detail = redact(result.error ?? (result.stopReason ? `stopped (${result.stopReason})` : "no reply"));
      postMessage({ threadId: thread.id, author: "system", kind: "event", body: `${bot.name} couldn't finish: ${detail.slice(0, 500)}`, answered: true });
      await raiseIncident(bot, thread, message, detail);
    }
  } catch (error) {
    const detail = redact(error instanceof Error ? error.message : "unknown error");
    postMessage({ threadId: thread.id, author: "system", kind: "event", body: `${bot.name} hit a problem: ${detail.slice(0, 500)}`, answered: true });
    // A setup the person has to fix isn't something the Chief of Staff can.
    if (!(error instanceof EngineSetupError)) await raiseIncident(bot, thread, message, detail);
  } finally {
    activeTurns().delete(agentId);
    activity(thread.id, bot.id, null);
    markAnswered(message.id);
  }
  await reportBack(bot, message, reply);
  return reply;
}

/** A teammate's answer to a delegated brief goes back to whoever briefed it. */
async function reportBack(bot: Bot, message: Message, reply: string) {
  const delegation = delegationForMessage(message.id);
  if (!delegation) return;
  finishDelegation(delegation.id, reply ? "done" : "failed", reply || "(no result)");
  const home = getThread(delegation.fromThreadId);
  if (!home) return;
  postMessage({
    threadId: home.id,
    author: bot.id,
    body: `Result for the task you handed me:\n\n${reply || "(I couldn't finish it; see my conversation for what went wrong.)"}`,
    depth: Math.min(message.depth + 1, MAX_CHAIN),
    fromThreadId: delegation.toThreadId,
  });
}

/** A broken run reaches the Chief of Staff, who hears first. */
async function raiseIncident(bot: Bot, thread: Thread, message: Message, detail: string) {
  const chief = getChief(thread.userId);
  if (!chief || chief.id === bot.id || message.depth >= MAX_CHAIN) return;
  const chiefThread = getThread(chief.threadId);
  if (!chiefThread) return;
  postMessage({
    threadId: chief.threadId,
    author: "system",
    body: `Incident: ${bot.name}'s run in "${thread.name}" stopped with: ${detail.slice(0, 600)}\n\nThe last request there was: "${message.body.slice(0, 400)}". Decide: send ${bot.name} a corrected brief with delegate_bot, or tell the person plainly what only they can fix. This report is from Kru Bot, not the person.`,
    depth: message.depth + 1,
    fromThreadId: thread.id,
  });
}

/**
 * Answers one pending message: finds its thread and targets and runs a
 * turn for each. Called by the dispatcher with a claimed message.
 */
export async function answerMessage(message: Message): Promise<void> {
  // The computer is updating: leave the message pending for when it's back.
  if (isUpdating()) {
    releaseClaim(message.id);
    return;
  }
  const thread = getThread(message.threadId);
  if (!thread) {
    markAnswered(message.id);
    return;
  }
  const bots = listBots({ includeHidden: true, userId: thread.userId });
  const targets = targetsFor(message, thread, bots).filter((b) => !isBusy(b.id, thread.id));
  if (targets.length === 0) {
    const anyTarget = targetsFor(message, thread, bots);
    if (anyTarget.length === 0) {
      markAnswered(message.id);
      return;
    }
    // Every target is busy in this thread: leave it for the next tick.
    releaseClaim(message.id);
    return;
  }
  await Promise.all(targets.map((bot) => botTurn(bot, thread, message).catch((error: unknown) => console.error(`[kru] ${bot.name} failed:`, error))));
}

export function botById(id: string) {
  return getBot(id);
}

export type { BoxConfig };
