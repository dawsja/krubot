import assert from "node:assert/strict";
import { test } from "node:test";
import { sameOrigin, serverCandidates } from "../src/server-url.mjs";

test("keeps a full address and drops its path", () => {
  assert.deepEqual(serverCandidates(" https://kru.example.com/login?next=/app "), ["https://kru.example.com"]);
  assert.deepEqual(serverCandidates("http://192.168.1.20:3000/"), ["http://192.168.1.20:3000"]);
});

test("tries https first for public names", () => {
  assert.deepEqual(serverCandidates("kru.example.com"), ["https://kru.example.com", "http://kru.example.com"]);
});

test("tries http first for this machine and private networks", () => {
  assert.deepEqual(serverCandidates("localhost:3000"), ["http://localhost:3000", "https://localhost:3000"]);
  assert.deepEqual(serverCandidates("10.0.0.5:3000"), ["http://10.0.0.5:3000", "https://10.0.0.5:3000"]);
  assert.deepEqual(serverCandidates("nas.local"), ["http://nas.local", "https://nas.local"]);
});

test("refuses what isn't a web address", () => {
  assert.throws(() => serverCandidates(""), /Enter the address/);
  assert.throws(() => serverCandidates("file:///etc/passwd"), /http:\/\/ or https:\/\//);
  assert.throws(() => serverCandidates("https://me:pw@kru.example.com"), /username and password/);
  assert.throws(() => serverCandidates("https://"), /doesn't look like an address/);
});

test("matches origins exactly", () => {
  assert.equal(sameOrigin("https://kru.example.com/app/t/1", "https://kru.example.com"), true);
  assert.equal(sameOrigin("https://kru.example.com.evil.test/", "https://kru.example.com"), false);
  assert.equal(sameOrigin("http://kru.example.com/", "https://kru.example.com"), false);
  assert.equal(sameOrigin("not a url", "https://kru.example.com"), false);
});
