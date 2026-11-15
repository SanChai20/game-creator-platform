// Per-player game data: proves that one player can never read or change another player's progress,
// one game never reaches another game's data, preview and live stay apart, and the verifier never touches a creator's saves.
// Runs the real module against an in-memory SQLite database with the real migrations.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { signPlayToken } from '../src/runtime/game-worker.js';
import { authToken, playRecordStmt, playerOf, playerSummary, resetPlayer, saveOp, scopeOf, serverStoreOp, statOp, verifierCleanupStmts, verifierId } from '../src/player-data.js';

// A D1-shaped wrapper over node:sqlite: prepare().bind().first()/all()/run(), and batch().
function d1() {
  const sql = new DatabaseSync(':memory:');
  const dir = new URL('../migrations/', import.meta.url);
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) sql.exec(readFileSync(new URL(f, dir), 'utf8'));
  const stmt = (q, args = []) => ({
    bind: (...a) => stmt(q, a),
    first: async () => sql.prepare(q).get(...args) ?? null,
    all: async () => ({ results: sql.prepare(q).all(...args) }),
    run: async () => { const r = sql.prepare(q).run(...args); return { meta: { changes: Number(r.changes) } }; },
  });
  return { prepare: (q) => stmt(q), batch: async (list) => { const out = []; for (const s of list) out.push(await s.run()); return out; }, sql };
}

const KEYS = { gamea1: 'key-of-game-a', gameb2: 'key-of-game-b' };
const keyFor = async (g) => KEYS[g] || 'unknown-' + g;
const exp = () => Math.floor(Date.now() / 1000) + 3600;
const tokenFor = (g, u, { e = 'live', k = 'player', s = 'ps_' + u } = {}) => signPlayToken({ g, e, u, n: u, k, s, x: exp() }, KEYS[g]);
const auth = async (g, u, o) => authToken(await tokenFor(g, u, o), keyFor);

test('two players of one game each get their own save under the same key', async () => {
  const db = d1(), alice = await auth('gamea1', 'u_alice'), bob = await auth('gamea1', 'u_bob');
  await saveOp(db, alice, { op: 'set', key: 'slot1', value: { level: 7 } });
  assert.deepEqual((await saveOp(db, bob, { op: 'get', key: 'slot1' })).value, null, 'a new player starts with no save');
  await saveOp(db, bob, { op: 'set', key: 'slot1', value: { level: 1 } });
  assert.deepEqual((await saveOp(db, alice, { op: 'get', key: 'slot1' })).value, { level: 7 });
  assert.deepEqual((await saveOp(db, bob, { op: 'get', key: 'slot1' })).value, { level: 1 });
  await saveOp(db, bob, { op: 'delete', key: 'slot1' });
  assert.deepEqual((await saveOp(db, alice, { op: 'get', key: 'slot1' })).value, { level: 7 }, 'deleting your save leaves others alone');
  assert.deepEqual((await saveOp(db, bob, { op: 'list' })).keys, []);
});

test('a request body cannot name another player, game or environment', async () => {
  const db = d1(), alice = await auth('gamea1', 'u_alice'), bob = await auth('gamea1', 'u_bob');
  await saveOp(db, alice, { op: 'set', key: 'slot1', value: 'alice' });
  // Fields a hostile page might add are ignored: identity comes only from the signed token.
  const r = await saveOp(db, bob, { op: 'get', key: 'slot1', user: 'u_alice', user_id: 'u_alice', player: 'u_alice', g: 'gamea1', project_id: 'gamea1', e: 'preview' });
  assert.equal(r.value, null);
  await saveOp(db, bob, { op: 'set', key: 'slot1', value: 'bob', user: 'u_alice', player: 'u_alice' });
  assert.equal((await saveOp(db, alice, { op: 'get', key: 'slot1' })).value, 'alice');
  await statOp(db, bob, { op: 'add', name: 'coins', value: 5, user: 'u_alice', player: 'u_alice' });
  assert.deepEqual((await statOp(db, alice, { op: 'all' })).stats, {});
});

test('players cannot write the game-wide shared data, only read it', async () => {
  const db = d1(), alice = await auth('gamea1', 'u_alice');
  await serverStoreOp(db, 'gamea1', 'live', { op: 'set', key: 'motd', value: 'hello' });
  assert.equal((await saveOp(db, alice, { op: 'get', key: 'motd', shared: true })).value, 'hello');
  await assert.rejects(saveOp(db, alice, { op: 'set', key: 'motd', value: 'pwned', shared: true }), /server code only/);
  await assert.rejects(saveOp(db, alice, { op: 'delete', key: 'motd', shared: true }), /server code only/);
  assert.equal((await saveOp(db, alice, { op: 'get', key: 'motd', shared: true })).value, 'hello');
  // and a player's own save under the same key is separate from the shared one
  await saveOp(db, alice, { op: 'set', key: 'motd', value: 'mine' });
  assert.equal((await saveOp(db, alice, { op: 'get', key: 'motd', shared: true })).value, 'hello');
});

test('the same player in two games has two separate saves and stats', async () => {
  const db = d1(), inA = await auth('gamea1', 'u_alice'), inB = await auth('gameb2', 'u_alice');
  await saveOp(db, inA, { op: 'set', key: 'slot1', value: 'A' });
  await statOp(db, inA, { op: 'add', name: 'wins', value: 3 });
  assert.equal((await saveOp(db, inB, { op: 'get', key: 'slot1' })).value, null);
  assert.equal((await statOp(db, inB, { op: 'get', name: 'wins' })).value, null);
  await saveOp(db, inB, { op: 'set', key: 'slot1', value: 'B' });
  assert.equal((await saveOp(db, inA, { op: 'get', key: 'slot1' })).value, 'A');
});

test('a token signed for one game is refused by every other game, and a forged token is refused', async () => {
  const good = await tokenFor('gamea1', 'u_alice');
  // re-label the same body as game B: the signature no longer matches game B's key
  const [body, sig] = good.split('.');
  const p = JSON.parse(Buffer.from(body, 'base64url').toString());
  const relabel = (o) => Buffer.from(JSON.stringify({ ...p, ...o })).toString('base64url') + '.' + sig;
  await assert.rejects(authToken(relabel({ g: 'gameb2' }), keyFor), /expired/);
  await assert.rejects(authToken(relabel({ u: 'u_bob' }), keyFor), /expired/, 'changing the player breaks the signature');
  await assert.rejects(authToken(relabel({ e: 'preview' }), keyFor), /expired/, 'changing the environment breaks the signature');
  await assert.rejects(authToken(await signPlayToken({ ...p, g: 'gameb2' }, 'key-of-game-a'), keyFor), /expired/, 'signed with the wrong game\'s key');
  await assert.rejects(authToken(await signPlayToken({ ...p, x: 1 }, 'key-of-game-a'), keyFor), /expired/, 'expired');
  await assert.rejects(authToken('garbage', keyFor), /expired/);
  assert.equal((await authToken(good, keyFor)).u, 'u_alice');
});

test('preview data and live data never mix', async () => {
  const db = d1(), live = await auth('gamea1', 'u_alice'), preview = await auth('gamea1', 'u_alice', { e: 'preview' });
  await saveOp(db, preview, { op: 'set', key: 'slot1', value: 'test run' });
  await statOp(db, preview, { op: 'max', name: 'best', value: 99 });
  assert.equal((await saveOp(db, live, { op: 'get', key: 'slot1' })).value, null);
  assert.equal((await statOp(db, live, { op: 'get', name: 'best' })).value, null);
  assert.equal(scopeOf('gamea1', 'preview'), 'gamea1:preview');
});

test('the verifier plays under its own throwaway identity, never the creator\'s', async () => {
  const db = d1(), creator = await auth('gamea1', 'u_owner', { e: 'preview', k: 'owner' });
  await saveOp(db, creator, { op: 'set', key: 'slot1', value: 'my real progress' });
  // a verifier token, even an old one that still carries the creator's id
  for (const [u, sid] of [['u_owner', 'vf_1'], [verifierId('vf_2'), 'vf_2']]) {
    const bot = await auth('gamea1', u, { e: 'preview', k: 'verify', s: sid });
    assert.equal(playerOf(bot), 'verify:' + sid);
    assert.equal((await saveOp(db, bot, { op: 'get', key: 'slot1' })).value, null, 'verification starts from no save');
    await saveOp(db, bot, { op: 'set', key: 'slot1', value: 'bot' });
  }
  assert.equal((await saveOp(db, creator, { op: 'get', key: 'slot1' })).value, 'my real progress');
  // and its leftovers are cleaned up
  await db.batch(verifierCleanupStmts(db, Date.now() + 1));
  assert.equal(db.sql.prepare("SELECT COUNT(*) AS n FROM saves WHERE user_id LIKE 'verify:%'").get().n, 0);
  assert.equal(db.sql.prepare("SELECT COUNT(*) AS n FROM saves WHERE user_id = 'u_owner'").get().n, 1);
});

test('stats add up per player and keep the best values', async () => {
  const db = d1(), alice = await auth('gamea1', 'u_alice'), bob = await auth('gamea1', 'u_bob');
  await statOp(db, alice, { op: 'add', name: 'levels' });
  await statOp(db, alice, { op: 'add', name: 'levels', value: 2 });
  await statOp(db, bob, { op: 'add', name: 'levels', value: 10 });
  assert.equal((await statOp(db, alice, { op: 'max', name: 'best_lap', value: 40 })).value, 40);
  assert.equal((await statOp(db, alice, { op: 'max', name: 'best_lap', value: 30 })).value, 40);
  assert.equal((await statOp(db, alice, { op: 'min', name: 'fastest', value: 30 })).value, 30);
  assert.equal((await statOp(db, alice, { op: 'min', name: 'fastest', value: 50 })).value, 30);
  assert.deepEqual((await statOp(db, alice, { op: 'all' })).stats, { best_lap: 40, fastest: 30, levels: 3 });
  assert.deepEqual((await statOp(db, bob, { op: 'all' })).stats, { levels: 10 });
  await assert.rejects(statOp(db, alice, { op: 'add', name: 'x', value: 'NaN' }), /finite/);
  await assert.rejects(statOp(db, alice, { op: 'add', name: '' }), /name/);
});

test('limits are per player: one player filling up does not block another', async () => {
  const db = d1(), alice = await auth('gamea1', 'u_alice'), bob = await auth('gamea1', 'u_bob');
  for (let i = 0; i < 64; i++) await saveOp(db, alice, { op: 'set', key: 'k' + i, value: i });
  await assert.rejects(saveOp(db, alice, { op: 'set', key: 'one-more', value: 1 }), /Too many save keys/);
  await saveOp(db, alice, { op: 'set', key: 'k0', value: 'overwrite is fine' });
  await saveOp(db, bob, { op: 'set', key: 'k0', value: 'bob' });
  await assert.rejects(saveOp(db, alice, { op: 'set', key: 'big', value: 'x'.repeat(300 * 1024) }), /too large/);
});

test('every session updates that player\'s own record for that game, and the verifier keeps none', async () => {
  const db = d1();
  const play = (user_id, extra = {}) => ({ project_id: 'gamea1', env: 'live', user_id, version: 3, kind: 'player', ...extra });
  await db.batch([playRecordStmt(db, play('u_alice'), 0, true, 1000), playRecordStmt(db, play('u_alice'), 15, false, 2000), playRecordStmt(db, play('u_bob'), 15, true, 3000)]);
  await db.batch([playRecordStmt(db, play('u_alice', { env: 'preview' }), 15, true, 4000)]);
  assert.equal(playRecordStmt(db, play('u_owner', { kind: 'verify' }), 15, true), null);
  const a = await playerSummary(db, 'gamea1', 'u_alice'), b = await playerSummary(db, 'gamea1', 'u_bob');
  assert.equal(a.sessions, 1); assert.equal(a.seconds, 15); assert.equal(a.first_played, 1000); assert.equal(a.last_played, 2000); assert.equal(a.last_version, 3);
  assert.equal(b.sessions, 1); assert.equal(b.seconds, 15);
  assert.equal((await playerSummary(db, 'gamea1:preview', 'u_alice')).seconds, 15);
  assert.equal((await playerSummary(db, 'gamea1', 'u_nobody')).sessions, 0);
});

test('a player resetting their progress removes only their own data in that game', async () => {
  const db = d1(), alice = await auth('gamea1', 'u_alice'), bob = await auth('gamea1', 'u_bob'), aliceB = await auth('gameb2', 'u_alice');
  for (const t of [alice, bob, aliceB]) { await saveOp(db, t, { op: 'set', key: 'slot1', value: t.u }); await statOp(db, t, { op: 'add', name: 'coins' }); }
  db.sql.prepare("INSERT INTO scores (project_id, board, user_id, name, score, updated_at) VALUES ('gamea1', 'default', 'u_alice', 'a', 5, 0), ('gamea1', 'default', 'u_bob', 'b', 6, 0)").run();
  const r = await resetPlayer(db, 'gamea1', 'u_alice');
  assert.equal(r.removed, 3);
  const s = await playerSummary(db, 'gamea1', 'u_alice');
  assert.equal(s.saves.keys, 0); assert.deepEqual(s.stats, {}); assert.deepEqual(s.best, {});
  assert.equal((await saveOp(db, bob, { op: 'get', key: 'slot1' })).value, 'u_bob');
  assert.deepEqual((await playerSummary(db, 'gamea1', 'u_bob')).best, { default: 6 });
  assert.equal((await saveOp(db, aliceB, { op: 'get', key: 'slot1' })).value, 'u_alice', 'other games keep their progress');
  await assert.rejects(resetPlayer(db, 'gamea1', ''), /No player/, 'an empty player id can never wipe the shared data');
});

test('game server code reaches only its own game', async () => {
  const db = d1();
  await serverStoreOp(db, 'gamea1', 'live', { op: 'set', key: 'best', value: 10, player: 'u_alice' });
  assert.equal((await serverStoreOp(db, 'gameb2', 'live', { op: 'get', key: 'best', player: 'u_alice' })).value, null);
  assert.equal((await serverStoreOp(db, 'gamea1', 'preview', { op: 'get', key: 'best', player: 'u_alice' })).value, null);
  assert.equal((await saveOp(db, await auth('gamea1', 'u_alice'), { op: 'get', key: 'best' })).value, 10, 'the same save GCP.save reads');
});
