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
import { SPLIT } from './platform-requirements.js';

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
 * guide (the long form), and required: the part that is a platform requirement (publish refuses without it), only on
 * the few entries that have one. Everything else in an entry is a design recommendation. Wording is for agents: say what to make, with numbers.
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
    required: `The listing text (the title, and the tagline and description where the listing has them) in every platform language the game declares (release rule listing_languages). A cover per language is a recommendation.`,
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
    required: `At most ${N.listing.title} characters per language: a longer title is refused.`,
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
    required: `At most ${N.listing.tagline} characters per language: a longer tagline is refused.`,
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
    required: `At most ${N.listing.description} characters per language: a longer description is refused.`,
    enforced: 'Over the limit is refused. game_standards check, deploy_preview and publish warn about Markdown.',
    checks: ['description-markdown', 'description-missing'], guide: '/guides/standards.md#description',
  },
  {
    id: 'controls-text', area: 'store', title: 'Controls text',
    where: 'The Controls box on the game page, beside the description.',
    spec: [`At most ${N.listing.controls} characters. Plain text like the description, one control per line: "WASD or arrows · move".`, 'Cover keyboard, mouse, touch and gamepad if the game supports them.'],
    do: ['Name keys by what is printed on them.'], dont: ['Markdown or tables.'],
    required: `At most ${N.listing.controls} characters per language: longer controls text is refused.`,
    enforced: 'game_standards check warns about Markdown and notes a game with keys but no controls text.',
    checks: ['controls-markdown', 'controls-missing'], guide: '/guides/standards.md#controls-text',
  },
  {
    id: 'genre-tags', area: 'store', title: 'Genre and tags',
    where: 'Store filters, category and tag pages, search, "more like this".',
    spec: ['One genre from the fixed list, up to two secondary genres, and 2 to 8 tags from the platform list only.'],
    do: ['Pick the tags a player would filter by.'], dont: ['Invent tags; anything off the list is refused.'],
    required: `One genre and 2 to 8 tags from the platform lists (release rule metadata).`,
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
    id: 'achievements', area: 'game', title: 'Achievements',
    where: 'The game page (an Achievements card with how rare each one is), the player\'s library (unlocked of total per game) and a short corner notice inside the game when one unlocks.',
    spec: ['Declare them in gcp.json "achievements" ({ id, name, description?, hidden?, stat?, goal? }, at most 100) and unlock them with GCP.achievements.unlock(id), or give a stat and a goal so the platform unlocks it when GCP.playerStats reaches the goal.', 'Names up to 60 characters and descriptions up to 160, in every language the game is listed in (a string, or one string per platform language).', 'The corner notice sits at the bottom right for about 4 seconds; set GCP.achievements.toast = false when the game shows its own.'],
    do: ['Keep ids stable across versions.', 'Name achievements the way a player would read them.'], dont: ['Keep achievements only on the device, where they are lost on another browser.', 'Promise achievements in the description that the game does not declare.'],
    enforced: 'deploy_preview refuses an invalid list; game_standards check notes achievement code with none declared.', checks: ['achievements'], guide: '/guides/services.md#achievements',
  },
  // ---- while the game plays -----------------------------------------------------------------------------------------
  {
    id: 'splash-loading', area: 'game', title: 'Platform splash and the loading screen',
    where: 'Between Play and the first playable frame.',
    spec: [
      'The platform\'s splash covers the page first, then fades into the game\'s own loading screen: after the second GCP.progress() call once the page stops changing for 0.25 s, else at GCP.ready(), at the latest 6 s (12 s for a game that has not called GCP.progress() twice).',
      'A title picture (key art, title image) is loaded before GCP.ready(); while it downloads the game draws its loading screen or a plain backdrop.',
      'Draw the loading screen at once, set its text, language and font before the second GCP.progress() call, then only move the bar.',
    ],
    do: ['Call GCP.progress(f, label) while loading and GCP.ready() after the first playable frame.'], dont: ['Draw a platform logo or a second splash.', 'Show a blank page, a stand-in font or text still being filled in.', 'Draw a code-drawn or older title while a new title picture downloads: players see the old cover, then the new one, on every launch. Remove the old drawing when you replace the picture, and give the new file a new name.'],
    required: `GCP.ready() once the first playable frame is drawn, within the time verification allows (the boots check). How the loading screen looks and how often it calls GCP.progress() are recommendations.`,
    enforced: 'boots check (GCP.ready() in time). Verification counts the GCP.progress() calls before GCP.ready(); game_standards check and publish warn when there are fewer than two (the splash then waits for GCP.ready(), up to 12 s). game_standards check warns when the title screen draws a code-drawn stand-in while its title picture loads.',
    checks: ['no-progress', 'progress-hand-off', 'title-stand-in', 'platform-logo'], guide: '/guides/platform-contract.md#the-platform-splash-before-your-loading-screen',
  },
  {
    id: 'menu-button', area: 'game', title: 'The platform menu button',
    where: 'Over the game whenever it plays: in its window on the page and in fullscreen, in the browser and the installed app.',
    spec: [
      `A ${N.menu_button.size} px round button sits ${N.menu_button.inset} px in from the safe edge, in the ${N.menu_button.corner} corner unless the game asks for another.`,
      `It fades to ${Math.round(N.menu_button.fade_to * 100)}% after ${N.menu_button.fade_after_s} s; the player can drag it anywhere, and the spot is kept per game and orientation. A trial clock may sit beside it.`,
      `For the first ${N.menu_button.tip_plays} plays on a device a short tip (up to ${N.menu_button.tip_width} px wide) shows at top centre for 5 s; taps go through it.`,
      'It is always there and always on top: the game is a frame under it and cannot paint over it, take fullscreen for itself or hide it. exitButton: \'none\' is taken as the top-left corner.',
      'Its corner is not reserved: it floats over the game, faded, and a player it is in the way of drags it aside. Lay the interface out for the game alone and use the whole safe area, top corners included.',
      'GCP.setDisplay({ exitButton: \'top-right\' | \'bottom-left\' | \'bottom-right\' }) picks the corner it starts in, if another suits the game better.',
    ],
    do: ['Lay out the HUD for the game itself, inside the safe area; the top corners are yours.'],
    dont: ['Move the HUD aside for the button or leave a corner empty for it.', 'Count on hiding it: exitButton \'none\' does not.'],
    enforced: 'Not checked: the button never needs room from the game.', checks: [], guide: '/guides/standards.md#menu-button',
  },
  {
    id: 'safe-area', area: 'game', title: 'Safe areas: notch, rounded corners, home bar',
    where: 'Fullscreen on phones and tablets.',
    spec: [
      'In fullscreen the game fills the whole screen edge to edge, under the notch, camera hole, rounded corners and home indicator.',
      'The insets are GCP.display.safe ({ top, right, bottom, left } in CSS px) and the CSS variables --gcp-safe-top, -right, -bottom, -left; GCP.ui.rect anchors inside them by default.',
      'Draw the world to the edges; keep buttons, text and HUD inside the insets. On a phone in landscape keep nothing important in the bottom 20 px.',
      'GCP.setDisplay({ edgeToEdge: false }) keeps the game inside them with black bars instead.',
      'A bar on an edge (an experience bar, a toolbar, a top HUD strip) sits flush on the screen edge: its background runs through the inset to the edge (GCP.ui.rect(...).bleed), and only its text, icons and buttons stay inside the safe area. Never leave a strip of the world between an edge bar and the screen edge, and never move the whole bar up by the inset. The anchor rules are the ui-layout standard.',
    ],
    do: ['Use max(env(safe-area-inset-left, 0px), var(--gcp-safe-left, 0px)) in CSS, or GCP.ui.rect for canvas layouts.'], dont: ['Assume the frame is already inside the notch.'],
    enforced: 'Verification tells the game it is in fullscreen on an iPhone (insets 47 / 47 / 21 sideways, 47 / 0 / 34 upright) and reads its interface layer: interface drawn under the notch or the home bar is reported, and game_standards check and publish warn about it. game_standards check also warns when a game for phones never reads the insets in its code.',
    checks: ['safe-area', 'zone-safe-area', 'zones-one-layer'], guide: '/guides/input.md#phones-and-tablets', template: '/guides/safe-area-template.png',
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
    required: `The game is playable by touch on phones and tablets (release rule every_device): with touch controls of its own (declare touch in requirements.input), or with the platform's on-screen controls pressing its keys (leave gcp.json "controls" touch on). Which of the two, and how its own controls look and where they sit, is the game's design choice.`,
    enforced: 'Not checked: look at the preview with debug_preview on a phone viewport.', checks: [], guide: '/guides/input.md#phones-and-tablets', template: '/guides/safe-area-template.png',
  },
  {
    id: 'ui-layout', area: 'game', title: 'Interface layout: anchors, offsets and stretch',
    where: 'Every interface element of the game (HUD, menus, dialogs, buttons, bars, toasts), at every screen size, aspect ratio and orientation, in a window and in fullscreen.',
    spec: [
      'Recommended: lay out every interface element by anchors, as Unity\'s RectTransform and Godot\'s Control do: GCP.ui.rect({ anchor, w, h, margin, pivot, offset, minW, maxW, aspect, id }, parent?). Never by absolute pixel positions from a design size, and never by positions measured once at start.',
      'Anchors: a corner (top-left, top-right, bottom-left, bottom-right), an edge middle (top, bottom, left, right) or the center places a fixed-size box against that point; a wide anchor (top-wide, bottom-wide, left-wide, right-wide, hcenter-wide, vcenter-wide, full) or [left, top, right, bottom] fractions of the parent stretches the box between two points. margin keeps room from the anchored edges, offset nudges, pivot is the point of the box that sits on the anchor, minW / maxW / minH / maxH and aspect bound a stretched box.',
      'Choose the anchor from what the element belongs to: status and resources to a top corner, the timer or wave to the top edge, the primary action to a bottom corner within thumb reach, an experience or progress bar to the bottom or top edge, stretched across, dialogs and the pause menu to the center with maxW and maxH, toasts to an edge. Never anchor a corner element to the center or position it as a fraction of a design size.',
      'Parents: lay a group out inside its panel with rect(spec, panelBox) and GCP.ui.split(box, "row" | "column", items, gap) (HBox and VBox), so the group moves and stretches with the panel. A child never pokes out of its parent.',
      'The parent of a top-level element is the view inside the safe area (GCP.ui.view minus GCP.ui.safe). Edge bars sit flush on the screen edge: draw their background from box.bleed (carried through the inset to the edge) and their text, icons and buttons in the box itself. Nothing floats a fixed distance above the bottom because of an inset that is not there.',
      'Size in interface units: GCP.ui.configure({ reference, match, minView }) once; GCP.ui.scale turns units into CSS pixels on this screen, times the player\'s Interface size. The view grows along the long side: a 21:9 phone has more width, a portrait phone more height, and the layout fills it from the anchors, never by stretching the art.',
      'Lay out again on every GCP.ui.onChange (resize, turning the device, fullscreen, the browser bars, the player\'s size), or simply every frame, and draw from the boxes you just placed.',
      'No two elements on the same layer overlap, at any size: when they would (a narrow portrait phone, a large Interface size), the layout switches (wrap a row into two, move secondary items to another edge, shorten labels, hide what is not needed) rather than letting them collide. Text fits its box at every size and language. Tap targets are at least 44 CSS px.',
      'Give every element an id (and a layer for what draws over the HUD: menu, modal, toast): rect({ id: "coins", layer: "hud", ... }). The verifier reads the boxes (GCP.ui.layout()) at every size it plays the game at and reports elements off the screen, under the notch or the home bar, and overlapping on one layer.',
    ],
    do: [
      'Check with debug_preview at 390x844, 844x390, 1180x820, 960x540 and 1920x1080 (plus 2560x1080 for ultrawide), and with Interface size at 150%: call GCP.ui.layout() in a state step to see every box.',
      'Draw edge bars with box.bleed for the background and box for the content.',
      'Prefer stretch anchors with minW / maxW over fixed widths for bars, panels and rows of buttons.',
    ],
    dont: [
      'Place interface at absolute coordinates of the reference size (x = 1180) or at a fraction of it computed once.',
      'Add the safe inset to an element that already sits inside the safe area, or move a whole edge bar up by the inset (it leaves a strip of the world under it in fullscreen).',
      'Let a corner panel and a centered or edge element share the same space on narrow screens.',
    ],
    enforced: 'game_standards check and deploy_preview warn when the game never reads the screen size, and note a game that places interface with GCP.ui.rect but gives no element an id. Verification reads the boxes placed with an id on the computer (960x540) and on every phone and tablet pass (sideways and, for a game that plays both ways, upright) and warns about each element off the screen, under the notch or the home bar, or overlapping another on the same layer, naming the elements and the screen size.',
    checks: ['layout-fixed-size', 'layout-no-ids', 'layout-off-screen', 'layout-unsafe', 'layout-overlap'], guide: '/guides/standards.md#ui-layout',
  },
  {
    id: 'window-orientation', area: 'game', title: 'Window size',
    where: 'The game page and the console preview; fullscreen on every device.',
    spec: [
      `In a window the game gets a 16:9 frame of at most ${N.window.max_w}x${N.window.max_h} CSS px (scaled down, never smaller, on a small page). Fullscreen gives it the whole screen at any shape.`,
      'Size from innerWidth and innerHeight on every resize, never from the first size.',
      'Which way up the game is played is its own standard: orientation.',
    ],
    do: ['Handle a resize at any time: entering fullscreen, turning the device, the browser bars coming and going.'], dont: ['Hard-code 16:9 or the window size.'],
    enforced: 'Device checks note a canvas that does not fit the screen or covers under 30% of it.', checks: [], guide: '/guides/standards.md#window-orientation',
  },
  {
    id: 'orientation', area: 'game', title: 'Orientation: landscape, portrait or both',
    where: 'Phones and tablets, fullscreen and the installed app; the store page\'s Compatibility section.',
    spec: [
      'Which way up the game is played is the game\'s own design decision: landscape only, portrait only and both are all fine, and the platform never requires one. What the platform requires is that the game plays on computers, tablets and phones (release rule every_device), held the way it declares.',
      'Declare which way up the game is played, in gcp.json requirements.orientation (compatibility {action: "declare"}): "landscape", "portrait" or "both" ("any" means both). Declare the shapes the interface is designed for, not the ones it merely survives. Without a declaration the platform assumes both.',
      'landscape or portrait (one orientation): the platform locks the screen to it where the browser allows (Android in fullscreen). Where it cannot (iPhone, iPad, a locked rotation), the platform itself covers the game with a rotate-your-device prompt while the device is held the other way, pauses the game behind it, and lifts it as soon as the device is turned. The game does not draw a prompt of its own and needs no layout for the other orientation.',
      'A one-orientation game still survives the other shape without breaking: the player can dismiss the prompt ("Play this way") and the computer window is always 16:9. Then fit the game to the window whole (letterbox or pillarbox the designed shape, never crop the interface) and keep running.',
      'landscape: design for aspect ratios from 4:3 (iPad, 1.33) to about 21:9 (phones, 2.17). Keep HUD on the edges and corners, controls in the bottom corners, and nothing important in the bottom 20 px on a phone (the home bar).',
      'portrait: design for 9:21 (phones) to 3:4 (iPad). On a computer the 16:9 window shows a centred column: fill the sides with the world or a backdrop, never stretch.',
      'both: give the interface a real layout for each shape, chosen from innerWidth > innerHeight on every resize, never once at start. Turning the device mid-game keeps all state (no restart, no reload, no lost menu) and relays out within one frame. Portrait is not landscape shrunk: stack top-bar items into rows or move secondary ones to the bottom, make primary menu buttons full-width in one column, keep thumb controls in the bottom third, and size text and buttons from the short side (GCP.ui does this).',
      'In every orientation: no two interface elements overlap, no text is cut off or runs outside its box, tap targets are at least 44 CSS px, and everything stays inside the safe area (GCP.display.safe). GCP.display.orientation tells the game what was declared, or what GCP.setDisplay({ orientation }) chose at run time.',
    ],
    do: [
      'Check each declared orientation with debug_preview: phone-portrait (390x844) and phone-landscape (844x390), and an iPad shape, on every screen (title, menus, play, pause, results).',
      'For both: rotate mid-run in debug_preview and confirm the game carries on where it was.',
      'Re-anchor the HUD from GCP.ui.rect on every GCP.ui.onChange or resize.',
    ],
    dont: [
      'Draw your own "rotate your device" screen: the platform shows one, and two prompts fight.',
      'Declare "both" for a game whose portrait view is a squeezed landscape layout.',
      'Read the orientation once at start, or reload the game on a turn.',
      'Call screen.orientation.lock() yourself: in a frame it only asks the platform, which already locks to the declaration.',
    ],
    enforced: 'game_standards check and deploy_preview warn when the game declares no orientation, when GCP.setDisplay({ orientation }) in the code disagrees with the declaration, and when the code draws its own rotate prompt. Verification plays a "both" game on the iPhone held both ways (an extra upright pass) and checks the reserved zones in each; a game for phones that breaks upright fails that pass, interface under the notch or home bar upright is reported, and so is a canvas that stops fitting the screen after the phone is turned.',
    checks: ['orientation', 'orientation-conflict', 'orientation-own-prompt', 'orientation-turn'], guide: '/guides/standards.md#orientation',
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
    enforced: 'Not checked.', checks: [], guide: '/guides/services.md#display-fullscreen-and-devices',
  },
  {
    id: 'intended-sound', area: 'game', title: 'Intended sound plays correctly',
    where: 'Wherever the game is designed to have sound: the title, menus, lobby, play or results, as the game chooses. A screen meant to be quiet may stay quiet.',
    spec: [
      'Every sound the game is designed to play actually plays, at the volume intended. If the title or a menu is meant to have music, it is audible as soon as the player enters the game, or on their first interaction where the browser holds sound back (Safari, iPhone, iPad): never silent because of an unlock bug or a volume mistake.',
      'Make the AudioContext (or start the sound library) while the game boots, not inside a gesture. The player started the game with a click on the platform page and the game frame has autoplay, so where the browser allows it the sound plays at once.',
      'Wake it on the first gesture from window listeners in the capture phase, added before the interface adds its own: pointerdown, pointerup, click and keydown. iPhone and iPad do not count pointerdown from a finger, and canvas interfaces stop presses on their buttons, so a bubble listener never hears a tap on a menu button and the game stays silent until some other press. The runtime also resumes every context the game made on each pointerup, touchend, click, mousedown and keydown (fix "audio-unlock"), so a context made at boot always wakes on the first tap. Leave touchend listeners to the runtime: a "touchend" in the game\'s code tells the platform the game has touch controls of its own, which hides the on-screen controls.',
      'Play nothing while the context is not running (no effects queued up to burst out on the first tap), and resume after an iPhone interruption ("interrupted": a call, the lock screen) on the next gesture.',
      'Mix so intended sound is heard: music meant for a menu should not sit so far under play (more than about 10 dB) that the menu seems silent, and each screen plays the music meant for it (no battle drums left running on a calm menu).',
      'The platform suspends every context while its menu or a card is over the game, and while the tab is hidden, then starts exactly those again (fix "pause-audio"). A game\'s own pause menu suspends its own sound, and a gesture on that menu must not resume it. No sound shipped only as Ogg: older iPhones cannot play it (deploy_preview warns).',
    ],
    do: ['Decide which screens have sound, then check each of them from a fresh load with no key pressed: on a computer it should play at once, on an iPhone after the first tap on any button.', 'Give the player music and effects volumes and remember them.'],
    dont: ['Start sound only from a press on the game world or from the first key.', 'Create the AudioContext only when play starts, or only inside a gesture listener that the interface can stop.'],
    enforced: 'game_standards check and deploy_preview warn when the game starts its sound from a window gesture listener in the bubble phase: an interface that stops presses keeps it from ever running, so sound meant for the menus never plays. Whether a screen should have sound is the game\'s choice and is not checked.',
    checks: ['sound-unlock-bubble'], guide: '/guides/standards.md#intended-sound',
  },
  {
    id: 'capture-hooks', area: 'game', title: 'Capture and state hooks',
    where: 'The creator\'s feedback screenshots and debug_preview.',
    spec: ['Draw everything in canvases (text fields aside) and register GCP.test.onCapture(() => canvas or [canvases]) and GCP.test.onState(() => where the game is).'],
    do: ['Return the canvases bottom to top.'], dont: ['Paint page elements over the game.'],
    enforced: 'Advice only: verification reports a game without the hooks, or with page elements over the game, in its capture check and notes; it never stops the version.', checks: [], guide: '/guides/platform-contract.md#hand-over-the-frame',
  },
  {
    id: 'bot-hook', area: 'game', title: 'Bot hook for online games',
    where: 'Test bots in the preview.',
    spec: ['Recommended for every online game, so the creator can test it with bots: ship server/bot.js with think/actions for matches, room() for GCP.room games, invite() for room games that invite friends. The platform does connecting, matchmaking and invites; the bot does the game\'s own moves.'],
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
    required: `The listing in every platform language the game declares (release rule listing_languages). Which languages the game itself offers is its own choice.`,
    enforced: 'publish refuses a version whose listing misses one of its languages; metadata warns when GCP.lang is never read.', checks: [], guide: '/guides/game-metadata.md#languages',
  },
];

export const AREAS = { store: 'The store', 'not-offered': 'What the platform does not take', game: 'While the game plays' };
export const standardById = (id) => STANDARDS.find((s) => s.id === id) || null;

/** One line per standard, for get_started and game_standards {action: "list"}: each says whether any of it is required. */
export const standardsIndex = () => STANDARDS.map((s) => `${s.id} (${AREAS[s.area]}; ${s.required ? 'has a required part' : 'recommendation'}): ${s.title}. ${s.spec[0]}`);

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
 * The ui-layout standard measured: the boxes a game placed with GCP.ui.rect({ id }) at one screen size (GCP.ui.layout()).
 * Returns [{ check, ids, message }]: a box off the screen, under the safe inset, or overlapping another on its layer.
 */
export function layoutFindings(L) {
  const out = [];
  if (!L || !L.view || !Array.isArray(L.boxes)) return out;
  const W = L.view.w, H = L.view.h, sf = L.safe || { top: 0, right: 0, bottom: 0, left: 0 }, e = 1;
  const boxes = L.boxes.filter((b) => b && b.w > 0.5 && b.h > 0.5).slice(0, 200);
  const r1 = (v) => Math.round(v);
  for (const b of boxes) {
    const off = [b.x < -e && 'left', b.y < -e && 'top', b.x + b.w > W + e && 'right', b.y + b.h > H + e && 'bottom'].filter(Boolean);
    if (off.length) { out.push({ check: 'layout-off-screen', ids: [b.id], message: `"${b.id}" runs off the ${off.join(' and ')} of the screen (box ${r1(b.x)},${r1(b.y)} ${r1(b.w)}×${r1(b.h)} in a ${r1(W)}×${r1(H)} view).` }); continue; }
    if (b.inParent) continue;
    const under = [sf.left > e && b.x < sf.left - e && 'the left inset', sf.right > e && b.x + b.w > W - sf.right + e && 'the right inset', sf.top > e && b.y < sf.top - e && 'the notch at the top', sf.bottom > e && b.y + b.h > H - sf.bottom + e && 'the home bar'].filter(Boolean);
    if (under.length) out.push({ check: 'layout-unsafe', ids: [b.id], message: `"${b.id}" sits under ${under.join(' and ')} (box ${r1(b.x)},${r1(b.y)} ${r1(b.w)}×${r1(b.h)}).` });
  }
  const inside = (a, b) => a.x >= b.x - e && a.y >= b.y - e && a.x + a.w <= b.x + b.w + e && a.y + a.h <= b.y + b.h + e;
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
    const a = boxes[i], b = boxes[j];
    if (a.layer !== b.layer || inside(a, b) || inside(b, a)) continue;
    const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x), h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
    if (w <= e || h <= e) continue;
    const share = (w * h) / Math.min(a.w * a.h, b.w * b.h);
    if (share < 0.02) continue;
    out.push({ check: 'layout-overlap', ids: [a.id, b.id], message: `"${a.id}" and "${b.id}" overlap (${Math.round(share * 100)}% of the smaller, around ${r1(Math.max(a.x, b.x))},${r1(Math.max(a.y, b.y))} ${r1(w)}×${r1(h)}).` });
  }
  return out;
}

/** Only what a player can see: page code without comments, not the server-side bot, tooling or libraries. */
const shownCode = (texts) => [...texts].filter(([p]) => /\.(m?js|html?)$/i.test(p) && !/(^|\/)(server|tools?|scripts?|tests?|vendor|libs?|node_modules|three)[^/]*\//i.test(p) && !/\.min\.js$/i.test(p))
  .map(([, t]) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '').replace(/(^|[^:\\'"`])\/\/.*$/gm, '$1')).join('\n');
/** "landscape" | "portrait" | "any" (both) from a declaration, or '' when there is none. */
export const orientationOf = (v) => { const s = String(v ?? '').trim().toLowerCase(); return s === 'both' || s === 'any' ? 'any' : s === 'landscape' || s === 'portrait' ? s : ''; };
/** Text of a rotate-your-device prompt, in the platform's languages. */
/** A title picture named in the code: a key art, title or cover image the title screen draws. */
const TITLE_PIC = /['"`][^'"`\s]*(title|cover|key-?art|splash|menu-?bg)[^'"`\s/]*\.(png|jpe?g|webp|avif)['"`]/i;
const OWN_PROMPT = /['"`][^'"`\n]*(\b(rotate|turn) (your |the )?(device|phone|screen|tablet)\b|\bplease (rotate|turn)\b|\b(best|only) (played|playable) in (landscape|portrait)\b|请(横|竖)屏|(旋转|横过来|竖过来)(你的)?(手机|设备|屏幕)|画面を(横|縦)|(横|縦)向きにして|기기를 (가로|세로)|화면을 회전|gira (tu|el) (dispositivo|teléfono|móvil))/i;

/**
 * Checks a game against the standards. Every finding names its standard, says what was found and gives the exact fix.
 * levels: 'warning' (shown at deploy and publish; advice, never blocking), 'note' (only in game_standards check). Game
 * design is the game's choice: no finding here ever stops a version.
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
    if (typeof pb === 'number' && pb < 2) add('splash-loading', 'warning', `Verification saw ${pb} GCP.progress() call${pb === 1 ? '' : 's'} before GCP.ready(), so the platform splash had no loading screen to hand over to and waited for GCP.ready().`, 'Draw the loading screen in its final look, then call GCP.progress(f, label) at least twice while loading.', { check: 'progress-hand-off' });
    for (const [z, way] of [[R.zones, ''], [R.zonesUpright, ' held upright']]) if (z && z.checked) for (const x of z.zones) {
      if (x.zone === 'menu-button') continue;   // an older report: the button's corner is no longer reserved
      add('safe-area', 'warning', `On a phone${way} in fullscreen the interface covers ${Math.round(x.coverage * 100)}% of ${x.zone === 'home-bar' ? 'the home bar strip' : 'the notch strip'} (around x ${x.box[0]}, y ${x.box[1]}, ${x.box[2]}×${x.box[3]} px).`, 'Anchor the HUD inside GCP.display.safe (GCP.ui.rect does it by default).', { check: 'zone-safe-area' });
    }
    // the ui-layout standard at each screen size verification played: one finding per problem, with every size it showed at
    if (Array.isArray(R.layout)) {
      const seen = new Map();
      for (const at of R.layout) for (const f of layoutFindings(at)) { const k = f.check + '|' + f.ids.join('|'), x = seen.get(k); if (x) x.where.push(at.where); else seen.set(k, { ...f, where: [at.where] }); }
      const STD = { 'layout-overlap': 'ui-layout', 'layout-off-screen': 'ui-layout', 'layout-unsafe': 'ui-layout' };
      const FIX = { 'layout-overlap': 'Anchor the two to different edges or corners, or switch the layout where there is no room for both (wrap the row, move one to another edge, shorten it); give an element that draws over the other its own layer.', 'layout-off-screen': 'Anchor it to the edge it belongs to with GCP.ui.rect and bound it with maxW / maxH, so it stays on the screen at every size.', 'layout-unsafe': 'Place it with GCP.ui.rect (inside the safe area by default); draw only an edge bar\'s background through the inset, from box.bleed.' };
      for (const f of [...seen.values()].slice(0, 12)) add(STD[f.check], 'warning', `${f.message.replace(/\.$/, '')} on ${f.where.join(', ')}.`, FIX[f.check], { check: f.check });
    }
    const z = R.zones;
    if (R.turn && R.turn.ok === false) add('orientation', 'warning', `After the phone was turned ${R.turn.to === 'portrait' ? 'upright' : 'sideways'} (${R.turn.viewport}), ${R.turn.problem}`, 'Size the canvas and lay out the interface from innerWidth and innerHeight on every resize, keeping the game where it was; a game that plays one way only declares that orientation instead.', { check: 'orientation-turn' });
    if (z && !z.checked && z.reason === 'one-layer') add('safe-area', 'note', 'The reserved zones (notch, home bar) could not be checked: GCP.test.onCapture hands over a single canvas.', 'Return [world, ui] from GCP.test.onCapture, with the interface on its own canvas, so verification can check them.', { check: 'zones-one-layer' });
  }
  const texts = input.texts instanceof Map ? input.texts : new Map(Object.entries(input.texts || {}));
  if (texts.size) {
    const code = [...texts].filter(([p]) => /\.(m?js|html?)$/i.test(p) && !/(^|\/)(vendor|libs?|node_modules|three)[^/]*\//i.test(p) && !/\.min\.js$/i.test(p)).map(([, t]) => t).join('\n');
    const gcp = input.gcp || {}, req = gcp.requirements || {}, devices = Array.isArray(req.devices) ? req.devices : [];
    const phones = devices.includes('mobile') || devices.includes('tablet');
    const usesKeys = /\b(keydown|keyup)\b/.test(code);
    if (L && usesKeys && !String(L.controls || '').trim()) add('controls-text', 'note', 'The game reads the keyboard but its listing has no controls text.', 'Add the controls (game_metadata declare controls), one per line.', { check: 'controls-missing' });
    if (phones && !/GCP\.display\.safe|display\.safe|--gcp-safe|ui\.rect\s*\(|ui\.safe|edgeToEdge\s*:\s*false|createUi\s*\(|createInput\s*\(/.test(code)) add('safe-area', 'warning', 'The game lists phones or tablets but never reads the safe-area insets; in fullscreen its HUD can sit under the notch or the home bar.', "Keep HUD and buttons inside GCP.display.safe (or --gcp-safe-* in CSS, or GCP.ui.rect), or call GCP.setDisplay({ edgeToEdge: false }).", { check: 'safe-area' });
    // ui-layout: the game reads the screen size, and names the boxes it places so verification can measure them
    if (/<canvas|getContext\s*\(|\bcanvas\b/i.test(code) && !/innerWidth|innerHeight|clientWidth|clientHeight|getBoundingClientRect|ResizeObserver|visualViewport|GCP\.ui\b|\bui\.(rect|view|state|onChange)\b|['"]resize['"]|onresize/.test(code)) add('ui-layout', 'warning', 'The game never reads the size of the screen, so its interface is laid out for one size and is cut off or misplaced on others and in fullscreen.', 'Lay the interface out with GCP.ui.rect anchors and redo it on every GCP.ui.onChange (or every frame).', { check: 'layout-fixed-size' });
    else if (/\bui\.rect\s*\(/.test(code) && !/\bui\.rect\s*\(\s*\{[^}]*\bid\s*:/.test(code)) add('ui-layout', 'note', 'The game places its interface with GCP.ui.rect but gives no element an id, so verification cannot measure its layout (overlaps, off screen, under the notch) at each screen size.', 'Pass an id (and a layer for menus and dialogs) to every rect() that places an interface element: rect({ id: "coins", anchor: "top-right", ... }).', { check: 'layout-no-ids' });
    // orientation: declared, consistent with what the code asks for at run time, and no rotate prompt of the game's own
    const declared = orientationOf(req.orientation ?? gcp.orientation), setIn = [...code.matchAll(/setDisplay\s*\(\s*\{[^}]*?orientation\s*:\s*['"](landscape|portrait|any|both)['"]/g)].map((m) => orientationOf(m[1]));
    // a game declared for computers only is never turned, so the missing declaration is only worth a note there
    const desktopOnly = devices.length > 0 && !phones;
    if (!declared) add('orientation', desktopOnly ? 'note' : 'warning', `The game declares no orientation, so the platform treats it as playable both ways${phones ? ' and checks it upright and sideways on phones' : ''}.`, 'Declare requirements.orientation: "landscape", "portrait" or "both" (compatibility {action: "declare"}). Pick the shapes the interface is designed for; a single orientation gets the platform\'s rotate-your-device prompt.', { check: 'orientation' });
    else if (setIn.some((o) => o !== declared)) add('orientation', 'warning', `The code calls GCP.setDisplay({ orientation: '${setIn.find((o) => o !== declared)}' }) but requirements.orientation declares ${declared === 'any' ? 'both' : declared}; the store page, the device checks and the rotate prompt follow different answers.`, 'Make them agree: change the declaration or the call (or drop the call; the declaration is enough).', { check: 'orientation-conflict' });
    if (OWN_PROMPT.test(shownCode(texts))) add('orientation', 'warning', 'The game draws its own rotate-your-device prompt. The platform shows one for a one-orientation game, pauses the game behind it and lifts it when the device is turned, so the player meets two.', declared && declared !== 'any' ? 'Remove the game\'s prompt; the declaration is enough.' : 'Remove the game\'s prompt and declare the orientation it needs; or, if it plays both ways, lay out for both and drop the prompt.', { check: 'orientation-own-prompt' });
    // a title picture drawn with a fallback while it loads: the fallback (often the old, code-drawn title) is what players see first
    const standIn = [...texts].find(([p, t]) => /\.(m?js|html?)$/i.test(p) && TITLE_PIC.test(t) && /\.complete\b|\bnaturalWidth\b/.test(t));
    if (standIn) add('splash-loading', 'warning', `${standIn[0]} loads a title picture (${(standIn[1].match(TITLE_PIC) || [''])[0].replace(/['"`]/g, '')}) and draws something else until it has loaded, so every launch can show that stand-in (often the old title) and then switch to the picture.`, 'Load the title picture before GCP.ready() and draw only the loading screen or a plain backdrop while it downloads; remove the code that drew the previous title (keep it only for when the picture fails to load).', { check: 'title-stand-in' });
    if (!/GCP\.progress\s*\(|\.progress\s*\(\s*[\d.]/.test(code)) add('splash-loading', 'note', 'The game never calls GCP.progress(), so the platform splash stays until GCP.ready() (at most 12 s) with no loading screen of the game\'s own.', 'Call GCP.progress(f, label) while loading (at least twice) and draw the loading screen in its final look before the second call.', { check: 'no-progress' });
    // intended sound: the unlock must hear a tap on a menu button, which a canvas interface stops at the window in the capture phase
    if (/\b(webkit)?AudioContext\b/.test(code)) {
      const re = /addEventListener\(\s*['"](pointerdown|mousedown|touchstart|pointerup|touchend|click|keydown)['"]\s*,\s*([A-Za-z_$][\w$.]*)\s*(\)|,\s*(\{[^}]*\}|true|false))/g;
      let m, bubble = null;
      while ((m = re.exec(code))) { const opt = m[4] || ''; if (/unlock|wake|resume|audio|sound|music/i.test(m[2]) && !/capture\s*:\s*true|^true$/.test(opt.trim())) { bubble = m; break; } }
      if (bubble) add('intended-sound', 'warning', `The sound starts from a window ${bubble[1]} listener in the bubble phase (addEventListener('${bubble[1]}', ${bubble[2]})). Canvas interfaces stop presses on their buttons before they bubble, so sound meant for the menus never plays: the game stays silent until a key or a press on the game world.`, 'Make the AudioContext at boot, and resume it from window listeners added with { capture: true } before the interface adds its own, for pointerdown, pointerup, click and keydown.', { check: 'sound-unlock-bubble' });
    }
    const brand = String(input.brand || 'HearthCade');
    // only what a player can see: page code without comments, not the server-side bot or tooling
    const shown = shownCode(texts);
    // the name as words a player reads, not inside a storage key, a host name or a path ('hearthcade-save', 'hearthcade.com/g/…')
    if (brand && new RegExp(`['"\`][^'"\`\\n]*(?<![\\w./:@-])${brand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w/:-]|\\.\\w)`, 'i').test(shown)) add('no-icons', 'warning', `The game's code draws or names "${brand}", the platform's own name.`, 'Remove it: the platform shows its own splash, and a game must not present itself as made by the platform.', { check: 'platform-logo' });
    if (/achievement/i.test(code) && !/GCP\s*\.\s*achievements|playerStats/.test(code) && !Array.isArray(input.gcp?.achievements)) add('achievements', 'note', 'The game has achievements but keeps them only on the device.', 'Declare them in gcp.json "achievements" and unlock them with GCP.achievements.unlock(id), so they follow the player and show on the game page with their rarity.', { check: 'achievements' });
  }
  const paths = input.paths || [...texts.keys()];
  const unused = paths.filter((p) => VIDEO.test(p) || ICONS.test(p) || SHOTS.test(p));
  if (unused.length) add('no-icons', 'note', `The bundle has files the store never shows: ${unused.slice(0, 6).join(', ')}${unused.length > 6 ? ` and ${unused.length - 6} more` : ''}.`, 'Remove them unless the game itself uses them: they only use storage. The store takes a cover (update_project) and nothing else.', { check: 'unused-store-files', files: unused.slice(0, 20) });
  return out;
}

/** A finding as one line, for deploy warnings and publish answers: always advice, never a requirement. */
export const findingLine = (f) => `${f.level === 'warning' ? 'RECOMMENDATION' : 'NOTE'} [${f.standard}] ${f.message} Suggested: ${f.fix}`;

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
    'Everything a game or its agent provides, as the platform shows it: where each thing appears, its exact sizes and limits, what to do and not do, and what the platform checks.',
    '',
    '## Two kinds of rule',
    '',
    `**Platform requirements (mandatory).** ${SPLIT.requirements} They are the release requirements, checked by \`publish\` (\`publish {dry_run: true}\` lists each one) and in [the contract](${link('/guides/platform-contract.md')}). Where an entry below has a mandatory part, it says **Required** and names it.`,
    '',
    `**Design recommendations (advice).** ${SPLIT.recommendations} Everything else on this page is one: \`deploy_preview\`, \`game_standards\` check and \`publish\` report each finding as RECOMMENDATION, weigh it against the game\'s design, and none of them stops a version. A one-orientation game, a portrait game, a game with its own layout style are all fine.`,
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
      if (s.required) out.push('', `**Required (platform requirement, publish refuses without it):** ${s.required}`);
      out.push('', `**${s.required ? 'Recommended, and checked' : 'Recommendation, checked'}:** ${s.enforced}`);
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
    `<circle cx="${ox + side + mb.inset + mb.size / 2}" cy="${oy + mb.inset + mb.size / 2}" r="${mb.size / 2}" fill="rgba(12,10,18,.55)" stroke="#fff"/>`,
    `<path d="M${ox + side + mb.inset + 11} ${oy + mb.inset + 14}h18M${ox + side + mb.inset + 11} ${oy + mb.inset + 20}h18M${ox + side + mb.inset + 11} ${oy + mb.inset + 26}h18" stroke="#fff" stroke-width="2.2" stroke-linecap="round"/>`,
    tx(side + mb.size + 2 * mb.inset + 8, 22, `platform menu button, ${mb.size} px, ${mb.inset} px in`, 11, '#7b4a00'),
    tx(side + mb.size + 2 * mb.inset + 8, 36, 'floats on top, drag it anywhere', 11, '#7b4a00'),
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
    tx(0, H + 84, 'The menu button needs no room. When the platform controls show, keep the bottom corners free of HUD. Standards: /guides/standards.md', 12, '#333'),
    `</svg>`,
  ].join('');
}
