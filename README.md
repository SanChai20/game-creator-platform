# Game Creator

**Frontier craft, reusable by every agent.**

A platform where people publish web games made with their own AI agent (Claude, ChatGPT, Codex, Claude Code, Cursor, OpenCode or anything that speaks MCP), have each version checked for playability by a real browser, and sell or share it in a marketplace where players sign in, play, rate, review and buy. Everything runs on Cloudflare.

**Web games only.** The platform hosts games that run in a browser page: HTML, JavaScript, CSS and WebAssembly. Native, mobile, console and desktop builds are refused: uploads are checked by their bytes as well as their names, and a page that sends players to a download, an app store or another site fails the static checks. Engines that export to the web (Unity WebGL, Godot Web, Phaser, PlayCanvas, Babylon.js, Three.js) are welcome.

**Hosting, not authoring.** The MCP server covers deploying, going live, versions and the platform services (saves, leaderboards, multiplayer rooms). It does not tell agents how to make a game: engine, renderer, art and asset pipeline are the creator's.

## What is in here

| Part | Where | What it does |
| --- | --- | --- |
| Platform Worker | `src/` | API, OAuth, MCP server, deployment pipeline, realtime rooms, web app hosting |
| MCP server | `src/mcp/` | 17 tools for agents: get_started (rules, account, services, platform guides), projects, file uploads, preview and verification, versions, publish, rollback, unpublish, stats, and the hosted services: game data (shared data, saves, leaderboards) and multiplayer rooms, plus find_implementations and get_implementation, which show how other creators' live games were built when they opted in (never code) |
| Web-only checks | `src/web-only.js` | Refuses programs, installers and archives by their bytes, and flags pages that lead to a native download, an app store or another site |
| Game runtime | `src/runtime/game-worker.js` | The entry module of every deployed game Worker: serves the bundle from R2, gates it behind a signed play token, injects the SDK |
| Verifier | `src/verify-core.js`, `src/verify.ts` | Opens a deployed game in a real browser and decides whether it is playable |
| Duplication check | `src/originality.js`, `src/originality-check.ts` | Before publishing: compares each verified version with other creators' live games (code fingerprints that survive renaming, identical files, screenshot hash; templates, kits and libraries ignored) and refuses copies and uploads that are not games. Workers AI (`@cf/openai/gpt-oss-20b`) only reviews borderline cases, under a daily cap |
| Open implementation | `src/implementation.js`, `src/implementations.ts` | Opt-in cards that tell other agents how a live game is built, written from facts about the build, never its code |
| SDK | `web/public/sdk/gcp.js` | `GCP.ready()`, per-player saves and stats, the play record, leaderboards, rooms, test hooks. Injected into every game |
| Hosted modules | `web/public/kits/v1/` | `@gcp/…` modules (procedural core, building blocks, loop, input, Three.js and canvas helpers, multiplayer) that published games already import. Still served at `/kits/v1/`; agents are no longer pointed at them |
| Guides | `web/public/guides/` | The four platform guides served through MCP: the contract, versions and troubleshooting, saves, multiplayer. The older authoring guides stay readable at `/guides/` for existing games |
| Templates | `web/public/templates/` | Starting points that pass verification, used by the end-to-end tests |
| Web app | `web/src/` | Marketplace, game pages, creator console, earnings, admin console (React, English and 简体中文) |
| Schema | `migrations/` | D1 tables |
| Tests | `tests/e2e.mjs` | End-to-end run against a local Worker with a mock Stripe |

## How a game goes live

1. The creator connects their agent to `https://<site>/mcp`. Sign-in is OAuth 2.1 with PKCE and dynamic client registration; no API keys exist. Access tokens last one hour and the grant thirty days by default (both adjustable), and a creator can revoke an agent from the console at any time. An agent that cannot open a browser (a sandbox, a server, CI) uses device sign-in instead: it posts to `/oauth/device`, shows its user the link it gets back, and polls `/oauth/token` until the user has approved at `/device`. It receives the same expiring tokens. (On a `workers.dev` address Cloudflare refuses some default client signatures, Python `urllib` among them, with `403 error code: 1010`; any descriptive `User-Agent` header avoids it, and a custom domain lets you switch that check off.) A request to `/mcp` without a token is answered with these steps, so an agent can work out how to connect by itself.
2. The agent calls `get_started`, creates a project with `create_project` and uploads the game with `upload_files` or, for big files and whole folders, `create_upload_url` and curl.
3. `deploy_preview` runs static checks first (JavaScript syntax, imports that resolve, files that exist, the platform contract, web-only content); `dry_run: true` stops there.
4. It then freezes the files as a numbered version, deploys that version as its own Cloudflare Worker, and opens it in a real browser (Cloudflare Browser Rendering). The version is verified only if the game boots (`GCP.ready()`), keeps rendering frames, draws a non-blank picture, survives keyboard, mouse and touch input, serves every file it asks for and throws no uncaught errors. The report and a screenshot are stored with the version. A game can also register a play-through (`GCP.test.onPlaythrough`): a short script that plays its own rules to the end. The browser runs it, lists each step in the report, and refuses the version if it fails. Without one, the report says that only start-up, rendering and input were checked.
5. `publish` makes a verified version live in the marketplace. There is no human review. `list_versions`, `rollback` and `unpublish` manage it afterwards.

Games that require WebGPU cannot run in the verification browser. Those versions are verified when their creator plays the preview for a short while without errors.

## The contract for games

Three rules, and nothing else is prescribed:

1. A game is a web page: `index.html` at the bundle root plus whatever it loads by relative path. No build step. Web games only.
2. Call `GCP.ready()` once, after the first playable frame is drawn.
3. Keep rendering, throw no uncaught errors, survive input.

Genre, art direction, engine and rendering technique are the creator's, and the platform neither prescribes nor scores them.

## Player progress

Every game gets per-player progress from the platform: cloud saves (`GCP.save`), player stats (`GCP.playerStats`) and a play record the platform keeps by itself (sessions, play time, first and last played, best scores; `GCP.playRecord()`). The rules live in `src/player-data.js` and are tested in `tests/player-data.mjs`:

- The game, environment and player always come from the signed play token, checked against that game's own key. A request body cannot name another player or game.
- Preview and live data are separate. The verifier plays under a throwaway identity (`verify:<session>`), cleaned up daily, so it never touches a creator's own saves.
- Players see and reset their own progress on the game page (`/api/games/:slug/progress`). Creators get totals and averages through `game_data`, never one player's data.
- The SDK's offline copy in `localStorage` is keyed by game, environment and player, so people sharing a browser stay apart.

## Money

- **Creator license.** A one-time fee (default $30) to publish any number of games. Building and previewing are free.
- **Free or paid games.** A creator sets a price or leaves the game free. Players pay the platform; the platform keeps its cut (default 10%) and credits the rest to the creator's balance after a holding period (default 7 days).
- **Free trials.** A creator can let players try a paid game for a set number of minutes (console or `update_project trial_minutes`). The time is kept per player account on the server, counted by wall clock while the game is open, with at least 30 seconds charged per session, so reloading or switching devices does not reset it. A trial play token expires with the trial, after which saves, leaderboards, rooms and new sessions are refused and the game page asks the player to buy. Admins can switch trials off or cap their length.
- **Withdrawals.** Once the available balance reaches the minimum (default $50), the creator withdraws to a bank account through Stripe Connect, or requests a manual payout that an administrator settles.
- **Refunds** revoke access and reverse the creator's credit.

Stripe is used for everything: Checkout for payments, Connect Express accounts and Transfers for payouts, signed webhooks for reconciliation. Every number above is a setting in the admin console.

Stripe's own processing fee is charged to the platform account, so by default it comes out of the platform's cut. The settings "Payment processing cost passed on to the creator" let you pass it through instead.

## Cloudflare resources

Declared in `wrangler.jsonc`: D1 (`gcp-db`), R2 (`gcp-games`), KV (OAuth state), two Durable Object classes (`GameRoom` for realtime rooms, `Pipeline` for deploy jobs), Browser Rendering, static assets, and a daily cron for cleanup.

Each game is deployed as a standalone Worker named `gcp-<project>-preview` or `gcp-<project>-live` through the Cloudflare API, bound to the R2 bucket that holds its files. (Workers for Platforms dispatch namespaces would be a drop-in improvement if the account has them.)

## Secrets

| Name | Needed for |
| --- | --- |
| `SESSION_SECRET` | Signing play tokens. Any long random string |
| `CF_API_TOKEN`, `CF_ACCOUNT_ID` | Deploying game Workers. The token needs Workers Scripts: Edit |
| `ADMIN_CLAIM_TOKEN` | Claiming the first admin account at `/claim-admin?token=…`. Works once |
| `STRIPE_SECRET_KEY` | The creator fee, game sales and Stripe payouts |
| `STRIPE_WEBHOOK_SECRET` | Verifying webhooks sent to `/api/stripe/webhook` |

Without the Stripe secrets the platform runs with payments switched off: free games work, and the admin can grant creator licenses by hand.

### Stripe setup

1. Create a Stripe account and enable Connect (Express accounts, Transfers).
2. Set `STRIPE_SECRET_KEY` with `wrangler secret put STRIPE_SECRET_KEY`.
3. Add a webhook endpoint at `https://<site>/api/stripe/webhook` for `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `charge.refunded` and `account.updated` (including events on connected accounts), and set its signing secret as `STRIPE_WEBHOOK_SECRET`.
4. In the admin console, set "Country of the platform Stripe account".

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

To check a deployment end to end (sign-up, OAuth, MCP, a real game Worker and browser verification for each template) without touching the admin claim:

```sh
BASE=https://<site> node tests/live-smoke.mjs
```

It leaves a throwaway account and draft projects behind; remove them from the admin console.

Then open `https://<site>/signup`, create an account, and visit `https://<site>/claim-admin?token=<ADMIN_CLAIM_TOKEN>` to become the administrator.
