import type { OAuthHelpers } from '@cloudflare/workers-oauth-provider';

export interface Env {
  DB: D1Database;
  FILES: R2Bucket;
  OAUTH_KV: KVNamespace;
  ASSETS: Fetcher;
  ROOMS: DurableObjectNamespace;
  MATCHMAKER: DurableObjectNamespace;
  BOTS?: DurableObjectNamespace;     // preview test bots: one BotFleet per creator, game and region (src/bots.ts)
  PIPELINE: DurableObjectNamespace;
  PLAY_CLOCK?: DurableObjectNamespace;   // one per player: check-ins and heartbeats (src/clock-do.ts, setting play_clock_do)
  GAME_TALLY?: DurableObjectNamespace;   // one per game: play totals and players online, written in batches
  SOCIAL?: DurableObjectNamespace;       // one per account: presence and live delivery for friends (src/social.ts)
  ACP?: DurableObjectNamespace;          // one per account: the ACP workbench relay between bridges and console pages (src/acp.ts)
  BROWSER?: Fetcher;
  PLAY_RL?: RateLimit;               // game service calls per play session (wrangler.jsonc ratelimits)
  SERVER_RL?: RateLimit;             // game server code's store calls per game and environment
  // Cloudflare Email Service (send_email binding): payout emails to creators (src/mail.ts)
  EMAIL?: { send(m: { from: { email: string; name: string }; to: string; subject: string; text: string; html: string }): Promise<{ messageId: string }> };
  AI?: Ai;                          // Workers AI: plain-language summaries of open implementations
  OAUTH_PROVIDER: OAuthHelpers;
  DEPLOY_DRIVER: string;            // cloudflare | dispatch | shared | local (src/hosting.ts)
  DISPATCHER?: DispatchNamespace;   // Workers for Platforms: the dispatch namespace games are deployed to (driver "dispatch")
  DISPATCH_NAMESPACE?: string;      // its name, for the upload API
  LOADER?: WorkerLoader;            // Worker Loader: games' server code runs as Dynamic Workers (driver "shared", src/game-host.ts)
  GAME_HOST?: string;               // games are served at <script>.<GAME_HOST> (needed for "dispatch"; optional otherwise)
  GAME_OUTBOUND?: string;           // set when the DISPATCHER binding has the outbound Worker (outbound/wrangler.jsonc)
  GAME_ZONE_ID?: string;            // zone of GAME_HOST, for per-script routes while games are still standard Workers
  GAMES_BUCKET: string;
  STRIPE_API_BASE: string;
  SESSION_SECRET: string;
  CF_API_TOKEN?: string;
  CF_ACCOUNT_ID?: string;
  ADMIN_CLAIM_TOKEN?: string;
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  STRIPE_ACCOUNTS_WEBHOOK_SECRET?: string;  // signing secret of the event destination for creators' Accounts v2 events (thin)
  TEST_MAIL_TOKEN?: string;         // secret, optional: lets the live test scripts read their own sign-up links and codes for @example.com addresses (src/mail.ts testMailbox)
  DEV_MAIL?: string;                // "1" only in wrangler dev: emails are kept in memory for the tests (GET /api/dev/mail) instead of sent
  PUBLIC_ORIGIN?: string;           // set to pin the public origin (custom domain); otherwise taken from the request
  VERIFY_ORIGIN?: string;           // dev only: origin the local verifier can reach
}

export interface User {
  id: string; email: string; name: string; role: 'user' | 'admin'; status: 'active' | 'suspended';
  creator: number; creator_since: number | null;
  // creator is 1 only while the license is valid (src/license.ts); creator_licensed is the stored flag, set once granted
  creator_plan: string | null; creator_until: number | null; creator_licensed?: number;
  stripe_account: string | null; stripe_payouts_enabled: number;
  payout_country: string | null; created_at: number;
  totp_enabled_at: number | null;               // two-factor sign-in on since then (src/two-factor.ts); null while off
}

export interface Project {
  id: string; owner_id: string; slug: string; title: string; tagline: string; description: string; tags: string; controls: string;
  status: 'draft' | 'live' | 'offline' | 'removed'; live_version: number | null; preview_version: number | null; next_version: number;
  ws_base?: number | null;                      // the version the workspace last matched (migrations/0048_version_sync.sql)
  coming_soon_at?: number | null; release_note?: string | null;   // the coming soon page (migrations/0057_coming_soon.sql)
  protection?: string | null;                   // main's protection, JSON (src/collab-core.ts)
  cover_key: string | null; price_cents: number; trial_minutes: number; sales: number; featured: number; plays: number; seconds: number; rating_sum: number; rating_count: number;
  removed_reason: string | null; deleted_at?: number | null; created_at: number; updated_at: number; published_at: number | null;
  open_implementation: number; open_implementation_at: number | null;
  skill_price_cents: number; skill_sales: number; skill_copies: number; skill_views: number;   // the build skill (src/skills.ts)
  sale_price_cents?: number | null; sale_starts_at?: number | null; sale_ends_at?: number | null; price_raised_at?: number | null;   // limited-time sale (src/sales.ts)
  listing_i18n: string;                         // JSON: the store listing translated into platform languages, each with an optional cover_key
  listing_lang?: string | null;                 // the language the project's own listing is in (null: worked out from the text)
  langs?: string | null;                        // platform languages the live version is played in, comma-separated (null until recorded)
  age: number | null;                           // the live version's age rating (null until recorded)
  mature: string;                               // adults-only categories of the live version, comma-separated: sexual, violence, other ('' for everyone)
  storage_bytes?: number | null;                // storage this game may use; null: the platform default (bundle_max_bytes)
}

export interface Version {
  project_id: string; n: number; note: string; manifest: string; file_count: number; bytes: number; files: string;
  status: 'queued' | 'deploying' | 'verifying' | 'verified' | 'failed'; stage: string; report: string | null;
  screenshot_key: string | null; human_ok: number; created_at: number; verified_at: number | null; published_at: number | null;
  review?: 'pending' | 'approved' | 'denied' | null; review_note?: string | null; reviewed_at?: number | null; reviewed_by?: string | null;
  gate?: string | null;                         // the release gate's last outcome for this version (src/release-gate.ts)
  base?: number | null;                         // the version it was built on (base_version)
  branch?: string | null;                       // the branch id it was deployed from; null: main (src/collab.ts)
  change_number?: number | null;                // the change request a merge version merged
  actor?: string;                               // who deployed it
}

/** Thrown anywhere in a request; turned into a JSON error (HTTP) or a tool error (MCP). */
export class AppError extends Error {
  constructor(public status: number, message: string, public code = 'error', public hint?: string) { super(message); }
}
export const bad = (msg: string, hint?: string) => new AppError(400, msg, 'bad_request', hint);
export const notFound = (msg = 'Not found', hint?: string) => new AppError(404, msg, 'not_found', hint);
export const forbidden = (msg = 'Forbidden', hint?: string) => new AppError(403, msg, 'forbidden', hint);
