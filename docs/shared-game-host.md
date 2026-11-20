# The shared game host

With `DEPLOY_DRIVER` set to `"shared"`, games no longer get a Cloudflare Worker each. The platform Worker answers on the
wildcard route `*.<GAME_HOST>/*` (`*.hearthcade.app/*`) and serves every game itself, so the number of games is not
limited by the account's Worker scripts (500 on Workers Paid) or the zone's routes. Creators do nothing different:
uploads, versions, previews, publishing and rollbacks work as before, and game addresses do not change
(`gcp-<project>-<live|preview>.hearthcade.app`).

## How a request is served

`src/game-host.ts`, reached from `src/index.ts` for any host under `GAME_HOST`:

| Request | Served by |
| --- | --- |
| Pages and files of any game | The game runtime (`src/runtime/game-worker.js`, the same code a game Worker ran) in-process, reading the version's files from the `FILES` bucket. No creator code runs in the platform isolate: a game's client code runs in the player's browser. |
| `/api/*` of a game with server code (`server/index.js`) | A Dynamic Worker (Worker Loader, `LOADER` binding) built from the runtime plus the game's own `server/` and `shared/` modules. It gets exactly the env a game Worker had (plain strings and the two keys derived for that game), never the platform's bindings. Its `fetch()` goes through `GameOutbound` (`src/index.ts`), which applies the admin's blocked hosts and answers platform calls in-process. |
| Games with server-run matches (`server/match.js`) | Still a standard Worker on its own route under `GAME_HOST`. A per-script route is more specific than the wildcard, so those requests never reach the shared host. A match is a Durable Object class of the game's own script, which needs a script of its own. |

The play-token gate, the `/~t/<token>/` paths Safari needs, the injected SDK and the headers are the runtime's, so they
are unchanged. Each isolate keeps what it read about a game (its served version and bindings) for `GAME_CACHE_MS`
(10 seconds), so a deploy or a rollback reaches players within 10 seconds.

## Moving existing games

Switching `DEPLOY_DRIVER` to `"shared"` makes the scheduled rollout (every 10 minutes, `src/deploy.ts`) move games a few
at a time: each moved game is recorded on the shared host (`game_workers.host = shared:<GAME_HOST>`), then its old
Worker and route are deleted. Until a game has moved, its old per-script route still wins over the wildcard, so it keeps
being served by its old Worker. Nothing is down at any point. Games with server-run matches stay on (or move to)
standard Workers (`game_workers.matches`, migration 0031).

## Costs

Per request, a game on the shared host costs the same as on its own Worker (one Workers request). Dynamic Workers are
billed per unique Worker per day (1,000 a month included, then $0.002 each a day) and only exist for games with server
code while they are played. The id changes only when the version, the runtime or the outbound policy changes.

## Configuration

`wrangler.jsonc`: the `*.hearthcade.app/*` route, `worker_loaders: [{ binding: "LOADER" }]`, `DEPLOY_DRIVER: "shared"`,
`GAME_HOST` and `GAME_ZONE_ID` (for the match games' routes). `hostingProblems` (`src/hosting.ts`, shown in the admin)
lists anything missing.
