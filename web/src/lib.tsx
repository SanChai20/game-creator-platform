// Shared plumbing for the web app: language, API client, a tiny router, session state and small components.
import { createContext, useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type MouseEvent, type PointerEvent as RPointerEvent, type ReactNode } from 'react';
import { Button, Notice } from './ui/components';
// Components that used to live here; kept as re-exports so existing imports keep working. New code imports from './ui'.
export { Bars, Code, Modal, Spinner, StatusBadge } from './ui/components';

// ---- language ---------------------------------------------------------------------------------
export type Lang = 'en' | 'zh';
const stored = (() => { try { return localStorage.getItem('gcp.lang'); } catch { return null; } })();
let lang: Lang = stored === 'zh' || stored === 'en' ? stored : (navigator.language || '').toLowerCase().startsWith('zh') ? 'zh' : 'en';
const langSubs = new Set<() => void>();
/** Pick the string for the current language. */
export const t = (en: string, zh: string) => (lang === 'zh' ? zh : en);
export const getLang = () => lang;
export function setLang(l: Lang) { lang = l; try { localStorage.setItem('gcp.lang', l); } catch { /* private mode */ } document.documentElement.lang = l === 'zh' ? 'zh-CN' : 'en'; langSubs.forEach((f) => f()); }
export const useLang = () => useSyncExternalStore((f) => { langSubs.add(f); return () => langSubs.delete(f); }, getLang);
document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';

// ---- formatting -------------------------------------------------------------------------------
export const usd = (cents: number) => `${cents < 0 ? '−' : ''}$${(Math.abs(cents || 0) / 100).toFixed(2)}`;
export const price = (cents: number) => (cents > 0 ? usd(cents) : t('Free', '免费'));
export const num = (n: number) => new Intl.NumberFormat(lang === 'zh' ? 'zh-CN' : 'en', { notation: 'compact', maximumFractionDigits: 1 }).format(n || 0);
/** A number with its unit, singular or plural in English. */
export const count = (n: number, one: string, many: string, zh: string) => `${num(n)} ${t(n === 1 ? one : many, zh)}`;
export const date = (ms: number | null | undefined) => (ms ? new Intl.DateTimeFormat(lang === 'zh' ? 'zh-CN' : 'en', { year: 'numeric', month: 'short', day: 'numeric' }).format(new Date(ms)) : '—');
export const dateTime = (ms: number | null | undefined) => (ms ? new Intl.DateTimeFormat(lang === 'zh' ? 'zh-CN' : 'en', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(ms)) : '—');
export function ago(ms: number | null | undefined) {
  if (!ms) return '—';
  const s = Math.max(1, Math.round((Date.now() - ms) / 1000)), rtf = new Intl.RelativeTimeFormat(lang === 'zh' ? 'zh-CN' : 'en', { numeric: 'auto' });
  if (s < 60) return rtf.format(-s, 'second'); if (s < 3600) return rtf.format(-Math.round(s / 60), 'minute');
  if (s < 86400) return rtf.format(-Math.round(s / 3600), 'hour'); if (s < 86400 * 30) return rtf.format(-Math.round(s / 86400), 'day');
  return date(ms);
}
export const bytes = (n: number) => (n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : n > 1024 ? Math.round(n / 1024) + ' KB' : (n || 0) + ' B');
export const playTime = (seconds: number) => { const m = Math.round((seconds || 0) / 60); return m >= 120 ? `${num(m / 60)} ${t('h', '小时')}` : `${num(m)} ${t('min', '分钟')}`; };

// ---- API --------------------------------------------------------------------------------------
export class ApiError extends Error { constructor(msg: string, public status: number, public code?: string, public hint?: string) { super(msg); } }
export async function api<T = any>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const r = await fetch('/api' + path, {
    method: opts.method || (opts.body !== undefined ? 'POST' : 'GET'), credentials: 'same-origin',
    headers: opts.body !== undefined ? { 'content-type': 'application/json' } : undefined, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new ApiError(j.error || `${t('Request failed', '请求失败')} (${r.status})`, r.status, j.code, j.hint);
  return j as T;
}
export function useData<T = any>(path: string | null) {
  const [state, set] = useState<{ data: T | null; error: ApiError | null; loading: boolean }>({ data: null, error: null, loading: !!path });
  const seq = useRef(0);
  const reload = useCallback(() => {
    if (!path) return Promise.resolve();
    const n = ++seq.current;
    return api<T>(path).then((data) => { if (n === seq.current) set({ data, error: null, loading: false }); }, (error) => { if (n === seq.current) set((s) => ({ data: s.data, error, loading: false })); });
  }, [path]);
  useEffect(() => { set((s) => ({ ...s, loading: !!path })); void reload(); }, [reload, path]);
  return { ...state, reload };
}

// ---- router -----------------------------------------------------------------------------------
const navSubs = new Set<() => void>();
window.addEventListener('popstate', () => navSubs.forEach((f) => f()));
export function navigate(to: string, replace = false) {
  if (to === location.pathname + location.search) return;
  const samePath = to.split('?')[0] === location.pathname;
  history[replace ? 'replaceState' : 'pushState'](null, '', to); navSubs.forEach((f) => f());
  if (!replace && !samePath) window.scrollTo(0, 0);
}
export const useLocation = () => useSyncExternalStore((f) => { navSubs.add(f); return () => navSubs.delete(f); }, () => location.pathname + location.search);
export const query = () => new URLSearchParams(location.search);
export function Link({ to, className, children, onClick, title }: { to: string; className?: string; children: ReactNode; onClick?: () => void; title?: string }) {
  const go = (e: MouseEvent) => { if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return; e.preventDefault(); onClick?.(); navigate(to); };
  return <a href={to} className={className} onClick={go} title={title}>{children}</a>;
}

// ---- session ----------------------------------------------------------------------------------
export interface Me { id: string; email: string; name: string; role: string; creator: boolean; payouts_enabled: boolean; has_payout_account: boolean; payout_country: string | null }
export interface Config { settings: Record<string, any>; payments: boolean; mcp_url: string; origin: string }
export interface AppState { user: Me | null; config: Config; refresh: () => Promise<void>; toast: (msg: string, bad?: boolean) => void }
export const AppCtx = createContext<AppState>(null as unknown as AppState);
export const useApp = () => useContext(AppCtx);
export const loginUrl = (next = location.pathname + location.search) => `/login?next=${encodeURIComponent(next)}`;

// ---- small components -------------------------------------------------------------------------
export const Star = () => <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 1.6l2.6 5.4 5.9.8-4.3 4.1 1 5.9L10 15l-5.2 2.8 1-5.9L1.5 7.8l5.9-.8z" /></svg>;
export function Stars({ rating, count }: { rating: number | null; count?: number }) {
  if (rating == null) return <span className="dim">{t('No ratings yet', '暂无评分')}</span>;
  return <span className="stars"><Star />{rating.toFixed(1)}{count != null && <span className="mute" style={{ fontWeight: 450 }}>({num(count)})</span>}</span>;
}
export function Fail({ error, retry }: { error: ApiError; retry?: () => void }) {
  return <Notice tone="bad" role="alert" actions={retry && <Button size="sm" onClick={retry}>{t('Try again', '重试')}</Button>}>{error.message}{error.hint ? ` ${error.hint}` : ''}</Notice>;
}
/** The last `days` calendar days as YYYY-MM-DD (UTC), oldest first, filled from rows keyed by day. */
export function series<T extends { day: string }>(rows: T[], days: number, pick: (r: T) => number) {
  const by = new Map(rows.map((r) => [r.day, r])), out: { label: string; value: number }[] = [];
  for (let i = days - 1; i >= 0; i--) { const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10), r = by.get(d); out.push({ label: d, value: r ? pick(r) : 0 }); }
  return out;
}
/** Deterministic cover art for games that have no screenshot yet, so every card still looks like its own thing. */
export function artStyle(seed: string): CSSProperties {
  let h = 2166136261; for (let i = 0; i < seed.length; i++) { h ^= seed.charCodeAt(i); h = Math.imul(h, 16777619); } h >>>= 0;
  const a = h % 360, b = (a + 35 + ((h >> 9) % 90)) % 360, x = 15 + ((h >> 4) % 70), y = 10 + ((h >> 13) % 60);
  return { background: `radial-gradient(90% 80% at ${x}% ${y}%, hsl(${a} 78% 58% / .95), transparent 62%), radial-gradient(70% 70% at ${100 - x}% ${100 - y}%, hsl(${b} 70% 45% / .8), transparent 65%), linear-gradient(135deg, hsl(${b} 40% 18%), hsl(${a} 45% 9%))` };
}
export interface GameCard { id: string; slug: string; title: string; tagline: string; tags: string[]; cover: string | null; price_cents: number; plays: number; minutes: number; rating: number | null; rating_count: number; author: string; featured: boolean; published_at: number | null; status: string; playing?: number }
/** How rare a game is as a collectible: earned from ratings and plays (featured games are Legendary). */
export type Rarity = 'common' | 'rare' | 'epic' | 'legendary';
export function rarity(g: Pick<GameCard, 'rating' | 'rating_count' | 'plays' | 'featured'>): Rarity {
  const r = g.rating_count >= 3 ? g.rating ?? 0 : 0;
  if (g.featured || (r >= 4.8 && g.rating_count >= 100)) return 'legendary';
  if ((r >= 4.5 && g.rating_count >= 20) || g.plays >= 10000) return 'epic';
  if (r >= 4 || g.plays >= 500) return 'rare';
  return 'common';
}
export const RARITY: Record<Rarity, { color: string; foil: number; name: () => string }> = {
  common: { color: '#a9a4b8', foil: 0.1, name: () => t('Common', '普通') },
  rare: { color: '#3fe0ff', foil: 0.3, name: () => t('Rare', '稀有') },
  epic: { color: '#8b6bff', foil: 0.6, name: () => t('Epic', '史诗') },
  legendary: { color: '#ffc845', foil: 1, name: () => t('Legendary', '传说') },
};
export const rarityHint = () => t('Rarity is earned from ratings and plays.', '稀有度由评分和游玩次数决定。');

/** A game as a collectible card: rarity edge, a foil sheen that follows the pointer, a slight tilt. */
export function GameTile({ g, to, fresh }: { g: GameCard; to?: string; fresh?: boolean }) {
  const rar = rarity(g);
  const move = (e: RPointerEvent<HTMLDivElement>) => {
    if (e.pointerType !== 'mouse') return;
    const el = e.currentTarget, r = el.getBoundingClientRect(), x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
    el.style.setProperty('--mx', `${(x * 100).toFixed(1)}%`); el.style.setProperty('--my', `${(y * 100).toFixed(1)}%`);
    el.style.setProperty('--rx', `${((0.5 - y) * 7).toFixed(2)}deg`); el.style.setProperty('--ry', `${((x - 0.5) * 9).toFixed(2)}deg`);
  };
  const leave = (e: RPointerEvent<HTMLDivElement>) => { const el = e.currentTarget; el.style.removeProperty('--rx'); el.style.removeProperty('--ry'); };
  return (
    <Link to={to || `/g/${g.slug}`} className={`game r-${rar}`}>
      <div className="card-in" onPointerMove={move} onPointerLeave={leave} style={{ '--rc': RARITY[rar].color } as CSSProperties}>
        <div className="art" style={g.cover ? undefined : artStyle(g.slug)}>
          {g.cover ? <img src={g.cover} alt="" loading="lazy" /> : <div className="mono-title">{g.title}</div>}
          <span className={'price' + (g.price_cents > 0 ? ' paid' : '')}>{price(g.price_cents)}</span>
          <span className="play-hint" aria-hidden="true" />
        </div>
        <div className="card-body">
          <div className="card-tag"><span className="rar" title={rarityHint()}>{RARITY[rar].name()}</span>{fresh && <span className="new">{t('New', '新上架')}</span>}{!fresh && g.featured && <span className="feat">{t('Featured', '精选')}</span>}{!!g.playing && <span className="live">{num(g.playing)} {t('playing', '人在玩')}</span>}</div>
          <h3 className="clip">{g.title}</h3>
          <div className="meta"><span className="clip">{g.author}</span><Stars rating={g.rating} count={g.rating_count} /><span className="right num">{count(g.plays, 'play', 'plays', '次游玩')}</span></div>
        </div>
        <span className="foil" aria-hidden="true" />
      </div>
    </Link>
  );
}
// ---- return visits (kept in this browser only) ---------------------------------------------------
export interface RecentPlay { slug: string; title: string; cover: string | null; at: number }
const RECENT_KEY = 'gcp.recent', VISIT_KEY = 'gcp.visit', PREV_KEY = 'gcp.prevVisit';
const readJson = <T,>(k: string, d: T, store: Storage | null = null): T => { try { const v = (store || localStorage).getItem(k); return v ? JSON.parse(v) as T : d; } catch { return d; } };
/** Games this browser played lately, newest first, for "Jump back in". */
export const recentPlays = (): RecentPlay[] => readJson<RecentPlay[]>(RECENT_KEY, []).filter((r) => r && r.slug);
export function rememberPlay(g: { slug: string; title: string; cover: string | null }) {
  const list = [{ slug: g.slug, title: g.title, cover: g.cover, at: Date.now() }, ...recentPlays().filter((r) => r.slug !== g.slug)].slice(0, 8);
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(list)); } catch { /* private mode */ }
}
/** When this browser was last here before this visit (null on a first visit). Stays the same for the whole session. */
export function lastVisit(): number | null {
  let prev: number | null;
  try { const s = sessionStorage.getItem(PREV_KEY); if (s !== null) return s === '' ? null : Number(s); } catch { /* fine */ }
  prev = readJson<number | null>(VISIT_KEY, null);
  try { sessionStorage.setItem(PREV_KEY, prev ? String(prev) : ''); localStorage.setItem(VISIT_KEY, String(Date.now())); } catch { /* private mode */ }
  return prev;
}

/** Runs an action, shows a toast on failure, and tells the caller whether it worked. */
export function useAct() {
  const { toast } = useApp(), [busy, setBusy] = useState('');
  const act = useCallback(async (key: string, fn: () => Promise<unknown>, okMsg?: string) => {
    setBusy(key);
    try { await fn(); if (okMsg) toast(okMsg); return true; } catch (e) { toast((e as Error).message, true); return false; } finally { setBusy(''); }
  }, [toast]);
  return { busy, act };
}
