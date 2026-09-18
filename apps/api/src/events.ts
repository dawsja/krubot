import type { LiveEvent } from "@krubot/shared";

/*
 * What changed, as it happens: the data layer announces each write here and
 * the browser hears it over /api/events. The API is one process with one
 * database, so an in-memory list of listeners is the whole bus. Most events
 * carry no data, only what to fetch again; activity lines carry the line.
 */

type Listener = (event: LiveEvent) => void;

const holder = globalThis as typeof globalThis & { __kruLiveListeners?: Set<Listener> };

function listeners(): Set<Listener> {
  return (holder.__kruLiveListeners ??= new Set());
}

export function subscribe(listener: Listener): () => void {
  listeners().add(listener);
  return () => {
    listeners().delete(listener);
  };
}

export function emit(event: LiveEvent) {
  for (const listener of [...listeners()]) {
    try {
      listener(event);
    } catch {
      listeners().delete(listener);
    }
  }
}

export const botsChanged = () => emit({ topic: "bots" });
export const threadChanged = (threadId: string, cleared?: true) => {
  emit(cleared ? { topic: "thread", threadId, cleared } : { topic: "thread", threadId });
  emit({ topic: "bots" });
};
export const approvalsChanged = () => emit({ topic: "approvals" });
export const settingsChanged = () => emit({ topic: "settings" });
export const activity = (threadId: string, botId: string, line: string | null) => emit({ topic: "activity", threadId, botId, line });

export function listenerCount() {
  return listeners().size;
}
