// The first run of an npx agent downloads it before the agent can say anything, and npx prints nothing while it does
// (Codex brings a ~550 MB binary on Windows). This watches the download from the outside so the console can show it:
// npx unpacks into <npm cache>/_npx/<hash>/node_modules while it downloads, so the size of the newest such folder is
// the progress, and the registry's unpacked sizes give the total to expect.
import { readdir, stat, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

/** npm's cache folder: npm_config_cache when set, otherwise npm's default for the platform. */
export function npmCacheDir(env = process.env, platform = process.platform) {
  if (env.npm_config_cache) return env.npm_config_cache;
  if (platform === 'win32') return join(env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'npm-cache');
  return join(homedir(), '.npm');
}

/** Bytes in a folder, following no links; stops counting after `maxFiles` files. */
export async function folderSize(dir, maxFiles = 200_000) {
  let total = 0, files = 0;
  const stack = [dir];
  while (stack.length && files < maxFiles) {
    const d = stack.pop();
    let list; try { list = await readdir(d, { withFileTypes: true }); } catch { continue; }
    for (const e of list) {
      const p = join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) { files++; try { total += (await lstat(p)).size; } catch { /* moved */ } }
    }
  }
  return total;
}

/** The npx folder created or changed since `since` (ms), or null. */
export async function newestNpxDir(cacheDir, since) {
  const root = join(cacheDir, '_npx');
  let names; try { names = await readdir(root); } catch { return null; }
  let best = null, bestT = 0;
  for (const n of names) {
    try { const s = await stat(join(root, n)); const t = Math.max(s.mtimeMs, s.birthtimeMs || 0); if (t >= since - 2000 && t > bestT) { best = join(root, n); bestT = t; } } catch { /* gone */ }
  }
  return best;
}

/**
 * About how many bytes a package unpacks to with its dependencies, from the registry: the package, its dependencies
 * and the optional dependencies built for this platform (the big native binaries), a few levels deep. An estimate:
 * ranges resolve to the latest version. null when the registry cannot be reached.
 */
export async function estimateSize(spec, { registry = process.env.npm_config_registry || 'https://registry.npmjs.org', platform = process.platform, arch = process.arch, fetchImpl = fetch, maxRequests = 80, timeoutMs = 8000 } = {}) {
  const base = registry.replace(/\/+$/, '');
  const seen = new Set();
  let requests = 0;
  const tag = `${platform}-${arch}`;
  const parse = (s) => {   // "@scope/name@1.2.3" | "name" | alias "npm:@scope/name@1.2.3"
    s = s.replace(/^npm:/, '');
    const at = s.lastIndexOf('@');
    return at > 0 ? { name: s.slice(0, at), version: s.slice(at + 1) } : { name: s, version: 'latest' };
  };
  const exact = (v) => /^\d+\.\d+\.\d+(-[\w.]+)?$/.test(v) ? v : 'latest';
  const one = async (name, version, depth) => {
    const key = name + '@' + version;
    if (seen.has(key) || requests >= maxRequests) return 0;
    seen.add(key); requests++;
    let doc;
    try {
      const r = await fetchImpl(`${base}/${name.replace('/', '%2f')}/${encodeURIComponent(version)}`, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json' } });
      if (!r.ok) return 0;
      doc = await r.json();
    } catch { return 0; }
    let size = Number(doc?.dist?.unpackedSize) || 0;
    if (depth <= 0) return size;
    const kids = [];
    for (const [n, v] of Object.entries(doc.dependencies || {})) kids.push(String(v).startsWith('npm:') ? parse(String(v)) : { name: n, version: exact(String(v)) });
    const opt = Object.entries(doc.optionalDependencies || {}).filter(([n, v]) => (n + ' ' + v).includes(tag) && !/musl/.test(n + v));
    for (const [n, v] of opt.slice(0, 1)) kids.push(String(v).startsWith('npm:') ? parse(String(v)) : { name: n, version: exact(String(v)) });
    const sizes = await Promise.all(kids.map((k) => one(k.name, k.version, depth - 1)));
    for (const s of sizes) size += s;
    return size;
  };
  const { name, version } = parse(spec);
  const total = await one(name, exact(version), 3);
  return total > 0 ? total : null;
}

/**
 * Watches an npx download while the agent starts. Calls onUpdate({ bytes, total }) when the bytes change; total is the
 * estimate (or null). stop() ends it.
 */
export function watchNpxDownload({ spec, cacheDir = npmCacheDir(), since = Date.now(), every = 1500, onUpdate, estimate = estimateSize, size = folderSize }) {
  let stopped = false, total = null, last = -1, timer = null, grew = false;
  estimate(spec).then((t) => { if (!stopped) { total = t; if (grew && last > 0) onUpdate({ bytes: last, total }); } }, () => {});
  const tick = async () => {
    if (stopped) return;
    const dir = await newestNpxDir(cacheDir, since);
    const bytes = dir ? await size(dir) : 0;
    // only a folder that grows is a download: an agent npx already has may still touch its folder
    if (!stopped && bytes !== last) { if (last >= 0 && bytes > last) grew = true; last = bytes; if (grew && bytes > 0) onUpdate({ bytes, total }); }
    if (!stopped) timer = setTimeout(tick, every);
  };
  timer = setTimeout(tick, every);
  return { stop() { stopped = true; clearTimeout(timer); } };
}
