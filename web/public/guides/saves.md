# Saves, leaderboards and server code

Each game runs on its own origin, and the preview and live versions are different origins. `localStorage` therefore does not follow a player from device to device or from one version's address to the next. The platform services below do.

## Cloud saves

```js
await GCP.save.set('slot1', { level: 3, hp: 80, pos: [12, 0, -4] });   // JSON, up to 256 KB per key
const data = await GCP.save.get('slot1');                              // null for a new player
await GCP.save.remove('slot1');
```

- Saves belong to the signed-in player and this game. Preview saves are kept apart from live saves.
- Calls never throw. Offline, they fall back to `localStorage` and `set` resolves to `false`.
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
// server/index.js — runs inside this game's own Cloudflare Worker, for requests under /api/
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
| `env.player` | `{ id, name }` of the caller, or `null` when the request carries no valid play session |
| `env.store` | `get(key, { player })`, `set(key, value, { player })`, `delete(key, { player })`, `list(prefix, { player })`. Without `player` the data is game-wide and is what `GCP.shared.get` reads. With `player` it is that player's save, the same data `GCP.save` uses. |

Rules for server code: it is an ES module with a default export that has `fetch`; it may import other files under `server/` by relative path; it has no access to the platform's own data or secrets; keep each request short. `check_project` validates the syntax, and the platform setting that allows server code is reported by `get_account`.

## Privacy

Store what the game needs and nothing else. `GCP.player.name` is a display name chosen by the player; do not ask for emails, real names or anything personal inside a game.
