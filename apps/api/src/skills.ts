import { SKILL_LIMITS, skillFilePath, skillMentions, type Skill } from "@krubot/shared";
import { BoxError, boxConfig, deleteBoxSkill, listBoxSkills, readBoxFile, readBoxFileBytes, writeBoxSkill, type BoxConfig } from "./box.ts";
import { listSkills, skillFiles, skillOwners, type StoredSkill } from "./data/skills.ts";
import { looksExecutable, renderSkillMd, unpackSkill, type BundleFile } from "./skill-bundle.ts";

/*
 * Skills on the box: every person's library is also a folder of folders,
 * ~/.skills/<slug>/ with SKILL.md and the skill's other files, in that
 * person's home only, so their bots can read the instructions and run the
 * scripts with their own tools. It is root's and read-only to them: the
 * library in the database is the source of truth, and the mirror is
 * rewritten from it at start, after a reset, on every change, and before
 * a person's first turn in this process in case the start missed it.
 */

/** People whose mirror has been written since this process started. */
const synced = new Set<string>();
/** One sync at a time per person, so two changes can't interleave their writes. */
const running = new Map<string, Promise<void>>();

function toBoxFiles(skill: StoredSkill) {
  const md = { path: "SKILL.md", data: Buffer.from(renderSkill(skill)).toString("base64"), executable: false };
  return [md, ...skillFiles(skill.id).map((file) => ({ path: file.path, data: Buffer.from(file.data).toString("base64"), executable: file.executable }))];
}

async function syncPerson(userId: string): Promise<void> {
  const box = boxConfig(userId);
  if (!box) return;
  const skills = listSkills(userId);
  const keep = new Set(skills.map((s) => s.slug));
  for (const skill of skills) await writeBoxSkill(box, skill.slug, toBoxFiles(skill));
  const listing = await listBoxSkills(box).catch(() => null);
  for (const name of listing?.skills ?? []) {
    if (!keep.has(name)) await deleteBoxSkill(box, name).catch(() => undefined);
  }
  synced.add(userId);
}

/**
 * Writes a person's library to their home on the box, or everyone's
 * without a person (at start, after an update or a reset).
 */
export async function syncSkills(userId?: string): Promise<void> {
  if (!boxConfig()) return;
  if (userId === undefined) synced.clear();
  const people = userId === undefined ? skillOwners() : [userId];
  for (const person of people) {
    const before = running.get(person) ?? Promise.resolve();
    const next = before.then(() => syncPerson(person)).catch((error) => {
      console.warn(`[kru] could not sync skills to the box: ${error instanceof Error ? error.message : error}`);
    });
    running.set(person, next);
    await next;
    if (running.get(person) === next) running.delete(person);
  }
}

/** Before a person's turn: their mirror, written once per process if nothing else has. */
export async function skillsReady(userId: string): Promise<void> {
  if (synced.has(userId)) return;
  await syncSkills(userId);
}

export function renderSkill(skill: StoredSkill): string {
  return renderSkillMd(skill);
}

function filesLine(skill: Pick<Skill, "files">): string {
  if (!skill.files.length) return "";
  const shown = skill.files.slice(0, 12).map((f) => f.path);
  return ` [files: ${shown.join(", ")}${skill.files.length > shown.length ? `, +${skill.files.length - shown.length} more` : ""}]`;
}

/** The one-line index of the library, for the system prompt. */
export function skillsIndex(skills: Skill[]): string {
  if (skills.length === 0) return "- None yet. Save one with save_skill when a way of doing a job is worth keeping, or when the person asks you to make a skill; they can also write or import one under Settings → Skills.";
  return skills.map((s) => `- /${s.slug}: ${s.name}${s.description ? ` — ${s.description.split("\n")[0]!.slice(0, 300)}` : ""}${filesLine(s)}`).join("\n");
}

/** The skills a message hands to the bot with /slug, in full. */
export function skillsFor<T extends Skill>(text: string, skills: T[]): T[] {
  const slugs = new Set(skillMentions(text));
  return skills.filter((s) => slugs.has(s.slug));
}

/** What a bot is told about a skill it uses: the instructions, and where its files are. */
export function skillBrief(skill: Skill, limit: number = SKILL_LIMITS.instructions): string {
  const files = skill.files.length
    ? `\n\nIts folder is ~/.skills/${skill.slug}/ (read-only; copy a file to your own folder to change it). Files: ${skill.files.map((f) => `${f.path}${f.executable ? " (executable)" : ""}`).join(", ")}. Paths in the instructions are relative to that folder; run scripts from there, like \`python3 ~/.skills/${skill.slug}/scripts/x.py\`.`
    : "";
  return `${skill.instructions.trim().slice(0, limit)}${files}`;
}

// ---------- a skill folder a bot made on the computer ----------

const SKIPPED = new Set(["node_modules", "__pycache__", ".venv", "venv", ".git", "__MACOSX"]);

/**
 * Reads a skill a bot built on the computer into a bundle: a folder with
 * SKILL.md and whatever sits next to it, or a .skill / .zip file. Hidden
 * files, caches and virtualenvs are left behind.
 */
export async function readSkillFromBox(box: BoxConfig, relative: string): Promise<{ skillMd: string | null; folder: string | null; files: BundleFile[] } | { error: string }> {
  let top: { directory?: string[] };
  try {
    top = await readBoxFile(box, relative);
  } catch (error) {
    if (!(error instanceof BoxError && error.status === 413)) return { error: error instanceof Error ? error.message : "it couldn't be read" };
    top = {};
  }
  if (!top.directory) {
    if (!/\.(skill|zip)$/i.test(relative)) return { error: "give the skill's folder (with SKILL.md in it) or a .skill file" };
    try {
      return unpackSkill(await readBoxFileBytes(box, relative));
    } catch (error) {
      return { error: error instanceof Error ? error.message : "it couldn't be read" };
    }
  }
  let skillMd: string | null = null;
  const files: BundleFile[] = [];
  let total = 0;
  async function walk(dir: string, prefix: string, depth: number): Promise<string | null> {
    if (depth > 8) return null;
    const listing = await readBoxFile(box, dir);
    for (const name of listing.directory ?? []) {
      if (name.startsWith(".") || SKIPPED.has(name)) continue;
      const path = prefix ? `${prefix}/${name}` : name;
      const child = `${dir}/${name}`;
      let info: { content?: string; directory?: string[]; binary?: boolean };
      try {
        info = await readBoxFile(box, child);
      } catch (error) {
        if (!(error instanceof BoxError && error.status === 413)) throw error;
        info = { binary: true };
      }
      if (info.directory) {
        const problem = await walk(child, path, depth + 1);
        if (problem) return problem;
        continue;
      }
      const data = info.content !== undefined ? new TextEncoder().encode(info.content) : await readBoxFileBytes(box, child);
      if (path === "SKILL.md") {
        skillMd = new TextDecoder().decode(data);
        continue;
      }
      const clean = skillFilePath(path);
      if (!clean) continue;
      if (data.byteLength > SKILL_LIMITS.fileBytes) return `${path} is larger than ${SKILL_LIMITS.fileBytes / 1024 / 1024} MB`;
      total += data.byteLength;
      if (files.length >= SKILL_LIMITS.files || total > SKILL_LIMITS.totalBytes) return `the folder holds more than a skill can (${SKILL_LIMITS.files} files, ${SKILL_LIMITS.totalBytes / 1024 / 1024} MB)`;
      files.push({ path: clean, data, executable: looksExecutable(data) });
    }
    return null;
  }
  try {
    const problem = await walk(relative.replace(/\/+$/, ""), "", 0);
    if (problem) return { error: problem };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "the folder couldn't be read" };
  }
  return { skillMd, folder: relative.replace(/\/+$/, "").split("/").pop() ?? null, files };
}
