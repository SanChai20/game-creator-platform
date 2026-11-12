import type { OAuthHelpers } from '@cloudflare/workers-oauth-provider';

export interface Env {
  DB: D1Database;
  FILES: R2Bucket;
  OAUTH_KV: KVNamespace;
  ASSETS: Fetcher;
  ROOMS: DurableObjectNamespace;
  PIPELINE: DurableObjectNamespace;
  BROWSER?: Fetcher;
  OAUTH_PROVIDER: OAuthHelpers;
  DEPLOY_DRIVER: string;            // cloudflare | local
  GAMES_BUCKET: string;
  STRIPE_API_BASE: string;
  SESSION_SECRET: string;
  CF_API_TOKEN?: string;
  CF_ACCOUNT_ID?: string;
  ADMIN_CLAIM_TOKEN?: string;
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  PUBLIC_ORIGIN?: string;           // set to pin the public origin (custom domain); otherwise taken from the request
  VERIFY_ORIGIN?: string;           // dev only: origin the local verifier can reach
}

export interface User {
  id: string; email: string; name: string; role: 'user' | 'admin'; status: 'active' | 'suspended';
  creator: number; creator_since: number | null; stripe_account: string | null; stripe_payouts_enabled: number;
  payout_country: string | null; created_at: number;
}

export interface Project {
  id: string; owner_id: string; slug: string; title: string; tagline: string; description: string; tags: string; controls: string;
  status: 'draft' | 'live' | 'offline' | 'removed'; live_version: number | null; preview_version: number | null; next_version: number;
  cover_key: string | null; price_cents: number; sales: number; featured: number; plays: number; seconds: number; rating_sum: number; rating_count: number;
  removed_reason: string | null; created_at: number; updated_at: number; published_at: number | null;
}

export interface Version {
  project_id: string; n: number; note: string; manifest: string; file_count: number; bytes: number; files: string;
  status: 'queued' | 'deploying' | 'verifying' | 'verified' | 'failed'; stage: string; report: string | null;
  screenshot_key: string | null; human_ok: number; created_at: number; verified_at: number | null; published_at: number | null;
}

/** Thrown anywhere in a request; turned into a JSON error (HTTP) or a tool error (MCP). */
export class AppError extends Error {
  constructor(public status: number, message: string, public code = 'error', public hint?: string) { super(message); }
}
export const bad = (msg: string, hint?: string) => new AppError(400, msg, 'bad_request', hint);
export const notFound = (msg = 'Not found') => new AppError(404, msg, 'not_found');
export const forbidden = (msg = 'Forbidden', hint?: string) => new AppError(403, msg, 'forbidden', hint);
