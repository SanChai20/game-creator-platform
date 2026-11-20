// Publishing switches the live version: on the shared host (which serves whatever live_version names) the switch has
// to come before the health check, or a publish can never pass it; a game that then does not answer is put back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { register } from 'node:module';

register('./ts-hook.mjs', import.meta.url);
const { switchLive } = await import('../src/go-live.ts');

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
  return { prepare: (q) => stmt(q), batch: async (l) => { for (const s of l) await s.run(); }, sql };
}
function setup() {
  const DB = d1();
  DB.sql.prepare("INSERT INTO projects (id, owner_id, slug, title, status, live_version, preview_version, next_version, cover_key, created_at, updated_at, published_at) VALUES ('g1', 'u1', 'g', 'G', 'live', 30, 31, 32, 'c30', 0, 0, 111)").run();
  for (const n of [30, 31]) DB.sql.prepare("INSERT INTO versions (project_id, n, status, created_at, published_at, screenshot_key) VALUES ('g1', ?, 'verified', 0, ?, ?)").run(n, n === 30 ? 111 : null, 's' + n);
  const env = { DB };
  const p = DB.sql.prepare("SELECT * FROM projects WHERE id = 'g1'").get();
  const v = DB.sql.prepare("SELECT * FROM versions WHERE project_id = 'g1' AND n = 31").get();
  const live = () => DB.sql.prepare("SELECT status, live_version, published_at, cover_key FROM projects WHERE id = 'g1'").get();
  const pub = () => DB.sql.prepare("SELECT published_at FROM versions WHERE project_id = 'g1' AND n = 31").get().published_at;
  return { env, p, v, live, pub };
}
// a stand-in for the shared host: it answers with whatever version the database says is live
const sharedHost = (s) => async (_env, _url, n) => (s.live().live_version === n ? { ok: true, detail: 'healthy' } : { ok: false, detail: `answers ${s.live().live_version}` });

test('shared host: the publish goes live (the switch comes before the health check)', async () => {
  const s = setup(); const order = [];
  const h = await switchLive(s.env, s.p, s.v, 'u', true, async (...a) => { order.push('health'); return sharedHost(s)(...a); }, async () => { order.push('before'); });
  assert.equal(h.ok, true);
  assert.equal(s.live().live_version, 31);
  assert.ok(s.pub() > 0);
  assert.deepEqual(order, ['before', 'health']);
});

test('shared host: a game that does not answer is put back as it was', async () => {
  const s = setup();
  const h = await switchLive(s.env, s.p, s.v, 'u', true, async () => ({ ok: false, detail: 'timeout' }));
  assert.equal(h.ok, false);
  assert.deepEqual({ ...s.live() }, { status: 'live', live_version: 30, published_at: 111, cover_key: 'c30' });
  assert.equal(s.pub(), null);
});

test('own Worker: nothing changes until the health check passes', async () => {
  const s = setup(); let seen = null;
  const h = await switchLive(s.env, s.p, s.v, 'u', false, async () => { seen = s.live().live_version; return { ok: true, detail: 'healthy' }; });
  assert.equal(h.ok, true); assert.equal(seen, 30); assert.equal(s.live().live_version, 31);
  const s2 = setup();
  const h2 = await switchLive(s2.env, s2.p, s2.v, 'u', false, async () => ({ ok: false, detail: 'timeout' }));
  assert.equal(h2.ok, false); assert.equal(s2.live().live_version, 30); assert.equal(s2.pub(), null);
});

test('the publish job uses it, with the host the game was deployed to', () => {
  const src = readFileSync(new URL('../src/pipeline.ts', import.meta.url), 'utf8');
  const body = src.slice(src.indexOf('async function runPublish'));
  assert.match(body, /switchLive\(env, p, v, url, await onSharedHost\(env, p\.id, 'live'\), waitHealthy/);
  assert.doesNotMatch(body.slice(0, body.indexOf('\n}\n')), /UPDATE projects SET status = 'live'/);
});
