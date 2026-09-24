import { SKILL_LIMITS, skillFilePath, slugify } from "@krubot/shared";
import { unzipSync, zipSync, type Zippable } from "fflate";

/*
 * A skill as a folder and as a .skill file. SKILL.md is YAML frontmatter
 * (name, description, and whatever else the author put there) over the
 * Markdown instructions; the other files sit next to it. A .skill is that
 * folder zipped, under a folder named for the skill, the way agent skills
 * are passed around. Pure: no database, no box, so it is tested alone.
 */

export type BundleFile = { path: string; data: Uint8Array; executable: boolean };

export type ParsedSkillMd = {
  /** The name to show: the frontmatter's metadata.title, else its name made readable. */
  name: string | null;
  description: string;
  instructions: string;
  /** Other top-level frontmatter, kept as it came (license, allowed-tools, metadata…). */
  meta: string;
};

/** A YAML scalar written so any text survives: JSON strings are YAML. */
function yamlString(value: string): string {
  return JSON.stringify(value);
}

/** One scalar value, plain, quoted or a block (`|`, `>`), from its first line and the indented lines after. */
function readScalar(first: string, rest: string[]): string {
  const head = first.trim();
  if (/^[|>][+-]?$/.test(head)) {
    const lines = rest.map((line) => line.replace(/^\s{1,}/, ""));
    return (head.startsWith("|") ? lines.join("\n") : lines.join(" ").replace(/\s+/g, " ")).trim();
  }
  const whole = [head, ...rest.map((line) => line.trim())].filter(Boolean).join(" ");
  if (whole.startsWith('"')) {
    try {
      return String(JSON.parse(whole));
    } catch {
      return whole.slice(1, whole.endsWith('"') ? -1 : undefined);
    }
  }
  if (whole.startsWith("'")) return whole.slice(1, whole.endsWith("'") ? -1 : undefined).replace(/''/g, "'");
  return whole;
}

/** "pdf-form-filler" → "Pdf form filler"; a name that already reads is left alone. */
export function readableName(name: string): string {
  if (!/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/.test(name)) return name;
  const words = name.replace(/[-_]+/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Reads a SKILL.md. Without frontmatter the whole text is the instructions. */
export function parseSkillMd(text: string): ParsedSkillMd {
  const source = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const match = /^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(source);
  if (!match) return { name: null, description: "", instructions: source.trim(), meta: "" };
  const body = source.slice(match[0].length).trim();
  // Top-level entries: a key at column 0 and the indented or blank lines under it.
  const entries: { key: string; first: string; rest: string[] }[] = [];
  for (const line of match[1]!.split("\n")) {
    const top = /^([A-Za-z0-9_-]+):(.*)$/.exec(line);
    if (top) entries.push({ key: top[1]!, first: top[2]!, rest: [] });
    else if (entries.length) entries[entries.length - 1]!.rest.push(line);
  }
  let name: string | null = null;
  let title: string | null = null;
  let description = "";
  const meta: string[] = [];
  for (const entry of entries) {
    const rest = entry.rest.filter((line, i, all) => line.trim() || all.slice(i).some((l) => l.trim()));
    if (entry.key === "name") name = readScalar(entry.first, rest);
    else if (entry.key === "description") description = readScalar(entry.first, rest);
    else if (entry.key === "slug" || entry.key === "title") {
      if (entry.key === "title") title = readScalar(entry.first, rest);
    } else if (entry.key === "metadata") {
      const kept = rest.filter((line) => {
        const found = /^\s+title:(.*)$/.exec(line);
        if (found) title = readScalar(found[1]!, []);
        return !found;
      });
      if (kept.some((line) => line.trim()) || entry.first.trim()) meta.push([`metadata:${entry.first}`, ...kept].join("\n"));
    } else meta.push([`${entry.key}:${entry.first}`, ...rest].join("\n"));
  }
  return { name: title || (name ? readableName(name) : null), description, instructions: body, meta: meta.join("\n") };
}

/**
 * Writes a SKILL.md: `name` is the slug (what agent tools expect: lower
 * case and dashes), the readable name rides in metadata.title, and any
 * other frontmatter the skill came with goes back as it was.
 */
export function renderSkillMd(skill: { slug: string; name: string; description: string; instructions: string; meta?: string }): string {
  const lines = [`name: ${skill.slug}`, `description: ${yamlString(skill.description || skill.name)}`];
  const meta = (skill.meta ?? "").trim();
  const title = `  title: ${yamlString(skill.name)}`;
  if (/^metadata:/m.test(meta)) {
    lines.push(meta.replace(/^metadata:.*$/m, (line) => `${line}\n${title}`));
  } else {
    if (meta) lines.push(meta);
    lines.push("metadata:", title);
  }
  return `---\n${lines.join("\n")}\n---\n\n${skill.instructions.trim()}\n`;
}

/** Whether bytes are text the editor can open: UTF-8 with no NULs. */
export function isText(data: Uint8Array): boolean {
  if (data.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(data);
    return true;
  } catch {
    return false;
  }
}

/** A file runs on its own when it starts with #!. */
export function looksExecutable(data: Uint8Array): boolean {
  return data.length > 2 && data[0] === 0x23 && data[1] === 0x21;
}

/** What is wrong with a set of files for one skill, or null. */
export function checkBundleFiles(files: { path: string; data: Uint8Array }[]): string | null {
  if (files.length > SKILL_LIMITS.files) return `A skill holds at most ${SKILL_LIMITS.files} files besides SKILL.md.`;
  let total = 0;
  const seen = new Set<string>();
  for (const file of files) {
    if (skillFilePath(file.path) !== file.path) return `"${file.path}" isn't a usable path inside a skill.`;
    if (seen.has(file.path)) return `"${file.path}" is there twice.`;
    seen.add(file.path);
    if (file.data.byteLength > SKILL_LIMITS.fileBytes) return `"${file.path}" is larger than ${SKILL_LIMITS.fileBytes / 1024 / 1024} MB.`;
    total += file.data.byteLength;
  }
  if (total > SKILL_LIMITS.totalBytes) return `The files come to more than ${SKILL_LIMITS.totalBytes / 1024 / 1024} MB.`;
  return null;
}

const UNIX_FILE = 0o100644;
const UNIX_EXEC = 0o100755;

/** The .skill file: `<slug>/SKILL.md` and `<slug>/<path>` for every other file, zipped. */
export function packSkill(skill: { slug: string; name: string; description: string; instructions: string; meta?: string }, files: BundleFile[]): Uint8Array {
  const entries: Zippable = {};
  const at = { os: 3, mtime: new Date("2020-01-01T00:00:00Z") };
  entries[`${skill.slug}/SKILL.md`] = [new TextEncoder().encode(renderSkillMd(skill)), { ...at, attrs: UNIX_FILE << 16 }];
  for (const file of files) entries[`${skill.slug}/${file.path}`] = [file.data, { ...at, attrs: (file.executable ? UNIX_EXEC : UNIX_FILE) << 16 }];
  return zipSync(entries, { level: 6 });
}

export type UnpackedSkill = { skillMd: string; folder: string | null; files: BundleFile[] };

/** Whether a folder or file in an archive is clutter an OS left there. */
function clutter(path: string): boolean {
  return path.split("/").some((part) => part === "__MACOSX" || part === ".DS_Store" || part === "Thumbs.db");
}

/**
 * Opens a .skill (or a .zip of a skill folder): finds the shallowest
 * SKILL.md, and takes it and everything under its folder. Sizes are
 * checked from the archive's own directory before anything is inflated,
 * so a small file can't unpack into gigabytes.
 */
export function unpackSkill(bytes: Uint8Array): UnpackedSkill | { error: string } {
  let listing: { name: string; size: number }[] = [];
  try {
    unzipSync(bytes, {
      filter: (file) => {
        listing.push({ name: file.name, size: file.originalSize });
        return false;
      },
    });
  } catch {
    return { error: "That isn't a .skill or .zip file." };
  }
  listing = listing.filter((entry) => !entry.name.endsWith("/") && !clutter(entry.name));
  const skillMds = listing.filter((entry) => entry.name === "SKILL.md" || entry.name.endsWith("/SKILL.md")).sort((a, b) => a.name.split("/").length - b.name.split("/").length);
  const top = skillMds[0];
  if (!top) return { error: "There's no SKILL.md in it." };
  const root = top.name.slice(0, -"SKILL.md".length);
  const wanted = listing.filter((entry) => entry.name.startsWith(root));
  if (wanted.length > SKILL_LIMITS.files + 1) return { error: `A skill holds at most ${SKILL_LIMITS.files} files besides SKILL.md.` };
  const total = wanted.reduce((sum, entry) => sum + entry.size, 0);
  if (top.size > SKILL_LIMITS.instructions * 4 || total > SKILL_LIMITS.totalBytes + top.size) return { error: `The skill comes to more than ${SKILL_LIMITS.totalBytes / 1024 / 1024} MB.` };
  const names = new Set(wanted.map((entry) => entry.name));
  let unpacked: Record<string, Uint8Array>;
  try {
    unpacked = unzipSync(bytes, { filter: (file) => names.has(file.name) });
  } catch {
    return { error: "The archive is damaged." };
  }
  const skillMd = unpacked[top.name];
  if (!skillMd || !isText(skillMd)) return { error: "SKILL.md isn't readable text." };
  const files: BundleFile[] = [];
  for (const [name, data] of Object.entries(unpacked)) {
    if (name === top.name) continue;
    const path = skillFilePath(name.slice(root.length));
    if (!path) continue;
    files.push({ path, data, executable: looksExecutable(data) });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  const problem = checkBundleFiles(files);
  if (problem) return { error: problem };
  const folder = root.replace(/\/$/, "").split("/").pop() || null;
  return { skillMd: new TextDecoder().decode(skillMd), folder, files };
}

/** The name for a skill that came without one: its folder's, made readable. */
export function nameFromFolder(folder: string | null): string {
  return readableName(slugify(folder ?? "") === "skill" ? "Imported skill" : slugify(folder ?? ""));
}
