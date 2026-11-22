// The tools an external agent uses to deploy, verify, publish and manage web games, and to use the platform's services.
// The platform hosts games; it does not tell agents how to make them. Engines, renderers, art and asset
// pipelines are the agent's business. Descriptions say when to call a tool and what comes next.
import { unzipSync } from 'fflate';
import { AppError, bad, forbidden, type Env, type User } from '../env';
import { balanceOf, freeSkillShared, splitSale, splitSkillSale } from '../earnings';
import { NO_CODE, setSkillPrice, skillForAgent, skillGate, storeItem, writeSkill } from '../skills';
import { enqueue } from '../pipeline';
import {
  assetText, checkProject, createProject, defaultImports, deleteFile, ensureCompat, ensureVersionMeta, getVersion, listFiles, logEvent, ownedProject, publicVersion,
  putFile, readFile, snapshot, updateProjectMeta, versionEligible, type Issue,
} from '../projects';
import { takeOffline, trialStats } from '../routes/api';
import { trialMinutes } from '../trials';
import type { GameRoom } from '../room';
import { actBots, botOptions, botStatus, startBots, stopBots } from '../bots';
import { getSettings } from '../settings';
import { applySale, saleView } from '../sales';
import { licenseText, offersText } from '../license';
import { STORAGE_GUIDE, budgetOf, mb, overBudget, assertFits, requestStorage, storageLine, storageReport } from '../storage';
import { gameAnalytics, onlineNow } from '../analytics';
// @ts-ignore plain JS module
import { DataError, serverStoreOp } from '../player-data.js';
import { assertGameDataRoom } from '../db-guard';
import { currentChecks, gateError, gateText, gateView, recordGate, releaseGate, storedGate, type GateResult } from '../release-gate';
import { DISCOVERY, NOT_PROVIDED, openPerks, platformServices } from './services';
import { NEVER_SHARED, findImplementations, implementationCard, setOpenImplementation } from '../implementations';
import { THREE_VERSION } from '../generated/runtime-source';
import { BROWSERS, DEVICES, FEATURE_IDS, GRAPHICS, INPUTS, ORIENTATIONS, OSES, describeRequirements, parseRequirements, type Compat, type Requirements } from '../../web/src/compat';
import { ACCESSIBILITY, BUILD_FIELDS, CONTENT_CHOICES, MANIFEST, mergeManifest, GENRES, MODES, genresOf, matureOf, parseAccessibility, parseContent, parsePlayers, type MetaIssue, type MetaRecord } from '../../web/src/gamemeta';
import { MAX_TAGS, MIN_TAGS, missingTags, missingToPublish, normalizeStoredTags, TAG_GROUPS, tagGroup, TAGS, tagsOnly } from '../../web/src/tags';
import { baseListingLang, languageName, listingLangCode, parseLanguages, type Languages } from '../../web/src/languages';
import { isLang } from '../../web/src/i18n/langs';
import { listingCoverage } from '../listing';
import { OPERATOR } from '../../web/src/operator';
import type { Project } from '../env';
import { addDays, clamp, cleanPath, dayOf, extOf, isText, now, parseJson, sha256, token as randomToken, unb64, usd } from '../util';
import { actDebug, closeDebug, openDebug, type DebugResult } from '../debug';
import { feedbackProject, pendingFeedback, takeFeedback } from '../feedback';
// @ts-ignore plain JS module
import { DEBUG_LIMITS, VIEWPORTS } from '../debug-core.js';
// @ts-ignore plain JS module
import { FEEDBACK_LIMITS } from '../feedback-rules.js';

export interface ToolCtx { env: Env; user: User; origin: string; client: string }
/** A tool answer with pictures: the JSON part is sent as text, each image as an MCP image block after it. */
export class WithImages { constructor(public data: unknown, public images: { data: Uint8Array; type: string }[]) {} }
interface Tool {
  name: string; title: string; description: string; inputSchema: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean };
  run: (a: Record<string, any>, c: ToolCtx) => Promise<unknown>;
}

export { WEB_ONLY } from '../web-only.js';
import { WEB_ONLY } from '../web-only.js';
export const ENGINE_EXPORTS = 'Any engine with a web export works: export to Web / HTML5 / WebGL and upload the exported folder (Unity: set Compression Format to Disabled; Godot\'s Web export and Phaser, PlayCanvas, Babylon.js, Three.js or plain canvas games upload as they are). The export must call GCP.ready() once it is playable.';

/** The platform guides an agent can read: how the platform behaves, not how to make a game. */
export const PLATFORM_GUIDES: { topic: string; file: string; title: string; summary: string }[] = [
  { topic: 'contract', file: 'platform-contract', title: 'The platform contract', summary: 'The hard rules (including handing over the frame: all UI drawn in canvases, GCP.test.onCapture and GCP.test.onState), what the platform injects into the page, the SDK, exactly what verification checks, and the optional play-through hook. Read before the first deploy.' },
  { topic: 'metadata', file: 'game-metadata', title: 'Game metadata', summary: 'The specification behind every store page: each field, its allowed values, what is required to publish, how the age rating is worked out, what the platform detects and what players see. Read before the first publish.' },
  { topic: 'versions', file: 'troubleshooting', title: 'Versions and failed verification', summary: 'How previews, versions, publishing and rollback relate, each verification check, why it usually fails, and the fix.' },
  { topic: 'saves', file: 'saves', title: 'Player progress, saves, leaderboards and server code', summary: 'Each player\'s progress: cloud saves and stats per player and game, the play record the platform keeps, shared game data, leaderboards, and optional server code that runs in the game\'s own Worker.' },
  { topic: 'multiplayer', file: 'multiplayer', title: 'Multiplayer rooms', summary: 'Realtime rooms on the platform, playing with friends (friend invites, GCP.friends, GCP.presence), the host-authoritative model, snapshots, host migration, turn-based games, and the two-player verification check.' },
  { topic: 'matches', file: 'matches', title: 'Server-run matches', summary: 'Competitive real-time games (shooters, fighting games, sports, racing): server/match.js runs the match at a fixed tick on the platform, with matchmaking by region and rating, private lobbies, client prediction, smooth playback and lag-compensated hit checks.' },
  { topic: 'bots', file: 'test-bots', title: 'Testing online games with bots', summary: 'Bot players in the preview that connect like real ones over the platform\'s network: following the creator into a match or room, a public queue, a private lobby or a room; server/bot.js for what they do; network profiles, lag spikes, drops and reloads; the numbers per bot; limits. Read before testing a multiplayer game.' },
  { topic: 'storage', file: 'storage', title: 'Game storage', summary: 'How much a game\'s files may add up to, how uploads, deploys and publishing enforce it, how to keep a game small (generate content from code, load large or optional content at run time from your own host with CORS, compress what ships), and how to ask for more. Read before adding large assets.' },
  { topic: 'touch', file: 'input', title: 'Phones, tablets and input', summary: 'What the platform does so every game plays on touch screens (on-screen controls from the game\'s keys, mouse from the finger, pointer lock, taps, pixel density), gcp.json "controls" and GCP.controls, and what makes touch controls of your own good.' },
  { topic: 'services', file: 'services', title: 'Platform services', summary: 'Every service the platform gives games and agents (hosting, accounts, saves, stats, shared data, leaderboards, rooms, server code, display, verification, payments, analytics, agent access): how each works, how to reach it, its limits, and what the platform does not provide.' },
];
export async function guideText(env: Env, origin: string, topic: string) {
  const t = String(topic || '').toLowerCase().trim();
  const g = PLATFORM_GUIDES.find((x) => x.topic === t || x.file === t);
  const text = g && await assetText(env, `/guides/${g.file}.md`);
  return text ? { guide: g!, markdown: text.replaceAll('{{ORIGIN}}', origin).replaceAll('{{THREE}}', THREE_VERSION) } : null;
}

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });
const PROJECT = { type: 'string', description: 'Project id or slug (from list_projects or create_project).' };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// Unknown environments are refused, not quietly sent to live.
const envOf = (v: unknown): 'preview' | 'live' => { if (v === undefined || v === null || v === '') return 'live'; if (v === 'preview' || v === 'live') return v; throw bad('env must be "preview" or "live".'); };
const issueLine = (i: Issue) => `${i.level.toUpperCase()}${i.file ? ` ${i.file}${i.line ? `:${i.line}` : ''}` : ''}: ${i.message}${i.frame ? `\n${i.frame}` : ''}${i.hint ? `\n  fix: ${i.hint}` : ''}`;
const RUNNING = ['queued', 'deploying', 'verifying'];
const trialText = (p: { price_cents: number; trial_minutes: number }, s: Awaited<ReturnType<typeof getSettings>>) => {
  const m = trialMinutes(p, s);
  return m ? `${m} min: players who have not bought it can play ${m} minutes in total (per account, across devices), then are asked to buy` : p.price_cents > 0 ? 'none: players must buy before playing' : 'not applicable: the game is free';
};
// the limited-time sale, in words (src/sales.ts)
const saleText = (p: Parameters<typeof saleView>[0], s: Awaited<ReturnType<typeof getSettings>>) => {
  const v = saleView(p, s);
  if (v.running) return `on sale: ${usd(v.running.price_cents)} (${v.running.percent_off}% off ${usd(v.running.regular_cents)}) until ${new Date(v.running.ends_at).toISOString().slice(0, 16).replace('T', ' ')} UTC; creator receives ${usd(splitSale(v.running.price_cents, s, freeSkillShared(p as any)).net)} per sale meanwhile`;
  if (!(p.price_cents > 0)) return 'not applicable: the game is free';
  if (!v.enabled) return 'disabled on this platform';
  return v.next_sale_at ? `none; the next sale can start on ${new Date(v.next_sale_at).toISOString().slice(0, 10)}` : 'none (update_project sale {price_cents, days} starts one)';
};
const sharing = (p: { open_implementation: number; skill_price_cents?: number }) => (p.open_implementation
  ? `on: the game's build skill is in the Creator Store, ${Number(p.skill_price_cents) > 0 ? `sold for ${usd(Number(p.skill_price_cents))}` : 'free'} (never its code). Write the skill for every version before publishing it: build_skill {action: "write"}`
  : 'off: nothing about how this game is built is shared');

async function account(c: ToolCtx) {
  const s = await getSettings(c.env), u = c.user, bal = await balanceOf(c.env, u.id);
  return {
    name: u.name, creator_license: !!u.creator,
    can_publish: !!u.creator || !s.creator_fee_required,
    license: u.creator ? licenseText(u) : `${licenseText(u) === 'none' ? 'Not purchased' : 'Expired (' + licenseText(u) + ')'}. Publishing and the console need ${offersText(s)}. Uploading, previewing and verifying are free. The account owner gets it at ${c.origin}/license`,
    console_url: `${c.origin}/console`,
    earnings: { available: usd(bal.available), pending: usd(bal.pending), withdraw_minimum: usd(s.withdraw_min_cents) },
    build_skills: { free_skill: `a game that shares its build skill for free pays a ${s.platform_fee_open_percent}% cut on its own sales instead of ${s.platform_fee_percent}%`, paid_skill: s.paid_skills_enabled ? `a skill can be sold for ${usd(s.skill_price_min_cents)} to ${usd(s.skill_price_max_cents)}; the platform keeps ${s.skill_fee_percent}% of each skill sale and the game keeps the standard ${s.platform_fee_percent}% cut; skill sales are final, build skills are non-refundable` : 'disabled', store: `${c.origin}/creator-store` },
    paid_games: s.paid_games_enabled ? { platform_cut_percent: s.platform_fee_percent, platform_cut_percent_with_free_build_skill: s.platform_fee_open_percent, min_price_cents: s.game_price_min_cents, max_price_cents: s.game_price_max_cents, free_trial: s.trials_enabled ? { max_minutes: s.trial_max_minutes, how: 'update_project trial_minutes' } : 'disabled', sales: s.sales_enabled ? { max_days: s.sale_max_days, min_percent_off: s.sale_min_percent_off, min_sale_price_cents: s.sale_price_min_cents, days_between_sales: s.sale_gap_days, how: 'update_project sale {price_cents, days}; null ends it' } : 'disabled' } : 'disabled',
    limits: { storage_per_game: mb(s.bundle_max_bytes), storage_per_game_bytes: s.bundle_max_bytes, largest_file: mb(s.file_max_bytes), files_per_game: s.bundle_max_files, more_storage: s.storage_requests_open ? `ask with game_storage, up to ${mb(s.storage_max_bytes)} per game` : 'closed', server_code: s.allow_server_code },
  };
}

async function waitVersion(c: ToolCtx, pid: string, n: number, ms: number) {
  const end = Date.now() + ms;
  let v = await getVersion(c.env, pid, n);
  while (v && RUNNING.includes(v.status) && Date.now() < end) { await sleep(2000); v = await getVersion(c.env, pid, n); }
  return v!;
}

async function versionReport(c: ToolCtx, p: Project, n: number, v: Awaited<ReturnType<typeof getVersion>>) {
  const s = await getSettings(c.env);
  if (!v) throw bad(`Version ${n} does not exist. Call list_versions.`);
  const pub = publicVersion(v, c.origin), el = versionEligible(v, s.verify_browser_required);
  // the verifier also measures how finished a game looks; that is the console's business, not a rule agents build to
  if (pub.report && typeof pub.report === 'object') delete (pub.report as Record<string, unknown>).craft;
  const { compat, meta, ...rest } = pub;
  const running = RUNNING.includes(v.status);
  // verified, but not against today's checks: publishing it would be refused (src/release-gate.ts, current_checks)
  const cur = el.ok ? currentChecks(v, s) : { ok: true, problems: [] }, last = storedGate(v);
  return {
    ...(running ? { not_finished: `Version ${n} is deployed and the browser check is still running (${v.status}). This is normal: it takes one to two minutes. Call list_versions {project, version: ${n}}; it waits for the result. Do not deploy the same files again.` } : {}),
    ...rest, can_publish: el.ok, eligibility: el.reason, compatibility: compatSummary(compat), metadata: meta ? metaSummary(p, compat, meta).build : null,
    ...(meta && compat && true ? (() => { const m = missingToPublish(meta, compat.declared, JSON.parse(p.tags || '[]')); return m.length ? { metadata_missing: m, metadata_next: 'Publishing needs these. game_metadata {project} walks through each with allowed values and suggestions.' } : {}; })() : {}),
    ...(cur.ok ? {} : { not_current: `Publishing this version would be refused: ${cur.problems.join('; ')}. deploy_preview again (retry_version: ${n} when it is the newest version) and publish the version that makes.` }),
    ...(last ? { last_release_check: { ok: last.ok, ruleset: last.ruleset, checked_at: new Date(last.checked_at).toISOString(), failed: last.failures.map((f) => `${f.id}: ${f.reason}`) } } : {}),
    preview_page: `${c.origin}/console/projects/${p.id}`,
    ...(s.creator_fee_required && !c.user.creator ? { preview_page_note: `The console, where a person plays the preview and leaves feedback, opens only with a creator license (${c.origin}/license). Without one, debug_preview is how to see the game.` } : {}),
    ...(await feedbackHint(c, p)),
    next: running ? `Still ${v.status} (${v.stage}). Call list_versions {project, version: ${n}}; it waits up to 40 seconds for the report.`
      : !el.ok ? 'Fix every failed check in report.checks (each has a hint), upload the changed files, then deploy_preview again. get_started {topic: "versions"} explains each check.'
        : !cur.ok ? `Verified, but not against today's checks. deploy_preview again before publishing.`
        : `Verified. A person can play it on the preview page first. publish {project, version: ${n}, dry_run: true} checks every platform requirement; publish {project, version: ${n}} makes it live.`,
  };
}

/**
 * The sharing state with where it came from, so an agent that left open_implementation out can tell the user whether this
 * call changed it (it never does) and who turned it on and when: a console toggle, an earlier update_project, another agent.
 */
async function sharingSource(c: ToolCtx, p: Project, asked: unknown): Promise<string> {
  const base = sharing(p);
  if (typeof asked === 'boolean') return `${base} (set by this call)`;
  if (!p.open_implementation) return `${base} (unchanged by this call)`;
  const e = await c.env.DB.prepare("SELECT actor, created_at FROM events WHERE project_id = ? AND kind = 'implementation_opened' ORDER BY id DESC LIMIT 1").bind(p.id).first<{ actor: string; created_at: number }>();
  const by = !e ? '' : e.actor === 'console' ? ' in the console' : e.actor === 'admin' ? ' by a platform admin' : e.actor ? ` by ${e.actor}` : '';
  return `${base}. Unchanged by this call: it was turned on${by}${e ? ` on ${new Date(e.created_at).toISOString().slice(0, 16).replace('T', ' ')} UTC` : ' earlier'}. publish {open_implementation: false} or update_project {open_implementation: false} turns it off.`;
}

/** The checks a finished version failed, by id and label, for the version list (the full report has details and hints). */
function failedChecks(v: { status: string; report: string | null }): { failed_checks?: string[] } {
  if (v.status !== 'failed') return {};
  const r = parseJson<{ checks?: { id: string; ok: boolean; label: string }[] }>(v.report, {});
  const f = (r.checks || []).filter((x) => !x.ok).map((x) => `${x.id}: ${x.label}`);
  return f.length ? { failed_checks: f } : {};
}

export const RETRY_LIMIT = 3;
/**
 * How long deploy_preview waits for the browser check before answering not_finished. Many MCP clients give up on a call
 * after 60 seconds (the TypeScript SDK's default request timeout, Codex's tool timeout), and a call that times out on the
 * client looks like a failure the agent retries, so the answer comes back well inside that and list_versions waits for the rest.
 */
export const DEPLOY_WAIT_MS = 45000;

/**
 * Runs the deploy and browser check again on the newest version when it failed, keeping its number: the files are frozen, so
 * this only helps when the failure did not come from them (a heavy game at the edge of the software GPU's frame count, a
 * deploy that was slow to settle). Limited per version so it cannot stand in for fixing a real failure.
 */
async function retryPreview(c: ToolCtx, p: Project, n: number) {
  if (!Number.isInteger(n) || n < 1) throw bad('retry_version must be a whole number from list_versions.');
  const v = await getVersion(c.env, p.id, n);
  if (!v) throw bad(`Version ${n} does not exist.`, 'Call list_versions to see the versions this game has.');
  const newest = await c.env.DB.prepare('SELECT MAX(n) AS n FROM versions WHERE project_id = ?').bind(p.id).first<{ n: number }>();
  if (newest && newest.n !== n) throw bad(`Version ${n} is not the newest version (${newest.n} is), so it cannot be retried.`, `Retry version ${newest.n} instead, or call deploy_preview without retry_version.`);
  if (RUNNING.includes(v.status)) throw new AppError(409, `Version ${n} is still being checked (${v.status}).`, 'busy', `Call list_versions {project, version: ${n}} and wait for it.`);
  if (v.status !== 'failed') throw bad(`Version ${n} did not fail (${v.status}), so there is nothing to retry.`, v.status === 'verified' ? `It can be published: publish {project, version: ${n}}.` : 'Call list_versions {project, version} to read it.');
  if ((v as { purged_at?: number | null }).purged_at) throw bad(`Version ${n} is older than the platform keeps files for.`, 'Call deploy_preview without retry_version to make a new version.');
  const tries = await c.env.DB.prepare("SELECT COUNT(*) AS k FROM events WHERE project_id = ? AND version = ? AND kind = 'preview_retried'").bind(p.id, n).first<{ k: number }>();
  if ((tries?.k ?? 0) >= RETRY_LIMIT) throw new AppError(409, `Version ${n} was already checked again ${RETRY_LIMIT} times.`, 'retry_limit', 'The failure is repeatable: read list_versions {project, version} and fix what the failed checks say, then deploy_preview without retry_version.');
  const res = await c.env.DB.prepare("UPDATE versions SET status = 'queued', stage = 'Queued for another check', report = NULL, verified_at = NULL WHERE project_id = ? AND n = ? AND status = 'failed'").bind(p.id, n).run();
  if (!res.meta.changes) throw new AppError(409, `Version ${n} changed while retrying.`, 'busy', `Call list_versions {project, version: ${n}}.`);
  await logEvent(c.env, p.id, 'preview_retried', `Checked again (${(tries?.k ?? 0) + 1} of ${RETRY_LIMIT})`, n, c.client);
  await enqueue(c.env, { kind: 'preview', pid: p.id, n, origin: c.origin, actor: c.client });
  const done = await waitVersion(c, p.id, n, DEPLOY_WAIT_MS);
  return { deployed: true, retried: true, retries_left: RETRY_LIMIT - (tries?.k ?? 0) - 1, storage: await storageLine(c.env, p), ...(await versionReport(c, p, n, done)) };
}

/** Tells the agent when its creator left feedback on the preview: annotated screenshots it should read and act on. */
async function feedbackHint(c: ToolCtx, p: Project): Promise<Record<string, string>> {
  if (p.owner_id !== c.user.id) return {};
  const n = await pendingFeedback(c.env, p.id);
  return n ? { creator_feedback: `${n} feedback item${n === 1 ? '' : 's'} from the creator ${n === 1 ? 'is' : 'are'} waiting: annotated screenshots of the preview with notes. Call creator_feedback {project: "${p.id}"} to read ${n === 1 ? 'it' : 'them'} and fix what they point at.` } : {};
}

const STEP_SCHEMA = {
  type: 'array', maxItems: DEBUG_LIMITS.steps,
  description: `Steps run in order, then a screenshot of the result is returned. Coordinates are CSS pixels of the viewport, (0, 0) top left; read them off the last screenshot (same size as the viewport). Each step is an object with "do":
- {do: "click", x, y, button?: "left"|"right"|"middle", count?: 1|2}, {do: "double_click", x, y}, {do: "right_click", x, y}
- {do: "move", x, y} (hover), {do: "down", x?, y?, button?}, {do: "up", x?, y?, button?} (press and release separately, e.g. to hold the mouse)
- {do: "drag", x, y, to_x, to_y, ms?} (press, move over ms milliseconds, release; default 300)
- {do: "tap", x, y} (a touch tap; use a phone viewport for touch games)
- {do: "scroll", x?, y?, dx?, dy} (mouse wheel)
- {do: "key", key, hold_ms?} (press one key, or hold it hold_ms to move a character), {do: "key_down", key}, {do: "key_up", key}. key is one character or a name: Enter, Space, Escape, Tab, Backspace, ArrowLeft/Right/Up/Down, KeyW, ShiftLeft, F1…
- {do: "type", text} (types characters, up to ${DEBUG_LIMITS.text_chars})
- {do: "wait", ms} (up to 10000)
- {do: "wait_for", until: "ready"|"text"|"frames", text?, frames?, timeout_ms?} (until GCP.ready(), until text appears on the page, or until the game drew that many more frames; stops the call if not met)
- {do: "screenshot", label?, clip?: {x, y, width, height}} (an extra picture in the middle of the steps, or a close-up of one area; up to ${DEBUG_LIMITS.shots - 1} per call plus the final one)
- {do: "eval", js} (an expression or statements ending in return, evaluated in the game page; the JSON result comes back in the log. For reading the game's state, not for playing it)
All waits of one call add up to at most ${DEBUG_LIMITS.wait_ms / 1000} seconds.`,
  items: { type: 'object' },
};
function debugAnswer(r: DebugResult, next: string) {
  const left = Math.max(0, Math.round((r.expires_at - now()) / 1000));
  return new WithImages({
    session: r.session, preview_version: r.version, viewport: `${r.viewport.width} × ${r.viewport.height}${r.viewport.touch ? ' (touch)' : ''}`,
    ...(r.opened ? { opened: r.opened.started ? `The game called GCP.ready() after ${r.opened.ms} ms.` : `The game did not call GCP.ready() within ${Math.round(r.opened.ms / 1000)} seconds (see state.errors).` } : {}),
    steps: r.log, ...(r.stopped ? { stopped_at_step: r.stopped } : {}),
    state: r.state,
    screenshots: r.shots.map((s, i) => `image ${i + 1}: ${s.label}`),
    closes_in_seconds: left,
    next,
  }, r.shots.map((s) => ({ data: s.bytes, type: 'image/jpeg' })));
}

/** The requirements block an agent writes: only what differs from nothing, so it reads like something a person would write. */
function requirementsBlock(r: Requirements): Record<string, unknown> {
  const out: Record<string, unknown> = { graphics: r.graphics };
  if (r.gpu === 'hardware') out.gpu = 'hardware';
  if (r.features.length) out.features = r.features;
  if (r.optional.length) out.optional = r.optional;
  out.input = r.input; out.devices = r.devices;
  if (r.orientation !== 'any') out.orientation = r.orientation;
  if (r.memory_gb) out.memory_gb = r.memory_gb;
  if (Object.keys(r.browsers).length) out.browsers = r.browsers;
  if (r.known_issues.length) out.known_issues = r.known_issues;
  if (r.notes) out.notes = r.notes;
  return out;
}
/** How a version's compatibility reads in a tool answer. */
const compatSummary = (c: Compat | null | undefined) => c ? {
  declared: c.declared, store_page_shows: describeRequirements(c.requirements), requirements: requirementsBlock(c.requirements),
  ...(c.declared ? {} : { note: 'Not declared by the creator: the store shows what the platform detected. compatibility {action: "declare"} sets them.' }),
} : null;

const REQUIREMENTS_SCHEMA = obj({
  graphics: { type: 'string', enum: [...GRAPHICS], description: 'The weakest graphics API the game still runs with. A WebGPU game with a WebGL 2 fallback is "webgl2" with "webgpu" under optional. three.js r163+ needs "webgl2".' },
  gpu: { type: 'string', enum: ['any', 'hardware'], description: '"hardware" when the game is unplayable with a software renderer (no GPU acceleration). Default "any".' },
  features: { type: 'array', items: { type: 'string', enum: [...FEATURE_IDS] }, description: 'Browser features the game cannot run without.' },
  optional: { type: 'array', items: { type: 'string', enum: [...FEATURE_IDS] }, description: 'Features the game uses when present but works without.' },
  input: { type: 'array', items: { type: 'string', enum: [...INPUTS] }, description: 'Every way the game can be played; a player needs any one of them.' },
  devices: { type: 'array', items: { type: 'string', enum: [...DEVICES] }, description: 'Devices the game is made for. "mobile" needs touch controls.' },
  orientation: { type: 'string', enum: [...ORIENTATIONS] },
  memory_gb: { type: ['number', 'null'], description: 'Minimum device memory in GB, only for heavy games.' },
  browsers: { type: 'object', description: `Minimum major version per browser when known, e.g. {"safari": 17}. Browsers: ${BROWSERS.join(', ')}.`, additionalProperties: { type: 'integer' } },
  known_issues: { type: 'array', maxItems: 12, description: 'Where the game is known not to work well, shown to players there.', items: obj({ browser: { type: 'string', enum: [...BROWSERS] }, os: { type: 'string', enum: [...OSES] }, severity: { type: 'string', enum: ['broken', 'degraded'] }, note: { type: 'string', description: 'One sentence for players, under 200 characters.' } }, ['note']) },
  notes: { type: 'string', description: 'Anything else players should know, under 300 characters.' },
});

/** gcp.json in the workspace, parsed, or an empty object. */
async function workspaceManifest(c: ToolCtx, pid: string): Promise<Record<string, unknown>> {
  try { const { bytes } = await readFile(c.env, pid, 'gcp.json'); const j = JSON.parse(new TextDecoder().decode(bytes)); return j && typeof j === 'object' && !Array.isArray(j) ? j : {}; }
  catch (e) { if (e instanceof AppError && e.status === 404) return {}; throw bad('gcp.json in the workspace is not valid JSON.', 'Fix or replace it with upload_files, then call compatibility again.'); }
}

const AGE_TEXT: Record<number, string> = { 3: '3+ (everyone)', 7: '7+', 12: '12+', 16: '16+', 18: '18+ (adults only)' };
const langList = (l: Languages) => l.supported.map((g) => `${languageName(g.code)[0]} (${[g.interface && 'interface', g.audio && 'voice', g.subtitles && 'subtitles'].filter(Boolean).join(', ')})${g.code === l.default ? ' default' : ''}`);
/** The game's metadata as an agent reads it back: what the store page will show, and what is still missing. */
function metaSummary(p: Project, compat: Compat | null | undefined, meta: MetaRecord | null | undefined) {
  const tags = JSON.parse(p.tags || '[]') as string[], g = genresOf(tags), stored = JSON.parse(p.listing_i18n || '{}') as Record<string, { cover_key?: string }>, listings = Object.keys(stored);
  const m = meta?.meta, rating = meta?.rating, cov = listingCoverage(p, meta?.languages);
  return {
    listing: { title: p.title, tagline: p.tagline || null, genre: g.primary, secondary_genres: g.secondary, tags: tagsOnly(normalizeStoredTags(tags)), ...(tagsOffList(tags).length ? { tags_not_on_the_platform_list: tagsOffList(tags) } : {}), controls: p.controls || null,
      // the store shows the listing in the viewer's platform language when the game is played in it, else English, else this one
      listing_language: `${cov.lang}${p.listing_lang ? '' : ' (worked out from the text; set listing_language if wrong)'}`, translated_into: listings,
      covers_per_language: listings.filter((k) => stored[k]?.cover_key),
      ...(cov.missing.length ? { listing_missing_in: cov.missing.map((x) => `${x.lang}: ${x.fields.join(', ')}`) } : {}) },
    build: meta ? {
      declared: meta.declared,
      requirements: compat ? describeRequirements(compat.requirements) : null,
      languages: { list: langList(meta.languages.languages), follows_platform_language: meta.languages.languages.follows_platform, declared: meta.languages.declared },
      players: m?.players ? `${m.players.min === m.players.max ? m.players.min : `${m.players.min}-${m.players.max}`} player(s): ${m.players.modes.join(', ')}` : null,
      session_minutes: m?.session_minutes ?? null,
      progress: m?.progress ?? null,
      accessibility: m?.accessibility ?? null,
      age_rating: rating ? `${AGE_TEXT[rating.age]}${rating.reasons.length ? `: ${rating.reasons.join(', ')}` : ''}` : null,
      adults_only: m?.content ? (matureOf(m.content).mature ? `Yes (${matureOf(m.content).categories.join(', ')}): the store blurs the cover, labels it 18+, and every player confirms a warning before the game starts.` : 'No') : null,
    } : null,
    missing_for_publish: missingToPublish(meta, !!compat?.declared, tags),
  };
}
const tagsOffList = (tags: string[]) => tags.filter((w) => tagGroup(String(w)) === null);
/** Tags the code and the declarations point to, as a starting point the agent completes: never a substitute for choosing. */
function suggestTagsFor(compat: Compat | null | undefined, meta: MetaRecord | null | undefined, tags: string[]): string[] {
  const out = new Set<string>(tagsOnly(normalizeStoredTags(tags)));
  const r = compat?.requirements ?? compat?.detected;
  if (r?.graphics === 'canvas') out.add('2d');
  if (r?.features?.includes('pointer-lock') || r?.optional?.includes('pointer-lock')) out.add('first-person');
  const mins = meta?.meta.session_minutes;
  if (mins && mins <= 5) out.add('short-sessions');
  if (meta?.meta.content?.fear === 'mild') out.add('spooky');
  const modes = meta?.meta.players?.modes ?? [];
  if (meta?.detected.multiplayer || modes.some((m) => m.endsWith('-online'))) out.add('multiplayer');
  if (modes.some((m) => m.startsWith('coop'))) out.add('co-op');
  if (modes.some((m) => m.startsWith('pvp'))) out.add('pvp');
  if (modes.some((m) => m.endsWith('-local') && m !== 'single')) out.add('local-multiplayer');
  return [...out].slice(0, MAX_TAGS);
}
/**
 * The publishing checklist an agent works through: every field the store page shows, in order, with its status, the allowed
 * values, a suggestion from the code scan where there is one, and the exact call that fills it.
 */
function metadataChecklist(p: Project, compat: Compat, meta: MetaRecord) {
  const tags = JSON.parse(p.tags || '[]') as string[], g = genresOf(tags), d = new Set(meta.declared);
  const declare = (args: Record<string, unknown>) => `game_metadata ${JSON.stringify({ project: p.id, action: 'declare', ...args })}`;
  const step = (n: number, field: string, required: boolean, done: boolean, ask: string, allowed: unknown, suggestion: unknown, call: string) =>
    ({ step: n, field, required, status: done ? 'done' : required ? 'missing' : 'optional', ask, allowed, ...(done ? {} : { suggestion, call }) });
  const det = meta.detected, langs = meta.languages.detected;
  return ([
    step(1, 'genre', true, !!g.primary, 'Which genre fits best? Pick one primary genre; up to two secondary genres are optional.', GENRES, null, declare({ genre: '<one of the genres>', genres: [] })),
    step(1, 'tags', true, !missingTags(tags), `Which tags describe the game? Choose ${MIN_TAGS} to ${MAX_TAGS} from the platform list (setting and theme, mood, gameplay, players, visual style and view); players filter the store by them. Only tags on the list are accepted.${tagsOffList(tags).length ? ` Replace ${tagsOffList(tags).join(', ')}: not on the list.` : ''}`, TAG_GROUPS, suggestTagsFor(compat, meta, tags), declare({ tags: suggestTagsFor(compat, meta, tags) })),
    step(2, 'requirements', true, compat.declared, 'What does the game need from the browser? Confirm the detected block, correcting input, devices or a hardware GPU.', { graphics: GRAPHICS, gpu: ['any', 'hardware'], features: FEATURE_IDS, input: INPUTS, devices: DEVICES, orientation: ORIENTATIONS }, requirementsBlock(compat.detected), declare({ requirements: requirementsBlock(compat.detected) })),
    step(3, 'languages', true, d.has('languages'), 'Which languages can players choose? For each: interface text, voice, subtitles. Does the game start in the player\'s platform language (GCP.lang), and switch live when the player changes it mid-game (GCP.onLang)?', { code: 'BCP 47 (en, ja, ko, es, zh-Hans, zh-Hant, fr, de, pt-BR…)', interface: 'boolean', audio: 'boolean', subtitles: 'boolean', follows_platform: 'boolean' }, langs, declare({ languages: { default: langs.default, supported: langs.supported, follows_platform: langs.follows_platform } })),
    step(4, 'players', true, d.has('players'), 'How many people play, and how: alone, together on one device, or online?', { min: '1-100', max: '>= min', modes: MODES }, det.multiplayer ? { min: 1, max: 4, modes: ['single', 'coop-online'] } : { min: 1, max: 1, modes: ['single'] }, declare({ players: det.multiplayer ? { min: 1, max: 4, modes: ['single', 'coop-online'] } : { min: 1, max: 1, modes: ['single'] } })),
    step(5, 'content', true, d.has('content'), 'What does the game contain, anywhere a player can reach? Answer every descriptor honestly; the platform derives the age rating from them. Adult games are allowed: declare sexual "nudity" or "explicit", violence "graphic" (or "realistic" with blood) or adult_themes, and the game is listed as 18+ with a blurred cover and a warning players confirm. The review plays the game and refuses a version that shows more sexual content or violence than it declares. {} means none of them.', CONTENT_CHOICES, {}, declare({ content: { violence: 'none', blood: false, language: 'none', fear: 'none', sexual: 'none', drugs: false, gambling: 'none', flashing_lights: false, player_chat: false, adult_themes: false } })),
    step(6, 'session_minutes', false, d.has('session_minutes'), 'How long is a typical session, in minutes?', '1-600', 10, declare({ session_minutes: 10 })),
    step(7, 'accessibility', false, d.has('accessibility'), 'Which accessibility features does the game have? [] when none.', ACCESSIBILITY, [], declare({ accessibility: [] })),
    step(8, 'progress', false, d.has('progress'), 'Confirm what is kept for the player: cloud saves, leaderboards, and whether it plays offline.', { cloud_saves: 'boolean', leaderboards: 'boolean', offline: 'boolean' }, det.progress, declare({ progress: det.progress })),
    step(9, 'listing', false, !!(p.tagline && p.description && p.controls), 'Is the listing complete: a one-line tagline, a description and the controls?', { tagline: '<=140 chars', description: '<=4000 chars', controls: '<=1000 chars' }, null, declare({ tagline: '…', description: '…', controls: '…' })),
    ...listingSteps(p, meta, declare, step),
  ]).map((x, i) => ({ ...x, step: i + 1 }));
}

/** The listing-language steps: the store listing, cover included, follows the player's platform language, so a game
 *  played in several languages lists itself in each of them (publish checks it: release rule listing_languages). */
function listingSteps<S>(p: Project, meta: MetaRecord, declare: (a: Record<string, unknown>) => string, step: (n: number, field: string, required: boolean, done: boolean, ask: string, allowed: unknown, suggestion: unknown, call: string) => S): S[] {
  const cov = listingCoverage(p, meta.languages), others = cov.supported.filter((l) => l !== cov.lang);
  const example = Object.fromEntries((cov.missing.length ? cov.missing.map((m) => m.lang) : others.length ? others : ['ja']).map((l) => [l, { title: '…', tagline: '…', description: '…', controls: '…' }]));
  return [
    step(10, 'listing_language', false, !!p.listing_lang, `Which language are the title, tagline, description and cover above written in? Worked out from the text as ${cov.lang}; confirm it.`, ['en', 'zh', 'zh-TW', 'ja', 'ko', 'es', 'or another BCP 47 code'], cov.lang, declare({ listing_language: cov.lang })),
    step(11, 'listing_translations', others.length > 0, others.length > 0 ? !cov.missing.length : Object.keys(JSON.parse(p.listing_i18n || '{}')).length > 0,
      others.length > 0
        ? `The game is played in ${cov.supported.join(', ')}, so everything players see about it outside the game must be too: the platform shows the store listing (name, tagline, description, controls) in the player's platform language when the game supports it, else in English, else in the listing's own language. Translate the listing faithfully into ${others.join(', ')}; publish refuses a version whose listing misses one of them.${cov.missing.length ? ` Missing: ${cov.missing.map((m) => `${m.lang} (${m.fields.join(', ')})`).join('; ')}.` : ''}`
        : 'Should the store listing be shown in other platform languages (zh, zh-TW, ja, ko, es)? A game in one language does not need it; only with translations the user approves.',
      { languages: ['en', 'zh', 'zh-TW', 'ja', 'ko', 'es'], fields: { title: '<=80 chars', tagline: '<=140', description: '<=5000', controls: '<=1000' } }, null, declare({ listing_translations: example })),
    step(12, 'covers', false, others.every((l) => JSON.parse(p.listing_i18n || '{}')[l]?.cover_key) || !others.length,
      'Does the cover (or any other store image) show text, such as the game\'s name? Then give each listing language its own cover with that text in the language: update_project {covers: {"<lang>": "<workspace path>"}}. A language without its own cover shows the main cover, so keep text off the main cover or make it language-neutral.', 'png, jpg or webp under 2 MB, 16:9 (1920x1080 is ideal)', null, `update_project ${JSON.stringify({ project: p.id, covers: Object.fromEntries((others.length ? others : ['zh']).map((l) => [l, `cover-${l}.jpg`])) })}`),
  ];
}

const metaIssueLine = (i: MetaIssue) => `${i.level.toUpperCase()} ${i.field}: ${i.message}${i.hint ? `\n  fix: ${i.hint}` : ''}`;
const LISTING_FIELDS = ['title', 'tagline', 'description', 'controls', 'genre', 'genres', 'tags', 'listing_language', 'listing_translations'] as const;
const LISTING_LANGUAGE_SCHEMA = { type: ['string', 'null'], description: 'The language the title, tagline, description, controls and cover are written in: en, zh (Simplified Chinese), zh-TW (Traditional Chinese), ja, ko, es, or another BCP 47 code. Worked out from the text when not set.' };
const TRANSLATIONS_SCHEMA = { type: 'object', description: 'The listing in other platform languages: {"zh": {"title": "…", "tagline": "…", "description": "…", "controls": "…"}, "ja": {…}}. Languages: en, zh, zh-TW, ja, ko, es. A game played in several platform languages needs one for each of them (publish checks): players see the listing in their platform language when the game is played in it, else English, else the listing\'s own language. null for a language removes it. Translate faithfully; use the names the game itself uses in that language.' };
const LANGUAGES_SCHEMA = { type: ['object', 'array'], description: 'Languages the game can be played in. {"default": "en", "supported": [{"code": "en", "interface": true, "audio": true, "subtitles": false}, {"code": "ja", "interface": true, "subtitles": true}], "follows_platform": true} or the shorthand ["en", "ja"] (interface text). Codes are BCP 47: en, ja, ko, es, zh-Hans, zh-Hant, fr, de, pt-BR… follows_platform: the game starts in GCP.lang (the player\'s platform language) when it has it.' };
const PLAYERS_SCHEMA = { type: 'object', description: `{"min": 1, "max": 4, "modes": ["single", "coop-online"]}. Modes: ${MODES.join(', ')}.` };
const CONTENT_SCHEMA = { type: 'object', description: `Content descriptors; the platform derives the age rating from them. Each one left out means none. ${Object.entries(CONTENT_CHOICES).map(([k, v]) => `${k}: ${v.join(' | ')}`).join('; ')}. Pass {} for a game with none of them (rated 3+). Adults only (18+): sexual nudity or explicit, violence graphic, violence realistic with blood, or adult_themes; such games are allowed, shown blurred with a warning players confirm. Declare everything a player can see: the review plays the game, and undeclared nudity, sexual content or realistic or graphic violence fails it.` };
const TAGS_SCHEMA = { type: 'array', maxItems: MAX_TAGS, items: { type: 'string', enum: [...TAGS] }, description: `${MIN_TAGS} to ${MAX_TAGS} tags from the platform list (only these are accepted; genres go in genre and genres). ${Object.entries(TAG_GROUPS).map(([g, l]) => `${g}: ${l.join(', ')}`).join('. ')}.` };
const GENRE_SCHEMA = { type: 'string', enum: [...GENRES], description: 'The primary genre; the store groups games by it.' };

/** The only thing between this version and going live is the review a person gives versions the browser could not run. */
const onlyReviewNeeded = (g: GateResult) => g.failures.length > 0 && g.failures.every((f) => f.review === 'needed');

async function publishVersion(a: Record<string, any>, c: ToolCtx, rollback: boolean): Promise<unknown> {
  const p = await ownedProject(c.env, c.user, a.project), s = await getSettings(c.env);
  if (p.status === 'removed') throw forbidden('This game was removed by the platform and cannot be published.');
  let v: any = null;
  if (a.version !== undefined && a.version !== null) {
    const n = Number(a.version);
    if (!Number.isInteger(n) || n < 1) throw bad('version must be a whole number from list_versions.');
    v = await getVersion(c.env, p.id, n);
    if (!v) throw bad(`Version ${n} does not exist.`, 'Call list_versions to see the versions this game has.');
  } else {
    const rows = await c.env.DB.prepare('SELECT * FROM versions WHERE project_id = ? ORDER BY n DESC LIMIT 20').bind(p.id).all<any>();
    v = rows.results.find((x) => versionEligible(x, s.verify_browser_required).ok) || rows.results[0] || null;
  }
  if (!v) throw bad('There is no version to publish.', 'Call deploy_preview first.');
  // Input is checked before the license, so a wrong version number is reported as such for any account.
  if (s.creator_fee_required && !c.user.creator && !a.dry_run) throw forbidden(`Publishing needs a valid creator license (${licenseText(c.user)} on this account).`, `Ask the user to get one at ${c.origin}/license: ${offersText(s)}. Then call publish again. Preview stays available meanwhile.`);
  if (!p.tagline && !p.description && !a.dry_run) await updateProjectMeta(c.env, p, { tagline: p.title });
  // Every platform requirement, checked on the server (src/release-gate.ts). The pipeline checks them again right before
  // the switch, so this answer is for the agent: every rule that fails, with what to do.
  const openAfter = typeof a.open_implementation === 'boolean' ? a.open_implementation : undefined;
  const gate = await releaseGate(c.env, p, v, { mode: rollback ? 'rollback' : 'publish', openImplementation: openAfter });
  await recordGate(c.env, gate);
  if (a.dry_run) return { would_go_live: gate.ok || onlyReviewNeeded(gate), ...(onlyReviewNeeded(gate) ? { review: 'needed', note: 'Everything else holds; publish asks a platform admin to review it because the verification browser could not run it.' } : {}), requirements: gateView(gate), summary: gateText(gate) };
  if (!gate.ok && !onlyReviewNeeded(gate)) {
    const err = gateError(gate), meta = gate.failures.find((f) => f.id === 'metadata');
    if (meta) {
      // the numbered store-page checklist, so the agent can declare everything in one go
      const { compat, meta: m } = await ensureVersionMeta(c.env, v);
      const steps = metadataChecklist(p, compat, m).filter((x) => x.required && x.status === 'missing').map((x) => `${x.step}. ${x.field}: ${x.ask} Allowed: ${JSON.stringify(x.allowed)}. Suggested call: ${x.call}`);
      if (steps.length) err.message += `\nStore metadata checklist:\n${steps.join('\n')}`;
      if (gate.failures.length === 1) {
        // Listing fields (genre, tags) take effect at once; only build fields are frozen with a version and need a new deploy.
        const needsDeploy = (meta.missing || []).some((x) => (BUILD_FIELDS as readonly string[]).includes(x.split(/[\s:]/)[0]) || /^requirements/.test(x));
        err.hint = needsDeploy
          ? 'Ask the user anything you cannot tell from the game, declare each field with game_metadata {action: "declare", …}, then deploy_preview again (build fields are frozen with a version) and publish the new version. game_metadata {project} shows the whole checklist.'
          : `Declare the missing listing fields with game_metadata {action: "declare", …} or update_project, then call publish {project, version: ${v.n}} again. No new deploy is needed.`;
      }
    }
    throw err;
  }
  if (typeof a.open_implementation === 'boolean') await setOpenImplementation(c.env, p, a.open_implementation, c.client, false);
  if (onlyReviewNeeded(gate)) {
    // Every other requirement holds; a person looks at the game before it goes live (the admin's Reviews queue).
    await c.env.DB.prepare("UPDATE versions SET review = 'pending', review_note = NULL, reviewed_at = NULL, reviewed_by = NULL WHERE project_id = ? AND n = ?").bind(p.id, v.n).run();
    await logEvent(c.env, p.id, 'review_requested', 'The verification browser could not run this version', v.n, c.client);
    return { live: false, version: v.n, review: 'pending', next: `Version ${v.n} is waiting for a platform review because the verification browser could not run it. It goes live by itself once approved; list_versions {project, version: ${v.n}} shows the review state. Tell the user.` };
  }
  await logEvent(c.env, p.id, 'publish_requested', '', v.n, c.client);
  await enqueue(c.env, { kind: 'publish', pid: p.id, n: v.n, origin: c.origin, actor: c.client, mode: rollback ? 'rollback' : 'publish' });
  const end = Date.now() + 45000;
  // the pipeline checks every requirement again before the switch; if it refuses, say why instead of "taking longer"
  const failedSince = () => c.env.DB.prepare("SELECT detail FROM events WHERE project_id = ? AND version = ? AND kind = 'publish_failed' AND created_at >= ? ORDER BY id DESC LIMIT 1").bind(p.id, v.n, gate.checked_at).first<{ detail: string }>();
  let q = await ownedProject(c.env, c.user, p.id), refused: { detail: string } | null = null;
  while (!(q.status === 'live' && q.live_version === v.n) && Date.now() < end) { await sleep(2000); q = await ownedProject(c.env, c.user, p.id); if (!(q.status === 'live' && q.live_version === v.n) && (refused = await failedSince())) break; }
  const live = q.status === 'live' && q.live_version === v.n;
  if (refused) {
    const later = storedGate((await getVersion(c.env, p.id, v.n)) as any);
    if (later && !later.ok && later.checked_at >= gate.checked_at) throw gateError(later);
  }
  if (refused) throw new AppError(409, refused.detail, 'publish_failed', `Fix what it says, then publish again. publish {project, version: ${v.n}, dry_run: true} checks every requirement without publishing.`);
  const vm = await ensureVersionMeta(c.env, v);
  return { live, version: v.n, compatibility: compatSummary(vm.compat), metadata: metaSummary(q, vm.compat, vm.meta), game_page: `${c.origin}/g/${p.slug}`, price: q.price_cents ? usd(q.price_cents) : 'free', free_trial: trialText(q, await getSettings(c.env)), open_implementation: await sharingSource(c, q, a.open_implementation), next: live ? 'The game is live. Share the game page with the user.' : 'Going live is taking longer than usual (a first deploy needs a minute). Call list_projects {project} in a little while to confirm.' };
}

export const TOOLS: Tool[] = [
  {
    name: 'get_started', title: 'Start here',
    description: `Call this first. ${WEB_ONLY} Returns what the platform does, the rules a game must follow to deploy, the workflow, the account status (creator license, earnings, limits) and the platform services (saves, leaderboards, multiplayer rooms, server-run matches). Pass topic to read one platform guide in full: ${PLATFORM_GUIDES.map((g) => `"${g.topic}"`).join(', ')}. Every game has a storage limit (see storage in the answer): tell the developer about it before planning large assets. debugging explains debug_preview (drive the preview in a browser and screenshot it) and creator_feedback (the creator's annotated screenshots, to read every session). platform_services lists every service with this platform's limits. It does not tell you how to make your game; that is up to you.`,
    inputSchema: obj({ topic: { type: 'string', enum: PLATFORM_GUIDES.map((g) => g.topic), description: 'Optional. Returns that platform guide as Markdown instead of the overview.' } }), annotations: { readOnlyHint: true },
    run: async (a, c) => {
      if (a.topic) {
        const g = await guideText(c.env, c.origin, a.topic);
        if (!g) throw bad(`No guide "${a.topic}".`, `Topics: ${PLATFORM_GUIDES.map((x) => x.topic).join(', ')}`);
        return { topic: g.guide.topic, title: g.guide.title, markdown: g.markdown };
      }
      const s = await getSettings(c.env);
      return {
        platform: s.brand_name,
        operator: { name: OPERATOR.name, entity: `${OPERATOR.jurisdiction} limited liability company`, website: OPERATOR.url, legal_contact: OPERATOR.legalEmail, terms: `${c.origin}/legal/terms`, privacy: `${c.origin}/legal/privacy`, note: `${s.brand_name} is developed and operated by ${OPERATOR.name}. Publishing or selling a game here means the creator agrees to the Terms with ${OPERATOR.name}, which sells paid games to players. When the user asks who runs the platform, who the seller is, or where to send legal or privacy questions, answer from this.` },
        web_games_only: WEB_ONLY,
        what_this_server_does: 'It hosts web games. It takes the files of your game, deploys each version to its own address, checks it in a real browser, publishes it to the marketplace, keeps every version for rollback, and provides player saves, leaderboards, realtime multiplayer rooms and server-run competitive matches. How you make the game (engine or none, renderer, art, hand-made or generated assets, any build tooling on your side) is your choice: the platform neither prescribes nor scores it.',
        rules: [
          'A web page: index.html at the bundle root, plus the files it loads with relative paths. There is no build step on the platform: upload what the browser runs.',
          'Call GCP.ready() once, right after the first playable frame is drawn. GCP is injected by the platform; never bundle or import it.',
          'Hand over the frame: draw everything the player sees (world, HUD, menus, text) in your canvases, never as page elements over the game (text fields are the one exception), and register GCP.test.onCapture(() => canvas or [canvases, bottom to top]) and GCP.test.onState(() => where the game is). The creator\'s feedback screenshots are that exact frame on every device, iPhone and iPad included (without the hook, Capture feedback is greyed out for the version: there is no other way to take one), and once the game is live the preview check "capture" fails a version without the hooks, with page elements painted over the game, or whose handed-over picture does not match the screen. get_started {topic: "contract"}, "Hand over the frame".',
          'Run with no uncaught errors, keep rendering frames (or, for a turn-based page, change when the player acts), survive keyboard, mouse and touch input, and stay on the page (no redirects, downloads or popups). That is what verification checks.',
          'Declare what the game shows (game_metadata content). Sexual content, violence and other mature themes are allowed when declared; adults-only games are shown blurred, labelled 18+ and start only after the player confirms a warning. The review plays the game and refuses a version whose sexual content or violence is not declared.',
          'A game in several languages is in those languages outside the game too. The platform (in en, zh, zh-TW, ja, ko and es) shows everything about a game in the player\'s platform language when the game is played in it, else in English, else in the game\'s own language: its name, tagline, description, controls text and cover, on the home page, cards, search, the game page, the library and friends\' lists. So for every platform language in game_metadata languages, give the store listing in that language (game_metadata listing_translations, and listing_language for the language the listing itself is in), and a cover per language when the cover shows text (update_project covers). publish refuses a version whose listing misses one of its languages.',
          `Fit the game's storage: all of a game's files together may use ${mb(s.bundle_max_bytes)} by default (one file at most ${mb(s.file_max_bytes)}, ${s.bundle_max_files} files). Uploads that would go over are refused, and a version over it cannot be deployed or published.`,
        ],
        storage: {
          per_game: `${mb(s.bundle_max_bytes)} for all of a game's files unless the platform set a different amount for that game; largest file ${mb(s.file_max_bytes)}; ${s.bundle_max_files} files. Platform-hosted Three.js and @gcp/ modules do not count.`,
          tell_the_developer: 'Tell the developer about this limit when you plan the game, before choosing large models, textures, audio or video, and again whenever an answer carries storage.warning (from 80% used). Do not discover it at upload time.',
          design_for_it: 'Prefer content generated from code at boot (meshes, terrain, textures, sound, music) and load large or optional content at run time from a host the developer controls. The page may fetch from any HTTPS host that sends CORS headers.',
          more: s.storage_requests_open ? `If the game truly needs more after that, ask with game_storage {project, action: "request", megabytes, reason}: up to ${mb(s.storage_max_bytes)} per game, reviewed by the platform${s.storage_auto_approve_bytes > 0 ? ` (approved at once up to ${mb(s.storage_auto_approve_bytes)})` : ''}. Ask the developer before requesting.` : 'Storage requests are closed on this platform: the game must fit.',
          check: 'Every upload, list_files, list_projects {project} and deploy_preview answer includes storage (used, storage, free, percent_used, and warning when it is getting full). game_storage {project} shows where the space goes, with every way to save it. get_started {topic: "storage"} is the long form.',
        },
        engines: ENGINE_EXPORTS,
        originality: 'After the browser check passes, each version is compared with other creators\' live games, and a copy (even with renamed variables or new titles) cannot be published. Platform templates, kits and common libraries are ignored, so starting from them is fine. An upload that is not a game is refused too, and so is content that is never allowed (hate, scams, phishing, sexual content involving minors) or abusive code (miners, password forms). Adult games (sexual content, graphic violence) are allowed when declared in the content descriptors: the review plays the game, looks at what it shows, and refuses a version that shows more than it declares. get_started {topic: "versions"} explains these checks.',
        workflow: [
          '1. create_project, once per game.',
          '2. upload_files for text files, small edits and deletions; create_upload_url to send big or binary files, or a whole folder as a zip, with curl. Each answer shows the game\'s storage; keep inside it (game_storage).',
          '2b. game_metadata: define what players see on the store page: genre, languages (interface, voice, subtitles; GCP.lang is the player\'s platform language; GCP.onLang(fn) hears when the player switches it mid-game, which never restarts the game), players and modes, session length, accessibility, content descriptors (the age rating) and the browser requirements, and the store listing in each platform language the game is played in (listing_language, listing_translations; covers with text per language through update_project covers). check shows what the code reveals and what is missing; declare saves it. Publishing a new version needs genre, requirements, languages, players, content and the listing in every platform language the game is played in.',
          '3. deploy_preview: static checks, then a new numbered version deployed to its own preview address and checked in a real browser. With dry_run: true it runs only the static checks.',
          '4. Read the report. If a check failed, fix it, upload, and deploy_preview again. list_versions {project, version} shows any version\'s report.',
          '4b. Look at the game and listen to the creator: debug_preview opens the preview in a browser you drive (screenshots, clicks, keys, the game\'s state), and creator_feedback returns the annotated screenshots and notes the creator left while playing the preview. Read creator_feedback at the start of every session and whenever an answer carries creator_feedback; each item is removed once you read it.',
          '4c. If the game shares its build skill (Open Implementation on), update it before every release: build_skill {project, action: "get"}, revise it for what changed, then build_skill {project, action: "write", version, content}. publish refuses a version without one while sharing is on.',
          '5. publish: the verified version goes live in the marketplace. rollback, unpublish and get_stats afterwards. update_project sets the listing, price and cover (and a cover per language); game_data and game_room manage the game\'s data and multiplayer rooms.',
        ],
        services: {
          catalog: 'platform_services lists every service (what it is, how it works, SDK calls, MCP tools, limits, guidelines) and what the platform does not provide. Read it before planning a game that needs more than hosting. get_started {topic: "services"} is the long form.',
          sdk: 'window.GCP, injected into every page. GCP.ready(), GCP.progress(f, label), GCP.fatal(err), GCP.player, GCP.env, GCP.lang and GCP.onLang(fn) (the platform language; switching it mid-game never restarts the game, fn(lang, previous) lets it swap text live), GCP.display (fullscreen, touch, paused), one pause owner: GCP.onEscape(fn) (Esc closes an open menu first; fn returns false only when nothing was open), GCP.pauseMenu(open) and GCP.setPaused(on) for a game with its own pause menu (Esc then opens that menu, never the platform menu too), GCP.paused and GCP.onPause(fn) (platform pause and game pause combined; freeze on it, never open a menu from it), GCP.menu(), GCP.quit(), GCP.setDisplay({ orientation, exitButton, edgeToEdge }). GCP.fullscreen() toggles fullscreen (the player also has a button and Alt+Enter, and phones start in fullscreen); see the input guide for touch controls. Every page is opened by a signed-in player (the platform requires an account to play, free games included; GCP.player.guest is true only if an administrator opens free games to guests). GCP.player.id is always that player.',
          saves: 'Every game should keep each player\'s progress with the platform: GCP.save.get/set/remove for the player\'s save (JSON), GCP.playerStats.add/max/min/set for numbers worth tracking (levels cleared, coins, best lap), GCP.playRecord() for what the platform recorded on its own (sessions, play time, first and last played). All of it is private to the signed-in player and this game, and preview is kept apart from live; the server enforces it, so a game cannot read another player\'s data. GCP.shared.get reads data every player sees. Load the save before the first playable frame and save at checkpoints and when the tab is hidden. game_data seeds shared data, aggregates saves and stats and manages leaderboards. get_started {topic: "saves"}.',
          leaderboards: 'GCP.leaderboard.submit(board, score, order) and GCP.leaderboard.top(board, n, order). game_data {action: "leaderboard"} reads or clears one.',
          multiplayer: 'GCP.room(name): a realtime room per room name on the platform\'s multiplayer servers, with a host and host migration. To play with friends, create the room under a random name and send it with a friend invite (see friends); never ask players to type or share a code. Host-authoritative (one player\'s browser runs the game): right for co-op, party, casual versus and turn-based games, not for ranked or competitive shooters and fighting games (the host can cheat, no lag compensation). game_room inspects or resets one. get_started {topic: "multiplayer"}.',
          friends: s.social_enabled ? 'Play with friends through friend invites, never typed codes: GCP.match.find({ private: true }) opens an invite-only lobby, GCP.friends.open({ match }) shows the platform\'s invite picker over the game (or GCP.friends.invite(id, { match }) from your own list, GCP.friends.list()), and a friend who accepts arrives with GCP.launch.join (or a GCP.friends.on("join") event) and calls GCP.match.join(join). A room game sends { data: { room } } instead. Only Online, Away and Busy friends can be invited. GCP.presence.set({ detail, joinable }) shows friends what the player does. get_started {topic: "multiplayer"}, section Playing with friends.' : 'Friends are switched off on this platform.',
          matches: 'GCP.match.find({ queue, players }) with server/match.js: for competitive real-time games. The platform matches players by region and rating, runs the game\'s rules at a fixed tick on its own servers near the players, predicts each player\'s own movement and judges shots where the target was on the shooter\'s screen (lag compensation). get_started {topic: "matches"}.',
          server_code: s.allow_server_code ? 'Optional server/index.js runs in the game\'s own Worker and is reached with GCP.server. get_started {topic: "saves"}.' : 'Disabled on this platform.',
          open_implementations: `Learn how other developers' live games were built, when they chose to share it: find_implementations searches them by kind of game, engine or technique and shows the patterns across them; get_implementation {game} returns one card (engine, rendering, input, audio, assets, platform services, loop and performance techniques, structure, verified play-through, summary). ${NEVER_SHARED} Games that share also publish a build skill in the Creator Store (${c.origin}/creator-store): an agent skill their own agent wrote. get_implementation includes it when it is free. To share your own, ask the user, write the skill with build_skill {action: "write"}, then update_project {open_implementation: true}; the user chooses free or a price (update_project skill_price_cents). While shared, write the skill again for each version before publishing it: publish refuses a version without one. ${openPerks(s)}`,
          compatibility: 'Each version carries its requirements: declared in gcp.json "requirements" (compatibility {action: "declare"} writes it), merged with what the platform detects in the code, frozen at deploy_preview. The store page lists them in a Compatibility section and checks the player\'s browser against them before launch. compatibility {action: "check"} shows what was detected and suggests a block.',
          interface_scale: 'Make the interface fit every screen and let the player size it: GCP.ui.configure({ reference: [1280, 720] }) once, then draw the interface in units with the canvas transform at devicePixelRatio * GCP.ui.scale, place boxes with anchors (GCP.ui.rect({ anchor: "top-right", w, h, margin }), GCP.ui.split) against GCP.ui.view and GCP.ui.safe, offer an Interface size setting with GCP.ui.sizes and GCP.ui.setSize, and redraw on GCP.ui.onChange. Fullscreen always overrides the size of the window the game was first shown in, so size from innerWidth and innerHeight on every resize. get_started {topic: "services"}, "Interface scale and the player\'s UI size".',
          touch_devices: 'Every game is playable on phones and tablets without code for it: the SDK gives keyboard games an on-screen stick and buttons that press the keys found in the game\'s code (or gcp.json "controls": {"touch": "auto" | "overlay" | "none", "stick", "buttons"}; GCP.controls at run time), gives mouse-only games mouse events from the finger and a pointer-lock stand-in, stops long-press selection, tap flashes and zoom, and caps devicePixelRatio at 2. Touch controls made for the game are still better: when the game has its own, the platform\'s stay away. get_started {topic: "touch"} has the details.',
          verification_hooks: 'Required: GCP.test.onCapture(fn) hands over the frame (the canvases that hold everything the player sees) and GCP.test.onState(fn) says where the game is; feedback screenshots use both (debug_preview returns the state), and the "capture" check holds them to the screen. Optional: GCP.test.onPlaythrough(fn) lets the verifier play your rules to the end; GCP.test.onTwoPlayers(fn) checks a two-player session (two verifier players meet on GCP.test.twoPlayers.code through GCP.room or GCP.match.find). get_started {topic: "contract"}.',
        },
        debugging: {
          see_the_game: 'debug_preview {project, action: "open"} opens the current preview in a real browser and returns a screenshot; {action: "act", steps: [...]} clicks, taps, drags, presses or holds keys, types, waits and returns screenshots after; {action: "close"} ends it. Each answer has state (ready, frames, uncaught errors, console errors, missing files, and what GCP.test.onState(fn) returns). Use it to reproduce a bug, check a layout on a phone viewport, or confirm a fix after deploy_preview. One browser per account, a few minutes each, no GPU.',
          creator_feedback: 'While playing the preview in the console, the creator can take a screenshot, circle or point at what is wrong, attach pictures of their own (design mockups, references) and mark those up too, write a note and add it to a queue. creator_feedback {project} returns the oldest items with their annotated pictures and takes them off the queue (peek: true only lists them). deploy_preview, list_versions and list_projects {project} say when items are waiting. Treat each item as a request from the creator: fix it, redeploy, and tell them what you changed.',
          game_state: 'GCP.test.onState(fn): register a function that returns where the game is (level, scene, player position, open menu). It is attached to every feedback screenshot and returned by debug_preview, so you can tell what a picture shows. Never called for players.',
        },
        account: await account(c),
        session: `The access token lasts ${Math.round(Math.max(60, s.oauth_access_ttl_s) / 60)} minutes. When a call answers 401, do not sign in again: POST ${c.origin}/oauth/token with grant_type=refresh_token, refresh_token and client_id, keep the new access_token and refresh_token from the answer, and repeat the call. The whole authorization ends after ${Math.max(1, Math.round(s.oauth_grant_ttl_s / 86400))} days or when the user revokes it. Projects, files and versions stay as they are across all of that.`,
        import_map: { note: 'The platform adds an import map to index.html unless the page has its own, so these bare imports resolve without a bundler. Using them is optional.', entries: defaultImports(c.origin) },
        guides: PLATFORM_GUIDES.map((g) => `${g.topic}: ${g.summary}`),
      };
    },
  },
  {
    name: 'platform_services', title: 'List the platform services',
    description: 'Lists every service this platform gives games and the agents that build them: hosting and versions, player accounts, cloud saves, player stats, the play record, shared game data, leaderboards, realtime multiplayer rooms, server-run matches and matchmaking, network smoothing, game server code, display and fullscreen, compatibility, verification hooks, publish checks, marketplace listing, paid games and trials, analytics, open implementations and agent access. Each entry says what it is, how it works, what to use it for, the SDK calls (window.GCP) and MCP tools that reach it, its limits on this platform, and usage guidelines. not_provided lists what the platform does not offer (AI for games, in-game purchases, achievements, secrets for server code, dedicated native servers, and more) with what to do instead. Call it when planning a game, before building your own backend for something the platform already does. Pass service for one entry.',
    inputSchema: obj({ service: { type: 'string', description: 'Optional. One service id (e.g. "multiplayer", "saves", "server_code") to return only that entry.' } }), annotations: { readOnlyHint: true },
    run: async (a, c) => {
      const all = platformServices(await getSettings(c.env), c.origin);
      if (a.service) {
        const one = all.find((x) => x.id === String(a.service).toLowerCase().trim());
        if (!one) throw bad(`No service "${a.service}".`, `Services: ${all.map((x) => x.id).join(', ')}`);
        return { service: one, more: one.guide ? `get_started {topic: "${one.guide}"}` : 'get_started' };
      }
      return {
        summary: 'Everything below is reached from the game through window.GCP (injected; never bundle it) or by you through this server\'s tools. Nothing needs keys, setup or a backend of your own: the platform takes the game, environment and player from the signed play session.',
        services: all.map((x) => ({ ...x, guide: x.guide ? `get_started {topic: "${x.guide}"}` : null })),
        not_provided: NOT_PROVIDED,
        discover: DISCOVERY,
      };
    },
  },
  {
    name: 'list_projects', title: 'List projects or show one',
    description: "Without project: lists this account's games with status (draft, live, offline), live and preview versions and marketplace numbers. With project: shows that one in detail, with workspace size, links and the newest version's report.",
    inputSchema: obj({ project: { ...PROJECT, description: 'Optional. A project id or slug to show in detail.' } }), annotations: { readOnlyHint: true },
    run: async (a, c) => {
      if (!a.project) {
        const rows = await c.env.DB.prepare("SELECT id, slug, title, tagline, tags, status, CASE WHEN status = 'live' THEN live_version ELSE NULL END AS live_version, preview_version, price_cents, CASE WHEN price_cents > 0 THEN trial_minutes ELSE 0 END AS trial_minutes, plays, sales, updated_at FROM projects WHERE owner_id = ? AND status != 'removed' ORDER BY updated_at DESC").bind(c.user.id).all<any>();
        return { projects: rows.results.map((r) => ({ ...r, tags: JSON.parse(r.tags || '[]') })) };
      }
      const p = await ownedProject(c.env, c.user, a.project), files = await listFiles(c.env, p.id);
      const latest = await c.env.DB.prepare('SELECT * FROM versions WHERE project_id = ? ORDER BY n DESC LIMIT 1').bind(p.id).first<any>();
      return {
        project: p.id, slug: p.slug, title: p.title, tagline: p.tagline, description: p.description, controls: p.controls, tags: JSON.parse(p.tags || '[]'),
        cover: p.cover_key ? `${c.origin}/api/media/${p.cover_key}` : null,
        status: p.status, price: p.price_cents ? usd(p.price_cents) : 'free', sale: saleText(p, await getSettings(c.env)), free_trial: trialText(p, await getSettings(c.env)), live_version: p.status === 'live' ? p.live_version : null, preview_version: p.preview_version,
        workspace: { files: files.length, bytes: files.reduce((x, f) => x + f.size, 0) }, storage: await storageLine(c.env, p, files),
        latest_version: latest ? await versionReport(c, p, latest.n, latest) : null,
        game_page: p.status === 'live' ? `${c.origin}/g/${p.slug}` : null, console_page: `${c.origin}/console/projects/${p.id}`,
        open_implementation: sharing(p),
      };
    },
  },
  {
    name: 'create_project', title: 'Create a game project',
    description: `Creates an empty project for one web game and returns its id, which every other tool takes. ${WEB_ONLY} Next: upload_files or create_upload_url.`,
    inputSchema: obj({
      title: { type: 'string', description: 'Game title shown in the marketplace.' },
      tagline: { type: 'string', description: 'One line shown on the game card.' },
      description: { type: 'string', description: 'Longer description for the game page.' },
      genre: GENRE_SCHEMA,
      tags: TAGS_SCHEMA,
    }, ['title']),
    run: async (a, c) => {
      let p = await createProject(c.env, c.user, a as any, c.client);
      if (a.genre !== undefined) { await updateProjectMeta(c.env, p, { genre: a.genre }); p = await ownedProject(c.env, c.user, p.id); }
      return {
        project: p.id, slug: p.slug, title: p.title, console_page: `${c.origin}/console/projects/${p.id}`, storage: await storageLine(c.env, p, []),
        tell_the_developer: `This game has ${mb(budgetOf(p, await getSettings(c.env)).bytes)} of storage for all its files. Plan assets around it: generate content from code and load large or optional content at run time (game_storage {project} explains how).`,
        next: 'Upload the game: upload_files for text files, create_upload_url for big or binary files or a whole folder. Then deploy_preview.',
        ...(JSON.parse(p.tags || '[]').length < 2 ? { before_publishing: 'Publishing needs 2 to 8 tags from the platform list (game_metadata {project} shows them). Add them with update_project {project, tags} any time before publish.' } : {}),
      };
    },
  },
  {
    name: 'update_project', title: 'Update listing, price, sale, cover or sharing',
    description: 'Updates the marketplace listing: title, tagline, description, genre and secondary genres, tags (both from the platform lists; see game_metadata), controls text, the listing translated into platform languages, price, free trial and cover image. price_cents 0 means free; a positive value makes it a paid game (one-time purchase in US cents), and the platform keeps its cut of each sale. trial_minutes lets players who have not bought a paid game play it for that many minutes in total (counted per account on the server, across reloads and devices) before they are asked to buy; 0 turns the trial off. Only set a price or a trial when the user has chosen them. sale puts a paid game on a limited-time sale: {price_cents, days}; the store shows the sale price with the regular price struck through and when it ends, and buyers pay the sale price until it ends (then the regular price is back by itself). Sending sale again while one runs changes it; null ends it early. The regular price cannot change during a sale. Only start a sale when the user has chosen one. cover is the workspace path of a png, jpg or webp under 2 MB (ideally 16:9); without one, the verification screenshot is used. open_implementation true lets other developers\' agents learn how the live game is built through get_implementation (engine, rendering, input, techniques, a summary; never code or files); false stops sharing at once. Only set it when the user has chosen to share. Sharing puts the game\'s build skill (written with build_skill) in the Creator Store; skill_price_cents 0 shares it for free, a price sells it (the user\'s choice).',
    inputSchema: obj({
      project: PROJECT, title: { type: 'string' }, tagline: { type: 'string' }, description: { type: 'string' }, tags: TAGS_SCHEMA,
      controls: { type: 'string', description: 'How to play, shown on the game page (keys, touch).' },
      price_cents: { type: 'integer', description: '0 for free, or the price in US cents (e.g. 499 = $4.99).' },
      trial_minutes: { type: 'integer', description: 'Paid games only: minutes of free play before buying (e.g. 30). 0 turns the free trial off. get_started shows the longest allowed.' },
      cover: { type: 'string', description: 'Workspace path of the cover image, e.g. "cover.png": the cover for the listing\'s own language, and for every language without one of its own.' },
      covers: { type: 'object', description: 'A cover per platform language, for covers that show text such as the game\'s name: {"zh": "cover-zh.jpg", "ja": "cover-ja.jpg"}, workspace paths; null removes one. The listing\'s own language uses cover. Players see the cover of the language the listing is shown in.' },
      listing_language: LISTING_LANGUAGE_SCHEMA,
      open_implementation: { type: 'boolean', description: 'Share how the live game is built with other agents (no code), and its build skill in the Creator Store. Default off.' },
      sale: { type: ['object', 'null'], properties: { price_cents: { type: 'integer', description: 'The sale price in US cents, below the regular price (get_started shows the smallest discount and lowest sale price allowed).' }, days: { type: 'integer', description: 'How many days the sale lasts, from now (or from when the running sale started).' } }, description: 'A limited-time sale of a paid game: {price_cents, days}; null ends the running sale. Only when the user has chosen.' },
      skill_price_cents: { type: 'integer', description: 'The build skill\'s price in US cents, or 0 to share it for free. A free skill lowers the game\'s own platform cut; a sold one keeps the standard cut and pays the skill commission on skill sales. Only when the user has chosen.' },
      genre: GENRE_SCHEMA, genres: { type: 'array', maxItems: 2, items: { type: 'string', enum: [...GENRES] }, description: 'Up to two secondary genres.' },
      listing_translations: TRANSLATIONS_SCHEMA,
    }, ['project']),
    run: async (a, c) => {
      const p = await ownedProject(c.env, c.user, a.project);
      let cover: string | undefined;
      const storeCover = async (raw: unknown, tag: string) => {
        const path = cleanPath(String(raw)) || '', ext = extOf(path);
        if (!['png', 'jpg', 'jpeg', 'webp'].includes(ext)) throw bad(`The ${tag} cover must be a png, jpg or webp file.`);
        const { row, bytes } = await readFile(c.env, p.id, path);
        if (row.size > 2 * 1024 * 1024) throw bad(`The ${tag} cover must be under 2 MB.`);
        const key = `covers/${p.id}-${tag === 'main' ? '' : tag + '-'}${now().toString(36)}.${ext}`;
        await c.env.FILES.put(key, bytes, { httpMetadata: { contentType: row.ctype } });
        return key;
      };
      // covers per language are checked whole before anything is stored
      const perLang: [string, unknown][] = [];
      if (a.covers !== undefined && a.covers !== null) {
        if (typeof a.covers !== 'object' || Array.isArray(a.covers)) throw bad('covers must map a platform language to a workspace path: {"zh": "cover-zh.jpg"}.');
        for (const [k, v] of Object.entries(a.covers as Record<string, unknown>)) {
          const l = listingLangCode(k);
          if (!l || !isLang(l)) throw bad(`covers: "${k}" is not one of the platform languages.`, 'Platform languages: en, zh, zh-TW, ja, ko, es.');
          if (v !== null && typeof v !== 'string') throw bad(`covers.${k} must be a workspace path or null.`);
          perLang.push([l, v]);
        }
      }
      const { cover: _c, covers: _cs, open_implementation: open, skill_price_cents: skillPrice, sale: saleIn, ...meta } = a;
      await updateProjectMeta(c.env, p, meta);
      if (saleIn !== undefined) await applySale(c.env, await ownedProject(c.env, c.user, p.id), saleIn, c.client);
      const fresh = await ownedProject(c.env, c.user, p.id), own = baseListingLang(fresh), langCovers: Record<string, string | null> = {};
      // the cover of the listing's own language is the main cover
      const mainPath = a.cover || perLang.find(([l, v]) => l === own && v)?.[1];
      if (mainPath) {
        const key = await storeCover(mainPath, 'main');
        await c.env.DB.prepare('UPDATE projects SET cover_key = ? WHERE id = ?').bind(key, p.id).run();
        cover = `${c.origin}/api/media/${key}`;
      }
      if (perLang.some(([l]) => l !== own)) {
        const cur = JSON.parse(fresh.listing_i18n || '{}') as Record<string, Record<string, string>>;
        for (const [l, v] of perLang) {
          if (l === own) continue;
          if (v === null) { if (cur[l]) { delete cur[l].cover_key; if (!Object.keys(cur[l]).length) delete cur[l]; } langCovers[l] = null; continue; }
          const key = await storeCover(v, l);
          cur[l] = { ...(cur[l] || {}), cover_key: key }; langCovers[l] = `${c.origin}/api/media/${key}`;
        }
        await c.env.DB.prepare('UPDATE projects SET listing_i18n = ? WHERE id = ?').bind(JSON.stringify(cur), p.id).run();
      }
      if (skillPrice !== undefined) await setSkillPrice(c.env, await getSettings(c.env), p, skillPrice, c.client);
      if (typeof open === 'boolean') await setOpenImplementation(c.env, p, open, c.client);
      const q = await ownedProject(c.env, c.user, p.id), s = await getSettings(c.env);
      if (a.trial_minutes !== undefined) await logEvent(c.env, p.id, 'trial', Number(a.trial_minutes) > 0 ? `Free trial set to ${Math.round(Number(a.trial_minutes))} min` : 'Free trial turned off', null, c.client);
      return { ok: true, title: q.title, price: q.price_cents ? usd(q.price_cents) : 'free', sale: saleText(q, s), free_trial: trialText(q, s), creator_receives_per_sale: q.price_cents ? usd(splitSale(q.price_cents, s, freeSkillShared(q)).net) : null, ...(cover ? { cover } : {}), ...(Object.keys(langCovers).length ? { covers: langCovers } : {}), open_implementation: sharing(q), ...(q.skill_price_cents > 0 ? { creator_receives_per_skill_sale: usd(splitSkillSale(q.skill_price_cents, s).net) } : {}) };
    },
  },
  {
    name: 'upload_files', title: 'Upload, edit or delete files',
    description: `Changes the project workspace in one call: files writes whole files, edits replaces an exact piece of text in a file already there (cheaper than resending it), delete removes paths. Paths are relative to the bundle root, e.g. "index.html", "src/game.js". Binary content must be base64 with encoding "base64"; for big or binary files, or a whole folder, create_upload_url is better. Only web file types are accepted, and executables or archives are refused whatever their name. The whole call is checked first: if any file or edit fails, nothing in the call is saved. Deployed versions keep their own copies, so nothing here changes a preview or the live game until the next deploy_preview and publish. Example: {"project": "abc123", "files": [{"path": "index.html", "content": "<!doctype html>..."}], "edits": [{"path": "src/main.js", "old_string": "speed = 4", "new_string": "speed = 5"}], "delete": ["old.js"]}.`,
    inputSchema: obj({
      project: PROJECT,
      files: { type: 'array', maxItems: 40, description: 'Whole files to create or replace, as {path, content} objects. Up to 40 per call.', items: obj({ path: { type: 'string', description: 'Relative path inside the bundle.' }, content: { type: 'string', description: 'The whole file as text (or base64 when encoding is "base64").' }, encoding: { type: 'string', enum: ['utf8', 'base64'], description: 'Default utf8.' } }, ['path', 'content']) },
      edits: { type: 'array', maxItems: 40, description: 'Exact text replacements in text files already in the workspace. old_string must match exactly (spaces and newlines included) and appear once, unless replace_all is true. Applied after files.', items: obj({ path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' }, replace_all: { type: 'boolean' } }, ['path', 'old_string', 'new_string']) },
      delete: { type: 'array', items: { type: 'string' }, description: 'Paths to delete.' },
    }, ['project']),
    run: async (a, c) => {
      const p = await ownedProject(c.env, c.user, a.project);
      const files = Array.isArray(a.files) ? a.files : [], edits = Array.isArray(a.edits) ? a.edits : [], dels = Array.isArray(a.delete) ? a.delete : [];
      if (!files.length && !edits.length && !dels.length) throw bad('Nothing to do.', 'Pass files, edits or delete. files is an array of {path, content} objects, not a map of path to content.');
      // Check and compute everything in memory first: if any file or edit fails, nothing in the call is saved.
      const pending = new Map<string, Uint8Array>(), edited: { path: string; replaced: number }[] = [];
      for (const f of files) {
        const path = cleanPath(f.path);
        if (!path) throw bad(`${f.path}: not a valid path or file type.`, 'Use relative paths such as "index.html" or "src/game.js", with a web file type (html, js, css, images, sounds, JSON, text).');
        let bytes: Uint8Array;
        try { bytes = f.encoding === 'base64' ? unb64(String(f.content).replace(/\s+/g, '')) : new TextEncoder().encode(String(f.content ?? '')); } catch { throw bad(`${f.path}: content is not valid base64.`); }
        pending.set(path, bytes);
      }
      for (const e of edits) {
        const path = cleanPath(e.path) || '';
        if (!isText(path)) throw bad(`${e.path}: edits only work on text files.`);
        const cur = pending.get(path) ?? (await readFile(c.env, p.id, path)).bytes;
        const src = new TextDecoder().decode(cur), old = String(e.old_string);
        if (!old) throw bad(`${path}: old_string must not be empty.`);
        const count = src.split(old).length - 1;
        if (count === 0) throw bad(`${path}: old_string was not found.`, 'Copy the exact text, including indentation, or send the whole file under files.');
        if (count > 1 && !e.replace_all) throw bad(`${path}: old_string appears ${count} times.`, 'Include more surrounding text to make it unique, or set replace_all to true.');
        const out = e.replace_all ? src.split(old).join(String(e.new_string)) : src.replace(old, () => String(e.new_string));
        pending.set(path, new TextEncoder().encode(out));
        edited.push({ path, replaced: e.replace_all ? count : 1 });
      }
      // The whole call against the game's storage, deletes included, so a call that swaps a big file for a smaller one fits.
      const before = await listFiles(c.env, p.id), s = await getSettings(c.env);
      assertFits(s, p, before, [...pending].map(([path, bytes]) => ({ path, size: bytes.byteLength })), dels.map((d: unknown) => cleanPath(String(d)) || String(d)));
      // Every part passed: write.
      const rows = new Map<string, Awaited<ReturnType<typeof putFile>>>();
      for (const [path, bytes] of pending) rows.set(path, await putFile(c.env, p, path, bytes, true));
      const written = [...new Set(files.map((f) => cleanPath(f.path)!))].map((path) => ({ path, bytes: rows.get(path)!.size, sha: rows.get(path)!.sha }));
      const deleted: string[] = [];
      const notFound: string[] = [];
      for (const d of dels) { const path = cleanPath(String(d)); if (path && await deleteFile(c.env, p.id, path)) deleted.push(path); else notFound.push(String(d)); }
      return {
        written, edited: edited.map((e) => ({ path: e.path, bytes: rows.get(e.path)!.size, sha: rows.get(e.path)!.sha, replaced: e.replaced })), deleted,
        ...(notFound.length ? { not_deleted: notFound, not_deleted_why: 'Not in the workspace (paths are case sensitive and relative to the bundle root). list_files shows every path.' } : {}),
        storage: await storageLine(c.env, p),
        next: 'Call deploy_preview when the changes are complete (dry_run: true for only the static checks).',
      };
    },
  },
  {
    name: 'create_upload_url', title: 'Get a direct upload URL',
    description: 'Returns a short-lived URL for uploading files straight from a shell with curl, without passing their contents through this conversation. Use it for large or binary files, or a whole folder as a zip (an engine\'s web export folder, for example). Valid for 30 minutes.',
    inputSchema: obj({ project: PROJECT }, ['project']),
    run: async (a, c) => {
      const p = await ownedProject(c.env, c.user, a.project), t = randomToken(24);
      await c.env.DB.prepare('INSERT INTO uploads (token_hash, project_id, user_id, expires_at) VALUES (?, ?, ?, ?)').bind(await sha256(t), p.id, c.user.id, now() + 30 * 60000).run();
      const base = `${c.origin}/api/upload/${t}`;
      return {
        expires_in_minutes: 30,
        file_url: `${base}?path=`, zip_url: `${base}/zip`,
        one_file: `curl -fsS -X PUT --data-binary @index.html "${base}?path=index.html"`,
        whole_folder: `zip -qr /tmp/game.zip . -x '.*' && curl -fsS -X POST --data-binary @/tmp/game.zip "${base}/zip"`,
        note: 'file_url and zip_url are the bare URLs for scripts (append the workspace path, URL-encoded, to file_url; PUT one file there, or POST a zip to zip_url). one_file and whole_folder are ready-to-run commands. Run whole_folder inside the folder that holds index.html. Paths inside the zip become paths in the workspace. Add ?clean=1 to the zip URL to delete workspace files that are not in the zip (gcp.json, which holds the declared build metadata, is kept; a gcp.json in the zip replaces it but keeps any build field it leaves out). Each call prints JSON listing what was written.',
      };
    },
  },
  {
    name: 'list_files', title: 'List workspace files',
    description: 'Lists every file in the project workspace with its size and sha (the first 32 hex characters of its SHA-256), so you can see which local files differ from what was uploaded.',
    inputSchema: obj({ project: PROJECT }, ['project']), annotations: { readOnlyHint: true },
    run: async (a, c) => { const p = await ownedProject(c.env, c.user, a.project), files = await listFiles(c.env, p.id); return { files: files.map((f) => ({ path: f.path, bytes: f.size, sha: f.sha })), total_bytes: files.reduce((x, f) => x + f.size, 0), storage: await storageLine(c.env, p, files) }; },
  },
  {
    name: 'game_storage', title: 'Check the game\'s storage or ask for more',
    description: 'Every game has a storage limit for all its files together (the platform default unless the platform set a different amount for this game), plus a largest-file size and a file count. Uploads that would go over are refused, and a version over it cannot be deployed or published. action "check" (default) shows the storage, what is used and free, the share used per kind of file (models, textures, audio, code…), the largest files, every way to keep the game small (generating content from code, loading large or optional content at run time from your own host, compression), how loading at run time works on this platform (CORS, caching, verification), and the status of any request. action "request" asks the platform for more storage for this game: megabytes is the new total wanted, reason says what needs the space and why generating it or loading it at run time does not work for it. Ask the developer before requesting; a request may wait for an admin. Tell the developer about the limit when planning assets, and whenever an answer carries storage.warning.',
    inputSchema: obj({
      project: PROJECT,
      action: { type: 'string', enum: ['check', 'request'], description: 'Default "check".' },
      megabytes: { type: 'number', description: 'request only: the total storage wanted for this game, in MB (not an amount to add).' },
      reason: { type: 'string', description: 'request only: what needs the space and why generating it from code or loading it at run time does not work for it (at least 40 characters).' },
    }, ['project']),
    run: async (a, c) => {
      const p = await ownedProject(c.env, c.user, a.project), action = a.action || 'check';
      if (action === 'request') return { project: p.id, ...(await requestStorage(c.env, c.user, p, a.megabytes, a.reason, c.client)), storage: await storageLine(c.env, await ownedProject(c.env, c.user, p.id)) };
      if (action !== 'check') throw bad('action must be "check" or "request".');
      const files = await listFiles(c.env, p.id), report = await storageReport(c.env, p, files);
      return {
        project: p.id, ...report, status: await storageLine(c.env, p, files), ...STORAGE_GUIDE,
        tell_the_developer: 'Share this with the developer when planning assets: how much storage the game has, what uses it, and the plan to stay inside it.',
        guide: 'get_started {topic: "storage"}',
      };
    },
  },
  {
    name: 'game_metadata', title: 'Define the game\'s store metadata',
    description: `Everything players see about the game on its store page, in one place. Define it while building the game: publishing a new version needs genre, tags, requirements, languages, players and content (the refusal lists what is missing). Listing (any time, no deploy needed): title, tagline, description, controls, genre (one of ${GENRES.join(', ')}), up to two secondary genres, tags (${MIN_TAGS} to ${MAX_TAGS} from the platform list: setting and theme, mood, gameplay, players, visual style and view; nothing else is accepted), and listing_translations (the listing in the platform languages en, zh, zh-TW, ja, ko, es). Build (frozen with the next deploy_preview, written to gcp.json): requirements (what it needs from the browser; see the compatibility tool), languages (interface, voice and subtitles per language, and whether it follows the player's platform language GCP.lang), players (min, max, modes), session_minutes (a typical session), progress (cloud_saves, leaderboards, offline; detected from GCP.save and GCP.leaderboard), accessibility (${ACCESSIBILITY.join(', ')}; [] for none) and content (descriptors the platform turns into an age rating). action "check" (default) shows the whole picture: what is declared, what the code shows (renderer, input, online play through rooms or server-run matches, saves, leaderboards, languages from translation files and on-screen text), problems, what publishing still needs, and suggestions. action "declare" validates and saves the fields you pass (each replaces that field; nothing is saved if any field is invalid). version shows what that version went out with.`,
    inputSchema: obj({
      project: PROJECT,
      action: { type: 'string', enum: ['check', 'declare'], description: 'Default "check".' },
      title: { type: 'string' }, tagline: { type: 'string' }, description: { type: 'string' }, controls: { type: 'string' },
      genre: GENRE_SCHEMA, genres: { type: 'array', maxItems: 2, items: { type: 'string', enum: [...GENRES] }, description: 'Up to two secondary genres.' },
      tags: TAGS_SCHEMA,
      listing_language: LISTING_LANGUAGE_SCHEMA,
      listing_translations: TRANSLATIONS_SCHEMA,
      requirements: { ...REQUIREMENTS_SCHEMA, description: 'What the game needs from the browser (same as compatibility declare).' },
      languages: LANGUAGES_SCHEMA, players: PLAYERS_SCHEMA,
      session_minutes: { type: 'integer', description: 'Length of a typical session in minutes.' },
      progress: { type: 'object', description: '{"cloud_saves": true, "leaderboards": false, "offline": true}. Detected from the code when left out.' },
      accessibility: { type: 'array', items: { type: 'string', enum: [...ACCESSIBILITY] }, description: 'Accessibility features the game has; [] when none.' },
      content: CONTENT_SCHEMA,
      version: { type: 'integer', description: 'Optional. Show what this version went out with.' },
    }, ['project']), annotations: { idempotentHint: true },
    run: async (a, c) => {
      let p = await ownedProject(c.env, c.user, a.project);
      if (a.version !== undefined && a.version !== null) {
        const v = await getVersion(c.env, p.id, Number(a.version));
        if (!v) throw bad(`Version ${a.version} does not exist.`, 'Call list_versions.');
        const { compat, meta } = await ensureVersionMeta(c.env, v);
        return { version: v.n, ...metaSummary(p, compat, meta) };
      }
      const action = a.action || 'check';
      if (action !== 'check' && action !== 'declare') throw bad('action must be "check" or "declare".');
      const written: string[] = [];
      if (action === 'declare') {
        const build = BUILD_FIELDS.filter((f) => a[f] !== undefined), listing = LISTING_FIELDS.filter((f) => a[f] !== undefined);
        if (!build.length && !listing.length) throw bad('Nothing to declare.', `Pass any of ${[...LISTING_FIELDS, ...BUILD_FIELDS].join(', ')}. game_metadata {project} (check) shows what is missing.`);
        // validate every build field first: nothing is written when one is wrong
        const issues: MetaIssue[] = [];
        if (a.requirements !== undefined) issues.push(...parseRequirements(a.requirements).issues);
        if (a.languages !== undefined) issues.push(...parseLanguages(a.languages).issues);
        if (a.players !== undefined) parsePlayers(a.players, issues);
        if (a.content !== undefined) parseContent(a.content, issues);
        if (a.accessibility !== undefined) parseAccessibility(a.accessibility, issues);
        if (a.session_minutes !== undefined && a.session_minutes !== null && !(Number(a.session_minutes) >= 1 && Number(a.session_minutes) <= 600)) issues.push({ level: 'error', field: 'session_minutes', message: 'session_minutes must be from 1 to 600.' });
        const errs = issues.filter((i) => i.level === 'error');
        if (errs.length) throw bad(errs.map((i) => `${i.field}: ${i.message}${i.hint ? ` (${i.hint})` : ''}`).join(' · '), 'Nothing was saved. Fix those fields and declare again.');
        if (listing.length) { await updateProjectMeta(c.env, p, Object.fromEntries(listing.map((f) => [f, a[f]]))); written.push(...listing); }
        if (build.length) {
          const gcp = await workspaceManifest(c, p.id);
          for (const f of build) if (a[f] === null) delete gcp[f]; else gcp[f] = f === 'requirements' ? parseRequirements(a[f]).value : f === 'languages' ? parseLanguages(a[f]).value : a[f];
          await putFile(c.env, p, 'gcp.json', new TextEncoder().encode(JSON.stringify(gcp, null, 2) + '\n'));
          written.push(...build);
        }
        await logEvent(c.env, p.id, 'metadata', `Game metadata declared: ${written.join(', ')}`, null, c.client);
        p = await ownedProject(c.env, c.user, p.id);
      }
      const check = await checkProject(c.env, p, c.origin), cp = check.manifest.compat!, mr = check.manifest.meta!;
      const summary = metaSummary(p, cp, mr), issues = [...check.compatIssues, ...check.metaIssues].map(metaIssueLine);
      const suggest: Record<string, unknown> = {};
      if (!cp.declared) suggest.requirements = requirementsBlock(cp.detected);
      if (!mr.languages.declared) suggest.languages = { default: mr.languages.detected.default, supported: mr.languages.detected.supported, follows_platform: mr.languages.detected.follows_platform };
      if (!mr.declared.includes('players')) suggest.players = mr.detected.multiplayer ? { min: 1, max: 4, modes: ['single', 'coop-online'] } : { min: 1, max: 1, modes: ['single'] };
      if (!mr.declared.includes('progress')) suggest.progress = mr.detected.progress;
      return {
        ...(written.length ? { saved: written, takes_effect: written.some((f) => (BUILD_FIELDS as readonly string[]).includes(f)) ? 'listing fields at once; build fields (gcp.json) with the next deploy_preview' : 'at once' } : {}),
        checklist: metadataChecklist(p, cp, mr),
        ...summary, detected: { online_play: mr.detected.multiplayer, multiplayer_rooms: mr.detected.multiplayer, progress: mr.detected.progress, languages: mr.languages.detected.supported.map((l) => l.code), evidence: { ...mr.detected.evidence, ...mr.languages.evidence } },
        issues, ...(Object.keys(suggest).length ? { suggested: suggest } : {}),
        next: issues.some((i) => i.startsWith('ERROR')) ? 'Fix the errors, then call game_metadata again.'
          : summary.missing_for_publish.length ? `Still needed before publishing: ${summary.missing_for_publish.join('; ')}. Check the suggestions against the game (they come from a code scan), then game_metadata {action: "declare", …}.`
            : 'Complete. Deploy with deploy_preview; the version carries the build fields.',
      };
    },
  },
  {
    name: 'compatibility', title: 'Declare and check compatibility requirements',
    description: 'Shortcut for the requirements part of game_metadata. What the game needs from the player\'s browser and device: the weakest graphics API it runs with (canvas, webgl, webgl2, webgpu), whether it needs a hardware GPU, required and optional browser features (WebAssembly, Web Audio, pointer lock…), input methods, devices, orientation, memory, minimum browser versions and known issues. The store page shows them in a Compatibility section and checks each player\'s browser against them before launch, so declare what is true. action "check" (default) scans the workspace and returns what the code shows it uses (with the reason for each item), what gcp.json declares, any problems, and a suggested block. action "declare" validates requirements and writes them into gcp.json "requirements" (fields you pass replace those fields; use_detected: true starts from what was detected); they take effect with the next deploy_preview. With version, returns what that version went out with. Without a declaration, the platform publishes what it detected and says so on the store page.',
    inputSchema: obj({
      project: PROJECT,
      action: { type: 'string', enum: ['check', 'declare'], description: 'Default "check".' },
      requirements: { ...REQUIREMENTS_SCHEMA, description: 'For "declare": the fields to set.' },
      use_detected: { type: 'boolean', description: 'For "declare": start from the detected requirements, then apply requirements on top.' },
      replace: { type: 'boolean', description: 'For "declare": replace the whole declaration instead of only the fields given.' },
      version: { type: 'integer', description: 'Optional. Show what this version went out with.' },
    }, ['project']), annotations: { idempotentHint: true },
    run: async (a, c) => {
      const p = await ownedProject(c.env, c.user, a.project);
      if (a.version !== undefined && a.version !== null) {
        const v = await getVersion(c.env, p.id, Number(a.version));
        if (!v) throw bad(`Version ${a.version} does not exist.`, 'Call list_versions.');
        return { version: v.n, ...compatSummary(await ensureCompat(c.env, v)) };
      }
      const action = a.action || 'check';
      if (action !== 'check' && action !== 'declare') throw bad('action must be "check" or "declare".');
      if (action === 'declare') {
        if (!a.requirements && !a.use_detected) throw bad('Pass requirements, or use_detected: true.', 'Example: {"project": "…", "action": "declare", "requirements": {"graphics": "webgl2", "input": ["keyboard", "mouse", "touch"], "devices": ["desktop", "tablet", "mobile"]}}');
        const parsed = parseRequirements(a.requirements ?? {});
        const errors = parsed.issues.filter((i) => i.level === 'error');
        if (errors.length) throw bad(`requirements: ${errors.map((i) => `${i.field}: ${i.message}${i.hint ? ` (${i.hint})` : ''}`).join(' · ')}`, 'Nothing was written. Fix those fields and call declare again.');
        const gcp = await workspaceManifest(c, p.id);
        const before = a.replace ? {} : (gcp.requirements && typeof gcp.requirements === 'object' ? gcp.requirements as Record<string, unknown> : {});
        const base = a.use_detected ? requirementsBlock((await checkProject(c.env, p, c.origin)).manifest.compat!.detected) : {};
        const next = { ...before, ...base, ...(a.requirements || {}) };
        const check = parseRequirements(next);
        if (check.issues.some((i) => i.level === 'error')) throw bad(`requirements: ${check.issues.filter((i) => i.level === 'error').map((i) => `${i.field}: ${i.message}`).join(' · ')}`, 'Nothing was written. With replace: true the whole declaration is replaced.');
        await putFile(c.env, p, 'gcp.json', new TextEncoder().encode(JSON.stringify({ ...gcp, requirements: check.value }, null, 2) + '\n'));
        await logEvent(c.env, p.id, 'requirements', 'Compatibility requirements declared', null, c.client);
      }
      const check = await checkProject(c.env, p, c.origin), cp = check.manifest.compat!;
      const issues = check.compatIssues.map((i) => `${i.level.toUpperCase()} ${i.field}: ${i.message}${i.hint ? `\n  fix: ${i.hint}` : ''}`);
      return {
        ...(action === 'declare' ? { written: 'gcp.json', takes_effect: 'with the next deploy_preview' } : {}),
        declared: cp.declared ? (await workspaceManifest(c, p.id)).requirements ?? null : null,
        detected: requirementsBlock(cp.detected), evidence: cp.evidence,
        store_page_will_show: describeRequirements(cp.requirements), download_size_bytes: cp.download_bytes,
        issues,
        ...(cp.declared ? {} : { suggested: requirementsBlock(cp.detected) }),
        next: issues.some((i) => i.startsWith('ERROR')) ? 'Fix the errors, then call compatibility again.'
          : cp.declared ? 'Declared. Deploy with deploy_preview; the version carries these requirements.'
            : 'Review the suggested block (correct anything the code scan got wrong, e.g. input it supports, devices, a hardware GPU), then call compatibility {action: "declare", requirements: {…}}.',
      };
    },
  },
  {
    name: 'deploy_preview', title: 'Deploy a preview and verify it',
    description: `Runs the static checks (JavaScript syntax with the exact line, imports that do not resolve, missing files, the GCP.ready() contract, web-only content, size limits), then freezes the workspace as a new numbered version, deploys it to its own preview address and opens it in a real browser to check that it boots, renders, survives input and throws no errors. If the game registered GCP.test.onPlaythrough, the browser also plays it. Returns the report. With dry_run: true only the static checks run and nothing is deployed. The browser check takes one to two minutes; if it is still running after ${DEPLOY_WAIT_MS / 1000} seconds the answer says not_finished and list_versions {project, version} returns the report (do not deploy again meanwhile). retry_version: n runs the deploy and browser check again on the newest version when it failed (for example a heavy game that only just missed the frame count on the verifier's software GPU), without making a new version number; up to ${RETRY_LIMIT} retries per version.`,
    inputSchema: obj({ project: PROJECT, note: { type: 'string', description: 'What changed in this version (shown in the version list).' }, dry_run: { type: 'boolean', description: 'Only run the static checks.' }, retry_version: { type: 'integer', description: 'Optional. Check this failed version again (it must be the newest) instead of making a new one from the workspace.' } }, ['project']),
    run: async (a, c) => {
      const p = await ownedProject(c.env, c.user, a.project);
      if (a.retry_version !== undefined && a.retry_version !== null) return retryPreview(c, p, Number(a.retry_version));
      const check = await checkProject(c.env, p, c.origin);
      const storage = await storageLine(c.env, p);
      if (a.dry_run) return { ok: check.ok, files: check.files, bytes: check.bytes, storage, errors: check.errors.map(issueLine), warnings: check.warnings.map(issueLine), next: check.ok ? 'No errors. Call deploy_preview without dry_run.' : 'Fix the errors above, then check again.' };
      if (!check.ok) return { deployed: false, reason: 'Static checks failed, so nothing was deployed.', storage, errors: check.errors.map(issueLine), warnings: check.warnings.map(issueLine), next: 'Fix the errors, then call deploy_preview again.' };
      const busy = await c.env.DB.prepare("SELECT n FROM versions WHERE project_id = ? AND status IN ('queued','deploying','verifying') AND created_at > ?").bind(p.id, now() - 10 * 60000).first<{ n: number }>();
      if (busy) throw new AppError(409, `Version ${busy.n} is still being deployed.`, 'busy', `Call list_versions {project, version: ${busy.n}} and wait for it to finish first.`);
      const v = await snapshot(c.env, p, check.manifest, String(a.note || ''));
      await logEvent(c.env, p.id, 'preview_requested', String(a.note || ''), v.n, c.client);
      await enqueue(c.env, { kind: 'preview', pid: p.id, n: v.n, origin: c.origin, actor: c.client });
      const done = await waitVersion(c, p.id, v.n, DEPLOY_WAIT_MS);
      return { deployed: true, storage, warnings: check.warnings.map(issueLine), ...(await versionReport(c, p, v.n, done)) };
    },
  },
  {
    name: 'list_versions', title: 'List versions or read one report',
    description: 'Without version: lists the project\'s versions, newest first, with status, the one-line summary, the checks that failed, whether each can be published, and which is live and which is on preview. With version: returns that version\'s full verification report (each check with its detail and hint, uncaught errors, missing files, load time, frame rate, screenshot), waiting up to 40 seconds if it is still being checked. This is how to read any past version\'s report.',
    inputSchema: obj({ project: PROJECT, version: { type: 'integer', description: 'Optional. A version number to read in full.' } }, ['project']), annotations: { readOnlyHint: true },
    run: async (a, c) => {
      const p = await ownedProject(c.env, c.user, a.project), s = await getSettings(c.env);
      if (a.version) return versionReport(c, p, Number(a.version), await waitVersion(c, p.id, Number(a.version), 40000));
      const rows = await c.env.DB.prepare('SELECT * FROM versions WHERE project_id = ? ORDER BY n DESC LIMIT 50').bind(p.id).all<any>();
      const versions = rows.results.map((v) => ({ version: v.n, note: v.note, status: v.status, summary: v.stage || parseJson<{ summary?: string }>(v.report, {}).summary || '', ...failedChecks(v), can_publish: versionEligible(v, s.verify_browser_required).ok && currentChecks(v, s).ok, created_at: new Date(v.created_at).toISOString(), live: v.n === p.live_version && p.status === 'live' }));
      const failed = versions.find((v) => v.status === 'failed');
      return { live_version: p.live_version, preview_version: p.preview_version, status: p.status, versions, next: failed ? `Call list_versions {project, version: ${failed.version}} for the full report of a version (every check with its detail and hint).` : 'Call list_versions {project, version} for the full report of one version.' };
    },
  },
  {
    name: 'debug_preview', title: 'Open, play and screenshot the preview in a browser',
    description: `A real browser on the game's current preview that you drive step by step, to see what the game looks like and reproduce a bug: take screenshots, click, tap, drag, press and hold keys, type, wait, and read the game's state. action "open" starts a browser on the preview (deploy_preview first) and returns a screenshot; "act" runs steps in it and returns screenshots; "screenshot" takes one; "close" ends it. Every answer includes state: whether the game is ready, frames drawn, uncaught errors and console errors the SDK saw, missing files, and what the game's GCP.test.onState(fn) returns. The game runs as a throwaway test player (empty save, never the creator's data). One browser per account at a time; it closes after 3 idle minutes and at most a few minutes after opening. The browser has no GPU: heavy 3D runs slowly and WebGPU is not available, so judge layout, UI and logic here, not frame rate. Also read creator_feedback: the creator may already have marked what is wrong.`,
    inputSchema: obj({
      project: PROJECT,
      action: { type: 'string', enum: ['open', 'act', 'screenshot', 'close'], description: 'open: a new browser on the preview (replaces your open one). act: run steps. screenshot: just a picture. close: end the session.' },
      steps: STEP_SCHEMA,
      viewport: { description: `open only. A preset (${Object.keys(VIEWPORTS).join(', ')}; default desktop, ${VIEWPORTS.desktop.width} × ${VIEWPORTS.desktop.height}, the verifier's size; the phone and tablet presets have touch) or {width, height, touch}.`, type: ['string', 'object'] },
      autostart: { type: 'boolean', description: 'open only. Open with ?gcp_autostart=1, so GCP.test.onAutostart skips menus as in verification. Default false: the game starts as a player sees it.' },
      session: { type: 'string', description: 'Optional: the session id from open (your latest one is used otherwise).' },
    }, ['project', 'action']),
    run: async (a, c) => {
      const p = await ownedProject(c.env, c.user, a.project);
      if (a.action === 'close') return closeDebug(c.env, c.user, a.session ? String(a.session) : undefined);
      if (a.action === 'open') {
        const r = await openDebug(c.env, c.origin, c.user, p, { viewport: a.viewport, autostart: a.autostart === true, steps: a.steps }, c.client);
        return debugAnswer(r, 'Look at the screenshot, then call debug_preview {action: "act", steps: [...]} to play. Close the session when you are done.');
      }
      if (a.steps !== undefined && a.action === 'screenshot') throw bad('screenshot takes no steps.', 'Use action "act" to run steps; it returns a screenshot after them.');
      const r = await actDebug(c.env, c.user, p, a.session ? String(a.session) : undefined, a.action === 'act' ? (a.steps ?? []) : []);
      return debugAnswer(r, 'Fix what you found, upload, deploy_preview, then open a new session on the new version to check it.');
    },
  },
  {
    name: 'creator_feedback', title: 'Read the creator\'s annotated screenshots',
    description: `The creator's feedback queue: while playing the preview in the console, the creator takes screenshots, circles or points at what is wrong, writes a note and adds it to this queue. Returns the oldest items (up to ${FEEDBACK_LIMITS.read_max}), each with its note, its marks numbered as drawn on the picture (in picture pixels, plus [game (x, y)]: the same spot in the game's CSS pixels, which debug_preview steps take, when the picture shows the whole game), how the picture was taken (captured_from), the preview version, the screen size, errors the game had and what GCP.test.onState(fn) returned, followed by the annotated pictures as images. An item can also carry pictures the creator attached themselves (attached_pictures: design mockups, references, photos, each with its own numbered marks); they show what the creator wants, not what the game shows, and come right after that item's screenshot. Each item is taken off the queue as it is returned, so act on it: the next call returns the next items. If an answer never reached you, recent: true returns the items read in the last day again. Large pictures may hold some items back for the next call (still_waiting says so). peek: true lists what is waiting (notes only, no pictures) without removing anything. Check it at the start of a session and after each deploy_preview (deploy_preview and list_versions say when items are waiting). Only the game's creator's own account can read it.`,
    inputSchema: obj({ project: PROJECT, limit: { type: 'integer', description: `Items to take, 1 to ${FEEDBACK_LIMITS.read_max} (default 3).` }, peek: { type: 'boolean', description: 'List what is waiting without taking anything (no pictures).' }, recent: { type: 'boolean', description: 'Return the items already read in the last 24 hours again, newest first, with their pictures (nothing is taken).' } }, ['project']),
    run: async (a, c) => {
      const p = await feedbackProject(c.env, c.user, a.project);
      const recent = a.recent === true && a.peek !== true;
      const r = await takeFeedback(c.env, p, Number(a.limit ?? 3), a.peek === true, c.client, recent);
      const data = {
        ...(a.peek ? { waiting: r.pending } : recent ? { read_again: r.items.length, still_waiting: r.pending } : { taken: r.items.length, still_waiting: r.pending }),
        items: r.items,
        next: recent ? (r.items.length ? 'These were read before, within the last day. Nothing changed on the queue.' : 'Nothing was read in the last day.')
          : !r.items.length ? 'Nothing waiting. The creator adds items from the preview in the console (Capture feedback).'
          : a.peek ? 'Call creator_feedback without peek to take them with their pictures.'
            : `These items are now off the queue. Fix what they point at, deploy_preview, and tell the creator what you changed for each.${r.pending ? ` ${r.pending} more waiting: call creator_feedback again.` : ''} debug_preview lets you reproduce what a picture shows.`,
      };
      return r.images.length ? new WithImages(data, r.images) : data;
    },
  },
  {
    name: 'publish', title: 'Publish a verified version',
    description: 'Makes a verified version live in the marketplace at the game\'s public address. Only versions that passed verification can be published, and the account needs a creator license (get_started shows it). Omit version to publish the newest verified one. Every platform requirement is checked on the server first (verification against today\'s checks, unchanged files, store metadata, storage, the build skill when shared, originality and content, license and account); a refusal lists every rule that fails with what to do, and dry_run: true checks without publishing. open_implementation sets whether other developers\' agents may learn how the game is built (never its code) and whether its build skill is in the Creator Store; leave it out to keep the current choice, and ask the user before turning it on. While it is on, every new version needs its build skill written first (build_skill {action: "write", version}), so the skill always matches the live game.',
    inputSchema: obj({ project: PROJECT, version: { type: 'integer', description: 'Version to make live. Default: newest verified.' }, open_implementation: { type: 'boolean', description: 'Optional. true shares how the game is built with other agents (no code); false keeps it private. Omitted: unchanged (off for a new game).' }, dry_run: { type: 'boolean', description: 'Optional. true checks every platform requirement for this version and returns each rule with its status and what to do, without publishing anything.' } }, ['project']),
    run: (a, c) => publishVersion(a, c, false),
  },
  {
    name: 'rollback', title: 'Roll back to an earlier version',
    description: 'Makes an earlier version that was live before live again. list_versions shows which ones can be published.',
    inputSchema: obj({ project: PROJECT, version: { type: 'integer' } }, ['project', 'version']),
    run: async (a, c) => { if (a.version === undefined || a.version === null) throw bad('version is required.', 'Call list_versions to pick the version to go back to.'); return publishVersion(a, c, true); },
  },
  {
    name: 'unpublish', title: 'Take a game offline',
    description: 'Takes the live game out of the marketplace and removes its live deployment. Versions and the preview stay; publish puts it back.',
    inputSchema: obj({ project: PROJECT }, ['project']), annotations: { destructiveHint: true },
    run: async (a, c) => { const p = await ownedProject(c.env, c.user, a.project); if (p.status !== 'live') throw bad('This game is not live.'); await takeOffline(c.env, p, c.client); return { ok: true, status: 'offline' }; },
  },
  {
    name: 'game_data', title: 'Game database: shared data, saves and leaderboards',
    description: 'Manages what the platform database holds for one game, in its preview or live environment (they are kept apart). Shared data is game-wide JSON every player reads with GCP.shared.get(key): use set to seed levels, configuration or a message of the day without server code. Player saves (GCP.save) and stats (GCP.playerStats) are private to each player and game; summary counts and aggregates them (players, sessions, play time, each stat\'s sum, average, min and max) without showing any one player\'s data. Leaderboards are what GCP.leaderboard.submit wrote. Actions: summary, list (shared keys, optional prefix), get, set, delete (one shared key), leaderboard (top rows of a board), clear_leaderboard. Writes take effect for players at once.',
    inputSchema: obj({
      project: PROJECT,
      action: { type: 'string', enum: ['summary', 'list', 'get', 'set', 'delete', 'leaderboard', 'clear_leaderboard'] },
      env: { type: 'string', enum: ['preview', 'live'], description: 'Default live. Previews have their own separate data.' },
      key: { type: 'string', description: 'Shared data key (1 to 120 characters), for get, set and delete.' },
      value: { description: 'Any JSON value, for set. 256 KB at most.' },
      prefix: { type: 'string', description: 'Only keys starting with this, for list.' },
      board: { type: 'string', description: 'Leaderboard name, for leaderboard and clear_leaderboard. Default "default".' },
      order: { type: 'string', enum: ['desc', 'asc'], description: 'For leaderboard: desc (highest first, default) or asc (lowest first, for times).' },
      limit: { type: 'integer', description: 'Rows for leaderboard, 1 to 100. Default 20.' },
    }, ['project', 'action']), annotations: { destructiveHint: true },
    run: async (a, c) => {
      const p = await ownedProject(c.env, c.user, a.project), db = c.env.DB, env = envOf(a.env);
      const scope = `${p.id}${env === 'preview' ? ':preview' : ''}`, key = String(a.key ?? ''), board = String(a.board || 'default').slice(0, 40);
      const needKey = () => { if (!key || key.length > 120) throw bad('key must be a string of 1 to 120 characters.'); };
      switch (a.action) {
        case 'summary': {
          const [shared, saves, boards, records, stats] = await Promise.all([
            db.prepare("SELECT COUNT(*) AS keys, COALESCE(SUM(LENGTH(v)), 0) AS bytes FROM saves WHERE project_id = ? AND user_id = ''").bind(scope).first<{ keys: number; bytes: number }>(),
            db.prepare("SELECT COUNT(DISTINCT user_id) AS players, COUNT(*) AS keys, COALESCE(SUM(LENGTH(v)), 0) AS bytes FROM saves WHERE project_id = ? AND user_id != '' AND user_id NOT LIKE 'verify:%'").bind(scope).first<{ players: number; keys: number; bytes: number }>(),
            db.prepare('SELECT board, COUNT(*) AS entries, MAX(updated_at) AS last_at FROM scores WHERE project_id = ? GROUP BY board ORDER BY board').bind(scope).all<{ board: string; entries: number; last_at: number }>(),
            db.prepare("SELECT COUNT(*) AS players, COALESCE(SUM(sessions), 0) AS sessions, COALESCE(SUM(seconds), 0) AS seconds FROM player_games WHERE project_id = ? AND user_id NOT LIKE 'verify:%'").bind(scope).first<{ players: number; sessions: number; seconds: number }>(),
            db.prepare("SELECT name, COUNT(*) AS players, SUM(value) AS sum, AVG(value) AS avg, MIN(value) AS min, MAX(value) AS max FROM player_stats WHERE project_id = ? AND user_id NOT LIKE 'verify:%' GROUP BY name ORDER BY players DESC, name LIMIT 64").bind(scope).all<{ name: string; players: number; sum: number; avg: number; min: number; max: number }>(),
          ]);
          return {
            env, shared_data: shared, player_saves: saves, leaderboards: boards.results.map((b) => ({ board: b.board, entries: b.entries, last_submit: new Date(b.last_at).toISOString() })),
            player_records: records, player_stats: stats.results,
            note: 'Player saves, stats and records are counted and aggregated here, never shown per player.',
            limits: { value_bytes: 256 * 1024, save_bytes_per_player: 2 * 1024 * 1024, save_bytes_per_guest: 512 * 1024, save_bytes_per_player_all_games: 20 * 1024 * 1024, save_keys_per_player: 64, stats_per_player: 64, shared_and_server_data: '10,000 keys; 50 MB live, 10 MB preview' },
          };
        }
        case 'list': {
          const rows = await db.prepare("SELECT k, LENGTH(v) AS bytes, updated_at FROM saves WHERE project_id = ? AND user_id = '' AND k LIKE ? ESCAPE '\\' ORDER BY k LIMIT 500").bind(scope, String(a.prefix || '').replace(/[\\%_]/g, '\\$&') + '%').all<{ k: string; bytes: number; updated_at: number }>();
          return { env, keys: rows.results.map((r) => ({ key: r.k, bytes: r.bytes, updated_at: new Date(r.updated_at).toISOString() })) };
        }
        case 'get': {
          needKey();
          const r = await db.prepare("SELECT v FROM saves WHERE project_id = ? AND user_id = '' AND k = ?").bind(scope, key).first<{ v: string }>();
          return { env, key, value: r ? JSON.parse(r.v) : null, exists: !!r };
        }
        case 'set': {
          needKey();
          if (a.value === undefined) throw bad('value is required for set (any JSON value).');
          const v = JSON.stringify(a.value);
          // the same store and allowance as the game's server code (keys and MB per environment), so shared data has a bound
          await assertGameDataRoom(c.env, Number((await getSettings(c.env)).game_data_max_db_gb) || 0);
          try { await serverStoreOp(db, p.id, env, { op: 'set', key, value: a.value, player: '' }, now()); }
          catch (e) { if (e instanceof DataError) throw bad(e.message); throw e; }
          await logEvent(c.env, p.id, 'data_set', `${env}: ${key}`, null, c.client);
          return { ok: true, env, key, bytes: new TextEncoder().encode(v).byteLength, read_it_with: `await GCP.shared.get(${JSON.stringify(key)})` };
        }
        case 'delete': {
          needKey();
          const r = await db.prepare("DELETE FROM saves WHERE project_id = ? AND user_id = '' AND k = ?").bind(scope, key).run();
          if (r.meta.changes) await logEvent(c.env, p.id, 'data_deleted', `${env}: ${key}`, null, c.client);
          return { ok: true, env, key, deleted: (r.meta.changes || 0) > 0 };
        }
        case 'leaderboard': {
          const fixed = await db.prepare('SELECT asc FROM boards WHERE project_id = ? AND board = ?').bind(scope, board).first<{ asc: number }>();
          const asc = fixed ? !!fixed.asc : a.order === 'asc';
          const rows = await db.prepare(`SELECT name, score, updated_at FROM scores WHERE project_id = ? AND board = ? ORDER BY score ${asc ? 'ASC' : 'DESC'} LIMIT ?`).bind(scope, board, clamp(Number(a.limit) || 20, 1, 100)).all<{ name: string; score: number; updated_at: number }>();
          return { env, board, order: asc ? 'asc' : 'desc', rows: rows.results.map((r, i) => ({ rank: i + 1, name: r.name, score: r.score, at: new Date(r.updated_at).toISOString() })) };
        }
        case 'clear_leaderboard': {
          // clearing a board also frees its order, so the next first submit sets it again
          const [r] = await db.batch([db.prepare('DELETE FROM scores WHERE project_id = ? AND board = ?').bind(scope, board), db.prepare('DELETE FROM boards WHERE project_id = ? AND board = ?').bind(scope, board)]);
          await logEvent(c.env, p.id, 'leaderboard_cleared', `${env}: ${board}`, null, c.client);
          return { ok: true, env, board, removed: r.meta.changes || 0 };
        }
        default: throw bad('action must be summary, list, get, set, delete, leaderboard or clear_leaderboard.');
      }
    },
  },
  {
    name: 'game_room', title: 'Multiplayer room: inspect or reset',
    description: 'Looks inside one of the game\'s realtime multiplayer rooms, the ones players join with GCP.room(name): who is connected, who is the host, and the world snapshot the host stored. reset clears the snapshot (with kick: true it also disconnects everyone, who can rejoin at once); use it when a room is stuck on a bad state. Rooms are per environment and per code; an empty room keeps nothing. get_started {topic: "multiplayer"} explains the room model.',
    inputSchema: obj({
      project: PROJECT,
      room: { type: 'string', description: 'The room name the game passed to GCP.room(name). Default "lobby".' },
      env: { type: 'string', enum: ['preview', 'live'], description: 'Default live.' },
      action: { type: 'string', enum: ['inspect', 'reset'], description: 'Default inspect.' },
      kick: { type: 'boolean', description: 'For reset: also disconnect everyone in the room.' },
    }, ['project']), annotations: { destructiveHint: true },
    run: async (a, c) => {
      const p = await ownedProject(c.env, c.user, a.project), env = envOf(a.env), code = String(a.room || 'lobby').slice(0, 40);
      if (a.action !== undefined && a.action !== 'inspect' && a.action !== 'reset') throw bad('action must be "inspect" or "reset".');
      const rooms = c.env.ROOMS as unknown as DurableObjectNamespace<GameRoom>, stub = rooms.get(rooms.idFromName(`${p.id}:${env}:${code}`));
      if (a.action === 'reset') {
        const r = await stub.reset(!!a.kick);
        await logEvent(c.env, p.id, 'room_reset', `${env}: ${code}${a.kick ? ' (kicked)' : ''}`, null, c.client);
        return { env, room: code, ...r };
      }
      const r = await stub.inspect(), s = await getSettings(c.env);
      const bytes = r.state_json ? r.state_json.length : 0;
      const state = !r.state_json ? null : bytes > 20000 ? `${r.state_json.slice(0, 20000)} …[truncated, ${bytes} bytes]` : JSON.parse(r.state_json);
      return { env, room: code, players: r.players, host: r.host, state, state_bytes: bytes, limits: { players_per_room: s.room_max_peers, message_bytes: 64 * 1024, state_bytes: 256 * 1024 }, ...(r.players.length ? {} : { note: 'Nobody is in this room now. Rooms are created when the first player joins and forget everything when the last one leaves.' }) };
    },
  },
  {
    name: 'preview_bots', title: 'Test an online game with bot players',
    description: 'Puts bot players into the game\'s preview to test online play over the platform\'s real network path. Each bot is a remote client like a player\'s page: it has a play session of its own (preview only, never rated), waits in the real matchmaker (GCP.match.find) or joins the real room (GCP.room), and plays the match over a WebSocket to the game\'s own Worker, from the region you pick, with an optional last mile of added latency, jitter and packet loss. Bots play with the game\'s own server/bot.js (export default { thinkMs, think(view, me, ctx) -> input } or actions(view, me, ctx) -> [inputs] for a generic random bot; room(ctx) -> messages for rooms), run in a sandbox with no network; without it they join and stay connected but send nothing. '
      + 'action start: target "follow" (default) sends the bots wherever the creator searches or opens a room in their preview; "queue" puts them in a public queue (queue, players, min, teams, mode as the game passes them to GCP.match.find, so they meet the players searching the same); "code" into a private lobby; "room" into a room. Bots alone can fill a match: with target queue and bots >= the queue\'s min the match starts without anyone else, so an agent can run an online match end to end without a browser. '
      + 'status: per bot its phase, round trip (last, median, 95th percentile), snapshots per second and their spacing and jitter, the longest gap, unacknowledged inputs, traffic, reconnects, errors (the match\'s and server/bot.js\'s), plus the fleet\'s log. act: drop (the connection drops and comes back after ms with the same ticket, like the SDK\'s reconnect), reload (comes back after ms like a reloaded page, through GCP.match.rejoin\'s path), spike (extra ms of delay for ms), outage (nothing gets through for ms), net (a new network profile), leave (for good), rejoin; bot "all" or one bot\'s id or name. stop ends the fleet and its sessions. '
      + 'Limits: a fleet stops by itself after its minutes; bots per fleet, fleets at once and bot-minutes per day are capped (status shows them).',
    inputSchema: obj({
      project: PROJECT,
      action: { type: 'string', enum: ['options', 'start', 'status', 'act', 'stop'], description: 'Default status.' },
      bots: { type: 'integer', description: 'start: how many bots (default 3).' },
      target: { type: 'string', enum: ['follow', 'queue', 'code', 'room'], description: 'start: where the bots go. Default follow.' },
      queue: { type: 'string', description: 'start with target queue: the queue name the game uses (default "default").' },
      players: { type: 'integer', description: 'start with target queue or code: the match size the game asks for (GCP.match.find players).' },
      min: { type: 'integer', description: 'start with target queue: the game\'s min.' },
      teams: { type: 'integer', description: 'start with target queue: the game\'s teams.' },
      mode: { type: 'string', description: 'start with target queue: the game\'s mode.' },
      code: { type: 'string', description: 'start with target code: the private lobby code.' },
      room: { type: 'string', description: 'start with target room: the room code.' },
      region: { type: 'string', enum: ['auto', 'wnam', 'enam', 'sam', 'weur', 'eeur', 'apac', 'oc', 'afr', 'me'], description: 'start: where the bots connect from. Default auto.' },
      net: { description: 'start: the last mile every bot gets: a profile (none, fiber, wifi, 4g, 3g, poor, far) or { latency, jitter, loss } (one-way ms, ms, percent). act net: the new one.' },
      nets: { type: 'array', description: 'start: one network per bot (profile names or objects), overriding net for those bots.' },
      names: { type: 'array', items: { type: 'string' }, description: 'start: display names for the bots.' },
      skill: { type: 'number', description: 'start: 0 to 1, handed to server/bot.js as ctx.skill (default 1).' },
      minutes: { type: 'integer', description: 'start: how long the fleet may run before it stops by itself.' },
      bot: { type: 'string', description: 'act: a bot\'s id or name, or "all" (default).' },
      what: { type: 'string', enum: ['drop', 'reload', 'spike', 'outage', 'net', 'leave', 'rejoin'], description: 'act: what to do.' },
      ms: { type: 'integer', description: 'act: how long (drop, reload: until the bot comes back; spike, outage: how long it lasts). Default 5000.' },
      extra: { type: 'integer', description: 'act spike: the extra delay in ms (default 400).' },
    }, ['project']), annotations: { destructiveHint: false },
    run: async (a, c) => {
      const action = a.action || 'status';
      if (action === 'options') { const p = await ownedProject(c.env, c.user, a.project); return botOptions(c.env, p, c.user); }
      if (action === 'start') return startBots(c.env, c.origin, c.user, a.project, a);
      if (action === 'act') return actBots(c.env, c.user, a.project, { bot: a.bot, action: a.what, ms: a.ms, extra: a.extra, net: a.net });
      if (action === 'stop') return stopBots(c.env, c.user, a.project);
      if (action !== 'status') throw bad('action must be options, start, status, act or stop.');
      return botStatus(c.env, c.user, a.project);
    },
  },
  {
    name: 'get_stats', title: 'Players online, analytics and marketplace numbers',
    description: 'Returns how the game is doing. now: players online at this moment (live and preview) and players in multiplayer rooms. analytics, over the last days (default 30, at most 90): sessions, unique, new and returning players, play time with average and median session length, session-length spread, players per day and per hour for the last 24 hours, a breakdown by version, device, browser and operating system. Every play number is measured by the platform itself (it starts each session, and the page that shows the game checks in every 30 seconds), never taken from the game; what the game reports about itself (whether it reached GCP.ready, the errors it caught) is under analytics.reported_by_game and in runtime_errors, apart from the rest. Also plays, ratings and recent reviews, and sales. Pass only_now: true for just the live counts, which is cheap enough to poll.',
    inputSchema: obj({ project: PROJECT, days: { type: 'integer', description: 'Window for analytics, 1 to 90 days. Default 30.' }, only_now: { type: 'boolean', description: 'Return only players online now and room occupancy.' } }, ['project']), annotations: { readOnlyHint: true },
    run: async (a, c) => {
      if (a.only_now) { const p = await ownedProject(c.env, c.user, a.project); return { status: p.status, ...(await onlineNow(c.env, p.id)) }; }
      const p = await ownedProject(c.env, c.user, a.project), db = c.env.DB;
      const [daily, errors, reviews, sales] = await Promise.all([
        db.prepare('SELECT day, sessions, plays, seconds FROM game_daily WHERE project_id = ? AND day >= ? ORDER BY day').bind(p.id, addDays(dayOf(now()), -13)).all<any>(),
        db.prepare('SELECT version, env, message, count FROM client_errors WHERE project_id = ? ORDER BY last_at DESC LIMIT 15').bind(p.id).all(),
        db.prepare('SELECT rating, body FROM reviews WHERE project_id = ? AND hidden = 0 ORDER BY updated_at DESC LIMIT 10').bind(p.id).all(),
        db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(net_cents), 0) AS net FROM purchases WHERE project_id = ? AND status = 'paid'").bind(p.id).first<{ n: number; net: number }>(),
      ]);
      return {
        status: p.status, live_version: p.live_version, plays: p.plays, minutes_played: Math.round(p.seconds / 60), rating: p.rating_count ? +(p.rating_sum / p.rating_count).toFixed(2) : null, ratings: p.rating_count,
        price: p.price_cents ? usd(p.price_cents) : 'free', sales: sales?.n || 0, creator_earnings: usd(sales?.net || 0),
        free_trial: { setting: trialText(p, await getSettings(c.env)), ...(await trialStats(c.env, p.id)) },   // players who started the trial, and how many then bought
        last_14_days: daily.results.map((d) => ({ day: d.day, sessions: d.sessions, plays: d.plays, minutes: Math.round(d.seconds / 60) })),
        runtime_errors: errors.results,   // reported by the game, not observed by the platform
        recent_reviews: reviews.results,
        analytics: await gameAnalytics(c.env, p.id, Number(a.days) || 30),
        console_page: `${c.origin}/console/p/${p.id}/analytics`,
      };
    },
  },
  {
    name: 'build_skill', title: 'Write this game\'s build skill',
    description: `The build skill is an agent skill (a SKILL.md) about how this game is built, written by you, its development agent, so other developers' agents can build a similar game. It is what the game shares in the Creator Store when Open Implementation is on, free or for a price the user sets. Write it from what you know of the game: architecture, rendering and art, the loop and feel, controls and devices, content and progression, platform services, performance, testing and release, and pitfalls. ${NO_CODE} A skill is written for one version and the store always shows the one for the live version: before each release, call get, revise the skill for what changed, and write it for the version you are about to publish. While sharing is on, publish refuses a version without one. Actions: get (the current skill, whether it matches, and the outline with what to cover), write (content in Markdown, a one-line description; version defaults to the newest deployed version).`,
    inputSchema: obj({
      project: PROJECT,
      action: { type: 'string', enum: ['get', 'write'] },
      version: { type: 'integer', description: 'The game version the skill describes. Default: the newest deployed version (the one you are about to publish).' },
      description: { type: 'string', description: 'write: one line, what the skill helps an agent build (at most 300 characters).' },
      content: { type: 'string', description: 'write: the skill in Markdown, organised under level-two headings (##), 600 to 60000 characters, no code. The platform adds the front matter, the title and the facts it measured.' },
    }, ['project', 'action']),
    run: async (a, c) => {
      const p = await ownedProject(c.env, c.user, a.project);
      const v = a.version === undefined || a.version === null ? undefined : Math.round(Number(a.version));
      if (a.action === 'get') return skillForAgent(c.env, c.origin, p, v);
      if (a.action !== 'write') throw bad('action must be get or write.');
      const r = await writeSkill(c.env, p, a, c.client);
      const q = await ownedProject(c.env, c.user, p.id);
      return {
        ok: true, ...r,
        matches_live_game: q.live_version === r.version,
        shared: !!q.open_implementation, store_page: `${c.origin}/creator-store/${q.slug}`,
        next: q.live_version === r.version ? 'The Creator Store now shows this skill for the live game.'
          : `Saved for version ${r.version}. It shows in the Creator Store once version ${r.version} is live: publish {project, version: ${r.version}}.`,
        ...(q.open_implementation ? {} : { not_shared: 'Open Implementation is off, so nothing is shared yet. Ask the user before turning it on (update_project {open_implementation: true}).' }),
      };
    },
  },
  {
    name: 'find_implementations', title: 'Find how other games were built',
    description: `Searches live games whose creators chose to share how they were built, and shows the patterns across the matches: which engines, rendering, input, audio, art approach, platform services and loop techniques games of that kind use. Use it before building a kind of game you have not built here, e.g. {query: "multiplayer racing"} or {tags: ["puzzle"], uses: ["touch"]}. Each match has a short summary; get_implementation {game} returns the full card. ${NEVER_SHARED}`,
    inputSchema: obj({
      query: { type: 'string', description: 'Words about the kind of game or technique, e.g. "3d platformer", "turn-based card game", "procedural audio".' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Only games with all of these marketplace tags.' },
      engine: { type: 'string', description: 'Only games built with this engine, e.g. "three.js", "Phaser", "Godot", "none".' },
      uses: { type: 'array', items: { type: 'string' }, description: 'Only games that use all of these, e.g. ["multiplayer rooms", "leaderboards", "touch", "WebGL"].' },
      limit: { type: 'integer', description: 'Games to return, 1 to 25. Default 10.' },
    }), annotations: { readOnlyHint: true },
    run: async (a, c) => findImplementations(c.env, c.origin, c.user, a),
  },
  {
    name: 'get_implementation', title: 'Read how one game was built',
    description: `Returns the implementation card of one live game whose creator shares it: engine and libraries, rendering and graphics techniques, input, audio, art approach, platform services (saves, leaderboards, rooms, server code), loop and performance techniques, code structure in numbers, the verified play-through, and a summary for building something similar. Your own games can always be read (marked as a preview when not shared). ${NEVER_SHARED}`,
    inputSchema: obj({ game: { type: 'string', description: 'The game slug from find_implementations or its marketplace address (/g/<slug>).' } }, ['game']), annotations: { readOnlyHint: true },
    run: async (a, c) => {
      const card = await implementationCard(c.env, c.origin, c.user, a.game);
      // the game's build skill: in full when it is free (or yours, or bought), otherwise where to get it
      const skill = await storeItem(c.env, c.origin, c.user, card.game.slug, false).catch(() => null);
      return { ...card, build_skill: !skill ? null : skill.locked
        ? { price: usd(skill.skill.price_cents), sections: skill.skill.sections, version: skill.skill.version, store_page: skill.skill.page, note: 'This build skill is sold. The user can buy it in the Creator Store; it then shows here in full.' }
        : { name: skill.skill.name, version: skill.skill.version, in_sync: skill.skill.in_sync, written_by: skill.skill.written_by_platform ? 'the platform (the game\'s agent has not written one yet)' : 'the game\'s development agent', skill_md: skill.skill_md, store_page: skill.skill.page, how_to_use: 'Save skill_md as SKILL.md in a folder named after the skill in your skills directory, or follow it directly.' } };
    },
  },
];

/** Unzips an uploaded archive into the workspace. */
export async function importZip(env: Env, user: User, projectId: string, zip: Uint8Array, clean: boolean) {
  const p = await ownedProject(env, user, projectId), s = await getSettings(env);
  // First read only the zip's directory (nothing is unpacked), so a zip that would not fit is refused before it fills memory.
  const sizes: Record<string, number> = {};
  try { unzipSync(zip, { filter: (f) => { sizes[f.name] = f.originalSize; return false; } }); } catch (e) { throw bad(`Not a readable zip file: ${(e as Error).message}`); }
  let names = Object.keys(sizes).filter((n) => !n.endsWith('/') && !n.startsWith('__MACOSX/'));
  // If everything sits in one top-level folder, strip it so index.html lands at the root.
  const tops = new Set(names.map((n) => n.split('/')[0]));
  const strip = tops.size === 1 && names.every((n) => n.includes('/')) && !names.includes('index.html') ? [...tops][0] + '/' : '';
  const target = new Map<string, string>(), skipped: string[] = [];
  for (const n of names) { const path = cleanPath(strip ? n.slice(strip.length) : n); if (path) target.set(n, path); else skipped.push(n); }
  const existing = await listFiles(env, p.id), incoming = new Set(target.values());
  // gcp.json holds what game_metadata and compatibility declared (requirements, languages, players, content…), which a local
  // build folder usually does not have: a clean upload keeps it rather than silently dropping those declarations.
  const keptManifest = clean && !incoming.has(MANIFEST) && existing.some((f) => f.path === MANIFEST);
  const removing = clean ? existing.filter((f) => !incoming.has(f.path) && f.path !== MANIFEST).map((f) => f.path) : [];
  assertFits(s, p, existing, [...target].map(([n, path]) => ({ path, size: sizes[n] })), removing);
  let entries: Record<string, Uint8Array>;
  try { entries = unzipSync(zip, { filter: (f) => target.has(f.name) }); } catch (e) { throw bad(`Not a readable zip file: ${(e as Error).message}`); }
  // A gcp.json in the zip replaces the workspace one, but build fields it leaves out are carried over from the workspace copy.
  let carried: string[] = [];
  const zipManifest = [...target].find(([, path]) => path === MANIFEST);
  if (zipManifest && existing.some((f) => f.path === MANIFEST)) {
    const before = await readFile(env, p.id, MANIFEST).then((f) => f.bytes).catch(() => null);
    const merged = before && mergeManifest(before, entries[zipManifest[0]]);
    if (merged) { entries[zipManifest[0]] = merged.bytes; carried = merged.carried; }
  }
  // the directory's sizes are the zip's own claim: check again with what actually came out
  assertFits(s, p, existing, [...target].map(([n, path]) => ({ path, size: entries[n]?.byteLength ?? 0 })), removing);
  const written: string[] = [];
  for (const [n, path] of target) { await putFile(env, p, path, entries[n], true); written.push(path); }
  const removed: string[] = [];
  for (const path of removing) { await deleteFile(env, p.id, path); removed.push(path); }
  const notes = [
    ...(keptManifest ? ['gcp.json is not in the zip, so the workspace copy was kept with its declared build metadata. To remove it, pass delete: ["gcp.json"] to upload_files.'] : []),
    ...(carried.length ? [`The zip's gcp.json leaves out ${carried.join(', ')}, so those were carried over from the workspace copy. To drop one, declare it again with game_metadata.`] : []),
  ];
  return { written, skipped, removed, ...(keptManifest ? { kept: [MANIFEST] } : {}), ...(carried.length ? { carried_over: carried } : {}), ...(notes.length ? { notes } : {}), storage: await storageLine(env, p), next: 'Call deploy_preview (dry_run: true runs only the static checks).' };
}

