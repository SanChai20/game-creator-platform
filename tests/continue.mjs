// "Continue playing": GCP.resume is kept per player and game from the play token, the Continue list holds only the
// player's own live games in the order they were last played, a game taken off the row comes back when played again,
// and resetting progress clears where the player left off. Runs the real module against SQLite with the real migrations.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { signPlayToken } from '../src/runtime/game-worker.js';
import { authToken, cleanResume, continueList, hideContinue, playRecordStmt, playerSummary, resetPlayer, resumeOp } from '../src/player-data.js';

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
const KEYS = { gamea1: 'key-a', gameb2: 'key-b', gamec3: 'key-c' };
const auth = async (g, u, { e = 'live', k = 'player', s = 'ps_' + u + g } = {}) => authToken(await signPlayToken({ g, e, u, n: u, k, s, x: Math.floor(Date.now() / 1000) + 3600 }, KEYS[g]), async (id) => KEYS[id]);
function game(db, id, { status = 'live', price = 0, owner = 'u_creator' } = {}) {
  db.sql.prepare('INSERT INTO projects (id, owner_id, slug, title, status, price_cents, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 0, 0)').run(id, owner, 'slug-' + id, 'Game ' + id, status, price);
}
const beat = (db, g, u, t, env = 'live') => playRecordStmt(db, { project_id: g, env, user_id: u, kind: 'player', version: 1 }, 15, true, t).run();

test('a resume label is one short line; progress is clamped to 0..1', () => {
  assert.deepEqual(cleanResume({ label: '  Act 2,\n Floor 14 ', detail: 'Ember Knight', progress: 1.7 }, 5), { label: 'Act 2, Floor 14', detail: 'Ember Knight', progress: 1, at: 5 });
  assert.equal(cleanResume({ label: 'x'.repeat(200) }).label.length, 60);
  assert.throws(() => cleanResume({ label: '   ' }), /label/);
  assert.throws(() => cleanResume({ label: 'a', progress: 'lots' }), /progress/);
});

test('GCP.resume belongs to the token\'s player and game; preview and the verifier keep none of the live one', async () => {
  const db = d1(), alice = await auth('gamea1', 'u_alice'), bob = await auth('gamea1', 'u_bob');
  await resumeOp(db, alice, { op: 'set', label: 'Floor 14', user: 'u_bob', g: 'gameb2' }, 1000);
  assert.equal((await resumeOp(db, alice, { op: 'get' })).resume.label, 'Floor 14');
  assert.equal((await resumeOp(db, bob, { op: 'get' })).resume, null, 'a request body cannot name another player');
  assert.equal((await resumeOp(db, await auth('gameb2', 'u_alice'), { op: 'get' })).resume, null);
  assert.equal((await resumeOp(db, await auth('gamea1', 'u_alice', { e: 'preview' }), { op: 'get' })).resume, null);
  const v = await auth('gamea1', 'u_alice', { k: 'verify' });
  assert.equal((await resumeOp(db, v, { op: 'set', label: 'verifier' })).ok, true);
  assert.equal((await resumeOp(db, v, { op: 'get' })).resume, null, 'the verifier stores nothing');
  assert.equal((await resumeOp(db, alice, { op: 'get' })).resume.label, 'Floor 14');
  // set before the first heartbeat starts the record without counting a session; the heartbeat keeps the resume
  const rec = await playerSummary(db, 'gamea1', 'u_alice');
  assert.equal(rec.sessions, 0); assert.equal(rec.resume.label, 'Floor 14');
  await beat(db, 'gamea1', 'u_alice', 2000);
  assert.equal((await playerSummary(db, 'gamea1', 'u_alice')).resume.label, 'Floor 14');
  await resumeOp(db, alice, { op: 'clear' });
  assert.equal((await resumeOp(db, alice, { op: 'get' })).resume, null);
});

test('the Continue list: own live games, last played first, with saves, resume and ownership', async () => {
  const db = d1();
  game(db, 'gamea1'); game(db, 'gameb2', { price: 500 }); game(db, 'gamec3', { status: 'offline' }); game(db, 'gamed4', { price: 300 });
  await beat(db, 'gamea1', 'u_alice', 1000); await beat(db, 'gameb2', 'u_alice', 3000); await beat(db, 'gamec3', 'u_alice', 4000);
  await beat(db, 'gamea1', 'u_alice', 1000, 'preview'); await beat(db, 'gamed4', 'u_bob', 5000);
  await resumeOp(db, await auth('gamea1', 'u_alice'), { op: 'set', label: 'Act 2', progress: 0.5 }, 1500);
  db.sql.prepare("INSERT INTO saves (project_id, user_id, k, v, updated_at) VALUES ('gamea1', 'u_alice', 'run', '1', 1200), ('gamea1', 'u_bob', 'run', '1', 9999)").run();
  const { list, more } = await continueList(db, 'u_alice');
  assert.deepEqual(list.map((x) => x.game_id), ['gameb2', 'gamea1'], 'offline games, preview data and other players are left out');
  assert.equal(more, false);
  assert.equal(list[1].saved_at, 1200, 'only this player\'s saves');
  assert.deepEqual(list[1].resume, { label: 'Act 2', progress: 0.5, at: 1500 });
  assert.equal(list[1].owned, true, 'free');
  assert.equal(list[0].owned, false, 'a paid game not bought');
  db.sql.prepare("INSERT INTO purchases (id, user_id, project_id, owner_id, price_cents, fee_cents, net_cents, provider, status, created_at) VALUES ('p1', 'u_alice', 'gameb2', 'u_creator', 500, 50, 450, 'admin', 'paid', 0)").run();
  assert.equal((await continueList(db, 'u_alice')).list[0].owned, true, 'bought');
  const page = await continueList(db, 'u_alice', { limit: 1 });
  assert.equal(page.list.length, 1); assert.equal(page.more, true);
});

test('a game taken off the row comes back once it is played again; reset clears where the player left off', async () => {
  const db = d1(); game(db, 'gamea1'); game(db, 'gameb2');
  await beat(db, 'gamea1', 'u_alice', 1000); await beat(db, 'gameb2', 'u_alice', 2000);
  assert.equal((await hideContinue(db, 'gamea1', 'u_alice', 3000)).ok, true);
  assert.equal((await hideContinue(db, 'gamea1', 'u_nobody', 3000)).ok, false);
  assert.deepEqual((await continueList(db, 'u_alice')).list.map((x) => x.game_id), ['gameb2']);
  await beat(db, 'gamea1', 'u_alice', 4000);
  assert.deepEqual((await continueList(db, 'u_alice')).list.map((x) => x.game_id), ['gamea1', 'gameb2']);
  await resumeOp(db, await auth('gamea1', 'u_alice'), { op: 'set', label: 'Floor 3' });
  await resetPlayer(db, 'gamea1', 'u_alice');
  assert.equal((await continueList(db, 'u_alice')).list[0].resume, null);
});
