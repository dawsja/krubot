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
export const APPROVAL_LEVELS = ["ask", "edits", "full"] as const;
export type ApprovalLevel = (typeof APPROVAL_LEVELS)[number];

export const APPROVAL_LEVEL_LABELS: Record<ApprovalLevel, { title: string; detail: string }> = {
  ask: { title: "Ask for approval", detail: "Shell commands, file changes and connected-app actions wait for you." },
  edits: { title: "Auto-accept edits", detail: "File edits in the bot's own home go ahead; everything else asks." },
  full: { title: "Full access", detail: "Nothing asks. Only for a bot you trust with its computer and apps." },
};

/** The Claude models the CLI can run, under the person's own plan. */
export const CLAUDE_CODE_MODELS = ["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5"] as const;
export type ClaudeCodeModel = (typeof CLAUDE_CODE_MODELS)[number];
export const DEFAULT_MODEL: ClaudeCodeModel = CLAUDE_CODE_MODELS[1];
export const MODEL_LABELS: Record<ClaudeCodeModel, { name: string; detail: string }> = {
  "claude-opus-5": { name: "Claude Opus 5", detail: "The most capable. Best for long, multi-step jobs." },
  "claude-sonnet-5": { name: "Claude Sonnet 5", detail: "Fast and capable. The default for every bot." },
  "claude-haiku-4-5": { name: "Claude Haiku 4.5", detail: "Quickest and cheapest. Good for triage and routines." },
};

export const EFFORT_LEVELS = ["low", "medium", "high"] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];
/** The effort slider's stops, left to right; null is the CLI's own default. */
export const EFFORT_STOPS: { value: EffortLevel | null; label: string; detail: string }[] = [
  { value: null, label: "Default", detail: "The CLI decides." },
  { value: "low", label: "Low", detail: "Quick answers, less thinking." },
  { value: "medium", label: "Medium", detail: "Balanced." },
  { value: "high", label: "High", detail: "Thinks longest. Best for hard, multi-step work." },
];

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
  createdAt: string;
};

export const MAX_ATTACHMENTS = 6;
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
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

// ---------- connected apps ----------

/**
 * The apps the onboarding step and the marketplace offer, mapped to the
 * Composio toolkit that provides them. The logo, when set, is the image URL
 * Composio reports for the toolkit; otherwise the web app uses appLogoUrl.
 */
export type AppCatalogEntry = { toolkit: string; name: string; icon: string; category: string; logo?: string };

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
  /** Whether every user's bots may use it, or only the admin's. */
  shared: boolean;
  createdAt: string;
};

// ---------- people ----------

/**
 * Who can do what. The first account, made with the setup token, is the
 * admin: it owns the server-wide settings (the AI, the computer, the apps,
 * the skills, the secrets, who may sign in). Everyone who arrives through
 * the OIDC provider is a user: their own bots and conversations, nothing
 * else. Bots are never shared between people.
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
export const PROVIDER_KINDS = ["anthropic", "openai"] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];

export const PROVIDER_LABELS: Record<ProviderKind, { name: string; detail: string; defaultUrl: string; keyHint: string }> = {
  anthropic: {
    name: "Anthropic-compatible API",
    detail: "Anthropic, or anything that speaks its Messages API. Claude Code uses it.",
    defaultUrl: "https://api.anthropic.com",
    keyHint: "sk-ant-…",
  },
  openai: {
    name: "OpenAI-compatible API",
    detail: "OpenAI, xAI, OpenRouter or any server that speaks the OpenAI API. Codex and Grok use it.",
    defaultUrl: "https://api.openai.com/v1",
    keyHint: "sk-…",
  },
};

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
export const ENGINES = ["claude", "codex", "grok"] as const;
export type Engine = (typeof ENGINES)[number];
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
  /** The API provider an API key access goes through. */
  provider: ProviderKind;
  /** The model when nothing is picked; "" leaves it to the CLI. */
  defaultModel: string;
  /** A hint for the model field. */
  modelHint: string;
};

export const ENGINE_LABELS: Record<Engine, EngineInfo> = {
  claude: {
    name: "Claude Code",
    vendor: "Anthropic",
    detail: "Anthropic's coding agent. The most capable at long, multi-step work.",
    plan: "Your Claude plan",
    signIn: "claude",
    provider: "anthropic",
    defaultModel: DEFAULT_MODEL,
    modelHint: "claude-sonnet-5",
  },
  codex: {
    name: "Codex",
    vendor: "OpenAI",
    detail: "OpenAI's coding agent. Runs on a ChatGPT plan or an API that speaks OpenAI's Responses API.",
    plan: "Your ChatGPT plan",
    signIn: "codex login --device-auth",
    provider: "openai",
    defaultModel: "",
    modelHint: "Leave empty for Codex's default",
  },
  grok: {
    name: "Grok",
    vendor: "xAI",
    detail: "xAI's Grok Build agent. Runs on a Grok plan or an API key, xAI's or any OpenAI-compatible one.",
    plan: "Your Grok plan",
    signIn: "grok login --device-auth",
    provider: "openai",
    defaultModel: "",
    modelHint: "Leave empty for Grok's default (grok-build)",
  },
};

/** How one engine runs: on the plan or an API key, and on which model ("" is the CLI's default). */
export type EngineSettings = { access: EngineAccess; model: string };

/** Model ids are plain tokens; a provider's may carry a slash or a colon. Empty is the CLI's default. */
export const MODEL_ID_PATTERN = /^[A-Za-z0-9._:/-]{0,120}$/;

export const DEFAULT_ENGINES: Record<Engine, EngineSettings> = {
  claude: { access: "plan", model: DEFAULT_MODEL },
  codex: { access: "plan", model: "" },
  grok: { access: "plan", model: "" },
};

// ---------- settings & onboarding ----------

export type Onboarding = {
  done: boolean;
  /** Toolkits picked in "What do you use every day?". */
  apps: string[];
  /** Templates picked in "Meet your first teammates". */
  templates: string[];
};

export type Settings = {
  onboarding: Onboarding;
  concurrency: number;
  timezone: string;
  /** The CLI every bot runs on. One for the whole team. */
  engine: Engine;
  /** For each engine: your plan or an API key, and the model. */
  engines: Record<Engine, EngineSettings>;
  /** How hard the CLI thinks per reply; null is the CLI's default. */
  effort: EffortLevel | null;
};

/** Whether Codex or Grok is installed on the box and signed in to a plan. */
export type EngineStatus = { installed: boolean; loggedIn: boolean; detail: string };

export type ClaudeStatus = {
  status: "ok" | "missing" | "unauthenticated" | "error" | "no-box";
  detail: string;
  email?: string | null;
};

export type BoxStatus = {
  configured: boolean;
  reachable: boolean;
  /** True while Settings → Computer → Update is running: nothing starts on the box. */
  updating: boolean;
  claude: ClaudeStatus;
  /** Codex and Grok on the box; null when the box didn't answer. */
  engines: { codex: EngineStatus; grok: EngineStatus } | null;
  composio: { configured: boolean; connected: number };
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

// ---------- live events ----------

export type LiveEvent =
  /** A bot, a room or their order changed: fetch the sidebar again. */
  | { topic: "bots" }
  /** A message landed on a thread, or (cleared) every message was removed. */
  | { topic: "thread"; threadId: string; cleared?: true }
  /** A bot's live activity while it works: the line, or null when the turn ended. */
  | { topic: "activity"; threadId: string; botId: string; line: string | null }
  /** Approvals changed. */
  | { topic: "approvals" }
  /** Routines or connections changed. */
  | { topic: "settings" }
  /** The computer's update moved a step. */
  | { topic: "box" }
  /** Your own profile (name, picture) changed. */
  | { topic: "me"; userId: string }
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
 * first. Skills live in one library every bot shares. Type / in a message
 * to hand one to a bot; a routine can run one on a schedule.
 */
export const SKILL_LIMITS = { name: 60, slug: 40, description: 200, instructions: 20_000 } as const;

const skillFields = z.object({
  name: z.string().trim().min(1).max(SKILL_LIMITS.name),
  /** What it does, one line, shown in the / menu. */
  description: z.string().trim().max(SKILL_LIMITS.description),
  /** Markdown: steps, rules, expected output, safety boundaries. */
  instructions: z.string().trim().min(1).max(SKILL_LIMITS.instructions),
});
export const skillInputSchema = skillFields.extend({ description: skillFields.shape.description.default("") });
/** Some of a skill's fields; see botPatchSchema for why this isn't `.partial()` of the input. */
export const skillPatchSchema = skillFields.partial();
export type SkillInput = z.infer<typeof skillInputSchema>;

export type Skill = SkillInput & {
  id: string;
  /** How the skill is referenced in a message: /morning-briefing. */
  slug: string;
  /** Where it came from: written by you, saved by a bot, or installed from the marketplace. */
  source: "written" | "bot" | "packaged";
  createdAt: string;
  updatedAt: string;
};

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
  /** Whether every user's bots may be given it, or only the admin's. */
  shared: z.boolean().default(false),
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
