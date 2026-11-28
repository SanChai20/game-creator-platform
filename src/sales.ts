// Limited-time sales. A creator puts a paid game on sale: a lower price for a whole number of days. While it runs, the
// store shows the sale price, the regular price struck through and when the sale ends, and checkout charges the sale
// price; once sale_ends_at passes, the game is back at its regular price everywhere, with nothing to clean up.
//
// The rules keep the struck-through price honest: it is the game's regular price, which cannot change while the sale
// runs, and a sale cannot start until sale_gap_days after the last one ended or after the regular price went up (so a
// price is never raised just to be "discounted"). A sale takes at least sale_min_percent_off off, never goes below
// sale_price_min_cents, and lasts at most sale_max_days.
//
// What a buyer paid is recorded from Stripe (purchases.price_cents is the session's amount_total), so a refund, the
// platform cut and the creator's credit all follow the price actually paid, sale or not.
import { bad, forbidden, type Env, type Project } from './env';
import { getSettings, type Settings } from './settings';
import { now } from './util';

export const DAY_MS = 86_400_000;

type SaleCols = Pick<Project, 'price_cents'> & { sale_price_cents?: number | null; sale_starts_at?: number | null; sale_ends_at?: number | null; price_raised_at?: number | null };
type SaleRules = Pick<Settings, 'sales_enabled' | 'sale_max_days' | 'sale_min_percent_off' | 'sale_price_min_cents' | 'sale_gap_days' | 'paid_games_enabled'>;

export interface Sale { price_cents: number; regular_cents: number; percent_off: number; starts_at: number; ends_at: number }

/** The sale running at `at`, or null. A sale only counts on a paid game and below its regular price. */
export function saleOf(p: SaleCols, at = now()): Sale | null {
  const sp = Number(p.sale_price_cents) || 0, ends = Number(p.sale_ends_at) || 0, regular = Number(p.price_cents) || 0;
  if (!(sp > 0) || !(regular > sp) || !(ends > at) || (Number(p.sale_starts_at) || 0) > at) return null;
  return { price_cents: sp, regular_cents: regular, percent_off: percentOff(regular, sp), starts_at: Number(p.sale_starts_at) || 0, ends_at: ends };
}

/** What a buyer pays at `at`: the sale price while a sale runs, otherwise the regular price. */
export const priceNow = (p: SaleCols, at = now()) => saleOf(p, at)?.price_cents ?? (Number(p.price_cents) || 0);

/** Whole percent off, rounded down so "40% off" is never more than the real discount. */
export const percentOff = (regular: number, sale: number) => (regular > 0 ? Math.floor(((regular - sale) * 100) / regular) : 0);

/** SQL for the price a buyer pays now (the `p` alias, one bound parameter: the time). */
export const PRICE_NOW_SQL = 'CASE WHEN p.sale_price_cents > 0 AND p.sale_ends_at > ? AND p.sale_price_cents < p.price_cents THEN p.sale_price_cents ELSE p.price_cents END';

/** When the next sale may start (0 when it may start now). */
export function nextSaleAt(p: SaleCols, s: Pick<Settings, 'sale_gap_days'>): number {
  const gap = Math.max(0, Number(s.sale_gap_days) || 0) * DAY_MS;
  if (!gap) return 0;
  return Math.max(p.sale_ends_at ? Number(p.sale_ends_at) + gap : 0, p.price_raised_at ? Number(p.price_raised_at) + gap : 0);
}

export interface SaleInput { price_cents?: unknown; days?: unknown }

/**
 * Checks a new or changed sale and returns the columns to store. A running sale can be changed (a typo fixed, made
 * longer or shorter) without waiting for the gap; it keeps its start, and its total length stays within sale_max_days.
 */
export function planSale(p: SaleCols, s: SaleRules, input: SaleInput, at = now()): { sale_price_cents: number; sale_starts_at: number; sale_ends_at: number } {
  if (!s.paid_games_enabled) throw forbidden('Paid games are turned off on this platform.');
  if (!s.sales_enabled) throw forbidden('Sales are turned off on this platform.');
  const regular = Number(p.price_cents) || 0;
  if (!(regular > 0)) throw bad('Only a paid game can go on sale. Set a price first (price_cents).');
  const price = Math.round(Number(input.price_cents)), days = Number(input.days);
  if (!Number.isFinite(price) || price <= 0) throw bad('The sale price must be a positive number of US cents (e.g. 299 = $2.99).');
  if (!Number.isInteger(days) || days < 1) throw bad('A sale lasts a whole number of days, at least 1.');
  if (days > s.sale_max_days) throw bad(`A sale can last at most ${s.sale_max_days} days.`);
  if (price < s.sale_price_min_cents) throw bad(`A sale price must be at least ${s.sale_price_min_cents} cents.`);
  const most = Math.floor((regular * (100 - s.sale_min_percent_off)) / 100);
  if (price > most) throw bad(`A sale must take at least ${s.sale_min_percent_off}% off the regular price of ${regular} cents: ${most} cents or less.`);
  const running = saleOf(p, at);
  if (running) {
    const ends = running.starts_at + days * DAY_MS;
    if (ends <= at) throw bad(`This sale started ${Math.ceil((at - running.starts_at) / DAY_MS)} days ago; a ${days}-day sale would already be over. End it instead.`);
    return { sale_price_cents: price, sale_starts_at: running.starts_at, sale_ends_at: ends };
  }
  const next = nextSaleAt(p, s);
  if (next > at) {
    const raised = !!p.price_raised_at && Number(p.price_raised_at) >= (Number(p.sale_ends_at) || 0);
    throw bad(`${raised ? 'The regular price went up recently' : 'This game had a sale recently'}; the next sale can start on ${new Date(next).toISOString().slice(0, 10)} (${s.sale_gap_days} days after${raised ? ' the price change' : ' the last sale ended'}).`);
  }
  return { sale_price_cents: price, sale_starts_at: at, sale_ends_at: at + days * DAY_MS };
}

/** Starts, changes (input) or ends (null) a game's sale. Returns the sale now running, or null. */
export async function setSale(env: Env, s: SaleRules, p: Project, input: SaleInput | null, at = now()): Promise<Sale | null> {
  if (input === null) {
    if (!saleOf(p, at)) return null;
    // ending early: the sale ends now, and the gap before the next one counts from now
    await env.DB.prepare('UPDATE projects SET sale_ends_at = ?, updated_at = ? WHERE id = ?').bind(at, at, p.id).run();
    return null;
  }
  const plan = planSale(p, s, input, at);
  await env.DB.prepare('UPDATE projects SET sale_price_cents = ?, sale_starts_at = ?, sale_ends_at = ?, updated_at = ? WHERE id = ?')
    .bind(plan.sale_price_cents, plan.sale_starts_at, plan.sale_ends_at, at, p.id).run();
  return saleOf({ ...p, ...plan }, at);
}

/** What the creator's console and agent see: the sale running, the last one, and when the next can start. */
export function saleView(p: SaleCols, s: SaleRules, at = now()) {
  const running = saleOf(p, at), next = running ? 0 : nextSaleAt(p, s);
  return {
    enabled: !!s.sales_enabled && !!s.paid_games_enabled,
    running,
    last: !running && Number(p.sale_price_cents) > 0 && p.sale_ends_at ? { price_cents: Number(p.sale_price_cents), starts_at: Number(p.sale_starts_at) || 0, ended_at: Number(p.sale_ends_at) } : null,
    next_sale_at: next > at ? next : null,
    rules: { max_days: s.sale_max_days, min_percent_off: s.sale_min_percent_off, min_price_cents: s.sale_price_min_cents, gap_days: s.sale_gap_days },
  };
}

/** A sale checkout's Stripe expires_at (seconds): when the sale ends, within Stripe's 30 minutes to 24 hours. */
export function checkoutExpiry(saleEndsAt: number, at = now()): number {
  return Math.floor(Math.max(at + 31 * 60_000, Math.min(saleEndsAt, at + 23 * 3_600_000)) / 1000);
}

const usd = (c: number) => '$' + (c / 100).toFixed(2);

/** The console and the agent's update_project: `raw` is {price_cents, days} to start or change a sale, null to end it. */
export async function applySale(env: Env, p: Project, raw: unknown, actor: string): Promise<Sale | null> {
  const s = await getSettings(env), at = now();
  if (raw !== null && (typeof raw !== 'object' || Array.isArray(raw))) throw bad('sale must be {price_cents, days} to start or change a sale, or null to end it.');
  const before = saleOf(p, at), sale = await setSale(env, s, p, raw as SaleInput | null, at);
  const insert = (detail: string) => env.DB.prepare('INSERT INTO events (project_id, kind, detail, version, actor, created_at) VALUES (?, ?, ?, NULL, ?, ?)').bind(p.id, 'sale', detail, actor.slice(0, 80), at).run();
  // a new sale is news for the players who wished for the game (src/wishlist-news.ts)
  // (loaded on demand: it reaches players' open pages through the social Durable Object)
  if (sale && !before && p.status === 'live') await import('./wishlist-news').then((m) => m.wishSale(env, p.id, sale.starts_at)).catch((e) => console.warn('wishlist sale', String(e)));
  if (sale) await insert(`${before ? 'Sale changed' : 'Sale started'}: ${usd(sale.price_cents)} (${sale.percent_off}% off ${usd(sale.regular_cents)}) until ${new Date(sale.ends_at).toISOString().slice(0, 16).replace('T', ' ')} UTC`);
  else if (before) await insert('Sale ended early');
  return sale;
}
