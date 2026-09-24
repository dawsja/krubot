import { handleOf, mentionsIn, type Bot, type ChatAttachment, type Message, type Thread } from "@krubot/shared";
import { boxConfig, ensureBotHome, interruptAgent, steerAgent, writeBoxFile, type BoxConfig } from "./box.ts";
import { isUpdating } from "./updater.ts";
import { getAi } from "./data/ai.ts";
import { getBot, getChief, listBots } from "./data/bots.ts";
import { type Delegation, finishDelegation, handoffWorkedOn, openChildren, openDelegationsFrom, openDelegationsTo } from "./data/delegations.ts";
import { cancelFollowUpsIn } from "./data/follow-ups.ts";
import { finishRoutineRun } from "./data/routines.ts";
import { recordUsage } from "./data/usage.ts";
import { allSecretValues } from "./data/secrets.ts";
import { getSettings, listConnections } from "./data/settings.ts";
import { listSkills } from "./data/skills.ts";
import { botLinesSincePerson, closePending, closeSentFrom, getAttachment, getMessage, getThread, listThreads, markAnswered, postMessage, releaseClaim, unsteer } from "./data/threads.ts";
import { computerTools } from "./computer.ts";
import { cliTurn } from "./driver.ts";
import { EngineSetupError, engineRun } from "./engines.ts";
import { activity } from "./events.ts";
import { boxMcpServers, mcpServersFor } from "./mcp.ts";
import { nativeTurn, SteerQueue } from "./native.ts";
import { soulPath } from "./memory.ts";
import { sendPush } from "./push.ts";
import { createRedactor } from "./redact.ts";
import { skillsFor, skillsIndex, skillsReady } from "./skills.ts";
import { renderSoul, systemPromptFor } from "./souls.ts";
import { usableBot } from "./toolkits.ts";
import { clearWork, clipOutput, recordStep, type StepUpdate } from "./work.ts";
import { appTools, baseTools, loadMemory, loadTeamMemory, MAX_CHAIN, MAX_ROOM_LINES, permissionTool, resultDepth, teamTools, TOOL_NOTES, transcript } from "./tools.ts";

/*
 * A bot's turn: the SOUL as the system prompt, the last few dozen lines of
 * the conversation as context, the team's tools in hand, and one reply
 * posted at the end. Runs on the bot's persistent CLI session in the box,
 * inside its owner's account there (Claude Code, Codex or Grok, as the
 * owner's Settings → AI says), so the bot remembers the conversation
 * between turns even when its process was closed in between.
 */

/** Lines of a conversation a bot reads before answering. */
const CONTEXT_LINES = 30;
/** Longest one reply may take: real work happens in the box. */
const TURN_TIMEOUT_MS = 45 * 60 * 1000;

type Active = {
  botId: string;
  threadId: string;
  userId: string;
  messageId: string;
  controller: AbortController;
  startedAt: number;
  /** Hands the person's words to this turn; false when it can't take them any more. */
  steer: (text: string) => Promise<boolean>;
};
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

/**
 * Why a turn was aborted, carried as the signal's reason: a person pressed
 * Stop (or a bot withdrew the task), or the computer is updating. Only the
 * second is something to pick up again; a stop is the person's decision.
 */
export type StopCause = "stopped" | "updating";

/** Why a turn's signal was aborted, or null when it wasn't. An abort without a reason is a stop. */
export function stopCauseOf(signal: AbortSignal): StopCause | null {
  if (!signal.aborted) return null;
  return signal.reason === "updating" ? "updating" : "stopped";
}

/**
 * What a turn that ended without an answer posts, and whether the Chief
 * of Staff hears of it. A stop is never an incident, whatever the engine
 * made of it: a CLI's stream just breaks, and that reads as an error. An
 * update says so itself. A setup only the person can fix isn't the
 * Chief's either.
 */
export function unansweredEnding(name: string, cause: StopCause | null, failure: string, setupError = false): { event: string | null; incident: boolean } {
  if (cause === "stopped") return { event: `${name} was stopped.`, incident: false };
  if (cause === "updating") return { event: null, incident: false };
  return { event: failure, incident: !setupError };
}

/** Thrown before a turn starts; the message it was for waits for the next tick. */
export class TurnNotStarted extends Error {}

/** Stops whatever a bot is doing in a thread. */
export async function interrupt(threadId: string) {
  let stopped = 0;
  for (const [agentId, turn] of activeTurns()) {
    if (turn.threadId !== threadId) continue;
    turn.controller.abort("stopped" satisfies StopCause);
    const box = boxConfig(turn.userId);
    if (box) await interruptAgent(box, agentId).catch(() => undefined);
    stopped += 1;
  }
  return stopped;
}

/** How long a stop waits for the turns it aborted to wind down before it clears up after them. */
const STOP_SETTLE_MS = 5_000;

/** Resolves once no turn is left in the thread, or after `ms`. */
async function settled(threadId: string, ms = STOP_SETTLE_MS) {
  const until = Date.now() + ms;
  while ([...activeTurns().values()].some((turn) => turn.threadId === threadId) && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 100));
}

/**
 * The work a conversation set going, stopped: the handoffs it gave out
 * (and theirs, down the chain), what it sent teammates that nobody has
 * picked up, and its follow-ups. `since` narrows a delegate's thread to
 * what it started for the handoff, not everything it ever did.
 */
async function stopWorkFrom(threadId: string, since: string | null, seen: Set<string>) {
  for (const handoff of openDelegationsFrom(threadId, since)) {
    finishDelegation(handoff.id, "cancelled", "Stopped by the person.");
    if (!(await interruptMessage(handoff.messageId))) markAnswered(handoff.messageId);
    if (seen.has(handoff.toThreadId)) continue;
    seen.add(handoff.toThreadId);
    await settled(handoff.toThreadId);
    await stopWorkFrom(handoff.toThreadId, handoff.createdAt, seen);
  }
  closeSentFrom(threadId, since);
  cancelFollowUpsIn(threadId, since);
}

/**
 * What the person's Stop does: the bots working in the conversation stop,
 * and so does everything that work set going, so nothing starts it again.
 * The turns go first and are given a moment to wind down (a tool call in
 * flight can still hand something out); then everything waiting there is
 * dropped, the person's own queued messages too, and the handoffs,
 * messages to teammates and follow-ups it started are called off. An
 * approval it was waiting on closes with its turn.
 */
export async function stopThread(threadId: string): Promise<{ stopped: number; dropped: number }> {
  const stopped = await interrupt(threadId);
  if (stopped) await settled(threadId);
  const dropped = closePending(threadId);
  await stopWorkFrom(threadId, null, new Set([threadId]));
  // A handoff here still open was waiting on the ones just called off, or its brief was just dropped.
  for (const handoff of openDelegationsTo(threadId)) closeStopped(handoff, getBot(handoff.toBotId)?.name ?? "The teammate");
  if (dropped) postMessage({ threadId, author: "system", kind: "event", body: `Stopped. ${dropped} waiting message${dropped === 1 ? " was" : "s were"} dropped.`, answered: true });
  return { stopped, dropped };
}

/** Stops a bot everywhere it works (its conversation, rooms, a teammate's ask), before it is deleted. */
export async function stopBot(bot: Bot) {
  await stopThread(bot.threadId);
  for (const [agentId, turn] of activeTurns()) {
    if (turn.botId !== bot.id) continue;
    turn.controller.abort("stopped" satisfies StopCause);
    const box = boxConfig(turn.userId);
    if (box) await interruptAgent(box, agentId).catch(() => undefined);
  }
}

/** Stop all: every conversation of the person's, and everything their bots set going. */
export async function stopAll(userId: string): Promise<{ stopped: number; dropped: number }> {
  const total = { stopped: 0, dropped: 0 };
  for (const thread of listThreads({ userId })) {
    const one = await stopThread(thread.id);
    total.stopped += one.stopped;
    total.dropped += one.dropped;
  }
  return total;
}

/** Stops the turn answering one message, if one is; true when it stopped one. */
export async function interruptMessage(messageId: string): Promise<boolean> {
  for (const [agentId, turn] of activeTurns()) {
    if (turn.messageId !== messageId) continue;
    turn.controller.abort("stopped" satisfies StopCause);
    const box = boxConfig(turn.userId);
    if (box) await interruptAgent(box, agentId).catch(() => undefined);
    return true;
  }
  return false;
}

/** How a running turn hears what the person sent while it worked. */
export function steerText(body: string): string {
  return `The person sent this while you were working:\n\n${body}\n\nIf it changes what you're doing, adjust course; otherwise keep it in mind and carry on. Don't start over: this is part of the same piece of work, and your answer at the end covers it.`;
}

/**
 * The turns a person's new message steers: every bot it is for is already
 * working in that conversation. Empty when any one of them isn't, and the
 * message is then answered the usual way, by a turn of its own.
 */
export function steerableTurns(thread: Thread, message: Pick<Message, "author" | "body">): Active[] {
  const targets = targetsFor(message, thread, listBots({ includeHidden: true, userId: thread.userId }));
  const running = [...activeTurns().values()].filter((turn) => turn.threadId === thread.id);
  const turns = targets.map((bot) => running.find((turn) => turn.botId === bot.id));
  return targets.length && turns.every(Boolean) ? (turns as Active[]) : [];
}

/** Hands a message to running turns; true when at least one took it. */
export async function steer(turns: Active[], body: string): Promise<boolean> {
  const taken = await Promise.all(turns.map((turn) => turn.steer(steerText(body)).catch(() => false)));
  return taken.some(Boolean);
}

/**
 * Posts what the person wrote. Said to bots that are already working, it
 * goes into that work (steering) rather than waiting for them to finish,
 * unless they asked for `after`. Files always wait, since a CLI can't take
 * them mid-turn. It is posted as steered first, so the dispatcher never
 * answers it as well, and put back to wait if no turn took it after all.
 */
export async function postFromPerson(thread: Thread, input: { body: string; attachments?: ChatAttachment[]; after?: boolean }): Promise<Message> {
  const turns = !input.after && !input.attachments?.length ? steerableTurns(thread, { author: "you", body: input.body }) : [];
  const message = postMessage({ threadId: thread.id, author: "you", body: input.body, attachments: input.attachments, steered: turns.length > 0 });
  if (turns.length && !(await steer(turns, input.body))) unsteer(message.id);
  return getMessage(message.id) ?? message;
}

/** The bots a message is for: the thread's bot, or the mentioned members of a room. */
export function targetsFor(message: Pick<Message, "author" | "body">, thread: Thread, bots: Bot[]): Bot[] {
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

/** Writes the bot's SOUL.md to its home, in its owner's account, so it can read it (and you can edit it). */
export async function syncSoul(bot: Bot) {
  const box = boxConfig(bot.userId);
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

export function promptFor(bot: Bot, thread: Thread, message: Message, bots: Bot[]): string {
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
  // A hidden prompt isn't part of the conversation's history, so its words go here.
  if (message.kind === "prompt") {
    return [`The conversation so far (newest last):\n${history || "(nothing yet)"}`, `Kru Bot, not the person, asks you this; nobody else sees it. Do it, and address your answer to the person:\n${message.body}`].join("\n\n");
  }
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
export async function botTurn(bot: Bot, thread: Thread, message: Message, parent?: AbortSignal): Promise<string> {
  // The bot works as its owner on the box: their account, their home, their sign-ins.
  const box = boxConfig(thread.userId);
  if (!box) {
    postMessage({ threadId: thread.id, author: "system", kind: "event", body: "No box is running, so no bot can work. Start the box container and set KRU_BOX_URL.", answered: true });
    if (message.author === "routine") finishRoutineRun(message.id, false);
    return "";
  }
  if (isUpdating()) throw new TurnNotStarted("The computer is updating; the bots answer when it's back.");
  const agentId = agentIdFor(bot, thread);
  if (activeTurns().has(agentId)) throw new TurnNotStarted("already answering");
  const controller = new AbortController();
  // Asked by another bot's turn (ask_bot): it ends when that one does, for the same reason.
  const follow = () => controller.abort(parent?.reason);
  if (parent?.aborted) follow();
  else parent?.addEventListener("abort", follow, { once: true });
  const active: Active = { botId: bot.id, threadId: thread.id, userId: thread.userId, messageId: message.id, controller, startedAt: Date.now(), steer: async () => false };
  activeTurns().set(agentId, active);
  const steers = new SteerQueue();
  clearWork(thread.id, bot.id);
  activity(thread.id, bot.id, "Thinking…");
  const bots = listBots({ includeHidden: true, userId: thread.userId });
  const askBot = async (target: Bot, prompt: string, depth: number): Promise<string> => {
    if (depth > MAX_CHAIN) return "(too many bot-to-bot hops)";
    const targetThread = getThread(target.threadId);
    if (!targetThread) return "(no conversation)";
    const posted = postMessage({ threadId: target.threadId, author: bot.id, body: prompt, depth, fromThreadId: thread.id, answered: true });
    // Its turn is part of this one: stopping this one stops it too.
    return botTurn(target, targetThread, posted, controller.signal).catch((error: unknown) => `(${target.name} could not answer: ${error instanceof Error ? error.message : "error"})`);
  };
  const context = { box, bot, thread, message, askBot, syncSoul, stopWork: interruptMessage, isWorking: isBusy, signal: controller.signal };
  let reply = "";
  let stopped = false;
  /** What broke, when the run was a handoff's: its result says so instead of an incident. */
  let broke: string | null = null;
  /**
   * No answer: say why, and when something broke (never for a stop) tell
   * whoever is to act on it: the bot that handed the task over, in the
   * result, or else the Chief of Staff.
   */
  const endUnanswered = async (failure: string, detail: string, setupError: boolean) => {
    const cause = stopCauseOf(controller.signal);
    stopped = cause === "stopped";
    const ending = unansweredEnding(bot.name, cause, failure, setupError);
    if (ending.event) postMessage({ threadId: thread.id, author: "system", kind: "event", body: ending.event, answered: true });
    if (!ending.incident) return;
    if (handoffWorkedOn(message.id)) broke = detail;
    else await raiseIncident(bot, thread, message, detail);
  };
  // What a bot writes never carries a stored secret, whatever it managed to read.
  const secrets = allSecretValues();
  const hide = createRedactor(secrets);
  // The same, uncut: a reply is kept whole, however long.
  const scrub = createRedactor(secrets, Infinity);
  // A work step is read like the line: never a secret, and never longer than the page keeps.
  const step = (update: StepUpdate) => {
    recordStep(thread.id, bot.id, {
      ...update,
      ...(update.title !== undefined ? { title: hide(update.title) } : {}),
      ...(update.detail ? { detail: clipOutput(scrub(update.detail)) } : {}),
      ...(update.output ? { output: scrub(update.output) } : {}),
    });
  };
  try {
    // Its home and its SOUL.md, made again if they aren't there: after a
    // reset the computer is empty, and the bot's own account with it.
    await syncSoul(bot);
    const [memory, teamMemory] = await Promise.all([loadMemory(box, bot.id), loadTeamMemory(box, bot.userId)]);
    const settings = getSettings();
    const skills = listSkills(bot.userId);
    await skillsReady(bot.userId);
    // The apps and servers its owner may use: un-sharing one takes it away here.
    const usable = usableBot(bot);
    const mcpServers = boxMcpServers(usable);
    // The owner's engine and model, chosen under their Settings → AI.
    const ai = getAi(thread.userId);
    const run = engineRun(ai, thread.userId);
    // The API engine's loop is here and reads the queue; a CLI's is on the box.
    active.steer = run.native ? async (text) => steers.push(text) : async (text) => (await steerAgent(box, agentId, text).catch(() => ({ steered: false }))).steered;
    /*
     * A CLI brings its own shell and file tools and asks the broker through
     * the `permission` tool; the API engine has neither, so it is
     * handed the computer here and every call is gated as it is made.
     */
    const tools = {
      ...baseTools(context),
      ...teamTools(context),
      ...(await appTools(context)),
      ...(run.native ? computerTools(context) : { permission: permissionTool(context) }),
    };
    const instructions = systemPromptFor(usable, {
      bots,
      thread,
      memory: memory.text,
      memoryTruncated: memory.truncated,
      teamMemory,
      connections: listConnections(bot.userId),
      toolNotes: TOOL_NOTES,
      timezone: settings.timezone,
      skillsIndex: skillsIndex(skills),
      skills: skillsFor(message.body, skills),
      // An MCP server is a CLI session's; calling an API directly reaches none of them.
      mcpServers: run.native ? [] : mcpServersFor(usable).map((m) => (m.authStatus === "needed" ? `${m.name} (waiting for the person to sign in: Settings → Apps → MCP servers → ${m.name} → Sign in; its tools fail until then)` : m.authStatus === "error" ? `${m.name} (sign-in problem: ${m.authError ?? "unknown"})` : m.name)),
    });
    // Stopped while it was getting ready: don't start the engine at all.
    controller.signal.throwIfAborted();
    const result = run.native
      ? await nativeTurn({
          access: run.native,
          model: run.model,
          instructions,
          prompt: promptFor(bot, thread, message, bots),
          attachments: await attachmentsFor(message),
          tools,
          signal: controller.signal,
          onLog: (line) => activity(thread.id, bot.id, hide(line)),
          onStep: step,
          steers,
        }).then((native) => ({ ...native, recovered: false, cost: null }))
      : await cliTurn({
      box,
      agentId,
      botId: bot.id,
      engine: run.engine,
      access: run.access,
      modelId: run.model,
      permission: bot.approval,
      instructions,
      prompt: promptFor(bot, thread, message, bots),
      attachments: await attachmentsFor(message),
      tools,
      mcpServers,
      timeoutMs: TURN_TIMEOUT_MS,
      signal: controller.signal,
      onLog: (line) => activity(thread.id, bot.id, hide(line)),
      onStep: step,
    });
    // What the turn used, answered or not: a failed turn still spent tokens.
    recordUsage({ userId: thread.userId, botId: bot.id, threadId: thread.id, engine: run.engine, model: run.model, usage: result.usage, cost: result.cost });
    if (result.ok && result.text.trim()) {
      reply = scrub(result.text.trim());
      postReply(bot, thread, message, reply);
      // A finished job for the person (not a teammate's ask) reaches their browser.
      if (bot.notify && (message.author === "you" || message.author === "routine")) {
        void sendPush({ title: bot.name, body: reply.replace(/\s+/g, " ").slice(0, 140), url: `/app/t/${thread.id}`, tag: thread.id, threadId: thread.id }, thread.userId);
      }
    } else {
      const detail = hide(result.error ?? (result.stopReason ? `stopped (${result.stopReason})` : "no reply"));
      await endUnanswered(`${bot.name} couldn't finish: ${detail.slice(0, 500)}`, detail, false);
    }
  } catch (error) {
    const detail = hide(error instanceof Error ? error.message : "unknown error");
    await endUnanswered(`${bot.name} hit a problem: ${detail.slice(0, 500)}`, detail, error instanceof EngineSetupError);
  } finally {
    parent?.removeEventListener("abort", follow);
    steers.shut();
    activeTurns().delete(agentId);
    clearWork(thread.id, bot.id);
    activity(thread.id, bot.id, null);
    markAnswered(message.id);
  }
  await reportBack(bot, message, reply, stopped, broke);
  if (message.author === "routine") finishRoutineRun(message.id, Boolean(reply));
  return reply;
}

/**
 * Posts a bot's reply. In a room, a reply that @mentions teammates wakes
 * them, so bots can talk there, up to MAX_ROOM_LINES since the person
 * last spoke; then the room waits for the person. The depth stays where
 * it was: room talk is a conversation, not a chain of briefs.
 */
function postReply(bot: Bot, thread: Thread, message: Message, reply: string) {
  const mentioned = thread.kind === "room" ? mentionsIn(reply) : [];
  const members = thread.kind === "room" ? thread.members.filter((id) => id !== bot.id) : [];
  const names = mentioned.includes("everyone") || mentioned.includes("all");
  const wakes = members.some((id) => {
    const member = getBot(id);
    return member && !member.hidden && (names || mentioned.includes(handleOf(member.name)));
  });
  if (!wakes) {
    postMessage({ threadId: thread.id, author: bot.id, body: reply, depth: message.depth + 1, answered: true });
    return;
  }
  const room = botLinesSincePerson(thread.id) < MAX_ROOM_LINES;
  postMessage({ threadId: thread.id, author: bot.id, body: reply, depth: message.depth, answered: !room, wake: room });
  if (!room) postMessage({ threadId: thread.id, author: "system", kind: "event", body: `The bots have said ${MAX_ROOM_LINES} things since you last wrote here, so the room waits for you. Write to carry on.`, answered: true });
}

/**
 * A teammate's answer to a delegated brief goes back to whoever briefed it.
 * A run that broke (`broke`, what went wrong) goes back the same way, as a
 * failed result a hop up: were it an incident a hop down, every "carry on"
 * brief after a long task timed out would sit two hops deeper than the last,
 * and the third would be refused.
 */
export async function reportBack(bot: Bot, message: Message, reply: string, stopped: boolean, broke: string | null = null) {
  const delegation = handoffWorkedOn(message.id);
  if (!delegation) return;
  // The person stopped it: the handoff is closed, and the bot that handed it
  // over hears so without being woken, so it doesn't start the work again.
  if (stopped) {
    closeStopped(delegation, bot.name);
    return;
  }
  // It handed part of the task on: the handoff stays open, and the turn that
  // takes in the last of those results reports back. Reporting now would
  // send "handed it to X" up the chain, and the real result would have to
  // follow as a message, a hop deeper each level.
  if (openChildren(delegation.id) > 0) return;
  const home = getThread(delegation.fromThreadId);
  const posted = home
    ? postMessage({
        threadId: home.id,
        author: bot.id,
        body: reply ? `Result for the task you handed me:\n\n${reply}` : failedResult(bot.name, broke),
        depth: resultDepth(getMessage(delegation.messageId)?.depth ?? message.depth),
        fromThreadId: delegation.toThreadId,
      })
    : null;
  finishDelegation(delegation.id, reply ? "done" : "failed", reply || "(no result)", posted?.id ?? null);
}

/** What a handoff whose run broke reports back, so the bot that gave it out can act on it. */
export function failedResult(name: string, broke: string | null): string {
  if (!broke) return "Result for the task you handed me:\n\n(I couldn't finish it; see my conversation for what went wrong.)";
  return `I couldn't finish the task you handed me: my run stopped with: ${broke.slice(0, 600)}\n\nWhat I did so far is in my conversation and my files. Decide: send ${name} a brief to carry on from there, or a corrected one, with delegate_bot; or tell the person plainly what only they can fix. This report is from Kru Bot, not the person.`;
}

/** A handoff whose teammate the person stopped: closed, and the bot that gave it out told without being woken. */
function closeStopped(delegation: Delegation, name: string) {
  finishDelegation(delegation.id, "cancelled", "Stopped by the person.");
  postMessage({ threadId: delegation.fromThreadId, author: "system", kind: "event", body: `${name} was stopped by the person, so the task handed to it is closed. Don't hand it out again unless they ask.`, answered: true });
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
  let notStarted = false;
  await Promise.all(
    targets.map((bot) =>
      botTurn(bot, thread, message).catch((error: unknown) => {
        if (error instanceof TurnNotStarted) notStarted = true;
        else console.error(`[kru] ${bot.name} failed:`, error);
      }),
    ),
  );
  // One of them couldn't start after all: the message goes back to wait, or it would sit claimed forever.
  if (notStarted) releaseClaim(message.id);
}

export function botById(id: string) {
  return getBot(id);
}

export type { BoxConfig };
