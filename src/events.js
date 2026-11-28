// Custom analytics events: what a game counts with GCP.track(name, value), for its creator's funnels and charts. Plain JS
// over a D1-shaped database so the rules can be tested without a Worker (tests/events.mjs).
//
// Rules: the game, environment and player come from the play token; a game uses at most MAX_NAMES event names per scope
// (preview and live apart), so a bug that tracks a fresh name every frame cannot grow the tables without bound; the
// verification browser records nothing; creators see totals and unique players, never one player's events.

export const MAX_NAMES = 50;
export const MAX_BATCH = 20;
export const NAME = /^[a-z0-9][a-z0-9_.-]{0,39}$/;
export const FUNNEL_MAX = 10;

export class EventError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code; }
}

/** A batch from the SDK: [{ name, n?, sum? }] (n events of that name, their values adding up to sum). */
export function cleanBatch(raw) {
  const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' && raw.name ? [raw] : [];
  if (!list.length) throw new EventError(400, 'events must be a list of { name, n, sum }.', 'bad_request');
  if (list.length > MAX_BATCH) throw new EventError(400, `At most ${MAX_BATCH} event names per call.`, 'bad_request');
  const out = new Map();
  for (const e of list) {
    const name = String(e?.name ?? '');
    if (!NAME.test(name)) throw new EventError(400, `Event name "${name.slice(0, 50)}" must be 1 to 40 characters of a-z, 0-9, _, . and -, starting with a letter or digit.`, 'bad_event');
    const n = Math.max(1, Math.min(10000, Math.round(Number(e.n ?? 1)) || 1)), sum = Number(e.sum ?? 0);
    const prev = out.get(name) || { name, n: 0, sum: 0 };
    prev.n += n; prev.sum += Number.isFinite(sum) && Math.abs(sum) <= 1e12 ? sum : 0;
    out.set(name, prev);
  }
  return [...out.values()];
}

const dayOf = (t) => new Date(t).toISOString().slice(0, 10);

/**
 * Records a batch for one player. New names are accepted while the scope has fewer than MAX_NAMES; the rest are
 * reported back in `refused`. Returns { ok, recorded, refused }.
 */
export async function trackOp(db, scope, owner, batch, t = Date.now(), keep = true) {
  const list = cleanBatch(batch);
  if (!keep || !owner) return { ok: true, recorded: 0, refused: [], ...(keep ? {} : { recorded_note: 'not recorded (verification browser)' }) };
  const known = new Set((await db.prepare('SELECT name FROM event_names WHERE project_id = ?').bind(scope).all()).results.map((r) => r.name));
  const refused = [], go = [];
  for (const e of list) {
    if (!known.has(e.name)) {
      // one statement: a name is added only while the scope is under the cap, so parallel calls cannot overshoot
      const r = await db.prepare('INSERT INTO event_names (project_id, name, created_at) SELECT ?1, ?2, ?3 WHERE (SELECT COUNT(*) FROM event_names WHERE project_id = ?1) < ?4 ON CONFLICT DO NOTHING').bind(scope, e.name, t, MAX_NAMES).run();
      if (!r.meta?.changes && !(await db.prepare('SELECT 1 AS x FROM event_names WHERE project_id = ? AND name = ?').bind(scope, e.name).first())) { refused.push(e.name); continue; }
    }
    go.push(e);
  }
  const day = dayOf(t), stmts = [];
  for (const e of go) {
    stmts.push(
      db.prepare('INSERT INTO game_events_daily (project_id, day, name, count, total) VALUES (?, ?, ?, ?, ?) ON CONFLICT(project_id, day, name) DO UPDATE SET count = count + excluded.count, total = total + excluded.total').bind(scope, day, e.name, e.n, e.sum),
      db.prepare('INSERT INTO event_players (project_id, name, user_id, count, first_at, last_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(project_id, name, user_id) DO UPDATE SET count = count + excluded.count, last_at = excluded.last_at').bind(scope, e.name, owner, e.n, t, t),
    );
  }
  if (stmts.length) await db.batch(stmts);
  return { ok: true, recorded: go.length, refused, ...(refused.length ? { error: `This game already uses ${MAX_NAMES} event names; ${refused.join(', ')} ${refused.length > 1 ? 'were' : 'was'} not recorded.` } : {}) };
}

/** Per event name over a window: count, total, average value, and unique players (who reached it in the window). */
export async function eventSummary(db, scope, since) {
  const sinceDay = dayOf(since);
  const [daily, players] = await Promise.all([
    db.prepare('SELECT name, SUM(count) AS count, SUM(total) AS total FROM game_events_daily WHERE project_id = ? AND day >= ? GROUP BY name').bind(scope, sinceDay).all(),
    db.prepare('SELECT name, COUNT(*) AS players FROM event_players WHERE project_id = ? AND last_at >= ? GROUP BY name').bind(scope, since).all(),
  ]);
  const p = new Map(players.results.map((r) => [r.name, r.players]));
  return daily.results.map((r) => ({ name: r.name, count: r.count, players: p.get(r.name) || 0, total: Math.round(r.total * 100) / 100, average: r.count ? Math.round((r.total / r.count) * 100) / 100 : 0 }))
    .sort((a, b) => b.players - a.players || b.count - a.count);
}

/** Event counts per day for a window, for charts: [{ day, name, count }]. */
export async function eventDaily(db, scope, since) {
  return (await db.prepare('SELECT day, name, count FROM game_events_daily WHERE project_id = ? AND day >= ? ORDER BY day').bind(scope, dayOf(since)).all()).results;
}

/**
 * An ordered funnel over event names: how many players who started in the window (first reached step 1 then) went on
 * to reach each later step, at or after the time they reached the one before. [{ step, players, share, from_previous }].
 */
export async function funnel(db, scope, steps, since) {
  const names = [...new Set((steps || []).map(String).filter((s) => NAME.test(s)))].slice(0, FUNNEL_MAX);
  if (!names.length) return [];
  const rows = (await db.prepare(`SELECT name, user_id, first_at FROM event_players WHERE project_id = ? AND name IN (${names.map(() => '?').join(',')})`).bind(scope, ...names).all()).results;
  const at = new Map(names.map((n) => [n, new Map()]));
  for (const r of rows) at.get(r.name).set(r.user_id, r.first_at);
  let cohort = [...at.get(names[0])].filter(([, t]) => t >= since).map(([u, t]) => [u, t]);
  const start = cohort.length, out = [];
  names.forEach((name, i) => {
    if (i) cohort = cohort.map(([u, t]) => { const n = at.get(name).get(u); return n != null && n >= t ? [u, n] : null; }).filter(Boolean);
    const prev = out.length ? out[out.length - 1].players : start;
    out.push({ step: name, players: cohort.length, share: start ? Math.round((cohort.length / start) * 1000) / 10 : 0, from_previous: prev ? Math.round((cohort.length / prev) * 1000) / 10 : 0 });
  });
  return out;
}

/** The funnel steps a version declares in gcp.json "funnel": event names in order. */
export function parseFunnel(raw) {
  if (raw == null) return { steps: [], issues: [] };
  if (!Array.isArray(raw)) return { steps: [], issues: [{ level: 'error', field: 'funnel', message: 'must be an array of event names in order.' }] };
  const issues = [], steps = [];
  for (const [i, s] of raw.entries()) {
    if (typeof s !== 'string' || !NAME.test(s)) { issues.push({ level: 'error', field: `funnel[${i}]`, message: 'must be an event name: 1 to 40 characters of a-z, 0-9, _, . and -.' }); continue; }
    if (!steps.includes(s)) steps.push(s);
  }
  if (steps.length > FUNNEL_MAX) issues.push({ level: 'warning', field: 'funnel', message: `has ${steps.length} steps; only the first ${FUNNEL_MAX} are shown.` });
  return { steps: steps.slice(0, FUNNEL_MAX), issues };
}

/** Rolling retention for a cohort of players: day 1, 7 and 30, overall and per week the players first played in. */
/** @param {{ first_at: number; last_at: number }[]} cohort @param {number} t */
export function retentionOf(cohort, t) {
  const DAY = 86400_000;
  const rate = (/** @type {typeof cohort} */ list, /** @type {number} */ n) => {
    const due = list.filter((p) => p.first_at <= t - n * DAY);
    return { eligible: due.length, returned: due.filter((p) => p.last_at >= p.first_at + n * DAY).length, share: due.length ? Math.round((due.filter((p) => p.last_at >= p.first_at + n * DAY).length / due.length) * 1000) / 10 : null };
  };
  const weekOf = (/** @type {number} */ ms) => { const d = new Date(ms); d.setUTCHours(0, 0, 0, 0); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return d.toISOString().slice(0, 10); };
  const weeks = /** @type {Map<string, typeof cohort>} */ (new Map());
  for (const p of cohort) { const w = weekOf(p.first_at); weeks.set(w, [...(weeks.get(w) || []), p]); }
  return {
    new_players: cohort.length,
    returned: cohort.filter((p) => p.last_at >= p.first_at + DAY).length,
    day1: rate(cohort, 1), day7: rate(cohort, 7), day30: rate(cohort, 30),
    cohorts: [...weeks].sort(([a], [b]) => (a < b ? 1 : -1)).map(([week, list]) => ({ week, players: list.length, day1: rate(list, 1).share, day7: rate(list, 7).share })),
  };
}
