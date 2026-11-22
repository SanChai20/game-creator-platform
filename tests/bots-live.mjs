// Preview test bots end to end, in the real Workers runtime with real WebSockets: the platform's runtime routes, its
// Matchmaker and BotFleet Durable Objects and the Worker Loader running the game's server/bot.js (tests/rt/bots-worker.ts),
// and the game's own Worker running its server/match.js in GameMatch (a second wrangler dev, built like a deployed one).
// The creator searches from "their preview" (a WebSocket with an owner token); seven bots that follow them fill the
// table through the same matchmaker, connect to the same match over their own sockets, and play with the game's bot.
//   node --test --test-concurrency=1 tests/bots-live.mjs      (npm run test:bots)
// GAME_DIR=<a game's folder with server/ and shared/> runs it with that game instead of tests/fixtures/bot-game
// (PLAYERS, QUEUE and MIN as that game asks the matchmaker for them).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';
import { signPlayToken } from '../src/runtime/game-worker.js';

const P_PORT = Number(process.env.BOTS_PORT || 8793), G_PORT = P_PORT + 1;
const PLATFORM = `http://127.0.0.1:${P_PORT}`, GAME = `http://127.0.0.1:${G_PORT}`;
const SECRET = 'test-session-secret', hmac = (m) => createHmac('sha256', SECRET).update(m).digest('hex');
const PLAY_KEY = hmac('play:gtest1'), STORE_KEY = hmac('store:gtest1:preview');
const GAME_DIR = process.env.GAME_DIR || new URL('./fixtures/bot-game', import.meta.url).pathname;
const PLAYERS = Number(process.env.PLAYERS || 8), QUEUE = process.env.QUEUE || 'court', MIN = Number(process.env.MIN || 2);
const root = new URL('..', import.meta.url);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 10_000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = await fn(); if (v) return v; await sleep(200); } return null; };
const devs = [];
const wenv = { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' };

function files(dir, base = dir, out = {}) {
  for (const f of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, f.name);
    if (f.isDirectory()) files(p, base, out); else if (/\.m?js$/.test(f.name)) out[p.slice(base.length + 1)] = readFileSync(p, 'utf8');
  }
  return out;
}
async function waitUp(url) { for (let i = 0; i < 160; i++) { try { if ((await fetch(url)).ok) return; } catch { /* starting */ } await sleep(500); } throw new Error(`${url} did not start`); }
const get = async (p) => (await fetch(PLATFORM + p)).json();
const post = async (p, b) => (await fetch(PLATFORM + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b || {}) })).json();

before(async () => {
  // the platform
  const persist = mkdtempSync(join(tmpdir(), 'gcp-bots-'));
  execFileSync('npx', ['wrangler', 'd1', 'migrations', 'apply', 'DB', '--local', '-c', 'tests/rt/wrangler.bots.jsonc', '--persist-to', persist], { cwd: root, stdio: 'ignore', env: wenv });
  devs.push(spawn('npx', ['wrangler', 'dev', '-c', 'tests/rt/wrangler.bots.jsonc', '--port', String(P_PORT), '--ip', '127.0.0.1', '--inspector-port', String(P_PORT + 1000), '--persist-to', persist, '--log-level', 'error'], { cwd: root, stdio: ['ignore', 'ignore', process.env.DEBUG ? 'inherit' : 'ignore'], env: wenv, detached: true }));
  // the game's own Worker, built like a deployed one, with the game's server/ and shared/
  const dir = mkdtempSync(join(tmpdir(), 'gcp-botgame-')), game = files(GAME_DIR);
  for (const f of ['game-worker.js', 'gcp-intrinsics.js', 'match-core.js']) copyFileSync(new URL(`../src/runtime/${f}`, import.meta.url), join(dir, f));
  mkdirSync(join(dir, 'server'), { recursive: true });
  copyFileSync(new URL('../src/runtime/server/index.js', import.meta.url), join(dir, 'server/index.js'));
  for (const [p, text] of Object.entries(game)) { mkdirSync(join(dir, p, '..'), { recursive: true }); writeFileSync(join(dir, p), text); }
  writeFileSync(join(dir, 'entry.js'), "import worker, { GameMatch } from './game-worker.js';\nexport { GameMatch };\nexport default worker;\n");
  writeFileSync(join(dir, 'wrangler.jsonc'), JSON.stringify({
    name: 'gcp-botgame-test', main: 'entry.js', compatibility_date: '2026-10-01',
    durable_objects: { bindings: [{ name: 'MATCH', class_name: 'GameMatch' }] }, migrations: [{ tag: 'gcp-match-v1', new_sqlite_classes: ['GameMatch'] }],
    vars: { PLAY_KEY, STORE_KEY, GAME_ID: 'gtest1', ENV: 'preview', PLATFORM, PREFIX: 'v/gtest1/1/', SLUG: 'g', TITLE: 'G', VERSION: '1', MANIFEST: '{}' },
  }));
  devs.push(spawn('npx', ['wrangler', 'dev', '-c', join(dir, 'wrangler.jsonc'), '--port', String(G_PORT), '--ip', '127.0.0.1', '--inspector-port', String(G_PORT + 1000), '--log-level', 'error'], { cwd: root, stdio: ['ignore', 'ignore', process.env.DEBUG ? 'inherit' : 'ignore'], env: wenv, detached: true }));
  await waitUp(`${PLATFORM}/health`); await waitUp(`${GAME}/__gcp/health`);
  const seeded = await post('/seed', { files: game, manifest: { hasMatch: true } });
  assert.ok(seeded.ok);
});
after(async () => { try { await post('/stop'); } catch { /* down */ } for (const d of devs) try { process.kill(-d.pid, 'SIGTERM'); } catch { /* gone */ } });

const ownerToken = () => signPlayToken({ g: 'gtest1', e: 'preview', u: 'owner1', n: 'Creator', k: 'owner', s: 'ps_owner', x: Math.floor(Date.now() / 1000) + 3600 }, PLAY_KEY);

/** The creator's own page: searches, then plays the match (sends nothing, like a player thinking). */
async function creatorSearch(query) {
  const c = { got: [], found: null, snaps: 0 };
  const ws = new WebSocket(`${PLATFORM.replace('http', 'ws')}/api/rt/match?t=${encodeURIComponent(await ownerToken())}&${query}`);
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); c.got.push(m); if (m.t === 'found') c.found = m; };
  c.mm = ws;
  return c;
}
function creatorPlay(ticket) {
  const c = { snaps: 0, hello: null, ws: new WebSocket(`${GAME.replace('http', 'ws')}/__gcp/match?t=${encodeURIComponent(ticket)}`) };
  c.ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.t === 's') c.snaps++; if (m.t === 'hello') c.hello = m; };
  c.ws.onclose = (ev) => { c.closed = [ev.code, ev.reason]; if (process.env.DEBUG) console.log('creator match closed', ev.code, ev.reason); };
  return c;
}

let creator;
test(`seven bots follow the creator into one ${PLAYERS}-seat match over the real matchmaker and play it`, async () => {
  const bots = PLAYERS - 1;
  const r = await post('/start', { platform: PLATFORM, game: GAME, request: { bots, target: 'follow', net: '4g', nets: [null, null, null, null, null, 'poor', 'none'] } });
  assert.ok(r.fleet, JSON.stringify(r));
  let st = await until(async () => { const s = await get('/status'); return s.running && s.bots.length === bots ? s : null; });
  assert.ok(st, 'the fleet runs');
  assert.equal(st.brain.kind, 'game', `server/bot.js is loaded in its sandbox: ${st.brain.note}`);
  assert.ok(st.bots.every((b) => b.phase === 'idle'), 'following bots wait for the creator');

  const search = await creatorSearch(`queue=${QUEUE}&players=${PLAYERS}&min=${MIN}`);
  assert.ok(await until(() => search.found, 15_000), `the creator is matched: ${JSON.stringify(search.got.slice(-3))}`);
  const roster = search.found.players.map((p) => p.id);
  assert.equal(roster.length, PLAYERS, 'a full table: the creator and every bot');
  assert.ok(roster.includes('owner1'));
  assert.equal(roster.filter((id) => id.startsWith('bot_')).length, bots);
  creator = creatorPlay(search.found.ticket); if (process.env.TICKET_OUT) writeFileSync(process.env.TICKET_OUT, search.found.ticket);

  st = await until(async () => { const s = await get('/status'); return s.bots.every((b) => b.phase === 'playing' && b.stats.snapshots_per_s >= 5 && b.inputs_sent > 0 && b.stats.rtt_ms != null) ? s : null; }, 25_000);
  assert.ok(st, `every bot plays: ${JSON.stringify((await get('/status')).bots.map((b) => [b.name, b.phase, b.detail, b.stats.snapshots_per_s, b.inputs_sent, b.stats.last_error]))}`);
  assert.ok(creator.snaps > 10, 'the creator gets snapshots of the same match');
  const by = Object.fromEntries(st.bots.map((b) => [b.name, b]));
  // the last mile: 4G adds about 2 x 35 ms to the round trip, a poor connection about 2 x 160 ms, none adds nothing
  assert.ok(by['Test Bot 1'].stats.rtt_p50_ms >= 50, `4G round trip ${by['Test Bot 1'].stats.rtt_p50_ms} ms`);
  assert.ok(by['Test Bot 6'].stats.rtt_p50_ms >= 200, `poor round trip ${by['Test Bot 6'].stats.rtt_p50_ms} ms`);
  assert.ok(by['Test Bot 7'].stats.rtt_p50_ms < by['Test Bot 1'].stats.rtt_p50_ms, 'no added delay is quicker');
  assert.ok(st.bots.every((b) => b.brain.errors === 0), `server/bot.js runs without errors: ${st.bots.map((b) => b.brain.last_error).filter(Boolean)}`);
  // the bots' inputs reach the match: what they bought shows in the creator's view of the table
  await sleep(3000);
  st = await get('/status');
  assert.ok(st.bots.every((b) => b.stats.inputs_unacked < 50), 'inputs are acknowledged');
  console.log('  per bot:', st.bots.map((b) => `${b.name} ${b.net.profile} rtt ${b.stats.rtt_p50_ms}/${b.stats.rtt_p95_ms} ms, ${b.stats.snapshots_per_s} snap/s, gap max ${b.stats.snapshot_gap_max_ms} ms, ${b.stats.kb_in_per_s} KB/s in`).join('\n    '));
});

test('a dropped bot comes back with its ticket; a reloaded one through GCP.match.rejoin\'s path; a lag spike shows', async () => {
  await post('/act', { bot: 'Test Bot 2', action: 'drop', ms: 2000 });
  await post('/act', { bot: 'Test Bot 3', action: 'reload', ms: 2000 });
  await post('/act', { bot: 'Test Bot 4', action: 'spike', ms: 6000, extra: 500 });
  let st = await get('/status');
  const ph = (s, n) => s.bots.find((b) => b.name === n);
  assert.equal(ph(st, 'Test Bot 2').phase, 'away');
  assert.equal(ph(st, 'Test Bot 3').phase, 'away');
  st = await until(async () => { const s = await get('/status'); return ph(s, 'Test Bot 2').phase === 'playing' && ph(s, 'Test Bot 3').phase === 'playing' ? s : null; }, 15_000);
  assert.ok(st, `both come back: ${JSON.stringify((await get('/status')).bots.slice(1, 3).map((b) => [b.phase, b.detail, b.stats.last_error]))}`);
  assert.ok(ph(st, 'Test Bot 2').stats.reconnects >= 1 && ph(st, 'Test Bot 3').stats.reconnects >= 1);
  st = await until(async () => { const s = await get('/status'); return ph(s, 'Test Bot 4').stats.rtt_ms >= 900 ? s : null; }, 8000);
  assert.ok(st, 'the spike adds about 2 x 500 ms to the round trip');
  assert.ok(st.log.some((l) => /page reload/.test(l)));
});

test('stopping the fleet ends the bots\' sessions and keeps a summary; bots never count in the ranking', async () => {
  const stop = await post('/stop');
  assert.equal(stop.stopped, true);
  const plays = await get(`/db?q=${encodeURIComponent("SELECT COUNT(*) AS n FROM plays WHERE kind = 'bot'")}`);
  assert.equal(plays[0].n, 0, 'the bots\' play sessions are gone');
  const fl = await get(`/db?q=${encodeURIComponent('SELECT ended_at, bot_minutes, summary FROM bot_fleets')}`);
  assert.ok(fl[0].ended_at); const sum = JSON.parse(fl[0].summary);
  assert.equal(sum.bots.length, PLAYERS - 1); assert.match(sum.why, /test over/);
  try { creator.ws.close(); } catch { /* closed */ }
});

test('bots alone fill a public queue: an agent can run an online match without a browser', async () => {
  const r = await post('/start', { platform: PLATFORM, game: GAME, request: { bots: 4, target: 'queue', queue: 'botsonly', players: 4, min: 4 } });
  assert.ok(r.fleet);
  const st = await until(async () => { const s = await get('/status'); return s.running && s.bots.length === 4 && s.bots.every((b) => b.phase === 'playing' && b.inputs_sent > 0) ? s : null; }, 25_000);
  assert.ok(st, `four bots play a match of their own: ${JSON.stringify((await get('/status')).bots?.map((b) => [b.phase, b.detail, b.stats.last_error]))}`);
  assert.equal(new Set(st.bots.map((b) => b.match)).size, 1, 'one match');
  await post('/stop');
});

test('in the preview the bots are the creator\'s friends: invited into a private lobby, one answers and joins through the real invite path', async () => {
  const r = await post('/start', { platform: PLATFORM, game: GAME, request: { bots: 3, target: 'invite', net: 'wifi' } });
  assert.ok(r.fleet);
  assert.ok(await until(async () => { const s = await get('/status'); return s.running && s.bots.length === 3; }));
  const t = await ownerToken();
  const rt = async (b) => { const x = await (await fetch(`${PLATFORM}/api/rt/friends`, { method: "POST", headers: { "content-type": "text/plain" }, body: JSON.stringify({ t, ...b }) })).text(); try { return JSON.parse(x); } catch { throw new Error(x.slice(0, 500)); } };
  const list = await rt({ op: 'list' });
  assert.ok(list.ok, JSON.stringify(list));
  const bots = list.friends.filter((f) => f.test_bot);
  assert.equal(bots.length, 3, 'GCP.friends.list() in the owner\'s preview lists the running bots');
  assert.ok(bots.every((f) => f.status === 'online' && f.invitable));
  // the creator opens a private lobby: bots waiting for invites stay where they are
  const search = await creatorSearch(`queue=${QUEUE}&players=${PLAYERS}&min=${MIN}&private=1`);
  const lobby = (await until(() => search.got.find((m) => m.lobby), 10_000))?.lobby;
  assert.ok(lobby, `a private lobby with its token: ${JSON.stringify(search.got)}`);
  await sleep(1000);
  assert.ok((await get('/status')).bots.every((b) => b.phase === 'idle'), 'nobody walks into a private lobby uninvited');
  // GCP.friends.invite(bot, { match }) from the game
  const inv = await rt({ op: 'invite', to: bots[0].id, lobby, label: 'Private Court' });
  assert.ok(inv.ok && inv.id, JSON.stringify(inv));
  const st = await until(async () => { const s = await get('/status'); return (s.invites || []).some((a) => a.id === inv.id && a.accepted) && s.bots[0].phase === 'searching' ? s : null; }, 10_000);
  assert.ok(st, `the bot accepts and enters the lobby: ${JSON.stringify((await get('/status')).log.slice(-6))}`);
  const row = await get(`/db?q=${encodeURIComponent(`SELECT env, status, kind FROM game_invites WHERE id = '${inv.id}'`)}`);
  assert.deepEqual(row[0], { env: 'preview', status: 'accepted', kind: 'match' }, 'the same invite record a friend gets, in the preview');
  const both = await until(() => search.got.filter((m) => m.t === 'lobby').find((m) => (m.players || []).some((p) => p.id === bots[0].id)), 10_000);
  assert.ok(both, `the creator sees the bot in their private lobby: ${JSON.stringify(search.got.slice(-2))}`);
  assert.ok(both.players.every((p) => p.id === 'owner1' || p.id === bots[0].id), 'only the invited bot came');
  // a room game's invite ({ data: { room } }) sends the bot to that room
  const inv2 = await rt({ op: 'invite', to: bots[1].id, data: { room: 'fgarden12345' }, label: 'Co-op garden' });
  assert.ok(inv2.ok);
  assert.ok(await until(async () => (await get('/status')).log.some((l) => /joining room fgarden12345/.test(l)), 8000), 'the bot heads to the room the invite names');
  // an invite to a bot of nobody's fleet is refused
  const bad = await rt({ op: 'invite', to: 'bot_zzzzzzzz_1', lobby });
  assert.equal(bad.code, 'not_online');
  try { search.mm.close(); } catch { /* closed */ }
  await post('/stop');
});
