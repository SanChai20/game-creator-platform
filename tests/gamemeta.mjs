// Game metadata: genres, languages, players, content descriptors and the age rating, detection, and what publishing needs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ageRating, buildMeta, matureOf, genresOf, genreTags, missingForPublish, normGenre, parseContent, parsePlayers, sessionBucket } from '../web/src/gamemeta.ts';
import { buildLanguages, detectLanguages, inYourLanguage, languageRows, normLang, parseLanguages, parseListings } from '../web/src/languages.ts';

test('genres are normalized and become the first tags', () => {
  assert.equal(normGenre('Role-Playing'), 'rpg');
  assert.equal(normGenre('roguelite'), 'roguelike');
  assert.equal(normGenre('tower defense'), 'tower-defense');
  assert.equal(normGenre('opera'), null);
  const tags = genreTags('platformer', ['puzzle'], ['puzzle', 'cute', 'pixel']);
  assert.deepEqual(tags.slice(0, 3), ['platformer', 'puzzle', 'cute']);
  assert.deepEqual(genresOf(tags), { primary: 'platformer', secondary: ['puzzle'] });
  assert.equal(genresOf(['cute']).primary, null);
});

test('languages: codes are normalized, the shorthand works, and mistakes are reported', () => {
  assert.equal(normLang('zh-CN'), 'zh-hans');
  assert.equal(normLang('zh_TW'), 'zh-hant');
  assert.equal(normLang('EN-us'), 'en-us');
  const short = parseLanguages(['en', 'ja']);
  assert.deepEqual(short.issues, []);
  assert.equal(short.value.default, 'en');
  assert.deepEqual(short.value.supported.map((g) => [g.code, g.interface]), [['en', true], ['ja', true]]);
  const full = parseLanguages({ default: 'ja', supported: [{ code: 'en', subtitles: true }, { code: 'ja', interface: true, audio: true }], follows_platform: true });
  assert.deepEqual(full.issues, []);
  assert.equal(full.value.default, 'ja');
  assert.equal(full.value.follows_platform, true);
  const bad = parseLanguages({ default: 'fr', supported: [{ code: 'klingon!' }, { code: 'en', interface: false }], colour: 1 });
  assert.ok(bad.issues.some((i) => i.field === 'colour'));
  assert.ok(bad.issues.some((i) => i.field === 'default'));
  assert.ok(bad.issues.filter((i) => i.field === 'supported').length >= 2);
});

test('languages are detected from locale files, scripts, html lang and GCP.lang', () => {
  const files = {
    'index.html': '<html lang="en"><body><script src="main.js"></script></body></html>',
    'main.js': 'const s = { start: "Start the game", quit: "Quit the game", again: "Play again", score: "Your score" }; const pick = GCP.lang;',
    'locales/ja.json': '{"start": "ゲームをはじめる", "quit": "ゲームをやめる"}',
    'locales/ko.json': '{"start": "게임 시작", "quit": "게임 종료"}',
  };
  const d = detectLanguages(files, Object.keys(files));
  assert.equal(d.languages.default, 'en');
  assert.deepEqual(d.languages.supported.map((g) => g.code).sort(), ['en', 'ja', 'ko']);
  assert.equal(d.languages.follows_platform, true);
  // a declaration wins, and what the code shows but the declaration leaves out is a warning
  const b = buildLanguages(['en'], files, Object.keys(files));
  assert.equal(b.record.declared, true);
  assert.deepEqual(b.record.languages.supported.map((g) => g.code), ['en']);
  assert.ok(b.issues.some((i) => i.level === 'warning' && /ja|ko/.test(i.message)));
  assert.ok(b.issues.some((i) => i.field === 'follows_platform'));
});

test('the store page rows and the in-your-language check', () => {
  const l = parseLanguages({ default: 'en', supported: [{ code: 'en' }, { code: 'ja', interface: false, subtitles: true }, { code: 'zh-Hans' }] }).value;
  assert.deepEqual(inYourLanguage(l, 'zh'), { ok: true, row: l.supported.find((g) => g.code === 'zh-hans'), partial: false });
  assert.equal(inYourLanguage(l, 'ja').partial, true);
  assert.equal(inYourLanguage(l, 'ko').ok, false);
  const rows = languageRows(l, ['ko', 'zh']);
  assert.equal(rows[0].code, 'en');
  assert.equal(rows.find((r) => r.platform === 'zh').store, true);
  const ko = rows.find((r) => r.platform === 'ko');
  assert.deepEqual([ko.interface, ko.store], [false, true]);
});

test('listing translations are checked per platform language and field', () => {
  const ok = parseListings({ ja: { title: '星の庭', tagline: '小さな星を育てる' }, ko: null });
  assert.deepEqual(ok.issues, []);
  assert.equal(ok.value.ja.title, '星の庭');
  assert.equal(ok.value.ko, null);
  const bad = parseListings({ fr: { title: 'x' }, ja: { title: 'x'.repeat(81), cover: 'x' } });
  assert.ok(bad.issues.length >= 3);
});

test('players are validated, with friendly mode names', () => {
  const issues = [];
  assert.deepEqual(parsePlayers({ min: 1, max: 4, modes: ['solo', 'co-op'] }, issues), { min: 1, max: 4, modes: ['single', 'coop-online'] });
  assert.deepEqual(issues, []);
  const bad = [];
  parsePlayers({ min: 0, max: 3, modes: ['single'] }, bad);
  assert.ok(bad.some((i) => i.field === 'players.min'));
  assert.ok(bad.some((i) => i.field === 'players.max'));
});

test('content descriptors give the age rating; left out means none', () => {
  const issues = [];
  const none = parseContent({}, issues);
  assert.deepEqual(issues, []);
  assert.deepEqual(ageRating(none), { age: 3, reasons: [] });
  assert.equal(ageRating(parseContent({ violence: 'cartoon' }, [])).age, 7);
  assert.equal(ageRating(parseContent({ violence: 'fantasy', fear: 'mild' }, [])).age, 12);
  assert.equal(ageRating(parseContent({ language: 'strong' }, [])).age, 16);
  assert.equal(ageRating(parseContent({ violence: 'realistic', blood: true }, [])).age, 18);
  assert.equal(ageRating(parseContent({ flashing_lights: true, player_chat: true }, [])).age, 3);
  const bad = [];
  parseContent({ violence: 'extreme', nudity: true }, bad);
  assert.equal(bad.length, 2);
});

test('buildMeta records declarations, detects progress and multiplayer, and warns on mismatches', () => {
  const files = {
    'index.html': '<html lang="en"><script src="g.js"></script></html>',
    'g.js': 'GCP.save.set("slot", s); GCP.leaderboard.submit("best", 10); const r = GCP.room("lobby"); const t = "Press start to play the game";',
  };
  const { record, issues } = buildMeta({ players: { min: 1, max: 1, modes: ['single'] }, content: { violence: 'cartoon' }, session_minutes: 12, accessibility: ['pause-anytime'] }, files, Object.keys(files));
  assert.deepEqual(record.declared.sort(), ['accessibility', 'content', 'players', 'session_minutes']);
  assert.deepEqual(record.detected.progress, { cloud_saves: true, leaderboards: true, offline: false });
  assert.equal(record.detected.multiplayer, true);
  assert.equal(record.rating.age, 7);
  assert.ok(issues.some((i) => i.field === 'players.modes' && i.level === 'warning'));
  const bad = buildMeta({ session_minutes: 0, accessibility: ['x-ray-vision'] }, files, Object.keys(files));
  assert.ok(bad.issues.some((i) => i.field === 'session_minutes' && i.level === 'error'));
  assert.ok(bad.issues.some((i) => i.field.startsWith('accessibility')));
  assert.equal(sessionBucket(12), '5-15');
});

test('publishing needs genre, requirements, languages, players and content', () => {
  const files = { 'index.html': '<html lang="en"><p>Start the game now please</p></html>' };
  const empty = buildMeta({}, files, Object.keys(files)).record;
  assert.deepEqual(missingForPublish(empty, false, []).map((m) => m.split(' ')[0]), ['genre', 'requirements', 'languages', 'players', 'content']);
  const full = buildMeta({ languages: ['en'], players: { min: 1, max: 1, modes: ['single'] }, content: {} }, files, Object.keys(files)).record;
  assert.deepEqual(missingForPublish(full, true, ['puzzle']), []);
});

test('adults-only games: what reaches 18+ and why', () => {
  assert.equal(ageRating(parseContent({ violence: 'graphic' }, [])).age, 18);
  assert.equal(ageRating(parseContent({ sexual: 'nudity' }, [])).age, 18);
  assert.equal(ageRating(parseContent({ sexual: 'explicit' }, [])).age, 18);
  assert.equal(ageRating(parseContent({ adult_themes: true }, [])).age, 18);
  assert.equal(ageRating(parseContent({ sexual: 'suggestive' }, [])).age, 16);
  assert.deepEqual(matureOf(parseContent({ sexual: 'explicit', violence: 'graphic' }, [])), { mature: true, categories: ['sexual', 'violence'] });
  assert.deepEqual(matureOf(parseContent({ violence: 'realistic', blood: true }, [])).categories, ['violence']);
  assert.deepEqual(matureOf(parseContent({ adult_themes: true }, [])).categories, ['other']);
  assert.deepEqual(matureOf(parseContent({ sexual: 'suggestive', violence: 'realistic', language: 'strong' }, [])), { mature: false, categories: [] });
  assert.deepEqual(matureOf(null), { mature: false, categories: [] });
  // a record stored before adult_themes existed still reads
  assert.equal(matureOf({ violence: 'fantasy', blood: false, language: 'none', fear: 'none', sexual: 'none', drugs: false, gambling: 'none', flashing_lights: false, player_chat: false }).mature, false);
  const issues = []; parseContent({ sexual: 'hardcore' }, issues);
  assert.match(issues[0].message, /none, suggestive, nudity, explicit/);
});

test('services are found through aliases of the SDK, and only a free-text field counts as chat', () => {
  const meta = { players: { min: 1, max: 4, modes: ['single', 'co-op'] }, content: {}, progress: { cloud_saves: true, leaderboards: true } };
  const aliased = {
    'index.html': '<html lang="en"><input id="code" maxlength="4" placeholder="ROOM"><button id="chat-toggle">Join</button><script src="g.js"></script></html>',
    'g.js': 'const GCPx = window.GCP; GCPx.save.get("slot"); GCPx.save.set("slot", 1); GCPx.leaderboard.submit("best", 3); const room = GCPx.room("lobby"); room.onChat = 0;',
  };
  const a = buildMeta(meta, aliased, Object.keys(aliased));
  assert.deepEqual(a.record.detected.progress, { cloud_saves: true, leaderboards: true, offline: false });
  assert.equal(a.record.detected.multiplayer, true);
  assert.deepEqual(a.issues.filter((i) => i.level === 'warning' && !i.field.startsWith('languages')).map((i) => i.field), []);
  for (const code of ['const sdk = GCP; sdk?.save.set("a", 1);', 'const { save, leaderboard: lb } = window.GCP;', 'let api; api = globalThis.GCP; api["save"].set("a", 1);'])
    assert.equal(buildMeta({}, { 'g.js': code }, ['g.js']).record.detected.progress.cloud_saves, true, code);
  assert.equal(buildMeta({}, { 'g.js': 'const save = GCP.version; mySave.set(1); GCPS.save.set(1);' }, ['g.js']).record.detected.progress.cloud_saves, false);
  // a real chat box still warns
  const chat = { 'index.html': '<input id="msg" placeholder="Say something"><script src="g.js"></script>', 'g.js': 'const r = GCP.room("x"); function sendChat(t) { r.send({ chat: t }); }' };
  assert.ok(buildMeta(meta, chat, Object.keys(chat)).issues.some((i) => i.field === 'content.player_chat'));
  const made = { 'g.js': 'const r = GCP.room("x"); const box = document.createElement("textarea"); box.onkeydown = () => r.send({ chat: box.value });' };
  assert.ok(buildMeta(meta, made, ['g.js']).issues.some((i) => i.field === 'content.player_chat'));
});

test('a server-run match (GCP.match.find) counts as online play', () => {
  const meta = { players: { min: 1, max: 2, modes: ['single', 'pvp-online'] }, content: {}, progress: {} };
  for (const code of ['const m = GCP.match.find({ queue: "duel", players: 2 });', 'const sdk = window.GCP; sdk.match?.find({ code });', 'const { match } = GCP; match.find({});']) {
    const { record, issues } = buildMeta(meta, { 'g.js': code }, ['g.js']);
    assert.equal(record.detected.multiplayer, true, code);
    assert.equal(record.detected.progress.offline, false, code);
    assert.ok(!issues.some((i) => i.field === 'players.modes'), code + ': ' + JSON.stringify(issues));
  }
  // a game that does neither still gets the warning, naming both ways
  const none = buildMeta(meta, { 'g.js': 'const matchFound = 1; GCP.save.set("a", 1);' }, ['g.js']);
  assert.equal(none.record.detected.multiplayer, false);
  assert.match(none.issues.find((i) => i.field === 'players.modes').message, /GCP\.room\) or finds a match \(GCP\.match\.find\)/);
  // an online game declared single-player only is told to add an online mode, whichever way it plays online
  const single = buildMeta({ players: { min: 1, max: 1, modes: ['single'] } }, { 'g.js': 'GCP.match.find({ players: 2 });' }, ['g.js']);
  assert.ok(single.issues.some((i) => i.field === 'players.modes' && /GCP\.match\.find/.test(i.message)));
});

test('a clean zip upload keeps the declared build metadata its gcp.json leaves out', async () => {
  const { mergeManifest } = await import('../web/src/gamemeta.ts');
  const enc = (o) => new TextEncoder().encode(JSON.stringify(o)), dec = (b) => JSON.parse(new TextDecoder().decode(b));
  const workspace = enc({ imports: { a: './a.js' }, requirements: { graphics: 'webgl2' }, languages: ['en', 'zh-Hans'], players: { min: 1, max: 4 }, content: {} });
  const m = mergeManifest(workspace, enc({ imports: { b: './b.js' }, players: { min: 1, max: 2 } }));
  assert.deepEqual(m.carried, ['requirements', 'languages', 'content']);
  assert.deepEqual(dec(m.bytes), { imports: { b: './b.js' }, players: { min: 1, max: 2 }, requirements: { graphics: 'webgl2' }, languages: ['en', 'zh-Hans'], content: {} });
  // nothing to carry, or a copy that is not a JSON object: the zip's file goes in unchanged
  assert.equal(mergeManifest(enc({ players: { min: 1 } }), enc({ players: { min: 2 } })), null);
  assert.equal(mergeManifest(workspace, new TextEncoder().encode('{ not json')), null);
  assert.equal(mergeManifest(new TextEncoder().encode('[]'), enc({})), null);
});
