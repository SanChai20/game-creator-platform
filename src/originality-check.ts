// The pre-publish duplication check. After a version passes the browser check, the platform fingerprints its own
// code, its files and its look, and compares them with the live games of other creators (only versions that existed
// before this one). Code everyone starts from (templates, kits, libraries) is ignored. Clear copies and uploads
// that are not games fail the check; Workers AI is asked only about borderline cases, under a daily cap.
import type { Env, Project, Version } from './env';
import { logEvent, verKey } from './projects';
import { getSettings } from './settings';
import { aiText } from './ai';
import { dayOf, now, parseJson } from './util';
// @ts-ignore plain JS modules
import { READABLE, analyzeBundle, isVendor } from './implementation.js';
// @ts-ignore plain JS modules
import { bundlePrints, compare, distinctFile, gameness, lookDistance, lookOf, sketchOf } from './originality.js';
// @ts-ignore plain JS module
import { decodePng } from './craft-review.js';

const ASSET = /\.(png|jpe?g|webp|gif|avif|ktx2|basis|mp3|ogg|wav|m4a|aac|opus|flac|glb|gltf|bin|obj|fbx|woff2?|ttf|otf|wasm|data|pck)$/i;
const CODE = /\.(m?js|cjs|html?)$/i;

interface Print { prints: number[]; files: string[]; assets: string[]; look: { dhash: string; palette: number[] } | null }
interface Built extends Print { facts: any; html: string }

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
  let look = null;
  if (v.screenshot_key) { const o = await env.FILES.get(v.screenshot_key); if (o) { try { look = lookOf(decodePng(new Uint8Array(await o.arrayBuffer()))); } catch { look = null; } } }
  const keys = [...new Set([...sketchOf(prints), ...assets.slice(0, 30).map((s) => parseInt(s.slice(0, 8), 16) | 0)])];
  await env.DB.batch([
    env.DB.prepare('INSERT OR REPLACE INTO fingerprints (project_id, version, owner_id, prints, files, assets, look, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').bind(p.id, v.n, p.owner_id, JSON.stringify(prints), JSON.stringify(files), JSON.stringify(assets), look ? JSON.stringify(look) : null, now()),
    env.DB.prepare('DELETE FROM fp_index WHERE project_id = ? AND version = ?').bind(p.id, v.n),
    ...keys.map((h) => env.DB.prepare('INSERT OR IGNORE INTO fp_index (h, project_id, version) VALUES (?, ?, ?)').bind(h, p.id, v.n)),
  ]);
  return { prints, files, assets, look, facts: analyzeBundle(texts, parseJson(v.report, {})), html: texts.find((t) => t.path === 'index.html')?.text || '' };
}

const rowPrint = (r: any): Print => ({ prints: parseJson(r.prints, []), files: parseJson(r.files, []), assets: parseJson(r.assets, []), look: parseJson(r.look, null) });

/** Fingerprints the live versions of up to `max` live games that have none yet (games published before this check existed). */
export async function backfill(env: Env, max = 5) {
  const rows = (await env.DB.prepare("SELECT p.*, v.files AS v_files, v.screenshot_key AS v_shot, v.report AS v_report, v.n AS v_n FROM projects p JOIN versions v ON v.project_id = p.id AND v.n = p.live_version LEFT JOIN fingerprints f ON f.project_id = p.id AND f.version = p.live_version WHERE p.status = 'live' AND f.project_id IS NULL LIMIT ?").bind(max).all<any>()).results;
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
    const looks = (await env.DB.prepare("SELECT f.project_id, f.version, f.look FROM fingerprints f JOIN projects p ON p.id = f.project_id AND p.live_version = f.version AND p.status = 'live' AND p.owner_id != ? JOIN versions v ON v.project_id = f.project_id AND v.n = f.version AND v.created_at < ? WHERE f.look IS NOT NULL LIMIT 5000").bind(p.owner_id, v.created_at).all<{ project_id: string; version: number; look: string }>()).results;
    looks.map((r) => ({ r, d: lookDistance(me.look, parseJson(r.look, null)) })).filter((x) => x.d <= 10).sort((a, b) => a.d - b.d).slice(0, 3).forEach((x) => ids.set(x.r.project_id, x.r.version));
  }
  const out = [];
  for (const [pid, n] of ids) {
    const r = await env.DB.prepare('SELECT f.*, p.title, p.slug, p.tagline, p.description, p.tags FROM fingerprints f JOIN projects p ON p.id = f.project_id WHERE f.project_id = ? AND f.version = ?').bind(pid, n).first<any>();
    if (!r) continue;
    out.push({ project_id: pid, version: n, title: r.title, slug: r.slug, listing: { title: r.title, tagline: r.tagline, description: String(r.description || '').slice(0, 400), tags: parseJson(r.tags, []) }, ...compare(me, rowPrint(r)) });
  }
  const rank = { copy: 2, similar: 1, different: 0 } as Record<string, number>;
  return out.sort((a, b) => rank[b.verdict] - rank[a.verdict] || b.code - a.code || b.assets - a.assets);
}

async function aiBudget(env: Env, purpose: string): Promise<boolean> {
  const s = await getSettings(env);
  if (!s.dup_ai || !env.AI || env.DEPLOY_DRIVER === 'local') return false;
  const day = dayOf(now());
  const row = await env.DB.prepare("SELECT COALESCE(SUM(calls), 0) AS n FROM ai_usage WHERE day = ? AND purpose LIKE 'dup%'").bind(day).first<{ n: number }>();
  if ((row?.n || 0) >= s.dup_ai_daily) return false;
  await env.DB.prepare('INSERT INTO ai_usage (day, purpose, calls) VALUES (?, ?, 1) ON CONFLICT(day, purpose) DO UPDATE SET calls = calls + 1').bind(day, purpose).run();
  return true;
}
const jsonFrom = (text: string | null) => { const m = text && text.match(/\{[\s\S]*\}/); try { return m ? JSON.parse(m[0]) : null; } catch { return null; } };
const facts4ai = (f: any) => ({ engine: f.engine, libraries: f.libraries, platform_kits: f.platform_kits, rendering: f.rendering, graphics: f.graphics, input: f.input, audio: f.audio, assets: f.assets, platform_services: f.platform_services, loop: f.loop_and_performance, play_through: f.gameplay?.playthrough_steps, own_code_lines: f.structure?.own_code_lines });

const JUDGE = `You review web games before they are published on a marketplace. Decide whether a new game is a copy of an existing game by another creator.
"copy": the same game with cosmetic changes (renamed, recoloured, re-titled). "derivative": clearly inspired, shares mechanics or style, but is its own work. "independent": unrelated apart from genre.
You get both listings, facts about how each is built (never code) and similarity measurements: code = share of the new game's own code fingerprints found in the other (after removing shared templates and libraries), same_files and assets = shares of identical files, look_distance = screenshot hash distance (0 identical, 10 or less looks alike).
Answer with JSON only: {"verdict": "copy" | "derivative" | "independent", "reason": "one sentence"}`;

const GAMENESS = `You review uploads to a marketplace that hosts web games only. Decide whether an upload is a game: something a person plays, with rules, goals or play. Interactive toys and puzzles count. A landing page, a document, a form, a store, a link page, a tool or an app that is not a game does not.
You get the listing, facts about the build (never code) and the start of the page's visible text.
Answer with JSON only: {"is_game": true | false, "reason": "one sentence"}`;

/**
 * Runs the check for a version that passed the browser check and adds its results to the report
 * (checks "original" and "is_game"; report.ok turns false when either fails and blocking is on).
 */
export async function originalityCheck(env: Env, p: Project, v: Version, report: Record<string, any>): Promise<void> {
  const s = await getSettings(env);
  if (!s.dup_check || !report.ok) return;
  const t0 = Date.now();
  const me = await printVersion(env, p, { ...v, report: JSON.stringify(report) });
  const listing = { title: p.title, tagline: p.tagline, description: p.description.slice(0, 400), tags: parseJson(p.tags, []) };
  const checks: { id: string; ok: boolean; label: string; detail: string; hint: string }[] = [];
  const flag = (c: typeof checks[number]) => checks.push(c);

  // 1. a copy of someone else's live game?
  const matches = await matchesFor(env, p, v, me);
  let top = matches[0], judged: any = null;
  if (top && top.verdict === 'similar' && await aiBudget(env, 'dup_judge')) {
    const other = await env.DB.prepare('SELECT * FROM versions WHERE project_id = ? AND n = ?').bind(top.project_id, top.version).first<Version>();
    const otherFacts = other ? analyzeBundle(await readTexts(env, other.project_id, other.n, parseJson<any[]>(other.files, [])), parseJson(other.report, {})) : null;
    const { listing: theirs, project_id: _p, version: _v, slug: _s, title: _t, verdict: _x, ...measures } = top as any;
    judged = jsonFrom(await aiText(env, JUDGE, JSON.stringify({ new_game: { listing, facts: facts4ai(me.facts) }, existing_game: { listing: theirs, facts: otherFacts && facts4ai(otherFacts) }, measurements: measures }), 1200));
    if (judged && judged.verdict === 'copy') top = { ...top, verdict: 'copy' };
  }
  const measured = top ? `${top.code}% of its own code${top.assets ? `, ${top.assets}% of its asset files` : ''}${top.looks_alike ? ' and the same look' : ''}` : '';
  if (top && top.verdict === 'copy') {
    flag({ id: 'original', ok: false, label: 'Original work', detail: `Matches "${top.title}" (/g/${top.slug}) by another creator: ${measured}.${judged?.reason ? ` Review: ${judged.reason}` : ''}`, hint: 'Publishing a copy of another creator\'s game is not allowed. Platform templates and kits are fine to start from; make the game your own, with your own code, rules and look. If the other game is yours under another account, contact the platform.' });
    await logEvent(env, p.id, 'copy_flagged', `Matches ${top.slug}: ${measured}`, v.n, 'originality');
  } else {
    flag({ id: 'original', ok: true, label: 'Original work', detail: top && top.verdict === 'similar' ? `Shares some code or look with "${top.title}" by another creator (${measured}), ${judged ? `judged ${judged.verdict}` : 'not enough to call it a copy'}.` : `No other creator's live game matches it.`, hint: '' });
    if (top && top.verdict === 'similar') report.notes = [...(report.notes || []), `Originality: this version shares ${measured} with "${top.title}". That is allowed; a version that copies most of another creator's game is not.`];
  }

  // 2. is it a game at all?
  let g = gameness(me.facts, report, me.html), aiSaid: any = null;
  if (g.verdict === 'unsure' && await aiBudget(env, 'dup_gameness')) {
    const text = me.html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 1500);
    aiSaid = jsonFrom(await aiText(env, GAMENESS, JSON.stringify({ listing, facts: facts4ai(me.facts), visible_text: text }), 1000));
    if (aiSaid && typeof aiSaid.is_game === 'boolean') g = { verdict: aiSaid.is_game ? 'game' : 'not_game', reason: String(aiSaid.reason || g.reason).slice(0, 300) };
  }
  if (g.verdict === 'not_game') {
    flag({ id: 'is_game', ok: false, label: 'It is a game', detail: g.reason, hint: 'This platform hosts web games only: something a player plays, in this page. If it is a game, make sure the player can act on it (keyboard, mouse, touch or buttons) and register a play-through with GCP.test.onPlaythrough so the verifier can play it.' });
    await logEvent(env, p.id, 'not_game_flagged', g.reason, v.n, 'originality');
  } else flag({ id: 'is_game', ok: true, label: 'It is a game', detail: g.verdict === 'unsure' ? 'An interactive page; nothing showed it is not a game.' : g.reason, hint: '' });

  const failed = checks.filter((c) => !c.ok);
  if (failed.length && !s.dup_block) {
    for (const c of failed) { c.ok = true; c.detail = `Warning: ${c.detail}`; }
    report.warnings = [...(report.warnings || []), ...failed.map((c) => `${c.label}: ${c.detail}`)];
  }
  report.checks = [...(report.checks || []), ...checks];
  report.originality = { matches: matches.slice(0, 3).map(({ listing: _l, project_id: _p, ...m }) => m), game: g.verdict, ai: { judge: judged?.verdict || null, gameness: aiSaid ? aiSaid.is_game : null }, ms: Date.now() - t0 };
  if (report.checks.some((c: any) => !c.ok)) { report.ok = false; report.summary = `Not publishable: ${report.checks.filter((c: any) => !c.ok).map((c: any) => c.label.toLowerCase()).join('; ')}.`; }
}

/** Before a version goes live: compare again with games that went live since its check. Returns a reason to refuse, or null. */
export async function publishGate(env: Env, p: Project, v: Version): Promise<string | null> {
  const s = await getSettings(env);
  if (!s.dup_check || !s.dup_block) return null;
  const row = await env.DB.prepare('SELECT * FROM fingerprints WHERE project_id = ? AND version = ?').bind(p.id, v.n).first<any>();
  const me = row ? rowPrint(row) : await printVersion(env, p, v);
  const top = (await matchesFor(env, p, v, me))[0];
  return top && top.verdict === 'copy' ? `Version ${v.n} matches "${top.title}" (/g/${top.slug}) by another creator: ${top.code}% of its own code${top.assets ? `, ${top.assets}% of its asset files` : ''}${top.looks_alike ? ' and the same look' : ''}. Publishing copies of other creators' games is not allowed.` : null;
}
