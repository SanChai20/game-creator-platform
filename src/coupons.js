// Coupons and keys. A creator makes discount codes for their own paid game (5 to 90% off the regular price, a number of
// uses, an optional end date) and batches of single-use keys that give the game for free, for streamers, press and
// giveaways. Plain JS over a D1-shaped database (tests/coupons.mjs).
//
// Rules, enforced here and nowhere else:
//   - Only a paid game has codes. At most 20 working discount codes and 1000 working keys per game; up to 100 keys a batch.
//   - A code works while it is not switched off, not past its end date, and has uses left. Each account uses a code once.
//   - A discount comes off the regular price; during a sale the buyer pays whichever is lower. Never below 50 cents,
//     the smallest card payment.
//   - A key gives the game to a signed-in account that does not own it and did not make it. Its purchase is recorded at
//     no charge, with no credit for the creator and nothing to refund; it does not count as a sale.

export const LIMITS = { discounts: 20, keys: 1000, batch: 100, percent_min: 5, percent_max: 90, uses_max: 10000, days_max: 365, note: 80, min_charge_cents: 50 };

export class CouponError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code; }
}
const now = () => Date.now();
const DAY = 86400_000;
const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const randCode = (n) => { const b = crypto.getRandomValues(new Uint8Array(n)); return [...b].map((x) => ALPHA[x % ALPHA.length]).join(''); };
const rid = (p) => p + randCode(12).toLowerCase();

/** A code as typed → its stored form: upper case letters and digits only. */
export const cleanCode = (raw) => String(raw ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 24);
/** A key's stored form shown in groups of five. */
export const showKey = (code) => code.match(/.{1,5}/g).join('-');

const working = `disabled_at IS NULL AND (expires_at IS NULL OR expires_at > ?) AND uses < max_uses`;

function paidGame(p) {
  if (!p || p.status === 'removed') throw new CouponError(404, 'No such game.', 'not_found');
  if (!(p.price_cents > 0)) throw new CouponError(409, 'Codes are for paid games: this game is free.', 'free');
}

/** A discount code: { code?, percent_off, max_uses?, days?, note? }. Returns the row. */
export async function createDiscount(db, p, raw = {}, t = now()) {
  paidGame(p);
  const pct = Math.round(Number(raw.percent_off));
  if (!(pct >= LIMITS.percent_min && pct <= LIMITS.percent_max)) throw new CouponError(400, `percent_off must be ${LIMITS.percent_min} to ${LIMITS.percent_max}.`, 'bad_request');
  const uses = Math.round(Number(raw.max_uses ?? 100));
  if (!(uses >= 1 && uses <= LIMITS.uses_max)) throw new CouponError(400, `max_uses must be 1 to ${LIMITS.uses_max}.`, 'bad_request');
  const days = raw.days == null || raw.days === '' ? null : Math.round(Number(raw.days));
  if (days !== null && !(days >= 1 && days <= LIMITS.days_max)) throw new CouponError(400, `days must be 1 to ${LIMITS.days_max}.`, 'bad_request');
  const code = raw.code ? cleanCode(raw.code) : randCode(8);
  if (code.length < 4) throw new CouponError(400, 'A code has 4 to 24 letters and digits.', 'bad_request');
  const n = (await db.prepare(`SELECT COUNT(*) AS n FROM coupons WHERE project_id = ? AND kind = 'discount' AND ${working}`).bind(p.id, t).first())?.n || 0;
  if (n >= LIMITS.discounts) throw new CouponError(409, `A game has at most ${LIMITS.discounts} working discount codes. Switch one off first.`, 'too_many');
  if (await db.prepare('SELECT 1 AS x FROM coupons WHERE code = ?').bind(code).first()) throw new CouponError(409, 'That code is taken. Choose another.', 'taken');
  const row = { id: rid('cpn_'), project_id: p.id, code, kind: 'discount', percent_off: pct, max_uses: uses, uses: 0, note: String(raw.note ?? '').replace(/\s+/g, ' ').trim().slice(0, LIMITS.note) || null, expires_at: days ? t + days * DAY : null, created_at: t };
  await db.prepare('INSERT INTO coupons (id, project_id, code, kind, percent_off, max_uses, uses, note, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)')
    .bind(row.id, p.id, code, 'discount', pct, uses, row.note, row.expires_at, t).run();
  return row;
}

/** A batch of single-use keys: { count, note? }. Returns { batch, codes }. */
export async function createKeys(db, p, raw = {}, t = now()) {
  paidGame(p);
  const count = Math.round(Number(raw.count));
  if (!(count >= 1 && count <= LIMITS.batch)) throw new CouponError(400, `count must be 1 to ${LIMITS.batch}.`, 'bad_request');
  const n = (await db.prepare(`SELECT COUNT(*) AS n FROM coupons WHERE project_id = ? AND kind = 'key' AND ${working}`).bind(p.id, t).first())?.n || 0;
  if (n + count > LIMITS.keys) throw new CouponError(409, `A game has at most ${LIMITS.keys} unused keys. ${LIMITS.keys - n} more can be made now.`, 'too_many');
  const batch = rid('kb_'), note = String(raw.note ?? '').replace(/\s+/g, ' ').trim().slice(0, LIMITS.note) || null, codes = [];
  const stmts = [];
  for (let i = 0; i < count; i++) {
    const code = randCode(15);
    codes.push(code);
    stmts.push(db.prepare("INSERT INTO coupons (id, project_id, code, kind, max_uses, uses, batch, note, created_at) VALUES (?, ?, ?, 'key', 1, 0, ?, ?, ?)").bind(rid('key_'), p.id, code, batch, note, t));
  }
  await db.batch(stmts);
  return { batch, note, codes: codes.map(showKey) };
}

/** The game's codes: discount codes one by one, keys by batch. */
export async function listCoupons(db, pid, t = now()) {
  const discounts = (await db.prepare("SELECT id, code, percent_off, max_uses, uses, note, expires_at, created_at, disabled_at FROM coupons WHERE project_id = ? AND kind = 'discount' ORDER BY created_at DESC LIMIT 100").bind(pid).all()).results
    .map((r) => ({ ...r, working: !r.disabled_at && (!r.expires_at || r.expires_at > t) && r.uses < r.max_uses }));
  const batches = (await db.prepare("SELECT batch, note, MIN(created_at) AS created_at, COUNT(*) AS count, SUM(uses) AS used, SUM(CASE WHEN disabled_at IS NOT NULL AND uses = 0 THEN 1 ELSE 0 END) AS off FROM coupons WHERE project_id = ? AND kind = 'key' GROUP BY batch, note ORDER BY created_at DESC LIMIT 100").bind(pid).all()).results;
  return { discounts, batches };
}

/** The keys of one batch (for the creator to hand out), with whether each was used. */
export async function batchKeys(db, pid, batch) {
  return (await db.prepare("SELECT code, uses, disabled_at FROM coupons WHERE project_id = ? AND kind = 'key' AND batch = ? ORDER BY rowid").bind(pid, batch).all()).results
    .map((r) => ({ key: showKey(r.code), used: r.uses > 0, off: !!r.disabled_at }));
}

/** Switches off one discount code (id) or the unused keys of a batch (batch). */
export async function disable(db, pid, { id, batch } = {}, t = now()) {
  const r = id ? await db.prepare('UPDATE coupons SET disabled_at = ? WHERE id = ? AND project_id = ? AND disabled_at IS NULL').bind(t, id, pid).run()
    : await db.prepare("UPDATE coupons SET disabled_at = ? WHERE batch = ? AND project_id = ? AND kind = 'key' AND uses = 0 AND disabled_at IS NULL").bind(t, String(batch || ''), pid).run();
  if (!r.meta?.changes) throw new CouponError(404, 'Nothing to switch off.', 'not_found');
  return { ok: true, switched_off: r.meta.changes };
}

/** A code that works now, with its game; null when it does not. */
export async function lookup(db, raw, t = now()) {
  const code = cleanCode(raw);
  if (code.length < 4) return null;
  return db.prepare(`SELECT c.*, p.slug, p.title, p.owner_id, p.price_cents, p.status AS game_status FROM coupons c JOIN projects p ON p.id = c.project_id
      WHERE c.code = ? AND c.disabled_at IS NULL AND (c.expires_at IS NULL OR c.expires_at > ?) AND c.uses < c.max_uses AND p.status = 'live' AND p.hidden_at IS NULL`).bind(code, t).first();
}

/** What the buyer pays with a discount code: off the regular price, or the sale price when lower, at least 50 cents.
 * @param {number} regularCents @param {number} percentOff @param {number | null} [saleCents] */
export function discounted(regularCents, percentOff, saleCents = null) {
  const off = Math.round(regularCents * (100 - percentOff) / 100);
  return Math.max(Math.min(LIMITS.min_charge_cents, regularCents), Math.min(off, saleCents ?? Infinity));
}

/** Checks a discount code for this buyer and game before checkout. Returns the coupon row. */
export async function checkDiscount(db, raw, p, uid, t = now()) {
  const c = await lookup(db, raw, t);
  if (!c || c.kind !== 'discount' || c.project_id !== p.id) throw new CouponError(404, 'That code does not work for this game. It may have run out or ended.', 'bad_code');
  if (await db.prepare('SELECT 1 AS x FROM coupon_uses WHERE coupon_id = ? AND user_id = ?').bind(c.id, uid).first()) throw new CouponError(409, 'You already used this code.', 'used');
  return c;
}

/** After a paid checkout that carried a discount code: the use is counted once per account. */
export async function countDiscountUse(db, couponId, uid, ref, t = now()) {
  const r = await db.prepare('INSERT INTO coupon_uses (coupon_id, user_id, ref, at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING').bind(couponId, uid, ref, t).run();
  if (r.meta?.changes) await db.prepare('UPDATE coupons SET uses = uses + 1 WHERE id = ?').bind(couponId).run();
  return !!r.meta?.changes;
}

/** Redeems a key: the game is the account's, at no charge. Returns { slug, title }. */
export async function redeemKey(db, raw, uid, t = now()) {
  if (!uid) throw new CouponError(401, 'Sign in to redeem a key.', 'unauthenticated');
  const c = await lookup(db, raw, t);
  if (!c || c.kind !== 'key') throw new CouponError(404, 'That key does not work. It may have been used already.', 'bad_code');
  if (c.owner_id === uid) throw new CouponError(409, 'This is your own game.', 'own_game');
  if (await db.prepare("SELECT 1 AS x FROM purchases WHERE user_id = ? AND project_id = ? AND status = 'paid'").bind(uid, c.project_id).first()) throw new CouponError(409, 'You already own this game. Keep the key for someone else.', 'owned');
  // take the key first: of two accounts redeeming it at once, only one gets it
  const took = await db.prepare(`UPDATE coupons SET uses = uses + 1 WHERE id = ? AND uses < max_uses AND disabled_at IS NULL`).bind(c.id).run();
  if (!took.meta?.changes) throw new CouponError(409, 'That key was just used.', 'bad_code');
  const pid = 'pur_' + randCode(20).toLowerCase();
  try { await db.prepare("INSERT INTO purchases (id, user_id, project_id, owner_id, price_cents, fee_cents, net_cents, provider, provider_ref, status, created_at) VALUES (?, ?, ?, ?, 0, 0, 0, 'key', ?, 'paid', ?)").bind(pid, uid, c.project_id, c.owner_id, 'key:' + c.id, t).run(); }
  catch (e) {
    // bought or redeemed at the same moment: the key goes back unused
    await db.prepare('UPDATE coupons SET uses = uses - 1 WHERE id = ? AND uses > 0').bind(c.id).run();
    if (/UNIQUE/i.test(String(e?.message))) throw new CouponError(409, 'You already own this game. Keep the key for someone else.', 'owned');
    throw e;
  }
  await db.batch([
    db.prepare('INSERT INTO coupon_uses (coupon_id, user_id, ref, at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING').bind(c.id, uid, pid, t),
  ]);
  return { slug: c.slug, title: c.title, project_id: c.project_id };
}
