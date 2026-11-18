// Web games only: the byte sniffing that refuses programs and archives, and the page scan that refuses downloads,
// store installs and redirects. Plain node, no server.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { register } from 'node:module';
import { join } from 'node:path';
import { test } from 'node:test';
import { nonWebContent, nonWebPage } from '../src/web-only.js';

const bytes = (...v) => new Uint8Array(v), str = (s) => new TextEncoder().encode(s);

test('programs, installers and archives are refused whatever their name', () => {
  assert.match(nonWebContent(bytes(0x4d, 0x5a, 0x90, 0, 3, 0), 'game.bin'), /Windows program/);
  assert.match(nonWebContent(bytes(0x7f, 0x45, 0x4c, 0x46, 2, 1), 'libgame.data'), /ELF/);
  assert.match(nonWebContent(bytes(0xcf, 0xfa, 0xed, 0xfe, 7, 0), 'x.bin'), /Mach-O/);
  assert.match(nonWebContent(bytes(0x50, 0x4b, 0x03, 0x04, 20, 0), 'game.pck'), /zip archive/);
  assert.match(nonWebContent(bytes(0x1f, 0x8b, 8, 0, 0, 0), 'build.data'), /compressed archive/);
  assert.match(nonWebContent(bytes(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1), 'setup.bin'), /installer/);
  assert.match(nonWebContent(str('#!/bin/sh\nrm -rf /'), 'run.bin'), /shell script/);
  const dmg = new Uint8Array(4096); dmg.set(str('koly'), 4096 - 512);
  assert.match(nonWebContent(dmg, 'x.bin'), /disk image/);
});

test('web files pass', () => {
  assert.equal(nonWebContent(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a), 'a.png'), null);
  assert.equal(nonWebContent(bytes(0, 0x61, 0x73, 0x6d, 1, 0, 0, 0), 'game.wasm'), null);
  assert.equal(nonWebContent(str('glTF\x02\0\0\0'), 'hero.glb'), null);
  assert.equal(nonWebContent(str('wOF2\0\x01\0\0'), 'f.woff2'), null);
  assert.equal(nonWebContent(str('UnityWebData1.0\0'), 'Build/game.data'), null);
  assert.equal(nonWebContent(str('GDPC\x02\0\0\0'), 'index.pck'), null);
  assert.equal(nonWebContent(str('#!/usr/bin/env node\nconsole.log(1)'), 'tool.js'), null);   // a hashbang in JavaScript is still JavaScript
  assert.match(nonWebContent(str('MZ\x90\0'), 'notes.txt'), /Windows/);   // a program named .txt is still a program
});

test('pages that lead away from the game are flagged', () => {
  assert.match(nonWebPage('<a href="downloads/MyGame-setup.exe">Download</a>')[0].message, /native download: downloads\/MyGame-setup\.exe/);
  assert.match(nonWebPage("fetch('/files/game.apk?v=2')")[0].message, /game\.apk/);
  assert.match(nonWebPage('<a href="https://play.google.com/store/apps/details?id=x">Get it</a>')[0].message, /app-store/);
  assert.match(nonWebPage('<a href="itms-services://?action=download-manifest">Install</a>')[0].message, /app-store/);
  assert.match(nonWebPage("window.location.href = 'https://elsewhere.example/'")[0].message, /another site/);
  assert.match(nonWebPage('location.replace("https://x.example")')[0].message, /another site/);
  assert.match(nonWebPage('<meta http-equiv="refresh" content="0; url=https://x.example">')[0].message, /another site/);
  assert.match(nonWebPage('<a href="Game.dmg">Mac</a>')[0].message, /Game\.dmg/);
  assert.match(nonWebPage("window.open('setup.exe')")[0].message, /setup\.exe/);
  assert.match(nonWebPage("t('op.dmg'); a.download = 'game.apk';")[0].message, /native download: game\.apk/);
});

test('ordinary game code is not flagged', () => {
  for (const src of [
    "const ext = '.exe'; if (name.endsWith(ext)) {}",
    "location.reload(); const u = new URL(location.href); location.hash = '#menu';",
    "<a href='https://example.com/credits'>Credits</a>",
    "const shareUrl = 'https://twitter.com/intent/tweet?text=' + score;",
    "t('op.dmg', { n: 3 }); const k = { 'stat.dmg': 1, 'build.exe': 2 }; label = 'hit.dmg';",   // keys that end like a file name are not links
  ]) assert.deepEqual(nonWebPage(src), [], src);
});

test('the platform\'s own kits, SDK, templates and three.js are not flagged', () => {
  const files = [];
  const walk = (d) => { for (const n of readdirSync(d)) { const p = join(d, n); statSync(p).isDirectory() ? walk(p) : /\.(js|mjs|html)$/.test(n) && files.push(p); } };
  for (const d of ['web/public/kits', 'web/public/sdk', 'web/public/templates', 'node_modules/three/build', 'node_modules/three/examples/jsm']) walk(d);
  assert.ok(files.length > 50);
  for (const f of files) assert.deepEqual(nonWebPage(readFileSync(f, 'utf8')).map((x) => x.message), [], f);
});

// The same checks as deploy_preview runs them on a workspace (checkProject), against an in-memory stand-in for D1 and R2.
register('./ts-hook.mjs', import.meta.url);
const { checkProject } = await import('../src/projects.ts');

function envWith(files) {
  const enc = new TextEncoder(), rows = Object.entries(files).map(([path, s]) => ({ path, size: enc.encode(s).length, sha: 'x', ctype: 'text/plain', updated_at: 0 }));
  const DB = { prepare: (sql) => { const q = { bind: () => q, all: async () => ({ results: /FROM files/.test(sql) ? rows : [] }), first: async () => null, run: async () => ({}) }; return q; } };
  const FILES = { get: async (key) => { const path = Object.keys(files).find((p) => key.endsWith('/' + p)); return path === undefined ? null : { text: async () => files[path] }; } };
  return { DB, FILES };
}
const project = { id: 'p1', slug: 'g', owner_id: 'u' };
const check = (files) => checkProject(envWith(files), project, 'https://play.example');
const syntax = (r) => r.errors.filter((e) => /syntax/i.test(e.message));

test('a minified ES module with export{...} mid-line parses as a module', async () => {
  const pixi = 'var a=1;function b(){return a}export{b as default,a as ALPHA};';   // no import/export at the start of a line
  const r = await check({
    'index.html': '<!doctype html><script type="module" src="./src/main.js"></script>',
    'src/main.js': "import * as PIXI from '../lib/pixi.min.mjs';\nimport x from '../lib/helper.js';\nGCP.ready();",
    'lib/pixi.min.mjs': pixi,
    'lib/helper.js': pixi,   // a .js file reached only through the module graph
    'loose.js': 'var c=2;export{c};',   // not reached from the page: retried as a module
  });
  assert.deepEqual(syntax(r), []);
});

test('a real syntax error in a script is still reported', async () => {
  const r = await check({ 'index.html': '<!doctype html><script src="a.js"></script><script>GCP.ready()</script>', 'a.js': 'const a = ;' });
  assert.equal(syntax(r).length, 1);
  assert.equal(syntax(r)[0].file, 'a.js');
});

test('an i18n key ending in .dmg is not a native download, a link to one is', async () => {
  const ok = await check({ 'index.html': '<!doctype html><script type="module" src="m.js"></script>', 'm.js': "const s = t('op.dmg', { n: 3 }); GCP.ready();" });
  assert.deepEqual(ok.errors.filter((e) => /native download/.test(e.message)), []);
  const bad = await check({ 'index.html': '<!doctype html><a href="Game.dmg">Mac</a><script>GCP.ready()</script>' });
  assert.equal(bad.errors.filter((e) => /native download/.test(e.message)).length, 1);
});
