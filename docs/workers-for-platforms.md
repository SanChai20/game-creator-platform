# Moving game Workers to Workers for Platforms

Today every game runs as its own standard Cloudflare Worker (`gcp-<project>-preview` and `gcp-<project>-live`), deployed and updated by the platform through the Cloudflare API. Workers for Platforms (WfP) puts those same scripts into one **dispatch namespace** and serves them through a **dispatch Worker**, which adds unlimited scripts, untrusted-mode isolation, per-request custom limits, tags and an outbound Worker.

The code is already shaped for that move. Switching is configuration plus a few one-time Cloudflare resources; the platform then moves the games over by itself, a few at a time.

## What is already in place

| Concern | Where | Standard Workers (now) | Workers for Platforms (later) |
| --- | --- | --- | --- |
| Choosing the host | `src/hosting.ts` (`DEPLOY_DRIVER`) | `cloudflare` | `dispatch` |
| Upload, delete, settings | `src/deploy.ts` (`host()`) | `/workers/scripts/<name>` | `/workers/dispatch/namespaces/<ns>/scripts/<name>` |
| Script names | `scriptName()` | `gcp-<pid>-<env>` | the same |
| Bindings | `scriptBindings()` | R2 `FILES`, plain text, `PLAY_KEY` secret | the same (all supported on user Workers) |
| Compatibility | `GAME_COMPAT_DATE`, `GAME_COMPAT_FLAGS` | `disallow_importable_env` | the same |
| Tags | `scriptTags()` | `gcp-game`, `gcp-<env>`, `project-<pid>`, `owner-<user>`, `server-code` or `static` | the same; usable for bulk delete (`?tags=owner-u_x:yes`) |
| CPU and subrequest limits | admin settings `game_cpu_ms`, `game_subrequests` | baked into each script's upload metadata (`limits`) | passed per request: `DISPATCHER.get(name, {}, { limits })` |
| Outbound policy | `src/runtime/outbound-worker.js`, setting `game_blocked_hosts` | not enforced | enforced by the outbound Worker |
| Routing | `src/dispatch.ts`, `src/dispatcher.ts` | each Worker has its own hostname | `*.<GAME_HOST>` → dispatch Worker → user Worker |
| Local dev | `/__game/<pid>/<env>/` | runs through the same `dispatchGame()` with an emulated namespace | unchanged |
| Health checks | `waitHealthy()` | HTTP to the game | in-process through the platform's `DISPATCHER` binding |
| Moving games | `rolloutRuntime()` (every 10 minutes) | redeploys scripts with an older runtime or limits | also redeploys scripts whose `game_workers.host` differs from the configured host, then retires the old copy |
| Where each game lives | `game_workers.host` (migration 0012) | `workers`, or `workers:<GAME_HOST>` on per-script routes | `dispatch:<namespace>` |

The game runtime (`src/runtime/game-worker.js`) is the same file in every host. It reads nothing host-specific (no `request.cf`, no Cache API), which matters because user Workers run in untrusted mode.

### Two things this also fixes now

- **Server code could read the platform's bindings.** A game's `server/` modules share the isolate with the runtime, and could `import { env } from 'cloudflare:workers'` to reach the whole games bucket. Game Workers are now deployed with `disallow_importable_env`, so server code only sees the narrow `env` the runtime passes it. The rollout redeploys every existing game with the flag after this ships.
- **Runaway server code had no budget.** The admin can now set a CPU time and subrequest budget per request for game Workers (Settings, Game Workers). They are enforced today through upload metadata and will be enforced through the dispatcher after the move, with the same numbers. Agents read them from `platform_services` (`server_code.limits`) and are told what a `limit_exceeded` (HTTP 503) answer means, so they can explain it to the developer.

## The one decision to make first: the game hostname

Games in a namespace have no `workers.dev` address of their own; the dispatch Worker answers for them on a wildcard route. Pick a host such as `play.example.com` (a zone on the account; `*.play.example.com` needs an Advanced certificate, or use a dedicated zone like `examplegames.com` where Universal SSL covers `*.examplegames.com`).

Why this matters: a game's **origin** changes from `gcp-<pid>-live.<account>.workers.dev` to `gcp-<pid>-live.<GAME_HOST>`. Anything a game keeps in the browser under its own origin (localStorage, IndexedDB, cookies the game set itself) does not follow. Platform saves (`GCP.save`) are server-side and are not affected.

To make the cutover invisible, move the addresses **before** the move to WfP:

1. Add a proxied wildcard DNS record `*.<GAME_HOST>` (any target, e.g. `192.0.2.1`).
2. Set `GAME_HOST` and `GAME_ZONE_ID` in `wrangler.jsonc` and give `CF_API_TOKEN` *Workers Routes: Edit* on that zone.
3. Deploy. The host id becomes `workers:<GAME_HOST>`, so the scheduled rollout redeploys every game onto its own route `gcp-<pid>-<env>.<GAME_HOST>/*` (8 scripts per 10 minutes), and each game's address switches once its route exists. The `workers.dev` address keeps working, so sessions already in progress are not cut off.

From then on, the address a game has is exactly the one the dispatch Worker will answer on, and the WfP move changes nothing for players.

## Migration steps

1. **Subscribe to Workers for Platforms** on the account (Workers Paid plus the WfP add-on).
2. **Create the namespace**: `npx wrangler dispatch-namespace create gcp-games`.
3. **Deploy the outbound Worker**: `npx wrangler deploy -c outbound/wrangler.jsonc`. It allows everything except hosts in `game_blocked_hosts`, and limits calls to the platform to `/api/rt/` and the public module paths. It also stamps `x-gcp-game` on calls to the platform with the real game.
4. **Deploy the dispatch Worker**: fill in `dispatcher/wrangler.jsonc` (route `*.<GAME_HOST>/*`, `GAME_HOST`, `PUBLIC_ORIGIN`, namespace name) and `npx wrangler deploy -c dispatcher/wrangler.jsonc`. It only answers for `gcp-<pid>-<env>.<GAME_HOST>` and returns 404 for anything else on that host, so game hosts never reach the platform's pages or API. If the per-script routes from the step above exist, they are more specific than the wildcard and keep serving the standard Workers until each game is moved.
5. **Point the platform at the namespace** in `wrangler.jsonc`:
   ```jsonc
   "dispatch_namespaces": [{ "binding": "DISPATCHER", "namespace": "gcp-games" }],
   "vars": { "DEPLOY_DRIVER": "dispatch", "DISPATCH_NAMESPACE": "gcp-games", "GAME_HOST": "play.example.com", ... }
   ```
   Apply D1 migrations (`npm run db:remote`, migration 0012 if it is not applied yet) and deploy. The admin overview shows `hosting: dispatch:gcp-games` and lists anything missing under `hosting_problems`.
6. **Let the rollout move the games.** Every 10 minutes it redeploys up to 8 scripts whose `game_workers.host` is not `dispatch:gcp-games` into the namespace, live versions first, with the version each already serves:
   - With per-script routes (same address), the old route and standard Worker are deleted as soon as the new copy is up; sessions carry on because the play key does not change.
   - With `workers.dev` addresses, play sessions started on the old address keep working; the old Worker is deleted 6 hours later (`RETIRE_AFTER_MS`). New sessions get the new address as soon as the game moves.
   With 22 games (up to 44 scripts) this takes about an hour. New deploys from creators go straight to the namespace.
7. **Check**: `wrangler tail gcp-games-dispatch`, the namespace view in the dashboard (filter by tag `gcp-live`), and `SELECT host, COUNT(*) FROM game_workers GROUP BY host` in D1. When every row says `dispatch:gcp-games` and no `retired_host` remains, the move is done.

### Rolling back

Set `DEPLOY_DRIVER` back to `cloudflare` and deploy. The rollout moves every game back the same way (to `workers.dev`, or to per-script routes when `GAME_ZONE_ID` is set).

## Later, optional

- **Per-plan limits.** `dispatchOptions()` is the one place that decides the limits per request; it can read a creator's plan and give paying creators more CPU without redeploying anything.
- **Thinner user Workers.** Today the user Worker still serves the game's static files from R2. The dispatch Worker could serve static files and the play-token gate itself and dispatch only `/api/*`, so games without server code would need no user Worker at all and user Workers would need no R2 binding.
- **Bulk operations.** Removing a creator's account can delete all their games at once with `DELETE /workers/dispatch/namespaces/gcp-games/scripts?tags=owner-<id>:yes`.
- **Custom domains for games** through Cloudflare for SaaS and the dispatch Worker's hostname routing.
