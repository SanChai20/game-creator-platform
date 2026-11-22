// The matchmaking rules: who plays whom, on which team, and how ratings move after a match. Pure: no bindings or I/O,
// so tests/match-making.mjs runs them directly. The Durable Object around them is src/matchmaker.ts.
import { regionDistance, type RegionHint } from './placement.ts';

/** One player in a queue. wait and settle are the player's own (see matchRequest); a queue mixes players with different ones. */
export interface Waiting { u: string; n: string; region: RegionHint | null; rating: number; at: number; wait?: number; settle?: number }

/** How far apart players may be while someone has waited `secs`: same region first, then neighbours, then anyone. */
export function reach(secs: number): { dist: number; rating: number } {
  return { dist: secs < 5 ? 0 : secs < 10 ? 1 : secs < 20 ? 2 : 3, rating: Math.min(1000, 100 + 25 * secs) };
}

/**
 * Forms as many matches as the queue allows right now. Oldest player first: they get the closest players by rating within
 * their reach. A full match is preferred; once the oldest player has waited their `wait` (`shortAfter` seconds when they
 * gave none) a match of at least `min` players starts anyway (with min 1, a player nobody else is in reach of starts
 * alone). A short match does not start while one of its players has been in the queue for less than their `settle`:
 * it holds for them, so nobody is taken the instant they arrive and players who arrive together play together.
 */
export const SHORT_AFTER_S = 30;
export function formGroups(waiting: Waiting[], now: number, size: number, min: number, shortAfter = SHORT_AFTER_S): Waiting[][] {
  const queue = [...waiting].sort((a, b) => a.at - b.at), used = new Set<string>(), out: Waiting[][] = [];
  for (const anchor of queue) {
    if (used.has(anchor.u)) continue;
    const secs = (now - anchor.at) / 1000, r = reach(secs);
    const cands = queue.filter((c) => !used.has(c.u) && c.u !== anchor.u && regionDistance(anchor.region, c.region) <= Math.max(r.dist, reach((now - c.at) / 1000).dist)
      && Math.abs(c.rating - anchor.rating) <= Math.max(r.rating, reach((now - c.at) / 1000).rating))
      .sort((a, b) => Math.abs(a.rating - anchor.rating) - Math.abs(b.rating - anchor.rating) || a.at - b.at);
    let group: Waiting[] | null = null;
    if (cands.length + 1 >= size) group = [anchor, ...cands.slice(0, size - 1)];
    else if (secs >= (anchor.wait ?? shortAfter) && cands.length + 1 >= min && [anchor, ...cands].every((g) => now - g.at >= (g.settle ?? 0) * 1000)) group = [anchor, ...cands];
    if (group) { for (const g of group) used.add(g.u); out.push(group); }
  }
  return out;
}

/** Splits a group into `teams` teams of even strength: strongest first, snake order (A B B A A B ...). */
export function assignTeams<T extends { rating: number }>(group: T[], teams: number): (T & { team: number | null })[] {
  if (teams <= 1) return group.map((g) => ({ ...g, team: null }));
  const sorted = [...group].sort((a, b) => b.rating - a.rating);
  return sorted.map((g, i) => {
    const round = Math.floor(i / teams), pos = i % teams;
    return { ...g, team: round % 2 === 0 ? pos : teams - 1 - pos };
  });
}

/**
 * Rating changes after a match: every pair of ranked players is an Elo game (the better place wins, the same place is a
 * draw), each scaled by 1 / (players - 1) so a big match moves a rating about as much as a duel.
 */
export function eloChanges(ranking: string[][], ratings: Map<string, number>, k = 32): Map<string, number> {
  const place = new Map<string, number>();
  ranking.forEach((ids, i) => ids.forEach((id) => place.set(id, i)));
  const ids = [...place.keys()], out = new Map<string, number>(ids.map((id) => [id, 0]));
  if (ids.length < 2) return out;
  for (const a of ids) for (const b of ids) {
    if (a === b) continue;
    const ra = ratings.get(a) ?? 1000, rb = ratings.get(b) ?? 1000;
    const expect = 1 / (1 + 10 ** ((rb - ra) / 400));
    const pa = place.get(a)!, pb = place.get(b)!, score = pa < pb ? 1 : pa === pb ? 0.5 : 0;
    out.set(a, out.get(a)! + (k * (score - expect)) / (ids.length - 1));
  }
  return out;
}

/** The rules a matchmaking request must follow. Returns the cleaned request or an error message. */
export function matchRequest(q: { queue?: string | null; size?: string | null; min?: string | null; teams?: string | null; code?: string | null; mode?: string | null; wait?: string | null; settle?: string | null }, maxPlayers: number):
  { ok: true; queue: string; size: number; min: number; teams: number; code: string | null; mode: string; wait: number; settle: number } | { ok: false; error: string } {
  const queue = String(q.queue || 'default');
  if (!/^[a-z0-9_-]{1,32}$/.test(queue)) return { ok: false, error: 'queue must be 1 to 32 characters: a-z, 0-9, _ or -.' };
  const cap = Math.max(2, Math.min(64, Math.round(maxPlayers) || 16));
  const size = Math.round(Number(q.size || 2));
  if (!(size >= 2 && size <= cap)) return { ok: false, error: `players must be between 2 and ${cap}.` };
  const min = Math.round(Number(q.min || size));
  // min 1: a lone player starts alone (after the short-start wait, or at once from a private lobby) and the game's
  // server/match.js fills the empty seats, with bots for example
  if (!(min >= 1 && min <= size)) return { ok: false, error: 'min must be between 1 and players.' };
  const teams = Math.round(Number(q.teams || 1));
  if (!(teams >= 1 && teams <= size)) return { ok: false, error: 'teams must be between 1 and players.' };
  const code = q.code ? String(q.code).toUpperCase() : null;
  if (code && !/^[A-Z0-9]{3,12}$/.test(code)) return { ok: false, error: 'code must be 3 to 12 letters or digits.' };
  const mode = String(q.mode || '');
  if (!/^[a-z0-9_-]{0,32}$/.test(mode)) return { ok: false, error: 'mode must be up to 32 characters: a-z, 0-9, _ or -.' };
  // wait: how long this player waits for a full match before one of at least `min` may start. settle: how long this
  // player is in the queue, at least, before a short match takes them. Both belong to the player, not to the queue, so
  // a game may give every search its own (a wait that is never the same twice, for example).
  const wait = q.wait == null || q.wait === '' ? SHORT_AFTER_S : Number(q.wait);
  if (!(wait >= 5 && wait <= 120)) return { ok: false, error: 'wait must be between 5 and 120 seconds.' };
  const settle = q.settle == null || q.settle === '' ? 0 : Number(q.settle);
  if (!(settle >= 0 && settle <= 20)) return { ok: false, error: 'settle must be between 0 and 20 seconds.' };
  return { ok: true, queue, size, min, teams, code, mode, wait, settle };
}
