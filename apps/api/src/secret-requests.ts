import type { Bot, SecretRequest } from "@krubot/shared";
import { approvalTimeoutMs } from "./config.ts";
import { hasComposioKey } from "./data/composio-keys.ts";
import { createSecretRequest, hasSecret, resolveSecretRequest } from "./data/secrets.ts";
import { postMessage } from "./data/threads.ts";
import { sendPush } from "./push.ts";

/*
 * A bot asks for a secret; a card lands in the conversation; the person
 * types the value into a masked field; the store keeps it; the bot is told
 * it's there. Same shape as an approval, and the same wait. A request whose
 * target is `composio` fills the person's Composio project key instead, so
 * a bot can set up connected apps without sending them to Settings.
 */

type Pending = { resolve: (status: SecretRequest["status"]) => void; timer: ReturnType<typeof setTimeout> };
const holder = globalThis as typeof globalThis & { __kruPendingSecrets?: Map<string, Pending> };

function pending(): Map<string, Pending> {
  return (holder.__kruPendingSecrets ??= new Map());
}

export async function requestSecret(input: { bot: Bot; threadId: string; name: string; reason: string; target?: SecretRequest["target"] }): Promise<SecretRequest["status"] | "exists"> {
  const target = input.target ?? "secret";
  const already = target === "composio" ? hasComposioKey(input.bot.userId) : hasSecret(input.bot.userId, input.name);
  if (already) return "exists";
  const request = createSecretRequest({ botId: input.bot.id, threadId: input.threadId, name: input.name, reason: input.reason, target });
  postMessage({ threadId: input.threadId, author: input.bot.id, kind: "secret", body: `${input.name}: ${input.reason}`, approvalId: request.id, answered: true });
  if (input.bot.notify) void sendPush({ title: `${input.bot.name} needs a secret`, body: `${input.name}: ${input.reason}`.slice(0, 140), url: `/app/t/${input.threadId}`, tag: input.threadId, threadId: input.threadId }, input.bot.userId);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending().delete(request.id);
      resolveSecretRequest(request.id, "expired");
      resolve("expired");
    }, approvalTimeoutMs());
    pending().set(request.id, { resolve, timer });
  });
}

export function answerSecretRequest(id: string, status: "given" | "declined"): SecretRequest | null {
  const waiting = pending().get(id);
  const request = resolveSecretRequest(id, status);
  if (waiting) {
    clearTimeout(waiting.timer);
    pending().delete(id);
    waiting.resolve(status);
  }
  return request;
}
