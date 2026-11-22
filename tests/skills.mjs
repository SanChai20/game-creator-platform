// Build skills and the Creator Store: what a skill may contain (never code), the SKILL.md that Copy skill gives, the
// commission rules (a free skill lowers the game's cut; a sold one keeps it and pays the skill commission), skill sales
// kept apart from game sales through refunds and chargebacks, who can read a paid skill, and the publish gate that keeps
// every shared skill in step with the live version. Real migrations, in-memory SQLite.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { register } from 'node:module';
import { SKILL_OUTLINE, checkSkill, headingsOf, normalizeSkill, skillMarkdown, skillName } from '../src/skill-rules.js';

register('./ts-hook.mjs', import.meta.url);
const { splitSale, splitSkillSale, freeSkillShared, recordPurchase, refundPurchase, partialRefund, disputePurchase, disputeWon, balanceOf, owns, ownsSkill } = await import('../src/earnings.ts');
const { gameRefundState, adminRefund, requestRefund } = await import('../src/refunds.ts');
const { writeSkill, skillGate, storeItem, storeList, liveSkill, setSkillPrice } = await import('../src/skills.ts');
const { SETTING_DEFS } = await import('../src/settings.ts');

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
  const batch = async (list) => { sql.exec('BEGIN'); try { const out = []; for (const s of list) out.push(await s.run()); sql.exec('COMMIT'); return out; } catch (e) { sql.exec('ROLLBACK'); throw e; } };
  return { prepare: (q) => stmt(q), batch, sql };
}

const defaults = Object.fromEntries(Object.entries(SETTING_DEFS).map(([k, d]) => [k, d.v]));
const S = { ...defaults, earnings_hold_days: 0, refund_window_hours: 0, new_creator_days: 0 };

const GOOD = `## What you are building
A small top-down arena survival game: the player walks a hero around a meadow while waves of creatures close in. Weapons fire on their own, so the only input is movement, and every level-up offers three upgrade cards. A run lasts about twelve minutes and ends with a boss.

## Architecture
The simulation runs at a fixed thirty steps per second and is kept apart from drawing, which interpolates between the last two steps. Modules own one thing each: the world, the simulation, the view, the interface and the audio. Build the simulation first with plain shapes, then the view.

## Rendering and art
Everything is drawn with WebGL from procedural geometry; there are no image files. A single directional light with soft shadows and a warm fog gives the look. Use \`GCP.ready()\` once the first frame is drawn.

## Pitfalls
Spawning hundreds of creatures at once made phones stutter, so spawns are spread over frames and creatures far off screen update every other step.`;

test('defaults: the skill commission is 5%, its own admin setting, apart from the game cuts', () => {
  assert.equal(SETTING_DEFS.skill_fee_percent.v, 5);
  assert.equal(SETTING_DEFS.skill_fee_percent.group, 'Creator Store');
  assert.equal(SETTING_DEFS.platform_fee_percent.v, 10);
  assert.equal(SETTING_DEFS.platform_fee_open_percent.v, 5);
  assert.equal(SETTING_DEFS.skill_required_to_publish.v, true);
});

test('a skill in prose passes; code of any kind is refused with its line', () => {
  assert.deepEqual(checkSkill(GOOD).problems, []);
  const bad = (extra, re) => { const r = checkSkill(GOOD + '\n\n' + extra); assert.equal(r.ok, false, extra); assert.match(r.problems.map((p) => p.why).join(' '), re); };
  bad('```js\nconst a = 1;\n```', /Code blocks/);
  bad('~~~\nanything\n~~~', /Code blocks/);
  bad('    for (let i = 0; i < n; i++) step();', /Indented|source code/);
  bad('const speed = 4;', /source code/);
  bad('function update(dt) {', /source code/);
  bad('<canvas id="c"></canvas>', /HTML/);
  bad('Use `const s = new Set()` for the pool.', /statement/);
  bad('Set `' + 'x'.repeat(70) + '` first.', /names only/);
  bad('a[i] = (b[j] + c[k]) * (d[l] - e[m]); f(g);', /punctuation|source code/);
  const r = checkSkill(GOOD + '\n\nconst a = 1;');
  assert.equal(r.problems[0].line, GOOD.split('\n').length + 2);
});

test('a skill needs substance and sections', () => {
  assert.match(checkSkill('## One\nToo short.').problems.map((p) => p.why).join(' '), /at least 600/);
  const flat = GOOD.replace(/^## .*$/gm, '').repeat(2);
  assert.match(checkSkill(flat).problems.map((p) => p.why).join(' '), /level-two headings/);
  assert.ok(SKILL_OUTLINE.length >= 8);
});

test('front matter and a leading title come off; the description is kept', () => {
  const r = normalizeSkill('---\nname: whatever\ndescription: "Arena survival with auto weapons"\n---\n# My title\n\n' + GOOD);
  assert.equal(r.description, 'Arena survival with auto weapons');
  assert.ok(r.body.startsWith('## What you are building'));
  assert.deepEqual(headingsOf(r.body), ['What you are building', 'Architecture', 'Rendering and art', 'Pitfalls']);
});

test('Copy skill gives a complete SKILL.md: front matter, source, body and measured facts', () => {
  const md = skillMarkdown({ title: 'Bloomguard', slug: 'bloomguard', by: 'sc', version: 37, description: 'Arena survival', body: GOOD, origin: 'https://h.test', facts: { engine: 'none: hand-written on browser APIs', rendering: ['WebGL'], graphics: [], input: ['keyboard', 'touch'], audio: [], assets: { approach: 'procedural' }, platform_services: ['leaderboards'], loop_and_performance: [], structure: { files: 40, own_code_lines: 9000, modules: 'ES modules' } } });
  assert.match(md, /^---\nname: build-like-bloomguard\ndescription: "Use when building a game like Bloomguard\. Arena survival"\n---\n/);
  assert.match(md, /matches version 37 of the live game/);
  assert.match(md, /## Measured by the platform/);
  assert.match(md, /- Platform services: leaderboards/);
  assert.equal(skillName('Noctelle: Gambit of the Blood Moon!'.toLowerCase()), 'build-like-noctelle-gambit-of-the-blood-moon');
  assert.ok(skillName('x'.repeat(100)).length <= 64);
});

test('commission: a free skill lowers the game cut to 5%; a sold skill keeps 10% and pays 5% on skill sales', () => {
  assert.equal(freeSkillShared({ open_implementation: 1, skill_price_cents: 0 }), true);
  assert.equal(freeSkillShared({ open_implementation: 1, skill_price_cents: 999 }), false);
  assert.equal(freeSkillShared({ open_implementation: 0, skill_price_cents: 0 }), false);
  assert.equal(splitSale(1000, S, freeSkillShared({ open_implementation: 1, skill_price_cents: 0 })).cut, 50);
  assert.equal(splitSale(1000, S, freeSkillShared({ open_implementation: 1, skill_price_cents: 999 })).cut, 100);
  assert.deepEqual(splitSkillSale(2000, S), { fee: 100, net: 1900, cut: 100, processing: 0, cut_percent: 5 });
  assert.equal(splitSkillSale(2000, { ...S, skill_fee_percent: 12 }).net, 1760);   // adjustable in the admin panel
});

async function world() {
  const DB = d1(), env = { DB };
  DB.sql.exec(`INSERT INTO users (id, email, name, pw_hash, created_at) VALUES ('u_maker', 'm@x', 'Maker', '', 0), ('u_buyer', 'b@x', 'Buyer', '', 0), ('u_other', 'o@x', 'Other', '', 0);
    INSERT INTO projects (id, owner_id, slug, title, status, price_cents, live_version, preview_version, next_version, open_implementation, skill_price_cents, created_at, updated_at) VALUES ('g1', 'u_maker', 'bloom', 'Bloom', 'live', 1000, 2, 3, 4, 1, 1500, 0, 0);
    INSERT INTO versions (project_id, n, note, manifest, file_count, bytes, files, status, stage, created_at) VALUES ('g1', 2, '', '{}', 1, 1, '[]', 'verified', '', 0), ('g1', 3, '', '{}', 1, 1, '[]', 'verified', '', 0);`);
  return env;
}
const project = (env) => env.DB.sql.prepare("SELECT * FROM projects WHERE id = 'g1'").get();
const user = (id, role = 'user') => ({ id, role });

test('skill sales are their own: own table, own counter, own ledger kind; refunds and chargebacks follow the same rules', async () => {
  const env = await world();
  await recordPurchase(env, S, { userId: 'u_buyer', projectId: 'g1', ownerId: 'u_maker', title: 'Bloom', priceCents: 1000, provider: 'stripe', providerRef: 'cs_game', paymentIntent: 'pi_game' });
  await recordPurchase(env, S, { userId: 'u_buyer', projectId: 'g1', ownerId: 'u_maker', title: 'Bloom', priceCents: 1500, provider: 'stripe', providerRef: 'cs_skill', paymentIntent: 'pi_skill', item: 'skill' });
  const p = project(env);
  assert.equal(p.sales, 1); assert.equal(p.skill_sales, 1);
  assert.equal((await balanceOf(env, 'u_maker')).total, 900 + 1425);
  assert.equal(await owns(env, 'u_buyer', 'g1'), true);
  assert.equal(await ownsSkill(env, 'u_buyer', 'g1'), true);
  assert.equal(env.DB.sql.prepare("SELECT kind FROM ledger WHERE note LIKE 'Skill sale%'").get().kind, 'skill_sale');
  // a partial refund of the skill, then a full refund: never more than it credited
  assert.equal(await partialRefund(env, 'pi_skill', 750), true);
  assert.equal((await balanceOf(env, 'u_maker')).total, 900 + 1425 - 713);
  assert.equal(await refundPurchase(env, { paymentIntent: 'pi_skill' }), true);
  assert.equal(await refundPurchase(env, { paymentIntent: 'pi_skill' }), false);
  assert.equal((await balanceOf(env, 'u_maker')).total, 900);
  assert.equal(await ownsSkill(env, 'u_buyer', 'g1'), false);
  assert.equal(await owns(env, 'u_buyer', 'g1'), true);   // the game is untouched
  assert.equal(project(env).skill_sales, 0); assert.equal(project(env).sales, 1);
  // a chargeback on a second skill purchase, then won
  await recordPurchase(env, S, { userId: 'u_other', projectId: 'g1', ownerId: 'u_maker', title: 'Bloom', priceCents: 1500, provider: 'stripe', providerRef: 'cs_skill2', paymentIntent: 'pi_skill2', item: 'skill' });
  assert.equal(await disputePurchase(env, 'pi_skill2'), true);
  assert.equal(await ownsSkill(env, 'u_other', 'g1'), false);
  assert.equal(await disputeWon(env, 'pi_skill2'), true);
  assert.equal(await disputeWon(env, 'pi_skill2'), false);
  assert.equal(await ownsSkill(env, 'u_other', 'g1'), true);
  assert.equal((await balanceOf(env, 'u_maker')).total, 900 + 1425);
  assert.equal(project(env).skill_sales, 1);
});

test('writing a skill: refused with code, saved per version, and the publish gate holds a shared game to it', async () => {
  const env = await world();
  const p = project(env);
  await assert.rejects(writeSkill(env, p, { content: GOOD + '\n\n```\nx\n```' }, 'agent'), /not saved[\s\S]*Code blocks/);
  assert.match(await skillGate(env, S, p, 3), /version 3 has no build skill/);
  const r = await writeSkill(env, p, { content: GOOD, description: 'Arena survival' }, 'agent');
  assert.equal(r.version, 3);   // the newest deployed version by default
  assert.equal(await skillGate(env, S, p, 3), null);
  assert.equal(await skillGate(env, { skill_required_to_publish: false }, p, 2), null);
  assert.equal(await skillGate(env, S, { ...p, open_implementation: 0 }, 2), null);
  await assert.rejects(writeSkill(env, p, { content: GOOD, version: 9 }, 'agent'), /does not exist/);
  // live is v2: the store shows the newest skill at or below the live version, flagged as behind until v3 goes live
  assert.equal((await liveSkill(env, p)).generated, true);   // none written for v2 yet: the platform's card stands in
  assert.equal(await liveSkill(env, { ...p, open_implementation: 0 }), null);
  await writeSkill(env, p, { content: GOOD.replace('twelve', 'ten'), version: 2 }, 'agent');
  const l = await liveSkill(env, p);
  assert.equal(l.row.version, 2); assert.equal(l.current, true);
  const after = { ...p, live_version: 3 };
  assert.equal((await liveSkill(env, after)).row.version, 3);
});

test('a paid skill shows its content only to buyers, the creator and admins; a free one to everyone', async () => {
  const env = await world();
  await writeSkill(env, project(env), { content: GOOD, version: 2 }, 'agent');
  const locked = await storeItem(env, 'https://h.test', user('u_other'), 'bloom');
  assert.equal(locked.locked, true); assert.equal(locked.content, null); assert.equal(locked.skill_md, null);
  assert.deepEqual(locked.skill.sections, ['What you are building', 'Architecture', 'Rendering and art', 'Pitfalls']);
  assert.equal((await storeItem(env, 'https://h.test', null, 'bloom')).buy.sign_in, true);
  assert.equal((await storeItem(env, 'https://h.test', user('u_maker'), 'bloom')).locked, false);
  assert.equal((await storeItem(env, 'https://h.test', user('u_admin', 'admin'), 'bloom')).locked, false);
  await recordPurchase(env, S, { userId: 'u_other', projectId: 'g1', ownerId: 'u_maker', title: 'Bloom', priceCents: 1500, provider: 'stripe', providerRef: 'cs_1', paymentIntent: 'pi_1', item: 'skill' });
  const bought = await storeItem(env, 'https://h.test', user('u_other'), 'bloom');
  assert.equal(bought.locked, false); assert.equal(bought.access, 'bought');
  assert.match(bought.skill_md, /name: build-like-bloom/);
  await setSkillPrice(env, S, project(env), 0, 'console');
  const free = await storeItem(env, 'https://h.test', null, 'bloom');
  assert.equal(free.locked, false); assert.equal(free.skill.free, true);
  const list = await storeList(env, 'https://h.test', null, {});
  assert.equal(list.total, 1); assert.equal(list.skills[0].game.title, 'Bloom');
  assert.equal((await storeList(env, 'https://h.test', null, { price: 'paid' })).total, 0);
});

test('a skill price stays within the platform range, and cannot be set before a skill exists', async () => {
  const env = await world();
  env.DB.sql.exec("UPDATE projects SET skill_price_cents = 0");
  await assert.rejects(setSkillPrice(env, S, project(env), 999, 'c'), /no build skill to sell/);
  await writeSkill(env, project(env), { content: GOOD }, 'agent');
  await assert.rejects(setSkillPrice(env, S, project(env), 50, 'c'), /from \$1\.99/);
  await assert.rejects(setSkillPrice(env, { ...S, paid_skills_enabled: false }, project(env), 999, 'c'), /turned off/);
  await setSkillPrice(env, S, project(env), 999, 'c');
  assert.equal(project(env).skill_price_cents, 999);
});

test('build skills are non-refundable: no self-serve refund, the admin refund refuses them, checkout says so', async () => {
  const env = await world();
  const open = { refund_window_hours: 24, refund_max_play_minutes: 10 };
  await recordPurchase(env, S, { userId: 'u_buyer', projectId: 'g1', ownerId: 'u_maker', title: 'Bloom', priceCents: 1500, provider: 'stripe', providerRef: 'cs_skill', paymentIntent: 'pi_skill', item: 'skill' });
  assert.equal(await gameRefundState(env, open, 'u_buyer', 'g1'), null);   // the buyer has only the skill: nothing to refund
  const skill = env.DB.sql.prepare('SELECT id FROM skill_purchases').get().id, pay = { refund: async () => 're', fee: async () => 0, reverseTransfer: async () => {} };
  await assert.rejects(requestRefund(env, open, 'u_buyer', skill, '', pay), (e) => e.code === 'skill_non_refundable');
  await assert.rejects(adminRefund(env, open, 'u_admin', skill, pay), (e) => e.code === 'skill_non_refundable');
  await recordPurchase(env, S, { userId: 'u_buyer', projectId: 'g1', ownerId: 'u_maker', title: 'Bloom', priceCents: 1000, provider: 'stripe', providerRef: 'cs_game', paymentIntent: 'pi_game' });
  const r = await gameRefundState(env, open, 'u_buyer', 'g1');
  assert.ok(r && r.refundable);                                               // games keep their refund rules
  const api = readFileSync(new URL('../src/routes/api.ts', import.meta.url), 'utf8');
  assert.match(api, /Build skills are non-refundable\./);
  assert.match(api, /build skills are non-refundable \(\[refund policy\]/);
});
