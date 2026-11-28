// Curated collections: public lists of games put together by players and staff ("best 10-minute puzzlers"), each game
// with an optional short note. Players follow lists and share their links; admins mark staff picks for the home page and
// can take a list down. Plain JS over a D1-shaped database (tests/collections.mjs).
//
// Rules, enforced here and nowhere else:
//   - A signed-in account has at most 50 lists of at most 100 games each. Titles up to 80 characters, descriptions 600,
//     notes 140. A list can be private (only its owner sees it).
//   - Only live, listed games can be added, and only live, listed games are shown; adult-only games are left out of the
//     cover strip and of staff picks' previews.
//   - Anyone signed in can follow a public list, not their own. Followers are counted on the list.

export const LIMITS = { per_user: 50, games: 100, title: 80, description: 600, note: 140, following: 500 };

export class CollectionError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code; }
}
const now = () => Date.now();
const clean = (v, n) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const slugify = (s) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'list';
const rid = () => 'col_' + [...crypto.getRandomValues(new Uint8Array(10))].map((b) => b.toString(36).padStart(2, '0')).join('').slice(0, 16);
const LIVE = "p.status = 'live' AND p.hidden_at IS NULL";

async function mine(db, uid, idOrSlug) {
  const c = await db.prepare('SELECT * FROM collections WHERE (id = ? OR slug = ?) AND owner_id = ?').bind(idOrSlug, idOrSlug, uid).first();
  if (!c) throw new CollectionError(404, 'No such list of yours.', 'not_found');
  return c;
}

/** A new list: { title, description?, public? }. */
export async function createCollection(db, uid, raw = {}, t = now()) {
  if (!uid) throw new CollectionError(401, 'Sign in to make a list.', 'unauthenticated');
  const title = clean(raw.title, LIMITS.title);
  if (!title) throw new CollectionError(400, 'A list needs a title.', 'bad_request');
  const n = (await db.prepare('SELECT COUNT(*) AS n FROM collections WHERE owner_id = ?').bind(uid).first())?.n || 0;
  if (n >= LIMITS.per_user) throw new CollectionError(409, `You can have at most ${LIMITS.per_user} lists.`, 'too_many');
  let slug = slugify(title);
  while (await db.prepare('SELECT 1 AS x FROM collections WHERE slug = ?').bind(slug).first()) slug = `${slugify(title).slice(0, 44)}-${Math.random().toString(36).slice(2, 7)}`;
  const id = rid(), pub = raw.public === false ? 0 : 1;
  await db.prepare('INSERT INTO collections (id, slug, owner_id, title, description, public, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(id, slug, uid, title, clean(raw.description, LIMITS.description) || null, pub, t, t).run();
  return { id, slug, title, public: !!pub };
}

/** Changes a list's title, description or whether it is public. */
export async function updateCollection(db, uid, idOrSlug, raw = {}, t = now()) {
  const c = await mine(db, uid, idOrSlug);
  const title = raw.title !== undefined ? clean(raw.title, LIMITS.title) : c.title;
  if (!title) throw new CollectionError(400, 'A list needs a title.', 'bad_request');
  const description = raw.description !== undefined ? clean(raw.description, LIMITS.description) || null : c.description;
  const pub = raw.public !== undefined ? (raw.public ? 1 : 0) : c.public;
  await db.prepare('UPDATE collections SET title = ?, description = ?, public = ?, updated_at = ? WHERE id = ?').bind(title, description, pub, t, c.id).run();
  return { ok: true, slug: c.slug };
}

export async function deleteCollection(db, uid, idOrSlug) {
  const c = await mine(db, uid, idOrSlug);
  await db.batch(['collection_games', 'collection_follows'].map((tb) => db.prepare(`DELETE FROM ${tb} WHERE collection_id = ?`).bind(c.id)).concat(db.prepare('DELETE FROM collections WHERE id = ?').bind(c.id)));
  return { ok: true };
}

/** Adds a live game to the end of a list (or updates its note when it is there). */
export async function addGame(db, uid, idOrSlug, game, note, t = now()) {
  const c = await mine(db, uid, idOrSlug);
  const p = await db.prepare(`SELECT p.id FROM projects p WHERE (p.id = ? OR p.slug = ?) AND ${LIVE}`).bind(game, game).first();
  if (!p) throw new CollectionError(404, 'Only live games can go on a list.', 'not_found');
  const n = clean(note, LIMITS.note) || null;
  const has = await db.prepare('SELECT 1 AS x FROM collection_games WHERE collection_id = ? AND project_id = ?').bind(c.id, p.id).first();
  if (has) {
    if (note !== undefined) await db.prepare('UPDATE collection_games SET note = ? WHERE collection_id = ? AND project_id = ?').bind(n, c.id, p.id).run();
  } else {
    const row = await db.prepare('SELECT COUNT(*) AS n, COALESCE(MAX(position), -1) AS last FROM collection_games WHERE collection_id = ?').bind(c.id).first();
    if (row.n >= LIMITS.games) throw new CollectionError(409, `A list holds at most ${LIMITS.games} games.`, 'too_many');
    await db.prepare('INSERT INTO collection_games (collection_id, project_id, position, note, added_at) VALUES (?, ?, ?, ?, ?)').bind(c.id, p.id, row.last + 1, n, t).run();
  }
  await db.prepare('UPDATE collections SET updated_at = ? WHERE id = ?').bind(t, c.id).run();
  return { ok: true, added: !has };
}

export async function removeGame(db, uid, idOrSlug, game, t = now()) {
  const c = await mine(db, uid, idOrSlug);
  const r = await db.prepare('DELETE FROM collection_games WHERE collection_id = ? AND project_id IN (SELECT id FROM projects WHERE id = ? OR slug = ?)').bind(c.id, game, game).run();
  if (!r.meta?.changes) throw new CollectionError(404, 'That game is not on the list.', 'not_found');
  await db.prepare('UPDATE collections SET updated_at = ? WHERE id = ?').bind(t, c.id).run();
  return { ok: true };
}

/** Puts the list's games in this order (game ids); games left out keep their place after them. */
export async function reorder(db, uid, idOrSlug, ids) {
  const c = await mine(db, uid, idOrSlug);
  const cur = (await db.prepare('SELECT project_id FROM collection_games WHERE collection_id = ? ORDER BY position').bind(c.id).all()).results.map((r) => r.project_id);
  const want = (Array.isArray(ids) ? ids : []).map(String).filter((id) => cur.includes(id));
  const order = [...new Set(want), ...cur.filter((id) => !want.includes(id))];
  await db.batch(order.map((id, i) => db.prepare('UPDATE collection_games SET position = ? WHERE collection_id = ? AND project_id = ?').bind(i, c.id, id)));
  return { ok: true };
}

const covers = async (db, id) => (await db.prepare(`SELECT p.slug, p.title, p.cover_key, p.id FROM collection_games g JOIN projects p ON p.id = g.project_id WHERE g.collection_id = ? AND ${LIVE} AND COALESCE(p.age, 0) < 18 ORDER BY g.position LIMIT 4`).bind(id).all()).results;
const countLive = async (db, id) => (await db.prepare(`SELECT COUNT(*) AS n FROM collection_games g JOIN projects p ON p.id = g.project_id WHERE g.collection_id = ? AND ${LIVE}`).bind(id).first())?.n || 0;
async function summary(db, c) {
  return { id: c.id, slug: c.slug, title: c.title, description: c.description, public: !!c.public, staff_pick: !!c.staff_pick, followers: c.followers, owner: { id: c.owner_id, name: c.owner_name }, games: await countLive(db, c.id), covers: await covers(db, c.id), updated_at: c.updated_at };
}
const WITH_OWNER = 'SELECT c.*, u.name AS owner_name FROM collections c JOIN users u ON u.id = c.owner_id';

/** The lists page: staff picks, the most followed, the viewer's own and the ones they follow. Empty lists are not shown. */
export async function browse(db, uid, limit = 24) {
  const pub = `c.public = 1 AND c.hidden_at IS NULL AND EXISTS (SELECT 1 FROM collection_games g JOIN projects p ON p.id = g.project_id WHERE g.collection_id = c.id AND ${LIVE})`;
  const map = async (rows) => Promise.all(rows.map((c) => summary(db, c)));
  return {
    staff: await map((await db.prepare(`${WITH_OWNER} WHERE ${pub} AND c.staff_pick = 1 ORDER BY c.updated_at DESC LIMIT ?`).bind(limit).all()).results),
    popular: await map((await db.prepare(`${WITH_OWNER} WHERE ${pub} AND c.staff_pick = 0 ORDER BY c.followers DESC, c.updated_at DESC LIMIT ?`).bind(limit).all()).results),
    mine: uid ? await map((await db.prepare(`${WITH_OWNER} WHERE c.owner_id = ? ORDER BY c.updated_at DESC`).bind(uid).all()).results) : [],
    following: uid ? await map((await db.prepare(`${WITH_OWNER} JOIN collection_follows f ON f.collection_id = c.id AND f.user_id = ? WHERE c.public = 1 AND c.hidden_at IS NULL ORDER BY f.at DESC LIMIT 100`).bind(uid).all()).results) : [],
  };
}

/** Staff picks for the home page shelf. */
export async function staffPicks(db, limit = 6) {
  return (await browse(db, null, limit)).staff;
}

/** One list's page: its live games with notes, for anyone when public, only its owner when private. */
export async function view(db, slug, uid, isAdmin = false) {
  const c = await db.prepare(`${WITH_OWNER} WHERE c.slug = ?`).bind(slug).first();
  const own = !!c && c.owner_id === uid;
  if (!c || (!own && !isAdmin && (!c.public || c.hidden_at))) throw new CollectionError(404, 'No such list.', 'not_found');
  const games = (await db.prepare(`SELECT p.*, u.name AS author, g.note, g.position FROM collection_games g JOIN projects p ON p.id = g.project_id JOIN users u ON u.id = p.owner_id WHERE g.collection_id = ? AND ${LIVE} ORDER BY g.position`).bind(c.id).all()).results;
  const following = uid && !own ? !!(await db.prepare('SELECT 1 AS x FROM collection_follows WHERE collection_id = ? AND user_id = ?').bind(c.id, uid).first()) : false;
  return { collection: { ...(await summary(db, c)), hidden: !!c.hidden_at }, games, mine: own, following };
}

/** The viewer's lists, each saying whether this game is on it (the game page's "Add to list"). */
export async function listsFor(db, uid, projectId) {
  return (await db.prepare('SELECT c.id, c.slug, c.title, c.public, EXISTS (SELECT 1 FROM collection_games g WHERE g.collection_id = c.id AND g.project_id = ?) AS has FROM collections c WHERE c.owner_id = ? ORDER BY c.updated_at DESC').bind(projectId, uid).all()).results
    .map((r) => ({ id: r.id, slug: r.slug, title: r.title, public: !!r.public, has: !!r.has }));
}

export async function follow(db, uid, slug, on = true, t = now()) {
  if (!uid) throw new CollectionError(401, 'Sign in to follow a list.', 'unauthenticated');
  const c = await db.prepare('SELECT id, owner_id, public, hidden_at FROM collections WHERE slug = ?').bind(slug).first();
  if (!c || !c.public || c.hidden_at) throw new CollectionError(404, 'No such list.', 'not_found');
  if (c.owner_id === uid) throw new CollectionError(409, 'This is your own list.', 'own');
  if (on) {
    const n = (await db.prepare('SELECT COUNT(*) AS n FROM collection_follows WHERE user_id = ?').bind(uid).first())?.n || 0;
    if (n >= LIMITS.following) throw new CollectionError(409, `You can follow at most ${LIMITS.following} lists.`, 'too_many');
    const r = await db.prepare('INSERT INTO collection_follows (collection_id, user_id, at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING').bind(c.id, uid, t).run();
    if (r.meta?.changes) await db.prepare('UPDATE collections SET followers = followers + 1 WHERE id = ?').bind(c.id).run();
  } else {
    const r = await db.prepare('DELETE FROM collection_follows WHERE collection_id = ? AND user_id = ?').bind(c.id, uid).run();
    if (r.meta?.changes) await db.prepare('UPDATE collections SET followers = MAX(0, followers - 1) WHERE id = ?').bind(c.id).run();
  }
  return { ok: true, following: on };
}

/** An admin marks a staff pick, or takes a list down (hidden) or puts it back. */
export async function moderate(db, slug, { staff_pick, hidden } = {}, t = now()) {
  const c = await db.prepare('SELECT id FROM collections WHERE slug = ? OR id = ?').bind(slug, slug).first();
  if (!c) throw new CollectionError(404, 'No such list.', 'not_found');
  if (staff_pick !== undefined) await db.prepare('UPDATE collections SET staff_pick = ? WHERE id = ?').bind(staff_pick ? 1 : 0, c.id).run();
  if (hidden !== undefined) await db.prepare('UPDATE collections SET hidden_at = ?, staff_pick = CASE WHEN ? THEN 0 ELSE staff_pick END WHERE id = ?').bind(hidden ? t : null, hidden ? 1 : 0, c.id).run();
  return { ok: true };
}

/** Account deletion: the account's lists and follows go; follower counts of lists they followed drop. */
export function deleteStatements(db, uid) {
  return [
    db.prepare('UPDATE collections SET followers = MAX(0, followers - 1) WHERE id IN (SELECT collection_id FROM collection_follows WHERE user_id = ?)').bind(uid),
    db.prepare('DELETE FROM collection_follows WHERE user_id = ?').bind(uid),
    db.prepare('DELETE FROM collection_follows WHERE collection_id IN (SELECT id FROM collections WHERE owner_id = ?)').bind(uid),
    db.prepare('DELETE FROM collection_games WHERE collection_id IN (SELECT id FROM collections WHERE owner_id = ?)').bind(uid),
    db.prepare('DELETE FROM collections WHERE owner_id = ?').bind(uid),
  ];
}
