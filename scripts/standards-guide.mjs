// Writes web/public/guides/standards.md from the standards registry (src/standards.js), and the safe-area template
// image (web/public/guides/safe-area-template.png) from its numbers. Run after changing the registry:
//   node scripts/standards-guide.mjs          (the guide only)
//   node scripts/standards-guide.mjs --image  (the guide and the template; needs Playwright)
// tests/standards.mjs fails when the committed guide is not what the registry renders.
import { writeFileSync } from 'node:fs';
import { renderStandards, safeAreaSvg } from '../src/standards.js';

const root = new URL('../', import.meta.url);
writeFileSync(new URL('web/public/guides/standards.md', root), renderStandards(''));
console.log('wrote web/public/guides/standards.md');
if (process.argv.includes('--image')) {
  const { createRequire } = await import('node:module');
  const { chromium } = await import('playwright').catch(() => createRequire(import.meta.url)('playwright'));   // a global install via NODE_PATH
  const b = await chromium.launch(), svg = safeAreaSvg();
  const p = await b.newPage({ viewport: { width: 1000, height: 560 }, deviceScaleFactor: 2 });
  await p.setContent(`<html><body style="margin:0;background:#fff">${svg}</body></html>`);
  await p.locator('svg').screenshot({ path: new URL('web/public/guides/safe-area-template.png', root).pathname });
  await b.close();
  console.log('wrote web/public/guides/safe-area-template.png');
}
