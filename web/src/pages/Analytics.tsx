import { useEffect, useState } from 'react';
import { ago, api, count, Fail, num, t, useData } from '../lib';
import { Badge, Bars, Card, ChartBlock, EmptyState, ListPager, Notice, PageHeader, Segmented, Share, Stat, StatGrid, StatusBadge, Table, Tabs, useClientPage } from '../ui';
import { AnalyticsSkeleton } from '../skeletons';

const DEVICE: Record<string, () => string> = { phone: () => t('Phone', '手机'), tablet: () => t('Tablet', '平板'), desktop: () => t('Desktop', '桌面电脑'), other: () => t('Other', '其他') };
const LENGTH: Record<string, () => string> = { 'under 30 s': () => t('under 30 s', '30 秒以内'), '30 s to 2 min': () => t('30 s to 2 min', '30 秒至 2 分钟'), '2 to 5 min': () => t('2 to 5 min', '2 至 5 分钟'), '5 to 15 min': () => t('5 to 15 min', '5 至 15 分钟'), '15 to 30 min': () => t('15 to 30 min', '15 至 30 分钟'), 'over 30 min': () => t('over 30 min', '30 分钟以上') };
const mins = (m: number) => (m >= 120 ? `${num(m / 60)} ${t('h', '小时')}` : `${num(m)} ${t('min', '分钟')}`);
const pct = (v: number) => `${v}%`;

export const projectTabs = (id: string, on: 'overview' | 'analytics') => (
  <Tabs active={on} items={[{ key: 'overview', to: `/console/p/${id}`, label: t('Overview', '概览') }, { key: 'analytics', to: `/console/p/${id}/analytics`, label: t('Analytics', '数据分析') }]} />
);

/** Players online now, refreshed every 15 seconds. */
function LiveNow({ id, first }: { id: string; first: any }) {
  const [now, setNow] = useState(first);
  useEffect(() => { const i = setInterval(() => { void api(`/console/projects/${id}/online`).then(setNow).catch(() => { }); }, 15000); return () => clearInterval(i); }, [id]);
  const roomsPg = useClientPage<any>(now.rooms?.busiest || [], 10, [id]);
  return (
    <Card title={<span className="row">{t('Right now', '此刻')} <Badge tone={now.online.live ? 'good' : 'neutral'}>{t('live', '实时')}</Badge></span>} aside={`${t('updated', '更新于')} ${ago(Date.parse(now.at))}`} pad>
      <StatGrid>
        <Stat tone="accent" label={t('Players online', '在线玩家')} value={num(now.online.live)} sub={count(now.online.live_sessions, 'open session', 'open sessions', '个会话进行中')} />
        <Stat label={t('In multiplayer rooms', '多人房间中')} value={num(now.rooms.players_in_rooms)} sub={count(now.rooms.live, 'room open', 'rooms open', '个房间开放中')} />
        <Stat label={t('On your preview', '预览版在线')} value={num(now.online.preview)} sub={t('you and anyone testing', '你本人及测试者')} />
      </StatGrid>
      {roomsPg.total > 0 && (
        <div style={{ marginTop: 18 }}>
          <Table><thead><tr><th>{t('Room', '房间')}</th><th>{t('Where', '环境')}</th><th className="n">{t('Players', '玩家')}</th><th className="n">{t('Last change', '最近变化')}</th></tr></thead>
            <tbody>{roomsPg.slice.map((r: any) => <tr key={r.env + r.room}><td className="mono">{r.room}</td><td>{r.env === 'live' ? t('Live', '线上') : t('Preview', '预览')}</td><td className="n">{r.players}</td><td className="n">{ago(Date.parse(r.since))}</td></tr>)}</tbody></Table>
          <ListPager compact page={roomsPg.page} total={roomsPg.total} perPage={roomsPg.perPage} onPage={roomsPg.setPage} />
        </div>
      )}
      <p className="dim fs-sm" style={{ marginTop: 14 }}>{t('Online means the page showing the game checked in with the platform in the last minute; the game\'s own heartbeats do not count. Rooms count players connected to GCP.room now.', '在线指显示游戏的页面在最近一分钟内向平台报到过；游戏自己的心跳不计入。房间人数为当前连接到 GCP.room 的玩家。')}</p>
    </Card>
  );
}

const ERR_PER = 15;
function AnalyticsErrors({ id, days, totalReports, kinds }: { id: string; days: string; totalReports: number; kinds: number }) {
  const [page, setPage] = useState(1);
  useEffect(() => { setPage(1); }, [id, days]);
  const { data, error, loading, reload } = useData<{ errors: any[]; total: number; pages: number }>(`/console/projects/${id}/errors?env=live&days=${days}&sort=count&page=${page}&per_page=${ERR_PER}`);
  useEffect(() => { if (data && page > data.pages) setPage(data.pages); }, [data, page]);
  return (
    <Card title={t('Errors players hit', '玩家遇到的错误')} aside={`${count(totalReports, 'report', 'reports', '次报告')} · ${count(kinds, 'kind', 'kinds', '种')}`}>
      {error && !data ? <div className="pad"><Fail error={error} retry={reload} /></div>
        : loading && !data ? <div className="pad mute">{t('Loading…', '加载中…')}</div>
        : data?.errors?.length ? (
          <>
            <Table><thead><tr><th>{t('Message', '信息')}</th><th>{t('Version', '版本')}</th><th className="n">{t('Count', '次数')}</th><th className="n">{t('Last seen', '最近出现')}</th></tr></thead>
              <tbody>{data.errors.map((e: any, i: number) => <tr key={`${page}-${i}`}><td className="mono bad fs-sm" style={{ wordBreak: 'break-word' }}>{e.message}</td><td>v{e.version}</td><td className="n">{e.count}</td><td className="n">{ago(e.last_at)}</td></tr>)}</tbody></Table>
            <ListPager flush page={page} total={data.total} perPage={ERR_PER} onPage={setPage} />
          </>
        ) : <div className="pad mute">{t('No errors reported by players in this window.', '此时间段内玩家没有报告错误。')}</div>}
    </Card>
  );
}

export function Analytics({ id }: { id: string }) {
  const [days, setDays] = useState<'7' | '30' | '90'>('30');
  const { data, error, loading, reload } = useData<any>(`/console/projects/${id}/analytics?days=${days}`);
  const verPg = useClientPage<any>(data?.versions || [], 10, [id, days]);
  const errVerPg = useClientPage<any>(data?.reported_by_game?.versions || [], 10, [id, days]);
  if (error && !data) return <div className="wrap page"><Fail error={error} retry={reload} /></div>;
  if (loading && !data) return <AnalyticsSkeleton />;
  const p = data.project, x = data.totals, daily = data.daily as any[], g = data.reported_by_game;
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
            <Stat label={t('Players', '玩家')} value={num(x.players)} sub={t('{new_players} new · {returning_players} returning', '{new_players} 新玩家 · {returning_players} 回访', { new_players: num(x.new_players), returning_players: num(x.returning_players) })} />
            <Stat label={t('Sessions', '会话')} value={num(x.sessions)} sub={t('{sessions_per_player} per player · {counted_plays} counted plays', '人均 {sessions_per_player} 次 · {counted_plays} 次计入游玩', { sessions_per_player: x.sessions_per_player, counted_plays: num(x.counted_plays) })} />
            <Stat label={t('Time played', '游玩时长')} value={mins(x.minutes_played)} sub={t('{avg_session_minutes} min average · {median_session_minutes} min median', '平均 {avg_session_minutes} 分钟 · 中位 {median_session_minutes} 分钟', { avg_session_minutes: x.avg_session_minutes, median_session_minutes: x.median_session_minutes })} />
            <Stat label={t('Returning players', '回访玩家')} value={pct(x.returning_share)} sub={t('{returning_players} of {players} players', '{players} 位玩家中的 {returning_players} 位', { returning_players: num(x.returning_players), players: num(x.players) })} />
          </StatGrid>
          <p className="dim fs-sm">{t('Sessions, play time and players are measured by the platform: from when a player presses Play, and from the game page checking in every 30 seconds while the game is on screen. Nothing the game reports about itself changes them.', '会话、游玩时长和玩家数由平台自己测量：从玩家点击“开始”起，并由游戏页面在游戏显示期间每 30 秒报到一次。游戏自己上报的内容不会改变这些数字。')}</p>

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
                <Table><thead><tr><th>{t('Version', '版本')}</th><th className="n">{t('Players', '玩家')}</th><th className="n">{t('Sessions', '会话')}</th><th className="n">{t('Avg session', '平均时长')}</th></tr></thead>
                  <tbody>{verPg.slice.map((v: any) => <tr key={v.version}><td className="mono">v{v.version}{v.version === p.live_version && <> <Badge tone="good" dot={false}>{t('Live', '线上')}</Badge></>}</td><td className="n">{num(v.players)}</td><td className="n">{num(v.sessions)}</td><td className="n">{v.avg_minutes} {t('min', '分钟')}</td></tr>)}</tbody></Table>
                <ListPager flush page={verPg.page} total={verPg.total} perPage={verPg.perPage} onPage={verPg.setPage} />
              </Card>
              <Card title={t('Reported by the game', '游戏自己上报的')} aside={t('for finding bugs; not used in any number above', '用于排查问题；不计入上面的任何数字')} pad>
                <div className="stack">
                  <p className="dim fs-sm">{t('These come from the game itself, through its heartbeat, so the platform cannot confirm them: whether it reached GCP.ready, and the errors it caught.', '这些来自游戏本身的心跳，平台无法核实：游戏是否调用了 GCP.ready，以及它捕获到的错误。')}</p>
                  <StatGrid>
                    <Stat tone={g.error_session_share > 5 ? 'accent' : undefined} label={t('Sessions with errors', '出错的会话')} value={pct(g.error_session_share)} sub={count(g.sessions_with_errors, 'session', 'sessions', '个会话')} />
                    <Stat label={t('Never started', '未能启动')} value={num(g.never_started)} sub={t('no GCP.ready before the player left', '玩家离开前未调用 GCP.ready')} />
                  </StatGrid>
                  {g.versions.some((v: any) => v.error_session_share > 0) && (
                    <>
                      <Table><thead><tr><th>{t('Version', '版本')}</th><th className="n">{t('With errors', '出错占比')}</th></tr></thead>
                        <tbody>{errVerPg.slice.map((v: any) => <tr key={v.version}><td className="mono">v{v.version}</td><td className={'n' + (v.error_session_share > 5 ? ' bad' : '')}>{pct(v.error_session_share)}</td></tr>)}</tbody></Table>
                      <ListPager compact page={errVerPg.page} total={errVerPg.total} perPage={errVerPg.perPage} onPage={errVerPg.setPage} />
                    </>
                  )}
                </div>
              </Card>
              <AnalyticsErrors id={id} days={days} totalReports={g.errors.total} kinds={g.errors.kinds} />
            </div>
            <div className="stack l">
              <Card title={t('Returning players', '回访玩家')} pad>
                <Share items={[{ name: t('Returning', '回访'), value: x.returning_players, note: `${num(x.returning_players)} · ${pct(x.returning_share)}` }, { name: t('New', '新玩家'), value: x.new_players, note: num(x.new_players) }]} />
                <p className="dim fs-sm" style={{ marginTop: 12 }}>{t('Returning: played on an earlier day too.', '回访：此前某一天也玩过。')}</p>
              </Card>
              <Card title={t('Session length', '单次时长')} pad>
                <Share items={data.session_lengths.map((b: any) => ({ name: LENGTH[b.label]?.() || b.label, value: b.sessions, note: num(b.sessions) }))} />
              </Card>
              <Card title={t('Devices', '设备')} pad>
                <Share items={data.devices.map((d: any) => ({ name: DEVICE[d.name]?.() || d.name, value: d.sessions, note: `${pct(d.share)} · ${d.avg_minutes} ${t('min', '分钟')}` }))} />
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
