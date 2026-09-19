import { DEFAULT_AI, EFFORT_LEVELS, ENGINES, type AiSettings, type EffortLevel, type Engine, type EngineSettings } from "@krubot/shared";
import { ensureKruDatabase } from "../db/init.ts";
import { emit } from "../events.ts";
import { now } from "../ids.ts";
import { readEngines } from "./settings.ts";

/*
 * Settings → AI, each person's own: which CLI their bots run on, how each
 * CLI reaches its model (their plan, signed in inside their own account on
 * the computer, or their own API key) and which model, and the effort.
 * Nobody's bots run on anyone else's plan or key. A person without a row
 * gets the defaults; the admin's row is seeded from the team-wide settings
 * an older install had (adoptOrphans).
 */

type Row = { user_id: string; engine: string; engines: string; effort: string | null };

function isEngine(value: unknown): value is Engine {
  return typeof value === "string" && (ENGINES as readonly string[]).includes(value);
}

function toAi(row: Row | null): AiSettings {
  if (!row) return { ...DEFAULT_AI, engines: { ...DEFAULT_AI.engines } };
  return {
    engine: isEngine(row.engine) ? row.engine : DEFAULT_AI.engine,
    engines: readEngines(row.engines, null),
    effort: (EFFORT_LEVELS as readonly string[]).includes(row.effort ?? "") ? (row.effort as EffortLevel) : null,
  };
}

export function getAi(userId: string): AiSettings {
  const row = ensureKruDatabase().query("SELECT user_id, engine, engines, effort FROM kru_user_ai WHERE user_id = ?").get(userId) as Row | null;
  return toAi(row);
}

export function updateAi(userId: string, patch: { engine?: Engine; engines?: Partial<Record<Engine, EngineSettings>>; effort?: EffortLevel | null }): AiSettings {
  const current = getAi(userId);
  const next: AiSettings = {
    engine: patch.engine ?? current.engine,
    engines: { ...current.engines, ...(patch.engines ?? {}) } as Record<Engine, EngineSettings>,
    effort: patch.effort === undefined ? current.effort : patch.effort,
  };
  ensureKruDatabase()
    .query("INSERT INTO kru_user_ai (user_id, engine, engines, effort, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (user_id) DO UPDATE SET engine = excluded.engine, engines = excluded.engines, effort = excluded.effort, updated_at = excluded.updated_at")
    .run(userId, next.engine, JSON.stringify(next.engines), next.effort, now());
  emit({ topic: "ai", userId });
  return getAi(userId);
}

/**
 * The team-wide engine settings an older install kept in kru_settings
 * become the admin's own, once, when the admin has no row of their own.
 */
export function adoptLegacyAi(adminId: string): void {
  const db = ensureKruDatabase();
  if (db.query("SELECT 1 FROM kru_user_ai WHERE user_id = ?").get(adminId)) return;
  const legacy = db.query("SELECT model, effort, engine, engines FROM kru_settings WHERE id = 1").get() as { model: string | null; effort: string | null; engine: string | null; engines: string | null } | null;
  if (!legacy || (!legacy.engine && !legacy.engines && !legacy.model && !legacy.effort)) return;
  const engines = readEngines(legacy.engines, legacy.model);
  const effort = (EFFORT_LEVELS as readonly string[]).includes(legacy.effort ?? "") ? legacy.effort : null;
  db.query("INSERT INTO kru_user_ai (user_id, engine, engines, effort, updated_at) VALUES (?, ?, ?, ?, ?)").run(adminId, isEngine(legacy.engine) ? legacy.engine : "claude", JSON.stringify(engines), effort, now());
}
