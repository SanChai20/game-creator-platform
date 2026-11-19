// Hosting stays within its limits: old versions' files are deleted (never the live, preview, newest or recently live
// ones), and idle preview Workers are removed, then brought back when the preview is opened again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { register } from 'node:module';

register('./ts-hook.mjs', import.meta.url);
const { purgeOldVersions, purgeRemovedGameData, retireIdlePreviews, KEEP_VERSIONS } = await import('../src/cleanup.ts');

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
  return { prepare: (q) => stmt(q), batch: async (l) => Promise.all(l.map((s) => s.run())), sql };
}
const DAY = 86400000, T = Date.now();
function bucket(keys) {
  const objs = new Set(keys);
  return { objs, list: async ({ prefix }) => ({ objects: [...objs].filter((k) => k.startsWith(prefix)).map((key) => ({ key })), truncated: false }), delete: async (ks) => { for (const k of ks) objs.delete(k); } };
}

test('old versions lose their files; live, preview, the newest and recently live ones keep them', async () => {
  const DB = d1();
  // versions 1..12, all 60 days old; 3 is live, 4 is the preview, 2 was live 10 days ago, 1 was live a year ago
  DB.sql.prepare("INSERT INTO projects (id, owner_id, slug, title, status, live_version, preview_version, next_version, created_at, updated_at) VALUES ('gamea1', 'u1', 'a', 'A', 'live', 3, 4, 13, 0, 0)").run();
  const keys = [];
  for (let n = 1; n <= 12; n++) {
    const pub = n === 2 ? T - 10 * DAY : n === 1 ? T - 365 * DAY : n === 3 ? T - 5 * DAY : null;
    DB.sql.prepare("INSERT INTO versions (project_id, n, status, created_at, published_at) VALUES ('gamea1', ?, 'verified', ?, ?)").run(n, T - 60 * DAY, pub);
    keys.push(`v/gamea1/${n}/index.html`, `v/gamea1/${n}/a.js`);
  }
  const FILES = bucket(keys);
  const out = await purgeOldVersions({ DB, FILES });
  const kept = (n) => FILES.objs.has(`v/gamea1/${n}/index.html`);
  assert.deepEqual(out.sort(), ['gamea1/1', 'gamea1/5', 'gamea1/6', 'gamea1/7'].sort());
  for (const n of [2, 3, 4]) assert.ok(kept(n), `version ${n} kept`);
  for (let n = 13 - KEEP_VERSIONS; n <= 12; n++) assert.ok(kept(n), `newest version ${n} kept`);
  assert.ok(!kept(1) && !FILES.objs.has('v/gamea1/1/a.js'));
  assert.ok(DB.sql.prepare("SELECT purged_at FROM versions WHERE project_id = 'gamea1' AND n = 1").get().purged_at > 0);
  assert.deepEqual(await purgeOldVersions({ DB, FILES }), [], 'nothing twice');
});

test('a preview nobody opened for two weeks is removed and marked, so the rollout leaves it alone', async () => {
  const DB = d1();
  DB.sql.exec(`INSERT INTO projects (id, owner_id, slug, title, status, preview_version, created_at, updated_at) VALUES ('gamea1', 'u1', 'a', 'A', 'draft', 1, 0, 0), ('gameb2', 'u1', 'b', 'B', 'draft', 1, 0, 0);
    INSERT INTO game_workers (project_id, env, version, runtime, origin, deployed_at, host, script) VALUES ('gamea1', 'preview', 1, 'r', 'o', ${T - 30 * DAY}, 'local', 's'), ('gameb2', 'preview', 1, 'r', 'o', ${T - 30 * DAY}, 'local', 's');
    INSERT INTO plays (id, project_id, version, env, user_id, kind, started_at, last_beat_at) VALUES ('ps1', 'gameb2', 1, 'preview', 'u1', 'owner', ${T - DAY}, ${T - DAY});`);
  const out = await retireIdlePreviews({ DB, DEPLOY_DRIVER: 'local' });
  assert.deepEqual(out, ['gamea1'], 'the one played yesterday stays');
  assert.ok(DB.sql.prepare("SELECT idle_at FROM game_workers WHERE project_id = 'gamea1'").get().idle_at > 0);
});

test('players\' data of a game removed more than 30 days ago is deleted; recently removed and live games keep theirs', async () => {
  const DB = d1();
  const q = (x, ...a) => DB.sql.prepare(x).run(...a);
  q("INSERT INTO projects (id, owner_id, slug, title, status, created_at, updated_at) VALUES ('gameold', 'u1', 'o', 'O', 'removed', 0, ?), ('gamenew', 'u1', 'n', 'N', 'removed', 0, ?), ('gamelive', 'u1', 'l', 'L', 'live', 0, 0)", T - 40 * DAY, T - 5 * DAY);
  for (const pid of ['gameold', 'gameold:preview', 'gamenew', 'gamelive']) {
    q("INSERT INTO saves (project_id, user_id, k, v, updated_at) VALUES (?, 'u2', 'slot', '{}', 0)", pid);
    q("INSERT INTO scores (project_id, board, user_id, name, score, updated_at) VALUES (?, 'main', 'u2', 'B', 1, 0)", pid);
  }
  q("INSERT INTO purchases (id, user_id, project_id, owner_id, price_cents, fee_cents, net_cents, status, provider, provider_ref, created_at) VALUES ('p1', 'u2', 'gameold', 'u1', 500, 50, 450, 'paid', 'stripe', 'r1', 0)");
  assert.deepEqual(await purgeRemovedGameData({ DB }), ['gameold']);
  const left = (tb) => DB.sql.prepare(`SELECT project_id FROM ${tb} ORDER BY project_id`).all().map((r) => r.project_id);
  assert.deepEqual(left('saves'), ['gamelive', 'gamenew']);
  assert.deepEqual(left('scores'), ['gamelive', 'gamenew']);
  assert.deepEqual(left('purchases'), ['gameold']);
  assert.deepEqual(await purgeRemovedGameData({ DB }), [], 'done once');
});
