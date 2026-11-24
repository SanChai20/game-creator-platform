// Friends, chat and invites in the web app: the live connection to the account's SocialHub (src/social.ts), the
// friends panel (friends, requests, adding by name or friend code, chat), the invite picker a game opens over itself
// (GCP.friends.open), pop-ups for what arrives, and the privacy settings on the Account page.
// Everything that pops up or slides in is rendered into the fullscreen element while a game fills the screen, so it is
// seen over the game too. A Busy player gets no pop-ups (only the badge), and nothing is ever sent for a guest.
import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ago, api, ApiError, local, navigate, t, useApp } from './lib';
import { Button, Field, Input, RowMenu, Select, Switch, Textarea } from './ui';
import { notesArrived } from './follow';
import './social.css';

// ---- types ------------------------------------------------------------------------------------------------------------
export type Status = 'online' | 'away' | 'busy' | 'offline' | 'invisible';
export interface Presence { s: Status; chosen?: string; game?: { id: string; slug: string; title: string }; since?: number; detail?: string; joinable?: boolean }
interface Friend { id: string; name: string; since: number; p: Presence; unread: number }
interface Invite { id: string; from: { id: string; name: string }; game: { id: string; slug: string; title: string }; kind: string; label: string; created_at: number; expires_at: number }
interface Profile { code: string; status: string; requests_from: string; messages_from: string; invites_from: string; show_game: boolean; joinable: boolean; searchable: boolean }
interface Counts { messages: number; chats: Record<string, number>; requests: number; notifications: number; invites: number }
interface Summary { enabled: boolean; profile?: Profile; me?: Presence; counts?: Counts; invites?: Invite[]; limits?: { message_max: number; friends_max: number } }
interface Msg { id: number; from: string; to: string; kind: 'text' | 'invite'; body: string; at: number; read: boolean; invite?: { id: string; status: string; game: { slug: string; title: string } | null; expires_at: number; label: string } }
export interface Join { id: string; kind: string; from: { id: string; name: string }; match: boolean; queue?: string; players?: number; min?: number; mode?: string; label?: string; data?: unknown }
interface Toast { id: number; kind: string; title: string; body?: string; who?: string; actions?: { label: string; primary?: boolean; run: () => void }[]; ttl: number }
type Tab = 'friends' | 'requests' | 'add';
interface OpenState { tab: Tab; peer?: { id: string; name: string } | null; invite?: { slug: string; title: string; lobby: string | null; label: string; data?: unknown } | null }

// ---- the store ----------------------------------------------------------------------------------------------------------
const S = {
  user: null as { id: string; name: string } | null,
  summary: null as Summary | null,
  friends: null as Friend[] | null,
  open: null as OpenState | null,
  toasts: [] as Toast[],
  chat: null as { peer: string; messages: Msg[]; more: boolean; relation: string } | null,
  activity: null as { slug: string; title: string; detail?: string; lobby?: string | null; label?: string } | null,
  frame: null as Window | null, frameJoin: false,
  conn: 'off' as 'off' | 'connecting' | 'on',
  v: 0,
};
const subs = new Set<() => void>();
const emit = () => { S.v++; subs.forEach((f) => f()); badge(); };
// The installed app's icon shows the unread count (Home Screen, Dock, taskbar), where the browser supports it.
let shownBadge = -1;
function badge() {
  const n = S.user ? unreadTotal() : 0, nav = navigator as Navigator & { setAppBadge?: (n?: number) => Promise<void>; clearAppBadge?: () => Promise<void> };
  if (n === shownBadge || !nav.setAppBadge) return;
  shownBadge = n;
  void (n ? nav.setAppBadge(n) : nav.clearAppBadge?.())?.catch(() => {});
}
export const useSocial = () => { useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f); }, () => S.v); return S; };
let toastN = 0;
function toast(x: Omit<Toast, 'id' | 'ttl'> & { ttl?: number }) {
  if (S.summary?.profile?.status === 'busy') return;   // do not disturb: the badge only
  const tt: Toast = { ttl: 6000, ...x, id: ++toastN };
  S.toasts = [...S.toasts.slice(-3), tt]; emit();
  setTimeout(() => dismiss(tt.id), tt.ttl);
}
const dismiss = (id: number) => { S.toasts = S.toasts.filter((x) => x.id !== id); emit(); };
const fail = (e: unknown) => toast({ kind: 'bad', title: (e as Error).message || t('Something went wrong.', '出了点问题。') });

export const unreadTotal = () => { const c = S.summary?.counts; return c ? c.messages + c.requests + c.invites + Math.max(0, c.notifications - c.requests) : 0; };

// ---- loading --------------------------------------------------------------------------------------------------------------
let sumTimer = 0, frTimer = 0;
async function loadSummary() { try { S.summary = await api<Summary>('/social/summary'); emit(); } catch { /* signed out, or busy: next event */ } }
async function loadFriends() { try { S.friends = (await api<{ friends: Friend[] }>('/social/friends')).friends; emit(); tellFrame(); } catch { /* ignore */ } }
const soonSummary = () => { clearTimeout(sumTimer); sumTimer = window.setTimeout(loadSummary, 250); };
const soonFriends = () => { clearTimeout(frTimer); frTimer = window.setTimeout(loadFriends, 250); };
let frameTold = 0;
function tellFrame() {
  if (!S.frame) return;
  const now = Date.now(); if (now - frameTold < 800) { setTimeout(tellFrame, 900); return; }
  frameTold = now;
  try { S.frame.postMessage({ gcp: 'friends_changed' }, '*'); } catch { /* gone */ }
}

// ---- the live connection --------------------------------------------------------------------------------------------
let ws: WebSocket | null = null, tries = 0, retry = 0, poll = 0;
function send(m: unknown) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(m)); }
function sendAct() { const a = S.activity; send(a ? { t: 'act', slug: a.slug, detail: a.detail || '', lobby: a.lobby || null, label: a.label || '' } : { t: 'act', slug: null }); }
function connect() {
  if (!S.user || ws || typeof WebSocket === 'undefined' || !S.summary?.enabled) return;
  S.conn = 'connecting'; emit();
  const sock = ws = new WebSocket(location.origin.replace(/^http/, 'ws') + '/api/social/ws?vis=' + (document.visibilityState === 'hidden' ? '0' : '1'));
  sock.onopen = () => { tries = 0; S.conn = 'on'; emit(); sendAct(); };
  sock.onmessage = (e) => { let m: any; try { m = JSON.parse(e.data); } catch { return; } onMessage(m); };
  sock.onclose = (e) => {
    if (ws === sock) ws = null;
    S.conn = 'off'; emit();
    if (!S.user || e.code === 4001 || e.code === 4000) return;   // signed out
    clearTimeout(retry); retry = window.setTimeout(connect, Math.min(30000, 1000 * 2 ** tries++) * (0.6 + Math.random() * 0.8));
  };
}
function disconnect() { clearTimeout(retry); clearInterval(poll); const w = ws; ws = null; try { w?.close(1000); } catch { /* closed */ } S.conn = 'off'; }
function onMessage(m: any) {
  if (m.t === 'hello' || m.t === 'me') { if (S.summary) { S.summary = { ...S.summary, me: m.me }; emit(); } return; }
  if (m.t === 'presence') {
    if (S.friends) { const f = S.friends.find((x) => x.id === m.id); if (f) { const was = f.p; f.p = m.p; S.friends = [...S.friends]; emit(); if (was.s === 'offline' && m.p.s === 'online') { /* quiet: no pop-up for every friend coming online */ } } }
    tellFrame(); return;
  }
  if (m.t !== 'event' || !m.ev) return;
  const ev = m.ev;
  switch (ev.kind) {
    case 'request':
      soonSummary();
      toast({ kind: 'request', who: ev.from.name, title: t('{name} sent you a friend request', '{name} 向你发送了好友请求', { name: ev.from.name }), actions: [
        { label: t('Accept', '接受'), primary: true, run: () => void acceptRequest(ev.from.id) },
        { label: t('View', '查看'), run: () => openPanel({ tab: 'requests' }) }] });
      break;
    case 'accepted':
      soonSummary(); soonFriends();
      toast({ kind: 'accepted', who: ev.by.name, title: t('{name} accepted your friend request', '{name} 接受了你的好友请求', { name: ev.by.name }), actions: [{ label: t('Message', '发消息'), run: () => openChat(ev.by) }] });
      break;
    case 'friends': soonFriends(); soonSummary(); break;
    case 'new_game':
      // a creator this player follows published a new game: the bell refreshes, and a pop-up offers it (web/src/follow.tsx)
      notesArrived();
      if (ev.game?.slug) toast({ kind: 'new_game', who: ev.creator?.name, title: t('{name} published a new game', '{name} 发布了新游戏', { name: ev.creator?.name || '' }), body: local(ev.game, 'title'),
        actions: [{ label: t('Play', '游玩'), primary: true, run: () => navigate(`/g/${encodeURIComponent(ev.game.slug)}`) }] });
      break;
    case 'message': {
      const open = S.chat && S.chat.peer === ev.peer && S.open?.peer?.id === ev.peer;
      if (open && ev.msg && !S.chat!.messages.some((x) => x.id === ev.msg.id)) { S.chat!.messages = [...S.chat!.messages, ev.msg]; emit(); if (!ev.mine) void api(`/social/chat/${ev.peer}/read`, { method: 'POST' }).catch(() => {}); }
      if (open && !ev.msg) void loadChat(ev.peer);
      if (!ev.mine) {
        soonSummary(); if (S.friends) soonFriends();
        if (!open && !ev.quiet && ev.from) toast({ kind: 'message', who: ev.from.name, title: ev.from.name, body: String(ev.msg?.body || '').slice(0, 120), actions: [{ label: t('Reply', '回复'), primary: true, run: () => openChat(ev.from) }] });
      }
      break;
    }
    case 'invite': {
      soonSummary();
      const inv = ev.invite as Invite;
      if (S.chat && S.chat.peer === inv.from.id) void loadChat(inv.from.id);
      if (!ev.quiet) toast({ kind: 'invite', who: inv.from.name, ttl: 25000, title: t('{name} invites you to play {game}', '{name} 邀请你一起玩 {game}', { name: inv.from.name, game: local(inv.game, 'title') }), body: inv.label || undefined, actions: [
        { label: t('Join', '加入'), primary: true, run: () => void answerInvite(inv.id, true) },
        { label: t('Decline', '拒绝'), run: () => void answerInvite(inv.id, false) }] });
      break;
    }
    case 'invite_answer':
      try { S.frame?.postMessage({ gcp: 'friends_answer', id: ev.id, accepted: ev.accepted, by: ev.by }, '*'); } catch { /* gone */ }
      if (S.chat && S.chat.peer === ev.by.id) void loadChat(ev.by.id);
      toast({ kind: 'answer', who: ev.by.name, title: ev.accepted ? t('{name} accepted your invite to {game}', '{name} 接受了你的 {game} 邀请', { name: ev.by.name, game: ev.game ? local(ev.game, 'title') : '' }) : t('{name} declined your invite', '{name} 拒绝了你的邀请', { name: ev.by.name }) });
      break;
    case 'joining': toast({ kind: 'answer', who: ev.by.name, title: t('{name} is joining you in {game}', '{name} 正在加入你的 {game}', { name: ev.by.name, game: ev.game ? local(ev.game, 'title') : '' }) }); break;
    case 'invite_cancelled': case 'counts': soonSummary(); if (S.chat) void loadChat(S.chat.peer); break;
  }
}

/** The small label over a pop-up, by what it is about. */
function toastKick(kind: string) {
  switch (kind) {
    case 'invite': return t('Game invite', '游戏邀请');
    case 'request': return t('Friend request', '好友请求');
    case 'accepted': return t('New friend', '新好友');
    case 'message': return t('New message', '新消息');
    default: return t('Friends', '好友');
  }
}

/** Signs the panel in or out with the account (App calls it with the signed-in user). */
export function socialUser(u: { id: string; name: string } | null) {
  if ((u?.id || null) === (S.user?.id || null)) return;
  disconnect();
  S.user = u; S.summary = null; S.friends = null; S.open = null; S.chat = null; S.toasts = []; emit();
  if (!u) return;
  if (linked) { const l = linked; linked = null; openLinked(l.friends, l.chat); }
  void loadSummary().then(() => { connect(); clearInterval(poll); poll = window.setInterval(() => { if (S.conn !== 'on') { void loadSummary(); if (S.open) void loadFriends(); } }, 60000); });
}
if (typeof document !== 'undefined') document.addEventListener('visibilitychange', () => { send({ t: 'vis', vis: document.visibilityState !== 'hidden' }); if (document.visibilityState !== 'hidden' && S.user && !ws) connect(); });

// ---- what the game page tells us --------------------------------------------------------------------------------------
/** The game page started (slug) or closed (null) a live game: friends see it and for how long. */
export function setActivity(g: { slug: string; title: string } | null) {
  S.activity = g ? { slug: g.slug, title: g.title } : null; if (!g) { S.frame = null; S.frameJoin = false; }
  sendAct(); emit();
}
/** The running game's frame (to tell it about friends), and what it says through the SDK. */
export function attachFrame(win: Window | null) { S.frame = win; S.frameJoin = false; }
export function fromGame(d: { gcp: string; detail?: string; lobby?: string | null; label?: string; join?: boolean; data?: unknown }) {
  if (d.gcp === 'social_hooks') { S.frameJoin = d.join === true; return; }
  if (d.gcp === 'presence' && S.activity) { S.activity = { ...S.activity, detail: String(d.detail || '').slice(0, 60), lobby: typeof d.lobby === 'string' ? d.lobby : null, label: String(d.label || '').slice(0, 60) }; sendAct(); return; }
  if (d.gcp === 'friends_open') {
    if (!S.user) { toast({ kind: 'bad', title: t('Sign in to play with friends.', '登录后即可和好友一起玩。') }); return; }
    if (!S.activity) return;
    openPanel({ tab: 'friends', invite: { slug: S.activity.slug, title: S.activity.title, lobby: typeof d.lobby === 'string' ? d.lobby : null, label: String(d.label || ''), data: d.data } });
  }
}
// Where an accepted invite or a join leads. A game page showing that game takes it (it reloads the game with the join,
// or hands it to the running game when the game listens for joins); otherwise the game's page opens and starts it.
const launchers = new Set<(slug: string, join: Join) => boolean>();
export function onLaunch(fn: (slug: string, join: Join) => boolean) { launchers.add(fn); return () => { launchers.delete(fn); }; }
export const encodeJoin = (j: Join) => { const b = new TextEncoder().encode(JSON.stringify(j)); let s = ''; b.forEach((x) => { s += String.fromCharCode(x); }); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
function launch(slug: string, join: Join) {
  closePanel();
  if (S.activity?.slug === slug && S.frame && S.frameJoin) { try { S.frame.postMessage({ gcp: 'friends_join', join }, '*'); return; } catch { /* gone: reload below */ } }
  for (const fn of launchers) if (fn(slug, join)) return;
  navigate(`/g/${encodeURIComponent(slug)}?play=1&join=${encodeJoin(join)}`);
}

// ---- actions ------------------------------------------------------------------------------------------------------------
// What a notification opens (web/src/pwa.ts): ?friends=requests or friends, ?chat=<player>. Kept until the account is known.
let linked: { friends: string | null; chat: string | null } | null = null;
export function openLinked(friends: string | null, chat: string | null) {
  if (!friends && !chat) return;
  if (!S.user) { linked = { friends, chat }; return; }
  if (chat) { void api<{ peer: { id: string; name: string } }>(`/social/chat/${encodeURIComponent(chat)}`).then((r) => { openPanel({ tab: 'friends' }); openChat(r.peer); }, fail); return; }
  openPanel({ tab: friends === 'requests' ? 'requests' : 'friends' });
}
export function openPanel(o: OpenState) { S.open = o; emit(); void loadFriends(); void loadSummary(); }
export function closePanel() { S.open = null; S.chat = null; emit(); }
export function togglePanel() { if (S.open) closePanel(); else openPanel({ tab: 'friends' }); }
function openChat(peer: { id: string; name: string }) { S.open = { ...(S.open || { tab: 'friends' }), peer }; S.chat = null; emit(); void loadChat(peer.id); }
async function loadChat(peer: string, older = false) {
  try {
    const before = older && S.chat?.messages.length ? `?before=${S.chat.messages[0].id}` : '';
    const r = await api<{ messages: Msg[]; more: boolean; relation: string }>(`/social/chat/${peer}${before}`);
    S.chat = { peer, messages: older && S.chat ? [...r.messages, ...S.chat.messages] : r.messages, more: r.more, relation: r.relation }; emit();
    if (!older && r.messages.some((m) => m.to === S.user?.id && !m.read)) { await api(`/social/chat/${peer}/read`, { method: 'POST' }); soonSummary(); if (S.friends) soonFriends(); }
  } catch (e) { fail(e); }
}
async function acceptRequest(id: string) { try { await api(`/social/requests/${id}/accept`, { method: 'POST' }); soonSummary(); soonFriends(); } catch (e) { fail(e); } }
async function answerInvite(id: string, yes: boolean) {
  try {
    const r = await api<{ game: { slug: string; title: string }; join?: Join }>(`/social/invites/${id}/${yes ? 'accept' : 'decline'}`, { method: 'POST' });
    soonSummary();
    if (yes && r.join) launch(r.game.slug, r.join);
  } catch (e) { fail(e); soonSummary(); }
}
async function joinFriend(f: { id: string }) {
  try { const r = await api<{ game: { slug: string }; join: Join }>(`/social/friends/${f.id}/join`, { method: 'POST' }); launch(r.game.slug, r.join); } catch (e) { fail(e); }
}
async function invite(f: Friend, inv: { slug: string; lobby: string | null; label: string; data?: unknown }) {
  try {
    const r = await api<{ status: string }>('/social/invites', { body: { to: f.id, slug: inv.slug, lobby: inv.lobby || undefined, label: inv.label || undefined, data: inv.data } });
    toast({ kind: 'answer', title: r.status === 'busy' ? t('Invite sent to {name}. They are busy, so it waits in their notifications.', '已向 {name} 发送邀请。对方正忙，邀请会安静地留在通知里。', { name: f.name })
      : r.status === 'away' ? t('Invite sent to {name}. They are away and may not answer soon.', '已向 {name} 发送邀请。对方暂时离开，可能不会马上回复。', { name: f.name })
      : t('Invite sent to {name}.', '已向 {name} 发送邀请。', { name: f.name }) });
    return true;
  } catch (e) { fail(e); return false; }
}

// ---- words ------------------------------------------------------------------------------------------------------------
export const statusName = (s: string) => ({ online: t('Online', '在线'), away: t('Away', '离开'), busy: t('Busy', '忙碌'), invisible: t('Invisible', '隐身'), offline: t('Offline', '离线') } as Record<string, string>)[s] || s;
function minutes(since?: number) { if (!since) return ''; const m = Math.max(0, Math.floor((Date.now() - since) / 60000)); return m < 1 ? t('just started', '刚开始') : m < 60 ? t('{n} min', '{n} 分钟', { n: m }) : t('{h} h {m} min', '{h} 小时 {m} 分钟', { h: Math.floor(m / 60), m: m % 60 }); }
export function presenceLine(p: Presence): string {
  if (p.game) return [t('Playing {game}', '正在玩 {game}', { game: local(p.game, 'title') }), p.detail, minutes(p.since)].filter(Boolean).join(' · ');
  return statusName(p.s);
}
const invitable = (s: Status) => s === 'online' || s === 'away' || s === 'busy';
const Dot = ({ s }: { s: Status }) => <i className={'fr-dot ' + s} aria-hidden="true" />;
const Initial = ({ name, s }: { name: string; s?: Status }) => <span className="fr-av" aria-hidden="true">{(name || '?').slice(0, 1).toUpperCase()}{s && <Dot s={s} />}</span>;

// ---- the button in the top bar ----------------------------------------------------------------------------------------
export function FriendsButton() {
  const s = useSocial();
  if (!s.user || s.summary?.enabled === false) return null;
  const n = unreadTotal();
  return (
    <button type="button" className={'icon-btn fr-btn' + (s.open ? ' on' : '')} onClick={togglePanel} aria-haspopup="dialog" aria-expanded={!!s.open}
      aria-label={n ? t('Friends, {n} new', '好友，{n} 条新消息', { n }) : t('Friends', '好友')} title={t('Friends', '好友')}>
      <svg className="ico" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="7.5" cy="7" r="2.8" /><path d="M2.5 16c.5-2.8 2.5-4.4 5-4.4s4.5 1.6 5 4.4" /><circle cx="14" cy="7.6" r="2.2" /><path d="M13.6 11.7c2 .1 3.5 1.4 3.9 3.8" /></svg>
      {n > 0 && <b className="fr-badge">{n > 99 ? '99+' : n}</b>}
    </button>
  );
}

// ---- the root: panel and pop-ups, over everything (and over a fullscreen game) ----------------------------------------
function useLayer(): Element {
  const get = () => document.fullscreenElement || (document as Document & { webkitFullscreenElement?: Element }).webkitFullscreenElement || document.body;
  const [el, setEl] = useState<Element>(get);
  useEffect(() => { const f = () => setEl(get()); document.addEventListener('fullscreenchange', f); document.addEventListener('webkitfullscreenchange', f); return () => { document.removeEventListener('fullscreenchange', f); document.removeEventListener('webkitfullscreenchange', f); }; }, []);
  return el;
}
export function SocialRoot() {
  const { user } = useApp();
  useEffect(() => { socialUser(user ? { id: user.id, name: user.name } : null); }, [user?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const s = useSocial(), layer = useLayer();
  if (!s.user) return null;
  return createPortal(<>
    {s.open && <Panel />}
    {s.toasts.length > 0 && <div className="fr-toasts" role="status" aria-live="polite">{s.toasts.map((x) => (
      <div key={x.id} className={'fr-toast ' + x.kind}>
        <div className="fr-toast-head"><span className="fr-toast-kick">{toastKick(x.kind)}</span>
          <button type="button" className="fr-x" aria-label={t('Close', '关闭')} onClick={() => dismiss(x.id)}>×</button></div>
        <div className="fr-toast-main">{x.who && <Initial name={x.who} />}<div className="fr-toast-text"><b>{x.title}</b>{x.body && <span>{x.body}</span>}</div></div>
        {x.actions && <div className="fr-toast-acts">{x.actions.map((a, i) => <button key={i} type="button" className={a.primary ? 'btn btn-sm btn-primary' : 'btn btn-sm'} onClick={() => { dismiss(x.id); a.run(); }}>{a.label}</button>)}</div>}
      </div>))}</div>}
  </>, layer);
}

// ---- the panel ------------------------------------------------------------------------------------------------------------
function useTick(ms: number) { const [, set] = useState(0); useEffect(() => { const i = setInterval(() => set((n) => n + 1), ms); return () => clearInterval(i); }, [ms]); }
function Panel() {
  const s = useSocial(), o = s.open!, box = useRef<HTMLDivElement>(null);
  useTick(30000);
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); if (S.open?.peer) { S.open = { ...S.open, peer: null }; S.chat = null; emit(); } else closePanel(); } }; addEventListener('keydown', k, true); return () => removeEventListener('keydown', k, true); }, []);
  useEffect(() => { box.current?.focus({ preventScroll: true }); }, []);
  const c = s.summary?.counts, setTab = (tab: Tab) => { S.open = { ...o, tab, peer: null }; S.chat = null; emit(); };
  return (
    <div className="fr-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) closePanel(); }}>
      <aside className="fr-panel" role="dialog" aria-modal="true" aria-label={t('Friends', '好友')} tabIndex={-1} ref={box}>
        {o.peer ? <Chat peer={o.peer} /> : <>
          <header className="fr-head">
            <b className="fr-title">{t('Friends', '好友')}</b>
            <MyStatus />
            <button type="button" className="fr-x big" aria-label={t('Close', '关闭')} onClick={closePanel}>×</button>
          </header>
          {o.invite && <div className="fr-inviting"><b>{t('Invite friends to {game}', '邀请好友一起玩 {game}', { game: o.invite.title })}</b><span>{o.invite.lobby ? t('They join your match when they accept.', '对方接受后会加入你的对局。') : t('They open the game when they accept.', '对方接受后会打开这款游戏。')} {t('Online, away and busy friends can be invited.', '可以邀请在线、离开和忙碌的好友。')}</span></div>}
          <Invites />
          <nav className="fr-tabs" role="tablist">
            {([['friends', t('Friends', '好友'), 0], ['requests', t('Requests', '请求'), (c?.requests || 0) + Math.max(0, (c?.notifications || 0) - (c?.requests || 0))], ['add', t('Add friend', '添加好友'), 0]] as [Tab, string, number][]).map(([k, label, n]) => (
              <button key={k} type="button" role="tab" aria-selected={o.tab === k} className={o.tab === k ? 'on' : ''} onClick={() => setTab(k)}>{label}{n > 0 && <b className="fr-badge in">{n}</b>}</button>))}
          </nav>
          <div className="fr-body">{o.tab === 'friends' ? <FriendList /> : o.tab === 'requests' ? <Requests /> : <AddFriend />}</div>
        </>}
      </aside>
    </div>
  );
}

function MyStatus() {
  const s = useSocial(), cur = s.summary?.profile?.status || 'online';
  const set = async (status: string) => {
    try { const r = await api<{ profile: Profile; me: Presence | null }>('/social/profile', { method: 'PATCH', body: { status } }); if (S.summary) { S.summary = { ...S.summary, profile: r.profile, me: r.me || S.summary.me }; emit(); } } catch (e) { fail(e); }
  };
  return (
    <label className="fr-status" title={t('Your status', '你的状态')}>
      <Dot s={(cur === 'invisible' ? 'invisible' : cur) as Status} />
      <select value={cur} onChange={(e) => void set(e.target.value)} aria-label={t('Your status', '你的状态')}>
        <option value="online">{statusName('online')}</option>
        <option value="away">{statusName('away')}</option>
        <option value="busy">{t('Busy (no pop-ups)', '忙碌（不弹出通知）')}</option>
        <option value="invisible">{t('Invisible (shown as offline)', '隐身（显示为离线）')}</option>
      </select>
    </label>
  );
}

function Invites() {
  const s = useSocial(), list = s.summary?.invites || [];
  if (!list.length) return null;
  return (
    <section className="fr-invites" aria-label={t('Invites', '邀请')}>
      {list.map((i) => (
        <div key={i.id} className="fr-invite">
          <div className="fr-invite-text"><b>{t('{name} invites you to play {game}', '{name} 邀请你一起玩 {game}', { name: i.from.name, game: local(i.game, 'title') })}</b>{i.label && <span>{i.label}</span>}<small>{ago(i.created_at)}</small></div>
          <div className="row" style={{ gap: 6 }}><Button size="sm" variant="primary" onClick={() => void answerInvite(i.id, true)}>{t('Join', '加入')}</Button><Button size="sm" variant="ghost" onClick={() => void answerInvite(i.id, false)}>{t('Decline', '拒绝')}</Button></div>
        </div>))}
    </section>
  );
}

function FriendList() {
  const s = useSocial(), list = s.friends, inv = s.open?.invite || (s.activity ? { slug: s.activity.slug, title: s.activity.title, lobby: s.activity.lobby || null, label: s.activity.label || '' } : null);
  const [sent, setSent] = useState<Record<string, boolean>>({});
  if (!list) return <div className="fr-empty">{t('Loading…', '加载中…')}</div>;
  if (!list.length) return <div className="fr-empty"><b>{t('No friends yet', '还没有好友')}</b><span>{t('Find people by name or friend code under Add friend.', '在“添加好友”里按名字或好友码查找。')}</span><Button size="sm" variant="primary" onClick={() => { S.open = { ...S.open!, tab: 'add' }; emit(); }}>{t('Add friend', '添加好友')}</Button></div>;
  const rank = (f: Friend) => (f.p.game ? 0 : f.p.s === 'online' ? 1 : f.p.s === 'away' ? 2 : f.p.s === 'busy' ? 3 : 4);
  const sorted = [...list].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  const groups: [string, Friend[]][] = [[t('Playing', '游戏中'), sorted.filter((f) => rank(f) === 0)], [t('Online', '在线'), sorted.filter((f) => rank(f) > 0 && rank(f) < 4)], [t('Offline', '离线'), sorted.filter((f) => rank(f) === 4)]];
  return <>{groups.filter(([, g]) => g.length).map(([title, g]) => (
    <section key={title} className="fr-group"><h3>{title} <span>{g.length}</span></h3>
      {g.map((f) => {
        const can = invitable(f.p.s);
        return (
          <div key={f.id} className="fr-row">
            <button type="button" className="fr-main" onClick={() => openChat(f)} title={t('Message', '发消息')}>
              <Initial name={f.name} s={f.p.s} />
              <span className="fr-who"><b className="clip">{f.name}</b><span className={'clip fr-line' + (f.p.game ? ' playing' : '')}>{presenceLine(f.p)}</span></span>
              {f.unread > 0 && <b className="fr-badge in">{f.unread}</b>}
            </button>
            <span className="fr-acts">
              {f.p.joinable && <Button size="sm" variant="primary" onClick={() => void joinFriend(f)}>{t('Join', '加入')}</Button>}
              {inv && (sent[f.id] ? <span className="fr-sent">{t('Invited', '已邀请')}</span>
                : <Button size="sm" variant={s.open?.invite ? 'primary' : 'secondary'} disabled={!can} title={can ? (f.p.s === 'online' ? t('Invite to {game}', '邀请一起玩 {game}', { game: inv.title }) : t('{status}: they may not answer soon', '{status}：对方可能不会马上回复', { status: statusName(f.p.s) })) : t('Invisible or offline friends cannot be invited', '无法邀请隐身或离线的好友')}
                  onClick={async () => { if (await invite(f, inv)) setSent((x) => ({ ...x, [f.id]: true })); }}>{t('Invite', '邀请')}{can && f.p.s !== 'online' && <small className="fr-st"> · {statusName(f.p.s)}</small>}</Button>)}
              <RowMenu label={t('More for {name}', '{name} 的更多操作', { name: f.name })} actions={[
                { label: t('Message', '发消息'), onClick: () => openChat(f) },
                { label: t('Remove friend', '删除好友'), danger: true, onClick: () => void removeFriend(f) },
                { label: t('Block', '屏蔽'), danger: true, onClick: () => void blockUser(f) },
                { label: t('Report', '举报'), danger: true, onClick: () => setReport(f) },
              ]} />
            </span>
          </div>);
      })}
    </section>))}<ReportHost /></>;
}
async function removeFriend(f: { id: string; name: string }) {
  if (!confirmDialog(t('Remove {name} from your friends?', '要把 {name} 从好友中删除吗？', { name: f.name }))) return;
  try { await api(`/social/friends/${f.id}`, { method: 'DELETE' }); soonFriends(); } catch (e) { fail(e); }
}
async function blockUser(f: { id: string; name: string }) {
  if (!confirmDialog(t('Block {name}? They will no longer be your friend and cannot find, message or invite you.', '要屏蔽 {name} 吗？对方将不再是你的好友，也无法找到你、给你发消息或邀请你。', { name: f.name }))) return;
  try { await api('/social/blocks', { body: { id: f.id } }); soonFriends(); soonSummary(); if (S.open?.peer?.id === f.id) { S.open = { ...S.open, peer: null }; S.chat = null; emit(); } } catch (e) { fail(e); }
}
// window.confirm stays out of a fullscreen game's way less well than a card would, but it is reliable on every device
const confirmDialog = (q: string) => { try { return window.confirm(q); } catch { return true; } };

// ---- reporting ------------------------------------------------------------------------------------------------------------
let reportFor: { id: string; name: string; messages?: number[] } | null = null;
function setReport(f: { id: string; name: string; messages?: number[] } | null) { reportFor = f; emit(); }
function ReportHost() { useSocial(); return reportFor ? <ReportDialog who={reportFor} /> : null; }
function ReportDialog({ who }: { who: { id: string; name: string; messages?: number[] } }) {
  const [reason, setReason] = useState('harassment'), [detail, setDetail] = useState(''), [also, setAlso] = useState(true), [busy, setBusy] = useState(false);
  const send = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true);
    try { await api('/social/reports', { body: { target: who.id, reason, detail, messages: who.messages, block: also } }); setReport(null); toast({ kind: 'answer', title: t('Thanks. The report went to the platform\'s moderators.', '感谢举报，已提交给平台管理员。') }); if (also) { soonFriends(); soonSummary(); if (S.open?.peer?.id === who.id) { S.open = { ...S.open, peer: null }; S.chat = null; emit(); } } }
    catch (x) { fail(x); }
    setBusy(false);
  };
  return (
    <div className="fr-sheet" role="dialog" aria-modal="true" aria-label={t('Report {name}', '举报 {name}', { name: who.name })}>
      <form onSubmit={send} className="fr-sheet-in">
        <b>{t('Report {name}', '举报 {name}', { name: who.name })}</b>
        <Field label={t('What happened?', '发生了什么？')}>
          <Select value={reason} onChange={(e) => setReason(e.target.value)}>
            <option value="harassment">{t('Harassment or bullying', '骚扰或欺凌')}</option>
            <option value="spam">{t('Spam or scams', '垃圾信息或诈骗')}</option>
            <option value="hate">{t('Hate speech', '仇恨言论')}</option>
            <option value="cheating">{t('Cheating', '作弊')}</option>
            <option value="name">{t('Offensive name', '不当名称')}</option>
            <option value="other">{t('Something else', '其他')}</option>
          </Select>
        </Field>
        <Field label={t('Details (optional)', '详情（可选）')}><Textarea rows={3} maxLength={1000} value={detail} onChange={(e) => setDetail(e.target.value)} /></Field>
        <label className="fr-check"><Switch checked={also} onChange={(e) => setAlso(e.target.checked)} /> {t('Also block {name}', '同时屏蔽 {name}', { name: who.name })}</label>
        <span className="mute fs-sm">{t('Moderators see your report and your recent messages with this player.', '管理员会看到你的举报以及你与该玩家最近的消息。')}</span>
        <div className="row" style={{ gap: 8, justifyContent: 'flex-end' }}><Button type="button" variant="ghost" onClick={() => setReport(null)}>{t('Cancel', '取消')}</Button><Button type="submit" variant="danger" disabled={busy}>{t('Send report', '提交举报')}</Button></div>
      </form>
    </div>
  );
}

// ---- requests ---------------------------------------------------------------------------------------------------------------
interface ReqData { incoming: { id: string; name: string; at: number }[]; outgoing: { id: string; name: string; at: number }[]; notifications: { id: number; kind: string; actor: { id: string; name: string }; at: number; read: boolean }[] }
function Requests() {
  useSocial();
  const [d, setD] = useState<ReqData | null>(null);
  const load = () => api<ReqData>('/social/requests').then(setD, fail);
  useEffect(() => { void load().then(() => api('/social/notifications/read', { method: 'POST' })).then(() => soonSummary()).catch(() => {}); }, [S.summary?.counts?.requests]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!d) return <div className="fr-empty">{t('Loading…', '加载中…')}</div>;
  const act = async (path: string, method = 'POST') => { try { await api(path, { method }); await load(); soonSummary(); soonFriends(); } catch (e) { fail(e); } };
  const accepted = d.notifications.filter((n) => n.kind === 'friend_accepted').slice(0, 10);
  if (!d.incoming.length && !d.outgoing.length && !accepted.length) return <div className="fr-empty"><b>{t('No requests', '没有请求')}</b><span>{t('Friend requests you get and send show here.', '你收到和发出的好友请求会显示在这里。')}</span></div>;
  return <>
    {d.incoming.length > 0 && <section className="fr-group"><h3>{t('Received', '收到的')} <span>{d.incoming.length}</span></h3>{d.incoming.map((r) => (
      <div key={r.id} className="fr-row"><span className="fr-main static"><Initial name={r.name} /><span className="fr-who"><b className="clip">{r.name}</b><span className="fr-line">{ago(r.at)}</span></span></span>
        <span className="fr-acts"><Button size="sm" variant="primary" onClick={() => void act(`/social/requests/${r.id}/accept`)}>{t('Accept', '接受')}</Button><Button size="sm" variant="ghost" onClick={() => void act(`/social/requests/${r.id}/decline`)}>{t('Decline', '拒绝')}</Button>
          <RowMenu label={t('More for {name}', '{name} 的更多操作', { name: r.name })} actions={[{ label: t('Block', '屏蔽'), danger: true, onClick: () => void blockUser(r).then(load) }, { label: t('Report', '举报'), danger: true, onClick: () => setReport(r) }]} /></span></div>))}</section>}
    {d.outgoing.length > 0 && <section className="fr-group"><h3>{t('Sent', '已发送')} <span>{d.outgoing.length}</span></h3>{d.outgoing.map((r) => (
      <div key={r.id} className="fr-row"><span className="fr-main static"><Initial name={r.name} /><span className="fr-who"><b className="clip">{r.name}</b><span className="fr-line">{t('Waiting for an answer', '等待对方回复')}</span></span></span>
        <span className="fr-acts"><Button size="sm" variant="ghost" onClick={() => void act(`/social/requests/${r.id}`, 'DELETE')}>{t('Cancel', '取消')}</Button></span></div>))}</section>}
    {accepted.length > 0 && <section className="fr-group"><h3>{t('Recent', '最近')}</h3>{accepted.map((n) => <div key={n.id} className="fr-note">{t('{name} accepted your friend request', '{name} 接受了你的好友请求', { name: n.actor.name })} <small>{ago(n.at)}</small></div>)}</section>}
    <ReportHost />
  </>;
}

// ---- adding -------------------------------------------------------------------------------------------------------------------
function AddFriend() {
  const s = useSocial(), code = s.summary?.profile?.code || '';
  const [q, setQ] = useState(''), [res, setRes] = useState<{ id: string; name: string; relation: string }[] | null>(null), [busy, setBusy] = useState(false);
  useEffect(() => {
    const v = q.trim(); if (v.length < 2) { setRes(null); return; }
    const tm = setTimeout(() => { setBusy(true); api<{ results: { id: string; name: string; relation: string }[] }>(`/social/search?q=${encodeURIComponent(v)}`).then((r) => setRes(r.results), fail).finally(() => setBusy(false)); }, 300);
    return () => clearTimeout(tm);
  }, [q]);
  const ask = async (r: { id: string; name: string }) => {
    try { const x = await api<{ state: string }>('/social/requests', { body: { to: r.id } }); setRes((l) => l && l.map((y) => (y.id === r.id ? { ...y, relation: x.state === 'friends' ? 'friends' : 'requested' } : y))); if (x.state === 'friends') soonFriends(); }
    catch (e) { fail(e); }
  };
  const copy = async () => { try { await navigator.clipboard.writeText(code); toast({ kind: 'answer', title: t('Friend code copied.', '好友码已复制。') }); } catch { /* no clipboard */ } };
  return <>
    <div className="fr-code"><span>{t('Your friend code', '你的好友码')}</span><b className="mono">{code}</b><Button size="sm" variant="ghost" onClick={() => void copy()}>{t('Copy', '复制')}</Button></div>
    <label className="fr-search"><span className="sr-only">{t('Name or friend code', '名字或好友码')}</span>
      <Input type="search" autoFocus placeholder={t('Name or friend code', '名字或好友码')} value={q} onChange={(e) => setQ(e.target.value)} maxLength={40} autoComplete="off" spellCheck={false} /></label>
    {q.trim().length > 0 && q.trim().length < 2 && <div className="fr-empty small">{t('Type at least 2 letters.', '至少输入 2 个字符。')}</div>}
    {res && !res.length && !busy && <div className="fr-empty small">{t('Nobody found. Try their friend code: some players hide their name from search.', '没有找到。试试对方的好友码：有些玩家不允许按名字搜索。')}</div>}
    {res && res.map((r) => (
      <div key={r.id} className="fr-row"><span className="fr-main static"><Initial name={r.name} /><span className="fr-who"><b className="clip">{r.name}</b></span></span>
        <span className="fr-acts">{r.relation === 'friends' ? <span className="fr-sent">{t('Friends', '已是好友')}</span>
          : r.relation === 'requested' ? <span className="fr-sent">{t('Requested', '已发送请求')}</span>
          : r.relation === 'incoming' ? <Button size="sm" variant="primary" onClick={() => void ask(r)}>{t('Accept request', '接受请求')}</Button>
          : r.relation === 'blocked' ? <span className="fr-sent">{t('Blocked', '已屏蔽')}</span>
          : <Button size="sm" variant="primary" onClick={() => void ask(r)}>{t('Add friend', '添加好友')}</Button>}</span></div>))}
  </>;
}

// ---- chat ---------------------------------------------------------------------------------------------------------------------
function Chat({ peer }: { peer: { id: string; name: string } }) {
  const s = useSocial(), chat = s.chat && s.chat.peer === peer.id ? s.chat : null, list = useRef<HTMLDivElement>(null);
  const f = s.friends?.find((x) => x.id === peer.id), max = s.summary?.limits?.message_max || 500;
  const [text, setText] = useState(''), [busy, setBusy] = useState(false);
  const last = chat?.messages[chat.messages.length - 1]?.id;
  useEffect(() => { const el = list.current; if (el) el.scrollTop = el.scrollHeight; }, [last]);
  const back = () => { S.open = { ...S.open!, peer: null }; S.chat = null; emit(); };
  const sendIt = async (e?: FormEvent) => {
    e?.preventDefault(); const v = text.trim(); if (!v || busy) return; setBusy(true);
    try { const r = await api<{ message: Msg }>(`/social/chat/${peer.id}`, { body: { body: v } }); setText(''); if (S.chat && S.chat.peer === peer.id && !S.chat.messages.some((m) => m.id === r.message.id)) { S.chat = { ...S.chat, messages: [...S.chat.messages, r.message] }; emit(); } }
    catch (x) { fail(x); }
    setBusy(false);
  };
  const canWrite = !chat || chat.relation === 'friends';
  return <>
    <header className="fr-head">
      <button type="button" className="fr-back" onClick={back} aria-label={t('Back to friends', '返回好友列表')}>‹</button>
      <Initial name={peer.name} s={f?.p.s} />
      <span className="fr-who"><b className="clip">{peer.name}</b>{f && <span className="clip fr-line">{presenceLine(f.p)}</span>}</span>
      <RowMenu label={t('More for {name}', '{name} 的更多操作', { name: peer.name })} actions={[
        f?.p.joinable && { label: t('Join', '加入'), onClick: () => void joinFriend(f) },
        { label: t('Report', '举报'), danger: true, onClick: () => setReport({ ...peer, messages: (chat?.messages || []).filter((m) => m.from === peer.id).slice(-10).map((m) => m.id) }) },
        { label: t('Block', '屏蔽'), danger: true, onClick: () => void blockUser(peer) },
      ]} />
      <button type="button" className="fr-x big" aria-label={t('Close', '关闭')} onClick={closePanel}>×</button>
    </header>
    <div className="fr-msgs" ref={list}>
      {!chat ? <div className="fr-empty">{t('Loading…', '加载中…')}</div> : <>
        {chat.more && <button type="button" className="fr-older" onClick={() => void loadChat(peer.id, true)}>{t('Earlier messages', '更早的消息')}</button>}
        {!chat.messages.length && <div className="fr-empty small">{t('Say hello to {name}.', '和 {name} 打个招呼吧。', { name: peer.name })}</div>}
        {chat.messages.map((m) => <Bubble key={m.id} m={m} mine={m.from === s.user?.id} name={peer.name} />)}
      </>}
    </div>
    {canWrite ? <form className="fr-compose" onSubmit={sendIt}>
      <Textarea rows={1} maxLength={max} value={text} placeholder={t('Message {name}', '给 {name} 发消息', { name: peer.name })} aria-label={t('Message {name}', '给 {name} 发消息', { name: peer.name })}
        onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void sendIt(); } }} />
      <Button type="submit" variant="primary" size="sm" disabled={busy || !text.trim()}>{t('Send', '发送')}</Button>
    </form> : <div className="fr-empty small">{t('You can message only your friends.', '只能给好友发消息。')}</div>}
    <ReportHost />
  </>;
}
function Bubble({ m, mine, name }: { m: Msg; mine: boolean; name: string }) {
  if (m.kind === 'invite' && m.invite) {
    const i = m.invite, live = i.status === 'sent' && i.expires_at > Date.now();
    const state = i.status === 'accepted' ? t('Accepted', '已接受') : i.status === 'declined' ? t('Declined', '已拒绝') : i.status === 'cancelled' ? t('Withdrawn', '已撤回') : !live ? t('Expired', '已过期') : mine ? t('Waiting for an answer', '等待对方回复') : '';
    return (
      <div className={'fr-bubble invite' + (mine ? ' mine' : '')}>
        <b>{mine ? t('You invited {name} to play {game}', '你邀请 {name} 一起玩 {game}', { name, game: i.game ? local(i.game, 'title') : '' }) : t('{name} invites you to play {game}', '{name} 邀请你一起玩 {game}', { name, game: i.game ? local(i.game, 'title') : '' })}</b>
        {i.label && <span>{i.label}</span>}
        {!mine && live ? <div className="row" style={{ gap: 6 }}><Button size="sm" variant="primary" onClick={() => void answerInvite(i.id, true)}>{t('Join', '加入')}</Button><Button size="sm" variant="ghost" onClick={() => void answerInvite(i.id, false)}>{t('Decline', '拒绝')}</Button></div> : <small>{state}</small>}
      </div>);
  }
  return <div className={'fr-bubble' + (mine ? ' mine' : '')} title={new Date(m.at).toLocaleString()}>{m.body}</div>;
}

// ---- Account: who can reach me ------------------------------------------------------------------------------------------------
export function FriendsSettings() {
  const s = useSocial(), p = s.summary?.profile;
  const [blocked, setBlocked] = useState<{ id: string; name: string }[] | null>(null);
  useEffect(() => { void api<{ blocked: { id: string; name: string }[] }>('/social/blocks').then((r) => setBlocked(r.blocked), () => setBlocked([])); }, []);
  if (s.summary?.enabled === false) return null;
  if (!p) return <div className="mute">{t('Loading…', '加载中…')}</div>;
  const patch = async (b: Partial<Profile>) => { try { const r = await api<{ profile: Profile; me: Presence | null }>('/social/profile', { method: 'PATCH', body: b }); if (S.summary) { S.summary = { ...S.summary, profile: r.profile, me: r.me || S.summary.me }; emit(); } } catch (e) { fail(e); } };
  const row = (label: ReactNode, el: ReactNode) => <label className="fr-set"><span>{label}</span>{el}</label>;
  return <div className="fr-settings">
    {row(t('Your friend code', '你的好友码'), <b className="mono">{p.code}</b>)}
    {row(t('Status', '状态'), <Select value={p.status} onChange={(e) => void patch({ status: e.target.value })}><option value="online">{statusName('online')}</option><option value="away">{statusName('away')}</option><option value="busy">{t('Busy (no pop-ups)', '忙碌（不弹出通知）')}</option><option value="invisible">{t('Invisible (shown as offline)', '隐身（显示为离线）')}</option></Select>)}
    {row(t('Who can send you friend requests', '谁可以向你发送好友请求'), <Select value={p.requests_from} onChange={(e) => void patch({ requests_from: e.target.value })}><option value="everyone">{t('Everyone', '所有人')}</option><option value="friends_of_friends">{t('Friends of friends', '好友的好友')}</option><option value="nobody">{t('Nobody', '任何人都不可以')}</option></Select>)}
    {row(t('Messages from friends', '好友消息'), <Select value={p.messages_from} onChange={(e) => void patch({ messages_from: e.target.value })}><option value="friends">{t('Allowed', '允许')}</option><option value="nobody">{t('Off', '关闭')}</option></Select>)}
    {row(t('Game invites from friends', '好友的游戏邀请'), <Select value={p.invites_from} onChange={(e) => void patch({ invites_from: e.target.value })}><option value="friends">{t('Allowed', '允许')}</option><option value="nobody">{t('Off', '关闭')}</option></Select>)}
    {row(t('Show friends the game I play and for how long', '向好友显示我在玩的游戏和时长'), <Switch checked={p.show_game} onChange={(e) => void patch({ show_game: e.target.checked })} />)}
    {row(t('Let friends join my game when it has room', '游戏有空位时允许好友加入'), <Switch checked={p.joinable} onChange={(e) => void patch({ joinable: e.target.checked })} />)}
    {row(t('Let people find me by name', '允许别人按名字找到我'), <Switch checked={p.searchable} onChange={(e) => void patch({ searchable: e.target.checked })} />)}
    <div className="fr-blocked"><b>{t('Blocked players', '已屏蔽的玩家')}</b>
      {!blocked ? <span className="mute">{t('Loading…', '加载中…')}</span> : !blocked.length ? <span className="mute">{t('Nobody is blocked.', '没有屏蔽任何人。')}</span>
        : blocked.map((b) => <div key={b.id} className="row" style={{ justifyContent: 'space-between' }}><span>{b.name}</span><Button size="sm" variant="ghost" onClick={async () => { try { await api(`/social/blocks/${b.id}`, { method: 'DELETE' }); setBlocked((l) => (l || []).filter((x) => x.id !== b.id)); } catch (e) { fail(e); } }}>{t('Unblock', '取消屏蔽')}</Button></div>)}
    </div>
  </div>;
}
export { ApiError };
