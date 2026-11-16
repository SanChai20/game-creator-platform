// Runs every case of the labelled corpus through the local copy of the publish pipeline and reports, per gate and
// overall, how many legitimate games were blocked (false blocks) and how many violators went live (false approvals).
//   node tests/moderation/audit.mjs [--only=id,id] [--out=results.json]      (NO_AI=1 skips Workers AI)
import { readdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import * as H from './harness.mjs';

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')).map(([k, v]) => [k, v ?? true]));
const CORPUS = join(H.ROOT, 'tests/moderation/corpus');
let cases = readdirSync(CORPUS).filter((d) => existsSync(join(CORPUS, d, 'case.json'))).sort().map((d) => H.loadCase(join(CORPUS, d)));
const only = args.only ? new Set(String(args.only).split(',')) : null;
const { O, C } = H;
const pct = (x) => `${Math.round(x * 100)}%`;

const platform = await H.startPlatform();
const rows = [];
const conc = Number(args.jobs || 3);

async function firstPass(c) {
  const t0 = Date.now(), row = { id: c.id, expect: c.expect, kind: c.kind, gate: c.gate || null, blocked_by: null, detail: '', checks: {} };
  const st = await H.staticCheck(c, platform.origin);
  row.checks.static = { ok: st.ok, errors: st.errors.map((e) => `${e.file || ''}${e.line ? ':' + e.line : ''} ${e.message}`).slice(0, 5), warnings: st.warnings.length };
  if (!st.ok) { row.blocked_by = 'static'; row.detail = row.checks.static.errors[0]; row.ms = Date.now() - t0; return row; }
  const url = await platform.deploy(c, st.manifest);
  const { report, shot } = await H.browserCheck(url, !!st.manifest.usesWebGPU, platform.origin);
  row.report = report; row.shot = shot;
  row.checks.browser = { ok: report.ok, summary: report.summary, failed: report.checks.filter((k) => !k.ok).map((k) => `${k.id}: ${k.detail}`), fps: report.metrics?.fps, playthrough: report.playthrough ? report.playthrough.ok : null, craft: report.craft?.score ?? null };
  const failed = report.checks.filter((k) => !k.ok).map((k) => k.id);
  if (!report.ok) { row.blocked_by = failed.length === 1 && failed[0] === 'conduct' ? 'content' : 'browser'; row.detail = row.checks.browser.failed.join(' | ').slice(0, 300); }
  row.print = H.printCase(c, shot, report);
  row.ms = Date.now() - t0;
  return row;
}

async function pool(list, fn) { const out = []; let i = 0; await Promise.all(Array.from({ length: conc }, async () => { while (i < list.length) { const k = i++; out[k] = await fn(list[k]); } })); return out; }

const todo = cases.filter((c) => !only || only.has(c.id) || cases.some((x) => only.has(x.id) && x.copy_of === c.id));
console.error(`${todo.length} cases, AI ${H.AI_ON ? 'on' : 'off'}`);
const first = await pool(todo, async (c) => { const r = await firstPass(c).catch((e) => ({ id: c.id, expect: c.expect, kind: c.kind, blocked_by: 'harness', detail: String(e && e.stack || e).slice(0, 400), checks: {} })); console.error(`${c.id}: ${r.blocked_by || 'passed browser'} (${r.ms} ms)`); return r; });
const byId = new Map(first.map((r) => [r.id, r]));
// the live catalogue: cases marked live (published before the others), with their prints
const live = todo.filter((c) => c.live && byId.get(c.id)?.print).map((c) => ({ id: c.id, owner: c.owner, listing: c.listing, print: byId.get(c.id).print, report: byId.get(c.id).report, c }));

for (const c of only ? todo.filter((x) => only.has(x.id)) : todo) {
  const row = byId.get(c.id);
  if (row.blocked_by || !row.print) { rows.push(row); continue; }
  const listing = { title: c.listing?.title || c.id, tagline: c.listing?.tagline || '', description: String(c.listing?.description || '').slice(0, 400), tags: c.listing?.tags || [] };
  // 1. copies (originalityCheck)
  const matches = H.matchesFor(row.print, c.owner, live.filter((x) => x.id !== c.id));
  let top = matches[0], judged = null;
  if (top && top.verdict === 'similar') {
    const { other, id: _i, title: _t, verdict: _v, ...measures } = top;
    const a = (await H.aiDecide('clef', { new_game: { listing, facts: O.facts4ai(row.print.facts) }, existing_game: { listing: other.listing, facts: O.facts4ai(other.print.facts) }, measurements: measures }, O.JUDGE_QUESTIONS))?.verdict;
    if (a?.type === 'choice') judged = { verdict: a.choice, probabilities: a.probabilities };
    if (judged?.verdict === 'copy') top = { ...top, verdict: 'copy' };
  }
  row.checks.original = { ok: !(top && top.verdict === 'copy'), top: top ? { id: top.id, verdict: top.verdict, code: top.code, same_files: top.same_files, assets: top.assets, look: top.look_distance } : null, judged };
  // 2. is it a game (same steps as originalityCheck)
  const image = row.shot ? { images: ['data:image/png;base64,' + row.shot.toString('base64')] } : {};
  let g = O.gameness(row.print.facts, row.report, row.print.html), aiSaid = null;
  const legacy = g.sure === undefined;   // the gameness() of before this audit: AI only for 'unsure'
  if (legacy ? g.verdict === 'unsure' : !g.sure) {
    const state = legacy ? { listing, facts: O.facts4ai(row.print.facts), visible_text: O.visibleText(row.print.html) }
      : { listing, facts: O.facts4ai(row.print.facts), page: { visible_text: (row.report.page?.text || O.visibleText(row.print.html)).slice(0, 1500), controls: row.report.page?.controls ?? null, signals: g.signals } };
    const a = (await H.aiDecide('clef-flash', state, O.GAMENESS_QUESTIONS, legacy ? {} : image))?.is_game;
    if (a?.type === 'noul') { aiSaid = a.noul; g = a.noul >= 0.5 ? { ...g, verdict: 'game', reason: `AI ${pct(a.noul)} game` } : { ...g, verdict: 'not_game', reason: `AI ${pct(1 - a.noul)} not a game; ${g.reason}` }; }
  }
  row.checks.is_game = { ok: g.verdict !== 'not_game', verdict: g.verdict, reason: g.reason, ai: aiSaid };
  // 3. content and conduct (once the check exists)
  if (C && C.contentCheck) {
    row.checks.content = await C.contentCheck({ listing, html: row.print.html, pageText: row.report.page?.text || '', texts: c.files.filter((f) => /\.(m?js|cjs|html?|json|css)$/i.test(f.path)).map((f) => ({ path: f.path, text: f.bytes.toString('utf8') })), report: row.report, shot: row.shot, ai: H.AI_ON ? H.aiDecide : null, threshold: 0.5 });
  }
  const order = ['original', 'is_game', 'content'];
  for (const k of order) if (row.checks[k] && !row.checks[k].ok) { row.blocked_by = k; row.detail = k === 'original' ? `copy of ${top.id} (code ${top.code}%, files ${top.same_files}%, assets ${top.assets}%, look ${top.look_distance})` : k === 'is_game' ? g.reason : row.checks[k].reason; break; }
  rows.push(row);
}
await platform.close(); await H.closeBrowser();

// ---------------------------------------------------------------------------------------------- report
const GATES = ['static', 'browser', 'original', 'is_game', 'content'];
const lines = [];
const out = (s = '') => lines.push(s);
out('case | expect | kind | outcome | blocked by | expected gate | detail');
for (const r of rows) {
  const blocked = !!r.blocked_by, right = (r.expect === 'block') === blocked;
  out([r.id, r.expect, r.kind, (right ? 'OK ' : 'XX ') + (blocked ? 'blocked' : 'published'), r.blocked_by || '-', r.gate || '-', (r.detail || (r.checks.browser ? `fps ${r.checks.browser.fps}, playthrough ${r.checks.browser.playthrough}, craft ${r.checks.browser.craft}` : '')).replace(/\s+/g, ' ').slice(0, 220)].join(' | '));
}
const legit = rows.filter((r) => r.expect === 'publish'), bad = rows.filter((r) => r.expect === 'block');
const fb = legit.filter((r) => r.blocked_by), fa = bad.filter((r) => !r.blocked_by);
out(); out(`Overall: ${legit.length} legitimate games, ${fb.length} wrongly blocked (${pct(fb.length / Math.max(1, legit.length))}); ${bad.length} violators, ${fa.length} wrongly published (${pct(fa.length / Math.max(1, bad.length))}).`);
const tp = bad.length - fa.length; out(`Blocking precision ${pct(tp / Math.max(1, tp + fb.length))}, recall ${pct(tp / Math.max(1, bad.length))}.`);
out(); out('gate | blocked legit (false blocks) | blocked violators | violators it is meant to catch | of those, caught by it');
for (const g of GATES) {
  const fbs = legit.filter((r) => r.blocked_by === g).length, hits = bad.filter((r) => r.blocked_by === g).length, mine = bad.filter((r) => r.gate === g), caught = mine.filter((r) => r.blocked_by === g).length;
  out(`${g} | ${fbs} | ${hits} | ${mine.length} | ${caught}`);
}
if (fb.length) { out(); out('False blocks:'); for (const r of fb) out(`  ${r.id}: ${r.blocked_by}: ${(r.detail || '').slice(0, 300)}`); }
if (fa.length) { out(); out('False approvals:'); for (const r of fa) out(`  ${r.id} (${r.kind}, should be caught by ${r.gate})`); }
out(); out(`Workers AI: ${H.aiUsage.calls} calls, ${H.aiUsage.input_tokens} input tokens.`);
console.log(lines.join('\n'));
if (args.out) writeFileSync(String(args.out), JSON.stringify(rows.map(({ shot, print, report, ...r }) => ({ ...r, craft: report?.craft?.score ?? null, gameness: print ? undefined : undefined })), null, 1));
process.exit(0);
