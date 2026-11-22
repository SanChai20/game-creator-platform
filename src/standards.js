// The platform's standards for everything a game or its agent provides: what the store shows about a game, what the
// platform draws over or around it while it plays, and what the platform does not take at all. The platform owns these
// standards; an outside agent only carries them out, so every place an agent meets them is fed from this one registry:
//
//   - get_started lists them and game_standards {action: "get"} returns one in full, when the agent is about to make it;
//   - checkStandards() is the validator: game_standards {action: "check"}, deploy_preview (as warnings) and publish
//     (listing findings) all report what it finds, each finding naming its standard and the exact fix;
//   - renderStandards() writes the guide (get_started {topic: "standards"} and web/public/guides/standards.md);
//   - tests/standards.mjs compares the numbers here with the code that draws each surface, so the two cannot drift.
//
// Plain JavaScript so the Worker, scripts and node tests share it. Covers have their own module (src/cover-spec.js).

import { COVER } from './cover-spec.js';

/** Numbers taken from the code that draws each surface. tests/standards.mjs reads that code and fails on a mismatch. */
export const NUMBERS = {
  listing: { title: 80, tagline: 140, description: 5000, controls: 1000 },          // web/src/languages.ts LISTING_LIMITS
  hero: { title_px: [40, 80], tagline_lines: 2, tagline_ch: 38, art_from: 0.40,          // web/src/store.css .hero*
    // measured in the live banner at 390 to 1920 px wide: what fits in two lines at the narrowest
    title_2_lines: 30, title_2_lines_cjk: 14, tagline_shown: 80, tagline_shown_cjk: 36 },
  page: { title_px: [42, 90], description_ch: 72 },                                   // web/src/store.css .gp-head, ui.css .prose
  card: { aspect: '16:10', title_px: 17 },                                            // web/src/store.css .game
  menu_button: { size: 40, inset: 8, corner: 'top-left', fade_after_s: 5, fade_to: 0.16, tip_plays: 3, tip_width: 440 },   // web/src/player.tsx, player.css
  touch: { edge: 18, stick_radius: 62, stick_zone_w: 0.42, stick_zone_h: 0.62, buttons_max: 6 },                            // web/public/sdk/gcp.js
  window: { max_w: 1056, max_h: 594 },                                               // web/src/play-window.ts
  friends_popup: { width: 360, top: 14, right: 14, seconds: 6 },                     // web/src/social.css, social.tsx
  verify: { width: 960, height: 540 },                                               // the verification browser
};

const N = NUMBERS;
const CJK = /[ᄀ-ᇿ⺀-鿿가-힯豈-﫿＀-￯]/g;
/** Mostly Chinese, Japanese or Korean characters. */
const isCjk = (s) => (String(s).match(CJK) || []).length > String(s).length / 2;
const norm = (x) => String(x || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

/**
 * The registry. Every entry: id, area ('store' | 'game' | 'not-offered'), title, where (where it appears), spec (the
 * exact rules), do / dont, enforced (what the platform checks, and when), checks (finding ids checkStandards can raise),
 * guide (the long form). Wording is for agents: say what to make, with numbers.
 */
export const STANDARDS = [
  // ---- the store ---------------------------------------------------------------------------------------------------
  {
    id: 'cover', area: 'store', title: 'Cover image',
    where: 'The home page banner, store cards (16:10), wide shelves (16:7), search, the library, Continue, friends\' lists and the game page. Each crops it differently.',
    spec: [
      `${COVER.width}x${COVER.height} (16:9), at least ${COVER.min_width}x${COVER.min_height}; png, jpg or webp under 2 MB. Set with update_project cover (and covers, one per language).`,
      `The title and the main subject stay inside the safe area: x ${COVER.safe.x0 * 100}% to ${COVER.safe.x1 * 100}%, y ${Math.round(COVER.safe.y0 * 100)}% to ${Math.round(COVER.safe.y1 * 100)}%.`,
      'The left 30% is hidden behind the home banner\'s info panel: background only there.',
    ],
    do: ['Design a cover; do not rely on the verification screenshot.', 'Check it on the template, cropped to the banner, 16:10 and 16:7, and at 240 px wide.'],
    dont: ['Close-up faces cut by the crops.', 'Text near any edge.'],
    enforced: 'update_project answers with cover_check (size and shape); game_standards check and publish warn when there is no cover (the store then crops the verification screenshot). The composition inside the safe area is yours to check by looking at the template.',
    checks: ['cover-missing'], guide: '/guides/game-metadata.md#cover-image', template: COVER.template,
  },
  {
    id: 'cover-languages', area: 'store', title: 'A cover per language',
    where: 'Every place the cover appears, in the player\'s platform language.',
    spec: ['A cover that shows words (the title) needs one cover per listing language with those words in it: update_project covers {zh, zh-TW, ja, ko, es}.', 'A language without its own cover shows the main cover.'],
    do: ['Keep the cover free of words if you will not make one per language.'], dont: ['Machine-translate the game\'s own name when the game keeps it in one language.'],
    enforced: 'publish refuses a version played in a platform language its listing lacks (rule listing_languages).',
    checks: [], guide: '/guides/game-metadata.md#the-store-listing-in-every-language',
  },
  {
    id: 'card-overlays', area: 'store', title: 'What the store draws over the cover',
    where: 'Store cards and shelves.',
    spec: [
      'Top left: a New, Featured or pick chip.',
      'Top right: a live pill with the number playing now.',
      'Bottom left: an 18+ tag naming what an adults-only game contains (the whole cover is blurred for those).',
      'Each sits about 10 px in from the card edge and is about 22 to 26 px tall on a card 220 to 350 px wide.',
    ],
    do: ['Keep the four corners of the 16:10 crop to background.'], dont: ['Put a logo, a price, a badge or a "NEW" label of your own on the cover: the store adds its own.'],
    enforced: 'Not checked. Look at the cover cropped to 16:10 with those corners covered.',
    checks: [], guide: '/guides/standards.md#card-overlays',
  },
  {
    id: 'title', area: 'store', title: 'Game title',
    where: `The home banner (${N.hero.title_px[0]} to ${N.hero.title_px[1]} px), the game page heading (${N.page.title_px[0]} to ${N.page.title_px[1]} px), cards (${N.card.title_px} px), search, the library, friends\' lists and invites.`,
    spec: [
      `At most ${N.listing.title} characters (per language).`,
      'The banner and the game page set it in the platform\'s condensed display face in CAPITALS, and break it anywhere when a word does not fit.',
      `About ${N.hero.title_2_lines} Latin characters or ${N.hero.title_2_lines_cjk} Chinese, Japanese or Korean characters fit on two banner lines; longer titles take three or more.`,
    ],
    do: ['Use the name the game shows on its title screen.', 'Put a subtitle in the tagline, not the title.'],
    dont: ['Rely on letter case (it is shown in capitals).', 'Add the platform\'s or the operator\'s name.', 'Add emoji or decorative symbols.'],
    enforced: 'Over the limit is refused. game_standards check notes a title too long for the banner.',
    checks: ['title-long'], guide: '/guides/standards.md#title',
  },
  {
    id: 'tagline', area: 'store', title: 'Tagline',
    where: `Under the title in the home banner (cut after ${N.hero.tagline_lines} lines), on cards and in search.`,
    spec: [
      `At most ${N.listing.tagline} characters, but only about ${N.hero.tagline_shown} Latin characters (or ${N.hero.tagline_shown_cjk} Chinese, Japanese or Korean) show in the banner on a phone before it is cut.`,
      'A tagline that only repeats the title is hidden everywhere.',
      'One sentence that says what the player does, in the listing\'s language.',
    ],
    do: ['Lead with the verb or the hook: "Guide a lantern through a drowned city."'],
    dont: ['Repeat the title.', 'Use the space for genre words the tags already show.', 'Use quotes, emoji or ALL CAPS.'],
    enforced: 'Over the limit is refused. game_standards check, deploy_preview and publish warn about a repeated title and a tagline cut in the banner.',
    checks: ['tagline-repeats-title', 'tagline-long', 'tagline-missing'], guide: '/guides/standards.md#tagline',
  },
  {
    id: 'description', area: 'store', title: 'Description',
    where: `The game page, in a column of about ${N.page.description_ch} characters.`,
    spec: [
      `At most ${N.listing.description} characters (per language).`,
      'Plain text: line breaks are kept and blank lines make paragraphs. Markdown is NOT rendered, so **bold**, # headings and [links](…) show as typed.',
      'A list is lines that start with "· " or "- ".',
    ],
    do: ['Open with what makes the game worth playing, then how a session goes, then modes and length.', 'Two to five short paragraphs.'],
    dont: ['Markdown, HTML or links.', 'Controls (they have their own field).', 'Prices, sales or other games.'],
    enforced: 'Over the limit is refused. game_standards check, deploy_preview and publish warn about Markdown.',
    checks: ['description-markdown', 'description-missing'], guide: '/guides/standards.md#description',
  },
  {
    id: 'controls-text', area: 'store', title: 'Controls text',
    where: 'The Controls box on the game page, beside the description.',
    spec: [`At most ${N.listing.controls} characters. Plain text like the description, one control per line: "WASD or arrows · move".`, 'Cover keyboard, mouse, touch and gamepad if the game supports them.'],
    do: ['Name keys by what is printed on them.'], dont: ['Markdown or tables.'],
    enforced: 'game_standards check warns about Markdown and notes a game with keys but no controls text.',
    checks: ['controls-markdown', 'controls-missing'], guide: '/guides/standards.md#controls-text',
  },
  {
    id: 'genre-tags', area: 'store', title: 'Genre and tags',
    where: 'Store filters, category and tag pages, search, "more like this".',
    spec: ['One genre from the fixed list, up to two secondary genres, and 2 to 8 tags from the platform list only.'],
    do: ['Pick the tags a player would filter by.'], dont: ['Invent tags; anything off the list is refused.'],
    enforced: 'publish refuses a version without genre and at least 2 tags.',
    checks: [], guide: '/guides/game-metadata.md#tags',
  },
  {
    id: 'screenshot', area: 'store', title: 'Screenshots',
    where: 'The game page shows the verification picture of the live version; it is the cover too when there is none.',
    spec: [
      `The platform takes it: after the checks it loads the game once more at ${N.verify.width}x${N.verify.height} with ?gcp_portrait=1 (GCP.portrait is true) and photographs the first view after loading.`,
      'There is no upload for screenshots. GCP.test.onAutostart decides what that first view is.',
    ],
    do: ['Draw at full quality when GCP.portrait is true, however slow the frame.', 'Make the first view after onAutostart a good-looking moment of play.'],
    dont: ['Make screenshot files for the store: nothing shows them.'],
    enforced: 'Taken by the platform at every verification.',
    checks: ['unused-store-files'], guide: '/guides/platform-contract.md#the-screenshot',
  },
  {
    id: 'badges', area: 'store', title: 'Store badges',
    where: 'The age rating badge, sale price, verdict, rarity, live count and 18+ label.',
    spec: ['All drawn by the platform from the metadata, sales and play data. There is nothing to make.'],
    do: ['Declare content descriptors honestly: the age badge comes from them.'], dont: ['Draw badges, ratings or prices into the cover or the game.'],
    enforced: 'Generated.', checks: [], guide: '/guides/game-metadata.md#content-descriptors-and-the-age-rating',
  },
  // ---- what the platform does not take ------------------------------------------------------------------------------
  {
    id: 'no-trailer', area: 'not-offered', title: 'Trailers and video',
    where: 'Nowhere: the store has no video slot.',
    spec: ['Do not make a trailer for the store. Video in the bundle counts against the game\'s storage.'],
    do: ['Spend the effort on the cover and the first view of play.'], dont: ['Ship trailer files in the bundle.'],
    enforced: 'game_standards check notes video files in the bundle.', checks: ['unused-store-files'], guide: '/guides/standards.md#no-trailer',
  },
  {
    id: 'no-icons', area: 'not-offered', title: 'Icons, logos and title art',
    where: 'Nowhere: there is no icon, favicon or logo slot. Where a store shows an icon, this one shows the cover, cropped to 16:10, as small as 64 px wide (search suggestions, "since you were away"). The title is set in text by the store; the Home Screen icon is the platform\'s.',
    spec: ['The cover is the game\'s icon: its main subject must still read at 64 px wide, so keep it large and simple inside the cover\'s safe area.', 'Put the game\'s logo or title art on the cover and the game\'s own title screen only.', 'Do not draw the platform\'s logo (HearthCade) anywhere: the platform shows its own splash.'],
    do: ['Keep title art inside the cover\'s safe area.'], dont: ['Ship icon sets, favicons or manifest icons for the store.'],
    enforced: 'game_standards check warns when the game draws the platform\'s name, and notes icon files.', checks: ['platform-logo', 'unused-store-files'], guide: '/guides/standards.md#no-icons',
  },
  {
    id: 'no-achievements', area: 'not-offered', title: 'Achievements',
    where: 'Nowhere: there is no achievements service or page.',
    spec: ['Track milestones with GCP.playerStats (players see them on the game page) and show them in the game\'s own interface.'],
    do: ['Name stats the way a player would read them.'], dont: ['Promise platform achievements in the description.'],
    enforced: 'game_standards check notes achievement code without player stats.', checks: ['achievements'], guide: '/guides/services.md#what-the-platform-does-not-provide',
  },
  // ---- while the game plays -----------------------------------------------------------------------------------------
  {
    id: 'splash-loading', area: 'game', title: 'Platform splash and the loading screen',
    where: 'Between Play and the first playable frame.',
    spec: [
      'The platform\'s splash covers the page first, then fades into the game\'s own loading screen: after the second GCP.progress() call once the page stops changing for 0.25 s, else 1.2 s, else at GCP.ready(), at the latest 6 s.',
      'Draw the loading screen at once, set its text, language and font before the second GCP.progress() call, then only move the bar.',
    ],
    do: ['Call GCP.progress(f, label) while loading and GCP.ready() after the first playable frame.'], dont: ['Draw a platform logo or a second splash.', 'Show a blank page, a stand-in font or text still being filled in.'],
    enforced: 'boots check (GCP.ready() in time). Verification counts the GCP.progress() calls before GCP.ready(); game_standards check and publish warn when there are fewer than two (the splash then waits 1.2 s and may hand over to a half-drawn screen).',
    checks: ['no-progress', 'progress-hand-off', 'platform-logo'], guide: '/guides/platform-contract.md#the-platform-splash-before-your-loading-screen',
  },
  {
    id: 'menu-button', area: 'game', title: 'The platform menu button',
    where: 'Over the game in fullscreen and on phones.',
    spec: [
      `A ${N.menu_button.size} px round button sits ${N.menu_button.inset} px in from the safe edge, in the ${N.menu_button.corner} corner unless the game asks for another.`,
      `It fades to ${Math.round(N.menu_button.fade_to * 100)}% after ${N.menu_button.fade_after_s} s; the player can drag it anywhere. A trial clock may sit beside it.`,
      `For the first ${N.menu_button.tip_plays} plays on a device a short tip (up to ${N.menu_button.tip_width} px wide) shows at top centre for 5 s; taps go through it.`,
      'Move it with GCP.setDisplay({ exitButton: \'top-right\' | \'bottom-left\' | \'bottom-right\' }), or hide it with exitButton: \'none\' when the game\'s own pause menu has a Quit button that calls GCP.quit() and Esc / Back reach that menu (GCP.pauseMenu).',
    ],
    do: [`Keep a ${N.menu_button.size + 2 * N.menu_button.inset} px square free in the chosen corner, inside the safe area.`, 'Choose the corner where your HUD has nothing.', 'When no corner is free, move the HUD that shares it aside by GCP.display.menuButton ({ corner, x, y, w, h } while the button shows, null otherwise), e.g. start a top-left row of buttons at menuButton.x + menuButton.w.'],
    dont: ['Put a pause, score or health widget under the button.', 'Hide it without a Quit of your own.'],
    enforced: 'Verification opens the game on a phone in fullscreen and reads the interface layer GCP.test.onCapture hands over (return [world, ui]): interface drawn in the button\'s square is reported, and game_standards check and publish warn about it. A game that hands over one canvas cannot be checked and is told so.', checks: ['menu-corner', 'zone-menu-button', 'zones-one-layer'], guide: '/guides/standards.md#menu-button',
  },
  {
    id: 'safe-area', area: 'game', title: 'Safe areas: notch, rounded corners, home bar',
    where: 'Fullscreen on phones and tablets.',
    spec: [
      'In fullscreen the game fills the whole screen edge to edge, under the notch, camera hole, rounded corners and home indicator.',
      'The insets are GCP.display.safe ({ top, right, bottom, left } in CSS px) and the CSS variables --gcp-safe-top, -right, -bottom, -left; GCP.ui.rect anchors inside them by default.',
      'Draw the world to the edges; keep buttons, text and HUD inside the insets. On a phone in landscape keep nothing important in the bottom 20 px.',
      'GCP.setDisplay({ edgeToEdge: false }) keeps the game inside them with black bars instead.',
    ],
    do: ['Use max(env(safe-area-inset-left, 0px), var(--gcp-safe-left, 0px)) in CSS, or GCP.ui.rect for canvas layouts.'], dont: ['Assume the frame is already inside the notch.'],
    enforced: 'Verification tells the game it is in fullscreen on an iPhone (insets 47 / 47 / 21 sideways, 47 / 0 / 34 upright) and reads its interface layer: interface drawn under the notch or the home bar is reported, and game_standards check and publish warn about it. game_standards check also warns when a game for phones never reads the insets in its code.',
    checks: ['safe-area', 'zone-safe-area'], guide: '/guides/input.md#phones-and-tablets', template: '/guides/safe-area-template.png',
  },
  {
    id: 'touch-controls', area: 'game', title: 'The platform\'s on-screen controls',
    where: 'Phones and tablets, for games without touch controls of their own.',
    spec: [
      `A stick zone in the bottom-left corner, ${N.touch.edge} px plus the safe inset from the edges, up to ${N.touch.stick_zone_w * 100}% of the width and ${N.touch.stick_zone_h * 100}% of the height.`,
      `Up to ${N.touch.buttons_max} round buttons in the bottom-right corner, the same distance from the edges.`,
      'They show only when the game has keys to press and no touch controls of its own, and hide while the game is paused. gcp.json "controls" or GCP.controls choose them; "touch": "none" turns them off.',
    ],
    do: ['Keep the bottom-left and bottom-right corners free of HUD when they show.', 'Better: make touch controls of your own and declare touch in requirements.input.'],
    dont: ['Show keyboard hints ("Space to jump") on touch screens.'],
    enforced: 'Not checked: look at the preview with debug_preview on a phone viewport.', checks: [], guide: '/guides/input.md#phones-and-tablets', template: '/guides/safe-area-template.png',
  },
  {
    id: 'window-orientation', area: 'game', title: 'Window size and orientation',
    where: 'The game page and the console preview; fullscreen on every device.',
    spec: [
      `In a window the game gets a 16:9 frame of at most ${N.window.max_w}x${N.window.max_h} CSS px (scaled down, never smaller, on a small page). Fullscreen gives it the whole screen at any shape.`,
      'Size from innerWidth and innerHeight on every resize, never from the first size.',
      'Declare orientation (requirements.orientation or GCP.setDisplay({ orientation })) for a game made for phones: the screen is locked to it where the browser allows, otherwise the player is asked to turn the phone.',
    ],
    do: ['Lay out for both shapes anyway: a resize can come at any time.'], dont: ['Hard-code 16:9 or the window size.'],
    enforced: 'game_standards check warns when a game for phones declares no orientation.', checks: ['orientation'], guide: '/guides/services.md#display-fullscreen-and-devices',
  },
  {
    id: 'interface-scale', area: 'game', title: 'Interface scale and the player\'s UI size',
    where: 'Every screen from a phone to a 4K monitor; the platform menu\'s Interface size row.',
    spec: ['GCP.ui.configure({ reference: [1280, 720] }) once, draw the interface in units at GCP.ui.scale, place boxes with GCP.ui.rect, and offer Interface size (GCP.ui.sizes, 80% to 150%).', 'Text at least about 11 CSS px, tap targets at least 44 CSS px.'],
    do: ['Redraw on GCP.ui.onChange.'], dont: ['Scale the interface with the window by hand in a way the player cannot change.'],
    enforced: 'device checks note text under 9 px and buttons under 20 px.', checks: [], guide: '/guides/services.md#interface-scale-and-the-players-ui-size',
  },
  {
    id: 'quality', area: 'game', title: 'Quality settings',
    where: 'The game\'s own settings; the platform has no quality setting.',
    spec: ['Offer low, medium and high, pick a default from the device (GCP.device), remember the choice with GCP.save or localStorage, and step down while the frame rate stays low.', 'The platform already caps devicePixelRatio at 2 on phones and tablets.'],
    do: ['Draw at full quality when GCP.portrait is true (the store screenshot).'], dont: ['Start phones on the highest setting.'],
    enforced: 'Not checked.', checks: [], guide: '/guides/performance.md#quality-levels',
  },
  {
    id: 'capture-hooks', area: 'game', title: 'Capture and state hooks',
    where: 'The creator\'s feedback screenshots and debug_preview.',
    spec: ['Draw everything in canvases (text fields aside) and register GCP.test.onCapture(() => canvas or [canvases]) and GCP.test.onState(() => where the game is).'],
    do: ['Return the canvases bottom to top.'], dont: ['Paint page elements over the game.'],
    enforced: 'The capture check fails a version without the hooks or with page elements over the game.', checks: [], guide: '/guides/platform-contract.md#hand-over-the-frame',
  },
  {
    id: 'bot-hook', area: 'game', title: 'Bot hook for online games',
    where: 'Test bots in the preview.',
    spec: ['Every online game ships server/bot.js: think/actions for matches, room() for GCP.room games, invite() for room games that invite friends. The platform does connecting, matchmaking and invites; the bot does the game\'s own moves.'],
    do: ['Test with preview_bots before publishing.'], dont: ['Leave a hook out for a mode the game has.'],
    enforced: 'deploy_preview and publish warn when an online game has no server/bot.js or misses a hook it needs.', checks: [], guide: '/guides/test-bots.md',
  },
  {
    id: 'friends-ui', area: 'game', title: 'Friends picker and pop-ups',
    where: 'Drawn by the platform over the game.',
    spec: [
      'GCP.friends.open({ match }) opens the platform\'s friends panel with the invite picker over the game; the game keeps running under it.',
      `Friend pop-ups (requests, invites, a friend joining) appear at the top right, up to ${N.friends_popup.width} px wide and ${N.friends_popup.top} px from the top (full width at the top on phones), for about ${N.friends_popup.seconds} s.`,
      'Players play together through invites: never ask them to type or share a room code.',
    ],
    do: ['Hold a lobby or menu state while the picker is open, and show who joined.', 'Keep nothing the player must read in the top-right corner for long.'],
    dont: ['Build your own friends list, chat or code entry.'],
    enforced: 'Not checked.', checks: [], guide: '/guides/services.md#friends-invites-and-presence',
  },
  {
    id: 'localization', area: 'game', title: 'Languages in the game',
    where: 'The game itself, and every listing surface.',
    spec: ['Read GCP.lang at start and open in it when the game has that language; GCP.onLang(fn) for a switch mid-game (the game is never restarted).', 'For every platform language the game declares, give the listing (title, tagline, description, controls) and a cover with words in that language.'],
    do: ['Use the names the game itself uses in each language.'], dont: ['Override a language the player picked in the game\'s own settings.'],
    enforced: 'publish refuses a version whose listing misses one of its languages; metadata warns when GCP.lang is never read.', checks: [], guide: '/guides/game-metadata.md#languages',
  },
];

export const AREAS = { store: 'The store', 'not-offered': 'What the platform does not take', game: 'While the game plays' };
export const standardById = (id) => STANDARDS.find((s) => s.id === id) || null;

/** One line per standard, for get_started and game_standards {action: "list"}. */
export const standardsIndex = () => STANDARDS.map((s) => `${s.id} (${AREAS[s.area]}): ${s.title}. ${s.spec[0]}`);

// ---- the validator ----------------------------------------------------------------------------------------------------

const MD = [
  [/\*\*[^*\n]+\*\*|__[^_\n]+__/, 'bold (** or __)'],
  [/^\s{0,3}#{1,6}\s+\S/m, 'a heading (#)'],
  [/\[[^\]\n]+\]\((?:https?:|\/|#)[^)\s]*\)/, 'a link ([text](url))'],
  [/`[^`\n]+`/, 'code (`…`)'],
  [/^\s*\|.*\|\s*$/m, 'a table (|)'],
  [/<\/?(?:b|i|p|br|a|strong|em|h[1-6]|ul|li|div|span)\b[^>]*>/i, 'HTML tags'],
];
const markdownIn = (s) => MD.filter(([re]) => re.test(String(s || ''))).map(([, name]) => name);
const VIDEO = /\.(mp4|webm|mov|m4v|ogv)$/i, ICONS = /(^|\/)(favicon|apple-touch-icon|icon-\d+|icons?|logo)[^/]*\.(png|ico|svg|jpg|webp)$|(^|\/)(manifest\.json|site\.webmanifest)$/i, SHOTS = /(^|\/)(screenshots?|store|promo|trailer)\//i;

/**
 * Checks a game against the standards. Every finding names its standard, says what was found and gives the exact fix.
 * levels: 'warning' (shown at deploy and publish; not blocking yet), 'note' (only in game_standards check).
 *
 * @param input {
 *   listing?: { title, tagline, description, controls, lang?, translations?: { [lang]: { title, tagline, description, controls } } },
 *   texts?: Map<path, text> | { [path]: text } (the workspace's text files; code checks are skipped without them),
 *   paths?: string[] (every workspace path), gcp?: gcp.json object, brand?: the platform's name,
 *   report?: a version's verification report (metrics.progressBeforeReady, zones) }
 */
export function checkStandards(input = {}) {
  const out = [];
  const add = (standard, level, message, fix, extra = {}) => out.push({ standard, level, message, fix, ...extra });
  const L = input.listing;
  if (L) {
    const langs = [[L.lang || 'listing', L], ...Object.entries(L.translations || {}).filter(([, v]) => v && typeof v === 'object')];
    for (const [lang, t] of langs) {
      const own = t === L, title = t.title || (own ? '' : L.title), where = own ? '' : ` (${lang})`;
      const tag = t.tagline ?? (own ? '' : undefined);
      if (title && String(title).length > (isCjk(title) ? N.hero.title_2_lines_cjk : N.hero.title_2_lines)) add('title', 'note', `The title${where} is ${String(title).length} characters; the home banner sets it in capitals and it takes three or more lines there (two lines hold about ${isCjk(title) ? N.hero.title_2_lines_cjk : N.hero.title_2_lines}).`, 'Keep the name short and move a subtitle into the tagline.', { lang, check: 'title-long' });
      if (tag !== undefined) {
        if (tag && title && norm(tag) === norm(title)) add('tagline', 'warning', `The tagline${where} repeats the title, so the store hides it everywhere.`, 'Write one sentence that says what the player does (game_metadata declare tagline / listing_translations).', { lang, check: 'tagline-repeats-title' });
        else if (tag && String(tag).length > (isCjk(tag) ? N.hero.tagline_shown_cjk : N.hero.tagline_shown)) add('tagline', 'warning', `The tagline${where} is ${String(tag).length} characters; the home banner cuts it after about ${isCjk(tag) ? N.hero.tagline_shown_cjk : N.hero.tagline_shown} on a phone.`, 'Shorten it to one sentence that fits two lines.', { lang, check: 'tagline-long' });
        else if (!tag && own) add('tagline', 'warning', 'The game has no tagline, so cards and the home banner show only its name.', 'Add one sentence that says what the player does.', { lang, check: 'tagline-missing' });
      }
      const md = markdownIn(t.description);
      if (md.length) add('description', 'warning', `The description${where} uses Markdown (${md.join(', ')}); the store shows it as typed.`, 'Rewrite it as plain text: paragraphs separated by blank lines, lists as lines starting with "· ".', { lang, check: 'description-markdown' });
      if (own && !String(t.description || '').trim()) add('description', 'note', 'The game has no description, so its page shows none.', 'Write two to five short plain-text paragraphs.', { lang, check: 'description-missing' });
      const mc = markdownIn(t.controls);
      if (mc.length) add('controls-text', 'warning', `The controls text${where} uses Markdown (${mc.join(', ')}); the store shows it as typed.`, 'One control per line in plain text: "WASD or arrows · move".', { lang, check: 'controls-markdown' });
    }
  }
  if (L && L.has_cover === false) add('cover', 'warning', 'The game has no cover, so the store crops the verification screenshot (a frame of play with its interface) into the home banner, cards and thumbnails.', `Design a ${COVER.width}x${COVER.height} cover on the template and set it with update_project cover.`, { check: 'cover-missing' });
  const R = input.report;
  if (R) {
    const pb = R.metrics && R.metrics.progressBeforeReady;
    if (typeof pb === 'number' && pb < 2) add('splash-loading', 'warning', `Verification saw ${pb} GCP.progress() call${pb === 1 ? '' : 's'} before GCP.ready(), so the platform splash waited 1.2 s and handed over to whatever was on screen.`, 'Draw the loading screen in its final look, then call GCP.progress(f, label) at least twice while loading.', { check: 'progress-hand-off' });
    const z = R.zones;
    if (z && z.checked) for (const x of z.zones) {
      const menu = x.zone === 'menu-button';
      add(menu ? 'menu-button' : 'safe-area', 'warning', `On a phone in fullscreen the interface covers ${Math.round(x.coverage * 100)}% of ${menu ? `the platform menu button's ${z.corner} square` : x.zone === 'home-bar' ? 'the home bar strip' : 'the notch strip'} (around x ${x.box[0]}, y ${x.box[1]}, ${x.box[2]}×${x.box[3]} px).`, menu ? `Move that part of the HUD out of the ${N.menu_button.size + 2 * N.menu_button.inset} px corner square, or put the button in a free corner with GCP.setDisplay({ exitButton }).` : 'Anchor the HUD inside GCP.display.safe (GCP.ui.rect does it by default).', { check: menu ? 'zone-menu-button' : 'zone-safe-area' });
    }
    if (z && !z.checked && z.reason === 'one-layer') add('menu-button', 'note', 'The reserved zones (notch, home bar, menu button corner) could not be checked: GCP.test.onCapture hands over a single canvas.', 'Return [world, ui] from GCP.test.onCapture, with the interface on its own canvas, so verification can check them.', { check: 'zones-one-layer' });
  }
  const texts = input.texts instanceof Map ? input.texts : new Map(Object.entries(input.texts || {}));
  if (texts.size) {
    const code = [...texts].filter(([p]) => /\.(m?js|html?)$/i.test(p) && !/(^|\/)(vendor|libs?|node_modules|three)[^/]*\//i.test(p) && !/\.min\.js$/i.test(p)).map(([, t]) => t).join('\n');
    const gcp = input.gcp || {}, req = gcp.requirements || {}, devices = Array.isArray(req.devices) ? req.devices : [];
    const phones = devices.includes('mobile') || devices.includes('tablet');
    const usesKeys = /\b(keydown|keyup)\b/.test(code);
    if (L && usesKeys && !String(L.controls || '').trim()) add('controls-text', 'note', 'The game reads the keyboard but its listing has no controls text.', 'Add the controls (game_metadata declare controls), one per line.', { check: 'controls-missing' });
    if (!/\bexitButton\b|\bmenuButton\b/.test(code)) add('menu-button', 'note', `The platform menu button (${N.menu_button.size} px) sits in the ${N.menu_button.corner} corner in fullscreen and on phones.`, `Keep that corner free, or move the button with GCP.setDisplay({ exitButton: 'top-right' }) to a corner your HUD leaves empty.`, { check: 'menu-corner' });
    if (phones && !/GCP\.display\.safe|display\.safe|--gcp-safe|ui\.rect\s*\(|ui\.safe|edgeToEdge\s*:\s*false|createUi\s*\(|createInput\s*\(/.test(code)) add('safe-area', 'warning', 'The game lists phones or tablets but never reads the safe-area insets; in fullscreen its HUD can sit under the notch or the home bar.', "Keep HUD and buttons inside GCP.display.safe (or --gcp-safe-* in CSS, or GCP.ui.rect), or call GCP.setDisplay({ edgeToEdge: false }).", { check: 'safe-area' });
    if (phones && !req.orientation && !/orientation\s*:\s*['"](landscape|portrait|any)/.test(code)) add('window-orientation', 'warning', 'The game lists phones or tablets but declares no orientation.', 'Declare requirements.orientation ("landscape", "portrait" or "any") with compatibility declare, or call GCP.setDisplay({ orientation }).', { check: 'orientation' });
    if (!/GCP\.progress\s*\(|\.progress\s*\(\s*[\d.]/.test(code)) add('splash-loading', 'note', 'The game never calls GCP.progress(), so the platform splash waits 1.2 s before handing over to the game.', 'Call GCP.progress(f, label) while loading (at least twice) and draw the loading screen in its final look before the second call.', { check: 'no-progress' });
    const brand = String(input.brand || 'HearthCade');
    // only what a player can see: page code without comments, not the server-side bot or tooling
    const shown = [...texts].filter(([p]) => /\.(m?js|html?)$/i.test(p) && !/(^|\/)(server|tools?|scripts?|tests?|vendor|libs?|node_modules|three)[^/]*\//i.test(p) && !/\.min\.js$/i.test(p))
      .map(([, t]) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '').replace(/(^|[^:\\'"`])\/\/.*$/gm, '$1')).join('\n');
    if (brand && new RegExp(`['"\`][^'"\`\\n]*\\b${brand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(shown)) add('no-icons', 'warning', `The game's code draws or names "${brand}", the platform's own name.`, 'Remove it: the platform shows its own splash, and a game must not present itself as made by the platform.', { check: 'platform-logo' });
    if (/achievement/i.test(code) && !/playerStats/.test(code)) add('no-achievements', 'note', 'The game has achievements but keeps them only on the device.', 'Keep them with GCP.playerStats so they follow the player and show on the game page.', { check: 'achievements' });
  }
  const paths = input.paths || [...texts.keys()];
  const unused = paths.filter((p) => VIDEO.test(p) || ICONS.test(p) || SHOTS.test(p));
  if (unused.length) add('no-icons', 'note', `The bundle has files the store never shows: ${unused.slice(0, 6).join(', ')}${unused.length > 6 ? ` and ${unused.length - 6} more` : ''}.`, 'Remove them unless the game itself uses them: they only use storage. The store takes a cover (update_project) and nothing else.', { check: 'unused-store-files', files: unused.slice(0, 20) });
  return out;
}

/** A finding as one line, for deploy warnings and publish answers. */
export const findingLine = (f) => `${f.level.toUpperCase()} [${f.standard}] ${f.message} Fix: ${f.fix}`;

// ---- the guide ----------------------------------------------------------------------------------------------------------

const anchor = (s) => s.toLowerCase().replace(/[^a-z0-9 -]/g, '').trim().replace(/\s+/g, '-');

/** The standards guide in Markdown. origin '' gives the file served at /guides/standards.md. */
export function renderStandards(origin = '') {
  const link = (p) => (p.startsWith('/') ? `${origin}${p}` : p);
  const out = [
    '# Game standards',
    '',
    '<!-- Generated from src/standards.js by scripts/standards-guide.mjs. Edit the registry, not this file. -->',
    '',
    'Everything a game or its agent provides, as the platform shows it: where each thing appears, its exact sizes and limits, what to do and not do, and what the platform checks. The platform sets these standards; the agent carries them out.',
    '',
    'Read the entry before you make the thing. `game_standards {action: "get", id}` returns one entry; `game_standards {project, action: "check"}` checks the game and its listing against all of them and lists each finding with the fix. `deploy_preview` and `publish` report the same findings.',
    '',
    `Templates: [cover](${link(COVER.template)}) · [safe area on a phone](${link('/guides/safe-area-template.png')})`,
    '',
    '| Standard | Where | Checked |',
    '|---|---|---|',
    ...STANDARDS.map((s) => `| [${s.title}](#${s.id}) | ${AREAS[s.area]} | ${s.checks.length ? 'game_standards check' : s.enforced.startsWith('Not checked') ? 'by looking' : 'platform'} |`),
  ];
  for (const area of Object.keys(AREAS)) {
    out.push('', `## ${AREAS[area]}`);
    for (const s of STANDARDS.filter((x) => x.area === area)) {
      out.push('', `<a id="${s.id}"></a>`, '', `### ${s.title}`, '', `**Where:** ${s.where}`, '', ...s.spec.map((x) => `- ${x}`));
      if (s.do.length) out.push('', `**Do:** ${s.do.join(' ')}`);
      if (s.dont.length) out.push('', `**Don't:** ${s.dont.join(' ')}`);
      out.push('', `**Checked:** ${s.enforced}`);
      if (s.template) out.push('', `![${s.title} template](${link(s.template)})`);
      out.push('', `More: [${s.guide.replace(/^\/guides\//, '')}](${link(s.guide)})`);
    }
  }
  return out.join('\n') + '\n';
}
export { anchor as standardAnchor };

// ---- the safe-area template -------------------------------------------------------------------------------------------

/**
 * A phone held sideways (844 x 390 CSS px, iPhone insets 47 / 47 / 21) with everything the platform puts over a game
 * drawn where it goes, from the numbers above. scripts/standards-guide.mjs --image renders it to a PNG.
 */
export function safeAreaSvg() {
  const W = 844, H = 390, side = 47, bottom = 21, ox = 48, oy = 56, mb = N.menu_button, t = N.touch;
  const s = Math.max(0.75, Math.min(1.35, Math.min(W, H) / 400)), R = Math.round(t.stick_radius * s);
  const zw = Math.round(Math.min(W * t.stick_zone_w, R * 3.4)), zh = Math.round(Math.min(H * t.stick_zone_h, R * 3.4));
  const stickX = side + t.edge, zoneY = H - bottom - t.edge - zh, btnX = W - side - t.edge - zw;
  const r = (x, y, w, h, fill, stroke, extra = '') => `<rect x="${ox + x}" y="${oy + y}" width="${w}" height="${h}" fill="${fill}" stroke="${stroke}" ${extra}/>`;
  const tx = (x, y, str, size = 13, color = '#1d1d1f', anchor = 'start', weight = 400) => `<text x="${ox + x}" y="${oy + y}" font-size="${size}" fill="${color}" text-anchor="${anchor}" font-weight="${weight}" font-family="system-ui, -apple-system, sans-serif">${str}</text>`;
  const tipW = mb.tip_width, popW = N.friends_popup.width;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 940 560" width="940" height="560">`,
    `<rect width="940" height="560" fill="#ffffff"/>`,
    tx(0, -26, 'Safe area template: a phone held sideways, 844 x 390 CSS px, as the platform shows a game in fullscreen', 15, '#1d1d1f', 'start', 600),
    `<rect x="${ox - 10}" y="${oy - 10}" width="${W + 20}" height="${H + 20}" rx="54" fill="#1d1d1f"/>`,
    `<clipPath id="screen"><rect x="${ox}" y="${oy}" width="${W}" height="${H}" rx="44"/></clipPath><g clip-path="url(#screen)">`,
    r(0, 0, W, H, '#dfe9f5', 'none'),
    // insets
    r(0, 0, side, H, '#f6d5d5', 'none'), r(W - side, 0, side, H, '#f6d5d5', 'none'), r(0, H - bottom, W, bottom, '#f6d5d5', 'none'),
    '</g>',
    `<rect x="${ox + 6}" y="${oy + H / 2 - 60}" width="26" height="120" rx="13" fill="#1d1d1f"/>`,
    r(side, 0, W - 2 * side, H - bottom, 'none', '#3a6ea5', 'stroke-dasharray="6 5" stroke-width="1.5"'),
    tx(W / 2, H - 6, `home bar: inset ${bottom} px; keep nothing important in the bottom 20 px`, 11, '#9b2c2c', 'middle'),
    `<text x="${ox + side / 2 + 4}" y="${oy + H / 2}" font-size="11" fill="#9b2c2c" text-anchor="middle" transform="rotate(-90 ${ox + side / 2 + 4} ${oy + H / 2})" font-family="system-ui, sans-serif">notch: inset ${side} px</text>`,
    // menu button
    r(side, 0, mb.size + 2 * mb.inset, mb.size + 2 * mb.inset, '#ffe8b3', '#b7791f', 'stroke-dasharray="4 3"'),
    `<circle cx="${ox + side + mb.inset + mb.size / 2}" cy="${oy + mb.inset + mb.size / 2}" r="${mb.size / 2}" fill="rgba(12,10,18,.55)" stroke="#fff"/>`,
    `<path d="M${ox + side + mb.inset + 11} ${oy + mb.inset + 14}h18M${ox + side + mb.inset + 11} ${oy + mb.inset + 20}h18M${ox + side + mb.inset + 11} ${oy + mb.inset + 26}h18" stroke="#fff" stroke-width="2.2" stroke-linecap="round"/>`,
    tx(side + mb.size + 2 * mb.inset + 8, 22, `platform menu button, ${mb.size} px, ${mb.inset} px in`, 11, '#7b4a00'),
    tx(side + mb.size + 2 * mb.inset + 8, 36, 'top left unless GCP.setDisplay({ exitButton })', 11, '#7b4a00'),
    // tip
    r(W - side - popW, N.friends_popup.top, popW, 46, 'rgba(56,161,105,.12)', '#2f855a', 'rx="10" stroke-dasharray="4 3"'),
    tx(W - side - popW / 2, N.friends_popup.top + 19, `friend pop-ups: top right, up to ${popW} px, about ${N.friends_popup.seconds} s`, 11, '#22543d', 'middle'),
    tx(W - side - popW / 2, N.friends_popup.top + 35, '(full width at the top on narrow screens)', 11, '#22543d', 'middle'),
    r((W - tipW) / 2, 76, tipW, 30, 'rgba(12,10,18,.12)', '#555', 'rx="12" stroke-dasharray="4 3"'),
    tx(W / 2, 95, `first-play tip: really at top centre, up to ${tipW} px, first ${mb.tip_plays} plays, 5 s`, 11, '#333', 'middle'),
    // touch controls
    r(stickX, zoneY, zw, zh, 'rgba(107,70,193,.10)', '#6b46c1', 'stroke-dasharray="4 3"'),
    `<circle cx="${ox + stickX + R + 6}" cy="${oy + zoneY + zh - R - 6}" r="${R}" fill="rgba(10,12,24,.18)" stroke="#6b46c1"/>`,
    tx(stickX + zw / 2, zoneY - 8, `on-screen stick zone, ${zw} x ${zh} px`, 11, '#44337a', 'middle'),
    r(btnX, zoneY, zw, zh, 'rgba(107,70,193,.10)', '#6b46c1', 'stroke-dasharray="4 3"'),
    `<circle cx="${ox + btnX + zw - 40}" cy="${oy + zoneY + zh - 40}" r="30" fill="rgba(10,12,24,.18)" stroke="#6b46c1"/><circle cx="${ox + btnX + zw - 110}" cy="${oy + zoneY + zh - 30}" r="26" fill="rgba(10,12,24,.18)" stroke="#6b46c1"/><circle cx="${ox + btnX + zw - 50}" cy="${oy + zoneY + zh - 110}" r="26" fill="rgba(10,12,24,.18)" stroke="#6b46c1"/>`,
    tx(btnX + zw / 2, zoneY - 8, `on-screen buttons, up to ${t.buttons_max}`, 11, '#44337a', 'middle'),
    tx(W / 2, H / 2 - 10, 'your game: draw the world to every edge', 14, '#1d3557', 'middle', 600),
    tx(W / 2, H / 2 + 10, 'HUD, text and buttons inside the dashed safe area', 12, '#1d3557', 'middle'),
    // legend
    tx(0, H + 44, 'Insets come from GCP.display.safe and --gcp-safe-*; GCP.ui.rect anchors inside them. They differ per device: read them, never hard-code these numbers.', 12, '#333'),
    tx(0, H + 64, `The on-screen controls show only for games without touch controls of their own; they sit ${t.edge} px plus the inset from the edges.`, 12, '#333'),
    tx(0, H + 84, 'Keep the menu button corner and, when the platform controls show, the bottom corners free of HUD. Standards: /guides/standards.md', 12, '#333'),
    `</svg>`,
  ].join('');
}
