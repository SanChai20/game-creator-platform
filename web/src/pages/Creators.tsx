import { useState } from 'react';
import { t, usd, useApp } from '../lib';
import { Button, Card, CelScene, Code, Eyebrow, Segmented, Steps } from '../ui';

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
      t('Meanwhile the agent asks the token endpoint every 5 seconds and receives an access token that expires. The response to the first request spells out each step, so you can simply tell your agent: "connect to {url}".', '与此同时，智能体每 5 秒向令牌端点询问一次，随后获得会过期的访问令牌。第一次请求的响应会写明每一步，所以你只需对智能体说：“连接 {url}”。', { url }),
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
  const keep = 100 - s.platform_fee_percent;
  return (
    <>
      <div className="wrap"><section className="lead ink">
        <CelScene seed={3} />
        <div className="lead-in">
          <Eyebrow tone="accent">{t('For creators', '面向创作者')}</Eyebrow>
          <h1>{t('Describe a game.', '描述一款游戏，')} <mark>{t('Your agent ships it.', '智能体帮你上线。')}</mark></h1>
          <p>{t('Use the agent you already have. We deploy every version, test it in a real browser and put it in front of players.', '用你已有的智能体。我们负责部署每个版本、在真实浏览器中测试，并把它送到玩家面前。')}</p>
          <div className="row wrapx lead-actions">
            <Button to={user ? '/console' : '/signup?next=%2Fconsole'} variant="primary" size="lg">{user ? t('Open your console', '打开控制台') : t('Start creating', '开始创作')} <em aria-hidden="true">→</em></Button>
            <Button to="/docs" variant="ghost" size="lg">{t('Read the docs', '阅读文档')}</Button>
          </div>
          <div className="web-only">{t('Web games only: games that run in a browser page. Native, mobile, console and desktop builds are not accepted.', '仅支持网页游戏：在浏览器页面中运行的游戏。不接受原生、移动端、主机或桌面端构建。')}</div>
        </div>
        <div className="term" aria-label={t('How a game goes live', '游戏上线的过程')}>
          <div className="term-bar"><i /><i /><i /><span>agent — game-creator</span></div>
          <div className="term-body">
            <div className="p">claude mcp add game-creator</div>
            <div className="say">“{t('Make a game about a lighthouse keeper catching falling stars.', '做一款灯塔守护者接住坠落星星的游戏。')}”</div>
            <div className="ok">{t('Preview deployed', '预览已部署')}</div>
            <div className="ok">{t('Played in a real browser:', '真实浏览器试玩：')} <b>{t('passed', '通过')}</b></div>
            <div className="ok">{t('Live at', '已上线：')} <b>/g/star-keeper</b></div>
            <div className="p"><span className="cur" /></div>
          </div>
        </div>
      </section></div>

      <div className="wrap stack xl creators">
        <div className="keys">
          <div><b>1</b><span>{t('prompt from an idea to a live game', '句话，从想法到上线')}</span></div>
          <div><b>0</b><span>{t('human review queues. Verified means live.', '人工审核排队。验证通过即上线。')}</span></div>
          <div><b>{s.paid_games_enabled ? `${keep}%` : s.creator_fee_cents > 0 ? usd(s.creator_fee_cents) : t('Free', '免费')}</b><span>{s.paid_games_enabled ? t('of every sale is yours', '的销售收入归你') : s.creator_fee_cents > 0 ? t('once, for unlimited games', '一次性，游戏数量不限') : t('to build, preview and publish', '创作、预览与发布')}</span></div>
        </div>

        <section className="stack l">
          <h2 className="rule">{t('How it works', '如何运作')}</h2>
          <div className="track">
            <div><h3>{t('Your agent builds it', '智能体创作')}</h3><p>{t('Any engine or none, as long as it runs in a browser.', '任何引擎或不用引擎，只要能在浏览器中运行。')}</p></div>
            <div><h3>{t('A real browser plays it', '真实浏览器试玩')}</h3><p>{t('It must boot, render, take input and throw no errors.', '必须能启动、渲染、响应输入且没有报错。')}</p></div>
            <div><h3>{t('Players find it', '玩家发现它')}</h3><p>{t('Live in the marketplace. Roll back in a second.', '上架游戏市场，秒级回滚。')}</p></div>
          </div>
        </section>

        <section className="stack l">
          <h2 className="rule">{t('Connect your agent', '连接你的智能体')}</h2>
          <Card tone="accent" pad>
            <Code text={`claude mcp add --transport http game-creator ${config.mcp_url}`} />
            <div className="row wrapx"><span className="mute grow wide">{t('Claude, ChatGPT, Codex, Cursor, OpenCode or any MCP client. No API keys: you approve it by signing in.', 'Claude、ChatGPT、Codex、Cursor、OpenCode 或任何 MCP 客户端。无需 API 密钥，登录授权即可。')}</span><Button to="/docs#connect" size="sm">{t('Setup for every agent', '各智能体的设置方法')} <em aria-hidden="true">→</em></Button></div>
          </Card>
        </section>
      </div>
    </>
  );
}
