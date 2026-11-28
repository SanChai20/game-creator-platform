// The workbench: the creator's own coding agent, on their machine, used from the console over the Agent Client Protocol.
// The platform hosts no agent. A bridge on the creator's machine (acp-bridge/) runs it and relays to this page; see
// src/acp.ts for the platform side and web/src/workbench/store.ts for the live connection.
import { Fragment, useEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent, type ReactNode } from 'react';
import { ago, api, date, Fail, Link, navigate, num, query, t, useAct, useApp, useData, useLocation } from '../lib';
import { Badge, Button, Card, Code, Modal, Notice, PageHeader } from '../ui';
import { Skeleton, SkRows } from '../ui/skeleton';
import { ConsoleTabs } from './Console';
import { acpCommand } from './Creators';
import { agentTitle, answer, cancel, fold, reconnectNow, restart, rpc, useWorkbench, type Ask, type BridgeState, type ConfigOption, type Item, type Plan, type SessionInfo, type ToolCall } from '../workbench/store';
import { Diff, Markdown } from '../workbench/render';
import CATALOG from '../../../acp-bridge/agents.json';
import '../workbench/workbench.css';

interface CatalogAgent { id: string; registry: string; name: string; description: string; website: string; featured?: boolean; launch: { npx?: string; uvx?: string; bin?: string; args: string[] } }
const AGENTS = (CATALOG as { agents: CatalogAgent[] }).agents;
interface Overview {
  command: string; command_base: string; version: string; server: string;
  links: { id: string; host: string; os: string | null; created_at: number; last_used_at: number | null; expires_at: number; project_scope: 'all' | 'selected'; projects: { id: string; title: string; slug: string | null }[] | null }[];
  projects: { id: string; title: string; slug: string | null; status: string }[];
}

const hue = (s: string) => { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h % 360; };
const initials = (name: string) => name.replace(/[^\p{L}\p{N} ]/gu, ' ').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '·';
export function AgentMark({ id, name, size = 'm' }: { id: string; name: string; size?: 's' | 'm' | 'l' }) {
  return <span className={`wb-mark ${size}`} style={{ ['--h' as string]: hue(id || name) }} aria-hidden="true">{initials(name)}</span>;
}
/** A path inside the agent's folder, shown relative to it. */
const rel = (cwd: string | undefined, p: string) => { const c = (cwd || '').replace(/[\\/]+$/, ''); return c && p.startsWith(c + '/') || c && p.startsWith(c + '\\') ? p.slice(c.length + 1) : p; };
const base = (p: string) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;
const agentById = (id?: string) => AGENTS.find((a) => a.id === id);
const isBin = (a: CatalogAgent) => !!a.launch.bin;

// ----- the page ------------------------------------------------------------------------------------------------------
export function Workbench() {
  const loc = useLocation();
  const pair = query().get('pair');
  const wb = useWorkbench();
  const ov = useData<Overview>('/acp/overview');
  const live = [...wb.bridges.values()].filter((b) => b.info.agent);
  void loc;

  return (
    <div className="wrap page">
      <PageHeader eyebrow={t('Console', '控制台')} title={t('Workbench', '工作台')}
        sub={t('Your own coding agent, running on your computer, driven from here. Agent Client Protocol (ACP).', '你自己的编程智能体在你的电脑上运行，在这里操控。基于 Agent Client Protocol（ACP）。')} />
      <ConsoleTabs on="workbench" />
      <div className="stack l">
        {pair && <PairApproval code={pair} onDone={() => { navigate('/console/workbench', true); void ov.reload(); }} />}
        {ov.error && !ov.data && <Fail error={ov.error} retry={ov.reload} />}
        {wb.conn !== 'open' && live.length > 0 && <div className="wb-conn" role="status"><span className="wb-dot warn" />{t('Reconnecting to your agents…', '正在重新连接你的智能体…')} <button className="linkish" onClick={reconnectNow}>{t('Retry now', '立即重试')}</button></div>}
        {live.length
          ? <Bench bridges={live} ov={ov.data} reloadOv={ov.reload} />
          : ov.data ? <Setup ov={ov.data} conn={wb.conn} reloadOv={ov.reload} /> : <Skeleton><SkRows n={4} /></Skeleton>}
      </div>
    </div>
  );
}

// ----- connecting a computer -------------------------------------------------------------------------------------------
function PairApproval({ code, onDone }: { code: string; onDone: () => void }) {
  const { toast } = useApp(), { busy, act } = useAct();
  const d = useData<{ code: string; host: string; agent: string; cwd: string | null; os: string | null; from: string | null; elsewhere: boolean; projects: { id: string; title: string; status: string }[] }>(`/acp/pair/${encodeURIComponent(code)}`);
  const [scope, setScope] = useState<'all' | 'selected'>('all'), [picked, setPicked] = useState<string[]>([]), [q, setQ] = useState('');
  if (d.error) return <Notice tone="bad" title={t('This code cannot be used', '此代码无法使用')} actions={<Button size="sm" onClick={onDone}>{t('Close', '关闭')}</Button>}>{d.error.message}</Notice>;
  if (!d.data) return <Card pad><Skeleton><SkRows n={3} thumb={false} /></Skeleton></Card>;
  const p = d.data, list = p.projects.filter((x) => !q || x.title.toLowerCase().includes(q.toLowerCase()));
  const decide = (decision: 'approve' | 'deny') => act('pair', async () => {
    await api(`/acp/pair/${encodeURIComponent(code)}`, { method: 'POST', body: { decision, project_scope: scope, project_ids: picked } });
    toast(decision === 'approve' ? t('Connected. Your agent appears here in a moment.', '已连接。你的智能体马上会出现在这里。') : t('Declined.', '已拒绝。'));
    onDone();
  });
  return (
    <Card tone="accent" className="wb-pair" title={t('Connect this computer?', '连接这台电脑？')} aside={<span className="mono">{p.code}</span>}>
      <div className="pad stack">
        <p>{t('Check that the terminal shows the same code. Once connected, agents you start on this computer can work in the folder you start them in and use HearthCade for your account.', '请确认终端显示的是同一个代码。连接后，你在这台电脑上启动的智能体可以在启动时所在的文件夹中工作，并以你的账户使用 HearthCade。')}</p>
        <dl className="wb-kv">
          <dt>{t('Computer', '电脑')}</dt><dd>{p.host}{p.os ? <span className="dim"> · {p.os}</span> : null}</dd>
          <dt>{t('Agent', '智能体')}</dt><dd>{p.agent}</dd>
          {p.cwd && <><dt>{t('Folder', '文件夹')}</dt><dd className="mono clip">{p.cwd}</dd></>}
          {p.from && <><dt>{t('Requested from', '请求来源')}</dt><dd>{p.from}</dd></>}
        </dl>
        {p.elsewhere && <Notice tone="bad" title={t('This request comes from another country than you', '此请求来自与你不同的国家')}>{t('If you did not just run the command yourself, decline it.', '如果这不是你刚刚运行的命令，请拒绝。')}</Notice>}
        <fieldset className="wb-scope">
          <legend>{t('Which games may its agents work on?', '它的智能体可以处理哪些游戏？')}</legend>
          <label className={scope === 'all' ? 'on' : ''}><input type="radio" name="scope" checked={scope === 'all'} onChange={() => setScope('all')} /><span><b>{t('All my games', '我的全部游戏')}</b><small>{t('Including games created later.', '包括之后创建的游戏。')}</small></span></label>
          <label className={scope === 'selected' ? 'on' : ''}><input type="radio" name="scope" checked={scope === 'selected'} onChange={() => setScope('selected')} disabled={!p.projects.length} /><span><b>{t('Only the games I pick', '仅我选择的游戏')}</b><small>{p.projects.length ? t('It cannot see or create other games.', '它无法查看或创建其他游戏。') : t('You have no games yet.', '你还没有游戏。')}</small></span></label>
          {scope === 'selected' && (
            <div className="wb-pick">
              {p.projects.length > 8 && <input className="input" type="search" placeholder={t('Search your games', '搜索你的游戏')} value={q} onChange={(e) => setQ(e.target.value)} />}
              <div className="wb-pick-list">{list.map((x) => <label key={x.id}><input type="checkbox" checked={picked.includes(x.id)} onChange={(e) => setPicked((v) => e.target.checked ? [...v, x.id] : v.filter((y) => y !== x.id))} /> {x.title}</label>)}</div>
            </div>
          )}
        </fieldset>
        <div className="row wrapx">
          <Button variant="primary" onClick={() => decide('approve')} disabled={busy === 'pair' || (scope === 'selected' && !picked.length)}>{t('Connect', '连接')}</Button>
          <Button onClick={() => decide('deny')} disabled={busy === 'pair'}>{t('Decline', '拒绝')}</Button>
        </div>
      </div>
    </Card>
  );
}

/** Pick an agent and get the one command that starts it. */
function AgentPicker({ ov, value, onChange, custom, setCustom }: { ov: Overview; value: string; onChange: (id: string) => void; custom: string; setCustom: (s: string) => void }) {
  const [all, setAll] = useState(false);
  const shown = all ? AGENTS : AGENTS.filter((a) => a.featured);
  const a = agentById(value);
  const cmd = value === 'custom' ? acpCommand(ov.server, '', custom.trim() || '<agent command>') : acpCommand(ov.server, value);
  return (
    <div className="stack">
      <div className="wb-agents" role="radiogroup" aria-label={t('Agent', '智能体')}>
        {shown.map((x) => (
          <button key={x.id} type="button" role="radio" aria-checked={value === x.id} className={value === x.id ? 'on' : ''} onClick={() => onChange(x.id)} title={x.description}>
            <AgentMark id={x.id} name={x.name} size="s" /><span className="clip">{x.name}</span>
          </button>
        ))}
        <button type="button" role="radio" aria-checked={value === 'custom'} className={value === 'custom' ? 'on' : ''} onClick={() => onChange('custom')}>
          <span className="wb-mark s plain" aria-hidden="true">{'>_'}</span><span>{t('Other ACP agent', '其他 ACP 智能体')}</span>
        </button>
      </div>
      <button type="button" className="linkish fs-sm" onClick={() => setAll(!all)}>{all ? t('Show fewer', '收起') : t('Show all {n} agents from the ACP registry', '显示 ACP 注册表中的全部 {n} 个智能体', { n: AGENTS.length })}</button>
      {value === 'custom' && <input className="input mono" placeholder={t('The command that starts your agent in ACP mode', '以 ACP 模式启动你的智能体的命令')} value={custom} onChange={(e) => setCustom(e.target.value)} aria-label={t('Agent command', '智能体命令')} />}
      <Code text={cmd} />
      <p className="dim fs-sm">
        {a && isBin(a)
          ? <>{t('Install {name} first, so the command "{bin}" works in your terminal.', '请先安装 {name}，确保终端里可以运行 “{bin}” 命令。', { name: a.name, bin: a.launch.bin! })} <a href={a.website} target="_blank" rel="noreferrer">{t('Get {name}', '获取 {name}', { name: a.name })}</a>. </>
          : a ? <>{t('{name} is fetched with npx the first time.', '首次运行时会通过 npx 下载 {name}。', { name: a.name })} <a href={a.website} target="_blank" rel="noreferrer">{t('About {name}', '关于 {name}', { name: a.name })}</a>. </> : null}
        {t('Needs Node.js 22 or newer. Sign in to the agent the way it asks (for example its own login or API key).', '需要 Node.js 22 或更高版本。按智能体自己的方式登录（例如它自带的登录或 API 密钥）。')}
      </p>
    </div>
  );
}

function Setup({ ov, conn, reloadOv }: { ov: Overview; conn: string; reloadOv: () => void }) {
  const [agent, setAgent] = useState(() => { try { return localStorage.getItem('wb.agent') || 'claude'; } catch { return 'claude'; } });
  const [custom, setCustom] = useState('');
  const pick = (id: string) => { setAgent(id); try { localStorage.setItem('wb.agent', id); } catch { /* private */ } };
  return (
    <div className="cols wb-setup">
      <Card title={t('Bring your agent into the console', '把你的智能体带进控制台')}>
        <ol className="wb-steps">
          <li>
            <h3>{t('Pick your agent', '选择你的智能体')}</h3>
            <p className="mute">{t('Any agent that speaks the Agent Client Protocol: the same ones Zed and JetBrains run.', '任何支持 Agent Client Protocol 的智能体，与 Zed 和 JetBrains 使用的相同。')}</p>
            <AgentPicker ov={ov} value={agent} onChange={pick} custom={custom} setCustom={setCustom} />
          </li>
          <li>
            <h3>{t('Run it in your game\'s folder', '在你的游戏文件夹中运行')}</h3>
            <p className="mute">{t('Open a terminal in the folder you want the agent to work in, and run the command above. The agent runs on your computer with your files; this page is its window.', '在希望智能体工作的文件夹中打开终端，运行上面的命令。智能体在你的电脑上运行并使用你的文件，这个页面是它的窗口。')}</p>
          </li>
          <li>
            <h3>{t('Approve the code', '确认代码')}</h3>
            <p className="mute">{t('The first time, the terminal shows a code and opens this page to approve it. After that the computer is remembered: start any agent there and it appears here.', '首次运行时，终端会显示一个代码并打开此页面让你确认。之后这台电脑会被记住：在那里启动任何智能体都会出现在这里。')}</p>
            <div className="wb-wait" role="status"><span className={`wb-dot ${conn === 'open' ? 'pulse' : 'warn'}`} />{conn === 'open' ? t('Waiting for an agent to connect…', '正在等待智能体连接…') : t('Connecting to the workbench…', '正在连接工作台…')}</div>
          </li>
        </ol>
      </Card>
      <div className="stack l">
        <ModeExplainer current="acp" />
        <Machines ov={ov} reload={reloadOv} />
      </div>
    </div>
  );
}

/** MCP or ACP: one short card that says both exist and the creator picks one. */
export function ModeExplainer({ current }: { current: 'mcp' | 'acp' }) {
  return (
    <Card title={t('Two ways to work, pick one', '两种工作方式，任选其一')} pad>
      <div className="wb-modes">
        <div className={current === 'mcp' ? 'on' : ''}>
          <b>MCP</b><span>{t('HearthCade inside your agent', '把 HearthCade 接入你的智能体')}</span>
          <p>{t('Keep using Claude, ChatGPT, Codex or Cursor where they are. They call HearthCade\'s tools.', '继续在原处使用 Claude、ChatGPT、Codex 或 Cursor，由它们调用 HearthCade 的工具。')}</p>
          {current !== 'mcp' && <Link to="/console#connect" className="fs-sm">{t('Set up MCP', '设置 MCP')} →</Link>}
        </div>
        <div className={current === 'acp' ? 'on' : ''}>
          <b>ACP</b><span>{t('Your agent inside HearthCade', '把你的智能体接入 HearthCade')}</span>
          <p>{t('Run your agent on your computer and work with it here, next to your games.', '在你的电脑上运行智能体，在这里、在你的游戏旁边与它协作。')}</p>
          {current !== 'acp' && <Link to="/console/workbench" className="fs-sm">{t('Open the workbench', '打开工作台')} →</Link>}
        </div>
      </div>
      <p className="dim fs-sm">{t('Both reach the same tools, games and versions. You can switch at any time.', '两种方式使用相同的工具、游戏和版本，随时可以切换。')}</p>
    </Card>
  );
}

function Machines({ ov, reload }: { ov: Overview; reload: () => void }) {
  const { busy, act } = useAct();
  const remove = (id: string) => act('rm' + id, async () => { await api(`/acp/links/${encodeURIComponent(id)}`, { method: 'DELETE' }); reload(); }, t('Disconnected. Its agents stopped.', '已断开连接，它的智能体已停止。'));
  return (
    <Card title={t('Connected computers', '已连接的电脑')} aside={ov.links.length ? num(ov.links.length) : undefined}>
      {ov.links.length ? ov.links.map((l) => (
        <div key={l.id} className="wb-machine">
          <div className="grow stack s">
            <b className="clip">{l.host}</b>
            <span className="dim fs-sm">{l.project_scope === 'all' ? t('All games', '全部游戏') : (l.projects || []).map((p) => p.title).join(', ') || t('No games', '没有游戏')} · {t('last used', '最近使用')} {ago(l.last_used_at || l.created_at)} · {t('until', '有效期至')} {date(l.expires_at)}</span>
          </div>
          <Button size="sm" variant="danger" onClick={() => remove(l.id)} disabled={busy === 'rm' + l.id}>{t('Disconnect', '断开')}</Button>
        </div>
      )) : <div className="pad mute fs-sm">{t('No computer is connected yet.', '还没有连接任何电脑。')}</div>}
    </Card>
  );
}

// ----- the bench: agents, sessions, conversation --------------------------------------------------------------------
function Bench({ bridges, ov, reloadOv }: { bridges: BridgeState[]; ov: Overview | null; reloadOv: () => void }) {
  const [sel, setSel] = useState<string>(() => { try { return sessionStorage.getItem('wb.bridge') || ''; } catch { return ''; } });
  const b = bridges.find((x) => x.info.id === sel) || bridges[bridges.length - 1];
  const sessions = useMemo(() => [...b.sessions.values()].sort((x, y) => y.createdAt - x.createdAt), [b.sessions, b.sessions.size]);
  const [sid, setSid] = useState<string>('');
  const s = b.sessions.get(sid) || null;
  const [adding, setAdding] = useState(false), [rail, setRail] = useState(false);
  useEffect(() => { try { sessionStorage.setItem('wb.bridge', b.info.id); } catch { /* fine */ } }, [b.info.id]);
  // follow the newest session when none is chosen (or the chosen one went away)
  useEffect(() => { if (!s && sessions.length) setSid(sessions[0].sessionId); }, [s, sessions]);

  const choose = (id: string) => { setSel(id); setSid(''); };
  const otherAsks = bridges.filter((x) => x !== b && x.asks.size).length;

  return (
    <div className={`wb ${rail ? 'rail-open' : ''}`}>
      <aside className="wb-side" aria-label={t('Agents and sessions', '智能体与会话')}>
        <div className="wb-side-h">{t('Agents', '智能体')}{otherAsks > 0 && <Badge tone="accent">{otherAsks}</Badge>}</div>
        <div className="wb-bridges">
          {bridges.map((x) => (
            <button key={x.info.id} className={`wb-bridge ${x === b ? 'on' : ''}`} onClick={() => choose(x.info.id)} aria-current={x === b}>
              <AgentMark id={x.info.agentId || x.info.agent || ''} name={agentTitle(x)} />
              <span className="grow stack">
                <b className="clip">{agentTitle(x)}</b>
                <small className="clip dim">{x.info.host} · {base(x.info.cwd || x.cwd || '')}</small>
              </span>
              <StatusDot b={x} />
            </button>
          ))}
        </div>
        <button className="wb-add" onClick={() => setAdding(true)}>+ {t('Add an agent', '添加智能体')}</button>

        <div className="wb-side-h">
          {t('Sessions', '会话')}
          <button className="btn btn-sm btn-ghost" onClick={() => setSid('')} disabled={b.status !== 'ready'}>+ {t('New', '新建')}</button>
        </div>
        <div className="wb-sessions">
          {sessions.length ? sessions.map((x) => (
            <button key={x.sessionId} className={`wb-session ${x.sessionId === sid ? 'on' : ''}`} onClick={() => setSid(x.sessionId)}>
              <span className="clip">{x.title || t('New session', '新会话')}</span>
              <small className="dim">{x.running ? <><span className="wb-dot pulse" />{t('working', '工作中')}</> : ago(x.updatedAt)}{[...b.asks.values()].some((a) => a.sessionId === x.sessionId) && <Badge tone="accent">{t('Needs you', '需要你处理')}</Badge>}</small>
            </button>
          )) : <p className="dim fs-sm pad-s">{t('No sessions yet.', '还没有会话。')}</p>}
        </div>
      </aside>

      <section className="wb-main" aria-label={t('Conversation', '对话')}>
        <Conversation key={b.info.id + '|' + (s?.sessionId || 'new')} b={b} s={s} onSession={setSid} onRail={() => setRail(!rail)} />
      </section>

      <aside className="wb-rail" aria-label={t('Plan and files', '计划与文件')}>
        <Rail b={b} s={s} />
      </aside>

      {adding && ov && (
        <Modal onClose={() => setAdding(false)} wide>
          <div className="stack l pad-l">
            <h2 className="wb-modal-h">{t('Add an agent', '添加智能体')}</h2>
            <p className="mute">{t('Run another agent on a connected computer, in any folder: it shows up here next to this one. On a new computer you approve a code first.', '在已连接的电脑上、任意文件夹中运行另一个智能体，它会出现在这里。在新电脑上需要先确认代码。')}</p>
            <AddAgent ov={ov} />
            <Machines ov={ov} reload={reloadOv} />
            <div className="row"><Button onClick={() => setAdding(false)}>{t('Done', '完成')}</Button></div>
          </div>
        </Modal>
      )}
    </div>
  );
}

function AddAgent({ ov }: { ov: Overview }) {
  const [agent, setAgent] = useState('claude'), [custom, setCustom] = useState('');
  return <AgentPicker ov={ov} value={agent} onChange={setAgent} custom={custom} setCustom={setCustom} />;
}

function StatusDot({ b }: { b: BridgeState }) {
  const busy = [...b.sessions.values()].some((s) => s.running), asks = b.asks.size;
  const [tone, label] = asks ? ['warn', t('Needs you', '需要你处理')] : b.status === 'ready' ? (busy ? ['pulse', t('Working', '工作中')] : ['good', t('Ready', '就绪')]) : b.status === 'starting' || b.status === 'connecting' ? ['pulse', t('Starting', '启动中')] : ['bad', b.status === 'exited' ? t('Stopped', '已停止') : t('Failed', '失败')];
  return <span className={`wb-dot ${tone}`} title={label} aria-label={label} />;
}

// ----- one conversation -------------------------------------------------------------------------------------------
function Conversation({ b, s, onSession, onRail }: { b: BridgeState; s: SessionInfo | null; onSession: (id: string) => void; onRail: () => void }) {
  const { toast } = useApp();
  const entries = (s && b.transcripts.get(s.sessionId)) || EMPTY;
  const { items } = useMemo(() => fold(entries), [entries, entries.length]);
  const asks = [...b.asks.values()].filter((a) => s && a.sessionId === s.sessionId);
  const [authNeeded, setAuthNeeded] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const scroller = useRef<HTMLDivElement>(null), atBottom = useRef(true);
  useEffect(() => { const el = scroller.current; if (el && atBottom.current) el.scrollTop = el.scrollHeight; });
  const onScroll = () => { const el = scroller.current; if (el) atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60; };

  const newSession = async (): Promise<string | null> => {
    setCreating(true);
    try {
      const r = await rpc<{ sessionId: string }>(b.info.id, 'session/new', {});
      setAuthNeeded(null); onSession(r.sessionId); return r.sessionId;
    } catch (e: any) {
      if (e?.code === -32000 || /auth/i.test(String(e?.message))) setAuthNeeded(String(e.message || ''));
      else toast(e?.message || String(e), true);
      return null;
    } finally { setCreating(false); }
  };

  const send = async (blocks: any[]) => {
    const id = s?.sessionId || await newSession();
    if (!id) return false;
    atBottom.current = true;
    rpc(b.info.id, 'session/prompt', { sessionId: id, prompt: blocks }).catch((e) => toast(e?.message || String(e), true));
    return true;
  };

  const title = s?.title || (s ? t('New session', '新会话') : t('Start a session', '开始会话'));
  return (
    <>
      <header className="wb-top">
        <div className="grow stack s">
          <b className="clip">{title}</b>
          <small className="dim clip">{agentTitle(b)}{b.init?.agentInfo?.version ? ` ${b.init.agentInfo.version}` : ''} · <span className="mono">{b.info.cwd || b.cwd}</span></small>
        </div>
        <button className="btn btn-sm btn-ghost wb-rail-btn" onClick={onRail}>{t('Plan', '计划')}</button>
      </header>

      <div className="wb-scroll" ref={scroller} onScroll={onScroll}>
        <div className="wb-thread">
          <AgentState b={b} />
          {authNeeded !== null && <AuthCard b={b} detail={authNeeded} onDone={() => { setAuthNeeded(null); void newSession(); }} />}
          {s?.trimmed && <p className="dim fs-sm wb-trim">{t('The start of this long session is not shown.', '这个长会话的开头部分未显示。')}</p>}
          {!s && b.status === 'ready' && authNeeded === null && <Welcome b={b} onPick={(text) => void send([{ type: 'text', text }])} busy={creating} />}
          {items.map((it, i) => (
            <Fragment key={it.key}>
              {it.kind !== 'user' && it.kind !== 'end' && (i === 0 || items[i - 1].kind === 'user') && <div className="wb-who"><AgentMark id={b.info.agentId || ''} name={agentTitle(b)} size="s" /><b>{agentTitle(b)}</b></div>}
              <ItemView it={it} cwd={b.info.cwd} />
            </Fragment>
          ))}
          {asks.map((a) => <AskCard key={a.key} b={b} a={a} />)}
          {s?.running && !asks.length && <div className="wb-working" role="status"><span className="wb-dots" aria-hidden="true"><i /><i /><i /></span>{t('Working…', '工作中…')}</div>}
        </div>
      </div>

      <Composer b={b} s={s} onSend={send} disabled={b.status !== 'ready' || creating} />
    </>
  );
}
const EMPTY: any[] = [];

function AgentState({ b }: { b: BridgeState }) {
  const a = agentById(b.info.agentId);
  if (b.status === 'ready') return null;
  if (b.status === 'starting' || b.status === 'connecting' || !b.ready) return <Starting b={b} />;
  return (
    <Notice tone="bad" title={b.status === 'exited' ? t('{name} stopped', '{name} 已停止', { name: agentTitle(b) }) : t('{name} could not start', '{name} 无法启动', { name: agentTitle(b) })}
      actions={<Button size="sm" variant="primary" onClick={() => restart(b.info.id, true)}>{t('Retry', '重试')}</Button>}>
      <div className="stack s">
        <span>{b.detail}</span>
        {/not found/i.test(b.detail) && a && <span>{t('Install {name} on that computer first:', '请先在那台电脑上安装 {name}：', { name: a.name })} <a href={a.website} target="_blank" rel="noreferrer">{a.website}</a></span>}
        {b.stderr.length > 0 && <details open={b.status === 'failed'}><summary>{t('What the agent printed', '智能体输出的内容')}</summary><pre className="wb-pre small">{b.stderr.slice(-30).join('\n')}</pre></details>}
      </div>
    </Notice>
  );
}

function AuthCard({ b, detail, onDone }: { b: BridgeState; detail: string; onDone: () => void }) {
  const { busy, act } = useAct();
  const methods = b.init?.authMethods || [];
  const login = (id: string) => act('auth' + id, async () => { await rpc(b.info.id, 'authenticate', { methodId: id }); onDone(); });
  return (
    <Notice tone="info" title={t('Sign in to {name}', '登录 {name}', { name: agentTitle(b) })}>
      <div className="stack s">
        <span>{t('The agent needs you to sign in before it can start a session.', '智能体需要你先登录才能开始会话。')} {detail && <span className="dim">({detail})</span>}</span>
        <div className="row wrapx">
          {methods.filter((m) => !m.type || m.type === 'agent').map((m) => <Button key={m.id} size="sm" variant="primary" onClick={() => login(m.id)} disabled={busy === 'auth' + m.id} title={m.description}>{m.name}</Button>)}
          <Button size="sm" onClick={onDone}>{t('I signed in, try again', '我已登录，重试')}</Button>
        </div>
        <span className="dim fs-sm">{t('Some agents sign in from their own terminal command (for example running the agent once, or setting its API key). Do that on the computer, then try again.', '有些智能体需要通过它们自己的终端命令登录（例如先运行一次智能体，或设置它的 API 密钥）。在那台电脑上完成后再重试。')}</span>
      </div>
    </Notice>
  );
}

const SUGGEST = () => [
  t('Make a small web game about a lighthouse keeper catching falling stars, deploy a preview and show me.', '做一款关于灯塔守护者接住坠落星星的网页小游戏，部署预览并给我看看。'),
  t('Deploy a preview of the game in this folder and fix whatever verification reports.', '为这个文件夹里的游戏部署预览，并修复验证报告中的问题。'),
  t('Check my game against the HearthCade game standards and list what to fix.', '按照 HearthCade 游戏标准检查我的游戏，列出需要修复的地方。'),
];
function Welcome({ b, onPick, busy }: { b: BridgeState; onPick: (text: string) => void; busy: boolean }) {
  return (
    <div className="wb-welcome">
      <AgentMark id={b.info.agentId || ''} name={agentTitle(b)} size="l" />
      <h2>{t('What should {name} work on?', '{name} 要做什么？', { name: agentTitle(b) })}</h2>
      <p className="mute">{b.mcp ? t('It works in {folder} on your computer and has HearthCade\'s tools for your account.', '它在你电脑上的 {folder} 中工作，并可以使用你账户的 HearthCade 工具。', { folder: base(b.info.cwd || b.cwd) }) : t('It works in {folder} on your computer.', '它在你电脑上的 {folder} 中工作。', { folder: base(b.info.cwd || b.cwd) })}</p>
      <div className="wb-suggest">{SUGGEST().map((x) => <button key={x} onClick={() => onPick(x)} disabled={busy}>{x}</button>)}</div>
    </div>
  );
}

function SessionControls({ b, s }: { b: BridgeState; s: SessionInfo }) {
  const { toast } = useApp();
  const setOpt = (o: ConfigOption, value: string) => rpc(b.info.id, 'session/set_config_option', { sessionId: s.sessionId, configId: o.id, value }).catch((e) => toast(e.message, true));
  const controls: ReactNode[] = [];
  if (s.configOptions?.length) {
    for (const o of s.configOptions) {
      if (o.type !== 'select' || !o.options) continue;
      const flat = o.options.flatMap((x: any) => (x.options ? x.options.map((y: any) => ({ ...y, group: x.name })) : [x]));
      // the model and the mode speak for themselves; other settings ("Fast mode: Off") keep their name
      const named = o.category !== 'model' && o.category !== 'mode';
      controls.push(<Pill key={o.id} label={o.name} named={named} title={o.description || o.name} value={String(o.currentValue)} onChange={(v) => void setOpt(o, v)} options={flat.map((x: any) => ({ value: x.value, name: x.group ? `${x.group} · ${x.name}` : x.name }))} />);
    }
  } else {
    if (s.models?.availableModels?.length) controls.push(<Pill key="model" label={t('Model', '模型')} value={s.models.currentModelId} onChange={(v) => rpc(b.info.id, 'session/set_model', { sessionId: s.sessionId, modelId: v }).catch((er) => toast(er.message, true))} options={s.models.availableModels.map((m) => ({ value: m.modelId, name: m.name }))} />);
    if (s.modes?.availableModes?.length) controls.push(<Pill key="mode" label={t('Mode', '模式')} value={s.modes.currentModeId} onChange={(v) => rpc(b.info.id, 'session/set_mode', { sessionId: s.sessionId, modeId: v }).catch((er) => toast(er.message, true))} options={s.modes.availableModes.map((m) => ({ value: m.id, name: m.name }))} />);
  }
  return <>{controls}</>;
}

/** A setting as a small pill: the native menu opens on it, so it works with keyboards, screen readers and phones. */
function Pill({ label, named, title, value, options, onChange }: { label: string; named?: boolean; title?: string; value: string; options: { value: string; name: string }[]; onChange: (v: string) => void }) {
  const cur = options.find((o) => o.value === value);
  return (
    <label className="wb-pill" title={title || label}>
      {named && <span className="dim">{label}</span>}
      <b>{cur?.name ?? value}</b>
      <svg viewBox="0 0 10 6" aria-hidden="true"><path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" /></svg>
      <select value={value} onChange={(e) => onChange(e.target.value)} aria-label={label}>{options.map((o) => <option key={o.value} value={o.value}>{o.name}</option>)}</select>
    </label>
  );
}

// ----- transcript items -------------------------------------------------------------------------------------------
const KIND_GLYPH: Record<string, string> = { read: '◱', edit: '✎', delete: '⌫', move: '⇄', search: '⌕', execute: '›_', think: '∴', fetch: '↓', switch_mode: '⇋', other: '•' };
/** An agent on its way up. The first run of an npx agent downloads it (hundreds of MB for some), shown with its size. */
function Starting({ b }: { b: BridgeState }) {
  const [, tick] = useState(0);
  useEffect(() => { const h = setInterval(() => tick((n) => n + 1), 1000); return () => clearInterval(h); }, []);
  const p = b.progress;
  const secs = b.since ? Math.max(0, Math.round((Date.now() - b.since) / 1000)) : 0;
  const clock = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
  const mb = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(2)} GB` : `${Math.round(n / 1e6)} MB`);
  const down = p?.phase === 'downloading';
  const pct = down && p.total ? Math.min(99, Math.floor((100 * p.bytes) / p.total)) : null;
  const log = b.stderr.slice(-30);
  return (
    <div className={`wb-start${p?.stalled ? ' stalled' : ''}`} role="status" aria-live="polite">
      <div className="wb-start-h">
        <AgentMark id={b.info.agentId || ''} name={agentTitle(b)} size="s" />
        <b className="grow">{down ? t('First-time setup: downloading {name}', '首次设置：正在下载 {name}', { name: agentTitle(b) }) : t('Starting {name}…', '正在启动 {name}…', { name: agentTitle(b) })}</b>
        <span className="mono dim wb-clock" title={t('Elapsed', '已用时间')}>{clock}</span>
      </div>
      {(down || secs >= 5) && <div className={`wb-bar${pct === null ? ' busy' : ''}`} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct ?? undefined}><i style={pct === null ? undefined : { width: `${pct}%` }} /></div>}
      {down
        ? <p className="fs-sm">{p.total ? t('{done} of about {total} · {pct}%', '{done} / 约 {total} · {pct}%', { done: mb(p.bytes), total: mb(p.total), pct: pct ?? 0 }) : t('{done} downloaded', '已下载 {done}', { done: mb(p.bytes) })} <span className="dim">{t('Only the first run downloads it.', '只有第一次运行需要下载。')}</span></p>
        : secs >= 10 && <p className="dim fs-sm">{t('The first run downloads the agent, which can take several minutes for a large one such as Codex. Its terminal shows the progress.', '首次运行会先下载智能体，像 Codex 这样较大的智能体可能需要几分钟。进度会显示在它的终端里。')}</p>}
      {p?.line && <p className="mono dim fs-sm clip wb-start-line" title={p.line}>{p.line}</p>}
      {p?.stalled && (
        <div className="wb-start-stall">
          <span>{t('Nothing has changed for 2 minutes. It may be stuck: check the network on that computer, then retry.', '已经 2 分钟没有进展，可能卡住了。请检查那台电脑的网络，然后重试。')}</span>
          <Button size="sm" variant="primary" onClick={() => restart(b.info.id, true)}>{t('Retry', '重试')}</Button>
        </div>
      )}
      {log.length > 0 && <details className="wb-start-log"><summary>{t('Show log', '查看日志')}</summary><pre className="wb-pre small">{log.join('\n')}</pre></details>}
    </div>
  );
}

function ItemView({ it, cwd }: { it: Item; cwd?: string }) {
  switch (it.kind) {
    case 'user': return <div className="wb-msg user">{it.blocks.map((c, i) => <Block key={i} c={c} />)}</div>;
    case 'agent': return <div className="wb-msg agent"><Markdown text={it.text} />{it.blocks.map((c, i) => <Block key={i} c={c} />)}</div>;
    case 'thought': return <details className="wb-thought"><summary>{t('Thinking', '思考')}</summary><Markdown text={it.text} /></details>;
    case 'tool': return <ToolView c={it.call} cwd={cwd} />;
    case 'end':
      if (it.stopReason === 'end_turn') return <div className="wb-end" aria-hidden="true" />;
      if (it.stopReason === 'error') return <Notice tone="bad" title={t('The agent reported an error', '智能体报告了一个错误')}>{it.error}</Notice>;
      return <div className="wb-end labelled"><span>{it.stopReason === 'cancelled' ? t('Stopped', '已停止') : it.stopReason === 'max_tokens' ? t('Stopped: the answer reached the agent\'s length limit', '已停止：回答达到智能体的长度上限') : it.stopReason === 'max_turn_requests' ? t('Stopped: the agent reached its step limit for one message', '已停止：智能体达到单条消息的步骤上限') : it.stopReason === 'refusal' ? t('The agent declined this request', '智能体拒绝了这个请求') : it.stopReason}</span></div>;
    default: return null;
  }
}

function Block({ c }: { c: any }) {
  if (!c) return null;
  if (c.type === 'text') return <Markdown text={String(c.text || '')} />;
  if (c.type === 'image' && typeof c.data === 'string' && /^image\/(png|jpeg|gif|webp)$/.test(c.mimeType)) return <img className="wb-img" src={`data:${c.mimeType};base64,${c.data}`} alt="" />;
  if (c.type === 'resource_link') return <span className="wb-chip mono">{c.name || c.uri}</span>;
  if (c.type === 'resource') return <details className="wb-res"><summary className="mono">{c.resource?.uri}</summary>{c.resource?.text && <pre className="wb-pre">{String(c.resource.text).slice(0, 20000)}</pre>}</details>;
  return null;
}

function ToolView({ c, cwd }: { c: ToolCall; cwd?: string }) {
  const diffs = c.content.filter((x) => x?.type === 'diff');
  const rest = c.content.filter((x) => x?.type === 'content');
  const terms = c.content.filter((x) => x?.type === 'terminal');
  const has = diffs.length || rest.length || c.locations.length || c.rawInput != null || terms.length;
  const tone = c.status === 'completed' ? 'good' : c.status === 'failed' ? 'bad' : c.status === 'in_progress' ? 'info' : '';
  const label = c.status === 'completed' ? t('Done', '完成') : c.status === 'failed' ? t('Failed', '失败') : c.status === 'in_progress' ? t('Running', '运行中') : t('Pending', '等待中');
  const head = (
    <>
      <span className={`wb-glyph k-${c.kind}`} aria-hidden="true">{KIND_GLYPH[c.kind] || '•'}</span>
      <span className="grow clip">{c.title || c.toolCallId}</span>
      <span className={`wb-st ${tone}`}>{c.status === 'in_progress' && <span className="wb-dot pulse" />}{label}</span>
    </>
  );
  if (!has) return <div className="wb-tool flat"><div className="wb-tool-h">{head}</div></div>;
  return (
    <details className="wb-tool" open={diffs.length > 0 && diffs.length <= 3}>
      <summary className="wb-tool-h">{head}</summary>
      <div className="wb-tool-b">
        {c.locations.length > 0 && <div className="wb-locs">{c.locations.slice(0, 20).map((l, i) => <span key={i} className="wb-chip mono">{base(l.path)}{l.line ? `:${l.line}` : ''}</span>)}</div>}
        {diffs.map((d, i) => <Diff key={i} path={rel(cwd, d.path)} oldText={d.oldText ?? null} newText={String(d.newText ?? '')} />)}
        {rest.map((x, i) => <Block key={i} c={x.content} />)}
        {terms.length > 0 && <p className="dim fs-sm">{t('Ran a command on your computer.', '在你的电脑上运行了一条命令。')}</p>}
        {!diffs.length && !rest.length && c.rawInput != null && <pre className="wb-pre small">{JSON.stringify(c.rawInput, null, 2).slice(0, 6000)}</pre>}
      </div>
    </details>
  );
}

function AskCard({ b, a }: { b: BridgeState; a: Ask }) {
  const tc = a.params.toolCall || {};
  const diffs = Array.isArray(tc.content) ? tc.content.filter((x: any) => x?.type === 'diff') : [];
  const opts = a.params.options || [];
  return (
    <div className="wb-ask" role="alertdialog" aria-label={t('The agent asks for permission', '智能体请求许可')}>
      <div className="wb-ask-h"><span className={`wb-glyph k-${tc.kind || 'other'}`} aria-hidden="true">{KIND_GLYPH[tc.kind] || '?'}</span><b className="grow">{tc.title || t('The agent wants to continue', '智能体想要继续')}</b><Badge tone="accent">{t('Needs you', '需要你处理')}</Badge></div>
      {Array.isArray(tc.locations) && tc.locations.length > 0 && <div className="wb-locs">{tc.locations.map((l: any, i: number) => <span key={i} className="wb-chip mono">{rel(b.info.cwd, l.path)}{l.line ? `:${l.line}` : ''}</span>)}</div>}
      {diffs.slice(0, 3).map((d: any, i: number) => <Diff key={i} path={rel(b.info.cwd, d.path)} oldText={d.oldText ?? null} newText={String(d.newText ?? '')} />)}
      {tc.rawInput && typeof tc.rawInput === 'object' && 'command' in tc.rawInput && <pre className="wb-pre small">{String((tc.rawInput as any).command)}</pre>}
      <div className="row wrapx">
        {opts.map((o) => <Button key={o.optionId} size="sm" variant={o.kind.startsWith('allow') ? (o.kind === 'allow_once' ? 'primary' : undefined) : 'ghost'} onClick={() => answer(b.info.id, a.key, o.optionId)}>{o.name}</Button>)}
      </div>
    </div>
  );
}

// ----- writing to the agent ------------------------------------------------------------------------------------------
function Composer({ b, s, onSend, disabled }: { b: BridgeState; s: SessionInfo | null; onSend: (blocks: any[]) => Promise<boolean>; disabled: boolean }) {
  const { toast } = useApp();
  const [text, setText] = useState(''), [imgs, setImgs] = useState<{ mimeType: string; data: string; name: string }[]>([]), [menu, setMenu] = useState(0);
  const box = useRef<HTMLTextAreaElement>(null);
  const canImg = !!b.init?.agentCapabilities?.promptCapabilities?.image;
  const slash = text.match(/^\/(\S*)$/);
  const cmds = slash && s ? s.commands.filter((c) => c.name.toLowerCase().startsWith(slash[1].toLowerCase())).slice(0, 8) : [];
  useEffect(() => { box.current?.focus(); }, [s?.sessionId]);

  const addFiles = async (files: FileList | File[]) => {
    for (const f of [...files]) {
      if (!/^image\/(png|jpeg|gif|webp)$/.test(f.type)) continue;
      if (!canImg) { toast(t('This agent does not take pictures.', '这个智能体不接受图片。'), true); return; }
      if (f.size > 5 * 1024 * 1024) { toast(t('Pictures up to 5 MB.', '图片最大 5 MB。'), true); continue; }
      const data = await new Promise<string>((ok) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(',')[1] || ''); r.readAsDataURL(f); });
      setImgs((v) => [...v, { mimeType: f.type, data, name: f.name }].slice(0, 6));
    }
  };
  const submit = async () => {
    const body = text.trim();
    if ((!body && !imgs.length) || disabled || s?.running) return;
    const blocks: any[] = [];
    if (body) blocks.push({ type: 'text', text: body });
    for (const i of imgs) blocks.push({ type: 'image', mimeType: i.mimeType, data: i.data });
    setText(''); setImgs([]);
    const ok = await onSend(blocks);
    if (!ok) { setText(body); }
  };
  const key = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (cmds.length && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) { e.preventDefault(); setMenu((m) => (m + (e.key === 'ArrowDown' ? 1 : cmds.length - 1)) % cmds.length); return; }
    if (cmds.length && (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey))) { e.preventDefault(); setText('/' + cmds[Math.min(menu, cmds.length - 1)].name + ' '); setMenu(0); return; }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void submit(); }
    if (e.key === 'Escape' && s?.running) cancel(b.info.id, s.sessionId);
  };
  const paste = (e: ClipboardEvent) => { const f = [...e.clipboardData.files]; if (f.length) { e.preventDefault(); void addFiles(f); } };
  const drop = (e: DragEvent) => { if (e.dataTransfer.files.length) { e.preventDefault(); void addFiles(e.dataTransfer.files); } };

  return (
    <div className="wb-compose" onDragOver={(e) => e.preventDefault()} onDrop={drop}>
      {cmds.length > 0 && (
        <div className="wb-cmds" role="listbox">
          {cmds.map((c, i) => <button key={c.name} role="option" aria-selected={i === menu} className={i === menu ? 'on' : ''} onMouseDown={(e) => { e.preventDefault(); setText('/' + c.name + ' '); box.current?.focus(); }}><b className="mono">/{c.name}</b><span className="dim clip">{c.description}{c.input?.hint ? ` · ${c.input.hint}` : ''}</span></button>)}
        </div>
      )}
      {imgs.length > 0 && <div className="wb-imgs">{imgs.map((im, i) => <span key={i}><img src={`data:${im.mimeType};base64,${im.data}`} alt={im.name} /><button aria-label={t('Remove', '移除')} onClick={() => setImgs((v) => v.filter((_, j) => j !== i))}>×</button></span>)}</div>}
      <div className="wb-box">
      <textarea ref={box} rows={2} value={text} disabled={disabled} onChange={(e) => { setText(e.target.value); setMenu(0); }} onKeyDown={key} onPaste={paste}
        placeholder={disabled ? t('The agent is not ready.', '智能体尚未就绪。') : s?.commands.length ? t('Message {name} · / for commands', '给 {name} 发消息 · 输入 / 查看命令', { name: agentTitle(b) }) : t('Message {name}', '给 {name} 发消息', { name: agentTitle(b) })} aria-label={t('Message', '消息')} />
      <div className="wb-compose-bar">
        {canImg && <label className="wb-icon" title={t('Add picture', '添加图片')}><input type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple hidden onChange={(e) => { if (e.target.files) void addFiles(e.target.files); e.target.value = ''; }} /><svg viewBox="0 0 20 20" aria-hidden="true"><rect x="2.5" y="4" width="15" height="12" rx="2" fill="none" stroke="currentColor" strokeWidth="1.5" /><circle cx="7" cy="8.5" r="1.5" fill="currentColor" /><path d="M3 14l4.5-4 3.5 3 2.5-2 3.5 3" fill="none" stroke="currentColor" strokeWidth="1.5" /></svg><span className="sr-only">{t('Add picture', '添加图片')}</span></label>}
        <div className="wb-pills">{s && <SessionControls b={b} s={s} />}</div>
        {s?.usage && s.usage.size > 0 && <span className="wb-usage" title={t('Context used', '已用上下文')}><i style={{ width: `${Math.min(100, (100 * s.usage.used) / s.usage.size)}%` }} />{Math.round((100 * s.usage.used) / s.usage.size)}%{s.usage.cost ? ` · ${s.usage.cost.amount.toFixed(2)} ${s.usage.cost.currency}` : ''}</span>}
        {s?.running
          ? <button className="wb-send stop" onClick={() => cancel(b.info.id, s.sessionId)} title={t('Stop', '停止')} aria-label={t('Stop', '停止')}><svg viewBox="0 0 20 20" aria-hidden="true"><rect x="6" y="6" width="8" height="8" rx="1.5" fill="currentColor" /></svg></button>
          : <button className="wb-send" onClick={() => void submit()} disabled={disabled || (!text.trim() && !imgs.length)} title={t('Send', '发送')} aria-label={t('Send', '发送')}><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 16V4M4.5 9.5L10 4l5.5 5.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg></button>}
      </div>
      </div>
      <p className="wb-hint">{t('Enter to send · Shift+Enter for a new line', 'Enter 发送 · Shift+Enter 换行')}</p>
    </div>
  );
}

// ----- the side rail: plan, files, agent ----------------------------------------------------------------------------
function Rail({ b, s }: { b: BridgeState; s: SessionInfo | null }) {
  const entries = (s && b.transcripts.get(s.sessionId)) || EMPTY;
  const { plan, files } = useMemo(() => fold(entries), [entries, entries.length]);
  const caps = b.init?.agentCapabilities || {};
  return (
    <div className="stack">
      <section className="wb-panel">
        <h3>{t('Plan', '计划')}</h3>
        <PlanView plan={plan} />
      </section>
      <section className="wb-panel">
        <h3>{t('Files', '文件')}{files.size > 0 && <span className="dim"> {files.size}</span>}</h3>
        {files.size ? <ul className="wb-files">{[...files].slice(-40).reverse().map(([p, k]) => <li key={p} title={p}><span className={`wb-glyph s k-${k}`} aria-hidden="true">{KIND_GLYPH[k] || '•'}</span><span className="mono clip">{base(p)}</span></li>)}</ul> : <p className="dim fs-sm">{t('Files the agent reads or changes show up here.', '智能体读取或修改的文件会显示在这里。')}</p>}
      </section>
      <section className="wb-panel">
        <h3>{t('Agent', '智能体')}</h3>
        <dl className="wb-kv small">
          <dt>{t('Name', '名称')}</dt><dd>{agentTitle(b)}{b.init?.agentInfo?.version ? ` ${b.init.agentInfo.version}` : ''}</dd>
          <dt>{t('Computer', '电脑')}</dt><dd>{b.info.host}</dd>
          <dt>{t('Folder', '文件夹')}</dt><dd className="mono clip" title={b.info.cwd}>{b.info.cwd}</dd>
          <dt>HearthCade</dt><dd>{b.mcp ? <Badge tone="good">{t('Tools connected', '工具已连接')}</Badge> : <Badge>{t('Not connected', '未连接')}</Badge>}</dd>
          <dt>ACP</dt><dd>v{b.init?.protocolVersion ?? 1}{caps.promptCapabilities?.image ? ` · ${t('pictures', '图片')}` : ''}{caps.loadSession ? ` · ${t('resumes sessions', '可恢复会话')}` : ''}</dd>
        </dl>
        {(b.status === 'exited' || b.status === 'failed') && <Button size="sm" onClick={() => restart(b.info.id, true)}>{t('Retry', '重试')}</Button>}
      </section>
      <p className="dim fs-sm">{t('To stop this agent, press Ctrl+C in its terminal.', '要停止这个智能体，请在它的终端中按 Ctrl+C。')}</p>
    </div>
  );
}

function PlanView({ plan }: { plan: Plan | null }) {
  if (!plan) return <p className="dim fs-sm">{t('When the agent plans its work, the steps show up here.', '智能体规划工作时，步骤会显示在这里。')}</p>;
  if (!Array.isArray(plan)) return <Markdown text={plan.markdown} />;
  const done = plan.filter((p) => p.status === 'completed').length;
  return (
    <div className="stack s">
      <div className="wb-meter" aria-label={t('{done} of {n} steps done', '已完成 {done}/{n} 步', { done, n: plan.length })}><i style={{ width: `${plan.length ? (100 * done) / plan.length : 0}%` }} /></div>
      <ol className="wb-plan">{plan.map((p, i) => <li key={i} className={p.status}><span className="box" aria-hidden="true" />{p.content}</li>)}</ol>
    </div>
  );
}

