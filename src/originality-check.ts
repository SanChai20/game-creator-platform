// The pre-publish duplication check. After a version passes the browser check, the platform fingerprints its own
// code, its files and its look, and compares them with the live games of other creators (only versions that existed
// before this one). Code everyone starts from (templates, kits, libraries) is ignored. Clear copies and uploads
// that are not games fail the check; Workers AI's decision models (Clef) are asked only about borderline cases, under a daily cap.
import type { Env, Project, Version } from './env';
import { logEvent, verKey } from './projects';
import { getSettings } from './settings';
import { aiDecide, type Question } from './ai';
import { b64, dayOf, now, parseJson } from './util';
// @ts-ignore plain JS modules
import { READABLE, analyzeBundle, isVendor } from './implementation.js';
// @ts-ignore plain JS modules
import { GAMENESS_QUESTIONS, JUDGE_QUESTIONS, PRINTS_VERSION, bundlePrints, compare, distinctFile, facts4ai, gameness, lookDistance, lookOf, sketchOf, visibleText } from './originality.js';
// @ts-ignore plain JS module
import { decodePng } from './craft-review.js';
// @ts-ignore plain JS module
import { contentCheck } from './content-check.js';

const ASSET = /\.(png|jpe?g|webp|gif|avif|ktx2|basis|mp3|ogg|wav|m4a|aac|opus|flac|glb|gltf|bin|obj|fbx|woff2?|ttf|otf|wasm|data|pck)$/i;
const CODE = /\.(m?js|cjs|html?)$/i;

interface Print { prints: number[]; files: string[]; assets: string[]; look: { dhash: string; palette: number[] } | null }
interface Built extends Print { facts: any; html: string; texts: { path: string; text: string }[]; shot: Uint8Array | null }

let baseline: Promise<Set<number>> | null = null;
function baselineOf(env: Env): Promise<Set<number>> {
  baseline ||= env.ASSETS.fetch(new Request('https://assets.local/kits/baseline.bin')).then(async (r) => (r.ok ? new Set(new Int32Array(await r.arrayBuffer())) : new Set<number>())).catch(() => new Set<number>());
  return baseline;
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
  return { prints, files, assets, look, facts: analyzeBundle(texts, parseJson(v.report, {})), html: texts.find((t) => t.path === 'index.html')?.text || '', texts: readable, shot };
}

const rowPrint = (r: any): Print => ({ prints: parseJson(r.prints, []), files: parseJson(r.files, []), assets: parseJson(r.assets, []), look: parseJson(r.look, null) });

/** Fingerprints the live versions of up to `max` live games that have none yet, or only older-algorithm ones (games published before this check, or before its last change). */
export async function backfill(env: Env, max = 5) {
  const rows = (await env.DB.prepare("SELECT p.*, v.files AS v_files, v.screenshot_key AS v_shot, v.report AS v_report, v.n AS v_n FROM projects p JOIN versions v ON v.project_id = p.id AND v.n = p.live_version LEFT JOIN fingerprints f ON f.project_id = p.id AND f.version = p.live_version WHERE p.status = 'live' AND (f.project_id IS NULL OR f.algo < ?) LIMIT ?").bind(PRINTS_VERSION, max).all<any>()).results;
  for (const r of rows) { try { await printVersion(env, r, { project_id: r.id, n: r.v_n, files: r.v_files, screenshot_key: r.v_shot, report: r.v_report } as any); } catch (e) { console.error('fingerprint backfill failed', r.id, e); } }
  return rows.length;
}

/** Other creators' live games that this version overlaps with, most similar first. Only versions made before it count. */
export async function matchesFor(env: Env, p: Project, v: Version, me: Print) {
  await backfill(env, 3);
  const keys = [...new Set([...sketchOf(me.prints), ...me.assets.slice(0, 30).map((s) => parseInt(s.slice(0, 8), 16) | 0)])].slice(0, 94);
  const ids = new Map<string, number>();
  if (keys.length) {
    const rows = (await env.DB.prepare(`SELECT i.project_id, i.version, COUNT(*) AS n FROM fp_index i JOIN projects p ON p.id = i.project_id AND p.live_version = i.version AND p.status = 'live' AND p.owner_id != ? JOIN versions v ON v.project_id = i.project_id AND v.n = i.version AND v.created_at < ? WHERE i.h IN (${keys.map(() => '?').join(',')}) GROUP BY i.project_id, i.version ORDER BY n DESC LIMIT 8`).bind(p.owner_id, v.created_at, ...keys).all<{ project_id: string; version: number; n: number }>()).results;
    for (const r of rows) if (r.n >= 3) ids.set(r.project_id, r.version);
  }
  if (me.look) {
    const looks = (await env.DB.prepare("SELECT f.project_id, f.version, f.look FROM fingerprints f JOIN projects p ON p.id = f.project_id AND p.live_version = f.version AND p.status = 'live' AND p.owner_id != ? JOIN versions v ON v.project_id = f.project_id AND v.n = f.version AND v.created_at < ? WHERE f.look IS NOT NULL AND f.algo = ? LIMIT 5000").bind(p.owner_id, v.created_at, PRINTS_VERSION).all<{ project_id: string; version: number; look: string }>()).results;
    looks.map((r) => ({ r, d: lookDistance(me.look, parseJson(r.look, null)) })).filter((x) => x.d <= 10).sort((a, b) => a.d - b.d).slice(0, 3).forEach((x) => ids.set(x.r.project_id, x.r.version));
  }
  const out = [];
  for (const [pid, n] of ids) {
    const r = await env.DB.prepare('SELECT f.*, p.title, p.slug, p.tagline, p.description, p.tags FROM fingerprints f JOIN projects p ON p.id = f.project_id WHERE f.project_id = ? AND f.version = ? AND f.algo = ?').bind(pid, n, PRINTS_VERSION).first<any>();
    if (!r) continue;
    out.push({ project_id: pid, version: n, title: r.title, slug: r.slug, listing: { title: r.title, tagline: r.tagline, description: String(r.description || '').slice(0, 400), tags: parseJson(r.tags, []) }, ...compare(me, rowPrint(r)) });
  }
  const rank = { copy: 2, similar: 1, different: 0 } as Record<string, number>;
  return out.sort((a, b) => rank[b.verdict] - rank[a.verdict] || b.code - a.code || b.assets - a.assets);
}

async function aiBudget(env: Env, purpose: string): Promise<boolean> {
  const s = await getSettings(env), content = purpose.startsWith('content');
  if (!(content ? s.content_check : s.dup_ai) || !env.AI || env.DEPLOY_DRIVER === 'local') return false;
  const day = dayOf(now());
  const row = await env.DB.prepare("SELECT COALESCE(SUM(calls), 0) AS n FROM ai_usage WHERE day = ? AND purpose LIKE ?").bind(day, content ? 'content%' : 'dup%').first<{ n: number }>();
  if ((row?.n || 0) >= (content ? s.content_ai_daily : s.dup_ai_daily)) return false;
  await env.DB.prepare('INSERT INTO ai_usage (day, purpose, calls) VALUES (?, ?, 1) ON CONFLICT(day, purpose) DO UPDATE SET calls = calls + 1').bind(day, purpose).run();
  return true;
}
const pct = (x: number) => `${Math.round(x * 100)}%`;
/** Least likelihood of "it is a game" the review must give for a page that is not sure to be one. */
const GAME_MIN = 0.5;

/**
 * Runs the check for a version that passed the browser check and adds its results to the report
 * (checks "original" and "is_game"; report.ok turns false when either fails and blocking is on).
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
  if (top && top.verdict === 'similar' && await aiBudget(env, 'dup_judge')) {
    const other = await env.DB.prepare('SELECT * FROM versions WHERE project_id = ? AND n = ?').bind(top.project_id, top.version).first<Version>();
    const otherFacts = other ? analyzeBundle(await readTexts(env, other.project_id, other.n, parseJson<any[]>(other.files, [])), parseJson(other.report, {})) : null;
    const { listing: theirs, project_id: _p, version: _v, slug: _s, title: _t, verdict: _x, ...measures } = top as any;
    const a = (await aiDecide(env, 'clef', { new_game: { listing, facts: facts4ai(me.facts) }, existing_game: { listing: theirs, facts: otherFacts && facts4ai(otherFacts) }, measurements: measures }, JUDGE_QUESTIONS as Record<string, Question>))?.verdict;
    if (a?.type === 'choice') judged = { verdict: a.choice, p: a.probabilities[a.choice] ?? a.confidence, probabilities: a.probabilities };
    if (judged && judged.verdict === 'copy') top = { ...top, verdict: 'copy' };
  }
  const measured = top ? `${top.code}% of its own code${top.assets ? `, ${top.assets}% of its asset files` : ''}${top.looks_alike ? ' and the same look' : ''}` : '';
  if (top && top.verdict === 'copy') {
    flag({ id: 'original', ok: false, label: 'Original work', detail: `Matches "${top.title}" (/g/${top.slug}) by another creator: ${measured}.${judged ? ` Review: judged a copy (${pct(judged.p)} likely).` : ''}`, hint: 'Publishing a copy of another creator\'s game is not allowed. Platform templates and kits are fine to start from; make the game your own, with your own code, rules and look. If the other game is yours under another account, contact the platform.' });
    await logEvent(env, p.id, 'copy_flagged', `Matches ${top.slug}: ${measured}`, v.n, 'originality');
  } else {
    flag({ id: 'original', ok: true, label: 'Original work', detail: top && top.verdict === 'similar' ? `Shares some code or look with "${top.title}" by another creator (${measured}), ${judged ? `judged ${judged.verdict}` : 'not enough to call it a copy'}.` : `No other creator's live game matches it.`, hint: '' });
    if (top && top.verdict === 'similar') report.notes = [...(report.notes || []), `Originality: this version shares ${measured} with "${top.title}". That is allowed; a version that copies most of another creator's game is not.`];
  }

  // 2. is it a game at all? Only "no input" and "built with a game engine" are sure; everything else is reviewed.
  const image = me.shot ? { images: ['data:image/png;base64,' + b64(me.shot)] } : {};
  let g = gameness(me.facts, report, me.html), aiSaid: any = null;
  if (!s.dup_check) g = { ...g, verdict: 'game', sure: true, reason: 'The originality check is off.' };
  if (!g.sure && await aiBudget(env, 'dup_gameness')) {
    const a = (await aiDecide(env, 'clef-flash', { listing, facts: facts4ai(me.facts), page: { visible_text: (report.page?.text || visibleText(me.html)).slice(0, 1500), controls: report.page?.controls ?? null, signals: g.signals } }, GAMENESS_QUESTIONS as Record<string, Question>, 15000, image))?.is_game;
    if (a?.type === 'noul') {
      aiSaid = { is_game: a.noul >= GAME_MIN, p: a.noul };
      g = aiSaid.is_game ? { ...g, verdict: 'game', reason: `Reviewed as a game (${pct(a.noul)} likely).` } : { ...g, verdict: 'not_game', reason: `Reviewed as a page, tool or app rather than a game (${pct(1 - a.noul)} likely): ${g.reason.toLowerCase()}` };
    }
  }
  if (g.verdict === 'not_game') {
    flag({ id: 'is_game', ok: false, label: 'It is a game', detail: g.reason, hint: 'This platform hosts web games only: something a player plays, in this page. Landing pages, shops, link lists, articles, videos, forms and tools are refused. If it is a game, make the play obvious on its first screen and in its listing, and register a play-through with GCP.test.onPlaythrough that plays it.' });
    await logEvent(env, p.id, 'not_game_flagged', g.reason, v.n, 'originality');
  } else flag({ id: 'is_game', ok: true, label: 'It is a game', detail: g.verdict === 'unsure' ? 'An interactive page; nothing showed it is not a game.' : g.reason, hint: '' });

  // 3. content and conduct: harmful content, miners, password forms, hidden servers
  let content: any = null;
  if (s.content_check) {
    const ai = (await aiBudget(env, 'content_review')) ? (model: string, state: unknown, questions: Record<string, Question>, extra: Record<string, unknown>) => aiDecide(env, model as any, state, questions, 15000, extra) : null;
    content = await contentCheck({ listing, html: me.html, pageText: report.page?.text || '', texts: me.texts, report, shot: me.shot, ai, threshold: s.content_ai_threshold / 100 });
    if (content.notes?.length) report.notes = [...(report.notes || []), ...content.notes];
    if (!content.ok) {
      const c = { id: 'content', ok: false, label: 'Safe for players', detail: content.reason, hint: 'The marketplace is open to all ages with no human review. Games may be violent, scary or dark, but not sexual, hateful, fraudulent or deceptive, and they may not mine, collect passwords or talk to hidden servers. If this was judged wrongly, change what the listing and first screen show, then deploy again.' };
      if (!s.content_block) { c.ok = true; c.detail = `Warning: ${c.detail}`; report.warnings = [...(report.warnings || []), `${c.label}: ${content.reason}`]; }
      checks.push(c);
      await logEvent(env, p.id, 'content_flagged', `${content.category}: ${content.reason}`.slice(0, 300), v.n, 'content');
    } else checks.push({ id: 'content', ok: true, label: 'Safe for players', detail: content.by === 'ai' ? 'Reviewed: nothing harmful found.' : 'Rule check: nothing harmful found (the AI review was not available).', hint: '' });
  }

  const failed = checks.filter((c) => !c.ok && c.id !== 'content');
  if (failed.length && !s.dup_block) {
    for (const c of failed) { c.ok = true; c.detail = `Warning: ${c.detail}`; }
    report.warnings = [...(report.warnings || []), ...failed.map((c) => `${c.label}: ${c.detail}`)];
  }
  report.checks = [...(report.checks || []), ...checks];
  report.originality = { matches: matches.slice(0, 3).map(({ listing: _l, project_id: _p, ...m }) => m), game: g.verdict, ai: { judge: judged?.verdict || null, judge_p: judged?.probabilities || null, gameness: aiSaid ? aiSaid.is_game : null, gameness_p: aiSaid ? aiSaid.p : null, content: content?.ai?.probabilities || null }, ms: Date.now() - t0 };
  report.content = content ? { ok: content.ok, category: content.category, by: content.by } : null;
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
  const me = row ? rowPrint(row) : await printVersion(env, p, v);
  const top = (await matchesFor(env, p, v, me))[0];
  return top && top.verdict === 'copy' ? `Version ${v.n} matches "${top.title}" (/g/${top.slug}) by another creator: ${top.code}% of its own code${top.assets ? `, ${top.assets}% of its asset files` : ''}${top.looks_alike ? ' and the same look' : ''}. Publishing copies of other creators' games is not allowed.` : null;
}
