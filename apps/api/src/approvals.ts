import { posix } from "node:path";
import type { Approval, Bot } from "@krubot/shared";
import { boxHome } from "./box.ts";
import { approvalTimeoutMs } from "./config.ts";
import { addRule, createApproval, getApproval, listApprovals, listRules, resolveApproval } from "./data/approvals.ts";
import { getBot } from "./data/bots.ts";
import { botHome } from "./memory.ts";
import { hideSecrets } from "./data/secrets.ts";
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
 * The rule that "Always allow" would save for this action: for a shell
 * command its first word, like Claude Code's own `Bash(git:*)` rules; for
 * a file change the folder it is in, `Edit(<folder>/**)`, so saying yes to
 * one file never says yes to every file; otherwise the tool name.
 */
export function ruleFor(tool: string, input: Record<string, unknown>): string {
  if (tool === "Bash" && typeof input.command === "string") {
    const first = input.command.trim().split(/\s+/)[0] ?? "";
    return first ? `Bash(${first}:*)` : "Bash";
  }
  if (FILE_TOOLS.has(tool)) {
    const file = pathOf(input);
    const folder = file ? posix.dirname(posix.normalize(file)) : null;
    if (folder && !folder.split("/").includes("..")) return `${tool}(${folder}/**)`;
  }
  return tool;
}

/** The file a file tool names. */
function pathOf(input: Record<string, unknown>): string | null {
  for (const key of PATH_KEYS) if (typeof input[key] === "string" && (input[key] as string).trim()) return (input[key] as string).trim();
  return null;
}

/**
 * What a shell can do past its first command: chain another, pipe into
 * one, substitute one, redirect into a file. A rule for `ls` is a yes to
 * `ls`, never to `ls; curl … | sh`, so a command with any of these asks.
 */
const SHELL_CHAIN = /[;&|`<>\n\r]|\$\(/;

/** A file path under a rule's folder: `.` is the bot's own folder, where a relative path lands. */
function underFolder(file: string, folder: string): boolean {
  const clean = posix.normalize(file);
  if (clean.split("/").includes("..")) return false;
  if (folder === ".") return !clean.startsWith("/") && !clean.startsWith("~");
  return clean.startsWith(`${folder}/`);
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

export function ruleMatches(rule: string, tool: string, input: Record<string, unknown>): boolean {
  if (rule === tool) return true;
  const prefix = /^Bash\((.+):\*\)$/.exec(rule);
  if (prefix && tool === "Bash" && typeof input.command === "string") {
    const command = input.command.trim();
    if (SHELL_CHAIN.test(command)) return false;
    return command.split(/\s+/)[0] === prefix[1];
  }
  const folder = /^(\w+)\((.+)\/\*\*\)$/.exec(rule);
  if (folder && folder[1] === tool && FILE_TOOLS.has(tool)) {
    const file = pathOf(input);
    return file !== null && underFolder(file, folder[2]!);
  }
  return false;
}

/** Tools that read only: never worth a card, whatever the level. */
const READ_ONLY = new Set(["Read", "Glob", "Grep", "LS", "TodoRead", "TodoWrite", "Task", "WebSearch", "NotebookRead"]);
/** Tools that change a file, and say which one. */
const FILE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
/** Where a tool says which file it means. */
const PATH_KEYS = ["file_path", "notebook_path", "path"];

/**
 * A path in the bot's own folder on the computer. Three shapes:
 * - relative: a CLI session runs in that folder, so one that doesn't climb
 *   out is inside it;
 * - `~/…`: the API engine's tools name everything from the person's home,
 *   so it must be `~/.bots/<id>` or under it;
 * - absolute: its owner's home on the box then `.bots/<id>`, from the
 *   start of the path, never merely somewhere in it.
 */
export function ownPath(bot: Pick<Bot, "id" | "userId">, value: string): boolean {
  const path = value.trim();
  if (!path || path.split("/").includes("..")) return false;
  const desk = botHome(bot.id);
  const inside = (clean: string, root: string) => clean === root || clean.startsWith(`${root}/`);
  if (path.startsWith("~/")) return inside(posix.normalize(path.slice(2)), desk);
  if (path.startsWith("~")) return false;
  if (!path.startsWith("/")) return true;
  const clean = posix.normalize(path);
  const home = bot.userId ? boxHome(bot.userId) : null;
  if (home) return inside(clean, `${home}/${desk}`);
  // Before the box has told us where the home is: a home is /home/<name>, or the admin's /home/agent.
  const at = clean.indexOf(`/${desk}`);
  return at > 0 && /^\/home\/[^/]+$/.test(clean.slice(0, at)) && inside(clean.slice(at + 1), desk);
}

/** Its own folder is its desk: it works there without asking, at either level. */
function inOwnHome(bot: Pick<Bot, "id" | "userId">, tool: string, input: Record<string, unknown>): boolean {
  if (!FILE_TOOLS.has(tool)) return false;
  const paths = PATH_KEYS.map((key) => input[key]).filter((value): value is string => typeof value === "string");
  return paths.length > 0 && paths.every((path) => ownPath(bot, path));
}

/**
 * Asks, or doesn't. Nothing gates reading, or a change the bot makes in
 * its own folder. Past that, `full` lets everything through and `ask`
 * sends a card and waits: a shell command, a file elsewhere, an app
 * action. Resolves once the person answers, a saved rule says yes, or the
 * wait runs out; `always` counts as allow and saves the rule.
 */
export async function requestApproval(input: { bot: Bot; threadId: string; tool: string; input: Record<string, unknown>; summary?: string; signal?: AbortSignal }): Promise<Decision> {
  const { threadId, tool } = input;
  /*
   * The level as it is right now, not as it was when the turn started: a
   * turn can run for minutes, and changing the level while a bot works is
   * exactly when a person does it.
   */
  const bot = getBot(input.bot.id) ?? input.bot;
  if (bot.approval === "full") return "allow";
  if (READ_ONLY.has(tool)) return "allow";
  if (inOwnHome(bot, tool, input.input)) return "allow";
  for (const rule of listRules(bot.id)) {
    if (ruleMatches(rule, tool, input.input)) return "allow";
  }
  const approval = createApproval({ botId: bot.id, threadId, tool, summary: hideSecrets(input.summary ?? summarize(tool, input.input)), input: input.input });
  postMessage({ threadId, author: bot.id, kind: "approval", body: approval.summary, approvalId: approval.id, answered: true });
  if (bot.notify) void sendPush({ title: `${bot.name} needs your approval`, body: approval.summary.slice(0, 140), url: `/app/t/${threadId}`, tag: threadId, threadId }, bot.userId);
  return new Promise<Decision>((resolve) => {
    // Nobody answered in time, or the turn that asked was stopped: the card
    // closes, so a late tap can't run something for work that's over.
    const expire = () => {
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", expire);
      if (!pending().delete(approval.id)) return;
      resolveApproval(approval.id, "expired");
      resolve("expired");
    };
    const timer = setTimeout(expire, approvalTimeoutMs());
    pending().set(approval.id, { resolve: (decision) => (input.signal?.removeEventListener("abort", expire), resolve(decision)), timer });
    if (input.signal?.aborted) expire();
    else input.signal?.addEventListener("abort", expire, { once: true });
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
