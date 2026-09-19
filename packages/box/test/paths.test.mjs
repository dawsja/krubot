import assert from "node:assert/strict";
import { test } from "node:test";
import { boxCwd, capOutput, inside, insideHome, realInsideHome, HttpError } from "../server.mjs";
import { PERMISSION_MODES, argsKeyFor, sessionArgs, settle, userMessage } from "../agents.mjs";

const HOME = "/home/agent";
const CLAUDE = "/home/agent/.claude";

test("inside refuses paths that climb out or touch .git", () => {
  assert.equal(inside(HOME, ".bots/x/MEMORY.md"), `${HOME}/.bots/x/MEMORY.md`);
  assert.throws(() => inside(HOME, "../etc/passwd"), HttpError);
  assert.throws(() => inside(HOME, ".bots/.git/config"), HttpError);
  assert.throws(() => inside(HOME, ""), HttpError);
});

test("insideHome keeps the Claude login private", () => {
  assert.throws(() => insideHome(".claude/credentials.json", HOME, CLAUDE), HttpError);
  assert.equal(insideHome(".bots/a/SOUL.md", HOME, CLAUDE), `${HOME}/.bots/a/SOUL.md`);
});

test("boxCwd resolves inside the home only", () => {
  assert.equal(boxCwd(undefined, HOME, CLAUDE), HOME);
  assert.equal(boxCwd(".bots/a", HOME, CLAUDE), `${HOME}/.bots/a`);
  assert.equal(boxCwd("/home/agent/.bots/a", HOME, CLAUDE), `${HOME}/.bots/a`);
  assert.throws(() => boxCwd("/etc", HOME, CLAUDE), HttpError);
});

test("capOutput keeps the head and the tail", () => {
  const { text, truncated } = capOutput("a".repeat(100) + "b".repeat(100), 40);
  assert.equal(truncated, true);
  assert.ok(text.startsWith("aaaaaaaaaa"));
  assert.ok(text.endsWith("b".repeat(30)));
});

test("sessionArgs routes permission prompts to the kru bridge unless full", () => {
  const base = { model: "claude-sonnet-5", systemPromptFile: "/tmp/p.md", mcpConfigFile: "/tmp/m.json", sessionId: "s", resume: false, allowed: new Set(["--effort", "--strict-mcp-config"]) };
  const ask = sessionArgs({ ...base, permission: "ask" });
  assert.ok(ask.includes("--permission-prompt-tool"));
  assert.equal(ask[ask.indexOf("--permission-mode") + 1], "default");
  assert.ok(!ask.includes("--dangerously-skip-permissions"));
  const full = sessionArgs({ ...base, permission: "full" });
  assert.ok(full.includes("--dangerously-skip-permissions"));
  assert.ok(!full.includes("--permission-prompt-tool"));
  assert.deepEqual(PERMISSION_MODES, ["ask", "full"]);
});

test("argsKey changes with the permission mode", () => {
  const a = argsKeyFor({ model: "m", toolNames: ["x"], permission: "ask" });
  const b = argsKeyFor({ model: "m", toolNames: ["x"], permission: "full" });
  assert.notEqual(a, b);
});

test("settle reads a result line and ignores task notifications", () => {
  assert.equal(settle({ type: "assistant" }), null);
  assert.equal(settle({ type: "result", origin: { kind: "task-notification" } }), null);
  const done = settle({ type: "result", result: "hi", usage: { input_tokens: 2, output_tokens: 3 } });
  assert.equal(done.ok, true);
  assert.equal(done.text, "hi");
});

test("userMessage attaches images and PDFs as content blocks", () => {
  const plain = userMessage("hello", []);
  assert.equal(plain.message.content, "hello");
  const rich = userMessage("look", [{ name: "a.png", mediaType: "image/png", data: "AAAA" }, { name: "d.pdf", mediaType: "application/pdf", data: "BBBB" }, { name: "x.bin", mediaType: "application/octet-stream", data: "CC" }]);
  assert.equal(rich.message.content.length, 3);
  assert.equal(rich.message.content[0].type, "image");
  assert.equal(rich.message.content[1].type, "document");
});

test("realInsideHome follows links and refuses ones that leave the home or reach a sign-in", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "kru-home-"));
  const login = path.join(home, ".claude");
  fs.mkdirSync(login);
  fs.writeFileSync(path.join(login, "credentials.json"), "{}");
  fs.writeFileSync(path.join(home, "hello.html"), "<p>hi</p>");
  fs.symlinkSync(path.join(login, "credentials.json"), path.join(home, "creds"));
  fs.symlinkSync("/etc/hostname", path.join(home, "host"));
  fs.symlinkSync(path.join(home, "hello.html"), path.join(home, "hi"));
  try {
    assert.equal(realInsideHome("hi", home, login), fs.realpathSync(path.join(home, "hello.html")));
    assert.throws(() => realInsideHome("creds", home, login), HttpError);
    assert.throws(() => realInsideHome("host", home, login), HttpError);
    assert.throws(() => realInsideHome("missing", home, login), HttpError);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
