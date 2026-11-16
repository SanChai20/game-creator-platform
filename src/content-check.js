// Content and conduct: the check that keeps harmful uploads off the marketplace when no person reviews them.
// It reads what the version is (its listing, its visible text, its screenshot, its code) and what it did in the
// verification browser (where it navigated, which windows and downloads it started, which other sites it talked to),
// and refuses:
//   - abuse of the player's browser: leaving for another site, opening windows by itself, downloads, dialog storms
//     (recorded by the browser check in report.conduct, refused there);
//   - known crypto-miner code, and background workers that talk to another server while the game runs;
//   - pages that ask for a password and send it to another site;
//   - hate, scams, phishing and content that is never allowed (sexual content involving minors, promotion of
//     self-harm), judged by a Workers AI decision model (Clef) from the listing, the page text and frames captured
//     while the verification browser played the game, with a small rule set when AI is not available;
//   - sexual content and violence the version does not declare. Adult games are allowed: a version that declares
//     nudity, explicit content or graphic violence in gcp.json "content" passes and is shown as 18+ with a warning.
//     The same review measures how sexual and how violent the game looks and refuses a version that shows more than
//     it declares (compareDeclared).
// Plain JavaScript, so the moderation harness and node tests run exactly this code.

/** Names that only crypto-miner code carries (libraries, pool protocols, algorithms). */
const MINER = /\b(?:coinhive|coin-hive|cryptonight|cryptoloot|crypto-loot|coinimp|webminepool|jsecoin|minero\.cc|deepminer|webminerpool|xmrig|monerominer|cryptonight_hash|stratum\+(?:tcp|ssl))\b/i;

const hostOf = (u) => { try { return new URL(u).host; } catch { return ''; } };

/** Forms that post a password to another site, found in the bundle's HTML and scripts. */
export function credentialForms(texts) {
  const out = [];
  for (const { path, text } of texts) {
    if (!/type\s*=\s*["']?password/i.test(text)) continue;
    for (const m of text.matchAll(/<form\b[^>]*\baction\s*=\s*["']?(https?:\/\/[^"'\s>]+)/gi)) out.push({ path, host: hostOf(m[1]) });
    // a password read by script and sent away with fetch, XHR or a beacon
    if (/\.value\b/.test(text) && /(?:fetch|sendBeacon|XMLHttpRequest)\s*\(\s*["'`]https?:\/\//.test(text)) out.push({ path, host: hostOf((text.match(/(?:fetch|sendBeacon)\s*\(\s*["'`](https?:\/\/[^"'`]+)/) || [])[1] || '') });
  }
  return out;
}

/** The deterministic part: returns the first reason to refuse, or null, plus notes worth a warning. */
export function conductRules({ texts = [], report = {} }) {
  const notes = [];
  for (const { path, text } of texts) {
    const m = MINER.exec(text);
    if (m) return { reason: `${path} contains crypto-miner code ("${m[0]}"). Games may not use the player's device to mine.`, notes };
  }
  const forms = credentialForms(texts);
  if (forms.length) return { reason: `${forms[0].path} asks for a password and sends it to ${forms[0].host || 'another site'}. Games may not collect passwords or sign-ins; players are already signed in through the platform.`, notes };
  const c = report.conduct || {};
  if (c.tokenSent) return { reason: `During verification the page sent the player's sign-in token to ${c.tokenSent}, a site outside the platform. Games may not pass on the player's identity.`, notes };
  const sockets = (c.external || []).filter((x) => x.type === 'websocket');
  if ((c.workers || 0) > 0 && sockets.length) return { reason: `It runs a background worker while connected to ${sockets[0].host}, a server outside the platform. That is how hidden miners work; multiplayer games use GCP.room, which runs on the platform.`, notes };
  const sends = (c.external || []).filter((x) => x.type !== 'websocket' && x.method && x.method !== 'GET');
  if (sends.length) notes.push(`Sends data to another site: ${[...new Set(sends.map((x) => x.host))].slice(0, 3).join(', ')}.`);
  if (sockets.length) notes.push(`Connects to another server: ${[...new Set(sockets.map((x) => x.host))].slice(0, 3).join(', ')}.`);
  return { reason: null, notes };
}

// Used when AI cannot answer: only unambiguous words, so no ordinary game is refused by them.
const SEXUAL = /\b(?:porn\w*|xxx|hentai|nsfw|onlyfans|nude(?:s)?|naked (?:girls|women|men|models)|sex (?:game|chat|cam)s?|camgirls?|strip ?tease)\b/i;
const GORE = /\b(?:gore|gory|dismember\w*|decapitat\w*|disembowel\w*|torture)\b/i;
// Never allowed, declared or not: sexual content that involves minors or characters presented as children.
const MINOR = /\b(?:loli|lolicon|shota|shotacon|underage|under-age|preteens?|jailbait|child porn\w*)/i;
const SCAM = /\b(?:send|deposit)\s+(?:any amount of |only )?(?:\d+(?:\.\d+)?\s*)?(?:btc|bitcoin|eth|ether|usdt|crypto)\b[^.]{0,80}\b(?:get|receive|back|double)\b|\bgiveaway\b[^.]{0,60}\b(?:btc|bitcoin|eth|crypto)\b|\b(?:double|triple) your (?:btc|bitcoin|eth|crypto|money)\b/i;

/** What a version declares about sexual content and violence, as indexes into the levels below. Missing means none. */
export const SEXUAL_LEVELS = ['none', 'suggestive', 'nudity', 'explicit'];
export const VIOLENCE_LEVELS = ['none', 'cartoon', 'fantasy', 'realistic', 'graphic'];
const SEXUAL_NAME = { suggestive: 'suggestive content', nudity: 'nudity', explicit: 'explicit sexual content' };
const VIOLENCE_NAME = { cartoon: 'cartoon violence', fantasy: 'fantasy violence', realistic: 'realistic violence', graphic: 'graphic violence or gore' };
const levelOf = (levels, v) => Math.max(0, levels.indexOf(String(v || 'none')));
/** The declaration as the check reads it: { sexual: 0..3, violence: 0..4, blood, adult } (null content = nothing declared). */
export function declaredLevels(content) {
  const c = content || {};
  return { sexual: levelOf(SEXUAL_LEVELS, c.sexual), violence: levelOf(VIOLENCE_LEVELS, c.violence), blood: !!c.blood, adult: !!c.adult_themes, declared: !!content };
}

/** The rule set used when AI cannot answer. Returns { block } for content never allowed, { undeclared } for content that needs a declaration, notes otherwise. */
export function contentRules(text, content = null) {
  const d = declaredLevels(content), notes = [];
  const s = SEXUAL.exec(text), m = MINOR.exec(text);
  if (m && (s || d.sexual >= 1)) return { category: 'dangerous', reason: `Its listing or page pairs sexual content with minors ("${m[0]}"). That is never allowed.` };
  if (s && d.sexual < 2) return { category: 'sexual', undeclared: true, reason: `Its listing or page describes sexual content ("${s[0]}"), but the version declares content.sexual "${SEXUAL_LEVELS[d.sexual]}".` };
  const c = SCAM.exec(text); if (c) return { category: 'scam', reason: `Its listing or page reads as a crypto scam ("${c[0].slice(0, 60)}").` };
  const g = GORE.exec(text);
  if (g && d.violence < 3) notes.push(`Its listing or page mentions "${g[0]}" while content.violence is "${VIOLENCE_LEVELS[d.violence]}". If players see it, declare realistic or graphic violence.`);
  return notes.length ? { notes } : null;
}

// Asked of @cf/cloudflare/clef with frames of the game in play attached. Three questions: content that is never
// allowed, and how sexual and how violent the game is, which is compared with what the version declares.
export const CONTENT_QUESTIONS = {
  verdict: {
    type: 'choice',
    instructions: 'You moderate a web-game marketplace with no human review. Adult games are allowed when they declare it, so sexual content and violence on their own are NOT reasons to pick anything but "fine" here; they are measured by the other questions. Judge the upload from its listing, the visible text of its page, what it did in a test browser and the pictures taken while it was played. Only flag clear cases.',
    criteria: {
      fine: 'Anything that is not clearly one of the other options, including violent, scary, sexual or edgy games.',
      hate: 'Attacks, dehumanises or calls for harm against people for their religion, ethnicity, nationality, race, gender, sexuality or disability; extremist propaganda.',
      scam: 'A scam or fraud: fake giveaways, send-money-get-more offers, fake prizes, investment or crypto schemes.',
      deceptive: 'Phishing or deception: asks for passwords or payment details, imitates a sign-in page or the platform, or tricks the player into downloads.',
      dangerous: 'Sexual or sexualised content involving minors or characters that look like children; content that promotes self-harm or suicide; real illegal drug or weapons trade; sexual content involving real, identifiable people.',
    },
  },
  sexual: {
    type: 'choice',
    instructions: 'The most sexual thing anywhere in the pictures, the visible text or the listing.',
    criteria: {
      none: 'Nothing sexual. Ordinary clothing, hugs, hand-holding, a kiss on the cheek.',
      suggestive: 'Suggestive: revealing outfits, sexual innuendo or jokes, kissing, characters drawn to look sexy, but no nudity.',
      nudity: 'Nudity: bare breasts, buttocks or genitals shown, in any art style, without sexual activity.',
      explicit: 'Explicit sexual activity, pornography, or sexual acts shown or described in detail.',
    },
  },
  violence: {
    type: 'choice',
    instructions: 'The most violent thing anywhere in the pictures, the visible text or the listing.',
    criteria: {
      none: 'No violence: puzzles, sports, building, racing without crashes into people.',
      cartoon: 'Cartoon violence: slapstick, characters bounce, flash or vanish when hit, no injury shown.',
      fantasy: 'Fantasy or stylised combat: fighting monsters, robots or abstract enemies, little or no blood.',
      realistic: 'Realistic violence against human-like characters: guns, fights or wounds that look real, some blood.',
      graphic: 'Graphic violence or gore: dismemberment, mutilation, torture, large amounts of blood and injury shown in detail.',
    },
  },
};
const LABEL = { hate: 'hateful content', scam: 'a scam', deceptive: 'deceptive or phishing content', dangerous: 'content that is never allowed (sexual content involving minors, promotion of self-harm, illegal trade)' };
const pct = (x) => `${Math.round(x * 100)}%`;
/** Probability mass of the levels strictly above `from` (with at least index `min`), and the most likely of them. */
function above(levels, probs, from, min = 0) {
  let p = 0, top = null;
  for (let i = Math.max(from + 1, min); i < levels.length; i++) { const v = probs[levels[i]] || 0; p += v; if (!top || v > (probs[top] || 0)) top = levels[i]; }
  return { p, top };
}

/**
 * Compares what the review saw with what the version declares. Undeclared nudity or explicit sexual content, and undeclared
 * realistic or graphic violence, refuse the version; smaller gaps (suggestive, cartoon or fantasy violence) are notes.
 */
export function compareDeclared(sexualProbs, violenceProbs, content, threshold = 0.5) {
  const d = declaredLevels(content), notes = [];
  if (sexualProbs) {
    const hard = above(SEXUAL_LEVELS, sexualProbs, d.sexual, 2);
    if (hard.p >= threshold) return { reason: `The review saw ${SEXUAL_NAME[hard.top]} (${pct(hard.p)} likely) while it was played, but the version declares content.sexual "${SEXUAL_LEVELS[d.sexual]}". Adult content is allowed only when it is declared.`, category: 'sexual', notes };
    const soft = above(SEXUAL_LEVELS, sexualProbs, d.sexual);
    if (soft.p >= threshold) notes.push(`The review saw ${SEXUAL_NAME[soft.top]} (${pct(soft.p)} likely), more than content.sexual "${SEXUAL_LEVELS[d.sexual]}" declares. Declare it so the age rating is right.`);
  }
  if (violenceProbs) {
    const hard = above(VIOLENCE_LEVELS, violenceProbs, d.violence, 3);
    if (hard.p >= threshold) return { reason: `The review saw ${VIOLENCE_NAME[hard.top]} (${pct(hard.p)} likely) while it was played, but the version declares content.violence "${VIOLENCE_LEVELS[d.violence]}". Violent games are allowed only when the violence is declared.`, category: 'violence', notes };
    const soft = above(VIOLENCE_LEVELS, violenceProbs, d.violence);
    if (soft.p >= threshold) notes.push(`The review saw ${VIOLENCE_NAME[soft.top]} (${pct(soft.p)} likely), more than content.violence "${VIOLENCE_LEVELS[d.violence]}" declares. Declare it so the age rating is right.`);
  }
  return { reason: null, category: null, notes };
}

/** The state the content judge sees (never code, never the declaration: the review judges what is there). */
export function contentState({ listing, text, report }) {
  const c = (report && report.conduct) || {};
  return {
    listing,
    visible_text: String(text || '').slice(0, 1500),
    in_the_test_browser: { other_sites_contacted: [...new Set((c.external || []).map((x) => x.host))].slice(0, 6), windows_opened: (c.popups || []).length, downloads: (c.downloads || []).length, password_fields: c.passwordFields || 0 },
    pictures: 'Frames captured while the game was started, played through and given input in the test browser, in order.',
  };
}

/** Clef takes at most this many images in one request (more is refused with "exceeds the image count limit"). */
export const MAX_IMAGES = 4;
/** Up to n items spread evenly over the list, first and last included, in order. */
export function spread(list, n) {
  if (list.length <= n) return list.slice();
  return Array.from({ length: n }, (_, i) => list[Math.round(i * (list.length - 1) / (n - 1))]);
}

const toB64 = (u8) => (typeof Buffer !== 'undefined' ? Buffer.from(u8).toString('base64') : (() => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000)); return btoa(s); })());
const dataUrl = (u8) => `data:${u8[0] === 0xff && u8[1] === 0xd8 ? 'image/jpeg' : 'image/png'};base64,${toB64(u8)}`;

/**
 * The whole check. `ai(model, state, questions, extra)` answers like aiDecide (null when AI is off or fails).
 * `content` is the version's declared content descriptors (gcp.json "content"); `frames` are pictures taken while the
 * verification browser played the game (the screenshot `shot` is used when there are none).
 * Returns { ok, reason, category, undeclared, notes, ai: { choice, probabilities, sexual, violence } | null, by: 'rules' | 'ai' }.
 * @param {{ listing: any, html?: string, pageText?: string, texts?: { path: string, text: string }[], report?: any, shot?: Uint8Array | null, frames?: Uint8Array[], content?: any, ai?: ((model: string, state: unknown, questions: any, extra: any) => Promise<any>) | null, threshold?: number, matureAllowed?: boolean }} args
 */
export async function contentCheck({ listing, html = '', pageText = '', texts = [], report = {}, shot = null, frames = [], content = null, ai = null, threshold = 0.5, matureAllowed = true }) {
  const conduct = conductRules({ texts, report });
  if (conduct.reason) return { ok: false, category: 'conduct', reason: conduct.reason, notes: conduct.notes, ai: null, by: 'rules' };
  const notes = [...conduct.notes];
  // a declared adult game on a platform that does not take them
  const d = declaredLevels(content);
  if (!matureAllowed && (d.sexual >= 2 || d.violence >= 4 || (d.violence === 3 && d.blood) || d.adult)) return { ok: false, category: 'mature', reason: 'It declares adult (18+) content, and this platform does not take adult games right now.', notes, ai: null, by: 'rules' };
  const text = [pageText || '', html ? String(html).replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ') : ''].join(' ').replace(/\s+/g, ' ').trim();
  const listingText = [listing?.title, listing?.tagline, listing?.description, ...(listing?.tags || [])].filter(Boolean).join(' · ');
  // never allowed, whatever the review says
  const r = contentRules(listingText + ' · ' + text, content);
  if (r && r.category === 'dangerous') return { ok: false, category: r.category, reason: r.reason, notes, ai: null, by: 'rules' };
  let judged = null;
  if (ai) {
    const pics = spread(frames && frames.length ? frames : shot ? [shot] : [], MAX_IMAGES);
    const extra = pics.length ? { images: pics.map(dataUrl) } : {};
    const out = await ai('clef', contentState({ listing, text, report }), CONTENT_QUESTIONS, extra);
    const a = out?.verdict, sx = out?.sexual, vi = out?.violence;
    if (a && a.type === 'choice') {
      const probs = a.probabilities || {}, bad = Object.entries(probs).filter(([k]) => k !== 'fine').sort((x, y) => y[1] - x[1])[0];
      judged = { choice: a.choice, probabilities: probs, sexual: sx?.probabilities || null, violence: vi?.probabilities || null, frames: pics.length };
      if (bad && bad[1] >= threshold) return { ok: false, category: bad[0], reason: `Reviewed as ${LABEL[bad[0]] || bad[0]} (${pct(bad[1])} likely). That is not allowed on this platform, declared or not.`, notes, ai: judged, by: 'ai' };
      const cmp = compareDeclared(sx?.probabilities || null, vi?.probabilities || null, content, threshold);
      notes.push(...cmp.notes);
      if (cmp.reason) return { ok: false, category: cmp.category, undeclared: true, reason: cmp.reason, notes, ai: judged, by: 'ai' };
      return { ok: true, category: null, reason: '', notes, ai: judged, by: 'ai' };
    }
  }
  if (r && r.reason) return { ok: false, category: r.category, undeclared: !!r.undeclared, reason: r.reason, notes, ai: judged, by: 'rules' };
  if (r && r.notes) notes.push(...r.notes);
  return { ok: true, category: null, reason: '', notes, ai: judged, by: judged ? 'ai' : 'rules' };
}
