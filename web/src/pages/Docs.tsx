import { useEffect } from 'react';
import { t, usd, useApp } from '../lib';
import { Card, Code, PageHeader, Ticks } from '../ui';
import { ConnectAgent, starterPrompt } from './Creators';

/** The details behind the creators page: setup per agent, the rules a game must follow, what it gets, and money. */
export function Docs() {
  const { config } = useApp(), s = config.settings;
  useEffect(() => { const id = location.hash.slice(1); if (id) document.getElementById(id)?.scrollIntoView(); }, []);
  const sections: [string, string][] = [
    ['connect', t('Connect your agent', '连接智能体')], ['prompt', t('Your first prompt', '第一句指令')], ['rules', t('The three rules', '三条规则')],
    ['features', t('What every game gets', '每款游戏自带的能力')], ['progress', t('Player progress', '玩家进度')], ['metadata', t('Game metadata', '游戏元数据')], ['services', t('Platform services', '平台服务')], ['money', t('Pricing and payouts', '费用与收益')],
  ];
  return (
    <div className="wrap page">
      <PageHeader eyebrow={t('Docs', '文档')} title={t('Make a game here', '在这里发布游戏')} sub={t('Everything you need to go from a connected agent to a live web game.', '从连接智能体到网页游戏上线，你需要知道的一切。')} />
      <div className="docs">
        <nav className="docs-nav" aria-label={t('On this page', '本页内容')}>{sections.map(([id, label]) => <a key={id} href={`#${id}`}>{label}</a>)}</nav>
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
            <h2>{t('The three rules', '三条规则')}</h2>
            <p>{t('Web games only: games that run in a browser page. Native, mobile, console and desktop builds are not accepted. Beyond that, genre, engine, art direction, camera and controls are never prescribed or scored.', '仅支持网页游戏：在浏览器页面中运行的游戏。不接受原生、移动端、主机或桌面端构建。除此之外，题材、引擎、美术风格、镜头与操作方式从不设限，也不评分。')}</p>
            <div className="tri">
              <div><span className="ico">&lt;/&gt;</span><h3>{t('A game is a web page', '游戏就是一个网页')}</h3><p>{t('index.html at the root, with whatever it loads beside it. HTML, JavaScript, CSS and WebAssembly; engines that export to the web work too. Programs, installers and app store links are refused.', '根目录放 index.html，旁边是它加载的文件。HTML、JavaScript、CSS 与 WebAssembly；可导出网页版本的引擎同样适用。程序、安装包与应用商店链接会被拒绝。')}</p></div>
              <div><span className="ico">✓</span><h3>{t('Say when it is ready', '告知何时就绪')}</h3><p>{t('Call GCP.ready() once, after the first playable frame is on screen.', '在第一帧可玩画面出现后调用一次 GCP.ready()。')}</p></div>
              <div><span className="ico">∞</span><h3>{t('Stay alive', '保持运行')}</h3><p>{t('Keep rendering, throw no uncaught errors, and survive keyboard, mouse and touch.', '持续渲染，不抛出未捕获的错误，并经得住键盘、鼠标与触摸操作。')}</p></div>
            </div>
            <p><a className="sig" href="/guides/platform-contract.md" target="_blank" rel="noreferrer">{t('Read the full platform contract', '阅读完整的平台约定')} →</a></p>
          </section>

          <section id="features">
            <h2>{t('What every game gets', '每款游戏自带的能力')}</h2>
            <div className="tri quad">
              <div><span className="ico">⚡</span><h3>{t('Its own Worker', '独立的 Worker')}</h3><p>{t('Every version is deployed as its own Cloudflare Worker, close to players, with nothing to host or scale.', '每个版本都部署为独立的 Cloudflare Worker，贴近玩家，无需自建托管或扩容。')}</p></div>
              <div><span className="ico">⇄</span><h3>{t('Multiplayer rooms', '多人房间')}</h3><p>{t('Realtime rooms with host migration, from one line of code.', '支持主机迁移的实时房间，一行代码即可使用。')}</p></div>
              <div><span className="ico">★</span><h3>{t('Saves and leaderboards', '存档与排行榜')}</h3><p>{t('Each player\'s progress saved per game, player stats, shared game data and leaderboards.', '按游戏保存每位玩家的进度、玩家统计、游戏共享数据与排行榜。')}</p></div>
              <div><span className="ico">▲</span><h3>{t('Real numbers', '真实数据')}</h3><p>{t('Plays, time played, ratings, sales and the errors real players hit, per version.', '按版本统计的游玩次数、时长、评分、销量以及真实玩家遇到的错误。')}</p></div>
            </div>
            <Ticks items={[
              t('Each preview is opened in a real browser: it must boot, keep rendering, show a picture, survive input and throw no errors.', '每个预览都会在真实浏览器中打开：必须能启动、持续渲染、有画面、经得住输入且没有报错。'),
              t('A verified version goes live with one instruction. There is no human review queue.', '通过验证的版本只需一句指令即可上线，无需人工审核排队。'),
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
const record = await GCP.playRecord();`} />
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
                ['requirements', t('Graphics, browser features, input, devices and orientation', '图形接口、浏览器功能、操作方式、设备与屏幕方向'), true],
                ['languages', t('Each language with interface, voice and subtitles, and whether the game follows the platform language', '每种语言的界面、语音与字幕支持，以及游戏是否跟随平台语言'), true],
                ['players', t('Minimum and maximum players, and the modes: single, co-op or versus, local or online', '最少与最多玩家人数，以及模式：单人、合作或对战，同屏或在线'), true],
                ['content', t('Violence, blood, language, fear, sexual content, drugs, gambling, adult themes, flashing lights, player chat. The platform works out the age rating from these. Adult games are allowed when declared: they are shown as 18+, blurred, behind a warning players confirm. The review plays the game and refuses undeclared sexual content or violence.', '暴力、血腥、粗口、恐怖、性内容、药物、赌博、成人主题、闪烁画面、玩家聊天。平台据此得出年龄分级。成人游戏在如实声明后允许发布：显示为 18+、封面模糊，并在玩家确认警告后才能开始。审核会实际游玩游戏，未声明的性内容或暴力将被拒绝。'), true],
                ['session_minutes', t('How long a typical session lasts', '一局通常持续多久'), false],
                ['progress', t('Cloud saves, leaderboards, offline play', '云存档、排行榜、离线游玩'), false],
                ['accessibility', t('Remappable controls, colour-blind modes, subtitles and seven more', '可自定义按键、色盲模式、字幕等十项功能'), false],
                ['listing_translations', t('The title, tagline, description and controls in the platform\'s other languages', '标题、简介、描述与操作说明在平台其他语言中的翻译'), false],
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
              t('Genre and translated listings belong to the project and apply at once. Everything in gcp.json belongs to one version, so a rollback brings back the metadata that matched that code.', '类型与翻译后的商品信息属于项目，立即生效。gcp.json 中的内容属于单个版本，因此回滚时会一并恢复与该代码相符的元数据。'),
              t('Publishing is refused until the required fields are on record. Rolling back is never blocked.', '在必填字段齐全之前，发布会被拒绝。回滚永远不受影响。'),
              t('The platform scans the code at every deploy. Anything the declaration leaves out is shown as detected, and anything that disagrees with the code is reported to your agent.', '平台在每次部署时都会扫描代码。声明中缺少的内容会以“检测得出”的形式显示，与代码不符的地方会报告给你的智能体。'),
            ]} />
            <p><a className="sig" href="/guides/game-metadata.md" target="_blank" rel="noreferrer">{t('Read the full metadata specification', '阅读完整的元数据规范')} →</a></p>
          </section>

          <section id="services">
            <h2>{t('Platform services', '平台服务')}</h2>
            <p>{t('Everything below is ready for every game, with no keys, setup or backend of your own. The game reaches it through the injected GCP object; your agent reaches it through the platform\'s MCP tools. Agents can list it all, with this platform\'s limits, with the platform_services tool.', '以下能力对每款游戏开箱即用，无需密钥、配置或自建后端。游戏通过平台注入的 GCP 对象调用，智能体通过平台的 MCP 工具调用。智能体可用 platform_services 工具列出全部服务及本平台的限制。')}</p>
            <div className="svc-list">
              {([
                [t('Hosting and versions', '托管与版本'), t('Each version runs on its own Cloudflare Worker, preview and live apart. Every version is kept for rollback.', '每个版本运行在独立的 Cloudflare Worker 上，预览与正式版分开。所有版本都会保留，可随时回滚。'), 'deploy_preview · publish · rollback'],
                [t('Player accounts', '玩家账户'), t('Every game is opened by a signed-in player. The game gets their id and display name, never an email or password.', '每款游戏都由已登录的玩家打开。游戏可获得玩家 ID 与显示名称，永远拿不到邮箱或密码。'), 'GCP.player'],
                [t('Saves, stats and play record', '存档、统计与游玩记录'), t('Cloud saves and named numbers per player and game, plus sessions and play time recorded by the platform.', '按玩家和游戏保存的云存档与具名数值，以及平台自动记录的游玩次数和时长。'), 'GCP.save · GCP.playerStats · GCP.playRecord()'],
                [t('Shared data and leaderboards', '共享数据与排行榜'), t('Game-wide data every player reads, written only by you or your server code, and boards that keep each player\'s best.', '所有玩家都能读取、只有你或你的服务端代码能写入的全局数据，以及保留每位玩家最佳成绩的排行榜。'), 'GCP.shared · GCP.leaderboard · game_data'],
                [t('Multiplayer rooms', '多人房间'), t('Realtime rooms by code, with a host, host migration, a snapshot for late joiners and smooth remote movement.', '按房间码加入的实时房间，带主机、主机迁移、供后加入者使用的快照，以及平滑的远端移动。'), 'GCP.room(code) · GCP.smooth() · game_room'],
                [t('Server code', '服务端代码'), t('Optional server/index.js runs in the game\'s own Worker, for checks players must not be able to tamper with.', '可选的 server/index.js 运行在游戏自己的 Worker 中，用于玩家无法篡改的校验。'), 'GCP.server(path) · env.store'],
                [t('Display and devices', '显示与设备'), t('Fullscreen inside the frame and on iPhone, orientation lock, touch detection and declared requirements.', '框架内及 iPhone 上的全屏、屏幕方向锁定、触屏检测与声明的兼容性要求。'), 'GCP.fullscreen() · GCP.display · compatibility'],
                [t('Verification', '验证'), t('A real browser plays every preview, and can run your own play-through and a two-player check.', '真实浏览器会试玩每个预览，并可运行你自己的通关脚本和双人检查。'), 'GCP.test.onPlaythrough · GCP.test.onTwoPlayers'],
                [t('Sales and payouts', '销售与收益'), t('One-time prices and free trials handled by the platform on Stripe. The game itself never takes payments.', '一次性定价与免费试玩由平台通过 Stripe 处理，游戏本身从不收款。'), 'update_project'],
                [t('Analytics', '数据分析'), t('Players online, sessions, play time, devices, browsers, sales and the errors real players hit.', '在线玩家、游玩次数、时长、设备、浏览器、销量以及真实玩家遇到的错误。'), 'get_stats'],
              ] as [string, string, string][]).map(([title, text, reach]) => (
                <div key={reach}><h3>{title}</h3><p>{text}</p><code>{reach}</code></div>
              ))}
            </div>
            <p>{t('Not provided: AI models for games, in-game purchases, achievements, matchmaking, friends and chat, and secrets for server code. The services guide says what to use instead.', '不提供：供游戏使用的 AI 模型、游戏内购买、成就、匹配、好友与聊天，以及服务端代码的密钥。服务指南说明了替代做法。')}</p>
            <p><a className="sig" href="/guides/services.md" target="_blank" rel="noreferrer">{t('Read the services guide', '阅读服务指南')} →</a></p>
          </section>

          <section id="money">
            <h2>{t('Pricing and payouts', '费用与收益')}</h2>
            <Ticks items={[
              s.creator_fee_cents > 0
                ? (s.creator_fee_required ? t('Building and previewing are free. A one-time creator license of {fee} is needed when you publish your first game, for unlimited games.', '创作与预览完全免费。发布第一款游戏时需一次性购买 {fee} 的创作者许可，游戏数量不限。', { fee: usd(s.creator_fee_cents) }) : t('The creator license is {fee}, once, for unlimited games.', '创作者许可为 {fee}，一次性，游戏数量不限。', { fee: usd(s.creator_fee_cents) }))
                : t('Building, previewing and publishing are free for every account.', '创作、预览与发布对所有账户免费开放。'),
              ...(s.paid_games_enabled ? [
                t('Publish free, or set a price.', '可以免费发布，也可以自行定价。'),
                t('On paid games you keep {share}% of each sale.', '付费游戏每笔销售你可获得 {share}%。', { share: 100 - s.platform_fee_percent }),
                t('Withdraw once your balance reaches {amount}.', '余额达到 {amount} 即可提现。', { amount: usd(s.withdraw_min_cents) }),
              ] : []),
            ]} />
          </section>
        </div>
      </div>
    </div>
  );
}
