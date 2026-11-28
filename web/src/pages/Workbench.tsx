// The workbench: the creator's own coding agent, on their machine, used from the console over the Agent Client Protocol.
// The platform hosts no agent. A bridge on the creator's machine (acp-bridge/) runs it and relays to this page; see
// src/acp.ts for the platform side and web/src/workbench/store.ts for the live connection.
import { createPortal } from 'react-dom';
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent, type ReactNode } from 'react';
import { ago, api, date, Fail, Link, navigate, num, query, t, useAct, useApp, useData, useLocation } from '../lib';
import { Badge, Button, Card, Code, Modal, Notice, PageHeader } from '../ui';
import { Skeleton, SkRows } from '../ui/skeleton';
import { acpCommand } from './Creators';
import { agentTitle, answer, cancel, fold, launchAgent, quitAgent, reconnectNow, restart, rpc, useWorkbench, type Ask, type BridgeState, type ConfigOption, type Item, type Plan, type SessionInfo, type ToolCall } from '../workbench/store';
import { Diff, Markdown } from '../workbench/render';
import REGISTRY from '../workbench/registry.json';
import '../workbench/workbench.css';

/** An agent of the official ACP Registry (github.com/agentclientprotocol/registry), the list Zed and JetBrains offer. */
interface RegAgent { id: string; name: string; version: string; description: string; repository: string | null; website: string | null; license: string | null; authors: string[]; dist: { npx?: string; uvx?: string; binary?: string[] } }
/** The page's copy (scripts/acp-registry.mjs), replaced by the live registry from /acp/registry.json once it loads. */
let AGENTS: RegAgent[] = (REGISTRY as { agents: RegAgent[] }).agents;
const ICONS = new Set(AGENTS.map((a) => a.id));   // web/public/acp-icons/<id>.svg
/** The ids the bridge used before it followed the registry (an older bridge still reports them). */
const ALIASES: Record<string, string> = { claude: 'claude-acp', codex: 'codex-acp', copilot: 'github-copilot-cli', qwen: 'qwen-code', kimi: 'kimi-code', vibe: 'mistral-vibe', droid: 'factory-droid', amp: 'amp-acp', grok: 'grok-build', codebuddy: 'codebuddy-code', minimax: 'minimax-code', minion: 'minion-code', muse: 'muse-code' };
/** The agents a bridge before 1.0.6 knows, by the ids it used then. */
const OLD_IDS = new Set('claude codex gemini copilot cursor opencode qwen goose kimi kiro cline auggie vibe droid junie amp grok devin kilo autohand bob codebuddy crow-cli deepagents dimcode dirac fast-agent kimchi minimax minion muse nova poolside qoder stakpak vtcode'.split(' '));
const older = (v: string | undefined, than: string) => { const a = String(v || '0').split('.').map(Number), b = than.split('.').map(Number); for (let i = 0; i < 3; i++) if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) < (b[i] || 0); return false; };
/** The id to ask a bridge for: a bridge before 1.0.6 knows the registry's agents by its old ids, or not at all (null). */
function idFor(bridgeVersion: string | undefined, id: string): string | null {
  if (!older(bridgeVersion, '1.0.6')) return id;
  const old = Object.keys(ALIASES).find((k) => ALIASES[k] === id);
  if (old) return old;
  return OLD_IDS.has(id) && !ALIASES[id] ? id : null;   // "kimi" meant Kimi Code there, not the registry's Kimi
}
let registryAsked = false;
/** Loads the live registry once; the components re-render when it arrives. */
function useRegistry() {
  const [, bump] = useState(0);
  useEffect(() => {
    if (registryAsked) return;
    registryAsked = true;
    fetch('/acp/registry.json').then((r) => (r.ok ? r.json() : null)).then((r: { agents?: any[] } | null) => {
      const list = (r?.agents || []).filter((a) => a && typeof a.id === 'string' && typeof a.name === 'string').map((a): RegAgent => {
        const d = a.distribution || {};
        return { id: a.id, name: a.name, version: String(a.version || ''), description: String(a.description || ''), repository: a.repository || null, website: a.website || null, license: a.license_url || null, authors: Array.isArray(a.authors) ? a.authors : [],
          dist: { ...(d.npx ? { npx: d.npx.package } : {}), ...(d.uvx ? { uvx: d.uvx.package } : {}), ...(d.binary ? { binary: Object.keys(d.binary).sort() } : {}) } };
      });
      if (list.length >= 5) { AGENTS = list; bump((n) => n + 1); }
    }).catch(() => { /* the bundled copy stays */ });
  }, []);
}
interface Overview {
  command: string; command_base: string; version: string; server: string;
  links: { id: string; host: string; os: string | null; created_at: number; last_used_at: number | null; expires_at: number; project_scope: 'all' | 'selected'; projects: { id: string; title: string; slug: string | null }[] | null }[];
  projects: { id: string; title: string; slug: string | null; status: string }[];
}

const hue = (s: string) => { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h % 360; };
const initials = (name: string) => name.replace(/[^\p{L}\p{N} ]/gu, ' ').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '·';
export function AgentMark({ id, name, size = 'm' }: { id: string; name: string; size?: 's' | 'm' | 'l' }) {
  const rid = ICONS.has(id) ? id : ALIASES[id] || id;
  if (ICONS.has(rid)) return <span className={`wb-mark ${size} icon`} aria-hidden="true"><i style={{ ['--icon' as string]: `url(/acp-icons/${rid}.svg)` }} /></span>;
  return <span className={`wb-mark ${size}`} style={{ ['--h' as string]: hue(id || name) }} aria-hidden="true">{initials(name)}</span>;
}
/** A path inside the agent's folder, shown relative to it. */
const rel = (cwd: string | undefined, p: string) => { const c = (cwd || '').replace(/[\\/]+$/, ''); return c && p.startsWith(c + '/') || c && p.startsWith(c + '\\') ? p.slice(c.length + 1) : p; };
const base = (p: string) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;
const NEW = '\u0000new';
/** A yes/no the creator sets once and the page remembers (folded panels). */
function useStored(key: string): [boolean, (v: boolean) => void] {
  const [v, setV] = useState(() => { try { return localStorage.getItem(key) === '1'; } catch { return false; } });
  return [v, (x: boolean) => { setV(x); try { localStorage.setItem(key, x ? '1' : '0'); } catch { /* private mode */ } }];
}
const PanelIcon = ({ side }: { side: 'left' | 'right' }) => (
  <svg viewBox="0 0 20 20" aria-hidden="true"><rect x="2.5" y="3.5" width="15" height="13" rx="2" fill="none" stroke="currentColor" strokeWidth="1.5" /><rect x={side === 'left' ? 2.5 : 12.5} y="3.5" width="5" height="13" rx="1" fill="currentColor" opacity=".35" /><path d={side === 'left' ? 'M7.5 4v12' : 'M12.5 4v12'} stroke="currentColor" strokeWidth="1.5" /></svg>
);
const agentById = (id?: string) => { const x = String(id || ''); return AGENTS.find((a) => a.id === x) || AGENTS.find((a) => a.id === ALIASES[x]); };
/** How the agent starts on the creator's computer, in a sentence. */
function startsHow(a: RegAgent) {
  if (a.dist.npx) return t('{name} {version} is downloaded with npx the first time; the progress shows here.', '首次运行时会通过 npx 下载 {name} {version}，进度会显示在这里。', { name: a.name, version: a.version });
  if (a.dist.binary) return t('The bridge downloads {name} {version} for that computer the first time, checks it against the registry and keeps it.', '首次运行时，桥接程序会为那台电脑下载 {name} {version}，按注册表校验后保存。', { name: a.name, version: a.version });
  return t('{name} {version} starts with uvx, so uv must be installed on that computer (docs.astral.sh/uv).', '{name} {version} 通过 uvx 启动，因此那台电脑上需要安装 uv（docs.astral.sh/uv）。', { name: a.name, version: a.version });
}
/** A tag for an agent that cannot start everywhere: no build for Windows or macOS, or uv needed. */
function reach(a: RegAgent): string | null {
  if (a.dist.npx) return null;
  const b = a.dist.binary || [];
  if (b.length && !a.dist.uvx) {
    if (!b.some((k) => k.startsWith('windows'))) return t('No Windows build', '无 Windows 版');
    if (!b.some((k) => k.startsWith('darwin'))) return t('No macOS build', '无 macOS 版');
    if (!b.some((k) => k.startsWith('linux'))) return t('No Linux build', '无 Linux 版');
    return null;
  }
  return b.length ? null : t('Needs uv', '需要 uv');
}
const LinkIcon = ({ kind }: { kind: 'repo' | 'web' | 'doc' }) => (
  <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">{kind === 'repo'
    ? <path fill="currentColor" d="M8 0a8 8 0 0 0-2.53 15.59c.4.07.55-.17.55-.38v-1.34c-2.23.48-2.7-1.07-2.7-1.07-.36-.92-.89-1.17-.89-1.17-.73-.5.06-.49.06-.49.8.06 1.23.83 1.23.83.71 1.23 1.88.87 2.34.67.07-.52.28-.87.5-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.83-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.22 2.2.82a7.6 7.6 0 0 1 4 0c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.28.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48v2.2c0 .21.15.46.55.38A8 8 0 0 0 8 0Z" />
    : kind === 'web'
      ? <g fill="none" stroke="currentColor" strokeWidth="1.3"><circle cx="8" cy="8" r="6.3" /><path d="M1.7 8h12.6M8 1.7c1.8 1.9 2.6 4 2.6 6.3S9.8 12.4 8 14.3C6.2 12.4 5.4 10.3 5.4 8S6.2 3.6 8 1.7Z" /></g>
      : <g fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"><path d="M3.5 1.7h6l3 3v9.6h-9z" /><path d="M9.5 1.7v3h3M5.6 8h4.8M5.6 10.6h4.8" /></g>}</svg>
);
/** The details Zed shows for a registry agent: its links (repository, website, license) and its id. */
function AgentLinks({ a }: { a: RegAgent }) {
  const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();
  const link = (href: string | null, kind: 'repo' | 'web' | 'doc', label: string) => href && /^https:\/\//.test(href)
    ? <a href={href} target="_blank" rel="noreferrer" className="wb-alink" title={label} aria-label={`${label}: ${a.name}`} onClick={stop} onMouseDown={stop}><LinkIcon kind={kind} /></a> : null;
  return (
    <span className="wb-alinks">
      {link(a.repository, 'repo', t('Repository', '代码仓库'))}
      {link(a.website, 'web', t('Website', '网站'))}
      {link(a.license, 'doc', t('License', '许可证'))}
    </span>
  );
}

// ----- the page ------------------------------------------------------------------------------------------------------
export function Workbench() {
  useRegistry();
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

/** A dropdown of the known agents with a search box, and "Another agent" for anything else. */
function AgentSelect({ value, onChange, running }: { value: string; onChange: (id: string) => void; running?: Set<string> }) {
  const [open, setOpen] = useState(false), [q, setQ] = useState(''), [hi, setHi] = useState(0);
  const box = useRef<HTMLDivElement>(null), btn = useRef<HTMLButtonElement>(null), pop = useRef<HTMLDivElement>(null), listRef = useRef<HTMLDivElement>(null);
  const needle = q.trim().toLowerCase();
  const shown = needle ? AGENTS.filter((x) => (x.name + ' ' + x.id + ' ' + (x.description || '') + ' ' + x.authors.join(' ')).toLowerCase().includes(needle)) : AGENTS;
  const ids = [...shown.map((x) => x.id), 'custom'];
  const cur = agentById(value);
  // The list floats over everything (a dialog included) at a fixed size that fits the screen, below the button or above
  // it when there is more room there, and only the list itself scrolls.
  const [at, setAt] = useState<{ left: number; width: number; top?: number; bottom?: number; height: number } | null>(null);
  const place = () => {
    const r = btn.current?.getBoundingClientRect();
    if (!r) return;
    const below = innerHeight - r.bottom - 12, above = r.top - 12, down = below >= 360 || below >= above;
    setAt({ left: r.left, width: r.width, height: Math.max(160, Math.min(460, down ? below : above)), ...(down ? { top: r.bottom + 4 } : { bottom: innerHeight - r.top + 4 }) });
  };
  useLayoutEffect(() => { if (open) place(); else setAt(null); }, [open]);
  useEffect(() => {
    if (!open) return;
    const inside = (n: EventTarget | null) => !!(n && (box.current?.contains(n as Node) || pop.current?.contains(n as Node)));
    const off = (e: Event) => { if (!inside(e.target)) setOpen(false); };
    const moved = (e: Event) => { if (!pop.current?.contains(e.target as Node)) place(); };
    document.addEventListener('mousedown', off); document.addEventListener('touchstart', off);
    addEventListener('scroll', moved, true); addEventListener('resize', place);
    return () => { document.removeEventListener('mousedown', off); document.removeEventListener('touchstart', off); removeEventListener('scroll', moved, true); removeEventListener('resize', place); };
  }, [open]);
  useEffect(() => { setHi(0); }, [needle]);
  useEffect(() => { listRef.current?.querySelector<HTMLElement>(`[data-i="${hi}"]`)?.scrollIntoView({ block: 'nearest' }); }, [hi, open]);
  const toggle = () => { setQ(''); setHi(Math.max(0, ids.indexOf(value))); setOpen((o) => !o); };
  const choose = (id: string) => { onChange(id); setOpen(false); };
  const key = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setHi((i) => Math.min(ids.length - 1, i + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHi((i) => Math.max(0, i - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); choose(ids[hi]); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setOpen(false); btn.current?.focus(); }   // not the dialog around it
  };
  return (
    <div className="wb-asel" ref={box}>
      <button ref={btn} type="button" className="wb-asel-btn" aria-haspopup="listbox" aria-expanded={open} onClick={toggle}
        onKeyDown={(e) => { if (!open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) { e.preventDefault(); toggle(); } }}>
        {cur ? <AgentMark id={cur.id} name={cur.name} size="s" /> : <span className="wb-mark s plain" aria-hidden="true">+</span>}
        <b className="clip">{cur ? cur.name : t('Another agent', '其他智能体')}</b>
        {cur && <span className="wb-aver">{cur.version}</span>}
        <span className="dim clip grow">{cur ? cur.description : t('Any program that speaks ACP', '任何支持 ACP 的程序')}</span>
        <svg className="wb-chev" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M3 4.5 6 7.5 9 4.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </button>
      {open && at && createPortal(
        <div className="wb-asel-pop" ref={pop} style={{ left: at.left, width: at.width, top: at.top ?? 'auto', bottom: at.bottom ?? 'auto', maxHeight: at.height }}>
          <input className="input" type="search" autoFocus placeholder={t('Search {n} agents', '搜索 {n} 个智能体', { n: AGENTS.length })} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={key} aria-label={t('Search agents', '搜索智能体')} />
          <p className="dim fs-xs wb-asrc">{t('The agents of the', '来自')} <a href="https://github.com/agentclientprotocol/registry" target="_blank" rel="noreferrer">{t('ACP Registry', 'ACP 注册表')}</a>{t(', the same list Zed offers.', '，与 Zed 提供的列表相同。')}</p>
          <div className="wb-asel-list" role="listbox" aria-label={t('Agent', '智能体')} ref={listRef}>
            {shown.map((x, i) => (
              <div key={x.id} data-i={i} role="option" aria-selected={value === x.id} className={`${value === x.id ? 'on' : ''}${hi === i ? ' hi' : ''}`} onMouseEnter={() => setHi(i)} onClick={() => choose(x.id)}>
                <AgentMark id={x.id} name={x.name} />
                <span className="wb-arow grow">
                  <span className="wb-aline"><b className="clip">{x.name}</b><span className="wb-aver">{x.version}</span>
                    {running?.has(x.id) ? <span className="wb-tag on">{t('Running', '运行中')}</span> : reach(x) && <span className="wb-tag">{reach(x)}</span>}</span>
                  <span className="dim wb-adesc">{x.description}</span>
                  <span className="wb-aline"><span className="wb-aid mono">{t('ID: {id}', 'ID：{id}', { id: x.id })}</span><AgentLinks a={x} /></span>
                </span>
              </div>
            ))}
            {!shown.length && <p className="dim fs-sm pad-s">{t('No agent in the list matches. Add it as another agent below.', '列表中没有匹配的智能体。可以在下方把它添加为其他智能体。')}</p>}
          </div>
          <div data-i={shown.length} role="option" aria-selected={value === 'custom'} className={`wb-asel-other${value === 'custom' ? ' on' : ''}${hi === shown.length ? ' hi' : ''}`} onMouseEnter={() => setHi(shown.length)} onClick={() => choose('custom')}>
            <span className="wb-mark s plain" aria-hidden="true">+</span>
            <b>{t('Another agent', '其他智能体')}</b>
            <span className="dim clip grow">{t('Any program that speaks ACP: give its command', '任何支持 ACP 的程序：填写它的启动命令')}</span>
          </div>
        </div>, document.fullscreenElement || document.body,
      )}
    </div>
  );
}

/** Pick an agent and get the one command that starts it. */
function AgentPicker({ ov, value, onChange, custom, setCustom, select = true }: { ov: Overview; value: string; onChange: (id: string) => void; custom: string; setCustom: (s: string) => void; select?: boolean }) {
  const [name, setName] = useState('');
  const a = agentById(value);
  const isCustom = value === 'custom';
  const cmd = isCustom ? acpCommand(ov.server, '', custom.trim() || '<command>', name) : acpCommand(ov.server, value);
  return (
    <div className="stack">
      {select && <AgentSelect value={value} onChange={onChange} />}
      {isCustom && (
        <div className="wb-custom">
          <label className="stack s"><span className="fs-sm"><b>{t('Command', '命令')}</b> <span className="dim">{t('starts the agent in ACP mode, as you would type it in a terminal', '以 ACP 模式启动智能体，与在终端中输入的一样')}</span></span>
            <input className="input mono" placeholder="my-agent --acp" value={custom} onChange={(e) => setCustom(e.target.value)} autoFocus spellCheck={false} /></label>
          <label className="stack s"><span className="fs-sm"><b>{t('Name', '名称')}</b> <span className="dim">{t('optional, shown in the workbench', '可选，显示在工作台中')}</span></span>
            <input className="input" placeholder={t('My agent', '我的智能体')} value={name} onChange={(e) => setName(e.target.value)} maxLength={60} /></label>
          <p className="dim fs-sm">{t('For example: npx -y @scope/agent-acp, uvx my-agent acp, or the path to a program. It talks ACP over its standard input and output; the agent\'s own docs say how to start it that way.', '例如：npx -y @scope/agent-acp、uvx my-agent acp，或某个程序的路径。它需要通过标准输入输出使用 ACP；具体启动方式见该智能体的文档。')}</p>
        </div>
      )}
      <Code text={cmd} />
      <p className="dim fs-sm">
        {a && <>{startsHow(a)}{(a.website || a.repository) && <> <a href={(a.website || a.repository)!} target="_blank" rel="noreferrer">{t('About {name}', '关于 {name}', { name: a.name })}</a>.</>} </>}
        {t('Run it in your game\'s folder. Needs Node.js 22 or newer. Sign in to the agent the way it asks (for example its own login or API key).', '在你的游戏文件夹中运行。需要 Node.js 22 或更高版本。按智能体自己的方式登录（例如它自带的登录或 API 密钥）。')}
      </p>
    </div>
  );
}

function Setup({ ov, conn, reloadOv }: { ov: Overview; conn: string; reloadOv: () => void }) {
  const [agent, setAgent] = useState(() => { try { return agentById(localStorage.getItem('wb.agent') || '')?.id || (localStorage.getItem('wb.agent') === 'custom' ? 'custom' : 'claude-acp'); } catch { return 'claude-acp'; } });
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
  // '' follows the newest session; NEW is a fresh conversation the creator asked for. A fresh conversation gets its
  // session at once (not with the first message), so the agent's settings (model, effort, mode…) can be set first; a
  // session nobody wrote in yet is reused rather than piling up, and is listed only while it is open.
  const [sid, setSid] = useState<string>('');
  const s = b.sessions.get(sid) || null;
  const blank = (x: SessionInfo) => !x.title && !x.running && !(b.transcripts.get(x.sessionId)?.length);
  const draft = sessions.find(blank);
  useEffect(() => { if (sid === NEW && draft) setSid(draft.sessionId); }, [sid, draft]);
  const autoStart = b.ready && !s && !draft && (sid === NEW || !sessions.length);
  const [adding, setAdding] = useState(false), [rail, setRail] = useState(false);
  // an agent started from "Add an agent": it is selected as soon as it shows up
  const [want, setWant] = useState<{ agentId: string; host?: string; cwd?: string } | null>(null);
  useEffect(() => {
    if (!want) return;
    const got = bridges.find((x) => x.info.agentId === want.agentId && x.info.host === want.host && x.info.cwd === want.cwd);
    if (got) { setSel(got.info.id); setSid(''); setWant(null); }
  }, [want, bridges]);
  const [sideOff, setSideOff] = useStored('wb.side-off'), [railOff, setRailOff] = useStored('wb.rail-off');
  useEffect(() => { try { sessionStorage.setItem('wb.bridge', b.info.id); } catch { /* fine */ } }, [b.info.id]);
  useEffect(() => { if (sid !== NEW && !s && sessions.length) setSid(sessions[0].sessionId); }, [sid, s, sessions]);
  // on narrow screens the rail is a panel over the chat; on wide ones it is a column that can fold away
  const toggleRail = () => { if (window.matchMedia('(max-width: 1180px)').matches) setRail(!rail); else setRailOff(!railOff); };

  const choose = (id: string) => { setSel(id); setSid(''); };
  const otherAsks = bridges.filter((x) => x !== b && x.asks.size).length;

  return (
    <div className={`wb${rail ? ' rail-open' : ''}${sideOff ? ' side-off' : ''}${railOff ? ' rail-off' : ''}`}>
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
          <button className="btn btn-sm btn-ghost" onClick={() => setSid(draft ? draft.sessionId : NEW)} disabled={b.status !== 'ready'}>+ {t('New', '新建')}</button>
        </div>
        <div className="wb-sessions">
          {sessions.some((x) => !blank(x) || x.sessionId === sid) ? sessions.filter((x) => !blank(x) || x.sessionId === sid).map((x) => (
            <button key={x.sessionId} className={`wb-session ${x.sessionId === sid ? 'on' : ''}`} onClick={() => setSid(x.sessionId)}>
              <span className="clip">{x.title || t('New session', '新会话')}</span>
              <small className="dim">{x.running ? <><span className="wb-dot pulse" />{t('working', '工作中')}</> : ago(x.updatedAt)}{[...b.asks.values()].some((a) => a.sessionId === x.sessionId) && <Badge tone="accent">{t('Needs you', '需要你处理')}</Badge>}</small>
            </button>
          )) : <p className="dim fs-sm pad-s">{t('No sessions yet.', '还没有会话。')}</p>}
        </div>
      </aside>

      <section className="wb-main" aria-label={t('Conversation', '对话')}>
        <Conversation key={b.info.id + '|' + (s?.sessionId || 'new')} b={b} s={s} autoStart={autoStart} onSession={setSid} onRail={toggleRail} onSide={() => setSideOff(!sideOff)} sideOff={sideOff} railOff={(typeof window !== 'undefined' && window.matchMedia('(max-width: 1180px)').matches) ? !rail : railOff} />
      </section>

      <aside className="wb-rail" aria-label={t('Plan and files', '计划与文件')}>
        <Rail b={b} s={s} />
      </aside>

      {adding && ov && (
        <Modal onClose={() => setAdding(false)} wide>
          <div className="stack l pad-l">
            <h2 className="wb-modal-h">{t('Add an agent', '添加智能体')}</h2>
            <p className="mute">{t('Run more agents side by side: one of each kind per folder. Each shows up in the list on the left.', '同时运行多个智能体：每个文件夹中每种智能体最多一个。每个都会出现在左侧列表中。')}</p>
            <AddAgent ov={ov} bridges={bridges} current={b} onStarted={(want) => { setWant(want); setAdding(false); }} />
            <Machines ov={ov} reload={reloadOv} />
            <div className="row"><Button onClick={() => setAdding(false)}>{t('Done', '完成')}</Button></div>
          </div>
        </Modal>
      )}
    </div>
  );
}

/** Another agent: started from here in a folder where one already runs, or by its command anywhere else. */
function AddAgent({ ov, bridges, current, onStarted }: { ov: Overview; bridges: BridgeState[]; current: BridgeState; onStarted: (want: { agentId: string; host?: string; cwd?: string }) => void }) {
  // the folders an agent can be started in from the console: where a bridge that can start others runs
  const targets = bridges.filter((x) => x.info.launch);
  const [target, setTarget] = useState(() => (targets.find((x) => x.info.host === current.info.host && x.info.cwd === current.info.cwd) || targets[0])?.info.id || '');
  const tb = targets.find((x) => x.info.id === target) || targets[0];
  const here = (x: BridgeState) => !!tb && x.info.host === tb.info.host && x.info.cwd === tb.info.cwd;
  const running = new Set(bridges.filter(here).map((x) => { const id = x.info.agentId || ''; return older(x.info.version, '1.0.6') ? ALIASES[id] || id : id; }));
  const [agent, setAgent] = useState(() => (running.has('claude-acp') ? AGENTS.find((a) => !running.has(a.id))?.id : null) || 'claude-acp'), [custom, setCustom] = useState('');
  const { busy, act } = useAct();
  const [err, setErr] = useState('');
  const known = !!agentById(agent);
  if (!tb || !known) {
    return (
      <div className="stack">
        <AgentSelect value={agent} onChange={setAgent} running={running} />
        {!tb && <p className="dim fs-sm">{t('Run it in a terminal on the computer, in the folder it should work in:', '在那台电脑上、智能体要工作的文件夹中，用终端运行：')}</p>}
        {tb && agent === 'custom' && <p className="dim fs-sm">{t('An agent outside the list starts from a terminal, in the folder it should work in:', '列表之外的智能体需要在终端中、它要工作的文件夹里启动：')}</p>}
        <AgentPicker ov={ov} value={agent} onChange={setAgent} custom={custom} setCustom={setCustom} select={false} />
      </div>
    );
  }
  const a = agentById(agent)!, already = running.has(agent);
  const start = () => act('launch', async () => {
    setErr('');
    const ask = idFor(tb.info.version, agent);
    if (!ask) { setErr(t('The connector on {host} is an older version ({version}) that cannot start {name}. Stop it with Ctrl+C and run the command again (under "Another computer or folder?" below) to get the latest one.', '{host} 上的连接程序是旧版本（{version}），无法启动 {name}。请按 Ctrl+C 停止它，然后重新运行命令（见下方“其他电脑或文件夹？”）以获取最新版本。', { host: tb.info.host || '', version: tb.info.version || '?', name: a.name })); return; }
    try { await launchAgent(tb.info.id, ask); onStarted({ agentId: ask, host: tb.info.host, cwd: tb.info.cwd }); }
    catch (e: any) { setErr(String(e?.message || e)); }
  });
  return (
    <div className="stack">
      <AgentSelect value={agent} onChange={(id) => { setAgent(id); setErr(''); }} running={running} />
      <div className="wb-launch">
        <div className="grow stack s">
          <span className="fs-sm dim">{t('Starts on', '启动位置')}</span>
          {targets.length > 1
            ? <select className="input" value={tb.info.id} onChange={(e) => setTarget(e.target.value)} aria-label={t('Computer and folder', '电脑和文件夹')}>
                {targets.map((x) => <option key={x.info.id} value={x.info.id}>{x.info.host} · {x.info.cwd}</option>)}
              </select>
            : <span><b>{tb.info.host}</b> · <span className="mono">{tb.info.cwd}</span></span>}
        </div>
        <Button variant="primary" onClick={start} disabled={already || busy === 'launch'}>{already ? t('Already running', '已在运行') : t('Start {name}', '启动 {name}', { name: a.name })}</Button>
      </div>
      {err && <Notice tone="bad">{err}</Notice>}
      <p className="dim fs-sm">
        {startsHow(a)}{' '}
        {t('It stops when the first agent in that folder stops.', '该文件夹中的第一个智能体停止时，它也会停止。')}
      </p>
      <details className="wb-more">
        <summary>{t('Another computer or folder? Run it in a terminal', '其他电脑或文件夹？在终端中运行')}</summary>
        <AgentPicker ov={ov} value={agent} onChange={setAgent} custom={custom} setCustom={setCustom} select={false} />
      </details>
    </div>
  );
}

function StatusDot({ b }: { b: BridgeState }) {
  const busy = [...b.sessions.values()].some((s) => s.running), asks = b.asks.size;
  const [tone, label] = asks ? ['warn', t('Needs you', '需要你处理')] : b.status === 'ready' ? (busy ? ['pulse', t('Working', '工作中')] : ['good', t('Ready', '就绪')]) : b.status === 'starting' || b.status === 'connecting' ? ['pulse', t('Starting', '启动中')] : ['bad', b.status === 'exited' ? t('Stopped', '已停止') : t('Failed', '失败')];
  return <span className={`wb-dot ${tone}`} title={label} aria-label={label} />;
}

// ----- one conversation -------------------------------------------------------------------------------------------
function Conversation({ b, s, autoStart, onSession, onRail, onSide, sideOff, railOff }: { b: BridgeState; s: SessionInfo | null; autoStart: boolean; onSession: (id: string) => void; onRail: () => void; onSide: () => void; sideOff: boolean; railOff: boolean }) {
  const { toast } = useApp();
  const entries = (s && b.transcripts.get(s.sessionId)) || EMPTY;
  const { items } = useMemo(() => fold(entries), [entries, entries.length]);
  const asks = [...b.asks.values()].filter((a) => s && a.sessionId === s.sessionId);
  const [authNeeded, setAuthNeeded] = useState<string | null>(null);
  const [failure, setFailure] = useState<AgentFail | null>(null);
  const [creating, setCreating] = useState(false);
  const scroller = useRef<HTMLDivElement>(null), atBottom = useRef(true);
  useEffect(() => { const el = scroller.current; if (el && atBottom.current) el.scrollTop = el.scrollHeight; });
  const onScroll = () => { const el = scroller.current; if (el) atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60; };

  const newSession = async (): Promise<string | null> => {
    setCreating(true); setFailure(null);
    try {
      const r = await rpc<{ sessionId: string }>(b.info.id, 'session/new', {});
      setAuthNeeded(null); onSession(r.sessionId); return r.sessionId;
    } catch (e: any) {
      if ((e?.code === -32000 || /auth/i.test(String(e?.message))) && b.init?.authMethods?.length) setAuthNeeded(String(e.message || ''));
      else setFailure({ what: 'session', message: String(e?.message || e), code: e?.code ?? null, log: e?.log || [] });
      return null;
    } finally { setCreating(false); }
  };

  // a fresh conversation starts its session as soon as the agent is ready, so its settings show before the first message
  const started = useRef(false);
  useEffect(() => {
    if (!autoStart || started.current || s || b.status !== 'ready') return;
    started.current = true; void newSession();
  }, [autoStart, s, b.status]);

  const send = async (blocks: any[]) => {
    const id = s?.sessionId || await newSession();
    if (!id) return false;
    atBottom.current = true;
    // a failed turn shows in the conversation (the bridge records it); anything else is a short note
    rpc(b.info.id, 'session/prompt', { sessionId: id, prompt: blocks }).catch((e) => { if (!e?.recorded) toast(e?.message || String(e), true); });
    return true;
  };

  const title = s?.title || (s ? t('New session', '新会话') : t('Start a session', '开始会话'));
  return (
    <>
      <header className="wb-top">
        <button className={`wb-tog${sideOff ? '' : ' on'}`} onClick={onSide} aria-pressed={!sideOff} title={sideOff ? t('Show agents and sessions', '显示智能体与会话') : t('Hide agents and sessions', '隐藏智能体与会话')}><PanelIcon side="left" /></button>
        <div className="grow stack s">
          <b className="clip">{title}</b>
          <small className="dim clip">{agentTitle(b)}{b.init?.agentInfo?.version ? ` ${b.init.agentInfo.version}` : ''} · <span className="mono">{b.info.cwd || b.cwd}</span></small>
        </div>
        <button className={`wb-tog${railOff ? '' : ' on'}`} onClick={onRail} aria-pressed={!railOff} title={t('Plan, files and agent', '计划、文件与智能体')}><PanelIcon side="right" /></button>
      </header>

      <div className="wb-scroll" ref={scroller} onScroll={onScroll}>
        <div className="wb-thread">
          <AgentState b={b} />
          {authNeeded !== null && <AuthCard b={b} detail={authNeeded} onDone={() => { setAuthNeeded(null); void newSession(); }} />}
          {failure && <AgentError b={b} f={failure} onRetry={() => void newSession()} />}
          {s?.trimmed && <p className="dim fs-sm wb-trim">{t('The start of this long session is not shown.', '这个长会话的开头部分未显示。')}</p>}
          {(!s || !items.length) && b.status === 'ready' && authNeeded === null && !failure && <Welcome b={b} onPick={(text) => void send([{ type: 'text', text }])} busy={creating} />}
          {items.map((it, i) => (
            <Fragment key={it.key}>
              {it.kind !== 'user' && it.kind !== 'end' && (i === 0 || items[i - 1].kind === 'user') && <div className="wb-who"><AgentMark id={b.info.agentId || ''} name={agentTitle(b)} size="s" /><b>{agentTitle(b)}</b></div>}
              <ItemView it={it} cwd={b.info.cwd} b={b} mode={s?.modes?.availableModes?.find((m) => m.id === s.modes?.currentModeId)} />
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
        {/not found|ENOENT|uvx/i.test(b.detail) && a && <span>{startsHow(a)} {(a.website || a.repository) && <a href={(a.website || a.repository)!} target="_blank" rel="noreferrer">{a.website || a.repository}</a>}</span>}
        {b.stderr.length > 0 && <details className="wb-log" open={b.status === 'failed'}><summary>{t('What the agent printed', '智能体输出的内容')}</summary><pre className="wb-pre small">{b.stderr.slice(-30).join('\n')}</pre></details>}
      </div>
    </Notice>
  );
}

interface AgentFail { what: 'session' | 'turn'; message: string; code: number | null; log: string[] }
/** Folders an agent should not work in (the bridge says the same in the terminal). */
function isSystemFolder(cwd: string) {
  const p = String(cwd || '').replace(/[\\/]+$/, '');
  return /^[a-z]:\\windows(\\|$)/i.test(p) || /^[a-z]:\\program files/i.test(p) || /^[a-z]:$/i.test(p) || /^\/(bin|sbin|usr|etc|System|Library|proc|dev)(\/|$)/.test(p);
}
/** What to do about an agent's error, from its text: the reason is the agent's own, the next step is ours. */
export function errorHint(text: string, code: number | null, b: { name: string; agentId?: string; host?: string; cwd?: string }): string {
  const x = text.toLowerCase();
  if (code === -32000 || /auth|log ?in|api key|apikey|unauthori[sz]ed|\b401\b|credential|not signed|subscription/.test(x)) {
    const id = ALIASES[b.agentId || ''] || b.agentId;
    const how = id === 'claude-acp' ? t('For Claude Agent: run "claude" in a terminal and sign in with /login, or set ANTHROPIC_API_KEY.', '对于 Claude Agent：在终端中运行 “claude” 并用 /login 登录，或设置 ANTHROPIC_API_KEY。')
      : id === 'codex-acp' ? t('For Codex: run "codex login" in a terminal, or set OPENAI_API_KEY.', '对于 Codex：在终端中运行 “codex login”，或设置 OPENAI_API_KEY。')
      : id === 'gemini' ? t('For Gemini CLI: run "gemini" once in a terminal to sign in, or set GEMINI_API_KEY.', '对于 Gemini CLI：在终端中运行一次 “gemini” 登录，或设置 GEMINI_API_KEY。') : '';
    return [t('Sign in to {name} on {host} the way it asks, then restart the agent and try again.', '在 {host} 上按 {name} 要求的方式登录，然后重启智能体再试。', { name: b.name, host: b.host || t('that computer', '那台电脑') }), how].filter(Boolean).join(' ');
  }
  if (/invalid .*(permissions|settings|defaultmode|mode)|unknown (setting|option)/.test(x)) return t('{name} turned down a setting from its own settings file, which an older copy of it does not know. Restart the agent: the workbench now starts the latest version.', '{name} 不认识其设置文件中的某个设置（旧版本不支持）。请重启智能体：工作台现在会启动最新版本。', { name: b.name });
  if (b.cwd && isSystemFolder(b.cwd)) return t('It works in {folder}, a system folder, which agents often cannot use. Stop it with Ctrl+C, open a terminal in your game\'s folder, and run the command again.', '它在系统文件夹 {folder} 中工作，智能体通常无法使用这里。请按 Ctrl+C 停止，在你的游戏文件夹中打开终端，然后重新运行命令。', { folder: b.cwd });
  if (/eperm|eacces|permission denied|operation not permitted|access is denied/.test(x)) return t('The agent may not read or write in this folder. Run it in a folder you own, such as your game\'s folder.', '智能体无权在这个文件夹中读写。请在你自己的文件夹（例如游戏文件夹）中运行它。');
  if (/rate.?limit|\b429\b|overloaded|quota|credit|billing|insufficient/.test(x)) return t('The agent\'s service turned the request down for now (a limit or the account\'s balance). Wait a moment, or check the account, then try again.', '智能体的服务暂时拒绝了请求（达到限制或账户余额不足）。稍等片刻或检查账户后再试。');
  if (/etimedout|enotfound|econnre|fetch failed|network|socket hang up|getaddrinfo|proxy/.test(x)) return t('The agent could not reach its service. Check the internet connection (and any proxy) on {host}, then try again.', '智能体无法连接到它的服务。请检查 {host} 上的网络连接（以及代理），然后重试。', { host: b.host || t('that computer', '那台电脑') });
  if (/exited|query closed|process.*(ended|stopped|exit)|epipe|not running/.test(x)) return t('The agent\'s process stopped. Restart the agent; if it happens again, the log below shows why.', '智能体的进程已停止。请重启智能体；如果再次发生，下面的日志会说明原因。');
  return t('Try again. If it keeps happening, restart the agent; the log below shows what the agent printed.', '请重试。如果一直出现，请重启智能体；下面的日志显示了智能体输出的内容。');
}
function AgentError({ b, f, onRetry }: { b: BridgeState; f: AgentFail; onRetry?: () => void }) {
  const name = agentTitle(b);
  const hint = errorHint(f.message + '\n' + f.log.join('\n'), f.code, { name, agentId: b.info.agentId, host: b.info.host, cwd: b.info.cwd || b.cwd });
  return (
    <Notice tone="bad" title={f.what === 'session' ? t('{name} could not start a session', '{name} 无法开始会话', { name }) : t('{name} stopped with an error', '{name} 因错误而停止', { name })}>
      <div className="stack s wb-err">
        <span className="mono wb-err-msg">{f.message || t('No reason given.', '没有给出原因。')}</span>
        <span>{hint}</span>
        <div className="row wrapx">
          {onRetry && <Button size="sm" variant="primary" onClick={onRetry}>{t('Try again', '重试')}</Button>}
          <Button size="sm" onClick={() => restart(b.info.id, true)}>{t('Restart agent', '重启智能体')}</Button>
        </div>
        {f.log.length > 0 && <details className="wb-log"><summary>{t('What the agent printed', '智能体输出的内容')}</summary><pre className="wb-pre small">{f.log.join('\n')}</pre></details>}
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
      {isSystemFolder(b.info.cwd || b.cwd) && <Notice tone="accent" title={t('This is a system folder', '这是一个系统文件夹')}>{t('The agent works in {folder}, where a terminal opened as administrator starts. Agents often cannot work there. Stop it with Ctrl+C, open a terminal in your game\'s folder, and run the command again.', '智能体在 {folder} 中工作，以管理员身份打开的终端会从这里开始。智能体通常无法在这里正常工作。请按 Ctrl+C 停止，在你的游戏文件夹中打开终端，然后重新运行命令。', { folder: b.info.cwd || b.cwd })}</Notice>}
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

function ItemView({ it, cwd, b, mode }: { it: Item; cwd?: string; b?: BridgeState; mode?: { id: string; name: string } }) {
  switch (it.kind) {
    case 'user': return <div className="wb-msg user">{it.blocks.map((c, i) => <Block key={i} c={c} />)}</div>;
    case 'agent': return <div className="wb-msg agent"><Markdown text={it.text} />{it.blocks.map((c, i) => <Block key={i} c={c} />)}</div>;
    case 'thought': return <details className="wb-thought"><summary>{t('Thinking', '思考')}</summary><Markdown text={it.text} /></details>;
    case 'tool': return <ToolView c={it.call} cwd={cwd} />;
    case 'end':
      if (it.stopReason === 'end_turn') return <div className="wb-end" aria-hidden="true" />;
      // the agent ended the turn itself, without a stop from here: say so, and how to be asked first
      if (it.stopReason === 'cancelled' && it.by === 'agent') return (
        <div className="wb-end labelled agent"><span>{t('{name} stopped this turn itself. Nothing was asked here.', '{name} 自己停止了这一轮，这里没有向你询问。', { name: b ? agentTitle(b) : t('The agent', '智能体') })}
          {mode && /auto/i.test(mode.id) && <> {t('In {mode} mode it decides on tools without asking you; choose another mode in the menu under the message box to be asked first.', '在 {mode} 模式下，它会自行决定是否使用工具而不询问你；在输入框下方的菜单中选择其他模式，即可先征求你的同意。', { mode: mode.name })}</>}</span></div>
      );
      if (it.stopReason === 'error') return b ? <AgentError b={b} f={{ what: 'turn', message: it.error || '', code: it.code ?? null, log: it.log || [] }} /> : <Notice tone="bad" title={t('The agent reported an error', '智能体报告了一个错误')}>{it.error}</Notice>;
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
    // Esc stops the turn, but not the Esc that closes an input method's candidate list
    if (e.key === 'Escape' && s?.running && !e.nativeEvent.isComposing && e.keyCode !== 229) { e.preventDefault(); cancel(b.info.id, s.sessionId); }
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
  const [agentOpen, setAgentOpen] = useStored('wb.rail.agent');   // folded by default, so the plan and files keep their room
  return (
    <div className="stack wb-rail-in">
      <PlanView plan={plan} />
      <FilesView files={files} cwd={b.info.cwd} />
      <details className="wb-panel wb-agent-info" open={agentOpen} onToggle={(e) => setAgentOpen((e.currentTarget as HTMLDetailsElement).open)}>
        <summary><h3>{t('Agent', '智能体')} <span className="dim">{agentTitle(b)}</span></h3></summary>
        <dl className="wb-kv small">
          <dt>{t('Name', '名称')}</dt><dd>{agentTitle(b)}{b.init?.agentInfo?.version ? ` ${b.init.agentInfo.version}` : ''}</dd>
          <dt>{t('Computer', '电脑')}</dt><dd>{b.info.host}</dd>
          <dt>{t('Folder', '文件夹')}</dt><dd className="mono clip" title={b.info.cwd}>{b.info.cwd}</dd>
          <dt>HearthCade</dt><dd>{b.mcp ? <Badge tone="good">{t('Tools connected', '工具已连接')}</Badge> : <Badge>{t('Not connected', '未连接')}</Badge>}</dd>
          <dt>ACP</dt><dd>v{b.init?.protocolVersion ?? 1}{caps.promptCapabilities?.image ? ` · ${t('pictures', '图片')}` : ''}{caps.loadSession ? ` · ${t('resumes sessions', '可恢复会话')}` : ''}</dd>
        </dl>
        {(b.status === 'exited' || b.status === 'failed') && <Button size="sm" onClick={() => restart(b.info.id, true)}>{t('Retry', '重试')}</Button>}
      </details>
      {b.info.child
        ? <div className="row"><Button size="sm" onClick={() => quitAgent(b.info.id)}>{t('Stop this agent', '停止这个智能体')}</Button></div>
        : <p className="dim fs-sm">{t('To stop this agent, press Ctrl+C in its terminal.', '要停止这个智能体，请在它的终端中按 Ctrl+C。')}</p>}
    </div>
  );
}

// The plan and the files each keep a fixed height, sized for whole rows, and page through the rest.
const PLAN_PAGE = 5, FILES_PAGE = 8;
/** Page `page` of `n` items, `size` a page; follows `want` (a page to show) until the creator turns a page. */
function usePages(n: number, size: number, want = 0) {
  const pages = Math.max(1, Math.ceil(n / size));
  const [page, setPage] = useState(want), [held, setHeld] = useState(false);
  useEffect(() => { if (!held) setPage(want); }, [want, held]);
  const at = Math.min(page, pages - 1);
  return { at, pages, go: (p: number) => { setHeld(true); setPage(Math.max(0, Math.min(pages - 1, p))); }, slice: <T,>(xs: T[]) => xs.slice(at * size, at * size + size) };
}
function Pager({ at, pages, go, label }: { at: number; pages: number; go: (p: number) => void; label: string }) {
  if (pages < 2) return null;
  return (
    <span className="wb-pager" role="group" aria-label={label}>
      <button type="button" onClick={() => go(at - 1)} disabled={at === 0} aria-label={t('Previous page', '上一页')}>‹</button>
      <span aria-live="polite">{at + 1}/{pages}</span>
      <button type="button" onClick={() => go(at + 1)} disabled={at === pages - 1} aria-label={t('Next page', '下一页')}>›</button>
    </span>
  );
}

function PlanView({ plan }: { plan: Plan | null }) {
  const steps = Array.isArray(plan) ? plan : [];
  const now = steps.findIndex((p) => p.status !== 'completed');   // the page with the step in hand
  const pg = usePages(steps.length, PLAN_PAGE, now < 0 ? Math.max(0, Math.ceil(steps.length / PLAN_PAGE) - 1) : Math.floor(now / PLAN_PAGE));
  const done = steps.filter((p) => p.status === 'completed').length;
  return (
    <section className="wb-panel">
      <h3><span className="grow">{t('Plan', '计划')}{steps.length > 0 && <span className="dim"> {done}/{steps.length}</span>}</span><Pager {...pg} label={t('Plan pages', '计划分页')} /></h3>
      {!plan ? <p className="dim fs-sm">{t('When the agent plans its work, the steps show up here.', '智能体规划工作时，步骤会显示在这里。')}</p>
        : !Array.isArray(plan) ? <div className="wb-plan-md"><Markdown text={plan.markdown} /></div>
        : <>
            <div className="wb-meter" aria-label={t('{done} of {n} steps done', '已完成 {done}/{n} 步', { done, n: steps.length })}><i style={{ width: `${steps.length ? (100 * done) / steps.length : 0}%` }} /></div>
            <ol className={`wb-plan paged${pg.pages > 1 ? ' fixed' : ''}`} start={pg.at * PLAN_PAGE + 1}>{pg.slice(steps).map((p, i) => <li key={pg.at * PLAN_PAGE + i} className={p.status} title={p.content}><span className="box" aria-hidden="true" /><span className="wb-two">{p.content}</span></li>)}</ol>
          </>}
    </section>
  );
}

const FILE_ROW = 26;
function FilesView({ files, cwd }: { files: Map<string, string>; cwd?: string }) {
  const list = useMemo(() => [...files].reverse(), [files, files.size]);   // the latest first
  // the list takes the rail's spare height, and a page holds as many whole rows as fit in it
  const box = useRef<HTMLDivElement>(null), [rows, setRows] = useState(FILES_PAGE);
  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setRows(Math.max(4, Math.floor(el.clientHeight / FILE_ROW))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const pg = usePages(list.length, rows);
  return (
    <section className="wb-panel wb-files-panel">
      <h3><span className="grow">{t('Files', '文件')}{list.length > 0 && <span className="dim"> {list.length}</span>}</span><Pager {...pg} label={t('File pages', '文件分页')} /></h3>
      <div className="wb-files-box" ref={box}>
        {list.length ? <ul className="wb-files paged">{pg.slice(list).map(([p, k]) => <li key={p} title={rel(cwd, p)}><span className={`wb-glyph s k-${k}`} aria-hidden="true">{KIND_GLYPH[k] || '•'}</span><span className="mono clip">{base(p)}</span></li>)}</ul>
          : <p className="dim fs-sm">{t('Files the agent reads or changes show up here.', '智能体读取或修改的文件会显示在这里。')}</p>}
      </div>
    </section>
  );
}

