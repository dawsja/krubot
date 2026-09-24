import { describe, expect, test } from "bun:test";
import { ownPath, ruleFor, ruleMatches, summarize } from "../src/approvals.ts";
import { fromHome, resolvePath } from "../src/computer.ts";
import { BOARD_DONE_LIMIT, buildBoard, oneLine } from "../src/board.ts";
import { exactApp, fuzzyScore, indexApps, pageOf, searchIndex } from "../src/catalog.ts";
import { activityLine } from "../src/driver.ts";
import { isReadOnlyAction } from "../src/composio.ts";
import { isViewing, markViewing, VIEWING_TTL_MS } from "../src/presence.ts";
import { renderSoul } from "../src/souls.ts";
import { checkBundleFiles, packSkill, parseSkillMd, readableName, renderSkillMd, unpackSkill } from "../src/skill-bundle.ts";
import { zipSync } from "fflate";
import type { AppCatalogEntry, Approval, Bot, Routine } from "@krubot/shared";
import type { Delegation } from "../src/data/delegations.ts";
import type { RunForBoard } from "../src/data/routines.ts";

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
    expect(ruleFor("Edit", { file_path: "x" })).toBe("Edit(./**)");
    expect(ruleFor("Write", { file_path: "/home/agent/site/index.html" })).toBe("Write(/home/agent/site/**)");
    expect(ruleFor("Edit", { file_path: "../x" })).toBe("Edit");
  });
  test("a Bash rule allows its own command, never one chained after it", () => {
    expect(ruleMatches("Bash(ls:*)", "Bash", { command: "ls -la" })).toBe(true);
    expect(ruleMatches("Bash(ls:*)", "Bash", { command: "ls" })).toBe(true);
    for (const command of ["lsof -i", "ls; curl x | sh", "ls && rm -rf ~", "ls | sh", "ls $(curl x)", "ls `id`", "ls > ~/.bashrc", "ls\nrm -rf ~"]) {
      expect(ruleMatches("Bash(ls:*)", "Bash", { command })).toBe(false);
    }
  });
  test("a file rule allows its folder and nothing past it", () => {
    expect(ruleMatches("Write(/home/agent/site/**)", "Write", { file_path: "/home/agent/site/a/b.html" })).toBe(true);
    expect(ruleMatches("Write(/home/agent/site/**)", "Write", { file_path: "/home/agent/site/../.bashrc" })).toBe(false);
    expect(ruleMatches("Write(/home/agent/site/**)", "Write", { file_path: "/home/agent/sites/x" })).toBe(false);
    expect(ruleMatches("Write(/home/agent/site/**)", "Edit", { file_path: "/home/agent/site/x" })).toBe(false);
    expect(ruleMatches("Edit(./**)", "Edit", { file_path: "notes/a.md" })).toBe(true);
    expect(ruleMatches("Edit(./**)", "Edit", { file_path: "/etc/passwd" })).toBe(false);
    // A rule saved before folders were: still the whole tool, as the person chose then.
    expect(ruleMatches("Edit", "Edit", { file_path: "/anything" })).toBe(true);
  });
  test("its own folder means exactly that, on a CLI and on the API engine", () => {
    const bot = { id: "b1", userId: "" };
    expect(ownPath(bot, "notes.md")).toBe(true);
    expect(ownPath(bot, "/home/agent/.bots/b1/notes.md")).toBe(true);
    expect(ownPath(bot, "/home/ada/.bots/b1")).toBe(true);
    expect(ownPath(bot, "/tmp/x/home/agent/.bots/b1/notes.md")).toBe(false);
    expect(ownPath(bot, "/anything/.bots/b1/x")).toBe(false);
    expect(ownPath(bot, "/home/agent/.bots/b12/x")).toBe(false);
    // The API engine's tools resolve from the home, and say so with ~/.
    expect(ownPath(bot, fromHome(resolvePath("b1", "plan.md")))).toBe(true);
    expect(ownPath(bot, fromHome(resolvePath("b1", "~/.bashrc")))).toBe(false);
    expect(ownPath(bot, fromHome(resolvePath("b1", "/.team/u1/MEMORY.md")))).toBe(false);
    expect(ownPath(bot, fromHome(resolvePath("b1", ".bots/b2/SOUL.md")))).toBe(false);
  });
  test("summarize describes the action", () => {
    expect(summarize("Bash", { command: "ls   -la" })).toBe("Run: ls -la");
    expect(summarize("Write", { file_path: "/a/b" })).toBe("Write /a/b");
    expect(summarize("WebFetch", { url: "https://x" })).toBe("Fetch https://x");
  });
});

describe("stopping", () => {
  test("a stop is never an incident, however the engine ended it", async () => {
    const { stopCauseOf, unansweredEnding } = await import("../src/responder.ts");
    const signal = (reason?: unknown) => {
      const controller = new AbortController();
      if (reason !== undefined) controller.abort(reason);
      return controller.signal;
    };
    expect(stopCauseOf(signal())).toBeNull();
    expect(stopCauseOf(signal("stopped"))).toBe("stopped");
    expect(stopCauseOf(signal("updating"))).toBe("updating");
    // An abort for no stated reason (a stream torn down) is still a stop.
    const bare = new AbortController();
    bare.abort();
    expect(stopCauseOf(bare.signal)).toBe("stopped");

    // A CLI's stream breaks on a stop and reads as "the box isn't reachable": still only a stop.
    expect(unansweredEnding("Pip", "stopped", "Pip hit a problem: The box isn't reachable")).toEqual({ event: "Pip was stopped.", incident: false });
    // An update says so itself, and wakes nobody.
    expect(unansweredEnding("Pip", "updating", "Pip hit a problem: aborted")).toEqual({ event: null, incident: false });
    // A real failure is said, and the Chief of Staff hears; a setup only the person can fix, only said.
    expect(unansweredEnding("Pip", null, "Pip couldn't finish: timed out")).toEqual({ event: "Pip couldn't finish: timed out", incident: true });
    expect(unansweredEnding("Pip", null, "Pip hit a problem: sign in", true)).toEqual({ event: "Pip hit a problem: sign in", incident: false });
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

describe("redaction", () => {
  test("a log line is capped, a reply is kept whole, and both lose their secrets", async () => {
    const { createRedactor, MAX_LOG_LINE } = await import("../src/redact.ts");
    const long = `token supersecretvalue ${"x".repeat(MAX_LOG_LINE * 2)}`;
    const line = createRedactor(["supersecretvalue"])(long);
    expect(line.length).toBe(MAX_LOG_LINE + 1);
    const reply = createRedactor(["supersecretvalue"], Infinity)(long);
    expect(reply.length).toBe(long.length - "supersecretvalue".length + 3);
    expect(reply).not.toContain("supersecretvalue");
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

  test("a proxied path never leaves the provider's address, whatever the box sends", async () => {
    const { proxiedUrl } = await import("../src/routes/llm.ts");
    expect(proxiedUrl("https://api.z.ai/api/anthropic", "v1/messages", "?beta=1")?.href).toBe("https://api.z.ai/api/anthropic/v1/messages?beta=1");
    expect(proxiedUrl("https://api.openai.com/v1", "/models", "")?.href).toBe("https://api.openai.com/v1/models");
    // Leading slashes are dropped, so `//host` is only a path under the base.
    expect(proxiedUrl("https://api.openai.com/v1", "//evil.example/v1", "")?.href).toBe("https://api.openai.com/v1/evil.example/v1");
    for (const escape of ["https://evil.example/v1", "http:evil.example", "\\\\evil.example/x", "../../v2/x", "%2e%2e/%2e%2e/x", "https://user:pw@api.openai.com/v1/models"]) {
      expect(proxiedUrl("https://api.openai.com/v1", escape, "")).toBeNull();
    }
    // An MCP server with its own path keeps it.
    expect(proxiedUrl("https://mcp.example.com/mcp/trading", "sse", "")?.href).toBe("https://mcp.example.com/mcp/trading/sse");
    expect(proxiedUrl("https://mcp.example.com/mcp/trading", "../other", "")).toBeNull();
  });
});

describe("mobile sign-in", () => {
  test("a code redeems once, and only with the verifier behind its challenge", async () => {
    const { challengeFor, isChallenge, issueCode, redeemCode } = await import("../src/mobile-sign-in.ts");
    const verifier = "the-apps-verifier-that-never-leaves-the-phone";
    const challenge = challengeFor(verifier);
    expect(isChallenge(challenge)).toBe(true);
    expect(isChallenge("short")).toBe(false);

    const code = issueCode("session.value", challenge);
    expect(redeemCode(code, "someone-elses-verifier")).toBeNull();
    // A wrong try spends the code.
    expect(redeemCode(code, verifier)).toBeNull();

    const again = issueCode("session.value", challenge);
    expect(redeemCode(again, verifier)).toBe("session.value");
    expect(redeemCode(again, verifier)).toBeNull();
  });

  test("an old code is refused", async () => {
    const { challengeFor, issueCode, redeemCode } = await import("../src/mobile-sign-in.ts");
    const code = issueCode("s", challengeFor("v"), Date.now() - 3 * 60 * 1000);
    expect(redeemCode(code, "v")).toBeNull();
  });

  test("the code goes back to the app that asked", async () => {
    const { DESKTOP_SIGN_IN_CALLBACK, MOBILE_SIGN_IN_CALLBACK } = await import("@krubot/shared");
    const { signInApp, signInCallback } = await import("../src/mobile-sign-in.ts");
    expect(signInCallback(signInApp("desktop"))).toBe(DESKTOP_SIGN_IN_CALLBACK);
    // Anything else is a phone, as it was before the desktop asked.
    expect(signInCallback(signInApp("app"))).toBe(MOBILE_SIGN_IN_CALLBACK);
    expect(signInCallback(signInApp(undefined))).toBe(MOBILE_SIGN_IN_CALLBACK);
    expect(signInCallback(signInApp("something else"))).toBe(MOBILE_SIGN_IN_CALLBACK);
  });

  test("next stays on this server", async () => {
    const { safePath } = await import("../src/mobile-sign-in.ts");
    expect(safePath("/app/t/1")).toBe("/app/t/1");
    expect(safePath("//evil.example")).toBe("/app");
    expect(safePath("/\\evil.example")).toBe("/app");
    expect(safePath("https://evil.example")).toBe("/app");
    expect(safePath(undefined)).toBe("/app");
  });
});

describe("calling an API directly", () => {
  test("both API shapes read back as the same step", async () => {
    const { readAnthropic, readOpenAi, providerError } = await import("../src/native.ts");

    const anthropic = readAnthropic({
      content: [
        { type: "text", text: "Looking now." },
        { type: "tool_use", id: "tu_1", name: "Bash", input: { command: "ls" } },
      ],
      stop_reason: "tool_use",
      usage: { input_tokens: 12, output_tokens: 3 },
    });
    expect(anthropic.text).toBe("Looking now.");
    expect(anthropic.calls).toEqual([{ id: "tu_1", name: "Bash", input: { command: "ls" } }]);
    expect(anthropic.usage).toEqual({ input: 12, output: 3, cachedInput: 0 });

    const openai = readOpenAi({
      choices: [{ message: { content: "Looking now.", tool_calls: [{ id: "call_1", function: { name: "Bash", arguments: '{"command":"ls"}' } }] }, finish_reason: "tool_calls" }],
      usage: { prompt_tokens: 12, completion_tokens: 3 },
    });
    expect(openai.text).toBe("Looking now.");
    expect(openai.calls).toEqual([{ id: "call_1", name: "Bash", input: { command: "ls" } }]);

    // A model that writes broken arguments still gets its tool called, and the tool complains.
    expect(readOpenAi({ choices: [{ message: { tool_calls: [{ id: "c", function: { name: "Bash", arguments: "{oops" } }] } }] }).calls[0]).toEqual({ id: "c", name: "Bash", input: {} });
    expect(providerError(401, { error: { message: "no credit" } })).toBe("The API refused the key: no credit");
    expect(providerError(404, {})).toContain("no such endpoint or model");
  });

  test("a turn runs the tools the API asks for and answers in words", async () => {
    const { nativeTurn } = await import("../src/native.ts");
    const ran: string[] = [];
    const tools = {
      Bash: {
        description: "Runs a command.",
        inputSchema: { type: "object", properties: { command: { type: "string" } } },
        execute: async (input: Record<string, unknown>) => {
          ran.push(String(input.command));
          return "hello.txt";
        },
      },
    };

    for (const kind of ["anthropic", "openai"] as const) {
      const seen: unknown[] = [];
      let step = 0;
      const fake = Bun.serve({
        port: 0,
        async fetch(request: Request) {
          const body = (await request.json()) as { messages: unknown[]; tools: unknown[] };
          seen.push(body);
          step += 1;
          if (kind === "anthropic") {
            return step === 1
              ? Response.json({ content: [{ type: "tool_use", id: "tu_1", name: "Bash", input: { command: "ls" } }], stop_reason: "tool_use", usage: { input_tokens: 10, output_tokens: 2 } })
              : Response.json({ content: [{ type: "text", text: "There is one file." }], stop_reason: "end_turn", usage: { input_tokens: 20, output_tokens: 5 } });
          }
          return step === 1
            ? Response.json({ choices: [{ message: { tool_calls: [{ id: "call_1", function: { name: "Bash", arguments: '{"command":"ls"}' } }] }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 10, completion_tokens: 2 } })
            : Response.json({ choices: [{ message: { content: "There is one file." }, finish_reason: "stop" }], usage: { prompt_tokens: 20, completion_tokens: 5 } });
        },
      });
      try {
        const result = await nativeTurn({
          access: { kind, baseUrl: `http://127.0.0.1:${fake.port}`, token: "proxy-token" },
          model: "a-model",
          instructions: "Be brief.",
          prompt: "What is in my folder?",
          tools,
        });
        expect(result.ok).toBe(true);
        expect(result.text).toBe("There is one file.");
        expect(result.usage).toEqual({ input: 30, output: 7, cachedInput: 0 });
        // Two calls: the question, then the same conversation with the tool's answer in it.
        expect(seen).toHaveLength(2);
        const second = seen[1] as { messages: { role?: string; content?: unknown }[]; system?: string };
        expect(JSON.stringify(second.messages)).toContain("hello.txt");
        if (kind === "anthropic") expect(second.system).toBe("Be brief.");
        else expect(second.messages[0]).toEqual({ role: "system", content: "Be brief." });
      } finally {
        fake.stop(true);
      }
    }
    expect(ran).toEqual(["ls", "ls"]);
  });

  test("a steer is read after the next tool results, or sends a finished answer round again", async () => {
    const { nativeTurn, SteerQueue } = await import("../src/native.ts");
    for (const kind of ["anthropic", "openai"] as const) {
      // Mid-turn: the person writes while the tool runs, and the model's next step sees it.
      let steers = new SteerQueue();
      const seen: string[] = [];
      let step = 0;
      const tools = { Bash: { description: "Runs a command.", inputSchema: {}, execute: async () => (steers.push("btw: use the other folder"), "done") } };
      const fake = Bun.serve({
        port: 0,
        async fetch(request: Request) {
          seen.push(JSON.stringify(((await request.json()) as { messages: unknown[] }).messages));
          step += 1;
          if (kind === "anthropic") {
            return step === 1
              ? Response.json({ content: [{ type: "tool_use", id: "tu_1", name: "Bash", input: {} }], stop_reason: "tool_use" })
              : Response.json({ content: [{ type: "text", text: step === 2 ? "Done." : "Moved it." }], stop_reason: "end_turn" });
          }
          return step === 1
            ? Response.json({ choices: [{ message: { tool_calls: [{ id: "call_1", function: { name: "Bash", arguments: "{}" } }] }, finish_reason: "tool_calls" }] })
            : Response.json({ choices: [{ message: { content: step === 2 ? "Done." : "Moved it." }, finish_reason: "stop" }] });
        },
      });
      const run = () => nativeTurn({ access: { kind, baseUrl: `http://127.0.0.1:${fake.port}`, token: "t" }, model: "m", instructions: "", prompt: "tidy up", tools, steers });
      try {
        const result = await run();
        expect(result.text).toBe("Done.");
        expect(seen).toHaveLength(2);
        expect(seen[1]).toContain("btw: use the other folder");
        // The turn is over: a late push is refused, so the message waits for a turn of its own.
        expect(steers.push("too late")).toBe(false);

        // At the answer: the steer arrives as the model finishes, so it goes round once more and both answers stay.
        steers = new SteerQueue();
        seen.length = 0;
        step = 1;
        const late = { ...tools, Bash: { ...tools.Bash, execute: async () => "done" } };
        const pending = nativeTurn({ access: { kind, baseUrl: `http://127.0.0.1:${fake.port}`, token: "t" }, model: "m", instructions: "", prompt: "tidy up", tools: late, steers });
        steers.push("btw: say where it went");
        const second = await pending;
        expect(seen).toHaveLength(2);
        expect(seen[1]).toContain("btw: say where it went");
        expect(second.text).toBe("Done.\n\nMoved it.");
      } finally {
        fake.stop(true);
      }
    }
  });

  test("an API that refuses says so, and a loop that never ends is stopped", async () => {
    const { nativeTurn } = await import("../src/native.ts");
    const refusing = Bun.serve({ port: 0, fetch: () => Response.json({ error: { message: "bad key" } }, { status: 401 }) });
    try {
      const turn = {
        access: { kind: "anthropic" as const, baseUrl: `http://127.0.0.1:${refusing.port}`, token: "t" },
        model: "m",
        instructions: "",
        prompt: "hi",
        tools: {},
      };
      await expect(nativeTurn(turn)).rejects.toThrow("The API refused the key: bad key");
    } finally {
      refusing.stop(true);
    }

    const forever = Bun.serve({ port: 0, fetch: () => Response.json({ content: [{ type: "tool_use", id: "t1", name: "Wait", input: {} }], stop_reason: "tool_use" }) });
    try {
      const result = await nativeTurn({
        access: { kind: "anthropic", baseUrl: `http://127.0.0.1:${forever.port}`, token: "t" },
        model: "m",
        instructions: "",
        prompt: "hi",
        tools: { Wait: { description: "waits", inputSchema: {}, execute: async () => "again" } },
        maxSteps: 3,
      });
      expect(result.ok).toBe(false);
      expect(result.stopReason).toBe("max_steps");
    } finally {
      forever.stop(true);
    }
  });

  test("a path from the model lands in the bot's own folder unless it says otherwise", async () => {
    const { resolvePath } = await import("../src/computer.ts");
    expect(resolvePath("bot-1", "notes.md")).toBe(".bots/bot-1/notes.md");
    expect(resolvePath("bot-1", "")).toBe(".bots/bot-1");
    expect(resolvePath("bot-1", "~/shared/report.md")).toBe("shared/report.md");
    expect(resolvePath("bot-1", "/projects/site")).toBe("projects/site");
    // Its own folder, the team's and the skills, named in full, are left as they are.
    expect(resolvePath("bot-1", ".bots/bot-2/MEMORY.md")).toBe(".bots/bot-2/MEMORY.md");
    expect(resolvePath("bot-1", ".team/u-1/MEMORY.md")).toBe(".team/u-1/MEMORY.md");
  });
});

describe("the app catalog", () => {
  const apps: AppCatalogEntry[] = [
    { toolkit: "googlesheets", name: "Google Sheets", icon: "googlesheets", category: "Files" },
    { toolkit: "gmail", name: "Gmail", icon: "gmail", category: "Email" },
    { toolkit: "github", name: "GitHub", icon: "github", category: "Code" },
    { toolkit: "twitter", name: "X", icon: "x", category: "Social" },
    { toolkit: "zendesk", name: "Zendesk", icon: "zendesk", category: "Support", description: "Customer support tickets" },
    { toolkit: "microsoft_teams", name: "Microsoft Teams", icon: "microsoftteams", category: "Chat" },
  ];
  const squash = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, "");
  // The index is built once, as the API builds it once per catalog it fetches.
  const index = indexApps(apps);
  const find = (query: string) => searchIndex(index, query);

  test("an exact name beats everything else", () => {
    expect(find("gmail")[0]?.toolkit).toBe("gmail");
    expect(find("GitHub")[0]?.toolkit).toBe("github");
  });

  test("a word inside the name finds it", () => {
    expect(find("sheets")[0]?.toolkit).toBe("googlesheets");
  });

  test("a few letters in order find it", () => {
    expect(find("gsheet")[0]?.toolkit).toBe("googlesheets");
    expect(find("zdesk")[0]?.toolkit).toBe("zendesk");
  });

  test("punctuation and case don't matter", () => {
    expect(find("Google-Sheets")[0]?.toolkit).toBe("googlesheets");
  });

  test("the slug finds an app its name doesn't", () => {
    expect(find("twitter")[0]?.toolkit).toBe("twitter");
  });

  test("what an app does counts, faintly", () => {
    expect(find("tickets")[0]?.toolkit).toBe("zendesk");
  });

  test("nothing matches nonsense", () => {
    expect(find("qqzzxx")).toEqual([]);
  });

  test("an empty search is the whole list, in its own order", () => {
    expect(find("  ")).toEqual(apps);
  });

  test("an underscore in the slug is nothing to type around", () => {
    expect(find("microsoft teams")[0]?.toolkit).toBe("microsoft_teams");
    expect(find("msteams")[0]?.toolkit).toBe("microsoft_teams");
  });

  test("the index answers an app named outright, by slug or by name", () => {
    expect(exactApp(index, "Google Sheets")?.toolkit).toBe("googlesheets");
    expect(exactApp(index, "microsoft_teams")?.toolkit).toBe("microsoft_teams");
    expect(exactApp(index, "sheets")).toBeNull();
  });

  test("the index looks an app up by its slug", () => {
    expect(index.bySlug.get("gmail")?.name).toBe("Gmail");
    expect(index.bySlug.get("nope")).toBeUndefined();
  });

  test("the mask that skips an app before scoring never skips a match", () => {
    // The same question asked without an index: every app the rules match.
    const plain = (query: string) =>
      apps
        .filter((a) => fuzzyScore(query, a.name) > 0 || fuzzyScore(query, a.toolkit) > 0 || fuzzyScore(query, a.category) > 0 || squash(a.description ?? "").includes(squash(query)))
        .map((a) => a.toolkit)
        .sort();
    for (const query of ["gmail", "gsheet", "x", "tickets", "chat", "zzz", "team5", "e"]) {
      expect(find(query).map((a) => a.toolkit).sort()).toEqual(plain(query));
    }
  });

  test("pages slice the list and clamp where you are", () => {
    const list = [1, 2, 3, 4, 5];
    expect(pageOf(list, 1, 2)).toEqual({ items: [1, 2], page: 1, pages: 3, total: 5 });
    expect(pageOf(list, 3, 2)).toEqual({ items: [5], page: 3, pages: 3, total: 5 });
    expect(pageOf(list, 9, 2).page).toBe(3);
    expect(pageOf(list, 0, 2).page).toBe(1);
    expect(pageOf([], 1, 10)).toEqual({ items: [], page: 1, pages: 1, total: 0 });
  });
});

describe("board", () => {
  const now = Date.parse("2026-09-20T12:00:00Z");
  const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
  const handoff = (id: string, patch: Partial<Delegation> = {}): Delegation => ({
    id,
    fromBotId: "chief",
    fromThreadId: "t-chief",
    toBotId: "scout",
    toThreadId: "t-scout",
    messageId: `m-${id}`,
    brief: `Brief ${id}`,
    status: "open",
    result: null,
    createdAt: ago(30),
    finishedAt: null,
    nudgedAt: null,
    escalatedAt: null,
    parentId: null,
    resultMessageId: null,
    ...patch,
  });
  const run = (id: string, patch: Partial<RunForBoard> = {}): RunForBoard => ({ id, routineId: "r1", routineName: "Morning", botId: "scout", threadId: "t-scout", status: "done", startedAt: ago(10), finishedAt: ago(5), ...patch });
  const approval: Approval = { id: "ap1", botId: "scout", threadId: "t-scout", tool: "Bash", summary: "Run: rm -rf build", input: {}, status: "pending", rule: null, createdAt: ago(2), resolvedAt: null };
  const empty = { delegations: [], approvals: [], turns: [], runs: [], upcoming: [] };

  test("sorts each kind of work into its column", () => {
    const board = buildBoard(
      {
        delegations: [handoff("open"), handoff("nudged", { nudgedAt: ago(10) }), handoff("escalated", { nudgedAt: ago(20), escalatedAt: ago(1) }), handoff("done", { status: "done", result: "All found.\nDetails", finishedAt: ago(3) })],
        approvals: [approval, { ...approval, id: "ap2", status: "allowed" }],
        turns: [{ botId: "chief", threadId: "t-chief", threadName: "Chief", startedAt: now - 5_000 }],
        runs: [run("ok"), run("bad", { status: "failed" }), run("queued", { status: "started", finishedAt: null, threadId: "t-other" }), run("running", { status: "started", finishedAt: null, threadId: "t-chief" })],
        upcoming: [{ id: "r2", botId: "scout", name: "Evening", nextRunAt: "2026-09-20T18:00:00Z", threadId: "t-scout" } as Routine & { threadId: string }],
      },
      now,
    );
    const ids = (column: keyof typeof board.columns) => board.columns[column].map((i) => i.id);
    expect(ids("needs-you").sort()).toEqual(["approval:ap1", "handoff:escalated", "run:bad"]);
    expect(ids("working")).toEqual(["turn:chief:t-chief"]);
    expect(ids("waiting")).toEqual(["handoff:open", "run:queued", "upcoming:r2"]);
    expect(ids("stalled")).toEqual(["handoff:nudged"]);
    expect(ids("done")).toEqual(["handoff:done", "run:ok"]);
    expect(board.columns.done[0]).toMatchObject({ detail: "All found. Details", toBotId: "scout", toThreadId: "t-scout" });
  });

  test("drops what finished more than a day ago and caps Done", () => {
    const old = buildBoard({ ...empty, delegations: [handoff("old", { status: "done", finishedAt: ago(25 * 60) })], runs: [run("old", { finishedAt: ago(25 * 60) }), run("oldfail", { status: "failed", finishedAt: ago(25 * 60) })] }, now);
    expect(Object.values(old.columns).flat()).toEqual([]);
    const many = buildBoard({ ...empty, runs: Array.from({ length: 30 }, (_, i) => run(`r${i}`, { finishedAt: ago(i) })) }, now);
    expect(many.columns.done).toHaveLength(BOARD_DONE_LIMIT);
    expect(many.columns.done[0]!.id).toBe("run:r0");
  });

  test("clearing hides finished cards only, and a withdrawn handoff says so", () => {
    const cleared = new Set(["handoff:done", "run:bad", "handoff:open", "approval:ap1"]);
    const board = buildBoard(
      {
        ...empty,
        delegations: [handoff("open"), handoff("done", { status: "done", finishedAt: ago(3) }), handoff("gone", { status: "cancelled", result: "Sketch took it", finishedAt: ago(2) })],
        approvals: [approval],
        runs: [run("bad", { status: "failed" })],
        cleared,
      },
      now,
    );
    const ids = (column: keyof typeof board.columns) => board.columns[column].map((i) => i.id);
    // Open work and a pending approval stay whatever the list says.
    expect(ids("waiting")).toEqual(["handoff:open"]);
    expect(ids("needs-you")).toEqual(["approval:ap1"]);
    expect(ids("done")).toEqual(["handoff:gone"]);
    expect(board.columns.done[0]!.detail).toBe("Withdrawn");
  });

  test("oneLine squashes whitespace and cuts long text", () => {
    expect(oneLine("  a\n\n b  ")).toBe("a b");
    expect(oneLine("x".repeat(300), 10)).toBe(`${"x".repeat(9)}…`);
  });
});

describe("viewing", () => {
  test("a conversation in front of the person holds back its push until the report lapses", () => {
    const t = 1_000_000;
    markViewing("u-view", "phone", "thread-a", t);
    expect(isViewing("u-view", "thread-a", t + 1000)).toBe(true);
    expect(isViewing("u-view", "thread-b", t + 1000)).toBe(false);
    expect(isViewing("u-other", "thread-a", t + 1000)).toBe(false);
    expect(isViewing("u-view", "thread-a", t + VIEWING_TTL_MS)).toBe(false);
  });

  test("any open window counts, and one that leaves stops counting", () => {
    const t = 2_000_000;
    markViewing("u-two", "phone", "thread-a", t);
    markViewing("u-two", "laptop", "thread-a", t);
    markViewing("u-two", "phone", null, t + 10);
    expect(isViewing("u-two", "thread-a", t + 20)).toBe(true);
    markViewing("u-two", "laptop", "thread-b", t + 30);
    expect(isViewing("u-two", "thread-a", t + 40)).toBe(false);
  });
});

describe("handoff depth", () => {
  test("a result lands at the delegator's own depth, so wave after wave can go out", async () => {
    const { MAX_CHAIN, resultDepth } = await import("../src/tools.ts");
    // The person (0) → the Chief briefs at 1 → the result comes back at 0, again and again.
    let depth = 0;
    for (let wave = 0; wave < 10; wave += 1) {
      const brief = depth + 1;
      expect(brief).toBeLessThanOrEqual(MAX_CHAIN);
      depth = resultDepth(brief);
    }
    expect(depth).toBe(0);
    expect(resultDepth(0)).toBe(0);
  });
});

describe("plainText", () => {
  test("decodes what a model escaped as HTML", async () => {
    const { plainText } = await import("../src/tools.ts");
    expect(plainText("Platform &amp; Systems")).toBe("Platform & Systems");
    expect(plainText("Art Director &AMP; Pixel &lt;3")).toBe("Art Director & Pixel <3");
    expect(plainText("&amp;lt;")).toBe("&lt;");
    expect(plainText("Q&A")).toBe("Q&A");
  });
});

describe("roomOpener", () => {
  test("mentions the invited bots its line doesn't already name", async () => {
    const { roomOpener } = await import("../src/tools.ts");
    const sound = { ...bot, id: "b-s", name: "Bleep" };
    const art = { ...bot, id: "b-a", name: "Pixel" };
    expect(roomOpener("Agree the cue.", [sound, art])).toBe("@bleep @pixel Agree the cue.");
    expect(roomOpener("@pixel draws it, @bleep scores it.", [sound, art])).toBe("@pixel draws it, @bleep scores it.");
    expect(roomOpener("@pixel first.", [sound, art])).toBe("@bleep @pixel first.");
  });
});

describe("ago and snippetAround", () => {
  test("say when and where, briefly", async () => {
    const { ago, snippetAround } = await import("../src/tools.ts");
    const now = Date.parse("2026-09-21T12:00:00Z");
    expect(ago("2026-09-21T11:59:50Z", now)).toBe("just now");
    expect(ago("2026-09-21T11:15:00Z", now)).toBe("45 min ago");
    expect(ago("2026-09-21T06:00:00Z", now)).toBe("6h ago");
    expect(ago("2026-09-15T12:00:00Z", now)).toBe("6d ago");
    expect(snippetAround("short", "x")).toBe("short");
    const long = `${"a ".repeat(300)}NEEDLE${" b".repeat(300)}`;
    const cut = snippetAround(long, "needle", 60);
    expect(cut).toContain("NEEDLE");
    expect(cut.startsWith("…") && cut.endsWith("…")).toBe(true);
  });
});

describe("skill bundles", () => {
  test("SKILL.md round-trips: the slug as name, the readable name and other frontmatter kept", () => {
    const md = renderSkillMd({ slug: "weekly-report", name: "Weekly report: \"Monday\"", description: "Numbers, then: a table.", instructions: "# Steps\n1. Run it.", meta: "license: MIT\nallowed-tools:\n  - Bash" });
    expect(md.startsWith("---\nname: weekly-report\n")).toBe(true);
    const parsed = parseSkillMd(md);
    expect(parsed).toEqual({ name: 'Weekly report: "Monday"', description: "Numbers, then: a table.", instructions: "# Steps\n1. Run it.", meta: "license: MIT\nallowed-tools:\n  - Bash" });
    // A skill's metadata block keeps its own keys beside the title.
    const withMeta = renderSkillMd({ slug: "x", name: "X", description: "d", instructions: "i", meta: "metadata:\n  version: 2" });
    expect(parseSkillMd(withMeta).meta).toBe("metadata:\n  version: 2");
  });

  test("SKILL.md from elsewhere: folded descriptions, quotes, no frontmatter", () => {
    expect(parseSkillMd("---\nname: pdf-editor\ndescription: >\n  Edits PDFs,\n  fills forms.\n---\nDo it.")).toMatchObject({ name: "Pdf editor", description: "Edits PDFs, fills forms.", instructions: "Do it." });
    expect(parseSkillMd("---\nname: 'It''s mine'\ndescription: \"a: b\"\n---\n\nBody").name).toBe("It's mine");
    expect(parseSkillMd("# Just instructions")).toEqual({ name: null, description: "", instructions: "# Just instructions", meta: "" });
    expect(readableName("My Skill")).toBe("My Skill");
  });

  test("a .skill packs under its folder and unpacks from wherever SKILL.md is, leaving clutter behind", () => {
    const text = (s: string) => new TextEncoder().encode(s);
    const zip = packSkill({ slug: "demo", name: "Demo", description: "d", instructions: "i" }, [{ path: "scripts/run.sh", data: text("#!/bin/sh\necho hi\n"), executable: true }]);
    const out = unpackSkill(zip);
    if ("error" in out) throw new Error(out.error);
    expect(out.folder).toBe("demo");
    expect(out.files).toEqual([{ path: "scripts/run.sh", data: text("#!/bin/sh\necho hi\n"), executable: true }]);
    const nested = zipSync({ "outer/demo/SKILL.md": text("---\nname: demo\n---\nx"), "outer/demo/ref.md": text("r"), "outer/other.txt": text("no"), "__MACOSX/outer/demo/._ref.md": text("junk"), "outer/demo/.env": text("SECRET=1") });
    const found = unpackSkill(nested);
    if ("error" in found) throw new Error(found.error);
    expect(found.files.map((f) => f.path)).toEqual(["ref.md"]);
    expect(unpackSkill(zipSync({ "a.txt": text("a") }))).toEqual({ error: "There's no SKILL.md in it." });
    expect(unpackSkill(text("nope"))).toEqual({ error: "That isn't a .skill or .zip file." });
  });

  test("a skill's files stay within the limits", () => {
    expect(checkBundleFiles([{ path: "a.txt", data: new Uint8Array(1) }])).toBeNull();
    expect(checkBundleFiles([{ path: "../a", data: new Uint8Array(1) }])).toContain("usable path");
    expect(checkBundleFiles([{ path: "SKILL.md", data: new Uint8Array(1) }])).toContain("usable path");
    expect(checkBundleFiles([{ path: "big.bin", data: new Uint8Array(6 * 1024 * 1024) }])).toContain("larger than");
    const many = Array.from({ length: 201 }, (_, i) => ({ path: `f${i}.txt`, data: new Uint8Array(1) }));
    expect(checkBundleFiles(many)).toContain("at most");
  });
});
