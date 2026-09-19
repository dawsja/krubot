import { describe, expect, test } from "bun:test";
import { parseInline, parseMarkdown } from "../lib/markdown";

describe("markdown", () => {
  test("inline code, bold and links", () => {
    const inlines = parseInline("run `ls` **now** [docs](https://example.com)");
    expect(inlines.map((i) => i.kind)).toEqual(["text", "code", "text", "bold", "text", "link"]);
  });
  test("a bare URL is a link, without the sentence's punctuation", () => {
    const inlines = parseInline("sign in here: https://example.com/a?b=1.");
    expect(inlines.map((i) => i.kind)).toEqual(["text", "link", "text"]);
    const link = inlines[1] as { href: string; text: string };
    expect(link.href).toBe("https://example.com/a?b=1");
    expect(link.text).toBe("https://example.com/a?b=1");
    expect(inlines.at(-1)).toEqual({ kind: "text", text: "." });
  });
  test("a bare URL keeps the brackets it opened and drops the ones it didn't", () => {
    expect((parseInline("(https://example.com/a)")[1] as { href: string }).href).toBe("https://example.com/a");
    expect((parseInline("https://en.wikipedia.org/wiki/Foo_(bar)")[0] as { href: string }).href).toBe("https://en.wikipedia.org/wiki/Foo_(bar)");
  });
  test("a URL inside a Markdown link stays one link", () => {
    const inlines = parseInline("[docs](https://example.com/a) and https://example.com/b");
    expect(inlines.map((i) => i.kind)).toEqual(["link", "text", "link"]);
    expect((inlines[0] as { text: string }).text).toBe("docs");
  });
  test("a pipe table becomes a table block, squared off and aligned", () => {
    const blocks = parseMarkdown("| Account | Value |\n|---|--:|\n| Roth IRA | $0.00 |\n| Agentic | $1,007.05 |");
    expect(blocks.map((b) => b.kind)).toEqual(["table"]);
    const table = blocks[0] as { align: string[]; head: unknown[][]; rows: unknown[][][] };
    expect(table.align).toEqual(["left", "right"]);
    expect(table.head).toHaveLength(2);
    expect(table.rows).toHaveLength(2);
    // Every row has the header's columns, whatever the row wrote.
    expect(table.rows.every((r) => r.length === 2)).toBe(true);
  });
  test("a table ends at a blank line and the text after it is its own block", () => {
    const blocks = parseMarkdown("| A |\n|---|\n| 1 |\n\nAfter the table.");
    expect(blocks.map((b) => b.kind)).toEqual(["table", "paragraph"]);
  });
  test("strikethrough", () => {
    expect(parseInline("~~gone~~ now").map((i) => i.kind)).toEqual(["strike", "text"]);
  });
  test("blocks", () => {
    const blocks = parseMarkdown("# Title\n\n- one\n- two\n\n```sh\nls\n```");
    expect(blocks.map((b) => b.kind)).toEqual(["heading", "list", "code"]);
  });
});
