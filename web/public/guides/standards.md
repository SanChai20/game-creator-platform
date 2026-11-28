# Game standards

<!-- Generated from src/standards.js by scripts/standards-guide.mjs. Edit the registry, not this file. -->

Everything a game or its agent provides, as the platform shows it: where each thing appears, its exact sizes and limits, what to do and not do, and what the platform checks.

## Two kinds of rule

**Platform requirements (mandatory).** Platform requirements are mandatory: a version that misses one cannot go live, and publish says exactly what to fix. Every game must boot and play in the browser without errors, react to the player's input, keep running through bot play (a score or an ending is optional; reporting one with GCP.score or GCP.gameOver lifts its ranking a little), be playable on computers, tablets and phones (keyboard or mouse on a computer, touch on a phone or tablet), pass the content and originality checks, fit its storage, and have its store metadata on record. They are the release requirements, checked by `publish` (`publish {dry_run: true}` lists each one) and in [the contract](/guides/platform-contract.md). Where an entry below has a mandatory part, it says **Required** and names it.

**Design recommendations (advice).** Design recommendations are advice: how the game looks, which way up it is played (landscape, portrait or both), how it lays out its interface, its cover, loading screen and sound are the game's own decisions. The platform says how its own surfaces behave and recommends how to fit around them; no recommendation ever stops a version. Everything else on this page is one: `deploy_preview`, `game_standards` check and `publish` report each finding as RECOMMENDATION, weigh it against the game's design, and none of them stops a version. A one-orientation game, a portrait game, a game with its own layout style are all fine.

Read the entry before you make the thing. `game_standards {action: "get", id}` returns one entry; `game_standards {project, action: "check"}` checks the game and its listing against all of them and lists each finding with the fix. `deploy_preview` and `publish` report the same findings.

Templates: [cover](/guides/cover-template.png) · [safe area on a phone](/guides/safe-area-template.png)

| Standard | Where | Checked |
|---|---|---|
| [Cover image](#cover) | The store | game_standards check |
| [A cover per language](#cover-languages) | The store | platform |
| [What the store draws over the cover](#card-overlays) | The store | by looking |
| [Game title](#title) | The store | game_standards check |
| [Tagline](#tagline) | The store | game_standards check |
| [Description](#description) | The store | game_standards check |
| [Controls text](#controls-text) | The store | game_standards check |
| [Genre and tags](#genre-tags) | The store | platform |
| [Screenshots](#screenshot) | The store | game_standards check |
| [Store badges](#badges) | The store | platform |
| [Trailers and video](#no-trailer) | What the platform does not take | game_standards check |
| [Icons, logos and title art](#no-icons) | What the platform does not take | game_standards check |
| [Achievements](#achievements) | While the game plays | game_standards check |
| [Platform splash and the loading screen](#splash-loading) | While the game plays | game_standards check |
| [The platform menu button](#menu-button) | While the game plays | by looking |
| [Safe areas: notch, rounded corners, home bar](#safe-area) | While the game plays | game_standards check |
| [The platform's on-screen controls](#touch-controls) | While the game plays | by looking |
| [Interface layout: anchors, offsets and stretch](#ui-layout) | While the game plays | game_standards check |
| [Window size](#window-orientation) | While the game plays | platform |
| [Orientation: landscape, portrait or both](#orientation) | While the game plays | game_standards check |
| [Interface scale and the player's UI size](#interface-scale) | While the game plays | platform |
| [Quality settings](#quality) | While the game plays | by looking |
| [Intended sound plays correctly](#intended-sound) | While the game plays | game_standards check |
| [Capture and state hooks](#capture-hooks) | While the game plays | platform |
| [Bot hook for online games](#bot-hook) | While the game plays | platform |
| [Friends picker and pop-ups](#friends-ui) | While the game plays | by looking |
| [Languages in the game](#localization) | While the game plays | platform |

## The store

<a id="cover"></a>

### Cover image

**Where:** The home page banner, store cards (16:10), wide shelves (16:7), search, the library, Continue, friends' lists and the game page. Each crops it differently.

- 1920x1080 (16:9), at least 1280x720; png, jpg or webp under 2 MB. Set with update_project cover (and covers, one per language).
- The title and the main subject stay inside the safe area: x 30% to 80%, y 12% to 86%.
- The left 30% is hidden behind the home banner's info panel: background only there.

**Do:** Design a cover; do not rely on the verification screenshot. Check it on the template, cropped to the banner, 16:10 and 16:7, and at 240 px wide.

**Don't:** Close-up faces cut by the crops. Text near any edge.

**Recommendation, checked:** update_project answers with cover_check (size and shape); game_standards check and publish warn when there is no cover (the store then crops the verification screenshot). The composition inside the safe area is yours to check by looking at the template.

![Cover image template](/guides/cover-template.png)

More: [game-metadata.md#cover-image](/guides/game-metadata.md#cover-image)

<a id="cover-languages"></a>

### A cover per language

**Where:** Every place the cover appears, in the player's platform language.

- A cover that shows words (the title) needs one cover per listing language with those words in it: update_project covers {zh, zh-TW, ja, ko, es}.
- A language without its own cover shows the main cover.

**Do:** Keep the cover free of words if you will not make one per language.

**Don't:** Machine-translate the game's own name when the game keeps it in one language.

**Required (platform requirement, publish refuses without it):** The listing text (the title, and the tagline and description where the listing has them) in every platform language the game declares (release rule listing_languages). A cover per language is a recommendation.

**Recommended, and checked:** publish refuses a version played in a platform language its listing lacks (rule listing_languages).

More: [game-metadata.md#the-store-listing-in-every-language](/guides/game-metadata.md#the-store-listing-in-every-language)

<a id="card-overlays"></a>

### What the store draws over the cover

**Where:** Store cards and shelves.

- Top left: a New, Featured or pick chip.
- Top right: a live pill with the number playing now.
- Bottom left: an 18+ tag naming what an adults-only game contains (the whole cover is blurred for those).
- Each sits about 10 px in from the card edge and is about 22 to 26 px tall on a card 220 to 350 px wide.

**Do:** Keep the four corners of the 16:10 crop to background.

**Don't:** Put a logo, a price, a badge or a "NEW" label of your own on the cover: the store adds its own.

**Recommendation, checked:** Not checked. Look at the cover cropped to 16:10 with those corners covered.

More: [standards.md#card-overlays](/guides/standards.md#card-overlays)

<a id="title"></a>

### Game title

**Where:** The home banner (40 to 80 px), the game page heading (42 to 90 px), cards (17 px), search, the library, friends' lists and invites.

- At most 80 characters (per language).
- The banner and the game page set it in the platform's condensed display face in CAPITALS, and break it anywhere when a word does not fit.
- About 30 Latin characters or 14 Chinese, Japanese or Korean characters fit on two banner lines; longer titles take three or more.

**Do:** Use the name the game shows on its title screen. Put a subtitle in the tagline, not the title.

**Don't:** Rely on letter case (it is shown in capitals). Add the platform's or the operator's name. Add emoji or decorative symbols.

**Required (platform requirement, publish refuses without it):** At most 80 characters per language: a longer title is refused.

**Recommended, and checked:** Over the limit is refused. game_standards check notes a title too long for the banner.

More: [standards.md#title](/guides/standards.md#title)

<a id="tagline"></a>

### Tagline

**Where:** Under the title in the home banner (cut after 2 lines), on cards and in search.

- At most 140 characters, but only about 80 Latin characters (or 36 Chinese, Japanese or Korean) show in the banner on a phone before it is cut.
- A tagline that only repeats the title is hidden everywhere.
- One sentence that says what the player does, in the listing's language.

**Do:** Lead with the verb or the hook: "Guide a lantern through a drowned city."

**Don't:** Repeat the title. Use the space for genre words the tags already show. Use quotes, emoji or ALL CAPS.

**Required (platform requirement, publish refuses without it):** At most 140 characters per language: a longer tagline is refused.

**Recommended, and checked:** Over the limit is refused. game_standards check, deploy_preview and publish warn about a repeated title and a tagline cut in the banner.

More: [standards.md#tagline](/guides/standards.md#tagline)

<a id="description"></a>

### Description

**Where:** The game page, in a column of about 72 characters.

- At most 5000 characters (per language).
- Plain text: line breaks are kept and blank lines make paragraphs. Markdown is NOT rendered, so **bold**, # headings and [links](…) show as typed.
- A list is lines that start with "· " or "- ".

**Do:** Open with what makes the game worth playing, then how a session goes, then modes and length. Two to five short paragraphs.

**Don't:** Markdown, HTML or links. Controls (they have their own field). Prices, sales or other games.

**Required (platform requirement, publish refuses without it):** At most 5000 characters per language: a longer description is refused.

**Recommended, and checked:** Over the limit is refused. game_standards check, deploy_preview and publish warn about Markdown.

More: [standards.md#description](/guides/standards.md#description)

<a id="controls-text"></a>

### Controls text

**Where:** The Controls box on the game page, beside the description.

- At most 1000 characters. Plain text like the description, one control per line: "WASD or arrows · move".
- Cover keyboard, mouse, touch and gamepad if the game supports them.

**Do:** Name keys by what is printed on them.

**Don't:** Markdown or tables.

**Required (platform requirement, publish refuses without it):** At most 1000 characters per language: longer controls text is refused.

**Recommended, and checked:** game_standards check warns about Markdown and notes a game with keys but no controls text.

More: [standards.md#controls-text](/guides/standards.md#controls-text)

<a id="genre-tags"></a>

### Genre and tags

**Where:** Store filters, category and tag pages, search, "more like this".

- One genre from the fixed list, up to two secondary genres, and 2 to 8 tags from the platform list only.

**Do:** Pick the tags a player would filter by.

**Don't:** Invent tags; anything off the list is refused.

**Required (platform requirement, publish refuses without it):** One genre and 2 to 8 tags from the platform lists (release rule metadata).

**Recommended, and checked:** publish refuses a version without genre and at least 2 tags.

More: [game-metadata.md#tags](/guides/game-metadata.md#tags)

<a id="screenshot"></a>

### Screenshots

**Where:** The game page shows the verification picture of the live version; it is the cover too when there is none.

- The platform takes it: after the checks it loads the game once more at 960x540 with ?gcp_portrait=1 (GCP.portrait is true) and photographs the first view after loading.
- There is no upload for screenshots. GCP.test.onAutostart decides what that first view is.

**Do:** Draw at full quality when GCP.portrait is true, however slow the frame. Make the first view after onAutostart a good-looking moment of play.

**Don't:** Make screenshot files for the store: nothing shows them.

**Recommendation, checked:** Taken by the platform at every verification.

More: [platform-contract.md#the-screenshot](/guides/platform-contract.md#the-screenshot)

<a id="badges"></a>

### Store badges

**Where:** The age rating badge, sale price, verdict, rarity, live count and 18+ label.

- All drawn by the platform from the metadata, sales and play data. There is nothing to make.

**Do:** Declare content descriptors honestly: the age badge comes from them.

**Don't:** Draw badges, ratings or prices into the cover or the game.

**Recommendation, checked:** Generated.

More: [game-metadata.md#content-descriptors-and-the-age-rating](/guides/game-metadata.md#content-descriptors-and-the-age-rating)

## What the platform does not take

<a id="no-trailer"></a>

### Trailers and video

**Where:** Nowhere: the store has no video slot.

- Do not make a trailer for the store. Video in the bundle counts against the game's storage.

**Do:** Spend the effort on the cover and the first view of play.

**Don't:** Ship trailer files in the bundle.

**Recommendation, checked:** game_standards check notes video files in the bundle.

More: [standards.md#no-trailer](/guides/standards.md#no-trailer)

<a id="no-icons"></a>

### Icons, logos and title art

**Where:** Nowhere: there is no icon, favicon or logo slot. Where a store shows an icon, this one shows the cover, cropped to 16:10, as small as 64 px wide (search suggestions, "since you were away"). The title is set in text by the store; the Home Screen icon is the platform's.

- The cover is the game's icon: its main subject must still read at 64 px wide, so keep it large and simple inside the cover's safe area.
- Put the game's logo or title art on the cover and the game's own title screen only.
- Do not draw the platform's logo (HearthCade) anywhere: the platform shows its own splash.

**Do:** Keep title art inside the cover's safe area.

**Don't:** Ship icon sets, favicons or manifest icons for the store.

**Recommendation, checked:** game_standards check warns when the game draws the platform's name, and notes icon files.

More: [standards.md#no-icons](/guides/standards.md#no-icons)

## While the game plays

<a id="achievements"></a>

### Achievements

**Where:** The game page (an Achievements card with how rare each one is), the player's library (unlocked of total per game) and a short corner notice inside the game when one unlocks.

- Declare them in gcp.json "achievements" ({ id, name, description?, hidden?, stat?, goal? }, at most 100) and unlock them with GCP.achievements.unlock(id), or give a stat and a goal so the platform unlocks it when GCP.playerStats reaches the goal.
- Names up to 60 characters and descriptions up to 160, in every language the game is listed in (a string, or one string per platform language).
- The corner notice sits at the bottom right for about 4 seconds; set GCP.achievements.toast = false when the game shows its own.

**Do:** Keep ids stable across versions. Name achievements the way a player would read them.

**Don't:** Keep achievements only on the device, where they are lost on another browser. Promise achievements in the description that the game does not declare.

**Recommendation, checked:** deploy_preview refuses an invalid list; game_standards check notes achievement code with none declared.

More: [services.md#achievements](/guides/services.md#achievements)

<a id="splash-loading"></a>

### Platform splash and the loading screen

**Where:** Between Play and the first playable frame.

- The platform's splash covers the page first, then fades into the game's own loading screen: after the second GCP.progress() call once the page stops changing for 0.25 s, else at GCP.ready(), at the latest 6 s (12 s for a game that has not called GCP.progress() twice).
- A title picture (key art, title image) is loaded before GCP.ready(); while it downloads the game draws its loading screen or a plain backdrop.
- Draw the loading screen at once, set its text, language and font before the second GCP.progress() call, then only move the bar.

**Do:** Call GCP.progress(f, label) while loading and GCP.ready() after the first playable frame.

**Don't:** Draw a platform logo or a second splash. Show a blank page, a stand-in font or text still being filled in. Draw a code-drawn or older title while a new title picture downloads: players see the old cover, then the new one, on every launch. Remove the old drawing when you replace the picture, and give the new file a new name.

**Required (platform requirement, publish refuses without it):** GCP.ready() once the first playable frame is drawn, within the time verification allows (the boots check). How the loading screen looks and how often it calls GCP.progress() are recommendations.

**Recommended, and checked:** boots check (GCP.ready() in time). Verification counts the GCP.progress() calls before GCP.ready(); game_standards check and publish warn when there are fewer than two (the splash then waits for GCP.ready(), up to 12 s). game_standards check warns when the title screen draws a code-drawn stand-in while its title picture loads.

More: [platform-contract.md#the-platform-splash-before-your-loading-screen](/guides/platform-contract.md#the-platform-splash-before-your-loading-screen)

<a id="menu-button"></a>

### The platform menu button

**Where:** Over the game whenever it plays: in its window on the page and in fullscreen, in the browser and the installed app.

- A 40 px round button sits 8 px in from the safe edge, in the top-left corner unless the game asks for another.
- It fades to 16% after 5 s; the player can drag it anywhere, and the spot is kept per game and orientation. A trial clock may sit beside it.
- For the first 3 plays on a device a short tip (up to 440 px wide) shows at top centre for 5 s; taps go through it.
- It is always there and always on top: the game is a frame under it and cannot paint over it, take fullscreen for itself or hide it. exitButton: 'none' is taken as the top-left corner.
- Its corner is not reserved: it floats over the game, faded, and a player it is in the way of drags it aside. Lay the interface out for the game alone and use the whole safe area, top corners included.
- GCP.setDisplay({ exitButton: 'top-right' | 'bottom-left' | 'bottom-right' }) picks the corner it starts in, if another suits the game better.

**Do:** Lay out the HUD for the game itself, inside the safe area; the top corners are yours.

**Don't:** Move the HUD aside for the button or leave a corner empty for it. Count on hiding it: exitButton 'none' does not.

**Recommendation, checked:** Not checked: the button never needs room from the game.

More: [standards.md#menu-button](/guides/standards.md#menu-button)

<a id="safe-area"></a>

### Safe areas: notch, rounded corners, home bar

**Where:** Fullscreen on phones and tablets.

- In fullscreen the game fills the whole screen edge to edge, under the notch, camera hole, rounded corners and home indicator.
- The insets are GCP.display.safe ({ top, right, bottom, left } in CSS px) and the CSS variables --gcp-safe-top, -right, -bottom, -left; GCP.ui.rect anchors inside them by default.
- Draw the world to the edges; keep buttons, text and HUD inside the insets. On a phone in landscape keep nothing important in the bottom 20 px.
- GCP.setDisplay({ edgeToEdge: false }) keeps the game inside them with black bars instead.
- A bar on an edge (an experience bar, a toolbar, a top HUD strip) sits flush on the screen edge: its background runs through the inset to the edge (GCP.ui.rect(...).bleed), and only its text, icons and buttons stay inside the safe area. Never leave a strip of the world between an edge bar and the screen edge, and never move the whole bar up by the inset. The anchor rules are the ui-layout standard.

**Do:** Use max(env(safe-area-inset-left, 0px), var(--gcp-safe-left, 0px)) in CSS, or GCP.ui.rect for canvas layouts.

**Don't:** Assume the frame is already inside the notch.

**Recommendation, checked:** Verification tells the game it is in fullscreen on an iPhone (insets 47 / 47 / 21 sideways, 47 / 0 / 34 upright) and reads its interface layer: interface drawn under the notch or the home bar is reported, and game_standards check and publish warn about it. game_standards check also warns when a game for phones never reads the insets in its code.

![Safe areas: notch, rounded corners, home bar template](/guides/safe-area-template.png)

More: [input.md#phones-and-tablets](/guides/input.md#phones-and-tablets)

<a id="touch-controls"></a>

### The platform's on-screen controls

**Where:** Phones and tablets, for games without touch controls of their own.

- A stick zone in the bottom-left corner, 18 px plus the safe inset from the edges, up to 42% of the width and 62% of the height.
- Up to 6 round buttons in the bottom-right corner, the same distance from the edges.
- They show only when the game has keys to press and no touch controls of its own, and hide while the game is paused. gcp.json "controls" or GCP.controls choose them; "touch": "none" turns them off.

**Do:** Keep the bottom-left and bottom-right corners free of HUD when they show. Better: make touch controls of your own and declare touch in requirements.input.

**Don't:** Show keyboard hints ("Space to jump") on touch screens.

**Required (platform requirement, publish refuses without it):** The game is playable by touch on phones and tablets (release rule every_device): with touch controls of its own (declare touch in requirements.input), or with the platform's on-screen controls pressing its keys (leave gcp.json "controls" touch on). Which of the two, and how its own controls look and where they sit, is the game's design choice.

**Recommended, and checked:** Not checked: look at the preview with debug_preview on a phone viewport.

![The platform's on-screen controls template](/guides/safe-area-template.png)

More: [input.md#phones-and-tablets](/guides/input.md#phones-and-tablets)

<a id="ui-layout"></a>

### Interface layout: anchors, offsets and stretch

**Where:** Every interface element of the game (HUD, menus, dialogs, buttons, bars, toasts), at every screen size, aspect ratio and orientation, in a window and in fullscreen.

- Recommended: lay out every interface element by anchors, as Unity's RectTransform and Godot's Control do: GCP.ui.rect({ anchor, w, h, margin, pivot, offset, minW, maxW, aspect, id }, parent?). Never by absolute pixel positions from a design size, and never by positions measured once at start.
- Anchors: a corner (top-left, top-right, bottom-left, bottom-right), an edge middle (top, bottom, left, right) or the center places a fixed-size box against that point; a wide anchor (top-wide, bottom-wide, left-wide, right-wide, hcenter-wide, vcenter-wide, full) or [left, top, right, bottom] fractions of the parent stretches the box between two points. margin keeps room from the anchored edges, offset nudges, pivot is the point of the box that sits on the anchor, minW / maxW / minH / maxH and aspect bound a stretched box.
- Choose the anchor from what the element belongs to: status and resources to a top corner, the timer or wave to the top edge, the primary action to a bottom corner within thumb reach, an experience or progress bar to the bottom or top edge, stretched across, dialogs and the pause menu to the center with maxW and maxH, toasts to an edge. Never anchor a corner element to the center or position it as a fraction of a design size.
- Parents: lay a group out inside its panel with rect(spec, panelBox) and GCP.ui.split(box, "row" | "column", items, gap) (HBox and VBox), so the group moves and stretches with the panel. A child never pokes out of its parent.
- The parent of a top-level element is the view inside the safe area (GCP.ui.view minus GCP.ui.safe). Edge bars sit flush on the screen edge: draw their background from box.bleed (carried through the inset to the edge) and their text, icons and buttons in the box itself. Nothing floats a fixed distance above the bottom because of an inset that is not there.
- Size in interface units: GCP.ui.configure({ reference, match, minView }) once; GCP.ui.scale turns units into CSS pixels on this screen, times the player's Interface size. The view grows along the long side: a 21:9 phone has more width, a portrait phone more height, and the layout fills it from the anchors, never by stretching the art.
- Lay out again on every GCP.ui.onChange (resize, turning the device, fullscreen, the browser bars, the player's size), or simply every frame, and draw from the boxes you just placed.
- No two elements on the same layer overlap, at any size: when they would (a narrow portrait phone, a large Interface size), the layout switches (wrap a row into two, move secondary items to another edge, shorten labels, hide what is not needed) rather than letting them collide. Text fits its box at every size and language. Tap targets are at least 44 CSS px.
- Give every element an id (and a layer for what draws over the HUD: menu, modal, toast): rect({ id: "coins", layer: "hud", ... }). The verifier reads the boxes (GCP.ui.layout()) at every size it plays the game at and reports elements off the screen, under the notch or the home bar, and overlapping on one layer.

**Do:** Check with debug_preview at 390x844, 844x390, 1180x820, 960x540 and 1920x1080 (plus 2560x1080 for ultrawide), and with Interface size at 150%: call GCP.ui.layout() in a state step to see every box. Draw edge bars with box.bleed for the background and box for the content. Prefer stretch anchors with minW / maxW over fixed widths for bars, panels and rows of buttons.

**Don't:** Place interface at absolute coordinates of the reference size (x = 1180) or at a fraction of it computed once. Add the safe inset to an element that already sits inside the safe area, or move a whole edge bar up by the inset (it leaves a strip of the world under it in fullscreen). Let a corner panel and a centered or edge element share the same space on narrow screens.

**Recommendation, checked:** game_standards check and deploy_preview warn when the game never reads the screen size, and note a game that places interface with GCP.ui.rect but gives no element an id. Verification reads the boxes placed with an id on the computer (960x540) and on every phone and tablet pass (sideways and, for a game that plays both ways, upright) and warns about each element off the screen, under the notch or the home bar, or overlapping another on the same layer, naming the elements and the screen size.

More: [standards.md#ui-layout](/guides/standards.md#ui-layout)

<a id="window-orientation"></a>

### Window size

**Where:** The game page and the console preview; fullscreen on every device.

- In a window the game gets a 16:9 frame of at most 1056x594 CSS px (scaled down, never smaller, on a small page). Fullscreen gives it the whole screen at any shape.
- Size from innerWidth and innerHeight on every resize, never from the first size.
- Which way up the game is played is its own standard: orientation.

**Do:** Handle a resize at any time: entering fullscreen, turning the device, the browser bars coming and going.

**Don't:** Hard-code 16:9 or the window size.

**Recommendation, checked:** Device checks note a canvas that does not fit the screen or covers under 30% of it.

More: [standards.md#window-orientation](/guides/standards.md#window-orientation)

<a id="orientation"></a>

### Orientation: landscape, portrait or both

**Where:** Phones and tablets, fullscreen and the installed app; the store page's Compatibility section.

- Which way up the game is played is the game's own design decision: landscape only, portrait only and both are all fine, and the platform never requires one. What the platform requires is that the game plays on computers, tablets and phones (release rule every_device), held the way it declares.
- Declare which way up the game is played, in gcp.json requirements.orientation (compatibility {action: "declare"}): "landscape", "portrait" or "both" ("any" means both). Declare the shapes the interface is designed for, not the ones it merely survives. Without a declaration the platform assumes both.
- landscape or portrait (one orientation): the platform locks the screen to it where the browser allows (Android in fullscreen). Where it cannot (iPhone, iPad, a locked rotation), the platform itself covers the game with a rotate-your-device prompt while the device is held the other way, pauses the game behind it, and lifts it as soon as the device is turned. The game does not draw a prompt of its own and needs no layout for the other orientation.
- A one-orientation game still survives the other shape without breaking: the player can dismiss the prompt ("Play this way") and the computer window is always 16:9. Then fit the game to the window whole (letterbox or pillarbox the designed shape, never crop the interface) and keep running.
- landscape: design for aspect ratios from 4:3 (iPad, 1.33) to about 21:9 (phones, 2.17). Keep HUD on the edges and corners, controls in the bottom corners, and nothing important in the bottom 20 px on a phone (the home bar).
- portrait: design for 9:21 (phones) to 3:4 (iPad). On a computer the 16:9 window shows a centred column: fill the sides with the world or a backdrop, never stretch.
- both: give the interface a real layout for each shape, chosen from innerWidth > innerHeight on every resize, never once at start. Turning the device mid-game keeps all state (no restart, no reload, no lost menu) and relays out within one frame. Portrait is not landscape shrunk: stack top-bar items into rows or move secondary ones to the bottom, make primary menu buttons full-width in one column, keep thumb controls in the bottom third, and size text and buttons from the short side (GCP.ui does this).
- In every orientation: no two interface elements overlap, no text is cut off or runs outside its box, tap targets are at least 44 CSS px, and everything stays inside the safe area (GCP.display.safe). GCP.display.orientation tells the game what was declared, or what GCP.setDisplay({ orientation }) chose at run time.

**Do:** Check each declared orientation with debug_preview: phone-portrait (390x844) and phone-landscape (844x390), and an iPad shape, on every screen (title, menus, play, pause, results). For both: rotate mid-run in debug_preview and confirm the game carries on where it was. Re-anchor the HUD from GCP.ui.rect on every GCP.ui.onChange or resize.

**Don't:** Draw your own "rotate your device" screen: the platform shows one, and two prompts fight. Declare "both" for a game whose portrait view is a squeezed landscape layout. Read the orientation once at start, or reload the game on a turn. Call screen.orientation.lock() yourself: in a frame it only asks the platform, which already locks to the declaration.

**Recommendation, checked:** game_standards check and deploy_preview warn when the game declares no orientation, when GCP.setDisplay({ orientation }) in the code disagrees with the declaration, and when the code draws its own rotate prompt. Verification plays a "both" game on the iPhone held both ways (an extra upright pass) and checks the reserved zones in each; a game for phones that breaks upright fails that pass, interface under the notch or home bar upright is reported, and so is a canvas that stops fitting the screen after the phone is turned.

More: [standards.md#orientation](/guides/standards.md#orientation)

<a id="interface-scale"></a>

### Interface scale and the player's UI size

**Where:** Every screen from a phone to a 4K monitor; the platform menu's Interface size row.

- GCP.ui.configure({ reference: [1280, 720] }) once, draw the interface in units at GCP.ui.scale, place boxes with GCP.ui.rect, and offer Interface size (GCP.ui.sizes, 80% to 150%).
- Text at least about 11 CSS px, tap targets at least 44 CSS px.

**Do:** Redraw on GCP.ui.onChange.

**Don't:** Scale the interface with the window by hand in a way the player cannot change.

**Recommendation, checked:** device checks note text under 9 px and buttons under 20 px.

More: [services.md#interface-scale-and-the-players-ui-size](/guides/services.md#interface-scale-and-the-players-ui-size)

<a id="quality"></a>

### Quality settings

**Where:** The game's own settings; the platform has no quality setting.

- Offer low, medium and high, pick a default from the device (GCP.device), remember the choice with GCP.save or localStorage, and step down while the frame rate stays low.
- The platform already caps devicePixelRatio at 2 on phones and tablets.

**Do:** Draw at full quality when GCP.portrait is true (the store screenshot).

**Don't:** Start phones on the highest setting.

**Recommendation, checked:** Not checked.

More: [services.md#display-fullscreen-and-devices](/guides/services.md#display-fullscreen-and-devices)

<a id="intended-sound"></a>

### Intended sound plays correctly

**Where:** Wherever the game is designed to have sound: the title, menus, lobby, play or results, as the game chooses. A screen meant to be quiet may stay quiet.

- Every sound the game is designed to play actually plays, at the volume intended. If the title or a menu is meant to have music, it is audible as soon as the player enters the game, or on their first interaction where the browser holds sound back (Safari, iPhone, iPad): never silent because of an unlock bug or a volume mistake.
- Make the AudioContext (or start the sound library) while the game boots, not inside a gesture. The player started the game with a click on the platform page and the game frame has autoplay, so where the browser allows it the sound plays at once.
- Wake it on the first gesture from window listeners in the capture phase, added before the interface adds its own: pointerdown, pointerup, click and keydown. iPhone and iPad do not count pointerdown from a finger, and canvas interfaces stop presses on their buttons, so a bubble listener never hears a tap on a menu button and the game stays silent until some other press. The runtime also resumes every context the game made on each pointerup, touchend, click, mousedown and keydown (fix "audio-unlock"), so a context made at boot always wakes on the first tap. Leave touchend listeners to the runtime: a "touchend" in the game's code tells the platform the game has touch controls of its own, which hides the on-screen controls.
- Play nothing while the context is not running (no effects queued up to burst out on the first tap), and resume after an iPhone interruption ("interrupted": a call, the lock screen) on the next gesture.
- Mix so intended sound is heard: music meant for a menu should not sit so far under play (more than about 10 dB) that the menu seems silent, and each screen plays the music meant for it (no battle drums left running on a calm menu).
- The platform suspends every context while its menu or a card is over the game, and while the tab is hidden, then starts exactly those again (fix "pause-audio"). A game's own pause menu suspends its own sound, and a gesture on that menu must not resume it. No sound shipped only as Ogg: older iPhones cannot play it (deploy_preview warns).

**Do:** Decide which screens have sound, then check each of them from a fresh load with no key pressed: on a computer it should play at once, on an iPhone after the first tap on any button. Give the player music and effects volumes and remember them.

**Don't:** Start sound only from a press on the game world or from the first key. Create the AudioContext only when play starts, or only inside a gesture listener that the interface can stop.

**Recommendation, checked:** game_standards check and deploy_preview warn when the game starts its sound from a window gesture listener in the bubble phase: an interface that stops presses keeps it from ever running, so sound meant for the menus never plays. Whether a screen should have sound is the game's choice and is not checked.

More: [standards.md#intended-sound](/guides/standards.md#intended-sound)

<a id="capture-hooks"></a>

### Capture and state hooks

**Where:** The creator's feedback screenshots and debug_preview.

- Draw everything in canvases (text fields aside) and register GCP.test.onCapture(() => canvas or [canvases]) and GCP.test.onState(() => where the game is).

**Do:** Return the canvases bottom to top.

**Don't:** Paint page elements over the game.

**Recommendation, checked:** Advice only: verification reports a game without the hooks, or with page elements over the game, in its capture check and notes; it never stops the version.

More: [platform-contract.md#hand-over-the-frame](/guides/platform-contract.md#hand-over-the-frame)

<a id="bot-hook"></a>

### Bot hook for online games

**Where:** Test bots in the preview.

- Recommended for every online game, so the creator can test it with bots: ship server/bot.js with think/actions for matches, room() for GCP.room games, invite() for room games that invite friends. The platform does connecting, matchmaking and invites; the bot does the game's own moves.

**Do:** Test with preview_bots before publishing.

**Don't:** Leave a hook out for a mode the game has.

**Recommendation, checked:** deploy_preview and publish warn when an online game has no server/bot.js or misses a hook it needs.

More: [test-bots.md](/guides/test-bots.md)

<a id="friends-ui"></a>

### Friends picker and pop-ups

**Where:** Drawn by the platform over the game.

- GCP.friends.open({ match }) opens the platform's friends panel with the invite picker over the game; the game keeps running under it.
- Friend pop-ups (requests, invites, a friend joining) appear at the top right, up to 360 px wide and 14 px from the top (full width at the top on phones), for about 6 s.
- Players play together through invites: never ask them to type or share a room code.

**Do:** Hold a lobby or menu state while the picker is open, and show who joined. Keep nothing the player must read in the top-right corner for long.

**Don't:** Build your own friends list, chat or code entry.

**Recommendation, checked:** Not checked.

More: [services.md#friends-invites-and-presence](/guides/services.md#friends-invites-and-presence)

<a id="localization"></a>

### Languages in the game

**Where:** The game itself, and every listing surface.

- Read GCP.lang at start and open in it when the game has that language; GCP.onLang(fn) for a switch mid-game (the game is never restarted).
- For every platform language the game declares, give the listing (title, tagline, description, controls) and a cover with words in that language.

**Do:** Use the names the game itself uses in each language.

**Don't:** Override a language the player picked in the game's own settings.

**Required (platform requirement, publish refuses without it):** The listing in every platform language the game declares (release rule listing_languages). Which languages the game itself offers is its own choice.

**Recommended, and checked:** publish refuses a version whose listing misses one of its languages; metadata warns when GCP.lang is never read.

More: [game-metadata.md#languages](/guides/game-metadata.md#languages)
