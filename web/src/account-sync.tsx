// Keeping every tab on the account the browser is signed in to, and offering a guest's progress to the account.
// The server is what keeps game sessions bound to the right player (src/session-binding.js); this only makes the pages
// notice at once, so a tab never goes on showing (or playing as) an account the browser has left.
import { useEffect, useRef, useState } from 'react';
import { api, ago, playTime, t, type Me } from './lib';
import { Button, Modal } from './ui';

const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('gcp-auth') : null;

/** Tells the other tabs of this site that the account changed (signed in, out, or as someone else). */
export function announceAuth() { try { channel?.postMessage({ changed: Date.now() }); } catch { /* closed */ } }

/** Re-reads the account when another tab signs in or out, and when this tab comes back into view. */
export function useAuthSync(userId: string | null, refresh: () => Promise<void>) {
  const current = useRef(userId); current.current = userId;
  useEffect(() => {
    let last = 0;
    const check = async (force = false) => {
      if (!force && Date.now() - last < 5000) return; last = Date.now();
      const me = await api<{ user: Me | null }>('/me').catch(() => null);
      if (me && (me.user?.id || null) !== current.current) await refresh().catch(() => {});
    };
    const onMsg = () => void check(true), onVis = () => { if (document.visibilityState === 'visible') void check(); };
    channel?.addEventListener('message', onMsg); document.addEventListener('visibilitychange', onVis); addEventListener('focus', onVis);
    return () => { channel?.removeEventListener('message', onMsg); document.removeEventListener('visibilitychange', onVis); removeEventListener('focus', onVis); };
  }, [refresh]);
}

interface GuestGame { slug: string; title: string; seconds: number; last_played: number | null; kept: boolean }
const LATER = 'gcp.guest-later';

/**
 * After signing in, progress this browser made as a guest is offered to the account. Nothing moves without the player's
 * yes: on a shared computer the guest progress may be someone else's. Either answer is final for that guest progress.
 */
export function GuestProgressPrompt({ user, toast }: { user: Me | null; toast: (msg: string, bad?: boolean) => void }) {
  const [games, setGames] = useState<GuestGame[] | null>(null), [busy, setBusy] = useState(false);
  useEffect(() => {
    setGames(null);
    if (!user) return;
    try { if (sessionStorage.getItem(LATER) === user.id) return; } catch { /* storage blocked */ }
    let live = true;
    const load = () => api<{ games: GuestGame[] }>('/guest-progress').then((r) => { if (live) setGames(r.games.length ? r.games : null); }, () => {});
    void load();
    // answered in another tab: the question goes away here too
    channel?.addEventListener('message', load);
    return () => { live = false; channel?.removeEventListener('message', load); };
  }, [user?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!user || !games) return null;
  const later = () => { try { sessionStorage.setItem(LATER, user.id); } catch { /* storage blocked */ } setGames(null); };
  const answer = async (move: boolean) => {
    setBusy(true);
    try {
      const r = await api<{ moved: number; kept: number }>('/guest-progress', { body: { move } });
      setGames(null); announceAuth();   // a guest game still open in another tab stops there
      toast(move ? (r.moved ? t('Your guest progress is now on your account.', '访客进度已转入你的账号。') : t('Your account already had progress in these games, so it was kept.', '你的账号在这些游戏中已有进度，已保留账号进度。')) : t('The guest progress was left out of your account.', '访客进度未转入你的账号。'));
    } catch (e) { toast((e as Error).message, true); } finally { setBusy(false); }
  };
  const moving = games.filter((g) => !g.kept), kept = games.filter((g) => g.kept);
  return (
    <Modal onClose={later}><div className="stack l">
      <h3 style={{ fontSize: 22 }}>{t('Move guest progress to {name}?', '把访客进度转入 {name}？', { name: user.name })}</h3>
      <p className="mute">{t('This browser has progress from playing as a guest. Move it only if it is yours: on a shared computer it may belong to someone else.', '这个浏览器里有以访客身份游玩的进度。只有确认是你自己的才转入：在共用电脑上，它可能属于别人。')}</p>
      {moving.length > 0 && <ul className="stack s" style={{ margin: 0, paddingLeft: 18 }}>{moving.map((g) => <li key={g.slug}><b>{g.title}</b> <span className="mute fs-sm">· {playTime(g.seconds)}{g.last_played ? ` · ${ago(g.last_played)}` : ''}</span></li>)}</ul>}
      {kept.length > 0 && <p className="mute fs-sm">{t('Your account already has progress in {games}. That progress stays as it is and the guest progress is not mixed into it.', '你的账号在 {games} 中已有进度，将保持不变，不会与访客进度混在一起。', { games: kept.map((g) => g.title).join(', ') })}</p>}
      <div className="row">
        <Button variant="primary" disabled={busy} onClick={() => answer(true)}>{moving.length ? t('Move to my account', '转入我的账号') : t('OK', '好的')}</Button>
        <Button disabled={busy} onClick={() => answer(false)}>{t('It is not mine', '这不是我的')}</Button>
        <Button variant="ghost" disabled={busy} onClick={later}>{t('Decide later', '稍后决定')}</Button>
      </div>
    </div></Modal>
  );
}
