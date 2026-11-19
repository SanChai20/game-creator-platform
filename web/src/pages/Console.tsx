import { useEffect, useMemo, useState } from 'react';
import { ago, api, artStyle, date, Fail, GameTile, num, price, Stars, t, usd, useAct, useData, count } from '../lib';
import { Button, Card, Code, ListRow, PageHeader, Section, Segmented, Stat, StatGrid, StatusBadge, Tabs } from '../ui';
import { ConsoleSkeleton } from '../skeletons';
import { Skeleton, SkRows } from '../ui/skeleton';
import { ConnectAgent, starterPrompt } from './Creators';
import { LicensePass } from './License';
import { Pager } from '../store';

const PER = 20;

export function ConsoleTabs({ on }: { on: 'games' | 'earnings' }) {
  return <Tabs active={on} items={[{ key: 'games', to: '/console', label: t('Games', '游戏') }, { key: 'earnings', to: '/console/earnings', label: t('Earnings', '收益') }]} />;
}

export function Console() {
  const { busy, act } = useAct();
  const { data, error, loading, reload } = useData<any>('/console/overview');
  const agents = useData<{ agents: any[] }>('/console/agents');

  // A creator can have thousands of games: the list is searchable, filterable and paged.
  const [q, setQ] = useState(''), [st, setSt] = useState('all'), [order, setOrder] = useState('updated'), [page, setPage] = useState(1);
  const all = (data?.projects || []) as any[];
  const shown = useMemo(() => {
    const s2 = q.trim().toLowerCase();
    return all.filter((p) => (st === 'all' || p.status === st) && (!s2 || p.title.toLowerCase().includes(s2) || p.slug.includes(s2)))
      .sort((a, b) => order === 'plays' ? b.plays - a.plays : order === 'title' ? a.title.localeCompare(b.title) : b.updated_at - a.updated_at);
  }, [all, q, st, order]);
  useEffect(() => { setPage(1); }, [q, st, order]);
  if (error && !data) return <div className="wrap page"><Fail error={error} retry={reload} /></div>;
  if (loading && !data) return <ConsoleSkeleton />;
  const u = data.user, projects = all, pages = Math.max(1, Math.ceil(shown.length / PER)), slice = shown.slice((page - 1) * PER, page * PER);
  const revoke = (id: string) => act('rv' + id, async () => { await api(`/console/agents/${encodeURIComponent(id)}`, { method: 'DELETE' }); await agents.reload(); }, t('Access revoked.', '已撤销访问权限。'));

  return (
    <div className="wrap page">
      <PageHeader eyebrow={t('Console', '控制台')} title={<>{t('Hello', '你好')}, {u.name}</>}
        actions={<LicensePass license={u.license} name={u.name} />} />
      <ConsoleTabs on="games" />

      <div className="stack l">
        <StatGrid>
          <Stat label={t('Games', '游戏')} value={projects.length} sub={`${projects.filter((p) => p.status === 'live').length} ${t('live', '款已上线')}`} />
          <Stat label={t('Plays', '游玩次数')} value={num(projects.reduce((a, p) => a + p.plays, 0))} sub={`${num(projects.reduce((a, p) => a + p.minutes, 0))} ${t('minutes played', '分钟游玩时长')}`} />
          <Stat label={t('Sales', '销量')} value={num(data.sales.n)} sub={`${usd(data.sales.net)} ${t('earned', '累计收益')}`} />
          <Stat tone="accent" to="/console/earnings" label={t('Available', '可提现')} value={usd(data.balance.available)} sub={<>{data.balance.pending > 0 ? `${usd(data.balance.pending)} ${t('pending', '待结算')}` : t('Open earnings', '查看收益')} →</>} />
        </StatGrid>

        <div className="cols">
          <div className="stack l">
            <Card title={t('Your games', '你的游戏')} aside={t('Created and updated by your agent · web games only', '由你的智能体创建和更新 · 仅支持网页游戏')}>
              {projects.length > 6 && (
                <div className="list-tools">
                  <input className="input" type="search" placeholder={t('Search {n} games', '搜索 {n} 款游戏', { n: projects.length })} value={q} onChange={(e) => setQ(e.target.value)} aria-label={t('Search your games', '搜索你的游戏')} />
                  <Segmented label={t('Status', '状态')} value={st} onChange={setSt} options={[['all', t('All', '全部')], ['live', t('Live', '已上线')], ['draft', t('Draft', '草稿')], ['offline', t('Offline', '已下线')]]} />
                  <select className="input" value={order} onChange={(e) => setOrder(e.target.value)} aria-label={t('Sort', '排序')}><option value="updated">{t('Recently updated', '最近更新')}</option><option value="plays">{t('Most played', '最多游玩')}</option><option value="title">{t('Title A–Z', '标题 A–Z')}</option></select>
                </div>
              )}
              {projects.length > 6 && !shown.length && <div className="pad mute">{t('No game matches that.', '没有符合条件的游戏。')}</div>}
              {projects.length ? slice.map((p) => (
                <ListRow key={p.id} to={`/console/p/${p.id}`}
                  media={<div className="thumb" style={p.cover ? undefined : artStyle(p.slug)}>{p.cover && <img src={p.cover} alt="" loading="lazy" />}</div>}
                  title={<><b className="clip">{p.title}</b><StatusBadge status={p.status} /></>}
                  meta={<>{p.live_version ? `${t('live', '线上')} v${p.live_version}` : t('not published', '未发布')}{p.preview_version ? ` · ${t('preview', '预览')} v${p.preview_version}` : ''} · {t('updated', '更新于')} {ago(p.updated_at)}</>}
                  tail={<><span>{price(p.price_cents)}</span><span>{count(p.plays, 'play', 'plays', '次游玩')}</span><Stars rating={p.rating} /></>} />
              )) : null}
              {pages > 1 && <div className="list-foot"><span className="dim fs-sm">{t('{from}–{to} of {total}', '第 {from}–{to} 款，共 {total} 款', { from: (page - 1) * PER + 1, to: Math.min(shown.length, page * PER), total: shown.length })}</span><Pager page={page} pages={pages} onPage={setPage} /></div>}
              {!projects.length && (
                <div className="pad stack"><b>{t('No games yet', '还没有游戏')}</b><p className="mute">{t('Games are made by your agent, not in this console. Connect it, then ask for a game. The platform hosts web games only: games that run in a browser page, not native, mobile, console or desktop builds.', '游戏由你的智能体创作，而不是在控制台里手动创建。先连接智能体，再让它为你做一款游戏。平台仅托管网页游戏，即在浏览器页面中运行的游戏，不接受原生、移动端、主机或桌面端构建。')}</p><Code text={starterPrompt()} /></div>
              )}
            </Card>
            {!!data.library.length && <Section title={t('Games you bought', '已购游戏')}><div className="grid" style={{ paddingTop: 0 }}>{data.library.map((g: any) => <GameTile key={g.id} g={g} />)}</div></Section>}
          </div>

          <div className="stack l">
            <Card title={t('Connect your agent', '连接你的智能体')} pad><ConnectAgent /></Card>
            <Card title={t('Connected agents', '已连接的智能体')}>
              {agents.data?.agents.length ? agents.data.agents.map((a) => (
                <ListRow key={a.id} title={<b className="clip">{a.client}</b>}
                  meta={<>{t('connected', '连接于')} {date(a.created_at)}{a.expires_at ? ` · ${t('expires', '到期')} ${date(a.expires_at)}` : ''}</>}
                  tail={<Button size="sm" variant="danger" onClick={() => revoke(a.id)} disabled={busy === 'rv' + a.id}>{t('Revoke', '撤销')}</Button>} />
              )) : agents.loading ? <Skeleton><SkRows n={2} thumb={false} /></Skeleton> : <div className="pad mute">{t('No agent has access to your account.', '目前没有智能体可以访问你的账户。')}</div>}
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
}
