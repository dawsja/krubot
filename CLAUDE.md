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
  `text-primary-foreground`, a white pill in the light and a grey one in
  the dark. Every main button, the circles on the phone's screens and the
  bot's name pill use it. Bubbles have their
  own greys: yours is `bg-bubble-you`, a bot's `bg-bubble-bot`, a step
  lighter. Send is a primary circle inside the composer pill. A control's
  on state (switch, checkbox, radio, slider, pressed pill) is `bg-control`
  / `text-control-foreground`, ink in both themes, so on and off always
  read; `variant="control"` on a button is for the rare one that must. Everything
  else is one pill: a slight grey `--primary-edge` draws it in both themes
  and nothing else does (`--primary-shadow` is `none`), so a button, a
  circle, a field, a select and a toggle read as the same object at any
  size. It is filled with `bg-primary` when it is a main action or a field
  you type into (`Input`, `Textarea`, `Select`, `InputGroup`), and
  transparent with the same edge when it is secondary
  (`variant="outline"`, a toggle until it is pressed). A focused field
  steps to `--primary-edge-focus`, never the orange ring, which reads as a
  band on the light page and vanishes on the dark one. The orange brand is
  an accent only: logo, focus ring on buttons, links, unread dot. Secondary actions are `variant="outline"`, tertiary
  `ghost`, destructive `destructive`. Use `text-muted-foreground`,
  `bg-card`, `bg-muted`, `border` and friends; never raw Tailwind colours,
  never `dark:` overrides by hand, never the old `bg-carbon` /
  `text-graphite` / `bg-paper-white` names outside `globals.css`.
  Nothing draws a scrollbar: `globals.css` hides every one, for every
  scroller, and the desktop's Connect page and the Android app's views do
  the same. Scrolling itself is untouched; a long list says its edges with
  `scroll-fade-y` / `scroll-fade-x`. Never style one back.
- **Both themes, every time.** Check light and dark. Field edges, rings and
  fills must read on both.
- **Phones first, one screen at a time.** Under `md` the app is a
  messaging app: `/app` is the Chats screen (`chats-screen.tsx`, the same
  list the sidebar draws: your picture top left opens Settings, Search and
  New are circles top right, Search swaps in the field; pinned bots are a
  row of big faces above the list, `PinnedTile` in `sidebar.tsx`), a conversation is a full screen with floating
  pills over the page, never a bar: the header is absolute and the messages
  scroll under it, so only the pills themselves cover what was said (the
  strip between them is `pointer-events-none`). The scroller is
  `scroll-fade-y`: both edges fade, and each one retracts as you reach it,
  so the newest message and the first are never cut off. They are a back chevron,
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
  `Dialog` is a sheet from the bottom under `sm`, and so is a `Select`'s
  list wherever the phone layout applies, the Android app included
  (`useIsMobile` in `ui/select.tsx`: a backdrop, the positioning dropped,
  70% of the screen at most, and rows a thumb can hit); touch targets are
  44px;
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
- **A bot's message is light Markdown** (`lib/markdown.ts`): paragraphs,
  headings, lists, quotes, fenced and inline code, rules, tables, bold,
  italic, strikethrough and links. A bare URL is a link too, since agents
  write them as plain text far more often than as `[text](url)`. Agents
  reach for a table whenever they return figures, so it is not optional.
  Images are deliberately not rendered: a bot hands over a file with
  `send_file` and it becomes an attachment. Anything a person has to act on (a sign-in, a key) is a
  card, not a link. Every one of them is built on `action-card.tsx`, one
  shell in the same grey with the same edge as a button or a field: the
  approval in `conversation.tsx`, then `secret-card.tsx`,
  `signin-card.tsx` and `connect-card.tsx`. A new kind of card goes there
  too, so they never drift. What is waiting is said by the buttons inside,
  never by a colour on the card; the approvals badge in the list carries
  the amber.
- **Settings is sections, not a scroll.** `SETTINGS_SECTIONS` in
  `lib/settings-sections.ts` is the list (account, team, ai, skills, apps,
  auth), each marked `admin` or not; the route
  `/app/settings/[[...section]]` maps to it and 404s a user on an admin
  section. Settings never opens the computer: a bot's panel does
  (`right-panel.tsx` → `openShellDialog({ kind: "computer", botId })`),
  and keeping it running (Update, Reset, what is installed) is the
  `ComputerCard` inside Team, the admin's. `useStore().admin` hides the
  admin's things elsewhere ("Open its computer", the computer section of a
  bot's details). A new card goes into an existing section, or a new entry there
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
- **The marketplace is every toolkit Composio supports**, never a list kept
  here: `catalogIndex` pages through their API (the SDK's own list drops
  the cursor, so it goes through the client under it), skips a project's
  custom toolkits, and keeps the result per key for ten minutes;
  `APP_CATALOG` in `packages/shared` is only the familiar few, shown before
  a key is set and on the onboarding step. **The catalog is indexed, not
  scanned**: `indexApps` (`src/catalog.ts`) reads every name, slug,
  category and description once into squashed text, its words, and a
  bitmask of the characters it holds, so a search is one integer test per
  app and then scoring — nothing is allocated per keystroke. The search is
  forgiving (a few letters in order: `gsheet` finds Google Sheets) and
  pure, so it is tested without a network. Hundreds don't scroll, so
  `/api/catalog` answers one page at a time and Settings → Apps is a search
  field, a page and shadcn `Pagination` (`components/apps-card.tsx`), with
  what you have connected kept at the top. `COMPOSIO_TOOLKITS` still
  narrows the lot. A bot may be given any of them (`allowedToolkits`); an
  app nobody connected is inert.
- **Two approval levels, and neither gates a bot's own folder.** `ask`
  ("Manual") and `full` ("Always allow") are the whole set. Reading is
  never gated, and nor is a change a bot makes inside
  `~/.bots/<id>`: that folder is its desk, so `inOwnHome` in
  `src/approvals.ts` lets it through at either level. Past that, `full`
  allows everything and `ask` sends a card and waits: a shell command, a
  file elsewhere, a connected-app action. The level is read at the moment
  it decides, not from the object the turn started with
  (`requestApproval` re-reads the bot), because a turn runs for minutes
  and changing the level while a bot works is exactly when a person does
  it. The box only ever hears `ask` or `full` (`PERMISSION_MODES`); under
  `ask` every prompt comes to the broker, which answers the free ones
  itself.
- Long work is started by the dispatcher (`src/dispatcher.ts`) and awaited
  in the responder (`src/responder.ts`); a tick stays quick. While the
  computer updates or resets (`src/updater.ts`), nothing new starts and
  pending messages wait. The dispatcher also chases stalled handoffs
  (`src/nudges.ts`) about once a minute.
- **Only handoffs nested in handoffs are hops.** `MAX_CHAIN` stops bots
  waking each other forever. A result lands a hop up from its brief
  (`resultDepth`), and a teammate that hands part of its task on keeps its
  own handoff open (`parentId`) until the last of those results is in, so
  the real result goes up the chain as results, never relayed with
  `message_bot` a hop deeper each time. A handoff whose run broke (a long
  task out of time) says so in its failed result, not in an incident a
  hop deeper, so a "carry on" brief is never further down than the first.
- **Stop means stop, and everything it started.** `stopThread`
  (`src/responder.ts`) is what Stop runs: the turns in the conversation
  are aborted with the reason `"stopped"` and given a moment to wind down,
  then everything waiting there is dropped (the person's queued messages
  too), and the handoffs it gave out (down the chain), what it sent
  teammates and its follow-ups are called off, and a handoff to it closes.
  `ask_bot` turns end with
  the turn that asked, and an approval a stopped turn waited on expires.
  A stop is never an incident, whatever the engine made of it: a CLI's
  stream just breaks, so `botTurn` asks the signal (`stopCauseOf`,
  `unansweredEnding`), never the error. Stop all (`POST /api/stop`) is
  `stopThread` over every conversation of the person's. Anything new
  that can wake a bot later (a timer, a queued message, a handoff) has
  to be called off here too, or it will start stopped work again.
- **A message to a working bot steers it.** When every bot a person's
  message is for is already working in that conversation,
  `postFromPerson` (`src/responder.ts`) hands it to their running turns
  instead of queueing it: the model works it in at its next step and the
  turn's one reply covers it. The message is posted `steered` (the web
  says "Sent while working") and put back to wait if no turn took it.
  "Send after it finishes" in the composer, and anything with files,
  waits as before. Only a person steers; routines, teammates and hidden
  prompts always queue. Each driver steers its own way (`steer` on the
  session, `POST /agents/:id/steer`): Claude Code reads another stdin
  message, known to be read by `--replay-user-messages`; Codex takes
  `turn/steer`; Grok's prompt is cancelled and the words sent next; the
  `api` engine's loop reads a `SteerQueue` between steps. A driver that
  can't take it answers false, never guesses.
- **The AI is each person's own** (`src/data/ai.ts`, Settings → AI for
  everyone). `enabled` is the engines they turned on, `engine` the one in
  use (always one of them), and `engines[engine]` its model. A CLI always
  runs on their plan; a key is the `api` engine's, so nothing can be left
  pointing at a key with no way back. How hard a model thinks is the
  model's own business: nothing sets it, and there is no setting for it.
  The Engine card
  is only ever about the plan: an engine is put on a key, or taken off it,
  by the switch on that key under API keys, and removing a key puts its
  engines back on the plan (`releaseEngines`). So nothing but that card
  writes `access`;
  `src/engines.ts` turns that and the owner's providers into what the box
  gets. A plan is the CLI signed in inside the person's own account on the
  box, which Settings → AI can do for them without a terminal
  (`/api/box/engines/:engine/sign-in`, `components/engine-signin.tsx`); an
  API key is one of their own providers. Models come from the engines
  themselves (`/api/models` in `routes/llm.ts`, one group per enabled
  engine): `codex model/list` over its app-server, `grok models`, Claude
  Code's aliases, and a key's own `/models`. Nothing here keeps a list of
  model names; picking one says which engine runs it, and any id can still
  be typed.
  Nobody's bots run on anyone else's plan or key, and there is no fallback
  to the admin's. Team settings (`kru_settings`) keep only onboarding
  and the time zone. Three of each person's bots answer at once
  (`TURNS_PER_PERSON`), counted apart so one busy team never holds up
  another's; there is no setting for it. A new engine is a session class in the box with the same surface
  (`ensure`, `turnWith`, `steer`, `answerTool`, `close`), its permission questions
  sent through `askPermission`, and an entry in `CLI_ENGINES` in both the
  box and shared.
- **`api` is the engine with no CLI** (`src/native.ts`). `engineRun`
  answers it with `native`, and the responder runs the loop here instead
  of in the box: Anthropic's Messages API or the OpenAI chat API,
  whichever the person's key is, with the same tools a CLI would get plus
  the computer (`src/computer.ts`: Bash, Read, LS, Write, Edit on the box,
  as the bot's owner). Those tools carry the CLI's own tool names on
  purpose, so `requestApproval`, the saved `Bash(git:*)` rules and
  "never ask about its own folder" hold unchanged. It still goes out
  through the LLM proxy with the provider's proxy token, so the key is
  decrypted in one place as before, and it reaches no MCP server: those
  are a CLI session's. Anything above the driver (the prompt, approvals,
  redaction, activity, posting) is shared, so a new API shape is two
  functions in `native.ts` and nothing else.
- **AI provider keys are secrets too, and each person's own.**
  `src/data/providers.ts` keeps one endpoint per API per person
  (`PROVIDER_KINDS`: Anthropic-compatible, OpenAI-compatible, xAI), the key
  encrypted and write-only. An engine names the APIs it can run on
  (`ENGINE_LABELS[engine].providers`, best first) and `engineRun` takes the
  first the person has a key for. A key is only ever typed in one place,
  Settings → AI → API keys, where the API is picked first and its card
  opens. The box gets the LLM proxy (`/api/llm/:kind/*` in
  `src/routes/llm.ts`) and the provider's proxy token; the token names whose row it is
  (`providerByToken`), only the proxy decrypts the key, and
  `allSecretValues()` includes every key for redaction.
- **Secrets never leave the API.** `src/data/secrets.ts` stores them
  encrypted, per person, and only `readSecret`/`injectSecrets` decrypt, at
  the moment of use: the MCP proxy in `src/routes/mcp.ts`, which fills a
  server's headers only from its owner's secrets. No route returns a value, no
  value goes to the box, and every bot reply and activity line passes
  through `createRedactor(allSecretValues())`. A bot asks with
  `request_secret` (a `secret` message kind, answered on
  `/api/secret-requests/:id`); it only ever hears "stored". A request's
  `target` says where the value lands: the secret store, or the person's
  Composio key when the bot asked with `set_composio_key`. There is no
  Settings section for them and no route lists or deletes one: a value
  only goes in through a bot's request, a newer one replaces it, and
  deleting the person takes the lot. Never tell a person to paste a key
  into Settings that a bot could ask for.
- **Skills are each person's own library of folders**
  (`src/data/skills.ts`): a row is SKILL.md (name, description,
  instructions, any other frontmatter in `meta`) and `kru_skill_files`
  holds the scripts, references and assets next to it. `src/skills.ts`
  mirrors a person's library to `~/.skills/<slug>/` in their home only
  (on change, at start, after a reset, and before their first turn in a
  process). The system prompt carries the index; a `/slug` in the message
  puts that skill in full, with where its files are. A routine with a
  `skillId` posts `Use /slug.` ahead of its prompt, from its owner's
  library only. A bot makes one with `save_skill` (best from a folder it
  built in its home, or a .skill file) and changes one with
  `update_skill`; "Make it a skill" on a bot's message asks it to. A
  .skill is the folder zipped (`src/skill-bundle.ts`, pure and tested):
  Settings → Skills imports one and downloads any skill as one.
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
  own) and `update_bot` (a teammate's) go through `profilePatch()` in
  `src/tools.ts`, then `syncSoul` rewrites SOUL.md on the box. Add a field
  there, not in the route. **No tool is the chief's alone**: `teamTools`
  (`create_bot`, `update_bot`, `delegate_bot`, `ask_bot`) goes to every bot,
  and `isChief` only shapes the prompt and decides who answers in a room
  when nobody is named. Who does what is said in a bot's SOUL and the house
  rules, never gated in the responder. `connect_app` looks in Composio first and only
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
  Nothing is pushed about a conversation the person has in front of them:
  the page reports what it shows (`viewing-report.tsx` →
  `/api/push/viewing`, `src/presence.ts`), since the service worker can't
  tell on an iPhone.
- **Roles.** `src/access.ts` is how a route knows who is asking:
  `requireAdmin` guards the admin's areas (mounted in `app.ts`: the
  computer's Update and Reset, onboarding, users, oidc, and every write to
  settings), `ownBot` and
  `ownThread` answer null for anything that isn't the signed-in person's,
  and a route answers 404 then, never 403. `listBots`, `listThreads`,
  `getChief`, `createBot`, `createRoom`, `searchMessages` and the push
  functions take the user; the responder and the bot tools use the
  conversation's owner. Connected apps, the Composio key, MCP servers,
  secrets, the AI and its providers, and the computer (terminals, the
  desktop, a bot's files, the sign-in status) are everyone's own and
  answer only for the signed-in person; nothing is shared between people.
  Skills are too. Reads everyone needs (a reduced settings view) stay
  open and are narrowed inside their routes. A live event about a
  conversation or a person reaches only its owner (`routes/events.ts`);
  `ai` and `skills` are such topics.
- **Every person has an account on the box.** `boxConfig(userId)` in
  `src/box.ts` makes the client for one person, and every request about a
  home carries them in `X-Kru-User`. The box answers `no_account` for
  someone it hasn't met, the client makes the account (`POST /accounts`:
  the admin is `agent`, anyone else a new Linux user with a home of their
  own) and tries again, so nothing is set up ahead of time. The responder
  uses the conversation's owner, the bot tools the bot's owner, the box
  routes the signed-in person; `boxHome(userId)` is the home's path once
  it is known (for `send_file`'s absolute paths). Deleting a person
  (`routes/users.ts`) removes their account, home and all
  (`removeBoxAccount`). Each person's skills mirror is written by
  `syncSkills(userId)` through `/skills`, at start and on every change.
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

- The box is not a throwaway. `/home/agent` (the admin's home) is a
  volume; their bots' homes, package caches and Claude sign-in are volumes
  inside it. `/home` is a volume for everyone else's homes, and `/state`
  keeps the token and the register of accounts. Never put state anywhere
  else.
- **One Linux account per person** (`accounts.mjs`). The admin is the
  `agent` user the box always had; everyone else gets `kru-<name>` (uid
  from 2001) and `/home/<name>`, mode 0700, made with `useradd` on first
  use and made again at start from `/state/accounts.json`, since
  `/etc/passwd` doesn't survive a container recreate but the homes do.
  Every route about a home takes the person from `X-Kru-User`
  (`accountFor`) and runs as them: `agentEnv(account)`, `asUser(account)`,
  `botDir(account, id)`, a terminal in their home, a desktop on their own
  display and VNC port (`desktopSlot`), and sessions, terminals and
  desktop connections answer 404 for anyone else's. Separation is Unix
  permissions inside one container: real, but not a hard security
  boundary. Without root (a dev checkout) every account shares this
  process's user and only the homes differ.
- Everything a bot runs happens as its owner's user with
  `agentEnv(account)`. Credentials are stripped from the environment
  before a session starts. The CLIs' sign-ins (`.claude`, `.codex`,
  `.grok`, each person's own) are never readable through the files API
  and survive Reset.
- **A model list comes from the CLI** (`models.mjs`,
  `/engines/:engine/models`). Codex answers `model/list` on its
  app-server, Grok prints `grok models`, and Claude Code has neither, so
  it offers its aliases (`fable`, `opus`, `sonnet`, `haiku`, best first,
  `opus` the default), which follow the newest model of each name and
  never go stale. Only their labels carry a version number, so those are
  edited by hand when a new one lands. A CLI that can't
  answer returns nothing and the app says so, rather than showing names
  that may not run.
- **A sign-in is the CLI's own login, driven here** (`sign-in.mjs`,
  `/engines/:engine/sign-in`). One job per person and engine: the login
  command in a pseudo terminal as them (the same `pty.spawn` recipe as a
  terminal, wide enough that no link wraps, `CI` dropped so the CLIs print
  the link), the link and the code parsed out of what it prints, the code
  from the sign-in page written back for Claude Code, and the outcome
  confirmed by asking the CLI itself. Only the link, the code and a short
  error ever leave; the transcript never does. Parsing and the job are
  pure functions with tests (`test/sign-in.test.mjs`) so nothing there
  needs a container to check.
- Anything that uses the computer answers 503 while `update.sh` runs;
  reads of a bot's files still work. `POST /reset` is the box as it was
  built (`accounts.reset()`): every person's account goes, Linux user and
  home with it, the admin's home is emptied and every skills mirror cleared.
  The one thing kept is each person's CLI sign-ins, set aside in
  `/state/logins/<user id>` and put back by `ensure()` when that person's
  next account is made, so a reset never signs anybody out of their plan.
  Everything else is made again as it is used: an account on the next
  request about a home, a bot's home and SOUL.md on its next turn, the
  skills from the API right after the reset. `DELETE /accounts/:id` closes
  a person's sessions and removes their user and home.
- In every home, `~/.team` holds the person's team space, `.team/<user
  id>` (its `MEMORY.md` loads into every turn of that person's bots, and
  nobody else's; the admin's bots still read the old `.team/MEMORY.md`
  until they write their own); `~/.skills` is a link to the person's own
  library mirror (`/srv/kru/skills/<linux name>`, root's, readable only
  by their group, written by the API through `/skills` as them);
  `~/.bots/<id>` is each bot's home. All three are hidden so
  the home looks like a person's. `bots`, `team` and `skills` from an
  older box are moved over at start.
- New endpoints: add to `route()` in `server.mjs`, keep the bearer-token
  check, take the account from the request, keep paths inside that
  person's home (`insideHome`, `boxCwd` with `account.home` and
  `forbiddenIn(account)`).
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
- All bots, everyone's, share one computer, and every person has their
  own Linux account on it: their own home, their bots' files, their CLI
  sign-ins, their terminals and their desktop. Separate bots are not a
  security boundary there; separate people are Unix permissions inside
  one container, which keeps their work apart but is not a hard boundary
  either. The container and the unprivileged users are. Rows in the
  database are: a bot, a conversation, a push subscription, a connected
  app, a Composio key, an MCP server, a secret, a skill, an AI setting and
  an API provider belong to a user, and a route never returns another person's.
- Everyone's bots run on their own plan or their own API key. Nothing
  about the AI is shared between people, and nobody falls back to the
  admin's.
- The web app never talks to the box; the API does, with a bearer token,
  over the Compose network.
- The Docker socket on the API exists only for Settings → Team →
  Update and Reset. Nothing else may use it.
- A stored secret is never returned by a route, never sent to the box, and
  never appears in a message: only injected by the API at the point of use.
- `.env` never holds anything checked in; `.env.example` documents every
  variable.
