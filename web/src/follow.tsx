// Following creators, and the notification bell in the top bar. The bell lists what is not about friends (friends'
// requests stay in the Friends panel): a new game from a creator the player follows, and gifts
// between friends. It refreshes when the
// SocialHub says something arrived (web/src/social.tsx forwards 'new_game'), when the tab comes back into view, and
// every few minutes while it is in view. The rules are src/follows.js; the routes src/routes/follows.ts.
import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type MouseEvent } from 'react';
import { ago, api, ApiError, CoverImg, genreHue, Link, loginUrl, navigate, num, shown, t, useApp, type ListingI18n } from './lib';
import { ListPager } from './ui';
import './follow.css';

// ---- following ------------------------------------------------------------------------------------------------------
/** A creator's monogram: the first letter on a slanted plate in a hue of their own (from their id). */
export function hueOf(id: string) { let h = 0; for (const c of id) h = (h * 31 + c.charCodeAt(0)) % 360; return h; }
export function Monogram({ id, name, size = 'md' }: { id: string; name: string; size?: 'sm' | 'md' | 'xl' }) {
  return <span className={'mono-av ' + size} style={{ '--h': hueOf(id) } as CSSProperties} aria-hidden="true"><b>{(name || '?').trim().slice(0, 1).toUpperCase()}</b></span>;
}

export const creatorPath = (id: string) => `/creator/${encodeURIComponent(id)}`;

/**
 * Follow and Following. Signed out, it sends the player to sign in and back. `state` is what the page already knows
 * (from GET /api/creators/:id); without it the button asks once. onChange gets the new state and follower count.
 */
export function FollowButton({ id, name, state, size = 'md', quiet, onChange }: { id: string; name: string; state?: boolean | null; size?: 'sm' | 'md' | 'lg'; quiet?: boolean; onChange?: (following: boolean, followers: number) => void }) {
  const { user, toast } = useApp();
  const [on, setOn] = useState<boolean | null>(state ?? null), [busy, setBusy] = useState(false);
  useEffect(() => { if (state != null) setOn(state); }, [state]);
  useEffect(() => {
    if (state != null || !user || user.id === id) return;
    let live = true;
    api<{ viewer: { following: boolean } }>(`/creators/${encodeURIComponent(id)}`).then((r) => { if (live) setOn(r.viewer.following); }, () => { if (live) setOn(false); });
    return () => { live = false; };
  }, [id, user, state]);
  if (user?.id === id) return null;
  const go = async (e: MouseEvent) => {
    e.preventDefault(); e.stopPropagation();
    if (!user) { navigate(loginUrl()); return; }
    setBusy(true);
    try {
      const r = await api<{ following: boolean; followers: number }>(`/creators/${encodeURIComponent(id)}/follow`, { method: on ? 'DELETE' : 'POST' });
      setOn(r.following); onChange?.(r.following, r.followers);
      toast(r.following ? t('Following {name}. You will hear when they publish a new game.', '已关注 {name}。对方发布新游戏时你会收到通知。', { name }) : t('You no longer follow {name}.', '已取消关注 {name}。', { name }));
    } catch (er) { toast((er as ApiError).message, true); }
    setBusy(false);
  };
  const cls = 'btn follow-btn btn-' + size + (on ? ' btn-secondary is-on' : quiet ? ' btn-secondary' : ' btn-primary');
  return (
    <button type="button" className={cls} onClick={go} disabled={busy || (!!user && on === null)} aria-pressed={!!on}
      aria-label={on ? t('Following {name}. Unfollow', '已关注 {name}，取消关注', { name }) : t('Follow {name}', '关注 {name}', { name })}>
      {on ? <><span className="fb-on"><svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 6.3 5 8.6l4.5-5" /></svg>{t('Following', '已关注')}</span><span className="fb-off">{t('Unfollow', '取消关注')}</span></>
        : <><span className="fb-plus" aria-hidden="true">+</span>{t('Follow', '关注')}</>}
    </button>
  );
}

// ---- the bell ---------------------------------------------------------------------------------------------------------
type Game = { id: string; slug: string; title: string; tagline: string; cover: string | null; live: boolean; mature: string[]; lang?: string; i18n?: ListingI18n };
export interface Note { id: number; kind: string; at: number; read: boolean; actor: { id: string; name: string }; game: Game | null; data: Record<string, unknown> }
const N = { unread: 0, items: null as Note[] | null, more: null as number | null, open: false, user: '' as string, v: 0 };
const subs = new Set<() => void>();
const emit = () => { N.v++; subs.forEach((f) => f()); };
const useNotes = () => { useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f); }, () => N.v); return N; };

async function loadCount() { try { N.unread = (await api<{ unread: number }>('/notifications/count')).unread; emit(); } catch { /* signed out or offline: next time */ } }
async function loadFeed(more = false) {
  try {
    const r = await api<{ unread: number; items: Note[]; more: number | null }>('/notifications' + (more && N.more ? `?before=${N.more}` : ''));
    N.unread = r.unread; N.items = more && N.items ? [...N.items, ...r.items] : r.items; N.more = r.more; emit();
  } catch { if (!N.items) { N.items = []; emit(); } }
}
/** Something arrived for the bell (a SocialHub event, web/src/social.tsx). */
export function notesArrived() { if (N.open) void loadFeed(); else void loadCount(); }
async function markRead(n: Note) {
  if (n.read) return;
  n.read = true; N.unread = Math.max(0, N.unread - 1); N.items = N.items ? [...N.items] : N.items; emit();
  try { N.unread = (await api<{ unread: number }>(`/notifications/${n.id}/read`, { method: 'POST' })).unread; emit(); } catch { /* shown read; the count corrects next time */ }
}
async function markAll() {
  N.items = N.items?.map((x) => ({ ...x, read: true })) || null; N.unread = 0; emit();
  try { N.unread = (await api<{ unread: number }>('/notifications/read', { method: 'POST' })).unread; emit(); } catch { /* next time */ }
}

/** What one notification says and where it goes. New kinds add a line here. */
function noteView(n: Note): { text: string; to: string } | null {
  const g = n.game ? shown(n.game as never) as Game : null;
  switch (n.kind) {
    case 'new_game': return g ? { text: t('{name} published a new game: {game}', '{name} 发布了新游戏：{game}', { name: n.actor.name, game: g.title }), to: `/g/${encodeURIComponent(g.slug)}` } : null;
    // a devlog or patch note on a game the player follows the creator of, keeps, bought or played (src/devlogs.js)
    case 'devlog': return g ? { text: t('{name} posted news about {game}', '{name} 发布了 {game} 的动态', { name: n.actor.name, game: g.title }), to: `/g/${encodeURIComponent(g.slug)}#news` } : null;
    // a game on the player's wishlist came out, or went on sale (src/wishlist.js)
    case 'wish_release': return g ? { text: t('{game} from your wishlist is out now', '你愿望单中的 {game} 现已推出', { game: g.title }), to: `/g/${encodeURIComponent(g.slug)}` } : null;
    case 'wish_sale': return g ? { text: t('{game} from your wishlist is on sale', '你愿望单中的 {game} 正在促销', { game: g.title }), to: `/g/${encodeURIComponent(g.slug)}` } : null;
    // a jam the player entered moved on (src/jams.js)
    case 'jam_voting': return n.data?.jam ? { text: t('Voting is open in {jam}', '{jam} 开始投票了', { jam: String(n.data.jam_title || '') }), to: `/jams/${encodeURIComponent(String(n.data.jam))}` } : null;
    case 'jam_results': return n.data?.jam ? { text: t('The results of {jam} are in', '{jam} 的结果出炉了', { jam: String(n.data.jam_title || '') }), to: `/jams/${encodeURIComponent(String(n.data.jam))}` } : null;
    // the creator answered the player's review; someone replied in the player's thread (src/community.js)
    case 'review_reply': return g ? { text: t('{name} replied to your review of {game}', '{name} 回复了你对 {game} 的评价', { name: n.actor.name, game: g.title }), to: `/g/${encodeURIComponent(g.slug)}#reviews` } : null;
    case 'board_reply': return g ? { text: t('{name} replied to your thread on {game}', '{name} 回复了你在 {game} 的帖子', { name: n.actor.name, game: g.title }), to: `/g/${encodeURIComponent(g.slug)}?thread=${encodeURIComponent(String(n.data?.thread || ''))}#community` } : null;
    // gifts between friends (src/gifts.ts)
    case 'gift_request': return g ? { text: t('{name} would like {game} as a gift', '{name} 想请你赠送 {game}', { name: n.actor.name, game: g.title }), to: '/gifts' } : null;
    case 'gift_declined': return g ? { text: t('{name} won\'t gift you {game} this time', '{name} 这次不会赠送你 {game}', { name: n.actor.name, game: g.title }), to: `/g/${encodeURIComponent(g.slug)}` } : null;
    case 'gift_received': return g ? { text: t('{name} gave you {game}', '{name} 送给你 {game}', { name: n.actor.name, game: g.title }), to: `/g/${encodeURIComponent(g.slug)}` } : null;
    case 'gift_sent': return g ? { text: t('You gave {game} to {name}', '你把 {game} 送给了 {name}', { name: n.actor.name, game: g.title }), to: '/gifts' } : null;
    default: return null;
  }
}

export function NotificationsButton() {
  const s = useNotes(), { user } = useApp(), ref = useRef<HTMLDivElement>(null);
  // a new account in this tab starts from nothing
  useEffect(() => {
    if (!user) return;
    if (N.user !== user.id) { N.user = user.id; N.items = null; N.unread = 0; N.more = null; emit(); }
    void loadCount();
    const every = window.setInterval(() => { if (document.visibilityState === 'visible') void loadCount(); }, 3 * 60_000);
    const vis = () => { if (document.visibilityState === 'visible') void loadCount(); };
    document.addEventListener('visibilitychange', vis);
    return () => { clearInterval(every); document.removeEventListener('visibilitychange', vis); };
  }, [user]);
  useEffect(() => {
    if (!s.open) return;
    const away = (e: globalThis.MouseEvent) => { if (!ref.current?.contains(e.target as Node)) { N.open = false; emit(); } };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { N.open = false; emit(); } };
    addEventListener('mousedown', away); addEventListener('keydown', esc);
    return () => { removeEventListener('mousedown', away); removeEventListener('keydown', esc); };
  }, [s.open]);
  if (!user) return null;
  const toggle = () => { N.open = !N.open; emit(); if (N.open) void loadFeed(); };
  const close = () => { N.open = false; emit(); };
  const list = (s.items || []).map((n) => ({ n, v: noteView(n) })).filter((x) => x.v);
  return (
    <div className="menu nb" ref={ref}>
      <button type="button" className={'icon-btn nb-btn' + (s.open ? ' on' : '')} onClick={toggle} aria-haspopup="dialog" aria-expanded={s.open}
        aria-label={s.unread ? t('Notifications, {n} new', '通知，{n} 条新通知', { n: s.unread }) : t('Notifications', '通知')} title={t('Notifications', '通知')}>
        <svg className="ico" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 8.2a5 5 0 0 1 10 0c0 3.6 1.4 5 2 5.6H3c.6-.6 2-2 2-5.6Z" /><path d="M8.2 16.4a2 2 0 0 0 3.6 0" /></svg>
        {s.unread > 0 && <b className="fr-badge">{s.unread > 99 ? '99+' : s.unread}</b>}
      </button>
      {s.open && (
        <div className="pop nb-pop" role="dialog" aria-label={t('Notifications', '通知')}>
          <div className="nb-head"><b>{t('Notifications', '通知')}</b>{s.unread > 0 && <button type="button" className="linkish fs-sm" onClick={markAll}>{t('Mark all read', '全部标为已读')}</button>}</div>
          {s.items === null ? <div className="nb-empty mute fs-sm">{t('Loading…', '加载中…')}</div>
            : !list.length ? (
              <div className="nb-empty">
                <b>{t('Nothing new yet', '暂无新通知')}</b>
                <span className="mute fs-sm">{t('Follow creators from their profile or a game page, and their new games show up here.', '在创作者主页或游戏页面关注创作者，他们的新游戏会显示在这里。')}</span>
              </div>
            ) : (
              <ul className="nb-list">
                {list.map(({ n, v }) => {
                  const g = n.game ? shown(n.game as never) as Game : null;
                  return (
                    <li key={n.id} className={n.read ? '' : 'unread'}>
                      <Link to={v!.to} className="nb-row" onClick={() => { void markRead(n); close(); }}>
                        <span className="nb-art" style={{ '--h': g ? genreHue(g.slug) : 350 } as CSSProperties}>{g?.cover ? <CoverImg g={g} src={g.cover} /> : <Monogram id={n.actor.id} name={n.actor.name} size="sm" />}</span>
                        <span className="nb-body"><span className="nb-text">{v!.text}</span><small className="dim">{ago(n.at)}</small></span>
                        {!n.read && <i className="nb-dot" aria-label={t('New', '新')} />}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          {s.more && <button type="button" className="nb-more fs-sm" onClick={() => void loadFeed(true)}>{t('Show older', '查看更早的通知')}</button>}
          <div className="nb-foot"><Link to="/library#following" onClick={close} className="fs-sm">{t('Creators you follow', '你关注的创作者')} →</Link></div>
        </div>
      )}
    </div>
  );
}

// ---- creators you follow (the Library's Following tab) -----------------------------------------------------------------
export interface Followed { id: string; name: string; since: number; games: number }
const FOLLOW_PER = 24;
export function FollowingList() {
  const [page, setPage] = useState(1);
  const [list, setList] = useState<Followed[] | null>(null), [total, setTotal] = useState(0), [err, setErr] = useState(''), [stamp, setStamp] = useState(0);
  useEffect(() => {
    let live = true;
    api<{ following: Followed[]; total?: number; pages?: number }>(`/me/following?page=${page}&per_page=${FOLLOW_PER}`).then((r) => {
      if (!live) return;
      const maxP = Math.max(1, r.pages || 1);
      if (page > maxP) { setPage(maxP); return; }
      setList(r.following);
      setTotal(r.total ?? r.following.length);
    }, (e) => { if (live) setErr((e as Error).message); });
    return () => { live = false; };
  }, [page, stamp]);
  if (err) return <p className="bad">{err}</p>;
  if (!list) return <div className="fl-grid">{[0, 1, 2].map((i) => <div key={i} className="fl-card sk" />)}</div>;
  if (!total && !list.length) return (
    <div className="fl-empty">
      <b>{t('You are not following anyone yet', '你还没有关注任何创作者')}</b>
      <span className="mute">{t('Open a game you like and follow its creator. Their next game will show up under the bell.', '打开一款你喜欢的游戏并关注它的创作者，对方的下一款游戏会出现在通知里。')}</span>
      <Link to="/browse" className="btn btn-secondary btn-sm">{t('Browse games', '浏览游戏')}</Link>
    </div>
  );
  return (
    <>
      <div className="fl-grid">
        {list.map((c) => (
          <div key={c.id} className="fl-card">
            <Link to={creatorPath(c.id)} className="fl-who"><Monogram id={c.id} name={c.name} /><span className="grow"><b className="clip">{c.name}</b><small className="dim">{c.games === 1 ? t('1 game', '1 款游戏') : t('{n} games', '{n} 款游戏', { n: num(c.games) })} · {t('followed {when}', '关注于{when}', { when: ago(c.since) })}</small></span></Link>
            <FollowButton id={c.id} name={c.name} state size="sm" onChange={(on) => { if (!on) setStamp((n) => n + 1); }} />
          </div>
        ))}
      </div>
      <ListPager page={page} total={total} perPage={FOLLOW_PER} onPage={setPage} />
    </>
  );
}
