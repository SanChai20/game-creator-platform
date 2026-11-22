// Binding each game session to the platform identity that started it, and moving a guest's progress into an account.
// Plain JS over a D1-shaped database so the rules can be tested without a Worker (tests/session-binding.mjs).
//
// The rules, enforced here and nowhere else:
//   - An account's play session belongs to the sign-in it was started from (plays.login_id). Signing out, signing in as
//     someone else in the same browser, the sign-in expiring or an admin suspending the account ends that sign-in, and
//     every game still open on it (another tab, a reload, a token kept on the game's own origin) is refused from the next
//     call on. A game can never keep writing to an account the browser is no longer signed in to.
//   - A play token is only good for the play session it names, and only for the player that session was started for.
//   - A guest's progress moves into an account only when the player asks for it from the browser that holds the guest
//     id (its signed, HttpOnly cookie), once: the guest id is then claimed, never handed out again, and its tokens stop.
//   - Moving never overwrites anything the account already has. In a game where the account already has progress, the
//     account's progress is kept as it is and the guest's is left behind (reported as kept), so two saves are never mixed.

export const SESSION_ENDED = 'session_ended';

/**
 * Checks that the session a play token names is still bound to a live identity.
 * Returns null when it is, or { code, message } saying why the game must stop using the token.
 */
export async function bindingProblem(db, tok, t = Date.now()) {
  const guest = String(tok.u || '').startsWith('guest_');
  const r = await db.prepare(`SELECT p.user_id, p.login_id, p.kind, p.project_id, p.env, s.user_id AS login_user, s.expires_at AS login_expires,
      EXISTS (SELECT 1 FROM guest_claims g WHERE g.guest_id = ?2) AS claimed
    FROM (SELECT 1) LEFT JOIN plays p ON p.id = ?1 LEFT JOIN sessions s ON s.id = p.login_id`).bind(String(tok.s || ''), guest ? String(tok.u) : '').first();
  const unknown = { code: SESSION_ENDED, reason: 'unknown', message: 'This play session is no longer valid. Reopen the game from its page.' };
  // The token's session must be a session of this game and environment, of the same kind (a verifier token names a
  // verifier session; any other token names a player's or owner's session). A token signed with a leaked key therefore
  // cannot claim to be the verifier to skip the checks below.
  if (!r || r.project_id == null) return unknown;
  if (r.project_id !== tok.g || (r.env != null && r.env !== tok.e)) return unknown;
  if (tok.k === 'verify') return r.kind === 'verify' && tok.u === `verify:${tok.s}` ? null : unknown;
  if (r.kind === 'verify') return unknown;
  // A preview test bot (src/bots.ts): a session of kind 'bot' in the preview of this game, nowhere else. Its row is
  // removed when the creator's fleet stops, which ends it (unknown above).
  if (tok.k === 'bot' || r.kind === 'bot') return tok.k === 'bot' && r.kind === 'bot' && r.env === 'preview' && tok.e === 'preview' && r.user_id === tok.u ? null : unknown;
  // A claimed guest: the progress moved to an account (or was left behind), so the guest session is over.
  if (guest && r.claimed) return { code: SESSION_ENDED, reason: 'signed_in', message: 'You signed in, so this guest session ended. Reopen the game to keep playing on your account.' };
  if (r.user_id !== tok.u) return unknown;
  if (guest) return null;
  if (r.login_id == null) return null;    // sessions started before binding existed run out with their token (six hours at most)
  if (!r.login_user || r.login_user !== tok.u || !(r.login_expires > t)) {
    return { code: SESSION_ENDED, reason: 'signed_out', message: 'You signed out or switched accounts, so this game session ended. Reopen the game to keep playing.' };
  }
  return null;
}

const SCOPED = ['saves', 'player_stats', 'scores', 'player_games'];

/** Per game, what a guest has and whether the account already has progress there. Live games only (guests play live). */
export async function guestProgress(db, guestId, userId) {
  if (!String(guestId).startsWith('guest_')) return [];
  if (await db.prepare('SELECT 1 AS x FROM guest_claims WHERE guest_id = ?').bind(guestId).first()) return [];
  const rows = await db.prepare(`SELECT g.project_id AS scope, p.slug, p.title, pg.seconds, pg.last_at,
      (SELECT COUNT(*) FROM saves s WHERE s.project_id = g.project_id AND s.user_id = ?1) AS saves,
      (SELECT COUNT(*) FROM player_stats s WHERE s.project_id = g.project_id AND s.user_id = ?1) AS stats,
      (SELECT COUNT(*) FROM scores s WHERE s.project_id = g.project_id AND s.user_id = ?1) AS scores,
      EXISTS (SELECT 1 FROM saves s WHERE s.project_id = g.project_id AND s.user_id = ?2)
        OR EXISTS (SELECT 1 FROM player_stats s WHERE s.project_id = g.project_id AND s.user_id = ?2) AS account_has
    FROM (${SCOPED.map((tb) => `SELECT project_id FROM ${tb} WHERE user_id = ?1`).join(' UNION ')}) g
    LEFT JOIN projects p ON p.id = g.project_id LEFT JOIN player_games pg ON pg.project_id = g.project_id AND pg.user_id = ?1
    WHERE g.project_id NOT LIKE '%:preview' ORDER BY pg.last_at DESC LIMIT 200`).bind(guestId, userId || '').all();
  return rows.results.filter((r) => r.slug).map((r) => ({
    game: r.scope, slug: r.slug, title: r.title, seconds: r.seconds || 0, last_played: r.last_at || null,
    saves: r.saves, stats: r.stats, scores: r.scores,
    // the account already has a save or stats here: its own progress stays and the guest's is not moved
    kept: !!r.account_has,
  }));
}

/**
 * Moves a guest's progress into an account, or (move = false) leaves it behind for good. Runs once per guest id:
 * the claim row is written first and a second call finds it and does nothing, whichever browser or tab makes it.
 * Returns { moved, kept, games } or null when the guest id was already claimed.
 */
export async function claimGuest(db, guestId, userId, name, { move = true, t = Date.now() } = {}) {
  if (!String(guestId).startsWith('guest_') || !userId || String(userId).startsWith('guest_')) return null;
  const games = move ? await guestProgress(db, guestId, userId) : [];
  const claim = await db.prepare('INSERT INTO guest_claims (guest_id, user_id, claimed_at) VALUES (?, ?, ?) ON CONFLICT(guest_id) DO NOTHING').bind(guestId, move ? userId : '', t).run();
  if (!claim.meta?.changes) return null;
  const go = games.filter((g) => !g.kept), kept = games.length - go.length, stmts = [];
  for (const { game } of go) {
    // OR IGNORE: should the account have gained a row with the same key since the check above, the account's row stays
    stmts.push(
      db.prepare('UPDATE OR IGNORE saves SET user_id = ?1 WHERE project_id = ?3 AND user_id = ?2').bind(userId, guestId, game),
      db.prepare('UPDATE OR IGNORE player_stats SET user_id = ?1 WHERE project_id = ?3 AND user_id = ?2').bind(userId, guestId, game),
    );
  }
  for (const { game } of games) {
    // Leaderboards: a board the account has no score on takes the guest's best, under the account's name.
    stmts.push(db.prepare('UPDATE OR IGNORE scores SET user_id = ?1, name = ?4 WHERE project_id = ?3 AND user_id = ?2').bind(userId, guestId, game, String(name || '').slice(0, 40) || 'Player'));
    // The play record adds up: sessions and time played as a guest count for the account.
    stmts.push(
      db.prepare(`INSERT INTO player_games (project_id, user_id, first_at, last_at, sessions, seconds, last_version)
        SELECT project_id, ?1, first_at, last_at, sessions, seconds, last_version FROM player_games WHERE project_id = ?3 AND user_id = ?2
        ON CONFLICT(project_id, user_id) DO UPDATE SET first_at = MIN(first_at, excluded.first_at), last_at = MAX(last_at, excluded.last_at),
          sessions = sessions + excluded.sessions, seconds = seconds + excluded.seconds, last_version = CASE WHEN excluded.last_at > last_at THEN excluded.last_version ELSE last_version END`).bind(userId, guestId, game),
      db.prepare('DELETE FROM player_games WHERE project_id = ? AND user_id = ?').bind(game, guestId),
    );
  }
  // Counted plays move too, so the account can review a game it played as a guest. Moving the rows also ends the guest's
  // open sessions: their tokens still name the guest, and a play row now owned by the account no longer matches them.
  if (move) stmts.push(db.prepare("UPDATE plays SET user_id = ? WHERE user_id = ? AND env = 'live'").bind(userId, guestId));
  stmts.push(db.prepare('UPDATE guest_claims SET moved = ?, kept = ? WHERE guest_id = ?').bind(go.length, kept, guestId));
  await db.batch(stmts);
  return { moved: go.length, kept, games: games.map((g) => ({ slug: g.slug, title: g.title, moved: !g.kept })) };
}

/** Daily cleanup: what a claimed guest left behind (kept or declined) is unreachable; it goes after 30 days. */
export const claimedGuestCleanupStmts = (db, before) => [
  ...['saves', 'player_stats', 'scores', 'player_games'].map((tb) => db.prepare(`DELETE FROM ${tb} WHERE user_id IN (SELECT guest_id FROM guest_claims WHERE claimed_at < ?)`).bind(before)),
];
