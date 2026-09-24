import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Accounts, FIRST_UID, accountName, handOver, nextSlot, nextUid } from "../accounts.mjs";

/** A registry and homes in a temp folder, never root, so no Linux user is made. */
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kru-accounts-"));
  const skills = path.join(dir, "skills");
  const agentHome = path.join(dir, "agent");
  fs.mkdirSync(agentHome, { recursive: true });
  const make = () =>
    new Accounts({
      stateDir: path.join(dir, "state"),
      homesDir: path.join(dir, "homes"),
      root: false,
      skillsRoot: skills,
      agent: { name: "agent", uid: 1001, gid: 1001, home: agentHome, dirs: { claude: path.join(dir, "claude-volume") } },
    });
  return { dir, skills, agentHome, make, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test("accountName is kru- plus the person's letters, unique among the taken", () => {
  assert.equal(accountName({ name: "Ada Lovelace" }), "kru-ada-lovelace");
  assert.equal(accountName({ name: "", email: "Bob.Smith@example.com" }), "kru-bob-smith");
  assert.equal(accountName({ name: "日本", email: "", id: "u1" }), "kru-u1");
  assert.equal(accountName({ name: "42" }), "kru-p42");
  assert.equal(accountName({ name: "ada" }, new Set(["kru-ada", "kru-ada-2"])), "kru-ada-3");
  assert.ok(accountName({ name: "x".repeat(80) }).length <= 32);
});

test("uids and desktop slots are the lowest free ones", () => {
  assert.equal(nextUid(new Set([1001])), FIRST_UID);
  assert.equal(nextUid(new Set([1001, FIRST_UID, FIRST_UID + 1])), FIRST_UID + 2);
  assert.equal(nextSlot(new Set()), 1);
  assert.equal(nextSlot(new Set([1, 2])), 3);
});

test("the admin is the agent; everyone else gets a home of their own, kept across restarts", () => {
  const f = fixture();
  try {
    const accounts = f.make();
    const admin = accounts.ensure({ id: "u-admin", name: "Admin", email: "admin@example.com", admin: true });
    assert.equal(admin.name, "agent");
    assert.equal(admin.home, f.agentHome);
    assert.equal(admin.claude, path.join(f.dir, "claude-volume"));
    assert.equal(admin.slot, 0);
    const ada = accounts.ensure({ id: "u-ada", name: "Ada", email: "ada@example.com", admin: false });
    assert.equal(ada.name, "kru-ada");
    assert.equal(ada.home, path.join(f.dir, "homes", "kru-ada"));
    assert.equal(ada.slot, 1);
    assert.ok(fs.statSync(path.join(ada.home, ".bots")).isDirectory());
    assert.ok(fs.statSync(path.join(ada.home, ".team")).isDirectory());
    assert.equal(fs.readlinkSync(path.join(ada.home, ".skills")), path.join(f.skills, "kru-ada"));
    assert.ok(fs.statSync(path.join(f.skills, "kru-ada")).isDirectory());
    assert.deepEqual(ada.logins, [path.join(ada.home, ".claude"), path.join(ada.home, ".codex"), path.join(ada.home, ".grok")]);
    // Asking again is the same account; a second Ada is told apart.
    assert.equal(accounts.ensure({ id: "u-ada", name: "Ada", admin: false }).name, "kru-ada");
    assert.equal(accounts.ensure({ id: "u-ada2", name: "Ada", admin: false }).name, "kru-ada-2");
    assert.throws(() => accounts.ensure({ id: "u-ada", name: "Ada", admin: true }), /role changed/);
    assert.throws(() => accounts.ensure({ id: "u-other", name: "Other", admin: true }), /already has an admin/);
    // A new process reads the registry back and finds the same people.
    const again = f.make();
    assert.equal(again.get("u-ada").name, "kru-ada");
    assert.equal(again.get("u-ada2").slot, 2);
    assert.equal(again.admin().id, "u-admin");
    assert.equal(again.get("nobody"), null);
    again.restore();
    assert.ok(fs.existsSync(path.join(f.dir, "homes", "kru-ada-2", ".bots")));
  } finally {
    f.cleanup();
  }
});

test("a home's old skills folder becomes the link to the person's own library, never copied into it, and removing an account removes the home and library", () => {
  const f = fixture();
  try {
    const accounts = f.make();
    fs.mkdirSync(path.join(f.agentHome, ".skills", "hello"), { recursive: true });
    fs.writeFileSync(path.join(f.agentHome, ".skills", "hello", "SKILL.md"), "hi");
    // The shared library from before: a skill folder straight under the root.
    fs.mkdirSync(path.join(f.skills, "old-shared"), { recursive: true });
    fs.writeFileSync(path.join(f.skills, "old-shared", "SKILL.md"), "old");
    accounts.clearLegacySkills();
    assert.equal(fs.existsSync(path.join(f.skills, "old-shared")), false);
    accounts.materialize(accounts.agentAccount());
    assert.equal(fs.readlinkSync(path.join(f.agentHome, ".skills")), path.join(f.skills, "agent"));
    assert.equal(fs.existsSync(path.join(f.skills, "agent", "hello")), false);
    const ada = accounts.ensure({ id: "u-ada", name: "Ada", admin: false });
    fs.writeFileSync(path.join(ada.home, "notes.md"), "mine");
    fs.mkdirSync(path.join(ada.library, "mine"));
    // Another person's library is another folder.
    assert.notEqual(ada.library, accounts.agentAccount().library);
    assert.equal(accounts.remove("u-ada"), true);
    assert.equal(fs.existsSync(ada.home), false);
    assert.equal(fs.existsSync(ada.library), false);
    assert.equal(accounts.get("u-ada"), null);
    assert.equal(accounts.remove("u-ada"), false);
    accounts.ensure({ id: "u-admin", name: "Admin", admin: true });
    assert.throws(() => accounts.remove("u-admin"), /admin/);
  } finally {
    f.cleanup();
  }
});

test("a reset empties the admin's home, takes every other account, and keeps the sign-ins", () => {
  const f = fixture();
  try {
    const accounts = f.make();
    const admin = accounts.ensure({ id: "u-admin", name: "Admin", admin: true });
    const ada = accounts.ensure({ id: "u-ada", name: "Ada", admin: false });
    // The admin's home: bots, team files, a global install, and sign-ins
    // (its Claude one is a volume outside the home, as on the real box).
    fs.mkdirSync(path.join(admin.bots, "bot-1"), { recursive: true });
    fs.writeFileSync(path.join(admin.bots, "bot-1", "MEMORY.md"), "what it learned");
    fs.writeFileSync(path.join(admin.team, "MEMORY.md"), "the team's");
    fs.mkdirSync(path.join(admin.home, ".npm-global"), { recursive: true });
    fs.mkdirSync(admin.codex, { recursive: true });
    fs.writeFileSync(path.join(admin.codex, "auth.json"), "admin codex");
    fs.mkdirSync(admin.claude, { recursive: true });
    fs.writeFileSync(path.join(admin.claude, "creds.json"), "admin claude");
    fs.mkdirSync(path.join(f.skills, "hello"), { recursive: true });
    fs.writeFileSync(path.join(f.skills, "hello", "SKILL.md"), "hi");
    // Ada's home: her files and her own sign-in.
    fs.writeFileSync(path.join(ada.home, "notes.md"), "mine");
    fs.mkdirSync(ada.grok, { recursive: true });
    fs.writeFileSync(path.join(ada.grok, "auth.json"), "ada grok");

    const result = accounts.reset();
    assert.deepEqual(result.accounts, ["kru-ada"]);
    assert.ok(result.removed.includes(".npm-global"));
    // Ada is gone, home and all; the admin is still the admin.
    assert.equal(accounts.get("u-ada"), null);
    assert.equal(fs.existsSync(ada.home), false);
    assert.equal(accounts.admin().id, "u-admin");
    // The admin's home is empty but for its folders, made again.
    assert.deepEqual(fs.readdirSync(admin.bots), []);
    assert.deepEqual(fs.readdirSync(admin.team), []);
    assert.equal(fs.existsSync(path.join(admin.home, ".npm-global")), false);
    assert.equal(fs.readlinkSync(path.join(admin.home, ".skills")), path.join(f.skills, "agent"));
    // Every library is emptied; the admin's is there again, with nothing in it.
    assert.deepEqual(fs.readdirSync(f.skills), ["agent"]);
    assert.deepEqual(fs.readdirSync(path.join(f.skills, "agent")), []);
    // Nobody signed out: the admin's stayed, Ada's waits for her next account.
    assert.equal(fs.readFileSync(path.join(admin.codex, "auth.json"), "utf8"), "admin codex");
    assert.equal(fs.readFileSync(path.join(admin.claude, "creds.json"), "utf8"), "admin claude");
    const again = accounts.ensure({ id: "u-ada", name: "Ada", admin: false });
    assert.equal(fs.readFileSync(path.join(again.grok, "auth.json"), "utf8"), "ada grok");
    assert.equal(fs.existsSync(path.join(again.home, "notes.md")), false);
    // The stash is spent: a second account doesn't get it again.
    assert.equal(fs.existsSync(accounts.stashDir("u-ada")), false);
  } finally {
    f.cleanup();
  }
});

test("a reset with nobody else on the box still empties the admin's home", () => {
  const f = fixture();
  try {
    const accounts = f.make();
    const admin = accounts.ensure({ id: "u-admin", name: "Admin", admin: true });
    fs.writeFileSync(path.join(admin.home, "stray.txt"), "x");
    const result = accounts.reset();
    assert.deepEqual(result.accounts, []);
    assert.ok(result.removed.includes("stray.txt"));
    assert.equal(fs.existsSync(path.join(admin.home, "stray.txt")), false);
  } finally {
    f.cleanup();
  }
});

test("deleting a person takes the sign-ins a reset had kept for them", () => {
  const f = fixture();
  try {
    const accounts = f.make();
    accounts.ensure({ id: "u-admin", name: "Admin", admin: true });
    const ada = accounts.ensure({ id: "u-ada", name: "Ada", admin: false });
    fs.mkdirSync(ada.claude, { recursive: true });
    fs.writeFileSync(path.join(ada.claude, "creds.json"), "ada claude");
    accounts.reset();
    assert.ok(fs.existsSync(accounts.stashDir("u-ada")));
    // The admin deletes her from the app: nothing of hers is left behind.
    assert.equal(accounts.remove("u-ada"), false);
    assert.equal(fs.existsSync(accounts.stashDir("u-ada")), false);
    const again = accounts.ensure({ id: "u-ada", name: "Ada", admin: false });
    assert.equal(fs.existsSync(path.join(again.claude, "creds.json")), false);
  } finally {
    f.cleanup();
  }
});

test("handOver owns what is in the home and refuses a link, or a path through one, that leads out", () => {
  const f = fixture();
  try {
    const home = path.join(f.dir, "home");
    const outside = path.join(f.dir, "outside");
    fs.mkdirSync(path.join(home, ".bots"), { recursive: true });
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(home, ".cache"));
    fs.symlinkSync(f.dir, path.join(home, "up"));
    const account = { home, uid: process.getuid(), gid: process.getgid() };
    handOver(path.join(home, ".bots"), account, 0o750);
    assert.equal(fs.statSync(path.join(home, ".bots")).mode & 0o777, 0o750);
    assert.throws(() => handOver(path.join(home, ".cache"), account, 0o700), /link/);
    assert.equal(fs.statSync(outside).mode & 0o777, 0o777 & ~process.umask());
    assert.throws(() => handOver(path.join(home, "up", "outside"), account, 0o700), /outside the home/);
  } finally {
    f.cleanup();
  }
});
