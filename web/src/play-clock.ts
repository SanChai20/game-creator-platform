// The platform's play clock, page side (the server side is src/play-clock.ts). While a game is open, the page showing it
// checks in every 15 seconds with how long the game was on screen since the last check-in. The page runs on the
// platform's own origin with the player's sign-in, so the game cannot send or change these; every play number the
// platform shows (plays, play time, players online, the player's record, trial and refund time) comes from them.
import { useEffect } from 'react';

export const CHECKIN_MS = 15_000;

/** `clock` is the ticket POST /play handed out with the session: with it a check-in needs no sign-in lookup on the server. */
export function usePlayClock(session: string | null, clock?: string | null) {
  useEffect(() => {
    if (!session) return;
    let visibleMs = 0, mark = performance.now(), visible = document.visibilityState === 'visible', done = false;
    const settle = () => { const n = performance.now(); if (visible) visibleMs += n - mark; mark = n; };
    const send = (last = false) => {
      if (done) return;
      settle(); const ms = Math.round(visibleMs); visibleMs = 0;
      if (last) done = true;
      void fetch(`/api/plays/${encodeURIComponent(session)}/seen`, { method: 'POST', credentials: 'same-origin', keepalive: last, headers: { 'content-type': 'application/json', ...(clock ? { 'x-gcp-clock': clock } : {}) }, body: JSON.stringify({ visible_ms: ms }) }).catch(() => undefined);
    };
    const onVis = () => { settle(); visible = document.visibilityState === 'visible'; };
    const onHide = () => send(true);
    send();   // the first check-in: the game is open on this page
    const id = setInterval(() => send(), CHECKIN_MS);
    document.addEventListener('visibilitychange', onVis); addEventListener('pagehide', onHide);
    return () => { clearInterval(id); document.removeEventListener('visibilitychange', onVis); removeEventListener('pagehide', onHide); send(true); };
  }, [session, clock]);
}
