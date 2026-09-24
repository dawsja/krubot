import type { UsageBot, UsageDay, UsageModel, UsageSummary, UsageTotals } from "@krubot/shared";
import { ensureKruDatabase } from "../db/init.ts";
import { newId, now } from "../ids.ts";

/*
 * What each turn used, the person's own. The responder writes a row when a
 * turn ends, whatever the engine; Usage reads them back grouped by day, by
 * bot and by model. Nothing here is shared between people.
 */

export type UsageInput = {
  userId: string;
  botId: string;
  threadId: string;
  engine: string;
  model: string;
  usage: { input: number; output: number; cachedInput: number } | null;
  cost: number | null;
};

type Row = { bot_id: string; engine: string; model: string; input: number; output: number; cached_input: number; cost: number | null; created_at: string };

const count = (value: number) => (Number.isFinite(value) && value > 0 ? Math.round(value) : 0);

/** Records one turn. A turn that reported nothing at all isn't worth a row. */
export function recordUsage(input: UsageInput): void {
  const cost = typeof input.cost === "number" && Number.isFinite(input.cost) && input.cost >= 0 ? input.cost : null;
  if (!input.usage && cost === null) return;
  ensureKruDatabase()
    .query("INSERT INTO kru_usage (id, user_id, bot_id, thread_id, engine, model, input, output, cached_input, cost, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(newId("u"), input.userId, input.botId, input.threadId, input.engine, input.model ?? "", count(input.usage?.input ?? 0), count(input.usage?.output ?? 0), count(input.usage?.cachedInput ?? 0), cost, now());
}

function empty(): UsageTotals {
  return { turns: 0, input: 0, output: 0, cachedInput: 0, cost: null };
}

function add(into: UsageTotals, row: Row) {
  into.turns += 1;
  into.input += row.input;
  into.output += row.output;
  into.cachedInput += row.cached_input;
  if (row.cost !== null) into.cost = (into.cost ?? 0) + row.cost;
}

/** A day as the team's clock has it, `YYYY-MM-DD`. */
function dayIn(timezone: string) {
  let format: Intl.DateTimeFormat;
  try {
    format = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" });
  } catch {
    format = new Intl.DateTimeFormat("en-CA", { timeZone: "UTC", year: "numeric", month: "2-digit", day: "2-digit" });
  }
  return (date: Date) => format.format(date);
}

/**
 * The last `days` days of one person's usage: totals, every day (empty ones
 * too, so a chart has no gaps), and by bot and by model, most used first.
 */
export function usageSummary(userId: string, days: number, timezone: string, at = new Date()): UsageSummary {
  const db = ensureKruDatabase();
  const since = new Date(at.getTime() - days * 24 * 60 * 60 * 1000);
  const rows = db
    .query("SELECT bot_id, engine, model, input, output, cached_input, cost, created_at FROM kru_usage WHERE user_id = ? AND created_at >= ? ORDER BY created_at ASC")
    .all(userId, since.toISOString()) as Row[];
  const day = dayIn(timezone);

  const daily = new Map<string, UsageDay>();
  for (let i = days - 1; i >= 0; i -= 1) {
    const key = day(new Date(at.getTime() - i * 24 * 60 * 60 * 1000));
    daily.set(key, { day: key, ...empty() });
  }
  const totals = empty();
  const bots = new Map<string, UsageBot>();
  const models = new Map<string, UsageModel>();
  const names = new Map(
    (db.query("SELECT id, name, color FROM kru_bots WHERE user_id = ?").all(userId) as { id: string; name: string; color: string | null }[]).map((b) => [b.id, b]),
  );

  for (const row of rows) {
    add(totals, row);
    const key = day(new Date(row.created_at));
    const inDay = daily.get(key);
    if (inDay) add(inDay, row);
    const known = names.get(row.bot_id);
    const bot = bots.get(row.bot_id) ?? { botId: row.bot_id, name: known?.name ?? "A deleted bot", color: known?.color ?? null, ...empty() };
    add(bot, row);
    bots.set(row.bot_id, bot);
    const modelKey = `${row.engine}\u0000${row.model}`;
    const model = models.get(modelKey) ?? { engine: row.engine, model: row.model, ...empty() };
    add(model, row);
    models.set(modelKey, model);
  }

  const heaviest = (a: UsageTotals, b: UsageTotals) => b.input + b.output - (a.input + a.output) || b.turns - a.turns;
  return { days, timezone, totals, daily: [...daily.values()], bots: [...bots.values()].sort(heaviest), models: [...models.values()].sort(heaviest) };
}
