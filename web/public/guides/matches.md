# Server-run matches

For competitive real-time games (shooters, fighting games, sports, racing, arena games), the platform runs the match itself. Your `server/match.js` runs on Cloudflare at a fixed tick in a Durable Object of the game's own Worker, placed in the region most of the players are in. Each player's browser only sends inputs and draws what the server sends back. No player can decide hits, move faster than your rules allow, or see what you do not send them.

Use [rooms](multiplayer.md) for co-op, party and casual games among friends. Use matches when players compete for something that matters.

## How it fits together

1. `GCP.match.find({ queue, players })` puts the player in the matchmaker's queue. It groups players by region and rating, signs a ticket for each, and connects them to the match.
2. The match waits for everyone (at most 15 s, then it starts with at least `min` players), calls `init()`, and then, `tickRate` times a second:
   - applies each player's next input with `input()`, in the order they sent them;
   - advances the world one step with `tick()`;
   - sends each player a snapshot: the whole view the first time and every 5 s, otherwise only what changed, with the number of the last input of theirs it applied.
3. The SDK draws the player's own character at once by running your `predict()` on their inputs, and corrects it smoothly when a snapshot disagrees. Everyone else is drawn a little in the past, between two snapshots, so they move smoothly.
4. Each input carries the moment the player was looking at. `ctx.hitscan()` checks a shot against the hitboxes as they were at that moment, so a shot that was on target on the shooter's screen hits (lag compensation, at most `maxRewindMs` back).
5. `ctx.end({ ranking })` finishes the match. The ranking moves each player's rating in that queue.

## Files

```
shared/rules.js     movement and rules, imported by the server and by the page
server/match.js     the match: export default { ... }
index.html, game.js the page: GCP.match.find(...)
```

`server/` is never served to players. `shared/` is served like any other file, so the page can import it. `server/match.js` may import relative `.js` files under `server/` and `shared/`; nothing else.

## server/match.js

```js
import { move, SPEED } from '../shared/rules.js';

export default {
  tickRate: 30,            // steps a second, 10 to 60
  snapshotRate: 30,        // snapshots a second, at most tickRate (a divisor of it is best)
  maxRewindMs: 200,        // how far back hit checks may look, at most 400
  // rejoinMs: 600000,     // let a player who reloaded or closed the browser come back for this long (see "Coming back")

  init(ctx) {              // ctx.players: [{ id, name, team }] of the players present
    const s = { players: {}, over: false };
    ctx.players.forEach((p, i) => { s.players[p.id] = { x: i * 4, y: 0, a: 0, hp: 100, kills: 0, team: p.team }; });
    return s;              // the match state: plain JSON (numbers, strings, arrays, objects)
  },
  join(s, p) { s.players[p.id] = { x: 0, y: 0, a: 0, hp: 100, kills: 0, team: p.team }; },   // late arrival
  leave(s, p) { delete s.players[p.id]; },                                                 // left, or away too long

  // One input of one player. Treat every field as hostile: check types, clamp numbers.
  input(s, p, inp, ctx) {
    const me = s.players[p.id];
    if (!me || me.hp <= 0 || !inp || typeof inp !== 'object') return;
    move(me, inp, ctx.dt);                                  // the same function the page uses to predict
    if (inp.fire) {
      const hit = ctx.hitscan(p.id, { origin: [me.x, me.y], dir: [Math.cos(me.a), Math.sin(me.a)], range: 60 });
      if (hit) {
        const t = s.players[hit.id];
        t.hp -= 34;
        ctx.emit({ hit: hit.id, by: p.id, at: hit.point });  // an event for everyone (or ctx.emit(data, playerId) for one)
        if (t.hp <= 0) { me.kills++; Object.assign(t, { hp: 100, x: ctx.random() * 40 - 20, y: ctx.random() * 40 - 20 }); }
      }
    }
  },

  tick(s, ctx) {           // one step of ctx.dt seconds
    const best = Object.entries(s.players).sort((a, b) => b[1].kills - a[1].kills);
    if (best[0] && best[0][1].kills >= 10) ctx.end({ ranking: best.map(([id]) => [id]) });
  },

  // Everything a shot can hit: circles/spheres { id, x, y, z?, r } or boxes { id, min: [..], max: [..] }.
  hitboxes(s) { return Object.entries(s.players).filter(([, p]) => p.hp > 0).map(([id, p]) => ({ id, x: p.x, y: p.y, r: 0.6 })); },

  // Optional: what one player may see. Leave it out to send the whole state to everyone.
  // view(s, player) { return { players: nearby(s, player.id) }; },
};
```

`ctx` in every call:

| | |
|---|---|
| `ctx.tick`, `ctx.dt`, `ctx.time` | the step number, seconds per step, ms since the start |
| `ctx.players` | `[{ id, name, team, connected }]` |
| `ctx.random()` | seeded random numbers; use it instead of `Math.random()` so a match can be replayed |
| `ctx.hitscan(shooterId, { origin, dir, range, ignore })` | the nearest hitbox along the ray as the shooter saw it: `{ id, distance, point }` or `null` |
| `ctx.rewind(playerId)` | the hitboxes as that player saw them, for your own checks (melee, cones, projectiles at spawn) |
| `ctx.emit(data, to)` | an event to everyone, or to one player |
| `ctx.end(result)` | ends the match after this step: `{ ranking: [[first], [second, tiedSecond], ...], scores, data }` |
| `ctx.log(...)` | a line in the Worker log |
| `ctx.queue`, `ctx.options` | the queue and `{ mode }` the match was found with |

## shared/rules.js

```js
export const SPEED = 6;
export function move(p, inp, dt) {
  const mx = Math.max(-1, Math.min(1, Number(inp.mx) || 0)), my = Math.max(-1, Math.min(1, Number(inp.my) || 0));
  const len = Math.hypot(mx, my) || 1;
  p.x += (mx / len) * SPEED * dt; p.y += (my / len) * SPEED * dt;
  if (Number.isFinite(inp.a)) p.a = inp.a;
  p.x = Math.max(-50, Math.min(50, p.x)); p.y = Math.max(-50, Math.min(50, p.y));
  return p;
}
```

## The page

```js
import { move } from './shared/rules.js';

const match = GCP.match.find({
  queue: 'duel', players: 2,                  // or players: 8, min: 4 (free-for-all), or teams: 2
                                              // or min: 1 to start alone after 30 s and fill the seats with bots
  // code: 'ABC123',                          // a private lobby among friends instead of the public queue
  predict: (me, input, dt) => move(me, input, dt),   // your own movement runs at once, the server corrects it
});
match.on('queued', ({ waiting, waited }) => showSearching(waited));
match.on('lobby', ({ code, players, owner, need }) => showLobby(code, players));   // private codes only
match.on('found', ({ players }) => showVersus(players));
match.on('start', () => hideMenus());
match.on('event', (e) => { if (e.hit) flash(e.at); });
match.on('end', (result) => showResult(result.ranking));
match.on('error', (e) => showError(e.message));          // e.code: 'standalone', 'kicked', 'session_ended', ...

addEventListener('mousedown', () => match.press('fire'));   // one-off actions: never lost between two ticks

function frame() {
  match.input({ mx: keys.right - keys.left, my: keys.down - keys.up, a: aimAngle });  // held input, sent every tick
  const { me, others, state } = match.view();
  if (me) drawPlayer(me);
  for (const id in others) drawEnemy(others[id]);
  if (state) drawScores(state.players);
  requestAnimationFrame(frame);
}
frame();
```

- `view().me` is your entity, predicted. `view().others` is everyone else, played back smoothly. `view().state` is the newest snapshot (scores, the HUD). Fields named `a`, `angle`, `yaw`, `pitch`, `rot` or `heading` blend the short way round; add others with `angles: ['turret']`.
- The SDK finds entities in `view.players` (or `view.entities`), keyed by player id. If your state keeps them elsewhere, pass `entities: (view) => view.units`.
- `match.rtt` is the round trip in ms; `match.phase` is `searching`, `connecting`, `running`, `reconnecting`, `ended` or `closed`. A dropped connection reconnects by itself; the player keeps their place for 20 s.
- `match.cancel()` leaves the queue or the match. Leaving a match is for good: `leave()` runs at once, and `GCP.match.rejoin()` will not lead back into it.

## Coming back to a match

A dropped connection reconnects by itself, and the player keeps their place for 20 s. A page reload or a closed browser is different: the page that held the match is gone. To let those players back in:

1. In `server/match.js`, set `rejoinMs`: how long after the 20 s a player may still come back (up to an hour). When the 20 s are over, `leave(state, player)` runs with `player.final` false, and your rules decide what happens to their things meanwhile (a bot plays for them, their character stands still, their turn is skipped). When they return, `join(state, player)` runs with `player.back` true. If they do not return in time, or they leave on purpose, `leave()` runs once more with `player.final` true.
2. In the page, call `GCP.match.rejoin(opts)` once when the game opens, before showing the menu as the place to be. It takes the drawing options of `find()` (`predict`, `entities`, `angles`, `delay`) and returns the same match object.

```js
const back = GCP.match.rejoin({ predict });
back.on('start', () => showMatch(back));     // back in: snapshots, events and inputs work as after find()
back.on('none', () => showMenu());           // no match to go back to: it is over, or the player left it
```

- `found` fires first with `{ match, players, queue, mode, rejoin: true }`; `match.queue` and `match.mode` say which kind of match it is.
- `none` (then `close`) is the ordinary answer when there is nothing to go back to. Show the menu.
- The state is whatever your rules made of it while the player was away. Draw from the first snapshot; do not assume the round the player left in.
- While a player may still come back, the match is not ended for being empty. End it from `tick()` when it has no reason to go on (everyone has been away for some minutes), or it runs until the last `rejoinMs` is over.
- A match is lost when the game is deployed again while it runs; `rejoin()` then answers `none`.
- Opened in a second tab, the game takes the match over there and the first tab's connection closes (code 4002).

## Rules of thumb

- **Movement comes from inputs, never from positions the page sends.** The page sends what is pressed and where it aims; `input()` turns that into movement with `ctx.dt`. That is what makes speed hacks and teleports impossible.
- **Take the shot's origin from the server's state of the shooter**, not from the input, and check the fire rate there too (keep a `nextShot` tick per player).
- **Keep the state small and flat.** Round numbers you do not need exact (`Math.round(x * 100) / 100`); small changes make small deltas. A snapshot over 64 KB for a player is not sent.
- **Hide what players must not know** (positions behind walls, the other hand of cards) with `view(state, player)`. Whatever a snapshot contains, a cheater can read.
- **Predict only your own movement.** Do not predict hits or deaths; wait for the event.
- **Keep each step cheap.** All of a match's steps run on one Durable Object; 30 to 60 steps a second of plain JavaScript over a few dozen entities is fine, physics over hundreds is not.
- **End every match with a ranking** so ratings move. `ctx.end({ ranking: [[winner], [loser]] })`; a draw is `[[a, b]]`.

## Limits

| | |
|---|---|
| Players per match | the platform setting (16 by default), at most 64 |
| Tick rate | 10 to 60 a second (30 by default) |
| Rewind | `maxRewindMs` up to 400 ms (200 by default) |
| One input | 2 KB; 3 messages per tick on average; at most 8 waiting (older ones are dropped) |
| One snapshot | 64 KB per player |
| Waiting for players | 15 s, then the match starts with at least `min` |
| Reconnecting | 20 s, then `leave()` runs |
| Coming back after a reload | `rejoinMs` after that, 0 (never) by default, at most 1 hour |
| Duration | 1 hour |
| Errors | more than 10 errors in your code within 100 ticks stops the match; a player whose inputs keep making `input()` throw is removed |

## Matchmaking and ratings

- One queue per `queue` name, number of `players`, `min`, `teams` and `mode`. The player who has waited longest is matched first, with the closest ratings in the same region. The search widens with the wait: neighbouring regions after 5 s, further after 10 s, anywhere after 20 s; the allowed rating gap grows by 25 points a second. After 30 s a match starts with at least `min` players.
- `min` is 1 to `players` (the default is `players`). With `min: 1`, a player who is still alone after 30 s starts a match by themselves: `ctx.players` in `init()` holds only them, and your `server/match.js` fills the other seats, with bots for example. Bots in `ctx.end({ ranking })` are ignored, so a match with one person in it does not move ratings.
- `teams: 2` splits the players into two teams of even strength by rating; each player's `team` (0, 1, ...) is in `ctx.players` and `match.players`.
- `code: 'ABC123'` opens a private lobby: the `lobby` event lists who is in; it starts when full, or when the player who opened it calls `match.start()` with at least `min` players (alone, with `min: 1`).
- Ratings start at 1000 per player, game, environment (preview or live) and queue, and change after every match that ends with a ranking. Verification runs do not count.

## Testing

- Two players: in the verifier's two-player check, `GCP.test.twoPlayers` is `{ role, code }` in both pages, and the two pages are two different players (each has its own verifier id, so the lobby lists both). Have both call `GCP.match.find({ code: GCP.test.twoPlayers.code, players: 2 })` from the autostart hook (no room is needed), and in `GCP.test.onTwoPlayers` wait until `match.phase === 'running'`, check that each page sees the other player move, and return `{ players: match.players.length, world }` with `world` built from what both must agree on (the server's state, not each page's prediction). When the check fails, its detail lists each page's match: the lobby code, phase, player id, who the lobby listed and how many snapshots arrived.
- Opened outside the platform (a file on disk), `GCP.match.find()` fails with the `standalone` error: matches need the platform.
- `ctx.log()` lines and your code's errors appear in the game Worker's log.
