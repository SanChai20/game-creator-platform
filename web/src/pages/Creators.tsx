import { useState } from 'react';
import { t, usd, useApp } from '../lib';
import { Button, Card, Code, Eyebrow, Section, Segmented, Steps } from '../ui';

/** How to add the MCP server in each agent. The server uses OAuth, so no key is ever pasted anywhere. */
export function ConnectAgent() {
  const { config } = useApp(), url = config.mcp_url, [tab, setTab] = useState('claude-code');
  const clients: Record<string, { name: string; steps: string[]; code?: string }> = {
    'claude-code': { name: 'Claude Code', code: `claude mcp add --transport http game-creator ${url}`, steps: [t('Run this in your terminal.', '在终端运行这条命令。'), t('Start Claude Code, type /mcp, choose game-creator and sign in from the browser window that opens.', '启动 Claude Code，输入 /mcp，选择 game-creator，并在弹出的浏览器窗口中登录。')] },
    claude: { name: 'Claude', code: url, steps: [t('Open Settings, then Connectors, then "Add custom connector".', '打开 设置 → 连接器 → “添加自定义连接器”。'), t('Paste this address, then choose Connect and sign in.', '粘贴此地址，点击连接并登录。')] },
    chatgpt: { name: 'ChatGPT', code: url, steps: [t('Open Settings, then Apps & Connectors, and turn on Developer mode under Advanced.', '打开 设置 → 应用与连接器，在高级设置中开启开发者模式。'), t('Choose Create, paste this address as the MCP server URL, pick OAuth and sign in.', '点击创建，将此地址填入 MCP 服务器 URL，选择 OAuth 并登录。')] },
    codex: { name: 'Codex', code: `codex mcp add game-creator --url ${url}\ncodex mcp login game-creator`, steps: [t('Run these two commands. The second opens a browser window to sign in.', '依次运行这两条命令，第二条会打开浏览器进行登录。')] },
    cursor: { name: 'Cursor', code: `{\n  "mcpServers": {\n    "game-creator": { "url": "${url}" }\n  }\n}`, steps: [t('Add this to ~/.cursor/mcp.json (or .cursor/mcp.json in a project).', '将其加入 ~/.cursor/mcp.json（或项目内的 .cursor/mcp.json）。'), t('Open Cursor Settings, then MCP, and choose "Needs login" next to game-creator.', '打开 Cursor 设置 → MCP，在 game-creator 旁点击“需要登录”。')] },
    opencode: { name: 'OpenCode', code: `{\n  "mcp": {\n    "game-creator": { "type": "remote", "url": "${url}", "enabled": true }\n  }\n}`, steps: [t('Add this to opencode.json.', '将其加入 opencode.json。'), t('Run "opencode mcp auth game-creator" and sign in.', '运行 “opencode mcp auth game-creator” 并登录。')] },
    headless: { name: t('No browser', '无浏览器'), code: `curl -s -X POST ${config.origin}/oauth/device -d client_name=my-agent`, steps: [
      t('For agents in a sandbox, on a server or in CI that cannot open a sign-in window. The agent runs this and receives a short code and a link.', '适用于运行在沙箱、服务器或 CI 中、无法打开登录窗口的智能体。智能体执行此请求后会得到一个短验证码和一个链接。'),
      t('It shows you the link. Open it in any browser, sign in and choose Allow.', '智能体会把链接显示给你。在任意浏览器中打开，登录并选择允许。'),
      t('Meanwhile the agent asks the token endpoint every 5 seconds and receives an access token that expires. The response to the first request spells out each step, so you can simply tell your agent: "connect to ' + url + '".', '与此同时，智能体每 5 秒向令牌端点询问一次，随后获得会过期的访问令牌。第一次请求的响应会写明每一步，所以你只需对智能体说：“连接 ' + url + '”。'),
    ] },
    other: { name: t('Any other agent', '其他智能体'), code: url, steps: [t('Add a remote MCP server (Streamable HTTP) with this address. The agent discovers the OAuth sign-in by itself.', '添加一个远程 MCP 服务器（Streamable HTTP）并填入此地址，智能体会自动发现 OAuth 登录流程。')] },
  };
  const c = clients[tab];
  return (
    <div className="stack l">
      <Segmented wrap label={t('Agent', '智能体')} options={Object.entries(clients).map(([k, v]) => [k, v.name] as [string, string])} value={tab} onChange={setTab} />
      {c.code && <Code text={c.code} />}
      <Steps items={c.steps} />
      <p className="dim fs-sm">{t('No API keys. Access is granted through sign-in, expires by itself, and can be revoked from your console at any time.', '无需任何 API 密钥。访问权限通过登录授予，会自动过期，并可随时在控制台撤销。')}</p>
    </div>
  );
}

export const starterPrompt = () => t(
  'Use the Game Creator tools. Call get_started first. Then make me a small web game about a lighthouse keeper catching falling stars, deploy a preview, fix whatever verification reports, and show me the preview before publishing.',
  '使用 Game Creator 工具。先调用 get_started，然后帮我做一款网页小游戏：灯塔守护者接住坠落的星星。部署预览，修复验证报告中的所有问题，发布前先让我看看预览。');

export function Creators() {
  const { config, user } = useApp(), s = config.settings;
  return (
    <>
      <section className="lead"><div className="wrap">
        <Eyebrow tone="accent">{t('For creators', '面向创作者')}</Eyebrow>
        <h1 style={{ marginTop: 20 }}><span className="text-grad">{s.tagline}</span></h1>
        <p>{t('Make a web game however you like, with whichever agent you use. The platform deploys every version, checks it in a real browser, publishes it to the marketplace, keeps every version for rollback, and gives it saves, leaderboards and multiplayer rooms.', '用你喜欢的方式、你常用的智能体制作网页游戏。平台负责部署每个版本、在真实浏览器中检查、发布到游戏市场、保留所有版本以便回滚，并提供存档、排行榜与多人房间。')}</p>
        <div className="web-only mute">{t('Web games only: games that run in a browser page. Native, mobile, console and desktop builds are not accepted.', '仅支持网页游戏：在浏览器页面中运行的游戏。不接受原生、移动端、主机或桌面端构建。')}</div>
        <div className="row wrapx lead-actions">
          <Button to={user ? '/console' : '/signup?next=%2Fconsole'} variant="primary" size="lg">{user ? t('Open your console', '打开控制台') : t('Start creating', '开始创作')}</Button>
          <Button href="#connect" variant="ghost" size="lg">{t('Connect an agent', '连接智能体')} ↓</Button>
        </div>
      </div></section>

      <div className="wrap page stack xl">
        <Section title={t('From an idea to a live game', '从想法到上线')}>
          <div className="tri">
            <div><span className="ico">01</span><Eyebrow tone="accent">{t('Build', '创作')}</Eyebrow><h3>{t('Your agent makes it', '由你的智能体制作')}</h3><p>{t('Any engine, framework or none, as long as the result runs in a browser: HTML, JavaScript, CSS and WebAssembly. Engines that export to the web (Unity WebGL, Godot Web and others) work too. The agent uploads the files.', '任何引擎、框架，或不用引擎都可以，只要最终能在浏览器中运行：HTML、JavaScript、CSS 与 WebAssembly。可导出网页版本的引擎（Unity WebGL、Godot Web 等）同样适用。智能体负责上传文件。')}</p></div>
            <div><span className="ico">02</span><Eyebrow tone="accent">{t('Verify', '验证')}</Eyebrow><h3>{t('A real browser plays it', '真实浏览器试玩')}</h3><p>{t('Each preview is deployed as its own Cloudflare Worker and opened in a real browser. It must boot, keep rendering, show a picture, survive input and throw no errors.', '每个预览版本都会部署为独立的 Cloudflare Worker，并在真实浏览器中打开：必须能启动、持续渲染、有画面、经得住输入且没有报错。')}</p></div>
            <div><span className="ico">03</span><Eyebrow tone="accent">{t('Publish', '发布')}</Eyebrow><h3>{t('Live in the marketplace', '上架游戏市场')}</h3><p>{t('A verified version goes live with one instruction. No human review queue. Keep shipping versions, roll back in a second, take it offline whenever you like.', '通过验证的版本只需一句指令即可上线，无需人工审核排队。可持续迭代、秒级回滚、随时下线。')}</p></div>
          </div>
        </Section>

        <section className="cols" id="connect">
          <Card title={t('Connect your agent', '连接你的智能体')} pad><ConnectAgent /></Card>
          <div className="stack l">
            <Card pad>
              <Eyebrow>{t('Then say something like', '然后可以这样说')}</Eyebrow>
              <p className="quote">{starterPrompt()}</p>
            </Card>
            <Card pad tone="accent">
              <Eyebrow tone="accent">{t('What it costs', '费用')}</Eyebrow>
              <div className="row wrapx"><b className="big-num">{s.creator_fee_cents > 0 ? usd(s.creator_fee_cents) : t('Free', '免费')}</b><span className="mute">{s.creator_fee_cents > 0 ? t('once, for unlimited games', '一次性，游戏数量不限') : ''}</span></div>
              <p className="mute">{s.creator_fee_required && s.creator_fee_cents > 0 ? t('Building and previewing are free. The creator license is needed when you publish your first game.', '创作与预览完全免费，发布第一款游戏时才需要创作者许可。') : t('Building, previewing and publishing are open to every account.', '创作、预览与发布对所有账户开放。')}</p>
              {s.paid_games_enabled && <p className="mute">{t(`Publish free, or set a price. On paid games you keep ${100 - s.platform_fee_percent}% of each sale and can withdraw once your balance reaches ${usd(s.withdraw_min_cents)}.`, `可以免费发布，也可以自行定价。付费游戏每笔销售你可获得 ${100 - s.platform_fee_percent}%，余额达到 ${usd(s.withdraw_min_cents)} 即可提现。`)}</p>}
            </Card>
          </div>
        </section>

        <Section title={t('Three rules. Everything else is yours.', '只有三条规则，其余由你决定。')}>
          <div className="tri">
            <div><span className="ico">&lt;/&gt;</span><h3>{t('A game is a web page', '游戏就是一个网页')}</h3><p>{t('index.html at the root, with whatever it loads beside it. No build step, no required engine. Programs, installers and links to app stores are refused.', '根目录放 index.html，旁边是它加载的文件。无需构建步骤，不限定引擎。程序、安装包与应用商店链接会被拒绝。')}</p></div>
            <div><span className="ico">✓</span><h3>{t('Say when it is ready', '告知何时就绪')}</h3><p>{t('Call GCP.ready() once, after the first playable frame is on screen.', '在第一帧可玩画面出现后调用一次 GCP.ready()。')}</p></div>
            <div><span className="ico">∞</span><h3>{t('Stay alive', '保持运行')}</h3><p>{t('Keep rendering, throw no uncaught errors, and survive keyboard, mouse and touch.', '持续渲染，不抛出未捕获的错误，并经得住键盘、鼠标与触摸操作。')}</p></div>
          </div>
          <p className="mute" style={{ maxWidth: '70ch' }}>{t('Genre, engine, art direction, camera, rendering technique and controls are never prescribed or scored.', '题材、引擎、美术风格、镜头、渲染技术与操作方式从不设限，也不评分。')} <a className="sig" href="/guides/platform-contract.md" target="_blank" rel="noreferrer">{t('Read the full contract', '阅读完整约定')} →</a></p>
        </Section>

        <Section title={t('What every game gets', '每款游戏自带的能力')}>
          <div className="tri">
            <div><span className="ico">⚡</span><h3>{t('Its own Worker', '独立的 Worker')}</h3><p>{t('Every version runs on Cloudflare’s network, close to players, with nothing to host or scale.', '每个版本都运行在 Cloudflare 全球网络上，贴近玩家，无需自建托管或扩容。')}</p></div>
            <div><span className="ico">⇄</span><h3>{t('Multiplayer rooms', '多人房间')}</h3><p>{t('Realtime rooms with host migration, ready to use from one line of code.', '支持主机迁移的实时房间，一行代码即可使用。')}</p></div>
            <div><span className="ico">★</span><h3>{t('Saves and leaderboards', '存档与排行榜')}</h3><p>{t('Cloud saves per player, shared game data and leaderboards, backed by the platform database.', '按玩家的云存档、游戏共享数据与排行榜，均由平台数据库支撑。')}</p></div>
            <div><span className="ico">▲</span><h3>{t('Real numbers', '真实数据')}</h3><p>{t('Plays, time played, ratings, sales and the errors real players hit, per version.', '按版本统计的游玩次数、时长、评分、销量以及真实玩家遇到的错误。')}</p></div>
          </div>
        </Section>
      </div>
    </>
  );
}
