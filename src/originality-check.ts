// The pre-publish duplication check. After a version passes the browser check, the platform fingerprints its own
// code, its files and its look, and compares them with the live games of other creators (only versions that existed
// before this one). Code everyone starts from (templates, kits, libraries) is ignored. Clear copies and uploads
// that are not games fail the check; Workers AI's decision models (Clef) are asked only about borderline cases, under a daily cap.
import type { Env, Project, Version } from './env';
import { ensureVersionMeta, logEvent, verKey } from './projects';
import { getSettings } from './settings';
import { aiDecide, type Question } from './ai';
import { dayOf, now, parseJson, sha256 } from './util';
// @ts-ignore plain JS modules
import { READABLE, analyzeBundle, isVendor } from './implementation.js';
// @ts-ignore plain JS modules
import { JUDGE_QUESTIONS, PRINTS_VERSION, bundlePrints, compare, CLEF_COPY, FLASH_SURE, contentNames, distinctFile, facts4ai, gameness, identityKeys, IDENTITY_TITLE_WEIGHT, judgeState, kinship, lookOf, sketchOf, traitsOf } from './originality.js';
// @ts-ignore plain JS module
import { decodePng } from './craft-review.js';
// @ts-ignore plain JS module
import { contentCheck } from './content-check.js';

const ASSET = /\.(png|jpe?g|webp|gif|avif|ktx2|basis|mp3|ogg|wav|m4a|aac|opus|flac|glb|gltf|bin|obj|fbx|woff2?|ttf|otf|wasm|data|pck)$/i;
const CODE = /\.(m?js|cjs|html?)$/i;

interface Print { prints: number[]; files: string[]; assets: string[]; look: { dhash: string; palette: number[] } | null }
/** What a game is called and what is in it: compared with other games so a rebuild from a description is caught too. */
interface Identity { names: string[]; traits: string[] }
interface Built extends Print, Identity { facts: any; html: string; texts: { path: string; text: string }[]; shot: Uint8Array | null; frames: Uint8Array[] }

let baseline: Promise<Set<number>> | null = null;
function baselineOf(env: Env): Promise<Set<number>> {
  baseline ||= env.ASSETS.fetch(new Request('https://assets.local/kits/baseline.bin')).then(async (r) => (r.ok ? new Set(new Int32Array(await r.arrayBuffer())) : new Set<number>())).catch(() => new Set<number>());
  return baseline;
}

let baseNames: Promise<Set<string>> | null = null;
/** Names in the templates and kits (scripts/prepare.mjs): two games on one template do not share names because of it. */
function baseNamesOf(env: Env): Promise<Set<string>> {
  baseNames ||= env.ASSETS.fetch(new Request('https://assets.local/kits/baseline-names.json')).then(async (r) => (r.ok ? new Set<string>(await r.json()) : new Set<string>())).catch(() => new Set<string>());
  return baseNames;
}

/** The files of a version, with the text of code and markup files (up to a budget). */
async function readTexts(env: Env, pid: string, n: number, list: { path: string; size: number }[]) {
  const texts: { path: string; size: number; text: string | null }[] = [];
  let budget = 4 * 1024 * 1024;
  for (const f of list) {
    let text: string | null = null;
    if (READABLE(f.path) && f.size <= 2 * 1024 * 1024 && f.size <= budget) { const o = await env.FILES.get(verKey(pid, n, f.path)); if (o) { text = await o.text(); budget -= f.size; } }
    texts.push({ path: f.path, size: f.size, text });
  }
  return texts;
}

/** Fingerprints one version and stores them with its candidate-index entries. */
export async function printVersion(env: Env, p: Project, v: Version): Promise<Built> {
  const list = parseJson<{ path: string; size: number; sha: string }[]>(v.files, []);
  const texts = await readTexts(env, p.id, v.n, list);
  const own = texts.filter((t) => t.text !== null && CODE.test(t.path) && !/^server\//.test(t.path) && !isVendor(t.path, t.text)) as { path: string; text: string }[];
  const base = await baselineOf(env), prints: number[] = bundlePrints(own, base);
  // files copied from a template or kit say nothing about copying another creator, so only distinct files count
  const ownPaths = new Set(own.filter((t) => distinctFile(t.path, t.text, base)).map((t) => t.path));
  const files = list.filter((f) => ownPaths.has(f.path) && f.size > 512).map((f) => f.sha);
  const assets = [...new Set(list.filter((f) => ASSET.test(f.path) && f.size > 2048).map((f) => f.sha))];
  let look = null, shot: Uint8Array | null = null;
  if (v.screenshot_key) { const o = await env.FILES.get(v.screenshot_key); if (o) { shot = new Uint8Array(await o.arrayBuffer()); try { look = lookOf(decodePng(shot)); } catch { look = null; } } }
  const keys = [...new Set([...sketchOf(prints), ...assets.slice(0, 30).map((s) => parseInt(s.slice(0, 8), 16) | 0)])];
  await env.DB.batch([
    env.DB.prepare('INSERT OR REPLACE INTO fingerprints (project_id, version, owner_id, prints, files, assets, look, created_at, algo) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').bind(p.id, v.n, p.owner_id, JSON.stringify(prints), JSON.stringify(files), JSON.stringify(assets), look ? JSON.stringify(look) : null, now(), PRINTS_VERSION),
    env.DB.prepare('DELETE FROM fp_index WHERE project_id = ? AND version = ?').bind(p.id, v.n),
    ...keys.map((h) => env.DB.prepare('INSERT OR IGNORE INTO fp_index (h, project_id, version) VALUES (?, ?, ?)').bind(h, p.id, v.n)),
  ]);
  const readable = texts.filter((t) => t.text !== null && /\.(m?js|cjs|html?|json|css)$/i.test(t.path)) as { path: string; text: string }[];
  // the frames the verification browser took while it played the game, for the content review
  const frames: Uint8Array[] = [];
  for (const k of (parseJson<{ frames?: string[] }>(v.report, {}).frames || []).slice(0, 8)) { const o = await env.FILES.get(k); if (o) frames.push(new Uint8Array(await o.arrayBuffer())); }
  const facts = analyzeBundle(texts, parseJson(v.report, {}));
  const names = contentNames(own, await baseNamesOf(env));
  return { prints, files, assets, look, facts, names, traits: traitsOf(facts), html: texts.find((t) => t.path === 'index.html')?.text || '', texts: readable, shot, frames };
}

/**
 * Writes the identity keys of the version going live (its project's title and tagline as they are now, its names and its
 * look) to the hash index, replacing the game's earlier ones: only live versions are ever looked up, so the index holds one
 * version per game and its lists stay as short as the catalogue allows.
 */
export async function indexIdentity(env: Env, p: Pick<Project, 'id' | 'title' | 'tagline'>, n: number, names: string[], look: Print['look'] = null) {
  const k = identityKeys({ title: p.title, tagline: p.tagline, names, look }), hs = [...new Set([...k.strong, ...k.names, ...k.look])];
  const rows: D1PreparedStatement[] = [];
  for (let i = 0; i < hs.length; i += 30) { const part = hs.slice(i, i + 30); rows.push(env.DB.prepare(`INSERT OR IGNORE INTO id_index (h, project_id, version) VALUES ${part.map(() => '(?, ?, ?)').join(', ')}`).bind(...part.flatMap((h) => [h, p.id, n]))); }
  await env.DB.batch([env.DB.prepare('DELETE FROM id_index WHERE project_id = ?').bind(p.id), ...rows]).catch((e) => console.error('identity index failed', p.id, n, String(e)));
}

/** Indexes the live versions of up to `max` live games that have no identity keys yet (run by the scheduled job, not by a publish). */
export async function backfillIdentity(env: Env, max = 10) {
  const rows = (await env.DB.prepare("SELECT p.id, p.title, p.tagline, p.live_version, v.files, v.report, f.look FROM projects p JOIN versions v ON v.project_id = p.id AND v.n = p.live_version LEFT JOIN fingerprints f ON f.project_id = p.id AND f.version = p.live_version WHERE p.status = 'live' AND NOT EXISTS (SELECT 1 FROM id_index i WHERE i.project_id = p.id AND i.version = p.live_version) LIMIT ?").bind(max).all<any>()).results;
  for (const r of rows) { try { const id = await identityOf(env, r.id, r.live_version, r.files, r.report); await indexIdentity(env, r, r.live_version, id.names, parseJson(r.look, null)); } catch (e) { console.error('identity backfill failed', r.id, e); } }
  return rows.length;
}

/** The names in a version's own code and how it is built, read from its files (for games found by their listing). */
async function identityOf(env: Env, pid: string, n: number, filesJson: string, reportJson: string | null): Promise<Identity> {
  const texts = await readTexts(env, pid, n, parseJson<{ path: string; size: number }[]>(filesJson, []));
  const own = texts.filter((t) => t.text !== null && CODE.test(t.path) && !/^server\//.test(t.path) && !isVendor(t.path, t.text)) as { path: string; text: string }[];
  return { names: contentNames(own, await baseNamesOf(env)), traits: traitsOf(analyzeBundle(texts, parseJson(reportJson, {}))) };
}

const rowPrint = (r: any): Print => ({ prints: parseJson(r.prints, []), files: parseJson(r.files, []), assets: parseJson(r.assets, []), look: parseJson(r.look, null) });

/** Fingerprints the live versions of up to `max` live games that have none yet, or only older-algorithm ones (games published before this check, or before its last change). */
export async function backfill(env: Env, max = 5) {
  const rows = (await env.DB.prepare("SELECT p.*, v.files AS v_files, v.screenshot_key AS v_shot, v.report AS v_report, v.n AS v_n FROM projects p JOIN versions v ON v.project_id = p.id AND v.n = p.live_version LEFT JOIN fingerprints f ON f.project_id = p.id AND f.version = p.live_version WHERE p.status = 'live' AND (f.project_id IS NULL OR f.algo < ?) LIMIT ?").bind(PRINTS_VERSION, max).all<any>()).results;
  for (const r of rows) { try { await printVersion(env, r, { project_id: r.id, n: r.v_n, files: r.v_files, screenshot_key: r.v_shot, report: r.v_report } as any); } catch (e) { console.error('fingerprint backfill failed', r.id, e); } }
  return rows.length;
}

/**
 * Other creators' live games that this version overlaps with, most similar first. Code, files and look count against
 * versions made before this one; listing and names count against games created before this game. Each match carries
 * the code measures (compare) and the identity measures (kinship: title, tagline, names, build), its verdict is the
 * stronger of the two, and why lists exactly what matched.
 */
export async function matchesFor(env: Env, p: Project, v: Version, me: Print & Partial<Identity>) {
  // Every lookup below starts from the hash indexes (CROSS JOIN keeps SQLite from starting at the projects table), so a
  // check costs the same with ten live games or a million. Games published before an index existed are indexed by the
  // scheduled jobs (backfill, backfillIdentity), not here.
  const keys = [...new Set([...sketchOf(me.prints), ...me.assets.slice(0, 30).map((s) => parseInt(s.slice(0, 8), 16) | 0)])].slice(0, 94);
  const ids = new Map<string, number>();
  if (keys.length) {
    const rows = (await env.DB.prepare(`SELECT i.project_id, i.version, COUNT(*) AS n FROM fp_index i CROSS JOIN projects p ON p.id = i.project_id AND p.live_version = i.version AND p.status = 'live' AND p.owner_id != ? CROSS JOIN versions v ON v.project_id = i.project_id AND v.n = i.version AND v.created_at < ? WHERE i.h IN (${keys.map(() => '?').join(',')}) GROUP BY i.project_id, i.version ORDER BY n DESC LIMIT 8`).bind(p.owner_id, v.created_at, ...keys).all<{ project_id: string; version: number; n: number }>()).results;
    for (const r of rows) if (r.n >= 3) ids.set(r.project_id, r.version);
  }
  // games that share no code but take its identity: the same or a near title, the same tagline, many of the same
  // names, or the same look. Looked up in the hash index (src/originality.js identityKeys), so the cost does not grow with the catalogue.
  const mine = { title: p.title, tagline: p.tagline, tags: parseJson<string[]>(p.tags, []) };
  const idk = identityKeys({ ...mine, names: me.names || [], look: me.look }), all = [...new Set([...idk.strong, ...idk.names, ...idk.look])];
  if (all.length) {
    // D1 binds at most 100 values per query: the keys go in chunks, each reading a bounded number of index rows (a name
    // that thousands of games use is cut off rather than read in full; rare names are the ones that tell), then scored here
    const strong = new Set(idk.strong), score = new Map<string, number>(), at = new Map<string, number>();
    for (let i = 0; i < Math.min(all.length, 360); i += 90) {
      const part = all.slice(i, i + 90);
      const rows = (await env.DB.prepare(`SELECT h, project_id, version FROM id_index WHERE h IN (${part.map(() => '?').join(',')}) LIMIT 4000`).bind(...part).all<{ h: number; project_id: string; version: number }>().catch(() => ({ results: [] as { h: number; project_id: string; version: number }[] }))).results;
      for (const r of rows) { if (r.project_id === p.id) continue; score.set(r.project_id, (score.get(r.project_id) || 0) + (strong.has(r.h) ? IDENTITY_TITLE_WEIGHT : 1)); at.set(r.project_id, r.version); }
    }
    const top = [...score].filter(([, n]) => n >= 3).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([id]) => id);
    if (top.length) {
      const ok = (await env.DB.prepare(`SELECT id, live_version FROM projects WHERE id IN (${top.map(() => '?').join(',')}) AND status = 'live' AND owner_id != ? AND created_at < ?`).bind(...top, p.owner_id, p.created_at).all<{ id: string; live_version: number }>()).results;
      ok.filter((r) => r.live_version === at.get(r.id)).sort((a, b) => (score.get(b.id) || 0) - (score.get(a.id) || 0)).slice(0, 3).forEach((r) => { if (!ids.has(r.id)) ids.set(r.id, r.live_version); });
    }
  }
  const out = [];
  for (const [pid, n] of [...ids].slice(0, 8)) {
    const q = await env.DB.prepare('SELECT p.title, p.slug, p.tagline, p.description, p.tags, p.created_at AS p_created, v.files AS v_files, v.report AS v_report FROM projects p JOIN versions v ON v.project_id = p.id AND v.n = ? WHERE p.id = ?').bind(n, pid).first<any>();
    if (!q) continue;
    const fp = await env.DB.prepare('SELECT * FROM fingerprints WHERE project_id = ? AND version = ? AND algo = ?').bind(pid, n, PRINTS_VERSION).first<any>();
    const code = fp ? compare(me, rowPrint(fp)) : { verdict: 'different', code: 0, same_files: 0, assets: 0, look_distance: 64, palette_overlap: 0, looks_alike: false };
    const theirs = { title: q.title, tagline: q.tagline, tags: parseJson<string[]>(q.tags, []) };
    // names only count against a game that existed before this one; for an older code match they are read too
    const older = q.p_created < p.created_at;
    const id = older && me.names ? await identityOf(env, pid, n, q.v_files, q.v_report).catch(() => ({ names: [], traits: [] })) : { names: [], traits: [] };
    const kin = kinship({ ...mine, names: me.names || [], traits: me.traits || [] }, older ? { ...theirs, ...id } : { title: '', tagline: '', tags: [] });
    const verdict = rank[code.verdict] >= rank[kin.verdict] ? code.verdict : kin.verdict;
    const why = [...kin.why];
    if (code.verdict !== 'different') why.push(`${code.code}% of its own code${code.assets ? `, ${code.assets}% of its asset files` : ''}${code.looks_alike ? ' and the same look' : ''}`);
    out.push({ project_id: pid, version: n, title: q.title, slug: q.slug, listing: { title: q.title, tagline: q.tagline, description: String(q.description || '').slice(0, 400), tags: theirs.tags }, ...code, kin, identity: kin.verdict !== 'different' && kin.why.length > 0 && !/^the same genre/.test(kin.why.join(' ')), verdict, why });
  }
  return out.sort((a, b) => rank[b.verdict] - rank[a.verdict] || b.code - a.code || b.kin.shared_names - a.kin.shared_names || b.assets - a.assets);
}
const rank = { copy: 2, similar: 1, different: 0 } as Record<string, number>;
/** What matched, in words a creator can act on. */
export const matchedText = (m: { why: string[] }) => m.why.join('; ') || 'parts of it';
/** The named things two games share, for the creator to rename. */
const namesText = (m: any) => m.kin?.name_examples?.length ? ` Names found in both: ${m.kin.name_examples.join(', ')}${m.kin.shared_names > m.kin.name_examples.length ? ` and ${m.kin.shared_names - m.kin.name_examples.length} more` : ''}.` : '';

async function aiBudget(env: Env, purpose: string): Promise<boolean> {
  const s = await getSettings(env), content = purpose.startsWith('content');
  if (!(content ? s.content_check : s.dup_ai) || !env.AI || env.DEPLOY_DRIVER === 'local') return false;
  const day = dayOf(now());
  const row = await env.DB.prepare("SELECT COALESCE(SUM(calls), 0) AS n FROM ai_usage WHERE day = ? AND purpose LIKE ?").bind(day, content ? 'content%' : 'dup%').first<{ n: number }>();
  if ((row?.n || 0) >= (content ? s.content_ai_daily : s.dup_ai_daily)) return false;
  await env.DB.prepare('INSERT INTO ai_usage (day, purpose, calls) VALUES (?, ?, 1) ON CONFLICT(day, purpose) DO UPDATE SET calls = calls + 1').bind(day, purpose).run();
  return true;
}
/** How long an AI answer about one pair of games is reused. */
const JUDGE_CACHE_MS = 30 * 86400000;
/**
 * The copy judge, three stages with no person in the loop: the rules (kinship, compare) have already sent only a close
 * pair here. Stage 2 is the cheap decision model, clef-flash ($0.038 per M input tokens): a "derivative" or "independent"
 * at FLASH_SURE or more is final, except for a pair with the same tagline or 3+ shared names (clefOnly), which skips
 * straight to clef. Anything else (unsure, or "copy", since the cheap model never blocks a publish on its
 * own) goes to stage 3, clef ($0.24 per M), which refuses from CLEF_COPY chance of "copy". Both read judgeState(state). An answer for the same pair and
 * measurements is reused for 30 days. Each model call counts against the daily cap. Null when no model could answer.
 */
async function judgeCopy(env: Env, state: Record<string, unknown>, clefOnly = false): Promise<{ verdict: string; p: number; probabilities: Record<string, number>; model: string; final: boolean } | null> {
  // the key names the question's version, so answers to an older wording are never reused
  const key = await sha256(JSON.stringify({ q: 3, clefOnly, state }));
  const hit = await env.DB.prepare('SELECT answer, created_at FROM dup_judgments WHERE key = ?').bind(key).first<{ answer: string; created_at: number }>().catch(() => null);
  if (hit && now() - hit.created_at < JUDGE_CACHE_MS) { const a = parseJson<any>(hit.answer, null); if (a?.final) return a; }
  const ask = async (model: 'clef' | 'clef-flash') => {
    if (!(await aiBudget(env, model === 'clef' ? 'dup_judge' : 'dup_judge_flash'))) return null;
    const a = (await aiDecide(env, model, judgeState(state), JUDGE_QUESTIONS as Record<string, Question>))?.verdict;
    return a?.type === 'choice' ? { verdict: a.choice, p: a.probabilities[a.choice] ?? a.confidence, probabilities: a.probabilities, model } : null;
  };
  // clefOnly (the same tagline, or 3+ shared names): the cheap model could only wave it through, so clef decides alone
  const flash = clefOnly ? null : await ask('clef-flash');
  let answer: { verdict: string; p: number; probabilities: Record<string, number>; model: string; final: boolean } | null =
    flash && flash.verdict !== 'copy' && flash.p >= FLASH_SURE ? { ...flash, final: true } : null;
  if (!answer) {
    const big = await ask('clef');
    // clef's chance of "copy" decides, not its top answer: copies sit at 50% and up, everything else under 20%
    answer = big ? { ...big, verdict: Number(big.probabilities.copy || 0) >= CLEF_COPY ? 'copy' : big.verdict === 'copy' ? 'derivative' : big.verdict, p: Number(big.probabilities.copy || 0) >= CLEF_COPY ? Number(big.probabilities.copy) : big.p, final: true } : flash ? { ...flash, final: false } : null;
  }
  // only final answers are kept: a stage-2 answer that could not be escalated is asked again next time
  if (answer?.final) await env.DB.prepare('INSERT OR REPLACE INTO dup_judgments (key, answer, created_at) VALUES (?, ?, ?)').bind(key, JSON.stringify(answer), now()).run().catch(() => {});
  return answer;
}
const pct = (x: number) => `${Math.round(x * 100)}%`;

/**
 * Runs the check for a version that passed the browser check and adds its results to the report
 * (check "original", which turns report.ok false when it fails and blocking is on, and "content").
 */
export async function originalityCheck(env: Env, p: Project, v: Version, report: Record<string, any>): Promise<void> {
  const s = await getSettings(env);
  if (!report.ok || (!s.dup_check && !s.content_check)) return;
  const t0 = Date.now();
  const me = await printVersion(env, p, { ...v, report: JSON.stringify(report) });
  const listing = { title: p.title, tagline: p.tagline, description: p.description.slice(0, 400), tags: parseJson(p.tags, []) };
  const checks: { id: string; ok: boolean; label: string; detail: string; hint: string }[] = [];
  const flag = (c: typeof checks[number]) => checks.push(c);

  // 1. a copy of someone else's live game?
  const matches = s.dup_check ? await matchesFor(env, p, v, me) : [];
  let top = matches[0], judged: any = null;
  if (top && top.verdict === 'similar' && (await getSettings(env)).dup_ai) {
    const other = await env.DB.prepare('SELECT * FROM versions WHERE project_id = ? AND n = ?').bind(top.project_id, top.version).first<Version>();
    const otherFacts = other ? analyzeBundle(await readTexts(env, other.project_id, other.n, parseJson<any[]>(other.files, [])), parseJson(other.report, {})) : null;
    const { listing: theirs, project_id: _p, version: _v, slug: _s, title: _t, verdict: _x, why: _w, identity: _i, kin, ...code } = top as any;
    const measures = { ...code, title_sim: kin.title_sim, tagline_sim: kin.tagline_sim, same_genre: kin.same_genre, tags_overlap: kin.tags_overlap, shared_names: kin.shared_names, names_share: kin.names_share, name_examples: kin.name_examples, traits_overlap: kin.traits_overlap };
    judged = await judgeCopy(env, { new_game: { listing, facts: facts4ai(me.facts) }, existing_game: { listing: theirs, facts: otherFacts && facts4ai(otherFacts) }, measurements: measures }, !!kin.clef_only);
    // the final model's "copy" refuses; anything else, or no final answer (AI down, cap reached), lets the rules stand
    if (judged?.final && judged.verdict === 'copy') top = { ...top, verdict: 'copy' };
  }
  const measured = top ? matchedText(top) : '';
  if (top && top.verdict === 'copy') {
    flag({ id: 'original', ok: false, label: 'Original work', detail: `Matches "${top.title}" (/g/${top.slug}) by another creator: ${measured}.${namesText(top)}${judged ? ` The AI review (${judged.model}) judged it a copy (${pct(judged.p)} likely).` : ''}`, hint: 'Publishing a copy of another creator\'s game is not allowed. Building a game like another one (its genre, mechanics, structure or style, for example from its build skill) is fine; taking its identity is not. Give the game its own title and tagline, rename the characters, cards, enemies, places and items listed above, and use your own code and look (platform templates and kits are fine to start from). Then deploy_preview again. If the other game is yours under another account, contact the platform.' });
    await logEvent(env, p.id, 'copy_flagged', `Matches ${top.slug}: ${measured}`, v.n, 'originality');
  } else {
    flag({ id: 'original', ok: true, label: 'Original work', detail: top && top.verdict === 'similar' ? `Shares some code or look with "${top.title}" by another creator (${measured}), ${judged ? `judged ${judged.verdict}` : 'not enough to call it a copy'}.` : `No other creator's live game matches it.`, hint: '' });
    if (top && top.verdict === 'similar') report.notes = [...(report.notes || []), `Originality: this version shares ${measured} with "${top.title}". That is allowed; a version that copies most of another creator's game is not.`];
  }

  // 2. what kind of thing it is: recorded for the admin pages only, never a check. The platform does not decide which kinds
  //    of game may be published (sandboxes, toys, tools-like creative games, idle and exploration games all are); what a
  //    player meets is judged by the playability, device, content and originality checks instead.
  const g = gameness(me.facts, report, me.html);

  // 3. content and conduct: content never allowed, undeclared adult content, miners, password forms, hidden servers.
  //    The review looks at frames taken while the game was played and compares what it saw with the declared content.
  let content: any = null;
  if (s.content_check) {
    const ai = (await aiBudget(env, 'content_review')) ? (model: string, state: unknown, questions: Record<string, Question>, extra: Record<string, unknown>) => aiDecide(env, model as any, state, questions, 20000, extra) : null;
    const declared = await ensureVersionMeta(env, v).then((m) => m.meta.meta.content).catch(() => null);
    content = await contentCheck({ listing, html: me.html, pageText: report.page?.text || '', texts: me.texts, report, shot: me.shot, frames: me.frames, content: declared, ai, threshold: s.content_ai_threshold / 100, matureAllowed: s.mature_allowed });
    if (content.notes?.length) report.notes = [...(report.notes || []), ...content.notes];
    if (!content.ok) {
      const c = { id: 'content', ok: false, label: content.undeclared ? 'Content is declared' : 'Safe for players', detail: content.reason, hint: content.undeclared
        ? 'Adult games are allowed, but what players see must be declared. Declare it with game_metadata (action "declare", content: sexual "suggestive" | "nudity" | "explicit", violence "realistic" | "graphic", blood, adult_themes), then deploy a new preview: the game is listed as 18+, its cover is blurred and players confirm before it starts. If the review saw something the game does not show, change what the listing and screens show, then deploy again.'
        : 'Adult content is allowed when declared, but some content is never allowed: sexual content involving minors, hate, scams, phishing, promotion of self-harm, and code that mines, collects passwords or talks to hidden servers. If this was judged wrongly, change what the listing and screens show, then deploy again.' };
      if (!s.content_block) { c.ok = true; c.detail = `Warning: ${c.detail}`; report.warnings = [...(report.warnings || []), `${c.label}: ${content.reason}`]; }
      checks.push(c);
      await logEvent(env, p.id, 'content_flagged', `${content.category}: ${content.reason}`.slice(0, 300), v.n, 'content');
    } else checks.push({ id: 'content', ok: true, label: 'Safe for players', detail: content.by === 'ai' ? `Reviewed from ${content.ai?.frames || 0} frame(s) of the game in play: nothing disallowed, and nothing beyond the declared content.` : 'Rule check: nothing disallowed found (the AI review was not available).', hint: '' });
  }

  const failed = checks.filter((c) => !c.ok && c.id !== 'content');
  if (failed.length && !s.dup_block) {
    for (const c of failed) { c.ok = true; c.detail = `Warning: ${c.detail}`; }
    report.warnings = [...(report.warnings || []), ...failed.map((c) => `${c.label}: ${c.detail}`)];
  }
  report.checks = [...(report.checks || []), ...checks];
  report.originality = { matches: matches.slice(0, 3).map(({ listing: _l, project_id: _p, ...m }) => m), game: g.verdict, ai: { judge: judged?.verdict || null, judge_p: judged?.probabilities || null, judge_model: judged?.model || null, judge_final: judged?.final ?? null, content: content?.ai?.probabilities || null }, ms: Date.now() - t0 };
  report.content = content ? { ok: content.ok, category: content.category, undeclared: !!content.undeclared, by: content.by, sexual: content.ai?.sexual || null, violence: content.ai?.violence || null, frames: content.ai?.frames || 0 } : null;
  if (report.checks.some((c: any) => !c.ok)) { report.ok = false; report.summary = `Not publishable: ${report.checks.filter((c: any) => !c.ok).map((c: any) => c.label.toLowerCase()).join('; ')}.`; }
}

/**
 * Before a version goes live: compare again with games that went live since its check. A version qualified by its
 * creator's own preview session (the automated browser could not run it) never went through the review, so it gets the
 * whole review here, from its files and listing. Returns a reason to refuse, or null.
 */
export async function publishGate(env: Env, p: Project, v: Version): Promise<string | null> {
  const s = await getSettings(env);
  const report = parseJson<Record<string, any>>(v.report, {});
  if (!report.originality && (s.dup_check || s.content_check)) {
    const r = { ...report, ok: true, checks: [] as any[], notes: [...(report.notes || [])] };
    await originalityCheck(env, p, v, r);
    const bad = r.checks.filter((c: any) => !c.ok);
    if (bad.length) return `Version ${v.n} cannot be published: ${bad.map((c: any) => `${c.label.toLowerCase()}: ${c.detail}`).join(' ')}`;
    if (!s.dup_block) return null;
  }
  if (!s.dup_check || !s.dup_block) return null;
  const row = await env.DB.prepare('SELECT * FROM fingerprints WHERE project_id = ? AND version = ? AND algo = ?').bind(p.id, v.n, PRINTS_VERSION).first<any>();
  const me: Print & Partial<Identity> = row ? { ...rowPrint(row), ...(await identityOf(env, p.id, v.n, v.files, v.report).catch(() => ({ names: [], traits: [] }))) } : await printVersion(env, p, v);
  const top = (await matchesFor(env, p, v, me))[0];
  // the version going live is indexed under the title and tagline it goes live with (a refused one is not)
  if (!(top && top.verdict === 'copy')) await indexIdentity(env, p, v.n, me.names || [], me.look);
  return top && top.verdict === 'copy' ? `Version ${v.n} matches "${top.title}" (/g/${top.slug}) by another creator: ${matchedText(top)}.${namesText(top)} Publishing copies of other creators' games is not allowed: give it its own title, tagline and names, and your own code and look.` : null;
}
