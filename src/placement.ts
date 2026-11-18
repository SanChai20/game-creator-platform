// Where a realtime Durable Object (a room or a match) should live, chosen from where its players connect.
//
// A Durable Object is created near the Worker that first asks for it, and stays there. Without a hint, a room opened by
// a player whose request happened to land in an odd data center (a VPN, a mobile carrier's exit) would sit far from
// everyone else for its whole life. A location hint names one of Cloudflare's Durable Object regions instead.
// Hints are best effort, and only the first get() of an object uses them.
// Pure: tests/placement.mjs imports it directly.

export type RegionHint = 'wnam' | 'enam' | 'sam' | 'weur' | 'eeur' | 'apac' | 'oc' | 'afr' | 'me';
/** The hints Durable Objects accept. 'sam', 'afr' and 'me' are accepted and placed in a nearby region by Cloudflare. */
export const REGION_HINTS: readonly RegionHint[] = ['wnam', 'enam', 'sam', 'weur', 'eeur', 'apac', 'oc', 'afr', 'me'];
export const isRegionHint = (s: unknown): s is RegionHint => typeof s === 'string' && (REGION_HINTS as readonly string[]).includes(s);

/** The subset of request.cf this reads. */
export interface CfGeo { continent?: string; country?: string; longitude?: string | number; latitude?: string | number }

const ME = new Set(['AE', 'BH', 'IL', 'IQ', 'IR', 'JO', 'KW', 'LB', 'OM', 'PS', 'QA', 'SA', 'SY', 'YE', 'TR']);

/** The region a player connecting from this place should be served from, or null when the request carries no location. */
export function regionHint(cf: CfGeo | null | undefined): RegionHint | null {
  if (!cf) return null;
  const continent = String(cf.continent || '').toUpperCase(), country = String(cf.country || '').toUpperCase();
  const lon = Number(cf.longitude);
  if (ME.has(country)) return 'me';
  switch (continent) {
    case 'NA': return Number.isFinite(lon) && lon < -100 ? 'wnam' : 'enam';
    case 'SA': return 'sam';
    case 'EU': return Number.isFinite(lon) && lon > 20 ? 'eeur' : 'weur';
    case 'AS': return 'apac';
    case 'OC': return 'oc';
    case 'AF': return 'afr';
    case 'AN': return 'oc';
    default: return null;
  }
}

/** The best hint for a group of players: the region most of them are in (ties go to the first player's). */
export function groupHint(hints: (RegionHint | null | undefined)[]): RegionHint | null {
  const n = new Map<RegionHint, number>();
  for (const h of hints) if (h && isRegionHint(h)) n.set(h, (n.get(h) || 0) + 1);
  let best: RegionHint | null = null, top = 0;
  for (const h of hints) { if (!h) continue; const c = n.get(h) || 0; if (c > top) { best = h; top = c; } }
  return best;
}

/** Rough distance class between two regions, 0 (same) to 3 (other side of the world). The matchmaker uses it to prefer
    near players and only widen to far ones after a wait. */
const ZONE: Record<RegionHint, [number, number]> = {
  wnam: [-120, 40], enam: [-77, 39], sam: [-50, -15], weur: [2, 48], eeur: [25, 50], me: [45, 27], afr: [20, 0], apac: [115, 25], oc: [145, -30],
};
export function regionDistance(a: RegionHint | null | undefined, b: RegionHint | null | undefined): number {
  if (!a || !b) return 1;
  if (a === b) return 0;
  const [ax, ay] = ZONE[a], [bx, by] = ZONE[b];
  let dx = Math.abs(ax - bx); if (dx > 180) dx = 360 - dx;
  const d = Math.hypot(dx, ay - by);
  return d < 40 ? 1 : d < 110 ? 2 : 3;
}
