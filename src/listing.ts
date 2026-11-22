// A game's store listing in the platform's languages, as every surface sends it to the web app.
//
// The project row holds the game's own listing (title, tagline, description, controls, cover) in the language it was
// written in (listing_lang, or worked out from the text), and listing_i18n holds it in other platform languages, each
// with an optional cover of its own. Only the languages the live version is played in are sent (projects.langs), and
// the web app picks one for the viewer with pickListing (web/src/languages.ts): theirs, else English, else the game's own.
import { baseListingLang, missingListings, offeredListings, platformLangsOf, type LanguagesRecord } from '../web/src/languages';
import type { Lang } from '../web/src/i18n/langs';
import { parseJson } from './util';

export type StoredListing = { title?: string; tagline?: string; description?: string; controls?: string; cover_key?: string };
export type ListingField = 'title' | 'tagline' | 'description' | 'controls';
type Row = { listing_i18n?: string | null; listing_lang?: string | null; langs?: string | null; title?: string | null; tagline?: string | null; description?: string | null };

/** The platform languages the live version is played in, as recorded on the project ([] when not known). */
export const projectLangs = (r: { langs?: string | null }): Lang[] => String(r.langs || '').split(',').filter(Boolean) as Lang[];

/** lang (what the game's own listing is in) and i18n (its other languages the game is played in, with covers). */
export function listingLangs(r: Row, fields: ListingField[], media: (key: string) => string | null): { lang: string; i18n?: Record<string, Record<string, string | null | undefined>> } {
  const lang = baseListingLang(r), all = parseJson<Record<string, StoredListing>>(r.listing_i18n || '{}', {});
  const offered = offeredListings(lang, Object.keys(all), projectLangs(r)).filter((k) => all[k]);
  if (!offered.length) return { lang };
  return { lang, i18n: Object.fromEntries(offered.map((k) => [k, { ...Object.fromEntries(fields.map((f) => [f, all[k][f]])), ...(all[k].cover_key ? { cover: media(all[k].cover_key!) } : {}) }])) };
}

/** Just the names, for places that show a game by name only (friends, invites, chat): {lang, i18n: {zh: {title}}}. */
export const listingTitles = (r: Row) => listingLangs(r, ['title'], () => null);

/** What a release's store listing still lacks: every platform language the version is declared to be played in needs
 *  the listing (title, and a tagline and description when the game's own listing has them) in that language. */
export function listingCoverage(p: Row, languages: LanguagesRecord | null | undefined): { lang: string; supported: Lang[]; missing: { lang: Lang; fields: string[] }[] } {
  const lang = baseListingLang(p), supported = languages?.declared ? platformLangsOf(languages.languages) : [];
  const tr = parseJson<Record<string, StoredListing>>(p.listing_i18n || '{}', {});
  return { lang, supported, missing: missingListings({ lang, title: p.title || '', tagline: p.tagline || '', description: p.description || '' }, tr, supported) };
}
export const LANG_NAMES_EN: Record<Lang, string> = { en: 'English', zh: 'Simplified Chinese', 'zh-TW': 'Traditional Chinese', ja: 'Japanese', ko: 'Korean', es: 'Spanish' };
