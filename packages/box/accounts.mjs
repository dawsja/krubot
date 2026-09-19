/**
 * One Linux account per person on the box. The admin is the `agent` user
 * the box always had, with its home and volumes; everyone else (the people
 * who sign in through the OIDC provider) gets a user of their own, made
 * here with useradd, and a private home under HOMES_DIR. A person's bots,
 * terminals and desktop run as that user, in that home, so nobody's bots
 * can read anyone else's files or borrow their CLI sign-ins.
 *
 * The registry (STATE_DIR/accounts.json) maps a Kru user id to the Linux
 * name, uid and desktop slot. It is what survives a container recreate:
 * /etc/passwd does not, but the homes on their volume keep their uids, so
 * at start every account is made again with the same numbers.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** Uids for people, above the agent's (1001) and clear of the image's own. */
export const FIRST_UID = 2001;
/** Every made-up Linux name starts with this, so a listing reads clearly. */
export const NAME_PREFIX = "kru-";
/** Linux names are 32 characters at most. */
const MAX_NAME = 32;
export const USER_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * A Linux name for a person: kru- and the letters of their name (or their
 * email's local part), lower case, plus a number when that is taken.
 */
export function accountName(person, taken = new Set()) {
  const source = [person?.name, String(person?.email ?? "").split("@")[0], person?.id].find((value) => typeof value === "string" && /[a-z0-9]/i.test(value)) ?? "person";
  let slug = source
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_NAME - NAME_PREFIX.length - 3)
    .replace(/-+$/g, "");
  if (!/^[a-z]/.test(slug)) slug = `p${slug}`;
  const base = `${NAME_PREFIX}${slug}`;
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** The lowest free uid at or above FIRST_UID. */
export function nextUid(used) {
  let uid = FIRST_UID;
  while (used.has(uid)) uid += 1;
  return uid;
}

/** The lowest free desktop slot above the agent's (0). */
export function nextSlot(used) {
  let slot = 1;
  while (used.has(slot)) slot += 1;
  return slot;
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 30_000 });
  return { ok: result.status === 0, output: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim() };
}

/** Whether a Linux user exists, by name. */
function linuxUserExists(name) {
  return run("id", ["-u", name]).ok;
}

export class Accounts {
  /**
   * @param {{
   *   stateDir: string; homesDir: string; root: boolean; skillsRoot?: string | null;
   *   agent: { name: string; uid: number; gid: number; home: string; dirs?: Partial<Record<string, string>> };
   *   log?: (text: string) => void;
   * }} options
   */
  constructor({ stateDir, homesDir, root, skillsRoot = null, agent, log = () => undefined }) {
    this.file = path.join(stateDir, "accounts.json");
    this.homesDir = homesDir;
    this.root = root;
    this.skillsRoot = skillsRoot;
    this.agent = agent;
    this.log = log;
    /** @type {Map<string, { name: string; uid: number; slot: number; admin: boolean }>} */
    this.records = new Map();
    this.load();
  }

  load() {
    try {
      const data = JSON.parse(fs.readFileSync(this.file, "utf8"));
      for (const [id, record] of Object.entries(data?.accounts ?? {})) {
        if (!USER_ID.test(id) || !record || typeof record.name !== "string") continue;
        this.records.set(id, { name: record.name, uid: Number(record.uid) || this.agent.uid, slot: Number(record.slot) || 0, admin: Boolean(record.admin) });
      }
    } catch {
      /* no registry yet */
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const accounts = Object.fromEntries([...this.records].map(([id, record]) => [id, record]));
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify({ version: 1, accounts }, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  /** The account as the rest of the box uses it: who to run as, where, and its private folders. */
  describe(id, record) {
    if (record.admin) {
      const home = this.agent.home;
      const dirs = this.agent.dirs ?? {};
      return this.withDirs({ id, name: this.agent.name, uid: this.agent.uid, gid: this.agent.gid, home, slot: 0, admin: true }, dirs);
    }
    const home = path.join(this.homesDir, record.name);
    // Without root every account shares this process's user; the homes still keep the work apart.
    const ids = this.root ? { uid: record.uid, gid: record.uid } : { uid: undefined, gid: undefined };
    return this.withDirs({ id, name: record.name, home, slot: record.slot, admin: false, ...ids }, {});
  }

  withDirs(account, dirs) {
    const home = account.home;
    account.bots = dirs.bots ?? path.join(home, ".bots");
    account.team = dirs.team ?? path.join(home, ".team");
    account.skills = dirs.skills ?? path.join(home, ".skills");
    account.cache = dirs.cache ?? path.join(home, ".cache");
    account.claude = dirs.claude ?? path.join(home, ".claude");
    account.codex = dirs.codex ?? path.join(home, ".codex");
    account.grok = dirs.grok ?? path.join(home, ".grok");
    account.run = dirs.run ?? path.join(home, ".run");
    /** Never readable through the files API. */
    account.logins = [account.claude, account.codex, account.grok];
    return account;
  }

  get(id) {
    const record = this.records.get(id);
    return record ? this.describe(id, record) : null;
  }

  list() {
    return [...this.records.keys()].map((id) => this.get(id));
  }

  /** The agent as an account with no person behind it: for the box's own checks and the reset. */
  agentAccount() {
    return this.describe(null, { name: this.agent.name, uid: this.agent.uid, slot: 0, admin: true });
  }

  /** The admin's account, when it has been named; the agent's folders are its own either way. */
  admin() {
    for (const [id, record] of this.records) if (record.admin) return this.describe(id, record);
    return null;
  }

  /**
   * Makes sure a person has an account: the admin is the agent, anyone
   * else gets a new Linux user and home. Idempotent, so the API can call it
   * before any work.
   */
  ensure(person) {
    if (!person || !USER_ID.test(person.id ?? "")) throw new Error("Bad user id");
    const existing = this.records.get(person.id);
    if (existing) {
      if (existing.admin !== Boolean(person.admin)) throw new Error("That account's role changed; the box can't move a home between users");
      const account = this.describe(person.id, existing);
      this.materialize(account);
      return account;
    }
    if (person.admin) {
      for (const record of this.records.values()) if (record.admin) throw new Error("The box already has an admin account");
      this.records.set(person.id, { name: this.agent.name, uid: this.agent.uid, slot: 0, admin: true });
    } else {
      const names = new Set([this.agent.name, ...[...this.records.values()].map((r) => r.name)]);
      const uids = new Set([this.agent.uid, ...[...this.records.values()].map((r) => r.uid)]);
      const slots = new Set([...this.records.values()].map((r) => r.slot));
      this.records.set(person.id, { name: accountName(person, names), uid: nextUid(uids), slot: nextSlot(slots), admin: false });
    }
    this.save();
    const account = this.describe(person.id, this.records.get(person.id));
    this.materialize(account);
    this.log(`account ${account.name} (uid ${account.uid ?? "-"}) for ${person.id}`);
    return account;
  }

  /** The Linux user and the home's private folders, made or repaired. */
  materialize(account) {
    // The homes' parent is everyone's to pass through, like /home; only each home inside is private.
    if (!account.admin) fs.mkdirSync(this.homesDir, { recursive: true, mode: 0o755 });
    if (!account.admin && this.root) {
      if (!linuxUserExists(account.name)) {
        const group = run("groupadd", ["--gid", String(account.gid), account.name]);
        if (!group.ok && !/already exists/.test(group.output)) throw new Error(`groupadd failed: ${group.output.slice(0, 200)}`);
        const flag = fs.existsSync(account.home) ? "-M" : "-m";
        const user = run("useradd", [flag, "--uid", String(account.uid), "--gid", String(account.gid), "--home-dir", account.home, "--shell", "/bin/bash", account.name]);
        if (!user.ok && !/already exists/.test(user.output)) throw new Error(`useradd failed: ${user.output.slice(0, 200)}`);
      }
    }
    this.own(account.home, account, 0o700);
    for (const dir of [account.bots, account.team, account.cache, account.codex, account.grok, account.run]) this.own(dir, account);
    this.linkSkills(account);
  }

  /**
   * ~/.skills is a link to the one library. A home from before the library
   * was shared has a real folder there: its skills move into the library
   * (the API rewrites them anyway) and the link takes its place.
   */
  linkSkills(account) {
    if (!this.skillsRoot) return;
    fs.mkdirSync(this.skillsRoot, { recursive: true, mode: 0o755 });
    let stat = null;
    try {
      stat = fs.lstatSync(account.skills);
    } catch {
      /* nothing there */
    }
    if (stat?.isSymbolicLink()) {
      if (fs.readlinkSync(account.skills) === this.skillsRoot) return;
      fs.unlinkSync(account.skills);
    } else if (stat?.isDirectory()) {
      for (const entry of fs.readdirSync(account.skills)) {
        const target = path.join(this.skillsRoot, entry);
        if (!fs.existsSync(target)) fs.cpSync(path.join(account.skills, entry), target, { recursive: true });
      }
      fs.rmSync(account.skills, { recursive: true, force: true });
    } else if (stat) {
      fs.rmSync(account.skills, { force: true });
    }
    fs.symlinkSync(this.skillsRoot, account.skills);
  }

  /** Makes a folder for the account, owned by it. */
  own(dir, account, mode = 0o755) {
    fs.mkdirSync(dir, { recursive: true, mode });
    if (account.uid === undefined) return;
    try {
      fs.chownSync(dir, account.uid, account.gid);
      fs.chmodSync(dir, mode);
    } catch (error) {
      this.log(`could not own ${dir}: ${error.message}`);
    }
  }

  /** At start: every known account exists again, since the container may be new. */
  restore() {
    for (const account of this.list()) {
      try {
        this.materialize(account);
      } catch (error) {
        this.log(`could not restore ${account.name}: ${error.message}`);
      }
    }
  }

  /**
   * Removes a person's account: the Linux user and the whole home, bots
   * and sign-ins included. The admin's is never removed.
   */
  remove(id) {
    const record = this.records.get(id);
    if (!record) return false;
    if (record.admin) throw new Error("The admin's account can't be removed");
    const account = this.describe(id, record);
    this.records.delete(id);
    this.save();
    if (this.root && linuxUserExists(account.name)) {
      const result = run("userdel", ["--remove", account.name]);
      if (!result.ok) this.log(`userdel ${account.name}: ${result.output.slice(0, 200)}`);
      run("groupdel", [account.name]);
    }
    fs.rmSync(account.home, { recursive: true, force: true });
    this.log(`removed account ${account.name} for ${id}`);
    return true;
  }
}
