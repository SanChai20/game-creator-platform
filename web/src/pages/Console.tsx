import { useEffect, useState } from 'react';
import { ago, api, artStyle, date, Fail, Link, num, price, Stars, t, usd, useAct, useApp, useData, count } from '../lib';
import { Badge, Button, Card, Code, ListPager, ListRow, Notice, PageHeader, Segmented, Stat, StatGrid, StatusBadge, Tabs } from '../ui';
import { ConsoleSkeleton } from '../skeletons';
import { Skeleton, SkRows } from '../ui/skeleton';
import { ConnectChoice, starterPrompt } from './Creators';
import { LicensePass } from './License';

const PER = 20;
const AGENT_PER = 8;

interface AgentProject { id: string; slug: string | null; title: string | null; status: string }
interface AgentGrant {
  id: string; client: string; scope: string[]; created_at: number; expires_at: number | null;
  project_scope?: 'all' | 'selected'; projects?: AgentProject[] | null;
}

export function ConsoleTabs({ on }: { on: 'games' | 'workbench' | 'earnings' }) {
  return <Tabs active={on} items={[{ key: 'games', to: '/console', label: t('Games', '游戏') }, { key: 'workbench', to: '/console/workbench', label: t('Workbench', '工作台') }, { key: 'earnings', to: '/console/earnings', label: t('Earnings', '收益') }]} />;
}

export function Console() {
  const { user: me } = useApp(), { busy, act } = useAct();
  const { data, error, loading, reload } = useData<any>('/console/overview?projects=0');

  // A creator can have thousands of games: search, filter, sort and paging run on the server.
  const [q, setQ] = useState(''), [debouncedQ, setDebouncedQ] = useState(''), [st, setSt] = useState('all'), [order, setOrder] = useState('updated'), [page, setPage] = useState(1);
  useEffect(() => { const h = setTimeout(() => setDebouncedQ(q.trim()), 200); return () => clearTimeout(h); }, [q]);
  useEffect(() => { setPage(1); }, [debouncedQ, st, order]);

  const projPath = `/console/projects?q=${encodeURIComponent(debouncedQ)}&status=${encodeURIComponent(st)}&sort=${encodeURIComponent(order)}&page=${page}&per_page=${PER}`;
  const proj = useData<{ projects: any[]; total: number; pages: number; counts: { all: number; live: number; draft: number; offline: number } }>(projPath);

  const [agentPage, setAgentPage] = useState(1);
  const agents = useData<{ agents: AgentGrant[]; total: number; pages: number }>(`/console/agents?page=${agentPage}&per_page=${AGENT_PER}`);
  useEffect(() => {
    if (agents.data && agentPage > agents.data.pages) setAgentPage(agents.data.pages);
  }, [agents.data, agentPage]);

  if (error && !data) return <div className="wrap page"><Fail error={error} retry={reload} /></div>;
  if (loading && !data) return <ConsoleSkeleton />;

  const u = data.user;
  const stats = data.stats || { total_games: 0, live_games: 0, total_plays: 0, total_minutes: 0, skills_shared: data.skills_shared || 0 };
  const totalOwned = proj.data?.counts?.all ?? stats.total_games;
  const projects = proj.data?.projects || [];
  const revoke = (id: string) => act('rv' + id, async () => { await api(`/console/agents/${encodeURIComponent(id)}`, { method: 'DELETE' }); await agents.reload(); }, t('Access revoked.', '已撤销访问权限。'));

  return (
    <div className="wrap page">
      <PageHeader eyebrow={t('Console', '控制台')} title={<>{t('Hello', '你好')}, {u.name}</>}
        actions={<LicensePass license={u.license} name={u.name} />} />
      <ConsoleTabs on="games" />

      <div className="stack l">
        {u.creator && !me?.two_factor && (
          <Notice tone="info" title={t('Protect your creator account', '保护你的创作者账户')} actions={<Button to="/account">{t('Turn on two-factor sign-in', '开启两步验证登录')}</Button>}>
            {t('Your games, earnings and connected agents are behind your password. Two-factor sign-in adds a code from your phone.', '你的游戏、收益和已连接的智能体目前只受密码保护。两步验证登录会再增加一个手机验证码。')}
          </Notice>
        )}

        <StatGrid>
          <Stat label={t('Games', '游戏')} value={stats.total_games} sub={`${stats.live_games} ${t('live', '款已上线')}`} />
          <Stat label={t('Plays', '游玩次数')} value={num(stats.total_plays)} sub={`${num(stats.total_minutes)} ${t('minutes played', '分钟游玩时长')}`} />
          <Stat label={t('Game sales', '游戏销量')} value={num(data.sales.n)} sub={`${usd(data.sales.net)} ${t('earned', '累计收益')}`} />
          <Stat to="/creator-store" label={t('Skill sales', '技能销量')} value={num(data.skill_sales?.n || 0)} sub={<>{usd(data.skill_sales?.net || 0)} {t('earned', '累计收益')} · {t('Creator Store', '创作者商店')} →</>} />
          <Stat tone="accent" to="/console/earnings" label={t('Available', '可提现')} value={usd(data.balance.available)} sub={<>{data.balance.pending > 0 ? `${usd(data.balance.pending)} ${t('pending', '待结算')}` : t('Open earnings', '查看收益')} →</>} />
        </StatGrid>

        <div className="cols">
          <div className="stack l">
            <Card title={t('Your games', '你的游戏')} aside={t('Created and updated by your agent · web games only', '由你的智能体创建和更新 · 仅支持网页游戏')}>
              {totalOwned > 6 && (
                <div className="list-tools">
                  <input className="input" type="search" placeholder={t('Search {n} games', '搜索 {n} 款游戏', { n: totalOwned })} value={q} onChange={(e) => setQ(e.target.value)} aria-label={t('Search your games', '搜索你的游戏')} />
                  <Segmented label={t('Status', '状态')} value={st} onChange={setSt} options={[['all', t('All', '全部')], ['live', t('Live', '已上线')], ['draft', t('Draft', '草稿')], ['offline', t('Offline', '已下线')]]} />
                  <select className="input" value={order} onChange={(e) => setOrder(e.target.value)} aria-label={t('Sort', '排序')}><option value="updated">{t('Recently updated', '最近更新')}</option><option value="plays">{t('Most played', '最多游玩')}</option><option value="title">{t('Title A–Z', '标题 A–Z')}</option></select>
                </div>
              )}
              {proj.error && !proj.data && <div className="pad"><Fail error={proj.error} retry={proj.reload} /></div>}
              {proj.loading && !proj.data ? <Skeleton><SkRows n={4} /></Skeleton> : null}
              {proj.data && totalOwned > 0 && !projects.length && <div className="pad mute">{t('No game matches that.', '没有符合条件的游戏。')}</div>}
              {projects.map((p) => (
                <ListRow key={p.id} to={`/console/p/${p.id}`}
                  media={<div className="thumb" style={p.cover ? undefined : artStyle(p.slug)}>{p.cover && <img src={p.cover} alt="" loading="lazy" />}</div>}
                  title={<><b className="clip">{p.title}</b><StatusBadge status={p.status} /></>}
                  meta={<>{p.live_version ? `${t('live', '线上')} v${p.live_version}` : t('not published', '未发布')}{p.preview_version ? ` · ${t('preview', '预览')} v${p.preview_version}` : ''} · {t('updated', '更新于')} {ago(p.updated_at)}</>}
                  tail={<><span>{price(p.price_cents)}</span><span>{count(p.plays, 'play', 'plays', '次游玩')}</span><Stars rating={p.rating} /></>} />
              ))}
              {proj.data && <ListPager flush page={page} total={proj.data.total} perPage={PER} onPage={setPage} />}
              {proj.data && totalOwned === 0 && (
                <div className="pad stack"><b>{t('No games yet', '还没有游戏')}</b><p className="mute">{t('Games are made by your agent, not in this console. Connect it, then ask for a game. The platform hosts web games only: games that run in a browser page, not native, mobile, console or desktop builds.', '游戏由你的智能体创作，而不是在控制台里手动创建。先连接智能体，再让它为你做一款游戏。平台仅托管网页游戏，即在浏览器页面中运行的游戏，不接受原生、移动端、主机或桌面端构建。')}</p><Code text={starterPrompt()} /></div>
              )}
            </Card>
          </div>

          <div className="stack l">
            <Card title={t('Creator Store', '创作者商店')} pad>
              <div className="stack">
                <p className="mute fs-sm">{stats.skills_shared
                  ? t('{n} of your live games share their build skill. Your agent keeps each one in step with every release.', '你有 {n} 款线上游戏分享了构建技能。智能体会在每次发布时同步更新。', { n: stats.skills_shared })
                  : t('Share how your games are built as agent skills, free or for a price. A free skill lowers your game\'s platform cut.', '以智能体技能的形式分享游戏的制作方式，可免费或定价。免费技能会降低游戏的平台抽成。')}</p>
                <div className="row wrapx"><Button size="sm" variant="primary" to="/creator-store">{t('Open the Creator Store', '打开创作者商店')}</Button><Button size="sm" to="/console/earnings">{t('Skill sales', '技能销量')}</Button></div>
              </div>
            </Card>
            <div id="connect"><Card title={t('Work with your agent', '与你的智能体协作')} pad><ConnectChoice /></Card></div>
            <Card title={t('Connected agents', '已连接的智能体')} aside={agents.data && agents.data.total > 0 ? num(agents.data.total) : undefined}>
              {agents.data?.agents.length ? agents.data.agents.map((a) => {
                const scoped = a.project_scope === 'selected';
                const list = a.projects || [];
                return (
                  <ListRow key={a.id}
                    title={<>
                      <b className="clip">{a.client}</b>
                      {scoped
                        ? <Badge tone="info">{list.length === 1 ? t('1 project', '1 个项目') : t('{n} projects', '{n} 个项目', { n: list.length })}</Badge>
                        : <Badge tone="neutral" dot={false}>{t('All projects', '所有项目')}</Badge>}
                    </>}
                    meta={<>
                      <div>{t('connected', '连接于')} {date(a.created_at)}{a.expires_at ? ` · ${t('expires', '到期')} ${date(a.expires_at)}` : ''}</div>
                      {scoped && list.length > 0 && (
                        <div className="scope-tags">
                          {list.slice(0, 5).map((p) => (
                            p.title && p.status !== 'removed'
                              ? <Link key={p.id} to={`/console/p/${p.id}`} className="scope-tag">{p.title}</Link>
                              : <span key={p.id} className="scope-tag">{p.title || t('Removed project', '已移除项目')}</span>
                          ))}
                          {list.length > 5 && <span className="scope-tag">+{list.length - 5}</span>}
                        </div>
                      )}
                    </>}
                    tail={<Button size="sm" variant="danger" onClick={() => revoke(a.id)} disabled={busy === 'rv' + a.id}>{t('Revoke', '撤销')}</Button>} />
                );
              }) : agents.loading ? <Skeleton><SkRows n={2} thumb={false} /></Skeleton> : <div className="pad mute">{t('No agent has access to your account.', '目前没有智能体可以访问你的账户。')}</div>}
              {agents.data && <ListPager flush compact page={agentPage} total={agents.data.total} perPage={AGENT_PER} onPage={setAgentPage} />}
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
}
