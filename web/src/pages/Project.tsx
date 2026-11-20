import { useEffect, useRef, useState } from 'react';
import { usePlayClock } from '../play-clock';
import { ago, api, bytes, dateTime, Fail, genreName, num, playTime, series, Stars, t, usd, useAct, useApp, useData, count } from '../lib';
import { Badge, Bars, Button, Card, ChartBlock, CheckRow, EmptyState, Input, KeyValue, Modal, Notice, PageHeader, Stat, StatGrid, StatusBadge, Switch, Table, Ticks } from '../ui';
import { ProjectSkeleton } from '../skeletons';
import { Stage } from './Game';
import type { StageCtl } from '../player';
import { CaptureButtons, FeedbackEditor, FeedbackQueue, type Shot } from '../feedback';
import { projectTabs } from './Analytics';
import { CompatSection, useCompat, type GameCompat } from '../compat-ui';
import { AgeBadge, ageLabel } from '../meta-ui';

/** What this version needs from a player's browser, checked against yours: the store page shows players the same. */
const metaField = (f: string) => ({ genre: t('Genre', '类型'), tags: t('Tags from the platform list', '平台标签'), requirements: t('Compatibility requirements', '兼容性要求'), languages: t('Languages', '语言'), players: t('Players', '玩家'), content: t('Content descriptors (age rating)', '内容描述（年龄分级）') } as Record<string, string>)[f] ?? f;

/** What the store page shows about the newest version, and what publishing still needs. */
function StoreMetadata({ m }: { m: { version: number; required: boolean; missing: string[]; age: number | null } }) {
  return (
    <Card title={t('Store page metadata', '商店页面元数据')} aside={<span className="dim fs-sm">v{m.version}</span>} pad>
      {m.age != null && <div className="row"><AgeBadge age={m.age} /><b>{ageLabel(m.age)}</b></div>}
      {m.missing.length ? <>
        <p className="mute fs-sm">{m.required ? t('Publishing needs these first:', '发布前需要先填写：') : t('Not filled in yet:', '尚未填写：')}</p>
        <ul className="meta-missing">{m.missing.map((f) => <li key={f}>{metaField(f)}</li>)}</ul>
        <p className="dim fs-sm">{t('Ask your agent to run game_metadata. It walks through each one with the allowed values and what it detected in the code.', '让你的智能体执行 game_metadata。它会逐项说明可选的值以及从代码中检测到的内容。')}</p>
      </> : <p className="mute fs-sm"><Badge tone="good" dot={false}>{t('Complete', '已完整')}</Badge> {t('Everything the store page needs is on record.', '商店页面所需的信息都已齐全。')}</p>}
    </Card>
  );
}

function VersionCompat({ c }: { c: GameCompat }) {
  const v = useCompat(c);
  return <div className="ver-compat"><CompatSection c={c} v={v} /></div>;
}

function Report({ v }: { v: any }) {
  const r = v.report;
  if (!r) return <p className="mute">{v.status === 'verified' || v.status === 'failed' ? t('No report was stored for this version.', '该版本没有保存报告。') : t('Working on it. This page refreshes by itself.', '处理中，页面会自动刷新。')}</p>;
  return (
    <div className="stack">
      <div>{(r.checks || []).map((c: any) => <CheckRow key={c.id} ok={c.ok} title={c.label} detail={c.detail} hint={!c.ok && c.hint} />)}</div>
      {r.playthrough === null && (r.checks || []).some((c: any) => c.id === 'input') && <p className="mute fs-sm">{t('Only start-up, rendering and input were checked. This version has no play-through script, so nothing confirmed that it can be played to the end. Ask your agent to add one.', '仅检查了启动、渲染与输入。该版本没有试玩脚本，因此无法确认游戏能否完整玩到结束。可以让你的智能体补上。')}</p>}
      {!!r.errors?.length && <div className="log">{r.errors.join('\n')}</div>}
      {!!r.missing?.length && <div className="log">{t('Files that failed to load', '加载失败的文件')}:{'\n'}{r.missing.join('\n')}</div>}
      {r.browser === 'unavailable' && <p className="mute fs-sm">{t('The automatic browser check could not run for this version. Play the preview yourself for a short while to verify it.', '该版本无法进行自动浏览器检查。请亲自试玩预览版一小段时间来完成验证。')}</p>}
    </div>
  );
}

const listOr = (a: string[] | undefined) => (a && a.length ? a.join(', ') : '—');

/** The opt-in to share how the game is built with other developers' agents, and a look at exactly what they get. */
function OpenImplementation({ id, p, info, reload }: { id: string; p: any; info: any; reload: () => Promise<unknown> }) {
  const { busy, act } = useAct(), [card, setCard] = useState<any>(undefined), s = useApp().config.settings;
  const cut = Number(s.platform_fee_percent), openCut = Number(s.platform_fee_open_percent ?? cut);
  const perk = p.price_cents > 0
    ? (s.paid_games_enabled && openCut < cut ? t('While shared, the platform keeps {open}% of each sale of this game instead of {cut}%.', '开放期间，平台从这款游戏的每笔销售中收取 {open}%，而不是 {cut}%。', { open: openCut, cut }) : null)
    : (Number(s.open_impl_free_boost_percent) > 0 ? t('While shared, this free game ranks higher among free games, unless players rate it poorly.', '开放期间，这款免费游戏在免费游戏中排名更靠前（玩家评价较差时除外）。') : null);
  const on = !!p.open_implementation;
  const toggle = (next: boolean) => act('impl', async () => { await api(`/console/projects/${id}`, { method: 'PATCH', body: { open_implementation: next } }); await reload(); },
    next ? t('Shared. Other agents can now learn how this game is built.', '已开放。其他智能体现在可以了解这款游戏的实现方式。') : t('No longer shared.', '已停止分享。'));
  const look = () => act('look', async () => { const r = await api<{ card: any }>(`/console/projects/${id}/implementation`); setCard(r.card); });
  const f = card?.built_with;
  return (
    <Card title={t('Open implementation', '开放实现')} pad>
      <div className="stack">
        <label className="row" style={{ gap: 12, cursor: 'pointer' }}>
          <Switch checked={on} disabled={busy === 'impl'} onChange={(e) => void toggle(e.target.checked)} aria-label={t('Share how this game is built', '分享这款游戏的实现方式')} />
          <b>{on ? t('Shared with other agents', '已向其他智能体开放') : t('Not shared', '未分享')}</b>
        </label>
        <p className="mute fs-sm">{on
          ? t('Other developers\' agents can read how the live game is built: engine, rendering, input, audio, techniques and a summary. Your code and files are never shared.', '其他开发者的智能体可以读取线上版本的实现方式：引擎、渲染、输入、音频、技术与概述。你的代码和文件永远不会被分享。')
          : t('Turn this on to let other developers\' agents learn how the game is built, never its code or files. With it off, nothing is shared.', '开启后，其他开发者的智能体可以了解这款游戏的实现方式，但看不到代码或文件。关闭时不分享任何内容。')}</p>
        {perk && <p className={on ? 'good fs-sm' : 'fs-sm'}>{perk}</p>}
        {on && info && <KeyValue items={[[t('Describes', '描述版本'), <span className="mono">v{info.version}</span>], [t('Read by other agents', '被其他智能体读取'), num(info.reads)], [t('Summary by', '概述来源'), info.summary_source === 'ai' ? 'Workers AI' : t('Rules', '规则')]]} />}
        {p.live_version ? <Button size="sm" onClick={look} disabled={busy === 'look'}>{on ? t('See what agents see', '查看智能体看到的内容') : t('Preview what would be shared', '预览将分享的内容')}</Button>
          : <p className="dim fs-sm">{t('Publish the game first. The card describes the live version.', '请先发布游戏，卡片描述的是线上版本。')}</p>}
      </div>
      {card && <Modal wide onClose={() => setCard(undefined)}><div className="stack l">
        <div className="row"><b>{t('What other agents see', '其他智能体看到的内容')}</b>{!card.shared && <Badge tone="info">{t('Preview, not shared', '预览，未分享')}</Badge>}<Button size="sm" className="right" onClick={() => setCard(undefined)}>{t('Close', '关闭')}</Button></div>
        <p style={{ whiteSpace: 'pre-wrap' }}>{card.summary}</p>
        <KeyValue items={[
          [t('Engine', '引擎'), f.engine], [t('Libraries', '库'), listOr(f.libraries)], [t('Rendering', '渲染'), listOr(f.rendering)], [t('Graphics', '画面技术'), listOr(f.graphics)],
          [t('Input', '输入'), listOr(f.input)], [t('Audio', '音频'), listOr(f.audio)], [t('Art', '美术'), f.assets.approach], [t('Platform services', '平台服务'), listOr(f.platform_services)],
          [t('Loop and performance', '循环与性能'), listOr(f.loop_and_performance)], [t('Structure', '结构'), `${f.structure.files} ${t('files', '个文件')} · ${f.structure.own_code_lines} ${t('lines of own code', '行自有代码')} · ${f.structure.modules}`],
          !!f.gameplay.playthrough_steps.length && [t('Play-through', '试玩流程'), f.gameplay.playthrough_steps.join(' → ')],
        ]} />
        <Ticks items={[card.never_shared]} />
      </div></Modal>}
    </Card>
  );
}

/** A paid game's free trial: whether players may try it before buying, and for how many minutes. Kept per player account on the server. */
function FreeTrial({ id, paid, trial, max, reload }: { id: string; paid: boolean; trial: { minutes: number; active: boolean; players: number; bought: number }; max: number; reload: () => Promise<unknown> }) {
  const { busy, act } = useAct(), [mins, setMins] = useState<string | null>(null);
  const on = paid && trial.minutes > 0;
  const save = (m: number) => act('trial', async () => {
    if (!Number.isInteger(m) || m < 0 || m > max) throw new Error(t('Enter a whole number of minutes from 1 to {max}.', '请输入 1 到 {max} 之间的整数分钟。', { max }));
    await api(`/console/projects/${id}`, { method: 'PATCH', body: { trial_minutes: m } }); setMins(null); await reload();
  }, m ? t('Free trial set to {m} minutes.', '免费试玩已设为 {m} 分钟。', { m }) : t('Free trial turned off.', '已关闭免费试玩。'));
  const toggle = (next: boolean) => { if (next) setMins(String(trial.minutes || Math.min(30, max))); else if (trial.minutes) void save(0); else setMins(null); };
  return (
    <Card title={t('Free trial', '免费试玩')} pad>
      <div className="row">
        <span className="grow">{!paid ? t('Set a price first. A free game needs no trial.', '请先设置价格。免费游戏无需试玩。') : on ? <b>{trial.minutes === 1 ? t('1 minute before buying', '购买前可玩 1 分钟') : t('{minutes} minutes before buying', '购买前可玩 {minutes} 分钟', { minutes: trial.minutes })}</b> : t('Players must buy before playing.', '玩家需购买后才能游玩。')}</span>
        <Switch checked={on || mins !== null} disabled={!paid || busy === 'trial'} onChange={(e) => toggle(e.target.checked)} aria-label={t('Let players try it for free', '允许玩家免费试玩')} />
      </div>
      {mins !== null && (
        <div className="trial-edit">
          <Input mono inputMode="numeric" value={mins} onChange={(e) => setMins(e.target.value.replace(/[^0-9]/g, ''))} autoFocus aria-label={t('Trial length in minutes', '试玩时长（分钟）')} />
          <span className="mute">{t('minutes', '分钟')}</span>
          <Button variant="primary" onClick={() => void save(Number(mins))} disabled={busy === 'trial' || !mins}>{t('Save', '保存')}</Button>
          <Button variant="ghost" onClick={() => setMins(null)}>{t('Cancel', '取消')}</Button>
        </div>
      )}
      {on && mins === null && <div className="row"><span className="mute fs-sm grow">{t('{players} tried it · {bought} then bought it', '{players} 人试玩 · 其中 {bought} 人购买', { players: num(trial.players), bought: num(trial.bought) })}</span><Button size="sm" onClick={() => setMins(String(trial.minutes))}>{t('Change', '修改')}</Button></div>}
      <p className="dim fs-sm">{t('Players who have not bought the game can play this long in total, then are asked to buy. The time is counted on our servers for their account, so reloading or switching devices does not reset it. Up to {max} minutes.', '未购买的玩家总共可以玩这么久，之后会提示购买。时长按玩家账号在服务器端计算，刷新页面或更换设备都不会重置。最长 {max} 分钟。', { max })}</p>
    </Card>
  );
}

export function Project({ id }: { id: string }) {
  const { config } = useApp(), { busy, act } = useAct(), s = config.settings;
  const { data, error, loading, reload } = useData<any>(`/console/projects/${id}`);
  const [open, setOpen] = useState<number | null>(null), [preview, setPreview] = useState<string | null>(null), [previewSession, setPreviewSession] = useState<string | null>(null), [priceText, setPriceText] = useState<string | null>(null);
  usePlayClock(preview ? previewSession : null);   // the platform's play clock for the preview session (src/play-clock.ts)
  // creator feedback: a capture being marked up (the game keeps its place, hidden, behind the editor), and a counter that
  // refreshes the queue card after an item was added
  const stage = useRef<StageCtl>(null), stageBox = useRef<HTMLDivElement>(null), [shot, setShot] = useState<Shot | null>(null), [fbStamp, setFbStamp] = useState(0);

  // While a deployment is running, keep the page fresh.
  const working = !!data?.versions.some((v: any) => ['queued', 'deploying', 'verifying'].includes(v.status));
  useEffect(() => { if (!working) return; const i = setInterval(() => void reload(), 4000); return () => clearInterval(i); }, [working, reload]);
  useEffect(() => { if (data && open === null && data.versions[0]) setOpen(data.versions[0].version); }, [data]); // eslint-disable-line react-hooks/exhaustive-deps

  if (error && !data) return <div className="wrap page"><Fail error={error} retry={reload} /></div>;
  if (loading && !data) return <ProjectSkeleton />;
  const p = data.project, versions = data.versions as any[];
  const playPreview = () => act('pv', async () => { const r = await api<{ url: string; session: string }>(`/console/projects/${id}/preview`, { method: 'POST' }); setPreviewSession(r.session); setPreview(r.url); });
  const offline = () => { if (confirm(t('Take this game offline? Players will not be able to open it until you put it back.', '确定下线这款游戏吗？在重新上线之前，玩家将无法打开它。'))) void act('off', async () => { await api(`/console/projects/${id}/offline`, { method: 'POST' }); await reload(); }, t('The game is offline.', '游戏已下线。')); };
  const online = () => act('on', async () => { await api(`/console/projects/${id}/online`, { method: 'POST' }); await reload(); }, t('Going back online. This takes a moment.', '正在重新上线，请稍候。'));
  const savePrice = () => act('price', async () => {
    const cents = Math.round(parseFloat(priceText || '0') * 100);
    if (!Number.isFinite(cents) || cents < 0) throw new Error(t('Enter a price like 4.99, or 0 for free.', '请输入类似 4.99 的价格，免费请填 0。'));
    await api(`/console/projects/${id}`, { method: 'PATCH', body: { price_cents: cents } }); setPriceText(null); await reload();
  }, t('Price saved.', '价格已保存。'));
  const plays = series<any>(data.daily, 30, (r) => r.plays), mins = series<any>(data.daily, 30, (r) => Math.round(r.seconds / 60));
  const sum30 = (k: string) => data.daily.reduce((a: number, r: any) => a + r[k], 0);

  return (
    <div className="wrap page">
      <PageHeader back={{ to: '/console', label: t('Console', '控制台') }} title={p.title} badge={<StatusBadge status={p.status} />} sub={p.tagline || undefined}
        actions={<>
          {p.preview_version && <Button onClick={playPreview} disabled={busy === 'pv'}>▶ {t('Play preview', '试玩预览')} v{p.preview_version}</Button>}
          {p.status === 'live' && <Button to={`/g/${p.slug}`}>{t('Store page', '商店页面')}</Button>}
          {p.status === 'live' && <Button variant="danger" onClick={offline} disabled={busy === 'off'}>{t('Take offline', '下线')}</Button>}
          {p.status === 'offline' && p.live_version && <Button variant="primary" onClick={online} disabled={busy === 'on'}>{t('Put back online', '重新上线')}</Button>}
        </>} />
      {projectTabs(id, 'overview')}
      {p.status === 'removed' && <div style={{ marginBottom: 22 }}><Notice tone="bad">{t('This game was removed by the platform.', '该游戏已被平台移除。')} {p.removed_reason}</Notice></div>}

      <div className="stack l">
        <StatGrid>
          <Stat tone="accent" to={`/console/p/${id}/analytics`} label={t('Online now', '当前在线')} value={num(data.online?.online.live ?? 0)} sub={t('{n} in rooms · see analytics', '{n} 人在房间中 · 查看数据分析', { n: num(data.online?.rooms.players_in_rooms ?? 0) })} />
          <Stat label={t('Plays', '游玩次数')} value={num(p.plays)} sub={`${num(sum30('plays'))} ${t('in 30 days', '近 30 天')}`} />
          <Stat label={t('Time played', '游玩时长')} value={playTime(p.minutes * 60)} sub={`${playTime(sum30('seconds'))} ${t('in 30 days', '近 30 天')}`} />
          <Stat label={t('Rating', '评分')} value={p.rating != null ? p.rating.toFixed(1) : '—'} sub={count(p.rating_count, 'rating', 'ratings', '个评分')} />
          <Stat label={t('Sales', '销量')} value={num(data.sales.n)} sub={`${usd(data.sales.net)} ${t('to you', '归你所得')} · ${usd(data.sales.gross)} ${t('gross', '总额')}`} />
        </StatGrid>

        <div className="cols">
          <div className="stack l">
            <Card title={t('Versions', '版本')} aside={t('Your agent deploys, verifies and publishes', '由智能体部署、验证并发布')}>
              {versions.length ? versions.map((v) => (
                <div className={'ver' + (open === v.version ? ' open' : '')} key={v.version}>
                  <button onClick={() => setOpen(open === v.version ? null : v.version)} aria-expanded={open === v.version}>
                    <span className="chev" aria-hidden="true" />
                    <b className="mono">v{v.version}</b><StatusBadge status={v.status} />
                    {p.live_version === v.version && <Badge tone="good" dot={false}>{t('Live', '线上')}</Badge>}
                    {p.preview_version === v.version && <Badge tone="info" dot={false}>{t('Preview', '预览')}</Badge>}
                    {v.human_ok && <Badge dot={false}>{t('Verified by play', '试玩验证')}</Badge>}
                    <span className="mute clip grow fs-sm">{v.note || v.stage}</span>
                    <span className="dim fs-sm" style={{ whiteSpace: 'nowrap' }}>{ago(v.created_at)}</span>
                  </button>
                  {open === v.version && (
                    <div className="body">
                      <div className="stack">{v.report?.summary && <p>{v.report.summary}</p>}<Report v={v} /></div>
                      <div className="stack">
                        {v.screenshot ? <a href={v.screenshot} target="_blank" rel="noreferrer"><img src={v.screenshot} alt={t('Verification screenshot', '验证截图')} /></a> : <EmptyState compact title={t('No screenshot', '暂无截图')} />}
                        <KeyValue items={[
                          [t('Files', '文件'), `${v.files} · ${bytes(v.bytes)}`],
                          v.report?.metrics && [t('Load time', '加载耗时'), `${v.report.metrics.loadMs} ms`],
                          v.report?.metrics && [t('Frame rate in check', '检查帧率'), `${v.report.metrics.fps} fps`],
                          [t('Created', '创建于'), dateTime(v.created_at)],
                          v.published_at && [t('Published', '发布于'), dateTime(v.published_at)],
                        ]} />
                      </div>
                      {v.compat && <VersionCompat c={v.compat} />}
                    </div>
                  )}
                </div>
              )) : <div className="pad mute">{t('No version yet. Ask your agent to run deploy_preview.', '还没有版本。让你的智能体执行 deploy_preview。')}</div>}
            </Card>

            <Card title={t('Last 30 days', '近 30 天')} pad>
              <div className="stack l">
                <ChartBlock label={t('Plays per day', '每日游玩次数')} value={num(sum30('plays'))}><Bars data={plays} tip={(d) => `${d.label} · ${d.value}`} /></ChartBlock>
                <ChartBlock label={t('Minutes played per day', '每日游玩分钟数')} value={playTime(sum30('seconds'))}><Bars data={mins} tip={(d) => `${d.label} · ${d.value} min`} /></ChartBlock>
              </div>
            </Card>

            {!!data.errors.length && <Card title={t('Errors players hit', '玩家遇到的错误')} aside={t('Reported by the game', '游戏自己上报的')}>
              <Table><thead><tr><th>{t('Message', '信息')}</th><th>{t('Version', '版本')}</th><th className="n">{t('Count', '次数')}</th><th className="n">{t('Last seen', '最近出现')}</th></tr></thead>
                <tbody>{data.errors.map((e: any, i: number) => <tr key={i}><td className="mono bad fs-sm" style={{ wordBreak: 'break-word' }}>{e.message}</td><td>v{e.version} · {e.env}</td><td className="n">{e.count}</td><td className="n">{ago(e.last_at)}</td></tr>)}</tbody></Table>
            </Card>}
          </div>

          <div className="stack l">
            {s.feedback_enabled !== false && <FeedbackQueue projectId={id} stamp={fbStamp} />}
            {data.metadata && <StoreMetadata m={data.metadata} />}
            <Card title={t('Price', '价格')} pad>
              {priceText === null ? (
                <div className="row"><b className="price-big">{p.price_cents > 0 ? usd(p.price_cents) : t('Free', '免费')}</b>{s.paid_games_enabled && <Button size="sm" className="right" onClick={() => setPriceText((p.price_cents / 100).toFixed(2))}>{t('Change', '修改')}</Button>}</div>
              ) : (
                <div className="price-edit"><span className="mute">$</span><Input mono inputMode="decimal" value={priceText} onChange={(e) => setPriceText(e.target.value)} autoFocus aria-label={t('Price in US dollars', '美元价格')} /><Button variant="primary" onClick={savePrice} disabled={busy === 'price'}>{t('Save', '保存')}</Button><Button variant="ghost" onClick={() => setPriceText(null)}>{t('Cancel', '取消')}</Button></div>
              )}
              {data.split ? <KeyValue items={[[t('Platform fee', '平台服务费'), usd(data.split.fee)], [t('You receive per sale', '每笔销售你获得'), usd(data.split.net), 'good']]} />
                : <p className="mute fs-sm">{s.paid_games_enabled ? t('Free to play. Set a price between {min} and {max} to sell it; the platform keeps {cut}% of each sale.', '目前免费。可在 {min} 至 {max} 之间定价销售，平台从每笔销售中收取 {cut}%。', { min: usd(s.game_price_min_cents), max: usd(s.game_price_max_cents), cut: s.platform_fee_percent }) : t('Paid games are turned off on this platform.', '平台暂未开放付费游戏。')}</p>}
            </Card>
            {s.paid_games_enabled && s.trials_enabled !== false && <FreeTrial id={id} paid={p.price_cents > 0} trial={data.trial} max={Number(s.trial_max_minutes) || 120} reload={reload} />}
            <OpenImplementation id={id} p={p} info={data.implementation} reload={reload} />
            <Card title={t('Details', '详情')} pad>
              <KeyValue items={[
                [t('Address', '地址'), `/g/${p.slug}`, 'mono'],
                [t('Working files', '工作区文件'), `${data.files.count} · ${bytes(data.files.bytes)}`],
                [t('Storage', '存储空间'), <span className={data.files.bytes > data.files.storage_bytes ? 'bad' : data.files.bytes >= data.files.storage_bytes * 0.8 ? 'sig' : undefined}>{t('{used} of {size} ({pct}%)', '已用 {used}，共 {size}（{pct}%）', { used: bytes(data.files.bytes), size: bytes(data.files.storage_bytes), pct: Math.round((data.files.bytes / Math.max(1, data.files.storage_bytes)) * 100) })}{data.files.request?.status === 'pending' && <span className="mute"> · {t('asked for {size}', '已申请 {size}', { size: bytes(data.files.request.bytes) })}</span>}</span>],
                [t('Tags', '标签'), p.tags.map(genreName).join(', ') || '—'],
                [t('Rating', '评分'), <Stars rating={p.rating} count={p.rating_count} />],
                [t('Project id', '项目 ID'), p.id, 'mono'],
              ]} />
            </Card>
            <Card title={t('Activity', '动态')} pad>
              {data.events.length ? <div>{data.events.slice(0, 14).map((e: any, i: number) => (
                <div key={i} className="activity"><Badge dot={false}>{String(e.kind).replace(/_/g, ' ')}</Badge><span className="mute" style={{ wordBreak: 'break-word' }}>{e.version ? `v${e.version} ` : ''}{e.detail}</span><span className="dim" style={{ whiteSpace: 'nowrap' }}>{ago(e.created_at)}</span></div>
              ))}</div> : <span className="mute">{t('Nothing yet.', '暂无动态。')}</span>}
            </Card>
          </div>
        </div>
      </div>

      {preview && <Modal wide game onClose={() => { setPreview(null); setShot(null); void reload(); }}><div className="stack">
        <div className="row"><b>{p.title}</b><Badge tone="info">{t('Preview', '预览')} v{p.preview_version}</Badge><Button size="sm" className="right" onClick={() => { setPreview(null); setShot(null); void reload(); }}>{t('Close', '关闭')}</Button></div>
        {(() => {
          const capture = (compact: boolean) => s.feedback_enabled !== false ? <CaptureButtons compact={compact} version={p.preview_version} capture={(pic) => stage.current!.capture(pic)} frame={() => stageBox.current?.querySelector('iframe') ?? null}
            fullscreen={() => !!stage.current?.isActive()} onShot={(sh) => { if (stage.current?.isActive()) stage.current.exit(); (document.activeElement as HTMLElement | null)?.blur?.(); setShot(sh); }} /> : null;
          // While a capture is marked up, the editor covers the game rather than replacing it: the game's frame keeps its
          // size and stays on screen. Hiding or shrinking it would resize the game, and a browser slows the drawing of a
          // frame it no longer shows, which a game can take for a slow device and lower its picture quality for good.
          return <div className="fb-stack">
            <div ref={stageBox} inert={shot ? true : undefined}>
              <Stage ctl={stage} poster={null} seed={p.slug} url={preview} controls={versions.find((v) => v.version === p.preview_version)?.controls ?? null} onQuit={() => { setPreview(null); setShot(null); void reload(); }} tools={capture(false)} badge={capture(true)} />
            </div>
            {shot && <div className="fb-over"><FeedbackEditor projectId={id} shot={shot} redraw={() => shot.alt ?? stage.current!.capture(true)} onCancel={() => setShot(null)} onDone={() => { setShot(null); setFbStamp((n) => n + 1); }} /></div>}
          </div>;
        })()}
        <p className="dim fs-sm">{t('Only you can open the preview. Playing it without errors also counts as verification when the automatic check cannot run the game.', '预览仅你本人可见。当自动检查无法运行游戏时，你无错误地试玩一段时间也算通过验证。')}</p>
      </div></Modal>}
    </div>
  );
}
