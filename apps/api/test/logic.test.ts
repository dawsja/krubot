import { describe, expect, test } from "bun:test";
import { ruleFor, summarize } from "../src/approvals.ts";
import { activityLine } from "../src/driver.ts";
import { isReadOnlyAction } from "../src/composio.ts";
import { renderSoul } from "../src/souls.ts";
import type { Bot } from "@krubot/shared";

const bot: Bot = {
  id: "bot-1",
  userId: "u-admin",
  name: "Scout",
  title: "Chief of Staff",
  description: "Read what changed.",
  color: "#000000",
  expression: "happy",
  approval: "ask",
  isChief: true,
  toolkits: [],
  threadId: "t-1",
  hidden: false,
  pinned: false,
  notify: true,
  position: 1,
  createdAt: "",
  updatedAt: "",
};

describe("approvals", () => {
  test("ruleFor makes a Bash prefix rule", () => {
    expect(ruleFor("Bash", { command: "git status" })).toBe("Bash(git:*)");
    expect(ruleFor("Edit", { file_path: "x" })).toBe("Edit");
  });
  test("summarize describes the action", () => {
    expect(summarize("Bash", { command: "ls   -la" })).toBe("Run: ls -la");
    expect(summarize("Write", { file_path: "/a/b" })).toBe("Write /a/b");
    expect(summarize("WebFetch", { url: "https://x" })).toBe("Fetch https://x");
  });
});

describe("driver", () => {
  test("activityLine turns a tool use into a line", () => {
    const line = JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "bun test" } }, { type: "text", text: "Looking around" }] } });
    expect(activityLine(line)).toEqual(["$ bun test", "Looking around"]);
    expect(activityLine("not json")).toEqual([]);
  });
});

describe("composio", () => {
  test("read-only slugs", () => {
    expect(isReadOnlyAction("GMAIL_FETCH_EMAILS")).toBe(true);
    expect(isReadOnlyAction("GMAIL_SEND_EMAIL")).toBe(false);
  });
});

describe("souls", () => {
  test("renderSoul includes the chief section", () => {
    const soul = renderSoul(bot);
    expect(soul).toContain("# Scout — Chief of Staff");
    expect(soul).toContain("## Chief of Staff");
    expect(soul).toContain("## Voice");
  });
});

describe("LLM proxy", () => {
  test("keys go out the way each provider wants them", async () => {
    const { authHeaders, isAnthropicHost, presentedToken, upstreamUrl } = await import("../src/routes/llm.ts");
    expect(isAnthropicHost("https://api.anthropic.com")).toBe(true);
    expect(isAnthropicHost("https://openrouter.ai/api")).toBe(false);
    expect(authHeaders("anthropic", "https://api.anthropic.com", "k")).toEqual({ "x-api-key": "k" });
    expect(authHeaders("anthropic", "https://openrouter.ai/api", "k")).toEqual({ "x-api-key": "k", authorization: "Bearer k" });
    expect(authHeaders("openai", "https://api.openai.com/v1", "k")).toEqual({ authorization: "Bearer k" });
    expect(presentedToken(new Headers({ authorization: "Bearer abc" }))).toBe("abc");
    expect(presentedToken(new Headers({ "x-api-key": "def" }))).toBe("def");
    expect(upstreamUrl("https://api.openai.com/v1", "responses", "?a=1").href).toBe("https://api.openai.com/v1/responses?a=1");
    expect(upstreamUrl("https://api.z.ai/api/anthropic", "/v1/messages", "").href).toBe("https://api.z.ai/api/anthropic/v1/messages");
  });
});
