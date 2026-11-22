// Build skills and the Creator Store. A game that shares its Open Implementation shares a build skill: an agent skill its
// own development agent writes (build_skill in src/mcp/tools.ts) about how the game is built, never its code. A skill is
// written for one version; the store always serves the one written for the live version, and while sharing is on a new
// version cannot go live without one (admin setting skill_required_to_publish), so the skill stays in step with every
// release. Rollbacks bring back the skill written for that version. A creator shares the skill for free (the game's sales
// then pay the lower cut) or sells it (the game pays the standard cut, and each skill sale pays the skill commission).
// The rules about what a skill may contain are in src/skill-rules.js.
import { listingLangs } from './listing';
import { AppError, bad, forbidden, notFound, type Env, type Project, type User } from './env';
import { getProject, logEvent } from './projects';
import { getSettings, type Settings } from './settings';
import { ownsSkill, splitSkillSale } from './earnings';
import { buildImplementation } from './implementations';
import { now, parseJson } from './util';
// @ts-ignore plain JS module
import { SKILL_LIMITS, SKILL_OUTLINE, checkSkill, fallbackSkill, headingsOf, normalizeSkill, skillMarkdown, skillName } from './skill-rules.js';

export interface SkillRow { project_id: string; version: number; description: string; content: string; written_by: string; created_at: number; updated_at: number }

const usd = (c: number) => `$${(c / 100).toFixed(2)}`;
export const NO_CODE = 'A build skill holds a game\'s practices, never its code: the platform refuses code blocks, HTML and code-like lines, and never shares source files or assets.';

/** The skill written for exactly this version, if any. */
export const skillFor = (env: Env, pid: string, version: number) =>
  env.DB.prepare('SELECT * FROM game_skills WHERE project_id = ? AND version = ?').bind(pid, version).first<SkillRow>();

/**
 * The skill that describes the live game: the one written for the live version, or (when the agent has not written one
 * for it, e.g. the game went live before skills existed) the newest one written for an earlier version, marked as behind.
 * With none at all, a game that shares gets the platform's own card arranged as a skill.
 */
export async function liveSkill(env: Env, p: Project): Promise<{ row: SkillRow; current: boolean; generated: boolean } | null> {
  if (!p.live_version) return null;
  const row = await env.DB.prepare('SELECT * FROM game_skills WHERE project_id = ? AND version <= ? ORDER BY version DESC LIMIT 1').bind(p.id, p.live_version).first<SkillRow>();
  if (row) return { row, current: row.version === p.live_version, generated: false };
  if (!p.open_implementation) return null;
  let card = await env.DB.prepare('SELECT version, facts, summary FROM implementations WHERE project_id = ?').bind(p.id).first<{ version: number; facts: string; summary: string }>();
  if (!card || card.version !== p.live_version) card = await buildImplementation(env, p.id, { ai: false }).catch(() => null);
  if (!card) return null;
  const listing = { title: p.title, tagline: p.tagline, tags: parseJson<string[]>(p.tags, []) };
  const content = fallbackSkill(listing, parseJson(card.facts, {}), card.summary);
  return { row: { project_id: p.id, version: card.version, description: p.tagline || '', content, written_by: 'platform', created_at: now(), updated_at: now() }, current: card.version === p.live_version, generated: true };
}

/** Measured facts of the live build, for the platform's section of the SKILL.md. */
async function factsOf(env: Env, p: Project) {
  const r = await env.DB.prepare('SELECT version, facts FROM implementations WHERE project_id = ?').bind(p.id).first<{ version: number; facts: string }>();
  return r && r.version === p.live_version ? parseJson<any>(r.facts, null) : null;
}

/**
 * Writes the skill for one version of the game (default: the newest deployed version, the one about to be published).
 * Refuses code and anything too short to be useful, naming each line. Writing again for the same version replaces it.
 */
export async function writeSkill(env: Env, p: Project, a: { content?: unknown; description?: unknown; version?: unknown }, actor: string) {
  const n = a.version === undefined || a.version === null ? (p.preview_version || p.live_version) : Math.round(Number(a.version));
  if (!n || !Number.isFinite(n)) throw bad('This game has no version yet, so there is nothing for a skill to describe.', 'Call deploy_preview first, then write the skill for that version.');
  const v = await env.DB.prepare('SELECT n FROM versions WHERE project_id = ? AND n = ?').bind(p.id, n).first<{ n: number }>();
  if (!v) throw bad(`Version ${n} does not exist.`, 'list_versions shows the versions. Omit version to write for the newest one.');
  if (typeof a.content !== 'string' || !a.content.trim()) throw bad('content is required: the skill in Markdown, without code.', 'build_skill {action: "get"} returns the outline and what to cover.');
  const { body, description } = normalizeSkill(a.content, typeof a.description === 'string' ? a.description : '');
  const check = checkSkill(body);
  if (!check.ok) {
    const lines = check.problems.map((x: { line: number; why: string }) => (x.line ? `line ${x.line}: ${x.why}` : x.why));
    throw new AppError(400, `The skill was not saved. ${lines.length} thing${lines.length > 1 ? 's' : ''} to fix:\n${lines.join('\n')}`, 'skill_refused', `${NO_CODE} Rewrite those lines as prose and call build_skill {action: "write"} again. Line numbers count from the first line after the front matter and title.`);
  }
  const t = now();
  await env.DB.prepare('INSERT INTO game_skills (project_id, version, description, content, written_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(project_id, version) DO UPDATE SET description = excluded.description, content = excluded.content, written_by = excluded.written_by, updated_at = excluded.updated_at')
    .bind(p.id, n, description, body, actor.slice(0, 80), t, t).run();
  await logEvent(env, p.id, 'skill_written', `Build skill written (${headingsOf(body).length} sections, ${body.length} characters)`, n, actor);
  return { version: n, sections: headingsOf(body), characters: body.length, description };
}

/** Why version n of this game cannot be published yet, or null. Only a game that shares its skill is held to it. */
export async function skillGate(env: Env, s: Pick<Settings, 'skill_required_to_publish'>, p: Project, n: number): Promise<string | null> {
  if (!s.skill_required_to_publish || !p.open_implementation) return null;
  if (await skillFor(env, p.id, n)) return null;
  return `This game shares its build skill in the Creator Store, and the skill must match every release: version ${n} has no build skill yet.`;
}

/** Sets the skill's price: 0 shares it for free; otherwise within the platform's range. */
export async function setSkillPrice(env: Env, s: Settings, p: Project, cents: unknown, actor: string) {
  const c = Math.round(Number(cents));
  if (!Number.isFinite(c) || c < 0) throw bad('skill_price_cents must be 0 (free) or a price in cents.');
  if (c > 0) {
    if (!s.paid_skills_enabled) throw forbidden('Selling build skills is turned off on this platform. Share it for free (0) instead.');
    if (c < s.skill_price_min_cents || c > s.skill_price_max_cents) throw bad(`A paid build skill costs from ${usd(s.skill_price_min_cents)} to ${usd(s.skill_price_max_cents)}.`);
    if (!(await env.DB.prepare('SELECT 1 FROM game_skills WHERE project_id = ? LIMIT 1').bind(p.id).first())) throw bad('There is no build skill to sell yet.', 'Ask the agent to write it first (build_skill {action: "write"}).');
  }
  if (c === (p.skill_price_cents || 0)) return;
  await env.DB.prepare('UPDATE projects SET skill_price_cents = ?, updated_at = ? WHERE id = ?').bind(c, now(), p.id).run();
  await logEvent(env, p.id, 'skill_price', c ? `Build skill priced at ${usd(c)}` : 'Build skill shared for free', null, actor);
}

/** Who may read a skill's content: everyone for a free one; the creator, admins and buyers for a paid one. */
async function access(env: Env, user: User | null, p: Project): Promise<{ can: boolean; why: 'free' | 'yours' | 'admin' | 'bought' | null }> {
  if (!(p.skill_price_cents > 0)) return { can: true, why: 'free' };
  if (!user) return { can: false, why: null };
  if (user.id === p.owner_id) return { can: true, why: 'yours' };
  if (await ownsSkill(env, user.id, p.id)) return { can: true, why: 'bought' };
  if (user.role === 'admin') return { can: true, why: 'admin' };
  return { can: false, why: null };
}

const STORE_SELECT = "SELECT p.*, u.name AS author, s.version AS s_version, s.description AS s_description, s.content AS s_content, s.written_by AS s_by, s.updated_at AS s_updated FROM projects p JOIN users u ON u.id = p.owner_id LEFT JOIN game_skills s ON s.project_id = p.id AND s.version = (SELECT MAX(version) FROM game_skills x WHERE x.project_id = p.id AND x.version <= p.live_version) WHERE p.status = 'live' AND p.open_implementation = 1";

function entry(origin: string, r: any, owned: boolean) {
  const generated = !r.s_version, version = r.s_version || r.live_version;
  return {
    game: { id: r.id, slug: r.slug, title: r.title, tagline: r.tagline, by: r.author, tags: parseJson<string[]>(r.tags, []), cover: r.cover_key ? `${origin}/api/media/${r.cover_key}` : null, ...listingLangs(r, ['title', 'tagline'], (k) => `${origin}/api/media/${k}`), game_page: `${origin}/g/${r.slug}`, plays: r.plays, live_version: r.live_version, price_cents: r.price_cents },
    skill: {
      name: skillName(r.slug), price_cents: Number(r.skill_price_cents) || 0, free: !(Number(r.skill_price_cents) > 0), version, in_sync: version === r.live_version, written_by_platform: generated,
      description: generated ? (r.tagline || '') : (r.s_description || r.tagline || ''), sections: generated ? [] : headingsOf(r.s_content), characters: generated ? 0 : String(r.s_content || '').length,
      sales: Number(r.skill_sales) || 0, copies: Number(r.skill_copies) || 0, updated_at: r.s_updated || r.published_at, page: `${origin}/creator-store/${r.slug}`,
      ...(owned ? { owned: true } : {}),
    },
  };
}

/** The Creator Store: every shared skill, listed under its game. Paid skills that have no written skill are left out. */
export async function storeList(env: Env, origin: string, user: User | null, q: { query?: string; price?: string; sort?: string; limit?: number; offset?: number }) {
  const words = String(q.query || '').toLowerCase().split(/[^\p{L}\p{N}.+-]+/u).filter((w) => w.length > 1).slice(0, 8);
  const rows = (await env.DB.prepare(`${STORE_SELECT} ORDER BY p.plays DESC LIMIT 1000`).all<any>()).results
    .filter((r) => r.s_version || !(Number(r.skill_price_cents) > 0))
    .filter((r) => q.price === 'free' ? !(Number(r.skill_price_cents) > 0) : q.price === 'paid' ? Number(r.skill_price_cents) > 0 : true)
    .filter((r) => !words.length || words.every((w) => `${r.title} ${r.tagline} ${r.tags} ${r.author} ${r.s_description || ''} ${headingsOf(r.s_content).join(' ')}`.toLowerCase().includes(w)));
  if (q.sort === 'new') rows.sort((a, b) => (b.s_updated || b.published_at || 0) - (a.s_updated || a.published_at || 0));
  else if (q.sort === 'sales') rows.sort((a, b) => (b.skill_sales + b.skill_copies) - (a.skill_sales + a.skill_copies));
  const bought = user ? new Set((await env.DB.prepare("SELECT project_id FROM skill_purchases WHERE user_id = ? AND status = 'paid'").bind(user.id).all<{ project_id: string }>()).results.map((x) => x.project_id)) : new Set<string>();
  const limit = Math.max(1, Math.min(100, Math.round(Number(q.limit) || 48))), offset = Math.max(0, Math.round(Number(q.offset) || 0));
  return { total: rows.length, skills: rows.slice(offset, offset + limit).map((r) => entry(origin, r, bought.has(r.id) || r.owner_id === user?.id)) };
}

/** One game's skill: its listing, and its full content and SKILL.md when the reader may see it. */
export async function storeItem(env: Env, origin: string, user: User | null, slug: string, count = true) {
  const p = await getProject(env, String(slug || '').trim().replace(/^.*\/(?:g|creator-store)\//, '').replace(/[/?#].*$/, ''));
  if (!p || p.status !== 'live' || (!p.open_implementation && p.owner_id !== user?.id)) throw notFound('There is no build skill for that game in the Creator Store. Only live games whose creators share their skill are listed.');
  const live = await liveSkill(env, p);
  if (!live || (live.generated && p.skill_price_cents > 0)) throw notFound('This game\'s creator has not written its build skill yet.');
  const author = (await env.DB.prepare('SELECT name FROM users WHERE id = ?').bind(p.owner_id).first<{ name: string }>())?.name || '';
  const a = await access(env, user, p), s = await getSettings(env);
  if (count && user?.id !== p.owner_id) await env.DB.prepare('UPDATE projects SET skill_views = skill_views + 1 WHERE id = ?').bind(p.id).run();
  const base = entry(origin, { ...p, author, s_version: live.generated ? null : live.row.version, s_description: live.row.description, s_content: live.row.content, s_updated: live.row.updated_at }, a.why === 'bought' || a.why === 'yours');
  const md = a.can ? skillMarkdown({ title: p.title, slug: p.slug, by: author, version: live.row.version, description: live.row.description || p.tagline, body: live.row.content, origin, facts: await factsOf(env, p) }) : null;
  return {
    ...base,
    shared: !!p.open_implementation,
    access: a.why, locked: !a.can,
    content: a.can ? live.row.content : null, skill_md: md,
    buy: a.can ? null : { price_cents: p.skill_price_cents, sign_in: !user, note: 'The full skill shows after purchase.' },
    ...(user?.id === p.owner_id ? { yours: { sales: p.skill_sales, copies: p.skill_copies, views: p.skill_views, creator_receives_per_sale: p.skill_price_cents > 0 ? splitSkillSale(p.skill_price_cents, s).net : null } } : {}),
    never_shared: NO_CODE,
  };
}

/** Someone copied or downloaded the skill: counted for the creator, once per reader per hour. */
export async function skillCopied(env: Env, user: User | null, slug: string, key: string) {
  const p = await getProject(env, slug);
  if (!p || p.status !== 'live' || !p.open_implementation) throw notFound();
  const a = await access(env, user, p);
  if (!a.can) throw forbidden('Buy the skill first.');
  if (user?.id === p.owner_id) return { ok: true };
  const k = `skill_copy:${p.id}:${key}`, t = now();
  const seen = await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind('_' + k).first<{ value: string }>();
  if (seen && t - Number(seen.value) < 3600_000) return { ok: true };
  await env.DB.batch([
    env.DB.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at').bind('_' + k, String(t), t),
    env.DB.prepare('UPDATE projects SET skill_copies = skill_copies + 1 WHERE id = ?').bind(p.id),
  ]);
  return { ok: true };
}

/** What the game's own agent gets from build_skill {action: "get"}: the current skill, sync state and the outline. */
export async function skillForAgent(env: Env, origin: string, p: Project, version?: number) {
  const s = await getSettings(env);
  const target = version || p.preview_version || p.live_version;
  const [row, live] = await Promise.all([target ? skillFor(env, p.id, target) : null, liveSkill(env, p)]);
  const newest = await env.DB.prepare('SELECT * FROM game_skills WHERE project_id = ? ORDER BY version DESC LIMIT 1').bind(p.id).first<SkillRow>();
  return {
    game: p.slug, live_version: p.live_version, newest_version: p.preview_version, shared: !!p.open_implementation,
    price: p.skill_price_cents > 0 ? usd(p.skill_price_cents) : 'free',
    for_version: target ?? null, written_for_this_version: !!row,
    skill: row ? { version: row.version, description: row.description, content: row.content } : newest ? { version: newest.version, description: newest.description, content: newest.content, note: `This is the skill written for version ${newest.version}. Update it for version ${target} and write it again.` } : null,
    live: live ? { version: live.row.version, in_sync: live.current, written_by_platform: live.generated } : null,
    publishing: p.open_implementation && s.skill_required_to_publish ? `While the skill is shared, publish refuses a version that has no skill written for it. Write the skill for version ${target} before publishing it.` : 'Not shared: publishing does not wait for the skill, but keeping it current means it is ready when the user shares it.',
    how_to_write: {
      format: 'Markdown. A one-line description plus a body organised under level-two headings (##). The platform adds the front matter (name, description), the title, where the skill comes from and the facts it measured, so Copy skill gives other agents a complete SKILL.md.',
      rules: [NO_CODE, `${SKILL_LIMITS.min_chars} to ${SKILL_LIMITS.max_chars} characters, at least ${SKILL_LIMITS.min_sections} sections.`, `Inline code only for names of APIs, files or values, at most ${SKILL_LIMITS.inline_code_max} characters.`, 'Write for another agent building a similar game, not a different version of this one: practices, decisions and their reasons, numbers that were tuned, the order to build things in, and pitfalls.', 'Describe what is in the version you write it for. Leave out secrets, keys, private addresses and anything the user asked to keep private.'],
      outline: SKILL_OUTLINE,
    },
    store_page: `${origin}/creator-store/${p.slug}`,
  };
}

/** Skill sales of one creator, apart from game sales. */
export async function skillSalesOf(env: Env, ownerId: string) {
  const [total, byGame] = await Promise.all([
    env.DB.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(price_cents), 0) AS gross, COALESCE(SUM(fee_cents), 0) AS fees, COALESCE(SUM(net_cents), 0) AS net FROM skill_purchases WHERE owner_id = ? AND status = 'paid'").bind(ownerId).first<{ n: number; gross: number; fees: number; net: number }>(),
    env.DB.prepare("SELECT p.title, p.slug, p.skill_copies AS copies, COUNT(x.id) AS n, COALESCE(SUM(x.price_cents), 0) AS gross, COALESCE(SUM(x.fee_cents), 0) AS fees, COALESCE(SUM(x.net_cents), 0) AS net FROM projects p LEFT JOIN skill_purchases x ON x.project_id = p.id AND x.status = 'paid' WHERE p.owner_id = ? AND (p.open_implementation = 1 OR x.id IS NOT NULL) GROUP BY p.id ORDER BY net DESC, copies DESC").bind(ownerId).all<any>(),
  ]);
  return { total: total || { n: 0, gross: 0, fees: 0, net: 0 }, by_game: byGame.results };
}
