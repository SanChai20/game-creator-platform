// The game metadata specification: everything an agent states about a game so players see it, the same way, on every
// store page. Three layers:
//   listing   project level, editable any time (update_project): title, tagline, description, controls, cover,
//             genre + up to two secondary genres (from GENRES) + free tags, store listing translated into platform languages
//   build     frozen with each version, declared in gcp.json and merged with what the platform detects in the code:
//             requirements (web/src/compat.ts), languages (web/src/languages.ts), players, session, progress,
//             accessibility, content (from which the platform derives the age rating)
//   platform  never declared: price, trial, verification, version, dates, download size
// No imports except the sibling modules, so the Worker, the web app and the tests share one set of rules.
import { buildLanguages, type LangIssue, type LanguagesRecord } from './languages.ts';

export type MetaIssue = LangIssue;

// ---------------------------------------------------------------------------------------------
// Genres
// ---------------------------------------------------------------------------------------------
export const GENRES = [
  'action', 'adventure', 'arcade', 'board', 'card', 'casual', 'fighting', 'idle', 'music', 'platformer', 'puzzle', 'racing',
  'rpg', 'roguelike', 'sandbox', 'shooter', 'simulation', 'sports', 'strategy', 'survival', 'tower-defense', 'word', 'horror', 'educational',
] as const;
export type Genre = typeof GENRES[number];
const GENRE_ALIAS: Record<string, Genre> = {
  'role-playing': 'rpg', 'role playing': 'rpg', 'action-rpg': 'rpg', 'rogue-like': 'roguelike', 'roguelite': 'roguelike', 'rogue-lite': 'roguelike', 'platform': 'platformer',
  'platformers': 'platformer', 'puzzles': 'puzzle', 'shoot-em-up': 'shooter', 'shmup': 'shooter', 'fps': 'shooter', 'td': 'tower-defense', 'tower defense': 'tower-defense',
  'rhythm': 'music', 'trivia': 'word', 'quiz': 'word', 'clicker': 'idle', 'incremental': 'idle', 'sim': 'simulation', 'management': 'simulation', 'farming': 'simulation',
  'card game': 'card', 'board game': 'board', 'party': 'casual', 'hyper-casual': 'casual', 'beat-em-up': 'fighting', 'education': 'educational', 'learning': 'educational',
  'open-world': 'sandbox', 'building': 'sandbox', 'rts': 'strategy', 'tactics': 'strategy', 'turn-based': 'strategy', 'racer': 'racing', 'driving': 'racing',
};
export function normGenre(v: unknown): Genre | null {
  const s = String(v ?? '').trim().toLowerCase().replace(/[_\s]+/g, '-');
  if ((GENRES as readonly string[]).includes(s)) return s as Genre;
  return GENRE_ALIAS[s] ?? GENRE_ALIAS[s.replace(/-/g, ' ')] ?? null;
}
/** Puts the primary genre first, then secondary genres, then free tags: the store treats the first tag as the genre. */
export function genreTags(primary: Genre, secondary: Genre[], tags: string[]): string[] {
  const out: string[] = [primary, ...secondary.filter((g) => g !== primary).slice(0, 2)];
  const cap = out.length + 8;   // up to 8 tags besides the genres (MAX_TAGS in tags.ts)
  for (const t of tags) if (!out.includes(t) && !(GENRES as readonly string[]).includes(t) && out.length < cap) out.push(t);
  return out;
}
/** The genres a project's tags declare: the first tag when it is a known genre, plus the known genres among the next two. */
export function genresOf(tags: string[]): { primary: Genre | null; secondary: Genre[] } {
  const primary = tags[0] && (GENRES as readonly string[]).includes(tags[0]) ? tags[0] as Genre : null;
  return { primary, secondary: primary ? tags.slice(1, 3).filter((t): t is Genre => (GENRES as readonly string[]).includes(t)) : [] };
}

// ---------------------------------------------------------------------------------------------
// The build layer
// ---------------------------------------------------------------------------------------------
export const MODES = ['single', 'coop-local', 'coop-online', 'pvp-local', 'pvp-online'] as const;
export type Mode = typeof MODES[number];
export interface Players { min: number; max: number; modes: Mode[] }
export interface Progress { cloud_saves: boolean; leaderboards: boolean; offline: boolean }
export const ACCESSIBILITY = ['remappable-controls', 'colorblind-modes', 'subtitles', 'adjustable-difficulty', 'reduced-motion', 'scalable-text', 'one-handed', 'pause-anytime', 'no-time-pressure', 'visual-sound-cues'] as const;
export type Access = typeof ACCESSIBILITY[number];
export interface Content {
  violence: 'none' | 'cartoon' | 'fantasy' | 'realistic';
  blood: boolean;
  language: 'none' | 'mild' | 'strong';
  fear: 'none' | 'mild' | 'intense';
  sexual: 'none' | 'suggestive';
  drugs: boolean;
  gambling: 'none' | 'simulated';
  flashing_lights: boolean;
  player_chat: boolean;
}
export const CONTENT_CHOICES: { [K in keyof Content]: readonly (Content[K] & (string | boolean))[] } = {
  violence: ['none', 'cartoon', 'fantasy', 'realistic'], blood: [false, true], language: ['none', 'mild', 'strong'], fear: ['none', 'mild', 'intense'],
  sexual: ['none', 'suggestive'], drugs: [false, true], gambling: ['none', 'simulated'], flashing_lights: [false, true], player_chat: [false, true],
};
export type Age = 3 | 7 | 12 | 16 | 18;

/** The platform's age rating, from the content descriptors. The highest band any descriptor reaches wins. */
export function ageRating(c: Content): { age: Age; reasons: (keyof Content | `${keyof Content}:${string}`)[] } {
  const hits: [Age, string][] = [];
  if (c.violence === 'realistic') hits.push([c.blood ? 18 : 16, 'violence:realistic']);
  else if (c.violence === 'fantasy') hits.push([12, 'violence:fantasy']);
  else if (c.violence === 'cartoon') hits.push([7, 'violence:cartoon']);
  if (c.blood && c.violence !== 'realistic') hits.push([12, 'blood']);
  if (c.language === 'strong') hits.push([16, 'language:strong']); else if (c.language === 'mild') hits.push([12, 'language:mild']);
  if (c.fear === 'intense') hits.push([16, 'fear:intense']); else if (c.fear === 'mild') hits.push([7, 'fear:mild']);
  if (c.sexual === 'suggestive') hits.push([16, 'sexual:suggestive']);
  if (c.drugs) hits.push([16, 'drugs']);
  if (c.gambling === 'simulated') hits.push([12, 'gambling:simulated']);
  const age = hits.reduce<number>((a, [n]) => Math.max(a, n), 3) as Age;
  return { age, reasons: hits.map(([, r]) => r) as never };
}

export interface BuildMeta {
  players: Players | null;
  session_minutes: number | null;
  progress: Progress;
  accessibility: Access[] | null;            // null: not declared; [] declared as none
  content: Content | null;
}
export interface MetaRecord {
  v: 1;
  meta: BuildMeta;
  declared: (keyof BuildMeta | 'languages')[];
  detected: { multiplayer: boolean; progress: Progress; evidence: Record<string, string> };
  rating: { age: Age; reasons: string[] } | null;
  languages: LanguagesRecord;
}

const e = (issues: MetaIssue[], field: string, message: string, hint?: string) => issues.push({ level: 'error', field, message, hint });
const w = (issues: MetaIssue[], field: string, message: string, hint?: string) => issues.push({ level: 'warning', field, message, hint });

export function parsePlayers(raw: unknown, issues: MetaIssue[]): Players | null {
  if (raw === undefined || raw === null) return null;
  const r = (typeof raw === 'number' ? { min: 1, max: raw, modes: raw > 1 ? [] : ['single'] } : raw) as Record<string, unknown>;
  if (!r || typeof r !== 'object' || Array.isArray(r)) { e(issues, 'players', 'players must be {min, max, modes}.', 'Example: {"min": 1, "max": 4, "modes": ["single", "coop-online"]}.'); return null; }
  for (const k of Object.keys(r)) if (!['min', 'max', 'modes'].includes(k)) e(issues, 'players', `Unknown field "${k}".`, 'Fields: min, max, modes.');
  const min = Number(r.min ?? 1), max = Number(r.max ?? min);
  if (!Number.isInteger(min) || min < 1 || min > 100) e(issues, 'players.min', 'min must be a whole number from 1 to 100.');
  if (!Number.isInteger(max) || max < min || max > 1000) e(issues, 'players.max', 'max must be a whole number, at least min, at most 1000.');
  const modes: Mode[] = [];
  for (const m of Array.isArray(r.modes) ? r.modes : r.modes ? [r.modes] : []) { const s = String(m).toLowerCase().replace(/[_\s]/g, '-'); const id = ({ solo: 'single', 'single-player': 'single', coop: 'coop-online', 'co-op': 'coop-online', 'co-op-online': 'coop-online', 'co-op-local': 'coop-local', pvp: 'pvp-online', versus: 'pvp-online', 'couch-coop': 'coop-local', 'local-coop': 'coop-local', 'local-pvp': 'pvp-local', 'online-pvp': 'pvp-online', 'online-coop': 'coop-online' } as Record<string, Mode>)[s] ?? s; if ((MODES as readonly string[]).includes(id)) { if (!modes.includes(id as Mode)) modes.push(id as Mode); } else e(issues, 'players.modes', `Unknown mode "${m}".`, `Modes: ${MODES.join(', ')}.`); }
  if (!modes.length) e(issues, 'players.modes', 'modes must name at least one way to play.', `Modes: ${MODES.join(', ')}.`);
  if (modes.length === 1 && modes[0] === 'single' && max > 1) e(issues, 'players.max', 'A single-player-only game has max 1.', 'Add the multiplayer modes, or set max to 1.');
  if (!modes.includes('single') && min === 1 && max > 1 && modes.every((m) => m.endsWith('-local'))) w(issues, 'players.min', 'Only local multiplayer modes are listed but min is 1.', 'If one person can play alone, add "single".');
  return { min: Number.isInteger(min) ? min : 1, max: Number.isInteger(max) ? max : 1, modes };
}

export function parseContent(raw: unknown, issues: MetaIssue[]): Content | null {
  if (raw === undefined || raw === null) return null;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { e(issues, 'content', 'content must be an object of descriptors.', 'Example: {"violence": "cartoon", "language": "none", "fear": "none"}. Every descriptor you leave out means none.'); return null; }
  const r = raw as Record<string, unknown>, out: Record<string, unknown> = {};
  for (const k of Object.keys(r)) if (!(k in CONTENT_CHOICES)) e(issues, 'content', `Unknown descriptor "${k}".`, `Descriptors: ${Object.keys(CONTENT_CHOICES).join(', ')}.`);
  for (const [k, choices] of Object.entries(CONTENT_CHOICES) as [keyof Content, readonly (string | boolean)[]][]) {
    const v = r[k];
    if (v === undefined) { out[k] = choices[0]; continue; }
    const val = typeof choices[0] === 'boolean' ? (v === true || v === 'true' || v === 'yes') ? true : (v === false || v === 'false' || v === 'no' || v === 'none') ? false : v : String(v).toLowerCase();
    if (!choices.includes(val as string | boolean)) { e(issues, `content.${k}`, `${k} must be one of ${choices.join(', ')}.`); out[k] = choices[0]; } else out[k] = val;
  }
  return out as unknown as Content;
}

export function parseAccessibility(raw: unknown, issues: MetaIssue[]): Access[] | null {
  if (raw === undefined || raw === null) return null;
  const out: Access[] = [];
  for (const a of Array.isArray(raw) ? raw : [raw]) { const id = String(a).toLowerCase().replace(/[_\s]/g, '-').replace(/^colou?r-?blind.*/, 'colorblind-modes').replace(/^remap.*/, 'remappable-controls'); if ((ACCESSIBILITY as readonly string[]).includes(id)) { if (!out.includes(id as Access)) out.push(id as Access); } else if (id !== 'none') e(issues, 'accessibility', `Unknown accessibility feature "${a}".`, `Features: ${ACCESSIBILITY.join(', ')}. Use [] when there are none.`); }
  return out;
}

// what the code shows: platform services it uses
const RX = {
  room: /\b(?:GCP|G|gcp)\s*\.\s*room\s*\(|@gcp\/net\.js/,
  save: /\b(?:GCP|G|gcp)\s*\.\s*save\s*\.|\b(?:GCP|G|gcp)\s*\.\s*playerStats\s*\./,
  board: /\b(?:GCP|G|gcp)\s*\.\s*leaderboard\s*\./,
  local: /\blocalStorage\b|\bindexedDB\b/,
  fetch: /\bfetch\s*\(|\bWebSocket\s*\(/,
};

/** Builds the build layer of a version from gcp.json (already parsed) and the bundle's files. */
export function buildMeta(gcp: Record<string, unknown>, texts: Map<string, string> | Record<string, string>, paths: string[]): { record: MetaRecord; issues: MetaIssue[] } {
  const t = texts instanceof Map ? texts : new Map(Object.entries(texts));
  const issues: MetaIssue[] = [], ev: Record<string, string> = {};
  const find = (rx: RegExp, key: string, why: string) => { for (const [f, s] of t) if (rx.test(s)) { ev[key] = `${why} (${f})`; return true; } return false; };
  const multiplayer = find(RX.room, 'multiplayer', 'GCP.room'), saves = find(RX.save, 'cloud_saves', 'GCP.save or GCP.playerStats'), boards = find(RX.board, 'leaderboards', 'GCP.leaderboard');
  const network = find(RX.fetch, 'network', 'fetch or WebSocket');
  const detectedProgress: Progress = { cloud_saves: saves, leaderboards: boards, offline: !multiplayer && !network };
  const declared: MetaRecord['declared'] = [];

  const players = parsePlayers(gcp.players, issues);
  if (players) declared.push('players');
  if (players && multiplayer && players.modes.every((m) => m === 'single' || m.endsWith('-local'))) w(issues, 'players.modes', 'The game opens multiplayer rooms (GCP.room) but no online mode is declared.', 'Add coop-online or pvp-online.');
  if (players && !multiplayer && players.modes.some((m) => m.endsWith('-online'))) w(issues, 'players.modes', 'An online mode is declared but the game never opens a room (GCP.room).', 'Online play on this platform goes through GCP.room; check the mode list.');

  let session: number | null = null;
  if (gcp.session_minutes !== undefined && gcp.session_minutes !== null) {
    const n = Number(gcp.session_minutes);
    if (!Number.isFinite(n) || n < 1 || n > 600) e(issues, 'session_minutes', 'session_minutes is the length of a typical session in minutes, from 1 to 600.'); else { session = Math.round(n); declared.push('session_minutes'); }
  }

  let progress = detectedProgress;
  if (gcp.progress !== undefined && gcp.progress !== null) {
    const p = gcp.progress as Record<string, unknown>;
    if (!p || typeof p !== 'object') e(issues, 'progress', 'progress must be {cloud_saves, leaderboards, offline}.');
    else {
      for (const k of Object.keys(p)) if (!['cloud_saves', 'leaderboards', 'offline'].includes(k)) e(issues, 'progress', `Unknown field "${k}".`);
      progress = { cloud_saves: p.cloud_saves === undefined ? saves : !!p.cloud_saves, leaderboards: p.leaderboards === undefined ? boards : !!p.leaderboards, offline: p.offline === undefined ? detectedProgress.offline : !!p.offline };
      if (progress.cloud_saves && !saves) w(issues, 'progress.cloud_saves', 'Cloud saves are declared but the game never calls GCP.save.', 'Saves only follow the player across devices through GCP.save.');
      declared.push('progress');
    }
  }
  const accessibility = parseAccessibility(gcp.accessibility, issues);
  if (accessibility) declared.push('accessibility');
  const content = parseContent(gcp.content, issues);
  if (content) declared.push('content');
  if (content && multiplayer && !content.player_chat && find(/chat|sendMessage|\bmessage\b.*input/i, 'chat', 'chat-like code')) w(issues, 'content.player_chat', 'The game has multiplayer rooms and chat-like code, but player_chat is false.', 'Set player_chat: true if players can send each other text.');
  const langs = buildLanguages(gcp.languages, t, paths);
  issues.push(...langs.issues);
  if (langs.record.declared) declared.push('languages');
  const rating = content ? ageRating(content) : null;
  return { record: { v: 1, meta: { players, session_minutes: session, progress, accessibility, content }, declared, detected: { multiplayer, progress: detectedProgress, evidence: ev }, rating, languages: langs.record }, issues };
}

/** What a version still lacks before it can be published, as the store page needs it. */
export function missingForPublish(meta: MetaRecord | null | undefined, compatDeclared: boolean, tags: string[]): string[] {
  const miss: string[] = [];
  if (!genresOf(tags).primary) miss.push(`genre (update_project {genre}: one of ${GENRES.join(', ')})`);
  if (!compatDeclared) miss.push('requirements (what the game needs from the browser)');
  if (!meta?.declared.includes('languages')) miss.push('languages');
  if (!meta?.declared.includes('players')) miss.push('players ({min, max, modes})');
  if (!meta?.declared.includes('content')) miss.push('content (descriptors for the age rating; {} when the game has none of them)');
  return miss;
}

/** Session length as a bucket players understand. */
export const sessionBucket = (m: number) => (m < 5 ? '<5' : m <= 15 ? '5-15' : m <= 30 ? '15-30' : m <= 60 ? '30-60' : '60+');
