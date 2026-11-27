import { useState } from 'react';
import { price, t, usd, useApp } from '../lib';
import { Button, Card, CelScene, Code, Eyebrow, Segmented, Steps } from '../ui';
import BRIDGE_PKG from '../../../acp-bridge/package.json';

/** The command that starts the workbench's bridge with an agent (src/acp.ts bridgeCommand says the same). */
export function acpCommand(origin: string, agent = 'claude', custom?: string) {
  const base = `npx -y ${origin}/acp/hearthcade-acp-${BRIDGE_PKG.version}.tgz`, server = origin === 'https://hearthcade.com' ? '' : ` --server ${origin}`;
  return custom !== undefined ? `${base}${server} -- ${custom}` : `${base} ${agent}${server}`;
}

type Way = 'mcp' | 'acp';
const WAY_KEY = 'gcp.way';
/** The two ways to work with an agent, side by side: the creator picks one. MCP brings HearthCade into the agent they
    already use; ACP brings their agent into HearthCade's workbench. Both reach the same tools and games. */
export function ConnectChoice({ initial }: { initial?: Way }) {
  const { config } = useApp();
  const [way, setWay] = useState<Way>(() => { if (initial) return initial; try { return (localStorage.getItem(WAY_KEY) as Way) || 'mcp'; } catch { return 'mcp'; } });
  const pick = (w: Way) => { setWay(w); try { localStorage.setItem(WAY_KEY, w); } catch { /* private mode */ } };
  const ways: [Way, string, string, string][] = [
    ['mcp', 'MCP', t('HearthCade in your agent', '把 HearthCade 接入你的智能体'), t('Keep working in Claude, ChatGPT, Codex or Cursor. They call HearthCade\'s tools.', '继续在 Claude、ChatGPT、Codex 或 Cursor 中工作，由它们调用 HearthCade 的工具。')],
    ['acp', 'ACP', t('Your agent in HearthCade', '把你的智能体接入 HearthCade'), t('Run your agent on your computer and work with it in the console\'s workbench.', '在你的电脑上运行智能体，在控制台的工作台中与它协作。')],
  ];
  return (
    <div className="stack l">
      <div className="way-pick" role="radiogroup" aria-label={t('How you work with your agent', '你与智能体协作的方式')}>
        {ways.map(([k, tag, title, sub]) => (
          <button key={k} type="button" role="radio" aria-checked={way === k} className={way === k ? 'on' : ''} onClick={() => pick(k)}>
            <span className="way-tag">{tag}</span><b>{title}</b><span>{sub}</span>
          </button>
        ))}
      </div>
      <p className="dim fs-sm">{t('Pick one. Both reach the same tools, games and versions, and you can switch at any time.', '任选其一。两种方式使用相同的工具、游戏和版本，随时可以切换。')}</p>
      {way === 'mcp' ? <ConnectAgent /> : (
        <div className="stack">
          <Code text={acpCommand(config.origin)} />
          <Steps items={[
            t('Run this in your game\'s folder (Node.js 22 or newer). Swap "claude" for codex, gemini, copilot, cursor, opencode or any of 36 ACP agents.', '在你的游戏文件夹中运行（需要 Node.js 22 或更高版本）。可把 “claude” 换成 codex、gemini、copilot、cursor、opencode 等 36 个 ACP 智能体中的任意一个。'),
            t('Approve the code it shows, once per computer.', '确认它显示的代码，每台电脑只需一次。'),
            t('Work with the agent in the workbench: it edits your files, asks before it acts, and deploys with HearthCade\'s tools.', '在工作台中与智能体协作：它修改你的文件、行动前征求你的同意，并用 HearthCade 的工具部署。'),
          ]} />
          <div className="row wrapx"><Button variant="primary" size="sm" to="/console/workbench">{t('Open the workbench', '打开工作台')} <em aria-hidden="true">→</em></Button></div>
        </div>
      )}
    </div>
  );
}


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
  'Use the HearthCade tools. Call get_started first. Then make me a small web game about a lighthouse keeper catching falling stars, deploy a preview, fix whatever verification reports, and show me the preview before publishing.',
  '使用 HearthCade 工具。先调用 get_started，然后帮我做一款网页小游戏：灯塔守护者接住坠落的星星。部署预览，修复验证报告中的所有问题，发布前先让我看看预览。');

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
            <Button to={!user ? '/signup?next=%2Fconsole' : user.creator ? '/console' : '/license'} variant="primary" size="lg">{!user ? t('Start creating', '开始创作') : user.creator ? t('Open your console', '打开控制台') : t('Get License', '获取许可')} <em aria-hidden="true">→</em></Button>
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
          <div><b>{s.paid_games_enabled ? `${keep}%` : price(s.license_lifetime_cents)}</b><span>{s.paid_games_enabled ? t('of every sale is yours', '的销售收入归你') : t('once, for unlimited games', '一次性，游戏数量不限')}</span></div>
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
          <h2 className="rule">{t('Creator Store', '创作者商店')}</h2>
          <Card pad>
            <div className="row wrapx">
              <div className="grow wide stack s">
                <b>{t('Learn from live games, or share how yours is built', '向线上游戏学习，或分享你的游戏是如何做出来的')}</b>
                <p className="mute">{t('Every game that opens up its implementation lists a build skill: an agent skill its own agent keeps in step with each release, free or for a price. Copy one into your agent to build something similar. No source code is ever shared.', '每款开放实现的游戏都会提供一个构建技能：由游戏自己的智能体随每次发布同步更新的智能体技能，可免费或付费。把它复制到你的智能体中，就能做出类似的游戏。源代码永远不会被分享。')}</p>
                {s.paid_games_enabled && Number(s.platform_fee_open_percent) < Number(s.platform_fee_percent) && <p className="dim fs-sm">{t('Share your skill for free and keep {share}% of your game\'s sales. Sell it instead and the platform keeps {pct}% of each skill sale.', '免费分享技能，游戏销售收入的 {share}% 归你。若出售技能，平台从每笔技能销售中收取 {pct}%。', { share: 100 - Number(s.platform_fee_open_percent), pct: Number(s.skill_fee_percent ?? 5) })}</p>}
              </div>
              <Button to="/creator-store" variant="primary">{t('Open the Creator Store', '打开创作者商店')} <em aria-hidden="true">→</em></Button>
            </div>
          </Card>
        </section>

        <section className="stack l">
          <h2 className="rule">{t('Connect your agent', '连接你的智能体')}</h2>
          <div className="ways">
            <Card tone="accent" pad>
              <div className="stack">
                <div className="row"><span className="way-tag">MCP</span><b>{t('HearthCade in your agent', '把 HearthCade 接入你的智能体')}</b></div>
                <Code text={`claude mcp add --transport http game-creator ${config.mcp_url}`} />
                <span className="mute">{t('Claude, ChatGPT, Codex, Cursor, OpenCode or any MCP client. No API keys: you approve it by signing in.', 'Claude、ChatGPT、Codex、Cursor、OpenCode 或任何 MCP 客户端。无需 API 密钥，登录授权即可。')}</span>
              </div>
            </Card>
            <Card pad>
              <div className="stack">
                <div className="row"><span className="way-tag">ACP</span><b>{t('Your agent in HearthCade', '把你的智能体接入 HearthCade')}</b></div>
                <Code text={acpCommand(config.origin)} />
                <span className="mute">{t('Run Claude Agent, Codex, Gemini CLI, Copilot, Cursor or 30 more ACP agents on your computer and work with them in the console\'s workbench.', '在你的电脑上运行 Claude Agent、Codex、Gemini CLI、Copilot、Cursor 等 30 多个 ACP 智能体，在控制台的工作台中与它们协作。')}</span>
              </div>
            </Card>
          </div>
          <div className="row wrapx"><span className="dim grow wide">{t('Pick one. Both reach the same tools, games and versions.', '任选其一。两种方式使用相同的工具、游戏和版本。')}</span><Button to="/docs#connect" size="sm">{t('Setup for every agent', '各智能体的设置方法')} <em aria-hidden="true">→</em></Button></div>
        </section>
      </div>
    </>
  );
}
