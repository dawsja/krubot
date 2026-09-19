import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Accounts, FIRST_UID, accountName, nextSlot, nextUid } from "../accounts.mjs";

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
    assert.equal(fs.readlinkSync(path.join(ada.home, ".skills")), f.skills);
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

test("a home's old skills folder becomes the shared link, and removing an account removes the home", () => {
  const f = fixture();
  try {
    const accounts = f.make();
    fs.mkdirSync(path.join(f.agentHome, ".skills", "hello"), { recursive: true });
    fs.writeFileSync(path.join(f.agentHome, ".skills", "hello", "SKILL.md"), "hi");
    accounts.materialize(accounts.agentAccount());
    assert.equal(fs.readlinkSync(path.join(f.agentHome, ".skills")), f.skills);
    assert.equal(fs.readFileSync(path.join(f.skills, "hello", "SKILL.md"), "utf8"), "hi");
    const ada = accounts.ensure({ id: "u-ada", name: "Ada", admin: false });
    fs.writeFileSync(path.join(ada.home, "notes.md"), "mine");
    assert.equal(accounts.remove("u-ada"), true);
    assert.equal(fs.existsSync(ada.home), false);
    assert.equal(accounts.get("u-ada"), null);
    assert.equal(accounts.remove("u-ada"), false);
    accounts.ensure({ id: "u-admin", name: "Admin", admin: true });
    assert.throws(() => accounts.remove("u-admin"), /admin/);
  } finally {
    f.cleanup();
  }
});
