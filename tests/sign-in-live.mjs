// Signing up and in against a running local Worker (npm run dev, with DEV_MAIL=1 in .dev.vars so emails are kept for
// /api/dev/mail): the sign-up link, the email code, two-factor after it, confirming before sensitive changes, agent
// device sign-in, deleting the account, and what crawlers see.   node tests/sign-in-live.mjs
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { register } from 'node:module';

register('./ts-hook.mjs', import.meta.url);
const { totpAt, stepOf, unbase32 } = await import('../src/two-factor.ts');
const BASE = process.env.BASE || 'http://127.0.0.1:8787', run = randomBytes(3).toString('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let n = 0; const ok = (m) => console.log(`  ✓ ${++n} ${m}`);
function client() {
  const jar = new Map();
  const call = async (method, path, body) => {
    const r = await fetch(BASE + path, { method, redirect: 'manual', headers: { ...(body ? { 'content-type': 'application/json' } : {}), origin: BASE, cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') }, body: body ? JSON.stringify(body) : undefined });
    for (const c of r.headers.getSetCookie()) { const [kv] = c.split(';'); const i = kv.indexOf('='); jar.set(kv.slice(0, i), kv.slice(i + 1)); }
    const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { /* text */ }
    return { status: r.status, json, text, headers: r.headers };
  };
  return { get: (p) => call('GET', p), post: (p, b = {}) => call('POST', p, b) };
}
const must = (r, code = 200) => { assert.equal(r.status, code, `expected ${code}, got ${r.status}: ${r.text.slice(0, 300)}`); return r.json; };
async function mail(to, re) {
  for (let i = 0; i < 30; i++) { const m = (await (await fetch(`${BASE}/api/dev/mail?to=${encodeURIComponent(to)}`)).json()).mail.filter((x) => re.test(x.text)).pop(); if (m) return m; await sleep(100); }
  throw new Error('no mail to ' + to);
}
const codeIn = async (to, re) => (await mail(to, re)).text.match(/(\d{6})/)[1];

const A = client(), email = `live-${run}@example.com`;
must(await A.post('/api/auth/signup', { email, name: 'Live ' + run, next: '/g/some-game' }));
assert.equal(must(await A.get('/api/me')).user, null);
const token = (await mail(email, /verify\?token=/)).text.match(/verify\?token=([\w-]+)/)[1];
const peek = must(await A.get('/api/auth/signup/link?token=' + token));
assert.deepEqual(peek, { email, name: 'Live ' + run, exists: false });
const made = must(await A.post('/api/auth/signup/confirm', { token }));
assert.equal(made.created, true); assert.equal(made.next, '/g/some-game');
assert.equal(must(await A.get('/api/me')).user.email, email);
// a second sign-up for the same address gets an email saying so, and no new account
must(await client().post('/api/auth/signup', { email, name: 'Again' }));
assert.match((await mail(email, /already have one/)).subject, /already have an account/);
ok('sign-up: nothing until the link is opened; the link names where to go next; a taken email is told so by email');

const acct = must(await A.get('/api/account'));
assert.ok(acct.email_verified_at && acct.confirmed_until > Date.now(), 'a fresh sign-in is confirmed');
assert.equal(acct.sessions[0].method, 'link');
const setup = must(await A.post('/api/account/2fa/setup'));
const secret = unbase32(setup.secret), totp = async (d = 0) => totpAt(secret, stepOf(Date.now()) + d);
const enabled = must(await A.post('/api/account/2fa/enable', { code: await totp() }));
assert.equal(enabled.recovery_codes.length, 10);
must(await A.post('/api/auth/logout'));
ok('two-factor turned on right after signing in (no extra proof needed while the sign-in is fresh)');

const B = client();
const { challenge } = must(await B.post('/api/auth/login', { email }));
const step2 = must(await B.post('/api/auth/login/verify', { challenge, code: await codeIn(email, /sign-in code is/) }));
assert.equal(step2.two_factor, true);
assert.equal(must(await B.get('/api/me')).user, null, 'not signed in before the authenticator code');
must(await B.post('/api/auth/login/code', { challenge: step2.challenge, code: await totp(1) }));
assert.equal(must(await B.get('/api/me')).user.email, email);
ok('sign-in: email code, then the authenticator code');

const pkReg = must(await B.post('/api/account/passkeys/options'));
assert.equal(pkReg.rp.id, new URL(BASE).hostname); assert.equal(pkReg.authenticatorSelection.userVerification, 'required');
assert.equal((await B.post('/api/account/passkeys', { credential: { id: 'x', response: { clientDataJSON: 'e30', attestationObject: 'oA' } } })).status, 400);
const pkLogin = must(await client().post('/api/auth/passkey/options', { purpose: 'login' }));
assert.ok(pkLogin.challenge && pkLogin.allowCredentials.length === 0);
assert.equal((await client().post('/api/auth/passkey/login', { credential: { id: 'nope', response: { clientDataJSON: Buffer.from(JSON.stringify({ challenge: pkLogin.challenge })).toString('base64url') } } })).status, 400);
ok('passkeys: options for this site with user verification required; a forged answer is refused');

const sent = must(await B.post('/api/account/confirm/send'));
const wrong = await B.post('/api/account/confirm', { challenge: sent.challenge, code: '000000' });
assert.equal(wrong.status, 401);
must(await B.post('/api/account/confirm', { challenge: sent.challenge, code: await codeIn(email, /confirmation code is/) }));
ok('confirming it is you by an emailed code');

// an agent's device sign-in, approved by the signed-in person
const dev = await (await fetch(`${BASE}/oauth/device`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'live-test/1.0' }, body: 'client_name=live-test' })).json();
assert.ok(dev.user_code && dev.device_code, JSON.stringify(dev));
must(await B.post(`/api/device/${encodeURIComponent(dev.user_code)}`, { decision: 'approve' }));
const tok = await (await fetch(`${BASE}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'live-test/1.0' }, body: `grant_type=urn:ietf:params:oauth:grant-type:device_code&device_code=${dev.device_code}` })).json();
assert.ok(tok.access_token, JSON.stringify(tok));
ok('agent device sign-in still works');

// what crawlers see
const robots = await (await fetch(`${BASE}/robots.txt`)).text();
assert.match(robots, /Disallow: \/account/); assert.match(robots, /User-agent: GPTBot/);
const sm = await (await fetch(`${BASE}/sitemap.xml`)).text();
assert.match(sm, /<loc>[^<]+\/docs<\/loc>/); assert.doesNotMatch(sm, /\/account|\/library/);
assert.match(await (await fetch(`${BASE}/llms.txt`)).text(), /^# HearthCade/);
assert.match(await (await fetch(`${BASE}/llms-full.txt`)).text(), /# The platform contract/);
assert.match(await (await fetch(`${BASE}/guides/about.md`)).text(), /# About HearthCade/);
for (const p of ['/account', '/library', '/console', '/login', '/verify?token=x', '/api/me']) assert.equal((await fetch(BASE + p, { redirect: 'manual' })).headers.get('x-robots-tag'), 'noindex, nofollow', p);
const home = await (await fetch(`${BASE}/`)).text();
assert.match(home, /<link rel="canonical"/); assert.match(home, /"@type":"WebSite"/); assert.match(home, /<noscript>/);
assert.match(await (await fetch(`${BASE}/account`)).text(), /<meta name="robots" content="noindex, nofollow">/);
ok('crawlers: robots.txt, sitemap, llms.txt and the guides; personal pages noindex; public pages carry JSON-LD');

// the live-test mailbox (TEST_MAIL_TOKEN, src/mail.ts testMailbox): only @example.com, only with the exact secret; every
// other address is emailed as usual and gets no code or link back, whatever header it sends
const SECRET = process.env.TEST_MAIL_TOKEN;
if (!SECRET) console.log('  - live-test mailbox not checked: set TEST_MAIL_TOKEN to the value in .dev.vars');
else {
  const raw = async (path, body, h = {}) => { const r = await fetch(BASE + path, { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE, ...h }, body: JSON.stringify(body) }); return { status: r.status, json: await r.json().catch(() => null), text: '' }; };
  const outbox = async (to) => (await (await fetch(`${BASE}/api/dev/mail?to=${encodeURIComponent(to)}`)).json()).mail.length;
  const right = { 'x-test-mail': SECRET }, wrong = { 'x-test-mail': SECRET.slice(0, -1) + (SECRET.endsWith('a') ? 'b' : 'a') };
  // real addresses: emailed, nothing comes back, even with the right secret
  for (const addr of [`real-${run}@example.org`, `real-${run}@sub.example.com`, `real-${run}@example.com.evil.io`]) {
    const su = must(await raw('/api/auth/signup', { email: addr, name: 'Real ' + run }, right));
    assert.equal(su.test_token, undefined, addr); assert.equal(await outbox(addr), 1, `${addr}: the sign-up link is emailed`);
    const li = must(await raw('/api/auth/login', { email: addr }, right));
    assert.equal(li.test_code, undefined, addr); assert.equal(await outbox(addr), 2, `${addr}: the sign-in email is sent`);
  }
  // @example.com without the secret, or with a wrong one: emailed, nothing comes back
  for (const [h, tag] of [[{}, 'none'], [wrong, 'wrong']]) {
    const addr = `nokey-${tag}-${run}@example.com`;
    const su = must(await raw('/api/auth/signup', { email: addr, name: 'No key ' + run }, h));
    assert.equal(su.test_token, undefined, tag); assert.equal(await outbox(addr), 1, `${tag}: emailed`);
    const li = must(await raw('/api/auth/login', { email: addr }, h));
    assert.equal(li.test_code, undefined, tag); assert.equal(await outbox(addr), 2, `${tag}: emailed`);
  }
  // @example.com with the secret: the link and code come back and nothing is sent
  const T = client(), addr = `key-${run}@example.com`;
  const su = must(await raw('/api/auth/signup', { email: addr, name: 'Key ' + run }, right));
  assert.match(su.test_token, /^[\w-]{20,}$/); assert.equal(await outbox(addr), 0, 'not emailed');
  must(await T.post('/api/auth/signup/confirm', { token: su.test_token }));
  const li = must(await raw('/api/auth/login', { email: addr }, right));
  assert.match(li.test_code, /^\d{6}$/); assert.equal(await outbox(addr), 0, 'not emailed');
  must(await T.post('/api/auth/login/verify', { challenge: li.challenge, code: li.test_code }));
  assert.equal(must(await T.get('/api/me')).user.email, addr);
  ok('live-test mailbox: real addresses are always emailed and get nothing back; @example.com only with the exact secret');
}

// deleting the account needs a fresh proof too, and works
must(await B.post('/api/account/delete'));
assert.equal(must(await B.get('/api/me')).user, null);
ok('account deleted');
console.log('sign-in live test passed');
