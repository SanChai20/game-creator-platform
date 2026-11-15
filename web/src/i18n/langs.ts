// The languages the web app speaks, and how a visitor's language is picked. No imports, so the Worker and tests can use it too.
export type Lang = 'en' | 'zh' | 'zh-TW' | 'ja' | 'ko' | 'es';

/** `code` is what we store, `tag` the BCP 47 tag for <html lang> and Intl, `name` the language's name in itself. */
export const LANGS: readonly { code: Lang; tag: string; name: string; short: string }[] = [
  { code: 'en', tag: 'en', name: 'English', short: 'EN' },
  { code: 'zh', tag: 'zh-CN', name: '简体中文', short: '简' },
  { code: 'zh-TW', tag: 'zh-TW', name: '繁體中文', short: '繁' },
  { code: 'ja', tag: 'ja', name: '日本語', short: '日' },
  { code: 'ko', tag: 'ko', name: '한국어', short: '한' },
  { code: 'es', tag: 'es', name: 'Español', short: 'ES' },
];

export const isLang = (v: unknown): v is Lang => LANGS.some((l) => l.code === v);
export const langTag = (l: Lang) => LANGS.find((x) => x.code === l)!.tag;

/** Maps one language tag (zh-Hant-HK, zh_TW, ja-JP, es-419, ko, …) or a stored/URL value to a supported language. */
export function matchLang(raw: string | null | undefined): Lang | null {
  const l = String(raw || '').trim().toLowerCase().replace(/_/g, '-');
  if (!l) return null;
  if (isLang(raw)) return raw as Lang;
  if (l === 'zh-cn' || l === 'zh-hans' || l === 'zh-sg') return 'zh';
  if (l.startsWith('zh')) {
    if (/^zh-hans\b/.test(l)) return 'zh';
    if (/^zh-(hant|tw|hk|mo)\b/.test(l)) return 'zh-TW';
    return 'zh';
  }
  for (const c of ['ja', 'ko', 'es', 'en'] as const) if (l === c || l.startsWith(c + '-')) return c;
  return null;
}

/** The first supported language in a preference list (navigator.languages, or an Accept-Language header). */
export function detectLang(prefs: readonly string[] | string | null | undefined): Lang {
  const list = typeof prefs === 'string'
    ? prefs.split(',').map((p) => { const [tag, ...params] = p.trim().split(';'); const q = params.find((x) => x.trim().startsWith('q=')); return { tag, q: q ? Number(q.trim().slice(2)) || 0 : 1 }; })
      .filter((x) => x.tag && x.q > 0).sort((a, b) => b.q - a.q).map((x) => x.tag)
    : prefs || [];
  for (const p of list) { const m = matchLang(p); if (m) return m; }
  return 'en';
}
