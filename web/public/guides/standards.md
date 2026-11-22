# Game standards

<!-- Generated from src/standards.js by scripts/standards-guide.mjs. Edit the registry, not this file. -->

Everything a game or its agent provides, as the platform shows it: where each thing appears, its exact sizes and limits, what to do and not do, and what the platform checks. The platform sets these standards; the agent carries them out.

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
| [Achievements](#no-achievements) | What the platform does not take | game_standards check |
| [Platform splash and the loading screen](#splash-loading) | While the game plays | game_standards check |
| [The platform menu button](#menu-button) | While the game plays | game_standards check |
| [Safe areas: notch, rounded corners, home bar](#safe-area) | While the game plays | game_standards check |
| [The platform's on-screen controls](#touch-controls) | While the game plays | by looking |
| [Window size and orientation](#window-orientation) | While the game plays | game_standards check |
| [Interface scale and the player's UI size](#interface-scale) | While the game plays | platform |
| [Quality settings](#quality) | While the game plays | by looking |
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

**Checked:** update_project answers with cover_check (size and shape); game_standards check and publish warn when there is no cover (the store then crops the verification screenshot). The composition inside the safe area is yours to check by looking at the template.

![Cover image template](/guides/cover-template.png)

More: [game-metadata.md#cover-image](/guides/game-metadata.md#cover-image)

<a id="cover-languages"></a>

### A cover per language

**Where:** Every place the cover appears, in the player's platform language.

- A cover that shows words (the title) needs one cover per listing language with those words in it: update_project covers {zh, zh-TW, ja, ko, es}.
- A language without its own cover shows the main cover.

**Do:** Keep the cover free of words if you will not make one per language.

**Don't:** Machine-translate the game's own name when the game keeps it in one language.

**Checked:** publish refuses a version played in a platform language its listing lacks (rule listing_languages).

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

**Checked:** Not checked. Look at the cover cropped to 16:10 with those corners covered.

More: [standards.md#card-overlays](/guides/standards.md#card-overlays)

<a id="title"></a>

### Game title

**Where:** The home banner (40 to 80 px), the game page heading (42 to 90 px), cards (17 px), search, the library, friends' lists and invites.

- At most 80 characters (per language).
- The banner and the game page set it in the platform's condensed display face in CAPITALS, and break it anywhere when a word does not fit.
- About 30 Latin characters or 14 Chinese, Japanese or Korean characters fit on two banner lines; longer titles take three or more.

**Do:** Use the name the game shows on its title screen. Put a subtitle in the tagline, not the title.

**Don't:** Rely on letter case (it is shown in capitals). Add the platform's or the operator's name. Add emoji or decorative symbols.

**Checked:** Over the limit is refused. game_standards check notes a title too long for the banner.

More: [standards.md#title](/guides/standards.md#title)

<a id="tagline"></a>

### Tagline

**Where:** Under the title in the home banner (cut after 2 lines), on cards and in search.

- At most 140 characters, but only about 80 Latin characters (or 36 Chinese, Japanese or Korean) show in the banner on a phone before it is cut.
- A tagline that only repeats the title is hidden everywhere.
- One sentence that says what the player does, in the listing's language.

**Do:** Lead with the verb or the hook: "Guide a lantern through a drowned city."

**Don't:** Repeat the title. Use the space for genre words the tags already show. Use quotes, emoji or ALL CAPS.

**Checked:** Over the limit is refused. game_standards check, deploy_preview and publish warn about a repeated title and a tagline cut in the banner.

More: [standards.md#tagline](/guides/standards.md#tagline)

<a id="description"></a>

### Description

**Where:** The game page, in a column of about 72 characters.

- At most 5000 characters (per language).
- Plain text: line breaks are kept and blank lines make paragraphs. Markdown is NOT rendered, so **bold**, # headings and [links](…) show as typed.
- A list is lines that start with "· " or "- ".

**Do:** Open with what makes the game worth playing, then how a session goes, then modes and length. Two to five short paragraphs.

**Don't:** Markdown, HTML or links. Controls (they have their own field). Prices, sales or other games.

**Checked:** Over the limit is refused. game_standards check, deploy_preview and publish warn about Markdown.

More: [standards.md#description](/guides/standards.md#description)

<a id="controls-text"></a>

### Controls text

**Where:** The Controls box on the game page, beside the description.

- At most 1000 characters. Plain text like the description, one control per line: "WASD or arrows · move".
- Cover keyboard, mouse, touch and gamepad if the game supports them.

**Do:** Name keys by what is printed on them.

**Don't:** Markdown or tables.

**Checked:** game_standards check warns about Markdown and notes a game with keys but no controls text.

More: [standards.md#controls-text](/guides/standards.md#controls-text)

<a id="genre-tags"></a>

### Genre and tags

**Where:** Store filters, category and tag pages, search, "more like this".

- One genre from the fixed list, up to two secondary genres, and 2 to 8 tags from the platform list only.

**Do:** Pick the tags a player would filter by.

**Don't:** Invent tags; anything off the list is refused.

**Checked:** publish refuses a version without genre and at least 2 tags.

More: [game-metadata.md#tags](/guides/game-metadata.md#tags)

<a id="screenshot"></a>

### Screenshots

**Where:** The game page shows the verification picture of the live version; it is the cover too when there is none.

- The platform takes it: after the checks it loads the game once more at 960x540 with ?gcp_portrait=1 (GCP.portrait is true) and photographs the first view after loading.
- There is no upload for screenshots. GCP.test.onAutostart decides what that first view is.

**Do:** Draw at full quality when GCP.portrait is true, however slow the frame. Make the first view after onAutostart a good-looking moment of play.

**Don't:** Make screenshot files for the store: nothing shows them.

**Checked:** Taken by the platform at every verification.

More: [platform-contract.md#the-screenshot](/guides/platform-contract.md#the-screenshot)

<a id="badges"></a>

### Store badges

**Where:** The age rating badge, sale price, verdict, rarity, live count and 18+ label.

- All drawn by the platform from the metadata, sales and play data. There is nothing to make.

**Do:** Declare content descriptors honestly: the age badge comes from them.

**Don't:** Draw badges, ratings or prices into the cover or the game.

**Checked:** Generated.

More: [game-metadata.md#content-descriptors-and-the-age-rating](/guides/game-metadata.md#content-descriptors-and-the-age-rating)

## What the platform does not take

<a id="no-trailer"></a>

### Trailers and video

**Where:** Nowhere: the store has no video slot.

- Do not make a trailer for the store. Video in the bundle counts against the game's storage.

**Do:** Spend the effort on the cover and the first view of play.

**Don't:** Ship trailer files in the bundle.

**Checked:** game_standards check notes video files in the bundle.

More: [standards.md#no-trailer](/guides/standards.md#no-trailer)

<a id="no-icons"></a>

### Icons, logos and title art

**Where:** Nowhere: there is no icon, favicon or logo slot. Where a store shows an icon, this one shows the cover, cropped to 16:10, as small as 64 px wide (search suggestions, "since you were away"). The title is set in text by the store; the Home Screen icon is the platform's.

- The cover is the game's icon: its main subject must still read at 64 px wide, so keep it large and simple inside the cover's safe area.
- Put the game's logo or title art on the cover and the game's own title screen only.
- Do not draw the platform's logo (HearthCade) anywhere: the platform shows its own splash.

**Do:** Keep title art inside the cover's safe area.

**Don't:** Ship icon sets, favicons or manifest icons for the store.

**Checked:** game_standards check warns when the game draws the platform's name, and notes icon files.

More: [standards.md#no-icons](/guides/standards.md#no-icons)

<a id="no-achievements"></a>

### Achievements

**Where:** Nowhere: there is no achievements service or page.

- Track milestones with GCP.playerStats (players see them on the game page) and show them in the game's own interface.

**Do:** Name stats the way a player would read them.

**Don't:** Promise platform achievements in the description.

**Checked:** game_standards check notes achievement code without player stats.

More: [services.md#what-the-platform-does-not-provide](/guides/services.md#what-the-platform-does-not-provide)

## While the game plays

<a id="splash-loading"></a>

### Platform splash and the loading screen

**Where:** Between Play and the first playable frame.

- The platform's splash covers the page first, then fades into the game's own loading screen: after the second GCP.progress() call once the page stops changing for 0.25 s, else 1.2 s, else at GCP.ready(), at the latest 6 s.
- Draw the loading screen at once, set its text, language and font before the second GCP.progress() call, then only move the bar.

**Do:** Call GCP.progress(f, label) while loading and GCP.ready() after the first playable frame.

**Don't:** Draw a platform logo or a second splash. Show a blank page, a stand-in font or text still being filled in.

**Checked:** boots check (GCP.ready() in time). Verification counts the GCP.progress() calls before GCP.ready(); game_standards check and publish warn when there are fewer than two (the splash then waits 1.2 s and may hand over to a half-drawn screen).

More: [platform-contract.md#the-platform-splash-before-your-loading-screen](/guides/platform-contract.md#the-platform-splash-before-your-loading-screen)

<a id="menu-button"></a>

### The platform menu button

**Where:** Over the game in fullscreen and on phones.

- A 40 px round button sits 8 px in from the safe edge, in the top-left corner unless the game asks for another.
- It fades to 16% after 5 s; the player can drag it anywhere. A trial clock may sit beside it.
- For the first 3 plays on a device a short tip (up to 440 px wide) shows at top centre for 5 s; taps go through it.
- Move it with GCP.setDisplay({ exitButton: 'top-right' | 'bottom-left' | 'bottom-right' }), or hide it with exitButton: 'none' when the game's own pause menu has a Quit button that calls GCP.quit() and Esc / Back reach that menu (GCP.pauseMenu).

**Do:** Keep a 56 px square free in the chosen corner, inside the safe area. Choose the corner where your HUD has nothing.

**Don't:** Put a pause, score or health widget under the button. Hide it without a Quit of your own.

**Checked:** Verification opens the game on a phone in fullscreen and reads the interface layer GCP.test.onCapture hands over (return [world, ui]): interface drawn in the button's square is reported, and game_standards check and publish warn about it. A game that hands over one canvas cannot be checked and is told so.

More: [standards.md#menu-button](/guides/standards.md#menu-button)

<a id="safe-area"></a>

### Safe areas: notch, rounded corners, home bar

**Where:** Fullscreen on phones and tablets.

- In fullscreen the game fills the whole screen edge to edge, under the notch, camera hole, rounded corners and home indicator.
- The insets are GCP.display.safe ({ top, right, bottom, left } in CSS px) and the CSS variables --gcp-safe-top, -right, -bottom, -left; GCP.ui.rect anchors inside them by default.
- Draw the world to the edges; keep buttons, text and HUD inside the insets. On a phone in landscape keep nothing important in the bottom 20 px.
- GCP.setDisplay({ edgeToEdge: false }) keeps the game inside them with black bars instead.

**Do:** Use max(env(safe-area-inset-left, 0px), var(--gcp-safe-left, 0px)) in CSS, or GCP.ui.rect for canvas layouts.

**Don't:** Assume the frame is already inside the notch.

**Checked:** Verification tells the game it is in fullscreen on an iPhone (insets 47 / 47 / 21 sideways, 47 / 0 / 34 upright) and reads its interface layer: interface drawn under the notch or the home bar is reported, and game_standards check and publish warn about it. game_standards check also warns when a game for phones never reads the insets in its code.

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

**Checked:** Not checked: look at the preview with debug_preview on a phone viewport.

![The platform's on-screen controls template](/guides/safe-area-template.png)

More: [input.md#phones-and-tablets](/guides/input.md#phones-and-tablets)

<a id="window-orientation"></a>

### Window size and orientation

**Where:** The game page and the console preview; fullscreen on every device.

- In a window the game gets a 16:9 frame of at most 1056x594 CSS px (scaled down, never smaller, on a small page). Fullscreen gives it the whole screen at any shape.
- Size from innerWidth and innerHeight on every resize, never from the first size.
- Declare orientation (requirements.orientation or GCP.setDisplay({ orientation })) for a game made for phones: the screen is locked to it where the browser allows, otherwise the player is asked to turn the phone.

**Do:** Lay out for both shapes anyway: a resize can come at any time.

**Don't:** Hard-code 16:9 or the window size.

**Checked:** game_standards check warns when a game for phones declares no orientation.

More: [services.md#display-fullscreen-and-devices](/guides/services.md#display-fullscreen-and-devices)

<a id="interface-scale"></a>

### Interface scale and the player's UI size

**Where:** Every screen from a phone to a 4K monitor; the platform menu's Interface size row.

- GCP.ui.configure({ reference: [1280, 720] }) once, draw the interface in units at GCP.ui.scale, place boxes with GCP.ui.rect, and offer Interface size (GCP.ui.sizes, 80% to 150%).
- Text at least about 11 CSS px, tap targets at least 44 CSS px.

**Do:** Redraw on GCP.ui.onChange.

**Don't:** Scale the interface with the window by hand in a way the player cannot change.

**Checked:** device checks note text under 9 px and buttons under 20 px.

More: [services.md#interface-scale-and-the-players-ui-size](/guides/services.md#interface-scale-and-the-players-ui-size)

<a id="quality"></a>

### Quality settings

**Where:** The game's own settings; the platform has no quality setting.

- Offer low, medium and high, pick a default from the device (GCP.device), remember the choice with GCP.save or localStorage, and step down while the frame rate stays low.
- The platform already caps devicePixelRatio at 2 on phones and tablets.

**Do:** Draw at full quality when GCP.portrait is true (the store screenshot).

**Don't:** Start phones on the highest setting.

**Checked:** Not checked.

More: [performance.md#quality-levels](/guides/performance.md#quality-levels)

<a id="capture-hooks"></a>

### Capture and state hooks

**Where:** The creator's feedback screenshots and debug_preview.

- Draw everything in canvases (text fields aside) and register GCP.test.onCapture(() => canvas or [canvases]) and GCP.test.onState(() => where the game is).

**Do:** Return the canvases bottom to top.

**Don't:** Paint page elements over the game.

**Checked:** The capture check fails a version without the hooks or with page elements over the game.

More: [platform-contract.md#hand-over-the-frame](/guides/platform-contract.md#hand-over-the-frame)

<a id="bot-hook"></a>

### Bot hook for online games

**Where:** Test bots in the preview.

- Every online game ships server/bot.js: think/actions for matches, room() for GCP.room games, invite() for room games that invite friends. The platform does connecting, matchmaking and invites; the bot does the game's own moves.

**Do:** Test with preview_bots before publishing.

**Don't:** Leave a hook out for a mode the game has.

**Checked:** deploy_preview and publish warn when an online game has no server/bot.js or misses a hook it needs.

More: [test-bots.md](/guides/test-bots.md)

<a id="friends-ui"></a>

### Friends picker and pop-ups

**Where:** Drawn by the platform over the game.

- GCP.friends.open({ match }) opens the platform's friends panel with the invite picker over the game; the game keeps running under it.
- Friend pop-ups (requests, invites, a friend joining) appear at the top right, up to 360 px wide and 14 px from the top (full width at the top on phones), for about 6 s.
- Players play together through invites: never ask them to type or share a room code.

**Do:** Hold a lobby or menu state while the picker is open, and show who joined. Keep nothing the player must read in the top-right corner for long.

**Don't:** Build your own friends list, chat or code entry.

**Checked:** Not checked.

More: [services.md#friends-invites-and-presence](/guides/services.md#friends-invites-and-presence)

<a id="localization"></a>

### Languages in the game

**Where:** The game itself, and every listing surface.

- Read GCP.lang at start and open in it when the game has that language; GCP.onLang(fn) for a switch mid-game (the game is never restarted).
- For every platform language the game declares, give the listing (title, tagline, description, controls) and a cover with words in that language.

**Do:** Use the names the game itself uses in each language.

**Don't:** Override a language the player picked in the game's own settings.

**Checked:** publish refuses a version whose listing misses one of its languages; metadata warns when GCP.lang is never read.

More: [game-metadata.md#languages](/guides/game-metadata.md#languages)
