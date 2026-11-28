// Parties and voice (src/parties.js, /api/social/party*): a small group of friends that moves between games together,
// in the friends panel, with voice chat between the members. Voice is peer to peer (WebRTC, audio only): the platform
// passes the connection messages along over the friends connection and never hears the audio. The small bar at the
// bottom of the screen stays while in voice, over every page and over a fullscreen game.
import { useSyncExternalStore } from 'react';
import { api, local, navigate, t } from './lib';
import { Button } from './ui';

export interface PartyMember { id: string; name: string; voice: boolean; leader: boolean }
export interface PartyView {
  party: { id: string; leader: string | null; me_leader: boolean; members: PartyMember[]; pending: { id: string; name: string }[]; game: { id: string; slug: string; title: string } | null } | null;
  invites: { id: string; from: { id: string; name: string }; size: number; expires_at: number }[];
  max: number; enabled?: boolean; voice?: boolean;
}
type ToastFn = (x: { kind: string; title: string; body?: string; who?: string; ttl?: number; actions?: { label: string; primary?: boolean; run: () => void }[] }) => void;

const P = {
  me: null as string | null, view: null as PartyView | null, v: 0,
  // voice
  on: false, joining: false, muted: false, err: '' as string,
  stream: null as MediaStream | null, ice: null as RTCIceServer[] | null,
  peers: new Map<string, { pc: RTCPeerConnection; audio: HTMLAudioElement; queue: RTCIceCandidateInit[]; state: string }>(),
};
const subs = new Set<() => void>();
const emit = () => { P.v++; subs.forEach((f) => f()); };
export const useParty = () => { useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f); }, () => P.v); return P; };
let toast: ToastFn = () => {};
const fail = (e: unknown) => toast({ kind: 'bad', title: (e as Error).message || t('Something went wrong.', '出了点问题。') });

// ---- loading and events -----------------------------------------------------------------------------------------------
let loadTimer = 0;
async function load() {
  if (!P.me) return;
  try {
    P.view = await api<PartyView>('/social/party');
    const ids = new Set((P.view.party?.members || []).map((m) => m.id));
    if (P.on && !P.view.party) await leaveVoice(false);
    for (const id of [...P.peers.keys()]) if (!ids.has(id)) drop(id);
    emit();
  } catch { /* signed out or busy: next event */ }
}
const soon = () => { clearTimeout(loadTimer); loadTimer = window.setTimeout(load, 200); };

/** The friends panel signs in and out with the account; it hands over its pop-up function. */
export function partyUser(uid: string | null, showToast: ToastFn) {
  toast = showToast;
  if (uid === P.me) return;
  if (P.on) void leaveVoice(true);
  P.me = uid; P.view = null; emit();
  if (uid) void load();
}

/** What the friends connection delivers for parties: changes, invites and voice connection messages. */
export function partyEvent(ev: any) {
  if (ev.kind === 'rtc') { void onSignal(String(ev.from || ''), ev.data); return; }
  if (ev.kind === 'party_invite' && ev.invite) {
    soon();
    toast({ kind: 'invite', who: ev.invite.from.name, ttl: 25000, title: t('{name} invites you to their party', '{name} 邀请你加入派对', { name: ev.invite.from.name }),
      body: t('Play together and talk in voice chat.', '一起玩，并在语音里聊天。'), actions: [
        { label: t('Join party', '加入派对'), primary: true, run: () => void answer(ev.invite.id, true) },
        { label: t('Decline', '拒绝'), run: () => void answer(ev.invite.id, false) }] });
    return;
  }
  if (ev.kind === 'party') {
    soon();
    if (ev.left && P.peers.has(ev.left)) drop(ev.left);
    if (ev.joined && ev.joined.id !== P.me) toast({ kind: 'accepted', who: ev.joined.name, title: t('{name} joined the party', '{name} 加入了派对', { name: ev.joined.name }) });
    if (ev.game && ev.by) toast({ kind: 'invite', who: ev.by.name, ttl: 25000, title: t('{name} is playing {game} with the party', '{name} 正带着派对玩 {game}', { name: ev.by.name, game: local(ev.game, 'title') }), actions: [
      { label: t('Play', '开始游戏'), primary: true, run: () => navigate(`/g/${encodeURIComponent(ev.game.slug)}?play=1`) }] });
  }
}

/** The leader started a game: the party is brought into it (members get "Play"). */
export function partyGame(slug: string | null) {
  const p = P.view?.party;
  if (!p || !p.me_leader || p.members.length < 2 || !slug || p.game?.slug === slug) return;
  p.game = { id: '', slug, title: '' };
  void api('/social/party/game', { body: { slug } }).then(soon, () => {});
}

// ---- actions --------------------------------------------------------------------------------------------------------------
export async function inviteToParty(f: { id: string; name: string }) {
  try { await api('/social/party/invite', { body: { to: f.id } }); toast({ kind: 'answer', title: t('Party invite sent to {name}.', '已邀请 {name} 加入派对。', { name: f.name }) }); soon(); } catch (e) { fail(e); }
}
async function answer(id: string, yes: boolean) {
  try { P.view = { ...(P.view as PartyView), ...(await api<PartyView>(`/social/party/${id}/${yes ? 'accept' : 'decline'}`, { method: 'POST' })) }; emit(); soon(); } catch (e) { fail(e); soon(); }
}
async function startParty() { try { P.view = await api<PartyView>('/social/party', { method: 'POST' }); emit(); } catch (e) { fail(e); } }
async function leaveParty() {
  if (P.on) await leaveVoice(true);
  try { await api('/social/party/leave', { method: 'POST' }); await load(); } catch (e) { fail(e); }
}
async function kick(id: string) { try { await api('/social/party/kick', { body: { id } }); drop(id); soon(); } catch (e) { fail(e); } }
async function lead(id: string) { try { await api('/social/party/lead', { body: { id } }); soon(); } catch (e) { fail(e); } }

// ---- voice ------------------------------------------------------------------------------------------------------------------
const signal = (to: string, data: unknown) => api('/social/party/signal', { body: { to, data } }).catch(() => {});
function drop(id: string) {
  const p = P.peers.get(id); if (!p) return;
  P.peers.delete(id);
  try { p.pc.close(); } catch { /* closed */ }
  p.audio.srcObject = null; p.audio.remove(); emit();
}
function peer(id: string) {
  const old = P.peers.get(id); if (old) return old;
  const pc = new RTCPeerConnection({ iceServers: P.ice || [{ urls: 'stun:stun.cloudflare.com:3478' }] });
  const audio = document.createElement('audio'); audio.autoplay = true; audio.setAttribute('playsinline', ''); audio.hidden = true; document.body.appendChild(audio);
  const entry = { pc, audio, queue: [] as RTCIceCandidateInit[], state: 'connecting' };
  P.peers.set(id, entry);
  for (const tr of P.stream?.getTracks() || []) pc.addTrack(tr, P.stream!);
  pc.onicecandidate = (e) => { if (e.candidate) void signal(id, { ice: e.candidate.toJSON() }); };
  pc.ontrack = (e) => { audio.srcObject = e.streams[0] || new MediaStream([e.track]); void audio.play().catch(() => {}); };
  pc.onconnectionstatechange = () => { entry.state = pc.connectionState; emit(); if (pc.connectionState === 'failed') drop(id); };
  emit();
  return entry;
}
async function call(id: string) {
  const { pc } = peer(id);
  await pc.setLocalDescription(await pc.createOffer());
  await signal(id, { sdp: pc.localDescription?.toJSON() });
}
async function onSignal(from: string, data: any) {
  if (!P.on || !from || !data) return;
  try {
    if (data.bye) { drop(from); return; }
    if (data.sdp?.type === 'offer') {
      const had = P.peers.get(from);
      if (had?.pc.signalingState === 'have-local-offer') {
        // both called at once: the account with the smaller id gives way and answers, the other ignores this offer
        if ((P.me || '') > from) return;
        drop(from);
      } else if (had?.pc.remoteDescription) drop(from);   // a fresh offer replaces an old connection (they rejoined)
      const early = had && !had.pc.remoteDescription ? had.queue.splice(0) : [];
      const p = peer(from); p.queue.push(...early);
      await p.pc.setRemoteDescription(data.sdp);
      for (const c of p.queue.splice(0)) await p.pc.addIceCandidate(c).catch(() => {});
      await p.pc.setLocalDescription(await p.pc.createAnswer());
      await signal(from, { sdp: p.pc.localDescription?.toJSON() });
    } else if (data.sdp?.type === 'answer') {
      const p = P.peers.get(from); if (!p) return;
      await p.pc.setRemoteDescription(data.sdp);
      for (const c of p.queue.splice(0)) await p.pc.addIceCandidate(c).catch(() => {});
    } else if (data.ice) {
      const p = P.peers.get(from) || peer(from);
      if (p.pc.remoteDescription) await p.pc.addIceCandidate(data.ice).catch(() => {}); else p.queue.push(data.ice);
    }
  } catch (e) { console.warn('voice', e); }
}
/** Joins the party's voice chat: asks for the microphone, then calls everyone already in it (they answer). */
export async function joinVoice() {
  if (P.on || P.joining) return;
  P.joining = true; P.err = ''; emit();
  try {
    if (!navigator.mediaDevices?.getUserMedia || typeof RTCPeerConnection !== 'function') throw new Error(t('This browser cannot do voice chat.', '此浏览器不支持语音聊天。'));
    P.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }).catch(() => { throw new Error(t('Allow the microphone to talk in voice chat.', '请允许使用麦克风以进行语音聊天。')); });
    P.ice = (await api<{ iceServers: RTCIceServer[] }>('/social/party/ice')).iceServers;
    P.muted = false; P.on = true;
    const r = await api<{ in_voice: string[] }>('/social/party/voice', { body: { on: true } });
    for (const id of r.in_voice) void call(id).catch(() => {});
    soon();
  } catch (e) {
    P.err = (e as Error).message; P.on = false; P.stream?.getTracks().forEach((tr) => tr.stop()); P.stream = null; fail(e);
  } finally { P.joining = false; emit(); }
}
export async function leaveVoice(tell = true) {
  if (!P.on) return;
  P.on = false;
  for (const id of [...P.peers.keys()]) { void signal(id, { bye: true }); drop(id); }
  P.stream?.getTracks().forEach((tr) => tr.stop()); P.stream = null; emit();
  if (tell) await api('/social/party/voice', { body: { on: false } }).catch(() => {});
  soon();
}
export function toggleMute() { P.muted = !P.muted; P.stream?.getAudioTracks().forEach((tr) => { tr.enabled = !P.muted; }); emit(); }
// a closed tab leaves voice, so the others do not wait for it
if (typeof window !== 'undefined') addEventListener('pagehide', () => { if (P.on) { try { void fetch('/api/social/party/voice', { method: 'POST', credentials: 'same-origin', keepalive: true, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ on: false }) }); } catch { /* gone */ } } });

// ---- views ----------------------------------------------------------------------------------------------------------------
const Mic = ({ off }: { off?: boolean }) => <svg className="ico" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true"><rect x="7" y="2.5" width="6" height="10" rx="3" /><path d="M4.5 9.5a5.5 5.5 0 0 0 11 0M10 15v2.5" />{off && <path d="M3 3l14 14" />}</svg>;

/** The party, at the top of the friends panel: its members and their voice, invites waiting, and what the player can do. */
export function PartyBox() {
  const s = useParty(), v = s.view;
  if (!v || v.enabled === false) return null;
  const p = v.party;
  return (
    <section className="pt-box" aria-label={t('Party', '派对')}>
      {v.invites.map((i) => (
        <div key={i.id} className="fr-invite">
          <div className="fr-invite-text"><b>{t('{name} invites you to their party', '{name} 邀请你加入派对', { name: i.from.name })}</b><span>{i.size === 1 ? t('1 player', '1 位玩家') : t('{n} players', '{n} 位玩家', { n: i.size })}</span></div>
          <div className="row" style={{ gap: 6 }}><Button size="sm" variant="primary" onClick={() => void answer(i.id, true)}>{t('Join', '加入')}</Button><Button size="sm" variant="ghost" onClick={() => void answer(i.id, false)}>{t('Decline', '拒绝')}</Button></div>
        </div>))}
      {!p ? (
        <div className="pt-start">
          <span className="grow"><b>{t('Party', '派对')}</b><small>{t('Group up with friends, follow the leader into games and talk in voice chat.', '和好友组队，跟着队长进入游戏，并在语音里聊天。')}</small></span>
          <Button size="sm" onClick={() => void startParty()}>{t('Start a party', '创建派对')}</Button>
        </div>
      ) : (
        <div className="pt-party">
          <div className="pt-head">
            <b className="grow">{t('Your party', '你的派对')} <span className="dim">{p.members.length}/{v.max}</span></b>
            {v.voice !== false && (s.on
              ? <><Button size="sm" variant="ghost" onClick={toggleMute} aria-pressed={s.muted}>{s.muted ? t('Unmute', '取消静音') : t('Mute', '静音')}</Button><Button size="sm" onClick={() => void leaveVoice()}>{t('Leave voice', '退出语音')}</Button></>
              : <Button size="sm" variant="primary" onClick={() => void joinVoice()} disabled={s.joining}><Mic />{s.joining ? t('Connecting…', '连接中…') : t('Join voice', '加入语音')}</Button>)}
          </div>
          {p.game && p.game.title && <div className="pt-game fs-sm">{t('Playing {game}', '正在玩 {game}', { game: local(p.game, 'title') })}{!p.me_leader && <> · <button type="button" className="linkish" onClick={() => navigate(`/g/${encodeURIComponent(p.game!.slug)}?play=1`)}>{t('Join them', '加入他们')}</button></>}</div>}
          <ul className="pt-members">
            {p.members.map((m) => {
              const me = m.id === s.me, link = s.peers.get(m.id);
              const vs = !m.voice ? '' : me ? (s.on ? (s.muted ? t('muted', '已静音') : t('in voice', '语音中')) : '') : !s.on ? t('in voice', '语音中') : link?.state === 'connected' ? t('connected', '已连接') : t('connecting…', '连接中…');
              return (
                <li key={m.id}>
                  <span className={'fr-av' + (m.voice ? ' pt-voice' : '')} aria-hidden="true">{(m.name || '?').slice(0, 1).toUpperCase()}</span>
                  <span className="grow clip"><b>{m.name}</b>{me && <span className="dim"> ({t('you', '你')})</span>}{m.leader && <span className="pt-lead"> · {t('Leader', '队长')}</span>}{vs && <span className="dim fs-sm"> · {vs}</span>}</span>
                  {p.me_leader && !me && <span className="row" style={{ gap: 4 }}>
                    <button type="button" className="linkish fs-sm" onClick={() => void lead(m.id)}>{t('Make leader', '设为队长')}</button>
                    <button type="button" className="linkish fs-sm" onClick={() => void kick(m.id)}>{t('Remove', '移出')}</button>
                  </span>}
                </li>);
            })}
            {p.pending.map((m) => <li key={'i' + m.id} className="dim"><span className="fr-av" aria-hidden="true">{(m.name || '?').slice(0, 1).toUpperCase()}</span><span className="grow clip">{m.name} · {t('invited', '已邀请')}</span></li>)}
          </ul>
          <div className="row pt-foot">
            <small className="grow dim">{p.me_leader ? t('Games you start bring the party along. Invite friends from their ⋯ menu.', '你开始的游戏会带上整个派对。在好友的 ⋯ 菜单里邀请他们。') : t('When the leader starts a game, you get a Play button.', '队长开始游戏时，你会收到“开始游戏”按钮。')}</small>
            <Button size="sm" variant="ghost" onClick={() => void leaveParty()}>{t('Leave party', '离开派对')}</Button>
          </div>
        </div>
      )}
    </section>
  );
}

/** While in voice: a small bar at the bottom corner of every page (and over a fullscreen game) to mute or hang up. */
export function VoiceBar() {
  const s = useParty();
  if (!s.on) return null;
  const others = (s.view?.party?.members || []).filter((m) => m.id !== s.me && m.voice);
  const live = others.filter((m) => s.peers.get(m.id)?.state === 'connected').length;
  return (
    <div className="pt-bar" role="region" aria-label={t('Voice chat', '语音聊天')}>
      <span className={'pt-dot' + (s.muted ? ' off' : '')} aria-hidden="true" />
      <span className="pt-bar-text">{others.length ? t('Voice · {n} of {m} connected', '语音 · 已连接 {n}/{m}', { n: live, m: others.length }) : t('Voice · waiting for the party', '语音 · 等待队友加入')}</span>
      <button type="button" onClick={toggleMute} aria-pressed={s.muted} aria-label={s.muted ? t('Unmute', '取消静音') : t('Mute', '静音')} title={s.muted ? t('Unmute', '取消静音') : t('Mute', '静音')}><Mic off={s.muted} /></button>
      <button type="button" className="pt-hang" onClick={() => void leaveVoice()} aria-label={t('Leave voice', '退出语音')} title={t('Leave voice', '退出语音')}>×</button>
    </div>
  );
}
