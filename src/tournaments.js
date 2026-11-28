// Tournaments on top of matchmaking: timed cups and single-elimination brackets, run by a game's creator for their game
// or by the platform (official). Plain JS over a D1-shaped database (tests/tournaments.mjs). The match route
// (src/routes/rt.ts) asks pairingFor() when a player searches, and reports every rated result to recordMatch(); the
// ten-minute cron calls tick() to start tournaments, close rounds and finish them.
//
// Rules, enforced here and nowhere else:
//   - The game is live and ships server-run matches (the route checks that); the tournament runs on one of its queues.
//     Starts 5 minutes to 60 days ahead. A cup scores for 1 hour to 30 days; a bracket gives each round 15 minutes to a
//     day. Up to 5 tournaments per game that have not finished. Only admins make official ones.
//   - Signed-in players sign up (guests cannot), up to the limit. A bracket closes sign-up when it starts; a cup takes
//     players until it ends. A player leaves only before it starts.
//   - Cup: from start to end, every rated match in the cup's queue scores for each signed-up player in it: 1 point for
//     playing, 3 more for winning. Most points wins; ties go to more wins, then to who signed up first.
//   - Bracket: seeded by rating in that queue when it starts (1 is the strongest), padded with byes to a power of two.
//     During a round, a player's search in the queue meets only their opponent. The match's ranking decides it. When the
//     round's time runs out, an undecided pair goes to the one who searched for it, else to the better seed.
//     Fewer than 2 players: cancelled.

export const LIMITS = { title: 80, description: 1000, prize: 200, open_per_game: 5, lead_min_ms: 5 * 60 * 1000, lead_max_ms: 60 * 86400000, cup_min_ms: 3600000, cup_max_ms: 30 * 86400000, round_min: 15, round_max: 1440, bracket_max: 128, cup_max_players: 10000 };

export class TournamentError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code; }
}
const now = () => Date.now();
const err = (s, c, m) => new TournamentError(s, m, c);
const clean = (v, n) => String(v ?? '').replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '').trim().slice(0, n);
const rid = () => 'tmt_' + [...crypto.getRandomValues(new Uint8Array(10))].map((b) => b.toString(36).padStart(2, '0')).join('').slice(0, 16);
const slugify = (s) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'tournament';
const int = (v) => (Number.isFinite(+v) ? Math.floor(+v) : NaN);

async function byKey(db, key) {
  return db.prepare('SELECT * FROM tournaments WHERE id = ? OR slug = ?').bind(key, key).first();
}

/** A new tournament for a game. actor: { id, admin }. p: the game row (id, owner_id, status). */
export async function create(db, actor, p, raw = {}, t = now()) {
  if (!actor?.id) throw err(401, 'unauthenticated', 'Sign in first.');
  if (!p || p.status !== 'live') throw err(409, 'not_live', 'Tournaments run on live games.');
  if (p.owner_id !== actor.id && !actor.admin) throw err(403, 'forbidden', 'Only the game\'s creator or an admin can run a tournament for it.');
  const title = clean(raw.title, LIMITS.title);
  if (title.length < 3) throw err(400, 'bad_request', 'A tournament needs a title of at least 3 characters.');
  const kind = raw.kind === 'bracket' ? 'bracket' : raw.kind === 'cup' ? 'cup' : null;
  if (!kind) throw err(400, 'bad_request', 'kind is cup or bracket.');
  const queue = String(raw.queue || 'default');
  if (!/^[a-z0-9_-]{1,32}$/.test(queue)) throw err(400, 'bad_request', 'queue must be 1 to 32 characters: a-z, 0-9, _ or -.');
  const starts = int(raw.starts_at);
  if (!(starts >= t + LIMITS.lead_min_ms && starts <= t + LIMITS.lead_max_ms)) throw err(400, 'bad_start', 'Start it 5 minutes to 60 days from now.');
  let ends = null, round = 60;
  if (kind === 'cup') {
    ends = int(raw.ends_at);
    if (!(ends - starts >= LIMITS.cup_min_ms && ends - starts <= LIMITS.cup_max_ms)) throw err(400, 'bad_end', 'A cup runs for 1 hour to 30 days.');
  } else {
    round = int(raw.round_minutes ?? 60);
    if (!(round >= LIMITS.round_min && round <= LIMITS.round_max)) throw err(400, 'bad_round', 'Give each round 15 to 1440 minutes.');
  }
  const cap = kind === 'bracket' ? LIMITS.bracket_max : LIMITS.cup_max_players;
  const max = raw.max_players == null ? (kind === 'bracket' ? 32 : 1000) : int(raw.max_players);
  if (!(max >= 2 && max <= cap)) throw err(400, 'bad_max', `Allow 2 to ${cap} players.`);
  const open = (await db.prepare("SELECT COUNT(*) AS n FROM tournaments WHERE project_id = ? AND status IN ('signup', 'running')").bind(p.id).first())?.n || 0;
  if (open >= LIMITS.open_per_game) throw err(409, 'too_many', `A game can have at most ${LIMITS.open_per_game} tournaments that have not finished.`);
  let slug = slugify(title);
  while (await db.prepare('SELECT 1 AS x FROM tournaments WHERE slug = ?').bind(slug).first()) slug = `${slugify(title).slice(0, 44)}-${Math.random().toString(36).slice(2, 7)}`;
  const id = rid();
  await db.prepare(`INSERT INTO tournaments (id, slug, project_id, title, description, prize, kind, queue, starts_at, ends_at, round_minutes, max_players, official, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(id, slug, p.id, title, clean(raw.description, LIMITS.description) || null, clean(raw.prize, LIMITS.prize) || null,
    kind, queue, starts, ends, round, max, actor.admin && raw.official ? 1 : 0, actor.id, t, t).run();
  return { id, slug };
}

/** Cancels a tournament that has not finished (its creator, the game's creator or an admin). */
export async function cancel(db, actor, key, t = now()) {
  const tm = await byKey(db, key);
  if (!tm) throw err(404, 'not_found', 'No such tournament.');
  const owner = await db.prepare('SELECT owner_id FROM projects WHERE id = ?').bind(tm.project_id).first();
  if (!actor?.admin && actor?.id !== tm.created_by && actor?.id !== owner?.owner_id) throw err(403, 'forbidden', 'Only its organizer or an admin can cancel it.');
  if (tm.official && !actor?.admin) throw err(403, 'forbidden', 'Only an admin can cancel an official tournament.');
  if (tm.status === 'done' || tm.status === 'cancelled') throw err(409, 'finished', 'It has already finished.');
  await db.prepare("UPDATE tournaments SET status = 'cancelled', updated_at = ? WHERE id = ?").bind(t, tm.id).run();
  return { ok: true };
}

/** Signs a player up. */
export async function join(db, uid, key, t = now()) {
  if (!uid) throw err(401, 'unauthenticated', 'Sign in to take part.');
  const tm = await byKey(db, key);
  if (!tm || tm.status === 'cancelled') throw err(404, 'not_found', 'No such tournament.');
  const open = tm.kind === 'cup' ? (tm.status === 'signup' || tm.status === 'running') && t < tm.ends_at : tm.status === 'signup' && t < tm.starts_at;
  if (!open) throw err(409, 'closed', 'Sign-up for this tournament is closed.');
  const n = (await db.prepare('SELECT COUNT(*) AS n FROM tournament_players WHERE tournament_id = ?').bind(tm.id).first())?.n || 0;
  if (n >= tm.max_players) throw err(409, 'full', 'This tournament is full.');
  await db.prepare('INSERT OR IGNORE INTO tournament_players (tournament_id, user_id, joined_at) VALUES (?, ?, ?)').bind(tm.id, uid, t).run();
  return { joined: true };
}
/** Leaves before it starts. */
export async function leave(db, uid, key, t = now()) {
  const tm = await byKey(db, key);
  if (!tm) throw err(404, 'not_found', 'No such tournament.');
  if (tm.status !== 'signup' || t >= tm.starts_at) throw err(409, 'started', 'You cannot leave once it has started.');
  await db.prepare('DELETE FROM tournament_players WHERE tournament_id = ? AND user_id = ?').bind(tm.id, uid).run();
  return { left: true };
}

const card = (r) => ({ id: r.id, slug: r.slug, title: r.title, kind: r.kind, queue: r.queue, status: r.status, starts_at: r.starts_at, ends_at: r.ends_at, round: r.round, round_ends_at: r.round_ends_at,
  round_minutes: r.round_minutes, max_players: r.max_players, players: r.players ?? 0, prize: r.prize, official: !!r.official,
  game: r.game_slug ? { id: r.project_id, slug: r.game_slug, title: r.game_title, cover_key: r.cover_key || null } : undefined, winner: r.winner_name ? { id: r.winner_id, name: r.winner_name } : null });
const LIST = `SELECT t.*, p.slug AS game_slug, p.title AS game_title, p.cover_key, w.name AS winner_name,
  (SELECT COUNT(*) FROM tournament_players x WHERE x.tournament_id = t.id) AS players
  FROM tournaments t JOIN projects p ON p.id = t.project_id LEFT JOIN users w ON w.id = t.winner_id`;

/** Tournaments to show: upcoming and running first, then recently finished. game: one game's id; organizer: theirs.
 * @param {any} db @param {{ game?: string|null, organizer?: string|null, all?: boolean }} [o] @param {number} [t] @returns {Promise<any[]>} */
export async function list(db, { game = null, organizer = null, all = false } = {}, t = now()) {
  const where = [], args = [];
  if (game) { where.push('t.project_id = ?'); args.push(game); }
  if (organizer) { where.push('(t.created_by = ? OR p.owner_id = ?)'); args.push(organizer, organizer); }
  if (!all) { where.push("(t.status IN ('signup', 'running') OR (t.status = 'done' AND t.updated_at > ?))"); args.push(t - 30 * 86400000); }
  if (!organizer && !all) where.push("p.status = 'live' AND p.hidden_at IS NULL");
  const rows = (await db.prepare(`${LIST} ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY CASE t.status WHEN 'running' THEN 0 WHEN 'signup' THEN 1 WHEN 'done' THEN 2 ELSE 3 END, t.official DESC, t.starts_at LIMIT 100`).bind(...args).all()).results || [];
  return rows.map(card);
}

/** One tournament as its page shows it: the standings (cup) or the bracket, and the viewer's place in it.
 * @param {any} db @param {string} key @param {string|null} [me] @param {number} [t] @returns {Promise<any>} */
export async function view(db, key, me = null, t = now()) {
  const r = await db.prepare(`${LIST} WHERE t.id = ? OR t.slug = ?`).bind(key, key).first();
  if (!r) return null;
  const out = { ...card(r), description: r.description, created_by: r.created_by, organizer: r.official ? 'platform' : 'creator' };
  const mine = me ? await db.prepare('SELECT * FROM tournament_players WHERE tournament_id = ? AND user_id = ?').bind(r.id, me).first() : null;
  out.me = mine ? { joined: true, points: mine.points, wins: mine.wins, played: mine.played, seed: mine.seed, out_round: mine.out_round } : { joined: false };
  if (r.kind === 'cup') {
    const rows = (await db.prepare(`SELECT x.user_id, COALESCE(u.name, 'Player') AS name, x.points, x.wins, x.played FROM tournament_players x LEFT JOIN users u ON u.id = x.user_id
      WHERE x.tournament_id = ? ORDER BY x.points DESC, x.wins DESC, x.joined_at LIMIT 100`).bind(r.id).all()).results || [];
    out.standings = rows.map((x, i) => ({ rank: i + 1, id: x.user_id, name: x.name, points: x.points, wins: x.wins, played: x.played, me: x.user_id === me }));
  } else {
    const names = new Map(((await db.prepare(`SELECT x.user_id, COALESCE(u.name, 'Player') AS name, x.seed FROM tournament_players x LEFT JOIN users u ON u.id = x.user_id WHERE x.tournament_id = ?`).bind(r.id).all()).results || []).map((x) => [x.user_id, x]));
    const ms = (await db.prepare('SELECT * FROM tournament_matches WHERE tournament_id = ? ORDER BY round, slot').bind(r.id).all()).results || [];
    const who = (id) => (id ? { id, name: names.get(id)?.name || 'Player', seed: names.get(id)?.seed ?? null } : null);
    const rounds = [];
    for (const m of ms) { (rounds[m.round - 1] ||= []).push({ slot: m.slot, a: who(m.a), b: who(m.b), winner: m.winner, decided_by: m.decided_by }); }
    out.rounds = rounds;
    out.entrants = r.status === 'signup' ? [...names.values()].slice(0, 200).map((x) => ({ id: x.user_id, name: x.name })) : undefined;
    if (me && r.status === 'running') {
      const m = ms.find((x) => x.round === r.round && !x.winner && (x.a === me || x.b === me));
      if (m) out.me.next = { round: m.round, opponent: who(m.a === me ? m.b : m.a), ends_at: r.round_ends_at };
    }
  }
  return out;
}

// ---- running them -------------------------------------------------------------------------------------------------------
/** Seed positions for a bracket of `size` (a power of two): 1 meets size, 2 meets size-1, and the best two meet last. */
export function seedOrder(size) {
  let order = [1];
  while (order.length < size) { const n = order.length * 2 + 1; order = order.flatMap((s) => [s, n - s]); }
  return order;
}
async function notifyMatch(db, tm, ids, t) {
  for (const uid of ids.filter(Boolean)) await db.prepare("INSERT INTO notifications (user_id, kind, actor_id, data, created_at) VALUES (?, 'tournament_match', ?, json_object('tournament', ?, 'title', ?, 'round', ?), ?)").bind(uid, tm.created_by, tm.slug, tm.title, tm.round, t).run();
}
async function startBracket(db, tm, t) {
  const players = ((await db.prepare(`SELECT x.user_id, COALESCE(r.rating, 1000) AS rating FROM tournament_players x
    LEFT JOIN match_ratings r ON r.project_id = ? AND r.env = 'live' AND r.queue = ? AND r.user_id = x.user_id
    WHERE x.tournament_id = ? ORDER BY rating DESC, x.joined_at`).bind(tm.project_id, tm.queue, tm.id).all()).results || []).map((x) => x.user_id);
  if (players.length < 2) { await db.prepare("UPDATE tournaments SET status = 'cancelled', updated_at = ? WHERE id = ?").bind(t, tm.id).run(); return; }
  let size = 2; while (size < players.length) size *= 2;
  const order = seedOrder(size), stmts = players.map((u, i) => db.prepare('UPDATE tournament_players SET seed = ? WHERE tournament_id = ? AND user_id = ?').bind(i + 1, tm.id, u));
  for (let s = 0; s < size / 2; s++) {
    const a = players[order[2 * s] - 1] || null, b = players[order[2 * s + 1] - 1] || null, bye = !a || !b;
    stmts.push(db.prepare('INSERT INTO tournament_matches (tournament_id, round, slot, a, b, winner, decided_by, decided_at) VALUES (?, 1, ?, ?, ?, ?, ?, ?)')
      .bind(tm.id, s, a, b, bye ? a || b : null, bye ? 'bye' : null, bye ? t : null));
  }
  stmts.push(db.prepare("UPDATE tournaments SET status = 'running', round = 1, round_ends_at = ?, updated_at = ? WHERE id = ?").bind(t + tm.round_minutes * 60000, t, tm.id));
  await db.batch(stmts);
  tm.round = 1;
  const real = ((await db.prepare('SELECT a, b FROM tournament_matches WHERE tournament_id = ? AND round = 1 AND winner IS NULL').bind(tm.id).all()).results || []).flatMap((m) => [m.a, m.b]);
  await notifyMatch(db, tm, real, t);
  await advance(db, tm.id, t);
}
/** When every match of the round is decided: the next round (or the winner). */
async function advance(db, tid, t) {
  const tm = await db.prepare('SELECT * FROM tournaments WHERE id = ?').bind(tid).first();
  if (!tm || tm.status !== 'running' || tm.kind !== 'bracket') return;
  const ms = (await db.prepare('SELECT * FROM tournament_matches WHERE tournament_id = ? AND round = ? ORDER BY slot').bind(tid, tm.round).all()).results || [];
  if (!ms.length || ms.some((m) => !m.winner)) return;
  if (ms.length === 1) { await db.prepare("UPDATE tournaments SET status = 'done', winner_id = ?, updated_at = ? WHERE id = ?").bind(ms[0].winner, t, tid).run(); return; }
  const next = tm.round + 1, stmts = [];
  for (let s = 0; s < ms.length / 2; s++) {
    const a = ms[2 * s].winner, b = ms[2 * s + 1].winner;
    stmts.push(db.prepare('INSERT OR IGNORE INTO tournament_matches (tournament_id, round, slot, a, b) VALUES (?, ?, ?, ?, ?)').bind(tid, next, s, a, b));
  }
  stmts.push(db.prepare('UPDATE tournaments SET round = ?, round_ends_at = ?, updated_at = ? WHERE id = ?').bind(next, t + tm.round_minutes * 60000, t, tid));
  await db.batch(stmts);
  await notifyMatch(db, { ...tm, round: next }, ms.map((m) => m.winner), t);
}
async function decide(db, tid, m, winner, by, t) {
  const loser = winner === m.a ? m.b : m.a;
  const r = await db.prepare('UPDATE tournament_matches SET winner = ?, decided_by = ?, decided_at = ?, match_id = COALESCE(?, match_id) WHERE tournament_id = ? AND round = ? AND slot = ? AND winner IS NULL')
    .bind(winner, by.kind, t, by.match || null, tid, m.round, m.slot).run();
  if (!r.meta?.changes) return false;
  if (loser) await db.prepare('UPDATE tournament_players SET out_round = ? WHERE tournament_id = ? AND user_id = ?').bind(m.round, tid, loser).run();
  await db.prepare('UPDATE tournament_players SET played = played + ?, wins = wins + ? WHERE tournament_id = ? AND user_id = ?').bind(by.kind === 'match' ? 1 : 0, by.kind === 'match' ? 1 : 0, tid, winner).run();
  if (loser && by.kind === 'match') await db.prepare('UPDATE tournament_players SET played = played + 1 WHERE tournament_id = ? AND user_id = ?').bind(tid, loser).run();
  return true;
}

/** Starts what is due, closes rounds whose time ran out and finishes cups. Safe to call often. Returns what it did. */
export async function tick(db, t = now()) {
  const did = { started: 0, rounds: 0, finished: 0 };
  const due = (await db.prepare("SELECT * FROM tournaments WHERE (status = 'signup' AND starts_at <= ?1) OR (status = 'running' AND ((kind = 'cup' AND ends_at <= ?1) OR (kind = 'bracket' AND round_ends_at <= ?1))) LIMIT 50").bind(t).all()).results || [];
  for (const tm of due) {
    if (tm.status === 'signup') {
      did.started++;
      if (tm.kind === 'cup') await db.prepare("UPDATE tournaments SET status = 'running', updated_at = ? WHERE id = ?").bind(t, tm.id).run();
      else await startBracket(db, tm, t);
      continue;
    }
    if (tm.kind === 'cup') {
      const top = await db.prepare('SELECT user_id FROM tournament_players WHERE tournament_id = ? AND played > 0 ORDER BY points DESC, wins DESC, joined_at LIMIT 1').bind(tm.id).first();
      await db.prepare("UPDATE tournaments SET status = 'done', winner_id = ?, updated_at = ? WHERE id = ?").bind(top?.user_id || null, t, tm.id).run();
      did.finished++; continue;
    }
    // a bracket round ran out: whoever showed up, else the better seed
    did.rounds++;
    const seeds = new Map(((await db.prepare('SELECT user_id, seed FROM tournament_players WHERE tournament_id = ?').bind(tm.id).all()).results || []).map((x) => [x.user_id, x.seed ?? 9999]));
    const open = (await db.prepare('SELECT * FROM tournament_matches WHERE tournament_id = ? AND round = ? AND winner IS NULL').bind(tm.id, tm.round).all()).results || [];
    for (const m of open) {
      const w = m.a_ready && !m.b_ready ? m.a : m.b_ready && !m.a_ready ? m.b : (seeds.get(m.a) ?? 9999) <= (seeds.get(m.b) ?? 9999) ? m.a : m.b;
      await decide(db, tm.id, m, w, { kind: m.a_ready && m.b_ready ? 'seed' : m.a_ready || m.b_ready ? 'no_show' : 'seed' }, t);
    }
    await advance(db, tm.id, t);
    const after = await db.prepare('SELECT status FROM tournaments WHERE id = ?').bind(tm.id).first();
    if (after?.status === 'done') did.finished++;
  }
  return did;
}

/** A player searches in a game's queue: when they have a bracket match to play now, the private room it is played in. */
export async function pairingFor(db, projectId, queue, uid, t = now()) {
  const m = await db.prepare(`SELECT m.*, t.id AS tid FROM tournament_matches m JOIN tournaments t ON t.id = m.tournament_id AND m.round = t.round
    WHERE t.project_id = ? AND t.queue = ? AND t.kind = 'bracket' AND t.status = 'running' AND t.round_ends_at > ? AND m.winner IS NULL AND (m.a = ? OR m.b = ?) AND m.a IS NOT NULL AND m.b IS NOT NULL
    ORDER BY t.round_ends_at LIMIT 1`).bind(projectId, queue, t, uid, uid).first();
  if (!m) return null;
  await db.prepare(`UPDATE tournament_matches SET ${m.a === uid ? 'a_ready' : 'b_ready'} = COALESCE(${m.a === uid ? 'a_ready' : 'b_ready'}, ?) WHERE tournament_id = ? AND round = ? AND slot = ?`).bind(t, m.tid, m.round, m.slot).run();
  return { room: `${m.tid}:${m.round}:${m.slot}`, tournament: m.tid, opponent: m.a === uid ? m.b : m.a };
}

/** A rated match ended (ranking: [[winner ids], [next], ...], ids only of real players). Scores cups and decides brackets. */
export async function recordMatch(db, projectId, queue, ranking, matchId, t = now()) {
  const ids = ranking.flat(), first = new Set(ranking[0] || []);
  if (ids.length < 2) return { cups: 0, brackets: 0 };
  const done = { cups: 0, brackets: 0 };
  const cups = (await db.prepare("SELECT id FROM tournaments WHERE project_id = ? AND queue = ? AND kind = 'cup' AND status = 'running' AND starts_at <= ? AND ends_at > ?").bind(projectId, queue, t, t).all()).results || [];
  for (const c of cups) {
    for (const u of ids) {
      const win = first.has(u) ? 1 : 0;
      const r = await db.prepare('UPDATE tournament_players SET played = played + 1, wins = wins + ?, points = points + 1 + ? WHERE tournament_id = ? AND user_id = ?').bind(win, win * 3, c.id, u).run();
      if (r.meta?.changes) done.cups++;
    }
  }
  const ms = (await db.prepare(`SELECT m.*, t.id AS tid FROM tournament_matches m JOIN tournaments t ON t.id = m.tournament_id AND m.round = t.round
    WHERE t.project_id = ? AND t.queue = ? AND t.kind = 'bracket' AND t.status = 'running' AND m.winner IS NULL`).bind(projectId, queue).all()).results || [];
  for (const m of ms) {
    if (!m.a || !m.b || !ids.includes(m.a) || !ids.includes(m.b)) continue;
    const ra = ranking.findIndex((pl) => pl.includes(m.a)), rb = ranking.findIndex((pl) => pl.includes(m.b));
    if (ra === rb) continue;   // a draw decides nothing: they play again
    if (await decide(db, m.tid, m, ra < rb ? m.a : m.b, { kind: 'match', match: matchId }, t)) { done.brackets++; await advance(db, m.tid, t); }
  }
  return done;
}

export function deleteStatements(db, uid) {
  return [db.prepare("DELETE FROM tournament_players WHERE user_id = ? AND tournament_id IN (SELECT id FROM tournaments WHERE status = 'signup')").bind(uid)];
}
