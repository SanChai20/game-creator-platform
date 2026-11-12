// Shared plumbing for the web app: language, API client, a tiny router, session state and small components.
import { createContext, useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type MouseEvent, type ReactNode } from 'react';

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
export const Spinner = () => <div className="spinner" role="status" aria-label={t('Loading', '加载中')} />;
export function Fail({ error, retry }: { error: ApiError; retry?: () => void }) {
  return <div className="notice bad row wrapx"><span className="grow">{error.message}{error.hint ? ` ${error.hint}` : ''}</span>{retry && <button className="btn sm" onClick={retry}>{t('Try again', '重试')}</button>}</div>;
}
export function Modal({ children, onClose, wide }: { children: ReactNode; onClose: () => void; wide?: boolean }) {
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); }; addEventListener('keydown', k); return () => removeEventListener('keydown', k); }, [onClose]);
  return <div className="modal" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}><div role="dialog" aria-modal="true" className={wide ? 'wide' : ''}>{children}</div></div>;
}
export function Code({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  const copy = () => { void navigator.clipboard?.writeText(text).then(() => { setDone(true); setTimeout(() => setDone(false), 1400); }); };
  return <div className="code">{text}<button className="btn sm copy" onClick={copy}>{done ? t('Copied', '已复制') : t('Copy', '复制')}</button></div>;
}
export function Bars({ data, tip }: { data: { label: string; value: number }[]; tip: (d: { label: string; value: number }) => string }) {
  const max = Math.max(1, ...data.map((d) => d.value));
  return <div className="bars">{data.map((d) => <div key={d.label} data-tip={tip(d)} style={{ height: `${Math.max(2, (d.value / max) * 100)}%`, background: d.value ? undefined : 'var(--ink-2)' }} />)}</div>;
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
export interface GameCard { id: string; slug: string; title: string; tagline: string; tags: string[]; cover: string | null; price_cents: number; plays: number; minutes: number; rating: number | null; rating_count: number; author: string; featured: boolean; published_at: number | null; status: string }
export function GameTile({ g, to }: { g: GameCard; to?: string }) {
  return (
    <Link to={to || `/g/${g.slug}`} className="game">
      <div className="art" style={g.cover ? undefined : artStyle(g.slug)}>
        {g.cover ? <img src={g.cover} alt="" loading="lazy" /> : <div className="mono-title">{g.title}</div>}
        {g.featured && <span className="badge sig feat">{t('Featured', '精选')}</span>}
        <span className={'price' + (g.price_cents > 0 ? ' paid' : '')}>{price(g.price_cents)}</span>
      </div>
      <div>
        <h3 className="clip">{g.title}</h3>
        <div className="meta"><span className="clip">{g.author}</span><span className="dim">·</span><Stars rating={g.rating} count={g.rating_count} /><span className="right num">{count(g.plays, 'play', 'plays', '次游玩')}</span></div>
      </div>
    </Link>
  );
}
export function StatusBadge({ status }: { status: string }) {
  const map: Record<string, [string, string]> = {
    live: ['good', t('Live', '已上线')], draft: ['', t('Draft', '草稿')], offline: ['sig', t('Offline', '已下线')], removed: ['bad', t('Removed', '已移除')],
    verified: ['good', t('Verified', '已验证')], failed: ['bad', t('Failed', '未通过')], queued: ['info', t('Queued', '排队中')], deploying: ['info', t('Deploying', '部署中')], verifying: ['info', t('Verifying', '验证中')],
    paid: ['good', t('Paid', '已支付')], pending: ['sig', t('Pending', '处理中')], rejected: ['bad', t('Rejected', '已拒绝')], refunded: ['', t('Refunded', '已退款')],
    active: ['good', t('Active', '正常')], suspended: ['bad', t('Suspended', '已停用')],
  };
  const [cls, label] = map[status] || ['', status];
  return <span className={'badge ' + cls}>{label}</span>;
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
