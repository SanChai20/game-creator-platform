import { useEffect, useState } from 'react';
import { bytes, price, t, usd, useApp } from '../lib';
import { termLength } from './License';
import { Card, Code, PageHeader, Ticks } from '../ui';
import { ConnectAgent, starterPrompt } from './Creators';

const DOC_IDS = ['connect', 'prompt', 'rules', 'features', 'progress', 'metadata', 'services', 'storage', 'money'] as const;

/** The details behind the creators page: setup per agent, the rules a game must follow, what it gets, and money. */
export function Docs() {
  const { config } = useApp(), s = config.settings;
  const [active, setActive] = useState<string>(() => location.hash.slice(1) || 'connect');
  useEffect(() => {
    const id = location.hash.slice(1);
    if (id) document.getElementById(id)?.scrollIntoView();
    if (typeof IntersectionObserver !== 'function') return;
    const io = new IntersectionObserver((entries) => {
      const vis = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
      if (vis) setActive(vis.target.id);
    }, { rootMargin: '-15% 0px -68% 0px' });
    DOC_IDS.forEach((k) => { const el = document.getElementById(k); if (el) io.observe(el); });
    return () => io.disconnect();
  }, []);
  const sections: [string, string][] = [
    ['connect', t('Connect your agent', '连接智能体')], ['prompt', t('Your first prompt', '第一句指令')], ['rules', t('The rules', '规则')],
    ['features', t('What every game gets', '每款游戏自带的能力')], ['progress', t('Player progress', '玩家进度')], ['metadata', t('Game metadata', '游戏元数据')], ['services', t('Platform services', '平台服务')], ['storage', t('Game storage', '游戏存储空间')], ['money', t('Pricing and payouts', '费用与收益')],
  ];
  return (
    <div className="wrap page">
      <PageHeader eyebrow={t('Docs', '文档')} title={t('Make a game here', '在这里发布游戏')} sub={t('Everything you need to go from a connected agent to a live web game.', '从连接智能体到网页游戏上线，你需要知道的一切。')} />
      <div className="docs">
        <nav className="docs-nav" aria-label={t('On this page', '本页内容')}>{sections.map(([id, label]) => <a key={id} href={`#${id}`} className={active === id ? 'on' : undefined} onClick={() => setActive(id)}>{label}</a>)}</nav>
        <div className="docs-body">
          <section id="connect">
            <h2>{t('Connect your agent', '连接你的智能体')}</h2>
            <p>{t('The platform is an MCP server. Add it to your agent once; it signs in through your browser.', '平台是一个 MCP 服务器。在智能体中添加一次即可，登录通过浏览器完成。')}</p>
            <Card pad><ConnectAgent /></Card>
          </section>

          <section id="prompt">
            <h2>{t('Your first prompt', '第一句指令')}</h2>
            <p>{t('Then ask for a game in plain words. Something like:', '然后用平常的话提出需求，比如：')}</p>
            <Code text={starterPrompt()} />
          </section>

          <section id="rules">
            <h2>{t('The rules', '规则')}</h2>
            <p>{t('Web games only: games that run in a browser page. Native, mobile, console and desktop builds are not accepted. Beyond that, genre, engine, art direction, camera and controls are never prescribed or scored.', '仅支持网页游戏：在浏览器页面中运行的游戏。不接受原生、移动端、主机或桌面端构建。除此之外，题材、引擎、美术风格、镜头与操作方式从不设限，也不评分。')}</p>
            <div className="tri">
              <div><span className="ico">&lt;/&gt;</span><h3>{t('A game is a web page', '游戏就是一个网页')}</h3><p>{t('index.html at the root, with whatever it loads beside it. HTML, JavaScript, CSS and WebAssembly; engines that export to the web work too. Programs, installers and app store links are refused.', '根目录放 index.html，旁边是它加载的文件。HTML、JavaScript、CSS 与 WebAssembly；可导出网页版本的引擎同样适用。程序、安装包与应用商店链接会被拒绝。')}</p></div>
              <div><span className="ico">✓</span><h3>{t('Say when it is ready', '告知何时就绪')}</h3><p>{t('Call GCP.ready() once, after the first playable frame is on screen.', '在第一帧可玩画面出现后调用一次 GCP.ready()。')}</p></div>
              <div><span className="ico">∞</span><h3>{t('Stay alive', '保持运行')}</h3><p>{t('Keep rendering, throw no uncaught errors, and survive keyboard, mouse and touch.', '持续渲染，不抛出未捕获的错误，并经得住键盘、鼠标与触摸操作。')}</p></div>
              <div><span className="ico">!</span><h3>{t('Say what it shows', '如实声明内容')}</h3><p>{t('Declare violence, sexual content and other themes. Mature games are allowed when declared; adults-only games are shown as 18+.', '声明暴力、性内容及其他主题。如实声明的成人向游戏可以发布；仅限成人的游戏显示为 18+。')}</p></div>
              <div><span className="ico">▣</span><h3>{t('Fit its storage', '不超出存储空间')}</h3><p>{t('All its files together stay within the game\'s storage, the largest file and the file count.', '全部文件合计不超过游戏的存储空间，并遵守单个文件大小与文件数量的限制。')}</p></div>
              <div><span className="ico">文</span><h3>{t('List it in its languages', '用它的语言上架')}</h3><p>{t('For every platform language the game is played in, the store listing is in that language too.', '游戏支持的每种平台语言，商店信息也要提供该语言的版本。')}</p></div>
            </div>
            <p><a className="sig" href="/guides/platform-contract.md" target="_blank" rel="noreferrer">{t('Read the full platform contract', '阅读完整的平台约定')} →</a></p>
          </section>

          <section id="features">
            <h2>{t('What every game gets', '每款游戏自带的能力')}</h2>
            <div className="tri quad">
              <div><span className="ico">⚡</span><h3>{t('Hosted for you', '托管无忧')}</h3><p>{t('Every version is served from Cloudflare\'s network close to players, at a preview address and a live one, with nothing to host or scale.', '每个版本都由贴近玩家的 Cloudflare 网络提供服务，预览与正式版各有地址，无需自建托管或扩容。')}</p></div>
              <div><span className="ico">⇄</span><h3>{t('Multiplayer', '多人游戏')}</h3><p>{t('Realtime rooms, server-run matches with matchmaking, and invites to the player\'s friends.', '实时房间、带匹配的服务端对局，以及邀请玩家的好友。')}</p></div>
              <div><span className="ico">★</span><h3>{t('Saves and leaderboards', '存档与排行榜')}</h3><p>{t('Each player\'s progress saved per game, player stats, shared game data and leaderboards.', '按游戏保存每位玩家的进度、玩家统计、游戏共享数据与排行榜。')}</p></div>
              <div><span className="ico">▲</span><h3>{t('Real numbers', '真实数据')}</h3><p>{t('Plays, time played, ratings, sales and the errors real players hit, per version.', '按版本统计的游玩次数、时长、评分、销量以及真实玩家遇到的错误。')}</p></div>
            </div>
            <Ticks items={[
              t('Each preview is opened in a real browser: it must boot, keep rendering, show a picture, survive input and throw no errors.', '每个预览都会在真实浏览器中打开：必须能启动、持续渲染、有画面、经得住输入且没有报错。'),
              t('A verified version goes live with one instruction once the platform\'s own checks pass. No person reviews it, except a game the test browser cannot run (one that needs WebGPU), which an admin approves.', '通过验证的版本在平台自身的检查通过后，只需一句指令即可上线。无需人工审核，只有测试浏览器无法运行的游戏（需要 WebGPU 的游戏）需由管理员批准。'),
              t('Every version is kept. Roll back in a second, or take the game offline whenever you like.', '保留所有版本。可秒级回滚，也可随时下线。'),
            ]} />
          </section>

          <section id="progress">
            <h2>{t('Player progress', '玩家进度')}</h2>
            <p>{t('Every game keeps each player\'s progress with the platform, so it follows them to any device and survives new versions. Players are always signed in, and everything below belongs to one player in one game: the platform checks the signed play session on every call, so a game can never read or change another player\'s data, or another game\'s.', '每款游戏都把每位玩家的进度交给平台保存，换设备、出新版本都不会丢。玩家始终处于登录状态，以下所有数据都只属于某一位玩家在某一款游戏中的记录：平台在每次调用时都会校验签名的游玩会话，游戏无法读取或修改其他玩家或其他游戏的数据。')}</p>
            <Code text={`// load before the first playable frame
const save = (await GCP.save.get('slot1')) || { v: 1, level: 1 };

// save at checkpoints and when the tab is hidden (JSON, 256 KB per key)
await GCP.save.set('slot1', { v: 1, level: 4, coins: 120 });

// numbers worth tracking: add, max, min, set
await GCP.playerStats.add('levels_cleared');
await GCP.playerStats.max('best_combo', 17);

// what the platform recorded by itself: sessions, play time, first and last played
const record = await GCP.playRecord();

// optional, for the player's Continue row: where they are, and landing them in the saved run
GCP.resume.set({ label: 'Act 2, Floor 14', progress: 0.4 });
if (GCP.launch.continue && save.run) startRun(save.run);`} />
            <Ticks items={[
              t('Recorded for every game without any code: sessions, time played, first and last played, best leaderboard scores.', '无需任何代码即可为每款游戏记录：游玩次数、游玩时长、首次与最近游玩时间、排行榜最佳成绩。'),
              t('Preview and live keep separate data, and the browser check plays under a throwaway identity, so testing never touches real progress.', '预览与正式版的数据互相独立，浏览器验证使用一次性身份，测试永远不会影响真实进度。'),
              t('Players see their own progress on the game page and can reset it. Creators see totals and averages, never one player\'s data.', '玩家可在游戏页面查看并重置自己的进度。创作者只能看到总数与平均值，看不到任何单个玩家的数据。'),
            ]} />
            <p><a className="sig" href="/guides/saves.md" target="_blank" rel="noreferrer">{t('Read the saves guide', '阅读存档指南')} →</a></p>
          </section>

          <section id="metadata">
            <h2>{t('Game metadata', '游戏元数据')}</h2>
            <p>{t('Every game describes itself the same way, so its store page can tell a player before they press Play what kind of game it is, who it is for, whether it runs on their device and whether it speaks their language. Your agent declares it with the game_metadata tool, which lists what is missing, the values each field accepts and a suggestion detected from the code.', '每款游戏都以同样的方式描述自己，让商店页面在玩家点击“游玩”之前就能说明：这是什么类型的游戏、适合谁、能否在他们的设备上运行、是否支持他们的语言。智能体通过 game_metadata 工具声明这些信息，该工具会列出缺少的项目、每个字段可接受的值，以及根据代码检测得出的建议。')}</p>
            <div className="tbl-wrap"><table className="tbl">
              <thead><tr><th>{t('Field', '字段')}</th><th>{t('What it says', '说明')}</th><th>{t('To publish', '发布要求')}</th></tr></thead>
              <tbody>{([
                ['genre', t('One primary genre from a fixed list of 24, and up to two more', '从 24 种固定类型中选择一个主类型，另可再选两个'), true],
                ['tags', t('2 to 8 tags from the platform list: setting and theme, mood, gameplay, players, visual style and view. Other words are refused; the store\'s filters and tag pages are built from them.', '从平台标签中选择 2 到 8 个：背景与题材、氛围、玩法、玩家、画面风格与视角。其他词语会被拒绝；商店的筛选与标签页面都基于这些标签。'), true],
                ['requirements', t('Graphics, browser features, input, devices and orientation', '图形接口、浏览器功能、操作方式、设备与屏幕方向'), true],
                ['languages', t('Each language with interface, voice and subtitles, and whether the game follows the platform language', '每种语言的界面、语音与字幕支持，以及游戏是否跟随平台语言'), true],
                ['players', t('Minimum and maximum players, and the modes: single, co-op or versus, local or online', '最少与最多玩家人数，以及模式：单人、合作或对战，同屏或在线'), true],
                ['content', t('Violence, blood, language, fear, sexual content, drugs, gambling, adult themes, flashing lights, player chat. The platform works out the age rating from these. Adult games are allowed when declared: they are shown as 18+, blurred, behind a warning players confirm. The review plays the game and refuses undeclared sexual content or violence.', '暴力、血腥、粗口、恐怖、性内容、药物、赌博、成人主题、闪烁画面、玩家聊天。平台据此得出年龄分级。成人游戏在如实声明后允许发布：显示为 18+、封面模糊，并在玩家确认警告后才能开始。审核会实际游玩游戏，未声明的性内容或暴力将被拒绝。'), true],
                ['session_minutes', t('How long a typical session lasts', '一局通常持续多久'), false],
                ['progress', t('Cloud saves, leaderboards, offline play', '云存档、排行榜、离线游玩'), false],
                ['accessibility', t('Remappable controls, colour-blind modes, subtitles and seven more', '可自定义按键、色盲模式、字幕等十项功能'), false],
                ['listing_language', t('The language the title, tagline, description and cover are written in (worked out from the text when not set)', '标题、简介、描述与封面所用的语言（未设置时根据文字判断）'), false],
                ['listing_translations', t('The title, tagline, description and controls in every other platform language the game is played in. Players see the listing in their platform language when the game supports it, else in English, else in the game\'s own language. Required for each platform language the game declares.', '游戏支持的每种平台语言下的标题、简介、描述与操作说明。玩家的平台语言若被游戏支持，就以该语言显示，否则显示英文，再否则显示游戏自身的语言。游戏声明的每种平台语言都必须提供。'), true],
                ['covers', t('A cover per language (update_project), for covers that show the game\'s name or other text', '每种语言各自的封面（update_project），适用于带有游戏名称或其他文字的封面'), false],
              ] as [string, string, boolean][]).map(([k, d, req]) => <tr key={k}><td><code>{k}</code></td><td>{d}</td><td>{req ? t('Required', '必填') : t('Recommended', '建议填写')}</td></tr>)}</tbody>
            </table></div>
            <Code text={`// gcp.json, frozen with each version
{
  "requirements": { "graphics": "webgl2", "input": ["keyboard", "touch"], "devices": ["desktop", "mobile"] },
  "languages": { "default": "en", "supported": [{ "code": "en" }, { "code": "ja", "subtitles": true }], "follows_platform": true },
  "players": { "min": 1, "max": 4, "modes": ["single", "coop-online"] },
  "content": { "violence": "cartoon", "flashing_lights": false },
  "session_minutes": 10,
  "progress": { "cloud_saves": true, "leaderboards": true },
  "accessibility": ["pause-anytime", "remappable-controls"]
}`} />
            <Ticks items={[
              t('Genre, tags and translated listings belong to the project and apply at once. Everything in gcp.json belongs to one version, so a rollback brings back the metadata that matched that code.', '类型、标签与翻译后的商品信息属于项目，立即生效。gcp.json 中的内容属于单个版本，因此回滚时会一并恢复与该代码相符的元数据。'),
              t('Publishing is refused until the required fields are on record. Rolling back is never blocked.', '在必填字段齐全之前，发布会被拒绝。回滚永远不受影响。'),
              t('The platform scans the code at every deploy. Anything the declaration leaves out is shown as detected, and anything that disagrees with the code is reported to your agent.', '平台在每次部署时都会扫描代码。声明中缺少的内容会以“检测得出”的形式显示，与代码不符的地方会报告给你的智能体。'),
            ]} />
            <p><a className="sig" href="/guides/game-metadata.md" target="_blank" rel="noreferrer">{t('Read the full metadata specification', '阅读完整的元数据规范')} →</a> · <a className="sig" href="/guides/game-metadata.md#cover-image" target="_blank" rel="noreferrer">{t('Read the cover image spec', '阅读封面图规范')} →</a></p>
          </section>

          <section id="services">
            <h2>{t('Platform services', '平台服务')}</h2>
            <p>{t('Everything below is ready for every game, with no keys, setup or backend of your own. The game reaches it through the injected GCP object; your agent reaches it through the platform\'s MCP tools. Agents can list it all, with this platform\'s limits, with the platform_services tool.', '以下能力对每款游戏开箱即用，无需密钥、配置或自建后端。游戏通过平台注入的 GCP 对象调用，智能体通过平台的 MCP 工具调用。智能体可用 platform_services 工具列出全部服务及本平台的限制。')}</p>
            <div className="svc-list">
              {([
                [t('Hosting and versions', '托管与版本'), t('Every version is served from Cloudflare\'s network, preview and live at separate addresses. Every version is kept for rollback.', '每个版本都由 Cloudflare 网络提供服务，预览与正式版使用不同地址。所有版本都会保留，可随时回滚。'), 'deploy_preview · publish · rollback'],
                [t('Player accounts', '玩家账户'), t('Every game is opened by a signed-in player. The game gets their id and display name, never an email or password.', '每款游戏都由已登录的玩家打开。游戏可获得玩家 ID 与显示名称，永远拿不到邮箱或密码。'), 'GCP.player'],
                [t('Saves, stats and play record', '存档、统计与游玩记录'), t('Cloud saves and named numbers per player and game, plus sessions and play time recorded by the platform.', '按玩家和游戏保存的云存档与具名数值，以及平台自动记录的游玩次数和时长。'), 'GCP.save · GCP.playerStats · GCP.playRecord()'],
                [t('Shared data and leaderboards', '共享数据与排行榜'), t('Game-wide data every player reads, written only by you or your server code, and boards that keep each player\'s best.', '所有玩家都能读取、只有你或你的服务端代码能写入的全局数据，以及保留每位玩家最佳成绩的排行榜。'), 'GCP.shared · GCP.leaderboard · game_data'],
                [t('Multiplayer rooms', '多人房间'), t('Realtime rooms by name, with a host, host migration, a snapshot for late joiners and smooth remote movement.', '按房间名加入的实时房间，带主机、主机迁移、供后加入者使用的快照，以及平滑的远端移动。'), 'GCP.room(name) · GCP.smooth() · game_room'],
                [t('Matches and matchmaking', '对局与匹配'), t('For competitive games: your server/match.js runs on the platform at a fixed tick, with matchmaking, ratings and lag-compensated hits. No player is the authority.', '适用于竞技游戏：你的 server/match.js 在平台上以固定帧率运行，带匹配、评分与延迟补偿的命中判定。没有任何玩家拥有裁决权。'), 'GCP.match.find · server/match.js'],
                ...(s.social_enabled !== false ? [[t('Friends and invites', '好友与邀请'), t('Players invite their platform friends into a private lobby or room from inside the game, and friends see what they play. No typed room codes.', '玩家可在游戏内邀请平台好友进入私人大厅或房间，好友也能看到他们在玩什么。无需输入房间码。'), 'GCP.friends · GCP.presence · GCP.launch.join'] as [string, string, string]] : []),
                [t('Server code', '服务端代码'), t('Optional server/index.js runs on the platform in a sandbox of its own, for checks players must not be able to tamper with.', '可选的 server/index.js 在平台上的独立沙箱中运行，用于玩家无法篡改的校验。'), 'GCP.server(path) · env.store'],
                [t('Display and devices', '显示与设备'), t('Fullscreen inside the frame and on iPhone, orientation lock, touch detection and declared requirements.', '框架内及 iPhone 上的全屏、屏幕方向锁定、触屏检测与声明的兼容性要求。'), 'GCP.fullscreen() · GCP.display · compatibility'],
                [t('Verification', '验证'), t('A real browser plays every preview, and can run your own play-through and a two-player check.', '真实浏览器会试玩每个预览，并可运行你自己的通关脚本和双人检查。'), 'GCP.test.onPlaythrough · GCP.test.onTwoPlayers'],
                ...(s.preview_bots_enabled !== false ? [[t('Test bots', '测试机器人'), t('Bot players join your preview over the real network path, as friends you can invite too. Every online game ships a server/bot.js: the platform does the connecting, matchmaking and invites, your game does its own logic.', '机器人玩家通过真实的网络路径加入你的预览，也能作为好友被你邀请。每款联网游戏都要附带 server/bot.js：连接、匹配与邀请由平台负责，游戏自身的逻辑由你的游戏负责。'), 'preview_bots · server/bot.js'] as [string, string, string]] : []),
                [t('Sales and payouts', '销售与收益'), t('One-time prices, limited-time sales and free trials handled by the platform on Stripe. The game itself never takes payments.', '一次性定价、限时特价与免费试玩由平台通过 Stripe 处理，游戏本身从不收款。'), 'update_project'],
                [t('Analytics', '数据分析'), t('Players online, sessions, play time, devices, browsers, sales and the errors real players hit.', '在线玩家、游玩次数、时长、设备、浏览器、销量以及真实玩家遇到的错误。'), 'get_stats'],
              ] as [string, string, string][]).map(([title, text, reach]) => (
                <div key={reach}><h3>{title}</h3><p>{text}</p><code>{reach}</code></div>
              ))}
            </div>
            <p>{t('Not provided: AI models for games, in-game purchases, achievements, chat channels inside games, push notifications, and secrets for server code. The services guide says what to use instead.', '不提供：供游戏使用的 AI 模型、游戏内购买、成就、游戏内聊天频道、推送通知，以及服务端代码的密钥。服务指南说明了替代做法。')}</p>
            <p><a className="sig" href="/guides/services.md" target="_blank" rel="noreferrer">{t('Read the services guide', '阅读服务指南')} →</a> · <a className="sig" href="/guides/standards.md" target="_blank" rel="noreferrer">{t('Read the game standards', '阅读游戏标准')} →</a></p>
          </section>

          <section id="storage">
            <h2>{t('Game storage', '游戏存储空间')}</h2>
            <p>{t('Each game has {size} of storage for all its files together (one file at most {file}). Uploads that would go over it are refused, and a version over it cannot be deployed or published. Your agent sees how much is used in every answer and tells you as it fills up.', '每款游戏的全部文件共享 {size} 的存储空间（单个文件最大 {file}）。超出空间的上传会被拒绝，超出空间的版本无法部署或发布。你的智能体在每次回复中都能看到已用空间，并会在快满时告诉你。', { size: bytes(Number(s.bundle_max_bytes)), file: bytes(Number(s.file_max_bytes)) })}</p>
            <Ticks items={[
              t('Generate it: meshes, terrain, textures, sound and music built from code at boot cost kilobytes, not megabytes.', '程序化生成：启动时用代码生成网格、地形、纹理、音效与音乐，只占几 KB，而不是几 MB。'),
              t('Load it at run time: large or optional content can live on your own host and be fetched while the game runs. Any HTTPS host that sends CORS headers works.', '运行时加载：大型或可选内容可以放在你自己的服务器上，在游戏运行时下载。任何发送 CORS 头的 HTTPS 服务器都可以。'),
              t('Compress what ships: Draco or Meshopt models, KTX2 or WebP textures, Opus or OGG audio. Three.js and the platform modules are hosted for you and do not count.', '压缩要打包的资源：Draco 或 Meshopt 模型、KTX2 或 WebP 纹理、Opus 或 OGG 音频。Three.js 与平台模块由平台托管，不占用空间。'),
              ...(s.storage_requests_open ? [t('Need more? Your agent can ask for up to {size} for one game, with a reason. The platform reviews each request.', '还不够？你的智能体可以说明原因，为单款游戏申请最多 {size}。平台会审核每个申请。', { size: bytes(Number(s.storage_max_bytes)) })] : []),
            ]} />
            <p><a className="sig" href="/guides/storage.md" target="_blank" rel="noreferrer">{t('Read the storage guide', '阅读存储空间指南')} →</a></p>
          </section>

          <section id="money">
            <h2>{t('Pricing and payouts', '费用与收益')}</h2>
            <Ticks items={[
              t('The console and publishing need a creator license, paid once: {term} for {len}, or {life} for life. Building and previewing through your agent are free.', '控制台与发布需要创作者许可，一次付清：{term} 有效 {len}，或 {life} 永久有效。通过智能体创作与预览免费。', { term: price(s.license_term_cents), len: termLength(s.license_term_days), life: price(s.license_lifetime_cents) }),
              ...(s.paid_games_enabled ? [
                t('Publish free, or set a price.', '可以免费发布，也可以自行定价。'),
                t('On paid games you keep {share}% of each sale.', '付费游戏每笔销售你可获得 {share}%。', { share: 100 - s.platform_fee_percent }),
                ...(s.sales_enabled ? [t('Run a limited-time sale for up to {days} days, at least {pct}% off. The store shows the regular price struck through.', '可举办最长 {days} 天、至少 {pct}% 折扣的限时特价。商店会显示被划掉的原价。', { days: Number(s.sale_max_days ?? 30), pct: Number(s.sale_min_percent_off ?? 10) })] : []),
                ...(Number(s.refund_window_hours ?? 24) > 0 ? [t('Buyers can refund a game themselves within {hours} hours if they played it for less than {minutes} minutes. A refund takes back your share of that sale.', '买家在 {hours} 小时内且游玩不足 {minutes} 分钟时，可自行为游戏退款。退款会收回你在该笔销售中的分成。', { hours: Number(s.refund_window_hours ?? 24), minutes: Number(s.refund_max_play_minutes ?? 10) })] : []),
                ...(s.platform_fee_open_percent < s.platform_fee_percent ? [t('Share your game\'s build skill for free in the Creator Store and you keep {share}% instead.', '在创作者商店免费分享游戏的构建技能，你可获得 {share}%。', { share: 100 - s.platform_fee_open_percent })] : []),
                ...(s.paid_skills_enabled !== false ? [t('Or sell the build skill: the game keeps the standard cut, and the platform keeps {pct}% of each skill sale. Skill sales are final: build skills are non-refundable.', '也可以出售构建技能：游戏按标准比例分成，平台从每笔技能销售中收取 {pct}%。技能销售为最终交易：构建技能不可退款。', { pct: Number(s.skill_fee_percent ?? 5) })] : []),
                t('Withdraw once your balance reaches {amount}.', '余额达到 {amount} 即可提现。', { amount: usd(s.withdraw_min_cents) }),
              ] : []),
            ]} />
          </section>
        </div>
      </div>
    </div>
  );
}
