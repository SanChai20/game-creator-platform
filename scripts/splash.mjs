// Launch screens for the Home Screen app on iPhone and iPad. iOS ignores the manifest's colours and shows a white screen
// while the app starts unless a picture of exactly the screen's size is linked with apple-touch-startup-image, one per
// screen and orientation. This draws them (HearthCade's mark on the dark splash the player shows too) into
// web/public/splash/ and rewrites the block between the splash markers in web/index.html.
// Run after adding a device or changing the mark: node scripts/splash.mjs (uses the pre-installed Playwright Chromium),
// then shrink them to 64 colours (they are flat): python3 -c "import glob;from PIL import Image;[Image.open(f).convert('RGB').quantize(64).save(f,optimize=True) for f in glob.glob('web/public/splash/*.png')]"
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';

const ROOT = new URL('..', import.meta.url);
const OUT = new URL('web/public/splash/', ROOT);
const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = await import('playwright')); }

// Screens in CSS px (portrait) and their device pixel ratio. Devices that share a size share a picture.
export const SCREENS = [
  // iPad
  { w: 1032, h: 1376, dpr: 2, name: 'iPad Pro 13" (M4 and later)' },
  { w: 1024, h: 1366, dpr: 2, name: 'iPad Pro 12.9", iPad Air 13"' },
  { w: 834, h: 1210, dpr: 2, name: 'iPad Pro 11" (M4 and later)' },
  { w: 834, h: 1194, dpr: 2, name: 'iPad Pro 11"' },
  { w: 820, h: 1180, dpr: 2, name: 'iPad Air 10.9" and 11", iPad 10th gen and later' },
  { w: 834, h: 1112, dpr: 2, name: 'iPad Air 10.5", iPad Pro 10.5"' },
  { w: 810, h: 1080, dpr: 2, name: 'iPad 10.2"' },
  { w: 768, h: 1024, dpr: 2, name: 'iPad 9.7", iPad mini 5' },
  { w: 744, h: 1133, dpr: 2, name: 'iPad mini 6 and later' },
  // iPhone
  { w: 440, h: 956, dpr: 3, name: 'iPhone 16 and 17 Pro Max' },
  { w: 402, h: 874, dpr: 3, name: 'iPhone 16 and 17 Pro, iPhone 17' },
  { w: 420, h: 912, dpr: 3, name: 'iPhone Air' },
  { w: 430, h: 932, dpr: 3, name: 'iPhone 14 Pro Max, 15 and 16 Plus, 15 Pro Max' },
  { w: 393, h: 852, dpr: 3, name: 'iPhone 14 Pro, 15, 15 Pro, 16' },
  { w: 428, h: 926, dpr: 3, name: 'iPhone 12 and 13 Pro Max, 14 Plus' },
  { w: 390, h: 844, dpr: 3, name: 'iPhone 12, 13, 14, 12 and 13 Pro' },
  { w: 375, h: 812, dpr: 3, name: 'iPhone X, XS, 11 Pro, 12 and 13 mini' },
  { w: 414, h: 896, dpr: 3, name: 'iPhone XS Max, 11 Pro Max' },
  { w: 414, h: 896, dpr: 2, name: 'iPhone XR, 11' },
  { w: 375, h: 667, dpr: 2, name: 'iPhone 6 to 8, SE 2nd and 3rd gen' },
];

const mark = readFileSync(new URL('web/public/favicon.svg', ROOT), 'utf8');
const font = readFileSync(new URL('web/public/fonts/bricolage-grotesque-latin.woff2', ROOT)).toString('base64');
const page = `<!doctype html><html><head><style>
@font-face { font-family: B; src: url(data:font/woff2;base64,${font}) format('woff2'); font-weight: 200 800; }
html, body { margin: 0; height: 100%; background: #111015; }
body { display: grid; place-content: center; justify-items: center; }
.m { display: flex; align-items: center; gap: 3.2vmin; }
.m svg { width: 15vmin; height: 15vmin; }
.m b { font: 800 8.4vmin/1 B, sans-serif; font-stretch: 80%; letter-spacing: .04em; text-transform: uppercase; color: #fff7ee; }
</style></head><body><div class="m">${mark}<b>HearthCade</b></div></body></html>`;

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
const links = [];
for (const s of SCREENS) {
  for (const landscape of [false, true]) {
    const [w, h] = landscape ? [s.h, s.w] : [s.w, s.h];
    const file = `${w * s.dpr}x${h * s.dpr}.png`;
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: s.dpr });
    const p = await ctx.newPage();
    await p.setContent(page); await p.evaluate(() => document.fonts.ready);
    await p.screenshot({ path: new URL(file, OUT).pathname });
    await ctx.close();
    links.push(`<link rel="apple-touch-startup-image" href="/splash/${file}" media="(device-width: ${s.w}px) and (device-height: ${s.h}px) and (-webkit-device-pixel-ratio: ${s.dpr}) and (orientation: ${landscape ? 'landscape' : 'portrait'})">`);
  }
}
await browser.close();

const html = new URL('web/index.html', ROOT), src = readFileSync(html, 'utf8');
const block = `<!--splash: launch screens for the Home Screen app, written by scripts/splash.mjs-->\n${links.join('\n')}\n<!--/splash-->`;
const next = src.includes('<!--/splash-->') ? src.replace(/<!--splash: [\s\S]*?<!--\/splash-->/, block)
  : src.includes('<!--splash-->') ? src.replace('<!--splash-->', block) : src.replace('</head>', block + '\n</head>');
writeFileSync(html, next);
console.log(`${links.length} launch screens in web/public/splash/`);
