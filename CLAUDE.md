# Kru Bot: how we build it

Read this before changing anything. It keeps new features consistent with
what is here. The README says what Kru Bot is; this says how it is made.

## The shape

- Bun workspaces monorepo. **Bun for everything, never npm or npx**: `bun
  install`, `bun run`, `bun x` / `bunx --bun`, `bun test`.
- `apps/web`: Next.js (App Router, React 19) + shadcn (base-ui primitives,
  "nova" style) + Tailwind 4. Talks to the API through `/api/*` rewrites,
  so one origin and one cookie.
- `apps/api`: Hono on `Bun.serve`, `bun:sqlite`, Better Auth (one account).
  Owns the database, drives the box, runs the dispatcher that answers
  messages and fires routines.
- `packages/box`: the bots' computer. Plain Node ESM (`.mjs`), no build
  step, runs as root only to drop to the `agent` user. Persistent CLI
  sessions: Claude Code in `agents.mjs`, Codex (`codex app-server`) in
  `codex.mjs`, Grok (`grok agent stdio`, ACP) in `grok.mjs`, all on the
  shared base in `bridge.mjs`; the `kru` MCP bridge in `kru-mcp.mjs`.
- `apps/desktop`: Electron, Windows installer and Linux AppImage. Plain
  ESM, no build step. It ships one page (Connect, `src/connect.*`, drawn
  with the web's tokens); after that the window loads the Kru Bot you
  connected to, so every other screen is the web app. `kruDesktop` in the
  preload is the only bridge; keep it that small.
- `apps/android`: Kotlin, Gradle, one activity. Like the desktop, it
  ships one screen of its own (Connect, native, drawn with the web's
  tokens in `res/values*/colors.xml`) and then shows the Kru Bot you
  connected to in a WebView, so every other screen is the web app.
  `kruMobile` (`KruBridge.kt`) is the only bridge; keep it that small, and
  every action on it goes through `fromTrustedPage` so a page from another
  origin (an OAuth provider mid sign-in) can't use it. `ServerUrl.kt`
  mirrors the desktop's `server-url.mjs`, with the same tests. Build with
  `gradle assembleRelease` in `apps/android` (ANDROID_HOME set); CI does.
- `packages/shared`: types, zod schemas, constants, templates, the app
  catalog. If web and api both need it, it goes here.
- `docker-compose.yml` runs the three services; CI builds the images and
  publishes them to GHCR.

## Web

- **Use shadcn, don't hand-roll.** The skill is in `.agents/skills/shadcn`
  and its rules apply: forms are `FieldGroup`/`Field`, option sets are
  `ToggleGroup`, callouts are `Alert`, empty states are `Empty`, confirms
  are `AlertDialog` (never `window.confirm`), notices are `toast`, chat is
  `MessageScroller`/`Message`/`Bubble`/`Attachment`/`Marker`, the sidebar
  is the `Sidebar` block, menus are `DropdownMenu` with items in groups,
  `Select` items in `SelectGroup`. Add a component with
  `bunx --bun shadcn@latest add <name>` from `apps/web`; check
  `components/ui` first.
- **Customize in `components/ui`, not at call sites.** The primitives are
  already themed (pill buttons, taller rounded inputs on the card surface,
  the `pill` toggle variant, the animated slider). If a look is needed in
  several places, change or extend the primitive; `className` on a call
  site is for layout.
- **Colours are tokens.** One primary for actions: `bg-primary` /
  `text-primary-foreground`, a white pill with a soft shadow in the light
  and a grey one in the dark (`border-primary-edge` is its ring,
  `shadow-(--primary-shadow)` its lift). Every main button, the circles on
  the phone's screens and the bot's name pill use it. Bubbles have their
  own greys: yours is `bg-bubble-you`, a bot's `bg-bubble-bot`, a step
  lighter. Send is a primary circle inside the composer pill. A control's
  on state (switch, checkbox, radio, slider, pressed pill) is `bg-control`
  / `text-control-foreground`, ink in both themes, so on and off always
  read; `variant="control"` on a button is for the rare one that must. A
  field that sits beside those circles is `<InputGroup variant="pill">`,
  the same surface as a button. What draws that surface differs by theme
  and both are `--primary-edge`: nothing in the light, where a white pill
  on linen is defined by `--primary-shadow` and an outline would make it a
  box, and a grey edge in the dark, where no shadow can be seen. A focused
  field goes to `--primary-edge-focus`, never the orange ring, which reads
  as a band on the light page and vanishes on the dark one. Something
  outlined stays outlined (`variant="outline"`, the `pill` toggle, a form
  field in a card): on a card there is nothing to float against. The
  orange brand is an accent only: logo, focus ring on buttons, links,
  unread dot. Secondary actions are `variant="outline"`, tertiary
  `ghost`, destructive `destructive`. Use `text-muted-foreground`,
  `bg-card`, `bg-muted`, `border` and friends; never raw Tailwind colours,
  never `dark:` overrides by hand, never the old `bg-carbon` /
  `text-graphite` / `bg-paper-white` names outside `globals.css`.
- **Both themes, every time.** Check light and dark. Field edges, rings and
  fills must read on both.
- **Phones first, one screen at a time.** Under `md` the app is a
  messaging app: `/app` is the Chats screen (`chats-screen.tsx`, the same
  list the sidebar draws: your picture top left opens Settings, Search and
  New are circles top right, Search swaps in the field; pinned bots are a
  row of big faces above the list, `PinnedTile` in `sidebar.tsx`), a conversation is a full screen with floating
  pills over the page, never a bar: the header is absolute and the messages
  scroll under it, so only the pills themselves cover what was said (the
  strip between them is `pointer-events-none`). They are a back chevron,
  the bot (tap it for the details sheet, the right panel's content) and a
  menu with the bot's actions
  (`thread-actions.tsx`, shared with the sidebar's long-press menu; under
  `pointer-coarse:` menus are large rounded cards). The composer is an
  attach circle beside a pill that holds the text and the send button, on
  every screen size. There is no bottom bar: the app
  opens on Chats, Settings is behind your picture (with Open the computer
  as a row for the admin), and every screen goes back with its chevron or
  a swipe in from the left edge (`hooks/use-swipe-back.ts`).
  `/app/settings` is the list of sections on a phone and the account on a
  desktop. Wide and narrow are CSS, not `useIsMobile`, so the server's
  HTML is right for both: layout code says `wide:` and `xwide:` (the
  variants in `globals.css`), which are `md` and `lg` except inside the
  Android app, where the phone layout applies at every width (the theme
  init script marks `<html data-shell="android">` before first paint).
  Everything at the bottom pads with `env(safe-area-inset-bottom)`; a
  `Dialog` is a sheet from the bottom under `sm`; touch targets are 44px;
  anything revealed on hover is always shown under `pointer-coarse:`; on a
  touch keyboard Enter is a new line and the send button sends
  (`useCoarsePointer`). Nothing takes focus on its own when a screen
  opens, so the keyboard stays down until a field is tapped.
- **The apps around the web app** are found with `lib/shell.ts`
  (`useNativeShell`, `mobileShell`), never by touching `window.kruDesktop`
  or `window.kruMobile` directly. In the Android app there is no Web Push:
  the API's `notify` live event becomes a phone notification through the
  bridge (`mobile-notifications.tsx`), the theme provider hands the page's
  background to the bars around it, and Settings → Account shows the
  server the app is pointed at with a Change server button.
- **No hydration surprises.** Anything that depends on storage, the
  viewport or the clock renders the server's value first
  (`useSyncExternalStore` with a server snapshot), then the real one.
  Effects that set state do it off the effect's own tick
  (`Promise.resolve().then(...)`), which is what the lint rule wants.
- **Live data flows through the store.** `components/store.tsx` holds bots,
  threads, approvals, activity, you (`me`) and the box update; it refetches
  on `/api/events` topics. Add a topic in `packages/shared` and handle it
  there rather than polling from a component.
- **Mascots come from the kru-bot skill** (`components/hq/kru-bot.tsx`),
  copied 1:1. Don't redraw the flame.
- **A bot's message is light Markdown** (`lib/markdown.ts`), and a bare URL
  is a link too: agents write them as plain text far more often than as
  `[text](url)`. Anything a person has to act on (a sign-in, a key) is a
  card, not a link: `secret-card.tsx`, `signin-card.tsx` and
  `connect-card.tsx` are the three, all answered from the conversation.
- **Settings is sections, not a scroll.** `SETTINGS_SECTIONS` in
  `lib/settings-sections.ts` is the list (account, team, ai, computer,
  skills, apps, secrets, auth), each marked `admin` or not; the route
  `/app/settings/[[...section]]` maps to it and 404s a user on an admin
  section. `useStore().admin` hides the admin's things elsewhere (the
  Computer tab, "Open its computer", the computer section of a bot's
  details). A new card goes into an existing section, or a new entry there
  with a URL the API and the bots can point at (`Settings → Apps → MCP
  servers` in copy). Sign out is in the sidebar footer's profile menu on a
  desktop and the last row of the Settings list on a phone (`useSignOut`).
  `about-card.tsx` ends the Account section with the link to the
  repository; Account is the one section everybody has, so anything for
  every person goes there.
- Copy is plain English in sentence case, short, no exclamation marks. Say
  "the computer" to the person, "the box" in code and docs for developers.

## API

- Routes live in `src/routes/*.ts`, one file per area, mounted in
  `app.ts`. Everything under `/api` needs the session; unsafe methods must
  be same-origin (already enforced in `app.ts`).
- Data access lives in `src/data/*.ts`. A write that the UI should see
  emits an event through `src/events.ts` (`botsChanged`, `threadChanged`,
  `settingsChanged`, or `emit({ topic })`). The web hears it on
  `/api/events`.
- **Migrations are append-only**: add a new SQL string to `MIGRATIONS` in
  `src/db/migrations.ts`; never edit an earlier one. A new enum value in a
  `CHECK` means rebuilding that table in a new migration (see the messages
  table in migration 6), and a data test that writes the new value. Settings that apply to
  the whole team go in `kru_settings`; binary things (attachments, your
  picture) are blobs in their own table.
- Anything that runs on the box goes through `src/box.ts`. The API never
  reads the Claude sign-in and never sends connected-app credentials to
  the box; app actions run through Composio in the API.
- **Connected apps are each person's own** (`src/composio.ts`). Everyone
  sets their own Composio project key in Settings → Apps, or gives it to a
  bot that asks with `set_composio_key` (`src/data/composio-keys.ts`,
  encrypted and write-only like a provider key; both paths go through
  `applyComposioKey`, which forgets what the old key connected); the admin
  falls back to `COMPOSIO_API_KEY`, nobody else does.
  Connections are rows per user, and every Composio call takes the
  person's id: `toolsFor`, `executeAction` and `startConnection` run on
  that person's key and their own connection, never anyone else's. A new
  key for a different project forgets the old project's connections.
- Long work is started by the dispatcher (`src/dispatcher.ts`) and awaited
  in the responder (`src/responder.ts`); a tick stays quick. While the
  computer updates or resets (`src/updater.ts`), nothing new starts and
  pending messages wait. The dispatcher also chases stalled handoffs
  (`src/nudges.ts`) about once a minute.
- **Engines are one choice for the team.** `settings.engine` picks the CLI
  and `settings.engines[engine]` its access (`plan` or `api`) and model;
  `src/engines.ts` turns that into what the box gets. A new engine is a
  session class in the box with the same surface (`ensure`, `turnWith`,
  `answerTool`, `close`), its permission questions sent through
  `askPermission`, and an entry in `ENGINES` in both the box and shared.
- **AI provider keys are secrets too.** `src/data/providers.ts` keeps the
  Anthropic-compatible and OpenAI-compatible endpoints, the key encrypted
  and write-only. The box gets the LLM proxy (`/api/llm/:kind/*` in
  `src/routes/llm.ts`) and the provider's proxy token; only the proxy
  decrypts the key, and `allSecretValues()` includes it for redaction.
- **Secrets never leave the API.** `src/data/secrets.ts` stores them
  encrypted, per person, and only `readSecret`/`injectSecrets` decrypt, at
  the moment of use: the MCP proxy in `src/routes/mcp.ts`, which fills a
  server's headers only from its owner's secrets. No route returns a value, no
  value goes to the box, and every bot reply and activity line passes
  through `createRedactor(allSecretValues())`. A bot asks with
  `request_secret` (a `secret` message kind, answered on
  `/api/secret-requests/:id`); it only ever hears "stored". A request's
  `target` says where the value lands: the secret store, or the person's
  Composio key when the bot asked with `set_composio_key`. Never tell a
  person to paste a key into Settings that a bot could ask for.
- **Skills are one library** (`src/data/skills.ts`), mirrored to the box
  at `~/.skills/<slug>/SKILL.md` by `src/skills.ts`. The system prompt
  carries the index; a `/slug` in the message puts that skill in full. A
  routine with a `skillId` posts `Use /slug.` ahead of its prompt.
- **MCP servers go through `src/mcp.ts`**: HTTP ones become a proxy URL
  with a per-server token; stdio ones are passed as given. Each server is
  one person's (`user_id`; names are unique per person), and its routes
  answer 404 to anyone else. A bot gets only its owner's servers that it
  was given: `mcp:<server id>` in its `toolkits`, toggled in
  its profile next to the Composio apps; `add_mcp_server` gives the new
  server to the bot that asked. The box writes
  them into the session's MCP config next to `kru`; a changed config
  relaunches the session (the args key covers it). OAuth lives in
  `src/mcp-oauth.ts`: probe on add, discovery per the MCP authorization
  spec, dynamic client registration, PKCE, tokens encrypted in the row,
  refresh in the proxy. The web only ever sees `authStatus`. A server set
  to `oauthRedirect: "localhost"` (providers that only allow local tools)
  returns to `MCP_LOOPBACK_CALLBACK`: the desktop app listens there and
  loads the server's callback in its window; a browser pastes the address
  into `/api/mcp-servers/oauth/complete`.
- **Bots hand over files with `send_file`**: it reads the bytes from the box
  (`/files/raw`, links resolved and kept inside the home), refuses a file
  holding a stored secret, and posts it as an attachment. Attachments that
  could run script (HTML, SVG, anything unknown) are served as downloads
  with a sandbox CSP, never inline on the app's origin.
- **Bots edit profiles through tools, not SQL.** `set_profile` (a bot's
  own) and the chief's `update_bot` go through `profilePatch()` in
  `src/tools.ts`, then `syncSoul` rewrites SOUL.md on the box. Add a field
  there, not in the route. `connect_app` looks in Composio first and only
  then points at `add_mcp_server`; keep that order. `add_mcp_server` takes
  an HTTP URL only (commands stay in Settings), asks the person's approval,
  and posts a `signin` card when the server wants OAuth; the card's sign-in
  comes back to that conversation and a hidden prompt lets the bot carry on.
  A connected app's sign-in is a `signin` card too, with `composio:<toolkit>`
  as its id (`composioCard` in `packages/shared`): the card asks for a fresh
  Connect Link when the person taps it, so nothing expires in the message,
  and the connection comes back to the conversation. A bot never pastes a
  sign-in link into a reply.
- A hidden `prompt` message (author `system`) is how the API asks a bot to
  do something on its own, like greeting a new person; the dispatcher
  answers it like a message and the web never renders it.
- **Notifications** are Web Push (`src/push.ts`, `web-push`, VAPID keys in
  the data directory). Send from the API only when a bot finishes for the
  person or needs them, and only when `bot.notify` is on. `sendPush` also
  emits the same notice as a `notify` live event for the Android app.
- **Roles.** `src/access.ts` is how a route knows who is asking:
  `requireAdmin` guards the admin's areas (mounted in `app.ts`: box,
  status, onboarding, providers, users, oidc, and every write to settings
  and skills), `ownBot` and
  `ownThread` answer null for anything that isn't the signed-in person's,
  and a route answers 404 then, never 403. `listBots`, `listThreads`,
  `getChief`, `createBot`, `createRoom`, `searchMessages` and the push
  functions take the user; the responder and the bot tools use the
  conversation's owner. Connected apps, the Composio key, MCP servers and
  secrets are everyone's own and answer only for the signed-in person;
  nothing is shared between people. Reads everyone needs (the skills
  index, a reduced settings view) stay open and are narrowed inside their
  routes. A live event about a
  conversation or a person reaches only its owner (`routes/events.ts`).
- **The OIDC provider** is `data/oidc.ts` (secret encrypted, write-only)
  and Better Auth's `genericOAuth` plugin in `auth.ts`, built from it with
  discovery; a change calls `invalidateAuth()` so the next request gets a
  new instance. The `admin` plugin holds the role; the first account gets
  `admin` (`ensureAdmin`), everyone from the provider `user`, and rows from
  before there were users are adopted by the admin at start
  (`adoptOrphans`). The sign-in page reads `/api/auth-config`, the only
  public view of it.
- Validate request bodies by hand at the route (shape, ranges, allowed
  values) and answer with `{ error }` and a fitting status. A partial
  update parses with the `*PatchSchema` from `packages/shared`, never
  `inputSchema.partial()`: with zod 4 that fills every missing field with
  its default, so a pin would have wiped a bot's job and its chief role.
- Tests: `bun test` in `apps/api/test`. Data tests use a temporary data
  directory; logic tests stay pure.

## Box

- The box is not a throwaway. `/home/agent` is a volume; the bots' homes,
  package caches and the Claude sign-in are volumes inside it. Never put
  state anywhere else.
- Everything a bot runs happens as the `agent` user with `agentEnv()`.
  Credentials are stripped from the environment before a session starts.
  The CLIs' sign-ins (`.claude`, `.codex`, `.grok`) are never readable
  through the files API and survive Reset.
- Anything that uses the computer answers 503 while `update.sh` runs;
  reads of a bot's files still work. `POST /reset` wipes the home except
  `.bots`, `.team`, `.skills` and `.claude`.
- `~/.team` holds each person's team space, `.team/<user id>` (its
  `MEMORY.md` loads into every turn of that person's bots, and nobody
  else's; the admin's bots still read the old `.team/MEMORY.md` until they
  write their own); `~/.skills` is the library mirror; `~/.bots/<id>` is each bot's
  home. All three are hidden so the home looks like a person's, and all
  belong to the agent user. `bots`, `team` and `skills` from an older box
  are moved over at start.
- New endpoints: add to `route()` in `server.mjs`, keep the bearer-token
  check, keep paths inside the agent's home (`insideHome`, `boxCwd`).
- Node and the desktop come from the image; Bun and Claude Code are
  patched in place by `update.sh`. Keep the script step-per-tool, each
  step reporting and never stopping the next.

## Before a commit

```sh
bun run lint
bun run typecheck
bun run test
bun run --filter @krubot/web build
```

All four green, then screenshots of what changed in light and dark when it
is UI (Playwright against the dev servers works; Chromium is at
`/opt/pw-browsers/chromium` in the remote environment). Commit messages:
a short subject in sentence case, then a paragraph or a list saying what
changed and why, written for the person reading the log.

## Things that stay true

- One local account per install, the admin; the setup token gates its
  registration. Everyone else comes through the OIDC provider the admin
  set up and is a user.
- All bots, everyone's, share one computer. Separate bots (and separate
  people) are not a security boundary there; the container and the
  unprivileged user are. Rows in the database are: a bot, a conversation,
  a push subscription, a connected app, a Composio key, an MCP server and
  a secret belong to a user, and a route never returns another person's.
- The web app never talks to the box; the API does, with a bearer token,
  over the Compose network.
- The Docker socket on the API exists only for Settings → Computer →
  Update and Reset. Nothing else may use it.
- A stored secret is never returned by a route, never sent to the box, and
  never appears in a message: only injected by the API at the point of use.
- `.env` never holds anything checked in; `.env.example` documents every
  variable.
