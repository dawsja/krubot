import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { AgentSession, STEER_FOLLOW_MS, isReplay, sessionArgs } from "../agents.mjs";

/*
 * Steering Claude Code, against the event order the CLI really produces
 * (with --replay-user-messages): a steer read at a tool boundary is echoed
 * inside the turn; one that arrives as the answer ends is run straight
 * after as a turn of its own, which starts with a fresh `system init`.
 */

function fakeSession({ replays = true } = {}) {
  const session = new AgentSession({ id: "steer-test", cwd: "/tmp", env: {}, socketDir: "/tmp", mcpScript: "/dev/null" });
  const written = [];
  session.child = {
    exitCode: null,
    killed: false,
    stdin: {
      writable: true,
      destroyed: false,
      write(line, done) {
        written.push(JSON.parse(line));
        done?.();
        return true;
      },
    },
  };
  session.replays = replays;
  const emit = (event) => session.onLine(JSON.stringify(event));
  const say = (text) => emit({ type: "assistant", message: { content: [{ type: "text", text }] } });
  const echo = (text) => emit({ type: "user", isReplay: true, message: { role: "user", content: text } });
  const result = (text) => emit({ type: "result", result: text, usage: {} });
  const start = () => session.turnWith({ prompt: "tidy the folder", timeoutMs: 60_000, onEvent: () => undefined, systemPrompt: "" });
  return { session, written, emit, say, echo, result, start };
}

/** Whether a promise has settled yet, without waiting for it. */
async function settled(promise) {
  let done = false;
  promise.then(() => (done = true));
  await new Promise((resolve) => setImmediate(resolve));
  return done;
}

test("the CLI is asked to echo what it reads, and only its echoes of our messages count", () => {
  const args = sessionArgs({ model: "opus", systemPromptFile: "/tmp/p", mcpConfigFile: "/tmp/m", sessionId: "s", resume: false, allowed: new Set(["--replay-user-messages"]) });
  assert.ok(args.includes("--replay-user-messages"));
  assert.equal(isReplay({ type: "user", isReplay: true, message: { content: "btw" } }), true);
  assert.equal(isReplay({ type: "user", isReplay: true, message: { content: [{ type: "tool_result", content: "ok" }] } }), false);
  assert.equal(isReplay({ type: "user", message: { content: "btw" } }), false);
});

test("a steer read at a tool boundary is part of the same turn", async () => {
  const { session, written, emit, say, echo, result, start } = fakeSession();
  const turn = start();
  emit({ type: "system", subtype: "init", session_id: "s" });
  echo("tidy the folder");
  emit({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "ls" } }] } });
  assert.equal(await session.steer("btw: skip the logs"), true);
  assert.equal(written.at(-1).message.content, "btw: skip the logs");
  emit({ type: "user", message: { content: [{ type: "tool_result", content: "a b" }] } });
  echo("btw: skip the logs");
  say("Tidied, and left the logs.");
  result("Tidied, and left the logs.");
  const done = await turn;
  assert.equal(done.ok, true);
  assert.equal(done.text, "Tidied, and left the logs.");
  assert.equal(session.turn, null);
});

test("a steer that lands as the answer ends keeps the turn open for the answer to it", async () => {
  const { session, emit, say, echo, result, start } = fakeSession();
  const turn = start();
  echo("tidy the folder");
  assert.equal(await session.steer("btw: say BANANA at the end"), true);
  say("Tidied.");
  result("Tidied.");
  // The CLI hasn't read the steer: this answer isn't the end.
  assert.equal(await settled(turn), false);
  emit({ type: "system", subtype: "init", session_id: "s" });
  echo("btw: say BANANA at the end");
  say("BANANA");
  result("BANANA");
  const done = await turn;
  assert.equal(done.text, "Tidied.\n\nBANANA");
  // The turn is over: a steer now is refused, and the message waits for the next turn.
  assert.equal(await session.steer("too late"), false);
});

test("a held answer is let go when no turn follows it", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const { session, echo, say, result, start } = fakeSession();
    const turn = start();
    echo("tidy the folder");
    await session.steer("btw");
    say("Tidied.");
    result("Tidied.");
    assert.equal(await settled(turn), false);
    mock.timers.tick(STEER_FOLLOW_MS);
    assert.equal((await turn).text, "Tidied.");
  } finally {
    mock.timers.reset();
  }
});

test("without echoes there's no telling where a steer went, so it's refused", async () => {
  const { session, echo, result, start } = fakeSession({ replays: false });
  assert.equal(await session.steer("no turn yet"), false);
  const turn = start();
  echo("tidy the folder");
  assert.equal(await session.steer("btw"), false);
  result("Tidied.");
  assert.equal((await turn).text, "Tidied.");
});

/** A JSON-RPC connection that records what was sent and lets the test answer each request. */
function fakeRpc() {
  const requests = [];
  const notices = [];
  return {
    requests,
    notices,
    request(method, params) {
      return new Promise((resolve, reject) => requests.push({ method, params, resolve, reject }));
    },
    notify(method, params) {
      notices.push({ method, params });
      return true;
    },
  };
}

const running = { exitCode: null, killed: false, stdin: { end() {} } };

test("Grok is steered by cancelling the prompt and sending the person's words next, in the same turn", async () => {
  const { GrokSession } = await import("../grok.mjs");
  const session = new GrokSession({ id: "grok-steer", cwd: "/tmp", env: {}, socketDir: "/tmp", mcpScript: "/dev/null" });
  session.child = running;
  session.rpc = fakeRpc();
  session.sessionId = "g1";
  session.personaSent = true;
  const turn = session.turnWith({ prompt: "tidy the folder", timeoutMs: 60_000, onEvent: () => undefined, systemPrompt: "" });
  const chunk = (text) => session.onNotification("session/update", { sessionId: "g1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } });
  chunk("Starting on the fol");

  // Waiting on an approval: a cancel would strand it, so the steer is refused.
  session.pendingCalls.set("c1", () => undefined);
  assert.equal(await session.steer("btw"), false);
  session.pendingCalls.clear();

  assert.equal(await session.steer("btw: skip the logs"), true);
  assert.equal(await session.steer("and be quick"), true);
  assert.deepEqual(session.rpc.notices.map((n) => n.method), ["session/cancel"]);
  session.rpc.requests[0].resolve({ stopReason: "cancelled" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(session.rpc.requests.length, 2);
  assert.match(JSON.stringify(session.rpc.requests[1].params.prompt), /btw: skip the logs\\n\\nand be quick/);
  assert.ok(session.turn);
  chunk("Done, logs left alone.");
  session.rpc.requests[1].resolve({ stopReason: "end_turn" });
  const done = await turn;
  assert.equal(done.ok, true);
  assert.equal(done.text, "Done, logs left alone.");
});

test("Codex is steered with turn/steer on the running turn, and says no when that turn is gone", async () => {
  const { CodexSession } = await import("../codex.mjs");
  const session = new CodexSession({ id: "codex-steer", cwd: "/tmp", env: {}, socketDir: "/tmp", mcpScript: "/dev/null" });
  session.child = running;
  session.rpc = fakeRpc();
  session.sessionId = "t1";
  assert.equal(await session.steer("no turn"), false);
  const turn = session.turnWith({ prompt: "tidy the folder", timeoutMs: 60_000, onEvent: () => undefined, systemPrompt: "" });
  // Before the app-server names the turn there's nothing to steer.
  assert.equal(await session.steer("too soon"), false);
  session.onNotification("turn/started", { threadId: "t1", turn: { id: "turn-1" } });
  const steering = session.steer("btw: skip the logs");
  const request = session.rpc.requests.at(-1);
  assert.equal(request.method, "turn/steer");
  assert.equal(request.params.expectedTurnId, "turn-1");
  assert.equal(request.params.input[0].text, "btw: skip the logs");
  request.resolve({ turnId: "turn-1" });
  assert.equal(await steering, true);
  const refused = session.steer("after all");
  session.rpc.requests.at(-1).reject(new Error("no active turn"));
  assert.equal(await refused, false);
  session.onNotification("turn/completed", { threadId: "t1", turn: { status: "completed" } });
  assert.equal((await turn).ok, true);
});
