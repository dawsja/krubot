import type { BoxUpdate, BoxUpdatePhase } from "@krubot/shared";
import { boxConfig, boxUpdateStatus, health, resetBox, startBoxUpdate, type BoxConfig } from "./box.ts";
import { dockerAvailability, DockerError, findBoxContainer, imageId, pullImage, recreateContainer } from "./docker.ts";
import { emit } from "./events.ts";
import { postMessage } from "./data/threads.ts";
import { activeTurns } from "./responder.ts";
import { forgetClaudeCheck } from "./status.ts";

/*
 * Settings → Computer → Update, the way Grok Bot's "update bot" works: the
 * computer is paused (nothing new starts, running turns are stopped), the
 * newest box image is pulled from GHCR and the box recreated on it when the
 * API can reach Docker, then the box patches itself in place (Debian, Bun,
 * Claude Code), and the computer comes back. One update at a time; the
 * phases and log are kept for the UI, which hears each change on
 * /api/events.
 */

const holder = globalThis as typeof globalThis & { __kruBoxUpdate?: BoxUpdate };

const IDLE: BoxUpdate = { phase: "idle", startedAt: null, finishedAt: null, log: [], error: null, pulled: false, patched: false, kind: "update" };
/** How long the box gets to come back after a recreate. */
const BOX_BACK_MS = 5 * 60 * 1000;
/** How long an in-place patch may take. */
const PATCH_MS = 35 * 60 * 1000;
const MAX_LOG_LINES = 400;

export function boxUpdate(): BoxUpdate {
  return (holder.__kruBoxUpdate ??= { ...IDLE });
}

/** Nothing new starts on the computer while this is true. */
export function isUpdating(): boolean {
  const phase = boxUpdate().phase;
  return phase !== "idle" && phase !== "done" && phase !== "failed";
}

function set(patch: Partial<BoxUpdate>) {
  holder.__kruBoxUpdate = { ...boxUpdate(), ...patch };
  emit({ topic: "box" });
}

function log(line: string) {
  const current = boxUpdate();
  const lines = [...current.log, ...line.split("\n").filter((l) => l.trim())].slice(-MAX_LOG_LINES);
  holder.__kruBoxUpdate = { ...current, log: lines };
  emit({ topic: "box" });
}

function phase(next: BoxUpdatePhase, note?: string) {
  set({ phase: next });
  if (note) log(note);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForBox(box: BoxConfig, timeoutMs: number): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const h = await health(box);
      if (h.ok) return;
    } catch {
      /* not yet */
    }
    await sleep(2_000);
  }
  throw new Error("The box didn't come back in time. Check `docker compose logs box`.");
}

/** Stops every running turn and lets the box close its sessions; the threads hear why. */
async function pause(): Promise<string[]> {
  const turns = activeTurns();
  const threads = new Set<string>();
  for (const turn of turns.values()) {
    threads.add(turn.threadId);
    turn.controller.abort();
  }
  const until = Date.now() + 15_000;
  while (turns.size > 0 && Date.now() < until) await sleep(500);
  for (const threadId of threads) {
    postMessage({ threadId, author: "system", kind: "event", body: "The computer is updating. Whatever was running stopped; send the request again once it's back.", answered: true });
  }
  log(turns.size ? `${turns.size} turn(s) didn't stop in time; going on.` : threads.size ? `Stopped work in ${threads.size} conversation(s).` : "No bot was working.");
  return [...threads];
}

/** Pulls the box's image; true when the container now runs an older one. */
async function pullNewer(): Promise<{ newer: boolean; image: string; info: Awaited<ReturnType<typeof findBoxContainer>> } | null> {
  const docker = dockerAvailability();
  if (!docker.available) {
    log(`Skipping the image pull: ${docker.reason}`);
    return null;
  }
  const info = await findBoxContainer();
  const image = info.Config.Image;
  log(`Box container ${info.Name.replace(/^\//, "")} runs ${image}.`);
  const before = info.Image;
  await pullImage(image, log);
  const after = await imageId(image);
  const newer = Boolean(after && after !== before);
  log(newer ? `A newer image arrived (${after!.slice(7, 19)}).` : "The image is already the newest.");
  return { newer, image, info };
}

async function patchInPlace(box: BoxConfig): Promise<boolean> {
  await startBoxUpdate(box);
  let shown = 0;
  const until = Date.now() + PATCH_MS;
  while (Date.now() < until) {
    await sleep(2_000);
    let status;
    try {
      status = await boxUpdateStatus(box);
    } catch {
      continue;
    }
    const text = status.log ?? "";
    if (text.length > shown) {
      log(text.slice(shown));
      shown = text.length;
    }
    if (!status.running) return status.ok === true;
  }
  log("The patch is taking too long; leaving it to finish on its own.");
  return false;
}

async function run(options: { pull: boolean }): Promise<void> {
  const box = boxConfig();
  if (!box) throw new Error("No box is configured. Set KRU_BOX_URL.");
  try {
    phase("pausing", "Pausing the computer…");
    const stopped = await pause();

    let pulled = false;
    if (options.pull) {
      phase("pulling", "Looking for a newer box image…");
      const result = await pullNewer();
      if (result?.newer) {
        phase("restarting", "Recreating the box on the new image (its volumes stay)…");
        await recreateContainer(result.info, result.image, log);
        log("Waiting for the box to come back…");
        await waitForBox(box, BOX_BACK_MS);
        pulled = true;
        set({ pulled: true });
      }
    }

    phase("patching", "Patching the box in place: Debian, Bun, Claude Code, Codex, Grok…");
    const patched = await patchInPlace(box);
    set({ patched });

    phase("resuming", "Bringing the computer back…");
    await waitForBox(box, 60_000);
    forgetClaudeCheck();
    set({ phase: "done", finishedAt: new Date().toISOString() });
    log(pulled ? "Updated to the newest image and patched. The bots are back." : patched ? "Patched. The bots are back." : "Finished with warnings; the bots are back.");
    for (const threadId of stopped) postMessage({ threadId, author: "system", kind: "event", body: "The computer is back.", answered: true });
  } catch (error) {
    const message = error instanceof DockerError || error instanceof Error ? error.message : "The update failed.";
    set({ phase: "failed", finishedAt: new Date().toISOString(), error: message });
    log(`Failed: ${message}`);
  }
}

/** Starts an update, or reports the one running. */
export function startUpdate(options: { pull?: boolean } = {}): BoxUpdate {
  if (isUpdating()) return boxUpdate();
  holder.__kruBoxUpdate = { ...IDLE, log: [], startedAt: new Date().toISOString(), kind: "update" };
  emit({ topic: "box" });
  void run({ pull: options.pull ?? true });
  return boxUpdate();
}

/**
 * Reset, like Grok Bot's "wipe and rebuild": the computer pauses, the
 * agent's home is wiped except the bots' homes, the team's files, the
 * skills and the Claude sign-in, and when the API can reach Docker the
 * container is rebuilt from its image so patches and stray installs go
 * too. Then the computer comes back.
 */
export function startReset(): BoxUpdate {
  if (isUpdating()) return boxUpdate();
  holder.__kruBoxUpdate = { ...IDLE, log: [], startedAt: new Date().toISOString(), kind: "reset" };
  emit({ topic: "box" });
  void runReset();
  return boxUpdate();
}

async function runReset(): Promise<void> {
  const box = boxConfig();
  if (!box) throw new Error("No box is configured. Set KRU_BOX_URL.");
  try {
    phase("pausing", "Pausing the computer…");
    const stopped = await pause();
    phase("resetting", "Wiping the home folder (bots, team files, skills and the Claude sign-in stay)…");
    const result = await resetBox(box);
    log(result.removed.length ? `Removed: ${result.removed.join(", ")}.` : "Nothing to remove.");
    const docker = dockerAvailability();
    if (docker.available) {
      log("Rebuilding the container from its image…");
      const info = await findBoxContainer();
      await recreateContainer(info, info.Config.Image, log);
      log("Waiting for the box to come back…");
      await waitForBox(box, BOX_BACK_MS);
    } else {
      log(`Container not rebuilt: ${docker.reason}`);
    }
    phase("resuming", "Bringing the computer back…");
    await waitForBox(box, 60_000);
    forgetClaudeCheck();
    set({ phase: "done", finishedAt: new Date().toISOString() });
    log("Reset. The bots are back with their memory and files.");
    for (const threadId of stopped) postMessage({ threadId, author: "system", kind: "event", body: "The computer is back.", answered: true });
  } catch (error) {
    const message = error instanceof DockerError || error instanceof Error ? error.message : "The reset failed.";
    set({ phase: "failed", finishedAt: new Date().toISOString(), error: message });
    log(`Failed: ${message}`);
  }
}

/** What the UI shows: the update's state plus whether image pulls can work here. */
export function updateReport(): { update: BoxUpdate; docker: ReturnType<typeof dockerAvailability> } {
  return { update: boxUpdate(), docker: dockerAvailability() };
}
