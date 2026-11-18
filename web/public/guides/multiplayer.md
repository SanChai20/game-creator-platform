# Multiplayer

The platform runs realtime rooms for every game: a WebSocket relay on Cloudflare Durable Objects, one object per room, created in the region of the player who opens it. You do not deploy or pay for a server. How you use a room is up to the game.

## What rooms are for, and what not

Rooms are **host-authoritative**: one player's browser (the host) runs the game, and the room relays messages between players. This is the model most co-op and party games use, and it is what rooms do well:

- co-op games (2 to 8 players), party games and casual versus among friends
- turn-based and slow games
- shared building and farming worlds while players are connected

It is **not** a fit for ranked or high-intensity competitive real-time play (shooters, fighting games, competitive sports and racing):

- the host decides hits and can change its own copy of the game, so the host can cheat;
- every guest's result travels guest → room → host → room → guest, so the host's connection sets everyone's lag;
- there is no lag compensation (rewinding hitboxes to what the shooter saw);
- WebSockets run over TCP, so a lost packet on Wi-Fi or mobile briefly holds back every later message.

For those, use **[server-run matches](matches.md)** (`server/match.js` with `GCP.match.find`): the platform runs your rules at a fixed tick near the players, with matchmaking, client prediction and lag-compensated hit checks. `get_started {topic: "matches"}` has the whole guide.

## Rooms

```js
const room = GCP.room('lobby');                  // any code up to 40 characters. Same code, same room.
room.on('open', ({ id, host, peers, state }) => { /* connected. state is the last snapshot the host stored */ });
room.on('join', (peer) => {});                   // { id, name }
room.on('leave', (id) => {});
room.on('host', (hostId) => {});                 // the host left and someone else was promoted
room.on('message', (data, from, meta) => {});     // meta.at: the sender's clock (ms) when it sent this, for GCP.smooth
room.on('state', (data) => {});                  // every time the host calls setState, on every other player; never on the host itself
room.on('close', (code) => {});                  // reconnects by itself a few times

room.send({ type: 'wave' });                     // to everyone else
room.send({ type: 'hit', dmg: 3 }, 'host');      // to the host only, or to one peer id
room.setState({ round: 2 });                     // host only: sent to everyone else at once and kept for late joiners (they get it in `open`), up to 256 KB
room.isHost; room.id; room.peers; room.leave();
```

- Messages are JSON, at most 64 KB each, or binary: `room.send(new Float32Array([x, y, z]))` arrives as an `ArrayBuffer` in the `message` handler (wrap it: `new Float32Array(data)`). Binary is several times smaller than JSON for positions.
- Each player may send 60 messages a second by default, with bursts of twice that, and 256 KB a second. Past it, messages are dropped and the sender gets an `error` event whose `code` is `'rate_limited'`; a player who stays over the budget for 10 seconds is disconnected with close code 4008 (and the SDK does not reconnect). Send on a timer at 10 to 30 a second, never once per frame per object.
- `room.rtt` is the measured round trip to the room in milliseconds (updated every 5 seconds).
- The room size limit is set by the platform and can be lowered per room with `GCP.room(code, { max: 4 })`.
- The first player in is the host. When the host leaves, the player who has been in the room longest becomes host.
- Players in a room are signed-in players of this game. Preview and live rooms are separate.
- For private matches, generate a short code, show it, and let friends type it in. For public play, use a fixed code such as `'world'`, or several (`'world-1'`, `'world-2'`).

## The host-authoritative model

One player's browser, the host, owns the truth. Guests send inputs, the host simulates and broadcasts the state, and everyone draws by interpolating between states. It suits co-op and casual competitive games, needs no server code, and one code path serves single player too (you are simply a host with no guests).

```js
import { joinSession, Interpolator } from '@gcp/net.js';

const players = {};                                 // host's truth: id -> { x, z, input }
const smooth = new Interpolator(120);               // guests draw 120 ms in the past, smoothly

const session = joinSession('lobby', {
  open(s) { if (s.isHost) players[s.id] = { x: 0, z: 0, input: { x: 0, y: 0 } }; },
  input(peerId, data) { (players[peerId] ||= { x: 0, z: 0, input: data }).input = data; },   // host: a guest's input
  snapshot() { const out = {}; for (const id in players) out[id] = { x: +players[id].x.toFixed(2), z: +players[id].z.toFixed(2) }; return out; },
  apply(state) { smooth.push(state); },             // guests: a snapshot arrived
  players(list) { if (session.isHost) for (const id in players) if (!list.some((p) => p.id === id)) delete players[id]; },
  event(data, from) { /* one-off things: chat, a sound, a hit effect */ },
}, { hz: 10 });

function update(dt) {
  session.sendInput({ x: input.move.x, y: input.move.y });          // delivered locally when you are the host
  if (session.isHost) for (const id in players) { const p = players[id]; p.x += p.input.x * 5 * dt; p.z -= p.input.y * 5 * dt; }
  const view = session.isHost ? players : smooth.sample();
  for (const id in view) drawPlayer(id, view[id].x, view[id].z);
}
```

What makes this hold up:

- **Keep snapshots small.** Round numbers, send only what changes, send static world data once (or better, send the seed and generate it on each client). Ten snapshots a second is enough for most games; twenty for fast action.
- **Interpolate, do not snap.** Draw every remote thing a little in the past, between two snapshots, using `GCP.smooth` (below). That goes for the host too: the host draws each guest from that guest's own position messages through a buffer, never by jumping to the newest one.
- **Send on a steady clock.** Keep the timer's remainder (`t += 1 / hz`, not `t = 1 / hz`), otherwise frame rounding turns 12 Hz into an uneven mix of 10 and 12.
- **Let players see each other directly.** A guest's position message sent to everyone (no `to`) reaches the other guests in one hop; drawing them from the host's snapshot instead adds a second hop and the host's sampling on top.
- **Make your own player feel instant.** Move the local player immediately from local input. `joinSession` numbers every input (`sendInput` returns the number) and the host's snapshots say which one it applied last (`meta.ack` in `apply`). To reconcile, take your player's position from the snapshot, re-apply `session.pending` (the inputs the host had not applied yet) on top, and ease the drawn position towards the result instead of snapping.
- **The host must keep running.** Browsers stop `requestAnimationFrame` in hidden tabs. `backgroundTicker(fn)` from `@gcp/core.js` keeps the host's simulation stepping while hidden.
- **Host migration.** The kit stores a snapshot in the room every few seconds. When the host leaves, the new host receives the `host` event and continues from the last snapshot it applied. Keep everything the simulation needs inside the snapshot, or derivable from the seed.
- **Never trust a guest for anything that matters.** The host decides hits, pickups and scores from inputs. In this model the host player can cheat, which is fine among friends. For ranked play, validate results in server code (see the saves guide).

## Smooth remote movement

Messages do not arrive evenly. Over Wi-Fi and mobile data some are late and then several come at once, so stamping
snapshots with their *arrival* time, or interpolating with a small fixed delay, makes other players stutter and snap.
`GCP.smooth()` is a playback buffer for one remote stream that handles this:

```js
const tracks = new Map();                                    // one buffer per remote player (or one for the host's snapshots)
room.on('message', (m, from, meta) => {
  if (m.type !== 'pos') return;
  if (!tracks.has(from)) tracks.set(from, GCP.smooth());
  tracks.get(from).push({ x: m.x, z: m.z }, meta.at);        // place it by when it was SENT
});
function draw() {
  for (const [id, buf] of tracks) { const p = buf.value(); if (p) drawPlayer(id, p.x, p.z); }   // every frame
}
```

- Every room message carries its send time as `meta.at`; pass it to `push`. Clocks need not agree: the buffer learns
  the offset between the sender's clock and this one.
- The delay adapts: about one send interval plus the jitter seen in the last few seconds (40 to 350 ms). Pass
  `{ delay: 100 }` for a fixed one, or `minDelay` / `maxDelay` to bound it.
- When a message is late it keeps moving a little along the last motion (`extrapolate`, 120 ms), then slows down
  rather than freezing and jumping. It never goes backwards.
- `value()` blends numbers and the number fields of an object; anything else (hp, flags) comes from the newer sample.
  `sample()` returns `{ a, b, k }` to blend things yourself, such as angles or lists of entities matched by id.
- `@gcp/net.js`'s `Interpolator` uses it by itself.
- Your own player never goes through a buffer: move it from local input at once.

## Turn-based and slow games

No simulation loop is needed. Send moves as messages, and have the host store the whole game in `room.setState(game)` after every move so that anyone who joins or reconnects gets the current position in `open`.

```js
room.on('message', (m, from) => { if (room.isHost && m.type === 'move' && legal(game, m, from)) { apply(game, m); room.setState(game); } });
room.on('state', (g) => { game = g; redraw(); });
```

For play that spans days, store the game in server code with `env.store` and fetch it on load; a room only lives while someone is connected.

## Shared worlds for building and farming games

For a world players change together, `createWorldSync(room, { build, nodes, crops, chunks, inventory })` from
`@gcp/play.js` (also in craft.js and craft2d.js) does the host-authoritative model for you: a guest's request goes to
the host, which checks it, applies it and sends it to everyone; the guest pays and collects on its own device when the
host says yes; and a late joiner loads the world from the room state. `createLoopback(2)` gives two rooms in one page,
so a single play-through can prove two players agree.

## Testing

Open the preview in two browser windows signed in as different players. The verifier first runs the game alone, so a multiplayer game must still boot, render and call `GCP.ready()` with nobody else in the room.

### The two-player check

A game that registers `GCP.test.onTwoPlayers` is then opened in two more pages of the verification browser, which meet in a
real room: the first with `?gcp_two=host&gcp_room=CODE`, the second with `?gcp_two=guest` and the same code. The function runs
in both pages at once. The check `two_players` passes when both finish, each sees two players, and both return the same
`world` string. The report has it under `two_players`.

```js
const two = GCP.test.twoPlayers;                       // { role, code } in those two pages, null otherwise
GCP.test.onAutostart(() => (two ? (two.role === 'host' ? lobby.host(two.code) : lobby.join(two.code)) : lobby.solo()));
GCP.test.onTwoPlayers(async (t, role) => {
  t.step('the other player appears'); await t.until(() => room.connected && peers.size >= 1, 30000, 'the other player');
  t.step('each builds one piece');    const r = await sync.place(role === 'host' ? 'fence' : 'torch', role === 'host' ? 5 : -5, 3);
  t.assert(!r.error, r.error);
  t.step('both pieces stand in both worlds'); await t.until(() => build.at(5, 3) && build.at(-5, 3), 20000, 'the other piece');
  return { players: peers.size + 1, world: JSON.stringify([build.toJSON(), crops.toJSON()]) };   // equal in both pages
});
```

Make `world` a string of what must agree (pieces, crops, what was felled), sorted so order does not matter, and leave out
what is each player's own (the backpack, the position). `createLoopback(2)` inside the play-through stays useful: it proves
the rules of the shared world quickly; the two-player check proves them over the real room.
