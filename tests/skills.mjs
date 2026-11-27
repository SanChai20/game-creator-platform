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

const GOOD_ZH = `## 核心循环与玩法
这是一款俯视视角的草地竞技场生存游戏：玩家操控一名小英雄在草地上移动，成群的怪物会从四周不断逼近。所有武器都会自动开火，因此玩家只需要专注于走位与拉扯；每次升级都会弹出三张强化卡牌供选择。整局节奏大约十二分钟，最后以首领战收尾。

## 整体架构
逻辑模拟固定以每秒三十步运行，与画面渲染彻底分离，渲染层在最近两步状态之间做插值。模块按职责拆分为世界、模拟、画面、界面和音频五个部分，开发时先用简单几何体把模拟跑顺，再叠加美术表现。

## 渲染与美术
所有画面都通过 WebGL 程序化几何体绘制，不依赖外部贴图。一盏带柔影的方向光配合温暖雾效构成整体氛围，首帧绘制完成后调用 \`GCP.ready()\` 通知平台。

## 常见坑点
一次性刷出上百只怪物会让手机掉帧，因此改为跨帧分批刷怪，屏幕外较远的怪物隔帧更新。`;

const GOOD_ZH_TW = `## 核心迴圈與玩法
這是一款俯視視角的草地競技場生存遊戲：玩家操控一名小英雄在草地上移動，成群的怪物會從四周不斷逼近。所有武器都會自動開火，因此玩家只需要專注於走位與拉扯；每次升級都會彈出三張強化卡牌供選擇。整局節奏大約十二分鐘，最後以首領戰收尾。

## 整體架構
邏輯模擬固定以每秒三十步運行，與畫面算繪徹底分離，算繪層在最近兩步狀態之間做插值。模組按職責拆分為世界、模擬、畫面、介面和音訊五個部分，開發時先用簡單幾何體把模擬跑順，再疊加美術表現。

## 算繪與美術
所有畫面都透過 WebGL 程式化幾何體繪製，不依賴外部貼圖。一盞帶柔影的方向光配合溫暖霧效構成整體氛圍，首幀繪製完成後呼叫 \`GCP.ready()\` 通知平台。

## 常見坑點
一次性刷出上百隻怪物會讓手機掉幀，因此改為跨幀分批刷怪，螢幕外較遠的怪物隔幀更新。`;

const GOOD_JA = `## コアループと概要
見下ろし視点の草原アリーナ型サバイバルゲームです。プレイヤーは小さなヒーローを操作して草原を動き回り、周囲から迫り来るモンスターの波を生き抜きます。武器はすべて自動で発射されるため、操作は移動に集中できます。レベルアップごとに三枚の強化カードから一枚を選び、約十二分のプレイの最後にボス戦を迎えます。

## アーキテクチャ
シミュレーションは毎秒三十ステップの固定更新で動作し、描画とは明確に分離しています。描画側は直近二ステップの間を補間します。世界、シミュレーション、描画、インターフェース、オーディオの五つにモジュールを分け、まず単純な図形でシミュレーションを完成させてから見た目を整えます。

## レンダリングとアート
すべての要素は外部画像を使わず WebGL のプロシージャルな形状で描画します。柔らかい影を落とす平行光源と温かいフォグで雰囲気を作り、最初のフレームを描画したら \`GCP.ready()\` を呼びます。

## 落とし穴
数百体の敵を一度に生成するとスマートフォンで処理落ちするため、複数フレームに分散して生成し、画面外の遠い敵は隔フレームで更新します。`;

const GOOD_KO = `## 핵심 루프와 개요
탑다운 시점의 초원 아레나 생존 게임입니다. 플레이어는 작은 영웅을 움직이며 사방에서 몰려드는 괴물 무리를 버텨냅니다. 모든 무기가 자동으로 발사되므로 이동과 회피에만 집중하면 되며, 레벨업마다 세 장의 강화 카드 중 하나를 선택합니다. 한 판은 약 십이 분 정도 이어지며 마지막 보스전으로 마무리됩니다.

## 아키텍처
시뮬레이션은 초당 삼십 스텝 고정 주기로 실행되며 렌더링과 완전히 분리되어 있습니다. 렌더링은 직전 두 스텝 사이를 보간해 부드럽게 그립니다. 월드, 시뮬레이션, 화면, 인터페이스, 오디오로 모듈을 나누고, 단순한 도형으로 시뮬레이션을 먼저 완성한 뒤 시각 요소를 입힙니다.

## 렌더링과 아트
외부 이미지 없이 WebGL 절차적 도형만으로 모든 장면을 그립니다. 부드러운 그림자를 만드는 방향광과 따뜻한 안개로 분위기를 완성하고, 첫 프레임이 그려지면 \`GCP.ready()\`를 호출합니다.

## 주의할 점
몬스터 수백 마리를 한꺼번에 생성하면 모바일에서 프레임이 떨어지므로 여러 프레임에 걸쳐 나누어 생성하고, 화면 밖 먼 적은 격프레임으로 갱신합니다.`;

const GOOD_ES = `## Qué estás construyendo
Un juego de supervivencia en arena con vista cenital: el jugador mueve a un héroe por una pradera mientras oleadas de criaturas se acercan desde todos los lados. Las armas disparan solas, así que la única entrada es el movimiento, y cada subida de nivel ofrece tres cartas de mejora. Una partida dura unos doce minutos y termina con un jefe final.

## Arquitectura
La simulación corre a treinta pasos fijos por segundo y se mantiene separada del dibujo, que interpola entre los dos últimos pasos. Cada módulo tiene una responsabilidad clara: el mundo, la simulación, la vista, la interfaz y el audio. Construye primero la simulación con formas simples y luego añade la vista.

## Renderizado y arte
Todo se dibuja con WebGL mediante geometría procedimental sin archivos de imagen externos. Una sola luz direccional con sombras suaves y una niebla cálida definen el estilo visual. Llama a \`GCP.ready()\` en cuanto se dibuje el primer fotograma.

## Problemas comunes
Generar cientos de criaturas de golpe provocaba tirones en teléfonos móviles, así que las apariciones se reparten en varios fotogramas y las criaturas muy lejos de la pantalla se actualizan cada dos pasos.`;

const ALL_TR = {
  zh: { description: '自动开火草地竞技场生存游戏制作指南', content: GOOD_ZH },
  'zh-TW': { description: '自動開火草地競技場生存遊戲製作指南', content: GOOD_ZH_TW },
  ja: { description: '自動攻撃アリーナ型サバイバルゲームの作り方', content: GOOD_JA },
  ko: { description: '자동 공격 아레나 생존 게임 제작 가이드', content: GOOD_KO },
  es: { description: 'Supervivencia en arena con armas automáticas', content: GOOD_ES },
};

test('base skill must be English only; translations are validated for their target language and no-code rules', () => {
  assert.equal(checkSkill(GOOD, { lang: 'en', description: 'Arena survival' }).ok, true);
  // Non-English base skills are refused
  const zhBase = checkSkill(GOOD_ZH, { lang: 'en' });
  assert.equal(zhBase.ok, false);
  assert.match(zhBase.problems.map((p) => p.why).join(' '), /English only/);
  assert.equal(checkSkill(GOOD + '\n\n这一行混入了中文。', { lang: 'en' }).ok, false, 'mixed Chinese line refused');
  assert.equal(checkSkill(GOOD, { lang: 'en', description: '中文简介不允许' }).ok, false, 'Chinese description on English base refused');
  assert.equal(checkSkill(GOOD_ES, { lang: 'en' }).ok, false, 'Spanish submitted as English base refused');
  assert.equal(checkSkill(GOOD_JA, { lang: 'en' }).ok, false, 'Japanese submitted as English base refused');
  assert.equal(checkSkill(GOOD_KO, { lang: 'en' }).ok, false, 'Korean submitted as English base refused');

  // Every valid platform translation passes
  for (const [lang, tr] of Object.entries(ALL_TR)) {
    const r = checkSkill(tr.content, { lang, description: tr.description });
    assert.deepEqual(r.problems, [], `${lang} should pass`);
  }
  // Wrong-language translations and code in translations are refused
  assert.equal(checkSkill(GOOD, { lang: 'zh' }).ok, false, 'English rejected for zh');
  assert.equal(checkSkill(GOOD_ZH, { lang: 'zh-TW' }).ok, false, 'Simplified Chinese rejected for zh-TW');
  assert.equal(checkSkill(GOOD_ZH, { lang: 'ja' }).ok, false, 'Chinese rejected for ja');
  assert.equal(checkSkill(GOOD_JA, { lang: 'ko' }).ok, false, 'Japanese rejected for ko');
  assert.equal(checkSkill(GOOD, { lang: 'es' }).ok, false, 'English rejected for es');
  assert.equal(checkSkill(GOOD_ZH + '\n\n```js\nconst x = 1;\n```', { lang: 'zh' }).ok, false, 'code block refused inside zh translation');
});

test('writing a skill: English-only base required, all platform translations enforced by publish gate, and Store switches by language', async () => {
  const env = await world();
  const p = project(env);
  await assert.rejects(writeSkill(env, p, { content: GOOD + '\n\n```\nx\n```' }, 'agent'), /not saved[\s\S]*Code blocks/);
  await assert.rejects(writeSkill(env, p, { content: GOOD_ZH, description: '中文技能' }, 'agent'), /English only/);
  // Cannot write a translation before the English base exists
  await assert.rejects(writeSkill(env, p, { language: 'zh', content: GOOD_ZH, description: '中文技能' }, 'agent'), /canonical English build skill first/);

  assert.match(await skillGate(env, S, p, 3), /version 3 has no build skill/);
  // Writing English alone saves v3, but publish gate still requires the 5 other platform languages
  const r = await writeSkill(env, p, { content: GOOD, description: 'Arena survival' }, 'agent');
  assert.equal(r.version, 3);   // the newest deployed version by default
  assert.deepEqual(r.available_languages, ['en']);
  assert.deepEqual(r.missing_languages, ['zh', 'zh-TW', 'ja', 'ko', 'es']);
  assert.match(await skillGate(env, S, p, 3), /missing translations for platform languages/);

  // Write translations one by one via language param (agent-friendly)
  for (const [lang, tr] of Object.entries(ALL_TR)) {
    const res = await writeSkill(env, p, { version: 3, language: lang, ...tr }, 'agent');
    assert.equal(res.language, lang);
  }
  assert.equal(await skillGate(env, S, p, 3), null, 'all 6 platform languages present -> gate passes');
  assert.equal(await skillGate(env, { skill_required_to_publish: false }, p, 2), null);
  assert.equal(await skillGate(env, S, { ...p, open_implementation: 0 }, 2), null);
  await assert.rejects(writeSkill(env, p, { content: GOOD, version: 9 }, 'agent'), /does not exist/);

  // Legacy Chinese base skill already in DB is caught by skillGate too
  env.DB.sql.prepare("INSERT INTO game_skills (project_id, version, description, content, i18n, written_by, created_at, updated_at) VALUES ('g1', 2, '旧中文', ?, '{}', 'legacy', 0, 0)").run(GOOD_ZH);
  assert.match(await skillGate(env, S, p, 2), /English only/);

  // Writing English + all translations together in one call also works
  await writeSkill(env, p, { content: GOOD.replace('twelve', 'ten'), description: 'Arena survival', version: 2, translations: ALL_TR }, 'agent');
  assert.equal(await skillGate(env, S, p, 2), null);
  const l = await liveSkill(env, p);
  assert.equal(l.row.version, 2); assert.equal(l.current, true);
  const after = { ...p, live_version: 3 };
  assert.equal((await liveSkill(env, after)).row.version, 3);

  // Store switches skill language cleanly when reqLang changes
  const enItem = await storeItem(env, 'https://h.test', user('u_maker'), 'bloom', false, 'en');
  assert.equal(enItem.active_lang, 'en');
  assert.deepEqual(enItem.skill.languages, ['en', 'zh', 'zh-TW', 'ja', 'ko', 'es']);
  assert.match(enItem.skill_md, /# Building a game like Bloom/);

  const zhItem = await storeItem(env, 'https://h.test', user('u_maker'), 'bloom', false, 'zh');
  assert.equal(zhItem.active_lang, 'zh');
  assert.match(zhItem.content, /核心循环与玩法/);
  assert.match(zhItem.skill_md, /# 制作类似《Bloom》的游戏/);

  const jaItem = await storeItem(env, 'https://h.test', user('u_maker'), 'bloom', false, 'ja');
  assert.equal(jaItem.active_lang, 'ja');
  assert.match(jaItem.content, /コアループと概要/);
  assert.match(jaItem.skill_md, /「Bloom」のようなゲームを作る/);

  // Search matches translated descriptions too
  const foundZh = await storeList(env, 'https://h.test', null, { query: '草地竞技场' });
  assert.equal(foundZh.total, 1);
  assert.deepEqual(foundZh.skills[0].skill.languages, ['en', 'zh', 'zh-TW', 'ja', 'ko', 'es']);
});

test('a paid skill shows its content only to buyers, the creator and admins; a free one to everyone', async () => {
  const env = await world();
  await writeSkill(env, project(env), { content: GOOD, version: 2, translations: ALL_TR }, 'agent');
  const locked = await storeItem(env, 'https://h.test', user('u_other'), 'bloom');
  assert.equal(locked.locked, true); assert.equal(locked.content, null); assert.equal(locked.skill_md, null);
  assert.deepEqual(locked.skill.sections, ['What you are building', 'Architecture', 'Rendering and art', 'Pitfalls']);
  assert.deepEqual(locked.skill.i18n.zh.sections, ['核心循环与玩法', '整体架构', '渲染与美术', '常见坑点']);
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
