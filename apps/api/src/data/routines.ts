import type { Routine, RoutineInput } from "@krubot/shared";
import { Cron } from "croner";
import { ensureKruDatabase } from "../db/init.ts";
import { boardChanged, settingsChanged } from "../events.ts";
import { newId, now } from "../ids.ts";

type Row = {
  id: string;
  bot_id: string;
  name: string;
  cron: string;
  timezone: string;
  prompt: string;
  enabled: number;
  skill_id: string | null;
  last_run_at: string | null;
  next_run_at: string | null;
  created_at: string;
  updated_at: string;
};

function toRoutine(row: Row): Routine {
  return {
    id: row.id,
    botId: row.bot_id,
    name: row.name,
    cron: row.cron,
    timezone: row.timezone,
    prompt: row.prompt,
    enabled: row.enabled === 1,
    skillId: row.skill_id,
    lastRunAt: row.last_run_at,
    nextRunAt: row.next_run_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** The next time a cron fires in its zone, or throws when the expression is bad. */
export function nextRun(cron: string, timezone: string, from = new Date()): Date | null {
  const job = new Cron(cron, { timezone, paused: true });
  const next = job.nextRun(from);
  job.stop();
  return next;
}

/** A readable description of a cron's next few dates, for the editor. */
export function previewRuns(cron: string, timezone: string, count = 3): string[] {
  const job = new Cron(cron, { timezone, paused: true });
  const runs = job.nextRuns(count).map((d) => d.toISOString());
  job.stop();
  return runs;
}

export function listRoutines(botId?: string): Routine[] {
  const rows = ensureKruDatabase()
    .query(`SELECT * FROM kru_routines ${botId ? "WHERE bot_id = ?" : ""} ORDER BY created_at ASC`)
    .all(...(botId ? [botId] : [])) as Row[];
  return rows.map(toRoutine);
}

export function getRoutine(id: string): Routine | null {
  const row = ensureKruDatabase().query("SELECT * FROM kru_routines WHERE id = ?").get(id) as Row | null;
  return row ? toRoutine(row) : null;
}

export function createRoutine(botId: string, input: Omit<RoutineInput, "skillId"> & { skillId?: string | null }): Routine {
  const id = newId("r");
  const at = now();
  const next = input.enabled ? nextRun(input.cron, input.timezone)?.toISOString() ?? null : null;
  ensureKruDatabase()
    .query("INSERT INTO kru_routines (id, bot_id, name, cron, timezone, prompt, enabled, skill_id, next_run_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(id, botId, input.name, input.cron, input.timezone, input.prompt, input.enabled ? 1 : 0, input.skillId ?? null, next, at, at);
  settingsChanged();
  return getRoutine(id)!;
}

export function updateRoutine(id: string, patch: Partial<RoutineInput>): Routine | null {
  const current = getRoutine(id);
  if (!current) return null;
  const next = { ...current, ...patch };
  const nextRunAt = next.enabled ? nextRun(next.cron, next.timezone)?.toISOString() ?? null : null;
  ensureKruDatabase()
    .query("UPDATE kru_routines SET name = ?, cron = ?, timezone = ?, prompt = ?, enabled = ?, skill_id = ?, next_run_at = ?, updated_at = ? WHERE id = ?")
    .run(next.name, next.cron, next.timezone, next.prompt, next.enabled ? 1 : 0, next.skillId ?? null, nextRunAt, now(), id);
  settingsChanged();
  return getRoutine(id);
}

export function deleteRoutine(id: string): boolean {
  const changed = ensureKruDatabase().query("DELETE FROM kru_routines WHERE id = ?").run(id).changes;
  if (changed) settingsChanged();
  return changed > 0;
}

/** Routines whose next run is due, and marks them as run with the following date. */
export function claimDueRoutines(at = new Date()): Routine[] {
  const db = ensureKruDatabase();
  const rows = db.query("SELECT * FROM kru_routines WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?").all(at.toISOString()) as Row[];
  const due: Routine[] = [];
  for (const row of rows) {
    let next: string | null = null;
    try {
      next = nextRun(row.cron, row.timezone, at)?.toISOString() ?? null;
    } catch {
      next = null;
    }
    db.query("UPDATE kru_routines SET last_run_at = ?, next_run_at = ? WHERE id = ?").run(at.toISOString(), next, row.id);
    due.push(toRoutine({ ...row, last_run_at: at.toISOString(), next_run_at: next }));
  }
  if (due.length) settingsChanged();
  return due;
}

export function recordRoutineRun(routineId: string, messageId: string | null) {
  ensureKruDatabase().query("INSERT INTO kru_routine_runs (id, routine_id, message_id, status, started_at) VALUES (?, ?, ?, 'started', ?)").run(newId("rr"), routineId, messageId, now());
  boardChanged(routineOwner(routineId));
}

/** The run a routine's message started is over: done when the bot replied, failed when it didn't. */
export function finishRoutineRun(messageId: string, ok: boolean) {
  const db = ensureKruDatabase();
  const run = db.query("SELECT routine_id FROM kru_routine_runs WHERE message_id = ? AND status = 'started'").get(messageId) as { routine_id: string } | null;
  if (!run) return;
  db.query("UPDATE kru_routine_runs SET status = ?, finished_at = ? WHERE message_id = ? AND status = 'started'").run(ok ? "done" : "failed", now(), messageId);
  boardChanged(routineOwner(run.routine_id));
}

export function listRoutineRuns(routineId: string, limit = 20): { id: string; messageId: string | null; status: string; startedAt: string; finishedAt: string | null }[] {
  const rows = ensureKruDatabase()
    .query("SELECT id, message_id, status, started_at, finished_at FROM kru_routine_runs WHERE routine_id = ? ORDER BY started_at DESC LIMIT ?")
    .all(routineId, limit) as { id: string; message_id: string | null; status: string; started_at: string; finished_at: string | null }[];
  return rows.map((r) => ({ id: r.id, messageId: r.message_id, status: r.status, startedAt: r.started_at, finishedAt: r.finished_at }));
}

export type RunForBoard = {
  id: string;
  routineId: string;
  routineName: string;
  botId: string;
  threadId: string;
  status: "started" | "done" | "failed";
  startedAt: string;
  finishedAt: string | null;
};

/** A person's routine runs that are still going or started since `since`, newest first. */
export function recentRunsForUser(userId: string, since: string): RunForBoard[] {
  const rows = ensureKruDatabase()
    .query(
      `SELECT rr.id, rr.routine_id, r.name, r.bot_id, b.thread_id, rr.status, rr.started_at, rr.finished_at
       FROM kru_routine_runs rr JOIN kru_routines r ON r.id = rr.routine_id JOIN kru_bots b ON b.id = r.bot_id
       WHERE b.user_id = ? AND (rr.status = 'started' OR rr.started_at >= ? OR rr.finished_at >= ?)
       ORDER BY rr.started_at DESC LIMIT 100`,
    )
    .all(userId, since, since) as { id: string; routine_id: string; name: string; bot_id: string; thread_id: string; status: RunForBoard["status"]; started_at: string; finished_at: string | null }[];
  return rows.map((r) => ({ id: r.id, routineId: r.routine_id, routineName: r.name, botId: r.bot_id, threadId: r.thread_id, status: r.status, startedAt: r.started_at, finishedAt: r.finished_at }));
}

/** A person's next scheduled routines, soonest first. */
export function upcomingRoutines(userId: string, limit = 5): Routine[] {
  const rows = ensureKruDatabase()
    .query(
      `SELECT r.* FROM kru_routines r JOIN kru_bots b ON b.id = r.bot_id
       WHERE b.user_id = ? AND b.hidden = 0 AND r.enabled = 1 AND r.next_run_at IS NOT NULL ORDER BY r.next_run_at ASC LIMIT ?`,
    )
    .all(userId, limit) as Row[];
  return rows.map(toRoutine);
}

function routineOwner(routineId: string): string | null {
  const row = ensureKruDatabase().query("SELECT b.user_id FROM kru_routines r JOIN kru_bots b ON b.id = r.bot_id WHERE r.id = ?").get(routineId) as { user_id: string | null } | null;
  return row?.user_id ?? null;
}

/** What a run posts: the skill it uses (as /slug, so the turn loads it) and the prompt. */
export function routinePrompt(routine: Routine): string {
  const skill = routine.skillId ? getSkillForRoutine(routine.skillId, routineOwner(routine.id)) : null;
  return `[Routine: ${routine.name}]${skill ? ` Use /${skill.slug}.` : ""} ${routine.prompt}`;
}

/** The routine's skill, only from its owner's library. */
function getSkillForRoutine(id: string, userId: string | null): { slug: string } | null {
  return ensureKruDatabase().query("SELECT slug FROM kru_skills WHERE id = ? AND user_id IS ?").get(id, userId) as { slug: string } | null;
}
