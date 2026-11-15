// Finds every translatable string in the web app: t('English', '简体中文'[, vars]) and count(n, 'one', 'many', '简体中文').
// Used by tests/i18n.mjs (every string must exist in every language) and by `node scripts/i18n-scan.mjs` (prints what is missing).
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;

function files(dir) {
  return readdirSync(dir).flatMap((f) => { const p = join(dir, f); return statSync(p).isDirectory() ? (f === 'i18n' ? [] : files(p)) : /\.tsx?$/.test(f) ? [p] : []; });
}

/** Reads a JS string literal starting at i. Returns { value, end } or null (not a plain literal). */
function literal(src, i) {
  const q = src[i];
  if (q !== "'" && q !== '"' && q !== '`') return null;
  let j = i + 1;
  for (; j < src.length; j++) {
    if (src[j] === '\\') { j++; continue; }
    if (q === '`' && src[j] === '$' && src[j + 1] === '{') return { template: true, end: j };
    if (src[j] === q) break;
  }
  const raw = src.slice(i, j + 1);
  return { value: Function(`return ${raw}`)(), end: j + 1 };
}
const ws = (src, i) => { while (/\s/.test(src[i])) i++; return i; };
function skipArg(src, i) { // to the next top-level comma
  let d = 0;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === "'" || c === '"' || c === '`') { const l = literal(src, i); if (l && !l.template) { i = l.end - 1; continue; } }
    if ('([{'.includes(c)) d++; else if (')]}'.includes(c)) { if (d === 0) return i; d--; } else if (c === ',' && d === 0) return i;
  }
  return i;
}

export function scan() {
  const keys = new Map(), problems = [];
  const add = (en, zh, where) => { const k = keys.get(en); if (!k) keys.set(en, { zh, where, all: new Set([zh]) }); else k.all.add(zh); };
  for (const f of files(join(ROOT, 'web/src'))) {
    const src = readFileSync(f, 'utf8'), rel = relative(ROOT, f);
    const line = (i) => src.slice(0, i).split('\n').length;
    for (const m of src.matchAll(/(?<![\w.$])t\(/g)) {
      let i = ws(src, m.index + 2);
      if (src.startsWith('en:', i) || src[i] === ')') continue; // the definition itself
      const a = literal(src, i);
      if (!a || a.template) { if (!/^(en|one|many|s|x|label|word)\b/.test(src.slice(i, i + 6))) problems.push(`${rel}:${line(i)} t() needs plain string literals (use {name} placeholders and a vars object)`); continue; }
      i = ws(src, a.end); if (src[i] !== ',') { problems.push(`${rel}:${line(i)} t() is missing its 简体中文 string`); continue; }
      i = ws(src, i + 1); const b = literal(src, i);
      if (!b || b.template) { problems.push(`${rel}:${line(i)} t() needs plain string literals (use {name} placeholders and a vars object)`); continue; }
      add(a.value, b.value, `${rel}:${line(m.index)}`);
    }
    for (const m of src.matchAll(/(?<![\w.$])count\(/g)) {
      let i = skipArg(src, m.index + 6); if (src[i] !== ',') continue;
      const out = [];
      for (let k = 0; k < 3; k++) { i = ws(src, i + 1); const l = literal(src, i); if (!l || l.template) break; out.push(l.value); i = ws(src, l.end); }
      if (out.length === 3) { add(out[0], out[2], `${relative(ROOT, f)}:${line(m.index)}`); add(out[1], out[2], `${relative(ROOT, f)}:${line(m.index)}`); }
    }
  }
  // Admin settings come from the Worker in English: their labels and groups are translated in the web app.
  const settings = readFileSync(join(ROOT, 'src/settings.ts'), 'utf8');
  const server = new Map();
  for (const m of settings.matchAll(/\b(label|group|help): (['"])((?:\\.|(?!\2).)*)\2/g)) server.set(Function(`return ${m[2]}${m[3]}${m[2]}`)(), 'src/settings.ts');
  for (const m of settings.matchAll(/\boptions: \[([^\]]*)\]/g)) for (const o of m[1].matchAll(/(['"])((?:\\.|(?!\1).)*)\1/g)) server.set(o[2], 'src/settings.ts');
  return { keys, server, problems };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { keys, server, problems } = scan();
  const mode = process.argv[2];
  if (mode === '--dump') { console.log(JSON.stringify({ keys: Object.fromEntries([...keys].map(([k, v]) => [k, v.zh])), server: [...server.keys()] }, null, 1)); process.exit(0); }
  if (mode === '--missing') { // node scripts/i18n-scan.mjs --missing ja  → the strings ja.json lacks, as JSON to translate
    const lang = process.argv[3], dict = JSON.parse(readFileSync(join(ROOT, `web/src/i18n/${lang}.json`), 'utf8')), out = {};
    for (const [en, v] of keys) if (lang !== 'zh' && !(en in dict)) out[en] = v.zh;
    for (const en of server.keys()) if (!(en in dict)) out[en] = '';
    console.log(JSON.stringify(out, null, 1)); process.exit(0);
  }
  console.log(`${keys.size} strings in the web app, ${server.size} from admin settings`);
  for (const p of problems) console.log('  ' + p);
}
