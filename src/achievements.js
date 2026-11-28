// Achievements: milestones a game declares in gcp.json "achievements", frozen with each version, unlocked per player by the
// game (GCP.achievements.unlock) or by the platform when a player stat reaches a goal. Players see them on the game page and
// in their library, with how rare each one is. Plain JS over a D1-shaped database so the rules can be tested without a
// Worker (tests/achievements.mjs).
//
// Rules, enforced here and nowhere else:
//   - Which game, environment and player: always the signed play token's (src/player-data.js scopeOf, playerOf). A request
//     body names only achievement ids, and only ids the version declares can be unlocked.
//   - Unlocks are for good: a game cannot take one back (a progress reset by the player does).
//   - The verification browser never keeps unlocks; an agent's debug_preview session keeps them on the preview only.
//   - Rarity counts players of the live game who unlocked it out of everyone who has played it.

import { DataError } from './player-data.js';

export const MAX_ACHIEVEMENTS = 100;
export const ID = /^[a-z0-9][a-z0-9_-]{0,39}$/;
export const LIMITS = { name: 60, description: 160 };
const LANG_KEYS = ['en', 'zh', 'zh-TW', 'ja', 'ko', 'es'];

/** A name or description: a string, or one string per platform language ({ en, zh, 'zh-TW', ja, ko, es }). */
function text(raw, max, field, issues, required) {
  if (raw == null || raw === '') { if (required) issues.push({ level: 'error', field, message: 'is required.' }); return null; }
  if (typeof raw === 'string') {
    const s = raw.trim();
    if (s.length > max) issues.push({ level: 'warning', field, message: `is longer than ${max} characters and was cut.` });
    return s.slice(0, max) || null;
  }
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    const out = {};
    for (const [k, v] of Object.entries(raw)) {
      if (!LANG_KEYS.includes(k)) { issues.push({ level: 'warning', field: `${field}.${k}`, message: `is not a platform language (${LANG_KEYS.join(', ')}) and was left out.` }); continue; }
      if (typeof v !== 'string' || !v.trim()) continue;
      out[k] = v.trim().slice(0, max);
    }
    if (!Object.keys(out).length) { if (required) issues.push({ level: 'error', field, message: 'has no text in any platform language.' }); return null; }
    return out;
  }
  issues.push({ level: 'error', field, message: 'must be a string or an object of strings per language.' });
  return null;
}

/**
 * gcp.json "achievements" → { list, issues }. Each entry: { id, name, description?, hidden?, stat?, goal? }.
 * stat + goal unlock it by themselves when GCP.playerStats makes that stat reach the goal (or more).
 */
export function parseAchievements(raw) {
  const issues = [], list = [];
  if (raw == null) return { list, issues };
  if (!Array.isArray(raw)) return { list, issues: [{ level: 'error', field: 'achievements', message: 'must be an array of { id, name, description, hidden, stat, goal }.' }] };
  if (raw.length > MAX_ACHIEVEMENTS) issues.push({ level: 'error', field: 'achievements', message: `has ${raw.length} entries; a game may declare at most ${MAX_ACHIEVEMENTS}.` });
  const seen = new Set();
  raw.slice(0, MAX_ACHIEVEMENTS).forEach((a, i) => {
    const f = `achievements[${i}]`;
    if (!a || typeof a !== 'object' || Array.isArray(a)) { issues.push({ level: 'error', field: f, message: 'must be an object.' }); return; }
    const id = String(a.id ?? '');
    if (!ID.test(id)) { issues.push({ level: 'error', field: `${f}.id`, message: 'must be 1 to 40 characters of a-z, 0-9, _ and -, starting with a letter or digit.' }); return; }
    if (seen.has(id)) { issues.push({ level: 'error', field: `${f}.id`, message: `"${id}" is declared twice.` }); return; }
    seen.add(id);
    const name = text(a.name, LIMITS.name, `${f}.name`, issues, true);
    if (!name) return;
    const out = { id, name };
    const description = text(a.description, LIMITS.description, `${f}.description`, issues, false);
    if (description) out.description = description;
    if (a.hidden === true) out.hidden = true;
    if (a.stat != null || a.goal != null) {
      const stat = typeof a.stat === 'string' ? a.stat : '', goal = Number(a.goal);
      if (!stat || stat.length > 60) { issues.push({ level: 'error', field: `${f}.stat`, message: 'must name a player stat (1 to 60 characters) when goal is given.' }); return; }
      if (a.goal == null || !Number.isFinite(goal) || Math.abs(goal) > 1e15) { issues.push({ level: 'error', field: `${f}.goal`, message: 'must be a finite number when stat is given.' }); return; }
      out.stat = stat; out.goal = goal;
    }
    list.push(out);
  });
  return { list, issues };
}

/** The text of a name or description in the viewer's platform language: theirs, else English, else the first given. */
export function pickText(v, lang) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  return v[lang] ?? (lang === 'zh-TW' ? v.zh : lang === 'zh' ? v['zh-TW'] : undefined) ?? v.en ?? Object.values(v)[0] ?? '';
}

/** Ids whose stat goal the new value of `stat` reaches. */
export function reachedBy(defs, stat, value) {
  if (!Array.isArray(defs) || !Number.isFinite(Number(value))) return [];
  return defs.filter((a) => a.stat === stat && Number(value) >= a.goal).map((a) => a.id);
}

/** Whether this session's unlocks are kept: never the verifier's, except an agent's debug_preview session on the preview. */
export const keepsUnlocks = (tok) => tok.k !== 'verify' || (!!tok.dbg && tok.e === 'preview');

/**
 * Unlocks `ids` (only those declared in defs) for the token's player. Returns { ok, unlocked: [ids new this call] }.
 * Already unlocked ids are left as they were (the first unlock time stays).
 */
export async function unlock(db, scope, owner, defs, ids, t = Date.now(), keep = true) {
  const known = new Set((defs || []).map((a) => a.id));
  const want = [...new Set((Array.isArray(ids) ? ids : [ids]).map(String))];
  const unknown = want.filter((id) => !known.has(id));
  if (unknown.length) {
    throw new DataError(400, `Unknown achievement${unknown.length > 1 ? 's' : ''} ${unknown.map((x) => `"${x}"`).join(', ')}. Declare ${unknown.length > 1 ? 'them' : 'it'} in gcp.json "achievements" and deploy a new version.`, 'unknown_achievement');
  }
  if (!want.length || !keep || !owner) return { ok: true, unlocked: [], ...(keep ? {} : { recorded: false }) };
  const got = [];
  for (const id of want) {
    const r = await db.prepare('INSERT INTO achievement_unlocks (project_id, user_id, ach_id, unlocked_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING').bind(scope, owner, id, t).run();
    if (r.meta?.changes) got.push(id);
  }
  return { ok: true, unlocked: got };
}

/** The unlock times of one player in one game: { id: unlocked_at }. */
export async function unlocksOf(db, scope, owner) {
  if (!owner) return {};
  const rows = await db.prepare('SELECT ach_id, unlocked_at FROM achievement_unlocks WHERE project_id = ? AND user_id = ?').bind(scope, owner).all();
  return Object.fromEntries(rows.results.map((r) => [r.ach_id, r.unlocked_at]));
}

/** How many players unlocked each achievement, and how many have played the game: { counts: { id: n }, players }. */
export async function rarityOf(db, scope) {
  const [rows, p] = await Promise.all([
    db.prepare('SELECT ach_id, COUNT(*) AS n FROM achievement_unlocks WHERE project_id = ? GROUP BY ach_id').bind(scope).all(),
    db.prepare("SELECT COUNT(*) AS n FROM player_games WHERE project_id = ? AND user_id NOT LIKE 'verify:%'").bind(scope).first(),
  ]);
  return { counts: Object.fromEntries(rows.results.map((r) => [r.ach_id, r.n])), players: p?.n || 0 };
}

/**
 * What a viewer sees: every declared achievement in the viewer's language, whether they unlocked it and when, and the
 * share of players who did. A hidden one the viewer has not unlocked shows no name or description.
 */
export function viewOf(defs, mine, rarity, lang = 'en') {
  const players = Math.max(rarity.players, 1);
  const list = (defs || []).map((a) => {
    const at = mine[a.id] || null, secret = a.hidden && !at;
    const n = rarity.counts[a.id] || 0;
    return {
      id: a.id,
      name: secret ? '' : pickText(a.name, lang),
      description: secret ? '' : pickText(a.description, lang),
      hidden: !!a.hidden,
      unlocked_at: at,
      percent: rarity.players ? Math.min(100, Math.round((n / players) * 1000) / 10) : 0,
      ...(a.stat && !secret ? { stat: a.stat, goal: a.goal } : {}),
    };
  });
  return { achievements: list, total: list.length, unlocked: list.filter((a) => a.unlocked_at).length, players: rarity.players };
}

/** Per game for one player, for the library: { scope: unlocked count }. */
export async function unlockCounts(db, owner, scopes) {
  if (!owner || !scopes.length) return {};
  const rows = await db.prepare(`SELECT project_id, COUNT(*) AS n FROM achievement_unlocks WHERE user_id = ? AND project_id IN (${scopes.map(() => '?').join(',')}) GROUP BY project_id`).bind(owner, ...scopes).all();
  return Object.fromEntries(rows.results.map((r) => [r.project_id, r.n]));
}

/** The achievements a version declares, read from its frozen manifest. Preview reads the preview version, live the live one. */
export async function declaredFor(db, game, env) {
  const col = env === 'preview' ? 'preview_version' : 'live_version';
  const r = await db.prepare(`SELECT json_extract(v.manifest, '$.achievements') AS a FROM projects p JOIN versions v ON v.project_id = p.id AND v.n = p.${col} WHERE p.id = ?`).bind(game).first();
  if (!r || !r.a) return [];
  try { const a = JSON.parse(r.a); return Array.isArray(a) ? a : []; } catch { return []; }
}
