import type { Database } from "bun:sqlite";

/**
 * Kru Bot's schema, one entry per version. Tables use a `kru_` prefix so
 * they never collide with Better Auth's. Never edit a shipped entry; add a
 * new one.
 */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE kru_bots (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    voice TEXT NOT NULL DEFAULT '',
    color TEXT NOT NULL,
    expression TEXT NOT NULL DEFAULT 'happy',
    tilt REAL NOT NULL DEFAULT 0,
    model TEXT NOT NULL,
    effort TEXT,
    approval TEXT NOT NULL DEFAULT 'ask' CHECK (approval IN ('ask', 'edits', 'full')),
    is_chief INTEGER NOT NULL DEFAULT 0,
    toolkits TEXT NOT NULL DEFAULT '[]',
    thread_id TEXT NOT NULL,
    hidden INTEGER NOT NULL DEFAULT 0,
    pinned INTEGER NOT NULL DEFAULT 0,
    position INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE kru_threads (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('bot', 'room')),
    bot_id TEXT,
    name TEXT NOT NULL DEFAULT '',
    last_read_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE kru_thread_members (
    thread_id TEXT NOT NULL REFERENCES kru_threads (id) ON DELETE CASCADE,
    bot_id TEXT NOT NULL,
    PRIMARY KEY (thread_id, bot_id)
  );

  CREATE TABLE kru_messages (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL REFERENCES kru_threads (id) ON DELETE CASCADE,
    author TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'message' CHECK (kind IN ('message', 'event', 'activity', 'approval')),
    body TEXT NOT NULL DEFAULT '',
    attachments TEXT NOT NULL DEFAULT '[]',
    depth INTEGER NOT NULL DEFAULT 0,
    approval_id TEXT,
    from_thread_id TEXT,
    -- Which process is answering this message, and when it was answered.
    claimed_by TEXT,
    answered_at TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX kru_messages_thread ON kru_messages (thread_id, created_at);
  CREATE INDEX kru_messages_pending ON kru_messages (answered_at) WHERE answered_at IS NULL AND author IN ('you', 'routine');

  CREATE TABLE kru_attachments (
    id TEXT PRIMARY KEY,
    message_id TEXT,
    name TEXT NOT NULL,
    media_type TEXT NOT NULL,
    size INTEGER NOT NULL,
    data BLOB NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE kru_approvals (
    id TEXT PRIMARY KEY,
    bot_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    tool TEXT NOT NULL,
    summary TEXT NOT NULL,
    input TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'allowed', 'denied', 'expired')),
    rule TEXT,
    created_at TEXT NOT NULL,
    resolved_at TEXT
  );
  CREATE INDEX kru_approvals_pending ON kru_approvals (status, created_at);

  -- "Always allow" rules: a tool (and optionally a command prefix) a bot may
  -- use without asking again.
  CREATE TABLE kru_approval_rules (
    id TEXT PRIMARY KEY,
    bot_id TEXT NOT NULL,
    rule TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (bot_id, rule)
  );

  CREATE TABLE kru_routines (
    id TEXT PRIMARY KEY,
    bot_id TEXT NOT NULL,
    name TEXT NOT NULL,
    cron TEXT NOT NULL,
    timezone TEXT NOT NULL DEFAULT 'UTC',
    prompt TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    last_run_at TEXT,
    next_run_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE kru_routine_runs (
    id TEXT PRIMARY KEY,
    routine_id TEXT NOT NULL REFERENCES kru_routines (id) ON DELETE CASCADE,
    message_id TEXT,
    status TEXT NOT NULL DEFAULT 'started',
    started_at TEXT NOT NULL,
    finished_at TEXT
  );

  CREATE TABLE kru_connections (
    toolkit TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    account_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL
  );

  CREATE TABLE kru_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    onboarding TEXT NOT NULL DEFAULT '{"done":false,"apps":[],"templates":[]}',
    concurrency INTEGER,
    timezone TEXT NOT NULL DEFAULT 'UTC',
    updated_at TEXT NOT NULL
  );

  -- Bot-to-bot handoffs: which thread a delegated task reports back to.
  CREATE TABLE kru_delegations (
    id TEXT PRIMARY KEY,
    from_bot_id TEXT NOT NULL,
    from_thread_id TEXT NOT NULL,
    to_bot_id TEXT NOT NULL,
    to_thread_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    brief TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    result TEXT,
    created_at TEXT NOT NULL,
    finished_at TEXT
  );
  `,
  // The model and effort every bot uses, chosen once under Settings.
  `
  ALTER TABLE kru_settings ADD COLUMN model TEXT;
  ALTER TABLE kru_settings ADD COLUMN effort TEXT;
  `,
  // Your profile picture: one row, the image itself, shown in the sidebar and on your messages.
  `
  CREATE TABLE kru_avatar (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    media_type TEXT NOT NULL,
    data BLOB NOT NULL,
    updated_at TEXT NOT NULL
  );
  `,
  // Skills (one library for every bot), your MCP servers, secrets the bots
  // use but never see, browser push subscriptions, per-bot notifications,
  // routines that run a skill, and the nudges a stalled handoff gets.
  `
  CREATE TABLE kru_skills (
    id TEXT PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    instructions TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'written',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE kru_mcp_servers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    transport TEXT NOT NULL CHECK (transport IN ('http', 'stdio')),
    url TEXT,
    headers TEXT NOT NULL DEFAULT '{}',
    command TEXT,
    args TEXT NOT NULL DEFAULT '[]',
    env TEXT NOT NULL DEFAULT '{}',
    enabled INTEGER NOT NULL DEFAULT 1,
    proxy_token TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE kru_secrets (
    name TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    requested_by TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE kru_secret_requests (
    id TEXT PRIMARY KEY,
    bot_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    name TEXT NOT NULL,
    reason TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL,
    resolved_at TEXT
  );

  CREATE TABLE kru_push_subscriptions (
    endpoint TEXT PRIMARY KEY,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    user_agent TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );

  ALTER TABLE kru_bots ADD COLUMN notify INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE kru_routines ADD COLUMN skill_id TEXT;
  ALTER TABLE kru_delegations ADD COLUMN nudged_at TEXT;
  ALTER TABLE kru_delegations ADD COLUMN escalated_at TEXT;
  `,
  // OAuth for HTTP MCP servers: the registered client and its tokens, encrypted, and where sign-in stands.
  `
  ALTER TABLE kru_mcp_servers ADD COLUMN oauth TEXT;
  ALTER TABLE kru_mcp_servers ADD COLUMN auth_status TEXT NOT NULL DEFAULT 'none';
  ALTER TABLE kru_mcp_servers ADD COLUMN auth_error TEXT;
  `,
  // Two more message kinds: a secret request card and a hidden prompt (the
  // greeting a new bot answers). SQLite can't widen a CHECK, so the table is
  // rebuilt; nothing references it by foreign key.
  `
  CREATE TABLE kru_messages_next (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL REFERENCES kru_threads (id) ON DELETE CASCADE,
    author TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'message' CHECK (kind IN ('message', 'event', 'activity', 'approval', 'secret', 'prompt')),
    body TEXT NOT NULL DEFAULT '',
    attachments TEXT NOT NULL DEFAULT '[]',
    depth INTEGER NOT NULL DEFAULT 0,
    approval_id TEXT,
    from_thread_id TEXT,
    claimed_by TEXT,
    answered_at TEXT,
    created_at TEXT NOT NULL
  );
  INSERT INTO kru_messages_next SELECT id, thread_id, author, kind, body, attachments, depth, approval_id, from_thread_id, claimed_by, answered_at, created_at FROM kru_messages;
  DROP TABLE kru_messages;
  ALTER TABLE kru_messages_next RENAME TO kru_messages;
  CREATE INDEX kru_messages_thread ON kru_messages (thread_id, created_at);
  CREATE INDEX kru_messages_pending ON kru_messages (answered_at) WHERE answered_at IS NULL AND author IN ('you', 'routine');
  `,
  // The AI the bots run on: which CLI (engine) and, per engine, your plan or
  // an API provider. Provider keys are encrypted like secrets; the box only
  // ever gets the proxy URL and its token.
  `
  CREATE TABLE kru_providers (
    kind TEXT PRIMARY KEY,
    base_url TEXT NOT NULL,
    api_key TEXT NOT NULL,
    proxy_token TEXT NOT NULL,
    last_check TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  ALTER TABLE kru_settings ADD COLUMN engine TEXT;
  ALTER TABLE kru_settings ADD COLUMN engines TEXT;
  `,
  // A sign-in card: a bot added an MCP server that wants the person to sign
  // in (approval_id holds the server id). The CHECK widens by a rebuild.
  `
  CREATE TABLE kru_messages_next (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL REFERENCES kru_threads (id) ON DELETE CASCADE,
    author TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'message' CHECK (kind IN ('message', 'event', 'activity', 'approval', 'secret', 'prompt', 'signin')),
    body TEXT NOT NULL DEFAULT '',
    attachments TEXT NOT NULL DEFAULT '[]',
    depth INTEGER NOT NULL DEFAULT 0,
    approval_id TEXT,
    from_thread_id TEXT,
    claimed_by TEXT,
    answered_at TEXT,
    created_at TEXT NOT NULL
  );
  INSERT INTO kru_messages_next SELECT id, thread_id, author, kind, body, attachments, depth, approval_id, from_thread_id, claimed_by, answered_at, created_at FROM kru_messages;
  DROP TABLE kru_messages;
  ALTER TABLE kru_messages_next RENAME TO kru_messages;
  CREATE INDEX kru_messages_thread ON kru_messages (thread_id, created_at);
  CREATE INDEX kru_messages_pending ON kru_messages (answered_at) WHERE answered_at IS NULL AND author IN ('you', 'routine');
  `,
  // Where an MCP server's sign-in returns: this app, or localhost for providers that only allow local tools.
  `
  ALTER TABLE kru_mcp_servers ADD COLUMN oauth_redirect TEXT NOT NULL DEFAULT 'app';
  UPDATE kru_mcp_servers SET oauth_redirect = 'localhost' WHERE url LIKE 'https://agent.robinhood.com/%';
  `,
  // MCP servers are given to bots one by one (mcp:<id> in a bot's toolkits); the ones that exist stay with every bot.
  `
  UPDATE kru_bots SET toolkits = (
    SELECT json_group_array(value) FROM (
      SELECT value FROM json_each(kru_bots.toolkits)
      UNION SELECT 'mcp:' || id FROM kru_mcp_servers
    )
  );
  `,
  // More than one person. Bots, conversations and push subscriptions belong
  // to a user (the ones from before belong to the admin; auth.ts fills the
  // column in once it knows who that is). A connected app or an MCP server
  // is the admin's unless shared with everyone. Pictures are per user. The
  // OIDC provider people sign in with lives in the settings row.
  `
  ALTER TABLE kru_bots ADD COLUMN user_id TEXT;
  ALTER TABLE kru_threads ADD COLUMN user_id TEXT;
  ALTER TABLE kru_push_subscriptions ADD COLUMN user_id TEXT;
  CREATE INDEX kru_bots_user ON kru_bots (user_id);
  CREATE INDEX kru_threads_user ON kru_threads (user_id);
  ALTER TABLE kru_connections ADD COLUMN shared INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE kru_mcp_servers ADD COLUMN shared INTEGER NOT NULL DEFAULT 0;
  CREATE TABLE kru_user_avatars (
    user_id TEXT PRIMARY KEY,
    media_type TEXT NOT NULL,
    data BLOB NOT NULL,
    updated_at TEXT NOT NULL
  );
  ALTER TABLE kru_settings ADD COLUMN oidc TEXT;
  `,
];

export function runMigrations(db: Database) {
  db.exec("CREATE TABLE IF NOT EXISTS kru_schema (version INTEGER NOT NULL)");
  const row = db.query("SELECT MAX(version) AS v FROM kru_schema").get() as { v: number | null } | null;
  let version = row?.v ?? 0;
  while (version < MIGRATIONS.length) {
    const sql = MIGRATIONS[version]!;
    db.transaction(() => {
      db.exec(sql);
      db.query("INSERT INTO kru_schema (version) VALUES (?)").run(version + 1);
    })();
    version += 1;
  }
  return version;
}
