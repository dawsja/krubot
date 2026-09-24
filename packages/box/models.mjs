/**
 * The models each CLI can actually run, asked of the CLI itself.
 *
 * They each answer differently, and none of them the same way an API does:
 *
 *   codex  `codex app-server` speaks `model/list`, which is what its own
 *          picker uses: id, display name, and which one is the default.
 *   grok   `grok models` prints them, marking the default, and works
 *          without being signed in.
 *   claude Claude Code has no list at all. What it does have is aliases
 *          (`--help`: "an alias for the latest model (e.g. 'fable',
 *          'opus', or 'sonnet')"), and an alias is the right thing to run
 *          on a plan: it follows the newest model of that name, so it
 *          never goes stale the way a pinned id does. A full id can still
 *          be typed in the app.
 *
 * Nothing here needs the person's API key: a plan has no /models endpoint,
 * which is the whole reason this file exists.
 */
import { spawn } from "node:child_process";
import { RpcPeer } from "./rpc.mjs";

/** How long a CLI gets to answer before we give up on it. */
const TIMEOUT_MS = 20_000;

/**
 * The aliases Claude Code takes, newest model of each name, best first.
 *
 * The id is the alias, so a bot keeps following the newest model of that
 * name. The name carries the version that alias resolves to today, which
 * is the one thing here that does go stale: when a new Opus or Sonnet
 * lands, edit the name. Nothing breaks if it is a release behind, the
 * label just reads old.
 */
export const CLAUDE_ALIASES = [
  { id: "fable", name: "Fable 5.1", detail: "The newest, above Opus. Only where your plan includes it." },
  { id: "opus", name: "Opus 5.5", detail: "The most capable. Best for long, multi-step jobs. The default for every bot.", default: true },
  { id: "sonnet", name: "Sonnet 5", detail: "Fast and capable. Good for everyday work." },
  { id: "haiku", name: "Haiku 4.5", detail: "Quickest and cheapest. Good for triage and routines." },
];

/** What `grok models` prints, as models. A starred line is the default. */
export function parseGrokModels(text) {
  const out = [];
  for (const line of String(text).split("\n")) {
    const found = /^\s*([*-])\s+([A-Za-z0-9][\w.:-]*)\s*(\(default\))?/.exec(line);
    if (!found) continue;
    const id = found[2];
    if (out.some((model) => model.id === id)) continue;
    out.push({ id, ...(found[1] === "*" || found[3] ? { default: true } : {}) });
  }
  return out;
}

/** What `model/list` answers, as models: hidden ones left out, the default marked. */
export function readCodexModels(payload) {
  const rows = Array.isArray(payload?.data) ? payload.data : [];
  const out = [];
  for (const row of rows) {
    const id = typeof row?.model === "string" && row.model ? row.model : typeof row?.id === "string" ? row.id : null;
    if (!id || row?.hidden === true || out.some((model) => model.id === id)) continue;
    out.push({
      id,
      ...(typeof row.displayName === "string" && row.displayName ? { name: row.displayName } : {}),
      ...(row.isDefault === true ? { default: true } : {}),
    });
  }
  return out;
}

/** Runs a command and hands back what it printed; a failure is empty output, not a throw. */
function output(bin, args, options) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      resolve("");
      return;
    }
    const chunks = [];
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.stderr.on("data", (chunk) => chunks.push(chunk));
    const timer = setTimeout(() => child.kill("SIGKILL"), TIMEOUT_MS);
    child.on("error", () => {
      clearTimeout(timer);
      resolve("");
    });
    child.on("close", () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
  });
}

/** Asks a Codex app-server for its model list, then closes it. */
async function codexModels(bin, options) {
  let child;
  try {
    child = spawn(bin, ["app-server"], { ...options, stdio: ["pipe", "pipe", "pipe"] });
  } catch {
    return [];
  }
  // A missing binary arrives as an event, not a throw; without this the process would take it personally.
  const died = new Promise((resolve) => child.once("error", () => resolve("gone")));
  try {
    const rpc = new RpcPeer(child, { jsonrpc: false });
    const start = await Promise.race([rpc.request("initialize", { clientInfo: { name: "krubot", title: "Kru Bot", version: "1.0.0" } }, { timeoutMs: TIMEOUT_MS }), died]);
    if (start === "gone") return [];
    rpc.notify("initialized", {});
    const answer = await Promise.race([rpc.request("model/list", { includeHidden: false }, { timeoutMs: TIMEOUT_MS }), died]);
    return answer === "gone" ? [] : readCodexModels(answer);
  } catch {
    return [];
  } finally {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

/**
 * The models one engine offers this person, asked of their own CLI in
 * their own account. An engine that can't answer returns nothing, and the
 * app says so rather than showing a list that isn't true.
 */
export async function engineModels(engine, { bins, env, uid, gid }) {
  const options = { env, ...(uid !== undefined ? { uid, gid } : {}) };
  if (engine === "claude") return CLAUDE_ALIASES.map((model) => ({ ...model }));
  if (engine === "grok") return parseGrokModels(await output(bins.grok, ["models"], options));
  if (engine === "codex") return codexModels(bins.codex, options);
  return [];
}
