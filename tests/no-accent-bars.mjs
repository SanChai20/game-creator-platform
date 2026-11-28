// Design rule (CLAUDE.md, "No accent bars"): the site never marks something with a coloured stripe on one side: no left,
// right, top or bottom border bar, no one-sided inset shadow, no thin pseudo-element bar, on tabs, nav items, cards,
// notices, quotes, headings or anything else. A current tab is a filled plate or pill, a highlight is a soft background,
// emphasis is colour and weight. This test reads every stylesheet and component so a stripe cannot come back unnoticed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = new URL('../web/src/', import.meta.url).pathname;
function files(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) files(p, out); else if (/\.(css|tsx)$/.test(e.name)) out.push(p);
  }
  return out;
}
/** CSS rules as [selector, body, file:line]. */
function rules(file) {
  const src = fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '));
  const out = [], re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(src))) out.push([m[1].trim(), m[2], `${path.relative(ROOT, file)}:${src.slice(0, m.index + m[1].length).split('\n').length}`]);
  return out;
}
const px = (v) => parseFloat(v) || 0;

test('no coloured stripe on one side of anything', () => {
  const bad = [];
  for (const f of files(ROOT)) {
    if (f.endsWith('.tsx')) {
      // inline styles: borderLeft / borderBottom / … of 2px or more
      const src = fs.readFileSync(f, 'utf8');
      for (const m of src.matchAll(/border(Left|Right|Top|Bottom|InlineStart|InlineEnd)\s*:\s*['"`](\d+(?:\.\d+)?)px/g)) if (px(m[2]) >= 2) bad.push(`${path.relative(ROOT, f)}: inline border${m[1]} ${m[2]}px`);
      continue;
    }
    for (const [sel, body, at] of rules(f)) {
      // a triangle, chevron, tick or spinner drawn with borders (a transparent side, currentColor, a rotation, a circle)
      // is a shape, not a stripe
      const shape = /transparent|currentColor|rotate\(|border-radius:\s*50%|animation:\s*spin/.test(body);
      for (const m of body.matchAll(/border-(left|right|top|bottom|inline-start|inline-end|block-start|block-end)\s*:\s*(\d*\.?\d+)px\s+(solid|dashed|double)/g)) {
        if (!shape && px(m[2]) >= 1.5) bad.push(`${at} ${sel}: border-${m[1]} ${m[2]}px`);
      }
      if (!shape) for (const m of body.matchAll(/border-(left|right|top|bottom)-color\s*:\s*var\(--(accent|area|a|info|warn|good|bad|edge|text)\b/g)) bad.push(`${at} ${sel}: border-${m[1]}-color ${m[2]}`);
      for (const m of body.matchAll(/inset\s+(-?\d*\.?\d+)(?:px)?\s+(-?\d*\.?\d+)(?:px)?\s+0(?:px)?\s/g)) {
        const x = px(m[1]), y = px(m[2]);
        if ((x === 0) !== (y === 0) && Math.max(Math.abs(x), Math.abs(y)) >= 2) bad.push(`${at} ${sel}: one-sided inset shadow ${m[0].trim()}`);
      }
      if (/::?(before|after)/.test(sel) && /position:\s*absolute/.test(body) && /background(-color)?:\s*(var\(--|hsl|#|rgb|linear|repeating)/.test(body)) {
        const w = body.match(/(?:^|[;\s])width:\s*(\d*\.?\d+)px/), h = body.match(/(?:^|[;\s])height:\s*(\d*\.?\d+)px/);
        if ((w && px(w[1]) >= 2 && px(w[1]) <= 6 && !(h && px(h[1]) <= 8)) || (h && px(h[1]) >= 2 && px(h[1]) <= 6 && !(w && px(w[1]) <= 8))) bad.push(`${at} ${sel}: a thin bar drawn by a pseudo-element`);
      }
    }
  }
  assert.deepEqual(bad, [], 'accent bars are not used on this site (CLAUDE.md, "No accent bars"):\n' + bad.join('\n'));
});
