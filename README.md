# Game Creator

**Frontier craft, reusable by every agent.**

A platform where people make web games with their own AI agent (Claude, ChatGPT, Codex, Claude Code, Cursor, OpenCode or anything that speaks MCP), have each version checked for playability by a real browser, and publish it to a marketplace where players sign in, play, rate, review and buy. Everything runs on Cloudflare.

## What is in here

| Part | Where | What it does |
| --- | --- | --- |
| Platform Worker | `src/` | API, OAuth, MCP server, deployment pipeline, realtime rooms, web app hosting |
| MCP server | `src/mcp/` | 31 tools for agents: projects, files, uploads, checks, preview, publish, versions, rollback, stats, plus the building-block catalog, a scene planner, guides, kits and templates |
| Game runtime | `src/runtime/game-worker.js` | The entry module of every deployed game Worker: serves the bundle from R2, gates it behind a signed play token, injects the SDK |
| Verifier | `src/verify-core.js`, `src/verify.ts` | Opens a deployed game in a real browser and decides whether it is playable |
| Craft review | `src/craft-review.js` | Measures seven things from the same browser run (surface detail, light, world, motion, sound, interface, play-through) and returns a score out of 100 with what to improve |
| SDK | `web/public/sdk/gcp.js` | `GCP.ready()`, saves, leaderboards, rooms, test hooks. Injected into every game |
| Procedural core | `web/public/kits/v1/procgen/` | `@gcp/procgen.js`: seeded random numbers and noise that give the same values in JavaScript and in GLSL, a mesh builder, a texture painter with 39 generators, and recipes (assets as seed + parameters) |
| Building blocks | `web/public/kits/v1/craft/`, `hud.js`, `sound.js` | `@gcp/craft.js`: one-call stage, surfaces, terrain, trees, props, animated characters, player control, effects, HUD and sound, all generated in code |
| Other kits | `web/public/kits/v1/` | Loop, input, Three.js and 2D canvas helpers, multiplayer |
| Scene planner | `src/design-scene.js` | Turns a description into a block plan and a complete starting game (plain rules, no AI) |
| Block lab | `web/public/lab/` | `/lab`: any recipe built live in the browser, with the CPU = GPU noise check |
| Guides | `web/public/guides/` | Authoring advice served to agents through MCP: building blocks, procedural generation, pipelines, meshes, materials, animation, loading, input, performance, audio, saves, multiplayer, troubleshooting |
| Templates | `web/public/templates/` | Four starting points that already pass verification, including a bare 2D canvas and a bare Three.js scene |
| Web app | `web/src/` | Marketplace, game pages, creator console, earnings, admin console (React, English and 简体中文) |
| Schema | `migrations/` | D1 tables |
| Tests | `tests/e2e.mjs` | End-to-end run against a local Worker with a mock Stripe |

## How a game goes live

1. The creator connects their agent to `https://<site>/mcp`. Sign-in is OAuth 2.1 with PKCE and dynamic client registration; no API keys exist. Access tokens last one hour and the grant thirty days by default (both adjustable), and a creator can revoke an agent from the console at any time. An agent that cannot open a browser (a sandbox, a server, CI) uses device sign-in instead: it posts to `/oauth/device`, shows its user the link it gets back, and polls `/oauth/token` until the user has approved at `/device`. It receives the same expiring tokens. (On a `workers.dev` address Cloudflare refuses some default client signatures, Python `urllib` among them, with `403 error code: 1010`; any descriptive `User-Agent` header avoids it, and a custom domain lets you switch that check off.) A request to `/mcp` without a token is answered with these steps, so an agent can work out how to connect by itself.
2. The agent calls `get_started`, plans with `design_scene` or `recommend_pipeline`, looks up building blocks with `list_blocks` and `get_block`, creates a project and writes files.
3. `check_project` runs static checks: JavaScript syntax, imports that resolve, files that exist, and the platform contract.
4. `deploy_preview` freezes the files as a numbered version, deploys that version as its own Cloudflare Worker, and opens it in a real browser (Cloudflare Browser Rendering). The version is verified only if the game boots (`GCP.ready()`), keeps rendering frames, draws a non-blank picture, survives keyboard, mouse and touch input, serves every file it asks for and throws no uncaught errors. The report and a screenshot are stored with the version. A game can also register a play-through (`GCP.test.onPlaythrough`): a short script that plays its own rules to the end. The browser runs it, lists each step in the report, and refuses the version if it fails. Without one, the report says that only start-up, rendering and input were checked.
   A verified version also gets a craft score out of 100 with the specific things to improve and the building block that fixes each. The score is advice: publishing never depends on it.
5. `publish` makes a verified version live in the marketplace. There is no human review. `rollback` and `unpublish` are one call each.

Games that require WebGPU cannot run in the verification browser. Those versions are verified when their creator plays the preview for a short while without errors.

## The contract for games

Three rules, and nothing else is prescribed:

1. A game is a web page: `index.html` at the bundle root plus whatever it loads by relative path. No build step.
2. Call `GCP.ready()` once, after the first playable frame is drawn.
3. Keep rendering, throw no uncaught errors, survive input.

Genre, art direction, engine and rendering technique are the creator's. The guides are advice and the kits are optional.

## Money

- **Creator license.** A one-time fee (default $30) to publish any number of games. Building and previewing are free.
- **Free or paid games.** A creator sets a price or leaves the game free. Players pay the platform; the platform keeps its cut (default 10%) and credits the rest to the creator's balance after a holding period (default 7 days).
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
node tests/procgen.mjs      # frozen outputs of the procedural core (same seed, same result)
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
