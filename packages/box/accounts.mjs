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
    /** Where a reset keeps each person's CLI sign-ins until their next account. */
    this.loginsDir = path.join(stateDir, "logins");
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
    /** Where ~/.skills points: the person's own library mirror, root's and readable only by them. */
    account.library = this.skillsRoot ? path.join(this.skillsRoot, account.name) : null;
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
      this.restoreLogins(account);
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
    // A reset kept this person's CLI sign-ins; their new home gets them back.
    this.restoreLogins(account);
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
   * ~/.skills is a link to the person's own library, a folder of skill
   * folders the API writes (SKILL.md, scripts, references…). It is root's,
   * so a bot can't change a skill behind the API's back, and only the
   * person's group can read it, so nobody sees anyone else's. A home from
   * before has a real folder or a link to the old shared library there:
   * it goes (the API writes every skill again) and the link takes its place.
   */
  linkSkills(account) {
    if (!account.library) return;
    this.makeLibrary(account);
    let stat = null;
    try {
      stat = fs.lstatSync(account.skills);
    } catch {
      /* nothing there */
    }
    if (stat?.isSymbolicLink()) {
      if (fs.readlinkSync(account.skills) === account.library) return;
      fs.unlinkSync(account.skills);
    } else if (stat?.isDirectory()) {
      // Never copied into the library: anyone can make this folder. The API writes the real skills back.
      fs.rmSync(account.skills, { recursive: true, force: true });
    } else if (stat) {
      fs.rmSync(account.skills, { force: true });
    }
    fs.symlinkSync(account.library, account.skills);
  }

  /** The person's library folder: root's, their group may read it, nobody else. */
  makeLibrary(account) {
    fs.mkdirSync(this.skillsRoot, { recursive: true, mode: 0o755 });
    fs.mkdirSync(account.library, { recursive: true, mode: 0o750 });
    if (this.root && account.gid !== undefined) {
      fs.chownSync(account.library, 0, account.gid);
      fs.chmodSync(account.library, 0o750);
    }
    return account.library;
  }

  /**
   * The shared library from before skills were each person's: skill
   * folders straight under the root. They go; the API writes everyone's
   * own library again.
   */
  clearLegacySkills() {
    if (!this.skillsRoot) return;
    let entries = [];
    try {
      entries = fs.readdirSync(this.skillsRoot);
    } catch {
      return;
    }
    for (const entry of entries) {
      const dir = path.join(this.skillsRoot, entry);
      if (fs.existsSync(path.join(dir, "SKILL.md"))) fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  /** Makes a folder for the account, owned by it. */
  own(dir, account, mode = 0o755) {
    fs.mkdirSync(dir, { recursive: true, mode });
    if (account.uid === undefined) return;
    try {
      handOver(dir, account, mode);
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
   * and sign-ins included. The admin's is never removed. With
   * `keepLogins`, the CLI sign-ins are set aside first (see `stash`) and
   * the next account for that person gets them back.
   */
  remove(id, { keepLogins = false } = {}) {
    // A person who is really gone takes their kept sign-ins with them,
    // even if a reset set them aside before their account was deleted.
    if (!keepLogins) fs.rmSync(this.stashDir(id), { recursive: true, force: true });
    const record = this.records.get(id);
    if (!record) return false;
    if (record.admin) throw new Error("The admin's account can't be removed");
    const account = this.describe(id, record);
    if (keepLogins) this.stashLogins(account);
    this.records.delete(id);
    this.save();
    if (this.root && linuxUserExists(account.name)) {
      const result = run("userdel", ["--remove", account.name]);
      if (!result.ok) this.log(`userdel ${account.name}: ${result.output.slice(0, 200)}`);
      run("groupdel", [account.name]);
    }
    fs.rmSync(account.home, { recursive: true, force: true });
    if (account.library) fs.rmSync(account.library, { recursive: true, force: true });
    this.log(`removed account ${account.name} for ${id}`);
    return true;
  }

  /**
   * The box as it was the day it was built: every person's account goes,
   * the Linux user and the home with it, and the admin's home is emptied
   * (its bots' files, the team's memory, the packages and dotfiles the
   * bots set up, all of it). The registry keeps only the admin, so
   * everyone else's account is made again, empty, the next time the API
   * asks for it.
   *
   * The one thing carried over is each person's CLI sign-ins: they are
   * kept in the state folder and put back in the new home. Without that,
   * a reset would sign everybody out of their own plan.
   */
  reset({ keepLogins = true } = {}) {
    const people = [];
    for (const [id, record] of [...this.records]) {
      if (record.admin) continue;
      const name = this.records.get(id)?.name ?? id;
      this.remove(id, { keepLogins });
      people.push(name);
    }
    const admin = this.admin() ?? this.agentAccount();
    const removed = this.wipeHome(admin, { keepLogins });
    this.clearSkills();
    this.materialize(admin);
    return { removed, accounts: people };
  }

  /**
   * Empties a home: everything in it goes but the CLI sign-ins, which are
   * kept where they are when `keepLogins`. A folder that is a mounted
   * volume (the admin's `.bots` and `.cache` are) can't be removed, only
   * emptied. Returns what was taken out.
   */
  wipeHome(account, { keepLogins = true } = {}) {
    const keep = new Set(keepLogins ? account.logins.map((dir) => path.resolve(dir)) : []);
    const removed = [];
    let entries = [];
    try {
      entries = fs.readdirSync(account.home);
    } catch {
      return removed;
    }
    for (const entry of entries) {
      const full = path.join(account.home, entry);
      if (keep.has(path.resolve(full))) continue;
      try {
        fs.rmSync(full, { recursive: true, force: true });
      } catch {
        for (const inner of fs.readdirSync(full)) fs.rmSync(path.join(full, inner), { recursive: true, force: true });
      }
      removed.push(entry);
    }
    return removed;
  }

  /** Every person's skills library mirror, emptied; the API writes them again from its own copy. */
  clearSkills() {
    if (!this.skillsRoot) return;
    try {
      for (const entry of fs.readdirSync(this.skillsRoot)) fs.rmSync(path.join(this.skillsRoot, entry), { recursive: true, force: true });
    } catch {
      /* no mirror yet */
    }
  }

  /** Where a person's sign-ins wait between their old account and their next one. */
  stashDir(id) {
    return path.join(this.loginsDir, encodeURIComponent(id));
  }

  /**
   * Moves a person's CLI sign-ins out of their home, before the home goes.
   * Only what is there is kept, and a stash from an earlier reset is
   * replaced, so the newest sign-in wins.
   */
  stashLogins(account) {
    if (!account.id) return;
    const target = this.stashDir(account.id);
    fs.rmSync(target, { recursive: true, force: true });
    let any = false;
    for (const [engine, dir] of Object.entries(this.loginDirs(account))) {
      if (!fs.existsSync(dir) || fs.readdirSync(dir).length === 0) continue;
      if (!any) fs.mkdirSync(target, { recursive: true, mode: 0o700 });
      moveInto(dir, path.join(target, engine));
      any = true;
    }
    if (any) this.log(`kept the sign-ins of ${account.name}`);
  }

  /**
   * Puts a person's kept sign-ins back into their new home, owned by their
   * new user. A folder the new account already has is left alone: what is
   * in the home now is newer than what was set aside.
   */
  restoreLogins(account) {
    if (!account.id) return;
    const stash = this.stashDir(account.id);
    if (!fs.existsSync(stash)) return;
    for (const [engine, dir] of Object.entries(this.loginDirs(account))) {
      const kept = path.join(stash, engine);
      if (!fs.existsSync(kept)) continue;
      if (fs.existsSync(dir) && fs.readdirSync(dir).length > 0) continue;
      fs.rmSync(dir, { recursive: true, force: true });
      moveInto(kept, dir);
      this.chownTree(dir, account);
    }
    fs.rmSync(stash, { recursive: true, force: true });
    this.log(`gave ${account.name} its sign-ins back`);
  }

  /** The CLIs' sign-in folders by engine, so a stash survives a home moving. */
  loginDirs(account) {
    return { claude: account.claude, codex: account.codex, grok: account.grok };
  }

  /** A restored folder and everything in it belongs to the account it landed in. */
  chownTree(dir, account) {
    if (account.uid === undefined) return;
    const walk = (current) => {
      try {
        fs.lchownSync(current, account.uid, account.gid);
      } catch (error) {
        this.log(`could not own ${current}: ${error.message}`);
        return;
      }
      let entries = [];
      try {
        entries = fs.readdirSync(current, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory() && !entry.isSymbolicLink()) walk(full);
        else {
          try {
            fs.lchownSync(full, account.uid, account.gid);
          } catch {
            /* a file that went while we walked */
          }
        }
      }
    };
    walk(dir);
  }
}

/**
 * Gives a path in a home to its account, as root, without following links.
 * The home is its owner's to rearrange, so `.cache` may be a link to /etc
 * by the time root gets there: the path is opened without following its
 * last part, what was really opened is checked to be inside the home, and
 * the owner and mode are set on that open file, never on a name that could
 * have been swapped since.
 */
export function handOver(target, account, mode = null) {
  const { O_RDONLY, O_NOFOLLOW, O_NONBLOCK } = fs.constants;
  let fd;
  try {
    fd = fs.openSync(target, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
  } catch (error) {
    if (error.code === "ELOOP") throw new Error(`${target} is a link; left alone`);
    throw error;
  }
  try {
    const opened = openedPath(fd, target);
    const home = fs.realpathSync(account.home);
    if (opened !== home && !opened.startsWith(home + path.sep)) throw new Error(`${target} leads outside the home; left alone`);
    fs.fchownSync(fd, account.uid, account.gid);
    if (mode !== null) fs.fchmodSync(fd, mode);
  } finally {
    fs.closeSync(fd);
  }
}

/** Where an open file really is: the kernel's answer on Linux, the resolved name elsewhere. */
export function openedPath(fd, fallback) {
  try {
    return fs.readlinkSync(`/proc/self/fd/${fd}`);
  } catch {
    return fs.realpathSync(fallback);
  }
}

/** Moves a folder, across devices too (a volume is its own). */
function moveInto(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  try {
    fs.renameSync(from, to);
    return;
  } catch {
    fs.cpSync(from, to, { recursive: true, preserveTimestamps: true });
    fs.rmSync(from, { recursive: true, force: true });
  }
}
