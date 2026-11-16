// The tools an external agent uses to deploy, verify, publish and manage web games, and to use the platform's services.
// The platform hosts games; it does not tell agents how to make them. Engines, renderers, art and asset
// pipelines are the agent's business. Descriptions say when to call a tool and what comes next.
import { unzipSync } from 'fflate';
import { AppError, bad, forbidden, type Env, type User } from '../env';
import { balanceOf, splitSale } from '../earnings';
import { enqueue } from '../pipeline';
import {
  assetText, checkProject, createProject, defaultImports, deleteFile, ensureCompat, getVersion, listFiles, logEvent, ownedProject, publicVersion,
  putFile, readFile, snapshot, updateProjectMeta, versionEligible, type Issue,
} from '../projects';
import { takeOffline, trialStats } from '../routes/api';
import { trialMinutes } from '../trials';
import type { GameRoom } from '../room';
import { getSettings } from '../settings';
import { gameAnalytics, onlineNow } from '../analytics';
import { publishGate } from '../originality-check';
import { NEVER_SHARED, findImplementations, implementationCard, setOpenImplementation } from '../implementations';
import { THREE_VERSION } from '../generated/runtime-source';
import { BROWSERS, DEVICES, FEATURE_IDS, GRAPHICS, INPUTS, ORIENTATIONS, OSES, describeRequirements, parseRequirements, type Compat, type Requirements } from '../../web/src/compat';
import { addDays, clamp, cleanPath, dayOf, extOf, isText, now, sha256, token as randomToken, unb64, usd } from '../util';

export interface ToolCtx { env: Env; user: User; origin: string; client: string }
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
  { topic: 'contract', file: 'platform-contract', title: 'The platform contract', summary: 'The hard rules, what the platform injects into the page, the SDK, exactly what verification checks, and the optional play-through hook. Read before the first deploy.' },
  { topic: 'versions', file: 'troubleshooting', title: 'Versions and failed verification', summary: 'How previews, versions, publishing and rollback relate, each verification check, why it usually fails, and the fix.' },
  { topic: 'saves', file: 'saves', title: 'Player progress, saves, leaderboards and server code', summary: 'Each player\'s progress: cloud saves and stats per player and game, the play record the platform keeps, shared game data, leaderboards, and optional server code that runs in the game\'s own Worker.' },
  { topic: 'multiplayer', file: 'multiplayer', title: 'Multiplayer rooms', summary: 'Realtime rooms on the platform, the host-authoritative model, snapshots, host migration, turn-based games, and the two-player verification check.' },
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
const sharing = (p: { open_implementation: number }) => (p.open_implementation ? 'on: other agents can read how the live game is built through get_implementation (never its code)' : 'off: nothing about how this game is built is shared');

async function account(c: ToolCtx) {
  const s = await getSettings(c.env), u = c.user, bal = await balanceOf(c.env, u.id);
  return {
    name: u.name, creator_license: !!u.creator,
    can_publish: !!u.creator || !s.creator_fee_required,
    license: u.creator ? 'active' : `Not purchased. Publishing needs a one-time ${usd(s.creator_fee_cents)} creator license (unlimited games). Uploading, previewing and verifying are free. The account owner buys it at ${c.origin}/console`,
    console_url: `${c.origin}/console`,
    earnings: { available: usd(bal.available), pending: usd(bal.pending), withdraw_minimum: usd(s.withdraw_min_cents) },
    paid_games: s.paid_games_enabled ? { platform_cut_percent: s.platform_fee_percent, min_price_cents: s.game_price_min_cents, max_price_cents: s.game_price_max_cents, free_trial: s.trials_enabled ? { max_minutes: s.trial_max_minutes, how: 'update_project trial_minutes' } : 'disabled' } : 'disabled',
    limits: { files_per_bundle: s.bundle_max_files, bundle_bytes: s.bundle_max_bytes, file_bytes: s.file_max_bytes, server_code: s.allow_server_code },
  };
}

async function waitVersion(c: ToolCtx, pid: string, n: number, ms: number) {
  const end = Date.now() + ms;
  let v = await getVersion(c.env, pid, n);
  while (v && RUNNING.includes(v.status) && Date.now() < end) { await sleep(2000); v = await getVersion(c.env, pid, n); }
  return v!;
}

async function versionReport(c: ToolCtx, p: { id: string; slug: string }, n: number, v: Awaited<ReturnType<typeof getVersion>>) {
  const s = await getSettings(c.env);
  if (!v) throw bad(`Version ${n} does not exist. Call list_versions.`);
  const pub = publicVersion(v, c.origin), el = versionEligible(v, s.verify_browser_required);
  // the verifier also measures how finished a game looks; that is the console's business, not a rule agents build to
  if (pub.report && typeof pub.report === 'object') delete (pub.report as Record<string, unknown>).craft;
  const { compat, ...rest } = pub;
  const running = RUNNING.includes(v.status);
  return {
    ...(running ? { not_finished: `Version ${n} is deployed and the browser check is still running (${v.status}). This is normal: it takes one to two minutes. Call list_versions {project, version: ${n}}; it waits for the result. Do not deploy the same files again.` } : {}),
    ...rest, can_publish: el.ok, eligibility: el.reason, compatibility: compatSummary(compat),
    preview_page: `${c.origin}/console/projects/${p.id}`,
    next: running ? `Still ${v.status} (${v.stage}). Call list_versions {project, version: ${n}}; it waits up to 40 seconds for the report.`
      : !el.ok ? 'Fix every failed check in report.checks (each has a hint), upload the changed files, then deploy_preview again. get_started {topic: "versions"} explains each check.'
        : `Verified. A person can play it on the preview page first. To make it live: publish {project, version: ${n}}.`,
  };
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

export const TOOLS: Tool[] = [
  {
    name: 'get_started', title: 'Start here',
    description: `Call this first. ${WEB_ONLY} Returns what the platform does, the rules a game must follow to deploy, the workflow, the account status (creator license, earnings, limits) and the platform services (saves, leaderboards, multiplayer rooms). Pass topic to read one platform guide in full: "contract", "versions", "saves" or "multiplayer". It does not tell you how to make your game; that is up to you.`,
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
        web_games_only: WEB_ONLY,
        what_this_server_does: 'It hosts web games. It takes the files of your game, deploys each version to its own address, checks it in a real browser, publishes it to the marketplace, keeps every version for rollback, and provides player saves, leaderboards and realtime multiplayer rooms. How you make the game (engine or none, renderer, art, hand-made or generated assets, any build tooling on your side) is your choice: the platform neither prescribes nor scores it.',
        rules: [
          'A web page: index.html at the bundle root, plus the files it loads with relative paths. There is no build step on the platform: upload what the browser runs.',
          'Call GCP.ready() once, right after the first playable frame is drawn. GCP is injected by the platform; never bundle or import it.',
          'Run with no uncaught errors, keep rendering frames, and survive keyboard, mouse and touch input. That is what verification checks.',
        ],
        engines: ENGINE_EXPORTS,
        originality: 'After the browser check passes, each version is compared with other creators\' live games, and a copy (even with renamed variables or new titles) cannot be published. Platform templates, kits and common libraries are ignored, so starting from them is fine. An upload that is not a game is refused too. get_started {topic: "versions"} explains both checks.',
        workflow: [
          '1. create_project, once per game.',
          '2. upload_files for text files, small edits and deletions; create_upload_url to send big or binary files, or a whole folder as a zip, with curl.',
          '2b. compatibility: check what the game needs from the player\'s browser (graphics API, GPU, features, input, devices), then declare it. Players see it on the store page and are told before launch whether their browser can run the game.',
          '3. deploy_preview: static checks, then a new numbered version deployed to its own preview address and checked in a real browser. With dry_run: true it runs only the static checks.',
          '4. Read the report. If a check failed, fix it, upload, and deploy_preview again. list_versions {project, version} shows any version\'s report.',
          '5. publish: the verified version goes live in the marketplace. rollback, unpublish and get_stats afterwards. update_project sets the listing, price and cover; game_data and game_room manage the game\'s data and multiplayer rooms.',
        ],
        services: {
          sdk: 'window.GCP, injected into every page. GCP.ready(), GCP.progress(f, label), GCP.fatal(err), GCP.player, GCP.env, GCP.fullscreen(). Every page is opened by a signed-in player, so GCP.player.id is always that player.',
          saves: 'Every game should keep each player\'s progress with the platform: GCP.save.get/set/remove for the player\'s save (JSON), GCP.playerStats.add/max/min/set for numbers worth tracking (levels cleared, coins, best lap), GCP.playRecord() for what the platform recorded on its own (sessions, play time, first and last played). All of it is private to the signed-in player and this game, and preview is kept apart from live; the server enforces it, so a game cannot read another player\'s data. GCP.shared.get reads data every player sees. Load the save before the first playable frame and save at checkpoints and when the tab is hidden. game_data seeds shared data, aggregates saves and stats and manages leaderboards. get_started {topic: "saves"}.',
          leaderboards: 'GCP.leaderboard.submit(board, score, order) and GCP.leaderboard.top(board, n, order). game_data {action: "leaderboard"} reads or clears one.',
          multiplayer: 'GCP.room(code): a realtime room per code on the platform\'s multiplayer servers, with a host and host migration. game_room inspects or resets one. get_started {topic: "multiplayer"}.',
          server_code: s.allow_server_code ? 'Optional server/index.js runs in the game\'s own Worker and is reached with GCP.server. get_started {topic: "saves"}.' : 'Disabled on this platform.',
          open_implementations: `Learn how other developers' live games were built, when they chose to share it: find_implementations searches them by kind of game, engine or technique and shows the patterns across them; get_implementation {game} returns one card (engine, rendering, input, audio, assets, platform services, loop and performance techniques, structure, verified play-through, summary). ${NEVER_SHARED} To share your own, ask the user, then update_project {open_implementation: true} or publish {open_implementation: true}.`,
          compatibility: 'Each version carries its requirements: declared in gcp.json "requirements" (compatibility {action: "declare"} writes it), merged with what the platform detects in the code, frozen at deploy_preview. The store page lists them in a Compatibility section and checks the player\'s browser against them before launch. compatibility {action: "check"} shows what was detected and suggests a block.',
          verification_hooks: 'GCP.test.onPlaythrough(fn) lets the verifier play your rules to the end; GCP.test.onTwoPlayers(fn) checks a two-player session. Both optional. get_started {topic: "contract"}.',
        },
        account: await account(c),
        session: `The access token lasts ${Math.round(Math.max(60, s.oauth_access_ttl_s) / 60)} minutes. When a call answers 401, do not sign in again: POST ${c.origin}/oauth/token with grant_type=refresh_token, refresh_token and client_id, keep the new access_token and refresh_token from the answer, and repeat the call. The whole authorization ends after ${Math.max(1, Math.round(s.oauth_grant_ttl_s / 86400))} days or when the user revokes it. Projects, files and versions stay as they are across all of that.`,
        import_map: { note: 'The platform adds an import map to index.html unless the page has its own, so these bare imports resolve without a bundler. Using them is optional.', entries: defaultImports(c.origin) },
        guides: PLATFORM_GUIDES.map((g) => `${g.topic}: ${g.summary}`),
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
        status: p.status, price: p.price_cents ? usd(p.price_cents) : 'free', free_trial: trialText(p, await getSettings(c.env)), live_version: p.status === 'live' ? p.live_version : null, preview_version: p.preview_version,
        workspace: { files: files.length, bytes: files.reduce((x, f) => x + f.size, 0) },
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
      tags: { type: 'array', items: { type: 'string' }, description: 'Up to 8 genre or mood tags.' },
    }, ['title']),
    run: async (a, c) => {
      const p = await createProject(c.env, c.user, a as any, c.client);
      return { project: p.id, slug: p.slug, title: p.title, console_page: `${c.origin}/console/projects/${p.id}`, next: 'Upload the game: upload_files for text files, create_upload_url for big or binary files or a whole folder. Then deploy_preview.' };
    },
  },
  {
    name: 'update_project', title: 'Update listing, price, cover or sharing',
    description: 'Updates the marketplace listing: title, tagline, description, tags, controls text, price, free trial and cover image. price_cents 0 means free; a positive value makes it a paid game (one-time purchase in US cents), and the platform keeps its cut of each sale. trial_minutes lets players who have not bought a paid game play it for that many minutes in total (counted per account on the server, across reloads and devices) before they are asked to buy; 0 turns the trial off. Only set a price or a trial when the user has chosen them. cover is the workspace path of a png, jpg or webp under 2 MB (ideally 16:9); without one, the verification screenshot is used. open_implementation true lets other developers\' agents learn how the live game is built through get_implementation (engine, rendering, input, techniques, a summary; never code or files); false stops sharing at once. Only set it when the user has chosen to share.',
    inputSchema: obj({
      project: PROJECT, title: { type: 'string' }, tagline: { type: 'string' }, description: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } },
      controls: { type: 'string', description: 'How to play, shown on the game page (keys, touch).' },
      price_cents: { type: 'integer', description: '0 for free, or the price in US cents (e.g. 499 = $4.99).' },
      trial_minutes: { type: 'integer', description: 'Paid games only: minutes of free play before buying (e.g. 30). 0 turns the free trial off. get_started shows the longest allowed.' },
      cover: { type: 'string', description: 'Workspace path of the cover image, e.g. "cover.png".' },
      open_implementation: { type: 'boolean', description: 'Share how the live game is built with other agents (no code). Default off.' },
    }, ['project']),
    run: async (a, c) => {
      const p = await ownedProject(c.env, c.user, a.project);
      let cover: string | undefined;
      if (a.cover) {
        const path = cleanPath(a.cover) || '', ext = extOf(path);
        if (!['png', 'jpg', 'jpeg', 'webp'].includes(ext)) throw bad('The cover must be a png, jpg or webp file.');
        const { row, bytes } = await readFile(c.env, p.id, path);
        if (row.size > 2 * 1024 * 1024) throw bad('The cover must be under 2 MB.');
        const key = `covers/${p.id}-${now().toString(36)}.${ext}`;
        await c.env.FILES.put(key, bytes, { httpMetadata: { contentType: row.ctype } });
        await c.env.DB.prepare('UPDATE projects SET cover_key = ? WHERE id = ?').bind(key, p.id).run();
        cover = `${c.origin}/api/media/${key}`;
      }
      const { cover: _c, open_implementation: open, ...meta } = a;
      await updateProjectMeta(c.env, p, meta);
      if (typeof open === 'boolean') await setOpenImplementation(c.env, p, open, c.client);
      const q = await ownedProject(c.env, c.user, p.id), s = await getSettings(c.env);
      if (a.trial_minutes !== undefined) await logEvent(c.env, p.id, 'trial', Number(a.trial_minutes) > 0 ? `Free trial set to ${Math.round(Number(a.trial_minutes))} min` : 'Free trial turned off', null, c.client);
      return { ok: true, title: q.title, price: q.price_cents ? usd(q.price_cents) : 'free', free_trial: trialText(q, s), creator_receives_per_sale: q.price_cents ? usd(splitSale(q.price_cents, s).net) : null, ...(cover ? { cover } : {}), open_implementation: sharing(q) };
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
      // Every part passed: write.
      const rows = new Map<string, Awaited<ReturnType<typeof putFile>>>();
      for (const [path, bytes] of pending) rows.set(path, await putFile(c.env, p, path, bytes));
      const written = [...new Set(files.map((f) => cleanPath(f.path)!))].map((path) => ({ path, bytes: rows.get(path)!.size, sha: rows.get(path)!.sha }));
      const deleted: string[] = [];
      for (const path of dels) if (await deleteFile(c.env, p.id, String(path))) deleted.push(path);
      return {
        written, edited: edited.map((e) => ({ path: e.path, bytes: rows.get(e.path)!.size, sha: rows.get(e.path)!.sha, replaced: e.replaced })), deleted,
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
        one_file: `curl -fsS -X PUT --data-binary @index.html "${base}?path=index.html"`,
        whole_folder: `zip -qr /tmp/game.zip . -x '.*' && curl -fsS -X POST --data-binary @/tmp/game.zip "${base}/zip"`,
        note: 'Run whole_folder inside the folder that holds index.html. Paths inside the zip become paths in the workspace. Add ?clean=1 to the zip URL to delete workspace files that are not in the zip. Each call prints JSON listing what was written.',
      };
    },
  },
  {
    name: 'list_files', title: 'List workspace files',
    description: 'Lists every file in the project workspace with its size and sha (the first 32 hex characters of its SHA-256), so you can see which local files differ from what was uploaded.',
    inputSchema: obj({ project: PROJECT }, ['project']), annotations: { readOnlyHint: true },
    run: async (a, c) => { const p = await ownedProject(c.env, c.user, a.project), files = await listFiles(c.env, p.id); return { files: files.map((f) => ({ path: f.path, bytes: f.size, sha: f.sha })), total_bytes: files.reduce((x, f) => x + f.size, 0) }; },
  },
  {
    name: 'compatibility', title: 'Declare and check compatibility requirements',
    description: 'What the game needs from the player\'s browser and device: the weakest graphics API it runs with (canvas, webgl, webgl2, webgpu), whether it needs a hardware GPU, required and optional browser features (WebAssembly, Web Audio, pointer lock…), input methods, devices, orientation, memory, minimum browser versions and known issues. The store page shows them in a Compatibility section and checks each player\'s browser against them before launch, so declare what is true. action "check" (default) scans the workspace and returns what the code shows it uses (with the reason for each item), what gcp.json declares, any problems, and a suggested block. action "declare" validates requirements and writes them into gcp.json "requirements" (fields you pass replace those fields; use_detected: true starts from what was detected); they take effect with the next deploy_preview. With version, returns what that version went out with. Without a declaration, the platform publishes what it detected and says so on the store page.',
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
    description: 'Runs the static checks (JavaScript syntax with the exact line, imports that do not resolve, missing files, the GCP.ready() contract, web-only content, size limits), then freezes the workspace as a new numbered version, deploys it to its own preview address and opens it in a real browser to check that it boots, renders, survives input and throws no errors. If the game registered GCP.test.onPlaythrough, the browser also plays it. Returns the report. With dry_run: true only the static checks run and nothing is deployed. The browser check takes one to two minutes; if it is still running after 80 seconds the answer says not_finished and list_versions {project, version} returns the report (do not deploy again meanwhile).',
    inputSchema: obj({ project: PROJECT, note: { type: 'string', description: 'What changed in this version (shown in the version list).' }, dry_run: { type: 'boolean', description: 'Only run the static checks.' } }, ['project']),
    run: async (a, c) => {
      const p = await ownedProject(c.env, c.user, a.project);
      const check = await checkProject(c.env, p, c.origin);
      if (a.dry_run) return { ok: check.ok, files: check.files, bytes: check.bytes, errors: check.errors.map(issueLine), warnings: check.warnings.map(issueLine), next: check.ok ? 'No errors. Call deploy_preview without dry_run.' : 'Fix the errors above, then check again.' };
      if (!check.ok) return { deployed: false, reason: 'Static checks failed, so nothing was deployed.', errors: check.errors.map(issueLine), warnings: check.warnings.map(issueLine), next: 'Fix the errors, then call deploy_preview again.' };
      const busy = await c.env.DB.prepare("SELECT n FROM versions WHERE project_id = ? AND status IN ('queued','deploying','verifying') AND created_at > ?").bind(p.id, now() - 10 * 60000).first<{ n: number }>();
      if (busy) throw new AppError(409, `Version ${busy.n} is still being deployed.`, 'busy', `Call list_versions {project, version: ${busy.n}} and wait for it to finish first.`);
      const v = await snapshot(c.env, p, check.manifest, String(a.note || ''));
      await logEvent(c.env, p.id, 'preview_requested', String(a.note || ''), v.n, c.client);
      await enqueue(c.env, { kind: 'preview', pid: p.id, n: v.n, origin: c.origin, actor: c.client });
      const done = await waitVersion(c, p.id, v.n, 80000);
      return { deployed: true, warnings: check.warnings.map(issueLine), ...(await versionReport(c, p, v.n, done)) };
    },
  },
  {
    name: 'list_versions', title: 'List versions or read one report',
    description: 'Without version: lists the project\'s versions, newest first, with status, whether each can be published, and which is live and which is on preview. With version: returns that version\'s full verification report (each check, uncaught errors, missing files, load time, frame rate, screenshot), waiting up to 40 seconds if it is still being checked.',
    inputSchema: obj({ project: PROJECT, version: { type: 'integer', description: 'Optional. A version number to read in full.' } }, ['project']), annotations: { readOnlyHint: true },
    run: async (a, c) => {
      const p = await ownedProject(c.env, c.user, a.project), s = await getSettings(c.env);
      if (a.version) return versionReport(c, p, Number(a.version), await waitVersion(c, p.id, Number(a.version), 40000));
      const rows = await c.env.DB.prepare('SELECT * FROM versions WHERE project_id = ? ORDER BY n DESC LIMIT 50').bind(p.id).all<any>();
      return { live_version: p.live_version, preview_version: p.preview_version, status: p.status, versions: rows.results.map((v) => ({ version: v.n, note: v.note, status: v.status, summary: v.stage, can_publish: versionEligible(v, s.verify_browser_required).ok, created_at: new Date(v.created_at).toISOString(), live: v.n === p.live_version && p.status === 'live' })) };
    },
  },
  {
    name: 'publish', title: 'Publish a verified version',
    description: 'Makes a verified version live in the marketplace at the game\'s public address. Only versions that passed verification can be published, and the account needs a creator license (get_started shows it). Omit version to publish the newest verified one. open_implementation sets whether other developers\' agents may learn how the game is built (never its code); leave it out to keep the current choice, and ask the user before turning it on.',
    inputSchema: obj({ project: PROJECT, version: { type: 'integer', description: 'Version to make live. Default: newest verified.' }, open_implementation: { type: 'boolean', description: 'Optional. true shares how the game is built with other agents (no code); false keeps it private. Omitted: unchanged (off for a new game).' } }, ['project']),
    run: async (a, c) => {
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
      if (s.creator_fee_required && !c.user.creator) throw forbidden(`Publishing needs the one-time ${usd(s.creator_fee_cents)} creator license.`, `Ask the user to buy it at ${c.origin}/console, then call publish again. Preview stays available meanwhile.`);
      const el = versionEligible(v, s.verify_browser_required);
      if (!el.ok) throw new AppError(409, el.reason, 'not_verified', `Call list_versions {project, version: ${v.n}} to read the failed checks, fix them, and deploy_preview again.`);
      if (!p.tagline && !p.description) await updateProjectMeta(c.env, p, { tagline: p.title });
      const copy = await publishGate(c.env, p, v);
      if (copy) throw new AppError(409, copy, 'not_original', 'Make the game your own (your own code, rules and look; platform templates and kits are fine to start from), then deploy_preview again.');
      if (typeof a.open_implementation === 'boolean') await setOpenImplementation(c.env, p, a.open_implementation, c.client, false);
      await logEvent(c.env, p.id, 'publish_requested', '', v.n, c.client);
      await enqueue(c.env, { kind: 'publish', pid: p.id, n: v.n, origin: c.origin, actor: c.client });
      const end = Date.now() + 45000;
      let q = await ownedProject(c.env, c.user, p.id);
      while (!(q.status === 'live' && q.live_version === v.n) && Date.now() < end) { await sleep(2000); q = await ownedProject(c.env, c.user, p.id); }
      const live = q.status === 'live' && q.live_version === v.n;
      return { live, version: v.n, compatibility: compatSummary(await ensureCompat(c.env, v)), game_page: `${c.origin}/g/${p.slug}`, price: q.price_cents ? usd(q.price_cents) : 'free', free_trial: trialText(q, await getSettings(c.env)), open_implementation: sharing(q), next: live ? 'The game is live. Share the game page with the user.' : 'Going live is taking longer than usual (a first deploy needs a minute). Call list_projects {project} in a little while to confirm.' };
    },
  },
  {
    name: 'rollback', title: 'Roll back to an earlier version',
    description: 'Makes an earlier verified version live again. list_versions shows which ones can be published.',
    inputSchema: obj({ project: PROJECT, version: { type: 'integer' } }, ['project', 'version']),
    run: async (a, c) => { if (a.version === undefined || a.version === null) throw bad('version is required.', 'Call list_versions to pick the version to go back to.'); return TOOLS.find((t) => t.name === 'publish')!.run(a, c); },
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
    }, ['project', 'action']),
    run: async (a, c) => {
      const p = await ownedProject(c.env, c.user, a.project), db = c.env.DB, env = envOf(a.env);
      const scope = `${p.id}${env === 'preview' ? ':preview' : ''}`, key = String(a.key ?? ''), board = String(a.board || 'default').slice(0, 40);
      const needKey = () => { if (!key || key.length > 120) throw bad('key must be a string of 1 to 120 characters.'); };
      switch (a.action) {
        case 'summary': {
          const [shared, saves, boards, records, stats] = await Promise.all([
            db.prepare("SELECT COUNT(*) AS keys, COALESCE(SUM(LENGTH(v)), 0) AS bytes FROM saves WHERE project_id = ? AND user_id = ''").bind(scope).first<{ keys: number; bytes: number }>(),
            db.prepare("SELECT COUNT(DISTINCT user_id) AS players, COUNT(*) AS keys, COALESCE(SUM(LENGTH(v)), 0) AS bytes FROM saves WHERE project_id = ? AND user_id != ''").bind(scope).first<{ players: number; keys: number; bytes: number }>(),
            db.prepare('SELECT board, COUNT(*) AS entries, MAX(updated_at) AS last_at FROM scores WHERE project_id = ? GROUP BY board ORDER BY board').bind(scope).all<{ board: string; entries: number; last_at: number }>(),
            db.prepare('SELECT COUNT(*) AS players, COALESCE(SUM(sessions), 0) AS sessions, COALESCE(SUM(seconds), 0) AS seconds FROM player_games WHERE project_id = ?').bind(scope).first<{ players: number; sessions: number; seconds: number }>(),
            db.prepare("SELECT name, COUNT(*) AS players, SUM(value) AS sum, AVG(value) AS avg, MIN(value) AS min, MAX(value) AS max FROM player_stats WHERE project_id = ? AND user_id NOT LIKE 'verify:%' GROUP BY name ORDER BY players DESC, name LIMIT 64").bind(scope).all<{ name: string; players: number; sum: number; avg: number; min: number; max: number }>(),
          ]);
          return {
            env, shared_data: shared, player_saves: saves, leaderboards: boards.results.map((b) => ({ board: b.board, entries: b.entries, last_submit: new Date(b.last_at).toISOString() })),
            player_records: records, player_stats: stats.results,
            note: 'Player saves, stats and records are counted and aggregated here, never shown per player.',
            limits: { value_bytes: 256 * 1024, save_keys_per_player: 64, stats_per_player: 64 },
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
          if (v.length > 256 * 1024) throw bad('Value too large (256 KB max per key).');
          await db.prepare("INSERT INTO saves (project_id, user_id, k, v, updated_at) VALUES (?, '', ?, ?, ?) ON CONFLICT(project_id, user_id, k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at").bind(scope, key, v, now()).run();
          await logEvent(c.env, p.id, 'data_set', `${env}: ${key}`, null, c.client);
          return { ok: true, env, key, bytes: v.length, read_it_with: `await GCP.shared.get(${JSON.stringify(key)})` };
        }
        case 'delete': {
          needKey();
          const r = await db.prepare("DELETE FROM saves WHERE project_id = ? AND user_id = '' AND k = ?").bind(scope, key).run();
          return { ok: true, env, key, deleted: (r.meta.changes || 0) > 0 };
        }
        case 'leaderboard': {
          const asc = a.order === 'asc';
          const rows = await db.prepare(`SELECT name, score, updated_at FROM scores WHERE project_id = ? AND board = ? ORDER BY score ${asc ? 'ASC' : 'DESC'} LIMIT ?`).bind(scope, board, clamp(Number(a.limit) || 20, 1, 100)).all<{ name: string; score: number; updated_at: number }>();
          return { env, board, order: asc ? 'asc' : 'desc', rows: rows.results.map((r, i) => ({ rank: i + 1, name: r.name, score: r.score, at: new Date(r.updated_at).toISOString() })) };
        }
        case 'clear_leaderboard': {
          const r = await db.prepare('DELETE FROM scores WHERE project_id = ? AND board = ?').bind(scope, board).run();
          await logEvent(c.env, p.id, 'leaderboard_cleared', `${env}: ${board}`, null, c.client);
          return { ok: true, env, board, removed: r.meta.changes || 0 };
        }
        default: throw bad('action must be summary, list, get, set, delete, leaderboard or clear_leaderboard.');
      }
    },
  },
  {
    name: 'game_room', title: 'Multiplayer room: inspect or reset',
    description: 'Looks inside one of the game\'s realtime multiplayer rooms, the ones players join with GCP.room(code): who is connected, who is the host, and the world snapshot the host stored. reset clears the snapshot (with kick: true it also disconnects everyone, who can rejoin at once); use it when a room is stuck on a bad state. Rooms are per environment and per code; an empty room keeps nothing. get_started {topic: "multiplayer"} explains the room model.',
    inputSchema: obj({
      project: PROJECT,
      room: { type: 'string', description: 'The room code the game passed to GCP.room(code). Default "lobby".' },
      env: { type: 'string', enum: ['preview', 'live'], description: 'Default live.' },
      action: { type: 'string', enum: ['inspect', 'reset'], description: 'Default inspect.' },
      kick: { type: 'boolean', description: 'For reset: also disconnect everyone in the room.' },
    }, ['project']),
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
    name: 'get_stats', title: 'Players online, analytics and marketplace numbers',
    description: 'Returns how the game is doing. now: players online at this moment (live and preview) and players in multiplayer rooms. analytics, over the last days (default 30, at most 90): sessions, unique, new and returning players, play time with average and median session length, session-length spread, players per day and per hour for the last 24 hours, a breakdown by version, device, browser and operating system, and the errors real players hit. Also plays, ratings and recent reviews, and sales. Pass only_now: true for just the live counts, which is cheap enough to poll.',
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
        runtime_errors: errors.results, recent_reviews: reviews.results,
        analytics: await gameAnalytics(c.env, p.id, Number(a.days) || 30),
        console_page: `${c.origin}/console/p/${p.id}/analytics`,
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
    run: async (a, c) => implementationCard(c.env, c.origin, c.user, a.game),
  },
];

/** Unzips an uploaded archive into the workspace. */
export async function importZip(env: Env, user: User, projectId: string, zip: Uint8Array, clean: boolean) {
  const p = await ownedProject(env, user, projectId);
  let entries: Record<string, Uint8Array>;
  try { entries = unzipSync(zip); } catch (e) { throw bad(`Not a readable zip file: ${(e as Error).message}`); }
  let names = Object.keys(entries).filter((n) => !n.endsWith('/') && !n.startsWith('__MACOSX/'));
  // If everything sits in one top-level folder, strip it so index.html lands at the root.
  const tops = new Set(names.map((n) => n.split('/')[0]));
  const strip = tops.size === 1 && names.every((n) => n.includes('/')) && !names.includes('index.html') ? [...tops][0] + '/' : '';
  const written: string[] = [], skipped: string[] = [];
  for (const n of names) {
    const path = cleanPath(strip ? n.slice(strip.length) : n);
    if (!path) { skipped.push(n); continue; }
    await putFile(env, p, path, entries[n]);
    written.push(path);
  }
  let removed: string[] = [];
  if (clean) { const keep = new Set(written); for (const f of await listFiles(env, p.id)) if (!keep.has(f.path)) { await deleteFile(env, p.id, f.path); removed.push(f.path); } }
  return { written, skipped, removed, next: 'Call deploy_preview (dry_run: true runs only the static checks).' };
}
