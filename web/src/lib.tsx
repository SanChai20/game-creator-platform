// Shared plumbing for the web app: language, API client, a tiny router, session state and small components.
import { createContext, useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore, type AnchorHTMLAttributes, type CSSProperties, type MouseEvent, type ReactNode } from 'react';
import { Button, Notice } from './ui/components';
import { detectLang, langTag, matchLang, type Lang } from './i18n/langs';
import { hue as tone } from './ui/tokens';
// Components that used to live here; kept as re-exports so existing imports keep working. New code imports from './ui'.
export { Bars, Code, Modal, Spinner, StatusBadge } from './ui/components';

// ---- language ---------------------------------------------------------------------------------
// Six languages. Call sites carry English and 简体中文 inline: t('Play', '游玩'). The other four (繁體中文, 日本語, 한국어,
// Español) live in i18n/<code>.json keyed by the English string and load only when picked. Strings that arrive from the
// Worker in English (admin setting labels and groups) are translated with tr(), from the same files plus i18n/zh.json.
// The same English word can mean two things ('Copy' a link, a 'Copy' of a game): a key 'English|简体中文' picks one.
// Placeholders: t('Page {page} of {pages}', '第 {page} / {pages} 页', { page, pages }). `npm test` fails on any string
// that is missing from a language, so new strings get translated when they are added.
export { LANGS } from './i18n/langs';
export type { Lang };
const urlLang = (() => { try { return matchLang(new URLSearchParams(location.search).get('lang')); } catch { return null; } })();
const stored = (() => { try { return matchLang(localStorage.getItem('gcp.lang')); } catch { return null; } })();
let lang: Lang = urlLang || stored || detectLang(navigator.languages?.length ? navigator.languages : [navigator.language]);
let dict: Record<string, string> = {};
const DICTS: Record<Exclude<Lang, 'en'>, () => Promise<{ default: Record<string, string> }>> = {
  zh: () => import('./i18n/zh.json'), 'zh-TW': () => import('./i18n/zh-TW.json'), ja: () => import('./i18n/ja.json'), ko: () => import('./i18n/ko.json'), es: () => import('./i18n/es.json'),
};
const loadDict = async (l: Lang) => (l === 'en' ? {} : (await DICTS[l]().catch(() => ({ default: {} }))).default);
const langSubs = new Set<() => void>();
const fill = (s: string, vars?: Record<string, string | number>) => (vars ? s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m)) : s);
/** Pick the string for the current language. English and 简体中文 are given here; the others come from i18n/<lang>.json. */
export const t = (en: string, zh: string, vars?: Record<string, string | number>) =>
  fill(lang === 'en' ? en : lang === 'zh' ? zh : dict[`${en}|${zh}`] ?? dict[en] ?? (lang === 'zh-TW' ? zh : en), vars);
/** Translate a string that arrives in English from the Worker (admin setting labels, groups and options). */
export const tr = (en: string, vars?: Record<string, string | number>) => fill(lang === 'en' ? en : dict[en] ?? en, vars);
/** The current language's BCP 47 tag, for Intl formatters. */
export const locale = () => langTag(lang);
export const getLang = () => lang;
const apply = (l: Lang) => {
  document.documentElement.lang = langTag(l);
  try { document.cookie = `gcp_lang=${l}; path=/; max-age=31536000; samesite=lax`; } catch { /* sandboxed */ }
};
/** Loads the language once, before the first render, so nothing flashes in English. */
export const langReady = loadDict(lang).then((d) => { dict = d; apply(lang); });
export async function setLang(l: Lang) {
  const d = await loadDict(l);
  lang = l; dict = d;
  try { localStorage.setItem('gcp.lang', l); } catch { /* private mode */ }
  apply(l); langSubs.forEach((f) => f());
}
export const useLang = () => useSyncExternalStore((f) => { langSubs.add(f); return () => langSubs.delete(f); }, getLang);

export const usd = (cents: number) => `${cents < 0 ? '−' : ''}$${(Math.abs(cents || 0) / 100).toFixed(2)}`;
export const price = (cents: number) => (cents > 0 ? usd(cents) : t('Free', '免费'));
// Free trials of paid games. The platform can switch them off or cap their length; the app learns that from /config.
let trialRules = { on: true, max: 120 };
export function setTrialRules(s: Record<string, unknown>) { trialRules = { on: s.trials_enabled !== false, max: Number(s.trial_max_minutes) || 120 }; }
/** Minutes of free trial a game offers (0 for none, and always 0 for a free game). */
export const trialOf = (g: { price_cents: number; trial_minutes?: number }) => (trialRules.on && g.price_cents > 0 ? Math.min(g.trial_minutes || 0, trialRules.max) : 0);
/** "Free trial · 30 min", or the short form "30 min trial" for tight spots. */
export const trialLabel = (mins: number, short = false) => (short ? t('{n} min trial', '试玩 {n} 分钟', { n: mins }) : t('Free trial · {n} min', '免费试玩 · {n} 分钟', { n: mins }));
/** m:ss for a countdown. */
export const clock = (sec: number) => { const s = Math.max(0, Math.ceil(sec)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
export const num = (n: number) => new Intl.NumberFormat(locale(), { notation: 'compact', maximumFractionDigits: 1 }).format(n || 0);
/** A number with its unit, singular or plural in English. */
export const count = (n: number, one: string, many: string, zh: string) => { const word = n === 1 ? one : many; return `${num(n)} ${t(word, zh)}`; };
export const date = (ms: number | null | undefined) => (ms ? new Intl.DateTimeFormat(locale(), { year: 'numeric', month: 'short', day: 'numeric' }).format(new Date(ms)) : '—');
export const dateTime = (ms: number | null | undefined) => (ms ? new Intl.DateTimeFormat(locale(), { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(ms)) : '—');
export function ago(ms: number | null | undefined) {
  if (!ms) return '—';
  const s = Math.max(1, Math.round((Date.now() - ms) / 1000)), rtf = new Intl.RelativeTimeFormat(locale(), { numeric: 'auto' });
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
type LinkProps = { to: string; className?: string; children: ReactNode; onClick?: () => void; title?: string; scroll?: boolean } & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href' | 'onClick' | 'className' | 'title' | 'children'>;
/** An in-app link. A same-page link (a filter or a page number) keeps the scroll position unless `scroll` is set. */
export function Link({ to, className, children, onClick, title, scroll, ...rest }: LinkProps) {
  const go = (e: MouseEvent) => { if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return; e.preventDefault(); onClick?.(); navigate(to); if (scroll) window.scrollTo(0, 0); };
  return <a href={to} className={className} onClick={go} title={title} {...rest}>{children}</a>;
}

// ---- session ----------------------------------------------------------------------------------
/** A creator license (src/license.ts). `creator` on Me is true only while it is valid. */
export interface License { active: boolean; plan: 'term' | 'lifetime' | null; until: number | null; since: number | null; expired: boolean }
export interface Me { id: string; email: string; name: string; role: string; creator: boolean; license: License; payouts_enabled: boolean; has_payout_account: boolean; payout_country: string | null }
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
/** Deterministic cover art for games that have no screenshot yet: two flat tones and a sun, so every card still looks like its own thing. */
export function artStyle(seed: string): CSSProperties {
  let h = 2166136261; for (let i = 0; i < seed.length; i++) { h ^= seed.charCodeAt(i); h = Math.imul(h, 16777619); } h >>>= 0;
  const a = h % 360, b = (a + 28 + ((h >> 9) % 40)) % 360, x = 18 + ((h >> 4) % 64), y = 22 + ((h >> 13) % 40), cut = 38 + ((h >> 17) % 30), tilt = 100 + ((h >> 21) % 50);
  return { background: `radial-gradient(circle at ${x}% ${y}%, hsl(${a} 95% 88%) 0 11%, transparent 11.4%), linear-gradient(${tilt}deg, hsl(${a} 78% 62%) 0 ${cut}%, hsl(${b} 62% 44%) ${cut}.3% ${cut + 22}%, hsl(${b} 52% 26%) ${cut + 22}.3%)` };
}
export interface GameCard { id: string; slug: string; title: string; tagline: string; tags: string[]; cover: string | null; price_cents: number; trial_minutes?: number; plays: number; minutes: number; rating: number | null; rating_count: number; author: string; featured: boolean; published_at: number | null; status: string; playing?: number; age?: number | null; mature?: string[]; pick?: 'featured' | 'trending' | 'rising' | 'new' | 'gem' | 'free' | 'more' }
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
  common: { color: 'var(--text-3)', foil: 0.1, name: () => t('Common', '普通') },
  rare: { color: tone.lilac, foil: 0.3, name: () => t('Rare', '稀有') },
  epic: { color: 'var(--accent)', foil: 0.6, name: () => t('Epic', '史诗') },
  legendary: { color: tone.gold, foil: 1, name: () => t('Legendary', '传说') },
};
export const rarityHint = () => t('Rarity is earned from ratings and plays.', '稀有度由评分和游玩次数决定。');

/** A hue for a genre, stable for its name: every category has its own colour across the store. */
export function genreHue(tag: string) {
  let h = 2166136261; for (let i = 0; i < tag.length; i++) { h ^= tag.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) % 360;
}
/** A genre's name: the platform genres are translated, free tags are shown as written. */
export const genreName = (tag: string): string => {
  if (!tag) return '';
  const known: Record<string, () => string> = {
    action: () => t('Action', '动作'), adventure: () => t('Adventure', '冒险'), arcade: () => t('Arcade', '街机'), board: () => t('Board', '桌游'), card: () => t('Card', '卡牌'),
    casual: () => t('Casual', '休闲'), fighting: () => t('Fighting', '格斗'), idle: () => t('Idle', '放置'), music: () => t('Music and rhythm', '音乐节奏'), platformer: () => t('Platformer', '平台跳跃'),
    puzzle: () => t('Puzzle', '解谜'), racing: () => t('Racing', '竞速'), rpg: () => t('RPG', '角色扮演'), roguelike: () => t('Roguelike', 'Roguelike'), sandbox: () => t('Sandbox', '沙盒'),
    shooter: () => t('Shooter', '射击'), simulation: () => t('Simulation', '模拟'), sports: () => t('Sports', '体育'), strategy: () => t('Strategy', '策略'), survival: () => t('Survival', '生存'),
    'tower-defense': () => t('Tower defense', '塔防'), word: () => t('Word and trivia', '文字与问答'), horror: () => t('Horror', '恐怖'), educational: () => t('Educational', '教育'),
    // the platform tag list (web/src/tags.ts)
    multiplayer: () => t('Multiplayer', '多人'), 'co-op': () => t('Co-op', '合作'), pvp: () => t('Player versus player', '玩家对战'), 'local-multiplayer': () => t('Local multiplayer', '本地多人'), asynchronous: () => t('Asynchronous play', '异步对战'),
    fantasy: () => t('Fantasy', '奇幻'), 'sci-fi': () => t('Sci-fi', '科幻'), space: () => t('Space', '太空'), cyberpunk: () => t('Cyberpunk', '赛博朋克'),
    steampunk: () => t('Steampunk', '蒸汽朋克'), 'post-apocalyptic': () => t('Post-apocalyptic', '末日废土'), medieval: () => t('Medieval', '中世纪'), historical: () => t('Historical', '历史'),
    mythology: () => t('Mythology', '神话'), military: () => t('Military', '军事'), western: () => t('Western', '西部'), pirates: () => t('Pirates', '海盗'),
    ninja: () => t('Ninjas and samurai', '忍者与武士'), superheroes: () => t('Superheroes', '超级英雄'), zombies: () => t('Zombies', '僵尸'), monsters: () => t('Monsters', '怪物'),
    dinosaurs: () => t('Dinosaurs', '恐龙'), animals: () => t('Animals', '动物'), robots: () => t('Robots', '机器人'), aliens: () => t('Aliens', '外星人'), magic: () => t('Magic', '魔法'),
    nature: () => t('Nature', '自然'), ocean: () => t('Ocean', '海洋'), farming: () => t('Farming', '农场'), cooking: () => t('Cooking', '烹饪'), city: () => t('City', '城市'),
    school: () => t('School', '校园'), detective: () => t('Detective', '侦探'), mystery: () => t('Mystery', '悬疑'), dungeon: () => t('Dungeons', '地牢'),
    vehicles: () => t('Vehicles', '载具'), relaxing: () => t('Relaxing', '放松'), cozy: () => t('Cozy', '温馨'), cute: () => t('Cute', '可爱'), funny: () => t('Funny', '搞笑'),
    wholesome: () => t('Wholesome', '治愈'), 'family-friendly': () => t('Family friendly', '适合全家'), dark: () => t('Dark', '黑暗'), atmospheric: () => t('Atmospheric', '氛围感'),
    spooky: () => t('Spooky', '阴森'), emotional: () => t('Emotional', '感人'), 'story-rich': () => t('Story rich', '剧情丰富'), 'fast-paced': () => t('Fast paced', '快节奏'),
    challenging: () => t('Challenging', '高难度'), competitive: () => t('Competitive', '竞技'), satisfying: () => t('Satisfying', '解压'), physics: () => t('Physics', '物理'),
    procedural: () => t('Procedural generation', '程序生成'), crafting: () => t('Crafting', '制作'), building: () => t('Building', '建造'), 'base-building': () => t('Base building', '基地建设'),
    exploration: () => t('Exploration', '探索'), 'open-world': () => t('Open world', '开放世界'), stealth: () => t('Stealth', '潜行'), 'turn-based': () => t('Turn based', '回合制'),
    'real-time': () => t('Real time', '即时'), 'deck-building': () => t('Deck building', '卡组构筑'), 'match-3': () => t('Match 3', '三消'), 'hidden-object': () => t('Hidden object', '找东西'),
    endless: () => t('Endless', '无尽'), 'bullet-hell': () => t('Bullet hell', '弹幕'), 'hack-and-slash': () => t('Hack and slash', '砍杀'), 'twin-stick': () => t('Twin stick', '双摇杆'),
    metroidvania: () => t('Metroidvania', '类银河战士恶魔城'), 'point-and-click': () => t('Point and click', '点击冒险'), management: () => t('Management', '经营管理'),
    tycoon: () => t('Tycoon', '大亨'), trading: () => t('Trading', '交易'), collecting: () => t('Collecting', '收集'), upgrades: () => t('Upgrades', '升级'), loot: () => t('Loot', '战利品'),
    permadeath: () => t('Permadeath', '永久死亡'), 'boss-fights': () => t('Boss fights', '首领战'), 'level-editor': () => t('Level editor', '关卡编辑器'),
    'choices-matter': () => t('Choices matter', '选择影响剧情'), 'character-customization': () => t('Character customization', '角色定制'), tactics: () => t('Tactics', '战术'),
    'auto-battler': () => t('Auto battler', '自走棋'), merge: () => t('Merge', '合成'), logic: () => t('Logic', '逻辑'), minigames: () => t('Minigames', '小游戏合集'),
    typing: () => t('Typing', '打字'), drawing: () => t('Drawing', '绘画'), math: () => t('Math', '数学'), 'one-button': () => t('One button', '单键操作'),
    'short-sessions': () => t('Short sessions', '碎片时间'), 'pixel-art': () => t('Pixel art', '像素'), 'low-poly': () => t('Low poly', '低多边形'), voxel: () => t('Voxel', '体素'),
    'hand-drawn': () => t('Hand drawn', '手绘'), cartoon: () => t('Cartoon', '卡通'), realistic: () => t('Realistic', '写实'), minimalist: () => t('Minimalist', '极简'),
    retro: () => t('Retro', '复古'), neon: () => t('Neon', '霓虹'), '2d': () => t('2D', '2D'), '3d': () => t('3D', '3D'), isometric: () => t('Isometric', '等距视角'),
    'top-down': () => t('Top down', '俯视'), 'side-view': () => t('Side view', '横版'), 'first-person': () => t('First person', '第一人称'), 'third-person': () => t('Third person', '第三人称'),
  };
  return known[tag]?.() ?? tag.charAt(0).toUpperCase() + tag.slice(1).replace(/-/g, ' ');
};

/** The name of a group of tags, as the store's filters show it. */
export const tagGroupName = (g: string): string => ({ genre: t('Genres', '类型'), theme: t('Setting and theme', '背景与题材'), mood: t('Mood', '氛围'), gameplay: t('Gameplay', '玩法'), players: t('Players', '玩家'), style: t('Visual style and view', '画面风格与视角') } as Record<string, string>)[g] ?? g;

/** A listing field in the viewer's language when the creator translated the listing, otherwise as written. */
export function local<K extends 'title' | 'tagline' | 'description' | 'controls'>(g: { [k in K]?: string | null } & { i18n?: Record<string, Partial<Record<string, string>>>; listing_i18n?: Record<string, Partial<Record<string, string>>> }, k: K): string {
  const tr = (g.listing_i18n || g.i18n)?.[lang]?.[k];
  return tr || String(g[k] ?? '');
}

/** What players think, in a word, from the average rating and how many ratings there are. */
export function verdict(g: Pick<GameCard, 'rating' | 'rating_count'>): { word: string; tone: 'top' | 'good' | 'mid' | 'low' | 'none' } {
  const r = g.rating ?? 0, n = g.rating_count || 0;
  if (n < 3) return { word: n ? t('A few ratings', '评分较少') : t('No ratings yet', '暂无评分'), tone: 'none' };
  if (r >= 4.7 && n >= 50) return { word: t('Adored', '口碑爆棚'), tone: 'top' };
  if (r >= 4.4) return { word: t('Loved', '好评如潮'), tone: 'top' };
  if (r >= 4) return { word: t('Liked', '特别好评'), tone: 'good' };
  if (r >= 3) return { word: t('Mixed', '褒贬不一'), tone: 'mid' };
  return { word: t('Rough', '多半差评'), tone: 'low' };
}
export function Verdict({ g, full }: { g: Pick<GameCard, 'rating' | 'rating_count'>; full?: boolean }) {
  const v = verdict(g);
  return <span className={'verdict v-' + v.tone}>{v.word}{full && g.rating != null && g.rating_count >= 3 && <span className="mute"> · ★ {g.rating.toFixed(1)} ({num(g.rating_count)})</span>}</span>;
}

/** A game's tagline, unless it only repeats the title (agents often set both to the name). */
export function blurb(g: { title: string; tagline?: string | null }): string {
  const s = (g.tagline || '').trim(), norm = (x: string) => x.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  return s && norm(s) !== norm(g.title) ? s : '';
}

/** Adults-only games: what they are flagged for, in words. */
export const matureName = (c: string) => ({ sexual: t('Sexual content', '性内容'), violence: t('Graphic violence', '血腥暴力'), other: t('Mature themes', '成人主题') } as Record<string, string>)[c] ?? c;
export const isMature = (g: { mature?: string[] } | null | undefined) => !!g?.mature?.length;
/** A cover image: blurred for an adults-only game, everywhere in the store, until its page has been confirmed. */
export function CoverImg({ g, src, lazy = true }: { g: { mature?: string[] }; src: string; lazy?: boolean }) {
  return <img src={src} alt="" loading={lazy ? 'lazy' : undefined} decoding="async" className={isMature(g) ? 'mature-blur' : undefined} />;
}
/** The 18+ label on an adults-only game's cover, naming what it contains. */
export function MatureTag({ g }: { g: { mature?: string[] } }) {
  if (!isMature(g)) return null;
  return <span className="mature-tag" title={g.mature!.map(matureName).join(' · ')}><b>18+</b>{g.mature!.map(matureName).join(' · ')}</span>;
}

/** A game as a card: the cover, then its name, what players say and the price. The cover lifts off a halftone shadow on hover. */
export function GameTile({ g, to, fresh }: { g: GameCard; to?: string; fresh?: boolean }) {
  const rar = rarity(g), genre = g.tags[0], trial = trialOf(g);
  return (
    <Link to={to || `/g/${g.slug}`} className={`game r-${rar}`} style={{ '--rc': RARITY[rar].color, '--h': genre ? genreHue(genre) : 350 } as CSSProperties}>
      <div className="art" style={g.cover ? undefined : artStyle(g.slug)}>
        {g.cover ? <CoverImg g={g} src={g.cover} /> : <div className="mono-title">{local(g, 'title')}</div>}
        <MatureTag g={g} />
        {fresh ? <span className="stick">{t('New', '新上架')}</span> : g.featured ? <span className="stick alt">{t('Featured', '精选')}</span> : null}
        {!!g.playing && <span className="live-pill"><i className="live-dot" aria-hidden="true" />{num(g.playing)}</span>}
        {!!trial && <span className="art-trial">{trialLabel(trial, true)}</span>}
      </div>
      <div className="game-b">
        <h3 className="clip">{local(g, 'title')}</h3>
        <span className={'price' + (g.price_cents > 0 ? ' paid' : '')}>{price(g.price_cents)}</span>
        <div className="meta">
          {rar !== 'common' && <span className="rar" title={rarityHint()}>{RARITY[rar].name()}</span>}
          <Verdict g={g} />
          {genre && <span className="gen">{genreName(genre)}</span>}
          <span className="num plays">{count(g.plays, 'play', 'plays', '次游玩')}</span>
        </div>
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
/** Games this browser has opened or skipped, for the discovery queue. */
const SEEN_KEY = 'gcp.seen';
export const seenGames = (): string[] => readJson<string[]>(SEEN_KEY, []);
export function markSeen(slug: string) {
  const list = [slug, ...seenGames().filter((s) => s !== slug)].slice(0, 400);
  try { localStorage.setItem(SEEN_KEY, JSON.stringify(list)); } catch { /* private mode */ }
}
export function resetSeen() { try { localStorage.removeItem(SEEN_KEY); } catch { /* private mode */ } }
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
