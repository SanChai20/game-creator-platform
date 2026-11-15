// Web games only: the byte sniffing that refuses programs and archives, and the page scan that refuses downloads,
// store installs and redirects. Plain node, no server.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
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
});

test('ordinary game code is not flagged', () => {
  for (const src of [
    "const ext = '.exe'; if (name.endsWith(ext)) {}",
    "location.reload(); const u = new URL(location.href); location.hash = '#menu';",
    "<a href='https://example.com/credits'>Credits</a>",
    "const shareUrl = 'https://twitter.com/intent/tweet?text=' + score;",
  ]) assert.deepEqual(nonWebPage(src), [], src);
});

test('the platform\'s own kits, SDK, templates and three.js are not flagged', () => {
  const files = [];
  const walk = (d) => { for (const n of readdirSync(d)) { const p = join(d, n); statSync(p).isDirectory() ? walk(p) : /\.(js|mjs|html)$/.test(n) && files.push(p); } };
  for (const d of ['web/public/kits', 'web/public/sdk', 'web/public/templates', 'node_modules/three/build', 'node_modules/three/examples/jsm']) walk(d);
  assert.ok(files.length > 50);
  for (const f of files) assert.deepEqual(nonWebPage(readFileSync(f, 'utf8')).map((x) => x.message), [], f);
});
