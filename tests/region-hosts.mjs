// Hosts some regions block: deploy_preview warns when a game loads its fonts, libraries, analytics or video from them.
// Plain node, no server.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { blockedHost, regionBlockedRefs, regionWarning } from '../src/region-hosts.js';

test('Google Fonts, YouTube and analytics are flagged with what to do instead', () => {
  const html = '<!doctype html>\n<link href="https://fonts.googleapis.com/css2?family=Inter" rel="stylesheet">\n<script async src="https://www.googletagmanager.com/gtag/js?id=G-1"></script>\n<iframe src="//www.youtube.com/embed/x"></iframe>';
  const refs = regionBlockedRefs(html);
  assert.deepEqual(refs.map((r) => [r.host, r.line]), [['fonts.googleapis.com', 2], ['www.googletagmanager.com', 3], ['www.youtube.com', 4]]);
  assert.match(refs[0].instead, /woff2/);
  const w = regionWarning('index.html', refs[0]);
  assert.equal(w.file, 'index.html'); assert.equal(w.line, 2); assert.match(w.message, /mainland China/);
});

test('CSS and JavaScript are scanned, each host once', () => {
  assert.deepEqual(regionBlockedRefs("@import url('https://fonts.googleapis.com/css?family=A');\n@font-face{src:url(https://fonts.gstatic.com/s/a.woff2)}\n@import url('https://fonts.googleapis.com/css?family=B');").map((r) => r.host), ['fonts.googleapis.com', 'fonts.gstatic.com']);
  assert.deepEqual(regionBlockedRefs("fetch(`https://my-app.firebaseio.com/scores.json`)").map((r) => r.what), ['Firebase']);
});

test('hosts that are reachable, and look-alikes, are not flagged', () => {
  assert.deepEqual(regionBlockedRefs('<script src="https://cdnjs.cloudflare.com/ajax/libs/x.js"></script> https://hearthcade.com/kits/v1/core.js https://notyoutube.com/a https://example.com/fonts.googleapis.com.html'), []);
  assert.equal(blockedHost('notgoogle-analytics.com'), null);
  assert.equal(blockedHost('region1.google-analytics.com').what, 'Google Analytics');
  assert.equal(blockedHost('FONTS.GSTATIC.COM.').host, 'fonts.gstatic.com');
});
