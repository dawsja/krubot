import { getBot } from "./data/bots.ts";
import { claimDueRoutines, recordRoutineRun, routinePrompt } from "./data/routines.ts";
import { getSettings } from "./data/settings.ts";
import { claimPendingMessages, postMessage, releaseClaim } from "./data/threads.ts";
import { randomString } from "./ids.ts";
import { activeTurns, answerMessage } from "./responder.ts";
import { chaseStalledDelegations } from "./nudges.ts";
import { isUpdating } from "./updater.ts";

/*
 * The team's heartbeat: one interval per process. Each tick answers the
 * messages nobody is answering yet, up to the concurrency limit, and fires
 * the routines that are due. Everything long-running is started here and
 * awaited elsewhere, so a tick itself is quick.
 */

type State = { timer: ReturnType<typeof setInterval> | null; owner: string; ticking: boolean; lastChase: number };
const holder = globalThis as typeof globalThis & { __kruDispatcher?: State };

function state(): State {
  return (holder.__kruDispatcher ??= { timer: null, owner: randomString(8), ticking: false, lastChase: 0 });
}

export const TICK_MS = 2_000;

export function startDispatcher(options: { intervalMs?: number } = {}) {
  const current = state();
  if (current.timer) return;
  current.timer = setInterval(() => void tick(), options.intervalMs ?? TICK_MS);
  console.info("[kru] Dispatcher started");
}

export function stopDispatcher() {
  const current = state();
  if (current.timer) clearInterval(current.timer);
  current.timer = null;
}

/** Fires every due routine by posting its prompt into the bot's conversation. */
export function runDueRoutines(at = new Date()) {
  for (const routine of claimDueRoutines(at)) {
    const bot = getBot(routine.botId);
    if (!bot || bot.hidden) continue;
    const posted = postMessage({ threadId: bot.threadId, author: "routine", body: routinePrompt(routine) });
    recordRoutineRun(routine.id, posted.id);
  }
}

export async function tick() {
  const current = state();
  if (current.ticking) return;
  current.ticking = true;
  try {
    runDueRoutines();
    if (Date.now() - current.lastChase > 60_000) {
      current.lastChase = Date.now();
      chaseStalledDelegations();
    }
    // While the computer updates, messages wait as pending and are answered after.
    if (isUpdating()) return;
    const room = Math.max(0, getSettings().concurrency - activeTurns().size);
    if (room === 0) return;
    const messages = claimPendingMessages(current.owner, room);
    for (const message of messages) {
      void answerMessage(message).catch((error: unknown) => {
        console.error(`[kru] answering ${message.id} failed:`, error);
        releaseClaim(message.id);
      });
    }
  } catch (error) {
    console.error("[kru] dispatcher tick failed:", error);
  } finally {
    current.ticking = false;
  }
}
