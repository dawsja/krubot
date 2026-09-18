import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import webpush from "web-push";
import { appUrl, ensureDataDir } from "./config.ts";
import { listSubscriptions, removeSubscription } from "./data/push.ts";
import { emit } from "./events.ts";

/*
 * Browser notifications, the way Grok Bot tells you a bot finished or
 * needs input: Web Push to every browser that subscribed under Settings →
 * Notifications. The service worker in the web app shows the notification
 * and opens the conversation on click, and stays quiet when that
 * conversation is already in front of you. VAPID keys are created once
 * into the data directory.
 */

type Vapid = { publicKey: string; privateKey: string };
const holder = globalThis as typeof globalThis & { __kruVapid?: Vapid };

export function vapidKeys(): Vapid {
  if (holder.__kruVapid) return holder.__kruVapid;
  const file = path.join(ensureDataDir(), "vapid.json");
  let keys: Vapid;
  if (existsSync(file)) {
    keys = JSON.parse(readFileSync(file, "utf8")) as Vapid;
  } else {
    keys = webpush.generateVAPIDKeys();
    writeFileSync(file, `${JSON.stringify(keys)}\n`, { mode: 0o600 });
  }
  holder.__kruVapid = keys;
  return keys;
}

export type PushPayload = {
  title: string;
  body: string;
  /** Where a click goes, on the app's origin. */
  url: string;
  /** Groups notifications: one per conversation, the newest replacing the last. */
  tag: string;
  threadId: string;
};

/**
 * Sends to every browser the person subscribed; a subscription the service
 * rejects is dropped. The same notice goes out on /api/events for clients
 * that have no Web Push of their own (the Android app shows it as a phone
 * notification).
 */
export async function sendPush(payload: PushPayload, userId: string): Promise<number> {
  emit({ topic: "notify", userId, ...payload });
  const subscriptions = listSubscriptions(userId);
  if (subscriptions.length === 0) return 0;
  const keys = vapidKeys();
  const contact = `mailto:kru@${new URL(appUrl()).hostname || "localhost"}`;
  let sent = 0;
  await Promise.all(
    subscriptions.map(async (sub) => {
      try {
        await webpush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, JSON.stringify(payload), { vapidDetails: { subject: contact, publicKey: keys.publicKey, privateKey: keys.privateKey }, TTL: 60 * 60, urgency: "high" });
        sent += 1;
      } catch (error) {
        const status = (error as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) removeSubscription(sub.endpoint);
        else console.warn(`[kru] push failed (${status ?? "?"}): ${error instanceof Error ? error.message : error}`);
      }
    }),
  );
  return sent;
}
