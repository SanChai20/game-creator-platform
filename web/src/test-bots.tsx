// The Test players panel under the creator's preview: add bot players that connect to the preview like real players
// (src/bots.ts), see each one's connection, and break it on purpose (a drop, a page reload, a lag spike, an outage).
// Real friends never meet a preview, so the running bots are the creator's friends there: the game's own GCP.friends
// list and invites reach them, and GCP.friends.open shows the invite picker below over the preview.
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api, t, useAct } from './lib';
import { Badge, Button, Input, Notice, RowMenu, Select, Table } from './ui';
import './social.css';

type Opts = {
  enabled: boolean; game: { matches: boolean; bot_logic: boolean; players: { min?: number; max?: number }; needs?: { message: string; hint: string }[] };
  limits: { bots: number; minutes: number; daily_bot_minutes: number; used_today: number };
  profiles: Record<string, { label: string; latency_ms: number; jitter_ms: number; loss_percent: number }>; regions: Record<string, string>;
};
type Bot = {
  id: string; name: string; phase: string; detail: string | null; inputs_sent: number; matches_finished: number;
  net: { profile: string; latency_ms: number; jitter_ms: number; loss_percent: number; spike: boolean; down: boolean };
  stats: { rtt_ms: number | null; rtt_p50_ms: number | null; rtt_p95_ms: number | null; snapshots_per_s: number; snapshot_jitter_ms: number | null; snapshot_gap_max_ms: number | null; since_snapshot_ms: number | null; inputs_unacked: number; kb_in_per_s: number; kb_out_per_s: number; reconnects: number; drops: number; errors: number; last_error: string | null };
  brain: { errors: number; last_error: string | null; think_ms: number };
  friend?: 'online' | 'busy';
};
type Answer = { id: string; bot: string; name: string; accepted: boolean; at: string; why?: string };
type Status = { invites?: Answer[]; needs?: { hook: string; message: string }[]; running: boolean; region?: string; region_name?: string; target?: string; following?: string | null; seconds_left?: number; brain?: { note: string; kind: string }; bots?: Bot[]; log?: string[]; last?: any; ended?: any };

const PHASE: Record<string, 'good' | 'info' | 'bad' | 'neutral' | 'accent'> = { idle: 'neutral', searching: 'info', connecting: 'info', waiting: 'info', playing: 'good', 'in room': 'good', reconnecting: 'accent', away: 'accent', ended: 'neutral', out: 'bad', left: 'neutral', stopped: 'neutral' };
const phaseName = (p: string) => ({
  idle: t('Waiting for you', '等待你'), searching: t('Searching', '匹配中'), connecting: t('Connecting', '连接中'), waiting: t('In the lobby', '等待开局'),
  playing: t('Playing', '对局中'), 'in room': t('In the room', '在房间中'), reconnecting: t('Reconnecting', '重连中'), away: t('Connection lost', '已断线'),
  ended: t('Match over', '对局结束'), out: t('Out', '已退出'), left: t('Left', '已离开'), stopped: t('Stopped', '已停止'),
} as Record<string, string>)[p] || p;
const ms = (v: number | null | undefined) => (v == null ? '–' : `${v} ms`);
// the preview's game frames (the SDK takes a message only from its own parent page, so the others ignore it)
const frames = () => Array.from(document.querySelectorAll('iframe')).map((f) => f.contentWindow).filter((w): w is Window => !!w);
const toFrames = (m: unknown) => { for (const w of frames()) { try { w.postMessage(m, '*'); } catch { /* gone */ } } };
type Picker = { lobby: string | null; label: string; data?: unknown };

export function TestPlayers({ projectId, players }: { projectId: string; players?: { min?: number; max?: number } | null }) {
  const { busy, act } = useAct();
  const [open, setOpen] = useState(false), [opts, setOpts] = useState<Opts | null>(null), [st, setSt] = useState<Status | null>(null);
  const [form, setForm] = useState({ bots: 0, target: 'follow', net: '4g', region: 'auto', minutes: 15, code: '', room: 'lobby', queue: 'default', size: 0, mixed: true });
  const load = useCallback(async () => {
    const r = await api<{ options: Opts; status: Status }>(`/console/projects/${projectId}/bots`);
    setOpts(r.options); setSt(r.status);
    return r;
  }, [projectId]);
  const [picker, setPicker] = useState<Picker | null>(null);
  // fetched once when the preview opens (is anything running?), then every 1.5 s while the panel is open and bots run
  useEffect(() => { void load().then((r) => { if (r.status.running) setOpen(true); }).catch(() => {}); }, [load]);
  // the game opened its invite picker (GCP.friends.open): in the preview it lists the test players
  useEffect(() => {
    const f = (e: MessageEvent) => {
      const d = e.data;
      if (!d || d.gcp !== 'friends_open' || !frames().includes(e.source as Window)) return;
      setPicker({ lobby: typeof d.lobby === 'string' ? d.lobby : null, label: String(d.label || ''), data: d.data });
      void load().catch(() => {});
    };
    addEventListener('message', f); return () => removeEventListener('message', f);
  }, [load]);
  // what the game hears as from friends: a bot's answer to an invite (GCP.friends.on('answer')), and a change in the
  // list (bots started, stopped, or busy in a match) as GCP.friends.on('change')
  const told = useRef<Set<string> | null>(null), sig = useRef('');
  useEffect(() => {
    if (!st) return;
    const seen = told.current, now = new Set(seen || []);
    for (const a of st.invites || []) if (!now.has(a.id)) { now.add(a.id); if (seen) toFrames({ gcp: 'friends_answer', id: a.id, accepted: a.accepted, by: { id: a.bot, name: a.name } }); }
    told.current = now;
    const next = st.running ? (st.bots || []).map((b) => b.id + ':' + (b.friend || '')).join() : '';
    if (next !== sig.current) { if (sig.current || next) toFrames({ gcp: 'friends_changed' }); sig.current = next; }
  }, [st]);
  useEffect(() => { if (!open && !picker) return; const i = setInterval(() => void load().catch(() => {}), st?.running ? 1500 : 8000); return () => clearInterval(i); }, [open, load, st?.running]);
  useEffect(() => {
    if (!opts || form.bots) return;
    const max = players?.max || opts.game.players.max || 2;
    setForm((f) => ({ ...f, bots: Math.max(1, Math.min(opts.limits.bots, max - 1)), size: max }));
  }, [opts]); // eslint-disable-line react-hooks/exhaustive-deps

  const running = !!st?.running, bots = st?.bots || [];
  const start = () => act('start', async () => {
    // a mixed table: most bots on the chosen network, one on a poor connection and one with no added delay
    const nets = form.mixed && form.bots >= 3 ? Array.from({ length: form.bots }, (_, i) => (i === form.bots - 2 ? 'poor' : i === form.bots - 1 ? 'none' : form.net)) : undefined;
    await api(`/console/projects/${projectId}/bots`, { method: 'POST', body: { bots: form.bots, target: form.target, net: form.net, nets, region: form.region, minutes: form.minutes, code: form.code, room: form.room, queue: form.queue, players: form.size } });
    setOpen(true); await load();
  }, t('Test bots started.', '测试机器人已启动。'));
  const stop = () => act('stop', async () => { await api(`/console/projects/${projectId}/bots`, { method: 'DELETE' }); await load(); }, t('Test bots stopped.', '测试机器人已停止。'));
  const doAct = (bot: string, action: string, extra: Record<string, unknown> = {}) => act('a:' + bot + action, async () => { await api(`/console/projects/${projectId}/bots/act`, { method: 'POST', body: { bot, action, ...extra } }); await load(); });
  const menu = (bot: string) => [
    { label: t('Drop the connection (back in 5 s)', '断开连接（5 秒后恢复）'), onClick: () => doAct(bot, 'drop', { ms: 5000 }) },
    { label: t('Reload the page (back in 3 s)', '刷新页面（3 秒后回来）'), onClick: () => doAct(bot, 'reload', { ms: 3000 }) },
    { label: t('Lag spike: +500 ms for 5 s', '延迟尖峰：+500 毫秒，持续 5 秒'), onClick: () => doAct(bot, 'spike', { ms: 5000, extra: 500 }) },
    { label: t('No connection for 3 s (a tunnel)', '断网 3 秒（像进隧道）'), onClick: () => doAct(bot, 'outage', { ms: 3000 }) },
    ...Object.entries(opts?.profiles || {}).map(([k, p]) => ({ label: `${t('Network', '网络')}: ${p.label}`, onClick: () => doAct(bot, 'net', { net: k }) })),
    { label: t('Leave for good', '永久离开'), danger: true, onClick: () => doAct(bot, 'leave') },
    { label: t('Join again', '重新加入'), onClick: () => doAct(bot, 'rejoin') },
  ];

  if (opts && !opts.enabled) return null;
  const pick = picker && <InvitePicker projectId={projectId} picker={picker} st={st} limit={opts?.limits.bots || 3} reload={load} onClose={() => setPicker(null)} onStarted={() => setOpen(true)} />;
  if (!open) return (
    <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>{pick}
      <b>{t('Test players', '测试玩家')}</b>
      <span className="mute fs-sm">{t('Add bot players that connect to this preview like real players, over the real network.', '加入机器人玩家，它们像真实玩家一样通过真实网络连接到这个预览。')}</span>
      <Button size="sm" className="right" onClick={() => setOpen(true)}>{t('Add test players', '添加测试玩家')}</Button>
    </div>
  );
  const left = opts ? Math.max(0, opts.limits.daily_bot_minutes - opts.limits.used_today) : 0;
  return (
    <div className="stack" style={{ gap: 10 }}>{pick}
      <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
        <b>{t('Test players', '测试玩家')}</b>
        {running ? <><Badge tone="good">{bots.length} {t('bots', '个机器人')}</Badge><span className="mute fs-sm">{st?.region_name}{st?.following ? ` · ${st.following}` : st?.target === 'follow' ? ` · ${t('waiting for your search', '等待你开始匹配')}` : st?.target === 'invite' ? ` · ${t('waiting for your invites', '等待你的邀请')}` : ''}</span></> : <Badge dot={false}>{t('Off', '未开启')}</Badge>}
        {running && st?.seconds_left != null && <span className="dim fs-sm">{t('stops by itself in', '自动停止于')} {Math.ceil(st.seconds_left / 60)} {t('min', '分钟')}</span>}
        <span className="right row" style={{ gap: 6 }}>
          {running && <RowMenu label={t('All bots', '全部机器人')} actions={menu('all')} />}
          {running ? <Button size="sm" variant="danger" onClick={stop} disabled={busy === 'stop'}>{t('Stop bots', '停止机器人')}</Button> : <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>{t('Hide', '收起')}</Button>}
        </span>
      </div>

      {!running && opts && <div className="stack" style={{ gap: 8 }}>
        {!opts.game.matches && <span className="mute fs-sm">{t('This preview has no server/match.js: bots can still join rooms (GCP.room).', '这个预览没有 server/match.js：机器人仍然可以加入房间（GCP.room）。')}</span>}
        {opts.game.needs?.length ? <Notice tone="accent" title={t('Your game has to teach the bots a few things', '你的游戏需要教会机器人一些事')}><span className="fs-sm">{t('The platform connects the bots, finds their matches and rooms, and handles invites and the network. What needs your game\'s rules (saying hello, marking ready, picking, moving) only your game\'s server/bot.js can do. Ask your agent to add what is missing:', '平台负责连接机器人、为它们找对局和房间，并处理邀请和网络。需要游戏规则的部分（打招呼、准备、选择、行动）只有游戏自己的 server/bot.js 能做。请让你的智能体补上缺少的部分：')}</span><ul className="fs-sm" style={{ margin: '6px 0 0', paddingLeft: 18 }}>{opts.game.needs.map((n, i) => <li key={i}>{n.message}</li>)}</ul></Notice>
          : <span className="mute fs-sm">{opts.game.bot_logic ? t('Bots play with the game\'s own server/bot.js.', '机器人使用游戏自己的 server/bot.js 进行游戏。') : t('This preview has no server/bot.js, so bots join and stay connected but send no inputs. Ask your agent to add one (get_started topic "bots").', '这个预览没有 server/bot.js，所以机器人会加入并保持连接，但不会发送操作。让你的智能体添加一个（get_started 主题 "bots"）。')}</span>}
        <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'end' }}>
          <label className="stack" style={{ gap: 2 }}><span className="dim fs-sm">{t('Bots', '机器人数量')}</span><Input type="number" min={1} max={opts.limits.bots} value={form.bots || ''} onChange={(e) => setForm({ ...form, bots: Math.max(1, Math.min(opts.limits.bots, Number(e.target.value) || 1)) })} style={{ width: 80 }} /></label>
          <label className="stack" style={{ gap: 2 }}><span className="dim fs-sm">{t('Where they go', '加入方式')}</span>
            <Select value={form.target} onChange={(e) => setForm({ ...form, target: e.target.value })}>
              <option value="follow">{t('Follow me (my searches and rooms)', '跟随我（我的匹配和房间）')}</option>
              <option value="invite">{t('Wait for my invites (as friends)', '等我邀请（作为好友）')}</option>
              <option value="code">{t('A private lobby code', '私人房间代码')}</option>
              <option value="room">{t('A room code', '房间代码')}</option>
              <option value="queue">{t('A public queue (bots only)', '公共队列（仅机器人）')}</option>
            </Select></label>
          {form.target === 'code' && <label className="stack" style={{ gap: 2 }}><span className="dim fs-sm">{t('Code', '代码')}</span><Input mono value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })} style={{ width: 110 }} /></label>}
          {form.target === 'room' && <label className="stack" style={{ gap: 2 }}><span className="dim fs-sm">{t('Room', '房间')}</span><Input mono value={form.room} onChange={(e) => setForm({ ...form, room: e.target.value })} style={{ width: 110 }} /></label>}
          {form.target === 'queue' && <label className="stack" style={{ gap: 2 }}><span className="dim fs-sm">{t('Queue', '队列')}</span><Input mono value={form.queue} onChange={(e) => setForm({ ...form, queue: e.target.value })} style={{ width: 110 }} /></label>}
          {(form.target === 'queue' || form.target === 'code') && <label className="stack" style={{ gap: 2 }}><span className="dim fs-sm">{t('Match size', '对局人数')}</span><Input type="number" min={2} max={64} value={form.size || ''} onChange={(e) => setForm({ ...form, size: Number(e.target.value) || 2 })} style={{ width: 80 }} /></label>}
          <label className="stack" style={{ gap: 2 }}><span className="dim fs-sm">{t('Network', '网络')}</span>
            <Select value={form.net} onChange={(e) => setForm({ ...form, net: e.target.value })}>{Object.entries(opts.profiles).map(([k, p]) => <option key={k} value={k}>{p.label}{p.latency_ms ? ` (+${p.latency_ms * 2} ms)` : ''}</option>)}</Select></label>
          <label className="stack" style={{ gap: 2 }}><span className="dim fs-sm">{t('Connect from', '连接地区')}</span>
            <Select value={form.region} onChange={(e) => setForm({ ...form, region: e.target.value })}>{Object.entries(opts.regions).map(([k, n]) => <option key={k} value={k}>{n}</option>)}</Select></label>
          <label className="stack" style={{ gap: 2 }}><span className="dim fs-sm">{t('Minutes', '分钟')}</span><Input type="number" min={1} max={opts.limits.minutes} value={form.minutes} onChange={(e) => setForm({ ...form, minutes: Math.max(1, Math.min(opts.limits.minutes, Number(e.target.value) || 1)) })} style={{ width: 70 }} /></label>
          <label className="row fs-sm" style={{ gap: 6 }}><input type="checkbox" checked={form.mixed} onChange={(e) => setForm({ ...form, mixed: e.target.checked })} />{t('One poor and one perfect connection', '一个差网络、一个理想网络')}</label>
          <Button variant="primary" size="sm" onClick={start} disabled={busy === 'start' || !form.bots}>{t('Start bots', '启动机器人')}</Button>
        </div>
        <span className="dim fs-sm">{form.bots * form.minutes} {t('bot-minutes', '机器人分钟')} · {left} {t('left today', '今日剩余')} · {t('Bots play only in your preview and never count in ratings or stats.', '机器人只在你的预览中游戏，不计入评分和统计。')}</span>
        {st?.last?.summary?.why && <span className="dim fs-sm">{t('Last run', '上次运行')}: {st.last.summary.why}{st.last.summary.matches != null ? ` · ${st.last.summary.matches} ${t('matches finished', '局完成')}` : ''}</span>}
      </div>}

      {running && <>
        {st?.needs?.length ? <Notice tone="bad" title={t('The bots are stuck: your game has not told them what to do', '机器人卡住了：你的游戏还没告诉它们该做什么')}><ul className="fs-sm" style={{ margin: 0, paddingLeft: 18 }}>{st.needs.map((n) => <li key={n.hook}>{n.message}</li>)}</ul></Notice>
          : st?.brain?.kind !== 'game' && st?.brain?.note && <span className="mute fs-sm">{st.brain.note}</span>}
        {st?.target === 'follow' && !st.following && <span className="mute fs-sm">{t('Start a match or open a room in your game above: the bots join you through the real matchmaker.', '在上方的游戏中开始匹配或打开房间：机器人会通过真实的匹配系统加入你。')}</span>}
        <span className="mute fs-sm">{t('In this preview the bots are your online friends: invite them from your game\'s own Invite Friends, and they answer and join like friends do.', '在这个预览中，机器人就是你的在线好友：用游戏自己的“邀请好友”邀请它们，它们会像好友一样回复并加入。')}</span>
        <Table dense stickyEnd>
          <thead><tr style={{ whiteSpace: 'nowrap' }}><th>{t('Bot', '机器人')}</th><th>{t('State', '状态')}</th><th>{t('Network', '网络')}</th><th>{t('Round trip', '往返延迟')}</th><th>{t('Snapshots', '快照')}</th><th>{t('Longest gap', '最长间隔')}</th><th>{t('Inputs', '操作')}</th><th>{t('Reconnects', '重连')}</th><th>{t('Errors', '错误')}</th><th /></tr></thead>
          <tbody style={{ whiteSpace: 'nowrap' }}>{bots.map((b) => {
            const tone = PHASE[b.phase] || 'neutral', s = b.stats, err = s.last_error || b.brain.last_error;
            return <tr key={b.id}>
              <td><b>{b.name}</b></td>
              <td><Badge tone={tone}>{phaseName(b.phase)}</Badge>{b.detail ? <div className="dim fs-sm">{b.detail}</div> : null}</td>
              <td className="fs-sm">{opts?.profiles[b.net.profile]?.label || b.net.profile}{b.net.spike ? ` · ${t('spike', '尖峰')}` : ''}{b.net.down ? ` · ${t('down', '断网')}` : ''}</td>
              <td className="mono fs-sm" title={t('last · median · 95th percentile, over 10 s', '最近 · 中位数 · 95 百分位，10 秒内')}>{ms(s.rtt_ms)}<div className="dim">{ms(s.rtt_p50_ms)} · {ms(s.rtt_p95_ms)}</div></td>
              <td className="mono fs-sm" title={t('per second · spacing jitter', '每秒 · 间隔抖动')}>{s.snapshots_per_s}/s<div className="dim">± {ms(s.snapshot_jitter_ms)}</div></td>
              <td className="mono fs-sm">{ms(s.snapshot_gap_max_ms)}</td>
              <td className="mono fs-sm" title={t('sent · not yet acknowledged', '已发送 · 尚未确认')}>{b.inputs_sent}<div className="dim">{s.inputs_unacked} {t('waiting', '待确认')}</div></td>
              <td className="mono fs-sm">{s.reconnects}</td>
              <td className="fs-sm" title={err || ''}>{s.errors + b.brain.errors ? <span className="bad">{s.errors + b.brain.errors}</span> : '0'}{err ? <div className="dim" style={{ maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{err}</div> : null}</td>
              <td><RowMenu label={b.name} actions={menu(b.id)} /></td>
            </tr>;
          })}</tbody>
        </Table>
        {!!st?.log?.length && <details><summary className="dim fs-sm">{t('Log', '日志')}</summary><pre className="mono fs-sm" style={{ whiteSpace: 'pre-wrap', maxHeight: 180, overflow: 'auto', margin: 0 }}>{st.log.slice().reverse().join('\n')}</pre></details>}
      </>}
    </div>
  );
}

// ---- the invite picker over the preview (GCP.friends.open) ----------------------------------------------------------
// The same look as the friends panel's picker on a live game page, listing the test players instead of real friends.
function useLayer(): Element {
  const get = () => document.fullscreenElement || (document as Document & { webkitFullscreenElement?: Element }).webkitFullscreenElement || document.body;
  const [el, setEl] = useState<Element>(get);
  useEffect(() => { const f = () => setEl(get()); document.addEventListener('fullscreenchange', f); document.addEventListener('webkitfullscreenchange', f); return () => { document.removeEventListener('fullscreenchange', f); document.removeEventListener('webkitfullscreenchange', f); }; }, []);
  return el;
}
function InvitePicker({ projectId, picker, st, limit, reload, onClose, onStarted }: { projectId: string; picker: Picker; st: Status | null; limit: number; reload: () => Promise<unknown>; onClose: () => void; onStarted: () => void }) {
  const layer = useLayer(), [sent, setSent] = useState<Record<string, string>>({}), [err, setErr] = useState(''), [busy, setBusy] = useState('');
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } }; addEventListener('keydown', k, true); return () => removeEventListener('keydown', k, true); }, [onClose]);
  const bots = st?.running ? st.bots || [] : [];
  const answerOf = (bot: string) => { const id = sent[bot]; return id ? (st?.invites || []).find((a) => a.id === id) || null : null; };
  const invite = async (b: Bot) => {
    setErr(''); setBusy(b.id);
    try { const r = await api<{ id: string }>(`/console/projects/${projectId}/bots/invite`, { method: 'POST', body: { bot: b.id, lobby: picker.lobby || undefined, label: picker.label || undefined, data: picker.data } }); setSent((x) => ({ ...x, [b.id]: r.id })); void reload(); }
    catch (e) { setErr((e as Error).message); } finally { setBusy(''); }
  };
  const startSome = async () => {
    setErr(''); setBusy('start');
    try { await api(`/console/projects/${projectId}/bots`, { method: 'POST', body: { bots: Math.min(3, limit), target: 'invite', net: '4g', minutes: 15 } }); onStarted(); await reload(); }
    catch (e) { setErr((e as Error).message); } finally { setBusy(''); }
  };
  return createPortal(
    <div className="fr-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <aside className="fr-panel" role="dialog" aria-modal="true" aria-label={t('Invite test players', '邀请测试玩家')} tabIndex={-1}>
        <header className="fr-head"><b className="fr-title">{t('Invite test players', '邀请测试玩家')}</b><button type="button" className="fr-x big" aria-label={t('Close', '关闭')} onClick={onClose}>×</button></header>
        <div className="fr-inviting"><b>{t('Your friends cannot join a preview', '好友无法加入预览')}</b><span>{t('Here your test players stand in for them: invite one as a player invites a friend, and it answers and joins through the real invite path.', '这里由测试玩家代替好友：像玩家邀请好友一样邀请它们，它们会通过真实的邀请流程回复并加入。')} {picker.lobby ? t('They join your match when they accept.', '对方接受后会加入你的对局。') : t('They open the game when they accept.', '对方接受后会打开这款游戏。')}</span></div>
        <div className="fr-body">
          {err && <div className="fr-empty"><span className="bad">{err}</span></div>}
          {!st ? <div className="fr-empty">{t('Loading…', '加载中…')}</div>
            : !bots.length ? <div className="fr-empty"><b>{t('No test players are running', '没有正在运行的测试玩家')}</b><span>{t('Start a few and they show here as your online friends.', '启动几个，它们就会作为你的在线好友出现在这里。')}</span><Button size="sm" variant="primary" onClick={() => void startSome()} disabled={busy === 'start'}>{t('Start 3 test players', '启动 3 个测试玩家')}</Button></div>
            : <section className="fr-group"><h3>{t('Test players', '测试玩家')} <span>{bots.length}</span></h3>
              {bots.map((b) => {
                const a = answerOf(b.id), status = b.friend || 'online';
                return <div key={b.id} className="fr-row">
                  <span className="fr-main"><span className="fr-av" aria-hidden="true">{b.name.slice(0, 1).toUpperCase()}<i className={'fr-dot ' + status} /></span>
                    <span className="fr-who"><b className="clip">{b.name}</b><span className="clip fr-line">{status === 'busy' ? t('Busy', '忙碌') : t('Online', '在线')} · {phaseName(b.phase)}</span></span></span>
                  <span className="fr-acts">{a ? <span className="fr-sent">{a.accepted ? t('Accepted', '已接受') : t('Declined', '已拒绝')}</span>
                    : sent[b.id] ? <span className="fr-sent">{t('Invited', '已邀请')}</span>
                    : <Button size="sm" variant="primary" disabled={busy === b.id} onClick={() => void invite(b)}>{t('Invite', '邀请')}{status === 'busy' && <small className="fr-st"> · {t('Busy', '忙碌')}</small>}</Button>}</span>
                </div>;
              })}
            </section>}
        </div>
      </aside>
    </div>, layer);
}
