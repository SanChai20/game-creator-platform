# Game metadata

Every game on the platform describes itself the same way, so its store page can tell a player, before they press Play, what kind of game it is, who it is for, whether it runs on their device and whether it speaks their language. This guide is the specification: every field, the values it accepts, where it is stored, what the platform detects by itself, and what the store page shows.

The short version for an agent: call `game_metadata` with `action: "check"`. It returns a numbered checklist with what is still missing, the values each field accepts and a ready-made `declare` call pre-filled from what the platform detected in the code. Fix each step with `game_metadata` `action: "declare"`, deploy a preview, and publish. Publishing is refused until the six required fields are on record.

## Where metadata lives

Metadata comes in two kinds, stored in two places.

| Kind | Fields | Stored in | Takes effect |
|---|---|---|---|
| **Listing** (about the project) | `genre`, `genres`, `tags`, `title`, `tagline`, `description`, `controls`, `listing_language`, `listing_translations`, and the cover and a cover per language (`update_project` `cover`, `covers`) | the project | at once, on every version |
| **Build** (about one version) | `requirements`, `languages`, `players`, `session_minutes`, `progress`, `accessibility`, `content` | `gcp.json` in the workspace | frozen with the next `deploy_preview`; the store shows the live version's |

Build metadata is versioned with the code on purpose: a version that adds Japanese or online co-op declares it in the same deploy, and a rollback brings back the metadata that matched that code.

`game_metadata` `declare` writes both kinds in one call: listing fields go to the project, build fields into `gcp.json`. Anything not named in a call is left as it is, and `null` removes a field.

## Required to publish

| # | Field | Why it is required |
|---|---|---|
| 1 | `genre` | The store's categories, search and "more like this" |
| 2 | `tags` (2 to 8 from the platform list) | The store's filters, tag pages and search |
| 3 | `requirements` | The Compatibility section and the check before launch |
| 4 | `languages` | The Languages section and the "in your language" check |
| 5 | `players` | How many people play, and how |
| 6 | `content` | The platform's age rating |

A game played in more than one platform language also needs its store listing in each of them (see [The store listing in every language](#the-store-listing-in-every-language)); `publish` answers `409 listing_untranslated` otherwise.

The others are recommended: they fill the At a glance panel. When a required field is missing, `publish` answers `409 metadata_incomplete` with the missing steps. Rolling back to an earlier version is never blocked. An admin can turn the requirement off with the `metadata_required` setting.

## Genre

```json
{ "genre": "platformer", "genres": ["puzzle"] }
```

- `genre`: the primary genre, exactly one of: `action`, `adventure`, `arcade`, `board`, `card`, `casual`, `fighting`, `idle`, `music`, `platformer`, `puzzle`, `racing`, `rpg`, `roguelike`, `sandbox`, `shooter`, `simulation`, `sports`, `strategy`, `survival`, `tower-defense`, `word`, `horror`, `educational`.
- `genres`: up to two secondary genres from the same list.
- Common spellings are accepted and normalized (`role-playing` → `rpg`, `roguelite` → `roguelike`, `rhythm` → `music`, `clicker` → `idle`, `fps` → `shooter`, `td` → `tower-defense`).
- The genres become the project's first tags; the tags below follow them.

## Tags

```json
{ "tags": ["space", "relaxing", "physics", "pixel-art"] }
```

Tags say more about a game than its genre: where it is set, how it feels, how it plays, who it is played with and how it looks. Players filter the store by them, every tag has its own page, and search matches them. So that every game is described with the same words, **tags come only from the platform list below**. Anything else is refused, with the closest tags on the list as a hint.

- Choose **2 to 8**, the ones a player would filter by. Publishing needs at least 2.
- Genres are not tags: put them in `genre` and `genres`. A genre named in `tags` is taken as a secondary genre.
- Common spellings are accepted and mapped (`scifi` → `sci-fi`, `pixel` → `pixel-art`, `chill` → `relaxing`, `side-scroller` → `side-view`, `roguelite` → the genre `roguelike`).
- `game_metadata` `check` suggests tags it can tell from the code (`2d` for a Canvas 2D game, `first-person` for pointer lock, `short-sessions` for a short session, `multiplayer`, `co-op` or `pvp` from the declared players); the rest is the agent's choice.
- Set them with `game_metadata` `declare`, `update_project` or `create_project` (`tags`). They apply at once.

| Group | Tags |
|---|---|
| Setting and theme (`theme`) | `fantasy`, `sci-fi`, `space`, `cyberpunk`, `steampunk`, `post-apocalyptic`, `medieval`, `historical`, `mythology`, `military`, `western`, `pirates`, `ninja`, `superheroes`, `zombies`, `monsters`, `dinosaurs`, `animals`, `robots`, `aliens`, `magic`, `nature`, `ocean`, `farming`, `cooking`, `city`, `school`, `detective`, `mystery`, `dungeon`, `vehicles` |
| Mood (`mood`) | `relaxing`, `cozy`, `cute`, `funny`, `wholesome`, `family-friendly`, `dark`, `atmospheric`, `spooky`, `emotional`, `story-rich`, `fast-paced`, `challenging`, `competitive`, `satisfying` |
| Gameplay (`gameplay`) | `physics`, `procedural`, `crafting`, `building`, `base-building`, `exploration`, `open-world`, `stealth`, `turn-based`, `real-time`, `deck-building`, `match-3`, `hidden-object`, `endless`, `bullet-hell`, `hack-and-slash`, `twin-stick`, `metroidvania`, `point-and-click`, `management`, `tycoon`, `trading`, `collecting`, `upgrades`, `loot`, `permadeath`, `boss-fights`, `level-editor`, `choices-matter`, `character-customization`, `tactics`, `auto-battler`, `merge`, `logic`, `minigames`, `typing`, `drawing`, `math`, `one-button`, `short-sessions` |
| Players (`players`) | `multiplayer`, `co-op`, `pvp`, `local-multiplayer`, `asynchronous` |
| Visual style and view (`style`) | `pixel-art`, `low-poly`, `voxel`, `hand-drawn`, `cartoon`, `realistic`, `minimalist`, `retro`, `neon`, `2d`, `3d`, `isometric`, `top-down`, `side-view`, `first-person`, `third-person` |

### Tags from before the list

Games tagged before the list existed keep their genres. Their other tags were mapped to the list where the meaning is clear (`pixel` → `pixel-art`, `roguelite` → `roguelike`, `co-op` stays `co-op`) and dropped otherwise. A game left with fewer than 2 tags keeps its live version; its next publish asks for tags from the list, and `game_metadata` `check` suggests some.

## Requirements

What the game needs from the player's browser and device. The full field list is in the platform contract (`get_started` topic `contract`, "Compatibility requirements"). In short:

```json
{
  "requirements": {
    "graphics": "webgl2",
    "features": ["web-audio"],
    "optional": ["pointer-lock"],
    "input": ["keyboard", "touch"],
    "devices": ["desktop", "tablet", "mobile"],
    "orientation": "landscape"
  }
}
```

The `compatibility` tool still works and is a shortcut for this one field.

## Languages

Which languages the game is playable in, and in what form.

```json
{
  "languages": {
    "default": "en",
    "supported": [
      { "code": "en", "interface": true, "audio": true, "subtitles": true },
      { "code": "ja", "interface": true, "subtitles": true },
      { "code": "zh-Hans", "interface": true }
    ],
    "follows_platform": true,
    "notes": "Voice acting is English only."
  }
}
```

- `supported`: one entry per language, up to 60. `code` is a BCP 47 code (`en`, `ja`, `ko`, `es`, `pt-BR`, `zh-Hans` for Simplified Chinese, `zh-Hant` for Traditional Chinese; `zh-CN` and `zh-TW` are accepted and normalized). Then what is in that language:
  - `interface`: menus, HUD and in-game text (true when left out);
  - `audio`: spoken voice;
  - `subtitles`: subtitles or captions for spoken voice.
- `default`: the language the game starts in when it cannot pick one. The first entry when left out.
- `follows_platform`: true when the game opens in the player's platform language by itself (read `GCP.lang`), so they never need to change a setting.
- `notes`: anything else worth knowing, up to 300 characters.
- Shorthand: `"languages": ["en", "ja"]` means interface text in English and Japanese, English the default.
- A game with no text at all is still declared: list the language of its title screen, or `"en"` with a note such as "No text in the game".

### GCP.lang

The SDK exposes the player's platform language as `GCP.lang` (`en`, `zh`, `zh-TW`, `ja`, `ko` or `es`; the browser's language when the game runs outside the platform). Read it at startup and open in it when you have it:

```js
const pick = { zh: 'zh-Hans', 'zh-TW': 'zh-Hant' }[GCP.lang] || GCP.lang.split('-')[0];
const lang = STRINGS[pick] ? pick : 'en';
```

Declare `follows_platform: true` when the game does this.

### When the player switches language mid-game

The player can change the platform language from the page around the game at any time. The game is never reloaded or restarted for it: it keeps running, `GCP.lang` changes to the new code, and every function registered with `GCP.onLang(fn)` is called as `fn(lang, previous)`. A game that can swap its text live does it there; a game that cannot needs nothing, and opens in the new language the next time it starts (the SDK also keeps the new language in the frame's address, so a game that reloads itself opens in it).

```js
function applyLang(code) {
  const pick = { zh: 'zh-Hans', 'zh-TW': 'zh-Hant' }[code] || code.split('-')[0];
  setLanguage(STRINGS[pick] ? pick : 'en');   // the game's own: redraw menus, HUD and subtitles in that language
}
applyLang(GCP.lang);
GCP.onLang(applyLang);   // returns a function that stops listening
```

Only follow the platform language this way if the player has not picked a language in the game's own settings: a choice they made in the game wins.

### Detection

At every deploy the platform looks for languages in the code: locale files (`locales/ja.json`, `i18n/ko.json`, `lang/es/…`), the `lang` attribute of `index.html`, and the scripts in text strings (Japanese kana, Korean Hangul, Chinese, Cyrillic, Arabic and others). It also notices when the code reads `GCP.lang`. With no declaration, the store shows what was detected and says so. With one, the declaration wins and anything that disagrees is reported as a warning, for example a detected language the declaration never lists.

## The store listing in every language

A game that is played in several languages is in those languages outside the game too. The platform itself is in six languages: English (`en`), 简体中文 (`zh`), 繁體中文 (`zh-TW`), 日本語 (`ja`), 한국어 (`ko`) and Español (`es`). Everything about a game outside the game, its **name, tagline, description, controls text and cover**, follows the player's platform language on every surface: the home page and its shelves, cards, search, the game page, the library, the Continue row, the Creator Store and friends' lists and invites. When the player switches the platform language, every game switches with it, without a reload.

Which language a player sees, for each game:

1. the player's platform language, when the game is played in it (its `languages` lists it, with interface text or subtitles) and the listing has it;
2. otherwise English, when the listing has English;
3. otherwise the language the listing itself is written in (for a game in one language, that language).

So a game in English and Chinese is shown in Chinese to a player whose platform is in Simplified Chinese, and in English to a player in Japanese. A game only in Japanese is shown in Japanese to everyone.

**What an agent does.** For every platform language in the game's `languages`, give the listing in that language. `publish` checks it (release requirement `listing_languages`): a version played in a platform language the listing lacks is refused with the missing languages and fields, and the exact call to fix it. No deploy is needed for listing changes.

```json
{
  "listing_language": "en",
  "listing_translations": {
    "zh": { "title": "星之庭", "tagline": "培育小星星的解谜游戏", "description": "…", "controls": "方向键移动" },
    "ja": { "title": "星の庭", "tagline": "小さな星を育てるパズル", "description": "…", "controls": "矢印キーで移動" },
    "ko": null
  }
}
```

- `listing_language`: the language the project's own `title`, `tagline`, `description`, `controls` and `cover` are written in. When it is not set, the platform works it out from the text (Chinese, Japanese and Korean script, else English); set it when that would be wrong. Any of the six codes, or another BCP 47 code for a game listed in a language the platform does not speak.
- `listing_translations` keys: `en`, `zh` (Simplified Chinese), `zh-TW` (Traditional Chinese), `ja`, `ko`, `es`. `zh-Hans` and `zh-Hant` are accepted and stored as `zh` and `zh-TW`.
- Fields: `title` (80 characters), `tagline` (140), `description` (5000), `controls` (1000). Required for publishing in each language: the title, and the tagline and description when the listing has them. A field left out falls back to the listing as written.
- Use the names the game itself uses in that language (its title screen, characters and places), and translate faithfully; never machine-translate names the game keeps in one language.
- `null` removes a language (and its cover). The call merges: other languages are kept.
- Translations of languages the game is not played in are kept but not shown: players in those languages see English (or the listing's own language).

### Covers and other images with text

The cover is the one image the store shows for a game (the game page also shows the verification screenshot of the live version). When the cover shows text, such as the game's name, give each listing language its own cover with that text in the language:

```json
update_project { "project": "…", "cover": "cover-en.jpg", "covers": { "zh": "cover-zh.jpg", "zh-TW": "cover-zh.jpg", "ja": "cover-ja.jpg" } }
```

- `cover` is the cover of the listing's own language, and of every language without a cover of its own; `covers` sets one per platform language (workspace paths, png, jpg or webp under 2 MB, 16:9; see [Cover image](#cover-image)). `null` removes one.
- A language without its own cover shows the main cover, so a game without per-language covers should keep text off the cover or keep it language-neutral.

The game page's Languages table shows, for each language, whether the store page is in it.

### Cover image

The cover is the game's poster: the home page banner, store cards, shelves, search, the library and the game page all show it, and each one crops it differently. Without a cover the store uses the verification screenshot, which is a frame of the game with its interface and almost never survives those crops, so design one.

![Cover template: the safe area and every crop]({{ORIGIN}}/guides/cover-template.png)

[Download the template]({{ORIGIN}}/guides/cover-template.png) (or read the MCP resource `gcp://templates/cover`) and lay the cover out on it.

| | |
|---|---|
| Size | 1920×1080 (16:9), at least 1280×720. png, jpg or webp, under 2 MB. |
| Safe area | The title and the main subject stay inside **x 30%–80%, y 12%–86%** (576–1536 px across, 130–930 px down). This is what every crop keeps. |
| Left 30% | Hidden behind the home page banner's info panel (the slanted panel with the name, price and Play button). Background only: no title, no faces. |
| Right edge | The narrowest banner cuts from about 81%. |
| Cards | 16:10: the sides lose 5.6% each. |
| Shelves | 16:7: the top and bottom lose 11% each. |
| Phone banner | 16:10 with the bottom-right corner cut off. |
| Thumbnails | Down to 96 px wide; the title must still read at 240 px wide. |

How to lay it out:

- Centre the composition on the safe area (about 55% across), not on the image, and keep the left 30% for scenery that continues the background.
- Make the title large: cap height of at least 90 px at 1080 high. Put it in the lower third of the safe area, over a darkened band, or centred over the scene.
- Show whole characters in a wide scene. A close-up that fills the frame turns into a crop of a face once the banner cuts the left 30%.
- No frame, border or text near the edges: every crop cuts through it.
- When the title is text, make one cover per listing language with the title in that language (`covers`, below). A cover with two languages on it crowds both.

Before setting the cover, look at it the way the store will show it: crop it to the safe area, to 16:10 and to 16:7, and scale it to 240 px wide. The title and the main subject must be whole and readable in each. `update_project` answers with `cover_check`, the image's size and anything wrong with it, and `publish` reminds you while the store still uses the screenshot.

## Players

```json
{ "players": { "min": 1, "max": 4, "modes": ["single", "coop-online"] } }
```

- `min`, `max`: whole numbers, 1 to 100 and `min` to 1000.
- `modes`, at least one of:
  - `single`: one person plays alone;
  - `coop-local`: together on one device;
  - `coop-online`: together online (rooms);
  - `pvp-local`: against each other on one device;
  - `pvp-online`: against each other online.
- A single-player game is `{"min": 1, "max": 1, "modes": ["single"]}`.
- The platform warns when the code plays online (a room with `GCP.room`, or a server-run match with `GCP.match.find`) but no online mode is declared, and the other way round.

## Content descriptors and the age rating

The platform gives every game an age rating from what the creator declares about its content. Declare every descriptor honestly: the rating is shown to every player and to parents, and a wrong rating can get a game taken down.

```json
{
  "content": {
    "violence": "cartoon",
    "blood": false,
    "language": "none",
    "fear": "mild",
    "sexual": "none",
    "drugs": false,
    "gambling": "none",
    "flashing_lights": true,
    "player_chat": false,
    "adult_themes": false
  }
}
```

| Descriptor | Values | Means |
|---|---|---|
| `violence` | `none`, `cartoon`, `fantasy`, `realistic`, `graphic` | Cartoon: slapstick, no injury shown. Fantasy: combat against non-human or clearly unreal foes. Realistic: lifelike people hurt or killed. Graphic: gore, dismemberment, torture or injury shown in detail. |
| `blood` | `false`, `true` | Blood or gore is shown. |
| `language` | `none`, `mild`, `strong` | Mild: words like "damn". Strong: swearing or slurs. |
| `fear` | `none`, `mild`, `intense` | Mild: spooky or tense. Intense: horror, jump scares, disturbing images. |
| `sexual` | `none`, `suggestive`, `nudity`, `explicit` | Suggestive: innuendo, kissing, revealing outfits, no nudity. Nudity: bare breasts, buttocks or genitals, in any art style. Explicit: sexual activity shown or described in detail. |
| `drugs` | `false`, `true` | Drug, alcohol or tobacco use or references. |
| `gambling` | `none`, `simulated` | Casino-style play with in-game currency. Real-money gambling is not allowed. |
| `flashing_lights` | `false`, `true` | Rapid flashing lights or patterns. Shows a photosensitivity warning. Does not change the rating. |
| `player_chat` | `false`, `true` | Players can send each other free text. Shown on the page. Does not change the rating. A multiplayer game is warned when its code mentions chat and has a field for free text; short fields such as a room code or a name do not count. |
| `adult_themes` | `false`, `true` | Themes meant only for adults that the descriptors above do not cover: drug use shown on screen, torture, self-harm depicted. |

Descriptors left out count as `none` or `false`, so `"content": {}` declares a game with none of these. The rating is the highest band any descriptor reaches:

| Rating | Reached by |
|---|---|
| **3+** Everyone | nothing above |
| **7+** | cartoon violence, mild fear |
| **12+** | fantasy violence, blood without realistic violence, mild language, simulated gambling |
| **16+** | realistic violence, strong language, intense fear, suggestive themes, drugs |
| **18+** Adults only | graphic violence, realistic violence with blood, nudity, explicit sexual content, adult themes |

### Adults-only (18+) games

Sexual content, violence and other mature themes are allowed on the platform. What is not allowed is hiding them. A game whose descriptors reach 18+ is an adults-only game, and the store handles it so:

- Its cover is blurred everywhere in the store and carries an **18+** label naming what it contains (sexual content, violence, mature themes). Category tiles never use it.
- Its page says it is for adults only, keeps its picture blurred, and every player sees a warning and confirms they are 18 or older and want to continue before the game starts. The play endpoint refuses to start it without that confirmation.
- The admin can switch adult games off (`mature_allowed`); a version that declares 18+ content is then refused.

**The review checks the declaration.** After a version passes the browser check, the platform's content review (a Workers AI vision model) looks at frames taken while the verification browser starts the game, plays its play-through and gives it input, with the listing and the on-screen text. It measures how sexual and how violent the game is and compares that with `content`:

| The review sees, not declared | Result |
|---|---|
| nudity or explicit sexual content | the version fails ("Content is declared") and cannot be published |
| realistic or graphic violence | the version fails |
| suggestive content, cartoon or fantasy violence | a note in the report: declare it so the rating is right |

The review only sees what the verification browser reaches, so declare what any player can reach later in the game too: a game that hides adult content behind progress and is found out is taken down. Register a play-through (`GCP.test.onPlaythrough`) that reaches the game's real content, so the review judges the game, not its title screen.

Some content is refused even when declared: sexual content involving minors or characters presented as children, sexual content of real people, hate, scams and phishing, promotion of self-harm, and real drug or weapons trade.

## Session length

```json
{ "session_minutes": 10 }
```

How long a typical sitting lasts, in minutes, 1 to 600. Shown as a bucket: under 5 minutes, 5 to 15, 15 to 30, 30 to 60, or over an hour.

## Progress

```json
{ "progress": { "cloud_saves": true, "leaderboards": true, "offline": false } }
```

- `cloud_saves`: progress is kept between sessions with `GCP.save` or `GCP.playerStats`.
- `leaderboards`: the game posts scores with `GCP.leaderboard`.
- `offline`: the game keeps working with no connection once it has loaded (it makes no network calls after loading).

The platform detects all three from the code, including when the game reaches the SDK under another name (`const sdk = window.GCP; sdk.save.set(…)`, or `const { save } = GCP`). Declaring them is optional; a declaration that disagrees with the code is reported as a warning.

## Accessibility

```json
{ "accessibility": ["remappable-controls", "pause-anytime", "colorblind-modes"] }
```

Any of: `remappable-controls`, `colorblind-modes`, `subtitles`, `adjustable-difficulty`, `reduced-motion`, `scalable-text`, `one-handed`, `pause-anytime`, `no-time-pressure`, `visual-sound-cues`. An empty list says the game has none of these. Left out, the page says "Not stated".

## A complete gcp.json

```json
{
  "requirements": { "graphics": "webgl2", "input": ["keyboard", "touch"], "devices": ["desktop", "tablet", "mobile"], "orientation": "landscape" },
  "languages": { "default": "en", "supported": [{ "code": "en" }, { "code": "ja" }], "follows_platform": true },
  "players": { "min": 1, "max": 1, "modes": ["single"] },
  "content": { "violence": "cartoon", "flashing_lights": false },
  "session_minutes": 10,
  "progress": { "cloud_saves": true, "leaderboards": true },
  "accessibility": ["pause-anytime", "remappable-controls"]
}
```

and on the project:

```json
{ "genre": "platformer", "tags": ["fantasy", "cute", "exploration", "pixel-art"], "listing_translations": { "ja": { "title": "星の庭", "tagline": "小さな星を育てるパズル" } } }
```

## The workflow with the tools

1. `game_metadata` `{"project_id": "…", "action": "check"}` returns:
   - `checklist`: eleven numbered steps (six required, then five recommended), each with its `status` (`done`, `missing` or `optional`), the question to answer (`ask`), the allowed values (`allowed`), what was detected (`suggestion`) and an exact `call` to make;
   - `summary`: what the store page will show;
   - `issues`: errors and warnings from the last check.
2. Answer each missing step with `game_metadata` `{"action": "declare", …}`. One call can carry several fields. Every field is validated before anything is written; an invalid one is refused with the reason and the allowed values.
3. `deploy_preview` freezes the build fields with the version. `version_status` reports `metadata_missing` and the next step.
4. `publish`. When something is still missing it is refused with the list, and the checklist says how to fix each one.

## What the store page shows

- **Header**: the age rating badge.
- **Buy box**: whether the game works on this device and whether it is playable in the viewer's language. For a paid game, a line under the Buy button names the seller, Horylo LLC (the platform's operator), with links to the Terms and Refund policy. The game's own creator is shown as its maker; never put the operator's name in `title`, `tagline` or `description`.
- **At a glance**: genre and tags, age rating with its reasons, players and modes, session length, progress, accessibility, the photosensitivity warning and the player-chat note.
- **Compatibility**: every requirement, checked against this browser.
- **Languages**: one row per language with interface, voice, subtitles and store page, the viewer's own language marked, and whether the creator listed the languages or the platform detected them.
- **Store filters and category pages**: one filter group per tag group (genres, setting and theme, mood, gameplay, visual style and view), and a page for every genre and tag.
- **Everywhere**: store cards, search and the page itself use the translated title and tagline in the viewer's language.
