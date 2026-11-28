// Presence: what an account's friends see of it (Online, Away, Busy, or Offline, and the game it is playing with for how
// long), worked out from the platform pages it has open. Pure, so tests/social.mjs checks it without a Durable Object;
// the SocialHub (src/social.ts) keeps the pages and pushes the result to friends.
//
//   - No page open: Offline. Invisible: Offline to everyone else, while the account itself keeps everything working.
//   - Busy (do not disturb) and Away are what the account chose. Online turns into Away by itself when every page has
//     been in the background for AWAY_AFTER_MS.
//   - The game is the one the most recent page is playing; its time counts from when that page started it. A friend
//     who hides their game shows only their status. "joinable": the game offers a place to friends and they allow joining.

export const AWAY_AFTER_MS = 5 * 60 * 1000;
/** A page that closed may be a reload: offline only once no page has come back for this long. */
export const OFFLINE_GRACE_MS = 12 * 1000;

/**
 * pages: [{ vis: boolean, hidAt: number|null, at: number, act: { g: { id, slug, title }, since, detail, lobby } | null, actAt }]
 * prof: { status, show_game, joinable } (social_profiles; status online | away | busy | invisible)
 * Returns { self, shown }: self is what the account sees of itself (with invisible), shown what friends see.
 */
export function presenceOf(pages, prof, t = Date.now()) {
  const status = prof?.status || 'online';
  if (!pages.length) return { self: { s: 'offline', chosen: status }, shown: { s: 'offline' } };
  const away = pages.every((p) => !p.vis && p.hidAt && t - p.hidAt >= AWAY_AFTER_MS);
  const s = status === 'busy' ? 'busy' : status === 'away' || away ? 'away' : 'online';
  const playing = pages.filter((p) => p.act && p.act.g).sort((a, b) => (b.actAt || 0) - (a.actAt || 0))[0];
  const self = { s: status === 'invisible' ? 'invisible' : s, chosen: status };
  const shown = { s };
  if (playing) {
    const a = playing.act;
    self.game = a.g; self.since = a.since; if (a.detail) self.detail = a.detail; if (a.lobby) self.joinable = true; if (a.watch) self.watchable = true;
    if (prof?.show_game !== 0 && prof?.show_game !== false) {
      shown.game = a.g; shown.since = a.since; if (a.detail) shown.detail = a.detail; if (a.watch) shown.watchable = true;
      if (a.lobby && prof?.joinable !== 0 && prof?.joinable !== false) shown.joinable = true;
    }
  }
  if (status === 'invisible') return { self, shown: { s: 'offline' } };
  return { self, shown };
}

/** Whether two presences differ in anything a friend would see (the game's time does not tick here: its start does). */
export const samePresence = (a, b) => JSON.stringify(a || null) === JSON.stringify(b || null);

/** When this presence will change by itself (a background page turning Away), so the hub can look again then. */
export function nextChange(pages, prof, t = Date.now()) {
  if (!pages.length || prof?.status === 'away' || prof?.status === 'busy') return null;
  if (pages.some((p) => p.vis)) return null;
  const last = Math.max(...pages.map((p) => p.hidAt || 0));
  return last + AWAY_AFTER_MS > t ? last + AWAY_AFTER_MS : null;
}

/** A presence as a game sees it (GCP.friends.list): the status, and the game only as "this game" or its title. */
export function forGame(p, projectId) {
  const s = p && p.s || 'offline', out = { status: s, playing: null, since: null, joinable: false };
  if (p && p.game) { out.playing = { here: p.game.id === projectId, title: p.game.title }; out.since = p.since || null; out.joinable = !!p.joinable && p.game.id === projectId; if (p.detail) out.playing.detail = p.detail; }
  return out;
}
