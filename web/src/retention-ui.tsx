// The analytics tab's retention cards (src/analytics.ts): do new players come back, how long their first session lasts,
// how many store visitors become players who stay, and what the game counts with GCP.track.
import { num, t } from './lib';
import { Bars, Card, ChartBlock, Share, Stat, StatGrid, Table } from './ui';

const pct = (v: number | null | undefined) => (v == null ? '–' : `${v}%`);
type Rate = { eligible: number; returned: number; share: number | null };
export interface RetentionData {
  retention: { new_players: number; returned: number; day1: Rate; day7: Rate; day30: Rate; cohorts: { week: string; players: number; day1: number | null; day7: number | null }[] };
  first_session: { players: number; median_minutes: number; quick_quit_share: number; curve: { minute: number; still_playing: number }[] };
  store_funnel: { step: string; count: number }[];
  events: { names: { name: string; count: number; players: number; total: number; average: number }[]; funnel: { step: string; players: number; share: number; from_previous: number }[]; funnel_steps: string[] };
}

const rateSub = (r: Rate) => (r.eligible ? t('{returned} of {eligible} players', '{eligible} 位玩家中的 {returned} 位', { returned: num(r.returned), eligible: num(r.eligible) }) : t('Not enough time has passed yet', '时间还不够长'));

export function RetentionCard({ d }: { d: RetentionData }) {
  const r = d.retention;
  return (
    <Card title={t('Do players come back?', '玩家会回来吗？')} aside={t('players who first played in this window', '在此时间段内首次游玩的玩家')} pad>
      <div className="stack l">
        <StatGrid>
          <Stat label={t('Day 1', '第 1 天')} value={pct(r.day1.share)} sub={rateSub(r.day1)} />
          <Stat label={t('Day 7', '第 7 天')} value={pct(r.day7.share)} sub={rateSub(r.day7)} />
          <Stat label={t('Day 30', '第 30 天')} value={pct(r.day30.share)} sub={rateSub(r.day30)} />
        </StatGrid>
        <p className="dim fs-sm">{t('Day N is the share of new players who started another session N days or more after their first. Only players who first played at least N days ago count.', '第 N 天指新玩家中在首次游玩 N 天或更久之后再次开始游玩的比例。只统计至少 N 天前首次游玩的玩家。')}</p>
        {r.cohorts.length > 0 && (
          <Table><thead><tr><th>{t('Week first played', '首次游玩的周')}</th><th className="n">{t('New players', '新玩家')}</th><th className="n">{t('Day 1', '第 1 天')}</th><th className="n">{t('Day 7', '第 7 天')}</th></tr></thead>
            <tbody>{r.cohorts.slice(0, 8).map((c) => <tr key={c.week}><td className="mono">{c.week}</td><td className="n">{num(c.players)}</td><td className="n">{pct(c.day1)}</td><td className="n">{pct(c.day7)}</td></tr>)}</tbody></Table>
        )}
      </div>
    </Card>
  );
}

export function FirstSessionCard({ d }: { d: RetentionData }) {
  const f = d.first_session;
  if (!f.players) return null;
  return (
    <Card title={t('First session', '首次游玩')} aside={t('new players still playing, by minute', '每分钟仍在玩的新玩家')} pad>
      <div className="stack l">
        <ChartBlock label={t('Still playing', '仍在玩')} value={t('{m} min median', '中位 {m} 分钟', { m: f.median_minutes })}>
          <Bars data={f.curve.map((c) => ({ label: t('minute {m}', '第 {m} 分钟', { m: c.minute }), value: c.still_playing }))} tip={(x) => `${x.label} · ${x.value}%`} height={96} />
        </ChartBlock>
        <p className="dim fs-sm">{t('{share} of new players left within the first minute. A steep drop early often means the start is confusing or slow to load.', '{share} 的新玩家在第一分钟内离开。开头就大幅下降，常常说明开场让人困惑或加载太慢。', { share: pct(f.quick_quit_share) })}</p>
      </div>
    </Card>
  );
}

export function StoreFunnelCard({ d }: { d: RetentionData }) {
  const names: Record<string, string> = {
    store_page_loads: t('Page views', 'Page views'),
    players_started: t('Pressed Play', '点击开始'),
    players_counted: t('Counted plays', '游玩达标'),
    players_returned: t('Came back', '回来了'),
  };
  const top = d.store_funnel[0]?.count || 0;
  return (
    <Card title={t('From store page to regular', '从商店页面到常客')} pad>
      <div className="stack">
        <Share items={d.store_funnel.map((s) => ({ name: names[s.step] || s.step, value: s.count, note: num(s.count) + (top && s !== d.store_funnel[0] ? ` · ${Math.round((s.count / top) * 1000) / 10}%` : '') }))} />
        <p className="dim fs-sm">{t('Store page views are counted from late November 2026 onward. The other steps count signed-in players only.', '商店页面浏览数从 2026 年 11 月下旬起统计。其余步骤只统计已登录玩家。')}</p>
      </div>
    </Card>
  );
}

export function EventsCard({ d }: { d: RetentionData }) {
  const e = d.events;
  return (
    <Card title={t('Game events', '游戏事件')} aside={t('counted with GCP.track', '通过 GCP.track 统计')} pad>
      {!e.names.length ? <p className="mute fs-sm">{t('Call GCP.track("level_complete") in your game to count moments that matter, then list them in gcp.json "funnel" to see where players drop off. Your agent can add this for you.', '在游戏中调用 GCP.track("level_complete") 统计关键时刻，再把它们列入 gcp.json 的 "funnel"，就能看到玩家在哪一步流失。你的智能体可以帮你加上。')}</p> : (
        <div className="stack l">
          {e.funnel.length > 0 && (
            <ChartBlock label={t('Funnel', '漏斗')}>
              <Share items={e.funnel.map((s) => ({ name: <span className="mono">{s.step}</span>, value: s.players, note: `${num(s.players)} · ${pct(s.share)}` }))} />
            </ChartBlock>
          )}
          <Table><thead><tr><th>{t('Event', '事件')}</th><th className="n">{t('Players', '玩家')}</th><th className="n">{t('Times', '次数')}</th><th className="n">{t('Average value', '平均值')}</th></tr></thead>
            <tbody>{e.names.slice(0, 20).map((n) => <tr key={n.name}><td className="mono">{n.name}</td><td className="n">{num(n.players)}</td><td className="n">{num(n.count)}</td><td className="n">{n.total ? n.average : '–'}</td></tr>)}</tbody></Table>
          <p className="dim fs-sm">{t('Reported by the game, from signed-in players of the live game.', '由游戏上报，仅统计线上游戏的已登录玩家。')}</p>
        </div>
      )}
    </Card>
  );
}
