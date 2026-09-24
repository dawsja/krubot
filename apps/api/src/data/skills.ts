import { PACKAGED_SKILLS, slugify, type Skill, type SkillFile, type SkillInput } from "@krubot/shared";
import { ensureKruDatabase, transaction } from "../db/init.ts";
import { skillsChanged } from "../events.ts";
import { newId, now } from "../ids.ts";
import { checkBundleFiles, isText, type BundleFile } from "../skill-bundle.ts";

/*
 * The skills library: each person's own, shared by all of their bots and
 * nobody else's. A skill is how to do one job, and a folder: the row is
 * SKILL.md (name, description, instructions, other frontmatter), and
 * kru_skill_files holds everything next to it (scripts, references,
 * templates, assets). A bot reads one when the person hands it over with
 * /slug, when a routine runs it, or when it asks for it by name.
 */

type Row = { id: string; user_id: string | null; slug: string; name: string; description: string; instructions: string; source: Skill["source"]; meta: string; created_at: string; updated_at: string };
type FileRow = { path: string; size: number; executable: number; text: number };

function filesOf(skillId: string): SkillFile[] {
  const rows = ensureKruDatabase().query("SELECT path, length(data) AS size, executable, text FROM kru_skill_files WHERE skill_id = ? ORDER BY path").all(skillId) as FileRow[];
  return rows.map((row) => ({ path: row.path, size: row.size, executable: Boolean(row.executable), text: Boolean(row.text) }));
}

function toSkill(row: Row): Skill & { userId: string | null; meta: string } {
  return {
    id: row.id,
    userId: row.user_id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    instructions: row.instructions,
    source: row.source,
    meta: row.meta,
    files: filesOf(row.id),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export type StoredSkill = ReturnType<typeof toSkill>;

/** A person's library, by name. */
export function listSkills(userId: string): StoredSkill[] {
  const rows = ensureKruDatabase().query("SELECT * FROM kru_skills WHERE user_id = ? ORDER BY name COLLATE NOCASE").all(userId) as Row[];
  return rows.map(toSkill);
}

/** The people who have any skills, for writing every library to the box. */
export function skillOwners(): string[] {
  return (ensureKruDatabase().query("SELECT DISTINCT user_id FROM kru_skills WHERE user_id IS NOT NULL").all() as { user_id: string }[]).map((r) => r.user_id);
}

/** A skill by id; with a person, only theirs. */
export function getSkill(id: string, userId?: string): StoredSkill | null {
  const row = ensureKruDatabase().query("SELECT * FROM kru_skills WHERE id = ?").get(id) as Row | null;
  if (!row || (userId !== undefined && row.user_id !== userId)) return null;
  return toSkill(row);
}

export function getSkillBySlug(userId: string, slug: string): StoredSkill | null {
  const row = ensureKruDatabase().query("SELECT * FROM kru_skills WHERE user_id = ? AND slug = ?").get(userId, slug) as Row | null;
  return row ? toSkill(row) : null;
}

/** A slug this person doesn't have yet: the name's, with a number when taken. */
function freeSlug(userId: string, name: string, except?: string): string {
  const base = slugify(name);
  const db = ensureKruDatabase();
  let slug = base;
  for (let n = 2; ; n += 1) {
    const taken = db.query("SELECT id FROM kru_skills WHERE user_id = ? AND slug = ?").get(userId, slug) as { id: string } | null;
    if (!taken || taken.id === except) return slug;
    slug = `${base}-${n}`;
  }
}

export class SkillFilesError extends Error {}

function ownerOf(skillId: string): string | null {
  return (ensureKruDatabase().query("SELECT user_id FROM kru_skills WHERE id = ?").get(skillId) as { user_id: string | null } | null)?.user_id ?? null;
}

function writeFiles(skillId: string, files: BundleFile[], at: string) {
  const db = ensureKruDatabase();
  for (const file of files) {
    db.query("INSERT INTO kru_skill_files (skill_id, path, data, executable, text, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (skill_id, path) DO UPDATE SET data = excluded.data, executable = excluded.executable, text = excluded.text, updated_at = excluded.updated_at").run(skillId, file.path, file.data, file.executable ? 1 : 0, isText(file.data) ? 1 : 0, at);
  }
}

/**
 * Adds a skill to a person's library, with any files it comes with.
 * Throws SkillFilesError when the files are past the limits.
 */
export function createSkill(userId: string, input: SkillInput, source: Skill["source"] = "written", extra: { files?: BundleFile[]; meta?: string } = {}): StoredSkill {
  const files = extra.files ?? [];
  const problem = checkBundleFiles(files);
  if (problem) throw new SkillFilesError(problem);
  const id = newId("sk");
  const at = now();
  transaction((db) => {
    db.query("INSERT INTO kru_skills (id, user_id, slug, name, description, instructions, source, meta, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(id, userId, freeSlug(userId, input.name), input.name, input.description, input.instructions, source, extra.meta ?? "", at, at);
    writeFiles(id, files, at);
  });
  skillsChanged(userId);
  return getSkill(id)!;
}

/**
 * Changes a skill. `files`, when given, replaces every file next to
 * SKILL.md; leave it out to keep them.
 */
export function updateSkill(id: string, patch: Partial<SkillInput> & { files?: BundleFile[]; meta?: string }): StoredSkill | null {
  const current = getSkill(id);
  if (!current || !current.userId) return null;
  if (patch.files) {
    const problem = checkBundleFiles(patch.files);
    if (problem) throw new SkillFilesError(problem);
  }
  const next = { ...current, ...patch };
  const slug = patch.name && patch.name !== current.name ? freeSlug(current.userId, patch.name, id) : current.slug;
  const at = now();
  transaction((db) => {
    db.query("UPDATE kru_skills SET slug = ?, name = ?, description = ?, instructions = ?, meta = ?, updated_at = ? WHERE id = ?").run(slug, next.name, next.description, next.instructions, next.meta, at, id);
    if (patch.files) {
      db.query("DELETE FROM kru_skill_files WHERE skill_id = ?").run(id);
      writeFiles(id, patch.files, at);
    }
  });
  skillsChanged(current.userId);
  return getSkill(id);
}

export function deleteSkill(id: string): boolean {
  const owner = getSkill(id)?.userId;
  let changed = 0;
  transaction((db) => {
    db.query("DELETE FROM kru_skill_files WHERE skill_id = ?").run(id);
    changed = db.query("DELETE FROM kru_skills WHERE id = ?").run(id).changes;
  });
  if (changed) skillsChanged(owner);
  return changed > 0;
}

// ---------- the files next to SKILL.md ----------

/** Every file of a skill with its bytes, for the box and for a .skill. */
export function skillFiles(skillId: string): BundleFile[] {
  const rows = ensureKruDatabase().query("SELECT path, data, executable FROM kru_skill_files WHERE skill_id = ? ORDER BY path").all(skillId) as { path: string; data: Uint8Array; executable: number }[];
  return rows.map((row) => ({ path: row.path, data: new Uint8Array(row.data), executable: Boolean(row.executable) }));
}

export function skillFile(skillId: string, path: string): BundleFile | null {
  const row = ensureKruDatabase().query("SELECT path, data, executable FROM kru_skill_files WHERE skill_id = ? AND path = ?").get(skillId, path) as { path: string; data: Uint8Array; executable: number } | null;
  return row ? { path: row.path, data: new Uint8Array(row.data), executable: Boolean(row.executable) } : null;
}

/** Adds or replaces one file, within the limits for the whole folder. */
export function putSkillFile(skillId: string, file: BundleFile): void {
  const others = skillFiles(skillId).filter((f) => f.path !== file.path);
  const problem = checkBundleFiles([...others, file]);
  if (problem) throw new SkillFilesError(problem);
  const at = now();
  transaction((db) => {
    writeFiles(skillId, [file], at);
    db.query("UPDATE kru_skills SET updated_at = ? WHERE id = ?").run(at, skillId);
  });
  skillsChanged(ownerOf(skillId));
}

/** Moves a file to another path in the same skill. */
export function renameSkillFile(skillId: string, from: string, to: string): boolean {
  const file = skillFile(skillId, from);
  if (!file) return false;
  if (from === to) return true;
  if (skillFile(skillId, to)) throw new SkillFilesError(`"${to}" is already there.`);
  const at = now();
  transaction((db) => {
    db.query("UPDATE kru_skill_files SET path = ?, updated_at = ? WHERE skill_id = ? AND path = ?").run(to, at, skillId, from);
    db.query("UPDATE kru_skills SET updated_at = ? WHERE id = ?").run(at, skillId);
  });
  skillsChanged(ownerOf(skillId));
  return true;
}

export function deleteSkillFile(skillId: string, path: string): boolean {
  const changed = ensureKruDatabase().query("DELETE FROM kru_skill_files WHERE skill_id = ? AND path = ?").run(skillId, path).changes;
  if (changed) {
    ensureKruDatabase().query("UPDATE kru_skills SET updated_at = ? WHERE id = ?").run(now(), skillId);
    skillsChanged(ownerOf(skillId));
  }
  return changed > 0;
}

/** Installs a packaged skill from the marketplace into a person's library; a second install is a no-op. */
export function installPackagedSkill(userId: string, packagedId: string): StoredSkill | null {
  const packaged = PACKAGED_SKILLS.find((s) => s.id === packagedId);
  if (!packaged) return null;
  const existing = getSkillBySlug(userId, packaged.id);
  if (existing) return existing;
  return createSkill(userId, { name: packaged.name, description: packaged.description, instructions: packaged.instructions }, "packaged");
}
