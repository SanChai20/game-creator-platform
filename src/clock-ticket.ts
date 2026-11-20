// The play-clock ticket: what the page showing a game sends with each check-in (header x-gcp-clock) so a check-in needs
// no database read to know whose it is. POST /play hands it out with the session, signed for that session, that player
// and the sign-in cookie that started it, so it proves the same browser sign-in is still sending the cookie (or, for a
// guest, the same guest cookie). Whether that sign-in has ended since is the player's clock's job (src/clock-do.ts
// confirms the binding once a minute), exactly like every game service call (session-binding.js).
import { hmacHex, safeEqual } from './util';

export const CLOCK_HEADER = 'x-gcp-clock';
const mac = (secret: string, sid: string, player: string, login: string | null) => hmacHex(secret, `clock:${sid}:${player}:${login || ''}`);

export async function clockTicket(secret: string, sid: string, player: string, login: string | null): Promise<string> {
  return `${sid}.${player}.${await mac(secret, sid, player, login)}`;
}
/** The player a ticket is for, when it names this session and the request carries the sign-in (login id) it was signed with. */
export async function readClockTicket(secret: string, ticket: string | null | undefined, sid: string, login: string | null): Promise<string | null> {
  const m = /^(ps_[a-z0-9]{8,40})\.((?:u_|guest_)[A-Za-z0-9_]{4,60})\.([a-f0-9]{64})$/.exec(String(ticket || ''));
  if (!m || m[1] !== sid) return null;
  return safeEqual(m[3], await mac(secret, m[1], m[2], login)) ? m[2] : null;
}
