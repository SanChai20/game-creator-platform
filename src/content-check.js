// Content and conduct: the check that keeps harmful uploads off the marketplace when no person reviews them.
// It reads what the version is (its listing, its visible text, its screenshot, its code) and what it did in the
// verification browser (where it navigated, which windows and downloads it started, which other sites it talked to),
// and refuses:
//   - abuse of the player's browser: leaving for another site, opening windows by itself, downloads, dialog storms
//     (recorded by the browser check in report.conduct, refused there);
//   - known crypto-miner code, and background workers that talk to another server while the game runs;
//   - pages that ask for a password and send it to another site;
//   - sexual content, hate, scams and other harmful content, judged by a Workers AI decision model (Clef) from the
//     listing, the page text and the screenshot, with a small rule set when AI is not available.
// Game violence, horror, fantasy combat and dark themes are fine: the model is told so, and the corpus checks it.
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
const SEXUAL = /\b(?:porn\w*|xxx|hentai|nsfw|onlyfans|nude(?:s)?|naked (?:girls|women|models)|sex (?:game|chat|cam)s?|camgirls?|strip ?tease)\b/i;
const SCAM = /\b(?:send|deposit)\s+(?:any amount of |only )?(?:\d+(?:\.\d+)?\s*)?(?:btc|bitcoin|eth|ether|usdt|crypto)\b[^.]{0,80}\b(?:get|receive|back|double)\b|\bgiveaway\b[^.]{0,60}\b(?:btc|bitcoin|eth|crypto)\b|\b(?:double|triple) your (?:btc|bitcoin|eth|crypto|money)\b/i;
export function contentRules(text) {
  const s = SEXUAL.exec(text); if (s) return { category: 'sexual', reason: `Its listing or page describes sexual content ("${s[0]}").` };
  const c = SCAM.exec(text); if (c) return { category: 'scam', reason: `Its listing or page reads as a crypto scam ("${c[0].slice(0, 60)}").` };
  return null;
}

// Asked of @cf/cloudflare/clef with the screenshot attached. Its answer can block a publish.
export const CONTENT_QUESTIONS = {
  verdict: {
    type: 'choice',
    instructions: 'You moderate a public web-game marketplace open to all ages, with no human review. Judge the new upload from its listing, the visible text of its page, what it did in a test browser and its screenshot. Video-game violence (fighting, shooting, zombies, monsters, cartoon blood), horror, war, crime stories, dark or sad themes, mild romance and swearing are all fine. Only flag clear cases.',
    criteria: {
      fine: 'An ordinary game, including violent, scary or edgy games. Anything that is not clearly one of the other options.',
      sexual: 'Pornography, nudity or sexual content.',
      hate: 'Attacks, dehumanises or calls for harm against people for their religion, ethnicity, nationality, race, gender, sexuality or disability; extremist propaganda.',
      scam: 'A scam or fraud: fake giveaways, send-money-get-more offers, fake prizes, investment or crypto schemes.',
      deceptive: 'Phishing or deception: asks for passwords or payment details, imitates a sign-in page or the platform, or tricks the player into downloads.',
      dangerous: 'Promotes self-harm, suicide, illegal drugs or weapons trade, or sexual content involving minors.',
    },
  },
};
const LABEL = { sexual: 'sexual content', hate: 'hateful content', scam: 'a scam', deceptive: 'deceptive or phishing content', dangerous: 'dangerous content' };

/** The state the content judge sees (never code). */
export function contentState({ listing, text, report }) {
  const c = (report && report.conduct) || {};
  return {
    listing,
    visible_text: String(text || '').slice(0, 1500),
    in_the_test_browser: { other_sites_contacted: [...new Set((c.external || []).map((x) => x.host))].slice(0, 6), windows_opened: (c.popups || []).length, downloads: (c.downloads || []).length, password_fields: c.passwordFields || 0 },
  };
}

/**
 * The whole check. `ai(model, state, questions, extra)` answers like aiDecide (null when AI is off or fails).
 * Returns { ok, reason, category, notes, ai: { choice, probabilities } | null, by: 'rules' | 'ai' }.
 * @param {{ listing: any, html?: string, pageText?: string, texts?: { path: string, text: string }[], report?: any, shot?: Uint8Array | null, ai?: ((model: string, state: unknown, questions: any, extra: any) => Promise<any>) | null, threshold?: number }} args
 */
export async function contentCheck({ listing, html = '', pageText = '', texts = [], report = {}, shot = null, ai = null, threshold = 0.5 }) {
  const conduct = conductRules({ texts, report });
  if (conduct.reason) return { ok: false, category: 'conduct', reason: conduct.reason, notes: conduct.notes, ai: null, by: 'rules' };
  const text = [pageText || '', html ? String(html).replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ') : ''].join(' ').replace(/\s+/g, ' ').trim();
  const listingText = [listing?.title, listing?.tagline, listing?.description, ...(listing?.tags || [])].filter(Boolean).join(' · ');
  let judged = null;
  if (ai) {
    const extra = shot ? { images: ['data:image/png;base64,' + (typeof Buffer !== 'undefined' ? Buffer.from(shot).toString('base64') : btoa(String.fromCharCode(...shot)))] } : {};
    const a = (await ai('clef', contentState({ listing, text, report }), CONTENT_QUESTIONS, extra))?.verdict;
    if (a && a.type === 'choice') {
      const probs = a.probabilities || {}, bad = Object.entries(probs).filter(([k]) => k !== 'fine').sort((x, y) => y[1] - x[1])[0];
      judged = { choice: a.choice, probabilities: probs };
      if (bad && bad[1] >= threshold) return { ok: false, category: bad[0], reason: `Reviewed as ${LABEL[bad[0]] || bad[0]} (${Math.round(bad[1] * 100)}% likely). This marketplace is open to all ages and allows no ${LABEL[bad[0]] || bad[0]}.`, notes: conduct.notes, ai: judged, by: 'ai' };
      return { ok: true, category: null, reason: '', notes: conduct.notes, ai: judged, by: 'ai' };
    }
  }
  const r = contentRules(listingText + ' · ' + text);
  if (r) return { ok: false, category: r.category, reason: r.reason, notes: conduct.notes, ai: judged, by: 'rules' };
  return { ok: true, category: null, reason: '', notes: conduct.notes, ai: judged, by: judged ? 'ai' : 'rules' };
}
