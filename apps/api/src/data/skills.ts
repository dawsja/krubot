import { PACKAGED_SKILLS, slugify, type Skill, type SkillInput } from "@krubot/shared";
import { ensureKruDatabase } from "../db/init.ts";
import { settingsChanged } from "../events.ts";
import { newId, now } from "../ids.ts";

/*
 * The skills library: one for the whole team. A skill is how to do one
 * job; a bot reads it when the person hands it over with /slug, when a
 * routine runs it, or when it asks for it by name.
 */

type Row = { id: string; slug: string; name: string; description: string; instructions: string; source: Skill["source"]; created_at: string; updated_at: string };

function toSkill(row: Row): Skill {
  return { id: row.id, slug: row.slug, name: row.name, description: row.description, instructions: row.instructions, source: row.source, createdAt: row.created_at, updatedAt: row.updated_at };
}

export function listSkills(): Skill[] {
  const rows = ensureKruDatabase().query("SELECT * FROM kru_skills ORDER BY name COLLATE NOCASE").all() as Row[];
  return rows.map(toSkill);
}

export function getSkill(id: string): Skill | null {
  const row = ensureKruDatabase().query("SELECT * FROM kru_skills WHERE id = ?").get(id) as Row | null;
  return row ? toSkill(row) : null;
}

export function getSkillBySlug(slug: string): Skill | null {
  const row = ensureKruDatabase().query("SELECT * FROM kru_skills WHERE slug = ?").get(slug) as Row | null;
  return row ? toSkill(row) : null;
}

/** A slug nobody else has: the name's, with a number when taken. */
function freeSlug(name: string, except?: string): string {
  const base = slugify(name);
  const db = ensureKruDatabase();
  let slug = base;
  for (let n = 2; ; n += 1) {
    const taken = db.query("SELECT id FROM kru_skills WHERE slug = ?").get(slug) as { id: string } | null;
    if (!taken || taken.id === except) return slug;
    slug = `${base}-${n}`;
  }
}

export function createSkill(input: SkillInput, source: Skill["source"] = "written"): Skill {
  const id = newId("sk");
  const at = now();
  ensureKruDatabase()
    .query("INSERT INTO kru_skills (id, slug, name, description, instructions, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(id, freeSlug(input.name), input.name, input.description, input.instructions, source, at, at);
  settingsChanged();
  return getSkill(id)!;
}

export function updateSkill(id: string, patch: Partial<SkillInput>): Skill | null {
  const current = getSkill(id);
  if (!current) return null;
  const next = { ...current, ...patch };
  const slug = patch.name && patch.name !== current.name ? freeSlug(patch.name, id) : current.slug;
  ensureKruDatabase().query("UPDATE kru_skills SET slug = ?, name = ?, description = ?, instructions = ?, updated_at = ? WHERE id = ?").run(slug, next.name, next.description, next.instructions, now(), id);
  settingsChanged();
  return getSkill(id);
}

export function deleteSkill(id: string): boolean {
  const changed = ensureKruDatabase().query("DELETE FROM kru_skills WHERE id = ?").run(id).changes;
  if (changed) settingsChanged();
  return changed > 0;
}

/** Installs a packaged skill from the marketplace; a second install is a no-op. */
export function installPackagedSkill(packagedId: string): Skill | null {
  const packaged = PACKAGED_SKILLS.find((s) => s.id === packagedId);
  if (!packaged) return null;
  const existing = getSkillBySlug(packaged.id);
  if (existing) return existing;
  return createSkill({ name: packaged.name, description: packaged.description, instructions: packaged.instructions }, "packaged");
}
