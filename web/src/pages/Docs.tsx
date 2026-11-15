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
    ['features', t('What every game gets', '每款游戏自带的能力')], ['progress', t('Player progress', '玩家进度')], ['money', t('Pricing and payouts', '费用与收益')],
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
