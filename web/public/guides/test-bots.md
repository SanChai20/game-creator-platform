# Testing online games with bots

The preview is yours alone: it never meets the live game's players. To test an online game there, add **test bots**:
bot players that join your preview **the way a real player's page does**, over the platform's real network path, not
inside your page. Latency, stutter, a reconnect or a desync only show over a real network, so that is where the bots are.

## What a bot is

- A remote client run by the platform, server side, in the region you pick (Western Europe, Asia-Pacific and so on), so
  its packets really travel from there.
- It has a play session of its own (a bot session, preview only). It waits in the **real matchmaker**
  (`GCP.match.find`), plays the match over its own WebSocket to your game's Worker running your `server/match.js`, or
  joins your **real room** (`GCP.room`). Your server code cannot tell it from a page, except by its id (`bot_…`).
- On top of the real path it can have a **last mile** of its own: added latency, jitter and packet loss. A lost packet
  on a WebSocket is a TCP retransmission: the message arrives late and holds up everything behind it, which is what
  players on a weak phone signal see.
- Bots never count anywhere: no ratings (a match's ranking leaves them out), no player numbers, no analytics. When the
  fleet stops, their sessions end.

## Where the bots go

| target | what happens |
| --- | --- |
| `follow` (default) | The bots wait for you. Press your game's own Find Match (or open a room) in the preview and the free bots search the same queue with the same options, or join the same lobby code or room, through the same matchmaker. An eight-seat game with seven bots starts at once. A private lobby (`GCP.match.find({ private: true })`) is entered by invite only, as with friends: invite the bots (below). |
| `invite` | The bots go nowhere until you invite them from your game, as friends (below). |
| `queue` | They search a public queue you name (`queue`, `players`, `min`, `teams`, `mode`, as your game passes them to `GCP.match.find`). Bots alone can fill a match: with `bots` at least the queue's `min` it starts without anyone else, so an agent can run an online match end to end without a browser. After a match they look for the next one. |
| `code` | They join a private lobby code. |
| `room` | They join a room code. |

## Bots as your friends: testing invites

Your real friends never meet a preview, so in your preview the running bots are your friends:

- `GCP.friends.list()` lists them first, `online` (or `busy` while in a match), each with `test_bot: true`.
- `GCP.friends.open({ match })` shows the invite picker over the preview with the test players, and an **Invite** button
  for each (with no bots running, it offers to start three).
- `GCP.friends.invite(botId, { match })` invites one directly.

A bot reads the invite for a moment and answers like a friend: your game hears `GCP.friends.on('answer')` and the page
shows the answer. It says yes when it is free (it leaves a search or a room for you) and no when it is busy in a match. On
yes it goes where a friend's page would after `GCP.match.join(join)`: into your private lobby, through the real invite
path (the same invite record a friend gets, in the preview), or to the room your invite's data names (`{ room }`, for a
`GCP.room` game). In `preview_bots`, `action: "invite"` does the same for an agent (`bot`, and `lobby` or `data`), and
`status` lists the latest answers.

## What the bots do: `server/bot.js`

Ship an optional `server/bot.js`. The platform runs it in a sandbox of its own (no network, no bindings, nothing but
your `server/` and `shared/` modules) and asks it, for each bot, what to do now:

```js
// server/bot.js
import { legalMoves } from '../shared/rules.js';

export default {
  thinkMs: 250,   // how often think() runs for each bot (50 to 10000 ms)
  // A match: view is exactly what match.state is in the page for this bot (your view() for it), me its player id.
  // Return one input, what the page would pass to match.input(...), or null to send nothing this time.
  think(view, me, ctx) {
    const moves = legalMoves(view, me);
    return moves.length ? moves[Math.floor(ctx.random() * moves.length)] : null;
  },
  // Or, instead of think: just list the inputs that are valid now and the bot sends one of them at random.
  // actions(view, me, ctx) { return legalMoves(view, me); },
  // A room (GCP.room): the messages to send now ({ d, to }); ctx.messages arrived since the last call.
  // room(ctx) { return ctx.messages.map((m) => ({ d: { ack: m.d.seq }, to: m.from })); },
};
```

`ctx`: `tick`, `phase`, `players`, `events` (match events since the last call), `elapsed` (ms since it joined),
`random()` (seeded per bot), `memory` (an object kept for this bot between calls, up to 8 KB of JSON), `skill` (0 to 1,
set when the fleet starts), `name`.

Guidelines:

- Put the rules in `shared/` and let the bot use them, as the page does. If your game already plays empty seats itself
  (a fill bot in `server/match.js`), call the same brain from `think()` on a copy of the view.
- Number inputs the way your page does and resend the ones the server has not acknowledged yet (the view usually says
  what it applied, for example an `ack` per player); the server ignores what it already has.
- Keep `think()` quick: it runs for every bot every `thinkMs`.
- Without `server/bot.js` the bots still join and stay connected, so you can see the table fill and the network numbers,
  but they send no inputs.

## Breaking the network on purpose

For any bot, or all of them at once:

- **drop**: the connection drops and comes back after a moment with the same ticket, like the SDK's own reconnect.
- **reload**: it comes back like a reloaded page: no ticket, so it asks the platform for its match (`GCP.match.rejoin`'s
  path) and enters with the number of the last input the match applied. This is how you test `rejoinMs`, `join()` with
  `player.back` and `leave()` with `player.final`.
- **spike**: every message takes longer for a while (a congested cell).
- **outage**: nothing gets through for a while, then everything sent meanwhile arrives together (a tunnel).
- **net**: another network profile: `none`, `fiber`, `wifi`, `4g`, `3g`, `poor`, `far`, or your own
  `{ latency, jitter, loss }` (one-way ms, ms, percent).
- **leave** for good (the page's `match.cancel()`), and **rejoin**.

## The numbers

Per bot, over the last 10 seconds: its phase, the round trip (last, median, 95th percentile), snapshots per second, the
spread of their spacing (jitter) and the longest gap between two, inputs sent and not yet acknowledged, traffic in and
out, reconnects, and errors (the match's and your `server/bot.js`'s). A healthy 10 Hz match shows 10 snapshots a second
with a small spread; a long gap or growing unacknowledged inputs is a stall.

## Where to find it

- In the console: **Play preview**, then **Test players** under the game.
- For agents: the MCP tool `preview_bots` (`options`, `start`, `status`, `act`, `invite`, `stop`).

## Limits

Only the game's owner starts bots, in the preview only. A fleet has a limited number of bots, stops by itself after its
minutes, a creator can run only a couple of fleets at once, and there is a daily allowance of bot-minutes (bots ×
minutes). `preview_bots {action: "options"}` shows the numbers on this platform and what is left today. The matchmaker's
and the match's own message budgets apply to bots as to anyone.
