import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CLAUDE_ALIASES, engineModels, parseGrokModels, readCodexModels } from "../models.mjs";

/** What `grok models` prints, signed in or not. */
const GROK_OUT = `You are not authenticated.

Default model: grok-4.6

Available models:
  * grok-4.6 (default)
  - grok-4.5
`;

test("what grok prints becomes models, the default marked", () => {
  assert.deepEqual(parseGrokModels(GROK_OUT), [{ id: "grok-4.6", default: true }, { id: "grok-4.5" }]);
  assert.deepEqual(parseGrokModels("nothing here"), []);
});

test("what Codex answers becomes models, hidden ones left out", () => {
  const answer = {
    data: [
      { id: "gpt-5.1-codex", model: "gpt-5.1-codex", displayName: "GPT-5.1 Codex", isDefault: true },
      { id: "gpt-5.1", model: "gpt-5.1", displayName: "GPT-5.1" },
      { id: "internal", model: "internal", hidden: true },
    ],
  };
  assert.deepEqual(readCodexModels(answer), [
    { id: "gpt-5.1-codex", name: "GPT-5.1 Codex", default: true },
    { id: "gpt-5.1", name: "GPT-5.1" },
  ]);
  assert.deepEqual(readCodexModels(null), []);
});

test("Claude Code runs on aliases, so the list never goes stale", async () => {
  const models = await engineModels("claude", { bins: {}, env: process.env });
  assert.deepEqual(
    models.map((model) => model.id),
    CLAUDE_ALIASES.map((model) => model.id),
  );
  assert.equal(models.find((model) => model.id === "opus")?.default, true);
  assert.equal(models.filter((model) => model.default).length, 1);
});

/** A stand-in CLI: a script on disk that answers the way the real one would. */
function fakeCli(name, body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kru-models-"));
  const file = path.join(dir, name);
  fs.writeFileSync(file, body, { mode: 0o755 });
  return file;
}

test("grok is asked for its own list", async () => {
  const bin = fakeCli("grok", `#!/bin/sh\n[ "$1" = "models" ] || exit 1\ncat <<'OUT'\n${GROK_OUT}OUT\n`);
  assert.deepEqual(await engineModels("grok", { bins: { grok: bin }, env: process.env }), [{ id: "grok-4.6", default: true }, { id: "grok-4.5" }]);
});

test("Codex is asked over its app-server, and a CLI that isn't there answers nothing", async () => {
  const bin = fakeCli(
    "codex",
    `#!/usr/bin/env node
process.stdin.setEncoding("utf8");
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let at = buffer.indexOf("\\n");
  while (at !== -1) {
    const line = buffer.slice(0, at);
    buffer = buffer.slice(at + 1);
    const message = JSON.parse(line);
    if (message.method === "initialize") process.stdout.write(JSON.stringify({ id: message.id, result: {} }) + "\\n");
    if (message.method === "model/list") process.stdout.write(JSON.stringify({ id: message.id, result: { data: [{ model: "gpt-5.1-codex", displayName: "GPT-5.1 Codex", isDefault: true }] } }) + "\\n");
    at = buffer.indexOf("\\n");
  }
});
`,
  );
  assert.deepEqual(await engineModels("codex", { bins: { codex: bin }, env: process.env }), [{ id: "gpt-5.1-codex", name: "GPT-5.1 Codex", default: true }]);
  assert.deepEqual(await engineModels("codex", { bins: { codex: "/nowhere/codex" }, env: process.env }), []);
  assert.deepEqual(await engineModels("grok", { bins: { grok: "/nowhere/grok" }, env: process.env }), []);
});
