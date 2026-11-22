// Signing up and in for the live test scripts, without passwords. The email step is read one of two ways:
// - a deployed platform: TEST_MAIL_TOKEN set to the Worker's TEST_MAIL_TOKEN secret; for @example.com addresses the
//   Worker then answers with the link token or code instead of emailing it (src/mail.ts testMailbox);
// - a local Worker with DEV_MAIL=1 in .dev.vars: the emails it kept, from /api/dev/mail.
// `post(path, body, headers)` is the script's own cookie-keeping client and answers { status, json, text }.
import assert from 'node:assert/strict';

const TOKEN = process.env.TEST_MAIL_TOKEN || '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const testMailHeaders = () => (TOKEN ? { 'x-test-mail': TOKEN } : {});
const must = (r) => { assert.equal(r.status, 200, `expected 200, got ${r.status}: ${String(r.text).slice(0, 300)}`); return r.json; };

async function devMail(base, to, re) {
  for (let i = 0; i < 30; i++) {
    const r = await fetch(`${base}/api/dev/mail?to=${encodeURIComponent(to)}`);
    if (r.status === 404) throw new Error('No way to read the sign-in email: set TEST_MAIL_TOKEN (deployed platform) or DEV_MAIL=1 in .dev.vars (local Worker).');
    const m = (await r.json()).mail.filter((x) => re.test(x.text)).pop();
    if (m) return m.text.match(re)[1];
    await sleep(150);
  }
  throw new Error(`no email to ${to}`);
}

/** Creates the account (an @example.com address) and leaves `post`'s client signed in to it. */
export async function signUp(base, post, email, name) {
  assert.match(email, /@example\.com$/, 'test accounts use @example.com addresses');
  const r = must(await post('/api/auth/signup', { email, name }, testMailHeaders()));
  const token = r.test_token || (TOKEN ? null : await devMail(base, email, /\/verify\?token=([\w-]+)/));
  assert.ok(token, 'no sign-up link came back: is TEST_MAIL_TOKEN the Worker\'s secret, and is the address new?');
  return must(await post('/api/auth/signup/confirm', { token }));
}

/** Signs `post`'s client in to an existing account with an email code. */
export async function signIn(base, post, email) {
  const r = must(await post('/api/auth/login', { email }, testMailHeaders()));
  const code = r.test_code || (TOKEN ? null : await devMail(base, email, /sign-in code is (\d{6})/));
  assert.ok(code, 'no sign-in code came back');
  return must(await post('/api/auth/login/verify', { challenge: r.challenge, code }));
}
