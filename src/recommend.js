// For you: games a signed-in player has not played yet, picked from what they played, kept, bought, wishlisted and
// rated, and from what other players of those games went on to play. Plain JS over a D1-shaped database; the scoring is
// a pure function so it can be tested on its own (tests/recommend.mjs).
//
// Rules: only live, listed games the player has not played, owned, or dismissed; never their own games; never adults-
// only games; at most two games from one creator; every pick says why it is there. A player with no history gets nothing
// (the store's own shelves serve them).

export const LIMITS = { sources: 20, peers: 2000, candidates: 300, per_creator: 2, max: 24 };

const parse = (s, d) => { try { const v = JSON.parse(s); return v ?? d; } catch { return d; } };
const now = () => Date.now();

/**
 * The player's taste: { games: Map<id, weight>, tags: Map<tag, weight>, seen: Set<id> } from their own history.
 * Play time counts on a log scale, a rating of 4 or 5 adds, a rating of 1 or 2 takes away, and keeping, buying and
 * wishlisting each add a little.
 */
export async function tasteOf(db, uid) {
  const [played, kept, bought, wished, rated, dismissed, own] = await Promise.all([
    db.prepare("SELECT g.project_id AS id, g.seconds, p.tags FROM player_games g JOIN projects p ON p.id = g.project_id WHERE g.user_id = ? AND p.status = 'live' ORDER BY g.last_at DESC LIMIT 200").bind(uid).all(),
    db.prepare("SELECT l.project_id AS id, p.tags FROM library_games l JOIN projects p ON p.id = l.project_id WHERE l.user_id = ? AND p.status = 'live' LIMIT 200").bind(uid).all(),
    db.prepare("SELECT b.project_id AS id, p.tags FROM purchases b JOIN projects p ON p.id = b.project_id WHERE b.user_id = ? AND b.status = 'paid' LIMIT 200").bind(uid).all(),
    db.prepare("SELECT w.project_id AS id, p.tags FROM wishlists w JOIN projects p ON p.id = w.project_id WHERE w.user_id = ? LIMIT 200").bind(uid).all(),
    db.prepare("SELECT r.project_id AS id, r.rating, p.tags FROM reviews r JOIN projects p ON p.id = r.project_id WHERE r.user_id = ? LIMIT 200").bind(uid).all(),
    db.prepare('SELECT project_id AS id FROM rec_dismissed WHERE user_id = ?').bind(uid).all(),
    db.prepare('SELECT id FROM projects WHERE owner_id = ?').bind(uid).all(),
  ]);
  const games = new Map(), tags = new Map(), seen = new Set();
  const add = (id, rawTags, w) => {
    games.set(id, (games.get(id) || 0) + w);
    for (const [i, tag] of parse(rawTags, []).slice(0, 8).entries()) tags.set(tag, (tags.get(tag) || 0) + w * (i === 0 ? 1.5 : 1));
  };
  for (const r of played.results) { add(r.id, r.tags, Math.log2(2 + (r.seconds || 0) / 60)); seen.add(r.id); }
  for (const r of kept.results) { add(r.id, r.tags, 1); seen.add(r.id); }
  for (const r of bought.results) { add(r.id, r.tags, 2); seen.add(r.id); }
  for (const r of wished.results) { add(r.id, r.tags, 1); seen.add(r.id); }
  for (const r of rated.results) add(r.id, r.tags, r.rating >= 4 ? 2 : r.rating <= 2 ? -3 : 0);
  for (const r of dismissed.results) seen.add(r.id);
  for (const r of own.results) seen.add(r.id);
  return { games, tags, seen };
}

/**
 * Scores candidates. candidates: [{ id, owner_id, tags (array), rating, rating_count, plays, published_at }].
 * coplay: Map<candidate id, { n, from }> (players who played the player's games and this one; `from` the source game
 * with the most of them). Returns [{ id, score, reason: { kind: 'played' | 'tag' | 'popular', game?, tag? } }], best
 * first, with at most LIMITS.per_creator per creator.
 */
export function rank(taste, candidates, coplay = new Map(), t = now(), limit = 12) {
  const tagTotal = [...taste.tags.values()].reduce((a, b) => a + Math.max(0, b), 0) || 1;
  const scored = [];
  for (const c of candidates) {
    if (taste.seen.has(c.id)) continue;
    let tagScore = 0, bestTag = null, bestW = 0;
    for (const tag of c.tags || []) { const w = taste.tags.get(tag) || 0; tagScore += w; if (w > bestW) { bestW = w; bestTag = tag; } }
    tagScore = tagScore / tagTotal;                       // share of the player's taste this game touches (can be negative)
    const co = coplay.get(c.id), coScore = co ? Math.log2(1 + co.n) / 4 : 0;
    const rating = (c.rating * (c.rating_count || 0) + 3.5 * 3) / ((c.rating_count || 0) + 3);   // three neutral votes in front
    const quality = (rating - 3.5) / 3 + Math.log10(1 + (c.plays || 0)) / 10;
    const fresh = c.published_at && t - c.published_at < 21 * 86400_000 ? 0.05 : 0;
    const score = tagScore * 1.2 + coScore + quality * 0.5 + fresh;
    if (tagScore <= 0 && !co) continue;                   // nothing in common with what the player likes
    const reason = co && co.n >= 2 && coScore >= tagScore ? { kind: 'played', game: co.from } : bestTag ? { kind: 'tag', tag: bestTag } : co ? { kind: 'played', game: co.from } : { kind: 'popular' };
    scored.push({ id: c.id, owner_id: c.owner_id, score, reason });
  }
  scored.sort((a, b) => b.score - a.score);
  const per = new Map(), out = [];
  for (const s of scored) {
    const n = per.get(s.owner_id) || 0;
    if (n >= LIMITS.per_creator) continue;
    per.set(s.owner_id, n + 1);
    out.push({ id: s.id, score: Math.round(s.score * 1000) / 1000, reason: s.reason });
    if (out.length >= limit) break;
  }
  return out;
}

/** The player's For you list: [{ id, score, reason }] (reason.game is a game id). Empty without any history. */
export async function forYou(db, uid, limit = 12, t = now()) {
  const taste = await tasteOf(db, uid);
  if (!taste.games.size) return [];
  const sources = [...taste.games].filter(([, w]) => w > 0).sort((a, b) => b[1] - a[1]).slice(0, LIMITS.sources).map(([id]) => id);
  const coplay = new Map();
  if (sources.length) {
    const marks = sources.map(() => '?').join(',');
    const rows = await db.prepare(`WITH peers AS (SELECT user_id, project_id FROM player_games WHERE project_id IN (${marks}) AND user_id != ? AND user_id NOT LIKE 'verify:%' ORDER BY last_at DESC LIMIT ${LIMITS.peers})
        SELECT pr.project_id AS src, g.project_id AS id, COUNT(DISTINCT g.user_id) AS n FROM peers pr JOIN player_games g ON g.user_id = pr.user_id AND g.project_id != pr.project_id
        WHERE g.project_id NOT LIKE '%:preview' GROUP BY pr.project_id, g.project_id ORDER BY n DESC LIMIT 2000`).bind(...sources, uid).all();
    for (const r of rows.results) {
      const cur = coplay.get(r.id);
      if (!cur) coplay.set(r.id, { n: r.n, from: r.src, best: r.n });
      else { cur.n += r.n; if (r.n > cur.best) { cur.best = r.n; cur.from = r.src; } }
    }
  }
  // candidates: the games others went on to play, plus the best liked games in the player's favourite genres and tags
  const topTags = [...taste.tags].filter(([, w]) => w > 0).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([tag]) => tag);
  const coIds = [...coplay.keys()].slice(0, 200);
  const base = "p.status = 'live' AND p.hidden_at IS NULL AND COALESCE(p.age, 0) < 18 AND p.owner_id != ?";
  const [a, b] = await Promise.all([
    coIds.length ? db.prepare(`SELECT p.id, p.owner_id, p.tags, p.rating_sum, p.rating_count, p.plays, p.published_at FROM projects p WHERE ${base} AND p.id IN (${coIds.map(() => '?').join(',')})`).bind(uid, ...coIds).all() : { results: [] },
    topTags.length ? db.prepare(`SELECT p.id, p.owner_id, p.tags, p.rating_sum, p.rating_count, p.plays, p.published_at FROM projects p WHERE ${base} AND EXISTS (SELECT 1 FROM json_each(p.tags) j WHERE j.value IN (${topTags.map(() => '?').join(',')}))
        ORDER BY p.recent DESC, p.plays DESC LIMIT ${LIMITS.candidates}`).bind(uid, ...topTags).all() : { results: [] },
  ]);
  const byId = new Map();
  for (const r of [...a.results, ...b.results]) byId.set(r.id, { id: r.id, owner_id: r.owner_id, tags: parse(r.tags, []), rating: r.rating_count ? r.rating_sum / r.rating_count : 0, rating_count: r.rating_count, plays: r.plays, published_at: r.published_at });
  return rank(taste, [...byId.values()], coplay, t, Math.min(LIMITS.max, limit));
}

/** "Not for me": the game leaves the player's For you list for good (until they play it, when it no longer matters). */
export async function dismiss(db, uid, pid, t = now()) {
  await db.prepare('INSERT INTO rec_dismissed (user_id, project_id, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING').bind(uid, pid, t).run();
  return { ok: true };
}
