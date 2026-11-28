// The tools an external agent uses to deploy, verify, publish and manage web games, and to use the platform's services.
// The platform hosts games; it does not tell agents how to make them. Engines, renderers, art and asset
// pipelines are the agent's business. Descriptions say when to call a tool and what comes next.
import { unzipSync } from 'fflate';
import { AppError, bad, forbidden, type Env, type User } from '../env';
import { balanceOf, freeSkillShared, splitSale, splitSkillSale } from '../earnings';
import { ENGLISH_FIRST, NO_CODE, SKILL_LANGS, setSkillPrice, skillForAgent, skillGate, storeItem, writeSkill } from '../skills';
import { enqueue } from '../pipeline';
import {
  assetText, checkProject, chooseTags, createProject, defaultImports, deleteFile, ensureCompat, ensureVersionMeta, getProject, getVersion, listFiles, logEvent, publicVersion,
  putFile, readFile, snapshot, updateProjectMeta, versionEligible, type Issue,
  listingForStandards,
} from '../projects';
import { takeOffline, trialStats } from '../routes/api';
import { trialMinutes } from '../trials';
import type { GameRoom } from '../room';
import { actBots, botOptions, botStatus, inviteBotFor, startBots, stopBots } from '../bots';
import { getSettings } from '../settings';
import { applySale, saleView } from '../sales';
// @ts-ignore plain JS module
import { PlaytestError, closePlaytest, listPlaytests, openPlaytest, results as playtestResults } from '../playtests.js';
import { WishError, announceIssues, isComingSoon, setComingSoon, wishCount } from '../wishlist.js';
import { licenseText, offersText } from '../license';
import { STORAGE_GUIDE, budgetOf, mb, overBudget, assertFits, requestStorage, storageLine, storageReport } from '../storage';
import { gameAnalytics, onlineNow } from '../analytics';
// @ts-ignore plain JS module
import { DataError, serverStoreOp } from '../player-data.js';
import { assertGameDataRoom } from '../db-guard';
import { RULES, currentChecks, explainFrozenMeta, gateError, gateText, gateView, recordGate, releaseGate, storedGate, type GateResult } from '../release-gate';
import { DISCOVERY, NOT_PROVIDED, openPerks, platformServices } from './services';
import { NEVER_SHARED, findImplementations, implementationCard, setOpenImplementation } from '../implementations';
import { THREE_VERSION } from '../generated/runtime-source';
import { BROWSERS, DEVICES, FEATURE_IDS, GRAPHICS, INPUTS, ORIENTATIONS, OSES, describeRequirements, parseRequirements, requirementsDrift, type Compat, type Requirements } from '../../web/src/compat';
import { ACCESSIBILITY, BUILD_FIELDS, CONTENT_CHOICES, MANIFEST, mergeManifest, GENRES, MODES, genresOf, matureOf, normGenre, parseAccessibility, parseContent, parsePlayers, type MetaIssue, type MetaRecord } from '../../web/src/gamemeta';
import { MAX_TAGS, MIN_TAGS, missingTags, missingToPublish, normalizeStoredTags, parseTags, TAG_GROUPS, tagGroup, tagNotes, TAGS, tagsOnly } from '../../web/src/tags';
import { baseListingLang, languageName, listingLangCode, parseLanguages, type Languages } from '../../web/src/languages';
import { isLang } from '../../web/src/i18n/langs';
import { listingCoverage } from '../listing';
import { OPERATOR } from '../../web/src/operator';
import type { Project, Version } from '../env';
import { addDays, clamp, cleanPath, dayOf, extOf, isText, now, parseJson, sha256, token as randomToken, unb64, usd } from '../util';
import { actDebug, closeDebug, openDebug, type DebugResult } from '../debug';
import { userById } from '../auth';
import { feedbackProject, pendingFeedback, takeFeedback } from '../feedback';
// @ts-ignore plain JS module
import { DEBUG_LIMITS, VIEWPORTS } from '../debug-core.js';
// @ts-ignore plain JS module
import { FEEDBACK_LIMITS } from '../feedback-rules.js';
import { assertCanCreateProject, isProjectAllowed, scopedProject } from './scope';
import { assertCan, autoResolve, branchWs, mainHead, target, withLock, type Target } from '../collab';
import type { Role } from '../collab-core';
import { COLLAB_TOOLS } from './collab-tools';

export interface ToolCtx { env: Env; user: User; origin: string; client: string; allowedProjects: string[] | null; tool?: string; roles?: Map<string, Role> }
/** A tool answer with pictures: the JSON part is sent as text, each image as an MCP image block after it. */
export class WithImages { constructor(public data: unknown, public images: { data: Uint8Array; type: string }[]) {} }
interface Tool {
  name: string; title: string; description: string; inputSchema: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean };
  run: (a: Record<string, any>, c: ToolCtx) => Promise<unknown>;
}

export { WEB_ONLY } from '../web-only.js';
import { WEB_ONLY } from '../web-only.js';
import { COVER, checkCover, coverRules } from '../cover-spec.js';
import { AREAS, STANDARDS, checkStandards, findingLine, renderStandards, standardById, standardsIndex } from '../standards.js';
import { SPLIT, deviceProblems } from '../platform-requirements.js';
import { storeStatus, storeText } from '../store-quality';
import { checkItem } from './schema';
import { checkBase, diffFiles, diffLine, isSame, textDiff, type BaseVerdict, type FileChange, type VersionLite } from '../version-sync';
import { checkoutVersion, parseSource, readSourceFile, sourceFiles, sourceName, versionOrThrow, workspaceLine, workspaceState, type Source } from '../version-store';
import { SCOPE, TESTING, toolMap } from './overview';
import { deleteProject } from '../project-delete';
import { publishDevlog } from '../devlog-news';
// @ts-ignore plain JS module
import { DevlogError, cleanPatchNotes, deleteDevlog, editDevlog, listDevlogs } from '../devlogs.js';
export const ENGINE_EXPORTS = 'Any engine with a web export works: export to Web / HTML5 / WebGL and upload the exported folder (Unity: set Compression Format to Disabled; Godot\'s Web export and Phaser, PlayCanvas, Babylon.js, Three.js or plain canvas games upload as they are). The export must call GCP.ready() once it is playable.';

/** The platform guides an agent can read: how the platform behaves, not how to make a game. */
export const PLATFORM_GUIDES: { topic: string; file: string; title: string; summary: string }[] = [
  { topic: 'contract', file: 'platform-contract', title: 'The platform contract', summary: 'The hard rules (including handing over the frame: all UI drawn in canvases, GCP.test.onCapture and GCP.test.onState), what the platform injects into the page, the SDK, exactly what verification checks, and the optional play-through hook. Read before the first deploy.' },
  { topic: 'metadata', file: 'game-metadata', title: 'Game metadata', summary: 'The specification behind every store page: each field, its allowed values, what is required to publish, how the age rating is worked out, what the platform detects and what players see. Read before the first publish.' },
  { topic: 'versions', file: 'troubleshooting', title: 'Versions and failed verification', summary: 'How previews, versions, publishing and rollback relate, each verification check, why it usually fails, and the fix.' },
  { topic: 'saves', file: 'saves', title: 'Player progress, saves, leaderboards and server code', summary: 'Each player\'s progress: cloud saves and stats per player and game, the play record the platform keeps, shared game data, leaderboards, and optional server code the platform runs in a sandbox of its own.' },
  { topic: 'multiplayer', file: 'multiplayer', title: 'Multiplayer rooms', summary: 'Realtime rooms on the platform, playing with friends (friend invites, GCP.friends, GCP.presence), the host-authoritative model, snapshots, host migration, turn-based games, and the two-player verification check.' },
  { topic: 'matches', file: 'matches', title: 'Server-run matches', summary: 'Competitive real-time games (shooters, fighting games, sports, racing): server/match.js runs the match at a fixed tick on the platform, with matchmaking by region and rating, private lobbies, client prediction, smooth playback and lag-compensated hit checks.' },
  { topic: 'testing', file: 'testing', title: 'Testing and feedback', summary: 'Every way to test a game here and hear back about it, in the order a build uses them: static checks, the real-browser verification (each check, the iPhone and iPad pass, your own play-through), reading reports, debug_preview (screenshots, PNG and zoom, viewports, steps, state), creator_feedback, test bots for online games, standards checks, the publish dry run, and analytics and player errors after release.' },
  { topic: 'bots', file: 'test-bots', title: 'Testing online games with bots', summary: 'The bot contract every online game follows: the platform\'s test bots connect, matchmake, enter rooms and accept invites like real players, and the game\'s server/bot.js does everything that needs its rules (hello, ready, picks, moves; think, room, invite hooks). Also following the creator, invites as friends in the preview, network profiles, drops and reloads, the numbers per bot, limits. Read before building or testing any multiplayer game.' },
  { topic: 'storage', file: 'storage', title: 'Game storage', summary: 'How much a game\'s files may add up to, how uploads, deploys and publishing enforce it, how to keep a game small (generate content from code, load large or optional content at run time from your own host with CORS, compress what ships), and how to ask for more. Read before adding large assets.' },
  { topic: 'touch', file: 'input', title: 'Phones, tablets and input', summary: 'What the platform does so every game plays on touch screens (on-screen controls from the game\'s keys, mouse from the finger, pointer lock, taps, pixel density), gcp.json "controls" and GCP.controls, and what makes touch controls of your own good.' },
  { topic: 'standards', file: 'standards', title: 'Game standards', summary: 'Everything a game or its agent provides, as the platform shows it: the cover and its crops, title, tagline, description and controls text with how the store renders them, what the store draws over the cover, what it does not take (trailers, icons, logos, achievements), the splash, the platform menu button, safe areas, on-screen controls, orientation, interface scale, quality, hooks, the friends picker and languages. Exact sizes, limits, dos and don\'ts, and what is checked. Read the entry before making the thing.' },
  { topic: 'services', file: 'services', title: 'Platform services', summary: 'Every service the platform gives games and agents (hosting, accounts, saves, stats, shared data, leaderboards, rooms, server code, display, verification, payments, analytics, agent access): how each works, how to reach it, its limits, and what the platform does not provide.' },
];
/** Template images an agent lays its work out on, served as MCP resources (gcp://templates/<name>) and on the web. */
export const TEMPLATES = [
  { name: 'cover', path: '/guides/cover-template.png', title: 'Cover template', description: 'The store cover at 1920x1080 with its safe area and every crop the store makes (home banner, 16:10, 16:7, small cards). PNG.' },
  { name: 'safe-area', path: '/guides/safe-area-template.png', title: 'Safe area template', description: 'A phone held sideways as the platform shows a game in fullscreen: the notch and home-indicator insets, the platform menu button, the tip and friend pop-ups, and the on-screen controls. PNG.' },
];
/** A guide path on the web ("/guides/input.md#phones") as the MCP call that opens it, so an agent never needs the web. */
export function guideCall(path: string): string {
  const m = String(path || '').match(/^\/guides\/([a-z0-9-]+)\.md(?:#([\w-]+))?$/);
  const g = m && PLATFORM_GUIDES.find((x) => x.file === m[1]);
  return g ? `get_started {topic: "${g.topic}"}${m![2] ? `, section "${m![2].replace(/-/g, ' ')}"` : ''}` : path;
}
export async function guideText(env: Env, origin: string, topic: string) {
  const t = String(topic || '').toLowerCase().trim();
  const g = PLATFORM_GUIDES.find((x) => x.topic === t || x.file === t);
  // the standards guide is rendered from the registry, so it is never out of step with what game_standards checks
  const text = g && (g.topic === 'standards' ? renderStandards(origin) : await assetText(env, `/guides/${g.file}.md`));
  return text ? { guide: g!, markdown: text.replaceAll('{{ORIGIN}}', origin).replaceAll('{{THREE}}', THREE_VERSION) } : null;
}

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });
/** The items of upload_files' files and edits, and the other names agents give their keys (read as the schema's names). */
export const UPLOAD_ITEMS = {
  files: obj({ path: { type: 'string', description: 'Relative path inside the bundle.' }, content: { type: 'string', description: 'The whole file as text (or base64 when encoding is "base64").' }, encoding: { type: 'string', enum: ['utf8', 'base64'], description: 'Default utf8.' } }, ['path', 'content']),
  edits: obj({ path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' }, replace_all: { type: 'boolean' } }, ['path', 'old_string', 'new_string']),
};
export const EDIT_ALIASES: Record<string, string> = { old: 'old_string', new: 'new_string', old_str: 'old_string', new_str: 'new_string', old_text: 'old_string', new_text: 'new_string', oldString: 'old_string', newString: 'new_string', oldText: 'old_string', newText: 'new_string', search: 'old_string', replace: 'new_string', find: 'old_string', file: 'path', file_path: 'path', replaceAll: 'replace_all' };
export const FILE_ALIASES: Record<string, string> = { file: 'path', file_path: 'path', name: 'path', text: 'content', data: 'content' };
const PROJECT = { type: 'string', description: 'Project id or slug (from list_projects or create_project).' };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// Unknown environments are refused, not quietly sent to live.
const envOf = (v: unknown): 'preview' | 'live' => { if (v === undefined || v === null || v === '') return 'live'; if (v === 'preview' || v === 'live') return v; throw bad('env must be "preview" or "live".'); };
// a message tagged REQUIRED (a platform requirement) or RECOMMENDATION (design advice) says so first, in place of the level
const TAGGED = /^(REQUIRED to publish|RECOMMENDATION) /;
const issueLine = (i: Issue) => `${TAGGED.exec(i.message)?.[1] ?? i.level.toUpperCase()}${i.file ? ` ${i.file}${i.line ? `:${i.line}` : ''}` : ''}: ${i.message.replace(TAGGED, '')}${i.frame ? `\n${i.frame}` : ''}${i.hint ? `\n  fix: ${i.hint}` : ''}`;
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
  const s = await getSettings(c.env), u = c.user, scoped = c.allowedProjects !== null;
  const bal = scoped ? null : await balanceOf(c.env, u.id);
  return {
    name: u.name, creator_license: !!u.creator,
    can_publish: !!u.creator || !s.creator_fee_required,
    license: u.creator ? licenseText(u) : `${licenseText(u) === 'none' ? 'Not purchased' : 'Expired (' + licenseText(u) + ')'}. Publishing and the console need ${offersText(s)}. Uploading, previewing and verifying are free. The account owner gets it at ${c.origin}/license`,
    console_url: `${c.origin}/console`,
    project_access: scoped
      ? { scope: 'selected', project_ids: c.allowedProjects, can_create_projects: false, note: 'This connection is limited to selected projects. Call list_projects to see them.' }
      : { scope: 'all', can_create_projects: true },
    ...(bal ? { earnings: { available: usd(bal.available), pending: usd(bal.pending), withdraw_minimum: usd(s.withdraw_min_cents) } } : {}),
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
  // platform requirement: playable on computers, tablets and phones (src/release-gate.ts, every_device)
  const dp = running ? [] : deviceProblems(parseJson<Record<string, unknown>>(v.manifest, {}));
  const verification = running ? 'running' : v.status === 'verified' ? 'passed' : v.status === 'failed' ? 'failed' : v.status;
  return {
    // the outcome first, in one word: "deployed" only says the files went out, never that the version works
    verification,
    ...(verification === 'failed' ? { verification_failed: `Version ${n} was deployed but failed verification, so it cannot be published. It stays on the preview address so debug_preview can show the failure; players never see a preview${p.status === 'live' && p.live_version ? `, and the live game stays on version ${p.live_version}` : ''}. report.checks says what failed and how to fix it.` } : {}),
    ...(running ? { not_finished: `Version ${n} is deployed and the browser check is still running (${v.status}). This is normal: it takes one to two minutes. Call list_versions {project, version: ${n}, wait_seconds: ${MAX_WAIT_S}}; it waits for the result. Do not deploy the same files again.` } : {}),
    ...rest, can_publish: el.ok, eligibility: el.reason, compatibility: compatSummary(compat), metadata: meta ? metaSummary(p, compat, meta).build : null,
    ...(meta && compat && true ? (() => { const m = missingToPublish(meta, compat.declared, JSON.parse(p.tags || '[]')); return m.length ? { metadata_missing: m, metadata_next: 'Publishing needs these. game_metadata {project} walks through each with allowed values and suggestions.' } : {}; })() : {}),
    ...(dp.length ? { platform_requirements_unmet: dp.map((d) => `[every_device] ${d.message} To fix: ${d.fix}`) } : {}),
    ...(cur.ok ? {} : { not_current: `Publishing this version would be refused: ${cur.problems.join('; ')}. deploy_preview again (retry_version: ${n} when it is the newest version) and publish the version that makes.` }),
    ...(last ? { last_release_check: { ok: last.ok, ruleset: last.ruleset, checked_at: new Date(last.checked_at).toISOString(), failed: last.failures.map((f) => `${f.id}: ${f.reason}`) } } : {}),
    preview_page: `${c.origin}/console/projects/${p.id}`,
    ...(s.creator_fee_required && !c.user.creator ? { preview_page_note: `The console, where a person plays the preview and leaves feedback, opens only with a creator license (${c.origin}/license). Without one, debug_preview is how to see the game.` } : {}),
    ...(await feedbackHint(c, p)),
    next: running ? `Still ${v.status} (${v.stage}); the deploy goes on without this call. Call list_versions {project, version: ${n}, wait_seconds: ${MAX_WAIT_S}} until it is done.`
      : !el.ok ? 'Fix every failed check in report.checks (each has a hint), upload the changed files, then deploy_preview again. get_started {topic: "versions"} explains each check.'
        : dp.length ? 'Verified, but publish refuses it: it misses a platform requirement (platform_requirements_unmet says what to fix). Fix it, then deploy_preview again.'
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
export const LIST_WAIT_MS = 40000;
/** The longest one call waits for a verification to finish (wait_seconds), for agents that would rather block than poll. */
// 55, not more: a call held open past about 60 seconds can be cut by the client or a proxy on the way (Haiku run 4 lost a
// wait_seconds: 150 call that way while the deploy itself finished), so a longer wait is many list_versions calls instead.
export const MAX_WAIT_S = 55;
export const waitMs = (sec: unknown, dflt: number) => sec === undefined || sec === null || !Number.isFinite(Number(sec)) ? dflt : clamp(Math.round(Number(sec)), 0, MAX_WAIT_S) * 1000;
const WAIT_SCHEMA = (dflt: number) => ({ type: 'integer', minimum: 0, maximum: MAX_WAIT_S, description: `Optional. How long this call waits for the browser check to finish before it answers (default ${dflt / 1000}, at most ${MAX_WAIT_S}; a larger value waits ${MAX_WAIT_S}, because a call held open longer can be cut off on the way). If the check is still running then, the answer says not_finished: call list_versions {project, version, wait_seconds: ${MAX_WAIT_S}} until it is done. 0 answers at once.` });
/** Said in the answer when a call asked to wait longer than one call safely can. */
const waitNote = (sec: unknown) => Number(sec) > MAX_WAIT_S ? { wait_note: `wait_seconds ${Number(sec)} was capped at ${MAX_WAIT_S}: a call held open longer can be cut off by the client or a proxy even though the work goes on. Poll list_versions {project, version, wait_seconds: ${MAX_WAIT_S}} instead.` } : {};

/**
 * Runs the deploy and browser check again on the newest version when it failed, keeping its number: the files are frozen, so
 * this only helps when the failure did not come from them (a heavy game at the edge of the software GPU's frame count, a
 * deploy that was slow to settle). Limited per version so it cannot stand in for fixing a real failure.
 */
/** Who deployed a version: the agent app's name, plus the machine label the deploy gave (deploy_preview by). */
const actorOf = (c: ToolCtx, by: unknown) => {
  const label = typeof by === 'string' ? by.replace(/[\u0000-\u001f]/g, '').trim().replace(/\s+/g, ' ').slice(0, 40) : '';
  return label ? `${c.client} (${label})` : c.client;
};

/** Versions after `base` on one line of history: main's (no branch) or one branch's. */
async function versionsAfter(env: Env, pid: string, base: number, branch: string | null = null): Promise<VersionLite[]> {
  return (await env.DB.prepare(`SELECT n, note, actor, created_at FROM versions WHERE project_id = ? AND n > ? AND ${branch ? 'branch = ?' : 'branch IS NULL'} ORDER BY n LIMIT 20`)
    .bind(...[pid, Number.isFinite(base) ? base : 0, ...(branch ? [branch] : [])]).all<VersionLite>()).results;
}

/** The project read again after a change, for an answer (access was checked by scopedProject). */
async function fresh(c: ToolCtx, id: string): Promise<Project> { return (await getProject(c.env, id))!; }
const roleIn = (c: ToolCtx, p: Project): Role => c.roles?.get(p.id) ?? 'owner';
/** The workspace a call names with its branch argument (main when omitted), checked for this caller's role. */
const wsTarget = (c: ToolCtx, p: Project, branch: unknown, mode: 'read' | 'write'): Promise<Target> => target(c.env, p, roleIn(c, p), branch, mode);
/** The newest version on a target's line of history and the version its workspace is based on. */
async function lineOf(c: ToolCtx, p: Project, t: Target) {
  const newest = t.branch ? (t.branch.head_version ?? 0) : await mainHead(c.env, p.id);
  const base = t.branch ? (t.branch.ws_base ?? t.branch.base_version) : (p.ws_base ?? (newest || null));
  return { ws: t.ws, base, newest };
}
const BRANCH_ARG = { type: 'string', description: 'Optional. The branch to work on (branches {action: "list"} lists them); omit for main. On a project shared with you, main is usually protected: work on a branch of your own and propose it with change_requests.' };

/** A deploy whose base_version is no longer the newest: nothing is deployed, and the answer says what came in between. */
async function baseConflict(c: ToolCtx, p: Project, base: number, verdict: BaseVerdict) {
  if (verdict.ok) throw new AppError(500, 'baseConflict called without a conflict');
  if (verdict.code === 'unknown_base') return { deployed: false, conflict: 'unknown_base', reason: verdict.message, newest_version: verdict.newest || null, next: 'Pass the version your changes start from: the one pull_version or checkout_version gave you (list_versions shows every version), or 0 before the first.' };
  const d = diffFiles(base ? await sourceFiles(c.env, p, { version: base }) : [], await sourceFiles(c.env, p, { version: verdict.newest }));
  return {
    deployed: false, conflict: 'newer_version', reason: verdict.message, your_base: base, newest_version: verdict.newest,
    newer_versions: verdict.newer.map((v) => ({ version: v.n, note: v.note || '', ...(v.actor ? { by: v.actor } : {}), ...(v.created_at ? { created_at: new Date(v.created_at).toISOString() } : {}) })),
    changed_since_your_base: { summary: diffLine(d), changed: d.changed.map((f) => f.path), added: d.added.map((f) => f.path), removed: d.removed.map((f) => f.path) },
    next: `Nothing was deployed. Merge first, as after a refused git push: diff_versions {project, from: ${base}, to: ${verdict.newest}} shows the line changes, pull_version {project, version: ${verdict.newest}} downloads them. Bring your changes onto version ${verdict.newest}, upload, and deploy_preview {project, base_version: ${verdict.newest}}. To deploy the workspace as it is and leave those changes out, call again with force: true.`,
  };
}

/** The most text pull_version puts in its answer (paths), for agents without a shell. */
export const PULL_INLINE = { files: 20, bytes: 256 * 1024 };
/** How much line diff diff_versions returns: each text file up to file_bytes is diffed, up to total_chars of diff in all. */
export const DIFF_LIMITS = { file_bytes: 512 * 1024, total_chars: 60_000, lines_per_file: 400 };

async function retryPreview(c: ToolCtx, p: Project, n: number, wait?: unknown) {
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
  const done = await waitVersion(c, p.id, n, waitMs(wait, DEPLOY_WAIT_MS));
  return { deployed: true, retried: true, retries_left: RETRY_LIMIT - (tries?.k ?? 0) - 1, storage: await storageLine(c.env, p), ...waitNote(wait), ...(await versionReport(c, p, n, done)) };
}

/** Tells the agent when its creator left feedback on the preview: annotated screenshots it should read and act on. */
async function feedbackHint(c: ToolCtx, p: Project): Promise<Record<string, string>> {
  if (p.owner_id !== c.user.id) return {};
  const n = await pendingFeedback(c.env, p.id);
  return n ? { creator_feedback: `${n} feedback item${n === 1 ? '' : 's'} from the creator ${n === 1 ? 'is' : 'are'} waiting: annotated screenshots of the preview with notes. Call creator_feedback {project: "${p.id}"} to read ${n === 1 ? 'it' : 'them'} and fix what they point at.` } : {};
}

const STEP_SCHEMA = {
  type: 'array', maxItems: DEBUG_LIMITS.steps,
  description: `Steps run in order, then a screenshot of the result is returned. Coordinates are CSS pixels of the viewport, (0, 0) top left; read them off the last full screenshot (same size as the viewport; in a zoomed or clipped one, CSS x = clip.x + image x ÷ zoom). Each step is an object with "do":
- {do: "click", x, y, button?: "left"|"right"|"middle", count?: 1|2}, {do: "double_click", x, y}, {do: "right_click", x, y}
- {do: "move", x, y} (hover), {do: "down", x?, y?, button?}, {do: "up", x?, y?, button?} (press and release separately, e.g. to hold the mouse)
- {do: "drag", x, y, to_x, to_y, ms?} (press, move over ms milliseconds, release; default 300)
- {do: "tap", x, y} (a touch tap; use a phone viewport for touch games)
- {do: "scroll", x?, y?, dx?, dy} (mouse wheel)
- {do: "key", key, hold_ms?} (press one key, or hold it hold_ms to move a character), {do: "key_down", key}, {do: "key_up", key}. key is one character or a name: Enter, Space, Escape, Tab, Backspace, ArrowLeft/Right/Up/Down, KeyW, ShiftLeft, F1…
- {do: "type", text} (types characters, up to ${DEBUG_LIMITS.text_chars})
- {do: "wait", ms} (up to 10000 per step; every wait, hold, drag and wait_for timeout in one call adds up to at most ${DEBUG_LIMITS.wait_ms / 1000} seconds, so a 60-second round takes three or more act calls in the same session)
- {do: "wait_for", until: "ready"|"text"|"frames", text?, frames?, timeout_ms?} (until GCP.ready(), until text appears on the page, or until the game drew that many more frames; stops the call if not met)
- {do: "screenshot", label?, clip?: {x, y, width, height}, format?: "jpeg"|"png", zoom?: 1|2|3|4} (an extra picture in the middle of the steps, or a close-up of one area; up to ${DEBUG_LIMITS.shots - 1} per call plus the final one. format "png" is lossless: exact colours and hard pixel edges, for checking art and palettes against a reference (default jpeg, smaller). zoom renders the region again at 2 to 4 image pixels per CSS pixel, sharp, not an enlarged 1× picture: for small sprites, icons and text. Picture size = clip (or the viewport) × zoom, at most ${DEBUG_LIMITS.shot_edge} px on its longest side, so at zoom 2 clip at most ${DEBUG_LIMITS.shot_edge / 2} px wide. A PNG over ${DEBUG_LIMITS.png_bytes / 1e6} MB comes back as a JPEG and its label says so. When the last step is a screenshot, it is the final picture and no extra one is added)
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
    screenshots: r.shots.map((s, i) => `image ${i + 1}: ${s.label}${s.type === 'image/png' ? ' (png)' : ''}${s.zoom ? ` (zoom ${s.zoom}: ${s.zoom} image pixels per CSS pixel)` : ''}${s.note ? ` (${s.note})` : ''}`),
    closes_in_seconds: left,
    next,
  }, r.shots.map((s) => ({ data: s.bytes, type: s.type || 'image/jpeg' })));
}

/** A declared requirements block as agents read it: orientation "any" (an older spelling) shows as "both". */
const bothNotAny = (r: unknown) => r && typeof r === 'object' ? { ...(r as Record<string, unknown>), ...((r as Record<string, unknown>).orientation === 'any' ? { orientation: 'both' } : {}) } : null;

/** The requirements block an agent writes: only what differs from nothing, so it reads like something a person would write. */
function requirementsBlock(r: Requirements): Record<string, unknown> {
  const out: Record<string, unknown> = { graphics: r.graphics };
  if (r.gpu === 'hardware') out.gpu = 'hardware';
  if (r.features.length) out.features = r.features;
  if (r.optional.length) out.optional = r.optional;
  out.input = r.input; out.devices = r.devices;
  out.orientation = r.orientation === 'any' ? 'both' : r.orientation;
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
  devices: { type: 'array', items: { type: 'string', enum: [...DEVICES] }, description: 'Devices the game plays on. Platform requirement: every game lists all three, desktop, tablet and mobile, and publish refuses a version that leaves one out.' },
  orientation: { type: 'string', enum: ['landscape', 'portrait', 'both', 'any'], description: 'Which way up the game is played: "landscape", "portrait" or "both" ("any" is the same as both). Recommended for every game (without it the platform assumes both). A single orientation gets the platform\'s rotate-your-device prompt on phones and tablets; "both" must lay out well in each. game_standards {action: "get", id: "orientation"} has the UI rules.' },
  memory_gb: { type: ['number', 'null'], description: 'Minimum device memory in GB, only for heavy games.' },
  browsers: { type: 'object', description: `Minimum major version per browser when known, e.g. {"safari": 17}. Browsers: ${BROWSERS.join(', ')}.`, additionalProperties: { type: 'integer' } },
  known_issues: { type: 'array', maxItems: 12, description: 'Where the game is known not to work well, shown to players there.', items: obj({ browser: { type: 'string', enum: [...BROWSERS] }, os: { type: 'string', enum: [...OSES] }, severity: { type: 'string', enum: ['broken', 'degraded'] }, note: { type: 'string', description: 'One sentence for players, under 200 characters.' } }, ['note']) },
  notes: { type: 'string', description: 'Anything else players should know, under 300 characters.' },
});

/**
 * Requirements declared in the workspace that version v does not carry (it was deployed before they were declared), as
 * the answer of publish, its dry run and the declare calls put it. Run 5: a game declared landscape after its last deploy
 * and was published with that version, so the store page said both orientations. Empty when nothing differs.
 */
async function declaredNotInVersion(c: ToolCtx, p: Project, v: Version | null): Promise<Record<string, unknown>> {
  if (!v) return {};
  try {
    const raw = (await workspaceManifest(c, p.id)).requirements;
    if (!raw || typeof raw !== 'object') return {};
    const drift = requirementsDrift(parseRequirements(raw).value, (await ensureVersionMeta(c.env, v)).compat.requirements);
    if (!drift.length) return {};
    return { not_in_this_version: {
      fields: drift,
      note: `gcp.json in the workspace declares ${drift.map((d) => `${d.field} ${d.declared}`).join(', ')}, but version ${v.n} was deployed before that and carries ${drift.map((d) => `${d.field} ${d.version}`).join(', ')}. Build fields are frozen with a version, so publishing version ${v.n} shows its values on the store page (and the platform plays it that way). Call deploy_preview {project} to make a version that carries the declaration, then publish that version.`,
    } };
  } catch { return {}; }
}

/** The newest verified version, else the newest: the one publish takes when no version is named. */
async function newestVersion(c: ToolCtx, p: Project): Promise<Version | null> {
  const rows = await c.env.DB.prepare('SELECT * FROM versions WHERE project_id = ? ORDER BY n DESC LIMIT 20').bind(p.id).all<any>(), s = await getSettings(c.env);
  return rows.results.find((x) => versionEligible(x, s.verify_browser_required).ok) || rows.results[0] || null;
}

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
/** The genres and tags as stored, and how each word the agent sent was read (an alias, a genre), so nothing changes silently. */
export function tagAnswer(p: Project, sent: unknown): Record<string, unknown> {
  const stored = JSON.parse(p.tags || '[]') as string[], g = genresOf(stored);
  const notes = sent === undefined ? [] : tagNotes(parseTags(sent).read_as, stored);
  return { genre: g.primary, secondary_genres: g.secondary, tags: tagsOnly(normalizeStoredTags(stored)), ...(notes.length ? { tag_notes: notes } : {}) };
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
    step(2, 'requirements', true, compat.declared, 'What does the game need from the browser? Confirm the detected block, correcting input, devices or a hardware GPU.', { graphics: GRAPHICS, gpu: ['any', 'hardware'], features: FEATURE_IDS, input: INPUTS, devices: DEVICES, orientation: ['landscape', 'portrait', 'both'] }, requirementsBlock(compat.detected), declare({ requirements: requirementsBlock(compat.detected) })),
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
const CONTENT_SCHEMA = { type: 'object', description: `Content descriptors; the platform derives the age rating from them. Each one left out means none. ${Object.entries(CONTENT_CHOICES).map(([k, v]) => `${k}: ${v.join(' | ')}`).join('; ')}. Pass {} for a game with none of them (rated 3+). flashing_lights is true when the game flashes or strobes bright light or alternating colours more than about three times a second (a photosensitivity warning); a single flash, a fade or a press highlight is false. Adults only (18+): sexual nudity or explicit, violence graphic, violence realistic with blood, or adult_themes; such games are allowed, shown blurred with a warning players confirm. Declare everything a player can see: the review plays the game, and undeclared nudity, sexual content or realistic or graphic violence fails it.` };
// the allowed tags are the enum; the description names the groups only, so tools/list does not carry the list twice
const TAGS_SCHEMA = { type: 'array', maxItems: MAX_TAGS, items: { type: 'string', enum: [...TAGS] }, description: `${MIN_TAGS} to ${MAX_TAGS} tags from the platform list (the allowed values; nothing else is accepted, and genres go in genre and genres). Pick across the groups: ${Object.keys(TAG_GROUPS).join(', ')}. game_metadata {project} shows the list by group with suggestions.` };
const GENRE_SCHEMA = { type: 'string', enum: [...GENRES], description: 'The primary genre; the store groups games by it.' };

/** The only thing between this version and going live is the review a person gives versions the browser could not run. */
const onlyReviewNeeded = (g: GateResult) => g.failures.length > 0 && g.failures.every((f) => f.review === 'needed');

/** After publishing: a word on the store cover when the game has no designed one, or when its size is wrong. */
async function coverAdvice(c: ToolCtx, q: Project, v: any): Promise<{ cover?: string }> {
  try {
    if (!q.cover_key || q.cover_key === v.screenshot_key || q.cover_key.startsWith('shots/'))
      return { cover: `The store is using the verification screenshot as the cover. Design a cover and set it with update_project {project, cover} (and covers per language when it shows the title). ${coverRules(c.origin)}` };
    const obj = await c.env.FILES.get(q.cover_key, { range: { offset: 0, length: 65536 } });
    if (!obj) return {};
    const chk = checkCover(new Uint8Array(await obj.arrayBuffer()));
    return chk.notes.length ? { cover: `The store cover needs work: ${chk.notes.join(' ')} ${coverRules(c.origin)}` } : {};
  } catch { return {}; }
}

async function publishVersion(a: Record<string, any>, c: ToolCtx, rollback: boolean): Promise<unknown> {
  const p = await scopedProject(c, a.project), s = await getSettings(c.env);
  if (p.status === 'removed') throw forbidden('This game was removed by the platform and cannot be published.');
  let v: any = null;
  if (a.version !== undefined && a.version !== null) {
    const n = Number(a.version);
    if (!Number.isInteger(n) || n < 1) throw bad('version must be a whole number from list_versions.');
    v = await getVersion(c.env, p.id, n);
    if (!v) throw bad(`Version ${n} does not exist.`, 'Call list_versions to see the versions this game has.');
  } else {
    const rows = await c.env.DB.prepare('SELECT * FROM versions WHERE project_id = ? AND branch IS NULL ORDER BY n DESC LIMIT 20').bind(p.id).all<any>();
    v = rows.results.find((x) => versionEligible(x, s.verify_browser_required).ok) || rows.results[0] || null;
  }
  if (!v) throw bad('There is no version to publish.', 'Call deploy_preview first.');
  // only main goes live: a branch's version reaches players through a change request merged into main (src/collab.ts)
  if (v.branch && !rollback) throw bad(`Version ${v.n} was deployed from a branch, and only main's versions go live.`, 'Open a change request for the branch (change_requests {action: "open"}), merge it, and publish the merged version.');
  // the license is the owner's: an admin collaborator publishes the owner's game under the owner's license
  const licensee = p.owner_id === c.user.id ? c.user : ((await userById(c.env, p.owner_id)) || c.user);
  // Input is checked before the license, so a wrong version number is reported as such for any account.
  if (s.creator_fee_required && !licensee.creator && !a.dry_run) throw forbidden(`Publishing needs a valid creator license (${licenseText(licensee)} on ${licensee.id === c.user.id ? 'this account' : 'the owner\'s account'}).`, `Ask the user to get one at ${c.origin}/license: ${offersText(s)}. Then call publish again. Preview stays available meanwhile.`);
  // Every platform requirement, checked on the server (src/release-gate.ts). The pipeline checks them again right before
  // the switch, so this answer is for the agent: every rule that fails, with what to do.
  const openAfter = typeof a.open_implementation === 'boolean' ? a.open_implementation : undefined;
  const gate = await releaseGate(c.env, p, v, { mode: rollback ? 'rollback' : 'publish', openImplementation: openAfter });
  // build fields declared after this version was deployed: the refusal says they apply from the next deploy
  const metaFail = gate.failures.find((f) => f.id === 'metadata');
  const declaredSince = metaFail ? await (async () => { try { const w = (await checkProject(c.env, p, c.origin)).manifest; return explainFrozenMeta(metaFail, v!.n, missingToPublish(w.meta, !!w.compat?.declared, JSON.parse(p.tags || '[]'))); } catch { return []; } })() : [];
  await recordGate(c.env, gate);
  const listingFindings = checkStandards({ listing: listingForStandards(p), report: parseJson<Record<string, unknown> | null>(v.report || 'null', null) }).filter((f: { level: string }) => f.level === 'warning').map(findingLine);
  const standardsOut = listingFindings.length ? { standards: { findings: listingFindings, note: 'Design recommendations, never blocking: the design is the game\'s choice. Listing findings are fixed with game_metadata declare or update_project (no deploy needed); findings from verification (loading hand-off, reserved zones) need a code change and a new version. game_standards {project, action: "check"} checks the code too.' } } : {};
  const drift = rollback ? {} : await declaredNotInVersion(c, p, v);
  if (a.dry_run) return { ...drift, ...standardsOut, would_go_live: gate.ok || onlyReviewNeeded(gate), ...(onlyReviewNeeded(gate) ? { review: 'needed', note: 'Everything else holds; publish asks a platform admin to review it because the verification browser could not run it.' } : {}), requirements: gateView(gate), summary: gateText(gate) };
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
        err.hint = declaredSince.length
          ? `${declaredSince.join(', ')} ${declaredSince.length > 1 ? 'are' : 'is'} already declared in the workspace: deploy_preview {project} to make a version that carries ${declaredSince.length > 1 ? 'them' : 'it'}, then publish that version.`
          : needsDeploy
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
  // patch notes ride with the version and are posted by the pipeline when it goes live (src/devlog-news.ts)
  const notes = rollback ? null : cleanPatchNotes(a.patch_notes, v.n);
  if (notes) await c.env.DB.prepare('UPDATE versions SET patch_notes = ? WHERE project_id = ? AND n = ?').bind(JSON.stringify(notes), p.id, v.n).run();
  await logEvent(c.env, p.id, 'publish_requested', '', v.n, c.client);
  await enqueue(c.env, { kind: 'publish', pid: p.id, n: v.n, origin: c.origin, actor: c.client, mode: rollback ? 'rollback' : 'publish' });
  const end = Date.now() + 45000;
  // the pipeline checks every requirement again before the switch; if it refuses, say why instead of "taking longer"
  const failedSince = () => c.env.DB.prepare("SELECT detail FROM events WHERE project_id = ? AND version = ? AND kind = 'publish_failed' AND created_at >= ? ORDER BY id DESC LIMIT 1").bind(p.id, v.n, gate.checked_at).first<{ detail: string }>();
  let q = await fresh(c, p.id), refused: { detail: string } | null = null;
  while (!(q.status === 'live' && q.live_version === v.n) && Date.now() < end) { await sleep(2000); q = await fresh(c, p.id); if (!(q.status === 'live' && q.live_version === v.n) && (refused = await failedSince())) break; }
  const live = q.status === 'live' && q.live_version === v.n;
  if (refused) {
    const later = storedGate((await getVersion(c.env, p.id, v.n)) as any);
    if (later && !later.ok && later.checked_at >= gate.checked_at) throw gateError(later);
  }
  if (refused) throw new AppError(409, refused.detail, 'publish_failed', `Fix what it says, then publish again. publish {project, version: ${v.n}, dry_run: true} checks every requirement without publishing.`);
  const vm = await ensureVersionMeta(c.env, v);
  const store = storeText(await storeStatus(c.env, await getSettings(c.env), q), live);
  return { live, version: v.n, ...drift, store, compatibility: compatSummary(vm.compat), metadata: metaSummary(q, vm.compat, vm.meta), game_page: `${c.origin}/g/${p.slug}`, price: q.price_cents ? usd(q.price_cents) : 'free', free_trial: trialText(q, await getSettings(c.env)), open_implementation: await sharingSource(c, q, a.open_implementation), ...(await coverAdvice(c, q, v)), ...standardsOut, next: live ? 'The game is live. Share the game page with the user.' : 'Going live is taking longer than usual (a first deploy needs a minute). Call list_projects {project} in a little while to confirm.' };
}

export const TOOLS: Tool[] = [
  {
    name: 'get_started', title: 'Start here',
    description: `Call this first. ${WEB_ONLY} Returns what the platform does, the rules a game must follow to deploy, the workflow, the account status (creator license, earnings, limits) and the platform services (saves, leaderboards, multiplayer rooms, server-run matches). Pass topic to read one platform guide in full: ${PLATFORM_GUIDES.map((g) => `"${g.topic}"`).join(', ')}. Every game has a storage limit (see storage in the answer): tell the developer about it before planning large assets. tools maps every tool on this server to what it is for; testing_and_feedback and debugging cover verification, debug_preview (drive the preview in a browser and screenshot it), creator_feedback (the creator's annotated screenshots, to read every session) and test bots. platform_services lists every service with this platform's limits. It does not tell you how to make your game: design is yours and the creator's, and the checks judge only whether a player can play it.`,
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
        scope: SCOPE,
        tools: toolMap(),
        testing_and_feedback: { loop: TESTING, guide: 'get_started {topic: "testing"}' },
        what_this_server_does: 'It hosts web games. It takes the files of your game, deploys each version to its own address, checks it in a real browser, publishes it to the marketplace, keeps every version for rollback, and provides player saves, leaderboards, realtime multiplayer rooms and server-run competitive matches. How you make the game (engine or none, renderer, art, hand-made or generated assets, any build tooling on your side) is your choice: the platform neither prescribes nor scores it.',
        rules: [
          'A web page: index.html at the bundle root, plus the files it loads with relative paths. There is no build step on the platform: upload what the browser runs.',
          'Call GCP.ready() once, right after the first playable frame is drawn. GCP is injected by the platform; never bundle or import it.',
          'Hand over the frame (recommended): draw what the player sees (world, HUD, menus, text) in your canvases rather than as page elements over the game (text fields are drawn in anyway), and register GCP.test.onCapture(() => canvas or [canvases, bottom to top]) and GCP.test.onState(() => where the game is). The creator\'s feedback screenshots are that exact frame on every device, iPhone and iPad included (without the hook, Capture feedback is greyed out for the version: there is no other way to take one), and the preview check "capture" reports, as advice that never stops a version, a game without the hooks, with page elements painted over it, or whose handed-over picture does not match the screen. get_started {topic: "contract"}, "Hand over the frame".',
          'Run with no uncaught errors, keep answering (a frame loop, or a game that redraws only when the player acts: both are fine), survive keyboard, mouse and touch input, and stay on the page (no redirects, downloads or popups). That is what verification checks.',
          `Be playable (required to publish): react visibly to the player's input (the verifier presses arrows, WASD, Space, Enter, J, K, Z, X, clicks, drags and taps; GCP.test.onAutostart skips a title screen), and keep running through ${s.verify_bot_play_s} s of random bot play. A score or an ending is optional (sandbox, idle, creative and exploration games need neither, and nothing needs declaring); a game that has one reports it with GCP.score(n) and GCP.gameOver({ outcome: 'win' | 'lose' | 'done', score }), and ranks a little higher for it.`,
          `The store keeps low-effort games out of view: a new game starts on the New shelf and reaches the main store's lists, shelves and picks once players stick with it (${s.graduate_min_players} players, ${s.graduate_min_minutes} min each on average, at most ${s.graduate_max_quit_percent}% leaving within a minute, ${s.graduate_min_ratings} ratings averaging ${s.graduate_min_rating}+). An account can put ${s.publish_cap_base} new games live in any 7 days, ${s.publish_cap_per_good} more per well-rated live game, up to ${s.publish_cap_max}; updates are never limited. Trending weighs play time and how players come back, not how many games a creator ships. Players can report a game (broken, low effort, …); ${s.report_hide_min} or more reports from different players hide it from the store until a new version goes live. All of this runs by itself; the ranking weights tune themselves to the store. Ship fewer, finished games.`,
          'Be playable on computers, tablets and phones: a keyboard or a mouse on a computer, touch on a phone or tablet (touch controls of the game\'s own, or the platform\'s on-screen controls for its keys), and keep running on the emulated iPhone and iPad through taps and a drag. Declare requirements.devices ["desktop", "tablet", "mobile"]. This is a platform requirement: publish refuses a version that leaves a kind of device out. Which way up the game is played (landscape, portrait or both) is the game\'s own choice.',
          'Declare what the game shows (game_metadata content). Sexual content, violence and other mature themes are allowed when declared; adults-only games are shown blurred, labelled 18+ and start only after the player confirms a warning. The review plays the game and refuses a version whose sexual content or violence is not declared.',
          'A game in several languages is in those languages outside the game too. The platform (in en, zh, zh-TW, ja, ko and es) shows everything about a game in the player\'s platform language when the game is played in it, else in English, else in the game\'s own language: its name, tagline, description, controls text and cover, on the home page, cards, search, the game page, the library and friends\' lists. So for every platform language in game_metadata languages, give the store listing in that language (game_metadata listing_translations, and listing_language for the language the listing itself is in), and a cover per language when the cover shows text (update_project covers). publish refuses a version whose listing misses one of its languages.',
          `Fit the game's storage: all of a game's files together may use ${mb(s.bundle_max_bytes)} by default (one file at most ${mb(s.file_max_bytes)}, ${s.bundle_max_files} files). Uploads that would go over are refused, and a version over it cannot be deployed or published.`,
        ],
        platform_requirements: {
          rule: `${SPLIT.requirements} publish {project, dry_run: true} lists every one with its status and the exact fix.`,
          list: RULES.filter((r) => r.modes.includes('publish')).map((r) => `${r.id}: ${r.title}. ${r.what}`),
        },
        design_recommendations: SPLIT.recommendations,
        standards: {
          rule: 'Design recommendations and best practice, not requirements: the platform says exactly how its own surfaces behave (the cover and its crops, how the store renders the listing text, what it draws over the game: menu button, on-screen controls, friend pop-ups; safe areas, the loading hand-off) and what the store does not take (trailers, icons, logos), and recommends how to fit the game around them. How the game looks, lays out its interface and plays is its own design decision, and no finding ever stops a version. Before making one of these things, read its entry with game_standards {action: "get", id}; before publishing, run game_standards {project, action: "check"} and weigh each warning against the game\'s design. deploy_preview and publish report the same findings. Where an entry has a part that is a platform requirement, it says so under required. What does stop a version is in platform_requirements above and in publish {dry_run: true}.',
          index: standardsIndex(),
          guide: 'get_started {topic: "standards"}',
        },
        storage: {
          per_game: `${mb(s.bundle_max_bytes)} for all of a game's files unless the platform set a different amount for that game; largest file ${mb(s.file_max_bytes)}; ${s.bundle_max_files} files. Platform-hosted Three.js and @gcp/ modules do not count.`,
          tell_the_developer: 'Tell the developer about this limit when you plan the game, before choosing large models, textures, audio or video, and again whenever an answer carries storage.warning (from 80% used). Do not discover it at upload time.',
          design_for_it: 'Prefer content generated from code at boot (meshes, terrain, textures, sound, music) and load large or optional content at run time from a host the developer controls. The page may fetch from any HTTPS host that sends CORS headers.',
          more: s.storage_requests_open ? `If the game truly needs more after that, ask with game_storage {project, action: "request", megabytes, reason}: up to ${mb(s.storage_max_bytes)} per game, reviewed by the platform${s.storage_auto_approve_bytes > 0 ? ` (approved at once up to ${mb(s.storage_auto_approve_bytes)})` : ''}. Ask the developer before requesting.` : 'Storage requests are closed on this platform: the game must fit.',
          check: 'Every upload, list_files, list_projects {project} and deploy_preview answer includes storage (used, storage, free, percent_used, and warning when it is getting full). game_storage {project} shows where the space goes, with every way to save it. get_started {topic: "storage"} is the long form.',
        },
        engines: ENGINE_EXPORTS,
        originality: 'After the browser check passes, each version is compared with other creators\' live games, and a copy (even with renamed variables or new titles) cannot be published. Platform templates, kits and common libraries are ignored, so starting from them is fine. The platform does not decide which kinds of game may be published: sandboxes, toys, creative, idle and exploration games without a score or an ending publish like any other. Content that is never allowed (hate, scams, phishing, sexual content involving minors) or abusive code (miners, password forms). Adult games (sexual content, graphic violence) are allowed when declared in the content descriptors: the review plays the game, looks at what it shows, and refuses a version that shows more than it declares. get_started {topic: "versions"} explains these checks.',
        workflow: [
          '1. create_project, once per game.',
          '2. upload_files for text files, small edits and deletions; create_upload_url to send big or binary files, or a whole folder as a zip, with curl. Each answer shows the game\'s storage; keep inside it (game_storage).',
          '2b. game_metadata: define what players see on the store page: genre, languages (interface, voice, subtitles; GCP.lang is the player\'s platform language; GCP.onLang(fn) hears when the player switches it mid-game, which never restarts the game), players and modes, session length, accessibility, content descriptors (the age rating) and the browser requirements, and the store listing in each platform language the game is played in (listing_language, listing_translations; covers with text per language through update_project covers). check shows what the code reveals and what is missing; declare saves it. Publishing a new version needs genre, requirements, languages, players, content and the listing in every platform language the game is played in.',
          '3. deploy_preview: static checks, then a new numbered version deployed to its own preview address and checked in a real browser. With dry_run: true it runs only the static checks.',
          '4. Read the report. If a check failed, fix it, upload, and deploy_preview again. list_versions {project, version} shows any version\'s report.',
          '4b. Look at the game and listen to the creator: debug_preview opens the preview in a browser you drive (screenshots, clicks, keys, the game\'s state), and creator_feedback returns the annotated screenshots and notes the creator left while playing the preview. Read creator_feedback at the start of every session and whenever an answer carries creator_feedback; each item is removed once you read it.',
          '4c. If the game shares its build skill (Open Implementation on), update it before every release: build_skill {project, action: "get"}, revise it for what changed, then build_skill {project, action: "write", version, content}. publish refuses a version without one while sharing is on.',
          '4d. Working from another machine or agent on the same account, as with git: pull_version downloads any version\'s complete files (or the workspace) and gives its base_version; checkout_version puts a version back into the workspace; diff_versions shows what changed between versions. Deploy with deploy_preview {base_version}: it is refused, and says what came in between, when someone deployed a newer version since. list_versions says who deployed each version and what it was built on.',
          '4e. Working with other people and other agents, as on GitHub: the owner invites collaborators with a role (collaborators {action: "invite"}: read, write, maintain, admin). Each developer or agent works on a branch of its own (branches {action: "create", name}; then upload_files, deploy_preview, list_files, diff_versions and pull_version take {branch}), proposes it for main with change_requests {action: "open", branch, title}, others review it (approve, request_changes, comment), and a maintainer merges it: a three-way merge into a new main version that is verified like any deploy. A conflict refuses the merge with the files; branches {action: "update"} brings main in and marks conflicts with <<<<<<< ======= >>>>>>>. main is protected for collaborators (required approvals, verification); list_projects shows projects shared with you.',
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
          server_code: s.allow_server_code ? 'Optional server/index.js runs on the platform in a sandbox of its own and is reached with GCP.server. get_started {topic: "saves"}.' : 'Disabled on this platform.',
          open_implementations: `Learn how other developers' live games were built, when they chose to share it: find_implementations searches them by kind of game, engine or technique and shows the patterns across them; get_implementation {game} returns one card (engine, rendering, input, audio, assets, platform services, loop and performance techniques, structure, verified play-through, summary). ${NEVER_SHARED} Games that share also publish a build skill in the Creator Store (${c.origin}/creator-store): an agent skill their own agent wrote. get_implementation includes it when it is free. To share your own, ask the user, write the skill with build_skill {action: "write"}, then update_project {open_implementation: true}; the user chooses free or a price (update_project skill_price_cents). While shared, write the skill again for each version before publishing it: publish refuses a version without one. ${openPerks(s)}`,
          compatibility: 'Each version carries its requirements: declared in gcp.json "requirements" (compatibility {action: "declare"} writes it), merged with what the platform detects in the code, frozen at deploy_preview. The store page lists them in a Compatibility section and checks the player\'s browser against them before launch. compatibility {action: "check"} shows what was detected and suggests a block.',
          interface_scale: 'Make the interface fit every screen and let the player size it: GCP.ui.configure({ reference: [1280, 720] }) once, then draw the interface in units with the canvas transform at devicePixelRatio * GCP.ui.scale, place boxes with anchors (GCP.ui.rect({ anchor: "top-right", w, h, margin }), GCP.ui.split) against GCP.ui.view and GCP.ui.safe, offer an Interface size setting with GCP.ui.sizes and GCP.ui.setSize, and redraw on GCP.ui.onChange. Fullscreen always overrides the size of the window the game was first shown in, so size from innerWidth and innerHeight on every resize. get_started {topic: "services"}, "Interface scale and the player\'s UI size".',
          touch_devices: 'Every game must be playable on phones and tablets (a platform requirement), and most need no code for it: the SDK gives keyboard games an on-screen stick and buttons that press the keys found in the game\'s code (or gcp.json "controls": {"touch": "auto" | "overlay" | "none", "stick", "buttons"}; GCP.controls at run time), gives mouse-only games mouse events from the finger and a pointer-lock stand-in, stops long-press selection, tap flashes and zoom, and caps devicePixelRatio at 2. Touch controls made for the game are still better: when the game has its own, the platform\'s stay away. get_started {topic: "touch"} has the details.',
          verification_hooks: 'Recommended: GCP.test.onCapture(fn) hands over the frame (the canvases that hold everything the player sees) and GCP.test.onState(fn) says where the game is; feedback screenshots use both (debug_preview returns the state), and the "capture" check compares them with the screen (advice only). Optional: GCP.test.onPlaythrough(fn) lets the verifier play your rules to the end; GCP.test.onTwoPlayers(fn) checks a two-player session (two verifier players meet on GCP.test.twoPlayers.code through GCP.room or GCP.match.find). get_started {topic: "contract"}.',
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
        const rows = c.allowedProjects === null
          ? await c.env.DB.prepare("SELECT id, slug, title, tagline, tags, status, CASE WHEN status = 'live' THEN live_version ELSE NULL END AS live_version, preview_version, price_cents, CASE WHEN price_cents > 0 THEN trial_minutes ELSE 0 END AS trial_minutes, plays, sales, updated_at FROM projects WHERE owner_id = ? AND status != 'removed' ORDER BY updated_at DESC").bind(c.user.id).all<any>()
          : await c.env.DB.prepare("SELECT id, slug, title, tagline, tags, status, CASE WHEN status = 'live' THEN live_version ELSE NULL END AS live_version, preview_version, price_cents, CASE WHEN price_cents > 0 THEN trial_minutes ELSE 0 END AS trial_minutes, plays, sales, updated_at FROM projects WHERE owner_id = ?1 AND status != 'removed' AND id IN (SELECT value FROM json_each(?2)) ORDER BY updated_at DESC").bind(c.user.id, JSON.stringify(c.allowedProjects)).all<any>();
        // projects other creators shared with this account (src/collab.ts), with the role it has on each
        const shared = (await c.env.DB.prepare(`SELECT p.id, p.slug, p.title, p.tagline, p.tags, p.status, CASE WHEN p.status = 'live' THEN p.live_version ELSE NULL END AS live_version, p.preview_version, p.updated_at, m.role, u.name AS owner
            FROM project_members m JOIN projects p ON p.id = m.project_id JOIN users u ON u.id = p.owner_id WHERE m.user_id = ?1 AND p.status != 'removed' ORDER BY p.updated_at DESC LIMIT 200`).bind(c.user.id).all<any>()).results
          .filter((r) => isProjectAllowed(c.allowedProjects, r.id));
        // the genre and secondary genres are stored among the tags; split them out as every other answer does
        return {
          projects: rows.results.map((r) => { const { tags, ...rest } = r; return { ...rest, role: 'owner', ...tagAnswer({ tags } as Project, undefined) }; }),
          ...(shared.length ? { shared_with_you: shared.map((r) => { const { tags, ...rest } = r; return { ...rest, ...tagAnswer({ tags } as Project, undefined) }; }), shared_note: 'Projects other creators invited you to, with your role on each. Work on a branch of your own (branches {action: "create"}) and propose it with change_requests; collaborators {action: "list"} shows the team.' } : {}),
          ...(c.allowedProjects !== null ? { access_scope: 'selected', note: 'This agent connection is limited to selected projects chosen during authorization.' } : {}),
        };
      }
      const p = await scopedProject(c, a.project), files = await listFiles(c.env, p.id);
      const latest = await c.env.DB.prepare('SELECT * FROM versions WHERE project_id = ? ORDER BY n DESC LIMIT 1').bind(p.id).first<any>();
      return {
        project: p.id, slug: p.slug, title: p.title, tagline: p.tagline, description: p.description, controls: p.controls, ...tagAnswer(p, undefined),
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
      assertCanCreateProject(c.allowedProjects);
      // tags and genre are checked exactly as game_metadata and update_project check them, before the project exists, so
      // a refused word leaves no half-made project behind; genres named among the tags become secondary genres
      if (a.tags !== undefined) chooseTags(a.tags);
      if (a.genre !== undefined && !normGenre(a.genre)) throw bad(`genre "${a.genre}" is not one of the platform genres.`, `Genres: ${GENRES.join(', ')}. Put anything more specific in tags.`);
      let p = await createProject(c.env, c.user, { ...(a as any), ...(a.genre !== undefined ? { tags: undefined } : {}) }, c.client);
      if (a.genre !== undefined) { await updateProjectMeta(c.env, p, { genre: a.genre, ...(a.tags !== undefined ? { tags: a.tags } : {}) }); p = await fresh(c, p.id); }
      return {
        project: p.id, slug: p.slug, title: p.title, ...tagAnswer(p, a.tags), console_page: `${c.origin}/console/projects/${p.id}`, storage: await storageLine(c.env, p, []),
        tell_the_developer: `This game has ${mb(budgetOf(p, await getSettings(c.env)).bytes)} of storage for all its files. Plan assets around it: generate content from code and load large or optional content at run time (game_storage {project} explains how).`,
        next: 'Upload the game: upload_files for text files, create_upload_url for big or binary files or a whole folder. Then deploy_preview.',
        ...(JSON.parse(p.tags || '[]').length < 2 ? { before_publishing: 'Publishing needs 2 to 8 tags from the platform list (game_metadata {project} shows them). Add them with update_project {project, tags} any time before publish.' } : {}),
      };
    },
  },
  {
    name: 'update_project', title: 'Update listing, price, sale, cover or sharing',
    description: 'Updates the marketplace listing: title, tagline, description, genre and secondary genres, tags (both from the platform lists; see game_metadata), controls text, the listing translated into platform languages, price, free trial and cover image. price_cents 0 means free; a positive value makes it a paid game (one-time purchase in US cents), and the platform keeps its cut of each sale. trial_minutes lets players who have not bought a paid game play it for that many minutes in total (counted per account on the server, across reloads and devices) before they are asked to buy; 0 turns the trial off. Only set a price or a trial when the user has chosen them. sale puts a paid game on a limited-time sale: {price_cents, days}; the store shows the sale price with the regular price struck through and when it ends, and buyers pay the sale price until it ends (then the regular price is back by itself). Sending sale again while one runs changes it; null ends it early. The regular price cannot change during a sale. Only start a sale when the user has chosen one. cover is the workspace path of the store cover; without one, the verification screenshot is used, which rarely survives the store\'s crops, so design one. ' + coverRules() + ' The answer carries cover_check: the image size and anything wrong with it. open_implementation true lets other developers\' agents learn how the live game is built through get_implementation (engine, rendering, input, techniques, a summary; never code or files); false stops sharing at once. Only set it when the user has chosen to share. Sharing puts the game\'s build skill (written with build_skill) in the Creator Store; skill_price_cents 0 shares it for free, a price sells it (the user\'s choice).',
    inputSchema: obj({
      project: PROJECT, title: { type: 'string' }, tagline: { type: 'string' }, description: { type: 'string' }, tags: TAGS_SCHEMA,
      controls: { type: 'string', description: 'How to play, shown on the game page (keys, touch).' },
      price_cents: { type: 'integer', description: '0 for free, or the price in US cents (e.g. 499 = $4.99).' },
      trial_minutes: { type: 'integer', description: 'Paid games only: minutes of free play before buying (e.g. 30). 0 turns the free trial off. get_started shows the longest allowed.' },
      cover: { type: 'string', description: 'Workspace path of the cover image, e.g. "cover.jpg": the cover for the listing\'s own language, and for every language without one of its own. 1920x1080 (16:9); title and main subject inside the safe area x 30%-80%, y 12%-86%; nothing important in the left 30% (hidden in the home page banner). See the description.' },
      covers: { type: 'object', description: 'A cover per platform language, for covers that show text such as the game\'s name: {"zh": "cover-zh.jpg", "ja": "cover-ja.jpg"}, workspace paths; null removes one. The listing\'s own language uses cover. Players see the cover of the language the listing is shown in.' },
      listing_language: LISTING_LANGUAGE_SCHEMA,
      open_implementation: { type: 'boolean', description: 'Share how the live game is built with other agents (no code), and its build skill in the Creator Store. Default off.' },
      sale: { type: ['object', 'null'], properties: { price_cents: { type: 'integer', description: 'The sale price in US cents, below the regular price (get_started shows the smallest discount and lowest sale price allowed).' }, days: { type: 'integer', description: 'How many days the sale lasts, from now (or from when the running sale started).' } }, description: 'A limited-time sale of a paid game: {price_cents, days}; null ends the running sale. Only when the user has chosen.' },
      skill_price_cents: { type: 'integer', description: 'The build skill\'s price in US cents, or 0 to share it for free. A free skill lowers the game\'s own platform cut; a sold one keeps the standard cut and pays the skill commission on skill sales. Only when the user has chosen.' },
      genre: GENRE_SCHEMA, genres: { type: 'array', maxItems: 2, items: { type: 'string', enum: [...GENRES] }, description: 'Up to two secondary genres.' },
      listing_translations: TRANSLATIONS_SCHEMA,
      coming_soon: { type: 'boolean', description: 'Before the first release only: true puts up a public coming soon page (needs a title, tagline and cover), where players wishlist the game and see its devlogs; false takes it down. The first release ends it and tells everyone who wishlisted it.' },
      release_note: { type: ['string', 'null'], description: 'The coming soon page\'s "when", in your own words, up to 40 characters: "Spring 2027", "Soon". null clears it.' },
    }, ['project']),
    run: async (a, c) => {
      const p = await scopedProject(c, a.project);
      // the listing is the maintainers'; money and sharing the build stay the owner's (src/collab-core.ts)
      const ownerOnly = (['price_cents', 'trial_minutes', 'sale', 'skill_price_cents', 'open_implementation'] as const).filter((k) => a[k] !== undefined);
      if (ownerOnly.length) assertCan(roleIn(c, p), 'pricing', `changing ${ownerOnly.join(', ')}`);
      let cover: string | undefined;
      const coverChecks: Record<string, unknown> = {};
      const storeCover = async (raw: unknown, tag: string) => {
        const path = cleanPath(String(raw)) || '', ext = extOf(path);
        if (!['png', 'jpg', 'jpeg', 'webp'].includes(ext)) throw bad(`The ${tag} cover must be a png, jpg or webp file.`);
        const { row, bytes } = await readFile(c.env, p.id, path);
        if (row.size > 2 * 1024 * 1024) throw bad(`The ${tag} cover must be under 2 MB.`);
        const chk = checkCover(bytes); coverChecks[tag] = { size: chk.size, ...(chk.notes.length ? { fix: chk.notes } : {}) };
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
      const { cover: _c, covers: _cs, open_implementation: open, skill_price_cents: skillPrice, sale: saleIn, coming_soon: soonIn, release_note: noteIn, ...meta } = a;
      await updateProjectMeta(c.env, p, meta);
      if (saleIn !== undefined) await applySale(c.env, await fresh(c, p.id), saleIn, c.client);
      const now1 = await fresh(c, p.id), own = baseListingLang(now1), langCovers: Record<string, string | null> = {};
      // the cover of the listing's own language is the main cover
      const mainPath = a.cover || perLang.find(([l, v]) => l === own && v)?.[1];
      if (mainPath) {
        const key = await storeCover(mainPath, 'main');
        await c.env.DB.prepare('UPDATE projects SET cover_key = ? WHERE id = ?').bind(key, p.id).run();
        cover = `${c.origin}/api/media/${key}`;
      }
      if (perLang.some(([l]) => l !== own)) {
        const cur = JSON.parse(now1.listing_i18n || '{}') as Record<string, Record<string, string>>;
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
      // the coming soon page goes up last, so a cover or tagline set in this same call counts (src/wishlist.js)
      let comingSoon: Record<string, unknown> | undefined;
      if (soonIn !== undefined || noteIn !== undefined) {
        const before = await fresh(c, p.id), was = isComingSoon(before);
        try { await setComingSoon(c.env.DB, before, { on: typeof soonIn === 'boolean' ? soonIn : undefined, release_note: noteIn }); }
        catch (e) { if (e instanceof WishError) throw bad(e.message, announceIssues(before).map((i: { message: string }) => i.message).join(' ') || undefined); throw e; }
        const after = await fresh(c, p.id), on = isComingSoon(after);
        if (on !== was) await logEvent(c.env, p.id, on ? 'coming_soon' : 'coming_soon_off', on ? 'Coming soon page is up' : 'Coming soon page taken down', null, c.client);
        comingSoon = { on, release_note: after.release_note || null, page: `${c.origin}/g/${encodeURIComponent(after.slug)}`, ...(await wishCount(c.env.DB, p.id)) };
      }
      const q = await fresh(c, p.id), s = await getSettings(c.env);
      if (a.trial_minutes !== undefined) await logEvent(c.env, p.id, 'trial', Number(a.trial_minutes) > 0 ? `Free trial set to ${Math.round(Number(a.trial_minutes))} min` : 'Free trial turned off', null, c.client);
      return { ok: true, title: q.title, ...(comingSoon ? { coming_soon: comingSoon } : {}), ...(a.tags !== undefined || a.genre !== undefined || a.genres !== undefined ? tagAnswer(q, a.tags) : {}), price: q.price_cents ? usd(q.price_cents) : 'free', sale: saleText(q, s), free_trial: trialText(q, s), creator_receives_per_sale: q.price_cents ? usd(splitSale(q.price_cents, s, freeSkillShared(q)).net) : null, ...(cover ? { cover } : {}), ...(Object.keys(langCovers).length ? { covers: langCovers } : {}), ...(Object.keys(coverChecks).length ? { cover_check: { ...coverChecks, look_at_it: `Before you call it done, look at the cover the way the store shows it: cropped to the safe area (x 30%-80%, y 12%-86%) for the home page banner, to 16:10 for cards and 16:7 for shelves, and 240 px wide. The title and main subject must be whole and readable in each. Template: ${c.origin}${COVER.template}` } } : {}), open_implementation: sharing(q), ...(q.skill_price_cents > 0 ? { creator_receives_per_skill_sale: usd(splitSkillSale(q.skill_price_cents, s).net) } : {}) };
    },
  },
  {
    name: 'upload_files', title: 'Upload, edit or delete files',
    description: `Changes the project workspace in one call: files writes whole files, edits replaces an exact piece of text in a file already there (cheaper than resending it), delete removes paths. Paths are relative to the bundle root, e.g. "index.html", "src/game.js". Binary content must be base64 with encoding "base64"; for big or binary files, or a whole folder, create_upload_url is better. Only web file types are accepted, and executables or archives are refused whatever their name. The whole call is checked first: if any file, edit or delete fails (a delete of a path that is not there fails), nothing in the call is saved. Deployed versions keep their own copies, so nothing here changes a preview or the live game until the next deploy_preview and publish. Example: {"project": "abc123", "files": [{"path": "index.html", "content": "<!doctype html>..."}], "edits": [{"path": "src/main.js", "old_string": "speed = 4", "new_string": "speed = 5"}], "delete": ["old.js"]}.`,
    inputSchema: obj({
      project: PROJECT,
      files: { type: 'array', maxItems: 40, description: 'Whole files to create or replace, as {path, content} objects. Up to 40 per call.', items: UPLOAD_ITEMS.files },
      edits: { type: 'array', maxItems: 40, description: 'Exact text replacements in text files already in the workspace. old_string must match exactly (spaces and newlines included) and appear once, unless replace_all is true. Applied after files. An unknown key refuses the call.', items: UPLOAD_ITEMS.edits },
      delete: { type: 'array', items: { type: 'string' }, description: 'Paths to delete. A path that is not in the workspace refuses the whole call (nothing is saved).' },
      branch: BRANCH_ARG,
    }, ['project']),
    run: async (a, c) => {
      const p = await scopedProject(c, a.project), t = await wsTarget(c, p, a.branch, 'write');
      return withLock(c.env, t.ws, async () => {
      // each file and edit is held to its item schema like the call itself: old/new are read as old_string/new_string,
      // and a key still unknown refuses the call instead of reading as a missing old_string
      const items = (k: 'files' | 'edits', aliases: Record<string, string>) => (Array.isArray(a[k]) ? a[k] : []).map((it: unknown, i: number) => {
        const r = checkItem(`${k}[${i}]`, it, (UPLOAD_ITEMS as any)[k], aliases);
        if ('error' in r) throw bad(r.error, k === 'edits' ? 'An edit is {path, old_string, new_string, replace_all?}, e.g. {"path": "src/main.js", "old_string": "speed = 4", "new_string": "speed = 5"}.' : 'A file is {path, content, encoding?}.');
        return r.item;
      });
      const files: any[] = items('files', FILE_ALIASES), edits: any[] = items('edits', EDIT_ALIASES), dels = Array.isArray(a.delete) ? a.delete : [];
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
        const cur = pending.get(path) ?? (await readFile(c.env, t.ws, path)).bytes;
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
      const before = await listFiles(c.env, t.ws), s = await getSettings(c.env);
      // a delete of a path that is not there is refused like an edit whose old_string is not found: nothing is saved
      const have = new Set([...before.map((f) => f.path), ...pending.keys()]);
      const missing = dels.map((d: unknown) => String(d)).filter((d: string) => { const path = cleanPath(d); return !path || !have.has(path); });
      if (missing.length) throw bad(`delete: ${missing.map((d: string) => `"${d}"`).join(', ')} ${missing.length === 1 ? 'is' : 'are'} not in the workspace, so nothing in this call was saved.`, 'Paths are case sensitive and relative to the bundle root; list_files shows every path. Leave out what is already gone and send the call again.');
      assertFits(s, p, before, [...pending].map(([path, bytes]) => ({ path, size: bytes.byteLength })), dels.map((d: unknown) => cleanPath(String(d)) || String(d)));
      // Every part passed: write.
      const rows = new Map<string, Awaited<ReturnType<typeof putFile>>>();
      for (const [path, bytes] of pending) rows.set(path, await putFile(c.env, p, path, bytes, true, t.ws));
      const written = [...new Set(files.map((f) => cleanPath(f.path)!))].map((path) => ({ path, bytes: rows.get(path)!.size, sha: rows.get(path)!.sha }));
      const deleted: string[] = [];
      const notFound: string[] = [];   // only a path removed by another call in the meantime
      for (const d of dels) { const path = cleanPath(String(d)); if (path && await deleteFile(c.env, t.ws, path)) deleted.push(path); else notFound.push(String(d)); }
      const resolved = await autoResolve(c.env, t.branch, [...pending.keys()], t.ws);
      return {
        ...(t.branch ? { branch: t.branch.name } : {}),
        ...(resolved.length ? { conflicts_resolved: resolved } : {}),
        written, edited: edited.map((e) => ({ path: e.path, bytes: rows.get(e.path)!.size, sha: rows.get(e.path)!.sha, replaced: e.replaced })), deleted,
        ...(notFound.length ? { not_deleted: notFound, not_deleted_why: 'Not in the workspace (paths are case sensitive and relative to the bundle root). list_files shows every path.' } : {}),
        storage: await storageLine(c.env, p, await listFiles(c.env, t.ws)),
        next: `Call deploy_preview${t.branch ? ` {branch: "${t.branch.name}"}` : ''} when the changes are complete (dry_run: true for only the static checks).`,
      };
      });
    },
  },
  {
    name: 'create_upload_url', title: 'Get a direct upload URL',
    description: 'Returns a short-lived URL for uploading files straight from a shell with curl, without passing their contents through this conversation. Use it for large or binary files, or a whole folder as a zip (an engine\'s web export folder, for example). Valid for 30 minutes.',
    inputSchema: obj({ project: PROJECT, branch: BRANCH_ARG }, ['project']),
    run: async (a, c) => {
      const p = await scopedProject(c, a.project), w = await wsTarget(c, p, a.branch, 'write'), t = randomToken(24);
      await c.env.DB.prepare('INSERT INTO uploads (token_hash, project_id, user_id, expires_at, ws) VALUES (?, ?, ?, ?, ?)').bind(await sha256(t), p.id, c.user.id, now() + 30 * 60000, w.branch ? w.ws : null).run();
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
    description: 'Lists every file in the project workspace with its size and sha (the first 32 hex characters of its SHA-256), so you can see which local files differ from what was uploaded, and which version the workspace is based on and what changed in it since. To get the files themselves, use pull_version.',
    inputSchema: obj({ project: PROJECT, branch: BRANCH_ARG }, ['project']), annotations: { readOnlyHint: true },
    run: async (a, c) => {
      const p = await scopedProject(c, a.project), t = await wsTarget(c, p, a.branch, 'read'), files = await listFiles(c.env, t.ws);
      return { ...(t.branch ? { branch: t.branch.name, conflicts: parseJson<string[]>(t.branch.conflicts, []) } : {}), files: files.map((f) => ({ path: f.path, bytes: f.size, sha: f.sha })), total_bytes: files.reduce((x, f) => x + f.size, 0), workspace: await workspaceLine(c.env, p, await lineOf(c, p, t)), storage: await storageLine(c.env, p, files) };
    },
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
      const p = await scopedProject(c, a.project), action = a.action || 'check';
      if (action === 'request') return { project: p.id, ...(await requestStorage(c.env, c.user, p, a.megabytes, a.reason, c.client)), storage: await storageLine(c.env, await fresh(c, p.id)) };
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
    name: 'game_standards', title: 'Read the platform\'s standards or check the game against them',
    description: `The platform's design recommendations and best practice for everything a game or its agent provides, and a check against all of them. These are advice, not the platform requirements (publish {dry_run: true} checks those); a few entries name a required part, under required. It says exactly how the platform's own surfaces behave (store, player, splash, menu button, safe area) and recommends how to fit the game around them; the game's design stays the game's decision, and no finding ever blocks a version. Read an entry before you make the thing it covers, and check before publishing.
- list: one line per standard (${STANDARDS.length}): the store (cover and its crops, a cover per language, what the store draws over the cover, title, tagline, description, controls text, genre and tags, screenshots, badges), what the platform does not take (trailers, icons and logos, achievements) and what happens while the game plays (splash and loading, the platform menu button, safe areas, on-screen controls, interface layout by anchors (ui-layout), window size, orientation (landscape, portrait or both, and the rotate prompt), interface scale, quality, intended sound playing correctly, capture hooks, the bot hook, the friends picker and pop-ups, languages).
- get {id}: one standard in full: where it appears, the exact sizes and limits, do and don't, what the platform checks, and a template image where there is one.
- check {project}: checks the listing (every language) and the workspace code against the standards. Each finding names its standard, says what was found and gives the fix; warnings are also shown by deploy_preview and publish, notes only here.
The whole set as one page: get_started {topic: "standards"}.`,
    inputSchema: obj({
      action: { type: 'string', enum: ['list', 'get', 'check'], description: 'Default "list", or "check" when project is given.' },
      id: { type: 'string', enum: STANDARDS.map((x) => x.id), description: 'get: the standard to return.' },
      project: { ...PROJECT, description: 'check: the project to check.' },
    }), annotations: { readOnlyHint: true },
    run: async (a, c) => {
      const action = a.action || (a.project ? 'check' : a.id ? 'get' : 'list');
      const full = (x: (typeof STANDARDS)[number]) => ({ ...x, area: AREAS[x.area as keyof typeof AREAS], guide: guideCall(x.guide), guide_on_the_web: `${c.origin}${x.guide}`, ...(x.template ? { template: `${c.origin}${x.template}`, ...(TEMPLATES.find((t) => t.path === x.template) ? { template_resource: `gcp://templates/${TEMPLATES.find((t) => t.path === x.template)!.name}` } : {}) } : {}) });
      if (action === 'list') return { standards: standardsIndex(), next: 'game_standards {action: "get", id} for one in full; game_standards {project, action: "check"} to check a game.' };
      if (action === 'get') {
        const x = standardById(String(a.id || ''));
        if (!x) throw bad(`No standard "${a.id}".`, `ids: ${STANDARDS.map((y) => y.id).join(', ')}`);
        return full(x);
      }
      if (action !== 'check') throw bad('action must be "list", "get" or "check".');
      if (!a.project) throw bad('check needs project.');
      const p = await scopedProject(c, a.project);
      const r = await checkProject(c.env, p, c.origin);
      // what verification measured on the newest version (the loading hand-off, the reserved zones on a phone)
      const last = await c.env.DB.prepare('SELECT n, report FROM versions WHERE project_id = ? AND report IS NOT NULL ORDER BY n DESC LIMIT 1').bind(p.id).first<{ n: number; report: string }>();
      const rep = last ? parseJson<Record<string, unknown> | null>(last.report, null) : null;
      if (rep) r.standards.push(...(checkStandards({ report: rep }) as typeof r.standards));
      const warnings = r.standards.filter((f) => f.level === 'warning'), notes = r.standards.filter((f) => f.level === 'note');
      return {
        project: p.id, ok: !warnings.length, ...(last ? { measured_on_version: last.n } : { measured_on_version: null, note: 'No verified version yet: the checks that need the verification browser (loading hand-off, reserved zones on a phone) run at deploy_preview.' }),
        ...(() => { const dp = deviceProblems(r.manifest as unknown as Record<string, unknown>); return dp.length ? { platform_requirements_unmet: dp.map((d) => `REQUIRED [every_device] ${d.message} To fix: ${d.fix}`) } : {}; })(),
        warnings: warnings.map(findingLine), notes: notes.map(findingLine),
        not_checked: STANDARDS.filter((x) => !x.checks.length && /^Not checked/.test(x.enforced)).map((x) => `${x.id}: ${x.enforced}`),
        next: warnings.length ? 'Consider each recommendation: they are advice, never blocking, and the design stays the game\'s choice. Listing fields change with game_metadata declare, code with upload_files.' : 'No warnings. Read the notes and the not_checked items, and look at the cover and the preview on a phone viewport (debug_preview) yourself.',
      };
    },
  },
  {
    name: 'game_metadata', title: 'Define the game\'s store metadata',
    description: `Everything players see about the game on its store page, in one place. Define it while building the game: publishing a new version needs genre, tags, requirements, languages, players and content (the refusal lists what is missing). Listing (any time, no deploy needed; how the store renders each field, with limits and what to avoid, is in game_standards {action: "get", id: "title" | "tagline" | "description" | "controls-text"}: description and controls are plain text, never Markdown, and a tagline that repeats the title is hidden): title, tagline, description, controls, genre (one of ${GENRES.join(', ')}), up to two secondary genres, tags (${MIN_TAGS} to ${MAX_TAGS} from the platform list: setting and theme, mood, gameplay, players, visual style and view; nothing else is accepted), and listing_translations (the listing in the platform languages en, zh, zh-TW, ja, ko, es). Build (frozen with the next deploy_preview, written to gcp.json): requirements (what it needs from the browser; see the compatibility tool), languages (interface, voice and subtitles per language, and whether it follows the player's platform language GCP.lang), players (min, max, modes), session_minutes (a typical session), progress (cloud_saves, leaderboards, offline; detected from GCP.save and GCP.leaderboard), accessibility (${ACCESSIBILITY.join(', ')}; [] for none) and content (descriptors the platform turns into an age rating). action "check" (default) shows the whole picture: what is declared, what the code shows (renderer, input, online play through rooms or server-run matches, saves, leaderboards, languages from translation files and on-screen text), problems, what publishing still needs, and suggestions. action "declare" validates and saves the fields you pass (each replaces that field; nothing is saved if any field is invalid). version shows what that version went out with.`,
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
      branch: BRANCH_ARG,
    }, ['project']), annotations: { idempotentHint: true },
    run: async (a, c) => {
      let p = await scopedProject(c, a.project);
      const t = await wsTarget(c, p, a.branch, a.action === 'declare' ? 'write' : 'read');
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
        if (listing.length) assertCan(roleIn(c, p), 'edit_listing', `declaring listing fields (${listing.join(', ')})`);
        if (listing.length) { await updateProjectMeta(c.env, p, Object.fromEntries(listing.map((f) => [f, a[f]]))); written.push(...listing); }
        if (build.length) {
          const gcp = await workspaceManifest(c, t.ws);
          for (const f of build) if (a[f] === null) delete gcp[f]; else gcp[f] = f === 'requirements' ? parseRequirements(a[f]).value : f === 'languages' ? parseLanguages(a[f]).value : a[f];
          await withLock(c.env, t.ws, () => putFile(c.env, p, 'gcp.json', new TextEncoder().encode(JSON.stringify(gcp, null, 2) + '\n'), false, t.ws));
          written.push(...build);
        }
        await logEvent(c.env, p.id, 'metadata', `Game metadata declared: ${written.join(', ')}`, null, c.client);
        p = await fresh(c, p.id);
      }
      const check = await checkProject(c.env, p, c.origin, t.ws), cp = check.manifest.compat!, mr = check.manifest.meta!;
      const summary = metaSummary(p, cp, mr), issues = [...check.compatIssues, ...check.metaIssues].map(metaIssueLine);
      const suggest: Record<string, unknown> = {};
      if (!cp.declared) suggest.requirements = requirementsBlock(cp.detected);
      if (!mr.languages.declared) suggest.languages = { default: mr.languages.detected.default, supported: mr.languages.detected.supported, follows_platform: mr.languages.detected.follows_platform };
      if (!mr.declared.includes('players')) suggest.players = mr.detected.multiplayer ? { min: 1, max: 4, modes: ['single', 'coop-online'] } : { min: 1, max: 1, modes: ['single'] };
      if (!mr.declared.includes('progress')) suggest.progress = mr.detected.progress;
      return {
        ...(written.length ? { saved: written, takes_effect: written.some((f) => (BUILD_FIELDS as readonly string[]).includes(f)) ? `listing fields at once. Build fields (${written.filter((f) => (BUILD_FIELDS as readonly string[]).includes(f)).join(', ')}) are written to gcp.json in the workspace and frozen into a version when it is deployed, so versions deployed before now still carry the old values: call deploy_preview {project} next and publish the version it makes` : 'at once' } : {}),
        ...(written.includes('requirements') ? await declaredNotInVersion(c, p, await newestVersion(c, p)) : {}),
        ...(action === 'declare' && a.tags !== undefined ? (() => { const t = tagAnswer(p, a.tags); return t.tag_notes ? { tag_notes: t.tag_notes } : {}; })() : {}),
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
      branch: BRANCH_ARG,
    }, ['project']), annotations: { idempotentHint: true },
    run: async (a, c) => {
      const p = await scopedProject(c, a.project), t = await wsTarget(c, p, a.branch, a.action === 'declare' ? 'write' : 'read');
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
        const gcp = await workspaceManifest(c, t.ws);
        const before = a.replace ? {} : (gcp.requirements && typeof gcp.requirements === 'object' ? gcp.requirements as Record<string, unknown> : {});
        const base = a.use_detected ? requirementsBlock((await checkProject(c.env, p, c.origin, t.ws)).manifest.compat!.detected) : {};
        const next = { ...before, ...base, ...(a.requirements || {}) };
        const check = parseRequirements(next);
        if (check.issues.some((i) => i.level === 'error')) throw bad(`requirements: ${check.issues.filter((i) => i.level === 'error').map((i) => `${i.field}: ${i.message}`).join(' · ')}`, 'Nothing was written. With replace: true the whole declaration is replaced.');
        // "both" is what agents and the store page say; the parser's internal "any" means the same and is never written
        const written = { ...check.value, ...(check.value.orientation === 'any' ? { orientation: 'both' } : {}) };
        await withLock(c.env, t.ws, () => putFile(c.env, p, 'gcp.json', new TextEncoder().encode(JSON.stringify({ ...gcp, requirements: written }, null, 2) + '\n'), false, t.ws));
        await logEvent(c.env, p.id, 'requirements', 'Compatibility requirements declared', null, c.client);
      }
      const check = await checkProject(c.env, p, c.origin, t.ws), cp = check.manifest.compat!;
      const issues = check.compatIssues.map((i) => `${i.level.toUpperCase()} ${i.field}: ${i.message}${i.hint ? `\n  fix: ${i.hint}` : ''}`);
      return {
        ...(action === 'declare' ? { written: 'gcp.json', takes_effect: 'with the next deploy_preview', ...await declaredNotInVersion(c, p, await newestVersion(c, p)) } : {}),
        declared: cp.declared ? bothNotAny((await workspaceManifest(c, t.ws)).requirements) : null,
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
    description: `Runs the static checks (JavaScript syntax with the exact line, imports that do not resolve, missing files, the GCP.ready() contract, web-only content, size limits), then freezes the workspace as a new numbered version, deploys it to its own preview address and opens it in a real browser to check that it boots, renders, survives input and throws no errors. If the game registered GCP.test.onPlaythrough, the browser also plays it. Returns the report. With dry_run: true only the static checks run and nothing is deployed. The browser check takes one to two minutes; if it is still running after ${DEPLOY_WAIT_MS / 1000} seconds (wait_seconds: up to ${MAX_WAIT_S} to wait for it in this call) the answer says not_finished and list_versions {project, version} returns the report (do not deploy again meanwhile). verification in the answer is the outcome: passed, failed or running; deployed: true only means the files went out. retry_version: n runs the deploy and browser check again on the newest version when it failed (for example a heavy game that only just missed the frame count on the verifier's software GPU), without making a new version number; up to ${RETRY_LIMIT} retries per version. base_version: the version your changes start from; when another agent or machine deployed a newer one since, nothing is deployed and the answer says which versions and what they changed (force: true deploys anyway).`,
    inputSchema: obj({
      project: PROJECT, note: { type: 'string', description: 'What changed in this version (shown in the version list).' }, dry_run: { type: 'boolean', description: 'Only run the static checks.' }, retry_version: { type: 'integer', description: 'Optional. Check this failed version again (it must be the newest) instead of making a new one from the workspace.' }, wait_seconds: WAIT_SCHEMA(DEPLOY_WAIT_MS),
      base_version: { type: 'integer', description: 'The version your changes start from (the one you pulled or checked out; 0 before the first). The deploy is refused when a newer version was deployed since, by another agent or machine, so its changes are never silently left out; the answer says which versions and what they changed. Strongly recommended whenever more than one agent or machine works on the game.' },
      force: { type: 'boolean', description: 'With base_version: deploy the workspace as it is even though newer versions exist (their changes are left out of this version unless the workspace has them).' },
      by: { type: 'string', description: 'Optional. A short name for this machine or agent (e.g. "laptop", "ci"), shown with the agent app\'s name as who deployed the version.' },
      branch: { ...BRANCH_ARG, description: 'Optional. Deploy this branch\'s workspace as a version of the branch instead of main. It is verified like any deploy and shows on the shared preview address; change_requests proposes it for main.' },
    }, ['project']),
    run: async (a, c) => {
      const p = await scopedProject(c, a.project), t = await wsTarget(c, p, a.branch, 'write');
      if (t.branch) assertCan(roleIn(c, p), 'deploy_branch', `deploying branch ${t.branch.name}`);
      if (a.retry_version !== undefined && a.retry_version !== null) return retryPreview(c, p, Number(a.retry_version), a.wait_seconds);
      const conflicts = t.branch ? parseJson<string[]>(t.branch.conflicts, []) : [];
      if (conflicts.length && !a.dry_run) return { deployed: false, branch: t.branch!.name, reason: `The branch has unresolved conflicts from bringing main in: ${conflicts.join(', ')}.`, conflicts, next: 'Fix each file (no <<<<<<< ======= >>>>>>> markers left) and upload it, or branches {action: "resolve", path, take: "main"|"branch"}. Then deploy again.' };
      return withLock(c.env, t.ws, async () => {
      const check = await checkProject(c.env, p, c.origin, t.ws);
      const storage = await storageLine(c.env, p, await listFiles(c.env, t.ws));
      const where = t.branch ? { branch: t.branch.name } : {};
      if (a.dry_run) return { ...where, ok: check.ok, files: check.files, bytes: check.bytes, storage, errors: check.errors.map(issueLine), warnings: check.warnings.map(issueLine), next: check.ok ? 'No errors. Call deploy_preview without dry_run.' : 'Fix the errors above, then check again.' };
      if (!check.ok) return { ...where, deployed: false, reason: 'Static checks failed, so nothing was deployed.', storage, errors: check.errors.map(issueLine), warnings: check.warnings.map(issueLine), next: 'Fix the errors, then call deploy_preview again.' };
      const busy = await c.env.DB.prepare("SELECT n FROM versions WHERE project_id = ?2 AND status IN ('queued','deploying','verifying') AND created_at > ?3 AND ((?1 IS NULL AND branch IS NULL) OR branch = ?1)")
        .bind(t.branch?.id ?? null, p.id, now() - 10 * 60000).first<{ n: number }>();
      if (busy) throw new AppError(409, `Version ${busy.n} of ${t.label} is still being deployed.`, 'busy', `Call list_versions {project, version: ${busy.n}} and wait for it to finish first.`);
      const by = actorOf(c, a.by), line = await lineOf(c, p, t), bid = t.branch?.id ?? null;
      let base: number | null = line.base ?? null, expectNewest: number | undefined;
      if (a.base_version !== undefined && a.base_version !== null) {
        base = Number(a.base_version);
        const verdict = checkBase(base, line.newest, await versionsAfter(c.env, p.id, base, bid));
        if (!verdict.ok && (verdict.code === 'unknown_base' || a.force !== true)) return await baseConflict(c, p, base, verdict);
        if (verdict.ok) expectNewest = line.newest;
      }
      const v = await snapshot(c.env, p, check.manifest, String(a.note || ''), { base, actor: by, expectNewest, ws: t.ws, branch: bid });
      if (!v) { const q = await fresh(c, p.id), now2 = t.branch ? (await c.env.DB.prepare('SELECT head_version FROM branches WHERE id = ?').bind(bid).first<{ head_version: number | null }>())?.head_version ?? 0 : await mainHead(c.env, p.id); return await baseConflict(c, q, base!, checkBase(base!, now2, await versionsAfter(c.env, p.id, base!, bid))); }
      await logEvent(c.env, p.id, 'preview_requested', `${t.branch ? `[${t.branch.name}] ` : ''}${String(a.note || '')}`, v.n, c.client);
      await enqueue(c.env, { kind: 'preview', pid: p.id, n: v.n, origin: c.origin, actor: c.client });
      return { v, storage, warnings: check.warnings.map(issueLine) };
      }).then(async (r: any) => {
        if (!r || !r.v) return r;
        const done = await waitVersion(c, p.id, r.v.n, waitMs(a.wait_seconds, DEPLOY_WAIT_MS));
        return { deployed: true, ...(t.branch ? { branch: t.branch.name, next_step: `When it is verified, propose it for main: change_requests {project, action: "open", branch: "${t.branch.name}", title}. An open change request picks up each new version of the branch by itself.` } : {}), storage: r.storage, warnings: r.warnings, ...waitNote(a.wait_seconds), ...(await versionReport(c, p, r.v.n, done)) };
      });
    },
  },
  {
    name: 'list_versions', title: 'List versions or read one report',
    description: `Without version: lists the project's versions, newest first, with status, the one-line summary, the checks that failed, whether each can be published, and which is live and which is on preview. With version: returns that version's full verification report (each check with its detail and hint, uncaught errors, missing files, load time, frame rate, screenshot), waiting up to ${LIST_WAIT_MS / 1000} seconds if it is still being checked (wait_seconds up to ${MAX_WAIT_S} waits longer, so one call returns the result). This is how to read any past version's report.`,
    inputSchema: obj({ project: PROJECT, version: { type: 'integer', description: 'Optional. A version number to read in full.' }, wait_seconds: WAIT_SCHEMA(LIST_WAIT_MS) }, ['project']), annotations: { readOnlyHint: true },
    run: async (a, c) => {
      const p = await scopedProject(c, a.project), s = await getSettings(c.env);
      if (a.version) return { ...waitNote(a.wait_seconds), ...(await versionReport(c, p, Number(a.version), await waitVersion(c, p.id, Number(a.version), waitMs(a.wait_seconds, LIST_WAIT_MS)))) };
      const rows = await c.env.DB.prepare('SELECT * FROM versions WHERE project_id = ? ORDER BY n DESC LIMIT 50').bind(p.id).all<any>();
      const bnames = new Map((await c.env.DB.prepare('SELECT id, name FROM branches WHERE project_id = ?').bind(p.id).all<{ id: string; name: string }>()).results.map((b) => [b.id, b.name]));
      const versions = rows.results.map((v) => ({ version: v.n, branch: v.branch ? bnames.get(v.branch) || 'deleted branch' : 'main', ...(v.change_number ? { merged_change: v.change_number } : {}), note: v.note, status: v.status, summary: v.stage || parseJson<{ summary?: string }>(v.report, {}).summary || '', ...failedChecks(v), can_publish: versionEligible(v, s.verify_browser_required).ok && currentChecks(v, s).ok, created_at: new Date(v.created_at).toISOString(), ...(v.actor ? { by: v.actor } : {}), ...(v.base ? { based_on: v.base } : {}), live: v.n === p.live_version && p.status === 'live' }));
      const failed = versions.find((v) => v.status === 'failed');
      const mh = await mainHead(c.env, p.id);
      return { live_version: p.live_version, preview_version: p.preview_version, newest_version: mh || null, ...(bnames.size ? { main_newest_version: mh || null, note_on_branches: 'Versions deployed from a branch are listed with it; main\'s newest version is the newest without one. branches {action: "list"} shows each branch.' } : {}), status: p.status, workspace: await workspaceLine(c.env, p), versions, next: failed ? `Call list_versions {project, version: ${failed.version}} for the full report of a version (every check with its detail and hint).` : 'Call list_versions {project, version} for the full report of one version.' };
    },
  },
  {
    name: 'pull_version', title: 'Download a version\'s files',
    description: `Gets the complete files of a version, every file exactly as it was uploaded (server/ code and gcp.json included), so another agent or another machine signed in to this account can carry on from it, the way a git pull does. Returns a short-lived zip URL for curl, a URL per file, the file list with hashes, and the base_version to pass to deploy_preview after your changes. paths returns the text of up to ${PULL_INLINE.files} text files in the answer, for agents without a shell. Omit version for the newest one; workspace: true gets the workspace as it is now (with uploads not deployed yet) instead. Nothing in the project changes.`,
    inputSchema: obj({
      project: PROJECT,
      version: { type: 'integer', description: 'Optional. The version to download. Default: the newest.' },
      workspace: { type: 'boolean', description: 'Optional. true: the workspace as it is now instead of a version.' },
      branch: { ...BRANCH_ARG, description: 'Optional. With workspace: true, that branch\'s workspace; without, the branch\'s newest version (when no version is given).' },
      paths: { type: 'array', items: { type: 'string' }, description: `Optional. Text files to return in the answer itself (up to ${PULL_INLINE.files} files and ${PULL_INLINE.bytes / 1024} KB in all).` },
    }, ['project']), annotations: { readOnlyHint: true },
    run: async (a, c) => {
      const p = await scopedProject(c, a.project), t = await wsTarget(c, p, a.branch, 'read'), line = await lineOf(c, p, t), newest = line.newest;
      if (a.workspace === true && a.version !== undefined && a.version !== null) throw bad('Pass version or workspace, not both.');
      if (a.workspace !== true && !newest) throw bad('This game has no version yet.', 'Pass workspace: true to download the workspace, or deploy_preview to make the first version.');
      const source: Source = a.workspace === true ? { workspace: true, ...(t.branch ? { ws: t.ws, label: t.label } : {}) } : { version: a.version ? Number(a.version) : newest };
      const v = 'version' in source ? await versionOrThrow(c.env, p, source.version) : null;
      const files = await sourceFiles(c.env, p, source);
      // text in the answer, all checked before any is read
      const want = Array.isArray(a.paths) ? [...new Set(a.paths.map((x: unknown) => String(x)))] as string[] : [];
      if (want.length > PULL_INLINE.files) throw bad(`paths: at most ${PULL_INLINE.files} files per call.`, 'Use the zip URL for more.');
      const pick = want.map((path) => {
        const f = files.find((x) => x.path === path);
        if (!f) throw bad(`paths: "${path}" is not in ${sourceName(source)}.`, 'The files list in an answer without paths shows every path.');
        if (!isText(path)) throw bad(`paths: ${path} is not a text file.`, 'Download binary files with the file URL.');
        return f;
      });
      const inlineBytes = pick.reduce((x, f) => x + f.size, 0);
      if (inlineBytes > PULL_INLINE.bytes) throw bad(`paths: those files are ${mb(inlineBytes)} together; the answer holds up to ${PULL_INLINE.bytes / 1024} KB.`, 'Ask for fewer files, or use the zip URL.');
      const contents: Record<string, string> = {};
      for (const f of pick) { const o = await readSourceFile(c.env, p, source, f.path); if (o) contents[f.path] = await o.text(); }
      const tk = randomToken(24);
      await c.env.DB.prepare('INSERT INTO downloads (token_hash, project_id, user_id, version, expires_at, ws) VALUES (?, ?, ?, ?, ?, ?)').bind(await sha256(tk), p.id, c.user.id, v ? v.n : null, now() + 30 * 60000, !v && t.branch ? t.ws : null).run();
      const url = `${c.origin}/api/download/${tk}`, base = v ? v.n : (line.base ?? newest);
      const folder = v ? `${p.slug}-v${v.n}` : `${p.slug}-workspace`;
      await logEvent(c.env, p.id, 'pulled', v ? `Version ${v.n} downloaded` : 'Workspace downloaded', v ? v.n : null, c.client);
      return {
        pulled: v ? `version ${v.n}` : 'the workspace',
        ...(v ? { version: v.n, note: v.note, status: v.status, ...(v.actor ? { by: v.actor } : {}), ...(v.base ? { based_on: v.base } : {}), created_at: new Date(v.created_at).toISOString() } : { workspace: await workspaceLine(c.env, p, line) }),
        newest_version: newest || null, base_version: base,
        file_count: files.length, total_bytes: files.reduce((x, f) => x + f.size, 0), files: files.map((f) => ({ path: f.path, bytes: f.size, sha: f.sha })),
        expires_in_minutes: 30, zip_url: url, file_url: `${url}?path=`,
        download: `curl -fsS -o /tmp/${folder}.zip "${url}" && mkdir -p ${folder} && unzip -oq /tmp/${folder}.zip -d ${folder}`,
        ...(pick.length ? { contents } : {}),
        note: 'The zip holds every file at its workspace path (index.html at the root). file_url takes a path, URL-encoded, for one file. Each file\'s sha is the first 32 hex characters of its SHA-256, as list_files shows it.',
        next: `Change the files, upload them (create_upload_url, and its zip URL with ?clean=1 makes the workspace exactly your folder; or upload_files), then deploy_preview {project, ${t.branch ? `branch: "${t.branch.name}", ` : ''}base_version: ${base}}. If another agent deployed a newer version in the meantime, that deploy is refused and says what changed, so you can merge it first. To edit the platform's copy in place with upload_files edits instead, first checkout_version {project, version: ${base}} so the workspace matches.`,
      };
    },
  },
  {
    name: 'checkout_version', title: 'Put a version\'s files back into the workspace',
    description: 'Makes the workspace exactly the files of one version: files that differ are replaced, files the version does not have are deleted. Use it to carry on from a version with upload_files edits, or to go back to an older version and build on it. The live game and the preview do not change until you deploy_preview and publish. If the workspace has changes that are in no version yet (uploaded but not deployed, perhaps by another agent), nothing is changed and the answer lists them; force: true discards them.',
    inputSchema: obj({ project: PROJECT, version: { type: 'integer', description: 'The version to check out.' }, force: { type: 'boolean', description: 'Discard workspace changes that are in no version yet.' }, branch: BRANCH_ARG }, ['project', 'version']), annotations: { destructiveHint: true },
    run: async (a, c) => {
      const p = await scopedProject(c, a.project), t = await wsTarget(c, p, a.branch, 'write'), n = Number(a.version);
      await versionOrThrow(c.env, p, n);
      return withLock(c.env, t.ws, async () => {
      const line = await lineOf(c, p, t);
      const w = await workspaceState(c.env, p, line);
      const unsaved = w.diff ? (isSame(w.diff) ? null : w.diff) : (w.files ? diffFiles([], await sourceFiles(c.env, p, { workspace: true, ws: t.ws })) : null);
      if (unsaved && a.force !== true) {
        return {
          checked_out: false,
          reason: `The workspace has changes that are in no version yet${w.base ? ` (against version ${w.base}, which it is based on)` : ''}: ${diffLine(unsaved)}. Checking out would discard them.`,
          unsaved: { changed: unsaved.changed.map((f) => f.path), added: unsaved.added.map((f) => f.path), removed: unsaved.removed.map((f) => f.path) },
          next: 'Keep them by deploying them first (deploy_preview) or downloading them (pull_version {project, workspace: true}). To discard them, call again with force: true.',
        };
      }
      const r = await checkoutVersion(c.env, p, n, t.ws, t.branch?.id ?? null);
      await logEvent(c.env, p.id, 'checkout', `${t.branch ? `[${t.branch.name}] ` : ''}Workspace set to version ${n}${unsaved ? ' (unsaved changes discarded)' : ''}`, n, c.client);
      const q = await fresh(c, p.id), newest = line.newest;
      return {
        checked_out: n, written: r.written, removed: r.removed, unchanged: r.unchanged, ...(unsaved ? { discarded: diffLine(unsaved) } : {}),
        ...(t.branch ? { branch: t.branch.name } : {}), newest_version: newest, base_version: newest, storage: await storageLine(c.env, q, await listFiles(c.env, t.ws)),
        next: n === newest
          ? `The workspace is now version ${n}. Make your changes, then deploy_preview {project, base_version: ${n}}.`
          : `The workspace is now version ${n}, older than the newest, version ${newest}. Deploying it leaves out what versions ${n + 1} to ${newest} changed (diff_versions {project, from: ${n}, to: ${newest}} shows it). Having chosen that, deploy with base_version: ${newest}, so a version someone deploys meanwhile is still caught.`,
      };
      });
    },
  },
  {
    name: 'diff_versions', title: 'Compare two versions, or a version with the workspace',
    description: `What changed between two versions, or between a version and the workspace: files added, removed and changed (by content hash), with a unified line diff of each changed text file (up to ${DIFF_LIMITS.file_bytes / 1024} KB per file and ${DIFF_LIMITS.total_chars / 1000}k characters of diff per answer). Omit from and to for the newest version against the one before it. to: "workspace" compares with what is uploaded now (from then defaults to the version the workspace is based on). paths limits it to some files; text: false lists the files only.`,
    inputSchema: obj({
      project: PROJECT,
      from: { type: ['integer', 'string'], description: 'A version number, or "workspace". Default: the version before to (for the workspace, the version it is based on).' },
      to: { type: ['integer', 'string'], description: 'A version number, or "workspace". Default: the newest version.' },
      paths: { type: 'array', items: { type: 'string' }, description: 'Optional. Only these files.' },
      text: { type: 'boolean', description: 'Default true: include line diffs of changed text files.' },
      branch: { ...BRANCH_ARG, description: 'Optional. Which workspace "workspace" means (and the default "to": the branch\'s newest version); omit for main.' },
    }, ['project']), annotations: { readOnlyHint: true },
    run: async (a, c) => {
      const p = await scopedProject(c, a.project), t = await wsTarget(c, p, a.branch, 'read'), line = await lineOf(c, p, t), newest = line.newest;
      const wsSrc = (s0: Source | null): Source | null => (s0 && 'workspace' in s0 && t.branch ? { workspace: true, ws: t.ws, label: t.label } : s0);
      const to: Source = wsSrc(parseSource(a.to, 'to')) ?? (newest ? { version: newest } : wsSrc({ workspace: true })!);
      const fromDefault: Source | null = 'workspace' in to ? ((line.base ?? newest) ? { version: (line.base ?? newest)! } : null) : (to.version > 1 ? { version: to.version - 1 } : null);
      const from = wsSrc(parseSource(a.from, 'from')) ?? fromDefault;
      if (!from) throw bad('There is no earlier version to compare with.', 'Pass from and to, e.g. {from: 1, to: "workspace"}.');
      const [A, B] = await Promise.all([sourceFiles(c.env, p, from), sourceFiles(c.env, p, to)]);
      const only = Array.isArray(a.paths) && a.paths.length ? new Set(a.paths.map((x: unknown) => String(x))) : null;
      const d = diffFiles(only ? A.filter((f) => only.has(f.path)) : A, only ? B.filter((f) => only.has(f.path)) : B);
      const changed: (FileChange & { diff?: string; truncated?: boolean })[] = d.changed.map((f) => ({ ...f }));
      const left: string[] = [];
      let budget = DIFF_LIMITS.total_chars;
      if (a.text !== false) for (const f of changed) {
        if (!isText(f.path)) continue;
        if ((f.bytes_before || 0) > DIFF_LIMITS.file_bytes || (f.bytes_after || 0) > DIFF_LIMITS.file_bytes || budget <= 0) { left.push(f.path); continue; }
        const [x, y] = await Promise.all([readSourceFile(c.env, p, from, f.path), readSourceFile(c.env, p, to, f.path)]);
        const r = x && y ? textDiff(await x.text(), await y.text(), f.path, { maxLines: DIFF_LIMITS.lines_per_file }) : null;
        if (!r || r.diff.length > budget) { left.push(f.path); continue; }
        f.diff = r.diff; if (r.truncated) f.truncated = true;
        budget -= r.diff.length;
      }
      return {
        from: sourceName(from), to: sourceName(to), summary: diffLine(d),
        changed, added: d.added, removed: d.removed, unchanged: d.unchanged,
        ...(left.length ? { diffs_left_out: left, why: `Too big for this answer (over ${DIFF_LIMITS.file_bytes / 1024} KB, or past ${DIFF_LIMITS.total_chars / 1000}k characters of diff in all). Pass paths to see them one at a time, or pull_version both versions and diff them locally.` } : {}),
        next: 'pull_version downloads either side; checkout_version puts a version back into the workspace.',
      };
    },
  },
  {
    name: 'debug_preview', title: 'Open, play and screenshot the preview in a browser',
    description: `A real browser on the game's current preview that you drive step by step, to see what the game looks like and reproduce a bug: take screenshots (JPEG, or lossless PNG and sharp 2× to 4× close-ups to compare art with a reference), click, tap, drag, press and hold keys, type, wait, and read the game's state. action "open" starts a browser on the preview (deploy_preview first) and returns a screenshot; "act" runs steps in it and returns screenshots; "screenshot" takes one; "close" ends it. Every answer includes state: whether the game is ready, frames drawn, uncaught errors, console errors and console warnings the SDK saw, the game's last calls to the platform with the answer to each (platform_calls: a GCP.leaderboard.submit shows as path "score", op "submit", with its HTTP status), missing files, and what the game's GCP.test.onState(fn) returns. Scores the game submits here are kept on the preview's leaderboards under the name "Debugger" (game_data {action: "leaderboard", env: "preview"} reads them). Limits per act call: ${DEBUG_LIMITS.steps} steps, ${DEBUG_LIMITS.shots} screenshots, waits adding up to ${DEBUG_LIMITS.wait_ms / 1000} seconds (one wait step up to 10); a session lasts a few minutes, so play a long round over several act calls. The game runs as a throwaway test player (empty save, never the creator's data; its saves are removed daily). One browser per account at a time; it closes after 3 idle minutes and at most a few minutes after opening. The browser has no GPU: heavy 3D runs slowly and WebGPU is not available, so judge layout, UI and logic here, not frame rate. Also read creator_feedback: the creator may already have marked what is wrong.`,
    inputSchema: obj({
      project: PROJECT,
      action: { type: 'string', enum: ['open', 'act', 'screenshot', 'close'], description: 'open: a new browser on the preview (replaces your open one). act: run steps. screenshot: just a picture. close: end the session.' },
      steps: STEP_SCHEMA,
      viewport: { description: `open only. A preset (${Object.entries(VIEWPORTS).map(([k, v]: [string, any]) => `${k} ${v.width} × ${v.height}${v.width > v.height ? ' landscape' : ' portrait'}${v.touch ? ' touch' : ''}`).join(', ')}; default desktop, ${VIEWPORTS.desktop.width} × ${VIEWPORTS.desktop.height}, the verifier's size; the phone and tablet presets have touch) or {width, height, touch}.`, type: ['string', 'object'] },
      autostart: { type: 'boolean', description: 'open only. Open with ?gcp_autostart=1, so GCP.test.onAutostart skips menus as in verification. Default false: the game starts as a player sees it.' },
      session: { type: 'string', description: 'Optional: the session id from open (your latest one is used otherwise).' },
    }, ['project', 'action']),
    run: async (a, c) => {
      const p = await scopedProject(c, a.project);
      if (a.action === 'close') return closeDebug(c.env, c.user, a.session ? String(a.session) : undefined, p.id);
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
      await scopedProject(c, a.project);
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
    description: 'Makes a verified version live in the marketplace at the game\'s public address. Only versions that passed verification can be published, and the account needs a creator license (get_started shows it). Omit version to publish the newest verified one. Every platform requirement is checked on the server first (verification against today\'s checks, including the playability checks: reacts to input and keeps running through bot play (a score or an ending is optional); playable on computers, tablets and phones, unchanged files, store metadata, storage, the weekly cap on new games (a few new games per account per 7 days, more for well-rated games; updates are never capped), the build skill when shared, originality and content, license and account); a refusal lists every rule that fails with exactly what to fix, and dry_run: true checks without publishing. A new game starts on the store\'s New shelf and moves to the main store by itself once players stick with it; the answer\'s store field says where it stands. Design recommendations (game_standards: cover, orientation, layout, loading screen, sound) are reported as advice and never refuse a version. open_implementation sets whether other developers\' agents may learn how the game is built (never its code) and whether its build skill is in the Creator Store; leave it out to keep the current choice, and ask the user before turning it on. While it is on, every new version needs its build skill written first (build_skill {action: "write", version}), so the skill always matches the live game.',
    inputSchema: obj({ project: PROJECT, version: { type: 'integer', description: 'Version to make live. Default: newest verified.' }, open_implementation: { type: 'boolean', description: 'Optional. true shares how the game is built with other agents (no code); false keeps it private. Omitted: unchanged (off for a new game).' }, dry_run: { type: 'boolean', description: 'Optional. true checks every platform requirement for this version and returns each rule with its status and what to do, without publishing anything.' }, patch_notes: { type: 'object', description: 'Optional, recommended for an update: what changed for players, as { title?, body } (title up to 120 characters, default "Version N"; body plain text up to 5000). Posted on the game page when the version goes live, and players who follow the creator, keep, bought or recently played the game are told under the bell. Write it for players, in the listing\'s language.', properties: { title: { type: 'string' }, body: { type: 'string' } } } }, ['project']),
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
    run: async (a, c) => { const p = await scopedProject(c, a.project); if (p.status !== 'live') throw bad('This game is not live.'); await takeOffline(c.env, p, c.client); return { ok: true, status: 'offline' }; },
  },
  {
    name: 'delete_project', title: 'Delete a project',
    description: 'Deletes one of this account\'s projects so it no longer counts toward the project limit and leaves list_projects. Ask the user first, and name the project to them. Two calls: without confirm it deletes nothing and says what deleting would mean (other players who played it, a price) and the confirm value; with confirm set to the project\'s address (slug) it deletes. A live game is refused (unpublish it first), and so is a game or build skill anyone has bought (buyers keep what they paid for: take it offline instead). The workspace and versions stop being served at once; players\' saves and scores are deleted after 30 days, and until then a platform admin can restore the project.',
    inputSchema: obj({ project: PROJECT, confirm: { type: 'string', description: 'The project\'s slug (its address, shown by list_projects and by the first call). Leave it out to see what would be deleted.' } }, ['project']), annotations: { destructiveHint: true },
    run: async (a, c) => { const p = await scopedProject(c, a.project); return deleteProject(c.env, c.user, p, a.confirm, c.client); },
  },
  {
    name: 'game_data', title: 'Game database: shared data, saves and leaderboards',
    description: 'Manages what the platform database holds for one game, in its preview or live environment (they are kept apart). Shared data is game-wide JSON every player reads with GCP.shared.get(key): use set to seed levels, configuration or a message of the day without server code. Player saves (GCP.save) and stats (GCP.playerStats) are private to each player and game; summary counts and aggregates them (players, sessions, play time, each stat\'s sum, average, min and max) without showing any one player\'s data. Leaderboards are what GCP.leaderboard.submit wrote. Actions: summary, list (shared keys, optional prefix), get, set, delete (one shared key), leaderboard (top rows of a board), clear_leaderboard. Writes take effect for players at once.',
    inputSchema: obj({
      project: PROJECT,
      action: { type: 'string', enum: ['summary', 'list', 'get', 'set', 'delete', 'leaderboard', 'clear_leaderboard'] },
      env: { type: 'string', enum: ['preview', 'live'], description: 'Default live, for every action: a key set with env "preview" is read, listed and deleted with env "preview" too. Previews have their own separate data.' },
      key: { type: 'string', description: 'Shared data key (1 to 120 characters), for get, set and delete.' },
      value: { description: 'Any JSON value, for set. 256 KB at most.' },
      prefix: { type: 'string', description: 'Only keys starting with this, for list.' },
      board: { type: 'string', description: 'Leaderboard name, for leaderboard and clear_leaderboard. Default "default".' },
      order: { type: 'string', enum: ['desc', 'asc'], description: 'For leaderboard: desc (highest first, default) or asc (lowest first, for times).' },
      limit: { type: 'integer', description: 'Rows for leaderboard, 1 to 100. Default 20.' },
    }, ['project', 'action']), annotations: { destructiveHint: true },
    run: async (a, c) => {
      const p = await scopedProject(c, a.project), db = c.env.DB, env = envOf(a.env);
      const scope = `${p.id}${env === 'preview' ? ':preview' : ''}`, key = String(a.key ?? ''), board = String(a.board || 'default').slice(0, 40);
      const needKey = () => { if (!key || key.length > 120) throw bad('key must be a string of 1 to 120 characters.'); };
      // env was left out and nothing was found in live: say when the other environment has it, since previews keep their own data
      const other = env === 'preview' ? 'live' : 'preview', otherScope = `${p.id}${other === 'preview' ? ':preview' : ''}`;
      const otherHint = async (what: 'key' | 'keys') => {
        if (a.env !== undefined) return {};
        const r = what === 'key'
          ? await db.prepare("SELECT 1 AS x FROM saves WHERE project_id = ? AND user_id = '' AND k = ?").bind(otherScope, key).first()
          : await db.prepare("SELECT 1 AS x FROM saves WHERE project_id = ? AND user_id = '' AND k LIKE ? ESCAPE '\\' LIMIT 1").bind(otherScope, String(a.prefix || '').replace(/[\\%_]/g, '\\$&') + '%').first();
        return r ? { hint: `env defaults to "${env}", and ${what === 'key' ? 'this key exists' : 'shared keys exist'} in ${other}. Pass env: "${other}" to ${a.action} ${what === 'key' ? 'it' : 'them'} there.` } : {};
      };
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
          return { env, keys: rows.results.map((r) => ({ key: r.k, bytes: r.bytes, updated_at: new Date(r.updated_at).toISOString() })), ...(rows.results.length ? {} : await otherHint('keys')) };
        }
        case 'get': {
          needKey();
          const r = await db.prepare("SELECT v FROM saves WHERE project_id = ? AND user_id = '' AND k = ?").bind(scope, key).first<{ v: string }>();
          return { env, key, value: r ? JSON.parse(r.v) : null, exists: !!r, ...(r ? {} : await otherHint('key')) };
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
          return { ok: true, env, key, deleted: (r.meta.changes || 0) > 0, ...(r.meta.changes ? {} : await otherHint('key')) };
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
      const p = await scopedProject(c, a.project), env = envOf(a.env), code = String(a.room || 'lobby').slice(0, 40);
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
      + 'action start: target "follow" (default) sends the bots wherever the creator searches or opens a room in their preview (a private lobby only by invite); "invite" keeps them waiting until they are invited; "queue" puts them in a public queue (queue, players, min, teams, mode as the game passes them to GCP.match.find, so they meet the players searching the same); "code" into a private lobby; "room" into a room. Bots alone can fill a match: with target queue and bots >= the queue\'s min the match starts without anyone else, so an agent can run an online match end to end without a browser. '
      + 'status: per bot its phase, round trip (last, median, 95th percentile), snapshots per second and their spacing and jitter, the longest gap, unacknowledged inputs, traffic, reconnects, errors (the match\'s and server/bot.js\'s), plus the fleet\'s log. act: drop (the connection drops and comes back after ms with the same ticket, like the SDK\'s reconnect), reload (comes back after ms like a reloaded page, through GCP.match.rejoin\'s path), spike (extra ms of delay for ms), outage (nothing gets through for ms), net (a new network profile), leave (for good), rejoin; bot "all" or one bot\'s id or name. stop ends the fleet and its sessions. '
      + 'Invites: in the owner\'s preview the running bots are the creator\'s online friends (GCP.friends.list() lists them, busy while in a match; GCP.friends.invite and the picker GCP.friends.open invite them), so the game\'s invite flow can be tested: a bot answers like a friend (GCP.friends.on(\'answer\')), and on yes enters the private lobby through the real invite path, or the room an invite\'s data names ({ room }). action invite does the same from here: bot, and lobby (the match.lobby token) or data ({ room }) and label. status lists the latest answers. '
      + 'Limits: a fleet stops by itself after its minutes; bots per fleet, fleets at once and bot-minutes per day are capped (status shows them).',
    inputSchema: obj({
      project: PROJECT,
      action: { type: 'string', enum: ['options', 'start', 'status', 'act', 'invite', 'stop'], description: 'Default status.' },
      bots: { type: 'integer', description: 'start: how many bots (default 3).' },
      target: { type: 'string', enum: ['follow', 'invite', 'queue', 'code', 'room'], description: 'start: where the bots go. Default follow.' },
      queue: { type: 'string', description: 'start with target queue: the queue name the game uses (default "default").' },
      players: { type: 'integer', description: 'start with target queue (required, no default) or code: the match size the game asks for (GCP.match.find players), 2 to 64.' },
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
      bot: { type: 'string', description: 'act: a bot\'s id or name, or "all" (default). invite: one bot\'s id (bot_…).' },
      lobby: { type: 'string', description: 'invite: the private lobby token the game\'s match has (match.lobby), for a match invite.' },
      label: { type: 'string', description: 'invite: the short line shown with the invite.' },
      data: { description: 'invite: the small JSON value the game sends with its invites, such as { room } for a GCP.room game.' },
      what: { type: 'string', enum: ['drop', 'reload', 'spike', 'outage', 'net', 'leave', 'rejoin'], description: 'act: what to do.' },
      ms: { type: 'integer', description: 'act: how long (drop, reload: until the bot comes back; spike, outage: how long it lasts). Default 5000.' },
      extra: { type: 'integer', description: 'act spike: the extra delay in ms (default 400).' },
    }, ['project']), annotations: { destructiveHint: false },
    run: async (a, c) => {
      const p = await scopedProject(c, a.project), action = a.action || 'status';
      if (action === 'options') return botOptions(c.env, p, c.user);
      if (action === 'start') return startBots(c.env, c.origin, c.user, p.id, a);
      if (action === 'act') return actBots(c.env, c.user, p.id, { bot: a.bot, action: a.what, ms: a.ms, extra: a.extra, net: a.net });
      if (action === 'invite') return inviteBotFor(c.env, c.user, p.id, { bot: a.bot, lobby: a.lobby, label: a.label, data: a.data });
      if (action === 'stop') return stopBots(c.env, c.user, p.id);
      if (action !== 'status') throw bad('action must be options, start, status, act, invite or stop.');
      return botStatus(c.env, c.user, p.id);
    },
  },
  {
    name: 'get_stats', title: 'Players online, analytics and marketplace numbers',
    description: 'Returns how the game is doing. now: players online at this moment (live and preview) and players in multiplayer rooms. analytics, over the last days (default 30, at most 90): sessions, unique, new and returning players, play time with average and median session length, session-length spread, players per day and per hour for the last 24 hours, a breakdown by version, device, browser and operating system, retention (day 1, 7 and 30, weekly cohorts), how long new players\' first session lasted, the store funnel from page views to returning players, and the events the game counts with GCP.track with its gcp.json funnel (pass funnel to try other steps). Every play number is measured by the platform itself (it starts each session, and the page that shows the game checks in every 30 seconds), never taken from the game; what the game reports about itself (whether it reached GCP.ready, the errors it caught) is under analytics.reported_by_game and in runtime_errors, apart from the rest. Also plays, ratings and recent reviews, and sales. Pass only_now: true for just the live counts, which is cheap enough to poll.',
    inputSchema: obj({ project: PROJECT, days: { type: 'integer', description: 'Window for analytics, 1 to 90 days. Default 30.' }, only_now: { type: 'boolean', description: 'Return only players online now and room occupancy.' }, funnel: { type: 'array', items: { type: 'string' }, description: 'Event names in order for the events funnel, instead of the live version\'s gcp.json "funnel".' } }, ['project']), annotations: { readOnlyHint: true },
    run: async (a, c) => {
      if (a.only_now) { const p = await scopedProject(c, a.project); return { status: p.status, ...(await onlineNow(c.env, p.id)) }; }
      const p = await scopedProject(c, a.project), db = c.env.DB;
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
        wishlists: await wishCount(db, p.id, now() - 7 * 86400_000),   // players who wishlisted the game: total, and in the last 7 days
        analytics: await gameAnalytics(c.env, p.id, Number(a.days) || 30, Array.isArray(a.funnel) ? a.funnel.map(String) : undefined),
        console_page: `${c.origin}/console/p/${p.id}/analytics`,
      };
    },
  },
  {
    name: 'build_skill', title: 'Write this game\'s build skill',
    description: `The build skill is an agent skill (a SKILL.md) about how this game is built, written by you, its development agent, so other developers' agents can build a similar game. It is what the game shares in the Creator Store when Open Implementation is on, free or for a price the user sets. Write it from what you know of the game: architecture, rendering and art, the loop and feel, controls and devices, content and progression, platform services, performance, testing and release, and pitfalls. ${NO_CODE} ${ENGLISH_FIRST} A skill is written for one version and the store always shows the one for the live version in the viewer's chosen platform language (falling back to English): before each release, call get, write the canonical English skill (language: "en", default; non-English text is refused), and write faithful translations for all other platform languages (zh, zh-TW, ja, ko, es) either one language per call via language or together via translations. While sharing is on, publish refuses a version whose skill is missing, non-English, or missing any platform language translation. Actions: get (the current skill, language coverage, and the outline), write (content in Markdown, a one-line description, optional language or translations; version defaults to the newest deployed version).`,
    inputSchema: obj({
      project: PROJECT,
      action: { type: 'string', enum: ['get', 'write'] },
      version: { type: 'integer', description: 'The game version the skill describes. Default: the newest deployed version (the one you are about to publish).' },
      language: { type: 'string', enum: [...SKILL_LANGS], description: 'Language for get or write. Default: "en" (canonical English base, required first and English-only). Use "zh", "zh-TW", "ja", "ko" or "es" to read or write one platform translation at a time.' },
      description: { type: 'string', description: 'write: one line in the target language, what the skill helps an agent build (at most 300 characters).' },
      content: { type: 'string', description: 'write: the skill in Markdown in the target language, organised under level-two headings (##), no code. English/Spanish: 600 to 60000 characters; zh/zh-TW/ja/ko: 200 to 30000 characters. The platform adds front matter, title and measured facts.' },
      translations: { type: 'object', description: 'write (with language omitted or "en"): optional map of other platform languages (zh, zh-TW, ja, ko, es) to {description, content}. For long skills, writing one language per call with the language parameter avoids output truncation.' },
    }, ['project', 'action']),
    run: async (a, c) => {
      const p = await scopedProject(c, a.project);
      const v = a.version === undefined || a.version === null ? undefined : Math.round(Number(a.version));
      if (a.action === 'get') return skillForAgent(c.env, c.origin, p, v, typeof a.language === 'string' ? a.language : undefined);
      if (a.action !== 'write') throw bad('action must be get or write.');
      const r = await writeSkill(c.env, p, a, c.client);
      const q = await fresh(c, p.id);
      const missing = r.missing_languages || [];
      return {
        ok: true, ...r,
        matches_live_game: q.live_version === r.version,
        shared: !!q.open_implementation, store_page: `${c.origin}/creator-store/${q.slug}`,
        next: missing.length
          ? `Saved ${r.language} for version ${r.version}. Still missing platform language translations: ${missing.join(', ')}. Call build_skill {project, action: "write", version: ${r.version}, language: "${missing[0]}", description, content} for each remaining language before publishing.`
          : q.live_version === r.version
            ? 'The Creator Store now shows this skill in all platform languages for the live game.'
            : `Saved all platform languages for version ${r.version}. It shows in the Creator Store once version ${r.version} is live: publish {project, version: ${r.version}}.`,
        ...(q.open_implementation ? {} : { not_shared: 'Open Implementation is off, so nothing is shared yet. Ask the user before turning it on (update_project {open_implementation: true}).' }),
      };
    },
  },
  {
    name: 'devlog', title: 'Post news and patch notes on the game page',
    description: 'The game\'s devlog: posts on its store page that players read, announced under the bell to players who follow the creator, keep the game in their library, bought it, or played it in the last 90 days. Actions: list (the newest posts, before for older ones), post (title up to 120 characters and body up to 5000, plain text; at most 3 posts a day per game; the game must be live to announce), edit (id, title, body; no new announcement) and delete (id). Patch notes for an update go with publish {patch_notes} instead, so they appear when the version goes live. Ask the user before posting: it is the creator speaking to players.',
    inputSchema: obj({
      project: PROJECT,
      action: { type: 'string', enum: ['list', 'post', 'edit', 'delete'] },
      id: { type: 'string', description: 'edit and delete: the post\'s id from list.' },
      title: { type: 'string', description: 'post and edit: the headline, up to 120 characters.' },
      body: { type: 'string', description: 'post and edit: plain text with line breaks, up to 5000 characters.' },
      before: { type: 'integer', description: 'list: the created_at of the last post shown, for older ones.' },
    }, ['project', 'action']),
    run: async (a, c) => {
      const p = await scopedProject(c, a.project);
      const guard = async <T>(fn: () => Promise<T>): Promise<T> => { try { return await fn(); } catch (e) { if (e instanceof DevlogError) throw new AppError((e as any).status, e.message, (e as any).code); throw e; } };
      if (a.action === 'list') return { ...(await listDevlogs(c.env.DB, p.id, { before: a.before })), game_page: `${c.origin}/g/${p.slug}#news` };
      if (a.action === 'post') {
        if (p.status !== 'live') throw bad('This game is not live, so nobody would read the post.', 'Publish the game first; for an update, pass patch_notes to publish.');
        const r = await guard(() => publishDevlog(c.env, p, c.user.id, { title: a.title, body: a.body }));
        await logEvent(c.env, p.id, 'devlog', String(a.title || '').slice(0, 120), null, c.client);
        return { ok: true, ...r, game_page: `${c.origin}/g/${p.slug}#news` };
      }
      if (a.action === 'edit') return guard(() => editDevlog(c.env.DB, p.id, a.id, { title: a.title, body: a.body }));
      if (a.action === 'delete') return guard(() => deleteDevlog(c.env.DB, p.id, a.id));
      throw bad('action must be list, post, edit or delete.');
    },
  },
  {
    name: 'playtest', title: 'Playtest the preview with real players',
    description: 'Invite real players to the game\'s preview through a link, ask them up to 5 questions afterwards, and read how each tester played: sessions, minutes, the custom events they reached (GCP.track) and their answers, with an enjoyment score from 1 to 5. Testers\' play is preview play and never counts toward the live game. Actions: list (the game\'s playtests with their links), open (title, optional note on what to try, questions, seats 1 to 500 default 50, days 1 to 30 default 7; needs a verified preview and no other open playtest), close (id) and results (id). Testers play whatever preview is deployed while the playtest is open, so deploy fixes to the preview as you go. Ask the user before opening one: they share the link with their players.',
    inputSchema: obj({
      project: PROJECT,
      action: { type: 'string', enum: ['list', 'open', 'close', 'results'] },
      id: { type: 'string', description: 'close and results: the playtest\'s id from list.' },
      title: { type: 'string', description: 'open: what this round tests, up to 80 characters, e.g. "Level 2 balance".' },
      note: { type: 'string', description: 'open: what testers should try, up to 600 characters.' },
      questions: { type: 'array', items: { type: 'string' }, description: 'open: up to 5 questions asked after playing, each up to 160 characters.' },
      seats: { type: 'integer', description: 'open: how many testers it takes, 1 to 500. Default 50.' },
      days: { type: 'integer', description: 'open: how long it stays open, 1 to 30 days. Default 7.' },
    }, ['project', 'action']),
    run: async (a, c) => {
      const p = await scopedProject(c, a.project);
      const guard = async <T>(fn: () => Promise<T>): Promise<T> => { try { return await fn(); } catch (e) { if (e instanceof PlaytestError) throw new AppError((e as any).status, e.message, (e as any).code); throw e; } };
      const link = (code: string) => `${c.origin}/playtest/${code}`;
      if (a.action === 'list') return { playtests: ((await listPlaytests(c.env.DB, p.id)) as any[]).map((x) => ({ ...x, link: link(x.code) })) };
      if (a.action === 'open') {
        const row = await guard(() => openPlaytest(c.env.DB, p, a));
        await logEvent(c.env, p.id, 'playtest', `Playtest opened: ${row.title} (preview v${row.version})`, null, c.client);
        return { ok: true, id: row.id, link: link(row.code), closes_at: row.closes_at, next: 'Give the user the link to share with their testers. Read results {id} as they play.' };
      }
      if (a.action === 'close') return guard(() => closePlaytest(c.env.DB, p.id, a.id));
      if (a.action === 'results') {
        const pt = await c.env.DB.prepare('SELECT * FROM playtests WHERE id = ? AND project_id = ?').bind(String(a.id || ''), p.id).first();
        if (!pt) throw bad('No playtest with that id on this game.', 'Run playtest {action: "list"} for the ids.');
        return { ...(await playtestResults(c.env.DB, pt)), link: link((pt as any).code) };
      }
      throw bad('action must be list, open, close or results.');
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
    inputSchema: obj({
      game: { type: 'string', description: 'The game slug from find_implementations or its marketplace address (/g/<slug>).' },
      language: { type: 'string', enum: [...SKILL_LANGS], description: 'Optional platform language for the build skill (default: "en", canonical English).' },
    }, ['game']), annotations: { readOnlyHint: true },
    run: async (a, c) => {
      // When project-scoped, do not grant owner/admin bypass on out-of-scope projects of this account.
      const slug = String(a.game || '').trim().replace(/^.*\/(?:g|creator-store)\//, '').replace(/[/?#].*$/, '');
      const target = c.allowedProjects !== null ? await getProject(c.env, slug) : null;
      const reader = c.allowedProjects !== null && target && (target.owner_id === c.user.id || c.user.role === 'admin') && !isProjectAllowed(c.allowedProjects, target.id)
        ? null
        : c.user;
      const card = await implementationCard(c.env, c.origin, reader, a.game);
      // the game's build skill: in full when it is free (or yours, or bought), otherwise where to get it; defaults to English
      const skill = await storeItem(c.env, c.origin, reader, card.game.slug, false, typeof a.language === 'string' ? a.language : 'en').catch(() => null);
      return { ...card, build_skill: !skill ? null : skill.locked
        ? { price: usd(skill.skill.price_cents), sections: skill.skill.sections, version: skill.skill.version, languages: skill.skill.languages, store_page: skill.skill.page, note: 'This build skill is sold. The user can buy it in the Creator Store; it then shows here in full.' }
        : { name: skill.skill.name, version: skill.skill.version, language: skill.active_lang, languages: skill.skill.languages, in_sync: skill.skill.in_sync, written_by: skill.skill.written_by_platform ? 'the platform (the game\'s agent has not written one yet)' : 'the game\'s development agent', skill_md: skill.skill_md, store_page: skill.skill.page, how_to_use: 'Save skill_md as SKILL.md in a folder named after the skill in your skills directory, or follow it directly.' } };
    },
  },
  ...(COLLAB_TOOLS as unknown as Tool[]),
];

/** Unzips an uploaded archive into the workspace. */
/** Unzips into a workspace: main's (ws = the project id) or a branch's. The caller holds the workspace's lease. */
export async function importZip(env: Env, p: Project, zip: Uint8Array, clean: boolean, ws: string = p.id) {
  const s = await getSettings(env);
  // First read only the zip's directory (nothing is unpacked), so a zip that would not fit is refused before it fills memory.
  const sizes: Record<string, number> = {};
  try { unzipSync(zip, { filter: (f) => { sizes[f.name] = f.originalSize; return false; } }); } catch (e) { throw bad(`Not a readable zip file: ${(e as Error).message}`); }
  let names = Object.keys(sizes).filter((n) => !n.endsWith('/') && !n.startsWith('__MACOSX/'));
  // If everything sits in one top-level folder, strip it so index.html lands at the root.
  const tops = new Set(names.map((n) => n.split('/')[0]));
  const strip = tops.size === 1 && names.every((n) => n.includes('/')) && !names.includes('index.html') ? [...tops][0] + '/' : '';
  const target = new Map<string, string>(), skipped: string[] = [];
  for (const n of names) { const path = cleanPath(strip ? n.slice(strip.length) : n); if (path) target.set(n, path); else skipped.push(n); }
  const existing = await listFiles(env, ws), incoming = new Set(target.values());
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
    const before = await readFile(env, ws, MANIFEST).then((f) => f.bytes).catch(() => null);
    const merged = before && mergeManifest(before, entries[zipManifest[0]]);
    if (merged) { entries[zipManifest[0]] = merged.bytes; carried = merged.carried; }
  }
  // the directory's sizes are the zip's own claim: check again with what actually came out
  assertFits(s, p, existing, [...target].map(([n, path]) => ({ path, size: entries[n]?.byteLength ?? 0 })), removing);
  const written: string[] = [];
  for (const [n, path] of target) { await putFile(env, p, path, entries[n], true, ws); written.push(path); }
  const removed: string[] = [];
  for (const path of removing) { await deleteFile(env, ws, path); removed.push(path); }
  const notes = [
    ...(keptManifest ? ['gcp.json is not in the zip, so the workspace copy was kept with its declared build metadata. To remove it, pass delete: ["gcp.json"] to upload_files.'] : []),
    ...(carried.length ? [`The zip's gcp.json leaves out ${carried.join(', ')}, so those were carried over from the workspace copy. To drop one, declare it again with game_metadata.`] : []),
  ];
  return { written, skipped, removed, ...(keptManifest ? { kept: [MANIFEST] } : {}), ...(carried.length ? { carried_over: carried } : {}), ...(notes.length ? { notes } : {}), storage: await storageLine(env, p, await listFiles(env, ws)), next: 'Call deploy_preview (dry_run: true runs only the static checks).' };
}

