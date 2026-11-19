// Creator licenses (src/license.ts): two one-time kinds, time-limited and lifetime.
// Proves: a term license counts only until it ends and then is no license at all; lifetime never ends; licenses granted
// before there were two kinds are lifetime; an account with a valid license cannot get another (a paid grant is refused
// so the caller refunds it), while an expired term can be followed by either kind; a refund of one grant leaves the
// others; an admin removal takes every grant back. Real migrations, in-memory SQLite.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { register } from 'node:module';

register('./ts-hook.mjs', import.meta.url);
const { licenseOf, withLicense, licenseFromGrants, grantLicense, revokeLicense, syncLicense, currentLicense, offers, offersText } = await import('../src/license.ts');
const { SETTING_DEFS } = await import('../src/settings.ts');

function d1(upTo) {
  const sql = new DatabaseSync(':memory:');
  const dir = new URL('../migrations/', import.meta.url);
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) { if (upTo && f > upTo) break; sql.exec(readFileSync(new URL(f, dir), 'utf8')); }
  const stmt = (q, args = []) => ({
    bind: (...a) => stmt(q, a),
    first: async () => sql.prepare(q).get(...args) ?? null,
    all: async () => ({ results: sql.prepare(q).all(...args) }),
    run: async () => { const r = sql.prepare(q).run(...args); return { meta: { changes: Number(r.changes) } }; },
  });
  return { prepare: (q) => stmt(q), sql, run: (f) => sql.exec(readFileSync(new URL(f, dir), 'utf8')) };
}
const S = { license_term_cents: 1000, license_term_days: 365, license_lifetime_cents: 5000 };
const DAY = 86400000;
function env() {
  const DB = d1();
  DB.sql.prepare("INSERT INTO users (id, email, name, pw_hash, created_at) VALUES ('u1', 'a@x.y', 'A', '', 0)").run();
  return { DB };
}
const row = (e) => e.DB.sql.prepare("SELECT creator, creator_plan, creator_until FROM users WHERE id = 'u1'").get();

test('defaults: $10 for 365 days, $50 lifetime, both one-time', () => {
  assert.equal(SETTING_DEFS.license_term_cents.v, 1000);
  assert.equal(SETTING_DEFS.license_term_days.v, 365);
  assert.equal(SETTING_DEFS.license_lifetime_cents.v, 5000);
  assert.deepEqual(offers(S), [{ plan: 'term', cents: 1000, days: 365 }, { plan: 'lifetime', cents: 5000, days: null }]);
  assert.match(offersText(S), /\$10\.00, valid 365 days.*\$50\.00, never expires.*not subscriptions/);
});

test('a term license counts until it ends, then it is no license; lifetime never ends', () => {
  const at = 1_000_000;
  assert.deepEqual(licenseOf({ creator: 1, creator_plan: 'term', creator_until: at + 1 }, at), { active: true, plan: 'term', until: at + 1, since: null, expired: false });
  assert.equal(licenseOf({ creator: 1, creator_plan: 'term', creator_until: at }, at).active, false);
  assert.equal(licenseOf({ creator: 1, creator_plan: 'term', creator_until: at }, at).expired, true);
  assert.equal(licenseOf({ creator: 1, creator_plan: 'lifetime', creator_until: null }, 9e15).active, true);
  assert.equal(licenseOf({ creator: 1, creator_plan: null }).plan, 'lifetime');   // granted before there were two kinds
  assert.equal(licenseOf({ creator: 0 }).active, false);
  // the rest of the platform reads `creator`: 1 only while valid, the stored flag kept beside it
  const u = withLicense({ id: 'x', creator: 1, creator_plan: 'term', creator_until: at - 1 }, at);
  assert.equal(u.creator, 0); assert.equal(u.creator_licensed, 1);
});

test('grants add up: lifetime wins, otherwise the term that ends last', () => {
  assert.deepEqual(licenseFromGrants([]), { creator: 0, plan: null, until: null });
  assert.deepEqual(licenseFromGrants([{ plan: 'term', expires_at: 5 }, { plan: 'term', expires_at: 9 }]), { creator: 1, plan: 'term', until: 9 });
  assert.deepEqual(licenseFromGrants([{ plan: 'term', expires_at: 5 }, { plan: 'lifetime', expires_at: null }]), { creator: 1, plan: 'lifetime', until: null });
});

test('the migration turns every existing license into lifetime', () => {
  const DB = d1('0025_library.sql');
  DB.sql.prepare("INSERT INTO users (id, email, name, pw_hash, creator, creator_since, created_at) VALUES ('old', 'o@x.y', 'O', '', 1, 5, 0)").run();
  DB.sql.prepare("INSERT INTO payments (id, user_id, kind, amount_cents, provider, provider_ref, status, created_at) VALUES ('p', 'old', 'creator_fee', 3000, 'stripe', 'cs_old', 'paid', 5)").run();
  DB.run('0026_creator_licenses.sql');
  assert.deepEqual({ ...DB.sql.prepare("SELECT creator, creator_plan, creator_until FROM users").get() }, { creator: 1, creator_plan: 'lifetime', creator_until: null });
  assert.equal(DB.sql.prepare("SELECT plan FROM payments").get().plan, 'lifetime');
});

test('a term grant runs for the configured days; while it is valid no other license can be had', async () => {
  const e = env(), t0 = Date.now();
  assert.equal(await grantLicense(e, S, 'u1', 'term', 'stripe', 'cs_a', 1000), 'granted');
  const r = row(e);
  assert.equal(r.creator, 1); assert.equal(r.creator_plan, 'term');
  assert.ok(Math.abs(r.creator_until - (t0 + 365 * DAY)) < 5000);
  assert.equal(await grantLicense(e, S, 'u1', 'term', 'stripe', 'cs_a', 1000), 'exists');              // confirm, then the webhook
  assert.equal(await grantLicense(e, S, 'u1', 'lifetime', 'stripe', 'cs_b', 5000), 'already_licensed'); // the other kind: refused
  assert.equal(await grantLicense(e, S, 'u1', 'term', 'stripe', 'cs_c', 1000), 'already_licensed');     // the same kind again: refused
  assert.equal(row(e).creator_plan, 'term');
});

test('after a term ends, the account can get either kind again', async () => {
  const e = env();
  await grantLicense(e, { ...S, license_term_days: 30 }, 'u1', 'term', 'stripe', 'cs_a', 1000);
  e.DB.sql.prepare("UPDATE payments SET expires_at = 1").run(); await syncLicense(e, 'u1');
  assert.equal((await currentLicense(e, 'u1')).expired, true);
  assert.equal(await grantLicense(e, S, 'u1', 'lifetime', 'stripe', 'cs_b', 5000), 'granted');
  assert.deepEqual({ ...row(e) }, { creator: 1, creator_plan: 'lifetime', creator_until: null });
});

test('a refunded grant is taken back; an admin removal takes back every grant', async () => {
  const e = env();
  await grantLicense(e, S, 'u1', 'lifetime', 'stripe', 'cs_a', 5000);
  e.DB.sql.prepare("UPDATE payments SET status = 'refunded' WHERE provider_ref = 'cs_a'").run(); await syncLicense(e, 'u1');
  assert.equal(row(e).creator, 0);
  await grantLicense(e, S, 'u1', 'term', 'admin', 'grant:1', 0, true);
  await grantLicense(e, S, 'u1', 'lifetime', 'admin', 'grant:2', 0, true);
  assert.equal(row(e).creator_plan, 'lifetime');
  await revokeLicense(e, 'u1');
  assert.equal(row(e).creator, 0);
  assert.equal(e.DB.sql.prepare("SELECT COUNT(*) AS n FROM payments WHERE status = 'revoked'").get().n, 2);
});
