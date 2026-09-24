import { z } from "zod";

/*
 * Types and schemas shared by the API and the web app. Nothing here touches
 * a database or the network, so both sides can import it freely.
 */

// ---------- bots ----------

/** Faces the Kru bot mascot can make. */
export const BOT_EXPRESSIONS = ["happy", "wink", "surprised", "sleepy", "excited"] as const;
export type BotExpression = (typeof BOT_EXPRESSIONS)[number];

/** The lineup palette: picked for dark and light surfaces alike. */
export const BOT_COLORS = ["#FF5A0F", "#3B82F6", "#EF4444", "#F59E0B", "#8B5CF6", "#EC4899", "#14B8A6", "#1DB954", "#0EA5E9", "#F97316"] as const;

/**
 * How a bot's own actions are gated. `ask` sends every permission prompt
 * Claude Code would show to you as a card; `edits` accepts file edits in the
 * bot's home and asks for the rest; `full` skips permissions.
 */
/*
 * Two levels, and neither one gates reading or a bot's own folder on the
 * computer: that folder is its desk, and a bot that has to ask to write a
 * note in it is no use. What differs is everything outside it.
 */
export const APPROVAL_LEVELS = ["ask", "full"] as const;
export type ApprovalLevel = (typeof APPROVAL_LEVELS)[number];

export const APPROVAL_LEVEL_LABELS: Record<ApprovalLevel, { title: string; detail: string }> = {
  ask: { title: "Manual", detail: "Shell commands, files outside its own folder and connected-app actions wait for you." },
  full: { title: "Always allow", detail: "Nothing asks. Only for a bot you trust with the computer and your apps." },
};

/**
 * What a bot runs on Claude Code until someone picks otherwise. An alias,
 * not a pinned id: Claude Code resolves `opus` to the newest Opus, so
 * a bot keeps up without anyone editing a list here.
 */
export const DEFAULT_MODEL = "opus";

/** Profile input limits, shared by every write surface. */
export const BOT_LIMITS = {
  name: 40,
  title: 80,
  description: 4000,
} as const;

const botFields = z.object({
  name: z.string().trim().min(1).max(BOT_LIMITS.name),
  /** The job, one line: "Chief of Staff", "Sales Outbound". */
  title: z.string().trim().max(BOT_LIMITS.title),
  /** How it should work: sources, boundaries, output format. Becomes the SOUL. */
  description: z.string().trim().max(BOT_LIMITS.description),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  expression: z.enum(BOT_EXPRESSIONS),
  approval: z.enum(APPROVAL_LEVELS),
  /** A Chief of Staff coordinates the others: it can list, brief and ask them. */
  isChief: z.boolean(),
  /** Composio toolkit slugs this bot may use, from the connected ones. */
  toolkits: z.array(z.string().trim().min(1).max(40)).max(40),
  /** Notify you (browser push) when this bot finishes or needs input. */
  notify: z.boolean(),
});
/** A whole bot, as a form or a template gives it; what's left out takes the default. */
export const botInputSchema = botFields.extend({
  title: botFields.shape.title.default(""),
  description: botFields.shape.description.default(""),
  color: botFields.shape.color.default(BOT_COLORS[0]),
  expression: botFields.shape.expression.default("happy"),
  approval: botFields.shape.approval.default("ask"),
  isChief: botFields.shape.isChief.default(false),
  toolkits: botFields.shape.toolkits.default([]),
  notify: botFields.shape.notify.default(true),
});
/**
 * A change to some of a bot's fields; the rest stay as they are. Not
 * `botInputSchema.partial()`: with zod 4 that fills every missing field
 * with its default, so pinning a bot would have made it forget its job.
 */
export const botPatchSchema = botFields.partial();
export type BotPatch = z.infer<typeof botPatchSchema>;
export type BotInput = z.infer<typeof botInputSchema>;

export type Bot = BotInput & {
  id: string;
  /** Whose bot it is. */
  userId: string;
  /** The bot's 1:1 conversation with you. */
  threadId: string;
  hidden: boolean;
  pinned: boolean;
  position: number;
  createdAt: string;
  updatedAt: string;
};

// ---------- conversations ----------

export const THREAD_KINDS = ["bot", "room"] as const;
export type ThreadKind = (typeof THREAD_KINDS)[number];

export type Thread = {
  id: string;
  /** Whose conversation it is. */
  userId: string;
  kind: ThreadKind;
  /** For a bot thread: the bot. Null for a room. */
  botId: string | null;
  name: string;
  /** Room members (bot ids); a bot thread has just its bot. */
  members: string[];
  /** Last message preview for the sidebar. */
  lastMessage: { author: string; body: string; at: string } | null;
  unread: number;
  createdAt: string;
  updatedAt: string;
};

/** Who wrote a message: you, a bot by id, a routine, or Kru Bot itself. */
export type MessageAuthor = "you" | "system" | "routine" | string;

/**
 * `secret` is a card asking you for a secret the bot needs; the value never
 * enters the chat. `prompt` is a line Kru Bot itself gives a bot to answer
 * (its first greeting); the bot answers it but nobody sees it. `signin` is
 * a card for an MCP server a bot added that wants the person to sign in
 * (`approvalId` holds the server id).
 */
export const MESSAGE_KINDS = ["message", "event", "activity", "approval", "secret", "prompt", "signin"] as const;
export type MessageKind = (typeof MESSAGE_KINDS)[number];

export type ChatAttachment = {
  id: string;
  name: string;
  mediaType: string;
  size: number;
};

export type Message = {
  id: string;
  threadId: string;
  author: MessageAuthor;
  kind: MessageKind;
  body: string;
  attachments: ChatAttachment[];
  /** Bot-to-bot hops from your message; caps chains. */
  depth: number;
  /** For an approval card: its approval id. For a secret card: the secret request's id. */
  approvalId: string | null;
  /** For a message a bot posted into another bot's thread: where it came from. */
  fromThreadId: string | null;
  /** The person sent it while the bot worked, and it went into that work (steering). */
  steered: boolean;
  createdAt: string;
};

export const MAX_ATTACHMENTS = 6;
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
/** Largest file a bot can hand the person with send_file (the box has the same limit). */
export const MAX_SENT_FILE_BYTES = 100 * 1024 * 1024;
/** A file's media type from its name, for files a bot hands over; unknown ones are plain bytes. */
export function mediaTypeFor(name: string): string {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  return FILE_TYPES[ext] ?? "application/octet-stream";
}

const FILE_TYPES: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml",
  pdf: "application/pdf", txt: "text/plain", md: "text/markdown", csv: "text/csv", json: "application/json",
  html: "text/html", htm: "text/html", css: "text/css", js: "text/javascript", xml: "application/xml",
  zip: "application/zip", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  mp3: "audio/mpeg", mp4: "video/mp4", wav: "audio/wav",
};

export const ATTACHMENT_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf", "text/plain", "text/markdown", "text/csv", "application/json"] as const;

// ---------- approvals ----------

export const APPROVAL_STATUSES = ["pending", "allowed", "denied", "expired"] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

export type Approval = {
  id: string;
  botId: string;
  threadId: string;
  /** The tool the bot wants to use: Bash, Edit, a connected-app action… */
  tool: string;
  /** What it wants to do, in one line. */
  summary: string;
  /** The tool's full input. */
  input: Record<string, unknown>;
  status: ApprovalStatus;
  /** Set when "Always allow" saved a rule. */
  rule: string | null;
  createdAt: string;
  resolvedAt: string | null;
};

export const approvalDecisionSchema = z.object({
  decision: z.enum(["allow", "deny", "always"]),
});

// ---------- routines ----------

export type Routine = {
  id: string;
  botId: string;
  name: string;
  /** Five-field cron, evaluated in `timezone`. */
  cron: string;
  timezone: string;
  /** What the bot is asked to do each time. */
  prompt: string;
  enabled: boolean;
  skillId: string | null;
  lastRunAt: string | null;
  nextRunAt: string | null;
  createdAt: string;
  updatedAt: string;
};

const routineFields = z.object({
  name: z.string().trim().min(1).max(80),
  cron: z.string().trim().min(9).max(100),
  timezone: z.string().trim().min(1).max(64),
  prompt: z.string().trim().min(1).max(4000),
  enabled: z.boolean(),
  /** A skill from the library the routine runs; the prompt then carries the inputs. */
  skillId: z.string().trim().max(40).nullable(),
});
export const routineInputSchema = routineFields.extend({
  timezone: routineFields.shape.timezone.default("UTC"),
  enabled: routineFields.shape.enabled.default(true),
  skillId: routineFields.shape.skillId.default(null),
});
/** Some of a routine's fields; see botPatchSchema for why this isn't `.partial()` of the input. */
export const routinePatchSchema = routineFields.partial();
export type RoutineInput = z.infer<typeof routineInputSchema>;

/** Presets the routine editor offers, each a cron in the person's zone. */
export const ROUTINE_PRESETS: { label: string; cron: string }[] = [
  { label: "Every weekday at 8:00", cron: "0 8 * * 1-5" },
  { label: "Every day at 8:00", cron: "0 8 * * *" },
  { label: "Every day at 18:00", cron: "0 18 * * *" },
  { label: "Every Monday at 9:00", cron: "0 9 * * 1" },
  { label: "Every hour", cron: "0 * * * *" },
  { label: "Every 15 minutes", cron: "*/15 * * * *" },
];

// ---------- board ----------

/**
 * The board: every bot's work at once, for one person. What waits on you
 * (approvals, a handoff that was reported stuck, a routine that failed),
 * what is running, what is queued, what went quiet and what finished.
 */
export const BOARD_COLUMNS = ["needs-you", "working", "waiting", "stalled", "done"] as const;
export type BoardColumn = (typeof BOARD_COLUMNS)[number];

export const BOARD_COLUMN_LABELS: Record<BoardColumn, string> = {
  "needs-you": "Needs you",
  working: "Working",
  waiting: "Waiting",
  stalled: "Stalled",
  done: "Done",
};

export type BoardItem = {
  id: string;
  kind: "approval" | "handoff" | "turn" | "run" | "upcoming";
  column: BoardColumn;
  /** The bot the item is about: the one asking, working, or handing off. */
  botId: string;
  /** For a handoff, the teammate it went to. */
  toBotId?: string;
  /** Where "Open" goes. */
  threadId: string;
  /** For a handoff, the teammate's conversation (the exchange's other side). */
  toThreadId?: string;
  title: string;
  detail?: string;
  /** When it happened or, for an upcoming routine, when it will. */
  at: string;
};

export type Board = { columns: Record<BoardColumn, BoardItem[]> };

/** A finished card you can clear off the board: anything done, or a routine that failed. Open work can't be. */
export function boardItemClearable(item: Pick<BoardItem, "kind" | "column">): boolean {
  return item.column === "done" || (item.kind === "run" && item.column === "needs-you");
}

// ---------- connected apps ----------

/**
 * An app the marketplace offers, as one Composio toolkit. The list itself
 * comes from Composio, so it is every app they support; APP_CATALOG below
 * is only the familiar few, shown before a key is set and in onboarding.
 * The logo, when set, is the image URL Composio reports for the toolkit;
 * otherwise the web app uses appLogoUrl.
 */
export type AppCatalogEntry = { toolkit: string; name: string; icon: string; category: string; logo?: string; description?: string };

/** One page of the app catalog: what /api/catalog answers with a search and a page. */
export type CatalogPage = { apps: AppCatalogEntry[]; total: number; page: number; pages: number };

/** How many apps a page of the marketplace holds. */
export const CATALOG_PAGE_SIZE = 12;

/** The app's real logo, served by Composio for every toolkit it offers. */
export function appLogoUrl(toolkit: string) {
  return `https://logos.composio.dev/api/${encodeURIComponent(toolkit)}`;
}

export const APP_CATALOG: AppCatalogEntry[] = [
  { toolkit: "gmail", name: "Gmail", icon: "gmail", category: "Email" },
  { toolkit: "googlecalendar", name: "Google Calendar", icon: "googlecalendar", category: "Calendar" },
  { toolkit: "googledrive", name: "Google Drive", icon: "googledrive", category: "Files" },
  { toolkit: "googlesheets", name: "Google Sheets", icon: "googlesheets", category: "Files" },
  { toolkit: "slack", name: "Slack", icon: "slack", category: "Chat" },
  { toolkit: "notion", name: "Notion", icon: "notion", category: "Docs" },
  { toolkit: "github", name: "GitHub", icon: "github", category: "Code" },
  { toolkit: "linear", name: "Linear", icon: "linear", category: "Work" },
  { toolkit: "jira", name: "Jira", icon: "jira", category: "Work" },
  { toolkit: "asana", name: "Asana", icon: "asana", category: "Work" },
  { toolkit: "trello", name: "Trello", icon: "trello", category: "Work" },
  { toolkit: "hubspot", name: "HubSpot", icon: "hubspot", category: "Sales" },
  { toolkit: "salesforce", name: "Salesforce", icon: "salesforce", category: "Sales" },
  { toolkit: "zoom", name: "Zoom", icon: "zoom", category: "Meetings" },
  { toolkit: "microsoft_teams", name: "Microsoft Teams", icon: "microsoftteams", category: "Chat" },
  { toolkit: "outlook", name: "Outlook", icon: "microsoftoutlook", category: "Email" },
  { toolkit: "figma", name: "Figma", icon: "figma", category: "Design" },
  { toolkit: "canva", name: "Canva", icon: "canva", category: "Design" },
  { toolkit: "linkedin", name: "LinkedIn", icon: "linkedin", category: "Social" },
  { toolkit: "twitter", name: "X", icon: "x", category: "Social" },
  { toolkit: "discord", name: "Discord", icon: "discord", category: "Chat" },
  { toolkit: "dropbox", name: "Dropbox", icon: "dropbox", category: "Files" },
  { toolkit: "stripe", name: "Stripe", icon: "stripe", category: "Finance" },
  { toolkit: "shopify", name: "Shopify", icon: "shopify", category: "Commerce" },
  { toolkit: "zendesk", name: "Zendesk", icon: "zendesk", category: "Support" },
  { toolkit: "intercom", name: "Intercom", icon: "intercom", category: "Support" },
  { toolkit: "airtable", name: "Airtable", icon: "airtable", category: "Data" },
  { toolkit: "clickup", name: "ClickUp", icon: "clickup", category: "Work" },
];

export type Connection = {
  /** Composio toolkit slug. */
  toolkit: string;
  name: string;
  /** Composio connected account id. */
  accountId: string;
  status: "active" | "pending" | "failed";
  createdAt: string;
};

/** Whether a person can connect apps: their own Composio key, the server's (the admin only), or none yet. */
export type ComposioKeyStatus = { source: "own" | "server" | null };

// ---------- people ----------

/**
 * Who can do what. The first account, made with the setup token, is the
 * admin: it owns the server-wide settings (the AI, the computer, the
 * skills, who may sign in). Everyone who arrives through the OIDC provider
 * is a user. Everyone, the admin included, has their own bots,
 * conversations, connected apps (with their own Composio key), MCP servers
 * and secrets; none of those are shared between people.
 */
export const USER_ROLES = ["admin", "user"] as const;
export type UserRole = (typeof USER_ROLES)[number];

/** How a person signs in: the local username and password, or the OIDC provider. */
export type SignInProvider = "local" | "oidc";

/** You, as /api/me tells it. */
export type Me = {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  provider: SignInProvider;
  /** The versioned URL of your picture, or null. */
  avatar: string | null;
};

/** A person, as the admin's Sign-in section lists them. */
export type UserSummary = Me & { createdAt: string; bots: number };

/**
 * The OIDC provider people sign in with (Pocket ID, Authentik, Keycloak,
 * Zitadel, anything with discovery). One provider, set up by the admin;
 * the client secret is stored encrypted and never read back.
 */
export const OIDC_PROVIDER_ID = "oidc";

/**
 * Where a sign-in with the OIDC provider in the phone apps comes back: the
 * provider's page runs in the phone's browser (a WebView can't use passkeys,
 * and many providers refuse one), and the API hands the app a one-time code
 * here. Kept in step with the intent filter in apps/android's manifest.
 */
export const MOBILE_SIGN_IN_CALLBACK = "krubot://sign-in";
/** The desktop app comes back to DESKTOP_SIGN_IN_CALLBACK, below, for the same reason. */
export const OIDC_DEFAULT_SCOPES = "openid profile email";

export type OidcSettings = {
  enabled: boolean;
  /** What the sign-in button says: "Sign in with <name>". */
  name: string;
  /** The issuer URL; discovery is at <issuer>/.well-known/openid-configuration. */
  issuer: string;
  clientId: string;
  /** Space-separated. */
  scopes: string;
  hasClientSecret: boolean;
  updatedAt: string | null;
};

export const oidcPatchSchema = z.object({
  enabled: z.boolean().optional(),
  name: z.string().trim().min(1).max(40).optional(),
  issuer: z.string().trim().url().max(500).optional(),
  clientId: z.string().trim().max(500).optional(),
  clientSecret: z.string().max(2000).optional(),
  scopes: z.string().trim().max(200).optional(),
});
export type OidcPatch = z.infer<typeof oidcPatchSchema>;

/** What the sign-in page needs, before anyone is signed in. */
export type AuthConfig = {
  /** Whether the local username and password sign-in exists (the admin account). */
  local: boolean;
  oidc: { enabled: boolean; name: string } | null;
};

// ---------- AI providers ----------

/**
 * An API the bots can run on instead of (or as well as) a plan: one
 * Anthropic-compatible and one OpenAI-compatible endpoint, each a base URL
 * and a key. The key is write-only: it is stored encrypted in the API and
 * never comes back to the web or goes to the box.
 */
export const PROVIDER_KINDS = ["anthropic", "openai", "xai"] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];

export const PROVIDER_LABELS: Record<ProviderKind, { name: string; short: string; detail: string; defaultUrl: string; keyHint: string }> = {
  anthropic: {
    name: "Anthropic-compatible API",
    short: "Anthropic",
    detail: "Anthropic, or anything that speaks its API, like MiniMax.",
    defaultUrl: "https://api.anthropic.com",
    keyHint: "sk-ant-…",
  },
  openai: {
    name: "OpenAI-compatible API",
    short: "OpenAI",
    detail: "OpenAI, OpenRouter, or any server that speaks their API.",
    defaultUrl: "https://api.openai.com/v1",
    keyHint: "sk-…",
  },
  xai: {
    name: "xAI API",
    short: "xAI",
    detail: "xAI's own API.",
    defaultUrl: "https://api.x.ai/v1",
    keyHint: "xai-…",
  },
};

/** Whether a provider speaks the OpenAI API, which decides how its key goes out and where its models are listed. */
export function isOpenAiShaped(kind: ProviderKind): boolean {
  return kind === "openai" || kind === "xai";
}

/** What the web sees of a provider: never the key. */
export type ProviderMeta = {
  kind: ProviderKind;
  baseUrl: string;
  /** The last check of the key against the provider, if one ran. */
  check: { ok: boolean; detail: string; at: string } | null;
  updatedAt: string;
};

export const providerInputSchema = z.object({
  baseUrl: z
    .string()
    .trim()
    .max(500)
    .refine((value) => /^https?:\/\/[^\s/]+/i.test(value), "The URL starts with http:// or https://"),
  /** Left out on an edit, the stored key stays. */
  apiKey: z.string().trim().min(8, "That key looks too short").max(8_000).optional(),
});
export type ProviderInput = z.infer<typeof providerInputSchema>;

// ---------- AI engines ----------

/**
 * The CLI every bot runs on, in the box: Claude Code, OpenAI's Codex or
 * xAI's Grok Build. Each one runs on the person's own plan (signed in once
 * on the computer) or on an API key (a provider above, through the API).
 */
/** The coding CLIs, which run as a session in the box on the person's own plan. */
export const CLI_ENGINES = ["claude", "codex", "grok"] as const;
export type CliEngine = (typeof CLI_ENGINES)[number];
/**
 * Every engine: the three CLIs, and `api`, where Kru Bot itself calls the
 * person's own API and hands the model the computer as tools. An API key
 * needs no CLI and no sign-in on the box, which is the whole point of it.
 */
export const ENGINES = [...CLI_ENGINES, "api"] as const;
export type Engine = (typeof ENGINES)[number];

export function isCliEngine(engine: Engine): engine is CliEngine {
  return (CLI_ENGINES as readonly string[]).includes(engine);
}
export const ENGINE_ACCESS = ["plan", "api"] as const;
export type EngineAccess = (typeof ENGINE_ACCESS)[number];

export type EngineInfo = {
  name: string;
  vendor: string;
  detail: string;
  /** What "your plan" is called for this engine. */
  plan: string;
  /** What to run in a terminal on the computer to sign in. */
  signIn: string;
  /** Where the plan's sign-in happens, for the copy on the sign-in sheet. */
  signInAt: string;
  /** The API provider an API key access goes through: the first one saved is used. */
  provider: ProviderKind;
  /** Every API this engine can run on, best first. */
  providers: readonly ProviderKind[];
  /** The model when nothing is picked; "" leaves it to the CLI. */
  defaultModel: string;
  /** A hint for the model field. */
  modelHint: string;
};

export const ENGINE_LABELS: Record<Engine, EngineInfo> = {
  claude: {
    name: "Claude Code",
    vendor: "Anthropic",
    detail: "Anthropic's coding agent. Best at long, multi-step work.",
    plan: "Your Claude plan",
    signIn: "claude",
    signInAt: "claude.com",
    provider: "anthropic",
    providers: ["anthropic"],
    defaultModel: DEFAULT_MODEL,
    modelHint: "fable, opus, sonnet, haiku, or a full model id",
  },
  codex: {
    name: "Codex",
    vendor: "OpenAI",
    detail: "OpenAI's coding agent, on a ChatGPT plan.",
    plan: "Your ChatGPT plan",
    signIn: "codex login --device-auth",
    signInAt: "auth.openai.com",
    provider: "openai",
    providers: ["openai", "xai"],
    defaultModel: "",
    modelHint: "Leave empty for Codex's default",
  },
  grok: {
    name: "Grok",
    vendor: "xAI",
    detail: "xAI's coding agent, on a Grok plan.",
    plan: "Your Grok plan",
    signIn: "grok login --device-auth",
    signInAt: "accounts.x.ai",
    provider: "xai",
    providers: ["xai", "openai"],
    defaultModel: "",
    modelHint: "Leave empty for Grok's default (grok-build)",
  },
  api: {
    name: "API",
    vendor: "your API",
    detail: "Kru Bot calls your key itself. Nothing to sign in to; your bots still have the computer. MCP servers need a CLI.",
    plan: "Your API key",
    signIn: "",
    signInAt: "",
    provider: "anthropic",
    providers: ["anthropic", "openai", "xai"],
    defaultModel: "",
    modelHint: "claude-sonnet-5, gpt-5.1, grok-4, MiniMax-M2…",
  },
};

/** One model a person can pick, as `/api/models` returns it. */
export type ModelChoice = { id: string; name?: string; detail?: string; default?: boolean };

/**
 * The models one engine offers, and where the list came from: the CLI
 * itself (`codex model/list`, `grok models`, Claude Code's aliases), the
 * API key's own list, or nothing, when whatever was asked couldn't
 * answer. A model id can always be typed in instead.
 */
export type ModelGroup = {
  engine: Engine;
  models: ModelChoice[];
  source: "engine" | "provider" | "none";
  detail: string | null;
};

/** What `/api/models` answers: one group per engine the person has turned on. */
export type ModelList = { groups: ModelGroup[] };

/**
 * How one engine runs: on the plan or an API key, on which model ("" is
 * the CLI's own default), and, when it runs on a key, which of the
 * person's APIs that key is.
 */
export type EngineSettings = { access: EngineAccess; model: string; provider?: ProviderKind | null };

/** Model ids are plain tokens; a provider's may carry a slash or a colon. Empty is the CLI's default. */
export const MODEL_ID_PATTERN = /^[A-Za-z0-9._:/-]{0,120}$/;

export const DEFAULT_ENGINES: Record<Engine, EngineSettings> = {
  claude: { access: "plan", model: DEFAULT_MODEL },
  codex: { access: "plan", model: "" },
  grok: { access: "plan", model: "" },
  // Calling an API is only ever that: there is no plan to fall back to.
  api: { access: "api", model: "", provider: null },
};

// ---------- settings & onboarding ----------

export type Onboarding = {
  done: boolean;
  /** Toolkits picked in "What do you use every day?". */
  apps: string[];
  /** Templates picked in "Meet your first teammates". */
  templates: string[];
};

/** What the whole team shares: the setup and the time zone. */
export type Settings = {
  onboarding: Onboarding;
  timezone: string;
};

/**
 * What one person's bots run on (Settings → AI, everyone's own): the
 * engine, and for each one their plan or their API key with the model.
 * A plan is the CLI signed in inside their own account on the computer;
 * an API key is one of their own providers. Nobody runs on anyone else's.
 */
export type AiSettings = {
  /** The engine this person's bots run on right now; always one of `enabled`. */
  engine: Engine;
  /**
   * The engines they have turned on. More than one is normal: sign in to
   * Claude Code and add an API key, and the models of both are there to
   * pick from.
   */
  enabled: Engine[];
  /** For each engine: their plan or an API key, and the model. */
  engines: Record<Engine, EngineSettings>;
};

export const DEFAULT_AI: AiSettings = { engine: "claude", enabled: ["claude"], engines: DEFAULT_ENGINES };

/**
 * What a person's bots used (Usage, behind their picture). Tokens are what
 * the engines reported; cost is summed only from the turns that reported
 * one, and is null when none did. On a plan it is what the same work would
 * have cost on the API, not a bill.
 */
export type UsageTotals = { turns: number; input: number; output: number; cachedInput: number; cost: number | null };
export type UsageDay = UsageTotals & { day: string };
export type UsageBot = UsageTotals & { botId: string; name: string; color: string | null };
export type UsageModel = UsageTotals & { engine: string; model: string };
export type UsageSummary = { days: number; timezone: string; totals: UsageTotals; daily: UsageDay[]; bots: UsageBot[]; models: UsageModel[] };
export const USAGE_RANGES = [7, 30, 90] as const;

/** Whether Codex or Grok is installed on the box and signed in to a plan. */
export type EngineStatus = { installed: boolean; loggedIn: boolean; detail: string };

/**
 * A sign-in the computer is driving for one person: it runs the CLI's own
 * login there and hands back only what the person needs to finish it in a
 * browser. `waiting` means the link is ready; Claude Code then wants the
 * code from that page pasted back (`needsCode`), while Codex and Grok wait
 * for the approval themselves.
 */
export const ENGINE_SIGN_IN_STATES = ["starting", "waiting", "finishing", "done", "failed"] as const;
export type EngineSignInState = (typeof ENGINE_SIGN_IN_STATES)[number];
export type EngineSignIn = {
  engine: Engine;
  state: EngineSignInState;
  /** Where the person signs in, once the CLI has printed it. */
  url: string | null;
  /** Codex and Grok: the one-time code to enter on that page. */
  code: string | null;
  /** Claude Code: the page hands back a code to paste here. */
  needsCode: boolean;
  /** The CLI's last line when it failed; short, never its whole output. */
  error: string | null;
  startedAt: string;
};

export type ClaudeStatus = {
  status: "ok" | "missing" | "unauthenticated" | "error" | "no-box";
  detail: string;
  email?: string | null;
};

/**
 * The computer as one person sees it: whether it is up, their own sign-ins
 * on it (each person has their own account there), and, for the admin,
 * every live session and what is installed.
 */
export type BoxStatus = {
  configured: boolean;
  reachable: boolean;
  /** True while Settings → Computer → Update is running: nothing starts on the box. */
  updating: boolean;
  /** Claude Code's sign-in in this person's account. */
  claude: ClaudeStatus;
  /** Codex and Grok on the box, signed in for this person or not; null when the box didn't answer. */
  engines: { codex: EngineStatus; grok: EngineStatus } | null;
  composio: { configured: boolean; connected: number };
  /** Live sessions: everyone's for the admin, only their own for anyone else. */
  agents: { id: string; running: boolean; busy: boolean }[];
  /** What runs on the box, when it answered. */
  versions: { node: string | null; bun: string | null; claude: string | null; codex?: string | null; grok?: string | null } | null;
};

/** The steps of Settings → Computer → Update, in order. */
export type BoxUpdatePhase = "idle" | "pausing" | "pulling" | "restarting" | "resetting" | "patching" | "resuming" | "done" | "failed";

export const BOX_UPDATE_PHASE_LABELS: Record<BoxUpdatePhase, string> = {
  idle: "Up to date as far as we know",
  pausing: "Pausing the computer",
  pulling: "Pulling the newest image",
  restarting: "Restarting on the new image",
  resetting: "Wiping the computer and rebuilding it",
  patching: "Patching Debian, Bun, Claude Code, Codex and Grok",
  resuming: "Bringing the computer back",
  done: "Updated",
  failed: "Update failed",
};

export type BoxUpdate = {
  phase: BoxUpdatePhase;
  startedAt: string | null;
  finishedAt: string | null;
  log: string[];
  error: string | null;
  /** A newer image was pulled and the box recreated on it. */
  pulled: boolean;
  /** The in-place patch finished cleanly. */
  patched: boolean;
  /** What this run is: an update, or a reset. */
  kind: "update" | "reset";
};

// ---------- work log ----------

/**
 * One thing a bot did while it worked, behind its activity line: a command
 * it ran and what that printed, a file it read or changed, a tool it
 * called, or what it said on the way. Kept by the API only while the turn
 * runs; every field is redacted like the line itself.
 */
export type WorkStep = {
  id: string;
  kind: "command" | "file" | "tool" | "note";
  /** The one line the activity line showed for it. */
  title: string;
  /** The whole command, or the tool's input, when the title cut it short. */
  detail: string | null;
  /** What it printed or answered, cut at WORK_OUTPUT_MAX. */
  output: string | null;
  status: "running" | "done" | "failed";
  at: string;
};

/** Longest output a work step keeps; the rest is cut. */
export const WORK_OUTPUT_MAX = 8_000;
/** Steps kept per bot and turn; the oldest go first. */
export const WORK_STEPS_MAX = 200;

// ---------- live events ----------

export type LiveEvent =
  /** A bot, a room or their order changed: fetch the sidebar again. */
  | { topic: "bots" }
  /** A message landed on a thread, or (cleared) every message was removed. */
  | { topic: "thread"; threadId: string; cleared?: true }
  /** A bot's live activity while it works: the line, or null when the turn ended. */
  | { topic: "activity"; threadId: string; botId: string; line: string | null }
  /** A step of a bot's work began or finished: the step as it now stands (see WorkStep). */
  | { topic: "work"; threadId: string; botId: string; step: WorkStep }
  /** Approvals changed. */
  | { topic: "approvals" }
  /** Routines or connections changed. */
  | { topic: "settings" }
  /** The computer's update moved a step. */
  | { topic: "box" }
  /** Your own profile (name, picture) changed. */
  | { topic: "me"; userId: string }
  /** Your AI settings or API keys changed. */
  | { topic: "ai"; userId: string }
  /** Your skills library changed. */
  | { topic: "skills"; userId: string }
  /** A handoff or a routine run of yours moved: fetch the board again. */
  | { topic: "board"; userId: string }
  /**
   * A bot finished a job for you or needs you: what the API just sent as a
   * push notification, for a client without Web Push (the Android app)
   * to show on its own. Quiet when that conversation is in front of you.
   */
  | { topic: "notify"; userId: string; title: string; body: string; url: string; tag: string; threadId: string };

// ---------- skills ----------

/**
 * A skill is a reusable way of doing one job: the steps, the decision
 * rules, what the result looks like, and what to check with the person
 * first. It is a folder, like any agent skill: SKILL.md (a name, a
 * description and the instructions) and whatever else the job needs next
 * to it, scripts, references, templates, assets. Each person has their own
 * library, shared by all of their bots and nobody else's. Type / in a
 * message to hand one to a bot; a routine can run one on a schedule; a
 * .skill file (the folder zipped) moves one in or out.
 */
export const SKILL_LIMITS = {
  name: 60,
  slug: 40,
  description: 1024,
  instructions: 60_000,
  /** Files next to SKILL.md. */
  files: 200,
  path: 200,
  fileBytes: 5 * 1024 * 1024,
  totalBytes: 20 * 1024 * 1024,
} as const;

const skillFields = z.object({
  name: z.string().trim().min(1).max(SKILL_LIMITS.name),
  /** What it does and when to use it, shown in the / menu. */
  description: z.string().trim().max(SKILL_LIMITS.description),
  /** Markdown: steps, rules, expected output, safety boundaries. */
  instructions: z.string().trim().min(1).max(SKILL_LIMITS.instructions),
});
export const skillInputSchema = skillFields.extend({ description: skillFields.shape.description.default("") });
/** Some of a skill's fields; see botPatchSchema for why this isn't `.partial()` of the input. */
export const skillPatchSchema = skillFields.partial();
export type SkillInput = z.infer<typeof skillInputSchema>;

/** One file of a skill besides SKILL.md, without its bytes. */
export type SkillFile = {
  /** Inside the skill's folder, like scripts/fill.py or references/api.md. */
  path: string;
  size: number;
  /** Runs on its own (a #! line, or marked so in a .skill). */
  executable: boolean;
  /** Readable as text, so the editor can open it. */
  text: boolean;
};

export type Skill = SkillInput & {
  id: string;
  /** How the skill is referenced in a message: /morning-briefing. */
  slug: string;
  /** Where it came from: written by you, saved by a bot, installed from the marketplace, or imported from a .skill. */
  source: "written" | "bot" | "packaged" | "imported";
  /** Everything in the folder besides SKILL.md. */
  files: SkillFile[];
  createdAt: string;
  updatedAt: string;
};

/**
 * A path inside a skill's folder, cleaned: forward slashes, no leading
 * slash, no `.` or `..`, no hidden parts, and never SKILL.md itself.
 * Null when it can't be one.
 */
export function skillFilePath(given: string): string | null {
  const parts = given.replace(/\\/g, "/").split("/").filter((part) => part && part !== ".");
  if (!parts.length || parts.some((part) => part === ".." || part.startsWith(".") || /[\u0000-\u001f]/.test(part))) return null;
  const clean = parts.join("/");
  if (clean.length > SKILL_LIMITS.path || clean === "SKILL.md") return null;
  return clean;
}

/** A slug from a name: lowercase, dashes, ASCII. */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SKILL_LIMITS.slug) || "skill";
}

/** Skill slugs a message refers to, as /slug tokens. */
export function skillMentions(text: string): string[] {
  const out = new Set<string>();
  for (const match of text.matchAll(/(?:^|\s)\/([a-z0-9][a-z0-9-]{0,39})\b/g)) out.add(match[1]!);
  return [...out];
}

/** Skills the marketplace offers, installable with one click and editable after. */
export const PACKAGED_SKILLS: { id: string; name: string; description: string; instructions: string }[] = [
  {
    id: "morning-briefing",
    name: "Morning briefing",
    description: "What changed overnight and what needs the person today, in one short note.",
    instructions: [
      "# Morning briefing",
      "",
      "Goal: one short note the person reads with their first coffee.",
      "",
      "Steps:",
      "1. Gather what changed since yesterday: the inbox and calendar if you have them, the team's open handoffs, anything a routine left for you.",
      "2. Sort by what needs the person today, what is waiting on someone else, and what is just news.",
      "3. Write at most eight lines. Lead with decisions and deadlines. Link to the source of each item.",
      "",
      "Rules:",
      "- Never send anything on the person's behalf; this is a read-only job.",
      "- If nothing changed, say so in one line.",
      "- Note anything you could not reach (an app that failed, an expired session).",
    ].join("\n"),
  },
  {
    id: "inbox-triage",
    name: "Inbox triage",
    description: "Sort new mail into needs-reply, waiting, FYI and noise, with draft replies for the first group.",
    instructions: [
      "# Inbox triage",
      "",
      "Goal: the person opens their inbox knowing what matters and finds drafts ready where a reply is due.",
      "",
      "Steps:",
      "1. Read unread mail from the last 24 hours (or since the last run).",
      "2. Label each thread: needs a reply, waiting on someone else, FYI, or noise. Newsletters and notifications are noise unless the person asked otherwise.",
      "3. For needs-a-reply, write a draft in the person's voice and save it as a draft; never send.",
      "4. Report: a table of needs-a-reply with the draft's first line, then counts for the rest.",
      "",
      "Rules:",
      "- Sending, archiving or deleting mail waits for approval.",
      "- Keep drafts short; a question deserves an answer, not an essay.",
    ].join("\n"),
  },
  {
    id: "bug-repro-pack",
    name: "Bug repro pack",
    description: "Turn a bug report into a reproduction: steps, environment, evidence, and a suggested cause.",
    instructions: [
      "# Bug repro pack",
      "",
      "Goal: an engineer can start fixing without asking a question.",
      "",
      "Steps:",
      "1. Read the report and pull out the expected and actual behaviour.",
      "2. Reproduce it on the computer: clone the repo if there is one, run the app, follow the steps. Save screenshots and console output in your home under repro/<ticket>/.",
      "3. Narrow it: the smallest input that still fails, the first version or commit where it fails if you can bisect quickly.",
      "4. Write the pack: title, steps, environment, evidence (paths to files), suspected cause with file and line, and what you tried.",
      "",
      "Rules:",
      "- Filing the ticket or commenting on it waits for approval.",
      "- Say clearly when you could not reproduce it, and what you tried.",
    ].join("\n"),
  },
  {
    id: "weekly-expense-summary",
    name: "Weekly expense summary",
    description: "Match receipts to charges, flag the unmatched, and nudge owners.",
    instructions: [
      "# Weekly expense summary",
      "",
      "Goal: by Monday morning, every charge of the week has a receipt or an owner who was asked for one.",
      "",
      "Steps:",
      "1. Pull the week's charges from the connected source (a sheet, an export, or mail from the card provider).",
      "2. Match each to a receipt by amount, merchant and date. Keep a list of the unmatched.",
      "3. For each unmatched charge, draft a one-line nudge to its owner. Sending waits for approval.",
      "4. Report: totals by category, the unmatched list, and who was nudged.",
      "",
      "Rules:",
      "- Never guess an owner; leave it unmatched and say so.",
      "- Round to whole units in the summary; keep exact amounts in the sheet.",
    ].join("\n"),
  },
  {
    id: "meeting-prep",
    name: "Meeting prep",
    description: "A one-page brief before a meeting: who, why, what happened last time, and what to ask.",
    instructions: [
      "# Meeting prep",
      "",
      "Goal: a page the person reads in two minutes on the way in.",
      "",
      "Steps:",
      "1. From the calendar entry, find the people, the company and the stated purpose.",
      "2. Search mail, notes and the CRM (whatever you have) for the last three interactions.",
      "3. Write: attendees with one line each, the purpose, what happened last time, open items, and three questions worth asking.",
      "",
      "Rules:",
      "- Read-only. Never message attendees.",
      "- Mark anything you inferred rather than read.",
    ].join("\n"),
  },
];

// ---------- MCP servers ----------

/**
 * Your own MCP servers, attached to every bot's Claude Code session next
 * to Kru's bridge. An HTTP server is reached through the API, which adds
 * its headers (secrets included) on the way, so the bots never hold them.
 * A stdio server runs on the box itself; its command line and environment
 * are visible there, so don't put secrets in them.
 */
export const MCP_TRANSPORTS = ["http", "stdio"] as const;
export type McpTransport = (typeof MCP_TRANSPORTS)[number];

export const mcpServerInputSchema = z.object({
  name: z.string().trim().min(1).max(40).regex(/^[a-z0-9][a-z0-9_-]*$/i, "Letters, digits, dashes and underscores"),
  transport: z.enum(MCP_TRANSPORTS),
  /** http: the server's URL. */
  url: z.string().trim().url().max(500).optional(),
  /** http: headers sent with every request; a value may hold {{secret:NAME}}. */
  headers: z.record(z.string().max(100), z.string().max(4000)).default({}),
  /** stdio: what the box runs. */
  command: z.string().trim().max(500).optional(),
  args: z.array(z.string().max(500)).max(50).default([]),
  env: z.record(z.string().max(100), z.string().max(4000)).default({}),
  enabled: z.boolean().default(true),
  /** http: where the sign-in sends the browser back; left out, the default for its host. */
  oauthRedirect: z.enum(["app", "localhost"]).optional(),
});
export type McpServerInput = z.infer<typeof mcpServerInputSchema>;

/**
 * A bot is given one of your MCP servers by listing `mcp:<server id>` in its
 * toolkits, next to the Composio toolkits it may use.
 */
export function mcpToolkit(serverId: string): string {
  return `mcp:${serverId}`;
}

/**
 * A command line to its words, the way a shell quotes them: "…" and '…'
 * keep spaces, a backslash escapes the next character (inside '…' it is
 * literal). Nothing is expanded.
 */
export function splitCommandLine(text: string): string[] {
  const words: string[] = [];
  let word = "";
  let started = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quote) {
      if (c === quote) quote = null;
      else if (c === "\\" && quote === '"' && i + 1 < text.length) word += text[++i];
      else word += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      started = true;
    } else if (c === "\\" && i + 1 < text.length) {
      word += text[++i];
      started = true;
    } else if (/\s/.test(c)) {
      if (started) words.push(word);
      word = "";
      started = false;
    } else {
      word += c;
      started = true;
    }
  }
  if (started) words.push(word);
  return words;
}

/** Words back to a command line that `splitCommandLine` reads the same. */
export function joinCommandLine(words: string[]): string {
  return words.map((w) => (w && !/[\s"'\\]/.test(w) ? w : `'${w.replaceAll("'", `'\\''`)}'`)).join(" ");
}

/**
 * A `signin` card names what it signs in to: an MCP server by its id, or a
 * connected app as `composio:<toolkit>`. The card asks the API for a fresh
 * Connect Link when the person taps it, so nothing expires in the message.
 */
export const COMPOSIO_CARD = "composio:";

export function composioCard(toolkit: string): string {
  return `${COMPOSIO_CARD}${toolkit}`;
}

export function composioCardToolkit(id: string | null | undefined): string | null {
  return id?.startsWith(COMPOSIO_CARD) ? id.slice(COMPOSIO_CARD.length) : null;
}

/**
 * Where an OAuth sign-in returns. `app`: this Kru Bot's own address.
 * `localhost`: MCP_LOOPBACK_CALLBACK, for providers that only let local
 * tools and a few partners sign in (Robinhood's Trading MCP). The desktop
 * app listens there and finishes the sign-in; in a browser the person
 * pastes the address the page landed on.
 */
export const MCP_OAUTH_REDIRECTS = ["app", "localhost"] as const;
export type McpOAuthRedirect = (typeof MCP_OAUTH_REDIRECTS)[number];
/** Kept in step with LOOPBACK_PORT in apps/desktop/src/main.mjs. */
export const MCP_LOOPBACK_PORT = 47651;
export const MCP_LOOPBACK_CALLBACK = `http://localhost:${MCP_LOOPBACK_PORT}/callback`;
/**
 * Where a sign-in with the OIDC provider in the desktop app comes back. Its
 * window can't go to the provider itself (that would sign the default
 * browser in and leave the app waiting), so the provider's page runs in that
 * browser and the API hands the app its one-time code on the loopback it is
 * already listening on, the way MOBILE_SIGN_IN_CALLBACK does for the phones.
 */
export const DESKTOP_SIGN_IN_CALLBACK = `http://localhost:${MCP_LOOPBACK_PORT}/sign-in`;
/** Hosts known to refuse a self-hosted address and take localhost. */
const LOOPBACK_HOSTS = ["agent.robinhood.com"];

export function defaultOAuthRedirect(url: string | undefined): McpOAuthRedirect {
  try {
    return url && LOOPBACK_HOSTS.includes(new URL(url).hostname) ? "localhost" : "app";
  } catch {
    return "app";
  }
}

/**
 * Whether an HTTP server wants you signed in (the MCP authorization flow:
 * OAuth with discovery and dynamic client registration, as Robinhood's or
 * Linear's servers use). `none`: no sign-in needed. `needed`: it answered
 * 401 and Settings has a Sign in button. `signed_in`: tokens are held by
 * the API and added to every request.
 */
export type McpAuthStatus = "none" | "needed" | "signed_in" | "error";

export type McpServer = McpServerInput & {
  id: string;
  oauthRedirect: McpOAuthRedirect;
  authStatus: McpAuthStatus;
  /** What went wrong the last time sign-in was tried, when it did. */
  authError: string | null;
  createdAt: string;
  updatedAt: string;
};

/** The placeholder a header or env value uses to name a stored secret. */
export const SECRET_REF = /\{\{\s*secret:([A-Za-z][A-Za-z0-9_]{0,63})\s*\}\}/g;

// ---------- secrets ----------

/**
 * Secrets the bots can use but never see: an API key for one of your MCP
 * servers, a token a connector needs. Stored encrypted by the API. A bot
 * asks with a card in the conversation; you type the value into a masked
 * field; the API injects it where it's needed. Passwords, one-time codes
 * and payments are different: for those, take over the computer and type
 * them yourself.
 */
export const SECRET_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

export type SecretMeta = {
  name: string;
  /** Who asked for it, when a bot did. */
  requestedBy: string | null;
  createdAt: string;
  updatedAt: string;
};

export type SecretRequest = {
  id: string;
  botId: string;
  threadId: string;
  name: string;
  reason: string;
  /**
   * Where the value goes when the person types it in: the secret store, or
   * the person's own Composio project key. Either way it is encrypted by
   * the API at once and no bot ever sees it.
   */
  target: "secret" | "composio";
  status: "pending" | "given" | "declined" | "expired";
  createdAt: string;
  resolvedAt: string | null;
};

// ---------- notifications ----------

/** A browser's push subscription, as the Push API hands it over. */
export type PushSubscriptionInput = {
  endpoint: string;
  keys: { p256dh: string; auth: string };
};

// ---------- templates ----------

/**
 * Teammates the person can add with one click, from onboarding or the
 * sidebar. Written to be safe by default: read, draft, hold for approval.
 */
export type BotTemplate = {
  id: string;
  name: string;
  title: string;
  tagline: string;
  color: string;
  expression: BotExpression;
  description: string;
  toolkits: string[];
  isChief?: boolean;
  routine?: { name: string; cron: string; prompt: string };
};

export const BOT_TEMPLATES: BotTemplate[] = [
  {
    id: "chief-of-staff",
    name: "Chief of Staff",
    title: "Chief of Staff",
    tagline: "Your always-on assistant. Reads what changed and what needs you, and briefs the others.",
    color: "#8B5CF6",
    expression: "wink",
    isChief: true,
    toolkits: ["slack", "gmail", "googlecalendar"],
    description:
      "Own the outcome of what the person asks. Scan the connected channels, inbox, calendar and notes for what is new and what maps to their priorities; for each item give the source, why it matters, the proposed next step, and whether they owe a decision. Coordinate the other bots when a job fits one of them, and return one consolidated answer. Never send messages or change meetings without approval.",
    routine: { name: "Morning briefing", cron: "0 8 * * 1-5", prompt: "Review activity since yesterday across my connected channels, inbox and calendar. Return only items that map to my priorities, each with the source, why it matters, the proposed next step, and whether I owe a decision." },
  },
  {
    id: "sales-outbound",
    name: "Sales Outbound",
    title: "Sales Outbound",
    tagline: "Researches accounts overnight, drafts outreach in your voice, and leaves a review list.",
    color: "#FF5A0F",
    expression: "happy",
    toolkits: ["hubspot", "gmail", "linkedin"],
    description:
      "Own account research, contact prioritisation and review-ready outreach. Score accounts against the ideal customer profile and recent intent, find up to three relevant contacts per account, and draft email and LinkedIn outreach in the person's voice. Skip anyone already in an active sequence. Always return a review list; never send or enrol anyone yourself.",
  },
  {
    id: "inbox-manager",
    name: "Inbox Manager",
    title: "Inbox Manager",
    tagline: "Triages email into clear categories, surfaces what's urgent, drafts replies.",
    color: "#3B82F6",
    expression: "surprised",
    toolkits: ["gmail"],
    description:
      "Keep the inbox usable. Triage new mail into categories, surface urgent and blocked threads, and draft replies and clean-up. Every send stays behind approval. Report what changed in a few lines, newest first.",
    routine: { name: "Inbox triage", cron: "0 9,13,17 * * 1-5", prompt: "Triage everything new in the inbox since the last run. List urgent and blocked threads first, then drafts waiting for my approval." },
  },
  {
    id: "talent-scout",
    name: "Talent Scout",
    title: "Talent Scout",
    tagline: "Sources candidates, drafts outreach, preps scheduling.",
    color: "#14B8A6",
    expression: "excited",
    toolkits: ["linkedin", "gmail", "googlecalendar"],
    description:
      "Own sourcing, candidate research, outreach drafts and scheduling preparation. For a role, find candidates who meet the must-have criteria, explain the evidence for each match, and draft personalised outreach in the person's voice. Never contact anyone without approval. Respect candidate privacy and source terms.",
  },
  {
    id: "expense-manager",
    name: "Expense Manager",
    title: "Expense Manager",
    tagline: "Builds the weekly expense summary, matches receipts, nudges owners.",
    color: "#F59E0B",
    expression: "sleepy",
    toolkits: ["gmail", "googlesheets", "googledrive"],
    description:
      "Own weekly expense reconciliation and missing-information follow-up. Build the week's summary, match receipts from the inbox, flag missing categories or policy exceptions with a policy citation, and draft one follow-up per owner. Return the summary and drafts; never send messages or change reimbursements.",
    routine: { name: "Weekly expense summary", cron: "0 9 * * 1", prompt: "Build last week's expense summary: totals that reconcile, receipts matched, exceptions with policy citations, and one follow-up draft per owner." },
  },
  {
    id: "bug-reproduction",
    name: "Bug Reproduction",
    title: "Bug Reproduction",
    tagline: "Turns reports into repro packs: steps, screenshots, console notes.",
    color: "#EF4444",
    expression: "surprised",
    toolkits: ["github", "linear"],
    description:
      "Turn bug reports into reliable reproduction packs. Read the report, reproduce it in a staging environment or a fresh clone in your home folder, and return exact steps, expected and actual behaviour, screenshots, environment details, relevant console or network notes, and a minimal test case when possible. Never use production customer data.",
  },
  {
    id: "product-performance",
    name: "Product Performance",
    title: "Product Performance",
    tagline: "Investigates performance questions with evidence and links.",
    color: "#0EA5E9",
    expression: "happy",
    toolkits: ["github", "slack"],
    description:
      "Investigate product-performance questions using the connected observability and source tools. Preserve links and screenshots, separate evidence from hypotheses, and return a short write-up with the highest-impact issue first. Never change alerts or production settings.",
  },
  {
    id: "account-health",
    name: "Account Health",
    title: "Account Health",
    tagline: "Turns portfolio noise into a ranked watch list before the QBR.",
    color: "#EC4899",
    expression: "wink",
    toolkits: ["hubspot", "zendesk", "slack"],
    description:
      "Review the accounts in the portfolio. Combine usage, support escalations, renewal timing and stakeholder activity into a ranked watch list; for each account include the evidence, why it matters, and a suggested next step. Never contact customers or edit the CRM without approval.",
  },
];

/** A friendly name for a new bot, avoiding ones already in use. */
export const BOT_NAMES = [
  "Scout", "Pixel", "Atlas", "Nova", "Juno", "Koda", "Miso", "Mochi", "Biscuit", "Pepper", "Clover", "Ember",
  "Willow", "Comet", "Orbit", "Echo", "Indigo", "Sage", "Zephyr", "Poppy", "Maple", "Cosmo", "Luna", "Otto",
  "Ivy", "Finch", "Wren", "Basil", "Hazel", "Nimbus", "Onyx", "Pearl", "Quill", "Rocket", "Sunny", "Tango",
  "Vega", "Waffle", "Ziggy", "Noodle", "Pickle", "Churro", "Panko", "Dumpling", "Pesto", "Olive", "Cocoa", "Taffy",
] as const;

export function pickBotName(taken: Iterable<string>, random = Math.random): string {
  const used = new Set([...taken].map((n) => n.trim().toLowerCase()));
  const free = BOT_NAMES.filter((n) => !used.has(n.toLowerCase()));
  if (free.length > 0) return free[Math.floor(random() * free.length)]!;
  const base = BOT_NAMES[Math.floor(random() * BOT_NAMES.length)]!;
  for (let i = 2; ; i += 1) {
    if (!used.has(`${base.toLowerCase()} ${i}`)) return `${base} ${i}`;
  }
}

/** `@name` mentions in a message, lowercased, in order, unique. */
export const MENTION = /(?<![\w@])@([a-z0-9][a-z0-9_-]{0,39})/gi;

export function mentionsIn(text: string): string[] {
  const seen = new Set<string>();
  for (const match of text.matchAll(MENTION)) seen.add(match[1]!.toLowerCase());
  return [...seen];
}

/** The mention handle for a bot: its name without spaces, lowercased. */
export function handleOf(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9_-]+/g, "");
}
