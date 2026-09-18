import { describe, expect, test } from "bun:test";
import { parseInline, parseMarkdown } from "../lib/markdown";

describe("markdown", () => {
  test("inline code, bold and links", () => {
    const inlines = parseInline("run `ls` **now** [docs](https://example.com)");
    expect(inlines.map((i) => i.kind)).toEqual(["text", "code", "text", "bold", "text", "link"]);
  });
  test("blocks", () => {
    const blocks = parseMarkdown("# Title\n\n- one\n- two\n\n```sh\nls\n```");
    expect(blocks.map((b) => b.kind)).toEqual(["heading", "list", "code"]);
  });
});
