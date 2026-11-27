// Runs before every build:
//  1. vendors the pinned Three.js build + addons into web/public/vendor so games can import it from the platform
//  2. indexes templates and kits so the MCP server can list and read them
//  3. embeds the game Worker runtime as a string (the platform uploads it as the entry module of every game Worker)
import { cpSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildBlocks } from './blocks.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pub = join(root, 'web/public');
const three = JSON.parse(readFileSync(join(root, 'node_modules/three/package.json'), 'utf8')).version;

const vdir = join(pub, 'vendor', `three-${three}`);
if (!existsSync(join(vdir, 'build/three.module.js'))) {
  rmSync(join(pub, 'vendor'), { recursive: true, force: true });
  mkdirSync(join(vdir, 'build'), { recursive: true });
  for (const f of readdirSync(join(root, 'node_modules/three/build'))) {
    if (f.endsWith('.cjs')) continue;
    cpSync(join(root, 'node_modules/three/build', f), join(vdir, 'build', f));
  }
  cpSync(join(root, 'node_modules/three/examples/jsm'), join(vdir, 'examples/jsm'), { recursive: true });
  cpSync(join(root, 'node_modules/three/LICENSE'), join(vdir, 'LICENSE'));
}

function walk(dir, base = dir, out = []) {
  for (const f of readdirSync(dir).sort()) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p, base, out);
    else out.push({ path: relative(base, p).split('\\').join('/'), size: statSync(p).size });
  }
  return out;
}

const templates = [];
for (const name of readdirSync(join(pub, 'templates')).sort()) {
  const dir = join(pub, 'templates', name);
  if (!statSync(dir).isDirectory()) continue;
  const meta = JSON.parse(readFileSync(join(dir, 'template.json'), 'utf8'));
  templates.push({ name, ...meta, files: walk(dir).filter((f) => f.path !== 'template.json') });
}
writeFileSync(join(pub, 'templates/index.json'), JSON.stringify({ templates }, null, 1));

const kits = JSON.parse(readFileSync(join(pub, 'kits/kits.json'), 'utf8'));
for (const k of kits.kits) if (k.exports === 'auto') k.exports = Object.keys(await import(pathToFileURL(join(pub, 'kits/v1', k.file)).href)).sort();
writeFileSync(join(pub, 'kits/index.json'), JSON.stringify({ three, kits: kits.kits }, null, 1));

// the building-block catalog: signatures and docs straight from the kit sources, valid values from the live modules
const blocks = await buildBlocks(pub);
writeFileSync(join(pub, 'kits/blocks.json'), JSON.stringify({ three, groups: blocks.groups, values: blocks.values }));

// fingerprints of the code everyone starts from (templates and kits): the duplication check ignores them, so two games
// built on the same template or kit are not mistaken for copies of each other
const { contentNames, fingerprints, inlineScripts } = await import(pathToFileURL(join(root, 'src/originality.js')).href);
const base = new Set(), baseNames = new Set();
for (const dir of ['templates', 'kits/v1']) for (const f of walk(join(pub, dir))) {
  if (!/\.(m?js|html)$/.test(f.path)) continue;
  const text = readFileSync(join(pub, dir, f.path), 'utf8');
  for (const n of contentNames([{ path: f.path, text }])) baseNames.add(n);
  for (const part of /\.html$/.test(f.path) ? inlineScripts(text) : [text]) for (const h of fingerprints(part)) base.add(h);
}
writeFileSync(join(pub, 'kits/baseline.bin'), Buffer.from(Int32Array.from([...base].sort((a, b) => a - b)).buffer));
// and the names in them (characters, items, places of the templates), so two games on one template do not share names
writeFileSync(join(pub, 'kits/baseline-names.json'), JSON.stringify([...baseNames].sort()));

// the ACP workbench's bridge (acp-bridge/), as the tarball `npx -y <site>/acp/hearthcade-acp-<version>.tgz` installs
{
  const { gzipSync } = await import('node:zlib');
  const pkgDir = join(root, 'acp-bridge'), pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
  const files = ['package.json', ...pkg.files.flatMap((f) => existsSync(join(pkgDir, f)) ? (statSync(join(pkgDir, f)).isDirectory() ? walk(join(pkgDir, f)).map((x) => f + '/' + x.path) : [f]) : [])];
  const blocks = [];
  const field = (buf, off, len, str) => { buf.write(str, off, Math.min(len, Buffer.byteLength(str)), 'utf8'); };
  for (const f of files) {
    const data = readFileSync(join(pkgDir, f)), h = Buffer.alloc(512);
    field(h, 0, 100, 'package/' + f);
    field(h, 100, 8, (f.startsWith('bin/') ? '0000755' : '0000644') + '\0');
    field(h, 108, 8, '0000000\0'); field(h, 116, 8, '0000000\0');
    field(h, 124, 12, data.length.toString(8).padStart(11, '0') + '\0');
    field(h, 136, 12, '14000000000\0');            // a fixed time: the same sources give the same tarball
    h.fill(0x20, 148, 156); h[156] = 0x30;
    field(h, 257, 6, 'ustar\0'); field(h, 263, 2, '00');
    let sum = 0; for (const b of h) sum += b;
    field(h, 148, 8, sum.toString(8).padStart(6, '0') + '\0 ');
    blocks.push(h, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  rmSync(join(pub, 'acp'), { recursive: true, force: true });
  mkdirSync(join(pub, 'acp'), { recursive: true });
  writeFileSync(join(pub, 'acp', `hearthcade-acp-${pkg.version}.tgz`), gzipSync(Buffer.concat(blocks), { level: 9 }));
}

mkdirSync(join(root, 'src/generated'), { recursive: true });
const runtime = readFileSync(join(root, 'src/runtime/game-worker.js'), 'utf8');
const intrinsics = readFileSync(join(root, 'src/runtime/gcp-intrinsics.js'), 'utf8');
const matchCore = readFileSync(join(root, 'src/runtime/match-core.js'), 'utf8');
// the module that runs a game's server/bot.js for preview test bots (src/bots.ts), loaded into a Dynamic Worker of its own
const botRunner = readFileSync(join(root, 'src/runtime/bot-runner.js'), 'utf8');
writeFileSync(join(root, 'src/generated/runtime-source.ts'),
  `// Generated by scripts/prepare.mjs. Do not edit.\nexport const THREE_VERSION = ${JSON.stringify(three)};\nexport const GAME_WORKER_SOURCE = ${JSON.stringify(runtime)};\nexport const GAME_INTRINSICS_SOURCE = ${JSON.stringify(intrinsics)};\nexport const GAME_MATCH_CORE_SOURCE = ${JSON.stringify(matchCore)};\nexport const BOT_RUNNER_SOURCE = ${JSON.stringify(botRunner)};\n`);
console.log(`prepared: three@${three}, ${templates.length} templates, ${kits.kits.length} kits, ${base.size} baseline fingerprints, ${blocks.groups.reduce((a, g) => a + g.blocks.length, 0)} building blocks`);
