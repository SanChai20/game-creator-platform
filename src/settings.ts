import { bad, type Env } from './env';
import { now } from './util';

// Every product parameter the admin can change. `public` ones are sent to the web app.
export const SETTING_DEFS = {
  brand_name: { v: 'HearthCade', type: 'text', group: 'Brand', label: 'Product name', public: true },
  tagline: { v: 'Frontier craft, reusable by every agent.', type: 'text', group: 'Brand', label: 'Slogan', public: true },
  support_email: { v: 'support@hearthcade.com', type: 'text', group: 'Brand', label: 'Support email address', public: true },
  signups_open: { v: true, type: 'bool', group: 'Access', label: 'Allow new sign-ups', public: true },
  require_login_to_play: { v: true, type: 'bool', group: 'Access', label: 'Require login to play', public: true },

  // Creator licenses (src/license.ts): both one-time payments. 0 makes that license free: it is granted at once.
  license_term_cents: { v: 1000, type: 'cents', group: 'Creator license', label: 'Price of the time-limited creator license (one-time payment, not a subscription)', public: true },
  license_term_days: { v: 365, type: 'int', group: 'Creator license', label: 'Days a time-limited creator license stays valid', public: true },
  license_lifetime_cents: { v: 5000, type: 'cents', group: 'Creator license', label: 'Price of the lifetime creator license (one-time payment, never expires)', public: true },
  creator_fee_required: { v: true, type: 'bool', group: 'Creator license', label: 'Require a valid creator license to publish (preview stays free)', public: true },
  creator_fee_for_projects: { v: false, type: 'bool', group: 'Creator license', label: 'Require a valid creator license before creating projects at all', public: true },

  auto_payouts: { v: true, type: 'bool', group: 'Withdrawals', label: 'Pay creators automatically each day once their available balance reaches the minimum (Stripe payout accounts only)', public: true },
  withdraw_min_cents: { v: 5000, type: 'cents', group: 'Withdrawals', label: 'Minimum balance to withdraw', public: true },
  allow_manual_withdrawals: { v: false, type: 'bool', group: 'Withdrawals', label: 'Allow manual withdrawals (paid by an admin outside Stripe)', public: true },
  stripe_platform_country: { v: 'US', type: 'text', group: 'Withdrawals', label: 'Country of the platform Stripe account (2 letters)' },

  platform_fee_percent: { v: 10, type: 'number', group: 'Paid games', label: 'Platform cut of each game sale (percent)', public: true },
  platform_fee_open_percent: { v: 5, type: 'number', group: 'Paid games', label: 'Platform cut of each sale of a game that shares its Open Implementation (percent)', public: true },
  sale_processing_percent: { v: 0, type: 'number', group: 'Paid games', label: 'Payment processing cost passed on to the creator (percent of price, on top of the cut)', public: true },
  sale_processing_fixed_cents: { v: 0, type: 'cents', group: 'Paid games', label: 'Payment processing cost passed on to the creator (fixed, per sale)', public: true },
  game_price_min_cents: { v: 199, type: 'cents', group: 'Paid games', label: 'Lowest price a paid game can have', public: true },
  game_price_max_cents: { v: 9999, type: 'cents', group: 'Paid games', label: 'Highest price a paid game can have', public: true },
  paid_games_enabled: { v: true, type: 'bool', group: 'Paid games', label: 'Allow creators to sell games', public: true },
  trials_enabled: { v: true, type: 'bool', group: 'Paid games', label: 'Allow creators to offer a free trial of a paid game (minutes of play before buying)', public: true },
  trial_max_minutes: { v: 120, type: 'int', group: 'Paid games', label: 'Longest free trial a creator can offer (minutes)', public: true },
  new_creator_days: { v: 90, type: 'int', group: 'Paid games', label: 'A creator counts as new for this many days after signing up (0: nobody is new)', public: true },
  new_creator_hold_days: { v: 30, type: 'int', group: 'Paid games', label: 'Days a new creator\'s sales are held before they can be withdrawn (card disputes can arrive weeks later)', public: true },
  earnings_hold_days: { v: 3, type: 'int', group: 'Paid games', label: 'Days a sale is held before the creator can withdraw it (never shorter than the refund window)', public: true },
  refund_window_hours: { v: 24, type: 'int', group: 'Paid games', label: 'Hours after paying that a buyer can refund a game themselves, once per game (0 turns self-serve refunds off)', public: true },
  refund_max_play_minutes: { v: 30, type: 'int', group: 'Paid games', label: 'Most minutes a buyer can have played a game (trial included) and still refund it themselves', public: true },

  play_min_seconds: { v: 30, type: 'int', group: 'Play counting', label: 'Seconds before a session counts as a play', public: true },
  play_clock_do: { v: false, type: 'bool', group: 'Play counting', label: 'Run the play clock in Durable Objects (needed for tens of thousands of players online; numbers can lag up to a minute)' },
  review_requires_play: { v: true, type: 'bool', group: 'Reviews', label: 'Only players with a counted play can rate and review', public: true },

  verify_ready_timeout_s: { v: 30, type: 'int', group: 'Verification', label: 'Seconds a game has to call GCP.ready()' },
  verify_min_frames: { v: 6, type: 'int', group: 'Verification', label: 'Frames that must render in the observation window (the check runs on a software GPU, so keep this low)' },
  verify_observe_s: { v: 3, type: 'int', group: 'Verification', label: 'Observation window after ready (seconds)' },
  verify_playthrough_s: { v: 30, type: 'int', group: 'Verification', label: "Seconds a game's own play-through script may take" },
  verify_devices: { v: 'iphone,ipad', type: 'text', group: 'Verification', label: 'Touch devices each version is also played on after it passes (emulated): iphone, ipad, android, comma separated; empty turns the device check off' },
  craft_target: { v: 75, type: 'int', group: 'Verification', label: 'Craft score (0 to 100) agents are told to reach before calling a game finished; publishing never depends on it', public: true },
  verify_capture_required: { v: true, type: 'bool', group: 'Verification', label: 'Fail a version that does not hand over its exact frame (the capture check: everything visible drawn in canvases, GCP.test.onCapture and onState registered); it fails only a version of a live game, any other game gets a note; off reports it without failing' },
  verify_browser_required: { v: true, type: 'bool', group: 'Verification', label: 'Require the automated browser check (otherwise a clean creator preview session also qualifies)' },
  metadata_required: { v: true, type: 'bool', group: 'Verification', label: 'Require complete game metadata to publish (genre, requirements, languages, players, content descriptors)' },
  verify_human_min_seconds: { v: 20, type: 'int', group: 'Verification', label: 'Seconds of clean real-browser preview play that qualify a version when the automated browser cannot run it' },

  // Storage: what a game's files may add up to. bundle_max_bytes is the default; Admin, Games raises or lowers it for one game.
  bundle_max_bytes: { v: 50 * 1024 * 1024, type: 'bytes', group: 'Storage', label: 'Default storage per game: the most one game\'s files may add up to (MB)', public: true },
  file_max_bytes: { v: 20 * 1024 * 1024, type: 'bytes', group: 'Storage', label: 'Largest single file (MB)', public: true },
  bundle_max_files: { v: 300, type: 'int', group: 'Storage', label: 'Files per game', public: true },
  storage_requests_open: { v: true, type: 'bool', group: 'Storage', label: 'Let creators ask for more storage for a game (each request waits for an admin unless it is under the automatic limit)', public: true },
  storage_auto_approve_bytes: { v: 0, type: 'bytes', group: 'Storage', label: 'Approve requests at once up to this much storage per game (MB; 0: an admin reviews every request)' },
  storage_max_bytes: { v: 200 * 1024 * 1024, type: 'bytes', group: 'Storage', label: 'Most storage a creator can ask for, for one game (MB; an admin can still set more)', public: true },
  projects_per_user: { v: 10, type: 'int', group: 'Limits', label: 'Projects per creator' },
  game_data_max_db_gb: { v: 8, type: 'int', group: 'Limits', label: 'Stop saving game data (saves, stats, scores, server store) once the database passes this many GB, so sign-in and purchases keep working (D1 stops at 10 GB; 0: never)' },
  allow_server_code: { v: true, type: 'bool', group: 'Limits', label: 'Allow games to ship server code (server/index.js)' },
  room_max_peers: { v: 16, type: 'int', group: 'Limits', label: 'Players per multiplayer room' },
  allow_matches: { v: true, type: 'bool', group: 'Limits', label: 'Allow server-run matches (server/match.js) and the matchmaker' },
  match_max_players: { v: 16, type: 'int', group: 'Limits', label: 'Players per server-run match (2 to 64)' },
  room_msgs_per_second: { v: 60, type: 'int', group: 'Limits', label: 'Messages a player may send to a multiplayer room per second (bursts of twice that are allowed; 5 to 240)' },

  dup_check: { v: true, type: 'bool', group: 'Originality', label: 'Check each verified version against other creators\' live games (copies) and for uploads that are not games' },
  dup_block: { v: true, type: 'bool', group: 'Originality', label: 'Block publishing a copy or a non-game (off: report it as a warning only)' },
  dup_ai: { v: true, type: 'bool', group: 'Originality', label: 'Ask Workers AI about borderline cases (similar but not clearly copied) and whether each upload that is not built with a game engine is a game' },
  dup_ai_daily: { v: 1000, type: 'int', group: 'Originality', label: 'Most Workers AI originality calls per day (Clef decision models, about $0.00002 to $0.00013 each; past the cap the rules decide)' },

  content_check: { v: true, type: 'bool', group: 'Content and conduct', label: 'Check each verified version for content that is never allowed (hate, scams, phishing, sexual content involving minors), adult content it does not declare, and abusive code (miners, password forms, hidden servers)' },
  mature_allowed: { v: true, type: 'bool', group: 'Content and conduct', label: 'Allow adult (18+) games that declare sexual content or graphic violence (shown blurred, with a warning players confirm)' },
  content_block: { v: true, type: 'bool', group: 'Content and conduct', label: 'Block publishing a version the content check refuses (off: report it as a warning only)' },
  content_ai_daily: { v: 1000, type: 'int', group: 'Content and conduct', label: 'Most Workers AI content reviews per day (Clef with up to 4 frames of the game in play, about $0.001 each; past the cap a small rule set decides)' },
  content_ai_threshold: { v: 50, type: 'int', group: 'Content and conduct', label: 'How likely (percent) the content review must find a version harmful, or showing adult content it does not declare, to refuse it' },

  open_impl_ai: { v: true, type: 'bool', group: 'Open implementation', label: 'Write a plain-language summary of each open game with Workers AI (once per published version, about $0.001 each)' },
  open_impl_free_boost_percent: { v: 50, type: 'int', group: 'Open implementation', label: 'Ranking boost for free games that share their Open Implementation, among free games (percent more weight on their recent play; 0 turns it off, at most 100; poorly rated games get none)', public: true },
  open_impl_ai_daily: { v: 200, type: 'int', group: 'Open implementation', label: 'Most AI summaries written per day (the rest use the rule-based summary)' },

  game_cpu_ms: { v: 0, type: 'int', group: 'Game Workers', label: 'CPU time a game Worker may use per request, in milliseconds (0: the Cloudflare default, 30000; at most 300000)', public: true },
  game_subrequests: { v: 0, type: 'int', group: 'Game Workers', label: 'Outgoing requests a game Worker may make per request, including its calls to the platform (0: the Cloudflare default, 10000)', public: true },
  game_blocked_hosts: { v: '', type: 'text', group: 'Game Workers', label: 'Hosts game server code may not call, comma-separated (enforced by the outbound Worker once games run on Workers for Platforms)' },

  // Agent debugging (debug_preview, src/debug.ts) shares Browser Rendering with the verifier: keep room for verification.
  debug_enabled: { v: true, type: 'bool', group: 'Debugging and feedback', label: 'Let agents open their game\'s preview in a browser they drive (debug_preview: screenshots, clicks, keys)', public: true },
  debug_max_sessions: { v: 3, type: 'int', group: 'Debugging and feedback', label: 'Debug browsers open at once across the platform (each uses one Browser Rendering browser; verification needs some too)' },
  debug_sessions_per_day: { v: 40, type: 'int', group: 'Debugging and feedback', label: 'Debug browsers one account may open per day' },
  debug_session_minutes: { v: 10, type: 'int', group: 'Debugging and feedback', label: 'Longest a debug browser stays open (minutes, 1 to 10; it also closes after 3 idle minutes)', public: true },
  feedback_enabled: { v: true, type: 'bool', group: 'Debugging and feedback', label: 'Let creators send annotated screenshots of their preview to their agent (creator feedback queue)', public: true },
  feedback_max_pending: { v: 20, type: 'int', group: 'Debugging and feedback', label: 'Feedback items waiting per game before the creator must remove some or the agent read them', public: true },
  feedback_keep_days: { v: 30, type: 'int', group: 'Debugging and feedback', label: 'Days an unread feedback item is kept', public: true },

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
    const def = (SETTING_DEFS as Record<string, { v: unknown; type: string; options?: readonly string[]; label: string }>)[k];
    if (!def) throw bad(`Unknown setting: ${k}.`);
    // Every value is checked strictly and refused with the setting's name, never coerced: "false" is not true.
    let val: unknown = v;
    const max = k.endsWith('_percent') ? 100 : def.type === 'bytes' ? 1e12 : 1e9;
    if (def.type === 'bool') { if (v === true || v === 'true' || v === 1 || v === '1') val = true; else if (v === false || v === 'false' || v === 0 || v === '0') val = false; else throw bad(`${def.label}: must be on or off.`); }
    else if (def.type === 'int' || def.type === 'cents' || def.type === 'bytes') { val = Math.round(Number(v)); if (v === '' || v === null || !Number.isFinite(val as number) || (val as number) < 0 || (val as number) > max) throw bad(`${def.label}: must be a whole number from 0 to ${max}.`); }
    else if (def.type === 'number') { val = Number(v); if (v === '' || v === null || !Number.isFinite(val as number) || (val as number) < 0 || (val as number) > max) throw bad(`${def.label}: must be a number from 0 to ${max}.`); }
    else if (def.type === 'select') { if (!def.options!.includes(String(v))) throw bad(`${def.label}: must be one of ${def.options!.join(', ')}.`); val = String(v); }
    else val = String(v ?? '').slice(0, 300);
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
