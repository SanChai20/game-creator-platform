// Web games only. The platform hosts games that run in a browser page; these checks keep native builds,
// installers and pages that only forward players elsewhere out. Plain JavaScript so tests can import it directly.

/** Said first to every agent and shown to people where they create and publish games. */
export const WEB_ONLY = 'This platform hosts web games only: HTML, JavaScript, CSS and WebAssembly that run in a browser page. Native, mobile, console and desktop builds (exe, apk, ipa, dmg, msi and the like), archives of them, and pages that send players to a download or an app store are refused.';

/** What every refusal of a non-web upload says to do instead. */
export const WEB_ONLY_HINT = 'Upload the web build of the game: index.html plus the HTML, JavaScript, CSS, WebAssembly and media files it loads. From an engine, use its Web / HTML5 / WebGL export (Unity: set Compression Format to Disabled) and upload that folder.';

const TEXT = new Set(['html', 'js', 'mjs', 'css', 'json', 'txt', 'md', 'svg', 'wgsl', 'glsl', 'map']);

/**
 * Names what a file really is when its first bytes say it is a program, an installer or an archive, whatever its
 * extension, so an exe renamed to .bin is still refused. Returns null for anything else.
 * @param {Uint8Array} b @param {string} path @returns {string | null}
 */
export function nonWebContent(b, path) {
  if (b.length < 4) return null;
  const at = (i, ...v) => v.every((x, k) => b[i + k] === x);
  const ascii = (i, t) => at(i, ...[...t].map((ch) => ch.charCodeAt(0)));
  if (at(0, 0x4d, 0x5a)) return 'a Windows program (exe or dll)';
  if (at(0, 0x7f, 0x45, 0x4c, 0x46)) return 'a Linux or Android program (ELF)';
  if (at(0, 0xfe, 0xed, 0xfa) || at(1, 0xfa, 0xed, 0xfe) || at(0, 0xca, 0xfe, 0xba, 0xbe)) return 'a macOS or iOS program (Mach-O) or a Java class';
  if (ascii(0, 'dex\n')) return 'Android bytecode (dex)';
  if (at(0, 0x50, 0x4b, 0x03, 0x04) || at(0, 0x50, 0x4b, 0x05, 0x06)) return 'a zip archive (zip, apk, ipa, jar or similar)';
  if (ascii(0, 'Rar!') || at(0, 0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c) || at(0, 0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00) || ascii(0, 'BZh') || at(0, 0x1f, 0x8b)) return 'a compressed archive (rar, 7z, xz, bzip2 or gzip)';
  if (at(0, 0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1)) return 'a Windows installer or Office file (msi, doc)';
  if (ascii(0, '!<arch>')) return 'a Debian package or static library';
  if (at(0, 0xed, 0xab, 0xee, 0xdb)) return 'an RPM package';
  if (b.length > 512 && ascii(b.length - 512, 'koly')) return 'a macOS disk image (dmg)';
  const ext = (path.match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase();
  if (!TEXT.has(ext) && ascii(0, '#!')) return 'a shell script';
  return null;
}

const NATIVE_LINK = /["'(=]\s*([^"'()\s<>]+\.(?:exe|msi|msix|appx|apk|aab|xapk|ipa|dmg|pkg|deb|rpm|appimage))(?:[?#][^"'()\s<>]*)?\s*["')]/gi;
// Only a real link counts: a URL or path (it has a slash or a scheme), or a bare name given to href, download, src, a
// location or window.open. A string that merely ends in ".dmg", such as the translation key 'op.dmg', is not a link.
const LINK_TARGET = /(?:\b(?:href|download|src|action|location|url)\s*[=:]\s*|\b(?:open|assign|replace|fetch)\s*\(\s*|\burl\(\s*)["']?\s*$/i;
function nativeLink(src) {
  NATIVE_LINK.lastIndex = 0;
  for (let m; (m = NATIVE_LINK.exec(src));) {
    if (/[/:\\]/.test(m[1]) || LINK_TARGET.test(src.slice(Math.max(0, m.index - 40), m.index + 1))) return m;
    NATIVE_LINK.lastIndex = m.index + 1;
  }
  return null;
}
const STORE_LINK = /\b(?:itms-services:|itms-apps:|market:\/\/|https?:\/\/(?:play\.google\.com\/store\/apps|apps\.apple\.com|itunes\.apple\.com\/(?:[a-z-]+\/)?app|apps\.microsoft\.com|www\.microsoft\.com\/(?:[a-z-]+\/)?store\/))/i;
const REDIRECT = /\blocation(?:\s*\.\s*href)?\s*=\s*["'`]https?:\/\/|\blocation\s*\.\s*(?:replace|assign)\s*\(\s*["'`]https?:\/\/|<meta[^>]+http-equiv=["']?refresh[^>]+url\s*=\s*["']?https?:\/\//i;

/**
 * Finds what makes a page something other than the game itself: a native download, an app-store install,
 * or a redirect to another site. One entry per kind, with the character index where it starts.
 * @param {string} src @returns {{ index: number, message: string, hint: string }[]}
 */
export function nonWebPage(src) {
  const out = [], native = nativeLink(src), store = STORE_LINK.exec(src), away = REDIRECT.exec(src);
  if (native) out.push({ index: native.index, message: `Links to a native download: ${native[1]}. This platform hosts web games only.`, hint: `Remove the download. ${WEB_ONLY_HINT}` });
  if (store) out.push({ index: store.index, message: `Links to an app-store install: ${store[0]}. This platform hosts web games only.`, hint: 'The game must be playable here, in the browser. Remove the store link.' });
  if (away) out.push({ index: away.index, message: 'Sends the player to another site. The platform hosts the game itself, not a page that forwards elsewhere.', hint: 'Remove the redirect; the game must run on this page.' });
  return out;
}
