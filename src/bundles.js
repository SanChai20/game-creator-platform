// Bundles: "complete the set". A creator groups 2 to 10 of their own paid games and sets a discount. Each game is still
// bought on its own (one checkout, one purchase, refunded on its own), and a player who owns any other game of the
// bundle pays less for the rest. Plain JS over a D1-shaped database (tests/bundles.mjs).
//
// Rules, enforced here and nowhere else:
//   - Only the creator's own games, each paid and not removed; 2 to 10 games; 5 to 60% off; at most 10 bundles each.
//   - The discount applies to a game of the bundle for a player who owns (a paid, unrefunded purchase, a gift or a key)
//     at least one other game of the same bundle. When several bundles qualify, the largest discount wins.
//   - It comes off the regular price. The buyer pays the lowest of the regular price, a sale, a discount code and the
//     bundle price, never below 50 cents; discounts do not stack.
//   - A bundle shows only its live games; with fewer than 2 live games it is not shown to players.

export const LIMITS = { games_min: 2, games_max: 10, percent_min: 5, percent_max: 60, per_creator: 10, title: 80, description: 600 };

export class BundleError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code; }
}
const now = () => Date.now();
const clean = (v, n) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const slugify = (s) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'bundle';
const rid = () => 'bnd_' + [...crypto.getRandomValues(new Uint8Array(9))].map((b) => b.toString(36).padStart(2, '0')).join('').slice(0, 14);

async function checkGames(db, ownerId, raw) {
  const ids = [...new Set((Array.isArray(raw) ? raw : []).map((x) => String(x || '').trim()).filter(Boolean))];
  if (ids.length < LIMITS.games_min || ids.length > LIMITS.games_max) throw new BundleError(400, `A bundle has ${LIMITS.games_min} to ${LIMITS.games_max} games.`, 'bad_request');
  const out = [];
  for (const id of ids) {
    const p = await db.prepare('SELECT id, slug, owner_id, price_cents, status FROM projects WHERE id = ? OR slug = ?').bind(id, id).first();
    if (!p || p.status === 'removed') throw new BundleError(404, `No game "${id}".`, 'not_found');
    if (p.owner_id !== ownerId) throw new BundleError(403, `"${p.slug}" is not your game: a bundle has only your own games.`, 'forbidden');
    if (!(p.price_cents > 0)) throw new BundleError(409, `"${p.slug}" is free: a bundle has only paid games.`, 'free');
    if (!out.includes(p.id)) out.push(p.id);
  }
  if (out.length < LIMITS.games_min) throw new BundleError(400, `A bundle has ${LIMITS.games_min} to ${LIMITS.games_max} games.`, 'bad_request');
  return out;
}
function checkPercent(v) {
  const pct = Math.round(Number(v));
  if (!(pct >= LIMITS.percent_min && pct <= LIMITS.percent_max)) throw new BundleError(400, `percent_off must be ${LIMITS.percent_min} to ${LIMITS.percent_max}.`, 'bad_request');
  return pct;
}
const setGames = (db, id, games) => [db.prepare('DELETE FROM bundle_games WHERE bundle_id = ?').bind(id), ...games.map((g, i) => db.prepare('INSERT INTO bundle_games (bundle_id, project_id, position) VALUES (?, ?, ?)').bind(id, g, i))];

/** A new bundle: { title, description?, percent_off, games: [id or slug] }. */
export async function createBundle(db, ownerId, raw = {}, t = now()) {
  const title = clean(raw.title, LIMITS.title);
  if (!title) throw new BundleError(400, 'A bundle needs a title.', 'bad_request');
  const pct = checkPercent(raw.percent_off), games = await checkGames(db, ownerId, raw.games);
  const n = (await db.prepare('SELECT COUNT(*) AS n FROM bundles WHERE owner_id = ?').bind(ownerId).first())?.n || 0;
  if (n >= LIMITS.per_creator) throw new BundleError(409, `A creator has at most ${LIMITS.per_creator} bundles. Remove one first.`, 'too_many');
  let slug = slugify(title);
  while (await db.prepare('SELECT 1 AS x FROM bundles WHERE slug = ?').bind(slug).first()) slug = `${slugify(title).slice(0, 44)}-${Math.random().toString(36).slice(2, 7)}`;
  const id = rid();
  await db.batch([
    db.prepare('INSERT INTO bundles (id, slug, owner_id, title, description, percent_off, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').bind(id, slug, ownerId, title, clean(raw.description, LIMITS.description) || null, pct, t, t),
    ...setGames(db, id, games),
  ]);
  return { id, slug, title, percent_off: pct, games };
}

/** Changes a bundle's title, description, discount or games. */
export async function updateBundle(db, ownerId, id, raw = {}, t = now()) {
  const b = await db.prepare('SELECT * FROM bundles WHERE (id = ? OR slug = ?) AND owner_id = ?').bind(id, id, ownerId).first();
  if (!b) throw new BundleError(404, 'No such bundle of yours.', 'not_found');
  const title = raw.title !== undefined ? clean(raw.title, LIMITS.title) : b.title;
  if (!title) throw new BundleError(400, 'A bundle needs a title.', 'bad_request');
  const description = raw.description !== undefined ? clean(raw.description, LIMITS.description) || null : b.description;
  const pct = raw.percent_off !== undefined ? checkPercent(raw.percent_off) : b.percent_off;
  const games = raw.games !== undefined ? await checkGames(db, ownerId, raw.games) : null;
  await db.batch([
    db.prepare('UPDATE bundles SET title = ?, description = ?, percent_off = ?, updated_at = ? WHERE id = ?').bind(title, description, pct, t, b.id),
    ...(games ? setGames(db, b.id, games) : []),
  ]);
  return { ok: true, id: b.id, slug: b.slug };
}

export async function removeBundle(db, ownerId, id) {
  const b = await db.prepare('SELECT id FROM bundles WHERE (id = ? OR slug = ?) AND owner_id = ?').bind(id, id, ownerId).first();
  if (!b) throw new BundleError(404, 'No such bundle of yours.', 'not_found');
  await db.batch([db.prepare('DELETE FROM bundle_games WHERE bundle_id = ?').bind(b.id), db.prepare('DELETE FROM bundles WHERE id = ?').bind(b.id)]);
  return { ok: true };
}

/** The creator's paid games that can go in a bundle. */
export async function bundleable(db, ownerId) {
  return (await db.prepare("SELECT id, slug, title, price_cents, status FROM projects WHERE owner_id = ? AND price_cents > 0 AND status != 'removed' ORDER BY updated_at DESC LIMIT 200").bind(ownerId).all()).results;
}

/** The creator's bundles with their games (all of them, live or not). */
export async function myBundles(db, ownerId) {
  const list = (await db.prepare('SELECT * FROM bundles WHERE owner_id = ? ORDER BY created_at DESC').bind(ownerId).all()).results;
  for (const b of list) b.games = (await db.prepare('SELECT p.id, p.slug, p.title, p.price_cents, p.status FROM bundle_games g JOIN projects p ON p.id = g.project_id WHERE g.bundle_id = ? ORDER BY g.position').bind(b.id).all()).results;
  return list;
}

const ownedIn = async (db, uid, ids) => {
  if (!uid || !ids.length) return new Set();
  const rows = (await db.prepare(`SELECT project_id FROM purchases WHERE user_id = ? AND status = 'paid' AND project_id IN (${ids.map(() => '?').join(',')})`).bind(uid, ...ids).all()).results;
  return new Set(rows.map((r) => r.project_id));
};
const liveGames = async (db, bundleId) => (await db.prepare("SELECT p.*, u.name AS author FROM bundle_games g JOIN projects p ON p.id = g.project_id JOIN users u ON u.id = p.owner_id WHERE g.bundle_id = ? AND p.status = 'live' AND p.hidden_at IS NULL AND p.price_cents > 0 ORDER BY g.position").bind(bundleId).all()).results;

/** The best bundle discount this player has on this game: { bundle_id, slug, title, percent_off } or null. */
export async function bundleDiscount(db, projectId, uid) {
  if (!uid) return null;
  const bs = (await db.prepare('SELECT b.id, b.slug, b.title, b.percent_off FROM bundle_games g JOIN bundles b ON b.id = g.bundle_id WHERE g.project_id = ? ORDER BY b.percent_off DESC').bind(projectId).all()).results;
  for (const b of bs) {
    const others = (await liveGames(db, b.id)).map((p) => p.id).filter((id) => id !== projectId);
    if ((await ownedIn(db, uid, others)).size > 0) return { bundle_id: b.id, slug: b.slug, title: b.title, percent_off: b.percent_off };
  }
  return null;
}

/** The bundles a live game is shown in, for its page: each with how many of its games this player owns. */
export async function bundlesOf(db, projectId, uid) {
  const bs = (await db.prepare('SELECT b.id, b.slug, b.title, b.percent_off FROM bundle_games g JOIN bundles b ON b.id = g.bundle_id WHERE g.project_id = ? ORDER BY b.percent_off DESC LIMIT 5').bind(projectId).all()).results;
  const out = [];
  for (const b of bs) {
    const games = await liveGames(db, b.id);
    if (games.length < LIMITS.games_min || !games.some((p) => p.id === projectId)) continue;
    const owned = await ownedIn(db, uid, games.map((p) => p.id));
    out.push({ slug: b.slug, title: b.title, percent_off: b.percent_off, games: games.length, owned: owned.size, applies: [...owned].some((id) => id !== projectId) });
  }
  return out;
}

/** A bundle's public page: its live games, which this player owns, and what each of the rest costs them. */
export async function bundleView(db, slug, uid, priceFor) {
  const b = await db.prepare('SELECT b.*, u.name AS owner_name FROM bundles b JOIN users u ON u.id = b.owner_id WHERE b.slug = ?').bind(slug).first();
  if (!b) throw new BundleError(404, 'No such bundle.', 'not_found');
  const games = await liveGames(db, b.id);
  if (games.length < LIMITS.games_min) throw new BundleError(404, 'This bundle is not available now.', 'not_found');
  const owned = await ownedIn(db, uid, games.map((p) => p.id));
  const mine = uid === b.owner_id;
  const list = games.map((p) => {
    const has = owned.has(p.id) || mine, applies = !has && [...owned].some((id) => id !== p.id);
    return { game: p, owned: has, discounted: applies, price_cents: has ? 0 : priceFor(p, applies ? b.percent_off : null) };
  });
  const rest = list.filter((x) => !x.owned);
  return {
    bundle: { id: b.id, slug: b.slug, title: b.title, description: b.description, percent_off: b.percent_off, owner: { id: b.owner_id, name: b.owner_name } },
    games: list, owned: list.length - rest.length, total: list.length,
    rest_cents: rest.reduce((a, x) => a + x.price_cents, 0),
    rest_regular_cents: rest.reduce((a, x) => a + x.game.price_cents, 0),
  };
}
