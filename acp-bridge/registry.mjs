// The agents the workbench runs: exactly those of the official ACP Registry (https://github.com/agentclientprotocol/registry),
// the list Zed and JetBrains offer. The bridge reads the live list from the site (/acp/registry.json, which follows the
// registry) and falls back to the copy it ships with (registry.json). Each agent starts the way the registry says: an
// npm package through npx, a Python package through uvx, or a binary for this platform that the bridge downloads,
// checks against the registry's SHA-256 and unpacks under ~/.hearthcade/agents/<id>/<version>/.
import { readFileSync, existsSync, mkdirSync, writeFileSync, rmSync, chmodSync, renameSync } from 'node:fs';
import { join, dirname, resolve, sep, basename } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { inflateRawSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Names the bridge took before it followed the registry's ids ("hearthcade-acp claude" still works). */
export const ALIASES = { claude: 'claude-acp', codex: 'codex-acp', copilot: 'github-copilot-cli', qwen: 'qwen-code', kimi: 'kimi-code', vibe: 'mistral-vibe', droid: 'factory-droid', amp: 'amp-acp', grok: 'grok-build', codebuddy: 'codebuddy-code', minimax: 'minimax-code', minion: 'minion-code', muse: 'muse-code' };

export function bundledRegistry(file = process.env.HEARTHCADE_ACP_AGENTS || join(HERE, 'registry.json')) {
  return JSON.parse(readFileSync(file, 'utf8')).agents;
}

/** The live registry from the site, or the bundled copy when it cannot be read. */
export async function loadRegistry(server, { fetchImpl = fetch, timeoutMs = 6000 } = {}) {
  if (process.env.HEARTHCADE_ACP_AGENTS) return bundledRegistry();
  try {
    const r = await fetchImpl(`${server}/acp/registry.json`, { signal: AbortSignal.timeout(timeoutMs) });
    if (r.ok) { const j = await r.json(); if (Array.isArray(j.agents) && j.agents.length) return j.agents; }
  } catch { /* offline or an older site: the bundled copy */ }
  return bundledRegistry();
}

export function findAgent(list, id) {
  const want = String(id || '').toLowerCase();
  return list.find((a) => a.id === want) || list.find((a) => a.id === ALIASES[want]) || null;
}

/** This computer as the registry names platforms: darwin-aarch64, linux-x86_64-musl, windows-x86_64, … */
export function platformKey(platform = process.platform, arch = process.arch, musl = isMusl(platform)) {
  const os = platform === 'win32' ? 'windows' : platform === 'darwin' ? 'darwin' : platform === 'linux' ? 'linux' : platform;
  const cpu = arch === 'x64' ? 'x86_64' : arch === 'arm64' ? 'aarch64' : arch;
  return `${os}-${cpu}${os === 'linux' && musl ? '-musl' : ''}`;
}
function isMusl(platform) {
  if (platform !== 'linux') return false;
  try { return !process.report.getReport().header.glibcVersionRuntime; } catch { return false; }
}

/**
 * How an agent starts on this computer: { kind: 'npx' | 'uvx', command, args, env } or { kind: 'binary', … } with the
 * download, or { error } when the registry has nothing for this platform. npx comes first (the bridge itself runs on
 * Node), then this platform's binary, then uvx (which needs uv installed).
 */
export function launchPlan(entry, { platform = process.platform, arch = process.arch, musl } = {}) {
  const d = entry?.distribution || {};
  if (entry?.launch) {   // a test catalog: a command as it is
    const l = entry.launch;
    return { kind: 'bin', command: l.bin, args: [...(l.args || [])], env: {} };
  }
  if (d.npx?.package) return { kind: 'npx', command: 'npx', args: ['-y', d.npx.package, ...(d.npx.args || [])], env: d.npx.env || {} };
  const key = platformKey(platform, arch, musl);
  const bins = d.binary || {};
  // a musl Linux takes the glibc build when there is no musl one
  const b = bins[key] || bins[key.replace(/-musl$/, '')];
  if (b?.archive && b.cmd) return { kind: 'binary', url: b.archive, sha256: b.sha256 || null, cmd: b.cmd, args: [...(b.args || [])], env: b.env || {}, platform: key };
  if (d.uvx?.package) return { kind: 'uvx', command: 'uvx', args: [d.uvx.package, ...(d.uvx.args || [])], env: d.uvx.env || {} };
  const has = Object.keys(bins);
  return { error: has.length ? `${entry.name} has no build for this computer (${key}). It is available for: ${has.join(', ')}.` : `${entry.name} has no way to start in the registry.` };
}

// ----- binaries --------------------------------------------------------------------------------------------------------
export const agentsHome = () => process.env.HEARTHCADE_AGENTS_DIR || join(homedir(), '.hearthcade', 'agents');

/**
 * Downloads, checks and unpacks a binary agent once per version; returns { command, args, env }. onProgress({ bytes,
 * total }) follows the download.
 */
export async function installBinary(entry, plan, { home = agentsHome(), fetchImpl = fetch, onProgress = () => {} } = {}) {
  const dir = join(home, safe(entry.id), safe(entry.version || 'current'), safe(plan.platform || 'any'));
  const command = resolve(dir, plan.cmd);
  if (!command.startsWith(dir + sep)) throw new Error(`The registry's command for ${entry.name} points outside its folder.`);
  if (!existsSync(join(dir, '.installed'))) {
    rmSync(dir, { recursive: true, force: true });
    const tmp = dir + '.part';
    rmSync(tmp, { recursive: true, force: true }); mkdirSync(tmp, { recursive: true });
    let r;
    try { r = await fetchImpl(plan.url); }
    catch (e) { throw new Error(`Could not download ${entry.name} from ${plan.url}: ${e?.cause?.code || e?.cause?.message || e?.message || e}. Check the internet connection (and any proxy) on this computer.`); }
    if (!r.ok || !r.body) throw new Error(`Could not download ${entry.name} (${r.status}) from ${plan.url}`);
    const total = Number(r.headers.get('content-length')) || null;
    const hash = createHash('sha256'), parts = [];
    let bytes = 0, last = 0;
    for await (const chunk of r.body) {
      const b = Buffer.from(chunk); parts.push(b); hash.update(b); bytes += b.length;
      if (Date.now() - last > 300) { last = Date.now(); onProgress({ bytes, total }); }
    }
    onProgress({ bytes, total: total || bytes });
    const digest = hash.digest('hex');
    if (plan.sha256 && digest !== plan.sha256.toLowerCase()) throw new Error(`The download of ${entry.name} does not match the registry's checksum (got ${digest.slice(0, 12)}…). Nothing was run.`);
    const data = Buffer.concat(parts), name = basename(new URL(plan.url).pathname).toLowerCase();
    if (name.endsWith('.zip')) unzip(data, tmp);
    else if (/\.(tar\.gz|tgz|tar\.bz2|tbz2|tar\.xz|txz|tar)$/.test(name)) { const f = join(tmp, '.archive'); writeFileSync(f, data); await untar(f, tmp); rmSync(f, { force: true }); }
    else { const target = resolve(tmp, plan.cmd); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, data); }
    rmSync(dir, { recursive: true, force: true }); mkdirSync(dirname(dir), { recursive: true });
    renameSync(tmp, dir);
    if (!existsSync(command)) throw new Error(`${entry.name}'s download has no ${plan.cmd}.`);
    if (process.platform !== 'win32') try { chmodSync(command, 0o755); } catch { /* not ours */ }
    writeFileSync(join(dir, '.installed'), JSON.stringify({ url: plan.url, sha256: digest, at: new Date().toISOString() }));
  }
  return { command, args: plan.args, env: plan.env, cwdHint: dir };
}
const safe = (s) => String(s).replace(/[^\w.-]+/g, '_').slice(0, 80);

/** A .zip, unpacked with Node alone (stored and deflated entries), refusing paths that leave the folder. */
export function unzip(buf, out) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('Not a zip archive.');
  let count = buf.readUInt16LE(eocd + 10), off = buf.readUInt32LE(eocd + 16);
  if (off === 0xffffffff || count === 0xffff) {   // zip64
    const loc = eocd - 20;
    if (buf.readUInt32LE(loc) !== 0x07064b50) throw new Error('Unsupported zip archive.');
    const z = Number(buf.readBigUInt64LE(loc + 8));
    count = Number(buf.readBigUInt64LE(z + 32)); off = Number(buf.readBigUInt64LE(z + 48));
  }
  const root = resolve(out);
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error('Damaged zip archive.');
    const method = buf.readUInt16LE(off + 10);
    let csize = buf.readUInt32LE(off + 20), local = buf.readUInt32LE(off + 42);
    const nlen = buf.readUInt16LE(off + 28), xlen = buf.readUInt16LE(off + 30), clen = buf.readUInt16LE(off + 32);
    const ext = buf.readUInt32LE(off + 38) >>> 16;
    const name = buf.toString('utf8', off + 46, off + 46 + nlen);
    // zip64 sizes and offsets live in the extra field
    let x = off + 46 + nlen; const xend = x + xlen;
    while (x + 4 <= xend) {
      const id = buf.readUInt16LE(x), size = buf.readUInt16LE(x + 2);
      if (id === 0x0001) { let p = x + 4; if (buf.readUInt32LE(off + 24) === 0xffffffff) p += 8; if (csize === 0xffffffff) { csize = Number(buf.readBigUInt64LE(p)); p += 8; } if (local === 0xffffffff) local = Number(buf.readBigUInt64LE(p)); }
      x += 4 + size;
    }
    off = xend + clen;
    const target = resolve(root, name);
    if (!target.startsWith(root + sep) && target !== root) throw new Error(`The archive has a path outside its folder: ${name}`);
    if (name.endsWith('/')) { mkdirSync(target, { recursive: true }); continue; }
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + csize);
    const data = method === 0 ? raw : method === 8 ? inflateRawSync(raw) : null;
    if (!data) throw new Error(`The archive uses a compression the bridge cannot unpack (${method}).`);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, data);
    if (ext & 0o111) try { chmodSync(target, 0o755); } catch { /* fine */ }
  }
}

/** A tar archive (gzip, bzip2, xz or none), unpacked with the system's tar (Windows 10 and later have one too). */
function untar(file, out) {
  return new Promise((ok, fail) => {
    const p = spawn('tar', ['-xf', file, '-C', out], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let err = ''; p.stderr.on('data', (d) => { err += d; });
    p.on('error', (e) => fail(new Error(`Could not run tar to unpack the agent: ${e.message}`)));
    p.on('exit', (code) => (code === 0 ? ok() : fail(new Error(`tar could not unpack the agent: ${err.trim().slice(0, 300)}`))));
  });   // GNU tar and bsdtar both refuse members that climb out of the folder
}
