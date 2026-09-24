import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let dir = "";
beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "krubot-"));
  process.env.KRU_DATA_DIR = dir;
  await seedUsers(["u-admin", "admin"]);
});

/** A Hono app whose requests come from this person, as the session middleware in app.ts would set. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function asPerson<T extends { use: (...args: any[]) => unknown }>(app: T, id: string): T {
  app.use("*", async (c: { set: (key: string, value: unknown) => void }, next: () => Promise<void>) => {
    c.set("session", { user: { id } });
    await next();
  });
  return app;
}

/** Better Auth's user table, as its migration makes it (enough for the reads here), with these people in it. */
async function seedUsers(...people: [id: string, role: "admin" | "user"][]) {
  const { ensureKruDatabase } = await import("../src/db/init.ts");
  const db = ensureKruDatabase();
  db.exec(`CREATE TABLE IF NOT EXISTS "user" (id TEXT PRIMARY KEY, name TEXT, email TEXT, emailVerified INTEGER, image TEXT, role TEXT, createdAt TEXT, updatedAt TEXT);
           CREATE TABLE IF NOT EXISTS "account" (id TEXT PRIMARY KEY, userId TEXT, providerId TEXT, accountId TEXT, createdAt TEXT, updatedAt TEXT);`);
  for (const [id, role] of people) {
    db.query('INSERT OR REPLACE INTO "user" (id, name, email, role, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)').run(id, id, `${id}@example.com`, role, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z");
  }
}
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("data", () => {
  test("creates a bot with its thread, posts and claims messages", async () => {
    const { createBot, listBots, getBotByThread } = await import("../src/data/bots.ts");
    const { postMessage, claimPendingMessages, markAnswered, listMessages, getThread } = await import("../src/data/threads.ts");
    const { botInputSchema } = await import("@krubot/shared");
    const bot = createBot(botInputSchema.parse({ name: "Pip", title: "Coordinator" }), "u-admin");
    expect(listBots()).toHaveLength(1);
    expect(getBotByThread(bot.threadId)?.id).toBe(bot.id);
    const thread = getThread(bot.threadId)!;
    expect(thread.members).toEqual([bot.id]);
    postMessage({ threadId: bot.threadId, author: "you", body: "hello" });
    const claimed = claimPendingMessages("test", () => 1000);
    expect(claimed).toHaveLength(1);
    expect(claimPendingMessages("test", () => 1000)).toHaveLength(0);
    markAnswered(claimed[0]!.id);
    postMessage({ threadId: bot.threadId, author: bot.id, body: "hi", answered: true });
    expect(listMessages(bot.threadId)).toHaveLength(2);
    expect(getThread(bot.threadId)!.lastMessage?.body).toBe("hi");
  });

  test("each person's messages are claimed against their own room", async () => {
    const { createBot } = await import("../src/data/bots.ts");
    const { postMessage, claimPendingMessages, markAnswered } = await import("../src/data/threads.ts");
    const { botInputSchema } = await import("@krubot/shared");
    const busy = createBot(botInputSchema.parse({ name: "Busy" }), "u-busy");
    const quiet = createBot(botInputSchema.parse({ name: "Quiet" }), "u-quiet");
    for (let i = 0; i < 5; i++) postMessage({ threadId: busy.threadId, author: "you", body: `job ${i}` });
    const theirs = postMessage({ threadId: quiet.threadId, author: "you", body: "hello" });
    // The busy person's five came first, but they have room for three; the other person still gets theirs.
    const claimed = claimPendingMessages("room-per-person", (userId) => (userId === "u-busy" ? 3 : 1));
    expect(claimed.filter((m) => m.threadId === busy.threadId)).toHaveLength(3);
    expect(claimed.map((m) => m.id)).toContain(theirs.id);
    // A person with no room left gets nothing.
    expect(claimPendingMessages("room-per-person", (userId) => (userId === "u-busy" ? 0 : 1))).toHaveLength(0);
    for (const message of [...claimed, ...claimPendingMessages("room-per-person", () => 1000)]) markAnswered(message.id);
  });

  test("secret cards and hidden prompts are messages too", async () => {
    const { listBots } = await import("../src/data/bots.ts");
    const { postMessage, claimPendingMessages, listMessages } = await import("../src/data/threads.ts");
    const bot = listBots()[0]!;
    postMessage({ threadId: bot.threadId, author: bot.id, kind: "secret", body: "OPENAI_API_KEY: for summaries", approvalId: "sr_test", answered: true });
    const prompt = postMessage({ threadId: bot.threadId, author: "system", kind: "prompt", body: "Say hello." });
    expect(listMessages(bot.threadId).map((m) => m.kind)).toContain("secret");
    // A prompt waits for the bot like a message from the person does.
    expect(claimPendingMessages("test", () => 1000).map((m) => m.id)).toEqual([prompt.id]);
  });

  test("an approval reads the bot's level now, not as the turn started", async () => {
    const { listBots, updateBot } = await import("../src/data/bots.ts");
    const { listMessages } = await import("../src/data/threads.ts");
    const { requestApproval } = await import("../src/approvals.ts");
    const stale = listBots()[0]!;
    const before = listMessages(stale.threadId).length;
    // The person opens the profile mid-turn and gives it full access.
    updateBot(stale.id, { approval: "full" });
    // The turn still holds the object it loaded when it began.
    const decision = await requestApproval({ bot: { ...stale, approval: "ask" }, threadId: stale.threadId, tool: "Bash", input: { command: "ls" } });
    expect(decision).toBe("allow");
    // Nothing was asked, so no card landed in the conversation.
    expect(listMessages(stale.threadId)).toHaveLength(before);
    updateBot(stale.id, { approval: stale.approval });
  });

  test("a bot works in its own folder without asking, and asks outside it", async () => {
    const { listBots, updateBot } = await import("../src/data/bots.ts");
    const { listMessages } = await import("../src/data/threads.ts");
    const { requestApproval } = await import("../src/approvals.ts");
    const bot = listBots()[0]!;
    updateBot(bot.id, { approval: "ask" });
    const ask = (tool: string, input: Record<string, unknown>) => requestApproval({ bot: { ...bot, approval: "ask" }, threadId: bot.threadId, tool, input });
    const before = listMessages(bot.threadId).length;
    // Its own folder, by an absolute path and by a relative one.
    expect(await ask("Write", { file_path: `/home/agent/.bots/${bot.id}/notes.md` })).toBe("allow");
    expect(await ask("Edit", { file_path: "memory/plan.md" })).toBe("allow");
    // Reading is never gated, wherever it points.
    expect(await ask("Read", { file_path: "/etc/hosts" })).toBe("allow");
    expect(listMessages(bot.threadId)).toHaveLength(before);
    // Another bot's folder, a climb out of its own, and the home itself are not.
    for (const path of [`/home/agent/.bots/${bot.id}-other/x.md`, `/home/agent/.bots/${bot.id}/../else.md`, "/home/agent/notes.md"]) {
      const pending = ask("Write", { file_path: path });
      const card = listMessages(bot.threadId).at(-1)!;
      expect(card.kind).toBe("approval");
      const { decide } = await import("../src/approvals.ts");
      decide(card.approvalId!, "deny");
      expect(await pending).toBe("deny");
    }
  });

  test("approval rules and routines", async () => {
    const { addRule, listRules, createApproval, resolveApproval } = await import("../src/data/approvals.ts");
    const { createRoutine, claimDueRoutines, listRoutines } = await import("../src/data/routines.ts");
    addRule("b1", "Bash(git:*)");
    expect(listRules("b1")).toEqual(["Bash(git:*)"]);
    const approval = createApproval({ botId: "b1", threadId: "t", tool: "Bash", summary: "Run: ls", input: { command: "ls" } });
    expect(resolveApproval(approval.id, "allowed")?.status).toBe("allowed");
    const routine = createRoutine("b1", { name: "r", cron: "* * * * *", timezone: "UTC", prompt: "p", enabled: true });
    expect(routine.nextRunAt).toBeTruthy();
    const due = claimDueRoutines(new Date(Date.now() + 120_000));
    expect(due.map((r) => r.id)).toContain(routine.id);
    expect(listRoutines("b1")[0]!.lastRunAt).toBeTruthy();
  });

  test("a patch keeps what it doesn't mention", async () => {
    const { createBot, updateBot } = await import("../src/data/bots.ts");
    const { botInputSchema, botPatchSchema, routinePatchSchema, skillPatchSchema } = await import("@krubot/shared");
    const chief = createBot(botInputSchema.parse({ name: "Patch Chief", title: "Chief of Staff", description: "Runs the team.", isChief: true, toolkits: ["gmail"], notify: false }), "u-admin");
    // What the bots route does for a pin: the parsed patch must not carry defaults for the rest.
    const parsed = botPatchSchema.parse({ pinned: true });
    expect(parsed).toEqual({});
    const after = updateBot(chief.id, { ...parsed, pinned: true })!;
    expect(after.isChief).toBe(true);
    expect(after.title).toBe("Chief of Staff");
    expect(after.description).toBe("Runs the team.");
    expect(after.toolkits).toEqual(["gmail"]);
    expect(after.notify).toBe(false);
    expect(after.pinned).toBe(true);
    expect(routinePatchSchema.parse({ enabled: false })).toEqual({ enabled: false });
    expect(skillPatchSchema.parse({ name: "Notes" })).toEqual({ name: "Notes" });
  });

  test("what a bot sends to a teammate shows in both conversations", async () => {
    const { createBot } = await import("../src/data/bots.ts");
    const { postMessage, listMessages, listExchange } = await import("../src/data/threads.ts");
    const { botInputSchema } = await import("@krubot/shared");
    const alex = createBot(botInputSchema.parse({ name: "Alex Exchange" }), "u-admin");
    const newbie = createBot(botInputSchema.parse({ name: "Newbie Exchange" }), "u-admin");
    const hello = postMessage({ threadId: newbie.threadId, author: alex.id, body: "Hey, what's your lane?", fromThreadId: alex.threadId, answered: true });
    postMessage({ threadId: newbie.threadId, author: newbie.id, body: "Replied to Alex.", answered: true });
    // The web's cursor is a timestamp; the reply must not share hello's millisecond.
    await Bun.sleep(3);
    const back = postMessage({ threadId: alex.threadId, author: newbie.id, body: "No lane yet.", fromThreadId: newbie.threadId, answered: true });
    expect(listMessages(alex.threadId).map((m) => m.id)).toEqual([back.id]);
    expect(listMessages(alex.threadId, { includeSent: true }).map((m) => m.id)).toEqual([hello.id, back.id]);
    expect(listMessages(alex.threadId, { includeSent: true, after: hello.createdAt }).map((m) => m.id)).toEqual([back.id]);
    expect(listExchange(alex.threadId, newbie.threadId).map((m) => m.id)).toEqual([hello.id, back.id]);
    expect(listExchange(newbie.threadId, alex.threadId).map((m) => m.id)).toEqual([hello.id, back.id]);
  });

  test("any bot creates a teammate with create_bot", async () => {
    const { createBot, listBots, findBot } = await import("../src/data/bots.ts");
    const { getThread, listMessages } = await import("../src/data/threads.ts");
    const { teamTools } = await import("../src/tools.ts");
    const { botInputSchema } = await import("@krubot/shared");
    const maker = createBot(botInputSchema.parse({ name: "Maker Test", title: "Researcher" }), "u-admin");
    const synced: string[] = [];
    const context = {
      box: { url: "http://box.invalid", token: "t", user: "u-admin" },
      bot: maker,
      thread: getThread(maker.threadId)!,
      message: { depth: 0 } as never,
      askBot: async () => "",
      syncSoul: async (b: { id: string }) => {
        synced.push(b.id);
      },
      stopWork: async () => false,
      isWorking: () => false,
    };
    const tool = teamTools(context).create_bot!;
    expect(await tool.execute({ title: "Developer" }, "call")).toContain("NOT created");
    expect(await tool.execute({ name: "Dev", title: "Developer", description: "Builds things.", color: "mauve" }, "call")).toContain("NOT created");
    const before = listBots().length;
    const answer = await tool.execute({ name: "Dev", title: "Developer", description: "Writes and ships code.", color: "blue", apps: ["github"] }, "call");
    expect(answer).toContain("Created Dev");
    expect(answer).toContain("github");
    expect(listBots()).toHaveLength(before + 1);
    const dev = findBot("Dev")!;
    expect(dev.title).toBe("Developer");
    expect(dev.color).toBe("#3B82F6");
    expect(dev.toolkits).toEqual([]);
    expect(synced).toEqual([dev.id]);
    expect(listMessages(maker.threadId).some((m) => m.body.includes("added Dev"))).toBe(true);
    expect(await tool.execute({ name: "Dev", title: "Developer", description: "A second one." }, "call")).toContain("Created Dev 2");
  });

  test("an API provider's key is encrypted, write-only, redacted, and one person's own", async () => {
    const { saveProvider, getProvider, listProviders, providerKey, providerProxyToken, providerByToken, deleteProvider } = await import("../src/data/providers.ts");
    const { allSecretValues } = await import("../src/data/secrets.ts");
    const { ensureKruDatabase } = await import("../src/db/init.ts");
    expect(() => saveProvider("u-admin", "openai", { baseUrl: "https://api.openai.com/v1" })).toThrow("Add the API key");
    const saved = saveProvider("u-admin", "openai", { baseUrl: "https://api.openai.com/v1/", apiKey: "sk-test-1234567890" });
    expect(saved.baseUrl).toBe("https://api.openai.com/v1");
    // Nothing a route could return carries the key.
    expect(JSON.stringify(saved)).not.toContain("sk-test");
    expect(JSON.stringify(listProviders("u-admin"))).not.toContain("sk-test");
    const raw = ensureKruDatabase().query("SELECT api_key FROM kru_providers WHERE kind = 'openai'").get() as { api_key: string };
    expect(raw.api_key).not.toContain("sk-test");
    expect(providerKey("u-admin", "openai")).toBe("sk-test-1234567890");
    const token = providerProxyToken("u-admin", "openai")!;
    expect(token.length).toBeGreaterThan(20);
    expect(allSecretValues()).toContain("sk-test-1234567890");
    // An edit without a key keeps the key and the proxy token.
    saveProvider("u-admin", "openai", { baseUrl: "https://api.x.ai/v1" });
    expect(providerKey("u-admin", "openai")).toBe("sk-test-1234567890");
    expect(providerProxyToken("u-admin", "openai")).toBe(token);
    expect(getProvider("u-admin", "openai")!.baseUrl).toBe("https://api.x.ai/v1");
    // Someone else has no provider until they add their own, with a token of its own.
    expect(listProviders("u-other")).toEqual([]);
    expect(providerKey("u-other", "openai")).toBeNull();
    saveProvider("u-other", "openai", { baseUrl: "https://api.openai.com/v1", apiKey: "sk-other-1234567890" });
    expect(providerProxyToken("u-other", "openai")).not.toBe(token);
    expect(providerByToken("openai", token)).toMatchObject({ userId: "u-admin", key: "sk-test-1234567890" });
    expect(providerByToken("openai", providerProxyToken("u-other", "openai")!)).toMatchObject({ userId: "u-other", key: "sk-other-1234567890" });
    expect(providerByToken("anthropic", token)).toBeNull();
    expect(deleteProvider("u-other", "openai")).toBe(true);
    expect(providerKey("u-admin", "openai")).toBe("sk-test-1234567890");
    expect(deleteProvider("u-admin", "openai")).toBe(true);
    expect(providerKey("u-admin", "openai")).toBeNull();
  });

  test("more than one engine is on at a time, and the one in use is always among them", async () => {
    const { getAi, updateAi } = await import("../src/data/ai.ts");
    expect(getAi("u-many").enabled).toEqual(["claude"]);

    // Turn on a second: both stay, and the one in use doesn't move on its own.
    const two = updateAi("u-many", { enabled: ["claude", "api"] });
    expect(two.enabled).toEqual(["claude", "api"]);
    expect(two.engine).toBe("claude");

    // Picking a model of the other engine is what moves it.
    const moved = updateAi("u-many", { engine: "api", engines: { api: { access: "api", model: "MiniMax-M2", provider: "anthropic" } } });
    expect(moved.engine).toBe("api");
    expect(moved.enabled).toEqual(["claude", "api"]);

    // Turning off the one in use hands it to what's left, rather than leaving nothing.
    const off = updateAi("u-many", { enabled: ["claude"] });
    expect(off.enabled).toEqual(["claude"]);
    expect(off.engine).toBe("claude");

    // An engine turned on that isn't in the list is still the one in use.
    const odd = updateAi("u-many", { engine: "grok", enabled: ["claude"] });
    expect(odd.engine).toBe("grok");
    expect(odd.enabled).toContain("grok");
  });

  test("a CLI runs on the plan, whatever an older row says", async () => {
    const { updateAi } = await import("../src/data/ai.ts");
    const { engineRun } = await import("../src/engines.ts");
    const { saveProvider, deleteProvider } = await import("../src/data/providers.ts");
    saveProvider("u-legacy", "xai", { baseUrl: "https://api.x.ai/v1", apiKey: "xai-1234567890" });
    // The state the old UI could leave behind: Grok pointed at a key.
    const ai = updateAi("u-legacy", { engine: "grok", engines: { grok: { access: "api", model: "grok-4.6", provider: "xai" } } });
    const run = engineRun(ai, "u-legacy");
    expect(run.access).toEqual({ kind: "plan" });
    expect(run.native).toBeUndefined();
    expect(run.model).toBe("grok-4.6");
    deleteProvider("u-legacy", "xai");
  });

  test("an engine runs on a key only while that key is there", async () => {
    const { saveProvider, deleteProvider, getProvider } = await import("../src/data/providers.ts");
    const { getAi, updateAi, releaseEngines } = await import("../src/data/ai.ts");
    const saved = (kind: "anthropic" | "openai" | "xai") => Boolean(getProvider("u-keys", kind));

    saveProvider("u-keys", "xai", { baseUrl: "https://api.x.ai/v1", apiKey: "xai-1234567890" });
    saveProvider("u-keys", "openai", { baseUrl: "https://api.openai.com/v1", apiKey: "sk-1234567890" });
    // Grok on xAI's key, Codex on OpenAI's; Claude Code stays on the plan.
    updateAi("u-keys", { engines: { grok: { access: "api", model: "" }, codex: { access: "api", model: "" } } });

    // xAI goes: Grok can still reach OpenAI's key, so it stays on an API; Codex is untouched.
    deleteProvider("u-keys", "xai");
    releaseEngines("u-keys", "xai", saved);
    expect(getAi("u-keys").engines.grok.access).toBe("api");
    expect(getAi("u-keys").engines.codex.access).toBe("api");

    // OpenAI goes too: neither has a key left, so both fall back to the plan.
    deleteProvider("u-keys", "openai");
    releaseEngines("u-keys", "openai", saved);
    expect(getAi("u-keys").engines.grok.access).toBe("plan");
    expect(getAi("u-keys").engines.codex.access).toBe("plan");
    expect(getAi("u-keys").engines.claude.access).toBe("plan");
  });

  test("AI settings are each person's own, and the team-wide ones from before become the admin's", async () => {
    const { getAi, updateAi, adoptLegacyAi } = await import("../src/data/ai.ts");
    const { readEngines, getSettings } = await import("../src/data/settings.ts");
    const { ensureKruDatabase } = await import("../src/db/init.ts");
    expect(getAi("u-admin").engine).toBe("claude");
    const next = updateAi("u-admin", { engine: "codex", engines: { codex: { access: "api", model: "gpt-test" } } });
    expect(next.engine).toBe("codex");
    expect(next.engines.codex).toEqual({ access: "api", model: "gpt-test", provider: null });
    // Calling an API directly remembers which of the person's keys it calls.
    const direct = updateAi("u-admin", { engine: "api", engines: { api: { access: "api", model: "MiniMax-M2", provider: "anthropic" } } });
    expect(direct.engine).toBe("api");
    expect(direct.engines.api).toEqual({ access: "api", model: "MiniMax-M2", provider: "anthropic" });
    expect(getAi("u-admin").engines.api.provider).toBe("anthropic");
    updateAi("u-admin", { engine: "codex" });
    expect(next.engines.claude.access).toBe("plan");
    // Nobody else's changed.
    expect(getAi("u-other").engine).toBe("claude");
    expect(getAi("u-other").engines.codex.access).toBe("plan");
    // An install from before engines keeps its Claude model.
    expect(readEngines(null, "claude-opus-5").claude.model).toBe("claude-opus-5");
    expect(readEngines('{"grok":{"access":"nope","model":"bad model!","provider":"nope"}}', null).grok).toEqual({ access: "plan", model: "", provider: null });
    // The engine settings an older install kept for the whole team are adopted by the admin, once, when they have none of their own.
    ensureKruDatabase().query("UPDATE kru_settings SET engine = 'grok', engines = ? WHERE id = 1").run(JSON.stringify({ grok: { access: "api", model: "grok-build" } }));
    adoptLegacyAi("u-admin");
    expect(getAi("u-admin").engine).toBe("codex");
    ensureKruDatabase().query("DELETE FROM kru_user_ai WHERE user_id = ?").run("u-admin");
    adoptLegacyAi("u-admin");
    expect(getAi("u-admin")).toMatchObject({ engine: "grok" });
    expect(getAi("u-admin").engines.grok).toEqual({ access: "api", model: "grok-build", provider: null });
    // The team settings no longer carry the engine at all.
    expect(Object.keys(getSettings()).sort()).toEqual(["onboarding", "timezone"]);
    updateAi("u-admin", { engine: "claude", engines: { grok: { access: "plan", model: "" }, codex: { access: "plan", model: "" } } });
  });

  test("a turn on an API key gets the proxy and the person's own token, never the key", async () => {
    const { saveProvider, deleteProvider, providerProxyToken } = await import("../src/data/providers.ts");
    const { engineRun, EngineSetupError } = await import("../src/engines.ts");
    const { getAi } = await import("../src/data/ai.ts");
    const base = getAi("u-admin");
    const ai = { ...base, engine: "api" as const, enabled: ["api" as const], engines: { ...base.engines, api: { access: "api" as const, model: "grok-4.6", provider: "xai" as const } } };
    // No key saved: a setup problem for the person, not a turn that half runs.
    expect(() => engineRun(ai, "u-admin")).toThrow(EngineSetupError);
    saveProvider("u-admin", "xai", { baseUrl: "https://api.x.ai/v1", apiKey: "xai-secret-123456" });
    const run = engineRun(ai, "u-admin");
    expect(run.engine).toBe("api");
    expect(run.model).toBe("grok-4.6");
    expect(run.native?.baseUrl).toEndWith("/api/llm/xai");
    expect(run.native?.token).toBe(providerProxyToken("u-admin", "xai")!);
    // The key itself never leaves the provider store: the proxy adds it on the way out.
    expect(JSON.stringify(run)).not.toContain("xai-secret");
    // A model is not optional when calling an API: there is no default to fall back on.
    expect(() => engineRun({ ...ai, engines: { ...ai.engines, api: { ...ai.engines.api, model: "" } } }, "u-admin")).toThrow(EngineSetupError);
    // The admin's key is nobody else's.
    expect(() => engineRun(ai, "u-other")).toThrow(EngineSetupError);
    deleteProvider("u-admin", "xai");
  });

  test("the LLM proxy swaps its token for its owner's key and refuses everything else", async () => {
    const { saveProvider, deleteProvider, providerProxyToken } = await import("../src/data/providers.ts");
    const { llmProxyRoutes } = await import("../src/routes/llm.ts");
    const { Hono } = await import("hono");
    const seen: { path: string; auth: string | null; xkey: string | null; body: string }[] = [];
    const upstream = Bun.serve({
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        seen.push({ path: url.pathname + url.search, auth: request.headers.get("authorization"), xkey: request.headers.get("x-api-key"), body: await request.text() });
        return new Response("data: {\"ok\":true}\n\n", { headers: { "content-type": "text/event-stream" } });
      },
    });
    try {
      saveProvider("u-admin", "openai", { baseUrl: `http://127.0.0.1:${upstream.port}/v1`, apiKey: "sk-real-key-123456" });
      saveProvider("u-admin", "anthropic", { baseUrl: `http://127.0.0.1:${upstream.port}`, apiKey: "ant-real-key-123456" });
      saveProvider("u-other", "openai", { baseUrl: `http://127.0.0.1:${upstream.port}/other`, apiKey: "sk-other-key-123456" });
      const app = new Hono();
      app.route("/api", llmProxyRoutes());
      const token = providerProxyToken("u-admin", "openai")!;
      const refused = await app.request("/api/llm/openai/responses", { method: "POST", headers: { authorization: "Bearer wrong" }, body: "{}" });
      expect(refused.status).toBe(401);
      expect(seen).toHaveLength(0);
      const ok = await app.request("/api/llm/openai/responses?x=1", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: '{"model":"m"}' });
      expect(ok.status).toBe(200);
      expect(await ok.text()).toContain('"ok":true');
      expect(seen[0]).toEqual({ path: "/v1/responses?x=1", auth: "Bearer sk-real-key-123456", xkey: null, body: '{"model":"m"}' });
      // Claude Code presents the token as a bearer; a non-Anthropic host gets the key both ways.
      const anthropic = await app.request("/api/llm/anthropic/v1/messages", { method: "POST", headers: { authorization: `Bearer ${providerProxyToken("u-admin", "anthropic")}` }, body: "{}" });
      expect(anthropic.status).toBe(200);
      expect(seen[1]!.path).toBe("/v1/messages");
      expect(seen[1]!.xkey).toBe("ant-real-key-123456");
      // One provider's token doesn't open the other.
      expect((await app.request("/api/llm/anthropic/v1/messages", { method: "POST", headers: { "x-api-key": token }, body: "{}" })).status).toBe(401);
      // Another person's token reaches their own key and endpoint, never the admin's.
      const other = await app.request("/api/llm/openai/responses", { method: "POST", headers: { authorization: `Bearer ${providerProxyToken("u-other", "openai")}` }, body: "{}" });
      expect(other.status).toBe(200);
      expect(seen[2]).toMatchObject({ path: "/other/responses", auth: "Bearer sk-other-key-123456" });
    } finally {
      upstream.stop(true);
      deleteProvider("u-admin", "openai");
      deleteProvider("u-admin", "anthropic");
      deleteProvider("u-other", "openai");
    }
  });

  test("add_mcp_server attaches a server and posts a sign-in card when it wants one", async () => {
    const { createBot, updateBot } = await import("../src/data/bots.ts");
    const { getThread, listMessages } = await import("../src/data/threads.ts");
    const { listMcpServers, deleteMcpServer } = await import("../src/data/mcp.ts");
    const { baseTools, mcpServerName } = await import("../src/tools.ts");
    const { botInputSchema } = await import("@krubot/shared");
    expect(mcpServerName("Robinhood Trading!")).toBe("robinhood-trading");
    // One server that wants OAuth (with discovery metadata), one that doesn't.
    let port = 0;
    const fake = Bun.serve({
      port: 0,
      fetch(request: Request): Response {
        const url = new URL(request.url);
        const base = `http://127.0.0.1:${port}`;
        if (url.pathname === "/.well-known/oauth-protected-resource/private/mcp") return Response.json({ resource: `${base}/private/mcp`, authorization_servers: [base] });
        if (url.pathname === "/.well-known/oauth-authorization-server") return Response.json({ authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, registration_endpoint: `${base}/register` });
        if (url.pathname === "/register") return Response.json({ client_id: "kru-client" });
        if (url.pathname === "/token") return Response.json({ access_token: "at-123", expires_in: 3600 });
        if (url.pathname === "/private/mcp") return new Response("", { status: 401, headers: { "www-authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/private/mcp"` } });
        if (url.pathname === "/public/mcp") return Response.json({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "p", version: "1" } } });
        return new Response("", { status: 404 });
      },
    });
    port = fake.port ?? 0;
    try {
      const bot = updateBot(createBot(botInputSchema.parse({ name: "Trader" }), "u-admin").id, { approval: "full" })!;
      const context = { box: { url: "http://box.invalid", token: "t", user: "u-admin" }, bot, thread: getThread(bot.threadId)!, message: { depth: 0 } as never, askBot: async () => "", syncSoul: async () => undefined, stopWork: async () => false, isWorking: () => false };
      const tool = baseTools(context).add_mcp_server!;
      expect(await tool.execute({ name: "x", url: "file:///etc/passwd" }, "c")).toContain("NOT added");
      expect(await tool.execute({ name: "x", url: "https://me:pw@example.com/mcp" }, "c")).toContain("NOT added");
      const added = String(await tool.execute({ name: "Robinhood", url: `http://127.0.0.1:${fake.port}/private/mcp` }, "c"));
      expect(added).toContain("Sign in card");
      const server = listMcpServers("u-admin").find((m) => m.name === "robinhood")!;
      expect(server.authStatus).toBe("needed");
      // The bot that added it gets it; another bot doesn't until the person gives it.
      const { getBot } = await import("../src/data/bots.ts");
      const { boxMcpServers } = await import("../src/mcp.ts");
      const { mcpToolkit } = await import("@krubot/shared");
      const other = createBot(botInputSchema.parse({ name: "Bystander" }), "u-admin");
      expect(getBot(bot.id)!.toolkits).toContain(mcpToolkit(server.id));
      expect(boxMcpServers(getBot(bot.id)!).map((m) => m.name)).toContain("robinhood");
      expect(boxMcpServers(other).map((m) => m.name)).not.toContain("robinhood");
      expect(String(await baseTools({ ...context, bot: other, thread: getThread(other.threadId)! }).connect_app!.execute({ app: "robinhood" }, "c"))).toContain("isn't given to you");
      const card = listMessages(bot.threadId).find((m) => m.kind === "signin")!;
      expect(card.approvalId).toBe(server.id);
      expect(card.body).toBe("Sign in to robinhood");
      // Asking again (or connect_app after add_mcp_server) doesn't add a second server or a second card.
      expect(String(await tool.execute({ name: "robinhood", url: `http://127.0.0.1:${fake.port}/private/mcp` }, "c"))).toContain("already attached");
      expect(String(await baseTools(context).connect_app!.execute({ app: "robinhood" }, "c"))).toContain("Sign in card");
      expect(listMcpServers("u-admin").filter((m) => m.name === "robinhood")).toHaveLength(1);
      expect(listMessages(bot.threadId).filter((m) => m.kind === "signin")).toHaveLength(1);
      expect(String(await tool.execute({ name: "Open Data", url: `http://127.0.0.1:${fake.port}/public/mcp` }, "c"))).toContain("without a sign-in");
      expect(listMcpServers("u-admin").find((m) => m.name === "open-data")?.authStatus).toBe("none");
      // The card's Sign in: the sign-in remembers the conversation and comes back to it, and the bot hears.
      const { mcpRoutes } = await import("../src/routes/mcp.ts");
      const { Hono } = await import("hono");
      const app = asPerson(new Hono(), "u-admin");
      app.route("/api", mcpRoutes());
      const beforeSignIn = JSON.stringify(boxMcpServers(getBot(bot.id)!));
      const started = (await (await app.request(`/api/mcp-servers/${server.id}/login`, { method: "POST", body: JSON.stringify({ threadId: bot.threadId }) })).json()) as { url: string };
      const state = new URL(started.url).searchParams.get("state")!;
      const back = await app.request(`/api/mcp-servers/oauth/callback?code=c1&state=${state}`);
      expect(back.status).toBe(302);
      expect(back.headers.get("location")).toEndWith(`/app/t/${bot.threadId}`);
      expect(listMcpServers("u-admin").find((m) => m.name === "robinhood")?.authStatus).toBe("signed_in");
      // The sign-in changes what the box gets, so the bot's session relaunches and lists the tools.
      const signedIn = JSON.stringify(boxMcpServers(getBot(bot.id)!));
      expect(signedIn).not.toBe(beforeSignIn);
      expect(signedIn).toContain("signed_in");
      const after = listMessages(bot.threadId);
      expect(after.some((m) => m.kind === "event" && m.body === "Signed in to robinhood.")).toBe(true);
      expect(after.some((m) => m.kind === "prompt" && m.author === "system" && m.body.includes("robinhood"))).toBe(true);
      for (const m of listMcpServers("u-admin")) deleteMcpServer(m.id);
      // A deleted server leaves no trace in a bot's apps.
      expect(getBot(bot.id)!.toolkits.some((t) => t.startsWith("mcp:"))).toBe(false);
    } finally {
      fake.stop(true);
    }
  });

  test("add_mcp_server attaches a command server, arguments intact, and never with a secret in it", async () => {
    const { createBot, getBot, updateBot } = await import("../src/data/bots.ts");
    const { getThread } = await import("../src/data/threads.ts");
    const { listMcpServers, deleteMcpServer } = await import("../src/data/mcp.ts");
    const { setSecret } = await import("../src/data/secrets.ts");
    const { boxMcpServers } = await import("../src/mcp.ts");
    const { baseTools } = await import("../src/tools.ts");
    const { botInputSchema, mcpToolkit } = await import("@krubot/shared");
    const bot = updateBot(createBot(botInputSchema.parse({ name: "Painter" }), "u-admin").id, { approval: "full" })!;
    const context = { box: { url: "http://box.invalid", token: "t", user: "u-admin" }, bot, thread: getThread(bot.threadId)!, message: { depth: 0 } as never, askBot: async () => "", syncSoul: async () => undefined, stopWork: async () => false, isWorking: () => false };
    const tool = baseTools(context).add_mcp_server!;
    try {
      expect(await tool.execute({ name: "x" }, "c")).toContain("NOT added");
      expect(await tool.execute({ name: "x", url: "https://example.com/mcp", command: "uv" }, "c")).toContain("NOT added");
      expect(await tool.execute({ name: "x", command: "uv", args: "run" }, "c")).toContain("NOT added");
      setSecret("u-admin", "STEAM_PASSWORD", "hunter2-hunter2");
      expect(await tool.execute({ name: "x", command: "uv", env: { STEAM_PASSWORD: "hunter2-hunter2" } }, "c")).toContain("stored secret");
      const args = ["--directory", "/home/agent/My Tools/aseprite-mcp", "run", "-m", "aseprite_mcp"];
      const added = String(await tool.execute({ name: "Aseprite", command: "/home/agent/.local/bin/uv", args, env: { ASEPRITE_PATH: "/home/agent/.local/bin/aseprite" } }, "c"));
      expect(added).toContain("Added aseprite");
      const server = listMcpServers("u-admin").find((m) => m.name === "aseprite")!;
      expect(server.transport).toBe("stdio");
      expect(server.args).toEqual(args);
      expect(getBot(bot.id)!.toolkits).toContain(mcpToolkit(server.id));
      expect(boxMcpServers(getBot(bot.id)!).find((m) => m.name === "aseprite")).toMatchObject({ type: "stdio", command: "/home/agent/.local/bin/uv", args, env: { ASEPRITE_PATH: "/home/agent/.local/bin/aseprite" } });
      // The same command again, under any name, is the one already there.
      expect(String(await tool.execute({ name: "sprites", command: "/home/agent/.local/bin/uv", args }, "c"))).toContain("already attached");
      expect(listMcpServers("u-admin").filter((m) => m.transport === "stdio")).toHaveLength(1);
    } finally {
      for (const m of listMcpServers("u-admin")) deleteMcpServer(m.id);
    }
  });

  test("the proxy sends the box's call to the server's own URL, path and all", async () => {
    const { createMcpServer, deleteMcpServer, mcpProxyToken } = await import("../src/data/mcp.ts");
    const { boxMcpServers } = await import("../src/mcp.ts");
    const { mcpProxyRoutes } = await import("../src/routes/mcp.ts");
    const { Hono } = await import("hono");
    const seen: string[] = [];
    const fake = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        seen.push(url.pathname + url.search);
        if (url.pathname === "/mcp/trading") return Response.json({ jsonrpc: "2.0", id: 1, result: {} }, { headers: { "x-upstream": "yes" } });
        return new Response("nope", { status: 404 });
      },
    });
    try {
      const server = createMcpServer({ name: "robinhood", transport: "http", url: `http://127.0.0.1:${fake.port}/mcp/trading`, headers: { "X-Kru-Test": "1" }, args: [], env: {}, enabled: true }, "u-admin");
      const [given] = boxMcpServers({ toolkits: [`mcp:${server.id}`], userId: "u-admin" });
      expect(given?.type).toBe("http");
      if (given?.type !== "http") throw new Error("expected an http server");
      const app = new Hono().route("/api", mcpProxyRoutes());
      const path = `${new URL(given.url).pathname}?a=1`;
      const call = (headers: Record<string, string>) => app.request(path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }) });
      expect((await call({})).status).toBe(401);
      const res = await call(given.headers);
      expect(res.status).toBe(200);
      expect(res.headers.get("x-upstream")).toBe("yes");
      expect(seen).toEqual(["/mcp/trading?a=1"]);
      expect(mcpProxyToken(server.id)).toBe(given.headers["X-Kru-Mcp-Token"]);
      deleteMcpServer(server.id);
    } finally {
      fake.stop(true);
    }
  });

  test("a server's picture comes from its host's site icon, an app it's named after, or nothing", async () => {
    const { createMcpServer, deleteMcpServer } = await import("../src/data/mcp.ts");
    const { iconHosts, resolveMcpIcon } = await import("../src/mcp-icon.ts");
    expect(iconHosts("https://agent.robinhood.com/mcp/trading")).toEqual(["agent.robinhood.com", "robinhood.com"]);
    expect(iconHosts("https://linear.app/mcp")).toEqual(["linear.app"]);
    expect(iconHosts("http://localhost:3000/mcp")).toEqual([]);
    expect(iconHosts("http://10.0.0.5:8080/mcp")).toEqual([]);
    expect(iconHosts(undefined)).toEqual([]);
    const asked: string[] = [];
    const icons = Bun.serve({
      port: 0,
      fetch(req) {
        const name = new URL(req.url).pathname.slice(1);
        asked.push(name);
        // Like the real service: the site above the host has an icon, and a miss is a 404 with a picture in it.
        if (name === "robinhood.com.ico") return new Response(new Uint8Array([137, 80, 78, 71]), { headers: { "content-type": "image/png" } });
        return new Response(new Uint8Array([137, 80, 78, 71]), { status: 404, headers: { "content-type": "image/png" } });
      },
    });
    const iconService = `http://127.0.0.1:${icons.port}/`;
    try {
      const robinhood = createMcpServer({ name: "robinhood", transport: "http", url: "https://agent.robinhood.com/mcp/trading", headers: {}, args: [], env: {}, enabled: true }, "u-admin");
      const found = await resolveMcpIcon(robinhood, { iconService });
      expect(found?.kind).toBe("image");
      expect(asked).toEqual(["agent.robinhood.com.ico", "robinhood.com.ico"]);
      // Kept for a day: a second look doesn't ask again.
      await resolveMcpIcon(robinhood, { iconService });
      expect(asked).toHaveLength(2);
      const nowhere = createMcpServer({ name: "nowhere", transport: "http", url: "https://nonexistent.example/mcp", headers: {}, args: [], env: {}, enabled: true }, "u-admin");
      expect(await resolveMcpIcon(nowhere, { iconService })).toBeNull();
      const linear = createMcpServer({ name: "linear", transport: "http", url: "https://mcp.linear.app/mcp", headers: {}, args: [], env: {}, enabled: true }, "u-admin");
      expect(await resolveMcpIcon(linear, { iconService })).toEqual({ kind: "redirect", url: "https://logos.composio.dev/api/linear" });
      const command = createMcpServer({ name: "local", transport: "stdio", command: "npx", headers: {}, args: [], env: {}, enabled: true }, "u-admin");
      expect(await resolveMcpIcon(command, { iconService })).toBeNull();
      const { mcpRoutes } = await import("../src/routes/mcp.ts");
      const { Hono } = await import("hono");
      const app = asPerson(new Hono(), "u-admin").route("/api", mcpRoutes());
      expect((await app.request(`/api/mcp-servers/${linear.id}/icon`)).status).toBe(302);
      expect((await app.request(`/api/mcp-servers/${command.id}/icon`)).status).toBe(404);
      for (const s of [robinhood, nowhere, linear, command]) deleteMcpServer(s.id);
    } finally {
      icons.stop(true);
    }
  });

  test("a localhost sign-in registers the loopback redirect and finishes from a pasted address", async () => {
    const { createMcpServer, deleteMcpServer, getMcpServer } = await import("../src/data/mcp.ts");
    const { MCP_LOOPBACK_CALLBACK, defaultOAuthRedirect } = await import("@krubot/shared");
    expect(defaultOAuthRedirect("https://agent.robinhood.com/mcp/trading")).toBe("localhost");
    expect(defaultOAuthRedirect("https://mcp.linear.app/mcp")).toBe("app");
    let port = 0;
    const registered: string[][] = [];
    const tokenBodies: URLSearchParams[] = [];
    const fake = Bun.serve({
      port: 0,
      async fetch(request: Request): Promise<Response> {
        const url = new URL(request.url);
        const base = `http://127.0.0.1:${port}`;
        if (url.pathname === "/.well-known/oauth-protected-resource/mcp") return Response.json({ resource: `${base}/mcp`, authorization_servers: [base] });
        if (url.pathname === "/.well-known/oauth-authorization-server") return Response.json({ authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, registration_endpoint: `${base}/register` });
        if (url.pathname === "/register") {
          registered.push(((await request.json()) as { redirect_uris: string[] }).redirect_uris);
          return Response.json({ client_id: `client-${registered.length}` });
        }
        if (url.pathname === "/token") {
          tokenBodies.push(new URLSearchParams(await request.text()));
          return Response.json({ access_token: "at-local", expires_in: 3600 });
        }
        if (url.pathname === "/mcp") return new Response("", { status: 401, headers: { "www-authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"` } });
        return new Response("", { status: 404 });
      },
    });
    port = fake.port ?? 0;
    try {
      const server = createMcpServer({ name: "local-only", transport: "http", url: `http://127.0.0.1:${port}/mcp`, headers: {}, args: [], env: {}, enabled: true, oauthRedirect: "localhost" }, "u-admin");
      expect(server.oauthRedirect).toBe("localhost");
      const { mcpRoutes } = await import("../src/routes/mcp.ts");
      const { Hono } = await import("hono");
      const app = asPerson(new Hono(), "u-admin");
      app.route("/api", mcpRoutes());
      const started = (await (await app.request(`/api/mcp-servers/${server.id}/login`, { method: "POST", body: "{}" })).json()) as { url: string };
      const authorize = new URL(started.url);
      expect(authorize.searchParams.get("redirect_uri")).toBe(MCP_LOOPBACK_CALLBACK);
      expect(registered[0]).toEqual([MCP_LOOPBACK_CALLBACK]);
      const bad = await app.request("/api/mcp-servers/oauth/complete", { method: "POST", body: JSON.stringify({ url: "not an address" }) });
      expect(bad.status).toBe(400);
      const pasted = `${MCP_LOOPBACK_CALLBACK}?code=c9&state=${authorize.searchParams.get("state")}`;
      const done = await app.request("/api/mcp-servers/oauth/complete", { method: "POST", body: JSON.stringify({ url: pasted }) });
      expect(done.status).toBe(200);
      expect(((await done.json()) as { name: string }).name).toBe("local-only");
      expect(tokenBodies[0]?.get("redirect_uri")).toBe(MCP_LOOPBACK_CALLBACK);
      expect(getMcpServer(server.id)?.authStatus).toBe("signed_in");
      // Switched back to this app's own address: it registers again for that one.
      await app.request(`/api/mcp-servers/${server.id}`, { method: "PATCH", body: JSON.stringify({ oauthRedirect: "app" }) });
      await app.request(`/api/mcp-servers/${server.id}/login`, { method: "POST", body: "{}" });
      expect(registered).toHaveLength(2);
      expect(registered[1]?.[0]).toEndWith("/api/mcp-servers/oauth/callback");
      deleteMcpServer(server.id);
    } finally {
      fake.stop(true);
    }
  });

  test("a CLI signs in from the app: the computer drives it and the person is told when it lands", async () => {
    const { subscribe } = await import("../src/events.ts");
    const { watchEngineSignIn } = await import("../src/status.ts");
    let state = "waiting";
    const seen: { user: string | null; auth: string | null; code: string | null } = { user: null, auth: null, code: null };
    const fake = Bun.serve({
      port: 0,
      async fetch(request: Request): Promise<Response> {
        const url = new URL(request.url);
        seen.user = request.headers.get("x-kru-user");
        seen.auth = request.headers.get("authorization");
        const view = { engine: "claude", state, url: "https://claude.com/cai/oauth/authorize?code=true", code: null, needsCode: true, error: null, startedAt: "2026-01-01T00:00:00Z" };
        if (url.pathname === "/engines/claude/sign-in" && request.method === "POST") return Response.json({ signIn: { ...view, state: "starting", url: null } });
        if (url.pathname === "/engines/claude/sign-in" && request.method === "GET") return Response.json({ signIn: view });
        if (url.pathname === "/engines/claude/sign-in" && request.method === "DELETE") return Response.json({ ok: true });
        if (url.pathname === "/engines/claude/sign-in/code") {
          seen.code = ((await request.json()) as { code: string }).code;
          return Response.json({ signIn: { ...view, state: "finishing" } });
        }
        return new Response("", { status: 404 });
      },
    });
    const boxUrl = process.env.KRU_BOX_URL;
    const boxToken = process.env.KRU_BOX_TOKEN;
    process.env.KRU_BOX_URL = `http://127.0.0.1:${fake.port}`;
    process.env.KRU_BOX_TOKEN = "box-token";
    try {
      const { boxRoutes } = await import("../src/routes/box.ts");
      const { boxConfig } = await import("../src/box.ts");
      const { Hono } = await import("hono");
      const app = asPerson(new Hono(), "u-admin");
      app.route("/api", boxRoutes());

      expect((await app.request("/api/box/engines/nothing/sign-in")).status).toBe(404);

      const started = await app.request("/api/box/engines/claude/sign-in", { method: "POST", body: "{}" });
      expect(started.status).toBe(200);
      expect(((await started.json()) as { signIn: { state: string } }).signIn.state).toBe("starting");
      // The box is asked as this person, in their own account there.
      expect(seen.user).toBe("u-admin");
      expect(seen.auth).toBe("Bearer box-token");

      const waiting = (await (await app.request("/api/box/engines/claude/sign-in")).json()) as { signIn: { url: string; needsCode: boolean } };
      expect(waiting.signIn.url).toStartWith("https://claude.com/cai/oauth/authorize");
      expect(waiting.signIn.needsCode).toBe(true);

      expect((await app.request("/api/box/engines/claude/sign-in/code", { method: "POST", body: JSON.stringify({ code: "no" }) })).status).toBe(400);
      const answered = await app.request("/api/box/engines/claude/sign-in/code", { method: "POST", body: JSON.stringify({ code: "abcd#state" }) });
      expect(answered.status).toBe(200);
      expect(seen.code).toBe("abcd#state");

      // Even with the sheet closed, the sign-in landing reaches this person's app.
      const told = new Promise<void>((resolve) => {
        const off = subscribe((event) => {
          if (event.topic === "ai" && event.userId === "u-admin") {
            off();
            resolve();
          }
        });
      });
      watchEngineSignIn(boxConfig("u-admin")!, "u-admin", "claude", 20);
      state = "done";
      await told;

      expect((await app.request("/api/box/engines/claude/sign-in", { method: "DELETE" })).status).toBe(204);
    } finally {
      fake.stop(true);
      if (boxUrl === undefined) delete process.env.KRU_BOX_URL;
      else process.env.KRU_BOX_URL = boxUrl;
      if (boxToken === undefined) delete process.env.KRU_BOX_TOKEN;
      else process.env.KRU_BOX_TOKEN = boxToken;
    }
  });

  test("a push notice also goes out as a notify live event", async () => {
    const { subscribe } = await import("../src/events.ts");
    const { sendPush } = await import("../src/push.ts");
    const seen: unknown[] = [];
    const stop = subscribe((event) => {
      if (event.topic === "notify") seen.push(event);
    });
    try {
      // No browser is subscribed here, so nothing is sent; the event still fires.
      expect(await sendPush({ title: "Pip", body: "Done.", url: "/app/t/t1", tag: "t1", threadId: "t1" }, "u-admin")).toBe(0);
    } finally {
      stop();
    }
    expect(seen).toEqual([{ topic: "notify", userId: "u-admin", title: "Pip", body: "Done.", url: "/app/t/t1", tag: "t1", threadId: "t1" }]);
  });

  test("each person has their own bots, conversations and subscriptions", async () => {
    const { createBot, listBots, getChief } = await import("../src/data/bots.ts");
    const { createRoom, listThreads, postMessage, searchMessages, threadOwner } = await import("../src/data/threads.ts");
    const { saveSubscription, listSubscriptions, removeSubscription } = await import("../src/data/push.ts");
    const { botInputSchema } = await import("@krubot/shared");
    const mine = createBot(botInputSchema.parse({ name: "Mine", isChief: true }), "u-me");
    const theirs = createBot(botInputSchema.parse({ name: "Theirs", isChief: true }), "u-them");
    expect(listBots({ userId: "u-me" }).map((b) => b.id)).toEqual([mine.id]);
    expect(listBots({ userId: "u-them" }).map((b) => b.id)).toEqual([theirs.id]);
    expect(getChief("u-me")?.id).toBe(mine.id);
    expect(getChief("u-them")?.id).toBe(theirs.id);
    expect(threadOwner(mine.threadId)).toBe("u-me");
    const room = createRoom("Ours", [mine.id], "u-me");
    expect(listThreads({ userId: "u-me" }).map((t) => t.id).sort()).toEqual([mine.threadId, room.id].sort());
    expect(listThreads({ userId: "u-them" }).map((t) => t.id)).toEqual([theirs.threadId]);
    postMessage({ threadId: mine.threadId, author: "you", body: "the secret plan" });
    postMessage({ threadId: theirs.threadId, author: "you", body: "the secret plan" });
    expect(searchMessages("secret plan", "u-me").map((m) => m.threadId)).toEqual([mine.threadId]);
    saveSubscription({ endpoint: "https://push.example/me", keys: { p256dh: "a", auth: "b" } }, "u-me");
    saveSubscription({ endpoint: "https://push.example/them", keys: { p256dh: "a", auth: "b" } }, "u-them");
    expect(listSubscriptions("u-me").map((s) => s.endpoint)).toEqual(["https://push.example/me"]);
    // One person can't drop another's subscription.
    expect(removeSubscription("https://push.example/them", "u-me")).toBe(false);
    expect(removeSubscription("https://push.example/them", "u-them")).toBe(true);
  });

  test("the OIDC provider's secret is stored encrypted and never read back", async () => {
    const { getOidcSettings, updateOidcSettings, oidcProvider, oidcReady, clearOidcSecret } = await import("../src/data/oidc.ts");
    const { ensureKruDatabase } = await import("../src/db/init.ts");
    expect(oidcReady()).toBe(false);
    updateOidcSettings({ name: "Pocket ID", issuer: "https://id.example.com/", clientId: "kru", clientSecret: "s3cret-value", scopes: "" });
    const shown = getOidcSettings();
    expect(shown).toMatchObject({ enabled: false, name: "Pocket ID", issuer: "https://id.example.com", clientId: "kru", scopes: "openid profile email", hasClientSecret: true });
    expect(JSON.stringify(shown)).not.toContain("s3cret-value");
    const raw = ensureKruDatabase().query("SELECT oidc FROM kru_settings WHERE id = 1").get() as { oidc: string };
    expect(raw.oidc).not.toContain("s3cret-value");
    // Off until turned on; then the provider is built with the plain secret and the discovery issuer.
    expect(oidcProvider()).toBeNull();
    updateOidcSettings({ enabled: true });
    expect(oidcProvider()).toEqual({ name: "Pocket ID", issuer: "https://id.example.com", clientId: "kru", clientSecret: "s3cret-value", scopes: ["openid", "profile", "email"] });
    // An empty secret in a later patch keeps the stored one.
    updateOidcSettings({ clientSecret: "" });
    expect(oidcProvider()?.clientSecret).toBe("s3cret-value");
    expect(clearOidcSecret()).toMatchObject({ enabled: false, hasClientSecret: false });
    expect(oidcReady()).toBe(false);
  });

  test("the first account is the admin and adopts what came before users", async () => {
    const { ensureKruDatabase } = await import("../src/db/init.ts");
    const { ensureAdmin, adoptOrphans, listUsers, getUser, isAdmin, deleteUserData } = await import("../src/data/users.ts");
    const { createBot, listBots } = await import("../src/data/bots.ts");
    const { botInputSchema } = await import("@krubot/shared");
    const db = ensureKruDatabase();
    // A fresh install: nobody has signed up yet.
    db.exec('DELETE FROM "user"; DELETE FROM "account";');
    db.query('INSERT INTO "user" (id, name, email, role, createdAt, updatedAt) VALUES (?, ?, ?, NULL, ?, ?)').run("u-first", "dawson", "dawson@users.krubot.invalid", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z");
    db.query('INSERT INTO "account" (id, userId, providerId, accountId, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)').run("a1", "u-first", "credential", "u-first", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z");
    db.query('INSERT INTO "user" (id, name, email, role, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)').run("u-sso", "Sam", "sam@example.com", "user", "2026-02-01T00:00:00Z", "2026-02-01T00:00:00Z");
    db.query('INSERT INTO "account" (id, userId, providerId, accountId, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)').run("a2", "u-sso", "oidc", "sub-1", "2026-02-01T00:00:00Z", "2026-02-01T00:00:00Z");
    expect(ensureAdmin()).toBe("u-first");
    expect(getUser("u-first")).toMatchObject({ role: "admin", provider: "local" });
    expect(getUser("u-sso")).toMatchObject({ role: "user", provider: "oidc" });
    expect(isAdmin({ role: "admin" })).toBe(true);
    expect(isAdmin({ role: "user" })).toBe(false);
    // A bot from before there were users has no owner until the admin adopts it.
    const orphan = createBot(botInputSchema.parse({ name: "Old Timer" }), "u-first");
    db.query("UPDATE kru_bots SET user_id = NULL WHERE id = ?").run(orphan.id);
    db.query("UPDATE kru_threads SET user_id = NULL WHERE id = ?").run(orphan.threadId);
    adoptOrphans("u-first");
    expect(listBots({ userId: "u-first", includeHidden: true }).some((b) => b.id === orphan.id)).toBe(true);
    const sam = createBot(botInputSchema.parse({ name: "Sam's Bot" }), "u-sso");
    expect(listUsers().map((u) => [u.id, u.role, u.bots >= 1])).toEqual([["u-first", "admin", true], ["u-sso", "user", true]]);
    expect(deleteUserData("u-sso").bots).toEqual([sam.id]);
    expect(listBots({ userId: "u-sso", includeHidden: true })).toEqual([]);
    expect(listBots({ userId: "u-first", includeHidden: true }).some((b) => b.id === orphan.id)).toBe(true);
  });

  test("send_file hands the person a file from the box as an attachment", async () => {
    const { createBot } = await import("../src/data/bots.ts");
    const { getAttachment, getThread, listMessages } = await import("../src/data/threads.ts");
    const { baseTools, sharePath } = await import("../src/tools.ts");
    const { botInputSchema } = await import("@krubot/shared");
    expect(sharePath("~/.team/hello-world.html", "b1")).toBe(".team/hello-world.html");
    // An absolute path is the person's home on the box, once it is known; before that, nothing absolute is.
    expect(sharePath("/home/agent/.team/a.txt", "b1", "/home/agent")).toBe(".team/a.txt");
    expect(sharePath("/home/kru-ada/notes/a.txt", "b1", "/home/kru-ada")).toBe("notes/a.txt");
    expect(sharePath("/home/agent/.team/a.txt", "b1", "/home/kru-ada")).toBeNull();
    expect(sharePath("/home/agent/.team/a.txt", "b1")).toBeNull();
    expect(sharePath("out/report.pdf", "b1")).toBe(".bots/b1/out/report.pdf");
    expect(sharePath("../../../../etc/passwd", "b1")).toBeNull();
    expect(sharePath("/etc/passwd", "b1", "/home/agent")).toBeNull();
    const asked: string[] = [];
    const box = Bun.serve({
      port: 0,
      fetch(request: Request): Response {
        const url = new URL(request.url);
        if (url.pathname !== "/files/raw") return new Response("", { status: 404 });
        const path = url.searchParams.get("path") ?? "";
        asked.push(path);
        if (path.endsWith("missing.html")) return Response.json({ error: "No such file" }, { status: 404 });
        return new Response("<h1>Hello world</h1>", { headers: { "Content-Type": "application/octet-stream" } });
      },
    });
    try {
      const bot = createBot(botInputSchema.parse({ name: "Sender" }), "u-admin");
      const context = { box: { url: `http://127.0.0.1:${box.port}`, token: "t", user: "u-admin" }, bot, thread: getThread(bot.threadId)!, message: { depth: 0 } as never, askBot: async () => "", syncSoul: async () => undefined, stopWork: async () => false, isWorking: () => false };
      const tool = baseTools(context).send_file!;
      expect(String(await tool.execute({ path: "~/.team/missing.html" }, "c"))).toContain("NOT sent");
      expect(String(await tool.execute({ path: "~/.team/hello-world.html", note: "Here it is." }, "c"))).toContain("Sent hello-world.html");
      expect(asked).toContain(".team/hello-world.html");
      const posted = listMessages(bot.threadId).find((m) => m.attachments.length)!;
      expect(posted.author).toBe(bot.id);
      expect(posted.body).toBe("Here it is.");
      expect(posted.attachments[0]).toMatchObject({ name: "hello-world.html", mediaType: "text/html" });
      expect(new TextDecoder().decode(getAttachment(posted.attachments[0]!.id)!.data)).toBe("<h1>Hello world</h1>");
      // It downloads rather than rendering on the app's own origin.
      const { threadsRoutes } = await import("../src/routes/threads.ts");
      const { Hono } = await import("hono");
      const app = new Hono<{ Variables: { session: { user: { id: string } } } }>();
      // The routes answer the signed-in person; here that is the bots' owner.
      app.use("*", async (c, next) => {
        c.set("session", { user: { id: "u-admin" } });
        await next();
      });
      app.route("/api", threadsRoutes());
      const res = await app.request(`/api/attachments/${posted.attachments[0]!.id}`);
      expect(res.headers.get("content-disposition")).toStartWith("attachment;");
      expect(res.headers.get("content-security-policy")).toBe("sandbox");
    } finally {
      box.stop(true);
    }
  });

  test("another person's bots keep to their own team, apps, servers and secrets", async () => {
    await seedUsers(["u-admin", "admin"], ["u-other", "user"]);
    const { createBot, listBots } = await import("../src/data/bots.ts");
    const { getThread, listMessages, postMessage } = await import("../src/data/threads.ts");
    const { getConnection, listConnections, saveConnection } = await import("../src/data/settings.ts");
    const { createMcpServer, deleteMcpServer, mcpProxyToken } = await import("../src/data/mcp.ts");
    const { allSecretValues, injectSecrets, listSecrets, setSecret } = await import("../src/data/secrets.ts");
    const { adoptOrphans } = await import("../src/data/users.ts");
    const { ensureKruDatabase } = await import("../src/db/init.ts");
    const { composioKeySource, executeAction, toolsFor } = await import("../src/composio.ts");
    const { connectionsRoutes } = await import("../src/routes/connections.ts");
    const { mcpProxyRoutes, mcpRoutes } = await import("../src/routes/mcp.ts");
    const { Hono } = await import("hono");
    const { baseTools, loadTeamMemory } = await import("../src/tools.ts");
    const { promptFor } = await import("../src/responder.ts");
    const { systemPromptFor } = await import("../src/souls.ts");
    const { allowedToolkits, usableBot } = await import("../src/toolkits.ts");
    const { botInputSchema, mcpToolkit } = await import("@krubot/shared");
    const read: string[] = [];
    const box = Bun.serve({
      port: 0,
      fetch(request: Request): Response {
        const path = new URL(request.url).searchParams.get("path") ?? "";
        read.push(path);
        if (path === ".team/MEMORY.md") return Response.json({ content: "Dylan is the Chief of Staff." });
        return Response.json({ error: "No such file" }, { status: 404 });
      },
    });
    try {
      const config = { url: `http://127.0.0.1:${box.port}`, token: "t", user: "u-admin" };
      // The file from before team memory was per person is the admin's, and nobody else's.
      expect(await loadTeamMemory(config, "u-admin")).toBe("Dylan is the Chief of Staff.");
      expect(await loadTeamMemory(config, "u-other")).toBeNull();
      expect(read).toContain(".team/u-other/MEMORY.md");

      // Connected apps are each person's own: the admin's Gmail is nothing to anyone else's bots.
      saveConnection("u-admin", { toolkit: "gmail", name: "Gmail", accountId: "acc-admin", status: "active" });
      const comet = createBot(botInputSchema.parse({ name: "Comet", toolkits: ["gmail"] }), "u-other");
      expect(listConnections("u-other")).toEqual([]);
      expect(await toolsFor("u-other", ["gmail"])).toEqual([]);
      await expect(executeAction("u-other", "GMAIL_SEND_EMAIL", {}, "gmail")).rejects.toThrow();
      const thread = getThread(comet.threadId)!;
      const system = systemPromptFor(usableBot(comet), { bots: listBots({ includeHidden: true, userId: "u-other" }), thread, memory: null, memoryTruncated: false, teamMemory: null, connections: listConnections("u-other"), toolNotes: "", timezone: "UTC", skillsIndex: "", skills: [], mcpServers: [] });
      expect(system).toContain("Nobody else yet");
      expect(system).toContain("~/.team/u-other/MEMORY.md");
      expect(system).not.toContain("Dylan");
      expect(system).not.toContain("Gmail");

      /*
       * Their bot asks for the Composio key with the masked card rather than
       * sending them to Settings: the card lands before the tool waits, the
       * value goes straight to their own project key, and the bot only hears
       * that it worked.
       */
      const context = { box: config, bot: comet, thread, message: { depth: 0 } as never, askBot: async () => "", syncSoul: async () => undefined, stopWork: async () => false, isWorking: () => false };
      const { secretsRoutes } = await import("../src/routes/secrets.ts");
      const asking = baseTools(context).set_composio_key!.execute({ reason: "to connect your Gmail" }, "c");
      const card = listMessages(thread.id).find((m) => m.kind === "secret" && m.body.startsWith("COMPOSIO_API_KEY"))!;
      expect(card.approvalId).toBeTruthy();
      const secrets = asPerson(new Hono(), "u-other").route("/api", secretsRoutes());
      expect((await secrets.request(`/api/secret-requests/${card.approvalId}`, { method: "POST", body: JSON.stringify({ value: "ak_from_card" }) })).status).toBe(200);
      expect(String(await asking)).toContain("Connected apps are on");
      expect(composioKeySource("u-other")).toBe("own");
      // The key is write-only and redacted from anything a bot writes, like any secret.
      expect(allSecretValues()).toContain("ak_from_card");
      expect(String(await baseTools(context).set_composio_key!.execute({}, "c"))).toContain("already in place");
      const { clearComposioKey } = await import("../src/data/composio-keys.ts");
      clearComposioKey("u-other");
      const previous = process.env.COMPOSIO_API_KEY;
      process.env.COMPOSIO_API_KEY = "server-key";
      try {
        // The server's key is the admin's fallback, never anyone else's.
        expect(composioKeySource("u-admin")).toBe("server");
        expect(composioKeySource("u-other")).toBeNull();
        const other = asPerson(new Hono(), "u-other").route("/api", connectionsRoutes());
        const saved = await other.request("/api/composio", { method: "PUT", body: JSON.stringify({ apiKey: "ak_other_123" }) });
        expect(await saved.json()).toEqual({ source: "own" });
        expect(await (await other.request("/api/composio")).text()).not.toContain("ak_other_123");
        expect(composioKeySource("u-other")).toBe("own");
        expect(composioKeySource("u-admin")).toBe("server");
        expect(allSecretValues()).toContain("ak_other_123");
        expect((await other.request("/api/composio", { method: "DELETE" })).status).toBe(200);
        expect(composioKeySource("u-other")).toBeNull();
      } finally {
        if (previous === undefined) delete process.env.COMPOSIO_API_KEY;
        else process.env.COMPOSIO_API_KEY = previous;
      }

      // Secrets and MCP servers are each person's own too.
      setSecret("u-admin", "TOKEN", "admin-token-value");
      const missing: string[] = [];
      expect(injectSecrets("Bearer {{secret:TOKEN}}", "u-other", (name) => missing.push(name))).toBe("Bearer ");
      expect(missing).toEqual(["TOKEN"]);
      expect(injectSecrets("Bearer {{secret:TOKEN}}", "u-admin")).toBe("Bearer admin-token-value");
      expect(listSecrets("u-other")).toEqual([]);
      const adminServer = createMcpServer({ name: "private", transport: "http", url: "https://admin.example/mcp", headers: {}, args: [], env: {}, enabled: true }, "u-admin");
      const theirs = createMcpServer({ name: "private", transport: "http", url: "https://other.example/mcp", headers: { Authorization: "{{secret:TOKEN}}" }, args: [], env: {}, enabled: true }, "u-other");
      // Any app Composio supports is a toolkit they may be given; another person's MCP server never is.
      expect(allowedToolkits("u-other", ["gmail", "shortcut", "Not a toolkit!", mcpToolkit(adminServer.id), mcpToolkit(theirs.id)])).toEqual(["gmail", "shortcut", mcpToolkit(theirs.id)]);
      const routes = asPerson(new Hono(), "u-other").route("/api", mcpRoutes());
      const listed = (await (await routes.request("/api/mcp-servers")).json()) as { servers: { id: string }[] };
      expect(listed.servers.map((m) => m.id)).toEqual([theirs.id]);
      expect((await routes.request(`/api/mcp-servers/${adminServer.id}`, { method: "PATCH", body: JSON.stringify({ enabled: false }) })).status).toBe(404);
      expect((await routes.request(`/api/mcp-servers/${adminServer.id}`, { method: "DELETE" })).status).toBe(404);
      // Their server's headers never get the admin's secret of the same name.
      const proxy = new Hono().route("/api", mcpProxyRoutes());
      const proxied = await proxy.request(`/api/mcp/${theirs.id}/mcp`, { method: "POST", headers: { "x-kru-mcp-token": mcpProxyToken(theirs.id)! }, body: "{}" });
      expect(proxied.status).toBe(424);
      deleteMcpServer(adminServer.id);
      deleteMcpServer(theirs.id);

      // What came from before there were people is the admin's.
      ensureKruDatabase().query("INSERT INTO kru_connections (user_id, toolkit, name, account_id, status, created_at) VALUES (NULL, 'notion', 'Notion', 'acc-old', 'active', '2026-01-01T00:00:00Z')").run();
      adoptOrphans("u-admin");
      expect(getConnection("u-admin", "notion")?.accountId).toBe("acc-old");

      // A hidden prompt's words reach the bot, though the history leaves it out.
      const hello = postMessage({ threadId: comet.threadId, author: "system", kind: "prompt", body: "Greet the person as yourself." });
      const prompt = promptFor(comet, thread, hello, [comet]);
      expect(prompt).toContain("Greet the person as yourself.");
      expect(prompt).not.toContain("system report");
    } finally {
      box.stop(true);
    }
  });
});

describe("steering", () => {
  test("a message to a working bot goes into its turn, unless it's sent after or the turn can't take it", async () => {
    const { createBot } = await import("../src/data/bots.ts");
    const { botInputSchema } = await import("@krubot/shared");
    const { createRoom, getThread } = await import("../src/data/threads.ts");
    const { activeTurns, postFromPerson, steerText } = await import("../src/responder.ts");
    const { ensureKruDatabase } = await import("../src/db/init.ts");
    const waiting = (id: string) => (ensureKruDatabase().query("SELECT answered_at FROM kru_messages WHERE id = ?").get(id) as { answered_at: string | null }).answered_at === null;
    const bot = createBot(botInputSchema.parse({ name: "Steer Me" }), "u-steer");
    const thread = getThread(bot.threadId)!;

    // Nobody working: an ordinary message, waiting for a turn.
    const idle = await postFromPerson(thread, { body: "start the report" });
    expect(idle.steered).toBe(false);
    expect(waiting(idle.id)).toBe(true);

    const heard: string[] = [];
    let takes = true;
    const turn = { botId: bot.id, threadId: thread.id, userId: "u-steer", messageId: idle.id, controller: new AbortController(), startedAt: Date.now(), steer: async (text: string) => (heard.push(text), takes) };
    activeTurns().set(`${bot.id}--${thread.id}`, turn);
    try {
      const steered = await postFromPerson(thread, { body: "use last week's numbers" });
      expect(steered.steered).toBe(true);
      expect(waiting(steered.id)).toBe(false);
      expect(heard).toEqual([steerText("use last week's numbers")]);

      // Sent after, or with a file: it waits, and the turn hears nothing.
      const after = await postFromPerson(thread, { body: "then email it", after: true });
      expect(after.steered).toBe(false);
      expect(waiting(after.id)).toBe(true);
      expect(heard).toHaveLength(1);

      // The turn ended as it was steered: the message is put back to wait for its own.
      takes = false;
      const missed = await postFromPerson(thread, { body: "and a chart" });
      expect(missed.steered).toBe(false);
      expect(waiting(missed.id)).toBe(true);

      // A room steers only when every bot the message is for is working.
      const other = createBot(botInputSchema.parse({ name: "Idle Mate" }), "u-steer");
      const room = createRoom("Steer room", [bot.id, other.id], "u-steer");
      activeTurns().set(`${bot.id}--${room.id}`, { ...turn, threadId: room.id });
      takes = true;
      expect((await postFromPerson(room, { body: "@steer-me shorter please" })).steered).toBe(true);
      expect((await postFromPerson(room, { body: "@everyone shorter please" })).steered).toBe(false);
      activeTurns().delete(`${bot.id}--${room.id}`);
    } finally {
      activeTurns().delete(`${bot.id}--${thread.id}`);
    }
  });
});

describe("stop", () => {
  test("stopping a conversation stops everything its work set going, down the chain", async () => {
    const { createBot } = await import("../src/data/bots.ts");
    const { botInputSchema } = await import("@krubot/shared");
    const { createDelegation, getDelegation } = await import("../src/data/delegations.ts");
    const { createFollowUp, listFollowUps } = await import("../src/data/follow-ups.ts");
    const { listMessages, postMessage } = await import("../src/data/threads.ts");
    const { stopThread } = await import("../src/responder.ts");
    const { ensureKruDatabase } = await import("../src/db/init.ts");
    const waiting = (threadId: string) => (ensureKruDatabase().query("SELECT id FROM kru_messages WHERE thread_id = ? AND answered_at IS NULL").all(threadId) as { id: string }[]).length;
    const chief = createBot(botInputSchema.parse({ name: "Halt Chief" }), "u-halt");
    const researcher = createBot(botInputSchema.parse({ name: "Halt Researcher" }), "u-halt");
    const writer = createBot(botInputSchema.parse({ name: "Halt Writer" }), "u-halt");
    const bystander = createBot(botInputSchema.parse({ name: "Halt Bystander" }), "u-halt");
    const handOver = (from: typeof chief, to: typeof chief, brief: string) => {
      const posted = postMessage({ threadId: to.threadId, author: from.id, body: brief, depth: 1, fromThreadId: from.threadId });
      return createDelegation({ fromBotId: from.id, fromThreadId: from.threadId, toBotId: to.id, toThreadId: to.threadId, messageId: posted.id, brief });
    };

    // Waiting in the Chief's conversation: the person's queued message, a teammate's result, a hidden prompt.
    postMessage({ threadId: chief.threadId, author: "you", body: "then do the slides" });
    postMessage({ threadId: chief.threadId, author: bystander.id, body: "Result: done", fromThreadId: bystander.threadId });
    postMessage({ threadId: chief.threadId, author: "system", kind: "prompt", body: "carry on" });
    // What the Chief set going: a handoff to the Researcher, who handed part on to the Writer; a note to the Bystander; a follow-up.
    const first = handOver(chief, researcher, "Research the market");
    const second = handOver(researcher, writer, "Write it up");
    postMessage({ threadId: bystander.threadId, author: chief.id, body: "FYI, starting on the market", fromThreadId: chief.threadId });
    createFollowUp({ botId: chief.id, threadId: chief.threadId, note: "check on the research", dueAt: new Date(Date.now() + 3_600_000) });
    // The Bystander's own work is none of this Stop's business.
    postMessage({ threadId: bystander.threadId, author: "you", body: "unrelated question" });

    const outcome = await stopThread(chief.threadId);
    expect(outcome).toEqual({ stopped: 0, dropped: 3 });
    expect(waiting(chief.threadId)).toBe(0);
    expect(listMessages(chief.threadId).at(-1)!.body).toBe("Stopped. 3 waiting messages were dropped.");
    // Down the chain: both handoffs closed, both briefs no longer waiting.
    expect(getDelegation(first.id)?.status).toBe("cancelled");
    expect(getDelegation(second.id)?.status).toBe("cancelled");
    expect(waiting(researcher.threadId)).toBe(0);
    expect(waiting(writer.threadId)).toBe(0);
    // The note to the Bystander is dropped, its own message isn't.
    expect(waiting(bystander.threadId)).toBe(1);
    expect(listFollowUps(chief.id)).toEqual([]);

    // Nothing waiting: a Stop drops nothing and says nothing.
    const quiet = listMessages(chief.threadId).length;
    expect(await stopThread(chief.threadId)).toEqual({ stopped: 0, dropped: 0 });
    expect(listMessages(chief.threadId)).toHaveLength(quiet);
  });

  test("a CLI turn stopped mid-stream is a stop, not a crash: no incident, and the Chief isn't woken", async () => {
    const { createBot } = await import("../src/data/bots.ts");
    const { botInputSchema } = await import("@krubot/shared");
    const { createDelegation, getDelegation } = await import("../src/data/delegations.ts");
    const { getThread, listMessages, postMessage } = await import("../src/data/threads.ts");
    const { activeTurns, botTurn, stopThread } = await import("../src/responder.ts");
    const { ensureKruDatabase } = await import("../src/db/init.ts");
    const waiting = (threadId: string) => (ensureKruDatabase().query("SELECT id FROM kru_messages WHERE thread_id = ? AND answered_at IS NULL").all(threadId) as { id: string }[]).length;
    // A box whose turn stream stays open, as a CLI's does while it works.
    let turnOpened: () => void = () => undefined;
    const opened = new Promise<void>((resolve) => (turnOpened = resolve));
    const fake = Bun.serve({
      port: 0,
      fetch(request: Request): Response {
        if (!new URL(request.url).pathname.endsWith("/turn")) return Response.json({});
        turnOpened();
        const body = new ReadableStream({ start: (controller) => controller.enqueue(new TextEncoder().encode(": connected\n\n")) });
        return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
      },
    });
    const boxUrl = process.env.KRU_BOX_URL;
    const boxToken = process.env.KRU_BOX_TOKEN;
    process.env.KRU_BOX_URL = `http://127.0.0.1:${fake.port}`;
    process.env.KRU_BOX_TOKEN = "box-token";
    try {
      const chief = createBot(botInputSchema.parse({ name: "Stream Chief", isChief: true }), "u-stream");
      const worker = createBot(botInputSchema.parse({ name: "Stream Worker" }), "u-stream");
      const brief = postMessage({ threadId: worker.threadId, author: chief.id, body: "Tidy the folder", depth: 1, fromThreadId: chief.threadId });
      const handoff = createDelegation({ fromBotId: chief.id, fromThreadId: chief.threadId, toBotId: worker.id, toThreadId: worker.threadId, messageId: brief.id, brief: "Tidy the folder" });

      const turn = botTurn(worker, getThread(worker.threadId)!, brief);
      await opened;
      expect([...activeTurns().values()].some((t) => t.botId === worker.id)).toBe(true);
      expect((await stopThread(worker.threadId)).stopped).toBe(1);
      await turn;

      const said = listMessages(worker.threadId).map((m) => m.body);
      expect(said).toContain("Stream Worker was stopped.");
      expect(said.some((body) => body.includes("hit a problem"))).toBe(false);
      expect(getDelegation(handoff.id)?.status).toBe("cancelled");
      // The Chief hears that it was stopped, and nothing in its conversation waits to wake it.
      expect(listMessages(chief.threadId).some((m) => m.body.startsWith("Incident"))).toBe(false);
      expect(waiting(chief.threadId)).toBe(0);
    } finally {
      fake.stop(true);
      if (boxUrl === undefined) delete process.env.KRU_BOX_URL;
      else process.env.KRU_BOX_URL = boxUrl;
      if (boxToken === undefined) delete process.env.KRU_BOX_TOKEN;
      else process.env.KRU_BOX_TOKEN = boxToken;
    }
  });

  test("an approval closes when the turn waiting on it is stopped", async () => {
    const { createBot, updateBot } = await import("../src/data/bots.ts");
    const { botInputSchema } = await import("@krubot/shared");
    const { getApproval } = await import("../src/data/approvals.ts");
    const { listMessages } = await import("../src/data/threads.ts");
    const { requestApproval, decide } = await import("../src/approvals.ts");
    const bot = createBot(botInputSchema.parse({ name: "Halt Asker" }), "u-halt");
    updateBot(bot.id, { approval: "ask" });
    const turn = new AbortController();
    const pending = requestApproval({ bot: { ...bot, approval: "ask" }, threadId: bot.threadId, tool: "Bash", input: { command: "rm -rf build" }, signal: turn.signal });
    const card = listMessages(bot.threadId).at(-1)!;
    expect(card.kind).toBe("approval");
    turn.abort("stopped");
    expect(await pending).toBe("expired");
    expect(getApproval(card.approvalId!)?.status).toBe("expired");
    // A late tap on the card runs nothing: it's already closed.
    expect(decide(card.approvalId!, "allow")?.status).toBe("expired");
  });
});

describe("handoffs", () => {
  test("a handoff the person stopped closes quietly; one that failed wakes the bot that handed it over", async () => {
    const { createBot } = await import("../src/data/bots.ts");
    const { botInputSchema } = await import("@krubot/shared");
    const { createDelegation, getDelegation } = await import("../src/data/delegations.ts");
    const { listMessages, postMessage } = await import("../src/data/threads.ts");
    const { reportBack } = await import("../src/responder.ts");
    const { ensureKruDatabase } = await import("../src/db/init.ts");
    const waiting = (threadId: string) => (ensureKruDatabase().query("SELECT id FROM kru_messages WHERE thread_id = ? AND answered_at IS NULL").all(threadId) as { id: string }[]).map((r) => r.id);
    const chief = createBot(botInputSchema.parse({ name: "Stop Chief" }), "u-stop");
    const worker = createBot(botInputSchema.parse({ name: "Stop Worker" }), "u-stop");
    const handOver = (brief: string) => {
      const posted = postMessage({ threadId: worker.threadId, author: chief.id, body: brief, depth: 1, fromThreadId: chief.threadId });
      return { posted, handoff: createDelegation({ fromBotId: chief.id, fromThreadId: chief.threadId, toBotId: worker.id, toThreadId: worker.threadId, messageId: posted.id, brief }) };
    };

    const stopped = handOver("Tidy the folder");
    await reportBack(worker, stopped.posted, "", true);
    expect(getDelegation(stopped.handoff.id)).toMatchObject({ status: "cancelled", result: "Stopped by the person." });
    const note = listMessages(chief.threadId).at(-1)!;
    expect(note).toMatchObject({ author: "system", kind: "event" });
    expect(note.body).toContain("stopped by the person");
    // Nothing in the chief's conversation waits to be answered, so it isn't woken.
    expect(waiting(chief.threadId)).toEqual([]);

    const failed = handOver("Tidy the other folder");
    await reportBack(worker, failed.posted, "", false);
    expect(getDelegation(failed.handoff.id)?.status).toBe("failed");
    const result = listMessages(chief.threadId).at(-1)!;
    expect(result.author).toBe(worker.id);
    expect(waiting(chief.threadId)).toEqual([result.id]);
  });
  test("a teammate that hands part of its task on reports once the last result is in, a hop up", async () => {
    const { createBot } = await import("../src/data/bots.ts");
    const { botInputSchema } = await import("@krubot/shared");
    const { getDelegation } = await import("../src/data/delegations.ts");
    const { getThread, listMessages, postMessage } = await import("../src/data/threads.ts");
    const { reportBack } = await import("../src/responder.ts");
    const { teamTools } = await import("../src/tools.ts");
    const chief = createBot(botInputSchema.parse({ name: "Chain Chief", isChief: true }), "u-chain");
    const lead = createBot(botInputSchema.parse({ name: "Chain Lead" }), "u-chain");
    const coder = createBot(botInputSchema.parse({ name: "Chain Coder" }), "u-chain");
    const tester = createBot(botInputSchema.parse({ name: "Chain Tester" }), "u-chain");
    const tools = (bot: typeof chief, message: Parameters<typeof reportBack>[1]) =>
      teamTools({
        box: { url: "http://box.invalid", token: "t", user: "u-chain" },
        bot,
        thread: getThread(bot.threadId)!,
        message,
        askBot: async () => "",
        syncSoul: async () => undefined,
        stopWork: async () => false,
        isWorking: () => false,
      });
    const delegate = async (from: typeof chief, message: Parameters<typeof reportBack>[1], to: typeof chief, brief: string) => {
      const sent = String(await tools(from, message).delegate_bot!.execute({ bot: to.name, brief }, "c"));
      return getDelegation(/handoff (d[^)\s]+)/.exec(sent)![1]!)!;
    };
    const briefOf = (id: string) => listMessages(getDelegation(id)!.toThreadId).find((m) => m.id === getDelegation(id)!.messageId)!;
    const last = (threadId: string) => listMessages(threadId).at(-1)!;

    const asked = postMessage({ threadId: chief.threadId, author: "you", body: "Ship the feature" });
    const toLead = await delegate(chief, asked, lead, "Ship the feature");
    // The lead hands both halves on and ends its turn: its handoff stays open.
    const toCoder = await delegate(lead, briefOf(toLead.id), coder, "Write it");
    const toTester = await delegate(lead, briefOf(toLead.id), tester, "Test it");
    expect(toCoder.parentId).toBe(toLead.id);
    expect(briefOf(toCoder.id).depth).toBe(2);
    await reportBack(lead, briefOf(toLead.id), "Handed to the coder and the tester.", false);
    expect(getDelegation(toLead.id)!.status).toBe("open");

    // The coder's result: the tester is still out, so still nothing goes up.
    await reportBack(coder, briefOf(toCoder.id), "Written.", false);
    const coderResult = last(lead.threadId);
    expect(coderResult.depth).toBe(1);
    // Taking it in, the lead hands on a fix: part of the same task, no deeper.
    const toFixer = await delegate(lead, coderResult, coder, "Fix the edge case");
    expect(toFixer.parentId).toBe(toLead.id);
    expect(briefOf(toFixer.id).depth).toBe(2);
    await reportBack(lead, coderResult, "Waiting on the tester and the fix.", false);
    await reportBack(tester, briefOf(toTester.id), "Passes.", false);
    await reportBack(lead, last(lead.threadId), "Tests pass; waiting on the fix.", false);
    expect(getDelegation(toLead.id)!.status).toBe("open");

    await reportBack(coder, briefOf(toFixer.id), "Fixed.", false);
    await reportBack(lead, last(lead.threadId), "Shipped: written, fixed and tested.", false);
    expect(getDelegation(toLead.id)).toMatchObject({ status: "done", result: "Shipped: written, fixed and tested." });
    const result = last(chief.threadId);
    expect(result).toMatchObject({ author: lead.id, depth: 0 });
    expect(result.body).toContain("Shipped");
    // So the chief can run the next wave as if it were the first.
    expect((await delegate(chief, result, lead, "Now the docs")).status).toBe("open");
  });

  test("a teammate whose run keeps breaking reports each time as a failed result, and the carry-on briefs never run out of hops", async () => {
    const { createBot } = await import("../src/data/bots.ts");
    const { botInputSchema } = await import("@krubot/shared");
    const { getDelegation } = await import("../src/data/delegations.ts");
    const { getThread, listMessages, postMessage } = await import("../src/data/threads.ts");
    const { botTurn } = await import("../src/responder.ts");
    const { teamTools } = await import("../src/tools.ts");
    // A box whose every turn breaks, as a long task does when it runs out of time.
    const fake = Bun.serve({
      port: 0,
      fetch: (request: Request) => (new URL(request.url).pathname.endsWith("/turn") ? new Response("timed out", { status: 500 }) : Response.json({})),
    });
    const boxUrl = process.env.KRU_BOX_URL;
    const boxToken = process.env.KRU_BOX_TOKEN;
    process.env.KRU_BOX_URL = `http://127.0.0.1:${fake.port}`;
    process.env.KRU_BOX_TOKEN = "box-token";
    try {
      const chief = createBot(botInputSchema.parse({ name: "Carry Chief", isChief: true }), "u-carry");
      const worker = createBot(botInputSchema.parse({ name: "Carry Worker" }), "u-carry");
      let answering = postMessage({ threadId: chief.threadId, author: "you", body: "Run the long job" });
      for (let round = 0; round < 6; round += 1) {
        const sent = String(
          await teamTools({
            box: { url: "http://box.invalid", token: "t", user: "u-carry" },
            bot: chief,
            thread: getThread(chief.threadId)!,
            message: answering,
            askBot: async () => "",
            syncSoul: async () => undefined,
            stopWork: async () => false,
            isWorking: () => false,
          }).delegate_bot!.execute({ bot: worker.name, brief: "Carry on with the long job" }, "c"),
        );
        expect(sent).toContain("Assigned");
        const handoff = getDelegation(/handoff (d[^)\s]+)/.exec(sent)![1]!)!;
        const brief = listMessages(worker.threadId).find((m) => m.id === handoff.messageId)!;
        await botTurn(worker, getThread(worker.threadId)!, brief);
        expect(getDelegation(handoff.id)!.status).toBe("failed");
        // One message wakes the Chief, a hop up from the brief, and it says what broke.
        answering = listMessages(chief.threadId).at(-1)!;
        expect(answering).toMatchObject({ author: worker.id, depth: 0 });
        expect(answering.body).toContain("my run stopped with");
        expect(listMessages(chief.threadId).some((m) => m.body.startsWith("Incident"))).toBe(false);
      }
    } finally {
      fake.stop(true);
      process.env.KRU_BOX_URL = boxUrl;
      process.env.KRU_BOX_TOKEN = boxToken;
    }
  });

  test("stopping a teammate that waits on its own handoffs closes its handoff too", async () => {
    const { createBot } = await import("../src/data/bots.ts");
    const { botInputSchema } = await import("@krubot/shared");
    const { createDelegation, getDelegation } = await import("../src/data/delegations.ts");
    const { markAnswered, postMessage } = await import("../src/data/threads.ts");
    const { stopThread } = await import("../src/responder.ts");
    const chief = createBot(botInputSchema.parse({ name: "Wait Chief" }), "u-wait");
    const lead = createBot(botInputSchema.parse({ name: "Wait Lead" }), "u-wait");
    const helper = createBot(botInputSchema.parse({ name: "Wait Helper" }), "u-wait");
    const brief = postMessage({ threadId: lead.threadId, author: chief.id, body: "Do it", depth: 1, fromThreadId: chief.threadId });
    markAnswered(brief.id);
    const parent = createDelegation({ fromBotId: chief.id, fromThreadId: chief.threadId, toBotId: lead.id, toThreadId: lead.threadId, messageId: brief.id, brief: "Do it" });
    const inner = postMessage({ threadId: helper.threadId, author: lead.id, body: "Half of it", depth: 2, fromThreadId: lead.threadId });
    const child = createDelegation({ fromBotId: lead.id, fromThreadId: lead.threadId, toBotId: helper.id, toThreadId: helper.threadId, messageId: inner.id, brief: "Half of it", parentId: parent.id });
    await stopThread(lead.threadId);
    expect(getDelegation(child.id)!.status).toBe("cancelled");
    expect(getDelegation(parent.id)).toMatchObject({ status: "cancelled", result: "Stopped by the person." });
  });
});

describe("board data", () => {
  test("routine runs finish once, and each person sees only their own work", async () => {
    const { createBot } = await import("../src/data/bots.ts");
    const { botInputSchema } = await import("@krubot/shared");
    const { createRoutine, recordRoutineRun, finishRoutineRun, listRoutineRuns, recentRunsForUser, upcomingRoutines } = await import("../src/data/routines.ts");
    const { createDelegation, finishDelegation, listDelegationsForUser } = await import("../src/data/delegations.ts");
    const { postMessage } = await import("../src/data/threads.ts");
    const since = new Date(Date.now() - 60_000).toISOString();

    const mine = createBot(botInputSchema.parse({ name: "Board Mine" }), "u-admin");
    const helper = createBot(botInputSchema.parse({ name: "Board Helper" }), "u-admin");
    const theirs = createBot(botInputSchema.parse({ name: "Board Theirs" }), "u-board-other");

    const routine = createRoutine(mine.id, { name: "Morning", cron: "0 8 * * *", timezone: "UTC", prompt: "p", enabled: true });
    const other = createRoutine(theirs.id, { name: "Theirs", cron: "0 8 * * *", timezone: "UTC", prompt: "p", enabled: true });
    const posted = postMessage({ threadId: mine.threadId, author: "routine", body: "[Routine: Morning] p" });
    recordRoutineRun(routine.id, posted.id);
    recordRoutineRun(other.id, postMessage({ threadId: theirs.threadId, author: "routine", body: "x" }).id);

    expect(recentRunsForUser("u-admin", since).map((r) => r.routineId)).toEqual([routine.id]);
    expect(recentRunsForUser("u-admin", since)[0]).toMatchObject({ status: "started", botId: mine.id, threadId: mine.threadId, routineName: "Morning" });
    finishRoutineRun(posted.id, true);
    finishRoutineRun(posted.id, false);
    const [run] = listRoutineRuns(routine.id);
    expect(run).toMatchObject({ status: "done" });
    expect(run!.finishedAt).toBeTruthy();

    expect(upcomingRoutines("u-admin").map((r) => r.id)).toContain(routine.id);
    expect(upcomingRoutines("u-admin").map((r) => r.id)).not.toContain(other.id);

    const brief = postMessage({ threadId: helper.threadId, author: mine.id, body: "Find it", fromThreadId: mine.threadId });
    const open = createDelegation({ fromBotId: mine.id, fromThreadId: mine.threadId, toBotId: helper.id, toThreadId: helper.threadId, messageId: brief.id, brief: "Find it" });
    const done = createDelegation({ fromBotId: mine.id, fromThreadId: mine.threadId, toBotId: helper.id, toThreadId: helper.threadId, messageId: brief.id, brief: "Done it" });
    finishDelegation(done.id, "done", "Here");
    createDelegation({ fromBotId: theirs.id, fromThreadId: theirs.threadId, toBotId: theirs.id, toThreadId: theirs.threadId, messageId: "m", brief: "Not yours" });

    const listed = listDelegationsForUser("u-admin", since).map((d) => d.id);
    expect(listed).toContain(open.id);
    expect(listed).toContain(done.id);
    expect(listDelegationsForUser("u-admin", since).every((d) => d.fromBotId === mine.id)).toBe(true);
    // A finished handoff older than the window drops off; an open one never does.
    const later = new Date(Date.now() + 60_000).toISOString();
    expect(listDelegationsForUser("u-admin", later).map((d) => d.id)).toEqual([open.id]);
  });
});

describe("rooms a bot opens", () => {
  test("create_room opens a room of the bot's own teammates, and its first line wakes them", async () => {
    const { createBot } = await import("../src/data/bots.ts");
    const { botInputSchema } = await import("@krubot/shared");
    const { botLinesSincePerson, claimPendingMessages, getThread, listMessages, postMessage, releaseClaim } = await import("../src/data/threads.ts");
    const { teamTools } = await import("../src/tools.ts");
    const chief = createBot(botInputSchema.parse({ name: "Room Chief", isChief: true }), "u-room");
    const sound = createBot(botInputSchema.parse({ name: "Room Sound" }), "u-room");
    const art = createBot(botInputSchema.parse({ name: "Room Art" }), "u-room");
    const stranger = createBot(botInputSchema.parse({ name: "Room Stranger" }), "u-room-other");
    const asked = postMessage({ threadId: chief.threadId, author: "you", body: "Get sound and art talking" });
    const tools = teamTools({ bot: chief, thread: getThread(chief.threadId)!, message: asked, stopWork: async () => false, isWorking: () => false } as unknown as Parameters<typeof teamTools>[0]);

    expect(await tools.create_room!.execute({ name: "Cues", bots: ["Room Stranger"] }, "c1")).toContain("NOT created");
    expect(await tools.create_room!.execute({ name: "Cues", bots: ["Room Chief"] }, "c2")).toContain("NOT created");

    const answer = String(await tools.create_room!.execute({ name: "Cues", bots: ["@roomsound", art.id], message: "Agree the spinner cue." }, "c3"));
    const roomId = /id (room[^)\s]+)/.exec(answer)![1]!;
    const room = getThread(roomId)!;
    expect(room.kind).toBe("room");
    expect(room.userId).toBe("u-room");
    expect([...room.members].sort()).toEqual([chief.id, sound.id, art.id].sort());
    expect(room.members).not.toContain(stranger.id);

    const opener = listMessages(roomId).find((m) => m.author === chief.id)!;
    expect(opener.body).toBe("@roomsound @roomart Agree the spinner cue.");
    // Waiting to be answered, as a person's line would be.
    const pending = claimPendingMessages("room-test", () => 1000);
    for (const m of pending) releaseClaim(m.id);
    expect(pending.map((m) => m.id)).toContain(opener.id);
    expect(botLinesSincePerson(roomId)).toBe(1);
    postMessage({ threadId: roomId, author: "you", body: "Carry on" });
    expect(botLinesSincePerson(roomId)).toBe(0);
  });
});

describe("tools for running the work", () => {
  const setup = async (userId: string) => {
    const { createBot } = await import("../src/data/bots.ts");
    const { botInputSchema } = await import("@krubot/shared");
    const { getThread, postMessage } = await import("../src/data/threads.ts");
    const { baseTools, teamTools } = await import("../src/tools.ts");
    const chief = createBot(botInputSchema.parse({ name: `${userId} Chief`, isChief: true }), userId);
    const dev = createBot(botInputSchema.parse({ name: `${userId} Dev` }), userId);
    const asked = postMessage({ threadId: chief.threadId, author: "you", body: "Run the waves" });
    const stopped: string[] = [];
    const context = {
      box: { url: "http://box.invalid", token: "t", user: userId },
      bot: chief,
      thread: getThread(chief.threadId)!,
      message: asked,
      askBot: async () => "",
      syncSoul: async () => undefined,
      stopWork: async (id: string) => {
        stopped.push(id);
        return false;
      },
      isWorking: () => false,
    };
    const tools = { ...baseTools(context), ...teamTools(context) };
    const run = async (name: string, input: Record<string, unknown>) => String(await tools[name]!.execute(input, "c"));
    return { chief, dev, run, stopped };
  };

  test("handoffs are listed, amended and withdrawn, and the teammate hears of it", async () => {
    const { getDelegation } = await import("../src/data/delegations.ts");
    const { claimPendingMessages, listMessages, releaseClaim } = await import("../src/data/threads.ts");
    const { chief, dev, run, stopped } = await setup("u-waves");
    const sent = await run("delegate_bot", { bot: dev.name, brief: "Build the monthly clock" });
    const first = /handoff (d[^)\s]+)/.exec(sent)![1]!;
    expect(await run("list_handoffs", {})).toContain(`${first} · to ${dev.name} · open`);
    expect(await run("list_handoffs", { id: first })).toContain("Build the monthly clock");

    const amended = await run("amend_handoff", { handoff: dev.name, brief: "There are no months: build the yearly turn" });
    const second = /handoff (d[^,\s]+), replacing/.exec(amended)![1]!;
    expect(getDelegation(first)!.status).toBe("cancelled");
    expect(getDelegation(second)!.status).toBe("open");
    expect(stopped).toEqual([getDelegation(first)!.messageId]);
    // The old brief will never be answered; the new one will.
    const pending = claimPendingMessages("waves-test", () => 1000);
    for (const m of pending) releaseClaim(m.id);
    expect(pending.map((m) => m.id)).not.toContain(getDelegation(first)!.messageId);
    expect(pending.map((m) => m.id)).toContain(getDelegation(second)!.messageId);
    expect(listMessages(dev.threadId).some((m) => m.body.startsWith("I've withdrawn the task"))).toBe(true);

    expect(await run("cancel_handoff", { handoff: second, reason: "Sketch took it" })).toContain("Withdrawn");
    expect(getDelegation(second)!).toMatchObject({ status: "cancelled", result: "Sketch took it" });
    expect(await run("cancel_handoff", { handoff: second, reason: "again" })).toContain("already cancelled");
    expect(await run("list_handoffs", {})).toContain("withdrawn");

    // Someone else's handoff is not this bot's to touch.
    const other = await setup("u-waves-other");
    expect(await other.run("list_handoffs", { id: first })).toContain("NOT found");
    expect(await other.run("cancel_handoff", { handoff: first, reason: "x" })).toContain("isn't yours");
    expect(chief.id).not.toBe(other.chief.id);
  });

  test("a follow-up wakes the bot once, with its note, when it is due", async () => {
    const { runDueFollowUps } = await import("../src/dispatcher.ts");
    const { listMessages } = await import("../src/data/threads.ts");
    const { chief, run } = await setup("u-follow");
    expect(await run("follow_up", { minutes: 0, note: "x" })).toContain("NOT set");
    const set = await run("follow_up", { minutes: 45, note: "Check Bolt's build" });
    expect(set).toContain("Set (id");
    expect(await run("list_handoffs", {})).toContain("Check Bolt's build");
    runDueFollowUps(new Date(Date.now() + 10 * 60_000));
    expect(listMessages(chief.threadId).filter((m) => m.kind === "prompt")).toHaveLength(0);
    runDueFollowUps(new Date(Date.now() + 50 * 60_000));
    runDueFollowUps(new Date(Date.now() + 60 * 60_000));
    const prompts = listMessages(chief.threadId).filter((m) => m.kind === "prompt");
    expect(prompts).toHaveLength(1);
    expect(prompts[0]!.body).toContain("Check Bolt's build");
    const dropped = /id (f[^)\s]+)/.exec(await run("follow_up", { minutes: 5, note: "never mind" }))![1]!;
    expect(await run("follow_up", { cancel: dropped })).toContain("Dropped");
  });

  test("routines can be changed, run now and deleted, only the bot's own", async () => {
    const { listRoutines } = await import("../src/data/routines.ts");
    const { listMessages } = await import("../src/data/threads.ts");
    const { chief, run } = await setup("u-routines");
    await run("create_routine", { name: "Standup", cron: "0 9 * * *", prompt: "Say what moved" });
    expect(await run("update_routine", { routine: "standup", cron: "not a cron" })).toContain("bad cron");
    expect(await run("update_routine", { routine: "Standup", cron: "30 9 * * 1-5", enabled: true })).toContain("on, next run");
    expect(listRoutines(chief.id)[0]).toMatchObject({ cron: "30 9 * * 1-5", enabled: true });
    expect(await run("run_routine", { routine: "Standup" })).toContain("queued");
    expect(listMessages(chief.threadId).some((m) => m.author === "routine" && m.body.includes("Say what moved"))).toBe(true);
    const other = await setup("u-routines-other");
    expect(await other.run("delete_routine", { routine: listRoutines(chief.id)[0]!.id })).toContain("NOT deleted");
    expect(await run("delete_routine", { routine: "Standup" })).toContain("Deleted");
    expect(listRoutines(chief.id)).toHaveLength(0);
  });

  test("a bot reads and searches only its own person's conversations", async () => {
    const { createRoom, postMessage } = await import("../src/data/threads.ts");
    const { dev, run } = await setup("u-reading");
    postMessage({ threadId: dev.threadId, author: dev.id, body: "The export filter needs *.json", answered: true });
    const room = createRoom("Audio sync", [dev.id], "u-reading");
    postMessage({ threadId: room.id, author: "you", body: "Spinner cue first, please" });
    expect(await run("read_conversation", { conversation: dev.name })).toContain("The export filter needs *.json");
    expect(await run("read_conversation", { conversation: "audio sync" })).toContain("Person: Spinner cue first");
    expect(await run("search_messages", { query: "spinner" })).toContain('the room "Audio sync"');
    const other = await setup("u-reading-other");
    expect(await other.run("read_conversation", { conversation: room.id })).toContain("NOT found");
    expect(await other.run("read_conversation", { conversation: dev.id })).toContain("NOT found");
    expect(await other.run("search_messages", { query: "spinner" })).toContain("Nothing said matches");
  });
});

describe("clearing the board", () => {
  test("a person's clearings are theirs, and dropped after two days", async () => {
    const { clearBoardItems, clearedBoardItems } = await import("../src/data/board.ts");
    const { ensureKruDatabase } = await import("../src/db/init.ts");
    clearBoardItems("u-clear", ["handoff:a", "run:b"]);
    clearBoardItems("u-clear", ["handoff:a"]);
    expect([...clearedBoardItems("u-clear")].sort()).toEqual(["handoff:a", "run:b"]);
    expect(clearedBoardItems("u-clear-other").size).toBe(0);
    ensureKruDatabase().query("UPDATE kru_board_cleared SET cleared_at = ? WHERE item_id = 'run:b'").run(new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString());
    expect([...clearedBoardItems("u-clear")]).toEqual(["handoff:a"]);
  });
});

describe("usage", () => {
  test("each person sees only their own turns, by day, bot and model, with cost only where reported", async () => {
    const { recordUsage, usageSummary } = await import("../src/data/usage.ts");
    const { ensureKruDatabase } = await import("../src/db/init.ts");
    await seedUsers(["u-use", "user"], ["u-use-other", "user"]);
    const base = { threadId: "t-use", engine: "claude", model: "opus" };
    recordUsage({ ...base, userId: "u-use", botId: "b-a", usage: { input: 1000, output: 200, cachedInput: 400 }, cost: 0.5 });
    recordUsage({ ...base, userId: "u-use", botId: "b-a", usage: { input: 10, output: 5, cachedInput: 0 }, cost: null });
    recordUsage({ ...base, userId: "u-use", botId: "b-b", engine: "api", model: "gpt-x", usage: { input: 50, output: 50, cachedInput: 0 }, cost: null });
    recordUsage({ ...base, userId: "u-use-other", botId: "b-c", usage: { input: 9999, output: 9999, cachedInput: 0 }, cost: 9 });
    // Nothing reported, nothing kept.
    recordUsage({ ...base, userId: "u-use", botId: "b-a", usage: null, cost: null });
    // A turn from before the range is left out.
    ensureKruDatabase()
      .query("INSERT INTO kru_usage (id, user_id, bot_id, thread_id, engine, model, input, output, cached_input, cost, created_at) VALUES ('old', 'u-use', 'b-a', 't', 'claude', 'opus', 5, 5, 0, 1, ?)")
      .run(new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString());

    const summary = usageSummary("u-use", 30, "UTC");
    expect(summary.totals).toEqual({ turns: 3, input: 1060, output: 255, cachedInput: 400, cost: 0.5 });
    expect(summary.daily).toHaveLength(30);
    expect(summary.daily.at(-1)!.turns).toBe(3);
    expect(summary.bots.map((b) => [b.botId, b.turns])).toEqual([["b-a", 2], ["b-b", 1]]);
    expect(summary.bots[0]!.name).toBe("A deleted bot");
    expect(summary.models.find((m) => m.engine === "api")!.cost).toBeNull();
    expect(usageSummary("u-use", 90, "UTC").totals.turns).toBe(4);

    const { usageRoutes } = await import("../src/routes/usage.ts");
    const { Hono } = await import("hono");
    const app = asPerson(new Hono(), "u-use-other").route("/api", usageRoutes());
    const mine = (await (await app.request("/api/usage?days=7")).json()) as { totals: { turns: number } };
    expect(mine.totals.turns).toBe(1);
    expect((await app.request("/api/usage?days=12")).status).toBe(400);
  });
});

describe("skills", () => {
  test("each person has their own library of skill folders, and a route never shows anyone else's", async () => {
    await seedUsers(["u-sk-a", "user"], ["u-sk-b", "user"]);
    const { Hono } = await import("hono");
    const { skillsRoutes } = await import("../src/routes/skills.ts");
    const { listSkills, getSkill, skillFiles } = await import("../src/data/skills.ts");
    const { unpackSkill } = await import("../src/skill-bundle.ts");
    const a = asPerson(new Hono(), "u-sk-a").route("/api", skillsRoutes());
    const b = asPerson(new Hono(), "u-sk-b").route("/api", skillsRoutes());
    const json = { "Content-Type": "application/json" };

    const made = await a.request("/api/skills", { method: "POST", headers: json, body: JSON.stringify({ name: "Weekly report", description: "Numbers for Monday.", instructions: "Run scripts/report.py." }) });
    expect(made.status).toBe(201);
    const { skill } = (await made.json()) as { skill: { id: string; slug: string } };
    expect(skill.slug).toBe("weekly-report");
    // The same name is a new slug only within one library.
    const theirs = (await (await b.request("/api/skills", { method: "POST", headers: json, body: JSON.stringify({ name: "Weekly report", instructions: "Theirs." }) })).json()) as { skill: { slug: string } };
    expect(theirs.skill.slug).toBe("weekly-report");
    expect(listSkills("u-sk-a").map((s) => s.slug)).toEqual(["weekly-report"]);

    // Files next to SKILL.md: text written, binary uploaded, renamed, marked executable.
    expect((await a.request(`/api/skills/${skill.id}/file`, { method: "PUT", headers: json, body: JSON.stringify({ path: "scripts/report.py", content: "#!/usr/bin/env python3\nprint('hi')\n" }) })).status).toBe(200);
    expect((await a.request(`/api/skills/${skill.id}/file`, { method: "PUT", headers: json, body: JSON.stringify({ path: "../escape.py", content: "x" }) })).status).toBe(400);
    const form = new FormData();
    form.append("dir", "assets");
    form.append("file", new File([new Uint8Array([0, 1, 2, 3])], "logo.png"));
    expect((await a.request(`/api/skills/${skill.id}/files`, { method: "POST", body: form })).status).toBe(200);
    expect((await a.request(`/api/skills/${skill.id}/file`, { method: "PATCH", headers: json, body: JSON.stringify({ path: "assets/logo.png", to: "assets/brand.png" }) })).status).toBe(200);
    const files = getSkill(skill.id)!.files;
    expect(files).toEqual([
      { path: "assets/brand.png", size: 4, executable: false, text: false },
      { path: "scripts/report.py", size: 35, executable: true, text: true },
    ]);
    const read = (await (await a.request(`/api/skills/${skill.id}/file?path=scripts/report.py`)).json()) as { content: string };
    expect(read.content).toContain("print('hi')");

    // Someone else gets 404 for all of it.
    expect((await b.request(`/api/skills/${skill.id}/file?path=scripts/report.py`)).status).toBe(404);
    expect((await b.request(`/api/skills/${skill.id}/download`)).status).toBe(404);
    expect((await b.request(`/api/skills/${skill.id}`, { method: "PATCH", headers: json, body: JSON.stringify({ name: "Mine now" }) })).status).toBe(404);
    expect((await b.request(`/api/skills/${skill.id}`, { method: "DELETE" })).status).toBe(404);
    const bList = (await (await b.request("/api/skills")).json()) as { skills: { id: string }[] };
    expect(bList.skills.some((s) => s.id === skill.id)).toBe(false);

    // Out as a .skill and back in, files and all.
    const download = await a.request(`/api/skills/${skill.id}/download`);
    expect(download.headers.get("Content-Disposition")).toContain("weekly-report.skill");
    const zip = new Uint8Array(await download.arrayBuffer());
    const unpacked = unpackSkill(zip);
    if ("error" in unpacked) throw new Error(unpacked.error);
    expect(unpacked.files.map((f) => f.path)).toEqual(["assets/brand.png", "scripts/report.py"]);
    const upload = new FormData();
    upload.append("file", new File([zip], "weekly-report.skill"));
    const imported = await b.request("/api/skills/import", { method: "POST", body: upload });
    expect(imported.status).toBe(201);
    const copy = ((await imported.json()) as { skill: { id: string; slug: string; name: string; description: string; source: string } }).skill;
    expect(copy).toMatchObject({ slug: "weekly-report-2", name: "Weekly report", description: "Numbers for Monday.", source: "imported" });
    expect(skillFiles(copy.id).find((f) => f.path === "assets/brand.png")!.data).toEqual(new Uint8Array([0, 1, 2, 3]));

    // A lone SKILL.md imports too; junk doesn't.
    const md = new FormData();
    md.append("file", new File(["---\nname: pdf-filler\ndescription: Fill PDF forms.\n---\n\n# Fill\nSteps."], "SKILL.md"));
    const fromMd = ((await (await b.request("/api/skills/import", { method: "POST", body: md })).json()) as { skill: { name: string; slug: string } }).skill;
    expect(fromMd).toMatchObject({ name: "Pdf filler", slug: "pdf-filler" });
    const junk = new FormData();
    junk.append("file", new File(["not a zip"], "x.skill"));
    expect((await b.request("/api/skills/import", { method: "POST", body: junk })).status).toBe(400);

    expect((await a.request(`/api/skills/${skill.id}/file?path=assets/brand.png`, { method: "DELETE" })).status).toBe(200);
    expect((await a.request(`/api/skills/${skill.id}`, { method: "DELETE" })).status).toBe(204);
    expect(skillFiles(skill.id)).toEqual([]);
  });

  test("a bot saves what it just did as a skill, files and all, and updates it", async () => {
    await seedUsers(["u-sk-bot", "user"]);
    const { createBot } = await import("../src/data/bots.ts");
    const { getThread } = await import("../src/data/threads.ts");
    const { getSkillBySlug, skillFiles } = await import("../src/data/skills.ts");
    const { baseTools } = await import("../src/tools.ts");
    const { botInputSchema } = await import("@krubot/shared");
    const bot = createBot(botInputSchema.parse({ name: "Analyst" }), "u-sk-bot");
    const context = { box: { url: "http://box.invalid", token: "t", user: "u-sk-bot" }, bot, thread: getThread(bot.threadId)!, message: { depth: 0 } as never, askBot: async () => "", syncSoul: async () => undefined, stopWork: async () => false, isWorking: () => false };
    const tools = baseTools(context);
    const saved = await tools.save_skill!.execute({ name: "Churn report", description: "Churn by cohort.", instructions: "Run `python3 scripts/churn.py <csv>`.", files: [{ path: "scripts/churn.py", content: "#!/usr/bin/env python3\nimport sys\n" }, { path: "references/notes.md", content: "Cohorts are monthly." }] }, "call");
    expect(String(saved)).toContain("Saved as /churn-report with 2 files");
    const skill = getSkillBySlug("u-sk-bot", "churn-report")!;
    expect(skill.source).toBe("bot");
    expect(skill.files.map((f) => [f.path, f.executable])).toEqual([["references/notes.md", false], ["scripts/churn.py", true]]);
    expect(String(await tools.save_skill!.execute({ name: "Bad", instructions: "x", files: [{ path: "../../etc/x", content: "y" }] }, "call"))).toContain("NOT saved");
    // Another person's bot never finds it.
    expect(getSkillBySlug("u-admin", "churn-report")).toBeNull();
    expect(String(await tools.use_skill!.execute({ slug: "/churn-report" }, "call"))).toContain("~/.skills/churn-report/");
    // Update: one file replaced, the other kept.
    expect(String(await tools.update_skill!.execute({ slug: "churn-report", files: [{ path: "references/notes.md", content: "Cohorts are weekly." }] }, "call"))).toContain("Updated /churn-report");
    const notes = skillFiles(skill.id).find((f) => f.path === "references/notes.md")!;
    expect(new TextDecoder().decode(notes.data)).toBe("Cohorts are weekly.");
    expect(skillFiles(skill.id)).toHaveLength(2);
  });

  test("the library from before is the admin's, and a person's skills go with them", async () => {
    const { ensureKruDatabase } = await import("../src/db/init.ts");
    const { adoptOrphans, deleteUserData } = await import("../src/data/users.ts");
    const { createSkill, listSkills } = await import("../src/data/skills.ts");
    ensureKruDatabase().query("INSERT INTO kru_skills (id, user_id, slug, name, description, instructions, source, created_at, updated_at) VALUES ('sk-old', NULL, 'old', 'Old', '', 'Do it.', 'written', 'x', 'x')").run();
    adoptOrphans("u-admin");
    expect(listSkills("u-admin").map((s) => s.slug)).toContain("old");
    await seedUsers(["u-sk-gone", "user"]);
    createSkill("u-sk-gone", { name: "Temp", description: "", instructions: "x" }, "written", { files: [{ path: "a.txt", data: new TextEncoder().encode("a"), executable: false }] });
    deleteUserData("u-sk-gone");
    expect(listSkills("u-sk-gone")).toEqual([]);
    expect((ensureKruDatabase().query("SELECT COUNT(*) AS n FROM kru_skill_files f LEFT JOIN kru_skills s ON s.id = f.skill_id WHERE s.id IS NULL").get() as { n: number }).n).toBe(0);
  });
});
