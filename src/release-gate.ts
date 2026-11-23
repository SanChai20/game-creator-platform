// The release gate: the platform's requirements for a version to go live, in one place, checked on the server.
//
// Every way a version reaches players passes through here: the publish and rollback tools, an admin approving a review,
// an admin publishing, and a creator putting a game back online from the console. The pipeline runs the gate again right
// before the switch (src/pipeline.ts), so what an agent, a client or a queued job says never matters: a version that
// fails a rule does not go live. Each rule says what failed, why, and what to do about it, and the outcome is stored on
// the version with the ruleset it was judged by.
//
// Admins can waive a waivable rule for one version (with a reason and an end date). Rules that protect players or other
// creators (content, conduct, originality, the files themselves, account standing) can never be waived.
import { AppError, type Env, type Project, type User, type Version } from './env';
import { getSettings, type Settings } from './settings';
import { licenseOf } from './license';
import { ensureVersionMeta, logEvent, versionEligible } from './projects';
import { overBudget } from './storage';
import { skillGate } from './skills';
import { publishGate } from './originality-check';
import { missingToPublish } from '../web/src/tags';
import { now, parseJson } from './util';
import { LANG_NAMES_EN, listingCoverage } from './listing';
import { deviceProblems } from './platform-requirements.js';
import { capGate } from './store-quality';

/** The ruleset's version. Bump it whenever a rule is added or tightened; each stored outcome names the one it used. */
export const RULESET = '2026-11-23.2';

export type GateMode = 'publish' | 'rollback' | 'restore';
export type RuleStatus = 'pass' | 'fail' | 'waived' | 'skipped';
export interface RuleOutcome {
  id: string; title: string; status: RuleStatus; waivable: boolean;
  reason?: string; fix?: string; code?: string; http?: number;
  review?: 'needed' | 'pending' | 'denied';
  missing?: string[];
  waiver?: { reason: string; by: string; until: number };
}
export interface GateResult { ok: boolean; ruleset: string; mode: GateMode; project: string; version: number; checked_at: number; rules: RuleOutcome[]; failures: RuleOutcome[]; waived: string[] }

/**
 * The platform requirements as a list players, creators and admins can read: the same text the console, docs and tools
 * show. These are mandatory. Game design (orientation, layout, cover, loading screen, sound) is never one of them: those
 * are recommendations (src/standards.js, src/platform-requirements.js).
 */
export const RULES: { id: string; title: string; modes: GateMode[]; waivable: boolean; what: string }[] = [
  { id: 'game_status', title: 'The game is allowed on the platform', modes: ['publish', 'rollback', 'restore'], waivable: false, what: 'A game the platform removed cannot go live again until an admin restores it.' },
  { id: 'account', title: 'The creator\'s account is in good standing', modes: ['publish', 'rollback', 'restore'], waivable: false, what: 'A suspended account cannot put games live.' },
  { id: 'license', title: 'The creator has a valid creator license', modes: ['publish', 'rollback', 'restore'], waivable: false, what: 'Publishing needs a creator license while the platform requires one.' },
  { id: 'release_kind', title: 'The release is what it says it is', modes: ['publish', 'rollback', 'restore'], waivable: false, what: 'A rollback only goes back to a version that was live before, and putting a game back online only brings back its last live version. Anything else is a new release and meets every rule.' },
  { id: 'files_kept', title: 'The version\'s files are still kept', modes: ['publish', 'rollback', 'restore'], waivable: false, what: 'Versions older than the platform keeps files for cannot go live.' },
  { id: 'files_intact', title: 'The files are the ones that were verified', modes: ['publish', 'rollback', 'restore'], waivable: false, what: 'Every file of the version is present, the size it was frozen at, and unchanged since.' },
  { id: 'verified', title: 'It passed verification', modes: ['publish', 'rollback', 'restore'], waivable: true, what: 'The automated browser check passed (boots with GCP.ready(), keeps rendering, a real picture, survives input, serves every file, no uncaught errors, stays on the page, keeps running on an emulated iPhone and iPad through taps and a drag, and is playable: it reacts to the player\'s input, keeps running through bot play (random keys, clicks, drags and taps); a score or an ending is optional and only lifts its ranking), or a person approved a version the browser could not run. An admin can waive only checks a verifier can get wrong; boot, conduct, originality and content failures stand.' },
  { id: 'current_checks', title: 'It was verified against today\'s requirements', modes: ['publish'], waivable: true, what: 'A new release must have been checked by every verification check the platform runs today: the frame hand-over (capture, advice only), the phone and tablet pass, and the rest. A version verified before a check existed is deployed again first.' },
  { id: 'every_device', title: 'It is playable on computers, tablets and phones', modes: ['publish'], waivable: false, what: 'Every game on the platform must be playable on every kind of device it supports. requirements.devices lists desktop, tablet and mobile; a computer player can play with a keyboard or a mouse; a phone or tablet player can play by touch (touch controls of the game\'s own, or the platform\'s on-screen controls standing in for its keys). Which way up the game is played (landscape, portrait or both) is the game\'s own design choice and is not part of this.' },
  { id: 'metadata', title: 'Its store metadata is complete', modes: ['publish'], waivable: true, what: 'Genre, 2 to 8 tags, requirements, languages, players and content descriptors are on record.' },
  { id: 'listing_languages', title: 'Its store listing is in every language it is played in', modes: ['publish'], waivable: true, what: 'Everything about the game outside the game follows the player\'s platform language. For every platform language (English, Simplified and Traditional Chinese, Japanese, Korean, Spanish) the version declares in languages, the store listing has the title, and the tagline and description when the game\'s own listing has them, in that language (game_metadata listing_translations; a cover per language is optional, update_project covers).' },
  { id: 'publish_cap', title: 'It fits the creator\'s weekly cap on new games', modes: ['publish'], waivable: true, what: 'A creator can put a few new games live in any 7 days (3 by default), one more for each of their live games that players rate well (5 or more ratings averaging 4 stars), up to 10. Updates to games that are already live are never limited.' },
  { id: 'storage', title: 'It fits the game\'s storage', modes: ['publish'], waivable: false, what: 'All of its files fit the game\'s storage and file count. An admin can give the game more storage instead.' },
  { id: 'build_skill', title: 'Its build skill is up to date', modes: ['publish'], waivable: true, what: 'A game that shares its build skill in the Creator Store has one written for this exact version.' },
  { id: 'original', title: 'It is original work and safe for players', modes: ['publish', 'rollback', 'restore'], waivable: false, what: 'Compared again with every other creator\'s live game right before it goes live, and reviewed for content when it never was. Copies and content that is never allowed are refused.' },
];
const RULE = new Map(RULES.map((r) => [r.id, r]));

/** Verification checks a verifier can get wrong (a slow software GPU, a flaky input pass): an admin may waive these. */
const WAIVABLE_CHECKS = /^(renders|picture|input|responds|files|clean|server|playthrough|capture|pause|two_players|bot_play|input_handled|device_.+)$/;
/** Checks every browser-verified version must carry today. Older reports that lack one are not current. */
export const REQUIRED_CHECKS = ['deployed', 'boots', 'picture', 'files', 'conduct', 'clean', 'capture'];
/** The playability checks (src/verify-core.js), required while verify_playability_required is on. */
export const PLAYABILITY_CHECKS = ['bot_play', 'input_handled'];

interface Check { id: string; ok: boolean; label?: string; detail?: string; hint?: string; soft?: boolean }
interface Report { ok?: boolean; checks?: Check[]; gpuLimited?: boolean; browser?: string; devices?: unknown[]; originality?: unknown }

export interface GateInput {
  mode: GateMode;
  /** Open Implementation as it will be once this release goes live (the publish tool may change it in the same call). */
  openImplementation?: boolean;
  /** Stand-ins for tests; production uses the real checks. */
  deps?: { originality?: (env: Env, p: Project, v: Version) => Promise<string | null>; settings?: Settings; cap?: typeof capGate };
}

/** Whether a version's verification report is current: every check that exists today ran on it, and none only warned. */
export function currentChecks(v: Version, s: Pick<Settings, 'verify_capture_required' | 'verify_devices'> & Partial<Pick<Settings, 'verify_playability_required'>>): { ok: boolean; problems: string[] } {
  const r = parseJson<Report>(v.report, {});
  // A version the verification browser could not run went through a person instead; the review is its check.
  // So does one an admin let qualify by a clean preview session alone (verify_browser_required off).
  if (!(v.status === 'verified' && r.ok)) return { ok: true, problems: [] };
  const checks = Array.isArray(r.checks) ? r.checks : [];
  const ids = new Set(checks.map((c) => c.id)), problems: string[] = [];
  const missing = [...REQUIRED_CHECKS, ...(s.verify_playability_required === false ? [] : PLAYABILITY_CHECKS)].filter((id) => !ids.has(id));
  if (missing.length) problems.push(`its report has no ${missing.join(', ')} check${missing.length > 1 ? 's' : ''} (it was verified before ${missing.length > 1 ? 'they' : 'it'} existed)`);
  // the capture check is advice (the frame hand-over serves the creator's feedback screenshots; how the game draws its
  // interface is the game's choice), so a capture finding never holds a release back: only a report without the check is old
  // the phone and tablet pass: every game must play on phones and tablets, so it is required while the platform runs it
  const profiles = String(s.verify_devices || '').split(',').map((x) => x.trim()).filter(Boolean);
  if (profiles.length && !Array.isArray(r.devices)) problems.push('the phone and tablet pass did not run on it');
  return { ok: !problems.length, problems };
}

/** Files are written just before their version's record; anything this much later was rewritten (as in src/audit.ts). */
const FROZEN_SLACK_MS = 10 * 60 * 1000;

async function filesIntact(env: Env, v: Version): Promise<string | null> {
  const files = parseJson<{ path: string; size: number }[]>(v.files, []), want = new Map(files.map((f) => [f.path, f]));
  const prefix = `v/${v.project_id}/${v.n}/`, seen = new Set<string>(), problems: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 20; page++) {
    const l = await env.FILES.list({ prefix, cursor, limit: 1000 } as R2ListOptions);
    for (const o of l.objects) {
      const path = o.key.slice(prefix.length);
      seen.add(path);
      // the same rules as the bucket audit (src/audit.ts): part of the version, its recorded size, not written after it froze
      const f = want.get(path);
      const why = !f ? 'not part of its version' : f.size !== o.size ? `size differs from the version record (${f.size} recorded)` : o.uploaded.getTime() > v.created_at + FROZEN_SLACK_MS ? 'written after its version was frozen' : null;
      if (why && problems.length < 5) problems.push(`${path}: ${why}`);
    }
    if (!l.truncated) break;
    cursor = (l as { cursor?: string }).cursor;
  }
  for (const p of want.keys()) if (!seen.has(p) && problems.length < 5) problems.push(`${p}: missing`);
  return problems.length ? problems.join('; ') : null;
}

export interface Waiver { project_id: string; version: number; rule: string; reason: string; created_by: string; created_at: number; expires_at: number; revoked_at: number | null }
export async function activeWaivers(env: Env, pid: string, n: number): Promise<Map<string, Waiver>> {
  const rows = await env.DB.prepare('SELECT * FROM release_waivers WHERE project_id = ? AND version = ? AND revoked_at IS NULL AND expires_at > ?').bind(pid, n, now()).all<Waiver>();
  return new Map(rows.results.map((w) => [w.rule, w]));
}

const statusOfRule = (out: RuleOutcome[], id: string) => out.find((r) => r.id === id)?.status;

/** Runs every rule for this release and returns each outcome. Never throws for a failed rule; see assertReleasable. */
export async function releaseGate(env: Env, p: Project, v: Version, input: GateInput): Promise<GateResult> {
  const s = input.deps?.settings || await getSettings(env), mode = input.mode, out: RuleOutcome[] = [];
  const waivers = await activeWaivers(env, p.id, v.n);
  const rule = (id: string, fail: Omit<RuleOutcome, 'id' | 'title' | 'status' | 'waivable'> | null, waivable = RULE.get(id)!.waivable) => {
    const def = RULE.get(id)!;
    if (!def.modes.includes(mode)) { out.push({ id, title: def.title, status: 'skipped', waivable: def.waivable, reason: `Not checked for a ${mode}.` }); return; }
    if (!fail) { out.push({ id, title: def.title, status: 'pass', waivable: def.waivable }); return; }
    const w = waivable ? waivers.get(id) : undefined;
    out.push({ id, title: def.title, waivable, ...fail, status: w ? 'waived' : 'fail', ...(w ? { waiver: { reason: w.reason, by: w.created_by, until: w.expires_at } } : {}) });
  };
  const has = (id: string) => RULE.get(id)!.modes.includes(mode);

  rule('game_status', p.status === 'removed' ? { code: 'removed', http: 403, reason: `This game was removed by the platform${p.removed_reason ? `: ${p.removed_reason}` : '.'}`, fix: 'Contact the platform. Only an admin can restore a removed game.' } : null);

  const owner = await env.DB.prepare('SELECT id, role, status, creator, creator_plan, creator_until, creator_since FROM users WHERE id = ?').bind(p.owner_id).first<Pick<User, 'id' | 'role' | 'status' | 'creator' | 'creator_plan' | 'creator_until' | 'creator_since'>>();
  rule('account', !owner || owner.status !== 'active' ? { code: 'account_suspended', http: 403, reason: 'The creator\'s account is suspended, so its games cannot go live.', fix: 'Contact the platform.' } : null);
  rule('license', s.creator_fee_required && !(owner && licenseOf(owner).active) ? { code: 'license_required', http: 403, reason: 'Publishing needs a valid creator license, and this account has none.', fix: 'Get a creator license at /license, then publish again. Preview stays available meanwhile.' } : null);

  const kind = mode === 'rollback' && !v.published_at ? `Version ${v.n} was never live, so it cannot be rolled back to.`
    : mode === 'restore' && !(p.status === 'offline' && p.live_version === v.n) ? `Only the version that was live when the game went offline can be brought back this way (version ${p.live_version ?? 'none'}${p.status === 'offline' ? '' : `; the game is ${p.status}`}).`
    : null;
  // a version that never passed verification cannot be published either, so the fix says what will work
  const el = versionEligible(v, s.verify_browser_required);
  rule('release_kind', kind ? { code: 'bad_request', http: 400, reason: kind, fix: el.ok ? `Publish version ${v.n} as a new release instead (publish {project, version: ${v.n}}).`
    : `Publishing version ${v.n} as a new release is refused too, because it has not passed verification (see the next item). Fix what list_versions {project, version: ${v.n}} reports, deploy_preview, and publish the new version.` } : null);

  const purged = (v as { purged_at?: number | null }).purged_at;
  rule('files_kept', purged ? { code: 'files_purged', http: 400, reason: `Version ${v.n} is older than the platform keeps files for.`, fix: 'Call deploy_preview to make a new version from the workspace, then publish that.' } : null);
  const broken = purged ? null : await filesIntact(env, v);
  rule('files_intact', broken ? { code: 'files_changed', http: 409, reason: `Version ${v.n}'s files are not the ones that were verified: ${broken}.`, fix: 'Call deploy_preview to make a new version from the workspace, then publish that. If this keeps happening, contact the platform.' } : null);

  // verification, including the review path for versions the browser could not run
  if (el.ok) rule('verified', null);
  else {
    const report = parseJson<Report>(v.report, {}), failed = (report.checks || []).filter((c) => !c.ok);
    const running = v.status === 'queued' || v.status === 'deploying' || v.status === 'verifying';
    // a waiver can only cover a finished check that a verifier can get wrong; boot, conduct, originality and content stand
    const waivable = !el.review && !running && failed.length > 0 && failed.every((c) => WAIVABLE_CHECKS.test(c.id));
    const code = el.review === 'pending' ? 'awaiting_review' : el.review === 'denied' ? 'review_denied' : el.review === 'needed' ? 'review_needed' : 'not_verified';
    const fix = el.review === 'pending' ? 'Nothing to do: the game goes live by itself once a platform admin approves it.'
      : el.review === 'denied' ? 'Fix what the review note says, deploy_preview again, and publish the new version.'
      : el.review === 'needed' ? 'Call publish to ask for the review; it goes live as soon as it is approved.'
      : running ? `Call list_versions {project, version: ${v.n}} again in a few seconds.`
      : `Call list_versions {project, version: ${v.n}} to read the failed checks, fix them, and deploy_preview again.`;
    rule('verified', { code, http: 409, review: el.review, reason: failed.length && !el.review ? `${el.reason} Failed: ${failed.map((c) => `${c.label || c.id}${c.detail ? ` (${String(c.detail).slice(0, 200)})` : ''}${c.hint ? `. To fix: ${String(c.hint).slice(0, 300)}` : ''}`).join('; ')}.` : el.reason, fix }, waivable);
  }

  if (has('current_checks')) {
    const cur = el.ok ? currentChecks(v, s) : { ok: true, problems: [] };
    rule('current_checks', cur.ok ? null : { code: 'verification_outdated', http: 409, reason: `Version ${v.n} was not verified against today's requirements: ${cur.problems.join('; ')}.`, fix: `Call deploy_preview again (retry_version: ${v.n} checks the same files again when it is the newest version), then publish the version it makes.` });
  } else rule('current_checks', null);

  if (has('every_device')) {
    const dp = deviceProblems(parseJson<Record<string, unknown>>(v.manifest, {}));
    rule('every_device', dp.length ? { code: 'devices_unsupported', http: 409, missing: dp.map((x) => x.id), reason: `Version ${v.n} is not playable on every kind of device: ${dp.map((x, i) => `(${i + 1}) ${x.message}`).join(' ')}`, fix: `${dp.map((x, i) => `(${i + 1}) ${x.fix}`).join(' ')} Then publish the new version. Orientation and layout stay your choice.` } : null);
  } else rule('every_device', null);

  if (has('metadata') && s.metadata_required) {
    const { compat, meta } = await ensureVersionMeta(env, v), missing = missingToPublish(meta, compat.declared, JSON.parse(p.tags || '[]'));
    rule('metadata', missing.length ? { code: 'metadata_incomplete', http: 409, missing, reason: `Version ${v.n} cannot be published until its store metadata is complete. Missing: ${missing.join('; ')}.`, fix: 'game_metadata {project} shows the checklist; declare each field with game_metadata {action: "declare", …}. Build fields (requirements, languages, players, content) are frozen with a version, so deploy_preview again after declaring them.' } : null);
  } else rule('metadata', null);

  if (has('listing_languages') && s.metadata_required) {
    const { meta } = await ensureVersionMeta(env, v), cov = listingCoverage(p, meta?.languages);
    const list = cov.missing.map((m) => `${LANG_NAMES_EN[m.lang]} (${m.lang}): ${m.fields.join(', ')}`);
    const example = Object.fromEntries(cov.missing.map((m) => [m.lang, Object.fromEntries(m.fields.map((f) => [f, '…']))]));
    rule('listing_languages', cov.missing.length ? { code: 'listing_untranslated', http: 409, missing: list, reason: `Version ${v.n} is played in ${cov.supported.map((l) => LANG_NAMES_EN[l]).join(', ')}, but the store listing (written in ${cov.lang}) is missing ${list.join('; ')}. Players whose platform language is one of those would see the game's name and description in another language.`, fix: `Translate the listing faithfully and call game_metadata ${JSON.stringify({ project: p.id, action: 'declare', listing_translations: example })}. Set listing_language too if the game's own listing is not in ${cov.lang}. No deploy is needed; publish again afterwards.` } : null);
  } else rule('listing_languages', null);

  const over = has('storage') ? overBudget(s, p, v.bytes, v.file_count) : null;
  if (has('publish_cap')) {
    const cap = await (input.deps?.cap || capGate)(env, s, p, owner?.role);
    rule('publish_cap', cap ? { code: 'publish_cap_reached', http: 429, ...cap } : null);
  } else rule('publish_cap', null);

  rule('storage', over ? { code: 'storage_full', http: 413, reason: `Version ${v.n} does not fit: ${over.message}`, fix: over.hint } : null);

  if (has('build_skill')) {
    const shared = typeof input.openImplementation === 'boolean' ? input.openImplementation : !!p.open_implementation;
    const gate = await skillGate(env, s, { ...p, open_implementation: shared ? 1 : 0 }, v.n);
    rule('build_skill', gate ? { code: 'skill_missing', http: 409, reason: gate, fix: `build_skill {project, action: "get"} returns the current skill and the outline; revise it for what changed and call build_skill {project, action: "write", version: ${v.n}, content}. Then publish again.` } : null);
  } else rule('build_skill', null);

  // the comparison with other creators' live games is the expensive one: it runs once everything else holds
  // (a version waiting to be asked for review still gets it, so the review only ever sees a version that is otherwise ready)
  const blocked = out.some((r) => r.status === 'fail' && !(r.id === 'verified' && r.review === 'needed'));
  if (blocked) out.push({ id: 'original', title: RULE.get('original')!.title, status: 'skipped', waivable: false, reason: 'Runs once the rules above pass.' });
  else {
    const copy = await (input.deps?.originality || publishGate)(env, p, v);
    rule('original', copy ? { code: 'not_original', http: 409, reason: copy, fix: 'Make the game your own (your own code, rules and look; platform templates and kits are fine to start from), then deploy_preview again.' } : null);
  }


  const failures = out.filter((r) => r.status === 'fail');
  return { ok: !failures.length, ruleset: RULESET, mode, project: p.id, version: v.n, checked_at: now(), rules: out, failures, waived: out.filter((r) => r.status === 'waived').map((r) => r.id) };
}

/** Keeps the latest outcome on the version, so the console, admins and agents see why it can or cannot go live. */
export async function recordGate(env: Env, g: GateResult): Promise<void> {
  await env.DB.prepare('UPDATE versions SET gate = ? WHERE project_id = ? AND n = ?').bind(JSON.stringify(g), g.project, g.version).run();
}
/** The outcome recorded on a version by the last check, if any. */
export function storedGate(v: { gate?: string | null }): GateResult | null {
  const g = parseJson<GateResult | null>(v.gate ?? null, null);
  return g && Array.isArray(g.rules) ? { ...g, failures: g.rules.filter((r) => r.status === 'fail') } : null;
}

/** One readable paragraph for the creator: every rule that fails, with what to do. */
export function gateText(g: GateResult): string {
  if (g.ok) return `Version ${g.version} meets every platform requirement (ruleset ${g.ruleset})${g.waived.length ? `; waived by the platform: ${g.waived.join(', ')}` : ''}.`;
  return `Version ${g.version} cannot go live: ${g.failures.length} platform requirement${g.failures.length > 1 ? 's are' : ' is'} not met (ruleset ${g.ruleset}).\n`
    + g.failures.map((f, i) => `${i + 1}. ${f.title} [${f.id}]: ${f.reason}${f.fix ? ` What to do: ${f.fix}` : ''}`).join('\n');
}

/** The error a tool or route answers with: the first failure's code (agents already know them), every failure listed. */
export function gateError(g: GateResult): AppError {
  const first = g.failures[0];
  // one failure already says what to do in the text; repeating it as the hint printed it twice
  return new AppError(first?.http || 409, gateText(g), first?.code || 'requirements_unmet', g.failures.length > 1 ? 'Fix every numbered item above, then publish again. publish {project, version, dry_run: true} checks without publishing.' : undefined);
}

/**
 * A version's build fields (requirements, languages, players, content) are the ones it was deployed with. When the
 * metadata rule fails on fields the workspace gcp.json now declares, say so: otherwise the refusal reads as if the
 * declare had not saved. workspaceMissing is missingToPublish for the workspace. Changes the outcome in place.
 */
export function explainFrozenMeta(f: RuleOutcome | undefined, n: number, workspaceMissing: string[]): string[] {
  if (!f || f.id !== 'metadata' || !f.missing?.length) return [];
  const key = (m: string) => m.split(/[\s:(]/)[0];
  const still = new Set(workspaceMissing.map(key));
  const declared = f.missing.map(key).filter((k) => !still.has(k));
  if (!declared.length) return [];
  const left = f.missing.filter((m) => still.has(key(m)));
  f.reason = `${f.reason} ${declared.join(', ')} ${declared.length > 1 ? 'are' : 'is'} declared now, but after version ${n} was deployed: build fields are frozen with the version they were deployed in, so they apply from the next deploy_preview. Version ${n} keeps what it went out with.`;
  f.fix = `${left.length ? `Declare the rest first (${left.join('; ')}) with game_metadata {action: "declare", …}. Then call` : 'Call'} deploy_preview {project} (no file changes needed), wait for its verification with list_versions {project, version, wait_seconds}, and publish the version it makes.`;
  return declared;
}

/** The view an agent or the console reads: compact, with only what it needs to act. */
export function gateView(g: GateResult) {
  return {
    ok: g.ok, ruleset: g.ruleset, mode: g.mode, version: g.version, checked_at: new Date(g.checked_at).toISOString(),
    rules: g.rules.map((r) => ({ id: r.id, title: r.title, status: r.status, ...(r.reason && r.status !== 'pass' ? { reason: r.reason } : {}), ...(r.fix && r.status === 'fail' ? { fix: r.fix } : {}), ...(r.waiver ? { waived_until: new Date(r.waiver.until).toISOString(), waiver_reason: r.waiver.reason } : {}) })),
  };
}

/** Logged when a release is let through on an admin's waiver, so every exception is on record. */
export async function noteWaivers(env: Env, g: GateResult, actor: string): Promise<void> {
  if (g.ok && g.waived.length) await logEvent(env, g.project, 'release_waived', `Went live with waived rules: ${g.waived.join(', ')} (ruleset ${g.ruleset})`, g.version, actor);
}

export const WAIVER_MAX_DAYS = 30;
/** An admin's waiver: one rule of one version, with a reason a person can read later. */
export async function waive(env: Env, admin: Pick<User, 'id'>, p: Project, n: number, ruleId: string, reason: unknown, days: unknown): Promise<Waiver> {
  const def = RULE.get(ruleId);
  if (!def) throw new AppError(400, `No rule "${ruleId}". Rules: ${RULES.map((r) => r.id).join(', ')}.`, 'bad_request');
  if (!def.waivable) throw new AppError(400, `"${def.title}" cannot be waived: it protects players, other creators or the platform.`, 'not_waivable');
  const why = String(reason ?? '').trim();
  if (why.length < 10) throw new AppError(400, 'Give a reason of at least 10 characters: it stays on record with the release.', 'bad_request');
  const d = days === undefined || days === null || days === '' ? 7 : Math.round(Number(days));
  if (!Number.isFinite(d) || d < 1 || d > WAIVER_MAX_DAYS) throw new AppError(400, `days must be from 1 to ${WAIVER_MAX_DAYS}.`, 'bad_request');
  const v = await env.DB.prepare('SELECT n FROM versions WHERE project_id = ? AND n = ?').bind(p.id, n).first();
  if (!v) throw new AppError(404, `Version ${n} does not exist.`, 'not_found');
  const t = now(), w: Waiver = { project_id: p.id, version: n, rule: ruleId, reason: why.slice(0, 500), created_by: admin.id, created_at: t, expires_at: t + d * 86400000, revoked_at: null };
  await env.DB.prepare('INSERT INTO release_waivers (project_id, version, rule, reason, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(project_id, version, rule) DO UPDATE SET reason = excluded.reason, created_by = excluded.created_by, created_at = excluded.created_at, expires_at = excluded.expires_at, revoked_at = NULL, revoked_by = NULL')
    .bind(w.project_id, w.version, w.rule, w.reason, w.created_by, w.created_at, w.expires_at).run();
  await logEvent(env, p.id, 'waiver_granted', `${ruleId} waived for ${d} day${d > 1 ? 's' : ''}: ${w.reason}`, n, 'admin:' + admin.id);
  return w;
}
export async function unwaive(env: Env, admin: Pick<User, 'id'>, p: Project, n: number, ruleId: string): Promise<boolean> {
  const r = await env.DB.prepare('UPDATE release_waivers SET revoked_at = ?, revoked_by = ? WHERE project_id = ? AND version = ? AND rule = ? AND revoked_at IS NULL').bind(now(), admin.id, p.id, n, ruleId).run();
  if (r.meta.changes) await logEvent(env, p.id, 'waiver_revoked', `${ruleId} no longer waived`, n, 'admin:' + admin.id);
  return !!r.meta.changes;
}
