import type { AppCatalogEntry } from "@krubot/shared";

/*
 * Finding an app among every toolkit Composio offers: hundreds of them, so
 * the marketplace is a search and a page at a time rather than a scroll.
 *
 * The list only changes when it is fetched again (composio.ts caches it per
 * key), so all the reading of it happens once, in `indexApps`: every name,
 * slug, category and description squashed to letters and digits, their
 * words kept, and the characters each app holds gathered into a bitmask.
 * A search then costs one integer test per app — an app that hasn't got
 * the query's letters cannot match it under any rule here — and scores only
 * what survives, against strings that are already squashed. Nothing is
 * allocated per keystroke.
 *
 * The search is forgiving: a few letters in order find the app ("gsheet"
 * finds Google Sheets), a word inside the name counts as much as the
 * start, and the closer the letters sit the better the match.
 */

/** Letters and digits only: "Google Sheets" and "google_sheets" are the same thing. */
function squash(text: string) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/** The words of a name, for matching one of them ("sheets" finds Google Sheets). */
function words(text: string) {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** One field of an app, read once: squashed, and split into its words. */
type Field = { text: string; words: string[] };

function field(raw: string): Field {
  return { text: squash(raw), words: words(raw) };
}

type Indexed = {
  app: AppCatalogEntry;
  name: Field;
  slug: Field;
  category: Field;
  /** What Composio says the app does, squashed; only substrings of it count. */
  about: string;
};

/**
 * The catalog, ready to search. `apps` is the list as it is shown,
 * `bySlug`/`byWord` answer an app named outright, and `letters`/`digits`
 * say which characters each app holds, one entry per app in `entries`.
 */
export type AppIndex = {
  apps: AppCatalogEntry[];
  bySlug: Map<string, AppCatalogEntry>;
  /** Squashed slugs and names both, so "Google Sheets" finds googlesheets. */
  byWord: Map<string, AppCatalogEntry>;
  entries: Indexed[];
  letters: Uint32Array;
  digits: Uint16Array;
};

/** Which of a-z and which of 0-9 a squashed string holds. */
function maskOf(text: string): { letters: number; digits: number } {
  let letters = 0;
  let digits = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 97 && code <= 122) letters |= 1 << (code - 97);
    else if (code >= 48 && code <= 57) digits |= 1 << (code - 48);
  }
  return { letters, digits };
}

/** Reads the catalog once, so every search after it is comparisons only. */
export function indexApps(apps: AppCatalogEntry[]): AppIndex {
  const entries: Indexed[] = [];
  const letters = new Uint32Array(apps.length);
  const digits = new Uint16Array(apps.length);
  const bySlug = new Map<string, AppCatalogEntry>();
  const byWord = new Map<string, AppCatalogEntry>();
  apps.forEach((app, i) => {
    const entry: Indexed = { app, name: field(app.name), slug: field(app.toolkit), category: field(app.category), about: squash(app.description ?? "") };
    entries.push(entry);
    // Every rule below needs the query's own characters somewhere in the
    // app, so one mask over all four fields never hides a match.
    const mask = maskOf(entry.name.text + entry.slug.text + entry.category.text + entry.about);
    letters[i] = mask.letters;
    digits[i] = mask.digits;
    if (!bySlug.has(app.toolkit)) bySlug.set(app.toolkit, app);
    for (const word of [entry.slug.text, entry.name.text]) if (word && !byWord.has(word)) byWord.set(word, app);
  });
  return { apps, bySlug, byWord, entries, letters, digits };
}

/**
 * How far apart the query's letters sit in the text, in order, or -1 when
 * they aren't all there. A tight run reads as a better match.
 */
function spread(text: string, query: string): number {
  let first = -1;
  let at = 0;
  for (const letter of query) {
    const found = text.indexOf(letter, at);
    if (found < 0) return -1;
    if (first < 0) first = found;
    at = found + 1;
  }
  return at - 1 - first;
}

/**
 * How well a squashed query matches one field, 0 for no match at all. The
 * bands are exact, starts with, a word starts with, holds it, and the
 * letters in order; each one falls off with distance or length, so within
 * a band the shorter, earlier match wins.
 */
function scoreField(target: Field, query: string): number {
  const text = target.text;
  if (!query || !text) return 0;
  if (text === query) return 1000;
  if (text.startsWith(query)) return 800 - Math.min(text.length - query.length, 99);
  if (target.words.some((w) => w.startsWith(query))) return 600;
  const at = text.indexOf(query);
  if (at >= 0) return 500 - Math.min(at, 99);
  const run = spread(text, query);
  if (run >= 0) return Math.max(100, 300 - run);
  return 0;
}

/** How well a query matches one piece of text, for a one-off comparison. */
export function fuzzyScore(query: string, text: string): number {
  return scoreField(field(text), squash(query));
}

/** An app's score: its name first, then its slug, its category, and what Composio says it does. */
function scoreEntry(entry: Indexed, query: string): number {
  const name = scoreField(entry.name, query);
  const slug = scoreField(entry.slug, query) * 0.95;
  const category = scoreField(entry.category, query) * 0.35;
  const about = entry.about.includes(query) ? 90 : 0;
  return Math.max(name, slug, category, about);
}

/** The apps a query finds, best first; ties keep the list's own order (alphabetical). */
export function searchIndex(index: AppIndex, query: string): AppCatalogEntry[] {
  const q = squash(query);
  if (!q) return index.apps;
  const wanted = maskOf(q);
  const hits: { app: AppCatalogEntry; index: number; score: number }[] = [];
  for (let i = 0; i < index.entries.length; i++) {
    // An app without every one of the query's characters can't match.
    if ((wanted.letters & ~index.letters[i]!) !== 0 || (wanted.digits & ~index.digits[i]!) !== 0) continue;
    const entry = index.entries[i]!;
    const score = scoreEntry(entry, q);
    if (score > 0) hits.push({ app: entry.app, index: i, score });
  }
  return hits.sort((a, b) => b.score - a.score || a.index - b.index).map((hit) => hit.app);
}

/** The app somebody named outright, by slug or by name, however they spelled it. */
export function exactApp(index: AppIndex, query: string): AppCatalogEntry | null {
  return index.byWord.get(squash(query)) ?? null;
}

/** One page of a list, with the page clamped into what there is. */
export function pageOf<T>(items: T[], page: number, per: number): { items: T[]; page: number; pages: number; total: number } {
  const size = Math.max(1, Math.floor(per));
  const pages = Math.max(1, Math.ceil(items.length / size));
  const at = Math.min(Math.max(Math.floor(page) || 1, 1), pages);
  return { items: items.slice((at - 1) * size, at * size), page: at, pages, total: items.length };
}
