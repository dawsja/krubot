import { describe, expect, test } from "bun:test";
import { parseInline, parseMarkdown, type Block } from "../lib/markdown";

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
  test("backslash escapes show the character, not the markup", () => {
    expect(parseInline("2 \\* 3 = 6 and \\_x\\_")).toEqual([{ kind: "text", text: "2 * 3 = 6 and _x_" }]);
  });
  test("an image is its link, and <br> is a line break", () => {
    const inlines = parseInline("![chart](https://example.com/c.png)<br>next");
    expect(inlines[0]).toEqual({ kind: "link", text: "chart", href: "https://example.com/c.png" });
    expect(inlines[1]).toEqual({ kind: "text", text: "\nnext" });
  });
  test("nested lists keep their depth however far they are indented, and numbers where they start", () => {
    const [list] = parseMarkdown("3. three\n    - four spaces\n        - eight\n4. four");
    expect(list?.kind).toBe("list");
    const items = (list as Extract<Block, { kind: "list" }>).items;
    expect(items.map((i) => i.depth)).toEqual([0, 1, 2, 0]);
    expect(items.map((i) => i.marker)).toEqual(["3.", "•", "•", "4."]);
  });
  test("task list items", () => {
    const [list] = parseMarkdown("- [x] done\n- [ ] to do");
    const items = (list as Extract<Block, { kind: "list" }>).items;
    expect(items.map((i) => i.task)).toEqual([true, false]);
    expect(items[0]?.inlines).toEqual([{ kind: "text", text: "done" }]);
  });
  test("an indented paragraph after a blank line stays in its list item", () => {
    const blocks = parseMarkdown("1. First\n\n   More on the first.\n2. Second");
    expect(blocks.map((b) => b.kind)).toEqual(["list"]);
    expect((blocks[0] as Extract<Block, { kind: "list" }>).items).toHaveLength(2);
  });
  test("a quote holds Markdown of its own, and a GitHub callout is marked", () => {
    const [quote] = parseMarkdown("> [!WARNING]\n> Careful:\n> - one\n> - two");
    expect(quote).toMatchObject({ kind: "quote", callout: "warning" });
    expect((quote as Extract<Block, { kind: "quote" }>).blocks.map((b) => b.kind)).toEqual(["paragraph", "list"]);
  });
  test("a fence keeps its language and loses blank edges and a list's indent", () => {
    const blocks = parseMarkdown("- step\n  ```Bash\n\n  ls -la\n    nested\n\n  ```");
    expect(blocks[1]).toEqual({ kind: "code", lang: "bash", text: "ls -la\n  nested" });
  });
  test("an underlined line is a heading", () => {
    expect(parseMarkdown("Summary\n=======")[0]).toMatchObject({ kind: "heading", level: 1 });
  });
});
