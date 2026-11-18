# Platform services

Everything the platform gives a web game and the agent that builds it, how each service works, how to reach it, its limits, and what the platform does not provide. Read this before you plan a game that needs more than hosting, so you use what is already here instead of building it yourself.

The live version of this list, with the numbers this platform is set to, is the `platform_services` tool (or the `gcp://services` resource). Limits shown here as "default" can be changed by the platform's administrators; `platform_services` and `get_started` under `account.limits` always show the current values.

## How the services reach a game

```
 player's browser                                   the platform (Cloudflare)
 ┌──────────────────────────────┐                   ┌─────────────────────────────────────────┐
 │ game page (its own origin)   │  files            │ game Worker  gcp-<project>-<preview|live>│
 │  index.html + your files  ◄──┼───────────────────┤  serves the version from R2, checks the  │
 │  window.GCP (injected SDK)   │                   │  play session, injects the SDK           │
 │                              │  GCP.server()     │  server/index.js (optional)  ── env.store│
 │                              ├──────────────────►│                                    │     │
 │  GCP.save / playerStats /    │  HTTPS            │ platform Worker  /api/rt/*         ▼     │
 │  shared / leaderboard /      ├──────────────────►│  saves, stats, shared data, scores (D1)  │
 │  playRecord / heartbeat      │                   │                                          │
 │  GCP.room(code)              │  WebSocket        │ GameRoom Durable Object                  │
 │                              ├──────────────────►│  one per game, environment and code      │
 └──────────────────────────────┘                   └─────────────────────────────────────────┘
        the agent ── MCP tools (this server) ──► projects, versions, game_data, game_room, get_stats
```

- **The game** reaches services through `window.GCP`, which the platform injects at the top of every page. Never import or bundle it. There are no keys to configure: every call carries the player's signed play session, and the platform takes the game, the environment (preview or live) and the player from it, never from the request.
- **The agent** reaches services through this MCP server: tools to deploy and publish, and tools to look inside and manage a game's data, rooms and numbers.
- **Preview and live are separate.** Each has its own address, its own saves, stats, shared data, leaderboards and rooms. Testing a preview never touches live players.

## The catalog

| Service | Status | Game uses | Agent uses | Guide |
| --- | --- | --- | --- | --- |
| Game hosting and delivery | available | `GCP.env`, `GCP.version` | `create_project`, `upload_files`, `create_upload_url`, `deploy_preview`, `publish`, `rollback`, `unpublish`, `list_versions` | versions |
| Game storage | available | none | `game_storage`, `list_files`, `upload_files`, `list_projects` | storage |
| Hosted libraries and import map | available | `import 'three'`, `@gcp/…` | `get_started` (`import_map`) | contract |
| SDK and game lifecycle | available | `GCP.ready`, `GCP.progress`, `GCP.fatal` | `get_started` | contract |
| Player accounts and play sessions | available | `GCP.player`, `GCP.lang` | none | saves |
| Cloud saves | available | `GCP.save` | `game_data` (summary) | saves |
| Player stats | available | `GCP.playerStats` | `game_data` (summary) | saves |
| Play record | automatic | `GCP.playRecord()` | `game_data` (summary) | saves |
| Shared game data | available | `GCP.shared.get` | `game_data` (set, get, list, delete) | saves |
| Leaderboards | available | `GCP.leaderboard` | `game_data` (leaderboard, clear_leaderboard) | saves |
| Realtime multiplayer rooms | available | `GCP.room` | `game_room`, `get_stats` | multiplayer |
| Network smoothing | available | `GCP.smooth` | none | multiplayer |
| Game server code | available unless switched off | `GCP.server` | `upload_files`, `deploy_preview` | saves |
| Display, fullscreen and devices | available | `GCP.fullscreen`, `GCP.display`, `GCP.setDisplay` | `compatibility` | contract |
| Compatibility requirements | available | none | `compatibility` | contract |
| Verification and test hooks | automatic | `GCP.test.*` | `deploy_preview`, `list_versions` | versions |
| Publish checks (originality, content, web only) | automatic | none | `publish`, `list_versions` | versions |
| Marketplace listing, ratings and reviews | available | none | `update_project`, `game_metadata` | metadata |
| Paid games, free trials and payouts | available unless switched off | none (handled by the platform) | `update_project`, `get_stats` | none |
| Analytics and runtime errors | automatic | none (heartbeats are automatic) | `get_stats` | none |
| Open implementations | available | none | `find_implementations`, `get_implementation` | none |
| Agent access (MCP and OAuth) | available | none | every tool | versions |

"Automatic" means the platform does it for every game with no code.

## Hosting and delivery

Each version of a game runs on its own Cloudflare Worker, `gcp-<project>-preview` or `gcp-<project>-live`, with the files in R2.

- `deploy_preview` freezes the workspace as a numbered, immutable version and deploys it to the preview address. `publish` makes a verified version live; `rollback` points live at an earlier version in about a second; `unpublish` takes the game offline. Every version is kept.
- The Worker serves every file with its content type, supports range requests (large audio, video and models stream), caches live files for 5 minutes and revalidates preview files. `index.html` is only served with a valid play session; players start one by pressing Play on the game page.
- Upload text files with `upload_files`. For big or binary files, or a whole folder (an engine's web export), use `create_upload_url` and curl: the URL is valid for 30 minutes, `PUT …?path=<file>` sends one file and `POST …/zip` a zipped folder.
- There is no build step on the platform. Upload what the browser runs.

Limits (defaults): 300 files per game, 50 MB of storage per game, 20 MB per file, 50 projects per creator.

## Game storage

Every game has a storage limit: how much all its files may add up to (50 MB by default; the platform can set a different amount for one game), plus the largest file (20 MB) and the number of files (300).

- **Enforced on the server.** `upload_files`, the upload URL and zip uploads refuse a change that would take the game over its storage; the whole call is checked first, deletions included, and only growth is refused, so deleting or shrinking files always works. `deploy_preview` refuses a workspace that is over, and `publish` refuses a new version that is over (a rollback to a version that was live before is allowed).
- **Visible all the time.** Every upload, `list_files`, `list_projects {project}` and `deploy_preview` answer has `storage`: used, storage, free and percent used, with a `warning` from 80% used. `game_storage {project}` shows what uses the space and every way to save it. Tell the developer about the limit when planning the game, not at upload time.
- **Keep games small.** Generate meshes, terrain, textures, sound and music from code at boot; load large or optional content at run time from a host the developer controls (any HTTPS host that sends CORS headers, with plain GET requests); compress what ships. Platform-hosted Three.js and `@gcp/` modules do not count.
- **More when needed.** `game_storage {project, action: "request", megabytes, reason}` asks for more for one game (up to 200 MB by default). An admin reviews each request unless the platform approves small ones automatically. Ask the developer first.

`get_started {topic: "storage"}` is the long form.

## Hosted libraries and the import map

Unless your `index.html` has its own `<script type="importmap">`, the platform adds one, so these bare imports work with no bundler:

```js
import * as THREE from 'three';                         // Three.js {{THREE}}
import * as THREE_GPU from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createLoop } from '@gcp/core.js';              // optional platform helper modules
```

`get_started` lists the exact addresses under `import_map`. Using them is optional: any engine or library you bundle works. If the page has its own import map, list every bare import in it.

## SDK and game lifecycle

```js
GCP.progress(0.4, 'Building terrain');   // optional, 0..1 while loading; shown in verification reports
GCP.ready();                              // required, once, after the first playable frame is drawn
GCP.fatal(err);                           // the game cannot start: shown as the failure reason
GCP.stats({ drawCalls, quality });        // optional numbers for reports
GCP.gpu.warmup(renderer, scenes, camera); // compile shaders in small batches (automatic for three.js while loading)
GCP.gpu.upload(renderer, textures);       // stagger texture uploads
```

While a game loads, the SDK warms the GPU for it. Every WebGL context gets `KHR_parallel_shader_compile`. For three.js, a draw to the screen is held back until its new materials are compiled in small batches and their textures uploaded, so a cold start does not freeze the browser (the GPU process is shared with every tab). See "GPU warm-up" in the contract guide.

The SDK also records uncaught errors, failed file loads and `console.error` for the verification report and for `get_stats`, and sends a heartbeat every 15 seconds that measures active play time (tab visible, frames advancing). Opened outside the platform (a local file or dev server), `GCP.standalone` is `true`, the player is a local one, rooms open with you alone as host, and the data calls fall back to `localStorage` or resolve to `null`, so the same code runs everywhere. Every call that talks to the network resolves instead of throwing.

## Player accounts and play sessions

Games open with no login of their own. `GCP.player` is `{ id, name, guest }`: for a signed-in player, a stable account id and the display name the player chose. Every game, free ones included, needs a platform account to play ("Require login to play" is on); a signed-out visitor who presses Play signs in first and comes back to the game. Only if the platform's administrators switch that setting off can free games be played without an account: `GCP.player.guest` is then `true`, the id is kept per browser, and the session token lasts an hour (renewed while the player keeps playing). When a guest signs in, the platform offers to move their progress to the account; a game then starts a new session as the account and finds its saves there. Paid games, reviews and progress on the game page always need an account. The rule is enforced by the server, which signs play sessions and checks the setting on every service call. `GCP.lang` is the player's platform language (en, zh, zh-TW, ja, ko, es), for games that declare `languages.follows_platform`. Pressing Play signs a play session (valid six hours and renewed by the SDK while the player stays signed in; for a free trial, only as long as the trial has left) that names the game, the environment and the player. The SDK keeps the token away from your page's scripts and attaches it to every service call. A session is bound to the player's platform sign-in: if they sign out or switch accounts, the platform refuses the session, the SDK pauses the game and the game page closes it. Your game never has to handle accounts or sign-in itself; save as you go, and the next session (as whichever player is signed in) loads its own saves.

Accounts, sign-in, purchases and the store page belong to the platform. A game never handles passwords or emails and must not ask for anything personal.

## Cloud saves, player stats and the play record

Per player and per game, stored in the platform database and following the player to any device and any later version.

```js
const state = (await GCP.save.get('progress')) || { v: 1, level: 1 };   // before GCP.ready()
await GCP.save.set('progress', state);                                  // JSON, 256 KB per key, 64 keys
await GCP.playerStats.add('levels_cleared');                            // add, max, min, set, get, all
const record = await GCP.playRecord();   // sessions, seconds, first and last played, stats, best scores, save totals
```

- The server enforces isolation: a game can never read or change another player's data, or another game's.
- The verifier plays under a throwaway identity, so it always starts with no save.
- Players see their progress on the game page and can reset it. Creators see totals and averages with `game_data {action: "summary"}`, never one player's data.
- Offline, saves fall back to a per-player copy in `localStorage` and `set` resolves to `false`; stats resolve to `null`.

Limits: 64 save keys and 64 stat names per player; 256 KB per value; save keys up to 120 characters, stat names up to 60. Details and save-format advice: `get_started {topic: "saves"}`.

## Shared game data

Game-wide JSON every player reads with `GCP.shared.get(key)`. Only you (through `game_data {action: "set"}`) and the game's server code can write it, so players cannot tamper with it. Use it for level packs, balance numbers, events or a message of the day that change without a new version. Seed preview and live separately (`env: "preview"`). 256 KB per value.

## Leaderboards

```js
await GCP.leaderboard.submit('time', 42.5, 'asc');           // keeps each player's best; 'asc' = lower is better
const rows = await GCP.leaderboard.top('time', 10, 'asc');   // [{ name, score, me }], 1 to 100 rows
```

Board names are yours (up to 40 characters), so per-level or per-season boards are just names. `game_data {action: "leaderboard"}` reads one and `clear_leaderboard` resets it. Scores sent from the page can be forged by a determined player: for boards that matter, check the run in server code and keep the trusted score there.

## Realtime multiplayer rooms

```js
const room = GCP.room('ABCD', { max: 4 });
room.on('open', ({ id, host, peers, state }) => { /* joined; state is the host's last snapshot */ });
room.on('message', (data, from, meta) => { /* meta.at is the sender's clock, for GCP.smooth */ });
room.on('join', (peer) => {}); room.on('leave', (id) => {}); room.on('host', (newHostId) => {});
room.send({ type: 'input', x, y });          // to everyone else; room.send(d, peerId) or room.send(d, 'host')
room.send(new Float32Array([x, y]));         // binary: arrives as an ArrayBuffer
if (room.isHost) room.setState(world);       // snapshot that late joiners receive
room.rtt;                                    // round trip to the room in ms
```

**What rooms are for.** Rooms are host-authoritative: one player's browser runs the game for everyone. That suits co-op, party games, casual versus among friends and turn-based games. It does not suit ranked or high-intensity competitive play (shooters, fighting games, competitive sports): the host decides hits and can cheat, every guest's lag depends on the host's connection, and there is no lag compensation. Tell the developer this before building such a game on rooms.

- One Cloudflare Durable Object per game, environment and room code, created when the first player joins. The first player in is the host; when the host leaves, the longest-connected player takes over and everyone gets a `host` event.
- Rooms relay messages and keep one snapshot. They do not run game logic: the host is the authority (host-authoritative model). For turn-based games the host checks each move and stores the state.
- A room is created in the region of the player who opens it, so friends in one region get a nearby room.
- The SDK reconnects by itself (up to six tries with backoff). An empty room forgets everything, including the snapshot: keep anything that spans sessions in server code or saves.
- Each player has a message budget per second. Past it, messages are dropped and the sender gets an `error` with `code: 'rate_limited'`; a player who keeps flooding for 10 seconds is disconnected (close code 4008).
- `game_room` shows who is in a room, who hosts and the stored snapshot, and resets a stuck room. `get_stats` shows room occupancy.

Limits: 16 players per room by default (at most 64), 64 KB per message, 60 messages a second per player by default (bursts of twice that) and 256 KB a second, 256 KB of state, room codes up to 40 characters. Messages are JSON, or binary when you send an ArrayBuffer or typed array.

Smooth remote movement with `GCP.smooth()`: push each sample with `meta.at`, read `value()` every frame. Verification can prove two browsers share one world if you register `GCP.test.onTwoPlayers`. Details: `get_started {topic: "multiplayer"}`.

## Game server code

Optional `server/index.js` in the bundle, run inside the game's own Worker for requests under `/api/`:

```js
// server/index.js
export default {
  async fetch(request, env) {
    // env.GAME = { id, slug, version, env }; env.player = { id, name } or null
    // env.store.get/set/delete/list(key, { player }) — without player: shared data; with player: that player's save
    return Response.json({ ok: true });
  },
};
// in the game: const r = await GCP.server('daily'); const daily = await r.json();
```

It runs on the standard Workers runtime (fetch, Web Crypto, streams) with no access to the platform's own data or secrets and no bindings of its own (no KV, D1, Durable Objects, cron or AI). Use it to validate scores, run daily challenges or keep a world that lasts between sessions.

**Limits per request.** Each request to server code has a CPU time budget and a budget of outgoing requests (`fetch()` and every `env.store` call count); the numbers for this platform are in `platform_services` under `server_code.limits` (`cpu_ms_per_request`, `outgoing_requests_per_request`, and any `blocked_hosts`). A request past either budget fails with HTTP 503 and `{"code": "limit_exceeded"}`: tell the developer which budget was hit and move the heavy part out of the request (precompute while building, cache in `env.store`, or split the work over several calls). Read everything from the `env` argument of `fetch`: `import { env } from 'cloudflare:workers'` and `process.env` are empty in game Workers.

**`server/` is never served.** The game Worker answers 404 for every path under `server/`, in preview and live, so players cannot download your server code; every other file in the bundle is public. There is no secrets store: a key written into `server/` stays readable to you through MCP and to the platform's automated checks, so use keys you can revoke and never put one in a client file.

Whether server code is allowed on this platform is shown by `get_started` under `account.limits.server_code`.

## Display, fullscreen and devices

Play starts the game in a window on its page, and on phones and tablets straight in fullscreen. The Fullscreen button under the game, Alt+Enter (also pressed inside the game) and `GCP.fullscreen()` switch. In fullscreen the platform menu (Resume, Exit fullscreen, Quit game) opens from a small corner button and from an Esc the game does not use; in Chromium browsers Esc is locked to the game and only holding it leaves. However fullscreen ends (Firefox and Safari on Esc, iPad's swipe from the top, Android's back), the game carries on in its window. A game that stops answering for 4 s gets a card with Wait and Quit game. On touch screens the SDK stops pinches and overscroll in the game from zooming or dropping fullscreen. `GCP.display` is `{ fullscreen, mode, orientation, touch, edgeToEdge, safe, paused, menu }` and `GCP.onDisplay(fn)` tells you when it changes; show on-screen controls when `touch` is true, and pause while `paused` is true. `GCP.onEscape(fn)` is the Escape rule: Esc closes the game's open menu first (fn returns true), and an Esc with nothing open opens the platform menu. `GCP.menu()` opens that menu and `GCP.quit()` quits, for a game with its own pause screen. `GCP.fullscreen(false)` goes back to the window. `GCP.setDisplay({ orientation, exitButton, edgeToEdge })` sets the orientation, where the platform's menu button sits, and whether the game fills the whole screen (notch included) in fullscreen. In fullscreen the game sits inside the safe area, or edge to edge with the insets in `GCP.display.safe` and the `--gcp-safe-*` CSS variables when the game asked for `edgeToEdge`. Fullscreen, gamepad, pointer lock and audio after a gesture are allowed in the frame; camera, microphone and geolocation are not.

## Compatibility requirements

`compatibility {action: "check"}` shows what the platform detected in the code and suggests a block; `compatibility {action: "declare"}` writes it to `gcp.json`. Each version carries graphics API, GPU, features, input, devices, orientation, memory, minimum browsers and known issues. The store page lists them and checks the player's browser before launch.

## Verification and test hooks

Every preview is opened in a real browser with no GPU. It must call `GCP.ready()` within 30 seconds (default), keep rendering, show a non-blank picture, survive keyboard, mouse and touch, load every file and throw no uncaught errors. `deploy_preview {dry_run: true}` runs only the static checks.

```js
GCP.test.onAutostart(() => startGame());               // skip menus when the verifier opens the game
GCP.test.onPlaythrough(async (t) => {                  // play your own rules to the end; each t.step is reported
  t.step('collect the key'); await t.key('ArrowRight', 800); await t.until(() => game.hasKey, 5000, 'the key');
});
GCP.test.onTwoPlayers(async (t, role) => ({ players: room.peers.length + 1, world: JSON.stringify(world) }));
```

Limits (defaults): play-through 30 seconds and 60 steps. WebGPU-only games are verified by a short clean play of the preview by their creator. Each check, why it fails and the fix: `get_started {topic: "versions"}`.

## Publish checks

Before a verified version goes live it is compared with other creators' live games (code fingerprints that survive renaming, identical files, screenshot hash; templates, kits and common libraries ignored), checked for content and abusive code, and confirmed to be a web game. Workers AI decision models review only borderline copies; every version's content is reviewed from frames taken while the verification browser plays it. Adult games (sexual content, graphic violence, other mature themes) are allowed when `content` declares them: they are listed as 18+ with a blurred cover, and players confirm a warning before they start. Undeclared sexual content or realistic violence fails the review (`get_started {topic: "metadata"}`). `publish` says which check refused a version and how to fix it.

## Marketplace, payments and payouts

- `update_project` sets the title, tagline, description, tags, controls text and cover (png, jpg or webp under 2 MB). `game_metadata` detects, suggests and declares the standardized store metadata (genre, tags from the platform list, languages, players, content and age rating, session length, progress, accessibility); publishing is refused until the required fields are on record (`get_started {topic: "metadata"}`). Players rate and review from the game page after a counted play (30 seconds of active play by default).
- `update_project {price_cents}` sells the game for a one-time price (default range $1.99 to $99.99); the platform keeps its cut (default 10%) and credits the rest after a holding period (default 7 days). `trial_minutes` offers a free trial kept per account on the server; when it ends the SDK pauses the game and asks the player to buy, and the data services answer 402.
- Horylo LLC, the company that operates the platform, is the seller of every paid game; Stripe Checkout shows it as the seller and links the Terms and Refund policy. Payments run on Stripe Checkout and payouts on Stripe Connect; the creator withdraws from the console once the balance reaches the minimum (default $50). Publishing needs a one-time creator license; building and previewing are free.
- The game never takes payments itself and never needs to check ownership: the platform only opens a paid game for owners and trial players.

Ask the user before setting or changing a price.

## Analytics and runtime errors

`get_stats` returns players online now, room occupancy, sessions, unique, new and returning players, play time and session lengths, devices, browsers, versions, trials, sales, ratings, recent reviews and the errors real players' browsers reported, over 1 to 90 days. Only real players of the live game count; your own plays and the verifier do not. There are no custom events: count what matters with player stats, which `game_data {action: "summary"}` aggregates.

## Open implementations

`find_implementations` and `get_implementation` show how other creators' live games were built, when they opted in, never their code. Ask the user before sharing theirs (`update_project {open_implementation: true}`).

## Agent access

The MCP server is at `{{ORIGIN}}/mcp` (Streamable HTTP, stateless). Sign-in is OAuth 2.1 with PKCE and dynamic client registration; there are no API keys. Agents without a browser use device sign-in (`POST {{ORIGIN}}/oauth/device`, the user approves at `{{ORIGIN}}/device`). Access tokens last an hour by default: on a 401, refresh with the refresh token instead of signing in again. The user can revoke an agent in the console.

How to discover services:

- `platform_services`: the catalog with this platform's live limits; `platform_services {service: "multiplayer"}` for one entry.
- `get_started`: rules, workflow, account and a short overview; `get_started {topic}` for a guide (`contract`, `metadata`, `versions`, `storage`, `saves`, `multiplayer`, `services`).
- MCP resources: `gcp://services` (the catalog as JSON) and `gcp://guides/<topic>`.
- On the web: `{{ORIGIN}}/guides/services.md` and the Docs page, `{{ORIGIN}}/docs#services`.

## What the platform does not provide

Plan around these instead of looking for them.

| Need | What to do instead |
| --- | --- |
| AI models for games (text, images, speech) | The platform uses Workers AI only for its own checks. Generate assets while building, or call an outside API from server code (never served to players); never put a key in a client file. |
| In-game purchases, currencies sold for money, subscriptions | Sell the whole game or offer a free trial. Currencies earned by play live in saves or stats. |
| Checking from game code whether the player bought the game | Not needed: only owners and trial players can open a paid game. |
| Achievements and badges | Track milestones with `GCP.playerStats` and show them in the game. |
| Friends, chat, invites, player profiles | Share a room code; relay chat over `room.send` and moderate what players type. |
| Matchmaking and a list of open rooms | Fixed or shared room codes; for a lobby list, players join a `lobby` room and advertise their codes there. |
| Server-authoritative simulation inside rooms | The host is the authority; validate results that matter in server code. Ranked or high-intensity competitive games need a neutral server that rooms do not provide: tell the developer before building one. |
| Persistent rooms and worlds while nobody is connected | Store the world with `env.store` in server code, or in the host's save, and load it when the room opens. |
| Secrets, environment variables or extra bindings (KV, D1, R2, cron) for server code | Use `env.store` for data. A key can live in `server/` (never served), but there is no secrets store or rotation: prefer keys you can revoke. |
| Asset hosting beyond the game's storage (a CDN or bucket for large downloads) | Generate content from code, or load it at run time from a host the developer controls (any HTTPS host with CORS). `game_storage` explains both and asks for more storage when a game truly needs it. |
| Custom analytics events | Count with player stats; `game_data summary` aggregates them. |
| Uploads from players (screenshots, levels, avatars) | Small player-made content as JSON in saves, or in shared data through server code. |
| Push notifications and email to players | None; use shared data for in-game announcements. |
| Camera, microphone and geolocation | Blocked in the play frame. |
| Native, mobile, console or desktop builds and app-store links | Web games only; engines with a web export are welcome. |

## A game that uses the services

```js
// index.html loads this as <script type="module" src="main.js">
const save = (await GCP.save.get('progress')) || { v: 1, best: 0 };
const room = GCP.room(new URLSearchParams(location.search).get('room') || 'lobby');
const others = new Map();                                 // peer id -> GCP.smooth buffer
room.on('message', (m, from, meta) => {
  if (!others.has(from)) others.set(from, GCP.smooth());
  others.get(from).push(m, meta.at);
});
room.on('leave', (id) => others.delete(id));

let started = false;
function frame() {
  update(); draw([...others.values()].map((b) => b.value()));
  if (!started) { started = true; GCP.ready(); }          // once, after the first playable frame is drawn
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
setInterval(() => room.send({ x: me.x, y: me.y }), 66);  // about 15 per second

async function gameOver(score) {
  save.best = Math.max(save.best, score);
  await GCP.save.set('progress', save);
  await GCP.playerStats.add('runs');
  await GCP.leaderboard.submit('score', score);
  showBoard(await GCP.leaderboard.top('score', 10));
}
document.addEventListener('visibilitychange', () => { if (document.hidden) GCP.save.set('progress', save); });
```
