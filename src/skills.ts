// Build skills and the Creator Store. A game that shares its Open Implementation shares a build skill: an agent skill its
// own development agent writes (build_skill in src/mcp/tools.ts) about how the game is built, never its code. A skill is
// written for one version; the store always serves the one written for the live version, and while sharing is on a new
// version cannot go live without one (admin setting skill_required_to_publish), so the skill stays in step with every
// release. Rollbacks bring back the skill written for that version. A creator shares the skill for free (the game's sales
// then pay the lower cut) or sells it (the game pays the standard cut, and each skill sale pays the skill commission).
//
// Language policy: every build skill's canonical base text is written in English only (en), and each release also carries
// translations for every other platform language (zh, zh-TW, ja, ko, es) stored in game_skill_i18n so the Creator Store
// follows the viewer's language seamlessly without bloating single D1 rows or racing on parallel writes.
// The rules about what a skill may contain are in src/skill-rules.js.
import { listingLangs } from './listing';
import { AppError, bad, forbidden, notFound, type Env, type Project, type User } from './env';
import { getProject, logEvent } from './projects';
import { getSettings, type Settings } from './settings';
import { ownsSkill, splitSkillSale } from './earnings';
import { buildImplementation } from './implementations';
import { now, parseJson } from './util';
// @ts-ignore plain JS module
import {
  SKILL_LANGS, SKILL_LANG_NAMES, SKILL_LIMITS, SKILL_OUTLINE, SKILL_TRANSLATION_LANGS,
  availableSkillLangs, checkSkill, checkSkillLanguage, fallbackSkill, headingsOf,
  missingSkillLangs, normalizeSkill, normalizeSkillLang, parseSkillI18n, skillMarkdown, skillName,
} from './skill-rules.js';

export interface SkillRow {
  project_id: string;
  version: number;
  description: string;
  content: string;
  i18n?: string | null;
  written_by: string;
  created_at: number;
  updated_at: number;
}

export interface SkillTrRow {
  project_id: string;
  version: number;
  lang: string;
  description: string;
  content: string;
  updated_at: number;
}

export { SKILL_LANGS, SKILL_TRANSLATION_LANGS, availableSkillLangs, missingSkillLangs, normalizeSkillLang, parseSkillI18n };

const usd = (c: number) => `$${(c / 100).toFixed(2)}`;
const langNameOf = (l: string) => (SKILL_LANG_NAMES as Record<string, string>)[l] || l;
const skillI18nOf = (raw: unknown): Record<string, { description: string; content: string }> => parseSkillI18n(raw) as Record<string, { description: string; content: string }>;
export const NO_CODE = 'A build skill holds a game\'s practices, never its code: the platform refuses code blocks, HTML and code-like lines, and never shares source files or assets.';
export const ENGLISH_FIRST = 'Write the canonical base build skill in English only (no other languages), and provide translations for all other platform languages (zh, zh-TW, ja, ko, es) so the skill switches with the platform language.';

/** The skill written for exactly this version, if any. */
export const skillFor = (env: Env, pid: string, version: number) =>
  env.DB.prepare('SELECT * FROM game_skills WHERE project_id = ? AND version = ?').bind(pid, version).first<SkillRow>();

/** All stored translations for one (project_id, version) from game_skill_i18n (merged with any legacy JSON column). */
export async function skillTranslations(env: Env, pid: string, version: number, legacyI18n?: string | null): Promise<Record<string, { description: string; content: string }>> {
  const map = skillI18nOf(legacyI18n);
  const rows = await env.DB.prepare('SELECT lang, description, content FROM game_skill_i18n WHERE project_id = ? AND version = ?').bind(pid, version).all<{ lang: string; description: string; content: string }>();
  for (const r of rows.results) {
    const l = normalizeSkillLang(r.lang);
    if (l && l !== 'en' && r.content?.trim()) map[l] = { description: r.description || '', content: r.content };
  }
  return map;
}

/** Lightweight language-code lookup for one (project_id, version), without loading full translation bodies. */
export async function skillLangCodes(env: Env, pid: string, version: number, legacyI18n?: string | null): Promise<string[]> {
  const set = new Set<string>(Object.keys(skillI18nOf(legacyI18n)));
  const rows = await env.DB.prepare('SELECT lang FROM game_skill_i18n WHERE project_id = ? AND version = ?').bind(pid, version).all<{ lang: string }>();
  for (const r of rows.results) {
    const l = normalizeSkillLang(r.lang);
    if (l && l !== 'en') set.add(l);
  }
  return SKILL_TRANSLATION_LANGS.filter((l: string) => set.has(l));
}

/** Computes available & missing platform languages for a game_skills row given its present translation lang codes. */
export function skillCoverage(row: Pick<SkillRow, 'content' | 'description'> | null | undefined, trLangs: readonly string[]): { available: string[]; missing: string[] } {
  if (!row || !row.content?.trim()) return { available: [], missing: [...SKILL_LANGS] };
  const set = new Set(trLangs);
  const available = ['en', ...SKILL_TRANSLATION_LANGS.filter((l: string) => set.has(l))];
  const missing: string[] = [];
  if (!checkSkillLanguage(row.content, 'en', row.description || '').ok) missing.push('en');
  for (const l of SKILL_TRANSLATION_LANGS) if (!set.has(l)) missing.push(l);
  return { available, missing };
}

/**
 * The skill that describes the live game: the one written for the live version, or (when the agent has not written one
 * for it, e.g. the game went live before skills existed) the newest one written for an earlier version, marked as behind.
 * With none at all, a game that shares gets the platform's own card arranged as a skill.
 */
export async function liveSkill(env: Env, p: Project): Promise<{ row: SkillRow; current: boolean; generated: boolean } | null> {
  if (!p.live_version) return null;
  const row = await env.DB.prepare('SELECT * FROM game_skills WHERE project_id = ? AND version <= ? ORDER BY version DESC LIMIT 1').bind(p.id, p.live_version).first<SkillRow>();
  if (row) return { row, current: row.version === p.live_version, generated: false };
  if (!p.open_implementation) return null;
  let card = await env.DB.prepare('SELECT version, facts, summary FROM implementations WHERE project_id = ?').bind(p.id).first<{ version: number; facts: string; summary: string }>();
  if (!card || card.version !== p.live_version) card = await buildImplementation(env, p.id, { ai: false }).catch(() => null);
  if (!card) return null;
  const listing = { title: p.title, tagline: p.tagline, tags: parseJson<string[]>(p.tags, []) };
  const content = fallbackSkill(listing, parseJson(card.facts, {}), card.summary);
  return { row: { project_id: p.id, version: card.version, description: p.tagline || '', content, i18n: '{}', written_by: 'platform', created_at: now(), updated_at: now() }, current: card.version === p.live_version, generated: true };
}

/** Measured facts of the live build, for the platform's section of the SKILL.md. */
async function factsOf(env: Env, p: Project) {
  const r = await env.DB.prepare('SELECT version, facts FROM implementations WHERE project_id = ?').bind(p.id).first<{ version: number; facts: string }>();
  return r && r.version === p.live_version ? parseJson<any>(r.facts, null) : null;
}

function throwSkillRefused(lang: string, problems: { line: number; why: string }[]): never {
  const lines = problems.map((x) => (x.line ? `line ${x.line}: ${x.why}` : x.why));
  const label = lang === 'en' ? 'English build skill' : `${lang} (${langNameOf(lang)}) translation`;
  throw new AppError(
    400,
    `The ${label} was not saved. ${lines.length} thing${lines.length > 1 ? 's' : ''} to fix:\n${lines.join('\n')}`,
    'skill_refused',
    `${NO_CODE} ${ENGLISH_FIRST} Fix those lines and call build_skill {action: "write"} again. Line numbers count from the first line after the front matter and title.`,
  );
}

function validateTranslationEntry(
  trLang: string,
  raw: unknown,
  baseEnBody: string,
): { description: string; content: string } {
  const entry = typeof raw === 'string'
    ? { content: raw, description: '' }
    : raw && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as { content?: unknown; description?: unknown })
      : null;
  if (!entry || typeof entry.content !== 'string' || !entry.content.trim()) {
    throw bad(`Translation for "${trLang}" must be {description, content} with non-empty Markdown content.`);
  }
  const { body, description } = normalizeSkill(entry.content, typeof entry.description === 'string' ? entry.description : '');
  const check = checkSkill(body, { lang: trLang, description });
  if (!check.ok) throwSkillRefused(trLang, check.problems);
  if (trLang === 'es' && baseEnBody && body.trim() === baseEnBody.trim()) {
    throwSkillRefused(trLang, [{ line: 0, why: 'Spanish (es) translation cannot be identical to the English skill.' }]);
  }
  return { description, content: body };
}

/**
 * Writes the skill (or one/more translations of it) for one version of the game (default: the newest deployed version,
 * the one about to be published). Base language is always English (`en`) and strictly rejects non-English text; other
 * platform languages (`zh`, `zh-TW`, `ja`, `ko`, `es`) are stored per-row in game_skill_i18n and can be written together
 * via `translations` or one at a time via `language`. Refuses code and anything too short to be useful, naming each line.
 */
export async function writeSkill(
  env: Env,
  p: Project,
  a: { content?: unknown; description?: unknown; version?: unknown; language?: unknown; translations?: unknown },
  actor: string,
) {
  const n = a.version === undefined || a.version === null ? (p.preview_version || p.live_version) : Math.round(Number(a.version));
  if (!n || !Number.isFinite(n)) throw bad('This game has no version yet, so there is nothing for a skill to describe.', 'Call deploy_preview first, then write the skill for that version.');
  const v = await env.DB.prepare('SELECT n FROM versions WHERE project_id = ? AND n = ?').bind(p.id, n).first<{ n: number }>();
  if (!v) throw bad(`Version ${n} does not exist.`, 'list_versions shows the versions. Omit version to write for the newest one.');

  let lang = 'en';
  if (a.language !== undefined && a.language !== null && String(a.language).trim() !== '') {
    const parsed = normalizeSkillLang(a.language);
    if (!parsed) throw bad(`Unsupported language "${a.language}". Platform languages: ${SKILL_LANGS.join(', ')}.`);
    lang = parsed;
  }

  const existing = await skillFor(env, p.id, n);
  const t = now();

  // Case 1: writing a single non-English platform translation (language: "zh" | "zh-TW" | "ja" | "ko" | "es")
  if (lang !== 'en') {
    if (a.translations !== undefined) {
      throw bad('Do not pass both language and translations in the same call. Either write one language with language + content, or omit language and pass translations.');
    }
    if (!existing || !checkSkillLanguage(existing.content, 'en', existing.description).ok) {
      throw bad(
        `Write the canonical English build skill first (language: "en") for version ${n} before adding the ${lang} translation.`,
        'Call build_skill {action: "write", version, description, content} in English first, then write each translation.',
      );
    }
    const tr = validateTranslationEntry(lang, { content: a.content, description: a.description }, existing.content);
    await env.DB.batch([
      env.DB.prepare('INSERT INTO game_skill_i18n (project_id, version, lang, description, content, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(project_id, version, lang) DO UPDATE SET description = excluded.description, content = excluded.content, updated_at = excluded.updated_at')
        .bind(p.id, n, lang, tr.description, tr.content, t),
      env.DB.prepare('UPDATE game_skills SET updated_at = ? WHERE project_id = ? AND version = ?').bind(t, p.id, n),
    ]);
    await logEvent(env, p.id, 'skill_written', `Build skill translated to ${lang} (${headingsOf(tr.content).length} sections, ${tr.content.length} characters)`, n, actor);
    const cov = skillCoverage(existing, await skillLangCodes(env, p.id, n, existing.i18n));
    return {
      version: n,
      language: lang,
      sections: headingsOf(tr.content),
      characters: tr.content.length,
      description: tr.description,
      available_languages: cov.available,
      missing_languages: cov.missing,
    };
  }

  // Case 2: writing canonical English (`en`), optionally with `translations` map, OR updating `translations` on an existing English skill
  const hasContent = typeof a.content === 'string' && a.content.trim().length > 0;
  const hasTranslations = a.translations !== undefined && a.translations !== null;
  if (!hasContent && !hasTranslations) {
    throw bad('content is required: the base build skill in English Markdown, without code.', 'build_skill {action: "get"} returns the outline and what to cover.');
  }

  let baseBody = existing?.content || '';
  let baseDesc = existing?.description || '';
  if (hasContent) {
    const norm = normalizeSkill(a.content as string, typeof a.description === 'string' ? a.description : '');
    const check = checkSkill(norm.body, { lang: 'en', description: norm.description });
    if (!check.ok) throwSkillRefused('en', check.problems);
    baseBody = norm.body;
    baseDesc = norm.description;
  } else {
    if (!existing || !checkSkillLanguage(existing.content, 'en', existing.description).ok) {
      throw bad(
        `Write the canonical English build skill first for version ${n} before adding translations.`,
        'Include English content (and description), or write English first and then add translations.',
      );
    }
  }

  const trEntries: [string, { description: string; content: string }][] = [];
  if (hasTranslations) {
    if (typeof a.translations !== 'object' || Array.isArray(a.translations)) {
      throw bad(`translations must be an object mapping platform languages (${SKILL_TRANSLATION_LANGS.join(', ')}) to {description, content}.`);
    }
    for (const [rawK, rawV] of Object.entries(a.translations as Record<string, unknown>)) {
      const trLang = normalizeSkillLang(rawK);
      if (!trLang || trLang === 'en') {
        throw bad(`Invalid translation language "${rawK}". Use platform translation codes: ${SKILL_TRANSLATION_LANGS.join(', ')}. (English goes in top-level content/description.)`);
      }
      trEntries.push([trLang, validateTranslationEntry(trLang, rawV, baseBody)]);
    }
  }

  const stmts: D1PreparedStatement[] = [];
  if (hasContent) {
    stmts.push(
      env.DB.prepare(
        'INSERT INTO game_skills (project_id, version, description, content, written_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(project_id, version) DO UPDATE SET description = excluded.description, content = excluded.content, written_by = excluded.written_by, updated_at = excluded.updated_at',
      ).bind(p.id, n, baseDesc, baseBody, actor.slice(0, 80), t, t),
    );
  } else {
    stmts.push(env.DB.prepare('UPDATE game_skills SET updated_at = ? WHERE project_id = ? AND version = ?').bind(t, p.id, n));
  }
  for (const [trLang, tr] of trEntries) {
    stmts.push(
      env.DB.prepare('INSERT INTO game_skill_i18n (project_id, version, lang, description, content, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(project_id, version, lang) DO UPDATE SET description = excluded.description, content = excluded.content, updated_at = excluded.updated_at')
        .bind(p.id, n, trLang, tr.description, tr.content, t),
    );
  }
  await env.DB.batch(stmts);

  const addedLangs = trEntries.map(([l]) => l);
  const noteLangs = hasContent
    ? (addedLangs.length ? `en + ${addedLangs.join(', ')}` : 'en')
    : addedLangs.join(', ');
  await logEvent(env, p.id, 'skill_written', `Build skill written (${noteLangs}; ${headingsOf(baseBody).length} sections, ${baseBody.length} characters)`, n, actor);

  const cov = skillCoverage({ content: baseBody, description: baseDesc }, await skillLangCodes(env, p.id, n, existing?.i18n));
  return {
    version: n,
    language: 'en',
    sections: headingsOf(baseBody),
    characters: baseBody.length,
    description: baseDesc,
    available_languages: cov.available,
    missing_languages: cov.missing,
  };
}

/**
 * Why version n of this game cannot be published yet, or null. Only a game that shares its skill is held to it.
 * Enforces: (1) a skill exists for version n, (2) its canonical base is written in English only, and (3) translations
 * exist for every other platform language (zh, zh-TW, ja, ko, es).
 */
export async function skillGate(env: Env, s: Pick<Settings, 'skill_required_to_publish'>, p: Project, n: number): Promise<string | null> {
  if (!s.skill_required_to_publish || !p.open_implementation) return null;
  const row = await skillFor(env, p.id, n);
  if (!row) {
    return `This game shares its build skill in the Creator Store, and the skill must match every release: version ${n} has no build skill yet. Write the base skill in English first, then translate it into all platform languages (${SKILL_TRANSLATION_LANGS.join(', ')}).`;
  }
  const enCheck = checkSkillLanguage(row.content, 'en', row.description || '');
  if (!enCheck.ok) {
    return `Version ${n}'s base build skill must be written in English only (no other languages). Rewrite it in English and provide translations for ${SKILL_TRANSLATION_LANGS.join(', ')}.`;
  }
  const cov = skillCoverage(row, await skillLangCodes(env, p.id, n, row.i18n));
  const missing = cov.missing.filter((l) => l !== 'en');
  if (missing.length) {
    const named = missing.map((l) => `${l} (${langNameOf(l)})`).join(', ');
    return `Version ${n}'s build skill is in English, but is missing translations for platform languages: ${named}. Call build_skill {action: "write", version: ${n}, language: "<lang>", description, content} for each missing language.`;
  }
  return null;
}

/** Sets the skill's price: 0 shares it for free; otherwise within the platform's range. */
export async function setSkillPrice(env: Env, s: Settings, p: Project, cents: unknown, actor: string) {
  const c = Math.round(Number(cents));
  if (!Number.isFinite(c) || c < 0) throw bad('skill_price_cents must be 0 (free) or a price in cents.');
  if (c > 0) {
    if (!s.paid_skills_enabled) throw forbidden('Selling build skills is turned off on this platform. Share it for free (0) instead.');
    if (c < s.skill_price_min_cents || c > s.skill_price_max_cents) throw bad(`A paid build skill costs from ${usd(s.skill_price_min_cents)} to ${usd(s.skill_price_max_cents)}.`);
    if (!(await env.DB.prepare('SELECT 1 FROM game_skills WHERE project_id = ? LIMIT 1').bind(p.id).first())) throw bad('There is no build skill to sell yet.', 'Ask the agent to write it first (build_skill {action: "write"}).');
  }
  if (c === (p.skill_price_cents || 0)) return;
  await env.DB.prepare('UPDATE projects SET skill_price_cents = ?, updated_at = ? WHERE id = ?').bind(c, now(), p.id).run();
  await logEvent(env, p.id, 'skill_price', c ? `Build skill priced at ${usd(c)}` : 'Build skill shared for free', null, actor);
}

/** Who may read a skill's content: everyone for a free one; the creator, admins and buyers for a paid one. */
async function access(env: Env, user: User | null, p: Project): Promise<{ can: boolean; why: 'free' | 'yours' | 'admin' | 'bought' | null }> {
  if (!(p.skill_price_cents > 0)) return { can: true, why: 'free' };
  if (!user) return { can: false, why: null };
  if (user.id === p.owner_id) return { can: true, why: 'yours' };
  if (await ownsSkill(env, user.id, p.id)) return { can: true, why: 'bought' };
  if (user.role === 'admin') return { can: true, why: 'admin' };
  return { can: false, why: null };
}

const STORE_SELECT = "SELECT p.*, u.name AS author, s.version AS s_version, s.description AS s_description, s.content AS s_content, s.i18n AS s_i18n, s.written_by AS s_by, s.updated_at AS s_updated FROM projects p JOIN users u ON u.id = p.owner_id LEFT JOIN game_skills s ON s.project_id = p.id AND s.version = (SELECT MAX(version) FROM game_skills x WHERE x.project_id = p.id AND x.version <= p.live_version) WHERE p.status = 'live' AND p.open_implementation = 1";

function entry(origin: string, r: any, owned: boolean, trMap?: Record<string, { description: string; content: string }>) {
  const generated = !r.s_version, version = r.s_version || r.live_version;
  const resolved = generated ? {} : (trMap ?? skillI18nOf(r.s_i18n));
  const skillI18n: Record<string, { description: string; sections: string[]; characters: number }> = {};
  for (const l of SKILL_TRANSLATION_LANGS) {
    const tr = resolved[l];
    if (tr?.content) skillI18n[l] = { description: tr.description || '', sections: headingsOf(tr.content), characters: tr.content.length };
  }
  const languages = generated ? ['en'] : ['en', ...SKILL_TRANSLATION_LANGS.filter((l: string) => !!resolved[l]?.content)];
  return {
    game: { id: r.id, slug: r.slug, title: r.title, tagline: r.tagline, by: r.author, tags: parseJson<string[]>(r.tags, []), cover: r.cover_key ? `${origin}/api/media/${r.cover_key}` : null, ...listingLangs(r, ['title', 'tagline'], (k) => `${origin}/api/media/${k}`), game_page: `${origin}/g/${r.slug}`, plays: r.plays, live_version: r.live_version, price_cents: r.price_cents },
    skill: {
      name: skillName(r.slug), price_cents: Number(r.skill_price_cents) || 0, free: !(Number(r.skill_price_cents) > 0), version, in_sync: version === r.live_version, written_by_platform: generated,
      lang: 'en', languages,
      description: generated ? (r.tagline || '') : (r.s_description || r.tagline || ''), sections: generated ? [] : headingsOf(r.s_content), characters: generated ? 0 : String(r.s_content || '').length,
      ...(Object.keys(skillI18n).length ? { i18n: skillI18n } : {}),
      sales: Number(r.skill_sales) || 0, copies: Number(r.skill_copies) || 0, updated_at: r.s_updated || r.published_at, page: `${origin}/creator-store/${r.slug}`,
      ...(owned ? { owned: true } : {}),
    },
  };
}

/** Batch-loads translations from game_skill_i18n for a set of (project_id, version) pairs. */
async function loadTranslationsBatch(env: Env, rows: { id: string; s_version: number | null; s_i18n?: string | null }[]): Promise<Map<string, Record<string, { description: string; content: string }>>> {
  const out = new Map<string, Record<string, { description: string; content: string }>>();
  const targets = rows.filter((r) => r.s_version != null);
  for (const r of targets) out.set(`${r.id}:${r.s_version}`, skillI18nOf(r.s_i18n));
  if (!targets.length) return out;
  const pids = [...new Set(targets.map((r) => r.id))];
  const trRows = await env.DB.prepare('SELECT project_id, version, lang, description, content FROM game_skill_i18n WHERE project_id IN (SELECT value FROM json_each(?))')
    .bind(JSON.stringify(pids)).all<SkillTrRow>();
  for (const tr of trRows.results) {
    const key = `${tr.project_id}:${tr.version}`;
    const map = out.get(key);
    const l = normalizeSkillLang(tr.lang);
    if (map && l && l !== 'en' && tr.content?.trim()) map[l] = { description: tr.description || '', content: tr.content };
  }
  return out;
}

/** The Creator Store: every shared skill, listed under its game. Paid skills that have no written skill are left out. */
export async function storeList(env: Env, origin: string, user: User | null, q: { query?: string; price?: string; sort?: string; limit?: number; offset?: number }) {
  const words = String(q.query || '').toLowerCase().split(/[^\p{L}\p{N}.+-]+/u).filter((w) => w.length > 1).slice(0, 8);
  let rows = (await env.DB.prepare(`${STORE_SELECT} ORDER BY p.plays DESC LIMIT 5000`).all<any>()).results
    .filter((r) => r.s_version || !(Number(r.skill_price_cents) > 0))
    .filter((r) => q.price === 'free' ? !(Number(r.skill_price_cents) > 0) : q.price === 'paid' ? Number(r.skill_price_cents) > 0 : true);

  let trBatch: Map<string, Record<string, { description: string; content: string }>> | null = null;
  if (words.length) {
    trBatch = await loadTranslationsBatch(env, rows);
    rows = rows.filter((r) => {
      const trs = r.s_version != null ? (trBatch!.get(`${r.id}:${r.s_version}`) || {}) : {};
      const trText = Object.values(trs).map((t) => `${t.description || ''} ${headingsOf(t.content).join(' ')}`).join(' ');
      const listingTr = parseJson<Record<string, { title?: string; tagline?: string }>>(r.listing_i18n || '{}', {});
      const listingText = Object.values(listingTr).map((l) => `${l.title || ''} ${l.tagline || ''}`).join(' ');
      const hay = `${r.title} ${r.tagline} ${r.tags} ${r.author} ${r.s_description || ''} ${headingsOf(r.s_content).join(' ')} ${trText} ${listingText}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    });
  }
  if (q.sort === 'new') rows.sort((a, b) => (b.s_updated || b.published_at || 0) - (a.s_updated || a.published_at || 0));
  else if (q.sort === 'sales') rows.sort((a, b) => (b.skill_sales + b.skill_copies) - (a.skill_sales + a.skill_copies));
  const bought = user ? new Set((await env.DB.prepare("SELECT project_id FROM skill_purchases WHERE user_id = ? AND status = 'paid'").bind(user.id).all<{ project_id: string }>()).results.map((x) => x.project_id)) : new Set<string>();
  const limit = Math.max(1, Math.min(100, Math.round(Number(q.limit) || 24))), offset = Math.max(0, Math.round(Number(q.offset) || 0));
  const page = Math.floor(offset / limit) + 1;
  const slice = rows.slice(offset, offset + limit);
  if (!trBatch) trBatch = await loadTranslationsBatch(env, slice);
  return {
    total: rows.length, page, per_page: limit, pages: Math.max(1, Math.ceil(rows.length / limit)),
    skills: slice.map((r) => entry(origin, r, bought.has(r.id) || r.owner_id === user?.id, r.s_version != null ? trBatch!.get(`${r.id}:${r.s_version}`) : undefined)),
  };
}

/** One game's skill: its listing, and its full content and SKILL.md in the requested platform language (default English). */
export async function storeItem(env: Env, origin: string, user: User | null, slug: string, count = true, reqLang?: string) {
  const p = await getProject(env, String(slug || '').trim().replace(/^.*\/(?:g|creator-store)\//, '').replace(/[/?#].*$/, ''));
  if (!p || p.status !== 'live' || (!p.open_implementation && p.owner_id !== user?.id)) throw notFound('There is no build skill for that game in the Creator Store. Only live games whose creators share their skill are listed.');
  const live = await liveSkill(env, p);
  if (!live || (live.generated && p.skill_price_cents > 0)) throw notFound('This game\'s creator has not written its build skill yet.');
  const author = (await env.DB.prepare('SELECT name FROM users WHERE id = ?').bind(p.owner_id).first<{ name: string }>())?.name || '';
  const a = await access(env, user, p), s = await getSettings(env);
  if (count && user?.id !== p.owner_id) await env.DB.prepare('UPDATE projects SET skill_views = skill_views + 1 WHERE id = ?').bind(p.id).run();
  const wantedLang = normalizeSkillLang(reqLang) || 'en';
  const trMap = live.generated ? {} : await skillTranslations(env, p.id, live.row.version, live.row.i18n);
  const tr = wantedLang !== 'en' ? trMap[wantedLang] : null;
  const activeLang = tr ? wantedLang : 'en';
  const activeBody = tr ? tr.content : live.row.content;
  const activeDesc = tr ? (tr.description || '') : (live.row.description || '');
  const listingTr = parseJson<Record<string, { title?: string; tagline?: string }>>(p.listing_i18n || '{}', {});
  const localTitle = (activeLang !== 'en' && listingTr[activeLang]?.title) || (activeLang === 'en' && listingTr.en?.title) || p.title;
  const localTagline = (activeLang !== 'en' && listingTr[activeLang]?.tagline) || (activeLang === 'en' && listingTr.en?.tagline) || p.tagline;

  const base = entry(origin, { ...p, author, s_version: live.generated ? null : live.row.version, s_description: live.row.description, s_content: live.row.content, s_i18n: live.row.i18n, s_updated: live.row.updated_at }, a.why === 'bought' || a.why === 'yours', trMap);
  const md = a.can ? skillMarkdown({ title: localTitle, slug: p.slug, by: author, version: live.row.version, description: activeDesc || localTagline, body: activeBody, origin, facts: await factsOf(env, p), lang: activeLang }) : null;
  return {
    ...base,
    shared: !!p.open_implementation,
    access: a.why, locked: !a.can,
    active_lang: activeLang,
    content: a.can ? activeBody : null, skill_md: md,
    buy: a.can ? null : { price_cents: p.skill_price_cents, sign_in: !user, note: 'The full skill shows after purchase.' },
    ...(user?.id === p.owner_id ? { yours: { sales: p.skill_sales, copies: p.skill_copies, views: p.skill_views, creator_receives_per_sale: p.skill_price_cents > 0 ? splitSkillSale(p.skill_price_cents, s).net : null } } : {}),
    never_shared: NO_CODE,
  };
}

/** Someone copied or downloaded the skill: counted for the creator, once per reader per hour. */
export async function skillCopied(env: Env, user: User | null, slug: string, key: string) {
  const p = await getProject(env, slug);
  if (!p || p.status !== 'live' || !p.open_implementation) throw notFound();
  const a = await access(env, user, p);
  if (!a.can) throw forbidden('Buy the skill first.');
  if (user?.id === p.owner_id) return { ok: true };
  const k = `skill_copy:${p.id}:${key}`, t = now();
  const seen = await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind('_' + k).first<{ value: string }>();
  if (seen && t - Number(seen.value) < 3600_000) return { ok: true };
  await env.DB.batch([
    env.DB.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at').bind('_' + k, String(t), t),
    env.DB.prepare('UPDATE projects SET skill_copies = skill_copies + 1 WHERE id = ?').bind(p.id),
  ]);
  return { ok: true };
}

/** What the game's own agent gets from build_skill {action: "get"}: the current skill, sync state, language coverage and the outline. */
export async function skillForAgent(env: Env, origin: string, p: Project, version?: number, language?: string) {
  const s = await getSettings(env);
  const target = version || p.preview_version || p.live_version;
  const reqLang = language ? normalizeSkillLang(language) : null;
  if (language && !reqLang) throw bad(`Unsupported language "${language}". Platform languages: ${SKILL_LANGS.join(', ')}.`);
  const [row, live] = await Promise.all([target ? skillFor(env, p.id, target) : null, liveSkill(env, p)]);
  const newest = await env.DB.prepare('SELECT * FROM game_skills WHERE project_id = ? ORDER BY version DESC LIMIT 1').bind(p.id).first<SkillRow>();
  const refRow = row || newest;
  const [refTrLangs, liveTrLangs, requestedTr] = await Promise.all([
    refRow ? skillLangCodes(env, p.id, refRow.version, refRow.i18n) : Promise.resolve([] as string[]),
    live && !live.generated ? skillLangCodes(env, p.id, live.row.version, live.row.i18n) : Promise.resolve([] as string[]),
    refRow && reqLang && reqLang !== 'en'
      ? skillTranslations(env, p.id, refRow.version, refRow.i18n).then((m) => m[reqLang] || null)
      : Promise.resolve(null),
  ]);
  const cov = row ? skillCoverage(row, refTrLangs) : { available: [], missing: [...SKILL_LANGS] };
  return {
    game: p.slug, live_version: p.live_version, newest_version: p.preview_version, shared: !!p.open_implementation,
    price: p.skill_price_cents > 0 ? usd(p.skill_price_cents) : 'free',
    platform_languages: SKILL_LANGS,
    for_version: target ?? null, written_for_this_version: !!row,
    available_languages: cov.available,
    missing_languages: cov.missing,
    skill: row
      ? { version: row.version, language: 'en', description: row.description, content: row.content, translated_languages: refTrLangs }
      : newest
        ? { version: newest.version, language: 'en', description: newest.description, content: newest.content, translated_languages: refTrLangs, note: `This is the skill written for version ${newest.version}. Update it for version ${target} in English first, then write translations for ${SKILL_TRANSLATION_LANGS.join(', ')}.` }
        : null,
    ...(reqLang && reqLang !== 'en' ? { translation: requestedTr ? { version: refRow!.version, language: reqLang, ...requestedTr } : null } : {}),
    live: live ? { version: live.row.version, in_sync: live.current, written_by_platform: live.generated, languages: live.generated ? ['en'] : skillCoverage(live.row, liveTrLangs).available } : null,
    publishing: p.open_implementation && s.skill_required_to_publish
      ? `While the skill is shared, publish requires version ${target} to have an English-only base skill plus translations for all other platform languages (${SKILL_TRANSLATION_LANGS.join(', ')}).${cov.missing.length ? ` Still needed for v${target}: ${cov.missing.join(', ')}.` : ''}`
      : 'Not shared: publishing does not wait for the skill, but keeping it current in English and all platform languages means it is ready when the user shares it.',
    how_to_write: {
      format: 'Markdown. Write the canonical base skill in English ONLY (language: "en", default): a one-line description plus a body organised under level-two headings (##). Then translate it faithfully into all other platform languages (zh, zh-TW, ja, ko, es), either one call per language with build_skill {action: "write", version, language, description, content} (recommended for long skills) or together in translations. The platform adds the front matter (name, description), title, origin and measured facts.',
      rules: [
        ENGLISH_FIRST,
        NO_CODE,
        `${SKILL_LIMITS.min_chars} to ${SKILL_LIMITS.max_chars} characters for English/Spanish (${SKILL_LIMITS.cjk_min_chars} to ${SKILL_LIMITS.cjk_max_chars} characters for zh/zh-TW/ja/ko), at least ${SKILL_LIMITS.min_sections} sections.`,
        `Inline code only for names of APIs, files or values, at most ${SKILL_LIMITS.inline_code_max} characters.`,
        'Write for another agent building a similar game, not a different version of this one: practices, decisions and their reasons, numbers that were tuned, the order to build things in, and pitfalls.',
        'Describe what is in the version you write it for. Leave out secrets, keys, private addresses and anything the user asked to keep private.',
      ],
      outline: SKILL_OUTLINE,
    },
    store_page: `${origin}/creator-store/${p.slug}`,
  };
}

/** Skill sales of one creator, apart from game sales. */
export async function skillSalesOf(env: Env, ownerId: string) {
  const [total, byGame] = await Promise.all([
    env.DB.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(price_cents), 0) AS gross, COALESCE(SUM(fee_cents), 0) AS fees, COALESCE(SUM(net_cents), 0) AS net FROM skill_purchases WHERE owner_id = ? AND status = 'paid'").bind(ownerId).first<{ n: number; gross: number; fees: number; net: number }>(),
    env.DB.prepare("SELECT p.title, p.slug, p.skill_copies AS copies, COUNT(x.id) AS n, COALESCE(SUM(x.price_cents), 0) AS gross, COALESCE(SUM(x.fee_cents), 0) AS fees, COALESCE(SUM(x.net_cents), 0) AS net FROM projects p LEFT JOIN skill_purchases x ON x.project_id = p.id AND x.status = 'paid' WHERE p.owner_id = ? AND (p.open_implementation = 1 OR x.id IS NOT NULL) GROUP BY p.id ORDER BY net DESC, copies DESC").bind(ownerId).all<any>(),
  ]);
  return { total: total || { n: 0, gross: 0, fees: 0, net: 0 }, by_game: byGame.results };
}
