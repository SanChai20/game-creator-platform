import { useEffect, useState } from 'react';
import { ago, api, count, Fail, num, t, useData } from '../lib';
import { Badge, Bars, Card, ChartBlock, EmptyState, Notice, PageHeader, Segmented, Share, Spinner, Stat, StatGrid, StatusBadge, Table, Tabs } from '../ui';

const DEVICE: Record<string, [string, string]> = { phone: ['Phone', '手机'], tablet: ['Tablet', '平板'], desktop: ['Desktop', '桌面电脑'], other: ['Other', '其他'] };
const LENGTH_ZH: Record<string, string> = { 'under 30 s': '30 秒以内', '30 s to 2 min': '30 秒至 2 分钟', '2 to 5 min': '2 至 5 分钟', '5 to 15 min': '5 至 15 分钟', '15 to 30 min': '15 至 30 分钟', 'over 30 min': '30 分钟以上' };
const mins = (m: number) => (m >= 120 ? `${num(m / 60)} ${t('h', '小时')}` : `${num(m)} ${t('min', '分钟')}`);
const pct = (v: number) => `${v}%`;

export const projectTabs = (id: string, on: 'overview' | 'analytics') => (
  <Tabs active={on} items={[{ key: 'overview', to: `/console/p/${id}`, label: t('Overview', '概览') }, { key: 'analytics', to: `/console/p/${id}/analytics`, label: t('Analytics', '数据分析') }]} />
);

/** Players online now, refreshed every 15 seconds (the rate the games send heartbeats). */
function LiveNow({ id, first }: { id: string; first: any }) {
  const [now, setNow] = useState(first);
  useEffect(() => { const i = setInterval(() => { void api(`/console/projects/${id}/online`).then(setNow).catch(() => { }); }, 15000); return () => clearInterval(i); }, [id]);
  return (
    <Card title={<span className="row">{t('Right now', '此刻')} <Badge tone={now.online.live ? 'good' : 'neutral'}>{t('live', '实时')}</Badge></span>} aside={`${t('updated', '更新于')} ${ago(Date.parse(now.at))}`} pad>
      <StatGrid>
        <Stat tone="accent" label={t('Players online', '在线玩家')} value={num(now.online.live)} sub={count(now.online.live_sessions, 'open session', 'open sessions', '个会话进行中')} />
        <Stat label={t('In multiplayer rooms', '多人房间中')} value={num(now.rooms.players_in_rooms)} sub={count(now.rooms.live, 'room open', 'rooms open', '个房间开放中')} />
        <Stat label={t('On your preview', '预览版在线')} value={num(now.online.preview)} sub={t('you and anyone testing', '你本人及测试者')} />
      </StatGrid>
      {!!now.rooms.busiest.length && <div style={{ marginTop: 18 }}><Table><thead><tr><th>{t('Room', '房间')}</th><th>{t('Where', '环境')}</th><th className="n">{t('Players', '玩家')}</th><th className="n">{t('Last change', '最近变化')}</th></tr></thead>
        <tbody>{now.rooms.busiest.map((r: any) => <tr key={r.env + r.room}><td className="mono">{r.room}</td><td>{r.env === 'live' ? t('Live', '线上') : t('Preview', '预览')}</td><td className="n">{r.players}</td><td className="n">{ago(Date.parse(r.since))}</td></tr>)}</tbody></Table></div>}
      <p className="dim fs-sm" style={{ marginTop: 14 }}>{t('Online means the game sent a heartbeat in the last minute. Rooms count players connected to GCP.room now.', '在线指游戏在最近一分钟内发送过心跳；房间人数为当前连接到 GCP.room 的玩家。')}</p>
    </Card>
  );
}

export function Analytics({ id }: { id: string }) {
  const [days, setDays] = useState<'7' | '30' | '90'>('30');
  const { data, error, loading, reload } = useData<any>(`/console/projects/${id}/analytics?days=${days}`);
  if (error && !data) return <div className="wrap page"><Fail error={error} retry={reload} /></div>;
  if (loading && !data) return <Spinner />;
  const p = data.project, x = data.totals, daily = data.daily as any[];
  const bar = (k: string) => daily.map((d) => ({ label: d.day, value: d[k] }));
  const empty = !x.sessions;

  return (
    <div className="wrap page">
      <PageHeader back={{ to: '/console', label: t('Console', '控制台') }} title={p.title} badge={<StatusBadge status={p.status} />} />
      <div className="row wrapx" style={{ gap: 12, alignItems: 'flex-start' }}>
        {projectTabs(id, 'analytics')}
        <span className="right"><Segmented label={t('Window', '时间范围')} value={days} onChange={setDays} options={[['7', t('7 days', '7 天')], ['30', t('30 days', '30 天')], ['90', t('90 days', '90 天')]]} /></span>
      </div>

      <div className="stack l">
        <LiveNow key={id} id={id} first={data.now} />

        {empty ? <Card pad><EmptyState title={t('No players yet in this window', '此时间段内还没有玩家')}>{p.status === 'live' ? t('Numbers appear here as soon as signed-in players open the live game. Your own plays and the verifier are not counted.', '已登录的玩家打开线上游戏后，这里就会出现数据。你本人的游玩和自动验证不计入。') : t('Publish the game to start collecting player numbers. Your own plays and the verifier are not counted.', '发布游戏后才会开始统计玩家数据。你本人的游玩和自动验证不计入。')}</EmptyState></Card> : <>
          <StatGrid>
            <Stat label={t('Players', '玩家')} value={num(x.players)} sub={t(`${num(x.new_players)} new · ${num(x.returning_players)} returning`, `${num(x.new_players)} 新玩家 · ${num(x.returning_players)} 回访`)} />
            <Stat label={t('Sessions', '会话')} value={num(x.sessions)} sub={t(`${x.sessions_per_player} per player · ${num(x.counted_plays)} counted plays`, `人均 ${x.sessions_per_player} 次 · ${num(x.counted_plays)} 次计入游玩`)} />
            <Stat label={t('Time played', '游玩时长')} value={mins(x.minutes_played)} sub={t(`${x.avg_session_minutes} min average · ${x.median_session_minutes} min median`, `平均 ${x.avg_session_minutes} 分钟 · 中位 ${x.median_session_minutes} 分钟`)} />
            <Stat tone={x.error_session_share > 5 ? 'accent' : undefined} label={t('Sessions with errors', '出错的会话')} value={pct(x.error_session_share)} sub={`${count(x.sessions_with_errors, 'session', 'sessions', '个会话')} · ${num(x.never_started)} ${t('never started', '个未能启动')}`} />
          </StatGrid>

          <div className="cols">
            <div className="stack l">
              <Card title={t('Players per day', '每日玩家')} pad>
                <div className="stack l">
                  <ChartBlock label={t('Unique players', '独立玩家')} value={num(x.players)}><Bars data={bar('players')} tip={(d) => `${d.label} · ${d.value}`} /></ChartBlock>
                  <ChartBlock label={t('New players', '新玩家')} value={num(x.new_players)}><Bars data={bar('new_players')} tip={(d) => `${d.label} · ${d.value}`} height={88} /></ChartBlock>
                  <ChartBlock label={t('Minutes played', '游玩分钟数')} value={mins(x.minutes_played)}><Bars data={bar('minutes')} tip={(d) => `${d.label} · ${d.value} min`} height={88} /></ChartBlock>
                </div>
              </Card>
              <Card title={t('Last 24 hours', '最近 24 小时')} aside={t('sessions started per hour, UTC', '每小时开始的会话数（UTC）')} pad>
                <Bars data={data.last_24_hours.map((h: any) => ({ label: h.hour.slice(11, 16), value: h.sessions }))} tip={(d) => `${d.label} · ${d.value}`} height={96} />
              </Card>
              <Card title={t('By version', '按版本')}>
                <Table><thead><tr><th>{t('Version', '版本')}</th><th className="n">{t('Players', '玩家')}</th><th className="n">{t('Sessions', '会话')}</th><th className="n">{t('Avg session', '平均时长')}</th><th className="n">{t('With errors', '出错占比')}</th></tr></thead>
                  <tbody>{data.versions.map((v: any) => <tr key={v.version}><td className="mono">v{v.version}{v.version === p.live_version && <> <Badge tone="good" dot={false}>{t('Live', '线上')}</Badge></>}</td><td className="n">{num(v.players)}</td><td className="n">{num(v.sessions)}</td><td className="n">{v.avg_minutes} {t('min', '分钟')}</td><td className={'n' + (v.error_session_share > 5 ? ' bad' : '')}>{pct(v.error_session_share)}</td></tr>)}</tbody></Table>
              </Card>
              <Card title={t('Errors players hit', '玩家遇到的错误')} aside={`${count(data.errors.total, 'report', 'reports', '次报告')} · ${count(data.errors.kinds, 'kind', 'kinds', '种')}`}>
                {data.errors.top.length ? <Table><thead><tr><th>{t('Message', '信息')}</th><th>{t('Version', '版本')}</th><th className="n">{t('Count', '次数')}</th><th className="n">{t('Last seen', '最近出现')}</th></tr></thead>
                  <tbody>{data.errors.top.map((e: any, i: number) => <tr key={i}><td className="mono bad fs-sm" style={{ wordBreak: 'break-word' }}>{e.message}</td><td>v{e.version}</td><td className="n">{e.count}</td><td className="n">{ago(Date.parse(e.last_seen))}</td></tr>)}</tbody></Table>
                  : <div className="pad mute">{t('No errors reported by players in this window.', '此时间段内玩家没有报告错误。')}</div>}
              </Card>
            </div>
            <div className="stack l">
              <Card title={t('Returning players', '回访玩家')} pad>
                <Share items={[{ name: t('Returning', '回访'), value: x.returning_players, note: `${num(x.returning_players)} · ${pct(x.returning_share)}` }, { name: t('New', '新玩家'), value: x.new_players, note: num(x.new_players) }]} />
                <p className="dim fs-sm" style={{ marginTop: 12 }}>{t('Returning: played on an earlier day too.', '回访：此前某一天也玩过。')}</p>
              </Card>
              <Card title={t('Session length', '单次时长')} pad>
                <Share items={data.session_lengths.map((b: any) => ({ name: t(b.label, LENGTH_ZH[b.label] || b.label), value: b.sessions, note: num(b.sessions) }))} />
              </Card>
              <Card title={t('Devices', '设备')} pad>
                <Share items={data.devices.map((d: any) => ({ name: t(...(DEVICE[d.name] || [d.name, d.name])), value: d.sessions, note: `${pct(d.share)} · ${d.avg_minutes} ${t('min', '分钟')}` }))} />
              </Card>
              <Card title={t('Browsers', '浏览器')} pad>
                <Share items={data.browsers.map((d: any) => ({ name: d.name, value: d.sessions, note: pct(d.share) }))} />
              </Card>
              <Card title={t('Operating systems', '操作系统')} pad>
                <Share items={data.systems.map((d: any) => ({ name: d.name, value: d.sessions, note: pct(d.share) }))} />
              </Card>
            </div>
          </div>
          <Notice tone="info">{t('Only signed-in players of the live game are counted here. Your own plays, preview sessions and the verifier are left out. Your agent sees the same numbers through get_stats.', '这里只统计线上游戏的已登录玩家；你本人的游玩、预览会话和自动验证都不计入。你的智能体可以通过 get_stats 看到同样的数据。')}</Notice>
        </>}
      </div>
    </div>
  );
}
