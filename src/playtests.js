// Playtests: a creator opens the preview version to real players through an invite link, asks a few questions after,
// and reads how each tester played and what they said. Plain JS over a D1-shaped database (tests/playtests.mjs).
//
// Rules, enforced here and nowhere else:
//   - Only a game with a verified preview can open a playtest, and at most one is open per game at a time.
//   - The link is the invitation: anyone signed in who has it may join while it is open and has seats, never the game's
//     owner (they play the preview in the console). A tester plays the preview the creator has deployed at that moment.
//   - Testers' play is preview play: it never counts toward the live game. Creators see each tester's sessions, minutes
//     and tracked events by display name, because a tester joined to be heard; answers are tied to the tester too.
//   - A playtest closes by itself after its days run out, and a closed one takes no new testers or answers.

export const LIMITS = { title: 80, note: 600, questions: 5, question: 160, answer: 800, seats_max: 500, days_max: 30 };

export class PlaytestError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code; }
}
const now = () => Date.now();
const DAY = 86400_000;
const parse = (s, d) => { try { const v = JSON.parse(s); return v ?? d; } catch { return d; } };
const line = (s, max) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const text = (s, max) => String(s ?? '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').replace(/\n{3,}/g, '\n\n').trim().slice(0, max);
const code = () => { const a = 'abcdefghjkmnpqrstuvwxyz23456789', b = crypto.getRandomValues(new Uint8Array(10)); return [...b].map((x) => a[x % a.length]).join(''); };
const id = () => 'pt_' + code();

/** The creator's input: { title, note?, questions?, seats?, days? } → cleaned, or a PlaytestError. */
export function cleanSetup(raw = {}) {
  const title = line(raw.title, LIMITS.title);
  if (!title) throw new PlaytestError(400, 'Give the playtest a title, such as "Level 2 balance".', 'bad_request');
  const qs = (Array.isArray(raw.questions) ? raw.questions : []).map((q) => line(q, LIMITS.question)).filter(Boolean);
  if (qs.length > LIMITS.questions) throw new PlaytestError(400, `Ask at most ${LIMITS.questions} questions.`, 'bad_request');
  const seats = Math.round(Number(raw.seats ?? 50)), days = Math.round(Number(raw.days ?? 7));
  if (!(seats >= 1 && seats <= LIMITS.seats_max)) throw new PlaytestError(400, `seats must be 1 to ${LIMITS.seats_max}.`, 'bad_request');
  if (!(days >= 1 && days <= LIMITS.days_max)) throw new PlaytestError(400, `days must be 1 to ${LIMITS.days_max}.`, 'bad_request');
  return { title, note: text(raw.note, LIMITS.note) || null, questions: qs, seats, days };
}

const isOpen = (pt, t = now()) => pt && pt.status === 'open' && pt.closes_at > t;

/** Opens a playtest on the game's preview. p: { id, preview_version }. Returns the playtest row. */
export async function openPlaytest(db, p, raw, t = now()) {
  const s = cleanSetup(raw);
  if (!p.preview_version) throw new PlaytestError(409, 'Deploy a preview first: testers play the preview version.', 'no_preview');
  const v = await db.prepare('SELECT status FROM versions WHERE project_id = ? AND n = ?').bind(p.id, p.preview_version).first();
  if (!v || v.status !== 'verified') throw new PlaytestError(409, 'The preview has to pass verification before real players test it.', 'not_verified');
  await closeExpired(db, p.id, t);
  if (await db.prepare("SELECT 1 AS x FROM playtests WHERE project_id = ? AND status = 'open'").bind(p.id).first()) throw new PlaytestError(409, 'This game already has an open playtest. Close it first.', 'already_open');
  const row = { id: id(), project_id: p.id, version: p.preview_version, code: code(), title: s.title, note: s.note, questions: JSON.stringify(s.questions), seats: s.seats, status: 'open', created_at: t, closes_at: t + s.days * DAY };
  await db.prepare('INSERT INTO playtests (id, project_id, version, code, title, note, questions, seats, status, created_at, closes_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(row.id, row.project_id, row.version, row.code, row.title, row.note, row.questions, row.seats, row.status, row.created_at, row.closes_at).run();
  return row;
}

export async function closeExpired(db, pid, t = now()) {
  await db.prepare("UPDATE playtests SET status = 'closed', closed_at = closes_at WHERE project_id = ? AND status = 'open' AND closes_at <= ?").bind(pid, t).run();
}

export async function closePlaytest(db, pid, ptId, t = now()) {
  const r = await db.prepare("UPDATE playtests SET status = 'closed', closed_at = ? WHERE id = ? AND project_id = ? AND status = 'open'").bind(t, ptId, pid).run();
  if (!r.meta?.changes) throw new PlaytestError(404, 'No open playtest with that id.', 'not_found');
  return { ok: true };
}

/** A playtest by its invite code, with its game. */
export async function byCode(db, c) {
  if (!/^[a-z0-9]{6,20}$/.test(String(c || ''))) return null;
  return db.prepare(`SELECT t.*, p.slug, p.title AS game_title, p.tagline, p.cover_key, p.owner_id, p.preview_version, p.status AS game_status, u.name AS author
      FROM playtests t JOIN projects p ON p.id = t.project_id JOIN users u ON u.id = p.owner_id WHERE t.code = ? AND p.status != 'removed'`).bind(c).first();
}

/** What a visitor of the invite link sees: the playtest, and their own place in it. */
export async function inviteView(db, pt, uid, t = now()) {
  const [count, me] = await Promise.all([
    db.prepare('SELECT COUNT(*) AS n FROM playtest_testers WHERE playtest_id = ?').bind(pt.id).first(),
    uid ? db.prepare('SELECT joined_at, answered_at, fun, answers FROM playtest_testers WHERE playtest_id = ? AND user_id = ?').bind(pt.id, uid).first() : null,
  ]);
  const testers = count?.n || 0;
  return {
    title: pt.title, note: pt.note, questions: parse(pt.questions, []), closes_at: pt.closes_at,
    open: isOpen(pt, t), full: testers >= pt.seats, owner: !!uid && uid === pt.owner_id,
    game: { slug: pt.slug, title: pt.game_title, tagline: pt.tagline, author: pt.author },
    joined: !!me, answered: !!me?.answered_at, mine: me?.answered_at ? { fun: me.fun, answers: parse(me.answers, []) } : null,
  };
}

/** Joins a tester. Idempotent for someone already in. */
export async function join(db, pt, uid, t = now()) {
  if (!uid) throw new PlaytestError(401, 'Sign in to join the playtest.', 'unauthenticated');
  if (uid === pt.owner_id) throw new PlaytestError(409, 'This is your own game: play its preview in the console.', 'owner');
  if (await db.prepare('SELECT 1 AS x FROM playtest_testers WHERE playtest_id = ? AND user_id = ?').bind(pt.id, uid).first()) return { joined: true };
  if (!isOpen(pt, t)) throw new PlaytestError(410, 'This playtest has closed.', 'closed');
  // one statement: the seat is taken only while there is one, so a crowd arriving at once cannot overfill it
  const r = await db.prepare('INSERT INTO playtest_testers (playtest_id, user_id, joined_at) SELECT ?1, ?2, ?3 WHERE (SELECT COUNT(*) FROM playtest_testers WHERE playtest_id = ?1) < ?4 ON CONFLICT DO NOTHING').bind(pt.id, uid, t, pt.seats).run();
  if (!r.meta?.changes) throw new PlaytestError(409, 'This playtest is full.', 'full');
  return { joined: true };
}

/** Whether this account may start a session of the playtest's game now. */
export async function canPlay(db, pt, uid, t = now()) {
  if (!uid || !isOpen(pt, t) || !pt.preview_version) return false;
  return !!(await db.prepare('SELECT 1 AS x FROM playtest_testers WHERE playtest_id = ? AND user_id = ?').bind(pt.id, uid).first());
}

/** A tester's answers: fun 1 to 5 and one answer per question. Can be changed while the playtest is open. */
export async function answer(db, pt, uid, raw, t = now()) {
  if (!isOpen(pt, t)) throw new PlaytestError(410, 'This playtest has closed.', 'closed');
  const fun = Math.round(Number(raw?.fun));
  if (!(fun >= 1 && fun <= 5)) throw new PlaytestError(400, 'fun must be 1 to 5.', 'bad_request');
  const qs = parse(pt.questions, []);
  const answers = qs.map((_, i) => text(Array.isArray(raw?.answers) ? raw.answers[i] : '', LIMITS.answer));
  const r = await db.prepare('UPDATE playtest_testers SET fun = ?, answers = ?, answered_at = ? WHERE playtest_id = ? AND user_id = ?').bind(fun, JSON.stringify(answers), t, pt.id, uid).run();
  if (!r.meta?.changes) throw new PlaytestError(403, 'Join the playtest first.', 'not_joined');
  return { ok: true };
}

/**
 * The creator's results: per tester their sessions on the preview since the playtest opened (count, minutes, longest,
 * last), the events they tracked there, and their answers; plus the totals. The preview's own events table is shared with
 * the creator's own testing, so events are counted for testers only.
 */
export async function results(db, pt) {
  const [testers, plays, events] = await Promise.all([
    db.prepare('SELECT t.user_id, u.name, t.joined_at, t.answered_at, t.fun, t.answers FROM playtest_testers t JOIN users u ON u.id = t.user_id WHERE t.playtest_id = ? ORDER BY t.joined_at').bind(pt.id).all(),
    db.prepare(`SELECT p.user_id, COUNT(*) AS sessions, COALESCE(SUM(p.seconds), 0) AS seconds, COALESCE(MAX(p.seconds), 0) AS longest, MAX(p.started_at) AS last_at
        FROM plays p JOIN playtest_testers t ON t.user_id = p.user_id AND t.playtest_id = ?1
        WHERE p.project_id = ?2 AND p.env = 'preview' AND p.started_at >= ?3 AND p.started_at <= COALESCE(?4, p.started_at) GROUP BY p.user_id`).bind(pt.id, pt.project_id, pt.created_at, pt.closed_at || null).all(),
    db.prepare(`SELECT e.user_id, e.name, e.count, e.first_at FROM event_players e JOIN playtest_testers t ON t.user_id = e.user_id AND t.playtest_id = ?1
        WHERE e.project_id = ?2 ORDER BY e.first_at`).bind(pt.id, pt.project_id + ':preview').all(),
  ]);
  const byUser = new Map(plays.results.map((r) => [r.user_id, r]));
  const evs = new Map();
  for (const e of events.results) { const l = evs.get(e.user_id) || []; l.push({ name: e.name, count: e.count, first_at: e.first_at }); evs.set(e.user_id, l); }
  const qs = parse(pt.questions, []);
  const list = testers.results.map((r) => {
    const p = byUser.get(r.user_id);
    return { name: r.name, joined_at: r.joined_at, answered_at: r.answered_at, fun: r.fun, answers: r.answers ? parse(r.answers, []) : null,
      sessions: p?.sessions || 0, minutes: Math.round((p?.seconds || 0) / 6) / 10, longest_minutes: Math.round((p?.longest || 0) / 6) / 10, last_played: p?.last_at || null, events: evs.get(r.user_id) || [] };
  });
  const played = list.filter((x) => x.sessions), funs = list.filter((x) => x.fun).map((x) => x.fun);
  const mins = played.map((x) => x.minutes).sort((a, b) => a - b);
  // how many testers reached each tracked event, in the order testers first reached them
  const reach = new Map();
  for (const x of list) for (const e of x.events) reach.set(e.name, (reach.get(e.name) || 0) + 1);
  return {
    playtest: { id: pt.id, title: pt.title, note: pt.note, questions: qs, version: pt.version, seats: pt.seats, status: isOpen(pt) ? 'open' : 'closed', created_at: pt.created_at, closes_at: pt.closes_at, closed_at: pt.closed_at || null },
    totals: { testers: list.length, played: played.length, answered: funs.length, fun_average: funs.length ? Math.round((funs.reduce((a, b) => a + b, 0) / funs.length) * 10) / 10 : null, median_minutes: mins.length ? mins[Math.floor(mins.length / 2)] : 0 },
    events: [...reach].map(([name, testers]) => ({ name, testers })),
    testers: list,
  };
}

/** The game's playtests, newest first, with their tester counts. */
export async function listPlaytests(db, pid, t = now()) {
  await closeExpired(db, pid, t);
  return (await db.prepare('SELECT t.id, t.code, t.title, t.version, t.seats, t.status, t.created_at, t.closes_at, t.closed_at, (SELECT COUNT(*) FROM playtest_testers x WHERE x.playtest_id = t.id) AS testers, (SELECT COUNT(*) FROM playtest_testers x WHERE x.playtest_id = t.id AND x.answered_at IS NOT NULL) AS answered FROM playtests t WHERE t.project_id = ? ORDER BY t.created_at DESC LIMIT 20').bind(pid).all()).results;
}
