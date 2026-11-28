// Daily and weekly challenges. Each UTC day the platform picks one free, live game with a leaderboard players use: the
// daily challenge. Every game gets a seed of the day that is the same for all its players (GCP.daily), so a game can
// offer the same run to everyone; the challenge game's best scores of the day, on its busiest board, make the day's
// board on the home page. Playing the daily challenge on consecutive days builds a streak shown on the player's profile.
// Each week another game gets a shared goal: minutes played by everyone together. Plain JS over a D1-shaped database
// (tests/challenges.mjs).
//
// Rules, enforced here and nowhere else:
//   - A daily challenge is a live, listed, free game that is not adults-only, with a leaderboard on which at least
//     3 players scored in the last 90 days, and that was not the challenge in the last 14 days. The pick is fixed per day.
//   - The day's board counts only scores sent that UTC day, on that board, from signed-in players of the live game.
//   - A streak counts the days in a row on which a signed-in player started the daily challenge game.
//   - The weekly goal is a free, live, listed game that is not adults-only, not picked in the last 4 weeks, and was
//     played in the last 14 days; its goal is half again the minutes it was played the week before (at least 300).

export const LIMITS = { min_scorers: 3, daily_gap_days: 14, weekly_gap_weeks: 4, board_size: 10, goal_min: 300 };
const DAY = 86400_000;
const now = () => Date.now();
export const dayOf = (t) => new Date(t).toISOString().slice(0, 10);
const dayMs = (d) => Date.parse(d + 'T00:00:00Z');
/** The Monday (UTC) of t's week. */
export const weekOf = (t) => { const d = new Date(dayMs(dayOf(t))); const back = (d.getUTCDay() + 6) % 7; return dayOf(d.getTime() - back * DAY); };

function fnv(s) { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h >>> 0; }
/** The seed of the day for one game: 16 hex digits, the same for every player of that game that UTC day. */
export const seedOf = (day, game) => fnv(`${day}:${game}:a`).toString(16).padStart(8, '0') + fnv(`${day}:${game}:b`).toString(16).padStart(8, '0');

const shown = `p.status = 'live' AND p.hidden_at IS NULL AND COALESCE(p.age, 0) < 18 AND COALESCE(p.price_cents, 0) = 0`;

/** Today's daily challenge, picked on first ask. null when no game qualifies. */
export async function ensureDaily(db, t = now()) {
  const day = dayOf(t);
  const have = await db.prepare('SELECT * FROM daily_challenges WHERE day = ?').bind(day).first();
  if (have) return have;
  const since = t - 90 * DAY, recent = dayOf(t - LIMITS.daily_gap_days * DAY);
  const rows = (await db.prepare(`SELECT p.id, b.board, b.asc, COUNT(s.user_id) AS scorers FROM projects p JOIN boards b ON b.project_id = p.id
      JOIN scores s ON s.project_id = p.id AND s.board = b.board AND s.updated_at >= ?1
      WHERE ${shown} AND p.id NOT IN (SELECT project_id FROM daily_challenges WHERE day >= ?2)
      GROUP BY p.id, b.board HAVING COUNT(s.user_id) >= ?3 ORDER BY p.plays DESC, scorers DESC LIMIT 200`).bind(since, recent, LIMITS.min_scorers).all()).results;
  // the busiest board of each game, then one of the 20 most played games, chosen by the day
  const best = new Map();
  for (const r of rows) if (!best.has(r.id) || best.get(r.id).scorers < r.scorers) best.set(r.id, r);
  const pool = [...best.values()].slice(0, 20);
  if (!pool.length) return null;
  const pick = pool[fnv(day) % pool.length];
  await db.prepare('INSERT INTO daily_challenges (day, project_id, board, asc, seed, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(day) DO NOTHING')
    .bind(day, pick.id, pick.board, pick.asc ? 1 : 0, seedOf(day, pick.id), t).run();
  return db.prepare('SELECT * FROM daily_challenges WHERE day = ?').bind(day).first();
}

/** This week's shared goal, picked on first ask. null when no game qualifies. */
export async function ensureWeekly(db, t = now()) {
  const week = weekOf(t);
  const have = await db.prepare('SELECT * FROM weekly_goals WHERE week = ?').bind(week).first();
  if (have) return have;
  const from = dayOf(t - 14 * DAY), gap = dayOf(dayMs(week) - LIMITS.weekly_gap_weeks * 7 * DAY);
  const pool = (await db.prepare(`SELECT p.id, SUM(d.seconds) AS seconds FROM projects p JOIN game_daily d ON d.project_id = p.id AND d.day >= ?1
      WHERE ${shown} AND p.id NOT IN (SELECT project_id FROM weekly_goals WHERE week > ?2) GROUP BY p.id HAVING SUM(d.seconds) > 0 ORDER BY seconds DESC LIMIT 10`).bind(from, gap).all()).results;
  if (!pool.length) return null;
  const pick = pool[fnv(week) % pool.length];
  const last = (await db.prepare('SELECT COALESCE(SUM(seconds), 0) AS s FROM game_daily WHERE project_id = ? AND day >= ? AND day < ?').bind(pick.id, dayOf(dayMs(week) - 7 * DAY), week).first())?.s || 0;
  const goal = Math.max(LIMITS.goal_min, Math.ceil((last / 60) * 1.5 / 100) * 100);
  await db.prepare('INSERT INTO weekly_goals (week, project_id, goal_minutes, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(week) DO NOTHING').bind(week, pick.id, goal, t).run();
  return db.prepare('SELECT * FROM weekly_goals WHERE week = ?').bind(week).first();
}

/** An admin sets the game of a day (today or later), with the board the day's scores come from. */
export async function setDaily(db, day, pid, board, adminId, t = now()) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || day < dayOf(t)) throw new Error('Pick today or a later day (YYYY-MM-DD).');
  const b = await db.prepare(`SELECT b.board, b.asc FROM boards b JOIN projects p ON p.id = b.project_id WHERE b.project_id = ? AND b.board = ? AND ${shown}`).bind(pid, board).first();
  if (!b) throw new Error('That game is not a free, live game with that leaderboard.');
  await db.prepare(`INSERT INTO daily_challenges (day, project_id, board, asc, seed, picked_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(day) DO UPDATE SET project_id = excluded.project_id, board = excluded.board, asc = excluded.asc, seed = excluded.seed, picked_by = excluded.picked_by`)
    .bind(day, pid, b.board, b.asc ? 1 : 0, seedOf(day, pid), adminId, t).run();
  if (day === dayOf(t)) await db.prepare('DELETE FROM challenge_scores WHERE day = ?').bind(day).run();   // the old game's scores of today do not count for the new one
  return { ok: true };
}

/** What a game's SDK gets from GCP.daily(): the seed of the day, and whether it is today's challenge (with its board). */
export async function dailyFor(db, game, t = now()) {
  const day = dayOf(t), c = await db.prepare('SELECT project_id, board FROM daily_challenges WHERE day = ?').bind(day).first();
  const on = !!c && c.project_id === game;
  return { day, seed: seedOf(day, game), challenge: on, board: on ? c.board : null, ends_at: dayMs(day) + DAY };
}

/** A score sent by a signed-in player of the live game: kept on the day's board when it is today's challenge board. */
export async function recordScore(db, game, board, uid, name, score, t = now()) {
  const day = dayOf(t), c = await db.prepare('SELECT project_id, board, asc FROM daily_challenges WHERE day = ?').bind(day).first();
  if (!c || c.project_id !== game || c.board !== board) return false;
  await db.prepare(`INSERT INTO challenge_scores (day, user_id, name, score, at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(day, user_id) DO UPDATE SET score = ${c.asc ? 'MIN' : 'MAX'}(score, excluded.score), name = excluded.name, at = CASE WHEN excluded.score ${c.asc ? '<' : '>'} score THEN excluded.at ELSE at END`)
    .bind(day, uid, String(name || '').slice(0, 60), score, t).run();
  return true;
}

/** A signed-in player started a live game: when it is today's challenge, their streak moves on. Returns the streak or null. */
export async function recordPlay(db, game, uid, t = now()) {
  const day = dayOf(t), c = await db.prepare('SELECT project_id FROM daily_challenges WHERE day = ?').bind(day).first();
  if (!c || c.project_id !== game) return null;
  const yesterday = dayOf(dayMs(day) - DAY);
  await db.prepare(`INSERT INTO challenge_streaks (user_id, last_day, streak, best, days) VALUES (?1, ?2, 1, 1, 1)
      ON CONFLICT(user_id) DO UPDATE SET
        streak = CASE WHEN last_day = ?2 THEN streak WHEN last_day = ?3 THEN streak + 1 ELSE 1 END,
        best = MAX(best, CASE WHEN last_day = ?2 THEN streak WHEN last_day = ?3 THEN streak + 1 ELSE 1 END),
        days = days + CASE WHEN last_day = ?2 THEN 0 ELSE 1 END,
        last_day = ?2`).bind(uid, day, yesterday).run();
  return streakOf(db, uid, t);
}

/** A player's streak as of t: the current run counts only if they played today or yesterday. */
export async function streakOf(db, uid, t = now()) {
  const r = uid ? await db.prepare('SELECT last_day, streak, best, days FROM challenge_streaks WHERE user_id = ?').bind(uid).first() : null;
  if (!r) return { streak: 0, best: 0, days: 0, played_today: false };
  const today = dayOf(t), alive = r.last_day === today || r.last_day === dayOf(dayMs(today) - DAY);
  return { streak: alive ? r.streak : 0, best: r.best, days: r.days, played_today: r.last_day === today };
}

/** The day's board: the best scores of the day, and the viewer's own place. */
export async function dayBoard(db, c, viewer, limit = LIMITS.board_size) {
  const order = c.asc ? 'ASC' : 'DESC';
  const top = (await db.prepare(`SELECT user_id, name, score FROM challenge_scores WHERE day = ? ORDER BY score ${order}, at ASC LIMIT ?`).bind(c.day, limit).all()).results;
  let mine = null;
  if (viewer) {
    const m = await db.prepare('SELECT score, at FROM challenge_scores WHERE day = ? AND user_id = ?').bind(c.day, viewer).first();
    if (m) {
      const ahead = (await db.prepare(`SELECT COUNT(*) AS n FROM challenge_scores WHERE day = ?1 AND (score ${c.asc ? '<' : '>'} ?2 OR (score = ?2 AND at < ?3))`).bind(c.day, m.score, m.at).first())?.n || 0;
      mine = { score: m.score, rank: ahead + 1 };
    }
  }
  const players = (await db.prepare('SELECT COUNT(*) AS n FROM challenge_scores WHERE day = ?').bind(c.day).first())?.n || 0;
  return { top: top.map((r, i) => ({ rank: i + 1, name: r.name, score: r.score, me: !!viewer && r.user_id === viewer })), mine, players };
}

/** Everything the challenges card shows: today's challenge with its board and the viewer's streak, and the week's goal. */
export async function challengesView(db, viewer, t = now()) {
  const [c, w] = await Promise.all([ensureDaily(db, t), ensureWeekly(db, t)]);
  const game = async (id) => db.prepare('SELECT p.*, u.name AS author FROM projects p JOIN users u ON u.id = p.owner_id WHERE p.id = ?').bind(id).first();
  const daily = c ? { day: c.day, board: c.board, lower_wins: !!c.asc, ends_at: dayMs(c.day) + DAY, game: await game(c.project_id), ...(await dayBoard(db, c, viewer)) } : null;
  let weekly = null;
  if (w) {
    const end = dayOf(dayMs(w.week) + 7 * DAY);
    const s = (await db.prepare('SELECT COALESCE(SUM(seconds), 0) AS s FROM game_daily WHERE project_id = ? AND day >= ? AND day < ?').bind(w.project_id, w.week, end).first())?.s || 0;
    weekly = { week: w.week, ends_at: dayMs(end), goal_minutes: w.goal_minutes, minutes: Math.round(s / 60), game: await game(w.project_id) };
  }
  return { daily, weekly, streak: await streakOf(db, viewer, t) };
}
