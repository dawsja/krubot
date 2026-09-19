import type { Approval, Bot } from "@krubot/shared";
import { approvalTimeoutMs } from "./config.ts";
import { addRule, createApproval, getApproval, listApprovals, listRules, resolveApproval } from "./data/approvals.ts";
import { getBot } from "./data/bots.ts";
import { postMessage } from "./data/threads.ts";
import { sendPush } from "./push.ts";

/*
 * The approval broker. Every consequential action a bot wants to take
 * comes here first: Claude Code's own permission prompts (a shell command,
 * a file edit, a web fetch) and connected-app actions alike. Depending on
 * the bot's approval level and the rules it has earned, the action goes
 * ahead, or a card lands in the conversation and the bot waits for the
 * person's answer.
 */

type Pending = { resolve: (decision: Decision) => void; timer: ReturnType<typeof setTimeout> };
export type Decision = "allow" | "deny" | "always" | "expired";

const holder = globalThis as typeof globalThis & { __kruPendingApprovals?: Map<string, Pending> };

function pending(): Map<string, Pending> {
  return (holder.__kruPendingApprovals ??= new Map());
}

/**
 * The rule that "Always allow" would save for this action: the tool name,
 * or for a shell command its first word as a prefix, like Claude Code's own
 * `Bash(git:*)` rules.
 */
export function ruleFor(tool: string, input: Record<string, unknown>): string {
  if (tool === "Bash" && typeof input.command === "string") {
    const first = input.command.trim().split(/\s+/)[0] ?? "";
    return first ? `Bash(${first}:*)` : "Bash";
  }
  return tool;
}

/** One line for the card: what the bot wants to do. */
export function summarize(tool: string, input: Record<string, unknown>): string {
  if (tool === "Bash" && typeof input.command === "string") return `Run: ${input.command.replace(/\s+/g, " ").slice(0, 300)}`;
  if ((tool === "Edit" || tool === "Write" || tool === "MultiEdit" || tool === "NotebookEdit") && typeof input.file_path === "string") return `${tool === "Write" ? "Write" : "Edit"} ${input.file_path}`;
  if (tool === "Read" && typeof input.file_path === "string") return `Read ${input.file_path}`;
  if (tool === "WebFetch" && typeof input.url === "string") return `Fetch ${input.url.slice(0, 200)}`;
  if (tool === "WebSearch" && typeof input.query === "string") return `Search the web for "${input.query.slice(0, 120)}"`;
  const first = Object.entries(input).find(([, v]) => typeof v === "string") as [string, string] | undefined;
  return first ? `${tool}: ${first[1].replace(/\s+/g, " ").slice(0, 200)}` : tool;
}

function ruleMatches(rule: string, tool: string, input: Record<string, unknown>): boolean {
  if (rule === tool) return true;
  const prefix = /^Bash\((.+):\*\)$/.exec(rule);
  if (prefix && tool === "Bash" && typeof input.command === "string") {
    return input.command.trim().startsWith(prefix[1]!);
  }
  return false;
}

/** Tools that read only: never worth a card, whatever the level. */
const READ_ONLY = new Set(["Read", "Glob", "Grep", "LS", "TodoRead", "TodoWrite", "Task", "WebSearch", "NotebookRead"]);
/** Edits inside the bot's own home are what "Auto-accept edits" accepts. */
const EDITS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/**
 * Asks, or doesn't. Resolves with the decision once the person answers, a
 * matching rule says yes, the level says nothing asks, or the wait runs
 * out. `always` counts as allow and saves the rule.
 */
export async function requestApproval(input: { bot: Bot; threadId: string; tool: string; input: Record<string, unknown>; summary?: string }): Promise<Decision> {
  const { threadId, tool } = input;
  /*
   * The level as it is right now, not as it was when the turn started: a
   * turn can run for minutes, and changing the level while a bot works is
   * exactly when a person does it.
   */
  const bot = getBot(input.bot.id) ?? input.bot;
  if (bot.approval === "full") return "allow";
  if (READ_ONLY.has(tool)) return "allow";
  if (bot.approval === "edits" && EDITS.has(tool)) return "allow";
  for (const rule of listRules(bot.id)) {
    if (ruleMatches(rule, tool, input.input)) return "allow";
  }
  const approval = createApproval({ botId: bot.id, threadId, tool, summary: input.summary ?? summarize(tool, input.input), input: input.input });
  postMessage({ threadId, author: bot.id, kind: "approval", body: approval.summary, approvalId: approval.id, answered: true });
  if (bot.notify) void sendPush({ title: `${bot.name} needs your approval`, body: approval.summary.slice(0, 140), url: `/app/t/${threadId}`, tag: threadId, threadId }, bot.userId);
  return new Promise<Decision>((resolve) => {
    const timer = setTimeout(() => {
      pending().delete(approval.id);
      resolveApproval(approval.id, "expired");
      resolve("expired");
    }, approvalTimeoutMs());
    pending().set(approval.id, { resolve, timer });
  });
}

/** The person's answer to a card. Returns the approval, or null when unknown. */
export function decide(id: string, decision: "allow" | "deny" | "always"): Approval | null {
  const approval = getApproval(id);
  if (!approval) return null;
  if (approval.status !== "pending") return approval;
  const rule = decision === "always" ? ruleFor(approval.tool, approval.input) : null;
  if (rule) addRule(approval.botId, rule);
  const resolved = resolveApproval(id, decision === "deny" ? "denied" : "allowed", rule);
  const waiter = pending().get(id);
  if (waiter) {
    clearTimeout(waiter.timer);
    pending().delete(id);
    waiter.resolve(decision);
  }
  return resolved;
}

/** Cards still open, oldest first. */
export function openApprovals(): Approval[] {
  return listApprovals({ status: "pending" }).reverse();
}
