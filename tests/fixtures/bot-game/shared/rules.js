// A tiny eight-seat drafting game for tests/bots-live.mjs: every second each seat earns gold; buying a card (one of the
// three on offer) adds its value to the seat's score. Rules shared by the match and the bots, as a real game would.
export const OFFER = 3;
export function card(seed, n) { let a = (seed * 2654435761 + n * 40503) >>> 0; a ^= a >>> 13; return 1 + (a % 5); }
export function buy(P, i) { const c = P.offer[i]; if (c == null || P.gold < c) return false; P.gold -= c; P.score += c * 2; P.offer[i] = null; P.bought++; return true; }
