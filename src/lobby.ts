// Private lobbies that only invited friends can enter (GCP.match.find({ private: true }), GCP.friends.invite). The lobby
// has no code anyone types: the platform draws one and signs it into a lobby token for the players in it. An invite
// carries that token; the invitee's matchmaking request names the accepted invite, never the lobby, so the only way in
// is an invite (or a friend's "Join", which is recorded as an accepted invite).
import type { Env } from './env';
import { matchTicketKey } from './matchmaker';
// @ts-ignore plain JS module
import { signPlayToken, verifyPlayToken } from './runtime/game-worker.js';

export const LOBBY_TTL_S = 2 * 3600;
export interface Lobby { typ: 'lobby'; g: string; e: string; c: string; q: string; n: number; m: number; t: number; o: string; x: number }

/** A fresh, unguessable lobby code (a different namespace from the old typed codes, so a typed code never reaches one). */
export const newLobbyCode = () => [...crypto.getRandomValues(new Uint8Array(12))].map((b) => b.toString(16).padStart(2, '0')).join('');

export async function signLobby(env: Env, l: Omit<Lobby, 'typ' | 'x'>): Promise<string> {
  return signPlayToken({ typ: 'lobby', ...l, x: Math.floor(Date.now() / 1000) + LOBBY_TTL_S }, await matchTicketKey(env, l.g));
}
/** The lobby a token names, if it is genuine, for this game and environment, and not expired. */
export async function readLobby(env: Env, token: unknown, g: string, e: string): Promise<Lobby | null> {
  if (typeof token !== 'string' || token.length > 400) return null;
  const p = await verifyPlayToken(token, await matchTicketKey(env, g), g, e) as Lobby | null;
  return p && p.typ === 'lobby' && /^[a-f0-9]{24}$/.test(String(p.c)) ? p : null;
}
