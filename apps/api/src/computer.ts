import type { Bot, Thread } from "@krubot/shared";
import { requestApproval, summarize } from "./approvals.ts";
import { execOnBox, readBoxFile, writeBoxFile, type BoxConfig } from "./box.ts";
import type { DriverTool } from "./driver.ts";
import { botHome } from "./memory.ts";

/*
 * The computer, as tools. A CLI brings its own shell and file tools; the
 * API engine has none, so these are it: the same box, the same account
 * (the bot's owner's), the same approvals. The tool names are the
 * ones the broker already knows (Bash, Read, Write, Edit), so a saved
 * "Always allow" rule and the rule that a bot never asks about its own
 * folder hold here exactly as they do for a CLI.
 */

/** How long one command may run before it is killed. */
const COMMAND_TIMEOUT_MS = 10 * 60 * 1000;
/** Most of a file handed to the model at once. */
const MAX_READ_BYTES = 200_000;

const schema = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false });

/**
 * Where a path lands on the box. Everything is relative to the person's
 * home there, and a bare path belongs to the bot's own folder, which is
 * where its work lives. An absolute path is taken as the person's home
 * being `/`, since that is all the box ever opens.
 */
export function resolvePath(botId: string, given: string): string {
  const path = String(given ?? "").trim();
  const home = botHome(botId);
  if (!path || path === "." || path === "./") return home;
  if (path.startsWith("~/")) return path.slice(2);
  const clean = path.replace(/^\/+/, "");
  // A path that already names a home folder (its own or the team's) is left alone.
  if (clean.startsWith(".bots/") || clean.startsWith(".team/") || clean.startsWith(".skills/")) return clean;
  return path.startsWith("/") ? clean : `${home}/${clean}`;
}

/**
 * A resolved path as the approval broker sees it: from the person's home,
 * `~/…`. A bare relative path means "the bot's own folder" there, which
 * would let `.bashrc` or a teammate's SOUL.md through without a card.
 */
export function fromHome(resolved: string): string {
  return `~/${resolved}`;
}

type Context = { box: BoxConfig; bot: Bot; thread: Thread; signal?: AbortSignal };

/** Runs the gate for one action, and says what to tell the model when the answer is no. */
async function allowed(context: Context, tool: string, input: Record<string, unknown>): Promise<string | null> {
  const decision = await requestApproval({ bot: context.bot, threadId: context.thread.id, tool, input, signal: context.signal });
  if (decision === "allow" || decision === "always") return null;
  if (decision === "expired") return `Nobody answered the approval for "${summarize(tool, input)}" in time. Say so and stop, or try something else.`;
  return `The person denied "${summarize(tool, input)}". Do something else, or say what you would need.`;
}

/** The shell, the files and a listing: what a bot needs to work on its computer. */
export function computerTools(context: Context): Record<string, DriverTool> {
  const { box, bot } = context;
  const home = botHome(bot.id);

  return {
    Bash: {
      description: `Runs a shell command on your computer, in your own folder (${home}) unless you give another directory. Use it for everything a terminal does: install things, run code, fetch a URL with curl, move files. Long output comes back trimmed.`,
      inputSchema: schema({ command: { type: "string", description: "The command line to run." }, cwd: { type: "string", description: "Where to run it, relative to your home. Defaults to your own folder." } }, ["command"]),
      execute: async (input) => {
        const command = String(input.command ?? "").trim();
        if (!command) return "No command given.";
        const denied = await allowed(context, "Bash", { command });
        if (denied) return denied;
        const cwd = typeof input.cwd === "string" && input.cwd.trim() ? resolvePath(bot.id, input.cwd) : home;
        const result = await execOnBox(box, command, { cwd, timeoutMs: COMMAND_TIMEOUT_MS });
        const head = `exit ${result.exitCode}${result.timedOut ? " (timed out)" : ""}${result.signal ? ` (${result.signal})` : ""}`;
        return `${head}\n${result.output || "(no output)"}`;
      },
    },

    Read: {
      description: "Reads a file on your computer. A directory comes back as a listing. Paths are relative to your own folder.",
      inputSchema: schema({ file_path: { type: "string", description: "The file to read." } }, ["file_path"]),
      execute: async (input) => {
        const file_path = resolvePath(bot.id, String(input.file_path ?? ""));
        const file = await readBoxFile(box, file_path);
        if (file.directory) return `${file_path} is a folder:\n${file.directory.join("\n") || "(empty)"}`;
        if (file.binary) return `${file_path} is a binary file (${file.size ?? 0} bytes). Use Bash if you need to work with it.`;
        const content = file.content ?? "";
        return content.length > MAX_READ_BYTES ? `${content.slice(0, MAX_READ_BYTES)}\n[… ${content.length - MAX_READ_BYTES} more characters; read the rest with Bash]` : content || "(empty file)";
      },
    },

    LS: {
      description: "Lists a folder on your computer. Defaults to your own folder.",
      inputSchema: schema({ path: { type: "string", description: "The folder to list." } }),
      execute: async (input) => {
        const path = resolvePath(bot.id, String(input.path ?? ""));
        const file = await readBoxFile(box, path);
        if (!file.directory) return `${path} is a file, not a folder.`;
        return `${path}:\n${file.directory.join("\n") || "(empty)"}`;
      },
    },

    Write: {
      description: "Writes a file on your computer, replacing whatever was there. Inside your own folder it just happens; anywhere else the person is asked first.",
      inputSchema: schema({ file_path: { type: "string", description: "The file to write." }, content: { type: "string", description: "Its whole new contents." } }, ["file_path", "content"]),
      execute: async (input) => {
        const file_path = resolvePath(bot.id, String(input.file_path ?? ""));
        const content = String(input.content ?? "");
        const denied = await allowed(context, "Write", { file_path: fromHome(file_path) });
        if (denied) return denied;
        await writeBoxFile(box, file_path, content);
        return `Wrote ${file_path} (${content.length} characters).`;
      },
    },

    Edit: {
      description: "Replaces one exact piece of text in a file on your computer. The old text must appear exactly once; read the file first.",
      inputSchema: schema(
        {
          file_path: { type: "string", description: "The file to change." },
          old_text: { type: "string", description: "The text to replace, exactly as it appears." },
          new_text: { type: "string", description: "What to put there instead." },
        },
        ["file_path", "old_text", "new_text"],
      ),
      execute: async (input) => {
        const file_path = resolvePath(bot.id, String(input.file_path ?? ""));
        const old_text = String(input.old_text ?? "");
        const new_text = String(input.new_text ?? "");
        if (!old_text) return "Give the text to replace.";
        const denied = await allowed(context, "Edit", { file_path: fromHome(file_path) });
        if (denied) return denied;
        const file = await readBoxFile(box, file_path);
        if (typeof file.content !== "string") return `${file_path} isn't a text file.`;
        const count = file.content.split(old_text).length - 1;
        if (count === 0) return `That text isn't in ${file_path}. Read it again and match it exactly.`;
        if (count > 1) return `That text appears ${count} times in ${file_path}. Include more of what's around it so it names one place.`;
        await writeBoxFile(box, file_path, file.content.replace(old_text, new_text));
        return `Edited ${file_path}.`;
      },
    },
  };
}
