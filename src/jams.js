// Game jams and festivals. A jam has a theme, a window in which creators enter games, then a window in which players
// who played an entry score it on the host's criteria; the results rank the entries. A festival is a showcase: for a
// few days its live and coming soon games share a page and, when the platform hosts it, a shelf on the store's home
// page. Plain JS over a D1-shaped database so the rules can be tested without a Worker (tests/jams.mjs).
//
// Rules, enforced here and nowhere else:
//   - Licensed creators and admins host. An admin's jam or festival is the platform's and is featured on the home page.
//     A creator hosts at most 3 that have not ended.
//   - A jam's theme stays hidden from everyone but its host until the jam starts.
//   - An entry is the entrant's own live game (a festival also takes a coming soon game), never an adults-only one. In a
//     jam that says so, only a game created after the jam started. At most 3 entries per creator per event.
//   - Entries can be added and withdrawn only while entries are open.
//   - Only a player who has played the live game may vote on it, never its owner, and only while voting is open; a
//     vote scores every criterion from 1 to 5 and can be changed until voting closes.
//   - An entry is ranked once it has at least `min_votes` voters; the others are listed unranked.

export const LIMITS = { title: 80, theme: 80, description: 2000, criteria: 5, criterion: 40, open_per_host: 3, entries_per_creator: 3, min_votes: 3,
  entry_days_max: 60, voting_days_max: 30, festival_days_max: 30, min_hours: 1 };
export const DEFAULT_CRITERIA = ['Fun', 'Originality', 'Presentation', 'Theme'];
const HOUR = 3600_000, DAY = 86400_000;

export class JamError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code; }
}
const now = () => Date.now();
const parse = (s, d) => { try { const v = JSON.parse(s); return v ?? d; } catch { return d; } };
const line = (s, max) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const text = (s, max) => String(s ?? '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').replace(/\n{3,}/g, '\n\n').trim().slice(0, max);
const rand = (n) => { const a = 'abcdefghjkmnpqrstuvwxyz23456789', b = crypto.getRandomValues(new Uint8Array(n)); return [...b].map((x) => a[x % a.length]).join(''); };
const slugify = (s) => String(s).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

/** Where an event is now: upcoming, entries, voting (jams), results (jams), running/ended (festivals), cancelled. */
export function phaseOf(j, t = now()) {
  if (j.status === 'cancelled') return 'cancelled';
  if (t < j.starts_at) return 'upcoming';
  if (j.kind === 'festival') return t < j.ends_at ? 'running' : 'ended';
  if (t < j.ends_at) return 'entries';
  return t < j.voting_ends_at ? 'voting' : 'results';
}
const entriesOpen = (j, t) => { const ph = phaseOf(j, t); return j.kind === 'festival' ? ph === 'upcoming' || ph === 'running' : ph === 'entries'; };

/** The host's input → a cleaned event, or a JamError. Times are unix ms. */
export function cleanSetup(raw = {}, t = now()) {
  const kind = raw.kind === 'festival' ? 'festival' : 'jam';
  const title = line(raw.title, LIMITS.title);
  if (!title) throw new JamError(400, 'Give it a title.', 'bad_request');
  const starts = Math.round(Number(raw.starts_at)), ends = Math.round(Number(raw.ends_at));
  if (!Number.isFinite(starts) || starts < t - 5 * 60_000) throw new JamError(400, 'starts_at must be now or later.', 'bad_request');
  if (!Number.isFinite(ends) || ends - starts < LIMITS.min_hours * HOUR) throw new JamError(400, 'ends_at must be at least an hour after starts_at.', 'bad_request');
  const out = { kind, title, description: text(raw.description, LIMITS.description) || null, starts_at: starts, ends_at: ends };
  if (kind === 'festival') {
    if (ends - starts > LIMITS.festival_days_max * DAY) throw new JamError(400, `A festival lasts at most ${LIMITS.festival_days_max} days.`, 'bad_request');
    return { ...out, theme: null, criteria: [], new_only: 0, voting_ends_at: null };
  }
  if (ends - starts > LIMITS.entry_days_max * DAY) throw new JamError(400, `Entries can stay open at most ${LIMITS.entry_days_max} days.`, 'bad_request');
  const voting = Math.round(Number(raw.voting_ends_at ?? ends + 7 * DAY));
  if (!(voting - ends >= LIMITS.min_hours * HOUR) || voting - ends > LIMITS.voting_days_max * DAY) throw new JamError(400, `voting_ends_at must be 1 hour to ${LIMITS.voting_days_max} days after ends_at.`, 'bad_request');
  const theme = line(raw.theme, LIMITS.theme);
  if (!theme) throw new JamError(400, 'A jam needs a theme. It stays hidden until the jam starts.', 'bad_request');
  const list = Array.isArray(raw.criteria) && raw.criteria.length ? raw.criteria : DEFAULT_CRITERIA;
  const criteria = [...new Set(list.map((c) => line(c, LIMITS.criterion)).filter(Boolean))];
  if (!criteria.length || criteria.length > LIMITS.criteria) throw new JamError(400, `Give 1 to ${LIMITS.criteria} criteria.`, 'bad_request');
  return { ...out, theme, criteria, new_only: raw.new_only === false ? 0 : 1, voting_ends_at: voting };
}

async function hostOf(db, uid, t) {
  return db.prepare("SELECT id, name, role FROM users WHERE id = ? AND status = 'active' AND (role = 'admin' OR (creator = 1 AND (creator_until IS NULL OR creator_until > ?)))").bind(uid, t).first();
}

/** Hosts a jam or festival. Returns the event row. */
export async function hostJam(db, uid, raw, t = now()) {
  const host = uid ? await hostOf(db, uid, t) : null;
  if (!host) throw new JamError(403, 'Hosting a jam needs a creator license.', 'not_creator');
  const s = cleanSetup(raw, t);
  const admin = host.role === 'admin';
  if (!admin) {
    const open = (await db.prepare("SELECT COUNT(*) AS n FROM jams WHERE host_id = ? AND status = 'active' AND COALESCE(voting_ends_at, ends_at) > ?").bind(uid, t).first())?.n || 0;
    if (open >= LIMITS.open_per_host) throw new JamError(409, `You can host at most ${LIMITS.open_per_host} events that have not ended.`, 'too_many');
  }
  const row = { id: 'jam_' + rand(10), slug: `${slugify(s.title) || 'jam'}-${rand(4)}`, host_id: uid, ...s, criteria: JSON.stringify(s.criteria), featured: admin ? 1 : 0, status: 'active', created_at: t };
  await db.prepare(`INSERT INTO jams (id, slug, host_id, kind, title, theme, description, criteria, new_only, starts_at, ends_at, voting_ends_at, featured, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(row.id, row.slug, uid, row.kind, row.title, row.theme, row.description, row.criteria, row.new_only, row.starts_at, row.ends_at, row.voting_ends_at, row.featured, 'active', t).run();
  return row;
}

export async function bySlug(db, slug) {
  if (!/^[a-z0-9-]{3,60}$/.test(String(slug || ''))) return null;
  return db.prepare('SELECT j.*, u.name AS host_name FROM jams j LEFT JOIN users u ON u.id = j.host_id WHERE j.slug = ?').bind(slug).first();
}

/** Cancels an event: its host before it has ended, or an admin at any time. */
export async function cancelJam(db, j, user, t = now()) {
  const admin = user?.role === 'admin';
  if (!admin && user?.id !== j.host_id) throw new JamError(403, 'Only the host can cancel it.', 'forbidden');
  const ph = phaseOf(j, t);
  if (!admin && (ph === 'results' || ph === 'ended')) throw new JamError(409, 'It has already ended.', 'ended');
  await db.prepare("UPDATE jams SET status = 'cancelled' WHERE id = ?").bind(j.id).run();
  return { ok: true };
}

/** What anyone may see of an event: the theme only once it starts (or to its host). */
export function publicView(j, viewer, t = now()) {
  const phase = phaseOf(j, t), host = !!viewer && viewer === j.host_id;
  return {
    id: j.id, slug: j.slug, kind: j.kind, title: j.title, description: j.description,
    theme: phase === 'upcoming' && !host ? null : j.theme, theme_hidden: phase === 'upcoming' && !!j.theme && !host,
    criteria: parse(j.criteria, []), new_only: !!j.new_only, starts_at: j.starts_at, ends_at: j.ends_at, voting_ends_at: j.voting_ends_at,
    featured: !!j.featured, host: { id: j.host_id, name: j.host_name || 'Deleted account' }, phase, is_host: host,
  };
}

/** Events for the jams page: running and upcoming first, then the latest finished. */
export async function listJams(db, t = now()) {
  const rows = (await db.prepare(`SELECT j.*, u.name AS host_name, (SELECT COUNT(*) FROM jam_entries e WHERE e.jam_id = j.id) AS entries FROM jams j LEFT JOIN users u ON u.id = j.host_id
      WHERE j.status = 'active' AND COALESCE(j.voting_ends_at, j.ends_at) > ?1 - 60 * 86400000
      ORDER BY j.featured DESC, j.starts_at ASC LIMIT 100`).bind(t).all()).results;
  const view = (j) => ({ ...publicView(j, null, t), entries: j.entries });
  const done = (j) => ['results', 'ended'].includes(phaseOf(j, t));
  return { current: rows.filter((j) => !done(j)).map(view), past: rows.filter(done).sort((a, b) => b.ends_at - a.ends_at).slice(0, 20).map(view) };
}

/** Enters the creator's game. p: the project row. */
export async function submit(db, j, uid, p, t = now()) {
  if (!uid) throw new JamError(401, 'Sign in first.', 'unauthenticated');
  if (!entriesOpen(j, t)) throw new JamError(409, j.kind === 'festival' ? 'This festival has ended.' : 'Entries are not open.', 'closed');
  if (!p || p.owner_id !== uid || p.status === 'removed') throw new JamError(404, 'Enter one of your own games.', 'not_found');
  if (p.hidden_at) throw new JamError(409, 'This game is hidden from the store.', 'hidden');
  if ((Number(p.age) || 0) >= 18) throw new JamError(409, 'Adults-only games cannot be entered.', 'mature');
  const soon = !!p.coming_soon_at && !p.published_at && p.status !== 'live';
  if (!(p.status === 'live' && p.live_version) && !(j.kind === 'festival' && soon)) throw new JamError(409, j.kind === 'festival' ? 'Enter a live game, or one with its coming soon page up.' : 'Publish the game first: voters play the live version.', 'not_live');
  if (j.kind === 'jam' && j.new_only && p.created_at < j.starts_at) throw new JamError(409, 'This jam takes only games made for it: the project has to be created after the jam started.', 'too_old');
  if (await db.prepare('SELECT 1 AS x FROM jam_entries WHERE jam_id = ? AND project_id = ?').bind(j.id, p.id).first()) return { entered: true };
  const mine = (await db.prepare('SELECT COUNT(*) AS n FROM jam_entries WHERE jam_id = ? AND user_id = ?').bind(j.id, uid).first())?.n || 0;
  if (mine >= LIMITS.entries_per_creator) throw new JamError(409, `At most ${LIMITS.entries_per_creator} entries per creator.`, 'too_many');
  await db.prepare('INSERT INTO jam_entries (jam_id, project_id, user_id, version, submitted_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING').bind(j.id, p.id, uid, p.live_version || null, t).run();
  return { entered: true };
}

export async function withdraw(db, j, uid, pid, t = now()) {
  if (!entriesOpen(j, t)) throw new JamError(409, 'Entries can be withdrawn only while they are open.', 'closed');
  const r = await db.prepare('DELETE FROM jam_entries WHERE jam_id = ? AND project_id = ? AND user_id = ?').bind(j.id, pid, uid).run();
  if (!r.meta?.changes) throw new JamError(404, 'No such entry of yours.', 'not_found');
  return { entered: false };
}

/** A voter's scores for one entry: { criterion: 1..5 } covering every criterion. */
export async function vote(db, j, uid, pid, scores, t = now()) {
  if (!uid) throw new JamError(401, 'Sign in to vote.', 'unauthenticated');
  if (j.kind !== 'jam' || phaseOf(j, t) !== 'voting') throw new JamError(409, 'Voting is not open.', 'closed');
  const e = await db.prepare('SELECT e.user_id, p.owner_id FROM jam_entries e JOIN projects p ON p.id = e.project_id WHERE e.jam_id = ? AND e.project_id = ?').bind(j.id, pid).first();
  if (!e) throw new JamError(404, 'No such entry.', 'not_found');
  if (e.user_id === uid || e.owner_id === uid) throw new JamError(403, 'You cannot vote on your own entry.', 'own_entry');
  if (!(await db.prepare("SELECT 1 AS x FROM plays WHERE user_id = ? AND project_id = ? AND env = 'live' LIMIT 1").bind(uid, pid).first())) throw new JamError(403, 'Play the game before you vote on it.', 'not_played');
  const criteria = parse(j.criteria, []), out = {};
  for (const c of criteria) {
    const v = Math.round(Number(scores?.[c]));
    if (!(v >= 1 && v <= 5)) throw new JamError(400, `Score every criterion from 1 to 5 (missing: ${c}).`, 'bad_request');
    out[c] = v;
  }
  await db.batch(criteria.map((c) => db.prepare('INSERT INTO jam_votes (jam_id, project_id, voter_id, criterion, score, at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (jam_id, project_id, voter_id, criterion) DO UPDATE SET score = excluded.score, at = excluded.at')
    .bind(j.id, pid, uid, c, out[c], t)));
  return { ok: true, scores: out };
}

/**
 * The entries with their games. During voting each carries the viewer's own scores and how many voted; after it,
 * the average per criterion, the overall average and the rank (null below min_votes).
 */
export async function entriesOf(db, j, viewer, t = now()) {
  const phase = phaseOf(j, t), criteria = parse(j.criteria, []);
  const rows = (await db.prepare(`SELECT p.*, u.name AS author, e.submitted_at, e.user_id AS entrant,
        (SELECT COUNT(DISTINCT v.voter_id) FROM jam_votes v WHERE v.jam_id = e.jam_id AND v.project_id = e.project_id) AS voters
      FROM jam_entries e JOIN projects p ON p.id = e.project_id JOIN users u ON u.id = p.owner_id
      WHERE e.jam_id = ? AND p.status != 'removed' AND p.hidden_at IS NULL ORDER BY e.submitted_at`).bind(j.id).all()).results;
  const mine = viewer && phase === 'voting' ? (await db.prepare('SELECT project_id, criterion, score FROM jam_votes WHERE jam_id = ? AND voter_id = ?').bind(j.id, viewer).all()).results : [];
  const played = viewer && phase === 'voting' && rows.length ? new Set((await db.prepare(`SELECT DISTINCT project_id FROM plays WHERE user_id = ? AND env = 'live' AND project_id IN (${rows.map(() => '?').join(',')})`).bind(viewer, ...rows.map((r) => r.id)).all()).results.map((r) => r.project_id)) : new Set();
  let avgs = new Map();
  if (phase === 'results') {
    const a = (await db.prepare('SELECT project_id, criterion, AVG(score) AS avg FROM jam_votes WHERE jam_id = ? GROUP BY project_id, criterion').bind(j.id).all()).results;
    for (const r of a) { const m = avgs.get(r.project_id) || {}; m[r.criterion] = Math.round(r.avg * 100) / 100; avgs.set(r.project_id, m); }
  }
  const list = rows.map((r) => {
    const base = { game: r, entrant: r.entrant, submitted_at: r.submitted_at, voters: r.voters, mine: !!viewer && r.entrant === viewer };
    if (phase === 'voting') {
      const s = Object.fromEntries(mine.filter((m) => m.project_id === r.id).map((m) => [m.criterion, m.score]));
      return { ...base, my_scores: Object.keys(s).length ? s : null, played: played.has(r.id) };
    }
    if (phase === 'results') {
      const m = avgs.get(r.id) || {}, vals = criteria.map((c) => m[c]).filter((x) => x != null);
      return { ...base, scores: m, overall: vals.length ? Math.round((vals.reduce((x, y) => x + y, 0) / vals.length) * 100) / 100 : null };
    }
    return base;
  });
  if (phase === 'results') {
    const ranked = list.filter((x) => x.voters >= LIMITS.min_votes && x.overall != null).sort((a, b) => b.overall - a.overall || b.voters - a.voters);
    ranked.forEach((x, i) => { x.rank = i + 1; });
    const rest = list.filter((x) => !ranked.includes(x)).map((x) => ({ ...x, rank: null }));
    return [...ranked, ...rest];
  }
  return list;
}

/** The games of the featured event that is running now, for the store's home shelf (null when none). */
export async function featuredNow(db, t = now(), limit = 12) {
  const j = await db.prepare(`SELECT j.*, u.name AS host_name FROM jams j LEFT JOIN users u ON u.id = j.host_id WHERE j.status = 'active' AND j.featured = 1 AND j.starts_at <= ?1
      AND COALESCE(j.voting_ends_at, j.ends_at) > ?1 ORDER BY j.starts_at DESC LIMIT 1`).bind(t).first();
  if (!j) return null;
  const games = (await db.prepare(`SELECT p.*, u.name AS author FROM jam_entries e JOIN projects p ON p.id = e.project_id JOIN users u ON u.id = p.owner_id
      WHERE e.jam_id = ? AND p.status != 'removed' AND p.hidden_at IS NULL AND COALESCE(p.age, 0) < 18 ORDER BY p.plays DESC LIMIT ?`).bind(j.id, limit).all()).results;
  return { jam: publicView(j, null, t), games };
}

/**
 * Tells entrants when a jam's voting opens and when its results are out, once each (for the scheduled job). Returns
 * the notifications written.
 */
export async function phaseNotices(db, t = now()) {
  const due = (await db.prepare(`SELECT * FROM jams WHERE status = 'active' AND kind = 'jam' AND ends_at <= ?1 AND voting_ends_at > ?1 - 2 * 86400000
      AND (noticed NOT LIKE '%voting%' OR (voting_ends_at <= ?1 AND noticed NOT LIKE '%results%')) LIMIT 20`).bind(t).all()).results;
  let n = 0;
  for (const j of due) {
    const phase = phaseOf(j, t), kind = phase === 'results' ? 'jam_results' : 'jam_voting';
    const r = await db.prepare(`INSERT INTO notifications (user_id, kind, actor_id, data, created_at)
        SELECT e.user_id, ?1, ?2, json_object('project', e.project_id, 'jam', ?3, 'jam_title', ?4), ?5 FROM jam_entries e JOIN users u ON u.id = e.user_id AND u.status = 'active' WHERE e.jam_id = ?6`)
      .bind(kind, j.host_id, j.slug, j.title, t, j.id).run();
    n += r.meta?.changes || 0;
    await db.prepare('UPDATE jams SET noticed = ? WHERE id = ?').bind(phase === 'results' ? 'voting,results' : 'voting', j.id).run();
  }
  return n;
}

/** The creator's games that could go into this event now (for the entry picker). */
export async function eligibleGames(db, j, uid) {
  const rows = (await db.prepare(`SELECT id, slug, title, status, live_version, coming_soon_at, published_at, created_at, age, hidden_at FROM projects WHERE owner_id = ? AND status != 'removed' AND hidden_at IS NULL
      AND id NOT IN (SELECT project_id FROM jam_entries WHERE jam_id = ?) ORDER BY updated_at DESC LIMIT 50`).bind(uid, j.id).all()).results;
  return rows.filter((p) => (Number(p.age) || 0) < 18 && ((p.status === 'live' && p.live_version) || (j.kind === 'festival' && p.coming_soon_at && !p.published_at))
    && !(j.kind === 'jam' && j.new_only && p.created_at < j.starts_at)).map((p) => ({ id: p.id, slug: p.slug, title: p.title }));
}
