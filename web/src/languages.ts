// Game languages: which languages a game can be played in (interface text, voice, subtitles), declared by its creator,
// detected from the code where possible, frozen with each version, and compared with the player's platform language.
// No imports except the platform's language list, so the Worker, the web app and the tests share it.
import { LANGS, matchLang, type Lang } from './i18n/langs';

export interface GameLanguage { code: string; interface: boolean; audio: boolean; subtitles: boolean }
export interface Languages {
  default: string;                 // the language the game starts in when it cannot tell
  supported: GameLanguage[];       // every language the game offers, the default first
  follows_platform: boolean;       // the game starts in the player's platform language (GCP.lang) when it supports it
  notes: string;
}
/** What is stored with a version (manifest.languages) and served to the store page. */
export interface LanguagesRecord { v: 1; languages: Languages; declared: boolean; detected: Languages; evidence: Record<string, string> }
export interface LangIssue { level: 'error' | 'warning'; field: string; message: string; hint?: string }

/** Names of common languages, in English and in the language itself. Anything else is shown by its code. */
export const LANGUAGE_NAMES: Record<string, [string, string]> = {
  en: ['English', 'English'], 'zh-hans': ['Chinese (Simplified)', '简体中文'], 'zh-hant': ['Chinese (Traditional)', '繁體中文'], zh: ['Chinese', '中文'],
  ja: ['Japanese', '日本語'], ko: ['Korean', '한국어'], es: ['Spanish', 'Español'], 'es-419': ['Spanish (Latin America)', 'Español (Latinoamérica)'],
  fr: ['French', 'Français'], de: ['German', 'Deutsch'], it: ['Italian', 'Italiano'], pt: ['Portuguese', 'Português'], 'pt-br': ['Portuguese (Brazil)', 'Português (Brasil)'],
  ru: ['Russian', 'Русский'], uk: ['Ukrainian', 'Українська'], pl: ['Polish', 'Polski'], nl: ['Dutch', 'Nederlands'], sv: ['Swedish', 'Svenska'], da: ['Danish', 'Dansk'],
  nb: ['Norwegian', 'Norsk'], fi: ['Finnish', 'Suomi'], cs: ['Czech', 'Čeština'], hu: ['Hungarian', 'Magyar'], ro: ['Romanian', 'Română'], el: ['Greek', 'Ελληνικά'],
  tr: ['Turkish', 'Türkçe'], ar: ['Arabic', 'العربية'], he: ['Hebrew', 'עברית'], fa: ['Persian', 'فارسی'], hi: ['Hindi', 'हिन्दी'], bn: ['Bengali', 'বাংলা'],
  th: ['Thai', 'ไทย'], vi: ['Vietnamese', 'Tiếng Việt'], id: ['Indonesian', 'Bahasa Indonesia'], ms: ['Malay', 'Bahasa Melayu'], fil: ['Filipino', 'Filipino'],
};

const CODE = /^[a-z]{2,3}(?:-[a-z]{4})?(?:-(?:[a-z]{2}|\d{3}))?$/;
/** Normalises a language tag: lower case, Chinese as zh-hans / zh-hant, a bare region-less code otherwise kept as given. */
export function normLang(raw: unknown): string | null {
  let c = String(raw ?? '').trim().toLowerCase().replace(/_/g, '-');
  if (!c) return null;
  const alias: Record<string, string> = { 'zh-cn': 'zh-hans', 'zh-sg': 'zh-hans', 'zh-tw': 'zh-hant', 'zh-hk': 'zh-hant', 'zh-mo': 'zh-hant', 'zh-hans-cn': 'zh-hans', 'zh-hant-tw': 'zh-hant', 'zh-hant-hk': 'zh-hant', 'pt-pt': 'pt', 'no': 'nb', 'tl': 'fil', 'iw': 'he', 'in': 'id', english: 'en', japanese: 'ja', korean: 'ko', spanish: 'es', chinese: 'zh', french: 'fr', german: 'de' };
  c = alias[c] ?? c;
  return CODE.test(c) ? c : null;
}
export const languageName = (code: string): [string, string] => LANGUAGE_NAMES[code] ?? LANGUAGE_NAMES[code.split('-')[0]] ?? [code, code];

/** The platform language a game language serves, if any (zh-hans → zh, zh-hant → zh-TW, es-419 → es, en-gb → en). */
export function platformLangOf(code: string): Lang | null {
  if (code === 'zh-hans') return 'zh';
  if (code === 'zh-hant') return 'zh-TW';
  return matchLang(code);
}
/** The game language codes that serve a platform language. */
export const PLATFORM_CODES: Record<Lang, string> = { en: 'en', zh: 'zh-hans', 'zh-TW': 'zh-hant', ja: 'ja', ko: 'ko', es: 'es' };

// ---------------------------------------------------------------------------------------------
// Declaring
// ---------------------------------------------------------------------------------------------
/** Checks a declared languages object (gcp.json "languages" or the MCP tool's argument). */
export function parseLanguages(raw: unknown): { value: Languages | null; issues: LangIssue[] } {
  const issues: LangIssue[] = [];
  const e = (field: string, message: string, hint?: string) => issues.push({ level: 'error', field, message, hint });
  if (raw === undefined || raw === null) return { value: null, issues };
  let r = raw as Record<string, unknown>;
  // shorthand: ["en", "ja"] means interface text in those languages, the first one the default
  if (Array.isArray(raw)) r = { supported: raw };
  if (!r || typeof r !== 'object') { e('languages', 'languages must be an object or a list of language codes.', 'Example: {"default": "en", "supported": [{"code": "en", "interface": true, "audio": true}, {"code": "ja", "interface": true, "subtitles": true}]} or simply ["en", "ja"].'); return { value: null, issues }; }
  for (const k of Object.keys(r)) if (!['default', 'supported', 'follows_platform', 'notes'].includes(k)) e(k, `Unknown field "${k}".`, 'Fields: default, supported, follows_platform, notes.');
  const items = Array.isArray(r.supported) ? r.supported : [];
  if (!items.length) e('supported', 'supported must list at least one language.');
  if (items.length > 60) e('supported', 'At most 60 languages.');
  const out: GameLanguage[] = [], seen = new Set<string>();
  for (const it of items.slice(0, 60)) {
    const o = (typeof it === 'string' ? { code: it, interface: true } : it) as Record<string, unknown>;
    const code = normLang(o?.code);
    if (!code) { e('supported', `"${o?.code}" is not a language code.`, 'Use BCP 47 codes such as "en", "ja", "ko", "es", "zh-Hans" (Simplified Chinese), "zh-Hant" (Traditional Chinese), "pt-BR".'); continue; }
    if (seen.has(code)) { e('supported', `${code} is listed twice.`); continue; }
    for (const k of Object.keys(o)) if (!['code', 'interface', 'audio', 'subtitles'].includes(k)) e('supported', `${code}: unknown field "${k}".`, 'Each language is {code, interface, audio, subtitles}.');
    const g: GameLanguage = { code, interface: o.interface === undefined ? true : !!o.interface, audio: !!o.audio, subtitles: !!o.subtitles };
    if (!g.interface && !g.audio && !g.subtitles) { e('supported', `${code}: say what is in that language: interface, audio or subtitles.`); continue; }
    seen.add(code); out.push(g);
  }
  const def = r.default === undefined ? out[0]?.code : normLang(r.default);
  if (r.default !== undefined && !def) e('default', `"${r.default}" is not a language code.`);
  else if (def && !seen.has(def)) e('default', `The default language ${def} is not in supported.`);
  if (r.notes !== undefined && String(r.notes).length > 300) e('notes', 'notes must be 300 characters or fewer.');
  if (issues.length) return { value: null, issues };
  const sorted = [...out.filter((x) => x.code === def), ...out.filter((x) => x.code !== def)];
  return { value: { default: def!, supported: sorted, follows_platform: !!r.follows_platform, notes: String(r.notes ?? '').trim().slice(0, 300) }, issues };
}

// ---------------------------------------------------------------------------------------------
// Detecting
// ---------------------------------------------------------------------------------------------
const LOCALE_PATH = /(?:^|\/)(?:locales?|i18n|lang|langs|languages|translations?|l10n|strings)\/(?:([a-z]{2,3}(?:[-_][A-Za-z]{2,4})?)(?:\/|\.(?:json|js|mjs|po|ya?ml|txt|csv|xml|properties))|[^/]*?[._-]([a-z]{2,3}(?:[-_][A-Za-z]{2,4})?)\.(?:json|js|po|ya?ml|txt))$/;
const SCRIPTS: [string, RegExp][] = [['ko', /[가-힯]/g], ['ja', /[぀-ヿ]/g], ['zh', /[一-鿿]/g], ['ru', /[Ѐ-ӿ]/g], ['ar', /[؀-ۿ]/g], ['he', /[֐-׿]/g], ['th', /[฀-๿]/g], ['hi', /[ऀ-ॿ]/g], ['el', /[Ͱ-Ͽ]/g]];
/** Text a player reads: string literals and HTML text, not code or comments. */
function playerText(path: string, src: string): string {
  if (/\.html?$/.test(path)) return src.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<!--[\s\S]*?-->|<[^>]+>/g, ' ');
  if (/\.(?:json|txt|csv|po|ya?ml)$/.test(path)) return src;
  return (src.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, ' ').match(/(["'`])(?:\\.|(?!\1)[^\\\n])*\1/g) || []).join(' ');
}

/** What the bundle shows about its languages. Pattern-based: a creator's declaration overrides it. */
export function detectLanguages(texts: Map<string, string> | Record<string, string>, paths: string[]): { languages: Languages; evidence: Record<string, string> } {
  const t = texts instanceof Map ? texts : new Map(Object.entries(texts));
  const ev: Record<string, string> = {}, found = new Map<string, GameLanguage>();
  const add = (code: string | null, why: string) => { if (!code || found.has(code)) return; found.set(code, { code, interface: true, audio: false, subtitles: false }); ev[code] = why; };
  for (const p of paths) { const m = p.match(LOCALE_PATH); if (m) add(normLang(m[1] || m[2]), `translation file ${p}`); }
  const html = t.get('index.html') || '', htmlLang = normLang(html.match(/<html[^>]*\slang=["']([^"']+)["']/i)?.[1]);
  // the scripts the player-facing text is written in (vendor bundles excluded by size)
  const counts = new Map<string, number>(); let latin = 0;
  for (const [p, src] of t) {
    if (p.startsWith('server/') || src.length > 400_000 || /(?:^|\/)(?:vendor|lib|libs|node_modules)\/|\.min\.js$/.test(p)) continue;
    const text = playerText(p, src);
    for (const [code, rx] of SCRIPTS) counts.set(code, (counts.get(code) || 0) + (text.match(rx)?.length || 0));
    latin += text.match(/\b[A-Za-z]{3,}\b/g)?.length || 0;
  }
  if ((counts.get('ja') || 0) >= 10) add('ja', 'Japanese text in the game');
  if ((counts.get('ko') || 0) >= 10) add('ko', 'Korean text in the game');
  if ((counts.get('zh') || 0) >= 20 && (counts.get('ja') || 0) < 10) add(found.has('zh-hant') ? 'zh-hant' : 'zh-hans', 'Chinese text in the game');
  for (const code of ['ru', 'ar', 'he', 'th', 'hi', 'el']) if ((counts.get(code) || 0) >= 20) add(code, `${languageName(code)[0]} text in the game`);
  if (htmlLang) add(htmlLang, `<html lang="${htmlLang}">`);
  if (!found.size || (latin >= 20 && !found.has('en') && ![...found.keys()].some((c) => /^(?:es|fr|de|it|pt|nl)/.test(c)) && !htmlLang)) add('en', 'English text in the game');
  const def = htmlLang && found.has(htmlLang) ? htmlLang : found.has('en') ? 'en' : [...found.keys()][0];
  const follows = [...t.values()].some((s) => /\bGCP\s*\.\s*lang\b/.test(s));
  if (follows) ev.follows_platform = 'reads GCP.lang';
  const supported = [...found.values()];
  return { languages: { default: def, supported: [...supported.filter((x) => x.code === def), ...supported.filter((x) => x.code !== def)], follows_platform: follows, notes: '' }, evidence: ev };
}

/** The languages a version goes out with: the declaration when there is one, otherwise what was detected. */
export function buildLanguages(declaredRaw: unknown, texts: Map<string, string> | Record<string, string>, paths: string[]): { record: LanguagesRecord; issues: LangIssue[] } {
  const parsed = parseLanguages(declaredRaw), det = detectLanguages(texts, paths), issues: LangIssue[] = [...parsed.issues];
  const w = (field: string, message: string, hint?: string) => issues.push({ level: 'warning', field, message, hint });
  if (declaredRaw === undefined || declaredRaw === null) {
    w('languages', `No languages are declared, so the store page shows what the platform detected: ${det.languages.supported.map((l) => l.code).join(', ')}.`, 'Declare them with the compatibility tool (languages), so players see exactly which languages the game offers.');
  } else if (parsed.value) {
    const declared = new Set(parsed.value.supported.map((l) => l.code));
    const missing = det.languages.supported.filter((l) => !declared.has(l.code) && !declared.has(l.code.split('-')[0]));
    if (missing.length) w('languages', `The bundle looks like it also has ${missing.map((l) => `${l.code} (${det.evidence[l.code]})`).join(', ')}, which the declaration does not list.`, 'List every language players can choose, or ignore this if that text is not player-facing.');
    if (det.languages.follows_platform && !parsed.value.follows_platform) w('follows_platform', 'The game reads GCP.lang but follows_platform is not set.', 'Set follows_platform: true so the store page tells players the game opens in their language.');
    if (parsed.value.follows_platform && !det.languages.follows_platform) w('follows_platform', 'follows_platform is set but the code never reads GCP.lang.', 'Start the game in GCP.lang when it is one of your languages, or turn follows_platform off.');
  }
  const value = parsed.value ?? det.languages;
  return { record: { v: 1, languages: value, declared: !!parsed.value, detected: det.languages, evidence: det.evidence }, issues };
}

// ---------------------------------------------------------------------------------------------
// The store listing in other platform languages (the platform-facing side)
// ---------------------------------------------------------------------------------------------
export interface Listing { title?: string; tagline?: string; description?: string; controls?: string }
export const LISTING_LIMITS: Record<keyof Listing, number> = { title: 80, tagline: 140, description: 5000, controls: 1000 };

/** Checks translated store listings: {"ja": {"title": "…", "tagline": "…"}, …}, keyed by the platform's languages. null removes one. */
export function parseListings(raw: unknown): { value: Partial<Record<Lang, Listing | null>>; issues: LangIssue[] } {
  const issues: LangIssue[] = [], value: Partial<Record<Lang, Listing | null>> = {};
  const e = (field: string, message: string, hint?: string) => issues.push({ level: 'error', field, message, hint });
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { e('listing_translations', 'listing_translations must map a platform language to {title, tagline, description, controls}.'); return { value, issues }; }
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const lang = (k === 'zh-hans' || k === 'zh-Hans' ? 'zh' : k === 'zh-hant' || k === 'zh-Hant' ? 'zh-TW' : LANGS.find((l) => l.code.toLowerCase() === k.toLowerCase())?.code) as Lang | undefined;
    if (!lang) { e('listing_translations', `"${k}" is not one of the platform languages.`, `Platform languages: ${LANGS.map((l) => l.code).join(', ')}.`); continue; }
    if (v === null) { value[lang] = null; continue; }
    if (!v || typeof v !== 'object') { e('listing_translations', `${k} must be {title, tagline, description, controls}.`); continue; }
    const out: Listing = {};
    for (const [f, s] of Object.entries(v as Record<string, unknown>)) {
      if (!(f in LISTING_LIMITS)) { e('listing_translations', `${k}: unknown field "${f}".`, 'Fields: title, tagline, description, controls.'); continue; }
      const text = String(s ?? '').trim(), max = LISTING_LIMITS[f as keyof Listing];
      if (text.length > max) { e('listing_translations', `${k}.${f} is longer than ${max} characters.`); continue; }
      if (text) out[f as keyof Listing] = text;
    }
    value[lang] = out;
  }
  return { value, issues };
}

// ---------------------------------------------------------------------------------------------
// The player's side
// ---------------------------------------------------------------------------------------------
export interface LanguageRow { code: string; platform: Lang | null; interface: boolean; audio: boolean; subtitles: boolean; store: boolean; isDefault: boolean }
/** One row per language: what the game offers in it and whether the store page is translated into it. Platform languages first. */
export function languageRows(l: Languages, listings: Lang[]): LanguageRow[] {
  const rows = new Map<string, LanguageRow>();
  for (const g of l.supported) rows.set(g.code, { code: g.code, platform: platformLangOf(g.code), interface: g.interface, audio: g.audio, subtitles: g.subtitles, store: false, isDefault: g.code === l.default });
  for (const lang of listings) {
    const hit = [...rows.values()].find((r) => r.platform === lang);
    if (hit) hit.store = true;
    else rows.set(PLATFORM_CODES[lang], { code: PLATFORM_CODES[lang], platform: lang, interface: false, audio: false, subtitles: false, store: true, isDefault: false });
  }
  const order = (r: LanguageRow) => (r.isDefault ? -1 : r.platform ? LANGS.findIndex((x) => x.code === r.platform) : 100);
  return [...rows.values()].sort((a, b) => order(a) - order(b) || a.code.localeCompare(b.code));
}

/** Whether the game can be played in the player's platform language. */
export function inYourLanguage(l: Languages, lang: Lang): { ok: boolean; row: GameLanguage | null; partial: boolean } {
  const row = l.supported.find((g) => platformLangOf(g.code) === lang) ?? null;
  return { ok: !!row && row.interface, row, partial: !!row && !row.interface };
}
