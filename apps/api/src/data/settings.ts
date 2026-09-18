import { DEFAULT_ENGINES, EFFORT_LEVELS, ENGINE_ACCESS, ENGINES, MODEL_ID_PATTERN, type Connection, type EffortLevel, type Engine, type EngineSettings, type Onboarding, type Settings } from "@krubot/shared";
import { concurrency as defaultConcurrency } from "../config.ts";
import { ensureKruDatabase } from "../db/init.ts";
import { emit, settingsChanged } from "../events.ts";
import { now } from "../ids.ts";

const EMPTY_ONBOARDING: Onboarding = { done: false, apps: [], templates: [] };

function isEngine(value: unknown): value is Engine {
  return typeof value === "string" && (ENGINES as readonly string[]).includes(value);
}

/**
 * Each engine's settings from the stored JSON, over the defaults. An
 * install from before engines keeps its Claude model (the old `model`
 * column).
 */
export function readEngines(json: string | null, legacyModel: string | null): Record<Engine, EngineSettings> {
  let stored: Partial<Record<Engine, Partial<EngineSettings>>> = {};
  try {
    stored = json ? (JSON.parse(json) as typeof stored) : {};
  } catch {
    /* defaults */
  }
  const out = { ...DEFAULT_ENGINES };
  if (legacyModel && MODEL_ID_PATTERN.test(legacyModel)) out.claude = { ...out.claude, model: legacyModel };
  for (const engine of ENGINES) {
    const value = stored[engine];
    if (!value || typeof value !== "object") continue;
    out[engine] = {
      access: (ENGINE_ACCESS as readonly string[]).includes(value.access ?? "") ? value.access! : out[engine].access,
      model: typeof value.model === "string" && MODEL_ID_PATTERN.test(value.model) ? value.model : out[engine].model,
    };
  }
  return out;
}

export function getSettings(): Settings {
  const row = ensureKruDatabase().query("SELECT onboarding, concurrency, timezone, model, effort, engine, engines FROM kru_settings WHERE id = 1").get() as
    | { onboarding: string; concurrency: number | null; timezone: string; model: string | null; effort: string | null; engine: string | null; engines: string | null }
    | null;
  let onboarding = EMPTY_ONBOARDING;
  try {
    onboarding = { ...EMPTY_ONBOARDING, ...(JSON.parse(row?.onboarding ?? "{}") as Partial<Onboarding>) };
  } catch {
    /* defaults */
  }
  const effort = (EFFORT_LEVELS as readonly string[]).includes(row?.effort ?? "") ? (row!.effort as EffortLevel) : null;
  return {
    onboarding,
    concurrency: row?.concurrency ?? defaultConcurrency(),
    timezone: row?.timezone ?? "UTC",
    engine: isEngine(row?.engine) ? row.engine : "claude",
    engines: readEngines(row?.engines ?? null, row?.model ?? null),
    effort,
  };
}

export function updateSettings(patch: Partial<Settings>): Settings {
  const current = getSettings();
  const next = {
    ...current,
    ...patch,
    onboarding: { ...current.onboarding, ...(patch.onboarding ?? {}) },
    engines: { ...current.engines, ...(patch.engines ?? {}) },
  };
  ensureKruDatabase()
    .query("UPDATE kru_settings SET onboarding = ?, concurrency = ?, timezone = ?, model = ?, effort = ?, engine = ?, engines = ?, updated_at = ? WHERE id = 1")
    .run(JSON.stringify(next.onboarding), next.concurrency, next.timezone, next.engines.claude.model, next.effort, next.engine, JSON.stringify(next.engines), now());
  settingsChanged();
  return getSettings();
}

// ---------- connected apps ----------

type ConnectionRow = { toolkit: string; name: string; account_id: string; status: string; shared: number; created_at: string };

function toConnection(row: ConnectionRow): Connection {
  return { toolkit: row.toolkit, name: row.name, accountId: row.account_id, status: row.status as Connection["status"], shared: row.shared === 1, createdAt: row.created_at };
}

export function listConnections(): Connection[] {
  const rows = ensureKruDatabase().query("SELECT * FROM kru_connections ORDER BY created_at").all() as ConnectionRow[];
  return rows.map(toConnection);
}

export function getConnection(toolkit: string): Connection | null {
  const row = ensureKruDatabase().query("SELECT * FROM kru_connections WHERE toolkit = ?").get(toolkit) as ConnectionRow | null;
  return row ? toConnection(row) : null;
}

export function saveConnection(input: { toolkit: string; name: string; accountId: string; status: Connection["status"] }): Connection {
  ensureKruDatabase()
    .query("INSERT INTO kru_connections (toolkit, name, account_id, status, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(toolkit) DO UPDATE SET name = excluded.name, account_id = excluded.account_id, status = excluded.status")
    .run(input.toolkit, input.name, input.accountId, input.status, now());
  settingsChanged();
  return getConnection(input.toolkit)!;
}

/** Whether every user's bots may use the app, or only the admin's. */
export function setConnectionShared(toolkit: string, shared: boolean): Connection | null {
  const changed = ensureKruDatabase().query("UPDATE kru_connections SET shared = ? WHERE toolkit = ?").run(shared ? 1 : 0, toolkit).changes;
  if (changed) settingsChanged();
  return getConnection(toolkit);
}

export function removeConnection(toolkit: string): boolean {
  const changed = ensureKruDatabase().query("DELETE FROM kru_connections WHERE toolkit = ?").run(toolkit).changes;
  if (changed) settingsChanged();
  return changed > 0;
}
