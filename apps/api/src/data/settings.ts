import { DEFAULT_ENGINES, ENGINE_ACCESS, ENGINES, MODEL_ID_PATTERN, type Connection, type Engine, type EngineSettings, type Onboarding, type Settings } from "@krubot/shared";
import { concurrency as defaultConcurrency } from "../config.ts";
import { ensureKruDatabase } from "../db/init.ts";
import { emit, settingsChanged } from "../events.ts";
import { now } from "../ids.ts";

const EMPTY_ONBOARDING: Onboarding = { done: false, apps: [], templates: [] };

/**
 * Each engine's settings from the stored JSON, over the defaults. An
 * install from before engines keeps its Claude model (the old `model`
 * column). Used by each person's AI settings (data/ai.ts), and to read
 * the team-wide row an older install had, once, for the admin.
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

/** What the whole team shares. The AI is each person's own (data/ai.ts). */
export function getSettings(): Settings {
  const row = ensureKruDatabase().query("SELECT onboarding, concurrency, timezone FROM kru_settings WHERE id = 1").get() as { onboarding: string; concurrency: number | null; timezone: string } | null;
  let onboarding = EMPTY_ONBOARDING;
  try {
    onboarding = { ...EMPTY_ONBOARDING, ...(JSON.parse(row?.onboarding ?? "{}") as Partial<Onboarding>) };
  } catch {
    /* defaults */
  }
  return {
    onboarding,
    concurrency: row?.concurrency ?? defaultConcurrency(),
    timezone: row?.timezone ?? "UTC",
  };
}

export function updateSettings(patch: Partial<Settings>): Settings {
  const current = getSettings();
  const next = {
    ...current,
    ...patch,
    onboarding: { ...current.onboarding, ...(patch.onboarding ?? {}) },
  };
  ensureKruDatabase()
    .query("UPDATE kru_settings SET onboarding = ?, concurrency = ?, timezone = ?, updated_at = ? WHERE id = 1")
    .run(JSON.stringify(next.onboarding), next.concurrency, next.timezone, now());
  settingsChanged();
  return getSettings();
}

// ---------- connected apps ----------

/*
 * Each person's own: a connection is an account in the Composio project of
 * the person's key, and only their bots may be given it.
 */

type ConnectionRow = { user_id: string; toolkit: string; name: string; account_id: string; status: string; created_at: string };

function toConnection(row: ConnectionRow): Connection {
  return { toolkit: row.toolkit, name: row.name, accountId: row.account_id, status: row.status as Connection["status"], createdAt: row.created_at };
}

export function listConnections(userId: string): Connection[] {
  const rows = ensureKruDatabase().query("SELECT * FROM kru_connections WHERE user_id = ? ORDER BY created_at").all(userId) as ConnectionRow[];
  return rows.map(toConnection);
}

export function getConnection(userId: string, toolkit: string): Connection | null {
  const row = ensureKruDatabase().query("SELECT * FROM kru_connections WHERE user_id = ? AND toolkit = ?").get(userId, toolkit) as ConnectionRow | null;
  return row ? toConnection(row) : null;
}

export function saveConnection(userId: string, input: { toolkit: string; name: string; accountId: string; status: Connection["status"] }): Connection {
  ensureKruDatabase()
    .query("INSERT INTO kru_connections (user_id, toolkit, name, account_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(user_id, toolkit) DO UPDATE SET name = excluded.name, account_id = excluded.account_id, status = excluded.status")
    .run(userId, input.toolkit, input.name, input.accountId, input.status, now());
  settingsChanged();
  return getConnection(userId, input.toolkit)!;
}

export function removeConnection(userId: string, toolkit: string): boolean {
  const changed = ensureKruDatabase().query("DELETE FROM kru_connections WHERE user_id = ? AND toolkit = ?").run(userId, toolkit).changes;
  if (changed) settingsChanged();
  return changed > 0;
}

/** Forgets every connection of a person's, when their key points at another Composio project. */
export function removeConnections(userId: string): void {
  const changed = ensureKruDatabase().query("DELETE FROM kru_connections WHERE user_id = ?").run(userId).changes;
  if (changed) settingsChanged();
}
