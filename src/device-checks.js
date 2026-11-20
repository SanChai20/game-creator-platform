// Device checks at deploy: what in a game's code keeps it from running on iPhone and iPad (Safari's engine, which every
// browser on iOS uses) and that the game runtime (web/public/sdk/gcp.js) cannot fill in for it. Plain JS with no imports,
// so the Worker's static checks (src/projects.ts) and the tests share it.
//
// The runtime already fills in, for every game: canvas roundRect, at/findLast/hasOwn/structuredClone and the other
// built-ins listed in docs/game-runtime.md, requestIdleCallback, navigator.vibrate, the fullscreen API, orientation lock,
// audio that starts on the first tap, and storage the browser refuses. Nothing of that is reported here. What is left is
// what no script can add: new syntax an older engine cannot parse (the whole file fails to load), browser features
// Safari does not have at all, and audio files it cannot play. These are warnings, never errors: the game still runs on
// every browser that has them, and the creator decides whether older iPhones matter for it.

/** Syntax Safari parses only from a given version. The baseline the platform targets is Safari and iOS 15.4. */
export const SAFARI_BASELINE = 15.4;
const SYNTAX = {
  'regex-lookbehind': { safari: 16.4, label: 'a regular expression with lookbehind ((?<=…) or (?<!…))' },
  'class-static-block': { safari: 16.4, label: 'a class static initialization block (static { … })' },
  'regex-v-flag': { safari: 17, label: 'a regular expression with the v flag' },
  'import-attributes': { safari: 17.2, label: 'an import with attributes (import … with { type: … })' },
  'regex-modifiers': { safari: 26, label: 'a regular expression with inline modifiers ((?i:…))' },
  'using-declaration': { safari: Infinity, label: 'a using or await using declaration' },
};

/** Browser features Safari on iPhone and iPad does not have in any version. Matched in the code as written. */
const MISSING = [
  { id: 'web-midi', rx: /\brequestMIDIAccess\b/, label: 'Web MIDI (navigator.requestMIDIAccess)' },
  { id: 'file-system-access', rx: /\b(showOpenFilePicker|showSaveFilePicker|showDirectoryPicker)\b/, label: 'the File System Access pickers (showOpenFilePicker and the like)' },
  { id: 'web-usb', rx: /\bnavigator\s*\.\s*(usb|hid|serial)\b/, label: 'WebUSB, WebHID or Web Serial' },
  { id: 'web-bluetooth', rx: /\bnavigator\s*\.\s*bluetooth\b/, label: 'Web Bluetooth' },
];

const safariName = (v) => (v === Infinity ? 'any version of Safari (every browser on iPhone and iPad)' : `Safari and iOS before ${v}`);

/** Walks an acorn AST and returns the newer syntax it uses: [{ id, line }], the first place of each. */
export function syntaxFindings(ast) {
  const out = new Map(), mark = (id, node) => { if (!out.has(id)) out.set(id, node && node.loc ? node.loc.start.line : undefined); };
  const stack = [ast];
  while (stack.length) {
    const n = stack.pop();
    if (!n || typeof n !== 'object') continue;
    if (Array.isArray(n)) { for (const x of n) stack.push(x); continue; }
    if (typeof n.type === 'string') {
      if (n.type === 'Literal' && n.regex) {
        const p = n.regex.pattern, f = n.regex.flags;
        if (/\(\?<[=!]/.test(p.replace(/\\./g, ''))) mark('regex-lookbehind', n);
        if (f.includes('v')) mark('regex-v-flag', n);
        if (/\(\?[ims]*-?[ims]+:/.test(p.replace(/\\./g, ''))) mark('regex-modifiers', n);
      } else if (n.type === 'StaticBlock') mark('class-static-block', n);
      else if ((n.type === 'ImportDeclaration' || n.type === 'ExportNamedDeclaration' || n.type === 'ExportAllDeclaration') && n.attributes && n.attributes.length) mark('import-attributes', n);
      else if (n.type === 'ImportExpression' && n.options) mark('import-attributes', n);
      else if (n.type === 'VariableDeclaration' && /using/.test(n.kind)) mark('using-declaration', n);
    }
    for (const k in n) { if (k === 'loc' || k === 'start' || k === 'end' || k === 'regex') continue; const v = n[k]; if (v && typeof v === 'object') stack.push(v); }
  }
  return [...out].map(([id, line]) => ({ id, line }));
}

/** Browser features the code names that Safari does not have: [{ id, line }]. */
export function apiFindings(src) {
  const out = [];
  for (const m of MISSING) {
    const hit = m.rx.exec(src);
    if (hit) out.push({ id: m.id, line: src.slice(0, hit.index).split('\n').length });
  }
  return out;
}

/**
 * The warnings for one deploy. files: [{ file, src, ast }] for the game's JavaScript (ast may be null where it did not
 * parse: that is reported elsewhere), paths: every file in the bundle. Returns { issues, minSafari } where minSafari is the
 * oldest Safari that can load all of the code (null when that is the baseline or older).
 */
export function deviceIssues(files, paths) {   // a file may carry its findings already (syntax, apis) instead of ast and src
  const issues = [], seen = new Set();
  let minSafari = null;
  for (const { file, src, ast, syntax, apis, lineOffset = 0 } of files) {
    for (const f of syntax || (ast ? syntaxFindings(ast) : [])) {
      const s = SYNTAX[f.id]; if (!s || s.safari <= SAFARI_BASELINE || seen.has(f.id)) continue;
      seen.add(f.id); minSafari = Math.max(minSafari || 0, s.safari);
      issues.push({ file, line: f.line === undefined ? undefined : f.line + lineOffset, message: `iPhone and iPad: this file uses ${s.label}, which ${safariName(s.safari)} cannot parse, so the whole file fails to load there.`,
        hint: s.safari === Infinity ? 'Rewrite it without this syntax (try/finally instead of using).' : `Rewrite it with older syntax, or declare requirements.browsers.safari ${Math.ceil(s.safari)} with the compatibility tool so players on older iPhones and iPads are told before they start.` });
    }
    for (const f of apis || (src ? apiFindings(src) : [])) {
      const m = MISSING.find((x) => x.id === f.id); if (seen.has(f.id)) continue;
      seen.add(f.id);
      issues.push({ file, line: f.line + lineOffset, message: `iPhone and iPad: the code uses ${m.label}, which Safari does not have in any version.`,
        hint: 'Fine if the game only uses it when it is there (check for it first) and plays without it. Otherwise the game cannot be played on iPhone and iPad.' });
    }
  }
  // Sound: Safari on iPhone and iPad plays Ogg (Vorbis, Opus) only from iOS 18.4. A game that ships its sound only as Ogg is
  // silent before that.
  const audio = (paths || []).filter((p) => /\.(ogg|oga|opus|mp3|m4a|aac|wav|webm|flac|caf)$/i.test(p));
  const ogg = audio.filter((p) => /\.(ogg|oga|opus)$/i.test(p));
  if (ogg.length && ogg.length === audio.length) issues.push({ file: ogg[0], message: `iPhone and iPad: all ${ogg.length} sound file(s) are Ogg, which Safari plays only from iOS 18.4, so the game is silent on older iPhones and iPads.`,
    hint: 'Ship the sound as .mp3 or .m4a as well (or instead), and pick the format with new Audio().canPlayType().' });
  return { issues, minSafari };
}
