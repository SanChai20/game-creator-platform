# Player progress, saves, leaderboards and server code

Each game runs on its own origin, and the preview and live versions are different origins. `localStorage` therefore does not follow a player from device to device or from one version's address to the next. The platform services below do.

## Player progress: what every game should do

Every game should keep each player's progress with the platform, not only in `localStorage`. Every player is signed in when a game opens (only if the platform's administrators open free games to guests does a player have a guest id kept per browser instead, with `GCP.player.guest` true), so `GCP.player.id` always identifies one player, and each of the services below belongs to one player in one game:

- The platform takes the game, the environment (preview or live) and the player from the signed play session on every call. Nothing in a request can name another player or another game, so a game cannot read or overwrite anyone else's progress, even by mistake.
- Preview data is kept apart from live data. The verification browser plays under a throwaway identity of its own, so it always starts from no save and never touches your own progress.
- Players see their own progress on the game page and can reset it there. You see totals and averages with `game_data {action: "summary"}`, never one player's data.

A good default for any game:

```js
const SAVE = 'progress';
let state = migrate(await GCP.save.get(SAVE)) || { v: 1, level: 1, unlocked: [] };   // before GCP.ready()
// …at a checkpoint (level cleared, item found) and when the tab is hidden:
GCP.save.set(SAVE, state);
GCP.playerStats.add('levels_cleared');
```

## Recorded for you

Without any code, the platform records for each player in each game: sessions, active play time (tab visible, frames advancing), first and last played, the last version played and their best leaderboard scores. Read it in the game with:

```js
const r = await GCP.playRecord();
// { sessions, seconds, first_played, last_played, last_version, stats: {…}, best: { board: score }, saves: { keys, bytes, last_saved } }
```

Use it for a "welcome back" message, a total-time line on a stats screen, or to skip a tutorial for a returning player.

## Continue playing

Signed-in players get a Continue row on the store front and in their library with every game they played, most recent first. Your game is on it without any code: the platform shows its play time, when it was last played and when it last saved. Pressing Continue opens the game at once. Two optional hooks let the row say more and land the player in their run:

```js
// 1. Where the player is, in words they recognise and in their language (GCP.lang). Call it where you save.
GCP.resume.set({ label: 'Act 2, Floor 14', detail: 'Ember Knight, 3 relics', progress: 0.4 });
// label: up to 60 characters (required), detail: up to 80, progress: 0..1 (a bar on the row). At most one call reaches the
// platform every 5 seconds; the latest value wins and a waiting one is sent when the tab is hidden.

// 2. The run is over (death in a roguelite, the credits): nothing to resume.
GCP.resume.clear();

// 3. Opened with Continue: skip the title screen and load the saved run, when there is one.
const save = migrate(await GCP.save.get('progress'));
if (GCP.launch.continue && save?.run) startRun(save.run); else showTitle(save);
```

`GCP.resume.get()` returns what was last set (or `null`), and `GCP.playRecord().resume` carries it too. The verifier keeps none. A player who resets their progress on the game page clears it.

## Player stats

Named numbers per player and game, updated on the server so two tabs never lose an increment:

```js
await GCP.playerStats.add('coins', 25);      // +25 (default +1). Resolves to the new value
await GCP.playerStats.max('best_combo', 17); // keeps the highest
await GCP.playerStats.min('fastest_lap', 41.2);
await GCP.playerStats.set('chapter', 3);
const all = await GCP.playerStats.all();     // { coins: 125, best_combo: 17, … }
```

Up to 64 names per player, each 1 to 60 characters. Offline, the calls resolve to `null`. Players see these numbers on the game page, so use readable names (`levels_cleared`, not `lc`).

## Cloud saves

```js
await GCP.save.set('slot1', { level: 3, hp: 80, pos: [12, 0, -4] });   // JSON, up to 256 KB per key
const data = await GCP.save.get('slot1');                              // null for a new player
await GCP.save.remove('slot1');
```

- Saves belong to the signed-in player and this game. Preview saves are kept apart from live saves.
- Calls never throw. Offline, they fall back to a copy in `localStorage` that is kept per player and environment (two people sharing a browser never see each other's saves), and `set` resolves to `false`.
- Up to 64 keys per player, 256 KB each.
- Do not write every frame. Save at checkpoints, every 20 to 30 seconds while playing, and when the tab is hidden:

```js
let dirty = false;
const save = () => { if (!dirty) return; dirty = false; GCP.save.set('slot1', snapshot()); };
setInterval(save, 25000);
document.addEventListener('visibilitychange', () => { if (document.hidden) save(); });
```

`visibilitychange` is the last moment you can rely on; `beforeunload` often does not fire on phones.

### Save format advice

- Put a `v` field in every save and migrate old shapes when you load them: a published game will meet saves from its earlier versions.
- Save the seed and what the player changed, not the whole generated world.
- Validate what you load. Treat a save as untrusted input: clamp numbers, default missing fields, and start fresh when it does not parse.

## Leaderboards

```js
const r = await GCP.leaderboard.submit('time', 42.5, 'asc');   // 'asc': lower is better. Default 'desc'.
const rows = await GCP.leaderboard.top('time', 10, 'asc');     // [{ name, score, me }]
```

The platform keeps each player's best score per board. Board names are yours (`'score'`, `'level-3-time'`). Scores submitted from the page can be forged by a determined player; for boards that matter, submit from server code after checking the run.

## Shared data

```js
const daily = await GCP.shared.get('daily');       // readable by every player, written only by the game's server code
```

## Server code

Most games need none. Add it when something must be decided where players cannot tamper with it (validating a score, a daily challenge, a shared world). Put a module at `server/index.js` in the bundle:

```js
// server/index.js — run by the platform in a sandbox of its own, for requests under /api/
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.endsWith('/api/daily')) {
      const day = new Date().toISOString().slice(0, 10);
      let daily = await env.store.get('daily');
      if (!daily || daily.day !== day) { daily = { day, seed: Math.floor(Math.random() * 1e9) }; await env.store.set('daily', daily); }
      return Response.json(daily);
    }
    if (url.pathname.endsWith('/api/finish') && request.method === 'POST') {
      if (!env.player) return Response.json({ error: 'Sign in to play.' }, { status: 401 });
      const run = await request.json();
      if (!plausible(run)) return Response.json({ error: 'Rejected.' }, { status: 400 });
      const best = (await env.store.get('best', { player: env.player.id })) || 0;
      if (run.score > best) await env.store.set('best', run.score, { player: env.player.id });
      return Response.json({ best: Math.max(best, run.score) });
    }
    return new Response('Not found', { status: 404 });
  },
};
function plausible(run) { return Number.isFinite(run.score) && run.score >= 0 && run.score < 1e7 && run.ms > 5000; }
```

Call it from the game with the SDK, which attaches the player's identity:

```js
const daily = await (await GCP.server('daily')).json();
const res = await GCP.server('finish', { method: 'POST', body: JSON.stringify({ score, ms }) });
```

What the server module receives in `env`:

| Name | What it is |
| --- | --- |
| `env.GAME` | `{ id, slug, version, env }` |
| `env.player` | `{ id, name, guest }` of the caller, or `null` when the request carries no valid play session |
| `env.store` | `get(key, { player })`, `set(key, value, { player })`, `delete(key, { player })`, `list(prefix, { player })`. Without `player` the data is game-wide and is what `GCP.shared.get` reads. With `player` it is that player's save, the same data `GCP.save` uses. |

Rules for server code: it is an ES module with a default export that has `fetch`; it may import other files under `server/` by relative path; it has no access to the platform's own data or secrets (and `import { env } from 'cloudflare:workers'` is empty: use the `env` argument); keep each request short, because each one has a CPU time budget and a budget of outgoing requests, counting `env.store` calls (see `platform_services`, `server_code.limits`), and a request past either fails with HTTP 503 and code `limit_exceeded`. Files under `server/` are never served to players (the game host answers 404 for them), but there is no secrets store: a key written there stays readable to you and to the platform's checks, so use keys you can revoke. `deploy_preview` validates the syntax, and whether this platform allows server code is shown by `get_started` under `account.limits`.

## Privacy

Store what the game needs and nothing else. `GCP.player.name` is a display name chosen by the player; do not ask for emails, real names or anything personal inside a game.
