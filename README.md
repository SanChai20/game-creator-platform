# HearthCade

**Frontier craft, reusable by every agent.**

A platform where people publish web games made with their own AI agent (Claude, ChatGPT, Codex, Claude Code, Cursor, OpenCode or anything that speaks MCP), have each version checked for playability by a real browser, and sell or share it in a marketplace where players sign in, play, rate, review and buy. Everything runs on Cloudflare.

**Web games only.** The platform hosts games that run in a browser page: HTML, JavaScript, CSS and WebAssembly. Native, mobile, console and desktop builds are refused: uploads are checked by their bytes as well as their names, and a page that sends players to a download, an app store or another site fails the static checks. Engines that export to the web (Unity WebGL, Godot Web, Phaser, PlayCanvas, Babylon.js, Three.js) are welcome.

**Hosting, not authoring.** The MCP server covers deploying, going live, versions and the platform services (saves, leaderboards, multiplayer rooms, server code and more; `platform_services` and [the services guide](web/public/guides/services.md) list them all, with what is not provided). It does not tell agents how to make a game: engine, renderer, art and asset pipeline are the creator's.

## What is in here

| Part | Where | What it does |
| --- | --- | --- |
| Platform Worker | `src/` | API, OAuth, MCP server, deployment pipeline, realtime rooms, web app hosting |
| MCP server | `src/mcp/` | 21 tools for agents: get_started (rules, account, services, platform guides), platform_services (the catalog of every service with its SDK calls, tools, live limits and what is not provided; also the `gcp://services` resource), projects, file uploads, game_metadata (the store-page checklist: detect, suggest, declare), compatibility requirements (detect, declare), game_storage (the game's storage, what uses it, how to stay inside it, requests for more), preview and verification, versions, publish, rollback, unpublish, stats, and the hosted services: game data (shared data, saves, leaderboards) and multiplayer rooms, plus find_implementations and get_implementation, which show how other creators' live games were built when they opted in (never code) |
| Web-only checks | `src/web-only.js` | Refuses programs, installers and archives by their bytes, and flags pages that lead to a native download, an app store or another site |
| Game runtime | `src/runtime/game-worker.js` | The entry module of every deployed game Worker: serves the bundle from R2, gates it behind a signed play token, injects the SDK |
| Verifier | `src/verify-core.js`, `src/verify.ts` | Opens a deployed game in a real browser and decides whether it is playable |
| Duplication check | `src/originality.js`, `src/originality-check.ts` | Before publishing: compares each verified version with other creators' live games (code fingerprints that survive renaming, identical files, screenshot hash; templates, kits and libraries ignored) and refuses copies and uploads that are not games. Workers AI's decision models only review borderline cases, under a daily cap: `@cf/cloudflare/clef` judges possible copies, `@cf/cloudflare/clef-flash` decides whether an interactive page is a game |
| Open implementation | `src/implementation.js`, `src/implementations.ts` | Opt-in cards that tell other agents how a live game is built, written from facts about the build, never its code |
| SDK | `web/public/sdk/gcp.js` | `GCP.ready()`, per-player saves and stats, the play record, leaderboards, rooms, test hooks. Injected into every game |
| Hosted modules | `web/public/kits/v1/` | `@gcp/…` modules (procedural core, building blocks, loop, input, Three.js and canvas helpers, multiplayer) that published games already import. Still served at `/kits/v1/`; agents are no longer pointed at them |
| Guides | `web/public/guides/` | The five platform guides served through MCP: the contract, versions and troubleshooting, saves, multiplayer, and platform services (the long form of the catalog in `src/mcp/services.ts`). The older authoring guides stay readable at `/guides/` for existing games |
| Templates | `web/public/templates/` | Starting points that pass verification, used by the end-to-end tests |
| Web app | `web/src/` | Marketplace, game pages, creator console, earnings, admin console (React, in English, 简体中文, 繁體中文, 日本語, 한국어 and Español; see `web/src/i18n/`) |
| Schema | `migrations/` | D1 tables |
| Tests | `tests/e2e.mjs` | End-to-end run against a local Worker with a mock Stripe |

## How a game goes live

1. The creator connects their agent to `https://<site>/mcp`. Sign-in is OAuth 2.1 with PKCE and dynamic client registration; no API keys exist. Access tokens last one hour and the grant thirty days by default (both adjustable), and a creator can revoke an agent from the console at any time. An agent that cannot open a browser (a sandbox, a server, CI) uses device sign-in instead: it posts to `/oauth/device`, shows its user the link it gets back, and polls `/oauth/token` until the user has approved at `/device`. It receives the same expiring tokens. Send a descriptive `User-Agent` header. A request to `/mcp` without a token is answered with these steps, so an agent can work out how to connect by itself.
2. The agent calls `get_started`, creates a project with `create_project` and uploads the game with `upload_files` or, for big files and whole folders, `create_upload_url` and curl.
3. `deploy_preview` runs static checks first (JavaScript syntax, imports that resolve, files that exist, the platform contract, web-only content); `dry_run: true` stops there.
4. It then freezes the files as a numbered version, deploys that version as its own Cloudflare Worker, and opens it in a real browser (Cloudflare Browser Rendering). The version is verified only if the game boots (`GCP.ready()`), keeps rendering frames, draws a non-blank picture, survives keyboard, mouse and touch input, serves every file it asks for, throws no uncaught errors, and (when it calls its own server code) does not make that code crash. The report and a screenshot are stored with the version. A game can also register a play-through (`GCP.test.onPlaythrough`): a short script that plays its own rules to the end. The browser runs it, lists each step in the report, and refuses the version if it fails. Without one, the report says that only start-up, rendering and input were checked.
5. `publish` makes a verified version live in the marketplace. There is no human review. `list_versions`, `rollback` and `unpublish` manage it afterwards.

Games that require WebGPU cannot run in the verification browser. Those versions are verified when their creator plays the preview for a short while without errors.

**Game storage.** Each game may hold up to its storage in files (admin setting `bundle_max_bytes`, 50 MB by default, with the largest file and the file count beside it under Admin, Settings, Storage). An admin can give one game a different amount (Admin, Games, Storage) or approve a creator's request for more, made by their agent with `game_storage {action: "request"}` (capped by `storage_max_bytes`, approved at once below `storage_auto_approve_bytes`). Uploads (MCP, the upload URL, zips, checked from the zip directory before unpacking) refuse growth past it, `deploy_preview` refuses a workspace over it and `publish` a new version over it. Every upload and deploy answer carries the game's storage with a warning from 80% used, and `get_started`, `platform_services`, the storage guide (`web/public/guides/storage.md`) and the Docs page steer agents toward generating content from code and loading large content at run time. The rules are in `src/storage-rules.ts` (tests in `tests/storage.mjs`), the Worker side in `src/storage.ts`.

**Game metadata.** Every game declares what its store page shows: genre (one of 24, stored as the first tag), 2 to 8 tags chosen only from the platform's list (`web/src/tags.ts`: setting and theme, mood, gameplay, players, visual style and view; the store's filters and category pages are built from it, and `scripts/normalize-tags.mjs` maps tags stored before the list), requirements, languages (interface, voice and subtitles per language, and whether it follows the player's platform language `GCP.lang`), players and modes, content descriptors that the platform turns into an age rating (3+, 7+, 12+, 16+, 18+), session length, progress and accessibility, plus store listing translations in the platform's six languages. Build fields live in `gcp.json` and are frozen with each version; genre and translations belong to the project. The `game_metadata` tool returns a numbered checklist with allowed values and suggestions detected from the code, and `publish` refuses a version until genre, requirements, languages, players and content are on record (admin setting `metadata_required`). The rules are in `web/src/gamemeta.ts` and `web/src/languages.ts` (tests in `tests/gamemeta.mjs`); the specification is `web/public/guides/game-metadata.md`. The game page shows an age badge, an At a glance panel, a Languages table and an in-your-language check.

**Adult games.** Sexual content, violence and other mature themes are allowed when the version declares them in `content` (`sexual`: suggestive, nudity, explicit; `violence`: up to graphic; `adult_themes`). A game that reaches 18+ is adults only (`matureOf` in `web/src/gamemeta.ts`, recorded on the project as `age` and `mature` when it goes live, `src/mature.ts`): its cover is blurred and labelled 18+ in every listing, its page keeps the picture blurred, and the player confirms a warning before it starts (`POST /api/games/:slug/play` answers 428 without `confirm_mature`). The content review (`src/content-check.js`) looks at frames the verification browser takes while it starts the game, runs its play-through and gives it input, and refuses a version that shows more sexual content or violence than it declares; content that is never allowed (sexual content involving minors, hate, scams, phishing) is refused whatever is declared. The admin setting `mature_allowed` switches adult games off.

**Compatibility.** Each version carries its requirements (graphics API, hardware GPU, browser features, input, devices, orientation, memory, minimum browsers, known issues), declared in `gcp.json` `requirements` through the `compatibility` tool and merged with what the platform detects in the code at deploy (`web/src/compat.ts`, shared by the Worker, the web app and `tests/compat.mjs`). The game page lists them in a Compatibility section, checks the player's own browser against them (`web/src/compat-probe.ts`) and says before launch whether the game works there. Versions deployed before this get their requirements detected the first time their page is opened.

## The contract for games

Five rules (the same list `get_started` gives agents), and nothing else is prescribed:

1. A game is a web page: `index.html` at the bundle root plus whatever it loads by relative path. No build step. Web games only.
2. Call `GCP.ready()` once, after the first playable frame is drawn.
3. Keep rendering, throw no uncaught errors, survive input, and stay on the page (no redirects, downloads or popups).
4. Declare what the game shows (`game_metadata` content). Mature content is allowed when declared; adults-only games are blurred and labelled 18+.
5. Fit the game's storage (per-game total, per-file and file-count limits).

A version the verification browser cannot run (it needs WebGPU, or no browser was available) can still qualify through the creator's own clean preview session, but it then waits for an admin's approval in the Reviews queue before it goes live.

Genre, art direction, engine and rendering technique are the creator's, and the platform neither prescribes nor scores them.

## Player progress

Every game gets per-player progress from the platform: cloud saves (`GCP.save`), player stats (`GCP.playerStats`) and a play record the platform keeps by itself (sessions, play time, first and last played, best scores; `GCP.playRecord()`). The rules live in `src/player-data.js` and are tested in `tests/player-data.mjs`:

- The game, environment and player always come from the signed play token, checked against that game's own key. A request body cannot name another player or game.
- Preview and live data are separate. The verifier plays under a throwaway identity (`verify:<session>`), cleaned up daily, so it never touches a creator's own saves.
- Players see and reset their own progress on the game page (`/api/games/:slug/progress`). Creators get totals and averages through `game_data`, never one player's data.
- The SDK's offline copy in `localStorage` is keyed by game, environment and player, so people sharing a browser stay apart.

## Game sessions and accounts

Games have no login of their own: every player signs in to the platform and plays as that account, free games included (admin setting "Require login to play", on by default). A signed-out visitor who presses Play is sent to sign in or create an account and comes back to the game, which then starts. Only if an administrator switches the setting off can free games be played as a guest; paid games, purchases and trials always need an account. Each session is bound to the identity that started it. The rules live in `src/session-binding.js` and are tested in `tests/session-binding.mjs`:

- An account's session belongs to the sign-in it started from. Signing out, signing in again (as anyone) in the same browser, the sign-in expiring or the account being suspended ends it, and every service call from a game still open on it (another tab, a reload, the token kept on the game's own origin) is refused with `session_ended`. The SDK stops the game and the game page closes it and says why; other tabs notice through a `BroadcastChannel` and when they come back into view.
- A game page reopened from the token its origin kept in a cookie is served only after the platform confirms the token is still bound (`/api/rt/check`); opened by itself it goes to the game's page, which starts it for whoever is signed in there (`?play=1`).
- Long sessions renew their token shortly before it runs out (`/api/rt/renew`) while the session is still bound, so saves never start failing mid-play. Free-trial tokens are not renewed, and a paid game is renewed only while the player still owns it.
- Progress made as a guest (while guest play was allowed) is offered to the account after sign-in or sign-up and moves only when the player says yes (on a shared computer it may be someone else's). It moves once: the guest id is then retired, its sessions end, and the browser gets a new guest id. In a game where the account already has progress, the account's progress stays as it is and the guest's is never mixed into it.

## Money

- **Creator license.** A one-time fee (default $30) to publish any number of games. Building and previewing are free.
- **Free or paid games.** A creator sets a price or leaves the game free. Players pay the platform; the platform keeps its cut (default 10%) and credits the rest to the creator's balance after a holding period (default 7 days).
- **Free trials.** A creator can let players try a paid game for a set number of minutes (console or `update_project trial_minutes`). The time is kept per player account on the server, counted by wall clock while the game is open, with at least 30 seconds charged per session, so reloading or switching devices does not reset it. A trial play token expires with the trial, after which saves, leaderboards, rooms and new sessions are refused and the game page asks the player to buy. Admins can switch trials off or cap their length.
- **Payouts.** Once the available balance reaches the minimum (default $50), it is sent to the creator's Stripe Connect account automatically each day, and Stripe pays it out to their bank. Creators can also withdraw it sooner. Manual payouts settled by an administrator are off by default and can be turned on in the admin console.
- **Refunds and chargebacks** revoke access and take back the creator's credit (a partial refund, its share). A chargeback the platform wins gives both back.

Stripe is used for everything: Checkout for payments, Connect (Accounts v2 recipient accounts with the Express Dashboard) and Transfers for payouts, signed webhooks for reconciliation. Every number above is a setting in the admin console.

Stripe's own processing fee is charged to the platform account, so by default it comes out of the platform's cut. The settings "Payment processing cost passed on to the creator" let you pass it through instead.

## Cloudflare resources

Declared in `wrangler.jsonc`: D1 (`gcp-db`), R2 (`gcp-games`), KV (OAuth state), two Durable Object classes (`GameRoom` for realtime rooms, `Pipeline` for deploy jobs), Browser Rendering, static assets, and a daily cron for cleanup.

Each game is deployed as a standalone Worker named `gcp-<project>-preview` or `gcp-<project>-live` through the Cloudflare API, bound to the R2 bucket that holds its files.

Addresses: the platform is `https://hearthcade.com` (`PUBLIC_ORIGIN`; `www` redirects to it). Games are served from their own domain, `https://gcp-<project>-<env>.hearthcade.app` (`GAME_HOST` and `GAME_ZONE_ID`; a proxied wildcard DNS record plus one Worker route per game, which the platform creates). The games domain is a different site from the platform, so a game page can never read or plant the platform's cookies, and each game's token cookie is `__Host-` prefixed so games cannot interfere with one another. No Worker answers on `workers.dev`.

## Secrets

| Name | Needed for |
| --- | --- |
| `SESSION_SECRET` | Signing play tokens. Any long random string |
| `CF_API_TOKEN`, `CF_ACCOUNT_ID` | Deploying game Workers. The token needs Workers Scripts: Edit, and Workers Routes: Edit on the `GAME_HOST` zone |
| `ADMIN_CLAIM_TOKEN` | Claiming the first admin account at `/claim-admin?token=…`. Works once |
| `STRIPE_SECRET_KEY` | The creator fee, game sales and Stripe payouts. A restricted key; [docs/stripe.md](docs/stripe.md) lists its permissions |
| `STRIPE_WEBHOOK_SECRET` | Verifying the platform account's webhooks sent to `/api/stripe/webhook` |
| `STRIPE_ACCOUNTS_WEBHOOK_SECRET` | Verifying the creator-accounts event destination (Accounts v2 thin events) sent to the same address |

Without the Stripe secrets the platform runs with payments switched off: free games work, and the admin can grant creator licenses by hand.

### Stripe setup

The full setup (Connect settings, the restricted key's permissions, both webhook endpoints, sandbox tests and the go-live
list) is in [docs/stripe.md](docs/stripe.md). In short:

1. Create a Stripe account with Connect (marketplace, Express onboarding, Transfers), in a sandbox first.
2. `wrangler secret put STRIPE_SECRET_KEY` with a restricted key (`rk_…`).
3. Two webhook endpoints at `https://<site>/api/stripe/webhook`, API version `2026-10-28.endive`: one for your account's
   events (`checkout.session.completed`, `checkout.session.async_payment_succeeded`, `charge.refunded`,
   `charge.dispute.created`, `charge.dispute.closed`) and a thin-event destination for creators' accounts
   (`v2.core.account[configuration.recipient].capability_status_updated`, `v2.core.account[requirements].updated`). Their
   signing secrets go in `STRIPE_WEBHOOK_SECRET` and `STRIPE_ACCOUNTS_WEBHOOK_SECRET`.

## Develop

```sh
npm install
npm run db:local            # apply migrations to the local D1
node scripts/local-verifier.mjs &   # Playwright stand-in for Browser Rendering (needs Playwright + Chromium)
npm run build && npx wrangler dev   # http://127.0.0.1:8787
node tests/e2e.mjs          # full flow against the local Worker
npm test                    # web-only checks and the frozen outputs of the procedural core
```

Local settings go in `.dev.vars`:

```
SESSION_SECRET=dev
DEPLOY_DRIVER=local
VERIFIER_URL=http://127.0.0.1:8799
ADMIN_CLAIM_TOKEN=dev-claim
STRIPE_SECRET_KEY=sk_test_local
STRIPE_WEBHOOK_SECRET=whsec_local
STRIPE_API_BASE=http://127.0.0.1:8798
```

With `DEPLOY_DRIVER=local` games are served from the platform Worker itself under `/__game/…` using the same runtime module that deployed game Workers run.

## Deploy

```sh
npm run db:remote           # apply migrations to the remote D1
npx wrangler secret put SESSION_SECRET     # and the other secrets above
npm run deploy              # build the web app and deploy the Worker
```

Game Workers are standard Workers today (`DEPLOY_DRIVER=cloudflare`). The code is ready to move them to a Workers for Platforms dispatch namespace with a configuration change (`DEPLOY_DRIVER=dispatch`, plus a dispatch Worker and an outbound Worker in `dispatcher/` and `outbound/`); the steps are in [docs/workers-for-platforms.md](docs/workers-for-platforms.md).

To check a deployment end to end (sign-up, OAuth, MCP, a real game Worker and browser verification for each template) without touching the admin claim:

```sh
BASE=https://<site> node tests/live-smoke.mjs
```

It leaves a throwaway account and draft projects behind; remove them from the admin console.

Then open `https://<site>/signup`, create an account, and visit `https://<site>/claim-admin?token=<ADMIN_CLAIM_TOKEN>` to become the administrator.
