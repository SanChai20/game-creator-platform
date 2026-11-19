// Account basics (security review, finding 8): deleting an account removes what is about the person and keeps the
// records the platform must keep; a password reset link works once and only for an hour.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { register } from 'node:module';

register('./ts-hook.mjs', import.meta.url);
const { deleteAccount, deleteBlocker, newResetToken, takeResetToken, RESET_TTL_MS } = await import('../src/account.ts');

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
const T = Date.now();
function env() {
  const DB = d1(), revoked = [];
  const grants = [{ id: 'g1' }, { id: 'g2' }];
  const OAUTH_PROVIDER = { listUserGrants: async () => ({ items: grants }), revokeGrant: async (id, uid) => revoked.push(id + ':' + uid) };
  const q = (s, ...a) => DB.sql.prepare(s).run(...a);
  q("INSERT INTO users (id, email, name, pw_hash, created_at) VALUES ('u1', 'a@x.io', 'Ann', 'pbkdf2$1$a$b', 0), ('u2', 'b@x.io', 'Bo', 'h', 0)");
  q("INSERT INTO projects (id, owner_id, slug, title, status, rating_sum, rating_count, created_at, updated_at) VALUES ('gamea1', 'u2', 'a', 'A', 'live', 9, 2, 0, 0), ('gameb1', 'u2', 'b', 'B', 'live', 2, 0, 0, 0)");
  q("INSERT INTO reviews (project_id, user_id, rating, created_at, updated_at) VALUES ('gamea1', 'u1', 4, 0, 0), ('gamea1', 'u2', 5, 0, 0)");
  q("INSERT INTO reviews (project_id, user_id, rating, hidden, created_at, updated_at) VALUES ('gameb1', 'u1', 2, 1, 0, 0)");
  q("INSERT INTO saves (project_id, user_id, k, v, updated_at) VALUES ('gamea1', 'u1', 'slot', '{}', 0), ('gamea1', 'u2', 'slot', '{}', 0)");
  q("INSERT INTO scores (project_id, board, user_id, name, score, updated_at) VALUES ('gamea1', 'main', 'u1', 'Ann', 10, 0)");
  q("INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES ('s1', 'u1', 0, ?), ('s2', 'u1', 0, ?), ('s3', 'u2', 0, ?)", T + 1e9, T + 1e9, T + 1e9);
  q("INSERT INTO purchases (id, user_id, project_id, owner_id, price_cents, fee_cents, net_cents, status, provider, provider_ref, created_at) VALUES ('p1', 'u1', 'gamea1', 'u2', 500, 50, 450, 'paid', 'stripe', 'r1', 0)");
  return { DB, OAUTH_PROVIDER, revoked };
}

test('deleting an account removes the person and keeps purchases and ratings consistent', async () => {
  const e = env();
  assert.equal(await deleteBlocker(e, { id: 'u1', role: 'user' }), null);
  await deleteAccount(e, 'u1');
  const u = e.DB.sql.prepare("SELECT * FROM users WHERE id = 'u1'").get();
  assert.equal(u.status, 'deleted'); assert.notEqual(u.email, 'a@x.io'); assert.equal(u.name, 'Deleted account'); assert.equal(u.pw_hash, '!');
  const count = (t, w = "user_id = 'u1'") => e.DB.sql.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE ${w}`).get().n;
  for (const t of ['reviews', 'saves', 'scores', 'sessions']) assert.equal(count(t), 0, t);
  assert.equal(count('saves', "user_id = 'u2'"), 1); assert.equal(count('sessions', "user_id = 'u2'"), 1);
  assert.equal(count('purchases'), 1, 'the purchase record stays');
  // the visible review leaves the rating; the hidden one was never counted
  assert.deepEqual({ ...e.DB.sql.prepare("SELECT rating_sum, rating_count FROM projects WHERE id = 'gamea1'").get() }, { rating_sum: 5, rating_count: 1 });
  assert.deepEqual({ ...e.DB.sql.prepare("SELECT rating_sum, rating_count FROM projects WHERE id = 'gameb1'").get() }, { rating_sum: 2, rating_count: 0 });
  assert.deepEqual(e.revoked, ['g1:u1', 'g2:u1']);
  // the address can be used for a new account
  e.DB.sql.prepare("INSERT INTO users (id, email, name, pw_hash, created_at) VALUES ('u3', 'a@x.io', 'Ann', 'h', 0)").run();
});

test('an account with games, earnings or an admin role cannot be deleted yet', async () => {
  const e = env();
  assert.match(await deleteBlocker(e, { id: 'u2', role: 'user' }), /2 games on the platform/);
  assert.match(await deleteBlocker(e, { id: 'u1', role: 'admin' }), /admin/);
  e.DB.sql.prepare("INSERT INTO ledger (user_id, kind, amount_cents, available_at, created_at) VALUES ('u1', 'adjustment', 100, 0, 0)").run();
  assert.match(await deleteBlocker(e, { id: 'u1', role: 'user' }), /earnings/);
});

test('a reset link works once, only for an hour, and a newer link replaces it', async () => {
  const e = env();
  const a = await newResetToken(e, 'u1'), b = await newResetToken(e, 'u1');
  assert.equal(await takeResetToken(e, a), null, 'the earlier link stopped working');
  assert.equal(await takeResetToken(e, b), 'u1');
  assert.equal(await takeResetToken(e, b), null, 'used once');
  const c = await newResetToken(e, 'u1');
  e.DB.sql.prepare('UPDATE password_resets SET expires_at = ?').run(T - 1);
  assert.equal(await takeResetToken(e, c), null, 'expired');
  assert.ok(RESET_TTL_MS <= 3600000);
  assert.ok(!e.DB.sql.prepare('SELECT id FROM password_resets').all().some((r) => r.id === c), 'only the hash is stored');
});
