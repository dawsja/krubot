import type { BoxStatus, ClaudeStatus, Engine } from "@krubot/shared";
import { boxConfig, boxVersions, checkClaude, claudeAuth, engineSignIn, enginesAuth, health, listAgents, type BoxConfig, type BoxVersions, type ClaudeCheck, type EnginesAuth } from "./box.ts";
import { emit } from "./events.ts";
import { composioConfigured } from "./composio.ts";
import { listConnections } from "./data/settings.ts";
import { isUpdating } from "./updater.ts";

/*
 * The computer as one person sees it. Sign-ins are per person (each has
 * their own account on the box, with their own CLI sign-ins), so the
 * checks and their caches are kept by person; what runs on the box is
 * the same for everyone.
 */

const CHECK_CACHE_MS = 5 * 60 * 1000;
const cachedChecks = new Map<string, { at: number; check: ClaudeCheck }>();

/** The box's answer about the CLI in this person's account, kept for a while: each check is a CLI run. */
export async function checkClaudeCached(box: BoxConfig, { fresh = false } = {}): Promise<ClaudeCheck> {
  const key = box.user ?? "";
  const cached = cachedChecks.get(key);
  if (!fresh && cached && Date.now() - cached.at < CHECK_CACHE_MS) return cached.check;
  const check = await checkClaude(box);
  cachedChecks.set(key, { at: Date.now(), check });
  return check;
}

/** Forgets one person's checks, or everyone's after an update. */
export function forgetClaudeCheck(userId?: string) {
  if (userId) {
    cachedChecks.delete(userId);
    cachedEngines.delete(userId);
  } else {
    cachedChecks.clear();
    cachedEngines.clear();
  }
  cachedVersions = null;
}

const cachedEngines = new Map<string, { at: number; engines: EnginesAuth }>();
/** Codex and Grok sign-ins change when someone runs a login in a terminal: kept only briefly. */
const ENGINES_CACHE_MS = 30_000;

async function enginesCached(box: BoxConfig, fresh = false): Promise<EnginesAuth | null> {
  const key = box.user ?? "";
  const cached = cachedEngines.get(key);
  if (!fresh && cached && Date.now() - cached.at < ENGINES_CACHE_MS) return cached.engines;
  const engines = await enginesAuth(box).catch(() => null);
  if (engines) cachedEngines.set(key, { at: Date.now(), engines });
  return engines;
}

/*
 * A sign-in the computer is driving right now. The app follows it in the
 * sheet it opened, but the person may close that and finish in the
 * browser, so the API watches it too: when it lands, the cached sign-in
 * state is dropped and the person's app is told, wherever they are.
 */
const watched = new Map<string, ReturnType<typeof setInterval>>();
const WATCH_MS = 3_000;
const WATCH_LIMIT_MS = 11 * 60 * 1000;

export function watchEngineSignIn(box: BoxConfig, userId: string, engine: Engine, intervalMs = WATCH_MS): void {
  const key = `${userId}:${engine}`;
  clearInterval(watched.get(key));
  const until = Date.now() + WATCH_LIMIT_MS;
  const stop = () => {
    clearInterval(watched.get(key));
    watched.delete(key);
  };
  const timer = setInterval(() => {
    if (Date.now() > until) return stop();
    void engineSignIn(box, engine)
      .then(({ signIn }) => {
        if (signIn && signIn.state !== "done" && signIn.state !== "failed") return;
        stop();
        // The sign-in changed what the computer would answer about this person.
        if (signIn?.state === "done") forgetClaudeCheck(userId);
        emit({ topic: "ai", userId });
      })
      .catch(() => stop());
  }, intervalMs);
  if (typeof timer.unref === "function") timer.unref();
  watched.set(key, timer);
}

let cachedVersions: { at: number; versions: BoxVersions } | null = null;

async function versionsCached(box: BoxConfig, fresh = false): Promise<BoxVersions | null> {
  if (!fresh && cachedVersions && Date.now() - cachedVersions.at < CHECK_CACHE_MS) return cachedVersions.versions;
  const versions = await boxVersions(box).catch(() => null);
  if (versions) cachedVersions = { at: Date.now(), versions };
  return versions;
}

export async function claudeStatus(box: BoxConfig | null, fresh = false): Promise<ClaudeStatus> {
  if (!box) return { status: "no-box", detail: "No box is configured. Set KRU_BOX_URL." };
  try {
    const [check, auth] = await Promise.all([checkClaudeCached(box, { fresh }), claudeAuth(box).catch(() => null)]);
    return { status: check.status, detail: check.detail, email: auth?.email ?? null };
  } catch (error) {
    return { status: "error", detail: error instanceof Error ? error.message : "The box didn't answer" };
  }
}

/** The status for one person: their sign-ins on the box, and, for the admin, everyone's live sessions. */
export async function boxStatus(userId: string, { fresh = false, admin = false } = {}): Promise<BoxStatus> {
  let box: BoxConfig | null = null;
  let configError: string | null = null;
  try {
    box = boxConfig(userId);
  } catch (error) {
    configError = error instanceof Error ? error.message : "bad box config";
  }
  const connections = listConnections(userId);
  if (!box) {
    return {
      configured: false,
      reachable: false,
      updating: false,
      claude: { status: "no-box", detail: configError ?? "No box is configured. Set KRU_BOX_URL." },
      composio: { configured: composioConfigured(userId), connected: connections.filter((c) => c.status === "active").length },
      agents: [],
      engines: null,
      versions: null,
    };
  }
  let reachable = false;
  let updating = isUpdating();
  let agents: BoxStatus["agents"] = [];
  let versions: BoxVersions | null = null;
  let engines: EnginesAuth | null = null;
  try {
    const h = await health(box);
    reachable = true;
    updating = updating || Boolean(h.updating);
    if (!updating) {
      const all = (await listAgents(box).catch(() => ({ agents: [] }))).agents;
      agents = all.filter((a) => admin || a.user === userId).map(({ id, running, busy }) => ({ id, running, busy }));
      [versions, engines] = await Promise.all([versionsCached(box, fresh), enginesCached(box, fresh)]);
    }
  } catch {
    reachable = false;
  }
  return {
    configured: true,
    reachable,
    updating,
    claude: updating ? { status: "error", detail: "The computer is updating." } : reachable ? await claudeStatus(box, fresh) : { status: "error", detail: "The box isn't reachable. Is the box container running?" },
    composio: { configured: composioConfigured(userId), connected: connections.filter((c) => c.status === "active").length },
    agents,
    engines,
    versions,
  };
}
