// Projects, workspace files, static checks and version snapshots. Used by the MCP tools and the console API.
import { parse } from 'acorn';
import { AppError, bad, forbidden, notFound, type Env, type Project, type User, type Version } from './env';
import { getSettings } from './settings';
import { saleOf } from './sales';
import { assertFits, overBudget } from './storage';
import { THREE_VERSION } from './generated/runtime-source';
import { hasConflictMarkers } from './collab-core';
import { cleanPath, extOf, isText, now, parseJson, rid, sha256, slugify, typeOf } from './util';

import { WEB_ONLY_HINT, nonWebContent, nonWebPage } from './web-only.js';
import { regionBlockedRefs, regionWarning } from './region-hosts.js';
// @ts-ignore plain JS module
import { botContract, botIssues } from './bot-contract.js';
import { checkStandards, findingLine } from './standards.js';
import { deviceProblems } from './platform-requirements.js';
// @ts-ignore plain JS module
import { parseAchievements } from './achievements.js';
// @ts-ignore plain JS module
import { parseFunnel } from './events.js';
// @ts-ignore plain JS module shared with the tests
import { apiFindings, deviceIssues, syntaxFindings } from './device-checks.js';
import { buildCompat, type Compat, type CompatIssue } from '../web/src/compat';
import { buildControls, type TouchControls } from '../web/src/touch-controls';
import { buildMeta, genreTags, genresOf, normGenre, GENRES, type Genre, type MetaIssue, type MetaRecord } from '../web/src/gamemeta';
import { listingLangCode, parseListings } from '../web/src/languages';
import { MAX_TAGS, normalizeStoredTags, parseTags, TAG_GROUPS, tagsOnly, type TagIssue } from '../web/src/tags';

export const wsKey = (pid: string, path: string) => `ws/${pid}/${path}`;
export const verKey = (pid: string, n: number, path: string) => `v/${pid}/${n}/${path}`;

export async function logEvent(env: Env, pid: string, kind: string, detail = '', version: number | null = null, actor = 'system') {
  await env.DB.prepare('INSERT INTO events (project_id, kind, detail, version, actor, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(pid, kind, detail.slice(0, 500), version, actor.slice(0, 80), now()).run();
}

export async function getProject(env: Env, idOrSlug: string): Promise<Project | null> {
  // an id always wins over a slug, so a game whose address happens to spell another game's id can never shadow it
  return (await env.DB.prepare('SELECT * FROM projects WHERE id = ?').bind(idOrSlug).first<Project>())
    || env.DB.prepare('SELECT * FROM projects WHERE slug = ?').bind(idOrSlug).first<Project>();
}
export async function ownedProject(env: Env, user: User, idOrSlug: string): Promise<Project> {
  const p = await getProject(env, idOrSlug);
  if (!p || p.status === 'removed' && user.role !== 'admin') throw notFound(`No project "${idOrSlug}". Call list_projects to see yours.`);
  if (p.owner_id !== user.id && user.role !== 'admin') throw forbidden('That project belongs to someone else.');
  return p;
}

export async function createProject(env: Env, user: User, input: { title: string; slug?: string; tagline?: string; description?: string; tags?: string[] }, actor = 'console'): Promise<Project> {
  const s = await getSettings(env);
  if (s.creator_fee_for_projects && !user.creator) throw forbidden('A valid creator license is required before creating projects.', 'Call get_started to see the account status and where the user gets a license.');
  const title = String(input.title || '').trim().slice(0, 80);
  if (title.length < 2) throw bad('title must be at least 2 characters.');
  const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM projects WHERE owner_id = ? AND status != 'removed'").bind(user.id).first<{ n: number }>();
  if ((count?.n || 0) >= s.projects_per_user) throw forbidden(`Project limit reached (${s.projects_per_user}).`);
  let slug = slugify(input.slug || title) || 'game';
  if (slug.length < 3) slug = `${slug}-game`;
  if (await env.DB.prepare('SELECT 1 FROM projects WHERE slug = ?1 OR id = ?1').bind(slug).first()) slug = `${slug.slice(0, 40)}-${rid(4)}`;
  const id = rid(10), t = now();
  await env.DB.prepare('INSERT INTO projects (id, owner_id, slug, title, tagline, description, tags, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(id, user.id, slug, title, String(input.tagline || '').slice(0, 140), String(input.description || '').slice(0, 4000), JSON.stringify(chooseTags(input.tags)), t, t).run();
  await logEvent(env, id, 'created', title, null, actor);
  return (await getProject(env, id))!;
}
/** The platform tag list, grouped, for refusals and tool descriptions. */
export const TAG_LIST_TEXT = Object.entries(TAG_GROUPS).map(([g, l]) => `${g}: ${l.join(', ')}`).join('; ');
const tagRefusal = (unknown: TagIssue[]) => bad(
  `Tags come from the platform list. ${unknown.map((u) => `"${u.word}" is not on it${u.suggestions.length ? ` (closest: ${u.suggestions.join(', ')})` : ''}`).join('; ')}.`,
  `Pick up to ${MAX_TAGS} that describe the game. ${TAG_LIST_TEXT}. Genres (${GENRES.join(', ')}) go in genre and genres.`);
/** Tags an agent chose: on the platform list or refused. Genres named among them lead, the first as the primary genre. */
export function chooseTags(raw: unknown): string[] {
  const r = parseTags(raw);
  if (r.unknown.length) throw tagRefusal(r.unknown);
  if (r.tags.length > MAX_TAGS) throw bad(`At most ${MAX_TAGS} tags besides the genres (got ${r.tags.length}).`, 'Keep the ones a player would filter by.');
  return r.genres.length ? genreTags(r.genres[0], r.genres.slice(1, 3), r.tags) : r.tags;
}

export async function updateProjectMeta(env: Env, p: Project, input: Record<string, unknown>) {
  const sets: string[] = [], vals: unknown[] = [];
  const put = (col: string, v: unknown) => { sets.push(`${col} = ?`); vals.push(v); };
  if (typeof input.title === 'string' && input.title.trim().length >= 2) put('title', input.title.trim().slice(0, 80));
  if (typeof input.tagline === 'string') put('tagline', input.tagline.slice(0, 140));
  if (typeof input.description === 'string') put('description', input.description.slice(0, 4000));
  if (typeof input.controls === 'string') put('controls', input.controls.slice(0, 1000));
  // Genres: the primary genre is the first tag (the store groups games by it), then up to two secondary genres, then
  // tags from the platform list. Tags a game carried before the list existed are mapped or dropped when it next changes.
  let tags: string[] | null = null, tagGenres: Genre[] = [];
  const stored = normalizeStoredTags(JSON.parse(p.tags || '[]'));
  if (input.tags !== undefined) {
    const r = parseTags(input.tags);
    if (r.unknown.length) throw tagRefusal(r.unknown);
    if (r.tags.length > MAX_TAGS) throw bad(`At most ${MAX_TAGS} tags besides the genres (got ${r.tags.length}).`, 'Keep the ones a player would filter by.');
    tags = r.tags; tagGenres = r.genres;
    const cur = genresOf(stored), primary = cur.primary ?? tagGenres[0];
    if (primary && input.genre === undefined && input.genres === undefined) tags = genreTags(primary, tagGenres.length ? tagGenres.filter((g) => g !== primary) : cur.secondary, r.tags);
  }
  if (input.genre !== undefined || input.genres !== undefined) {
    const cur = genresOf(stored);
    const primary = input.genre !== undefined ? normGenre(input.genre) : cur.primary ?? tagGenres[0] ?? null;
    if (input.genre !== undefined && !primary) throw bad(`genre "${input.genre}" is not one of the platform genres.`, `Genres: ${GENRES.join(', ')}. Put anything more specific in tags.`);
    const secondary: Genre[] = [];
    for (const g of Array.isArray(input.genres) ? input.genres : input.genres === undefined ? (tagGenres.length ? tagGenres.filter((x) => x !== primary) : cur.secondary) : []) { const n = normGenre(g); if (!n) throw bad(`"${g}" in genres is not one of the platform genres.`, `Genres: ${GENRES.join(', ')}.`); if (!secondary.includes(n)) secondary.push(n); }
    if (secondary.length > 2) throw bad('At most two secondary genres.');
    if (!primary) throw bad('Set genre (the primary genre) before secondary genres.');
    const free = tagsOnly(tags ?? stored);
    tags = genreTags(primary, secondary, free);
  }
  if (tags) put('tags', JSON.stringify(tags));
  if (input.listing_translations !== undefined) {
    const parsed = parseListings(input.listing_translations);
    const errs = parsed.issues.filter((i) => i.level === 'error');
    if (errs.length) throw bad(errs.map((i) => i.message + (i.hint ? ` ${i.hint}` : '')).join(' · '));
    const cur = JSON.parse(p.listing_i18n || '{}') as Record<string, Record<string, string>>;
    // a language's cover (update_project covers) stays when its text is replaced; null removes the language, cover too
    for (const [k, v] of Object.entries(parsed.value)) { if (v === null) delete cur[k]; else if (!Object.keys(v).length && !cur[k]?.cover_key) delete cur[k]; else cur[k] = { ...v, ...(cur[k]?.cover_key ? { cover_key: cur[k].cover_key } : {}) }; }
    put('listing_i18n', JSON.stringify(cur));
  }
  // the language the project's own listing (title, tagline, description, controls, cover) is written in
  if (input.listing_language !== undefined) {
    if (input.listing_language === null || input.listing_language === '') put('listing_lang', null);
    else {
      const l = listingLangCode(input.listing_language);
      if (!l) throw bad(`listing_language "${input.listing_language}" is not a language code.`, 'Use the language the title, tagline and description are written in: en, zh, zh-TW, ja, ko, es (or another BCP 47 code).');
      put('listing_lang', l);
    }
  }
  if (input.price_cents !== undefined) {
    const s = await getSettings(env), price = Math.round(Number(input.price_cents));
    if (!Number.isFinite(price) || price < 0) throw bad('price_cents must be 0 (free) or a positive number of US cents.');
    if (price > 0) {
      if (!s.paid_games_enabled) throw forbidden('Paid games are turned off on this platform. Set price_cents to 0.');
      if (price < s.game_price_min_cents || price > s.game_price_max_cents) throw bad(`A paid game must cost between ${s.game_price_min_cents} and ${s.game_price_max_cents} cents. Use 0 for a free game.`);
    }
    if (price !== p.price_cents) {
      // The regular price is the struck-through "was" price of a running sale, so it stays put until the sale ends;
      // a price that goes up starts the wait before the next sale (src/sales.ts).
      if (saleOf(p)) throw bad('This game is on sale. End the sale before changing its regular price.');
      if (price > p.price_cents && p.price_cents > 0) put('price_raised_at', now());
    }
    put('price_cents', price);
  }
  if (input.trial_minutes !== undefined && input.trial_minutes !== null) {
    const s = await getSettings(env), mins = Math.round(Number(input.trial_minutes));
    if (!Number.isFinite(mins) || mins < 0) throw bad('trial_minutes must be 0 (no free trial) or a whole number of minutes.');
    if (mins > 0) {
      if (!s.trials_enabled) throw forbidden('Free trials are turned off on this platform. Set trial_minutes to 0.');
      if (mins > s.trial_max_minutes) throw bad(`A free trial can be at most ${s.trial_max_minutes} minutes.`);
      const price = input.price_cents !== undefined ? Math.round(Number(input.price_cents)) : p.price_cents;
      if (!(price > 0)) throw bad('Only a paid game can have a free trial. Set a price first (price_cents), then the trial.');
    }
    put('trial_minutes', mins);
  }
  if (!sets.length) return;
  put('updated_at', now());
  await env.DB.prepare(`UPDATE projects SET ${sets.join(', ')} WHERE id = ?`).bind(...vals, p.id).run();
}

// ---------------------------------------------------------------------------------------------
// Workspace files
// ---------------------------------------------------------------------------------------------
export interface FileRow { path: string; size: number; sha: string; ctype: string; updated_at: number }

export async function listFiles(env: Env, pid: string): Promise<FileRow[]> {
  return (await env.DB.prepare('SELECT path, size, sha, ctype, updated_at FROM files WHERE project_id = ? ORDER BY path').bind(pid).all<FileRow>()).results;
}

/**
 * Writes one workspace file. `budgetChecked`: the caller already checked the whole change against the game's storage.
 * `ws`: the workspace, the project id for main or "<project>~<branch id>" for a branch (src/collab.ts).
 */
export async function putFile(env: Env, p: Project, rawPath: string, bytes: Uint8Array, budgetChecked = false, ws: string = p.id): Promise<FileRow> {
  const s = await getSettings(env);
  const path = cleanPath(rawPath);
  if (!path) throw bad(`Path not allowed: "${rawPath}".`, `Use relative paths like "index.html" or "src/game.js" with a web file extension (html, js, css, json, png, jpg, webp, svg, mp3, ogg, wav, glb, wasm, woff2, data, pck, …). ${WEB_ONLY_HINT}`);
  const what = nonWebContent(bytes, path);
  if (what) throw bad(`${path} is ${what}, not a web file. This platform hosts web games only.`, WEB_ONLY_HINT);
  if (!budgetChecked) assertFits(s, p, await listFiles(env, ws), [{ path, size: bytes.byteLength }]);
  const row: FileRow = { path, size: bytes.byteLength, sha: (await sha256(bytes)).slice(0, 32), ctype: typeOf(path) || 'application/octet-stream', updated_at: now() };
  await env.FILES.put(wsKey(ws, path), bytes, { httpMetadata: { contentType: row.ctype } });
  await env.DB.batch([
    env.DB.prepare('INSERT INTO files (project_id, path, size, sha, ctype, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(project_id, path) DO UPDATE SET size = excluded.size, sha = excluded.sha, ctype = excluded.ctype, updated_at = excluded.updated_at')
      .bind(ws, path, row.size, row.sha, row.ctype, row.updated_at),
    env.DB.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').bind(row.updated_at, p.id),
  ]);
  return row;
}

export async function readFile(env: Env, pid: string, path: string): Promise<{ row: FileRow; bytes: Uint8Array }> {
  const row = await env.DB.prepare('SELECT path, size, sha, ctype, updated_at FROM files WHERE project_id = ? AND path = ?').bind(pid, path).first<FileRow>();
  const obj = row && await env.FILES.get(wsKey(pid, path));
  if (!row || !obj) throw notFound(`No file "${path}" in this project. Call list_files.`);
  return { row, bytes: new Uint8Array(await obj.arrayBuffer()) };
}

export async function deleteFile(env: Env, pid: string, path: string): Promise<boolean> {
  const r = await env.DB.prepare('DELETE FROM files WHERE project_id = ? AND path = ?').bind(pid, path).run();
  await env.FILES.delete(wsKey(pid, path));
  return (r.meta.changes || 0) > 0;
}

export async function assetJson<T>(env: Env, path: string): Promise<T> {
  const r = await env.ASSETS.fetch(new Request('https://assets.local' + path));
  if (!r.ok) throw new AppError(500, `Missing platform asset ${path}`);
  return r.json<T>();
}
export async function assetText(env: Env, path: string): Promise<string | null> {
  const r = await env.ASSETS.fetch(new Request('https://assets.local' + path));
  if (!r.ok || (r.headers.get('content-type') || '').includes('text/html') && !path.endsWith('.html')) return null;
  return r.text();
}

// ---------------------------------------------------------------------------------------------
// Manifest + import map
// ---------------------------------------------------------------------------------------------
export interface Manifest {
  imports: Record<string, string>;
  three: string;
  orientation?: string;
  usesWebGPU?: boolean;
  minSafari?: number;            // the oldest Safari (iPhone, iPad) that can load all of the code, when newer than the baseline (src/device-checks.js)
  hasServer?: boolean;
  hasMatch?: boolean;            // server/match.js: server-run matches
  bots?: { online: boolean; match: boolean; room: boolean; invites: boolean; file: boolean; hooks: { think: boolean; actions: boolean; room: boolean; invite: boolean } };   // the test-bot contract (bot-contract.js)
  /** What this version needs from the player's browser: declared in gcp.json "requirements", merged with what the code shows. */
  compat?: Compat;
  /** The build layer of the game metadata: languages, players, session, progress, accessibility, content and the age rating. */
  meta?: MetaRecord;
  /** On-screen controls for touch screens: gcp.json "controls" laid over the keys found in the code. */
  controls?: TouchControls;
  /** Achievements this version declares (gcp.json "achievements", src/achievements.js). */
  /** Custom event names in funnel order (gcp.json "funnel", src/events.js), for the console's analytics. */
  funnel?: string[];
  /** Player-made levels (src/levels.js): gcp.json "levels": true, or code that calls GCP.levels.publish. */
  levels?: boolean;
  achievements?: { id: string; name: string | Record<string, string>; description?: string | Record<string, string>; hidden?: boolean; stat?: string; goal?: number }[];
}

export function defaultImports(origin: string): Record<string, string> {
  const v = `${origin}/vendor/three-${THREE_VERSION}`;
  return {
    three: `${v}/build/three.module.js`,
    'three/webgpu': `${v}/build/three.webgpu.js`,
    'three/tsl': `${v}/build/three.tsl.js`,
    'three/addons/': `${v}/examples/jsm/`,
    '@gcp/': `${origin}/kits/v1/`,
  };
}

function resolveManifest(raw: unknown, origin: string): Manifest {
  const m = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const imports = defaultImports(origin);
  if (m.imports && typeof m.imports === 'object') {
    for (const [k, v] of Object.entries(m.imports as Record<string, unknown>)) if (typeof v === 'string' && k.length < 100 && v.length < 500) imports[k] = v;
  }
  return { imports, three: THREE_VERSION, orientation: typeof m.orientation === 'string' ? m.orientation : undefined };
}

// ---------------------------------------------------------------------------------------------
// Static checks: catch what would fail in the browser before deploying anything.
// ---------------------------------------------------------------------------------------------
export interface Issue { level: 'error' | 'warning'; file?: string; line?: number; col?: number; message: string; hint?: string; frame?: string }
/** A finding against the platform's standards (src/standards.js). */
export interface StandardFinding { standard: string; level: 'warning' | 'note'; message: string; fix: string; check?: string; lang?: string; files?: string[] }
export interface CheckResult { ok: boolean; errors: Issue[]; warnings: Issue[]; files: number; bytes: number; manifest: Manifest; compatIssues: CompatIssue[]; metaIssues: MetaIssue[]; standards: StandardFinding[] }

function frameOf(src: string, line: number, col: number): string {
  const l = src.split('\n')[line - 1] ?? '';
  const start = Math.max(0, col - 60);
  return `${l.slice(start, start + 140)}\n${' '.repeat(Math.min(col, 60))}^`;
}

function collectImports(ast: unknown, out: { spec: string; line: number }[]) {
  const visit = (n: any) => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) { for (const x of n) visit(x); return; }
    if (typeof n.type === 'string') {
      if ((n.type === 'ImportDeclaration' || n.type === 'ExportNamedDeclaration' || n.type === 'ExportAllDeclaration') && n.source && typeof n.source.value === 'string') out.push({ spec: n.source.value, line: n.loc?.start.line || 0 });
      if (n.type === 'ImportExpression' && n.source?.type === 'Literal' && typeof n.source.value === 'string') out.push({ spec: n.source.value, line: n.loc?.start.line || 0 });
    }
    for (const k in n) { if (k !== 'loc' && k !== 'start' && k !== 'end') { const v = n[k]; if (v && typeof v === 'object') visit(v); } }
  };
  visit(ast);
}

function resolveRel(from: string, spec: string): string {
  const parts = from.split('/').slice(0, -1);
  for (const seg of spec.split(/[?#]/)[0].split('/')) {
    if (seg === '.' || seg === '') continue;
    if (seg === '..') parts.pop(); else parts.push(seg);
  }
  return parts.join('/');
}

/** The project's store listing in the shape checkStandards reads: its own fields plus each translation. */
export function listingForStandards(p: Project) {
  return { title: p.title, tagline: p.tagline, description: p.description, controls: p.controls, has_cover: !!p.cover_key, lang: p.listing_lang || undefined, translations: parseJson<Record<string, Record<string, string>>>(p.listing_i18n || '{}', {}) };
}
export { findingLine };

export async function checkProject(env: Env, p: Project, origin: string, ws: string = p.id): Promise<CheckResult> {
  const s = await getSettings(env);
  const files = await listFiles(env, ws);
  const errors: Issue[] = [], warnings: Issue[] = [];
  const err = (i: Omit<Issue, 'level'>) => { if (errors.length < 40) errors.push({ level: 'error', ...i }); };
  const warn = (i: Omit<Issue, 'level'>) => { if (warnings.length < 40) warnings.push({ level: 'warning', ...i }); };
  const paths = new Set(files.map((f) => f.path));
  const bytes = files.reduce((a, f) => a + f.size, 0);
  let manifest = resolveManifest(null, origin), declared: unknown = undefined, gcpRaw: Record<string, unknown> = {};

  if (!files.length) err({ message: 'The project has no files yet.', hint: 'Upload at least index.html (upload_files or create_upload_url).' });
  const over = overBudget(s, p, bytes, files.length);
  if (over) err({ message: over.message, hint: over.hint });
  if (files.length && !paths.has('index.html')) err({ message: 'index.html is missing.', hint: 'The game document must be index.html at the bundle root.' });

  const texts = new Map<string, string>();
  for (const f of files) {
    if (!isText(f.path) || f.size > 6 * 1024 * 1024) continue;
    const obj = await env.FILES.get(wsKey(ws, f.path));
    if (obj) texts.set(f.path, await obj.text());
  }
  // a merge from main leaves both sides of a conflicting change in the file between git's markers (src/collab.ts)
  for (const [path, text] of texts) if (hasConflictMarkers(text)) err({ file: path, message: `${path} still has merge conflict markers (<<<<<<<, =======, >>>>>>>).`, hint: 'Keep the right lines from each side, delete the markers, upload the file, then deploy again. branches {action: "status"} lists the conflicts.' });

  if (texts.has('gcp.json')) {
    try { const raw = JSON.parse(texts.get('gcp.json')!); manifest = resolveManifest(raw, origin); if (raw && typeof raw === 'object' && !Array.isArray(raw)) gcpRaw = raw; declared = gcpRaw.requirements; }
    catch (e) { err({ file: 'gcp.json', message: `gcp.json is not valid JSON: ${(e as Error).message}` }); }
  }
  const importKeys = Object.keys(manifest.imports);
  const mapped = (spec: string, extra: string[]) => [...importKeys, ...extra].some((k) => (k.endsWith('/') ? spec.startsWith(k) : spec === k));
  let sawReady = false, usesGPU = false, bareImports = false;
  const pauseSeen = { esc: '', menu: false, contract: false };   // a pause menu of the game's own on Esc, and whether it uses the pause contract
  const deviceFiles: { file: string; syntax: unknown[]; apis: unknown[]; lineOffset: number }[] = [];   // what the game's code uses, for the iPhone and iPad checks (findings only: syntax trees are not kept)

  const checkJs = (file: string, src: string, kind: 'module' | 'script', lineOffset: number, extraMap: string[]): void => {
    if (/\bGCP\s*\.\s*ready\s*\(/.test(src) || /\bGCP\b/.test(src) && /\.\s*ready\s*\(\s*[^)]{0,80}\)/.test(src)) sawReady = true; // also matches an alias: const G = window.GCP; G.ready()
    if (/@gcp\/craft(2d)?(\.js|\/stage\.js)/.test(src) && /\.\s*run\s*\(/.test(src) && !/ready\s*:\s*false/.test(src)) sawReady = true;   // stage.run() from the craft blocks calls GCP.ready() after the first frames
    if (/navigator\s*\.\s*gpu\b|three\/webgpu|WebGPURenderer/.test(src)) usesGPU = true;
    if (!/(^|\/)(vendor|libs?|node_modules)\/|\.min\.m?js$/.test(file)) {
      if (!pauseSeen.esc && /["'`]Esc(ape)?["'`]|keyCode\s*===?\s*27\b/.test(src)) pauseSeen.esc = file;
      if (/\b(open|show|toggle)_?Pause\w*\s*\(|\bpause_?(Menu|Screen|Overlay|Panel|Modal)\b/i.test(src)) pauseSeen.menu = true;
      if (/\.\s*(pauseMenu|setPaused)\s*\(|@gcp\/play(\.js)?['"`]/.test(src)) pauseSeen.contract = true;
    }
    let ast: unknown;
    try { ast = parse(src, { ecmaVersion: 'latest', sourceType: kind, locations: true, allowHashBang: true, allowAwaitOutsideFunction: kind === 'module', allowReturnOutsideFunction: kind === 'script' }); }
    catch (e) {
      // a guess of "script" was wrong: the file uses import/export mid-line (minified ES modules such as pixi.min.mjs)
      if (kind === 'script' && /sourceType: ?module/.test((e as Error).message)) return checkJs(file, src, 'module', lineOffset, extraMap);
      const loc = (e as { loc?: { line: number; column: number } }).loc;
      err({ file, line: loc ? loc.line + lineOffset : undefined, col: loc?.column, message: `JavaScript syntax error: ${(e as Error).message.replace(/\s*\(\d+:\d+\)$/, '')}`, frame: loc ? frameOf(src, loc.line, loc.column) : undefined,
        hint: kind === 'script' && /\b(import|export)\b/.test(src) ? 'This file uses import/export. Load it with <script type="module">.' : 'Fix the syntax at the marked position, upload the file again, then deploy again.' });
      return;
    }
    deviceFiles.push({ file, syntax: syntaxFindings(ast), apis: apiFindings(src), lineOffset });
    const imps: { spec: string; line: number }[] = [];
    collectImports(ast, imps);
    for (const im of imps) {
      if (/^(https?:)?\/\//.test(im.spec)) { if (!im.spec.startsWith(origin)) warn({ file, line: im.line + lineOffset, message: `Imports from an external URL: ${im.spec}`, hint: 'External hosts can go down or block players. Prefer the platform-hosted modules ("three", "three/addons/…", "@gcp/…") or ship the file in the bundle.' }); continue; }
      if (im.spec.startsWith('data:') || im.spec.startsWith('blob:')) continue;
      if (im.spec.startsWith('.') || im.spec.startsWith('/')) {
        const target = im.spec.startsWith('/') ? im.spec.slice(1).split(/[?#]/)[0] : resolveRel(file, im.spec);
        if (!paths.has(target)) err({ file, line: im.line + lineOffset, message: `Import not found: "${im.spec}" resolves to "${target}", which is not in the bundle.`, hint: 'Upload that file, or fix the path. Imports need the full file name including ".js".' });
      } else if (!mapped(im.spec, extraMap)) {
        err({ file, line: im.line + lineOffset, message: `Bare import "${im.spec}" is not in the import map.`, hint: `Browsers cannot resolve bare names without an import map. Available by default: ${importKeys.join(', ')}. Add others under "imports" in gcp.json, or import a relative file.` });
      } else bareImports = true;
    }
  };

  // Files the page loads with <script type="module" src>, and every file those import, are modules whatever they look like.
  const moduleFiles = new Set<string>();
  {
    const queue: string[] = [];
    for (const [file, src] of texts) {
      if (extOf(file) === 'mjs') queue.push(file);
      if (extOf(file) !== 'html') continue;
      for (const m of src.matchAll(/<script\b([^>]*)>/gi)) {
        const type = (m[1].match(/type=["']?([^"'\s>]+)/i)?.[1] || '').toLowerCase(), srcAttr = m[1].match(/src=["']([^"']+)["']/i)?.[1];
        if (type === 'module' && srcAttr && !/^(https?:)?\/\/|^data:|^blob:/.test(srcAttr)) queue.push(srcAttr.startsWith('/') ? srcAttr.slice(1).split(/[?#]/)[0] : resolveRel(file, srcAttr));
      }
    }
    while (queue.length) {
      const f = queue.pop()!;
      if (moduleFiles.has(f) || !texts.has(f)) continue;
      moduleFiles.add(f);
      for (const m of texts.get(f)!.matchAll(/(?:\bimport\s*(?:[\w$*{}\s,]+?\s*from\s*)?|\bexport\s*(?:\*(?:\s*as\s+[\w$]+)?|\{[^}]*\})\s*from\s*|\bimport\s*\(\s*)["'`](\.{1,2}\/[^"'`]+|\/[^"'`]+)["'`]/g))
        queue.push(m[1].startsWith('/') ? m[1].slice(1).split(/[?#]/)[0] : resolveRel(f, m[1]));
    }
  }

  for (const [file, src] of texts) {
    const ext = extOf(file);
    if (file.startsWith('server/')) continue;
    // web games only: the page is the game, not a way to a native download, an app store or another site
    if (ext === 'html' || ext === 'js' || ext === 'mjs') for (const i of nonWebPage(src)) err({ file, line: src.slice(0, i.index).split('\n').length, message: i.message, hint: i.hint });
    // hosts some regions block (Google Fonts, YouTube, analytics…): the game would fail there, so say what to bundle instead
    if (ext === 'html' || ext === 'js' || ext === 'mjs' || ext === 'css') for (const r of regionBlockedRefs(src)) warn(regionWarning(file, r));
    if (ext === 'js' || ext === 'mjs') {
      // A file is a module if anything imports it or it uses import/export; parse as module first.
      const isModule = moduleFiles.has(file) || /^\s*(import|export)\b/m.test(src);
      checkJs(file, src, isModule ? 'module' : 'script', 0, []);
    } else if (ext === 'json' && file !== 'gcp.json') {
      try { JSON.parse(src); } catch (e) { err({ file, message: `Invalid JSON: ${(e as Error).message}` }); }
    } else if (ext === 'html') {
      const inlineMap: string[] = [];
      const mapM = src.match(/<script[^>]*type=["']importmap["'][^>]*>([\s\S]*?)<\/script>/i);
      if (mapM) {
        try { inlineMap.push(...Object.keys(JSON.parse(mapM[1]).imports || {})); warn({ file, message: 'The page declares its own import map, so the platform will not inject the default one.', hint: 'Simpler: delete the inline import map and put extra entries under "imports" in gcp.json. "three", "three/addons/" and "@gcp/" are provided by default.' }); }
        catch (e) { err({ file, message: `The inline import map is not valid JSON: ${(e as Error).message}` }); }
      }
      const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
      let m: RegExpExecArray | null;
      while ((m = re.exec(src))) {
        const attrs = m[1], body = m[2];
        const type = (attrs.match(/type=["']([^"']+)["']/i)?.[1] || '').toLowerCase();
        const srcAttr = attrs.match(/src=["']([^"']+)["']/i)?.[1];
        const line = src.slice(0, m.index).split('\n').length - 1;
        if (srcAttr) {
          if (/^(https?:)?\/\//.test(srcAttr)) warn({ file, line: line + 1, message: `Loads a script from an external host: ${srcAttr}`, hint: 'Ship the file in the bundle or use the platform-hosted modules so the game keeps working.' });
          else { const target = srcAttr.startsWith('/') ? srcAttr.slice(1).split(/[?#]/)[0] : resolveRel(file, srcAttr); if (!paths.has(target)) err({ file, line: line + 1, message: `Script not found: "${srcAttr}".`, hint: 'Upload the file or fix the src.' }); }
          continue;
        }
        if (type === 'importmap' || type.includes('json') || type.includes('template') || type.includes('shader') || type.startsWith('x-')) continue;
        if (!body.trim()) continue;
        checkJs(file, body, type === 'module' ? 'module' : 'script', line, inlineMap);
      }
      const ref = /<(?:link|img|audio|video|source)\b[^>]*?(?:href|src)=["']([^"'#?]+)[^"']*["']/gi;
      while ((m = ref.exec(src))) {
        const u = m[1];
        if (/^(https?:)?\/\/|^data:|^blob:|^mailto:/.test(u)) continue;
        const target = u.startsWith('/') ? u.slice(1) : resolveRel(file, u);
        if (target && !paths.has(target)) err({ file, message: `Referenced file not found: "${u}".`, hint: 'Upload it or remove the reference.' });
      }
      if (file === 'index.html') {
        if (!/<script\b/i.test(src)) err({ file, message: 'index.html has no <script>, so nothing can run.' });
        if (!/<meta[^>]+viewport/i.test(src)) warn({ file, message: 'No viewport meta tag; the game will look zoomed out on phones.', hint: 'Add <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">.' });
        if (/\b(alert|prompt|confirm)\s*\(/.test(src)) warn({ file, message: 'alert/prompt/confirm block the page and stall automated verification.', hint: 'Use an in-game overlay instead.' });
      }
    }
  }

  if (pauseSeen.esc && pauseSeen.menu && !pauseSeen.contract) warn({ file: pauseSeen.esc, message: 'The game seems to open a pause menu of its own on Esc, but never tells the platform (GCP.pauseMenu, GCP.setPaused). In fullscreen, players can then get two menus at once, and the platform\'s Resume can run the game under its own menu.', hint: 'At boot call GCP.pauseMenu(() => openPause()); call GCP.setPaused(true) when your pause menu opens and GCP.setPaused(false) when it closes; freeze the game on GCP.onPause / GCP.paused, never open your menu from it. See the input guide, "One pause owner".' });
  if (files.length && !sawReady) err({ message: 'The game never calls GCP.ready().', hint: 'Call GCP.ready() once, right after the first playable frame is drawn (stage.run() from @gcp/craft.js or @gcp/craft2d.js does it for you, unless you pass { ready: false }). An engine export can call it from its index.html or a small JS plugin once the first scene is running. The platform uses it to know the game booted. See get_started {topic: "contract"}.' });

  const server = files.filter((f) => f.path.startsWith('server/'));
  // server/bot.js (and what it imports) is not server code: it runs only in the test bots' sandbox (src/bots.ts), so a
  // room game with no server of its own ships one too, whatever the server-code setting
  const botOnly = !paths.has('server/index.js') && !paths.has('server/match.js') && paths.has('server/bot.js');
  if (server.length) {
    if (!s.allow_server_code && !botOnly) err({ message: 'Server code is disabled on this platform.', hint: 'Remove the server/ folder (server/bot.js, for test bots, may stay). Use GCP.save, GCP.leaderboard and GCP.room for data and multiplayer.' });
    else if (!paths.has('server/index.js') && !paths.has('server/match.js') && !paths.has('server/bot.js')) err({ message: 'server/ exists but has none of server/index.js, server/match.js or server/bot.js.', hint: 'server/index.js must `export default { async fetch(request, env, ctx) { … } }` (server code); server/match.js must `export default { init, input, tick }` (server-run matches); server/bot.js is what test bots do (get_started {topic: "bots"}).' });
    else {
      for (const [entry, needs] of [['server/index.js', 'a fetch(request, env, ctx) method'], ['server/match.js', 'init(ctx), tick(state, ctx) and usually input(state, player, input, ctx) (get_started {topic: "matches"})'], ['server/bot.js', 'the test-bot hooks: think, actions, room or invite (get_started {topic: "bots"})']] as const) {
        if (!paths.has(entry)) continue;
        const src = texts.get(entry) || '';
        try { parse(src, { ecmaVersion: 'latest', sourceType: 'module' }); if (!/export\s+default/.test(src)) err({ file: entry, message: `${entry} must have a default export with ${needs}.` }); }
        catch (e) { err({ file: entry, message: `JavaScript syntax error: ${(e as Error).message}` }); }
      }
      if (paths.has('server/match.js') && !s.allow_matches) err({ file: 'server/match.js', message: 'Server-run matches are switched off on this platform.', hint: 'Remove server/match.js and use GCP.room (host-authoritative rooms) instead.' });
      // Server modules run in the game's Worker, where only server/ and shared/ modules are uploaded and there is no import map.
      for (const f of files) {
        if (!/^(server|shared)\//.test(f.path) || !/\.m?js$/.test(f.path) || f.path.startsWith('shared/') && !server.length) continue;
        const src = texts.get(f.path); if (src == null) continue;
        let ast; try { ast = parse(src, { ecmaVersion: 'latest', sourceType: 'module', locations: true }); } catch (e) { if (f.path.startsWith('server/')) err({ file: f.path, message: `JavaScript syntax error: ${(e as Error).message}` }); continue; }
        const imps: { spec: string; line: number }[] = [];
        collectImports(ast, imps);
        for (const im of imps) {
          if (im.spec.startsWith('cloudflare:')) continue;
          const target = im.spec.startsWith('.') ? resolveRel(f.path, im.spec) : null;
          if (!target || !/^(server|shared)\/.+\.m?js$/.test(target) || !paths.has(target)) err({ file: f.path, line: im.line, message: `Server modules can only import other .js files under server/ or shared/ by relative path ("${im.spec}").`, hint: 'Put the rules the client and the server share (movement, hit rules) in shared/ and import them as "../shared/rules.js". Bundle any library you need into those folders.' });
        }
      }
      if (!botOnly) manifest.hasServer = true;
      if (paths.has('server/match.js')) manifest.hasMatch = true;
    }
  }
  // Online games: what their test bots need from server/bot.js (the platform does the rest; see bot-contract.js)
  const bc = botContract(texts, paths);
  if (bc.online) { manifest.bots = bc; for (const i of botIssues(bc)) warn(i); }
  // iPhone and iPad: what in the code the game runtime cannot fill in for Safari (newer syntax, missing features, Ogg-only sound).
  const dev = deviceIssues(deviceFiles, [...paths]);
  for (const i of dev.issues) warn(i);
  if (dev.minSafari) manifest.minSafari = dev.minSafari;
  // Compatibility: the creator's declared requirements, merged with what the code shows it uses.
  const c = buildCompat(declared, { texts, paths: [...paths], bareImports, orientation: manifest.orientation }, bytes);
  for (const i of c.issues) (i.level === 'error' ? err : warn)({ file: 'gcp.json', message: `requirements${i.field === 'requirements' ? '' : '.' + i.field}: ${i.message}`, hint: i.hint });
  manifest.compat = c.compat;
  manifest.usesWebGPU = usesGPU || c.compat.requirements.graphics === 'webgpu';
  // The rest of the game metadata that is true of this build: languages, players, session, progress, accessibility, content.
  const gm = buildMeta(gcpRaw, texts, [...paths]);
  for (const i of gm.issues) (i.level === 'error' ? err : warn)({ file: 'gcp.json', message: `${i.field}: ${i.message}`, hint: i.hint });
  manifest.meta = gm.record;
  // On-screen controls for phones and tablets: the keys the game's code checks, or the creator's own layout.
  const tc = buildControls({ texts, declared: (gcpRaw as Record<string, unknown> | null)?.controls, declaredInput: c.compat.declared ? c.compat.requirements.input : null });
  for (const i of tc.issues) (i.level === 'error' ? err : warn)({ file: 'gcp.json', message: `${i.field}: ${i.message}`, hint: i.hint });
  manifest.controls = tc.controls;
  // Achievements: milestones the game unlocks with GCP.achievements.unlock, or the platform when a stat reaches a goal.
  const ach = parseAchievements(gcpRaw.achievements);
  for (const i of ach.issues) (i.level === 'error' ? err : warn)({ file: 'gcp.json', message: `${i.field}: ${i.message}`, hint: 'gcp.json "achievements": [{ "id": "first_win", "name": "First win", "description": "Win a match", "hidden": false, "stat": "wins", "goal": 1 }]. platform_services {service: "achievements"} has the details.' });
  if (ach.list.length) manifest.achievements = ach.list;
  // Funnel: the order of the game's own GCP.track events, charted in the console's analytics.
  const fun = parseFunnel(gcpRaw.funnel);
  for (const i of fun.issues) (i.level === 'error' ? err : warn)({ file: 'gcp.json', message: `${i.field}: ${i.message}`, hint: 'gcp.json "funnel": ["tutorial_start", "tutorial_done", "level_3"], the names the game sends with GCP.track(name).' });
  if (fun.steps.length) manifest.funnel = fun.steps;
  // player-made levels: the game shares levels players make (src/levels.js); gcp.json "levels": false keeps the shelf off
  if (gcpRaw.levels === true || (gcpRaw.levels !== false && [...texts.values()].some((src) => /\blevels\s*\.\s*publish\s*\(/.test(src)))) manifest.levels = true;
  // Platform requirement: playable on computers, tablets and phones. publish refuses a version that is not
  // (src/release-gate.ts, rule every_device); said here first so the agent fixes it before it deploys.
  for (const d of deviceProblems(manifest)) warn({ file: 'gcp.json', message: `REQUIRED to publish [every_device]: ${d.message}`, hint: d.fix });
  // The platform's standards (src/standards.js): the listing and the code against what the store and the player show.
  // Design recommendations: advice that never blocks; game_standards {action: "check"} lists the notes too.
  const standards = checkStandards({ listing: listingForStandards(p), texts, paths: files.map((f) => f.path), gcp: gcpRaw, brand: s.brand_name }) as StandardFinding[];
  for (const f of standards) if (f.level === 'warning') warn({ message: `RECOMMENDATION [${f.standard}] (design choice, does not block publishing): ${f.message}`, hint: `${f.fix} game_standards {action: "get", id: "${f.standard}"} has the full standard.` });
  return { ok: errors.length === 0, errors, warnings, files: files.length, bytes, manifest, compatIssues: c.issues, metaIssues: gm.issues, standards };
}

// ---------------------------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------------------------
export async function getVersion(env: Env, pid: string, n: number): Promise<Version | null> {
  return env.DB.prepare('SELECT * FROM versions WHERE project_id = ? AND n = ?').bind(pid, n).first<Version>();
}

/**
 * Freezes a workspace as a new numbered version.
 *   ws / branch: the workspace (the project id for main, "<project>~<branch id>" for a branch) and the branch id the
 *     version belongs to (null: main). Merges freeze a scratch workspace into main (src/collab.ts).
 *   expectNewest: the deploy said which version its changes start from (base_version), so the number is taken only while
 *     that is still main's newest version (for main) or the branch's newest (for a branch); two agents deploying at once
 *     cannot both pass, and the one that loses gets null (src/version-sync.ts).
 * The number and the version's row are written in one transaction, so a check of "the newest version" made by another
 * deploy at the same moment always sees this one; the files are copied after, while the version is still queued.
 */
export async function snapshot(env: Env, p: Project, manifest: Manifest, note: string, opts: { base?: number | null; actor?: string; expectNewest?: number; ws?: string; branch?: string | null; change?: number | null; keepWsBase?: boolean } = {}): Promise<Version | null> {
  const ws = opts.ws ?? p.id, branch = opts.branch ?? null;
  const files = await listFiles(env, ws), tok = rid(16), t = now();
  const cond = opts.expectNewest === undefined ? ''
    : branch ? ' AND COALESCE((SELECT head_version FROM branches WHERE id = ?4), 0) = ?5'
      : ' AND COALESCE((SELECT MAX(n) FROM versions WHERE project_id = ?1 AND branch IS NULL), 0) = ?5';
  const sigs = JSON.stringify(files.map((f) => ({ path: f.path, size: f.size, sha: f.sha })));
  const stmts = [
    env.DB.prepare(`UPDATE projects SET next_version = next_version + 1, alloc_token = ?2, updated_at = ?3 WHERE id = ?1${cond}`).bind(...(cond ? [p.id, tok, t, branch, opts.expectNewest ?? 0] : [p.id, tok, t])),
    env.DB.prepare(`INSERT INTO versions (project_id, n, note, manifest, file_count, bytes, files, status, stage, created_at, base, actor, branch, change_number)
      SELECT id, next_version - 1, ?3, ?4, ?5, ?6, ?7, 'queued', 'Copying files', ?8, ?9, ?10, ?11, ?12 FROM projects WHERE id = ?1 AND alloc_token = ?2`)
      .bind(p.id, tok, note.slice(0, 300), JSON.stringify(manifest), files.length, files.reduce((a, f) => a + f.size, 0), sigs, t, opts.base ?? null, (opts.actor || '').slice(0, 120), branch, opts.change ?? null),
    // the workspace now matches this version: checkout_version and list_files say what changed since
    ...(opts.keepWsBase ? [] : branch
      ? [env.DB.prepare('UPDATE branches SET head_version = (SELECT next_version - 1 FROM projects WHERE id = ?1 AND alloc_token = ?2), ws_base = (SELECT next_version - 1 FROM projects WHERE id = ?1 AND alloc_token = ?2), updated_at = ?3 WHERE id = ?4 AND EXISTS (SELECT 1 FROM projects WHERE id = ?1 AND alloc_token = ?2)').bind(p.id, tok, t, branch)]
      : [env.DB.prepare('UPDATE projects SET ws_base = next_version - 1 WHERE id = ?1 AND alloc_token = ?2').bind(p.id, tok)]),
    env.DB.prepare('SELECT next_version - 1 AS n FROM projects WHERE id = ?1 AND alloc_token = ?2').bind(p.id, tok),
  ];
  const res = await env.DB.batch(stmts);
  const n = (res[res.length - 1].results?.[0] as { n?: number } | undefined)?.n;
  if (!n) return null;
  try {
    for (const f of files) {
      const obj = await env.FILES.get(wsKey(ws, f.path));
      if (!obj) throw new AppError(500, `Workspace file vanished: ${f.path}`);
      await env.FILES.put(verKey(p.id, n, f.path), obj.body, { httpMetadata: { contentType: f.ctype } });
    }
  } catch (e) {
    await env.DB.prepare("UPDATE versions SET status = 'failed', stage = ? WHERE project_id = ? AND n = ?").bind(`Failed: ${String((e as Error).message || e).slice(0, 200)}`, p.id, n).run();
    throw e;
  }
  await env.DB.prepare("UPDATE versions SET stage = 'Queued' WHERE project_id = ? AND n = ? AND stage = 'Copying files'").bind(p.id, n).run();
  return (await getVersion(env, p.id, n))!;
}

export function versionEligible(v: Version, browserRequired: boolean): { ok: boolean; reason: string; review?: 'needed' | 'pending' | 'denied' } {
  const report = parseJson<{ ok?: boolean; gpuLimited?: boolean; browser?: string }>(v.report, {});
  if (v.status === 'verified' && report.ok) return { ok: true, reason: 'Automated browser check passed.' };
  if (v.human_ok && !browserRequired) return { ok: true, reason: 'A clean real-browser preview session qualified this version.' };
  // The verification browser could not run this version (it needs WebGPU, or no browser was available). The creator's
  // own preview session proves little on its own (its heartbeats are plain requests anyone can script, and the content
  // review saw no frames), so such a version also needs an admin's approval.
  if (v.human_ok && (report.gpuLimited || report.browser === 'unavailable')) {
    if (v.review === 'approved') return { ok: true, reason: 'Qualified by a clean preview session and approved by the platform.' };
    if (v.review === 'denied') return { ok: false, review: 'denied', reason: `The platform did not approve version ${v.n}${v.review_note ? `: ${v.review_note}` : '.'}` };
    if (v.review === 'pending') return { ok: false, review: 'pending', reason: `Version ${v.n} is waiting for the platform to review it. The verification browser could not run it, so a person checks it before it goes live; it is published as soon as it is approved.` };
    return { ok: false, review: 'needed', reason: `Version ${v.n} needs a review by the platform: the verification browser could not run it. Call publish to ask for the review; it goes live as soon as it is approved.` };
  }
  if (v.status === 'queued' || v.status === 'deploying' || v.status === 'verifying') return { ok: false, reason: `Version ${v.n} is still ${v.status}. Call list_versions {project, version} again in a few seconds.` };
  return { ok: false, reason: `Version ${v.n} has not passed verification.` };
}

export function publicVersion(v: Version, origin: string) {
  return {
    version: v.n, note: v.note, status: v.status, stage: v.stage, files: v.file_count, bytes: v.bytes, created_at: v.created_at, verified_at: v.verified_at,
    published_at: v.published_at, human_ok: !!v.human_ok, screenshot: v.screenshot_key ? `${origin}/api/media/${v.screenshot_key}` : null, report: parseJson(v.report, null),
    compat: parseJson<Manifest>(v.manifest, {} as Manifest).compat ?? null,
    meta: parseJson<Manifest>(v.manifest, {} as Manifest).meta ?? null,
    controls: parseJson<Manifest>(v.manifest, {} as Manifest).controls ?? null,
  };
}

/**
 * A version's compatibility record. Versions deployed before requirements existed get theirs detected from their frozen
 * files the first time anyone asks, and stored, so every live game has a Compatibility section.
 */
export async function ensureCompat(env: Env, v: Version): Promise<Compat> { return (await ensureVersionMeta(env, v)).compat; }

/** A version's compatibility and metadata records, detected from its frozen files and stored the first time anyone asks. */
export async function ensureVersionMeta(env: Env, v: Version): Promise<{ compat: Compat; meta: MetaRecord; controls: TouchControls }> {
  const m = parseJson<Manifest>(v.manifest, {} as Manifest);
  if (m.compat?.v === 1 && m.meta?.v === 1 && m.controls?.v === 1) return { compat: m.compat, meta: m.meta, controls: m.controls };
  const files = parseJson<{ path: string; size: number }[]>(v.files, []), texts = new Map<string, string>();
  for (const f of files) {
    if (!isText(f.path) || f.path.startsWith('server/') || f.size > 6 * 1024 * 1024 || texts.size >= 200) continue;   // server code is not what the browser runs
    const obj = await env.FILES.get(verKey(v.project_id, v.n, f.path));
    if (obj) texts.set(f.path, await obj.text());
  }
  let raw: Record<string, unknown> = {};
  try { const j = texts.has('gcp.json') ? JSON.parse(texts.get('gcp.json')!) : null; if (j && typeof j === 'object' && !Array.isArray(j)) raw = j; } catch { /* checked at deploy */ }
  const paths = files.map((f) => f.path);
  const bareImports = [...texts.values()].some((s) => /\b(?:from|import)\s*\(?\s*["'](?![./]|https?:|data:|blob:)[^"'\s]+["']/.test(s));
  const compat = m.compat?.v === 1 ? m.compat : buildCompat(raw.requirements, { texts, paths, bareImports, orientation: typeof m.orientation === 'string' ? m.orientation : undefined }, v.bytes).compat;
  const meta = m.meta?.v === 1 ? m.meta : buildMeta(raw, texts, paths).record;
  const controls = m.controls?.v === 1 ? m.controls : buildControls({ texts, declared: raw.controls, declaredInput: compat.declared ? compat.requirements.input : null }).controls;
  await env.DB.prepare('UPDATE versions SET manifest = ? WHERE project_id = ? AND n = ?').bind(JSON.stringify({ ...m, compat, meta, controls }), v.project_id, v.n).run();
  return { compat, meta, controls };
}
