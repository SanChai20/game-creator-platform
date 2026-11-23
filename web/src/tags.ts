// The platform's tag list: the only tags a game can carry, grouped so the store can filter by them. Genres
// (web/src/gamemeta.ts) come first in a game's tags; these describe it further. Shared by the Worker (validation,
// the MCP tools, the store API), the web app (names, filters) and tests/tags.mjs. No imports beyond gamemeta.
import { GENRES, missingForPublish, normGenre, type Genre, type MetaRecord } from './gamemeta.ts';

export const TAG_GROUPS = {
  theme: [
    'fantasy', 'sci-fi', 'space', 'cyberpunk', 'steampunk', 'post-apocalyptic', 'medieval', 'historical', 'mythology', 'military',
    'western', 'pirates', 'ninja', 'superheroes', 'zombies', 'monsters', 'dinosaurs', 'animals', 'robots', 'aliens', 'magic',
    'nature', 'ocean', 'farming', 'cooking', 'city', 'school', 'detective', 'mystery', 'dungeon', 'vehicles',
  ],
  mood: [
    'relaxing', 'cozy', 'cute', 'funny', 'wholesome', 'family-friendly', 'dark', 'atmospheric', 'spooky', 'emotional',
    'story-rich', 'fast-paced', 'challenging', 'competitive', 'satisfying',
  ],
  gameplay: [
    'physics', 'procedural', 'crafting', 'building', 'base-building', 'exploration', 'open-world', 'stealth', 'turn-based',
    'real-time', 'deck-building', 'match-3', 'hidden-object', 'endless', 'bullet-hell', 'hack-and-slash', 'twin-stick',
    'metroidvania', 'point-and-click', 'management', 'tycoon', 'trading', 'collecting', 'upgrades', 'loot', 'permadeath',
    'boss-fights', 'level-editor', 'choices-matter', 'character-customization', 'tactics', 'auto-battler', 'merge', 'logic',
    'minigames', 'typing', 'drawing', 'math', 'one-button', 'short-sessions',
  ],
  players: ['multiplayer', 'co-op', 'pvp', 'local-multiplayer', 'asynchronous'],
  style: [
    'pixel-art', 'low-poly', 'voxel', 'hand-drawn', 'cartoon', 'realistic', 'minimalist', 'retro', 'neon', '2d', '3d',
    'isometric', 'top-down', 'side-view', 'first-person', 'third-person',
  ],
} as const;
export type TagGroup = keyof typeof TAG_GROUPS;
export type Tag = typeof TAG_GROUPS[TagGroup][number];
export const TAGS: readonly Tag[] = Object.values(TAG_GROUPS).flat() as Tag[];
/** At most this many tags besides the genres. */
export const MAX_TAGS = 8;
/** Publishing needs at least this many. */
export const MIN_TAGS = 2;

/** Common ways agents and creators wrote tags before the list existed, and the tag each one means. */
const ALIAS: Record<string, Tag> = {
  'multi-player': 'multiplayer', online: 'multiplayer', 'online-multiplayer': 'multiplayer', mmo: 'multiplayer', coop: 'co-op', cooperative: 'co-op', 'co-operative': 'co-op',
  'online-co-op': 'co-op', versus: 'pvp', 'player-vs-player': 'pvp', 'pv-p': 'pvp', 'local-co-op': 'local-multiplayer', 'couch-co-op': 'local-multiplayer', 'split-screen': 'local-multiplayer',
  'hot-seat': 'local-multiplayer', hotseat: 'local-multiplayer', 'pass-and-play': 'local-multiplayer', async: 'asynchronous', 'play-by-mail': 'asynchronous', 'turn-based-multiplayer': 'asynchronous',
  scifi: 'sci-fi', 'science-fiction': 'sci-fi', 'sci fi': 'sci-fi', futuristic: 'sci-fi', 'outer-space': 'space', galaxy: 'space', planets: 'space', 'space-exploration': 'space',
  'post-apocalypse': 'post-apocalyptic', apocalypse: 'post-apocalyptic', knights: 'medieval', castle: 'medieval', history: 'historical', myths: 'mythology', gods: 'mythology',
  war: 'military', army: 'military', cowboys: 'western', 'wild-west': 'western', pirate: 'pirates', samurai: 'ninja', superhero: 'superheroes', zombie: 'zombies', undead: 'zombies',
  monster: 'monsters', dinosaur: 'dinosaurs', animal: 'animals', pets: 'animals', cats: 'animals', dogs: 'animals', robot: 'robots', mechs: 'robots', alien: 'aliens',
  wizard: 'magic', witch: 'magic', spells: 'magic', dragons: 'fantasy', 'high-fantasy': 'fantasy', forest: 'nature', garden: 'nature', underwater: 'ocean', sea: 'ocean', fishing: 'ocean',
  farm: 'farming', food: 'cooking', restaurant: 'cooking', urban: 'city', 'crime': 'detective', investigation: 'detective', dungeons: 'dungeon', 'dungeon-crawler': 'dungeon',
  cars: 'vehicles', trucks: 'vehicles', driving: 'vehicles', relax: 'relaxing', relaxed: 'relaxing', chill: 'relaxing', calm: 'relaxing', zen: 'relaxing', comfy: 'cozy',
  kawaii: 'cute', adorable: 'cute', comedy: 'funny', humor: 'funny', humour: 'funny', silly: 'funny', wholesome: 'wholesome', family: 'family-friendly', kids: 'family-friendly',
  'kid-friendly': 'family-friendly', grim: 'dark', gloomy: 'dark', moody: 'atmospheric', ambient: 'atmospheric', scary: 'spooky', creepy: 'spooky', halloween: 'spooky',
  story: 'story-rich', narrative: 'story-rich', 'story-driven': 'story-rich', fast: 'fast-paced', frantic: 'fast-paced', hard: 'challenging', difficult: 'challenging',
  'skill-based': 'challenging', 'high-score': 'competitive', 'score-attack': 'competitive', esports: 'competitive', 'physics-based': 'physics', ragdoll: 'physics',
  'procedural-generation': 'procedural', procgen: 'procedural', generated: 'procedural', random: 'procedural', craft: 'crafting', build: 'building', construction: 'building',
  'base-builder': 'base-building', colony: 'base-building', explore: 'exploration', 'open-world': 'open-world', openworld: 'open-world', sneaking: 'stealth', 'turn based': 'turn-based',
  'turn-based-strategy': 'turn-based', realtime: 'real-time', deckbuilder: 'deck-building', 'deck-builder': 'deck-building', deckbuilding: 'deck-building', match3: 'match-3',
  'match-three': 'match-3', 'hidden-objects': 'hidden-object', 'endless-runner': 'endless', runner: 'endless', infinite: 'endless', 'bullet hell': 'bullet-hell', danmaku: 'bullet-hell',
  'hack-n-slash': 'hack-and-slash', 'hack and slash': 'hack-and-slash', 'twin-stick-shooter': 'twin-stick', 'point and click': 'point-and-click', 'point-click': 'point-and-click',
  manager: 'management', 'resource-management': 'management', business: 'tycoon', economy: 'trading', merchant: 'trading', shop: 'trading', collect: 'collecting', collectibles: 'collecting',
  progression: 'upgrades', 'upgrade': 'upgrades', items: 'loot', 'loot-based': 'loot', 'perma-death': 'permadeath', bosses: 'boss-fights', 'boss-battles': 'boss-fights',
  'level-editor': 'level-editor', 'user-levels': 'level-editor', choices: 'choices-matter', 'multiple-endings': 'choices-matter', 'branching-story': 'choices-matter',
  customization: 'character-customization', 'character-creator': 'character-customization', tactical: 'tactics', autobattler: 'auto-battler', 'auto-chess': 'auto-battler',
  merging: 'merge', brain: 'logic', 'brain-teaser': 'logic', 'logic-puzzle': 'logic', minigame: 'minigames', 'mini-games': 'minigames', 'party-games': 'minigames',
  typing: 'typing', keyboard: 'typing', paint: 'drawing', painting: 'drawing', art: 'drawing', maths: 'math', numbers: 'math', 'one-tap': 'one-button', 'one-touch': 'one-button',
  'tap': 'one-button', quick: 'short-sessions', short: 'short-sessions', 'bite-sized': 'short-sessions', pixel: 'pixel-art', pixelart: 'pixel-art', '8-bit': 'pixel-art',
  '16-bit': 'pixel-art', lowpoly: 'low-poly', voxels: 'voxel', 'hand drawn': 'hand-drawn', handdrawn: 'hand-drawn', toon: 'cartoon', cel: 'cartoon', 'cel-shaded': 'cartoon',
  photorealistic: 'realistic', minimal: 'minimalist', simple: 'minimalist', 'retro-style': 'retro', 'old-school': 'retro', oldschool: 'retro', vintage: 'retro', synthwave: 'neon',
  vaporwave: 'neon', glow: 'neon', '2-d': '2d', '3-d': '3d', isometric: 'isometric', topdown: 'top-down', 'top down': 'top-down', overhead: 'top-down', 'side-scroller': 'side-view',
  sidescroller: 'side-view', 'side-scrolling': 'side-view', 'side scroller': 'side-view', 'first person': 'first-person', fp: 'first-person', 'third person': 'third-person',
};

const slug = (v: unknown) => String(v ?? '').toLowerCase().trim().replace(/[_]+/g, '-').replace(/[^\p{L}\p{N}\- ]/gu, '').replace(/\s+/g, ' ').slice(0, 40);
const isTag = (s: string): s is Tag => (TAGS as readonly string[]).includes(s);

/** The platform tag a word means, or null. Genres are not tags: see normGenre. */
export function normTag(v: unknown): Tag | null {
  const s = slug(v);
  if (!s) return null;
  if (isTag(s)) return s;
  if (ALIAS[s]) return ALIAS[s];
  const dashed = s.replace(/ /g, '-');
  if (isTag(dashed)) return dashed;
  if (ALIAS[dashed]) return ALIAS[dashed];
  if (dashed.endsWith('s') && isTag(dashed.slice(0, -1))) return dashed.slice(0, -1) as Tag;
  return null;
}

/** The group a tag (or genre) belongs to. */
export function tagGroup(tag: string): TagGroup | 'genre' | null {
  if ((GENRES as readonly string[]).includes(tag)) return 'genre';
  for (const [g, list] of Object.entries(TAG_GROUPS)) if ((list as readonly string[]).includes(tag)) return g as TagGroup;
  return null;
}

/** The closest platform tags to an unknown word, for the hint in a refusal. */
export function suggestTags(v: unknown, n = 3): string[] {
  const s = slug(v).replace(/ /g, '-');
  if (!s) return [];
  const dist = (a: string, b: string) => {
    const d = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) { let prev = d[0]; d[0] = i; for (let j = 1; j <= b.length; j++) { const t = d[j]; d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = t; } }
    return d[b.length];
  };
  const all = [...TAGS, ...GENRES] as string[];
  return all.map((x) => [x, x.includes(s) || s.includes(x) ? 0 : dist(s, x)] as [string, number]).filter(([, d]) => d <= Math.max(2, Math.floor(s.length / 3))).sort((a, b) => a[1] - b[1]).slice(0, n).map(([x]) => x);
}

export interface TagIssue { word: string; suggestions: string[] }
/**
 * Checks tags an agent chose. Genre ids are accepted and returned separately (they become secondary genres);
 * anything not on the platform list is refused with the closest matches.
 */
export function parseTags(raw: unknown): { tags: Tag[]; genres: Genre[]; unknown: TagIssue[]; read_as: TagReading[] } {
  const tags: Tag[] = [], genres: Genre[] = [], unknown: TagIssue[] = [], read_as: TagReading[] = [];
  for (const w of Array.isArray(raw) ? raw : raw == null || raw === '' ? [] : [raw]) {
    const g = (GENRES as readonly string[]).includes(slug(w).replace(/ /g, '-')) ? slug(w).replace(/ /g, '-') as Genre : null;
    const tag = g ? null : normTag(w), genre = g ?? (tag ? null : normGenre(w));
    const word = String(w).slice(0, 40);
    if (tag) { if (!tags.includes(tag)) tags.push(tag); if (tag !== word) read_as.push({ word, as: tag, kind: 'tag' }); }
    else if (genre) { if (!genres.includes(genre)) genres.push(genre); read_as.push({ word, as: genre, kind: 'genre' }); }
    else unknown.push({ word, suggestions: suggestTags(w) });
  }
  return { tags, genres, unknown, read_as };
}

/** A word that was not stored as written: an alias of a platform tag, or a genre (which goes with the genres, not the tags). */
export interface TagReading { word: string; as: string; kind: 'tag' | 'genre' }

/**
 * What an agent is told about the tags it sent: every word stored under another name, and every genre among them, so
 * nothing is changed without a word. Empty when every word was a platform tag as written.
 */
export function tagNotes(read: TagReading[], stored: string[]): string[] {
  return read.map((r) => r.kind === 'tag' ? `"${r.word}" was stored as the platform tag "${r.as}".`
    : stored.includes(r.as) ? `"${r.word}" is a genre, not a tag: it was stored as ${stored[0] === r.as ? 'the primary genre' : 'a secondary genre'} "${r.as}".`
      : `"${r.word}" is a genre, not a tag, and was not kept: a game has one primary and up to two secondary genres (genre and genres).`);
}

/**
 * A stored tag list as the store shows it: genres first as they were, then known tags, aliases mapped, anything
 * not on the list dropped. Used for games tagged before the list existed, and by scripts/normalize-tags.mjs.
 */
export function normalizeStoredTags(stored: unknown): string[] {
  const out: string[] = [];
  for (const w of Array.isArray(stored) ? stored : []) {
    const s = slug(w).replace(/ /g, '-');
    const v = (GENRES as readonly string[]).includes(s) ? s : normTag(w) ?? normGenre(w);
    if (v && !out.includes(v)) out.push(v);
  }
  // genres lead, in their stored order; tags follow
  const gs = out.filter((x) => tagGroup(x) === 'genre').slice(0, 3), ts = out.filter((x) => tagGroup(x) !== 'genre').slice(0, MAX_TAGS);
  return [...gs, ...ts];
}

/** Tags without the genres, as an agent sees them. */
export const tagsOnly = (tags: string[]) => tags.filter((t) => tagGroup(t) !== 'genre');

/** What publishing still needs from a game's tags, or null: at least MIN_TAGS from the list, and nothing off it. */
export function missingTags(stored: string[]): string | null {
  const known = tagsOnly(normalizeStoredTags(stored)), off = stored.filter((w) => tagGroup(String(w)) === null);
  if (off.length) return `tags (${off.map((w) => `"${w}"`).join(', ')} ${off.length === 1 ? 'is' : 'are'} not on the platform list: choose tags with game_metadata {tags})`;
  if (known.length < MIN_TAGS) return `tags (at least ${MIN_TAGS} from the platform list; ${known.length} so far)`;
  return null;
}

/** Everything publishing still needs: the metadata checklist's required fields, then the tags. */
export function missingToPublish(meta: MetaRecord | null | undefined, compatDeclared: boolean, tags: string[]): string[] {
  const t = missingTags(tags);
  return [...missingForPublish(meta, compatDeclared, tags), ...(t ? [t] : [])];
}
