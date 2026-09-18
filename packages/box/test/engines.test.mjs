import assert from "node:assert/strict";
import { test } from "node:test";
import { claudeAccessEnv, parseAccess } from "../agents.mjs";
import { permissionDecision } from "../bridge.mjs";
import { codexActivity, codexApprovalPolicy, codexArgs, codexEnv, codexInput, tomlValue, unwrapCommand, usageDelta } from "../codex.mjs";
import { acpMcpServers, grokActivity, grokArgs, grokEnv, grokPrompt, permissionOutcome, permissionSubject, withPersona } from "../grok.mjs";
import { insideHome, HttpError } from "../server.mjs";

const API = { kind: "api", baseUrl: "http://api:8790/api/llm/openai", token: "tok_abcdefghijklmnop" };

test("parseAccess takes the proxy only when it's well formed", () => {
  assert.deepEqual(parseAccess(undefined), { kind: "plan" });
  assert.deepEqual(parseAccess({ kind: "api", baseUrl: "file:///etc", token: "tok_abcdefghijklmnop" }), { kind: "plan" });
  assert.deepEqual(parseAccess({ kind: "api", baseUrl: API.baseUrl, token: "short" }), { kind: "plan" });
  assert.deepEqual(parseAccess(API), { ...API, smallModel: null });
});

test("Claude Code on an API reaches the proxy with the token as a bearer", () => {
  assert.deepEqual(claudeAccessEnv({ kind: "plan" }), {});
  const env = claudeAccessEnv({ kind: "api", baseUrl: "http://api:8790/api/llm/anthropic", token: "t", smallModel: "glm-5" });
  assert.equal(env.ANTHROPIC_BASE_URL, "http://api:8790/api/llm/anthropic");
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, "t");
  assert.equal(env.ANTHROPIC_DEFAULT_HAIKU_MODEL, "glm-5");
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
});

test("permission answers read as allow or deny", () => {
  assert.deepEqual(permissionDecision({ content: JSON.stringify({ behavior: "allow", updatedInput: {} }) }), { allow: true, message: "" });
  assert.deepEqual(permissionDecision({ content: JSON.stringify({ behavior: "deny", message: "no" }) }), { allow: false, message: "no" });
  assert.equal(permissionDecision({ content: "garbage" }).allow, false);
  assert.equal(permissionDecision(null).allow, false);
});

test("codexArgs writes valid -c overrides for the bridge, servers and the proxy", () => {
  const args = codexArgs({ node: "/usr/bin/node", mcpScript: "/box/kru-mcp.mjs", socketPath: "/tmp/a.sock", access: API, mcpServers: [{ type: "http", name: "linear", url: "http://api/mcp/1/mcp", headers: { "X-Kru-Mcp-Token": "abc" } }, { type: "stdio", name: "bad name!", command: "x" }] });
  assert.equal(args[0], "app-server");
  const overrides = args.filter((_, i) => args[i - 1] === "-c");
  assert.ok(overrides.includes('mcp_servers.kru={ "command" = "/usr/bin/node", "args" = ["/box/kru-mcp.mjs", "/tmp/a.sock"], "default_tools_approval_mode" = "approve", "startup_timeout_sec" = 30 }'));
  assert.ok(overrides.some((o) => o.startsWith("mcp_servers.linear=") && o.includes('"X-Kru-Mcp-Token" = "abc"')));
  assert.ok(!overrides.some((o) => o.includes("bad name")));
  assert.ok(overrides.includes('model_provider="kru"'));
  assert.ok(overrides.some((o) => o.startsWith("model_providers.kru=") && o.includes('"env_key" = "KRU_LLM_TOKEN"') && o.includes('"wire_api" = "responses"')));
  // Nothing of the token in argv: it goes in the environment.
  assert.ok(!args.join(" ").includes(API.token));
  assert.ok(!codexArgs({ node: "n", mcpScript: "m", socketPath: "s", access: { kind: "plan" } }).some((a) => a.includes("model_provider")));
  assert.equal(tomlValue('say "hi"\n'), '"say \\"hi\\"\\n"');
});

test("codexEnv drops inherited keys and carries the proxy token", () => {
  const env = codexEnv({ PATH: "/bin", OPENAI_API_KEY: "sk-leak", CODEX_API_KEY: "leak" }, API);
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.CODEX_API_KEY, undefined);
  assert.equal(env.KRU_LLM_TOKEN, API.token);
  assert.equal(codexEnv({ KRU_LLM_TOKEN: "old" }, { kind: "plan" }).KRU_LLM_TOKEN, undefined);
  assert.equal(codexApprovalPolicy("full"), "never");
  assert.equal(codexApprovalPolicy("ask"), "untrusted");
});

test("Codex activity reads like the person would say it", () => {
  assert.equal(unwrapCommand("/bin/bash -lc 'git status'"), "git status");
  assert.equal(unwrapCommand("ls -la"), "ls -la");
  assert.equal(codexActivity({ type: "commandExecution", command: "/bin/bash -lc 'npm test'" }), "$ npm test");
  assert.equal(codexActivity({ type: "fileChange", changes: [{ path: "/home/agent/.bots/b/notes.md" }] }, "/home/agent/.bots/b"), "Editing notes.md");
  assert.equal(codexActivity({ type: "mcpToolCall", server: "kru", tool: "send_message", arguments: { to: "Pip" } }), "send_message Pip");
  assert.equal(codexActivity({ type: "reasoning" }), null);
  assert.deepEqual(usageDelta({ inputTokens: 100, outputTokens: 5, cachedInputTokens: 0 }, { inputTokens: 300, outputTokens: 15, cachedInputTokens: 50 }), { input: 200, output: 10, cachedInput: 50 });
  const input = codexInput("hi", [{ mediaType: "image/png", data: "AAA" }, { mediaType: "application/pdf", data: "BBB" }]);
  assert.deepEqual(input, [{ type: "text", text: "hi", text_elements: [] }, { type: "image", url: "data:image/png;base64,AAA" }]);
});

test("Grok runs without borrowing Claude's config, on the proxy for an API", () => {
  const env = grokEnv({ PATH: "/bin", XAI_API_KEY: "leak" }, { kind: "plan" });
  assert.equal(env.XAI_API_KEY, undefined);
  assert.equal(env.GROK_CLAUDE_RULES_ENABLED, "0");
  assert.equal(env.GROK_CLAUDE_MCPS_ENABLED, "0");
  assert.equal(env.GROK_CURSOR_HOOKS_ENABLED, "0");
  const api = grokEnv({}, API);
  assert.equal(api.XAI_API_KEY, API.token);
  assert.equal(api.GROK_XAI_API_BASE_URL, API.baseUrl);
  assert.deepEqual(grokArgs({ model: "", effort: null, permission: "ask" }), ["agent", "stdio"]);
  assert.deepEqual(grokArgs({ model: "grok-build", effort: "high", permission: "full" }), ["agent", "--always-approve", "--model", "grok-build", "--reasoning-effort", "high", "stdio"]);
});

test("Grok's MCP servers use ACP's shape", () => {
  const servers = acpMcpServers({ node: "/usr/bin/node", mcpScript: "/box/kru-mcp.mjs", socketPath: "/tmp/a.sock", mcpServers: [{ type: "http", name: "linear", url: "http://x", headers: { A: "b" } }, { type: "stdio", name: "fs", command: "npx", args: ["x"], env: { K: "v" } }] });
  assert.deepEqual(servers[0], { name: "kru", command: "/usr/bin/node", args: ["/box/kru-mcp.mjs", "/tmp/a.sock"], env: [] });
  assert.deepEqual(servers[1], { type: "http", name: "linear", url: "http://x", headers: [{ name: "A", value: "b" }] });
  assert.deepEqual(servers[2], { name: "fs", command: "npx", args: ["x"], env: [{ name: "K", value: "v" }] });
});

test("Grok's permission questions read like Claude Code's and answer once", () => {
  const options = [
    { optionId: "always-allow", kind: "allow_always" },
    { optionId: "allow-once", kind: "allow_once" },
    { optionId: "reject-once", kind: "reject_once" },
  ];
  assert.deepEqual(permissionOutcome(options, true), { outcome: { outcome: "selected", optionId: "allow-once" } });
  assert.deepEqual(permissionOutcome(options, false), { outcome: { outcome: "selected", optionId: "reject-once" } });
  assert.deepEqual(permissionOutcome([], true), { outcome: { outcome: "cancelled" } });
  assert.deepEqual(permissionSubject({ kind: "execute", rawInput: { variant: "Bash", command: "rm -rf x", description: "clean" } }), { tool: "Bash", input: { command: "rm -rf x", description: "clean" } });
  assert.deepEqual(permissionSubject({ kind: "edit", rawInput: { path: "/a/b.md" } }), { tool: "Edit", input: { file_path: "/a/b.md" } });
  assert.equal(grokActivity({ title: "use_tool", rawInput: { tool_name: "kru__send_message", tool_input: { to: "Pip" } }, _meta: { "x.ai/tool": { name: "use_tool" } } }), "send_message Pip");
  assert.equal(grokActivity({ title: "run_terminal_command", rawInput: { command: "ls" } }), "$ ls");
  assert.ok(withPersona("Be Pip.", "hello").startsWith("<instructions>\nBe Pip.\n</instructions>"));
  assert.deepEqual(grokPrompt("hi", [{ mediaType: "image/png", data: "A" }], false), [{ type: "text", text: "hi" }]);
  assert.deepEqual(grokPrompt("hi", [{ mediaType: "image/png", data: "A" }], true)[1], { type: "image", data: "A", mimeType: "image/png" });
});

test("insideHome keeps every CLI's sign-in private", () => {
  for (const dir of [".claude/x", ".codex/auth.json", ".grok/auth.json"]) assert.throws(() => insideHome(dir), HttpError);
  assert.ok(insideHome(".bots/a/notes.md").endsWith("/.bots/a/notes.md"));
});
