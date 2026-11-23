// The desktop app (desktop/, docs/apps.md): a shell that opens the live site and never carries the web app, the site's
// stable download addresses for its installers and updater manifest (src/desktop.ts), and the Get the app page's
// choice of download (web/src/desktop-app.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { desktop, desktopTarget, DESKTOP_FILES, DESKTOP_RELEASES } from '../src/desktop.ts';
import { desktopOs, DOWNLOAD } from '../web/src/desktop-app.ts';

const conf = JSON.parse(readFileSync('desktop/src-tauri/tauri.conf.json', 'utf8'));
const main = readFileSync('desktop/src-tauri/src/main.rs', 'utf8');
const workflow = readFileSync('.github/workflows/desktop.yml', 'utf8');

test('the shell opens the live site and carries no copy of the web app', () => {
  assert.match(main, /const HOME: &str = "https:\/\/hearthcade\.com\/";/);
  assert.match(main, /WebviewUrl::External\(HOME/);
  assert.equal(conf.build.frontendDist, '../shell');   // the only local files: one page that sends you to the site
  assert.deepEqual(readdirSync('desktop/shell'), ['index.html']);
  assert.ok(!conf.build.beforeBuildCommand, 'the shell build never builds the web app');
  assert.deepEqual(conf.app.windows, []);   // main.rs makes the one window
});

test('shell updates come from the site and are signed', () => {
  assert.deepEqual(conf.plugins.updater.endpoints, ['https://hearthcade.com/download/desktop/latest.json']);
  assert.ok(conf.plugins.updater.pubkey.length > 40);
  assert.equal(conf.version, '../package.json');
  assert.equal(conf.bundle.createUpdaterArtifacts, true);
});

test('every installer has a stable address that the workflow publishes under the same name', () => {
  for (const [os, file] of Object.entries(DESKTOP_FILES)) {
    assert.equal(desktopTarget(os), `${DESKTOP_RELEASES}/${file}`);
    assert.ok(workflow.includes(file), `${file} is collected by the workflow`);
    assert.equal(DOWNLOAD[os], `/download/desktop/${os}`);
  }
  assert.equal(desktopTarget('latest.json'), `${DESKTOP_RELEASES}/latest.json`);
  assert.equal(desktopTarget('info.json'), `${DESKTOP_RELEASES}/hearthcade-desktop.json`);
  for (const bad of ['', 'toString', '__proto__', 'constructor', '../windows', 'mac.dmg']) assert.equal(desktopTarget(bad), null, bad);
});

test('the updater manifest never hands a .deb install the AppImage', () => {
  const src = readFileSync('desktop/release-manifests.mjs', 'utf8');
  assert.ok(!/'linux-x86_64':/.test(src));
  assert.match(src, /'linux-x86_64-deb': 'HearthCade-Linux-amd64\.deb'/);
  assert.match(src, /'linux-x86_64-appimage': 'HearthCade-Linux-x86_64\.AppImage'/);
});

test('download addresses redirect; the manifests say when there is nothing yet', async () => {
  const r = await desktop.request('/windows');
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), `${DESKTOP_RELEASES}/HearthCade-Windows-x64-setup.exe`);
  assert.equal((await desktop.request('/nope')).status, 404);
  const real = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response('Not Found', { status: 404 });
    assert.deepEqual(await (await desktop.request('/info.json')).json(), { available: false });
    assert.equal((await desktop.request('/latest.json')).status, 204);   // "no update" to the Tauri updater
    globalThis.fetch = async () => Response.json({ version: '0.2.0', files: [] });
    assert.deepEqual(await (await desktop.request('/info.json')).json(), { available: true, version: '0.2.0', files: [] });
    assert.equal((await (await desktop.request('/latest.json')).json()).version, '0.2.0');
  } finally { globalThis.fetch = real; }
});

test('the Get the app page offers the download for this computer, and none on phones and tablets', () => {
  const d = (userAgent, maxTouchPoints = 0) => desktopOs({ userAgent, maxTouchPoints });
  assert.equal(d('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0 Safari/537.36'), 'windows');
  assert.equal(d('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15'), 'mac');
  assert.equal(d('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15', 5), null);   // an iPad
  assert.equal(d('Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0'), 'linux');
  assert.equal(d('Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0 Mobile Safari/537.36'), null);
  assert.equal(d('Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1'), null);
  assert.equal(d('Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0 Safari/537.36'), null);
});
