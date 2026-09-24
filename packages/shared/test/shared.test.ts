import { describe, expect, test } from "bun:test";
import { BOT_TEMPLATES, botInputSchema, handleOf, joinCommandLine, mentionsIn, pickBotName, splitCommandLine } from "../src/index.ts";

describe("shared", () => {
  test("pickBotName avoids taken names and numbers when exhausted", () => {
    expect(pickBotName(["scout"], () => 0)).not.toBe("Scout");
    const all = [...Array(200)].map((_, i) => `n${i}`);
    const name = pickBotName(all, () => 0);
    expect(name).toBeTruthy();
  });

  test("mentions are lowercased and unique", () => {
    expect(mentionsIn("@Scout and @scout, then @Pixel-2")).toEqual(["scout", "pixel-2"]);
    expect(mentionsIn("mail me at a@b.com")).toEqual([]);
  });

  test("handles drop spaces and punctuation", () => {
    expect(handleOf("Chief of Staff")).toBe("chiefofstaff");
  });

  test("templates parse as bot input", () => {
    for (const t of BOT_TEMPLATES) {
      const parsed = botInputSchema.safeParse({ name: t.name, title: t.title, description: t.description, color: t.color, expression: t.expression, isChief: t.isChief ?? false, toolkits: t.toolkits });
      expect(parsed.success).toBe(true);
    }
  });

  test("bot input defaults", () => {
    const bot = botInputSchema.parse({ name: "Pip" });
    expect(bot.approval).toBe("ask");
    expect(bot.toolkits).toEqual([]);
  });

  test("a command line splits like a shell and joins back", () => {
    expect(splitCommandLine("")).toEqual([]);
    expect(splitCommandLine("  uv  run -m  aseprite_mcp ")).toEqual(["uv", "run", "-m", "aseprite_mcp"]);
    expect(splitCommandLine(`uv --directory "/home/agent/My Tools/mcp" run`)).toEqual(["uv", "--directory", "/home/agent/My Tools/mcp", "run"]);
    expect(splitCommandLine(`echo 'a "b"' "c \\"d\\"" e\\ f ''`)).toEqual(["echo", 'a "b"', 'c "d"', "e f", ""]);
    for (const words of [["uv", "--directory", "/a b/c", "run"], ["say", "it's", 'a "quote"', "back\\slash", ""]]) {
      expect(splitCommandLine(joinCommandLine(words))).toEqual(words);
    }
    expect(joinCommandLine(["uv", "run"])).toBe("uv run");
  });
});
