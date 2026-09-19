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
  test("blocks", () => {
    const blocks = parseMarkdown("# Title\n\n- one\n- two\n\n```sh\nls\n```");
    expect(blocks.map((b) => b.kind)).toEqual(["heading", "list", "code"]);
  });
});
