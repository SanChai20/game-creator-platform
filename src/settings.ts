import type { Env } from './env';
import { now } from './util';

// Every product parameter the admin can change. `public` ones are sent to the web app.
export const SETTING_DEFS = {
  brand_name: { v: 'Game Creator', type: 'text', group: 'Brand', label: 'Product name', public: true },
  tagline: { v: 'Frontier craft, reusable by every agent.', type: 'text', group: 'Brand', label: 'Slogan', public: true },
  signups_open: { v: true, type: 'bool', group: 'Access', label: 'Allow new sign-ups', public: true },
  require_login_to_play: { v: true, type: 'bool', group: 'Access', label: 'Require login to play', public: true },

  creator_fee_cents: { v: 3000, type: 'cents', group: 'Creator fee', label: 'One-time creator fee', public: true },
  creator_fee_required: { v: true, type: 'bool', group: 'Creator fee', label: 'Require the fee before publishing (preview stays free)', public: true },
  creator_fee_for_projects: { v: false, type: 'bool', group: 'Creator fee', label: 'Require the fee before creating projects at all', public: true },

  withdraw_min_cents: { v: 5000, type: 'cents', group: 'Withdrawals', label: 'Minimum balance to withdraw', public: true },
  allow_manual_withdrawals: { v: true, type: 'bool', group: 'Withdrawals', label: 'Allow manual withdrawals (paid by an admin outside Stripe)', public: true },
  stripe_platform_country: { v: 'US', type: 'text', group: 'Withdrawals', label: 'Country of the platform Stripe account (2 letters)' },

  platform_fee_percent: { v: 10, type: 'number', group: 'Paid games', label: 'Platform cut of each game sale (percent)', public: true },
  sale_processing_percent: { v: 0, type: 'number', group: 'Paid games', label: 'Payment processing cost passed on to the creator (percent of price, on top of the cut)', public: true },
  sale_processing_fixed_cents: { v: 0, type: 'cents', group: 'Paid games', label: 'Payment processing cost passed on to the creator (fixed, per sale)', public: true },
  game_price_min_cents: { v: 199, type: 'cents', group: 'Paid games', label: 'Lowest price a paid game can have', public: true },
  game_price_max_cents: { v: 9999, type: 'cents', group: 'Paid games', label: 'Highest price a paid game can have', public: true },
  paid_games_enabled: { v: true, type: 'bool', group: 'Paid games', label: 'Allow creators to sell games', public: true },
  earnings_hold_days: { v: 7, type: 'int', group: 'Paid games', label: 'Days a sale is held before the creator can withdraw it (covers refunds)', public: true },

  play_min_seconds: { v: 30, type: 'int', group: 'Play counting', label: 'Seconds before a session counts as a play', public: true },
  review_requires_play: { v: true, type: 'bool', group: 'Reviews', label: 'Only players with a counted play can rate and review', public: true },

  verify_ready_timeout_s: { v: 30, type: 'int', group: 'Verification', label: 'Seconds a game has to call GCP.ready()' },
  verify_min_frames: { v: 6, type: 'int', group: 'Verification', label: 'Frames that must render in the observation window (the check runs on a software GPU, so keep this low)' },
  verify_observe_s: { v: 3, type: 'int', group: 'Verification', label: 'Observation window after ready (seconds)' },
  verify_playthrough_s: { v: 20, type: 'int', group: 'Verification', label: "Seconds a game's own play-through script may take" },
  craft_target: { v: 75, type: 'int', group: 'Verification', label: 'Craft score (0 to 100) agents are told to reach before calling a game finished; publishing never depends on it', public: true },
  verify_browser_required: { v: true, type: 'bool', group: 'Verification', label: 'Require the automated browser check (otherwise a clean creator preview session also qualifies)' },
  verify_human_min_seconds: { v: 20, type: 'int', group: 'Verification', label: 'Seconds of clean real-browser preview play that qualify a version when the automated browser cannot run it' },

  bundle_max_files: { v: 300, type: 'int', group: 'Limits', label: 'Files per game bundle', public: true },
  bundle_max_bytes: { v: 50 * 1024 * 1024, type: 'int', group: 'Limits', label: 'Bundle size (bytes)', public: true },
  file_max_bytes: { v: 20 * 1024 * 1024, type: 'int', group: 'Limits', label: 'Single file size (bytes)', public: true },
  projects_per_user: { v: 50, type: 'int', group: 'Limits', label: 'Projects per creator' },
  allow_server_code: { v: true, type: 'bool', group: 'Limits', label: 'Allow games to ship server code (server/index.js)' },
  room_max_peers: { v: 16, type: 'int', group: 'Limits', label: 'Players per multiplayer room' },

  oauth_access_ttl_s: { v: 3600, type: 'int', group: 'Agent access (OAuth)', label: 'Access token lifetime (seconds)' },
  oauth_grant_ttl_s: { v: 30 * 86400, type: 'int', group: 'Agent access (OAuth)', label: 'Authorization lifetime before the agent must be re-approved (seconds)' },
} as const;

export type SettingKey = keyof typeof SETTING_DEFS;
export type Settings = { [K in SettingKey]: (typeof SETTING_DEFS)[K]['v'] extends boolean ? boolean : (typeof SETTING_DEFS)[K]['v'] extends number ? number : string };

let cache: { at: number; s: Settings } | null = null;

export async function getSettings(env: Env, fresh = false): Promise<Settings> {
  if (!fresh && cache && now() - cache.at < 15000) return cache.s;
  const s: Record<string, unknown> = {};
  for (const [k, d] of Object.entries(SETTING_DEFS)) s[k] = d.v;
  const rows = await env.DB.prepare('SELECT key, value FROM settings').all<{ key: string; value: string }>();
  for (const r of rows.results) { if (r.key in SETTING_DEFS) { try { s[r.key] = JSON.parse(r.value); } catch { /* keep default */ } } }
  cache = { at: now(), s: s as Settings };
  return cache.s;
}

export async function putSettings(env: Env, patch: Record<string, unknown>): Promise<Settings> {
  const stmts = [];
  for (const [k, v] of Object.entries(patch)) {
    const def = (SETTING_DEFS as Record<string, { v: unknown; type: string; options?: readonly string[] }>)[k];
    if (!def) continue;
    let val: unknown = v;
    if (def.type === 'bool') val = !!v;
    else if (def.type === 'int' || def.type === 'cents') { val = Math.round(Number(v)); if (!Number.isFinite(val as number) || (val as number) < 0) continue; }
    else if (def.type === 'number') { val = Number(v); if (!Number.isFinite(val as number) || (val as number) < 0) continue; }
    else if (def.type === 'select') { if (!def.options!.includes(String(v))) continue; val = String(v); }
    else val = String(v).slice(0, 300);
    stmts.push(env.DB.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at').bind(k, JSON.stringify(val), now()));
  }
  if (stmts.length) await env.DB.batch(stmts);
  cache = null;
  return getSettings(env, true);
}

/** Internal key/value state that is not a product setting (cached workers.dev subdomain, …). */
export async function getState<T>(env: Env, key: string, fallback: T): Promise<T> {
  const r = await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind('_' + key).first<{ value: string }>();
  try { return r ? JSON.parse(r.value) : fallback; } catch { return fallback; }
}
export async function setState(env: Env, key: string, value: unknown): Promise<void> {
  await env.DB.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at').bind('_' + key, JSON.stringify(value), now()).run();
}
