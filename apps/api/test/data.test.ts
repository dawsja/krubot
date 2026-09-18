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
    const claimed = claimPendingMessages("test", 5);
    expect(claimed).toHaveLength(1);
    expect(claimPendingMessages("test", 5)).toHaveLength(0);
    markAnswered(claimed[0]!.id);
    postMessage({ threadId: bot.threadId, author: bot.id, body: "hi", answered: true });
    expect(listMessages(bot.threadId)).toHaveLength(2);
    expect(getThread(bot.threadId)!.lastMessage?.body).toBe("hi");
  });

  test("secret cards and hidden prompts are messages too", async () => {
    const { listBots } = await import("../src/data/bots.ts");
    const { postMessage, claimPendingMessages, listMessages } = await import("../src/data/threads.ts");
    const bot = listBots()[0]!;
    postMessage({ threadId: bot.threadId, author: bot.id, kind: "secret", body: "OPENAI_API_KEY: for summaries", approvalId: "sr_test", answered: true });
    const prompt = postMessage({ threadId: bot.threadId, author: "system", kind: "prompt", body: "Say hello." });
    expect(listMessages(bot.threadId).map((m) => m.kind)).toContain("secret");
    // A prompt waits for the bot like a message from the person does.
    expect(claimPendingMessages("test", 5).map((m) => m.id)).toEqual([prompt.id]);
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

  test("the Chief of Staff creates a teammate with create_bot", async () => {
    const { createBot, listBots, findBot } = await import("../src/data/bots.ts");
    const { getThread, listMessages } = await import("../src/data/threads.ts");
    const { chiefTools } = await import("../src/tools.ts");
    const { botInputSchema } = await import("@krubot/shared");
    const chief = createBot(botInputSchema.parse({ name: "Chief Test", title: "Chief of Staff", isChief: true }), "u-admin");
    const synced: string[] = [];
    const context = {
      box: { url: "http://box.invalid", token: "t" },
      bot: chief,
      thread: getThread(chief.threadId)!,
      message: { depth: 0 } as never,
      askBot: async () => "",
      syncSoul: async (b: { id: string }) => {
        synced.push(b.id);
      },
    };
    const tool = chiefTools(context).create_bot!;
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
    expect(listMessages(chief.threadId).some((m) => m.body.includes("added Dev"))).toBe(true);
    expect(await tool.execute({ name: "Dev", title: "Developer", description: "A second one." }, "call")).toContain("Created Dev 2");
  });

  test("an API provider's key is encrypted, write-only, and redacted", async () => {
    const { saveProvider, getProvider, listProviders, providerKey, providerProxyToken, deleteProvider } = await import("../src/data/providers.ts");
    const { allSecretValues } = await import("../src/data/secrets.ts");
    const { ensureKruDatabase } = await import("../src/db/init.ts");
    expect(() => saveProvider("openai", { baseUrl: "https://api.openai.com/v1" })).toThrow("Add the API key");
    const saved = saveProvider("openai", { baseUrl: "https://api.openai.com/v1/", apiKey: "sk-test-1234567890" });
    expect(saved.baseUrl).toBe("https://api.openai.com/v1");
    // Nothing a route could return carries the key.
    expect(JSON.stringify(saved)).not.toContain("sk-test");
    expect(JSON.stringify(listProviders())).not.toContain("sk-test");
    const raw = ensureKruDatabase().query("SELECT api_key FROM kru_providers WHERE kind = 'openai'").get() as { api_key: string };
    expect(raw.api_key).not.toContain("sk-test");
    expect(providerKey("openai")).toBe("sk-test-1234567890");
    const token = providerProxyToken("openai")!;
    expect(token.length).toBeGreaterThan(20);
    expect(allSecretValues()).toContain("sk-test-1234567890");
    // An edit without a key keeps the key and the proxy token.
    saveProvider("openai", { baseUrl: "https://api.x.ai/v1" });
    expect(providerKey("openai")).toBe("sk-test-1234567890");
    expect(providerProxyToken("openai")).toBe(token);
    expect(getProvider("openai")!.baseUrl).toBe("https://api.x.ai/v1");
    expect(deleteProvider("openai")).toBe(true);
    expect(providerKey("openai")).toBeNull();
  });

  test("engine settings keep each engine's access and model", async () => {
    const { getSettings, updateSettings, readEngines } = await import("../src/data/settings.ts");
    expect(getSettings().engine).toBe("claude");
    const next = updateSettings({ engine: "codex", engines: { ...getSettings().engines, codex: { access: "api", model: "gpt-test" } } });
    expect(next.engine).toBe("codex");
    expect(next.engines.codex).toEqual({ access: "api", model: "gpt-test" });
    expect(next.engines.claude.access).toBe("plan");
    // An install from before engines keeps its Claude model.
    expect(readEngines(null, "claude-opus-5").claude.model).toBe("claude-opus-5");
    expect(readEngines('{"grok":{"access":"nope","model":"bad model!"}}', null).grok).toEqual({ access: "plan", model: "" });
    updateSettings({ engine: "claude" });
  });

  test("a turn on an API key gets the proxy and its token, never the key", async () => {
    const { saveProvider, deleteProvider, providerProxyToken } = await import("../src/data/providers.ts");
    const { engineRun, EngineSetupError } = await import("../src/engines.ts");
    const { getSettings } = await import("../src/data/settings.ts");
    const settings = { ...getSettings(), engine: "grok" as const, engines: { ...getSettings().engines, grok: { access: "api" as const, model: "" } } };
    expect(() => engineRun(settings)).toThrow(EngineSetupError);
    saveProvider("openai", { baseUrl: "https://api.x.ai/v1", apiKey: "xai-secret-123456" });
    const run = engineRun(settings);
    expect(run.engine).toBe("grok");
    expect(run.model).toBe("");
    expect(run.access.kind).toBe("api");
    if (run.access.kind === "api") {
      expect(run.access.baseUrl).toEndWith("/api/llm/openai");
      expect(run.access.token).toBe(providerProxyToken("openai")!);
    }
    expect(JSON.stringify(run)).not.toContain("xai-secret");
    // Claude Code on someone else's Anthropic-compatible API gets its model for background work too.
    saveProvider("anthropic", { baseUrl: "https://api.z.test/anthropic", apiKey: "zk-secret-123456" });
    const claude = engineRun({ ...settings, engine: "claude", engines: { ...settings.engines, claude: { access: "api", model: "glm-5" } } });
    expect(claude.access.kind === "api" && claude.access.smallModel).toBe("glm-5");
    expect(engineRun({ ...settings, engine: "claude" }).access).toEqual({ kind: "plan" });
    deleteProvider("openai");
    deleteProvider("anthropic");
  });

  test("the LLM proxy swaps its token for the key and refuses everything else", async () => {
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
      saveProvider("openai", { baseUrl: `http://127.0.0.1:${upstream.port}/v1`, apiKey: "sk-real-key-123456" });
      saveProvider("anthropic", { baseUrl: `http://127.0.0.1:${upstream.port}`, apiKey: "ant-real-key-123456" });
      const app = new Hono();
      app.route("/api", llmProxyRoutes());
      const token = providerProxyToken("openai")!;
      const refused = await app.request("/api/llm/openai/responses", { method: "POST", headers: { authorization: "Bearer wrong" }, body: "{}" });
      expect(refused.status).toBe(401);
      expect(seen).toHaveLength(0);
      const ok = await app.request("/api/llm/openai/responses?x=1", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: '{"model":"m"}' });
      expect(ok.status).toBe(200);
      expect(await ok.text()).toContain('"ok":true');
      expect(seen[0]).toEqual({ path: "/v1/responses?x=1", auth: "Bearer sk-real-key-123456", xkey: null, body: '{"model":"m"}' });
      // Claude Code presents the token as a bearer; a non-Anthropic host gets the key both ways.
      const anthropic = await app.request("/api/llm/anthropic/v1/messages", { method: "POST", headers: { authorization: `Bearer ${providerProxyToken("anthropic")}` }, body: "{}" });
      expect(anthropic.status).toBe(200);
      expect(seen[1]!.path).toBe("/v1/messages");
      expect(seen[1]!.xkey).toBe("ant-real-key-123456");
      // One provider's token doesn't open the other.
      expect((await app.request("/api/llm/anthropic/v1/messages", { method: "POST", headers: { "x-api-key": token }, body: "{}" })).status).toBe(401);
    } finally {
      upstream.stop(true);
      deleteProvider("openai");
      deleteProvider("anthropic");
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
      const context = { box: { url: "http://box.invalid", token: "t" }, bot, thread: getThread(bot.threadId)!, message: { depth: 0 } as never, askBot: async () => "", syncSoul: async () => undefined };
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
    expect(sharePath("/home/agent/.team/a.txt", "b1")).toBe(".team/a.txt");
    expect(sharePath("out/report.pdf", "b1")).toBe(".bots/b1/out/report.pdf");
    expect(sharePath("../../../../etc/passwd", "b1")).toBeNull();
    expect(sharePath("/etc/passwd", "b1")).toBeNull();
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
      const context = { box: { url: `http://127.0.0.1:${box.port}`, token: "t" }, bot, thread: getThread(bot.threadId)!, message: { depth: 0 } as never, askBot: async () => "", syncSoul: async () => undefined };
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
    const { getThread, postMessage } = await import("../src/data/threads.ts");
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
      const config = { url: `http://127.0.0.1:${box.port}`, token: "t" };
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

      // Their bot connects apps in their own Composio project, once they add a key.
      const context = { box: config, bot: comet, thread, message: { depth: 0 } as never, askBot: async () => "", syncSoul: async () => undefined };
      expect(String(await baseTools(context).connect_app!.execute({ app: "gmail" }, "c"))).toContain("Composio API key");
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
      expect(allowedToolkits("u-other", ["gmail", "made-up", mcpToolkit(adminServer.id), mcpToolkit(theirs.id)])).toEqual(["gmail", mcpToolkit(theirs.id)]);
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
