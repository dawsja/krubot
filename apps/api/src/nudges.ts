import { getBot } from "./data/bots.ts";
import { listOpenDelegations, markEscalated, markNudged } from "./data/delegations.ts";
import { getThread, postMessage } from "./data/threads.ts";
import { isBusy } from "./responder.ts";

/*
 * Handoffs that stall get chased, the way a good chief of staff chases
 * them. A brief nobody has answered for a while gets a nudge from the bot
 * that wrote it, in the teammate's own conversation; if it still hasn't
 * come back after as long again, the wait is reported to the thread the
 * brief came from, once, so the person (or the Chief) can step in.
 */

/** How long a handoff may sit before the first nudge: KRU_NUDGE_MINUTES, default 120. */
export function nudgeAfterMs(): number {
  return Math.max(5, Number(process.env.KRU_NUDGE_MINUTES ?? 120) || 120) * 60_000;
}

export function chaseStalledDelegations(at = Date.now()): { nudged: number; escalated: number } {
  let nudged = 0;
  let escalated = 0;
  const wait = nudgeAfterMs();
  for (const delegation of listOpenDelegations()) {
    const from = getBot(delegation.fromBotId);
    const to = getBot(delegation.toBotId);
    if (!from || !to || to.hidden) continue;
    // A teammate still working on it isn't stalled.
    if (isBusy(to.id, delegation.toThreadId)) continue;
    const age = at - Date.parse(delegation.createdAt);
    if (!delegation.nudgedAt && age >= wait) {
      postMessage({
        threadId: delegation.toThreadId,
        author: from.id,
        body: `Checking in on the task I handed you ${Math.round(age / 3_600_000)}h ago: "${delegation.brief.slice(0, 240)}". Where does it stand? If something blocks you, say what you need.`,
        fromThreadId: delegation.fromThreadId,
        depth: 1,
      });
      markNudged(delegation.id);
      nudged += 1;
      continue;
    }
    if (delegation.nudgedAt && !delegation.escalatedAt && at - Date.parse(delegation.nudgedAt) >= wait) {
      const home = getThread(delegation.fromThreadId);
      if (home) {
        postMessage({
          threadId: home.id,
          author: "system",
          kind: "event",
          body: `${to.name} hasn't answered the task ${from.name} handed over (${delegation.brief.slice(0, 120)}…) after a nudge. It may need a clearer brief, or the person's help.`,
          answered: true,
        });
      }
      markEscalated(delegation.id);
      escalated += 1;
    }
  }
  return { nudged, escalated };
}
