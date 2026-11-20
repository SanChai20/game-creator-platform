# The play clock at scale

Every play number the platform shows (counted plays, play time, players online, the player's record, refund play time)
comes from the play clock: the page showing a game checks in every 15 seconds, and the game sends a heartbeat every 15
seconds. With the database play clock (`src/play-clock.ts`), each check-in and heartbeat is about 11 database
statements. At 20,000 players online that is roughly 14,500 statements a second on one D1 database, far more than one
database can run.

With the setting **play_clock_do** on (admin, Play counting), check-ins and heartbeats go to Durable Objects instead,
and the database is written in batches:

- **PlayClock**, one per player (account or guest), holds that player's open sessions in every game. It applies the
  database clock's rules (`src/clock-core.ts`, proven equal to `src/play-clock.ts` by `tests/clock-scale.mjs`), writes
  the player's sessions and play record to the database every 5 minutes and when a session ends, and sends its games'
  tallies once a minute.
- **GameTally**, one per game, adds up its players' clocks and writes the day's totals, the game's totals and who is
  online (`game_online`, migration 0032) in one batch every 30 seconds.
- The page gets a **clock ticket** with its session (`src/clock-ticket.ts`): a check-in with a good ticket needs no
  sign-in lookup. The clock confirms the session is still bound to the same sign-in once a minute.
- Free-trial and verifier sessions stay on the database clock: trial time decides access and refunds, so it stays exact.
  A refund flushes the player's clock before reading play time.

## Restarts

A Durable Object that is idle for 10 seconds can be shut down, and check-ins come every 15 seconds, so a clock can
start fresh before any request. It never trusts its memory: every check-in that changes the book is saved to the
object's own storage before the answer goes back, and whatever was sent to a tally or written to the database is saved
in the same turn, so a restored clock never owes anything twice. A GameTally saves each add before acknowledging it.
`tests/clock-scale.mjs` and `scripts/load/clock-sim.mjs` (`EVICT=1`) restart every object before every request and
check that nothing is lost or counted twice.

## What it costs and saves

`scripts/load/clock-sim.mjs 20000 30 500` runs both clocks' real code for 20,000 players in 500 games for 30 simulated
minutes against an in-memory copy of the database, with every object restarted before every request:

| Per minute, 20,000 players | Database clock | Durable Object clock |
| --- | --- | --- |
| Database statements | 873,822 | 33,700 (26x fewer) |
| Database rows written | 476,267 | 11,600 (41x fewer) |
| Durable Object requests | 0 | 184,639 |
| Durable Object storage writes | 0 | 111,661 |

Plays counted, session seconds, player records, game totals and daily totals are identical in both runs.

At Workers Paid prices, 20,000 players online around the clock for a month cost about $1,200 in Durable Object
requests, $4,800 in Durable Object storage writes and $450 in database writes for the play clock. The database clock
would write $20,500 a month in rows and could not keep up. Most of the cost is one storage write per check-in, so
checking in every 30 seconds instead of 15 would roughly halve it.

Numbers lag: game totals and players online by up to about a minute, a player's record by up to 5 minutes (refunds
flush first, so they are exact).

## Game starts

Starting a game (POST /games/:slug/play) still runs on the database: the sign-in lookup, the game, the rate limit and
the new session row. With play_clock_do the new session is handed straight to the player's clock (`PlayClock.open`), so
the clock never reads it back and the game's tally counts the day's sessions instead of a write per start.

Measured on a staging copy on Cloudflare (one D1 database, nothing else using it):

| Burst | Result |
| --- | --- |
| 1,000 players for 10 minutes, starting over 15 seconds (before the hand-over) | 75% of starts succeeded; every player who started was credited correctly (570 to 585 s of about 585) |
| 1,000 starts in 15 seconds (about 67 a second), with the hand-over | all 1,000 succeeded, every check-in and heartbeat answered |
| 3,000 starts in 15 seconds (about 200 a second) | about half succeeded: D1 reports "overloaded" |

20,000 players in 15-minute sessions start about 22 games a second, well inside what was measured. A rush of more than
about 100 starts a second on one database is the next limit. When D1 says it is overloaded the platform answers 503
"busy" and the page retries a few times with a growing delay, which absorbs a short spike but not a sustained one. The
next step is to take the sign-in lookup and the game lookup off the primary database (D1 read replication with the
Sessions API), which were most of the failed queries.

## Turning it on

1. Apply migrations 0031 and 0032 (`wrangler d1 migrations apply gcp-db --remote`), then deploy (the `PLAY_CLOCK` and
   `GAME_TALLY` bindings and the `v3` Durable Object migration are in `wrangler.jsonc`).
2. Turn on **play_clock_do** in the admin. Sessions already open keep working: a clock that does not know a session
   reads it from the database the first time it sees it.
3. Turning it off again is safe: open sessions continue on the database clock from what was last written (up to 5
   minutes of a session's time may not be counted again).

## Load tests

- `node scripts/load/clock-sim.mjs <players> <minutes> <games>` (add `EVICT=1`): the cost model above. Runs locally,
  sends nothing anywhere.
- `node scripts/load/clock-seed.mjs <players> <games> > seed.sql` and `BASE=… node scripts/load/clock-players.mjs
  <players> <seconds>`: real players in real time against a staging copy (never production).
- `node scripts/load/browsers.mjs bloomguard void-echoes`: the games in real browsers and emulated phones and tablets.
