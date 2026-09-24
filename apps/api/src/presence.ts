/*
 * Which conversation each open copy of the app has in front of the person,
 * reported by the page itself (`POST /api/push/viewing`). A reply to a
 * conversation you are reading needs no push: the service worker can't be
 * trusted to tell on every phone (iOS reports no window as focused, and
 * counts a push it received without showing it against the site), so the
 * API doesn't send one. A page renews its report while it stays in front;
 * one that vanishes without saying so (a phone locked mid-conversation)
 * lapses after VIEWING_TTL_MS. Memory only: a restart forgets, and the
 * pages report again within a heartbeat.
 */

/** How long a report holds without a renewal. The page renews every 20 seconds. */
export const VIEWING_TTL_MS = 60_000;

const views = new Map<string, { userId: string; threadId: string; until: number }>();

/** One copy of the app (`client`, its own random id) says what it shows now; null when nothing. */
export function markViewing(userId: string, client: string, threadId: string | null, now = Date.now()) {
  const key = `${userId}\0${client}`;
  if (threadId) views.set(key, { userId, threadId, until: now + VIEWING_TTL_MS });
  else views.delete(key);
}

/** Whether any copy of the app the person has open is showing this conversation right now. */
export function isViewing(userId: string, threadId: string, now = Date.now()): boolean {
  let found = false;
  for (const [key, view] of views) {
    if (view.until <= now) views.delete(key);
    else if (view.userId === userId && view.threadId === threadId) found = true;
  }
  return found;
}
