// Build skills: what a game shares through Open Implementation. A skill is an agent skill (a SKILL.md) that the game's own
// development agent writes about how the game is built, so another developer's agent can build something similar. It
// carries the game's practices, never its source: fenced or indented code, HTML tags, code-dense lines and long inline
// code are refused with the line they are on, so the agent can rewrite them as prose.
//
// Language policy: the canonical base skill is always written in English only (no other languages). To support switching
// languages across the platform, each release's skill also carries translations for all other platform languages
// (zh, zh-TW, ja, ko, es), each held to the same no-code and language checks. Plain JavaScript so node tests can import
// it directly; the Worker side is src/skills.ts.

export const SKILL_LANGS = ['en', 'zh', 'zh-TW', 'ja', 'ko', 'es'];
export const SKILL_TRANSLATION_LANGS = ['zh', 'zh-TW', 'ja', 'ko', 'es'];
export const SKILL_LANG_NAMES = {
  en: 'English',
  zh: 'Simplified Chinese',
  'zh-TW': 'Traditional Chinese',
  ja: 'Japanese',
  ko: 'Korean',
  es: 'Spanish',
};

export const SKILL_LIMITS = {
  min_chars: 600,
  max_chars: 60000,
  cjk_min_chars: 200,
  cjk_max_chars: 30000,
  description_max: 300,
  min_sections: 3,
  inline_code_max: 60,
};

/** Normalises a platform language code (accepting zh-Hans / zh-CN -> zh, zh-Hant / zh-HK -> zh-TW, etc.). */
export function normalizeSkillLang(raw) {
  if (raw === undefined || raw === null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  if (SKILL_LANGS.includes(s)) return s;
  const l = s.toLowerCase().replace(/_/g, '-');
  if (l === 'en' || l.startsWith('en-')) return 'en';
  if (l === 'zh' || l === 'zh-cn' || l === 'zh-hans' || l === 'zh-sg' || l.startsWith('zh-hans-')) return 'zh';
  if (l === 'zh-tw' || l === 'zh-hant' || l === 'zh-hk' || l === 'zh-mo' || l.startsWith('zh-hant-')) return 'zh-TW';
  if (l === 'ja' || l.startsWith('ja-')) return 'ja';
  if (l === 'ko' || l.startsWith('ko-')) return 'ko';
  if (l === 'es' || l.startsWith('es-')) return 'es';
  return null;
}

const isCjkLang = (lang) => lang === 'zh' || lang === 'zh-TW' || lang === 'ja' || lang === 'ko';

/** The sections an agent is asked to cover. Only three level-two headings are required; these are the suggestion. */
export const SKILL_OUTLINE = [
  { heading: 'What you are building', ask: 'The kind of game, its core loop in a few sentences, what makes it feel good, and the scope a first playable version needs.' },
  { heading: 'Architecture', ask: 'How the game is put together: engine or none, modules and what each one owns, how state flows between simulation, rendering and interface, and in what order to build them.' },
  { heading: 'Rendering and art', ask: 'How things are drawn (renderer, camera, lighting, materials, effects), how art is made (procedural or files), and the choices that gave the look.' },
  { heading: 'Game loop and feel', ask: 'Timing (fixed step or delta time), movement and physics, juice (screen shake, hit pause, particles), and the numbers that were tuned and why.' },
  { heading: 'Controls and devices', ask: 'Keyboard, mouse, touch and gamepad handling, phones and tablets, interface scaling and orientation, and how the interface keeps clear of what the platform draws over the game (the safe area, the on-screen control zones; game_standards).' },
  { heading: 'Content and progression', ask: 'Levels, waves, unlocks, balance, difficulty curve, saves and what the player keeps between sessions.' },
  { heading: 'Platform services', ask: 'Which platform services the game uses (saves, leaderboards, rooms, matches, server code) and how, by name, not by code.' },
  { heading: 'Performance', ask: 'Budgets and the techniques that kept frame time inside them on phones.' },
  { heading: 'Testing and release', ask: 'The play-through hook, what verification checks, how a release is prepared, and what to check by hand; and the store cover: how it was made (1920x1080, title and main subject inside the safe area x 30%-80%, y 12%-86%, a cover per language when it shows the title) and how it was checked in the banner, card and thumbnail crops.' },
  { heading: 'Pitfalls', ask: 'What went wrong while building it and how it was solved, so another agent avoids it.' },
];

const CODE_START = /^\s*(?:const|let|var|function|import|export|class|return|if\s*\(|for\s*\(|while\s*\(|switch\s*\(|async\s+function|def |#include|public |private |@media|\$\(|document\.|window\.[\w.]+\s*=)/;
const TAG = /<\/?(?:script|style|div|span|canvas|html|head|body|template|svg|path|iframe|link|meta|button|input|section|p|a|img|ul|li|table|tr|td|br|hr|h[1-6])\b[^>]*>/i;

// Non-Latin scripts and CJK fullwidth punctuation: forbidden in the canonical English base skill.
const NON_LATIN_SCRIPT = /[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\u0400-\u04ff\u0600-\u06ff\u0590-\u05ff\u0e00-\u0e7f\u0900-\u097f\uff01-\uff5e]/;
const HAN_RE = /[\u3400-\u4dbf\u4e00-\u9fff]/g;
const KANA_RE = /[\u3040-\u30ff]/g;
const HANGUL_RE = /[\uac00-\ud7af]/g;
const SIMP_ONLY_RE = /[这说会国与为产开关时应从点击将对发经门实进体无画动图现帧级线设试储档]/g;
const TRAD_ONLY_RE = /[這說會國與為產開關時應從點擊將對發經門實進體無畫動圖現幀級線設試儲檔]/g;

const EN_WORDS = new Set([
  'the', 'and', 'of', 'to', 'in', 'is', 'a', 'for', 'with', 'that', 'on', 'as', 'it', 'are', 'by', 'from', 'this',
  'be', 'at', 'or', 'not', 'when', 'each', 'into', 'its', 'can', 'will', 'has', 'have', 'which', 'where', 'how',
  'uses', 'use', 'player', 'game', 'frame', 'world', 'screen', 'build', 'state', 'should', 'while', 'without',
]);
const EN_ONLY_WORDS = new Set([
  'the', 'and', 'with', 'that', 'from', 'this', 'which', 'when', 'where', 'into', 'your', 'each', 'about',
  'should', 'while', 'without', 'through', 'player', 'game', 'build', 'frame', 'screen', 'world', 'between',
]);
const FOREIGN_LATIN_WORDS = new Set([
  'el', 'la', 'los', 'las', 'del', 'que', 'con', 'para', 'por', 'una', 'como', 'pero', 'más', 'está', 'son',
  'este', 'esta', 'juego', 'jugador', 'cada', 'sobre', 'entre', 'desde', 'les', 'des', 'dans', 'pour', 'avec',
  'sur', 'est', 'sont', 'pas', 'jeu', 'joueur', 'der', 'die', 'das', 'und', 'ist', 'mit', 'für', 'auf', 'nicht',
  'ein', 'eine', 'spiel', 'spieler', 'com', 'uma', 'não', 'jogo',
]);
const ES_WORDS = new Set([
  'el', 'la', 'los', 'las', 'de', 'del', 'en', 'que', 'con', 'para', 'por', 'una', 'un', 'como', 'es', 'son',
  'se', 'al', 'más', 'cada', 'juego', 'jugador', 'sobre', 'entre', 'pero', 'sus', 'este', 'esta', 'sin', 'cuando',
  'desde', 'donde', 'también', 'hacia', 'pantalla', 'mundo', 'estado', 'construir', 'versión',
]);

const stripInline = (s) => String(s || '').replace(/`[^`\n]*`/g, ' ').replace(/https?:\/\/\S+/g, ' ');
const latinWords = (s) => (stripInline(s).toLowerCase().match(/[a-z\u00c0-\u024f]+/g) || []);
const countMatches = (s, re) => (s.match(re) || []).length;

/** Splits off a leading YAML front matter block; its description (if any) is kept. */
export function splitFrontMatter(text) {
  const m = String(text || '').replace(/^\uFEFF/, '').match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { body: String(text || ''), description: '' };
  const d = m[1].match(/^description:\s*(.+)$/m);
  return { body: String(text).slice(m[0].length), description: d ? d[1].trim().replace(/^["']|["']$/g, '') : '' };
}

/** Cleans what an agent sent: front matter and a leading level-one title come off (the platform writes both). */
export function normalizeSkill(text, description = '') {
  const fm = splitFrontMatter(String(text || '').replace(/\r\n?/g, '\n'));
  const body = fm.body.replace(/^\s*#\s+[^\n]*\n/, '').replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
  const desc = String(description || fm.description || '').replace(/\s+/g, ' ').trim().slice(0, SKILL_LIMITS.description_max);
  return { body, description: desc };
}

/** Level-two headings, in order: the outline a paid skill shows before it is bought. */
export const headingsOf = (body) => [...String(body || '').matchAll(/^##\s+(.+?)\s*#*\s*$/gm)].map((m) => m[1].trim()).slice(0, 40);

/**
 * Checks that a build skill (and optional one-line description) is written in its declared language.
 * Canonical English (`en`) strictly forbids non-English text; translations (`zh`, `zh-TW`, `ja`, `ko`, `es`) must
 * genuinely be written in that target language.
 */
export function checkSkillLanguage(body, lang = 'en', description = '') {
  const problems = [];
  const add = (line, why) => { if (problems.length < 15) problems.push({ line, why }); };
  const text = String(body || ''), desc = String(description || '').trim();
  const stripped = stripInline(text);

  if (lang === 'en') {
    if (desc) {
      if (NON_LATIN_SCRIPT.test(desc)) {
        add(0, 'The base build skill description must be written in English only (no other languages). Put non-English descriptions in translations or with the language parameter.');
      } else {
        const dw = latinWords(desc);
        const df = dw.filter((w) => FOREIGN_LATIN_WORDS.has(w)).length;
        const de = dw.filter((w) => EN_WORDS.has(w)).length;
        if (/[¿¡]/.test(desc) || (df >= 3 && de === 0)) {
          add(0, 'The base build skill description must be written in English only. Put other platform languages in translations or with the language parameter.');
        }
      }
    }
    const lines = text.split('\n');
    let scriptLineHits = 0;
    lines.forEach((l, i) => {
      if (NON_LATIN_SCRIPT.test(l)) {
        scriptLineHits++;
        if (scriptLineHits <= 8) {
          add(i + 1, 'The base build skill must be written in English only (no other languages). Move non-English content to translations or write it with language: "zh" / "zh-TW" / "ja" / "ko" / "es".');
        }
      }
    });
    if (!scriptLineHits) {
      const words = latinWords(stripped);
      const enHits = words.filter((w) => EN_WORDS.has(w)).length;
      const foreignHits = words.filter((w) => FOREIGN_LATIN_WORDS.has(w)).length;
      const accented = countMatches(stripped, /[áéíóúñü¿¡çàèìòùâêîôûäößãõ]/gi);
      const letters = countMatches(stripped, /[a-z\u00c0-\u024f]/gi);
      if ((foreignHits >= 8 && foreignHits > enHits) || (accented >= 8 && accented / Math.max(1, letters) > 0.025) || (words.length >= 40 && enHits < 3)) {
        add(0, 'The base build skill must be written in English. Write other platform languages (zh, zh-TW, ja, ko, es) using translations or the language parameter.');
      }
    }
    return { ok: !problems.length, problems };
  }

  const noSpace = stripped.replace(/\s+/g, '');
  const han = countMatches(stripped, HAN_RE);
  const kana = countMatches(stripped, KANA_RE);
  const hangul = countMatches(stripped, HANGUL_RE);

  if (lang === 'zh' || lang === 'zh-TW') {
    if (kana >= 5) add(0, `${lang} translation contains Japanese Kana characters. Write it in ${SKILL_LANG_NAMES[lang]}.`);
    if (hangul >= 5) add(0, `${lang} translation contains Korean Hangul characters. Write it in ${SKILL_LANG_NAMES[lang]}.`);
    if (han < 60 || han / Math.max(1, noSpace.length) < 0.2) {
      add(0, `${lang} translation must be written in ${SKILL_LANG_NAMES[lang]}.`);
    } else if (lang === 'zh-TW') {
      const simp = countMatches(stripped, SIMP_ONLY_RE);
      const trad = countMatches(stripped, TRAD_ONLY_RE);
      if (simp >= 12 && (trad === 0 || simp > trad * 4)) {
        add(0, 'zh-TW translation looks like Simplified Chinese. Write it in Traditional Chinese (繁體中文).');
      }
    }
    if (desc && (!HAN_RE.test(desc) || KANA_RE.test(desc) || HANGUL_RE.test(desc))) {
      add(0, `${lang} description must be written in ${SKILL_LANG_NAMES[lang]}.`);
    }
    return { ok: !problems.length, problems };
  }

  if (lang === 'ja') {
    if (hangul >= 5) add(0, 'ja translation contains Korean Hangul characters. Write it in Japanese (日本語).');
    if (kana < 15) add(0, 'ja translation must be written in Japanese (日本語).');
    if (desc && (!(KANA_RE.test(desc) || HAN_RE.test(desc)) || HANGUL_RE.test(desc))) {
      add(0, 'ja description must be written in Japanese (日本語).');
    }
    return { ok: !problems.length, problems };
  }

  if (lang === 'ko') {
    if (kana >= 5) add(0, 'ko translation contains Japanese Kana characters. Write it in Korean (한국어).');
    if (hangul < 25) add(0, 'ko translation must be written in Korean (한국어).');
    if (desc && (!HANGUL_RE.test(desc) || KANA_RE.test(desc))) {
      add(0, 'ko description must be written in Korean (한국어).');
    }
    return { ok: !problems.length, problems };
  }

  if (lang === 'es') {
    if (NON_LATIN_SCRIPT.test(stripped)) add(0, 'es translation must be written in Spanish (Español) without non-Latin scripts.');
    const words = latinWords(stripped);
    const esHits = words.filter((w) => ES_WORDS.has(w)).length;
    const enOnly = words.filter((w) => EN_ONLY_WORDS.has(w)).length;
    if (esHits < 8 || esHits < enOnly) add(0, 'es translation must be written in Spanish (Español), not left in English.');
    if (desc && NON_LATIN_SCRIPT.test(desc)) add(0, 'es description must be written in Spanish (Español).');
    return { ok: !problems.length, problems };
  }

  add(0, `Unsupported skill language "${lang}". Platform languages: ${SKILL_LANGS.join(', ')}.`);
  return { ok: false, problems };
}

/**
 * Checks a skill body. Returns { ok, problems } where each problem names the line and why it was refused. Code of any
 * kind is refused; names of APIs and platform calls in short inline code (`GCP.ready()`) are fine. Also enforces the
 * language check (default: canonical English only).
 */
export function checkSkill(body, opts = {}) {
  const lang = normalizeSkillLang(opts?.lang) || 'en';
  const description = typeof opts?.description === 'string' ? opts.description : '';
  const minChars = isCjkLang(lang) ? SKILL_LIMITS.cjk_min_chars : SKILL_LIMITS.min_chars;
  const maxChars = isCjkLang(lang) ? SKILL_LIMITS.cjk_max_chars : SKILL_LIMITS.max_chars;

  const problems = [], text = String(body || '');
  const add = (line, why) => { if (problems.length < 25) problems.push({ line, why }); };
  if (text.length < minChars) add(0, `The skill is ${text.length} characters; write at least ${minChars} so it is useful to another agent.`);
  if (text.length > maxChars) add(0, `The skill is ${text.length} characters; the most is ${maxChars}.`);
  const lines = text.split('\n');
  let prevBlank = true;
  lines.forEach((l, i) => {
    const n = i + 1;
    if (/^\s*(```|~~~)/.test(l)) add(n, 'Code blocks are not allowed in a build skill. Describe the technique in words.');
    else if (prevBlank && /^(?: {4}|\t)\S/.test(l) && !/^\s*[-*+]\s|^\s*\d+[.)]\s/.test(l)) add(n, 'Indented lines read as a code block. Remove the indent or describe it in words.');
    else if (CODE_START.test(l.replace(/^\s*[-*+]\s+/, ''))) add(n, 'This line looks like source code. Describe what it does instead.');
    else if (TAG.test(l.replace(/`[^`]*`/g, ''))) add(n, 'HTML tags are not allowed. Name the element in words.');
    else {
      const plain = l.replace(/`[^`]*`/g, ' ');
      const sym = (plain.match(/[{}();=<>[\]]/g) || []).length;
      if (sym >= 8 && sym / Math.max(1, plain.length) > 0.06) add(n, 'This line is dense with code punctuation. Write it as prose.');
      for (const m of l.matchAll(/`([^`\n]*)`/g)) {
        const c = m[1];
        if (c.length > SKILL_LIMITS.inline_code_max) add(n, `Inline code is for names only (at most ${SKILL_LIMITS.inline_code_max} characters).`);
        else if (/[{};]|=>|\b(?:const|let|var|function|return)\b|[^=!<>]=[^=]/.test(c)) add(n, 'Inline code may name an API or a value, not hold a statement.');
      }
    }
    prevBlank = !l.trim();
  });
  if (headingsOf(text).length < SKILL_LIMITS.min_sections) add(0, `Organise the skill under at least ${SKILL_LIMITS.min_sections} level-two headings (## …). Suggested: ${SKILL_OUTLINE.map((s) => s.heading).join(', ')}.`);
  const langCheck = checkSkillLanguage(text, lang, description);
  for (const p of langCheck.problems) add(p.line, p.why);
  return { ok: !problems.length, problems };
}

/** Safely parses a game_skills.i18n JSON column into valid platform language entries. */
export function parseSkillI18n(raw) {
  let obj = raw;
  if (typeof raw === 'string') {
    try { obj = JSON.parse(raw || '{}'); } catch { obj = {}; }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {};
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    const lang = normalizeSkillLang(k);
    if (!lang || lang === 'en' || !v || typeof v !== 'object') continue;
    const content = typeof v.content === 'string' ? v.content.trim() : '';
    const description = typeof v.description === 'string' ? v.description.trim() : '';
    if (content) out[lang] = { description, content };
  }
  return out;
}

/** Platform languages available on a game_skills row, in platform order (English first when present). */
export function availableSkillLangs(row) {
  if (!row) return [];
  const i18n = parseSkillI18n(row.i18n);
  const out = [];
  if (row.content && String(row.content).trim()) out.push('en');
  for (const l of SKILL_TRANSLATION_LANGS) if (i18n[l]?.content) out.push(l);
  return out;
}

/** Platform languages missing from a game_skills row (checked by the release gate and build_skill). */
export function missingSkillLangs(row) {
  if (!row || !row.content || !String(row.content).trim()) return [...SKILL_LANGS];
  const i18n = parseSkillI18n(row.i18n);
  const missing = [];
  if (!checkSkillLanguage(row.content, 'en', row.description || '').ok) missing.push('en');
  for (const l of SKILL_TRANSLATION_LANGS) if (!i18n[l]?.content) missing.push(l);
  return missing;
}

/** A skill name in the form agent tools accept: lower-case words and hyphens, at most 64 characters. */
export function skillName(slug) {
  const s = String(slug || 'game').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return ('build-like-' + s).slice(0, 64).replace(/-+$/, '');
}

const oneLine = (s) => String(s || '').replace(/\s+/g, ' ').replace(/"/g, "'").trim();

const MD_TEXT = {
  en: {
    descUse: (title, desc) => `Use when building a game like ${title}. ${desc}`,
    descFallback: (title) => `How ${title} was built, from its own development agent.`,
    heading: (title) => `# Building a game like ${title}`,
    intro: (title, origin, slug, by, version) => `This skill was written by the development agent of [${title}](${origin}/g/${slug})${by ? ` by ${by}` : ''} and matches version ${version} of the live game. It holds the game's practices, not its code: the platform never shares source code. Following it does not guarantee the same result; it captures what worked for this game.`,
    measured: '## Measured by the platform',
    measuredIntro: (version) => `Facts the platform read from the build of version ${version}, not written by the creator:`,
    labels: { engine: 'Engine', rendering: 'Rendering', graphics: 'Graphics', input: 'Input', audio: 'Audio', art: 'Art', services: 'Platform services', loop: 'Loop and performance', size: 'Size' },
    sizeVal: (st) => `${st.files} files, about ${st.own_code_lines} lines of the game's own code, ${st.modules}`,
  },
  zh: {
    descUse: (title, desc) => `在制作类似《${title}》的游戏时使用。${desc}`,
    descFallback: (title) => `由《${title}》的开发智能体编写的制作实践指南。`,
    heading: (title) => `# 制作类似《${title}》的游戏`,
    intro: (title, origin, slug, by, version) => `本技能由 [${title}](${origin}/g/${slug})${by ? `（作者：${by}）` : ''} 的开发智能体编写，对应线上游戏的第 ${version} 版。它记录的是制作实践而非代码：平台从不分享源代码。参考本技能并不保证产出完全一致的结果，而是保留了这款游戏验证有效的经验。`,
    measured: '## 平台实测信息',
    measuredIntro: (version) => `以下为平台从第 ${version} 版构建产物中自动读取的客观信息（非作者手动填写）：`,
    labels: { engine: '引擎', rendering: '渲染', graphics: '图形', input: '输入', audio: '音频', art: '美术', services: '平台服务', loop: '主循环与性能', size: '规模' },
    sizeVal: (st) => `${st.files} 个文件，约 ${st.own_code_lines} 行游戏自有代码，${st.modules}`,
  },
  'zh-TW': {
    descUse: (title, desc) => `在製作類似《${title}》的遊戲時使用。${desc}`,
    descFallback: (title) => `由《${title}》的開發 AI 代理編寫的製作實踐指南。`,
    heading: (title) => `# 製作類似《${title}》的遊戲`,
    intro: (title, origin, slug, by, version) => `本技能由 [${title}](${origin}/g/${slug})${by ? `（作者：${by}）` : ''} 的開發 AI 代理編寫，對應線上遊戲的第 ${version} 版。它記錄的是製作實踐而非程式碼：平台從不分享原始碼。參考本技能並不保證產出完全一致的結果，而是保留了這款遊戲驗證有效的經驗。`,
    measured: '## 平台實測資訊',
    measuredIntro: (version) => `以下為平台從第 ${version} 版建置產物中自動讀取的客觀資訊（非作者手動填寫）：`,
    labels: { engine: '引擎', rendering: '算繪', graphics: '圖形', input: '輸入', audio: '音訊', art: '美術', services: '平台服務', loop: '主迴圈與效能', size: '規模' },
    sizeVal: (st) => `${st.files} 個檔案，約 ${st.own_code_lines} 行遊戲自有程式碼，${st.modules}`,
  },
  ja: {
    descUse: (title, desc) => `「${title}」のようなゲームを作る際に使用します。${desc}`,
    descFallback: (title) => `「${title}」の開発エージェントが記した制作ノウハウ。`,
    heading: (title) => `# 「${title}」のようなゲームを作る`,
    intro: (title, origin, slug, by, version) => `このスキルは [${title}](${origin}/g/${slug})${by ? `（作者: ${by}）` : ''} の開発エージェントによって書かれ、公開中のバージョン ${version} に対応しています。コードではなく制作上の実践知のみを収めており、プラットフォームがソースコードを共有することはありません。同じ結果を保証するものではなく、このゲームでうまく機能した手法をまとめたものです。`,
    measured: '## プラットフォームによる計測情報',
    measuredIntro: (version) => `バージョン ${version} のビルドからプラットフォームが自動読み取りした事実（作成者の記述ではありません）：`,
    labels: { engine: 'エンジン', rendering: 'レンダリング', graphics: 'グラフィックス', input: '入力', audio: 'オーディオ', art: 'アート', services: 'プラットフォーム機能', loop: 'ループとパフォーマンス', size: '規模' },
    sizeVal: (st) => `${st.files} ファイル、ゲーム独自コード約 ${st.own_code_lines} 行、${st.modules}`,
  },
  ko: {
    descUse: (title, desc) => `${title} 같은 게임을 만들 때 사용합니다. ${desc}`,
    descFallback: (title) => `${title}의 개발 에이전트가 정리한 제작 방법입니다.`,
    heading: (title) => `# ${title} 같은 게임 만들기`,
    intro: (title, origin, slug, by, version) => `이 스킬은 [${title}](${origin}/g/${slug})${by ? ` (제작: ${by})` : ''}의 개발 에이전트가 작성했으며 라이브 버전 ${version}과 일치합니다. 코드가 아닌 제작 관행만 담고 있으며 플랫폼은 소스 코드를 절대 공유하지 않습니다. 동일한 결과를 보장하지는 않지만 이 게임에서 효과가 있었던 방식을 정리한 내용입니다.`,
    measured: '## 플랫폼 측정 정보',
    measuredIntro: (version) => `버전 ${version} 빌드에서 플랫폼이 자동으로 읽은 정보(제작자가 직접 작성한 내용이 아님):`,
    labels: { engine: '엔진', rendering: '렌더링', graphics: '그래픽', input: '입력', audio: '오디오', art: '아트', services: '플랫폼 서비스', loop: '루프 및 성능', size: '규모' },
    sizeVal: (st) => `파일 ${st.files}개, 게임 자체 코드 약 ${st.own_code_lines}줄, ${st.modules}`,
  },
  es: {
    descUse: (title, desc) => `Úsalo al crear un juego como ${title}. ${desc}`,
    descFallback: (title) => `Cómo se construyó ${title}, escrito por su propio agente de desarrollo.`,
    heading: (title) => `# Cómo crear un juego como ${title}`,
    intro: (title, origin, slug, by, version) => `Esta skill fue escrita por el agente de desarrollo de [${title}](${origin}/g/${slug})${by ? ` de ${by}` : ''} y corresponde a la versión ${version} publicada. Contiene las prácticas del juego, nunca su código: la plataforma jamás comparte código fuente. Seguirla no garantiza el mismo resultado; recoge lo que funcionó en este juego.`,
    measured: '## Medido por la plataforma',
    measuredIntro: (version) => `Datos que la plataforma leyó de la compilación de la versión ${version}, no escritos por el creador:`,
    labels: { engine: 'Motor', rendering: 'Renderizado', graphics: 'Gráficos', input: 'Entrada', audio: 'Audio', art: 'Arte', services: 'Servicios de la plataforma', loop: 'Bucle y rendimiento', size: 'Tamaño' },
    sizeVal: (st) => `${st.files} archivos, unas ${st.own_code_lines} líneas de código propio del juego, ${st.modules}`,
  },
};

/**
 * The SKILL.md another agent drops into its skills folder: front matter (name, description), a title, where it comes
 * from, the creator's body, and the facts the platform measured from the live build. What Copy skill copies.
 */
export function skillMarkdown({ title, slug, by, version, description, body, origin, facts, lang = 'en' }) {
  const L = MD_TEXT[normalizeSkillLang(lang) || 'en'] || MD_TEXT.en;
  const cleanTitle = oneLine(title);
  const desc = oneLine(description) || L.descFallback(cleanTitle);
  const out = [
    '---',
    `name: ${skillName(slug)}`,
    `description: "${L.descUse(cleanTitle, desc)}"`,
    '---',
    '',
    L.heading(cleanTitle),
    '',
    L.intro(cleanTitle, origin, slug, oneLine(by), version),
    '',
    String(body || '').trim(),
  ];
  const f = facts && typeof facts === 'object' ? facts : null;
  if (f) {
    const list = (a) => (Array.isArray(a) && a.length ? a.join(', ') : null);
    const lb = L.labels;
    const rows = [
      [lb.engine, f.engine], [lb.rendering, list(f.rendering)], [lb.graphics, list(f.graphics)], [lb.input, list(f.input)], [lb.audio, list(f.audio)],
      [lb.art, f.assets && f.assets.approach], [lb.services, list(f.platform_services)], [lb.loop, list(f.loop_and_performance)],
      [lb.size, f.structure ? L.sizeVal(f.structure) : null],
    ].filter(([, v]) => v);
    if (rows.length) out.push('', L.measured, '', L.measuredIntro(version), '', ...rows.map(([k, v]) => `- ${k}: ${v}`));
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n') + '\n';
}

/**
 * A stand-in for a game that shares its implementation but whose agent has not written a skill yet: the platform's own
 * card (facts and summary) arranged as a skill. Marked as written by the platform.
 */
export function fallbackSkill(listing, facts, summary) {
  const f = facts || {}, list = (a) => (Array.isArray(a) && a.length ? a.join(', ') : 'not detected');
  const parts = [
    '## What you are building', '', String(summary || listing.tagline || listing.title || '').trim(), '',
    '## Architecture', '',
    `- Engine: ${f.engine || 'not detected'}${f.libraries && f.libraries.length ? `, with ${f.libraries.join(', ')}` : ''}.`,
    f.structure ? `- Structure: ${f.structure.files} files written as ${f.structure.modules}, about ${f.structure.own_code_lines} lines of the game's own code${f.structure.server_code ? ', plus server code on the platform' : ''}.` : '- Structure: not measured.',
    '', '## Rendering and art', '', `- Rendering: ${list(f.rendering)}.`, `- Graphics: ${list(f.graphics)}.`, `- Art: ${(f.assets && f.assets.approach) || 'not measured'}.`,
    '', '## Controls and sound', '', `- Input: ${list(f.input)}.`, `- Audio: ${list(f.audio)}.`,
    '', '## Platform services and performance', '', `- Platform services: ${list(f.platform_services)}.`, `- Loop and performance: ${list(f.loop_and_performance)}.`,
  ];
  if (f.gameplay && f.gameplay.playthrough_steps && f.gameplay.playthrough_steps.length) parts.push('', '## Testing and release', '', `The verified play-through goes: ${f.gameplay.playthrough_steps.join(', then ')}.`);
  return parts.join('\n');
}
