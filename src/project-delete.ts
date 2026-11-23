// A creator deletes a project of their own: the MCP tool delete_project and the console's Delete project button.
// Soft delete: the project becomes 'removed' with deleted_at set (migrations/0045_project_delete.sql), so it no longer
// counts toward the project limit, leaves the creator's lists and its Workers are taken down. Its versions, purchases and
// events stay; players' saves and scores are purged REMOVED_DATA_DAYS later (src/cleanup.ts), and until then a platform
// admin can restore it. What may not be deleted at all: a live game (take it offline first, so players are never cut off
// mid-session by surprise) and a game or build skill anyone has bought (buyers keep what they paid for; offline is the way).
import { bad, forbidden, type Env, type Project, type User } from './env';
import { undeployGame } from './deploy';
import { logEvent } from './projects';
import { REMOVED_DATA_DAYS } from './cleanup';
import { now } from './util';

export interface DeleteFacts { status: string; slug: string; id: string; purchases: number; skillPurchases: number; otherPlayers: number; priceCents: number;
  /** A game or build skill that was for sale while live: when it last stopped being live (ms), or null when never. */
  soldUntil?: number | null; at?: number }
/** How long a buyer's open Stripe Checkout can still complete after the game goes offline (Stripe's default and longest
 *  session is 24 hours): a paid game cannot be deleted before that, so no payment lands on a deleted game. */
export const CHECKOUT_WINDOW_MS = 24 * 3_600_000;
export type DeleteVerdict =
  | { ok: false; code: 'live' | 'bought' | 'removed' | 'checkout'; reason: string; fix: string }
  | { ok: true; confirmed: boolean; confirm_with: string; warnings: string[] };

/** Whether a project may be deleted, and whether the confirm the caller gave matches (its address or id, exactly). */
export function deleteVerdict(f: DeleteFacts, confirm: unknown): DeleteVerdict {
  if (f.status === 'removed') return { ok: false, code: 'removed', reason: 'This project is already deleted or was removed by the platform.', fix: 'Nothing to do.' };
  if (f.status === 'live') return { ok: false, code: 'live', reason: 'This game is live, so it cannot be deleted.', fix: 'Take it offline first (unpublish, or Take offline in the console), then delete it.' };
  if (f.purchases > 0 || f.skillPurchases > 0) {
    const what = [f.purchases > 0 && `${f.purchases} purchase(s) of the game`, f.skillPurchases > 0 && `${f.skillPurchases} purchase(s) of its build skill`].filter(Boolean).join(' and ');
    return { ok: false, code: 'bought', reason: `This game cannot be deleted: it has ${what}, and buyers keep what they paid for.`, fix: 'Take it offline instead (unpublish). It then stops counting as live, and a platform admin can help if the project limit is in the way.' };
  }
  if (f.soldUntil != null && (f.at ?? Date.now()) - f.soldUntil < CHECKOUT_WINDOW_MS) {
    const left = Math.ceil((f.soldUntil + CHECKOUT_WINDOW_MS - (f.at ?? Date.now())) / 3_600_000);
    return { ok: false, code: 'checkout', reason: 'This game was for sale while it was live less than 24 hours ago, and a buyer who opened checkout then can still pay.', fix: `Try again in about ${left} hour(s).` };
  }
  const warnings: string[] = [];
  if (f.otherPlayers > 0) warnings.push(`${f.otherPlayers} player(s) other than you have played it. Their saves, stats and scores are deleted ${REMOVED_DATA_DAYS} days after the project is.`);
  if (f.priceCents > 0) warnings.push('It has a price set, but nobody has bought it.');
  const c = typeof confirm === 'string' ? confirm.trim() : '';
  return { ok: true, confirmed: !!c && (c === f.slug || c === f.id), confirm_with: f.slug, warnings };
}

export async function deleteFacts(env: Env, p: Project): Promise<DeleteFacts> {
  const sold = (p.price_cents || 0) > 0 || (p.skill_price_cents || 0) > 0;
  const [buy, skill, players, off] = await Promise.all([
    env.DB.prepare('SELECT COUNT(*) AS n FROM purchases WHERE project_id = ?').bind(p.id).first<{ n: number }>(),
    env.DB.prepare('SELECT COUNT(*) AS n FROM skill_purchases WHERE project_id = ?').bind(p.id).first<{ n: number }>().catch(() => ({ n: 0 })),
    env.DB.prepare('SELECT COUNT(*) AS n FROM player_games WHERE project_id = ? AND user_id != ?').bind(p.id, p.owner_id).first<{ n: number }>().catch(() => ({ n: 0 })),
    sold && p.live_version != null ? env.DB.prepare("SELECT MAX(created_at) AS t FROM events WHERE project_id = ? AND kind = 'offline'").bind(p.id).first<{ t: number | null }>() : Promise.resolve(null),
  ]);
  return { status: p.status, slug: p.slug, id: p.id, purchases: buy?.n || 0, skillPurchases: skill?.n || 0, otherPlayers: players?.n || 0, priceCents: p.price_cents || 0,
    // a paid game that was live and has no offline event (taken down some other way) counts as just taken down
    soldUntil: sold && p.live_version != null ? off?.t ?? p.updated_at : null, at: now() };
}

/** Deletes the project when the verdict allows it and confirm matches; otherwise throws, or (no confirm) says what it would do. */
export async function deleteProject(env: Env, user: User, p: Project, confirm: unknown, actor: string): Promise<Record<string, unknown>> {
  if (p.owner_id !== user.id) throw forbidden('Only the creator who owns a project can delete it.');
  const facts = await deleteFacts(env, p), v = deleteVerdict(facts, confirm);
  if (!v.ok) throw v.code === 'bought' ? forbidden(v.reason, v.fix) : bad(v.reason, v.fix);
  if (!v.confirmed) {
    if (confirm !== undefined && confirm !== null && confirm !== '') throw bad(`confirm "${String(confirm).slice(0, 80)}" does not match this project.`, `Pass confirm: "${p.slug}" (the game's address) to delete "${p.title}".`);
    return { deleted: false, project: p.id, title: p.title, status: p.status, ...(v.warnings.length ? { warnings: v.warnings } : {}), confirm_with: p.slug,
      next: `Nothing was deleted. Check with the user that "${p.title}" is the project to delete, then call again with confirm: "${p.slug}".` };
  }
  const t = now();
  const r = await env.DB.prepare("UPDATE projects SET status = 'removed', removed_reason = 'Deleted by the creator', deleted_at = ?, updated_at = ? WHERE id = ? AND status NOT IN ('live', 'removed')").bind(t, t, p.id).run();
  if (!r.meta.changes) throw bad('The project changed while it was being deleted (it went live, or was already deleted).', 'Call list_projects and try again.');
  for (const e of ['live', 'preview'] as const) { try { await undeployGame(env, p.id, e); } catch (err) { console.error('undeploy on delete failed', p.id, e, err); } }
  await logEvent(env, p.id, 'deleted', `Deleted by the creator: ${p.title}`, null, actor);
  return { deleted: true, project: p.id, title: p.title, ...(v.warnings.length ? { warnings: v.warnings } : {}),
    note: `The project no longer counts toward the project limit and is gone from list_projects. Players' data is deleted after ${REMOVED_DATA_DAYS} days; until then a platform admin can restore it.` };
}
