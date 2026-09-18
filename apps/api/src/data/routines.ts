import type { Routine, RoutineInput } from "@krubot/shared";
import { Cron } from "croner";
import { ensureKruDatabase } from "../db/init.ts";
import { settingsChanged } from "../events.ts";
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
}

export function listRoutineRuns(routineId: string, limit = 20): { id: string; messageId: string | null; status: string; startedAt: string }[] {
  const rows = ensureKruDatabase()
    .query("SELECT id, message_id, status, started_at FROM kru_routine_runs WHERE routine_id = ? ORDER BY started_at DESC LIMIT ?")
    .all(routineId, limit) as { id: string; message_id: string | null; status: string; started_at: string }[];
  return rows.map((r) => ({ id: r.id, messageId: r.message_id, status: r.status, startedAt: r.started_at }));
}

/** What a run posts: the skill it uses (as /slug, so the turn loads it) and the prompt. */
export function routinePrompt(routine: Routine): string {
  const skill = routine.skillId ? getSkillForRoutine(routine.skillId) : null;
  return `[Routine: ${routine.name}]${skill ? ` Use /${skill.slug}.` : ""} ${routine.prompt}`;
}

function getSkillForRoutine(id: string): { slug: string } | null {
  return ensureKruDatabase().query("SELECT slug FROM kru_skills WHERE id = ?").get(id) as { slug: string } | null;
}
