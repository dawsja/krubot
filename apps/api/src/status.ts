import type { BoxStatus, ClaudeStatus } from "@krubot/shared";
import { boxConfig, boxVersions, checkClaude, claudeAuth, enginesAuth, health, listAgents, type BoxConfig, type BoxVersions, type ClaudeCheck, type EnginesAuth } from "./box.ts";
import { composioConfigured } from "./composio.ts";
import { listConnections } from "./data/settings.ts";
import { isUpdating } from "./updater.ts";

const CHECK_CACHE_MS = 5 * 60 * 1000;
let cachedCheck: { at: number; check: ClaudeCheck } | null = null;

/** The box's answer about the CLI, kept for a while: each check is a CLI run. */
export async function checkClaudeCached(box: BoxConfig, { fresh = false } = {}): Promise<ClaudeCheck> {
  if (!fresh && cachedCheck && Date.now() - cachedCheck.at < CHECK_CACHE_MS) return cachedCheck.check;
  const check = await checkClaude(box);
  cachedCheck = { at: Date.now(), check };
  return check;
}

export function forgetClaudeCheck() {
  cachedCheck = null;
  cachedVersions = null;
  cachedEngines = null;
}

let cachedEngines: { at: number; engines: EnginesAuth } | null = null;
/** Codex and Grok sign-ins change when someone runs a login in a terminal: kept only briefly. */
const ENGINES_CACHE_MS = 30_000;

async function enginesCached(box: BoxConfig, fresh = false): Promise<EnginesAuth | null> {
  if (!fresh && cachedEngines && Date.now() - cachedEngines.at < ENGINES_CACHE_MS) return cachedEngines.engines;
  const engines = await enginesAuth(box).catch(() => null);
  if (engines) cachedEngines = { at: Date.now(), engines };
  return engines;
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

export async function boxStatus(userId: string, fresh = false): Promise<BoxStatus> {
  let box: BoxConfig | null = null;
  let configError: string | null = null;
  try {
    box = boxConfig();
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
      agents = (await listAgents(box).catch(() => ({ agents: [] }))).agents;
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
