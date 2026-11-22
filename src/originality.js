// Duplication checks without AI: fingerprints of a game's own code that survive renamed variables and moved
// whitespace, the files it shares byte for byte, and a perceptual hash of how it looks. Plus a rule-based answer
// to "is this upload a game at all". Plain JavaScript so node tests can import it directly.
import { tokenizer } from 'acorn';

const K = 12, W = 24;                     // k-gram length in tokens and winnowing window
export const SKETCH = 64;                  // fingerprints per game kept in the candidate index
export const MAX_PRINTS = 6000;            // fingerprints stored per version (the smallest hashes, consistently)
export const PRINTS_VERSION = 2;           // bump when tokens() or K change: stored fingerprints of older versions are recomputed

const fnv = (s) => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); } return h | 0; };

// Tokens a minifier adds, drops or swaps for one another. Leaving them out (and folding the swaps) makes the same code
// give the same fingerprints before and after minification: esbuild, terser and the like rewrite "if (a) b(); else c();"
// to "a ? b() : c()", merge declarations, drop braces and semicolons and turn true into !0.
const DROP = new Set([';', ',', '(', ')', '{', '}', '[', ']', 'var', 'let', 'const', 'else', ':', '!', 'void', '`', '${']);
const BRANCH = new Set(['if', '?', '&&', '||', '??']);

/** Tokens with names, strings and numbers folded, so renaming variables, changing constants or minifying does not hide a copy. */
export function tokens(src) {
  const out = [];
  const push = (v) => { if (DROP.has(v)) return; out.push(BRANCH.has(v) ? 'if' : v === 'true' || v === 'false' ? 'n' : v); };
  try {
    for (const t of tokenizer(src, { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true, allowReturnOutsideFunction: true, allowImportExportEverywhere: true, allowAwaitOutsideFunction: true })) {
      const label = t.type.label;
      push(label === 'name' ? 'v' : label === 'string' ? 's' : label === 'num' || label === 'bigint' ? 'n' : label === 'template' ? 's' : label === 'regexp' ? 'r' : t.type.keyword || label);
    }
    return out;
  } catch {
    // not parseable as JavaScript: fall back to a plain word and punctuation split
    for (const x of src.match(/[A-Za-z_$][\w$]*|\d+(?:\.\d+)?|&&|\|\||\?\?|[^\s\w]/g) || []) push(/^[A-Za-z_$]/.test(x) ? (KEYWORDS.has(x) ? x : 'v') : /^\d/.test(x) ? 'n' : x);
    return out;
  }
}
const KEYWORDS = new Set('break case catch class const continue debugger default delete do else export extends finally for function if import in instanceof let new return super switch this throw try typeof var void while with yield async await of'.split(' '));

/** Inline scripts of an HTML page (external ones are separate files). */
export const inlineScripts = (html) => [...String(html).matchAll(/<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]).filter((s) => s.trim() && !/^\s*\{\s*"imports"/.test(s));

/** Winnowed fingerprints of one source text (a set of 32-bit integers). */
export function fingerprints(src) {
  const tk = tokens(src), hashes = [];
  for (let i = 0; i + K <= tk.length; i++) hashes.push(fnv(tk.slice(i, i + K).join(' ')));
  const out = new Set();
  if (hashes.length <= W) { if (hashes.length) out.add(Math.min(...hashes)); return out; }
  for (let i = 0; i + W <= hashes.length; i++) { let m = hashes[i]; for (let j = i + 1; j < i + W; j++) if (hashes[j] <= m) m = hashes[j]; out.add(m); }
  return out;
}

/** Fingerprints of a whole bundle's own code (vendor files are left out by the caller), minus a baseline (templates, kits). */
export function bundlePrints(texts, baseline) {
  const all = new Set();
  for (const { path, text } of texts) {
    const parts = /\.html?$/i.test(path) ? inlineScripts(text) : [text];
    for (const p of parts) for (const h of fingerprints(p)) if (!baseline || !baseline.has(h)) all.add(h);
  }
  return [...all].sort((a, b) => a - b).slice(0, MAX_PRINTS);
}

/** True when a code file is mostly the game's own (not a template or kit file copied in), so an identical copy of it means something. */
export function distinctFile(path, text, baseline) {
  let all = 0, own = 0;
  for (const p of /\.html?$/i.test(path) ? inlineScripts(text) : [text]) for (const h of fingerprints(p)) { all++; if (!baseline || !baseline.has(h)) own++; }
  return own >= 10 && own >= all / 2;
}

/** The candidate-index sketch: the smallest fingerprints, which similar sets tend to share. */
export const sketchOf = (prints) => prints.slice(0, SKETCH);

/** Share of a's fingerprints found in b, estimated on the hash range both stored sets fully cover. */
export function containment(a, b) {
  if (!a.length || !b.length) return 0;
  const cut = (x) => (x.length >= MAX_PRINTS ? x[x.length - 1] : Infinity), limit = Math.min(cut(a), cut(b)), B = new Set(b);
  let n = 0, hit = 0;
  for (const h of a) { if (h > limit) break; n++; if (B.has(h)) hit++; }
  return n ? hit / n : 0;
}

/** A 64-bit difference hash (hex) and the dominant coarse colours of a decoded picture { w, h, bpp, stride, px }. */
export function lookOf(img) {
  if (!img || !img.w || !img.h) return null;
  const { w, h, bpp, stride, px } = img, gw = 9, gh = 8, cells = new Float64Array(gw * gh), cn = new Uint32Array(gw * gh), pal = new Map();
  const step = Math.max(1, Math.floor(Math.sqrt((w * h) / 40000)));
  for (let y = 0; y < h; y += step) for (let x = 0; x < w; x += step) {
    const i = y * stride + x * bpp, r = px[i], g = px[i + 1], b = px[i + 2], c = Math.min(gh - 1, (y * gh / h) | 0) * gw + Math.min(gw - 1, (x * gw / w) | 0);
    cells[c] += 0.299 * r + 0.587 * g + 0.114 * b; cn[c]++;
    const k = ((r >> 5) << 6) | ((g >> 5) << 3) | (b >> 5); pal.set(k, (pal.get(k) || 0) + 1);
  }
  let bits = '';
  for (let y = 0; y < gh; y++) for (let x = 0; x < gw - 1; x++) { const a = cells[y * gw + x] / Math.max(1, cn[y * gw + x]), b = cells[y * gw + x + 1] / Math.max(1, cn[y * gw + x + 1]); bits += a > b ? '1' : '0'; }
  let hex = ''; for (let i = 0; i < 64; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  const palette = [...pal].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k]) => k);
  return { dhash: hex, palette };
}

export function lookDistance(a, b) {
  if (!a || !b || !a.dhash || !b.dhash) return 64;
  let d = 0; for (let i = 0; i < 16; i++) { let x = parseInt(a.dhash[i], 16) ^ parseInt(b.dhash[i], 16); while (x) { d += x & 1; x >>= 1; } }
  return d;
}
export const paletteOverlap = (a, b) => (a && b && a.palette && b.palette && a.palette.length ? a.palette.filter((c) => b.palette.includes(c)).length / a.palette.length : 0);

/**
 * How much of game A is in game B.
 * @param {{ prints: number[], files: string[], assets: string[], look: any }} a  the new version
 * @param {{ prints: number[], files: string[], assets: string[], look: any }} b  a published game by someone else
 */
export function compare(a, b) {
  const code = containment(a.prints, b.prints);
  const sameFiles = a.files.length ? a.files.filter((s) => b.files.includes(s)).length / a.files.length : 0;
  const assets = a.assets.length ? a.assets.filter((s) => b.assets.includes(s)).length / a.assets.length : 0;
  const dist = lookDistance(a.look, b.look), pal = paletteOverlap(a.look, b.look);
  const looksAlike = dist <= 10 && pal >= 0.5;
  const enough = a.prints.length >= 40;                 // a few lines of code say nothing either way
  const small = a.prints.length >= 20;                  // a small game (a few KB) copied almost whole still counts
  let verdict = 'different';
  if ((enough && code >= 0.8) || (small && code >= 0.9) || sameFiles >= 0.8 || (enough && code >= 0.6 && (assets >= 0.5 || looksAlike)) || (assets >= 0.8 && a.assets.length >= 4 && looksAlike)) verdict = 'copy';
  else if ((enough && code >= 0.35) || (small && code >= 0.6) || (assets >= 0.5 && a.assets.length >= 3) || (looksAlike && enough && code >= 0.2) || sameFiles >= 0.5) verdict = 'similar';
  return { verdict, code: Math.round(code * 100), same_files: Math.round(sameFiles * 100), assets: Math.round(assets * 100), look_distance: dist, palette_overlap: Math.round(pal * 100), looks_alike: looksAlike };
}

// ---- listing and content: a game rebuilt from another's description (a build skill, a review, a video) shares no code,
// files or look with it, but keeps its name, its tagline and the names of what is in it. Sharing mechanics, genre or style
// is allowed (that is what build skills are for); taking the game's identity is not.

/** A title or tagline reduced to letters and digits: case, accents, punctuation, spacing and a leading "the" do not count. */
export const normText = (s) => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/^the /, '');
/** How much a normalized text says: CJK characters carry about as much as a short word each. */
export const textWeight = (s) => [...String(s || '')].reduce((n, c) => n + (/[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/.test(c) ? 3 : 1), 0);
const grams = (s) => { const t = ` ${s} `, g = new Map(); for (let i = 0; i + 3 <= t.length; i++) { const k = t.slice(i, i + 3); g.set(k, (g.get(k) || 0) + 1); } return g; };
/** Character-trigram Dice similarity of two normalized strings, 0 to 1. */
export function textSim(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const A = grams(a), B = grams(b); let both = 0, n = 0;
  for (const [k, c] of A) { n += c; both += Math.min(c, B.get(k) || 0); }
  for (const c of B.values()) n += c;
  return n ? (2 * both) / n : 0;
}
const jaccard = (a, b) => { const A = new Set(a), B = new Set(b); if (!A.size && !B.size) return 0; let n = 0; for (const x of A) if (B.has(x)) n++; return n / (A.size + B.size - n); };

// Words that games show on buttons and menus, not names of what is in a particular game.
const UI_WORDS = new Set('play start new game continue resume restart retry pause paused menu main options settings sound music volume back next ok cancel close quit exit yes no done loading score best high level stage wave round turn end victory defeat game over you win you lose try again select confirm save load delete reset help how to controls credits language full screen fullscreen on off easy normal hard tutorial skip shop store buy sell gold coins health hp energy mana xp attack defend block run map deck hand draw discard reward rewards rest boss elite enemy player hero heroes cards card records locked unlocked blocked enter escape space tab shift control alt meta backspace delete arrowup arrowdown arrowleft arrowright home page up page down insert'.split(' '));
const NAME = /^[\p{Lu}][\p{Ll}'’-]+(?: (?:of|the|de|la|le|von|and|[\p{Lu}][\p{Ll}'’-]+)){0,3}$/u;
/**
 * Names of what is in a game (characters, cards, enemies, places, items): Title Case strings of one to four words in
 * the game's own code. Menu and button words, and names in `baseline` (the templates' and kits'), are left out.
 * Returns normalized names, sorted.
 */
export function contentNames(texts, baseline) {
  const out = new Set();
  const take = (v) => {
    const s = String(v || '').trim();
    if (s.length < 4 || s.length > 40 || !NAME.test(s)) return;
    const n = normText(s);
    if (n.length < 4 || n.split(' ').every((w) => UI_WORDS.has(w)) || (baseline && baseline.has(n))) return;
    out.add(n);
  };
  for (const { path, text } of texts) {
    for (const src of /\.html?$/i.test(path) ? inlineScripts(text) : [text]) {
      try { for (const t of tokenizer(src, { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true, allowReturnOutsideFunction: true, allowImportExportEverywhere: true, allowAwaitOutsideFunction: true })) if (t.type.label === 'string' || t.type.label === 'template') take(t.value); }
      catch { for (const m of src.matchAll(/(["'`])([^"'`\n\\]{4,40})\1/g)) take(m[2]); }
    }
  }
  return [...out].sort().slice(0, 2000);
}

/** The build's traits (engine, rendering, graphics, input, audio, loop), for "built the same way". */
export const traitsOf = (f) => !f ? [] : [`engine:${f.engine}`, ...(f.libraries || []).map((x) => 'lib:' + x), ...(f.rendering || []).map((x) => 'render:' + x), ...(f.graphics || []).map((x) => 'gfx:' + x), ...(f.input || []).map((x) => 'input:' + x), ...(f.audio || []).map((x) => 'audio:' + x), ...(f.loop_and_performance || []).map((x) => 'loop:' + x)];

/**
 * How much of game B's identity game A takes: its listing, the names in it and how it is built.
 * @param {{ title: string, tagline?: string, tags?: string[], names?: string[], traits?: string[] }} a  the new game
 * @param {{ title: string, tagline?: string, tags?: string[], names?: string[], traits?: string[] }} b  a live game by someone else
 */
export function kinship(a, b) {
  const ta = normText(a.title), tb = normText(b.title), ga = normText(a.tagline), gb = normText(b.tagline);
  const sameTitle = !!ta && ta === tb, titleSim = textSim(ta, tb);
  const sameTagline = textWeight(ga) >= 20 && ga === gb, taglineSim = textWeight(ga) >= 20 ? textSim(ga, gb) : 0;
  const tagsA = a.tags || [], tagsB = b.tags || [];
  const sameGenre = !!tagsA[0] && tagsA[0] === tagsB[0], tags = jaccard(tagsA, tagsB);
  const nb = new Set(b.names || []), shared = (a.names || []).filter((n) => nb.has(n));
  const nameShare = (a.names || []).length ? shared.length / a.names.length : 0;
  const traits = jaccard(a.traits || [], b.traits || []);
  // Rules refuse only a game that is essentially the same one: at least two of the same title, the same tagline and
  // many of the same names. Any one of them alone, or anything near, is a closer look for the AI review, never a refusal.
  const manyNames = (shared.length >= 8 && nameShare >= 0.4) || shared.length >= 15;
  const nearNames = shared.length >= 6 || (shared.length >= 4 && nameShare >= 0.2);
  // another creator's exact tagline, or 3 or more of its named heroes, cards and the like, is never settled by the
  // cheap model alone: the pair always goes to the AI review and that review always ends with clef
  const fewNames = shared.length >= 3;
  const why = [];
  if (sameTitle) why.push(`the same title "${b.title}"`);
  else if (titleSim >= 0.75) why.push(`a title close to "${b.title}"`);
  if (sameTagline) why.push('the same tagline');
  else if (taglineSim >= 0.8) why.push('a tagline close to its tagline');
  if (manyNames || nearNames || fewNames) why.push(`${shared.length} of the same names (${shared.slice(0, 5).join(', ')}${shared.length > 5 ? '…' : ''})`);
  const strong = [sameTitle, sameTagline, manyNames].filter(Boolean).length;
  const built = sameGenre && tags >= 0.5 && traits >= 0.7;
  if (built && why.length === 0) why.push('the same genre and tags, built the same way');
  const verdict = strong >= 2 ? 'copy' : why.length ? 'similar' : 'different';
  return { verdict, why, clef_only: sameTagline || fewNames, same_title: sameTitle, title_sim: Math.round(titleSim * 100), same_tagline: sameTagline, tagline_sim: Math.round(taglineSim * 100), same_genre: sameGenre, tags_overlap: Math.round(tags * 100), shared_names: shared.length, names_share: Math.round(nameShare * 100), name_examples: shared.slice(0, 12), traits_overlap: Math.round(traits * 100) };
}
/** A title without its vowels and doubled letters, so "Void Echoes" and "Void Echos" or "Voyd Echoes" meet in the index. */
export const titleSkeleton = (t) => normText(t).replace(/[aeiouy]/g, '').replace(/(.)\1+/g, '$1').replace(/\s+/g, '');
export const ID_NAMES = 600;                // name hashes per game kept in the identity index (the smallest, consistently)
const TITLE_WEIGHT = 10;                    // a title or tagline hit counts as much as this many shared names
/**
 * Identity keys of a game for the hash index: its title, title skeleton and tagline (weight TITLE_WEIGHT each) and the
 * ID_NAMES smallest hashes of its names and the four bands of its screenshot hash (weight 1 each). Lookups by these keys find games with the same or a near name or the
 * same named content without comparing against every live game.
 * @returns {{ strong: number[], names: number[], look: number[] }}
 */
export function identityKeys({ title, tagline, names, look }) {
  const strong = new Set(), t = normText(title), k = titleSkeleton(title), g = normText(tagline);
  if (t) strong.add(fnv('t:' + t));
  if (k.length >= 3) strong.add(fnv('k:' + k));
  if (textWeight(g) >= 20) strong.add(fnv('g:' + g));
  const nm = [...new Set((names || []).map((n) => fnv('n:' + n)))].sort((x, y) => x - y).slice(0, ID_NAMES);
  // the screenshot hash in four 16-bit bands: pictures that look alike share most bands (locality-sensitive hashing)
  const bands = look && /^[0-9a-f]{16}$/.test(look.dhash || '') ? [0, 1, 2, 3].map((i) => fnv(`l${i}:` + look.dhash.slice(i * 4, i * 4 + 4))) : [];
  return { strong: [...strong], names: nm, look: bands };
}
export const IDENTITY_TITLE_WEIGHT = TITLE_WEIGHT;

const ENGINE_INPUT = /^(Unity|Godot|Construct|GameMaker|Defold|Cocos Creator|PlayCanvas|Phaser|Excalibur|KAPLAY \/ Kaboom|melonJS|LittleJS|Emscripten \/ WebAssembly)$/;
/**
 * Is it a game? From the build facts (analyzeBundle), the verification report and index.html.
 *  - 'not_game' (sure) when nothing in it takes input;
 *  - 'game' (sure) when it is built with a game engine;
 *  - otherwise a lean ('game' or 'unsure') that is not sure: landing pages, shops, tools and articles also draw on canvases,
 *    run frame loops, take clicks and can register a play-through that clicks a button. Those are decided by the
 *    Workers AI decision model with the screenshot (see GAMENESS_QUESTIONS); when AI cannot answer, the lean stands.
 * @returns {{ verdict: 'game' | 'not_game' | 'unsure', sure: boolean, reason: string, signals: object }}
 */
export function gameness(facts, report, html) {
  const page = (report && report.page) || {};
  const drawn = facts.rendering.some((r) => /WebGL|WebGPU|Canvas|SVG/.test(r)), looped = facts.loop_and_performance.includes('requestAnimationFrame loop');
  const played = !!(report && report.playthrough && report.playthrough.ok);
  const forms = (String(html || '').match(/<input\b[^>]*type=["']?(?:email|password|tel)|<form\b/gi) || []).length;
  const signals = { drawn, looped, played_through: played, play_steps: played ? report.playthrough.steps.length : 0, controls: page.controls || 0, text_chars: String(page.text || '').length, forms, changed: report && report.metrics && report.metrics.change || null };
  if (ENGINE_INPUT.test(facts.engine)) return { verdict: 'game', sure: true, reason: `Built with ${facts.engine}, a game engine.`, signals };
  const interactive = facts.input.length > 0 || /<button\b|onclick=|<input\b/i.test(html || '') || (page.controls || 0) > 0;
  if (!interactive) return { verdict: 'not_game', sure: true, reason: 'Nothing in it responds to the player: no keyboard, mouse, touch, pointer or gamepad input and no buttons.', signals };
  if (played) return { verdict: 'game', sure: false, reason: 'Its play-through hook played it to the end.', signals };
  if (drawn || looped) return { verdict: 'game', sure: false, reason: 'It draws frames in a loop and responds to input.', signals };
  return { verdict: 'unsure', sure: false, reason: forms ? 'A page with forms and no game loop.' : 'An interactive page with no canvas and no game loop.', signals };
}

// ---- the questions the Workers AI decision models answer (shared with the moderation harness) ----
/** The build facts the AI checks see (never code). */
export const facts4ai = (f) => ({ engine: f.engine, libraries: f.libraries, platform_kits: f.platform_kits, rendering: f.rendering, graphics: f.graphics, input: f.input, audio: f.audio, assets: f.assets, platform_services: f.platform_services, loop: f.loop_and_performance, play_through: f.gameplay?.playthrough_steps, own_code_lines: f.structure?.own_code_lines });

// Asked of @cf/cloudflare/clef-flash first and @cf/cloudflare/clef for the final word, about the plain-sentence state
// below (judgeState). Tuned on a labelled set of 140 mock pairs (scripts/dup-eval.mjs): with this wording and that state,
// clef gave every copy at least 38% "copy" and every other pair at most 15%.
export const JUDGE_QUESTIONS = {
  verdict: {
    type: 'choice',
    instructions: 'You decide whether a new web game is a copy of an existing game by another creator, before it is published. You get both store listings, facts about how each is built (never code) and measurements. A copy is the same game passed off as new: a player who knows the existing game would recognise it as that game, because it keeps most of its named content (characters, cards, enemies, places, items) or its listing, or its code and assets, with surface changes such as a new title, colours or text. Building the same kind of game is allowed and common: the same genre, mechanics, structure, rules, art style or engine is not copying. Taking its exact tagline together with three or more of its named characters, cards, enemies, places or items is taking its identity and is a copy, even under a new title. A few shared names alone, or common words, are not copying. The same or a similar title on a game that is otherwise different is a name collision, not a copy. Measurements: code = share of the new game\'s own code found in the other (0-100); same_files and assets = shares of identical files; look_distance = screenshot difference (0 identical, 10 or less looks alike); title_sim and tagline_sim = how close the listings are (100 identical); shared_names = how many names of content are in both games, names_share = what share of the new game\'s names that is (0-100), name_examples = some of them; traits_overlap = how alike the build facts are.',
    criteria: {
      copy: 'The existing game with surface changes: most of its named content, its listing, its exact tagline with several of its names, or its code and assets are kept.',
      derivative: 'The same kind of game (genre, mechanics, style) with its own content and identity.',
      independent: 'A different game; any likeness is only genre, a common word or the title.',
    },
  },
};
/** clef-flash's "not a copy" is final from this probability (no copy in the labelled set got more than 0.69). */
export const FLASH_SURE = 0.75;
/** clef refuses from this chance of "copy" (labelled set of 160 pairs: copies 0.5 and up, everything else under 0.2). */
export const CLEF_COPY = 0.3;

/**
 * The pair as the judge reads it: both listings, how each is built, and the measurements in plain sentences. Decision
 * models, the small one above all, read words far better than a table of numbers.
 */
export function judgeState(st) {
  const m = st.measurements, a = st.new_game, b = st.existing_game, f = (x) => x && `${x.engine === 'none' ? 'no engine' : x.engine}, ${(x.rendering || []).join(' and ')}, input by ${(x.input || []).join(', ')}`;
  const lines = [];
  lines.push(m.title_sim >= 100 ? 'Both games have the same title.' : m.title_sim >= 75 ? 'The titles are close.' : 'The titles are different.');
  lines.push(m.tagline_sim >= 100 ? 'Both listings have the same tagline.' : m.tagline_sim >= 80 ? 'The taglines are close.' : 'The taglines are different.');
  lines.push(m.shared_names ? `${m.shared_names} named characters, cards, enemies, places or items appear in both games (${m.names_share}% of the new game's names)${m.name_examples?.length ? ': ' + m.name_examples.join(', ') : ''}.` : 'No named content appears in both games.');
  lines.push(m.code >= 50 ? `${m.code}% of the new game's code is the same as the existing game's.` : `Their code is different (${m.code}% alike, which is normal for unrelated games).`);
  if (m.assets) lines.push(`${m.assets}% of its asset files are identical.`);
  lines.push(m.looks_alike ? 'Their screenshots look alike.' : 'Their screenshots look different.');
  lines.push(m.same_genre ? 'They are the same genre.' : 'They are different genres.');
  return { new_game: { title: a.listing.title, tagline: a.listing.tagline, tags: a.listing.tags, built_with: f(a.facts) }, existing_game: { title: b.listing.title, tagline: b.listing.tagline, tags: b.listing.tags, built_with: f(b.facts) }, comparison: lines.join(' ') };
}

// Asked of @cf/cloudflare/clef-flash.
export const GAMENESS_QUESTIONS = {
  is_game: {
    type: 'noul',
    instructions: 'This marketplace hosts web games only, with no human review. Is this upload a game: something a person plays, with rules, goals, challenge or play? Interactive toys, puzzles, quizzes, interactive stories and simulations count, however simple, unfinished or text-based. You get the listing, facts about the build (never code), what the page showed in a test browser (its visible text, how many controls, whether its own play-through script passed) and a screenshot. A page can draw on a canvas, animate and take clicks without being a game, and its play-through can be a single button click.',
    criteria: { true: 'A game, an interactive toy, a puzzle, a quiz or an interactive story.', false: 'A landing or promo page, an advert, an article or document, a link list, a shop, a sign-up or payment form, a video or slideshow, a calculator, tool or app: something to read, watch, buy or use rather than play.' },
  },
};

/** The start of a page's visible text: what a player reads before anything runs. */
export const visibleText = (html, max = 1500) => String(html || '').replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
