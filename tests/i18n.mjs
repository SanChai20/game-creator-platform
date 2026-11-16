// Every string in the web app exists in every language, with the same placeholders.
// When this fails after adding strings: `node scripts/i18n-scan.mjs --missing ja` lists what to translate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { scan } from '../scripts/i18n-scan.mjs';
import { detectLang, matchLang, LANGS } from '../web/src/i18n/langs.ts';

const dict = (l) => JSON.parse(readFileSync(new URL(`../web/src/i18n/${l}.json`, import.meta.url), 'utf8'));
const { keys, server, problems } = scan();
const holes = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');

test('every t() call can be translated', () => {
  assert.deepEqual(problems, []);
  assert.ok(keys.size > 500, `only ${keys.size} strings found: is the scanner broken?`);
});

for (const l of ['zh-TW', 'ja', 'ko', 'es']) {
  test(`${l} has every string`, () => {
    const d = dict(l), missing = [...keys.keys(), ...server.keys()].filter((k) => !(k in d));
    assert.deepEqual(missing, [], `${missing.length} missing in ${l}.json`);
  });
}
test('zh has every admin setting label', () => {
  const d = dict('zh'), missing = [...server.keys()].filter((k) => !(k in d));
  assert.deepEqual(missing, []);
});

test('translations keep their placeholders', () => {
  for (const l of ['zh', 'zh-TW', 'ja', 'ko', 'es']) {
    for (const [k, v] of Object.entries(dict(l))) assert.equal(holes(v), holes(k.split('|')[0]), `${l}: ${k} → ${v}`);
  }
  for (const [en, v] of keys) assert.equal(holes(v.zh), holes(en), `zh inline: ${en} → ${v.zh}`);
});

test('language detection', () => {
  assert.equal(LANGS.length, 6);
  assert.equal(detectLang(['zh-TW']), 'zh-TW');
  assert.equal(detectLang(['zh-HK']), 'zh-TW');
  assert.equal(detectLang(['zh-Hant-MO']), 'zh-TW');
  assert.equal(detectLang(['zh-Hans-HK']), 'zh');
  assert.equal(detectLang(['zh-CN']), 'zh');
  assert.equal(detectLang(['zh']), 'zh');
  assert.equal(detectLang(['ja-JP']), 'ja');
  assert.equal(detectLang(['ko-KR']), 'ko');
  assert.equal(detectLang(['es-419']), 'es');
  assert.equal(detectLang(['fr-FR', 'es-ES']), 'es');
  assert.equal(detectLang(['de-DE']), 'en');
  assert.equal(detectLang('fr;q=0.9, ko;q=0.8, en;q=0.7'), 'ko');
  assert.equal(detectLang('en;q=0.5, ja'), 'ja');
  assert.equal(detectLang(''), 'en');
  assert.equal(matchLang('zh'), 'zh');
  assert.equal(matchLang('nonsense'), null);
});
