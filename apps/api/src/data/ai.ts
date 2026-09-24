import { DEFAULT_AI, ENGINE_LABELS, ENGINES, type AiSettings, type Engine, type EngineSettings, type ProviderKind } from "@krubot/shared";
import { ensureKruDatabase } from "../db/init.ts";
import { emit } from "../events.ts";
import { now } from "../ids.ts";
import { readEngines } from "./settings.ts";

/*
 * Settings → AI, each person's own: which CLI their bots run on, how each
 * CLI reaches its model (their plan, signed in inside their own account on
 * the computer, or their own API key) and which model. How hard a model
 * thinks is the model's own business: nothing here sets it.
 * Nobody's bots run on anyone else's plan or key. A person without a row
 * gets the defaults; the admin's row is seeded from the team-wide settings
 * an older install had (adoptOrphans).
 */

type Row = { user_id: string; engine: string; enabled: string | null; engines: string };

function isEngine(value: unknown): value is Engine {
  return typeof value === "string" && (ENGINES as readonly string[]).includes(value);
}

/**
 * The engines this person has turned on. The one in use is always among
 * them, so a stored row that lost track still answers with something that
 * runs.
 */
export function readEnabled(json: string | null, engine: Engine): Engine[] {
  let stored: unknown = null;
  try {
    stored = json ? JSON.parse(json) : null;
  } catch {
    /* the defaults below */
  }
  const list = Array.isArray(stored) ? stored.filter(isEngine) : [];
  const out = ENGINES.filter((candidate) => list.includes(candidate));
  return out.includes(engine) ? out : [engine, ...out];
}

function toAi(row: Row | null): AiSettings {
  if (!row) return { ...DEFAULT_AI, engines: { ...DEFAULT_AI.engines } };
  const engine = isEngine(row.engine) ? row.engine : DEFAULT_AI.engine;
  return { engine, enabled: readEnabled(row.enabled, engine), engines: readEngines(row.engines, null) };
}

export function getAi(userId: string): AiSettings {
  const row = ensureKruDatabase().query("SELECT user_id, engine, enabled, engines FROM kru_user_ai WHERE user_id = ?").get(userId) as Row | null;
  return toAi(row);
}

export function updateAi(userId: string, patch: { engine?: Engine; enabled?: Engine[]; engines?: Partial<Record<Engine, EngineSettings>> }): AiSettings {
  const current = getAi(userId);
  // Turning an engine on is what makes it pickable; the one in use is on by definition.
  const enabled = ENGINES.filter((engine) => (patch.enabled ?? current.enabled).includes(engine));
  const engine = patch.engine ?? (enabled.includes(current.engine) ? current.engine : (enabled[0] ?? DEFAULT_AI.engine));
  const next: AiSettings = {
    engine,
    enabled: enabled.includes(engine) ? enabled : [engine, ...enabled],
    engines: { ...current.engines, ...(patch.engines ?? {}) } as Record<Engine, EngineSettings>,
  };
  ensureKruDatabase()
    .query("INSERT INTO kru_user_ai (user_id, engine, enabled, engines, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (user_id) DO UPDATE SET engine = excluded.engine, enabled = excluded.enabled, engines = excluded.engines, updated_at = excluded.updated_at")
    .run(userId, next.engine, JSON.stringify(next.enabled), JSON.stringify(next.engines), now());
  emit({ topic: "ai", userId });
  return getAi(userId);
}

/**
 * Puts every engine of this person's that ran on `kind` back on their
 * plan, unless another API of that engine's still has a key. Called when a
 * key goes: the switch that put them on it goes with it, so nothing may be
 * left pointing at a key that isn't there.
 */
export function releaseEngines(userId: string, kind: ProviderKind, saved: (kind: ProviderKind) => boolean): AiSettings {
  const current = getAi(userId);
  const engines: Partial<Record<Engine, EngineSettings>> = {};
  for (const engine of ENGINES) {
    const config = current.engines[engine];
    const providers = ENGINE_LABELS[engine].providers;
    if (config.access !== "api" || !providers.includes(kind)) continue;
    if (providers.some((other) => other !== kind && saved(other))) continue;
    engines[engine] = { ...config, access: "plan" };
  }
  return Object.keys(engines).length ? updateAi(userId, { engines }) : current;
}

/**
 * The team-wide engine settings an older install kept in kru_settings
 * become the admin's own, once, when the admin has no row of their own.
 */
export function adoptLegacyAi(adminId: string): void {
  const db = ensureKruDatabase();
  if (db.query("SELECT 1 FROM kru_user_ai WHERE user_id = ?").get(adminId)) return;
  const legacy = db.query("SELECT model, engine, engines FROM kru_settings WHERE id = 1").get() as { model: string | null; engine: string | null; engines: string | null } | null;
  if (!legacy || (!legacy.engine && !legacy.engines && !legacy.model)) return;
  const engines = readEngines(legacy.engines, legacy.model);
  const engine = isEngine(legacy.engine) ? legacy.engine : "claude";
  db.query("INSERT INTO kru_user_ai (user_id, engine, enabled, engines, updated_at) VALUES (?, ?, ?, ?, ?)").run(adminId, engine, JSON.stringify([engine]), JSON.stringify(engines), now());
}
