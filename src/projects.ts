// Projects, workspace files, static checks and version snapshots. Used by the MCP tools and the console API.
import { parse } from 'acorn';
import { AppError, bad, forbidden, notFound, type Env, type Project, type User, type Version } from './env';
import { getSettings } from './settings';
import { THREE_VERSION } from './generated/runtime-source';
import { cleanPath, extOf, isText, now, parseJson, rid, sha256, slugify, typeOf } from './util';

export const wsKey = (pid: string, path: string) => `ws/${pid}/${path}`;
export const verKey = (pid: string, n: number, path: string) => `v/${pid}/${n}/${path}`;

export async function logEvent(env: Env, pid: string, kind: string, detail = '', version: number | null = null, actor = 'system') {
  await env.DB.prepare('INSERT INTO events (project_id, kind, detail, version, actor, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(pid, kind, detail.slice(0, 500), version, actor.slice(0, 80), now()).run();
}

export async function getProject(env: Env, idOrSlug: string): Promise<Project | null> {
  return env.DB.prepare('SELECT * FROM projects WHERE id = ?1 OR slug = ?1').bind(idOrSlug).first<Project>();
}
export async function ownedProject(env: Env, user: User, idOrSlug: string): Promise<Project> {
  const p = await getProject(env, idOrSlug);
  if (!p || p.status === 'removed' && user.role !== 'admin') throw notFound(`No project "${idOrSlug}". Call list_projects to see yours.`);
  if (p.owner_id !== user.id && user.role !== 'admin') throw forbidden('That project belongs to someone else.');
  return p;
}

export async function createProject(env: Env, user: User, input: { title: string; slug?: string; tagline?: string; description?: string; tags?: string[] }, actor = 'console'): Promise<Project> {
  const s = await getSettings(env);
  if (s.creator_fee_for_projects && !user.creator) throw forbidden('A creator license is required before creating projects.', 'Call get_account to get the purchase link.');
  const title = String(input.title || '').trim().slice(0, 80);
  if (title.length < 2) throw bad('title must be at least 2 characters.');
  const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM projects WHERE owner_id = ? AND status != 'removed'").bind(user.id).first<{ n: number }>();
  if ((count?.n || 0) >= s.projects_per_user) throw forbidden(`Project limit reached (${s.projects_per_user}).`);
  let slug = slugify(input.slug || title) || 'game';
  if (slug.length < 3) slug = `${slug}-game`;
  if (await env.DB.prepare('SELECT 1 FROM projects WHERE slug = ?').bind(slug).first()) slug = `${slug.slice(0, 40)}-${rid(4)}`;
  const id = rid(10), t = now();
  await env.DB.prepare('INSERT INTO projects (id, owner_id, slug, title, tagline, description, tags, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(id, user.id, slug, title, String(input.tagline || '').slice(0, 140), String(input.description || '').slice(0, 4000), JSON.stringify(cleanTags(input.tags)), t, t).run();
  await logEvent(env, id, 'created', title, null, actor);
  return (await getProject(env, id))!;
}
export const cleanTags = (tags: unknown) => (Array.isArray(tags) ? tags : []).map((t) => String(t).toLowerCase().trim().replace(/[^\p{L}\p{N}\- ]/gu, '').slice(0, 24)).filter(Boolean).slice(0, 8);

export async function updateProjectMeta(env: Env, p: Project, input: Record<string, unknown>) {
  const sets: string[] = [], vals: unknown[] = [];
  const put = (col: string, v: unknown) => { sets.push(`${col} = ?`); vals.push(v); };
  if (typeof input.title === 'string' && input.title.trim().length >= 2) put('title', input.title.trim().slice(0, 80));
  if (typeof input.tagline === 'string') put('tagline', input.tagline.slice(0, 140));
  if (typeof input.description === 'string') put('description', input.description.slice(0, 4000));
  if (typeof input.controls === 'string') put('controls', input.controls.slice(0, 1000));
  if (Array.isArray(input.tags)) put('tags', JSON.stringify(cleanTags(input.tags)));
  if (input.price_cents !== undefined) {
    const s = await getSettings(env), price = Math.round(Number(input.price_cents));
    if (!Number.isFinite(price) || price < 0) throw bad('price_cents must be 0 (free) or a positive number of US cents.');
    if (price > 0) {
      if (!s.paid_games_enabled) throw forbidden('Paid games are turned off on this platform. Set price_cents to 0.');
      if (price < s.game_price_min_cents || price > s.game_price_max_cents) throw bad(`A paid game must cost between ${s.game_price_min_cents} and ${s.game_price_max_cents} cents. Use 0 for a free game.`);
    }
    put('price_cents', price);
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

export async function putFile(env: Env, p: Project, rawPath: string, bytes: Uint8Array): Promise<FileRow> {
  const s = await getSettings(env);
  const path = cleanPath(rawPath);
  if (!path) throw bad(`Path not allowed: "${rawPath}".`, 'Use relative paths like "index.html" or "src/game.js" with a known extension (html, js, css, json, png, jpg, webp, svg, mp3, ogg, wav, glb, wasm, woff2, …).');
  if (bytes.byteLength > s.file_max_bytes) throw bad(`${path} is ${bytes.byteLength} bytes; the limit is ${s.file_max_bytes}.`);
  const existing = await listFiles(env, p.id);
  const others = existing.filter((f) => f.path !== path);
  if (others.length + 1 > s.bundle_max_files) throw bad(`Bundle would exceed ${s.bundle_max_files} files.`);
  if (others.reduce((a, f) => a + f.size, 0) + bytes.byteLength > s.bundle_max_bytes) throw bad(`Bundle would exceed ${s.bundle_max_bytes} bytes.`);
  const row: FileRow = { path, size: bytes.byteLength, sha: (await sha256(bytes)).slice(0, 32), ctype: typeOf(path) || 'application/octet-stream', updated_at: now() };
  await env.FILES.put(wsKey(p.id, path), bytes, { httpMetadata: { contentType: row.ctype } });
  await env.DB.batch([
    env.DB.prepare('INSERT INTO files (project_id, path, size, sha, ctype, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(project_id, path) DO UPDATE SET size = excluded.size, sha = excluded.sha, ctype = excluded.ctype, updated_at = excluded.updated_at')
      .bind(p.id, path, row.size, row.sha, row.ctype, row.updated_at),
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

/** Copies a starter template into the workspace. */
export async function applyTemplate(env: Env, p: Project, name: string): Promise<string[]> {
  const idx = await assetJson<{ templates: { name: string; files: { path: string }[] }[] }>(env, '/templates/index.json');
  const t = idx.templates.find((x) => x.name === name);
  if (!t) throw bad(`Unknown template "${name}".`, `Available: ${idx.templates.map((x) => x.name).join(', ')}`);
  const written: string[] = [];
  for (const f of t.files) {
    const r = await env.ASSETS.fetch(new Request(`https://assets.local/templates/${name}/${f.path}`));
    if (!r.ok) continue;
    await putFile(env, p, f.path, new Uint8Array(await r.arrayBuffer()));
    written.push(f.path);
  }
  return written;
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
  hasServer?: boolean;
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
export interface CheckResult { ok: boolean; errors: Issue[]; warnings: Issue[]; files: number; bytes: number; manifest: Manifest }

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

export async function checkProject(env: Env, p: Project, origin: string): Promise<CheckResult> {
  const s = await getSettings(env);
  const files = await listFiles(env, p.id);
  const errors: Issue[] = [], warnings: Issue[] = [];
  const err = (i: Omit<Issue, 'level'>) => { if (errors.length < 40) errors.push({ level: 'error', ...i }); };
  const warn = (i: Omit<Issue, 'level'>) => { if (warnings.length < 40) warnings.push({ level: 'warning', ...i }); };
  const paths = new Set(files.map((f) => f.path));
  const bytes = files.reduce((a, f) => a + f.size, 0);
  let manifest = resolveManifest(null, origin);

  if (!files.length) err({ message: 'The project has no files yet.', hint: 'Upload at least index.html (put_files), or start from a template (apply_template).' });
  if (files.length && !paths.has('index.html')) err({ message: 'index.html is missing.', hint: 'The game document must be index.html at the bundle root.' });

  const texts = new Map<string, string>();
  for (const f of files) {
    if (!isText(f.path) || f.size > 6 * 1024 * 1024) continue;
    const obj = await env.FILES.get(wsKey(p.id, f.path));
    if (obj) texts.set(f.path, await obj.text());
  }

  if (texts.has('gcp.json')) {
    try { manifest = resolveManifest(JSON.parse(texts.get('gcp.json')!), origin); }
    catch (e) { err({ file: 'gcp.json', message: `gcp.json is not valid JSON: ${(e as Error).message}` }); }
  }
  const importKeys = Object.keys(manifest.imports);
  const mapped = (spec: string, extra: string[]) => [...importKeys, ...extra].some((k) => (k.endsWith('/') ? spec.startsWith(k) : spec === k));
  let sawReady = false, usesGPU = false;

  const checkJs = (file: string, src: string, kind: 'module' | 'script', lineOffset: number, extraMap: string[]) => {
    if (/\bGCP\s*\.\s*ready\s*\(/.test(src) || /\bGCP\b/.test(src) && /\.\s*ready\s*\(\s*[^)]{0,80}\)/.test(src)) sawReady = true; // also matches an alias: const G = window.GCP; G.ready()
    if (/@gcp\/craft(2d)?(\.js|\/stage\.js)/.test(src) && /\.\s*run\s*\(/.test(src) && !/ready\s*:\s*false/.test(src)) sawReady = true;   // stage.run() from the craft blocks calls GCP.ready() after the first frames
    if (/navigator\s*\.\s*gpu\b|three\/webgpu|WebGPURenderer/.test(src)) usesGPU = true;
    let ast: unknown;
    try { ast = parse(src, { ecmaVersion: 'latest', sourceType: kind, locations: true, allowHashBang: true, allowAwaitOutsideFunction: kind === 'module', allowReturnOutsideFunction: kind === 'script' }); }
    catch (e) {
      const loc = (e as { loc?: { line: number; column: number } }).loc;
      err({ file, line: loc ? loc.line + lineOffset : undefined, col: loc?.column, message: `JavaScript syntax error: ${(e as Error).message.replace(/\s*\(\d+:\d+\)$/, '')}`, frame: loc ? frameOf(src, loc.line, loc.column) : undefined,
        hint: kind === 'script' && /\b(import|export)\b/.test(src) ? 'This file uses import/export. Load it with <script type="module">.' : 'Fix the syntax at the marked position, upload the file again, then run check_project.' });
      return;
    }
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
      }
    }
  };

  for (const [file, src] of texts) {
    const ext = extOf(file);
    if (file.startsWith('server/')) continue;
    if (ext === 'js' || ext === 'mjs') {
      // A file is a module if anything imports it or it uses import/export; parse as module first.
      const isModule = /^\s*(import|export)\b/m.test(src);
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

  if (files.length && !sawReady) err({ message: 'The game never calls GCP.ready().', hint: 'Call GCP.ready() once, right after the first playable frame is drawn (stage.run() from @gcp/craft.js or @gcp/craft2d.js does it for you, unless you pass { ready: false }). The platform uses it to know the game booted. See get_guide("platform-contract").' });

  const server = files.filter((f) => f.path.startsWith('server/'));
  if (server.length) {
    if (!s.allow_server_code) err({ message: 'Server code is disabled on this platform.', hint: 'Remove the server/ folder. Use GCP.save, GCP.leaderboard and GCP.room for data and multiplayer.' });
    else if (!paths.has('server/index.js')) err({ message: 'server/ exists but server/index.js is missing.', hint: 'server/index.js must `export default { async fetch(request, env, ctx) { … } }`.' });
    else {
      const src = texts.get('server/index.js') || '';
      try { parse(src, { ecmaVersion: 'latest', sourceType: 'module' }); if (!/export\s+default/.test(src)) err({ file: 'server/index.js', message: 'server/index.js must have a default export with a fetch(request, env, ctx) method.' }); }
      catch (e) { err({ file: 'server/index.js', message: `JavaScript syntax error: ${(e as Error).message}` }); }
      manifest.hasServer = true;
    }
  }
  manifest.usesWebGPU = usesGPU;
  return { ok: errors.length === 0, errors, warnings, files: files.length, bytes, manifest };
}

// ---------------------------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------------------------
export async function getVersion(env: Env, pid: string, n: number): Promise<Version | null> {
  return env.DB.prepare('SELECT * FROM versions WHERE project_id = ? AND n = ?').bind(pid, n).first<Version>();
}

/** Freezes the workspace into an immutable numbered version. */
export async function snapshot(env: Env, p: Project, manifest: Manifest, note: string): Promise<Version> {
  const files = await listFiles(env, p.id);
  const got = await env.DB.prepare('UPDATE projects SET next_version = next_version + 1, updated_at = ? WHERE id = ? RETURNING next_version').bind(now(), p.id).first<{ next_version: number }>();
  const n = got!.next_version - 1;
  for (const f of files) {
    const obj = await env.FILES.get(wsKey(p.id, f.path));
    if (!obj) throw new AppError(500, `Workspace file vanished: ${f.path}`);
    await env.FILES.put(verKey(p.id, n, f.path), obj.body, { httpMetadata: { contentType: f.ctype } });
  }
  await env.DB.prepare('INSERT INTO versions (project_id, n, note, manifest, file_count, bytes, files, status, stage, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(p.id, n, note.slice(0, 300), JSON.stringify(manifest), files.length, files.reduce((a, f) => a + f.size, 0), JSON.stringify(files.map((f) => ({ path: f.path, size: f.size, sha: f.sha }))), 'queued', 'Queued', now()).run();
  return (await getVersion(env, p.id, n))!;
}

export function versionEligible(v: Version, browserRequired: boolean): { ok: boolean; reason: string } {
  const report = parseJson<{ ok?: boolean; gpuLimited?: boolean; browser?: string }>(v.report, {});
  if (v.status === 'verified' && report.ok) return { ok: true, reason: 'Automated browser check passed.' };
  if (v.human_ok && (!browserRequired || report.gpuLimited || report.browser === 'unavailable')) return { ok: true, reason: 'A clean real-browser preview session qualified this version.' };
  if (v.status === 'queued' || v.status === 'deploying' || v.status === 'verifying') return { ok: false, reason: `Version ${v.n} is still ${v.status}. Call get_version again in a few seconds.` };
  return { ok: false, reason: `Version ${v.n} has not passed verification.` };
}

export function publicVersion(v: Version, origin: string) {
  return {
    version: v.n, note: v.note, status: v.status, stage: v.stage, files: v.file_count, bytes: v.bytes, created_at: v.created_at, verified_at: v.verified_at,
    published_at: v.published_at, human_ok: !!v.human_ok, screenshot: v.screenshot_key ? `${origin}/api/media/${v.screenshot_key}` : null, report: parseJson(v.report, null),
  };
}
