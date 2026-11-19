// Two-factor sign-in (src/two-factor.ts): authenticator codes match RFC 6238, a code works once, recovery codes work
// once each, the sign-in challenge dies after five wrong codes or five minutes, and secrets are sealed per account.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { register } from 'node:module';

register('./ts-hook.mjs', import.meta.url);
const tf = await import('../src/two-factor.ts');
const { deleteAccount } = await import('../src/account.ts');

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
function env() {
  const DB = d1();
  DB.sql.prepare("INSERT INTO users (id, email, name, pw_hash, created_at) VALUES ('u1', 'a@x.io', 'Ann', 'h', 0), ('u2', 'b@x.io', 'Bo', 'h', 0)").run();
  return { DB, SESSION_SECRET: 'test-secret-that-is-long-enough', OAUTH_PROVIDER: { listUserGrants: async () => ({ items: [] }), revokeGrant: async () => {} } };
}
const T0 = 1_800_000_000_000;
/** Turns two-factor on for u1 and returns the raw secret and the recovery codes. */
async function turnOn(e, at = T0) {
  const s = await tf.beginSetup(e, { id: 'u1', email: 'a@x.io' }, 'HearthCade', at);
  const secret = tf.unbase32(s.secret);
  const codes = await tf.confirmSetup(e, 'u1', await tf.totpAt(secret, tf.stepOf(at)), at);
  assert.ok(codes);
  return { secret, codes, setup: s };
}

test('codes match the RFC 6238 test vectors (SHA-1, 6 digits)', async () => {
  const key = new TextEncoder().encode('12345678901234567890');
  assert.equal(await tf.totpAt(key, tf.stepOf(59_000)), '287082');
  assert.equal(await tf.totpAt(key, tf.stepOf(1111111109_000)), '081804');
  assert.equal(await tf.totpAt(key, tf.stepOf(1234567890_000)), '005924');
  assert.equal(await tf.totpAt(key, tf.stepOf(2000000000_000)), '279037');
  assert.deepEqual([...tf.unbase32(tf.base32(key))], [...key]);
  assert.equal(tf.base32(key), 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
});

test('a code from one step either side is accepted, two steps away is not', async () => {
  const key = new TextEncoder().encode('12345678901234567890'), s = tf.stepOf(T0);
  assert.equal(await tf.matchTotp(key, await tf.totpAt(key, s - 1), T0), s - 1);
  assert.equal(await tf.matchTotp(key, await tf.totpAt(key, s + 1), T0), s + 1);
  assert.equal(await tf.matchTotp(key, await tf.totpAt(key, s + 2), T0), null);
  assert.equal(await tf.matchTotp(key, 'abcdef', T0), null);
});

test('setup gives an otpauth link for the account, and is on only after a code confirms it', async () => {
  const e = env();
  const s = await tf.beginSetup(e, { id: 'u1', email: 'a@x.io' }, 'HearthCade', T0);
  assert.match(s.uri, /^otpauth:\/\/totp\/HearthCade:a%40x\.io\?secret=[A-Z2-7]{32}&issuer=HearthCade&algorithm=SHA1&digits=6&period=30$/);
  assert.equal((await tf.twoFactorState(e, 'u1')).enabled, false, 'not on before the code');
  assert.equal(await tf.confirmSetup(e, 'u1', '000000', T0), null);
  // a setup left too long expires
  const late = T0 + tf.SETUP_TTL_MS + 60_000, sec = tf.unbase32(s.secret);
  e.DB.sql.prepare('UPDATE users SET totp_pending_at = ? WHERE id = ?').run(T0, 'u1');
  assert.equal(await tf.confirmSetup(e, 'u1', await tf.totpAt(sec, tf.stepOf(late)), late), null);
  e.DB.sql.prepare('UPDATE users SET totp_pending_at = ? WHERE id = ?').run(T0, 'u1');
  const codes = await tf.confirmSetup(e, 'u1', await tf.totpAt(sec, tf.stepOf(T0)), T0);
  assert.equal(codes.length, 10);
  for (const c of codes) assert.match(c, /^[a-z2-9]{5}-[a-z2-9]{5}$/);
  assert.deepEqual(await tf.twoFactorState(e, 'u1'), { enabled: true, enabled_at: T0, recovery_left: 10 });
  assert.equal((await tf.twoFactorState(e, 'u2')).enabled, false, 'other accounts are untouched');
});

test('the secret is stored sealed and bound to its account', async () => {
  const e = env(), { secret } = await turnOn(e);
  const row = e.DB.sql.prepare("SELECT totp_secret, totp_pending FROM users WHERE id = 'u1'").get();
  assert.match(row.totp_secret, /^v1\./); assert.equal(row.totp_pending, null);
  assert.ok(!row.totp_secret.includes(tf.base32(secret)));
  assert.deepEqual([...await tf.unseal(e, 'u1', row.totp_secret)], [...secret]);
  assert.equal(await tf.unseal(e, 'u2', row.totp_secret), null, 'copied to another account it does not open');
  assert.equal(await tf.unseal({ ...e, SESSION_SECRET: 'another' }, 'u1', row.totp_secret), null, 'without the server secret it does not open');
});

test('an authenticator code works once; the next step works again', async () => {
  const e = env(), { secret } = await turnOn(e);
  const t1 = T0 + 30_000, c1 = await tf.totpAt(secret, tf.stepOf(t1));
  assert.equal(await tf.useCode(e, 'u1', c1, t1), 'totp');
  assert.equal(await tf.useCode(e, 'u1', c1, t1), null, 'replayed');
  // an older step that is still inside the window is refused once a newer one was used
  assert.equal(await tf.useCode(e, 'u1', await tf.totpAt(secret, tf.stepOf(T0)), t1), null);
  const t2 = T0 + 60_000;
  assert.equal(await tf.useCode(e, 'u1', ' ' + (await tf.totpAt(secret, tf.stepOf(t2))) + ' ', t2), 'totp');
  assert.equal(await tf.useCode(e, 'u2', await tf.totpAt(secret, tf.stepOf(T0 + 90_000)), T0 + 90_000), null, 'no two-factor on u2');
});

test('recovery codes work once each, in any case and with or without the dash', async () => {
  const e = env(), { codes } = await turnOn(e);
  assert.equal(await tf.useCode(e, 'u1', codes[0].toUpperCase().replace('-', ' '), T0), 'recovery');
  assert.equal(await tf.useCode(e, 'u1', codes[0], T0), null, 'used up');
  assert.equal(await tf.useCode(e, 'u1', 'aaaaa-bbbbb', T0), null);
  assert.equal((await tf.twoFactorState(e, 'u1')).recovery_left, 9);
  const fresh = await tf.replaceRecoveryCodes(e, 'u1');
  assert.equal(await tf.useCode(e, 'u1', codes[1], T0), null, 'old codes stop working');
  assert.equal(await tf.useCode(e, 'u1', fresh[0], T0), 'recovery');
  // another account cannot use them
  e.DB.sql.prepare("UPDATE users SET totp_enabled_at = 1 WHERE id = 'u2'").run();
  assert.equal(await tf.useCode(e, 'u2', fresh[1], T0), null);
  const rows = e.DB.sql.prepare("SELECT id FROM recovery_codes WHERE user_id = 'u1'").all();
  for (const r of rows) assert.match(r.id, /^[0-9a-f]{64}$/, 'only hashes are kept');
});

test('the sign-in challenge: right code signs in once, five wrong codes or five minutes end it', async () => {
  const e = env(), { secret, codes } = await turnOn(e);
  const at = T0 + 30_000, good = await tf.totpAt(secret, tf.stepOf(at));
  const ch = await tf.startChallenge(e, 'u1', at);
  assert.deepEqual(await tf.answerChallenge(e, ch, '111111', at), { ok: false, reason: 'bad_code' });
  assert.deepEqual(await tf.answerChallenge(e, ch, good, at), { ok: true, userId: 'u1', kind: 'totp' });
  assert.deepEqual(await tf.answerChallenge(e, ch, codes[0], at), { ok: false, reason: 'expired' }, 'a challenge signs in once');

  const ch2 = await tf.startChallenge(e, 'u1', at);
  for (let i = 0; i < tf.CHALLENGE_TRIES; i++) assert.equal((await tf.answerChallenge(e, ch2, '000000', at)).reason, 'bad_code');
  assert.deepEqual(await tf.answerChallenge(e, ch2, codes[0], at), { ok: false, reason: 'expired' }, 'the right code no longer helps');

  const ch3 = await tf.startChallenge(e, 'u1', at);
  assert.deepEqual(await tf.answerChallenge(e, ch3, codes[0], at + tf.CHALLENGE_TTL_MS + 1), { ok: false, reason: 'expired' });
  const ch4 = await tf.startChallenge(e, 'u1', at);
  assert.deepEqual(await tf.answerChallenge(e, ch4, codes[0], at), { ok: true, userId: 'u1', kind: 'recovery' });
  assert.deepEqual(await tf.answerChallenge(e, 'not-a-challenge', good, at), { ok: false, reason: 'expired' });
  const ids = e.DB.sql.prepare('SELECT id FROM login_challenges').all();
  for (const r of ids) assert.match(r.id, /^[0-9a-f]{64}$/, 'only hashes are kept');
});

test('turning it off, or deleting the account, forgets the secret, the codes and open challenges', async () => {
  const e = env(), { codes } = await turnOn(e);
  await tf.startChallenge(e, 'u1', T0);
  await tf.disableTwoFactor(e, 'u1');
  assert.deepEqual(await tf.twoFactorState(e, 'u1'), { enabled: false, enabled_at: null, recovery_left: 0 });
  assert.equal(await tf.useCode(e, 'u1', codes[2], T0), null);
  assert.equal(e.DB.sql.prepare("SELECT totp_secret FROM users WHERE id = 'u1'").get().totp_secret, null);
  assert.equal(e.DB.sql.prepare('SELECT COUNT(*) AS n FROM login_challenges').get().n, 0);

  await turnOn(e, T0 + 120_000);
  await tf.startChallenge(e, 'u1', T0);
  await deleteAccount(e, 'u1');
  const u = e.DB.sql.prepare("SELECT totp_secret, totp_enabled_at FROM users WHERE id = 'u1'").get();
  assert.equal(u.totp_secret, null); assert.equal(u.totp_enabled_at, null);
  assert.equal(e.DB.sql.prepare("SELECT COUNT(*) AS n FROM recovery_codes WHERE user_id = 'u1'").get().n, 0);
  assert.equal(e.DB.sql.prepare("SELECT COUNT(*) AS n FROM login_challenges WHERE user_id = 'u1'").get().n, 0);
});
