import { useState } from 'react';
import { Code, Link, t, usd, useApp } from '../lib';

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
    other: { name: t('Any other agent', '其他智能体'), code: url, steps: [t('Add a remote MCP server (Streamable HTTP) with this address. The agent discovers the OAuth sign-in by itself.', '添加一个远程 MCP 服务器（Streamable HTTP）并填入此地址，智能体会自动发现 OAuth 登录流程。')] },
  };
  const c = clients[tab];
  return (
    <div className="stack l">
      <div className="seg wrapx">{Object.entries(clients).map(([k, v]) => <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{v.name}</button>)}</div>
      {c.code && <Code text={c.code} />}
      <ol className="steps">{c.steps.map((s, i) => <li key={i}><span>{s}</span></li>)}</ol>
      <p className="dim" style={{ fontSize: 13 }}>{t('No API keys. Access is granted through sign-in, expires by itself, and can be revoked from your console at any time.', '无需任何 API 密钥。访问权限通过登录授予，会自动过期，并可随时在控制台撤销。')}</p>
    </div>
  );
}

export const starterPrompt = () => t(
  'Use the Game Creator tools. Call get_started first. Then make me a small game about a lighthouse keeper catching falling stars, preview it, fix whatever verification reports, and show me the preview before publishing.',
  '使用 Game Creator 工具。先调用 get_started，然后帮我做一款小游戏：灯塔守护者接住坠落的星星。部署预览，修复验证报告中的所有问题，发布前先让我看看预览。');

export function Creators() {
  const { config, user } = useApp(), s = config.settings;
  return (
    <>
      <section className="lead"><div className="wrap">
        <span className="eyebrow sig">{t('For creators', '面向创作者')}</span>
        <h1 style={{ marginTop: 18 }}>{s.tagline}</h1>
        <p>{t('The hard-won craft of making web games that load fast, run everywhere and feel good has been written down once: as rules, guides, kits and a verifier. Your agent, whichever one you use, picks it up and builds your game with it.', '如何让网页游戏加载快、处处能跑、手感出色——这些来之不易的经验已被整理成规则、指南、工具包与验证器。无论你使用哪款智能体，它都能直接取用，为你把游戏做出来。')}</p>
        <div className="row wrapx" style={{ marginTop: 30 }}>
          <Link to={user ? '/console' : '/signup?next=%2Fconsole'} className="btn pri big">{user ? t('Open your console', '打开控制台') : t('Start creating', '开始创作')}</Link>
          <a href="#connect" className="btn big ghost">{t('Connect an agent', '连接智能体')}</a>
        </div>
      </div></section>

      <div className="wrap page stack xl">
        <section className="stack l">
          <div className="section-h" style={{ margin: 0 }}><h2>{t('From an idea to a live game', '从想法到上线')}</h2></div>
          <div className="tri">
            <div><span className="eyebrow sig">01 · {t('Build', '创作')}</span><h3>{t('Describe it to your agent', '向智能体描述你的游戏')}</h3><p>{t('The agent reads the platform guides on rendering, meshes, materials, input and performance, starts from a template or from nothing, and writes the game.', '智能体会阅读平台关于渲染、网格、材质、输入与性能的指南，从模板或空白起步，写出整款游戏。')}</p></div>
            <div><span className="eyebrow sig">02 · {t('Verify', '验证')}</span><h3>{t('A real browser plays it', '真实浏览器试玩')}</h3><p>{t('Each preview is deployed as its own Cloudflare Worker and opened in a real browser. It must boot, keep rendering, show a picture, survive input and throw no errors.', '每个预览版本都会部署为独立的 Cloudflare Worker，并在真实浏览器中打开：必须能启动、持续渲染、有画面、经得住输入且没有报错。')}</p></div>
            <div><span className="eyebrow sig">03 · {t('Publish', '发布')}</span><h3>{t('Live in the marketplace', '上架游戏市场')}</h3><p>{t('A verified version goes live with one instruction. No human review queue. Keep shipping versions, roll back in a second, take it offline whenever you like.', '通过验证的版本只需一句指令即可上线，无需人工审核排队。可持续迭代、秒级回滚、随时下线。')}</p></div>
          </div>
        </section>

        <section className="cols" id="connect">
          <div className="card">
            <header><h3>{t('Connect your agent', '连接你的智能体')}</h3></header>
            <div className="pad"><ConnectAgent /></div>
          </div>
          <div className="stack l">
            <div className="card pad stack">
              <span className="eyebrow">{t('Then say something like', '然后可以这样说')}</span>
              <p style={{ fontSize: 16 }}>“{starterPrompt()}”</p>
            </div>
            <div className="card pad stack">
              <span className="eyebrow">{t('What it costs', '费用')}</span>
              <div className="row"><b style={{ fontSize: 34, letterSpacing: '-.03em' }}>{s.creator_fee_cents > 0 ? usd(s.creator_fee_cents) : t('Free', '免费')}</b><span className="mute">{s.creator_fee_cents > 0 ? t('once, for unlimited games', '一次性，游戏数量不限') : ''}</span></div>
              <p className="mute">{s.creator_fee_required && s.creator_fee_cents > 0 ? t('Building and previewing are free. The creator license is needed when you publish your first game.', '创作与预览完全免费，发布第一款游戏时才需要创作者许可。') : t('Building, previewing and publishing are open to every account.', '创作、预览与发布对所有账户开放。')}</p>
              {s.paid_games_enabled && <p className="mute">{t(`Publish free, or set a price. On paid games you keep ${100 - s.platform_fee_percent}% of each sale and can withdraw once your balance reaches ${usd(s.withdraw_min_cents)}.`, `可以免费发布，也可以自行定价。付费游戏每笔销售你可获得 ${100 - s.platform_fee_percent}%，余额达到 ${usd(s.withdraw_min_cents)} 即可提现。`)}</p>}
            </div>
          </div>
        </section>

        <section className="stack l">
          <div className="section-h" style={{ margin: 0 }}><h2>{t('Three rules. Everything else is yours.', '只有三条规则，其余由你决定。')}</h2></div>
          <div className="tri">
            <div><h3>{t('A game is a web page', '游戏就是一个网页')}</h3><p>{t('index.html at the root, with whatever it loads beside it. No build step, no required engine.', '根目录放 index.html，旁边是它加载的文件。无需构建步骤，不限定引擎。')}</p></div>
            <div><h3>{t('Say when it is ready', '告知何时就绪')}</h3><p>{t('Call GCP.ready() once, after the first playable frame is on screen.', '在第一帧可玩画面出现后调用一次 GCP.ready()。')}</p></div>
            <div><h3>{t('Stay alive', '保持运行')}</h3><p>{t('Keep rendering, throw no uncaught errors, and survive keyboard, mouse and touch.', '持续渲染，不抛出未捕获的错误，并经得住键盘、鼠标与触摸操作。')}</p></div>
          </div>
          <p className="mute" style={{ maxWidth: '70ch' }}>{t('Genre, art direction, camera, rendering technique and controls are never prescribed. The guides are advice gathered from shipped games, the kits are optional, and two games made here should look nothing alike.', '题材、美术风格、镜头、渲染技术与操作方式从不设限。指南是从已上线游戏中总结的建议，工具包可用可不用——在这里诞生的任意两款游戏都不该彼此相像。')} <a className="sig" href="/guides/platform-contract.md" target="_blank" rel="noreferrer">{t('Read the full contract', '阅读完整约定')} →</a></p>
        </section>

        <section className="stack l">
          <div className="section-h" style={{ margin: 0 }}><h2>{t('What every game gets', '每款游戏自带的能力')}</h2></div>
          <div className="tri">
            <div><h3>{t('Its own Worker', '独立的 Worker')}</h3><p>{t('Every version runs on Cloudflare’s network, close to players, with nothing to host or scale.', '每个版本都运行在 Cloudflare 全球网络上，贴近玩家，无需自建托管或扩容。')}</p></div>
            <div><h3>{t('Multiplayer rooms', '多人房间')}</h3><p>{t('Realtime rooms with host migration, ready to use from one line of code.', '支持主机迁移的实时房间，一行代码即可使用。')}</p></div>
            <div><h3>{t('Saves and leaderboards', '存档与排行榜')}</h3><p>{t('Cloud saves per player, shared game data and leaderboards, backed by the platform database.', '按玩家的云存档、游戏共享数据与排行榜，均由平台数据库支撑。')}</p></div>
            <div><h3>{t('Real numbers', '真实数据')}</h3><p>{t('Plays, time played, ratings, sales and the errors real players hit, per version.', '按版本统计的游玩次数、时长、评分、销量以及真实玩家遇到的错误。')}</p></div>
          </div>
        </section>
      </div>
    </>
  );
}
