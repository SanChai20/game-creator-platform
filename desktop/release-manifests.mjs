// Writes the two manifests a desktop release carries, next to the installers in <dir> (.github/workflows/desktop.yml):
//   hearthcade-desktop.json  the version and files, for the Get the app page (/download/desktop/info.json)
//   latest.json              the Tauri updater's manifest (/download/desktop/latest.json), only when the installers
//                            were signed with the updater key (their .sig files are there)
// Usage: V=<version> TAG=<tag> REPO=<owner/name> node desktop/release-manifests.mjs <dir>
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2], { V: version, TAG: tag, REPO: repo } = process.env;
if (!dir || !version || !tag || !repo) throw new Error('usage: V=<version> TAG=<tag> REPO=<owner/name> node release-manifests.mjs <dir>');
const url = (f) => `https://github.com/${repo}/releases/download/${tag}/${f}`;
const pub_date = new Date().toISOString();

// Which file updates which installed app. A .deb install looks for linux-x86_64-deb and an AppImage for
// linux-x86_64-appimage; there is deliberately no plain linux-x86_64, which would hand a .deb install the AppImage.
// The macOS build is universal, so both Mac architectures take the same archive.
export const UPDATES = {
  'windows-x86_64-nsis': 'HearthCade-Windows-x64-setup.exe',
  'windows-x86_64': 'HearthCade-Windows-x64-setup.exe',
  'darwin-aarch64-app': 'HearthCade-macOS.app.tar.gz',
  'darwin-x86_64-app': 'HearthCade-macOS.app.tar.gz',
  'darwin-aarch64': 'HearthCade-macOS.app.tar.gz',
  'darwin-x86_64': 'HearthCade-macOS.app.tar.gz',
  'linux-x86_64-appimage': 'HearthCade-Linux-x86_64.AppImage',
  'linux-x86_64-deb': 'HearthCade-Linux-amd64.deb',
};

const files = readdirSync(dir).filter((f) => !f.endsWith('.sig') && !f.endsWith('.json')).sort();
writeFileSync(join(dir, 'hearthcade-desktop.json'), JSON.stringify({ version, tag, pub_date, files }, null, 2) + '\n');

const platforms = {};
for (const [target, file] of Object.entries(UPDATES)) {
  const sig = join(dir, file + '.sig');
  if (existsSync(sig)) platforms[target] = { signature: readFileSync(sig, 'utf8').trim(), url: url(file) };
}
if (Object.keys(platforms).length) {
  writeFileSync(join(dir, 'latest.json'), JSON.stringify({ version, notes: `HearthCade desktop ${version}`, pub_date, platforms }, null, 2) + '\n');
  console.log(`latest.json: ${Object.keys(platforms).join(', ')}`);
} else {
  console.log('no updater signatures (TAURI_SIGNING_PRIVATE_KEY is not set): no latest.json, installed apps keep their shell');
}
