import { skillMentions, type Skill } from "@krubot/shared";
import { boxConfig, deleteBoxFile, readBoxFile, writeBoxFile } from "./box.ts";
import { listSkills } from "./data/skills.ts";

/*
 * Skills on the box: every skill is also a file at ~/.skills/<slug>/SKILL.md,
 * so a bot can read it with its own tools and the person can see it from
 * the computer. The library in the database is the source of truth.
 */

export async function syncSkills(): Promise<void> {
  const box = boxConfig();
  if (!box) return;
  try {
    const skills = listSkills();
    const keep = new Set(skills.map((s) => s.slug));
    for (const skill of skills) await writeBoxFile(box, `.skills/${skill.slug}/SKILL.md`, renderSkill(skill));
    const listing = await readBoxFile(box, ".skills").catch(() => null);
    for (const name of listing?.directory ?? []) {
      if (!keep.has(name)) await deleteBoxFile(box, `.skills/${name}`).catch(() => undefined);
    }
  } catch (error) {
    console.warn(`[kru] could not sync skills to the box: ${error instanceof Error ? error.message : error}`);
  }
}

export function renderSkill(skill: Skill): string {
  return `---\nname: ${skill.name}\nslug: ${skill.slug}\ndescription: ${skill.description}\n---\n\n${skill.instructions.trim()}\n`;
}

/** The one-line index of the library, for the system prompt. */
export function skillsIndex(skills: Skill[]): string {
  if (skills.length === 0) return "- None yet. Save one with save_skill when a way of doing a job is worth keeping; the person can write one under Settings → Skills.";
  return skills.map((s) => `- /${s.slug}: ${s.name}${s.description ? ` — ${s.description}` : ""}`).join("\n");
}

/** The skills a message hands to the bot with /slug, in full. */
export function skillsFor(text: string, skills: Skill[]): Skill[] {
  const slugs = new Set(skillMentions(text));
  return skills.filter((s) => slugs.has(s.slug));
}
