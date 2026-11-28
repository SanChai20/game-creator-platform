// The storage side of exporting a verified version as a YouTube Playables package: which version, the check the console
// shows before the download (src/youtube-check.js decides it), and the zip itself, streamed: the version's files straight
// from storage (server code left out), index.html rewritten to load YouTube's SDK and ours from the package, the platform
// files the game imports (three.js, the game kits) read from the platform's own assets, and a PLAYABLES.md checklist.
import { Zip, ZipPassThrough } from 'fflate';
import { AppError, type Env, type Project, type Version } from './env';
import { defaultImports, getVersion } from './projects';
import { readSourceFile } from './version-store';
import { parseJson } from './util';
import { check, isText, leftOut, LOCAL_DIR, mapSpecifier, ownImportMap, packageHtml, platformPath, readme, specifiers } from './youtube-check.js';
import type { FileSig } from './version-sync';

const TEXT_MAX = 2 * 1024 * 1024, TEXTS_MAX = 12 * 1024 * 1024, PLATFORM_FILES_MAX = 400;

/** The version to export: the one asked for, else the live one, else the newest verified one. */
export async function exportVersion(env: Env, p: Project, n?: number | null): Promise<Version> {
  if (n) {
    const v = Number.isInteger(n) && n > 0 ? await getVersion(env, p.id, n) : null;
    if (!v) throw new AppError(404, `Version ${n} does not exist.`, 'not_found');
    return v;
  }
  if (p.live_version) { const v = await getVersion(env, p.id, p.live_version); if (v) return v; }
  const v = await env.DB.prepare("SELECT * FROM versions WHERE project_id = ? AND status = 'verified' ORDER BY n DESC LIMIT 1").bind(p.id).first<Version>();
  if (!v) throw new AppError(409, 'This game has no verified version to export yet. Deploy it and let verification finish.', 'no_version');
  return v;
}

async function platformAsset(env: Env, path: string): Promise<Uint8Array | null> {
  const r = await env.ASSETS.fetch(new Request('https://assets.local' + path));
  if (!r.ok || ((r.headers.get('content-type') || '').includes('text/html') && !path.endsWith('.html'))) return null;
  return new Uint8Array(await r.arrayBuffer());
}

type Plan = {
  v: Version; files: FileSig[]; html: string; imports: Record<string, string>;
  platform: Map<string, Uint8Array>; result: ReturnType<typeof check>;
};

/** Reads what the package needs and checks it. */
export async function planExport(env: Env, p: Project, origin: string, n?: number | null): Promise<Plan> {
  const v = await exportVersion(env, p, n);
  const files = parseJson<FileSig[]>(v.files, []), manifest = parseJson<Record<string, any>>(v.manifest, {});
  const texts: Record<string, string> = {};
  let total = 0;
  for (const f of files) {
    if (leftOut(f.path) || !isText(f.path) || f.size > TEXT_MAX || total + f.size > TEXTS_MAX) continue;
    const obj = await readSourceFile(env, p, { version: v.n }, f.path);
    if (!obj) continue;
    texts[f.path] = await obj.text(); total += f.size;
  }
  const html = texts['index.html'] || '';
  const imports: Record<string, string> = ownImportMap(html) || (manifest.imports && typeof manifest.imports === 'object' ? manifest.imports : defaultImports(origin));
  // the platform files the game loads, followed through their own imports
  const platform = new Map<string, Uint8Array>(), queue: string[] = [], seen = new Set<string>();
  const want = (path: string | null) => { if (path && !seen.has(path) && seen.size < PLATFORM_FILES_MAX) { seen.add(path); queue.push(path); } };
  const resolve = (spec: string, from: string | null) => {
    if (/^\.\.?\//.test(spec)) return from ? new URL(spec, 'https://x' + from).pathname : null;   // relative: the game's own, or inside a platform file
    const mapped = mapSpecifier(spec, imports);
    return platformPath(mapped ?? spec, origin);
  };
  for (const [path, text] of Object.entries(texts)) if (/\.(m?js|html?)$/i.test(path)) for (const s of specifiers(text)) want(resolve(s, null));
  while (queue.length) {
    const path = queue.shift()!, body = await platformAsset(env, path);
    if (!body) continue;
    platform.set(path, body);
    if (/\.m?js$/.test(path)) for (const s of specifiers(new TextDecoder().decode(body))) want(resolve(s, path));
  }
  const sdk = await platformAsset(env, '/sdk/gcp.js');
  if (sdk) platform.set('/sdk/gcp.js', sdk);
  let extra = 0;
  for (const b of platform.values()) extra += b.length;
  const result = check({ verified: v.status === 'verified', files, texts, manifest, age: p.age, extraBytes: extra });
  return { v, files, html, imports, platform, result };
}

/** The package as a zip stream, each stored file uncompressed and read from storage as it goes. */
export function exportZip(env: Env, p: Project, origin: string, plan: Plan): ReadableStream<Uint8Array> {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const w = writable.getWriter(), enc = new TextEncoder();
  let chain = Promise.resolve();
  const zip = new Zip((err, data, final) => {
    chain = chain.then(async () => {
      if (err) { await w.abort(err); return; }
      await w.write(data);
      if (final) await w.close();
    });
  });
  const put = async (path: string, bytes: Uint8Array) => { const e = new ZipPassThrough(path); zip.add(e); e.push(bytes, true); await chain; };
  (async () => {
    try {
      await put('index.html', enc.encode(packageHtml(plan.html, plan.imports, origin)));
      for (const f of plan.files) {
        if (leftOut(f.path) || f.path === 'index.html' || f.path.startsWith(LOCAL_DIR)) continue;
        const obj = await readSourceFile(env, p, { version: plan.v.n }, f.path);
        if (!obj) throw new Error(`${f.path} is missing from storage`);
        const entry = new ZipPassThrough(f.path);
        zip.add(entry);
        const r = obj.body.getReader();
        for (;;) {
          const { done, value } = await r.read();
          if (done) break;
          entry.push(value);
          await chain;
        }
        entry.push(new Uint8Array(0), true);
        await chain;
      }
      for (const [path, bytes] of plan.platform) await put(path === '/sdk/gcp.js' ? LOCAL_DIR + 'gcp.js' : LOCAL_DIR + path.slice(1), bytes);
      await put('PLAYABLES.md', enc.encode(readme({ title: p.title, version: plan.v.n, origin, warnings: plan.result.warnings })));
      zip.end();
      await chain;
    } catch (e) { console.error('youtube export', p.id, String((e as Error)?.message || e)); await w.abort(e).catch(() => {}); }
  })();
  return readable;
}
