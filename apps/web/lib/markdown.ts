/*
 * A small Markdown reader for what agents say while they work: paragraphs,
 * headings, lists (nested, numbered from where they start, and task
 * lists), quotes and GitHub's callouts, fenced code, tables, rules, and
 * inline code, bold, italics, strikethrough and links. It builds a tree
 * rather than HTML, so the conversation renders it as React elements and
 * the watch terminal as ANSI, and nothing an agent writes is ever injected
 * as markup. It is forgiving on purpose: agents indent lists by two, three
 * or four spaces, put <br> in table cells, and escape what they meant to
 * show, and every one of those should still read cleanly.
 */

export type Inline =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string }
  | { kind: "bold" | "italic" | "strike"; children: Inline[] }
  | { kind: "link"; text: string; href: string };

export type Align = "left" | "center" | "right";

export type ListItem = {
  depth: number;
  /** "•" for a bullet, or the number the agent wrote ("3."). */
  marker: string;
  ordered: boolean;
  /** A task list item's box: ticked or not; null for a plain item. */
  task: boolean | null;
  inlines: Inline[];
};

export type Callout = "note" | "tip" | "important" | "warning" | "caution";

export type Block =
  | { kind: "paragraph"; inlines: Inline[] }
  | { kind: "heading"; level: number; inlines: Inline[] }
  | { kind: "list"; ordered: boolean; items: ListItem[] }
  | { kind: "quote"; callout: Callout | null; blocks: Block[] }
  | { kind: "code"; lang: string; text: string }
  | { kind: "table"; align: Align[]; head: Inline[][]; rows: Inline[][][] }
  | { kind: "rule" };

/*
 * In order: a backslash escape, inline code, bold (** or __),
 * strikethrough, italics (* or _), an image (shown as its link: a bot hands
 * files over with send_file), a link, and last a bare URL: agents write
 * links as plain text far more often than as [text](url), and a sign-in
 * link nobody can tap is no link at all.
 */
const INLINE =
  /\\([\\`*_{}[\]()#+\-.!|~<>])|(`+)([^`]|[^`][\s\S]*?[^`])\2(?!`)|\*\*(?=\S)([\s\S]*?\S)\*\*|__(?=\S)([\s\S]*?\S)__|~~(?=\S)([\s\S]*?\S)~~|(?<![\w*\\])\*(?=[^*\s])([^*\n]*?[^*\s\\])\*(?![\w*])|(?<![\w_\\])_(?=[^_\s])([^_\s]|[^_\n]*?[^_\s\\])_(?![\w_])|!\[([^\]\n]*)\]\(((?:https?:\/\/|mailto:)[^\s)]+)\)|\[([^\]\n]+)\]\(((?:https?:\/\/|mailto:)[^\s)]+)\)|(https?:\/\/[^\s<>`\]]+)/g;

const count = (text: string, char: string) => text.split(char).length - 1;

/**
 * A bare URL at the end of a sentence shouldn't swallow the full stop, and
 * one inside brackets shouldn't swallow the closing one. A closing bracket
 * the URL opened itself stays (Wikipedia's are like that).
 */
function trimUrl(url: string): string {
  let out = url;
  for (;;) {
    const end = out.at(-1) ?? "";
    if (".,;:!?'\"*".includes(end)) out = out.slice(0, -1);
    else if (end === ")" && count(out, ")") > count(out, "(")) out = out.slice(0, -1);
    else return out;
  }
}

/** Pushes text, joined to the text before it so escapes don't leave a trail of pieces. */
function pushText(out: Inline[], text: string) {
  if (!text) return;
  const last = out.at(-1);
  if (last?.kind === "text") last.text += text;
  else out.push({ kind: "text", text });
}

export function parseInline(source: string): Inline[] {
  // An agent's <br> (they put them in table cells) is a line break, not markup to show.
  const text = source.replace(/<br\s*\/?>/gi, "\n");
  const out: Inline[] = [];
  let last = 0;
  for (const match of text.matchAll(INLINE)) {
    const index = match.index ?? 0;
    if (index < last) continue;
    pushText(out, text.slice(last, index));
    const [, escaped, ticks, code, bold1, bold2, strike, italic1, italic2, imageAlt, imageHref, linkText, href, bare] = match;
    let consumed = match[0].length;
    if (escaped) pushText(out, escaped);
    else if (ticks) out.push({ kind: "code", text: ticks.length > 1 ? code.trim() : code });
    else if (bold1 ?? bold2) out.push({ kind: "bold", children: parseInline(bold1 ?? bold2) });
    else if (strike) out.push({ kind: "strike", children: parseInline(strike) });
    else if (italic1 ?? italic2) out.push({ kind: "italic", children: parseInline(italic1 ?? italic2) });
    else if (imageHref) out.push({ kind: "link", text: imageAlt.trim() || imageHref, href: imageHref });
    else if (bare) {
      const url = trimUrl(bare);
      out.push({ kind: "link", text: url, href: url });
      consumed = url.length;
    } else out.push({ kind: "link", text: linkText, href });
    last = index + consumed;
  }
  pushText(out, text.slice(last));
  return out;
}

const FENCE = /^(\s*)(`{3,}|~{3,})\s*([\w+#.-]*)/;
const TABLE_CELL_RULE = /^:?-+:?$/;

/** The cells of one row, without the outer pipes; `\|` stays a pipe. */
function cellsOf(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split(/(?<!\\)\|/)
    .map((cell) => cell.replace(/\\\|/g, "|").trim());
}
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/;
const LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const TASK = /^\[([ xX])\]\s+(.*)$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const CALLOUT = /^\[!(note|tip|important|warning|caution)\]\s*$/i;

const widthOf = (indent: string) => indent.replace(/\t/g, "    ").length;

export function parseMarkdown(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  // The indents of the list being read, outermost first: how deep an item is, whatever the agent indented by.
  let indents: number[] = [];

  const flush = () => {
    if (paragraph.length) blocks.push({ kind: "paragraph", inlines: parseInline(paragraph.join("\n")) });
    paragraph = [];
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const fence = FENCE.exec(line);
    if (fence) {
      flush();
      const body: string[] = [];
      const [, indent, marks, lang] = fence;
      const close = new RegExp(`^\\s*${marks![0] === "`" ? "`" : "~"}{${marks!.length},}\\s*$`);
      // A fence inside a list item is indented; its lines lose that indent, not their own.
      const strip = new RegExp(`^ {0,${widthOf(indent!)}}`);
      for (i += 1; i < lines.length && !close.test(lines[i]!); i += 1) body.push(lines[i]!.replace(strip, ""));
      while (body.length && !body.at(-1)!.trim()) body.pop();
      while (body.length && !body[0]!.trim()) body.shift();
      blocks.push({ kind: "code", lang: lang!.toLowerCase(), text: body.join("\n") });
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    if (RULE.test(line) && !paragraph.length) {
      blocks.push({ kind: "rule" });
      continue;
    }
    // A line of === or --- under a line of text makes it a heading (setext).
    if (paragraph.length === 1 && /^\s{0,3}(={2,}|-{2,})\s*$/.test(line)) {
      blocks.push({ kind: "heading", level: line.trim().startsWith("=") ? 1 : 2, inlines: parseInline(paragraph[0]!.trim()) });
      paragraph = [];
      continue;
    }
    if (RULE.test(line)) {
      flush();
      blocks.push({ kind: "rule" });
      continue;
    }
    // A table is a header line, a line of dashes, then rows until a blank one.
    const next = lines[i + 1];
    const head = line.includes("|") ? cellsOf(line) : null;
    const rule = head && next !== undefined && next.includes("-") ? cellsOf(next) : null;
    // The dashes say where the table is, and must have the header's columns.
    if (head && rule && rule.length === head.length && rule.every((cell) => TABLE_CELL_RULE.test(cell))) {
      const align: Align[] = rule.map((cell) => (cell.startsWith(":") && cell.endsWith(":") ? "center" : cell.endsWith(":") ? "right" : "left"));
      const rows: Inline[][][] = [];
      let at = i + 2;
      for (; at < lines.length && lines[at]!.trim() && lines[at]!.includes("|"); at += 1) {
        const cells = cellsOf(lines[at]!);
        // Square it off, so a short or long row still lines up.
        rows.push(head.map((_, column) => parseInline(cells[column] ?? "")));
      }
      flush();
      blocks.push({ kind: "table", align, head: head.map((cell) => parseInline(cell)), rows });
      i = at - 1;
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      flush();
      blocks.push({ kind: "heading", level: heading[1]!.length, inlines: parseInline(heading[2]!) });
      continue;
    }
    const item = LIST_ITEM.exec(line);
    if (item) {
      flush();
      const ordered = /\d/.test(item[2]!);
      const indent = widthOf(item[1]!);
      const previous = blocks.at(-1);
      // A nested item joins the list above it whatever its kind; a new top-level kind starts a new list.
      const joins = previous?.kind === "list" && (indent > (indents[0] ?? 0) || previous.ordered === ordered);
      if (!joins) indents = [];
      const list = joins ? (previous as Extract<Block, { kind: "list" }>) : (blocks[blocks.push({ kind: "list", ordered, items: [] }) - 1] as Extract<Block, { kind: "list" }>);
      while (indents.length && indent < indents.at(-1)!) indents.pop();
      if (!indents.length || indent > indents.at(-1)!) indents.push(indent);
      const task = TASK.exec(item[3]!);
      list.items.push({
        depth: indents.length - 1,
        marker: ordered ? `${parseInt(item[2]!, 10)}.` : "•",
        ordered,
        task: task ? task[1] !== " " : null,
        inlines: parseInline(task ? task[2]! : item[3]!),
      });
      continue;
    }
    const quote = QUOTE.exec(line);
    if (quote) {
      flush();
      // The whole quote at once, read as Markdown of its own.
      const inner: string[] = [];
      for (; i < lines.length; i += 1) {
        const q = QUOTE.exec(lines[i]!);
        if (!q) break;
        inner.push(q[1]!);
      }
      i -= 1;
      const callout = CALLOUT.exec(inner[0] ?? "");
      blocks.push({ kind: "quote", callout: callout ? (callout[1]!.toLowerCase() as Callout) : null, blocks: parseMarkdown((callout ? inner.slice(1) : inner).join("\n")) });
      continue;
    }
    // An indented line after a list item continues that item, even after a blank line.
    const previous = blocks.at(-1);
    if (!paragraph.length && previous?.kind === "list" && /^\s+\S/.test(line)) {
      const blank = !lines[i - 1]?.trim();
      previous.items.at(-1)?.inlines.push({ kind: "text", text: blank ? "\n\n" : " " }, ...parseInline(line.trim()));
      continue;
    }
    paragraph.push(line);
  }
  flush();
  return blocks;
}

/** The words of some inline Markdown, without its markers. */
export function plainInline(inlines: Inline[]): string {
  return inlines
    .map((inline) => ("children" in inline ? plainInline(inline.children) : inline.text))
    .join("");
}

const ESC = "\x1b[";
/** Kru's orange, for markers and headings in the terminal. */
const ACCENT = `${ESC}38;2;255;106;51m`;
const DEFAULT_FG = `${ESC}39m`;

function inlineAnsi(inlines: Inline[]): string {
  return inlines
    .map((inline) => {
      switch (inline.kind) {
        case "text":
          return inline.text;
        case "code":
          return `${ESC}36m${inline.text}${DEFAULT_FG}`;
        case "bold":
          return `${ESC}1m${inlineAnsi(inline.children)}${ESC}22m`;
        case "italic":
          return `${ESC}3m${inlineAnsi(inline.children)}${ESC}23m`;
        case "strike":
          return `${ESC}9m${inlineAnsi(inline.children)}${ESC}29m`;
        case "link":
          return `${ESC}4m${inline.text}${ESC}24m ${ESC}2m(${inline.href})${ESC}22m`;
      }
    })
    .join("");
}

/** Markdown as terminal text: bold, italics, colors and box-drawing, lines ending in "\n". */
export function markdownToAnsi(source: string): string {
  return blocksAnsi(parseMarkdown(source));
}

function blocksAnsi(blocks: Block[]): string {
  const out: string[] = [];
  for (const block of blocks) {
    switch (block.kind) {
      case "paragraph":
        out.push(inlineAnsi(block.inlines));
        break;
      case "heading":
        out.push(`${ESC}1m${ACCENT}${inlineAnsi(block.inlines)}${DEFAULT_FG}${ESC}22m`);
        break;
      case "list":
        out.push(
          block.items
            .map((item) => `${"  ".repeat(item.depth + 1)}${ACCENT}${item.task === null ? item.marker : item.task ? "☑" : "☐"}${DEFAULT_FG} ${inlineAnsi(item.inlines)}`)
            .join("\n"),
        );
        break;
      case "quote":
        out.push(
          `${block.callout ? `${ESC}1m${block.callout.toUpperCase()}${ESC}22m\n` : ""}${blocksAnsi(block.blocks)}`
            .trimEnd()
            .split("\n")
            .map((line) => `${ESC}2m▎${ESC}22m ${ESC}3m${line}${ESC}23m`)
            .join("\n"),
        );
        break;
      case "code": {
        const label = block.lang ? ` ${block.lang}` : "";
        const body = block.text
          .split("\n")
          .map((line) => `${ESC}2m│${ESC}22m ${ESC}33m${line}${DEFAULT_FG}`)
          .join("\n");
        out.push(`${ESC}2m╭─${label}${ESC}22m\n${body}\n${ESC}2m╰─${ESC}22m`);
        break;
      }
      case "table":
        out.push(
          [block.head, ...block.rows]
            .map((row, r) => row.map((cell) => (r === 0 ? `${ESC}1m${inlineAnsi(cell)}${ESC}22m` : inlineAnsi(cell))).join(`  ${ESC}2m│${ESC}22m  `))
            .join("\n"),
        );
        break;
      case "rule":
        out.push(`${ESC}2m${"─".repeat(24)}${ESC}22m`);
        break;
    }
  }
  return out.length ? `${out.join("\n\n")}\n` : "";
}
