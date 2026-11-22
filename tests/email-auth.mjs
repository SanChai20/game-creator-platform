// Signing up and in without passwords (src/email-auth.ts, src/auth-mail.ts): a sign-up link creates nothing until it is
// used and works once; a sign-in code works once, for 10 minutes and 5 tries; an email with no account gets a handle no
// code ever matches; a proof keeps a sign-in confirmed for ten minutes. The migration drops every password.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { register } from 'node:module';

register('./ts-hook.mjs', import.meta.url);
const A = await import('../src/email-auth.ts');
const { renderAuthMail } = await import('../src/auth-mail.ts');

function d1(seed = '') {
  const sql = new DatabaseSync(':memory:');
  const dir = new URL('../migrations/', import.meta.url), files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) { if (f.startsWith('0043') && seed) sql.exec(seed); sql.exec(readFileSync(new URL(f, dir), 'utf8')); }
  const stmt = (q, args = []) => ({
    bind: (...a) => stmt(q, a),
    first: async () => sql.prepare(q).get(...args) ?? null,
    all: async () => ({ results: sql.prepare(q).all(...args) }),
    run: async () => { const r = sql.prepare(q).run(...args); return { meta: { changes: Number(r.changes) } }; },
  });
  return { prepare: (q) => stmt(q), batch: async (l) => { for (const s of l) await s.run(); }, sql };
}
const env = () => ({ DB: d1(), SESSION_SECRET: 'test-secret' });
const T = 1_800_000_000_000;

test('emails, names and return paths are cleaned', () => {
  assert.equal(A.normEmail('  Ann@Example.COM '), 'ann@example.com');
  assert.ok(A.validEmail('a@b.co'));
  for (const bad of ['', 'a@b', 'a b@c.d', '@c.d', 'a@.d', 'a@b.']) assert.ok(!A.validEmail(bad), bad);
  assert.equal(A.cleanName(' Ann\u0000 '), 'Ann');
  assert.equal(A.safeNext('/g/abc?x=1'), '/g/abc?x=1');
  for (const bad of ['//evil.com', 'https://evil.com', '/\\evil.com', 'g/abc', '']) assert.equal(A.safeNext(bad), null, bad);
});

test('codes are six digits, drawn evenly', () => {
  const seen = new Set();
  for (let i = 0; i < 2000; i++) { const c = A.newCode(); assert.match(c, /^\d{6}$/); seen.add(c[0]); }
  assert.equal(seen.size, 10, 'every leading digit shows up');
});

test('a sign-up link creates nothing by itself, works once and only for a day', async () => {
  const e = env();
  const a = await A.newSignupLink(e, 'ann@x.io', 'Ann', '/g/fun', T);
  assert.equal(e.DB.sql.prepare('SELECT COUNT(*) AS n FROM users').get().n, 0, 'no account yet');
  assert.deepEqual({ ...(await A.peekSignupLink(e, a, T + 1)) }, { email: 'ann@x.io', name: 'Ann', next: '/g/fun' });
  assert.ok(await A.peekSignupLink(e, a, T + 2), 'peeking does not use it');
  const b = await A.newSignupLink(e, 'ann@x.io', 'Ann B', null, T + 10);
  assert.equal(await A.takeSignupLink(e, a, T + 11), null, 'a newer link replaces the older one');
  assert.equal((await A.takeSignupLink(e, b, T + 12)).name, 'Ann B');
  assert.equal(await A.takeSignupLink(e, b, T + 13), null, 'used once');
  const c = await A.newSignupLink(e, 'bo@x.io', 'Bo', null, T);
  assert.equal(await A.takeSignupLink(e, c, T + A.LINK_TTL_MS + 1), null, 'expired');
  assert.ok(!e.DB.sql.prepare('SELECT id FROM signup_links').all().some((r) => r.id === c), 'only the hash is kept');
  assert.equal(await A.takeSignupLink(e, 'x'.repeat(200), T), null);
});

test('a sign-in code works once, within ten minutes and five tries', async () => {
  const e = env();
  const { handle, code } = await A.startCode(e, 'login', 'ann@x.io', 'u1', T);
  assert.match(code, /^\d{6}$/);
  const wrong = code === '000000' ? '111111' : '000000';
  assert.deepEqual(await A.checkCode(e, 'login', handle, wrong, T + 1), { ok: false, reason: 'bad_code' });
  assert.deepEqual(await A.checkCode(e, 'confirm', handle, code, T + 1), { ok: false, reason: 'expired' }, 'a code is for one purpose');
  const s2 = await A.startCode(e, 'login', 'ann@x.io', 'u1', T);
  assert.deepEqual({ ...(await A.checkCode(e, 'login', s2.handle, s2.code, T + 2)) }, { ok: true, userId: 'u1', email: 'ann@x.io' });
  assert.equal((await A.checkCode(e, 'login', s2.handle, s2.code, T + 3)).ok, false, 'used once');
  assert.equal((await A.checkCode(e, 'login', handle, code, T + 3)).ok, false, 'a new code replaced the first');
  const s3 = await A.startCode(e, 'login', 'ann@x.io', 'u1', T);
  for (let i = 0; i < A.CODE_TRIES; i++) await A.checkCode(e, 'login', s3.handle, s3.code === '999999' ? '888888' : '999999', T + 4);
  assert.deepEqual(await A.checkCode(e, 'login', s3.handle, s3.code, T + 5), { ok: false, reason: 'expired' }, 'five wrong tries end it');
  const s4 = await A.startCode(e, 'login', 'ann@x.io', 'u1', T);
  assert.deepEqual(await A.checkCode(e, 'login', s4.handle, s4.code, T + A.CODE_TTL_MS + 1), { ok: false, reason: 'expired' });
  assert.ok(!JSON.stringify(e.DB.sql.prepare('SELECT * FROM email_codes').all()).includes(s4.code), 'the code is not stored');
});

test('an email with no account gets a handle that never signs in', async () => {
  const e = env();
  const { handle, code } = await A.startCode(e, 'login', 'nobody@x.io', null, T);
  assert.equal(code, null);
  for (const c of ['000000', '123456', '999999']) assert.equal((await A.checkCode(e, 'login', handle, c, T + 1)).ok, false);
});

test('a proof keeps a sign-in confirmed for ten minutes', async () => {
  const e = env();
  e.DB.sql.prepare("INSERT INTO sessions (id, user_id, created_at, expires_at, confirmed_at) VALUES ('s1', 'u1', ?, ?, ?)").run(T, T + 1e10, T);
  assert.equal(await A.confirmedUntil(e, 's1', T + 1000), T + A.CONFIRM_WINDOW_MS);
  assert.equal(await A.confirmedUntil(e, 's1', T + A.CONFIRM_WINDOW_MS + 1), 0);
  await A.markConfirmed(e, 's1', T + A.CONFIRM_WINDOW_MS + 5);
  assert.ok(await A.confirmedUntil(e, 's1', T + A.CONFIRM_WINDOW_MS + 6) > 0);
  assert.equal(await A.confirmedUntil(e, null, T), 0);
});

test('the migration drops every password and open reset link', () => {
  const db = d1("INSERT INTO users (id, email, name, pw_hash, created_at) VALUES ('u1', 'a@x.io', 'A', 'pbkdf2$100000$abc$def', 0), ('u2', 'deleted-u2@deleted.invalid', 'Deleted account', '!', 0); INSERT INTO password_resets (id, user_id, created_at, expires_at) VALUES ('r', 'u1', 0, 9e15);");
  assert.equal(db.sql.prepare("SELECT pw_hash FROM users WHERE id = 'u1'").get().pw_hash, '');
  assert.equal(db.sql.prepare("SELECT pw_hash FROM users WHERE id = 'u2'").get().pw_hash, '!');
  assert.equal(db.sql.prepare('SELECT COUNT(*) AS n FROM password_resets').get().n, 0);
});

test('the sign-in emails exist in every language and carry the code or link', () => {
  for (const l of ['en', 'zh', 'zh-TW', 'ja', 'ko', 'es']) {
    const c = renderAuthMail(l, 'HearthCade', { kind: 'login_code', name: 'Ann <b>', code: '482913' });
    assert.ok(c.subject.includes('482913') && c.text.includes('482913') && c.html.includes('482913'), l);
    assert.ok(!c.html.includes('<b>'), 'names are escaped');
    const k = renderAuthMail(l, 'HearthCade', { kind: 'signup_link', name: 'Ann', link: 'https://h.test/verify?token=abc' });
    assert.ok(k.text.includes('https://h.test/verify?token=abc') && k.html.includes('href="https://h.test/verify?token=abc"'), l);
    for (const kind of ['signup_exists', 'login_unknown']) assert.ok(renderAuthMail(l, 'HearthCade', { kind, link: 'https://h.test/x' }).subject, `${l} ${kind}`);
    assert.ok(renderAuthMail(l, 'HearthCade', { kind: 'confirm_code', name: '', code: '111222' }).text.includes('111222'));
  }
});

test('nothing reads or writes a password any more', () => {
  const api = readFileSync(new URL('../src/routes/api.ts', import.meta.url), 'utf8'), auth = readFileSync(new URL('../src/auth.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(api + auth, /checkPassword|hashPassword|pw_hash = \?/);
  for (const f of ['Auth.tsx', 'Account.tsx']) assert.doesNotMatch(readFileSync(new URL(`../web/src/pages/${f}`, import.meta.url), 'utf8'), /type="password"/, f);
});

test('the live-test mailbox answers only @example.com, only with the exact secret', async () => {
  const { testMailbox } = await import('../src/mail.ts');
  const secret = 'x'.repeat(40), req = (h) => new Request('https://h/', { headers: h ? { 'x-test-mail': h } : {} });
  assert.equal(testMailbox({ TEST_MAIL_TOKEN: secret }, req(secret), 'smoke-1@example.com'), true);
  assert.equal(testMailbox({ TEST_MAIL_TOKEN: secret }, req(secret), 'someone@gmail.com'), false);
  assert.equal(testMailbox({ TEST_MAIL_TOKEN: secret }, req(secret), 'a@example.com.evil.io'), false);
  assert.equal(testMailbox({ TEST_MAIL_TOKEN: secret }, req('x'.repeat(39) + 'y'), 'a@example.com'), false);
  assert.equal(testMailbox({ TEST_MAIL_TOKEN: secret }, req(), 'a@example.com'), false);
  assert.equal(testMailbox({ TEST_MAIL_TOKEN: 'short' }, req('short'), 'a@example.com'), false);
  assert.equal(testMailbox({}, req(''), 'a@example.com'), false);
});

test('the live-test secret stays on the server: no client code or config names it', () => {
  const ls = readdirSync;
  const walk = (d) => ls(d).flatMap((f) => { const p = `${d}/${f}`; return statSync(p).isDirectory() ? walk(p) : [p]; });
  const root = new URL('..', import.meta.url).pathname;
  const files = ['web/src', 'web/public', 'web/dist'].flatMap((d) => { try { return walk(root + d); } catch { return []; } }).filter((f) => /\.(m?[jt]sx?|html|json|md)$/.test(f));
  assert.ok(files.length > 20);
  for (const f of files) assert.doesNotMatch(readFileSync(f, 'utf8'), /TEST_MAIL_TOKEN|x-test-mail|test_token|test_code/, f);
  // a secret, never a plain [vars] value in the Worker config
  for (const f of ls(root).filter((f) => /^wrangler\./.test(f))) assert.doesNotMatch(readFileSync(root + f, 'utf8'), /TEST_MAIL_TOKEN/, f);
});
