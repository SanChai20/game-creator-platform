# Multiplayer

The platform runs realtime rooms for every game: a WebSocket relay on Cloudflare Durable Objects, one object per room, close to the players. You do not deploy or pay for a server. How you use a room is up to the game.

## Rooms

```js
const room = GCP.room('lobby');                  // any code up to 40 characters. Same code, same room.
room.on('open', ({ id, host, peers, state }) => { /* connected. state is the last snapshot the host stored */ });
room.on('join', (peer) => {});                   // { id, name }
room.on('leave', (id) => {});
room.on('host', (hostId) => {});                 // the host left and someone else was promoted
room.on('message', (data, from) => {});
room.on('state', (data) => {});                  // every time the host calls setState, on every other player; never on the host itself
room.on('close', (code) => {});                  // reconnects by itself a few times

room.send({ type: 'wave' });                     // to everyone else
room.send({ type: 'hit', dmg: 3 }, 'host');      // to the host only, or to one peer id
room.setState({ round: 2 });                     // host only: sent to everyone else at once and kept for late joiners (they get it in `open`), up to 256 KB
room.isHost; room.id; room.peers; room.leave();
```

- Messages are JSON, at most 64 KB each. The room size limit is set by the platform (`get_account` shows it) and can be lowered per room with `GCP.room(code, { max: 4 })`.
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
- **Interpolate, do not snap.** Guests render a little in the past, between the two most recent snapshots.
- **Make your own player feel instant.** Move the local player immediately from local input and gently pull towards the host's position when they disagree by more than a small threshold.
- **The host must keep running.** Browsers stop `requestAnimationFrame` in hidden tabs. `backgroundTicker(fn)` from `@gcp/core.js` keeps the host's simulation stepping while hidden.
- **Host migration.** The kit stores a snapshot in the room every few seconds. When the host leaves, the new host receives the `host` event and continues from the last snapshot it applied. Keep everything the simulation needs inside the snapshot, or derivable from the seed.
- **Never trust a guest for anything that matters.** The host decides hits, pickups and scores from inputs. In this model the host player can cheat, which is fine among friends. For ranked play, validate results in server code (see the saves guide).

## Turn-based and slow games

No simulation loop is needed. Send moves as messages, and have the host store the whole game in `room.setState(game)` after every move so that anyone who joins or reconnects gets the current position in `open`.

```js
room.on('message', (m, from) => { if (room.isHost && m.type === 'move' && legal(game, m, from)) { apply(game, m); room.setState(game); } });
room.on('state', (g) => { game = g; redraw(); });
```

For play that spans days, store the game in server code with `env.store` and fetch it on load; a room only lives while someone is connected.

## Testing

Open the preview in two browser windows signed in as different players. The verifier runs the game alone, so a multiplayer game must still boot, render and call `GCP.ready()` with nobody else in the room.
