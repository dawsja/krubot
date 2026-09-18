import { describe, expect, test } from "bun:test";
import { BOT_TEMPLATES, botInputSchema, handleOf, mentionsIn, pickBotName } from "../src/index.ts";

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
});
