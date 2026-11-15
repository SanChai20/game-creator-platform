// Open implementation: a creator can let other developers' agents learn how their live game was built.
// What is shared is a card the platform writes from the published build (facts from src/implementation.js and a
// summary written from those facts), never code, file contents or assets. With the setting off nothing is shared:
// the card is deleted and the game is not found.
import { notFound, type Env, type Project, type User } from './env';
import { getProject, getVersion, logEvent, verKey } from './projects';
import { getSettings } from './settings';
import { aiText } from './ai';
import { dayOf, now, parseJson } from './util';
// @ts-ignore plain JS module
import { READABLE, aggregate, analyzeBundle, ruleSummary, scrubSummary } from './implementation.js';

const TEXT_BUDGET = 4 * 1024 * 1024, FILE_TEXT_MAX = 2 * 1024 * 1024;
export const NEVER_SHARED = 'Source code, file contents and asset files are never shared. This card was written by the platform from the published build: facts about how it is made, and a summary written from those facts alone.';

interface Row { project_id: string; version: number; facts: string; summary: string; summary_source: string; reads: number; created_at: number }

const SYSTEM = `You explain how a published web game was built, for another developer's AI agent that wants to make something similar.
You are given the game's listing and facts the platform measured from its build. You never see its code.
Write 140 to 220 words of plain prose in three short paragraphs: how it is put together (engine, rendering, structure), how it plays and is controlled, and the techniques worth reusing.
Use only the facts given. Do not invent features. Do not write code, pseudo-code, file names or Markdown.`;

/** Builds (or rebuilds) the card for the project's live version. ai=false writes the rule-based summary only. */
export async function buildImplementation(env: Env, pid: string, opts: { ai?: boolean; store?: boolean } = {}) {
  const p = await getProject(env, pid);
  if (!p || !p.live_version) return null;
  const v = await getVersion(env, p.id, p.live_version);
  if (!v) return null;
  const list = parseJson<{ path: string; size: number }[]>(v.files, []);
  const files: { path: string; size: number; text?: string | null }[] = [];
  let budget = TEXT_BUDGET;
  for (const f of list) {
    let text: string | null = null;
    if (READABLE(f.path) && f.size <= FILE_TEXT_MAX && f.size <= budget) {
      const obj = await env.FILES.get(verKey(p.id, v.n, f.path));
      if (obj) { text = await obj.text(); budget -= f.size; }
    }
    files.push({ path: f.path, size: f.size, text });
  }
  const facts = analyzeBundle(files, parseJson(v.report, {}));
  const listing = { title: p.title, tagline: p.tagline, description: p.description.slice(0, 800), tags: parseJson<string[]>(p.tags, []), controls: p.controls.slice(0, 300) };
  let summary = ruleSummary(listing, facts), source = 'rules';
  const old = await env.DB.prepare('SELECT version, summary, summary_source FROM implementations WHERE project_id = ?').bind(p.id).first<{ version: number; summary: string; summary_source: string }>();
  if (old && old.version === v.n && old.summary_source === 'ai') { summary = old.summary; source = 'ai'; }
  else if (opts.ai !== false) {
    const s = await getSettings(env);
    const today = Date.parse(dayOf(now()) + 'T00:00:00Z');
    const used = await env.DB.prepare("SELECT COUNT(*) AS n FROM implementations WHERE summary_source = 'ai' AND created_at >= ?").bind(today).first<{ n: number }>();
    if (s.open_impl_ai && (used?.n || 0) < s.open_impl_ai_daily) {
      const out = await aiText(env, SYSTEM, JSON.stringify({ listing, facts: { ...facts, keywords: undefined } }), 1600);   // reasoning tokens count too
      const clean = out && scrubSummary(out);
      if (clean && clean.length > 200) { summary = clean; source = 'ai'; }
    }
  }
  if (opts.store !== false) {
    await env.DB.prepare('INSERT INTO implementations (project_id, version, facts, summary, summary_source, reads, created_at) VALUES (?, ?, ?, ?, ?, 0, ?) ON CONFLICT(project_id) DO UPDATE SET version = excluded.version, facts = excluded.facts, summary = excluded.summary, summary_source = excluded.summary_source, created_at = excluded.created_at')
      .bind(p.id, v.n, JSON.stringify(facts), summary, source, now()).run();
  }
  return { project_id: p.id, version: v.n, facts: JSON.stringify(facts), summary, summary_source: source, reads: 0, created_at: now() } as Row;
}

/** Turns the setting on or off. Off deletes the card, so nothing is shared from then on. */
export async function setOpenImplementation(env: Env, p: Project, on: boolean, actor: string, build = true) {
  if (!!p.open_implementation === on) { if (on && build && p.status === 'live') await freshRow(env, p); return; }
  await env.DB.prepare('UPDATE projects SET open_implementation = ?, open_implementation_at = ?, updated_at = ? WHERE id = ?').bind(on ? 1 : 0, on ? now() : null, now(), p.id).run();
  if (!on) await env.DB.prepare('DELETE FROM implementations WHERE project_id = ?').bind(p.id).run();
  await logEvent(env, p.id, on ? 'implementation_opened' : 'implementation_closed', on ? 'Other agents can learn how this game is built (no code)' : 'Implementation no longer shared', p.live_version, actor);
  if (on && build && p.status === 'live') { try { await buildImplementation(env, p.id); } catch (e) { console.error('implementation build failed', p.id, e); } }
}

/** After a version goes live: refresh the card of an open game. */
export async function afterPublish(env: Env, pid: string) {
  const p = await getProject(env, pid);
  if (p?.open_implementation && p.status === 'live') { try { await buildImplementation(env, pid); } catch (e) { console.error('implementation build failed', pid, e); } }
}

async function freshRow(env: Env, p: Project): Promise<Row | null> {
  const row = await env.DB.prepare('SELECT * FROM implementations WHERE project_id = ?').bind(p.id).first<Row>();
  if (row && row.version === p.live_version) return row;
  return buildImplementation(env, p.id);
}

const author = async (env: Env, uid: string) => (await env.DB.prepare('SELECT name FROM users WHERE id = ?').bind(uid).first<{ name: string }>())?.name || 'a creator';

function cardOf(origin: string, p: Project & { author?: string }, row: Row) {
  const facts = parseJson<any>(row.facts, {});
  const { keywords: _k, ...builtWith } = facts;
  return {
    game: { title: p.title, slug: p.slug, by: p.author, tagline: p.tagline, tags: parseJson<string[]>(p.tags, []), description: p.description.slice(0, 600), controls: p.controls.slice(0, 400), game_page: `${origin}/g/${p.slug}`, plays: p.plays },
    version: row.version, summary: row.summary, summary_source: row.summary_source === 'ai' ? 'Workers AI, from the facts below' : 'rules, from the facts below',
    built_with: builtWith, card_written: new Date(row.created_at).toISOString(), never_shared: NEVER_SHARED,
  };
}

/** The card another agent reads. The owner may read their own even when it is not shared (marked as a preview). */
export async function implementationCard(env: Env, origin: string, user: User | null, idOrSlug: string) {
  const p = await getProject(env, String(idOrSlug || '').trim().replace(/^.*\/g\//, '').replace(/[/?#].*$/, ''));
  const mine = !!p && !!user && (p.owner_id === user.id);
  const open = !!p && !!p.open_implementation && p.status === 'live';
  if (!p || p.status === 'removed' || (!open && !mine)) throw notFound(`There is no open implementation for "${idOrSlug}". Only live games whose creators chose to share how they were built can be read. find_implementations lists them.`);
  if (!p.live_version) throw notFound('This game has never been published, so there is no build to describe yet. Publish it first.');
  const row = open ? await freshRow(env, p) : await buildImplementation(env, p.id, { ai: false, store: false });
  if (!row) throw notFound('The live build of this game could not be read. Try again in a minute.');
  if (open && !mine) await env.DB.prepare('UPDATE implementations SET reads = reads + 1 WHERE project_id = ?').bind(p.id).run();
  const card = cardOf(origin, { ...p, author: await author(env, p.owner_id) }, row);
  return mine ? { ...card, yours: true, shared: open, ...(open ? { reads_by_other_agents: row.reads } : { not_shared: 'Preview only: this is what other agents would see if you turned open implementation on. Right now nothing about this game is shared.' }) } : card;
}

/** Open live games matching a query, and the patterns across them. */
export async function findImplementations(env: Env, origin: string, user: User | null, q: { query?: string; tags?: string[]; engine?: string; uses?: string[]; limit?: number }) {
  const rows = (await env.DB.prepare("SELECT p.*, u.name AS author, i.version AS i_version, i.facts AS i_facts, i.summary AS i_summary FROM projects p JOIN users u ON u.id = p.owner_id LEFT JOIN implementations i ON i.project_id = p.id WHERE p.status = 'live' AND p.open_implementation = 1 ORDER BY p.plays DESC LIMIT 500").all<any>()).results;
  // cards missing or behind the live version are rebuilt (rules only here, so a search never waits on AI)
  let rebuilt = 0;
  for (const r of rows) {
    if (r.i_facts && r.i_version === r.live_version) continue;
    if (rebuilt++ >= 3) continue;
    const b = await buildImplementation(env, r.id, { ai: false }).catch(() => null);
    if (b) { r.i_facts = b.facts; r.i_summary = b.summary; r.i_version = b.version; }
  }
  const words = String(q.query || '').toLowerCase().split(/[^\p{L}\p{N}.+-]+/u).filter((w) => w.length > 1).slice(0, 12);
  const tags = (q.tags || []).map((t) => String(t).toLowerCase().trim()).filter(Boolean);
  const engine = String(q.engine || '').toLowerCase().trim(), uses = (q.uses || []).map((u) => String(u).toLowerCase().trim()).filter(Boolean);
  const scored = [];
  for (const r of rows) {
    if (!r.i_facts) continue;
    const facts = parseJson<any>(r.i_facts, {}), ptags: string[] = parseJson(r.tags, []);
    const techs = [facts.engine, ...(facts.libraries || []), ...(facts.rendering || []), ...(facts.graphics || []), ...(facts.input || []), ...(facts.audio || []), ...(facts.platform_services || []), ...(facts.loop_and_performance || []), ...(facts.keywords || [])].map((x: string) => String(x).toLowerCase());
    if (tags.length && !tags.every((t) => ptags.includes(t))) continue;
    if (engine && !String(facts.engine || '').toLowerCase().includes(engine)) continue;
    if (uses.length && !uses.every((u) => techs.some((x) => x.includes(u)))) continue;
    const hay = `${r.title} ${r.tagline} ${r.description} ${ptags.join(' ')} ${techs.join(' ')} ${r.i_summary || ''}`.toLowerCase();
    const hits = words.filter((w) => hay.includes(w)).length;
    if (words.length && !hits) continue;
    scored.push({ r, facts, ptags, score: hits * 10 + Math.log10(1 + (r.plays || 0)) });
  }
  scored.sort((a, b) => b.score - a.score);
  const limit = Math.max(1, Math.min(25, Math.round(Number(q.limit) || 10)));
  return {
    matches: scored.length,
    games: scored.slice(0, limit).map(({ r, facts, ptags }) => ({
      game: r.slug, title: r.title, by: r.author, tagline: r.tagline, tags: ptags, plays: r.plays, game_page: `${origin}/g/${r.slug}`,
      engine: facts.engine, rendering: facts.rendering, input: facts.input, platform_services: facts.platform_services,
      summary: String(r.i_summary || '').split(/(?<=\.)\s/).slice(0, 2).join(' '), ...(user && r.owner_id === user.id ? { yours: true } : {}),
    })),
    patterns: scored.length >= 2 ? aggregate(scored.map((x) => x.facts)) : null,
    note: `Only live games whose creators chose to share how they were built are listed. get_implementation {game} returns one card in full. ${NEVER_SHARED}`,
  };
}
