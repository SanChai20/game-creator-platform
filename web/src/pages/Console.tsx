import { useEffect } from 'react';
import { ago, api, artStyle, Code, date, Fail, GameTile, Link, navigate, num, price, query, Spinner, Stars, StatusBadge, t, usd, useAct, useApp, useData, count } from '../lib';
import { ConnectAgent, starterPrompt } from './Creators';

export function ConsoleTabs({ on }: { on: 'games' | 'earnings' }) {
  return <div className="tabs"><Link to="/console" className={on === 'games' ? 'on' : ''}>{t('Games', '游戏')}</Link><Link to="/console/earnings" className={on === 'earnings' ? 'on' : ''}>{t('Earnings', '收益')}</Link></div>;
}

export function Console() {
  const { config, refresh, toast } = useApp(), { busy, act } = useAct(), s = config.settings;
  const { data, error, loading, reload } = useData<any>('/console/overview');
  const agents = useData<{ agents: any[] }>('/console/agents');

  useEffect(() => {
    const paid = query().get('paid'); if (!paid) return;
    navigate('/console', true);
    api('/billing/confirm', { body: { session_id: paid } }).then(async () => { toast(t('Creator license active. You can publish now.', '创作者许可已生效，现在可以发布了。')); await refresh(); await reload(); }, (e) => toast((e as Error).message, true));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (error && !data) return <div className="wrap page"><Fail error={error} retry={reload} /></div>;
  if (loading && !data) return <Spinner />;
  const u = data.user, projects = data.projects as any[];
  const buyLicense = () => act('fee', async () => { const r = await api<{ url?: string }>('/billing/creator-fee', { method: 'POST' }); if (r.url) location.href = r.url; else { await refresh(); await reload(); } });
  const revoke = (id: string) => act('rv' + id, async () => { await api(`/console/agents/${encodeURIComponent(id)}`, { method: 'DELETE' }); await agents.reload(); }, t('Access revoked.', '已撤销访问权限。'));
  const needsFee = !u.creator && s.creator_fee_required;

  return (
    <div className="wrap page">
      <div className="page-h"><div className="stack"><span className="eyebrow">{t('Console', '控制台')}</span><h1>{t('Hello', '你好')}, {u.name}</h1></div>
        <span className="right">{u.creator ? <span className="badge good">{t('Creator license', '创作者许可')}</span> : <span className="badge">{t('No creator license', '未获得创作者许可')}</span>}</span></div>
      <ConsoleTabs on="games" />

      <div className="stack l">
        {needsFee && (
          <div className="notice row wrapx">
            <div className="grow"><b>{t('Publishing needs a creator license', '发布需要创作者许可')}</b><div className="mute">{t(`Build and preview for free. Pay ${usd(data.fee_cents)} once to publish as many games as you like.`, `创作与预览免费。一次性支付 ${usd(data.fee_cents)}，即可发布任意数量的游戏。`)}</div></div>
            <button className="btn pri" onClick={buyLicense} disabled={busy === 'fee' || (data.fee_cents > 0 && !config.payments)}>{data.fee_cents > 0 ? `${t('Get the license', '获取许可')} · ${usd(data.fee_cents)}` : t('Activate', '激活')}</button>
            {data.fee_cents > 0 && !config.payments && <span className="dim" style={{ fontSize: 13, flexBasis: '100%' }}>{t('Payments are not set up on this platform yet.', '平台尚未开通支付。')}</span>}
          </div>
        )}

        <div className="stats">
          <div className="stat"><span className="eyebrow">{t('Games', '游戏')}</span><b>{projects.length}</b><small>{projects.filter((p) => p.status === 'live').length} {t('live', '款已上线')}</small></div>
          <div className="stat"><span className="eyebrow">{t('Plays', '游玩次数')}</span><b>{num(projects.reduce((a, p) => a + p.plays, 0))}</b><small>{num(projects.reduce((a, p) => a + p.minutes, 0))} {t('minutes played', '分钟游玩时长')}</small></div>
          <div className="stat"><span className="eyebrow">{t('Sales', '销量')}</span><b>{num(data.sales.n)}</b><small>{usd(data.sales.net)} {t('earned', '累计收益')}</small></div>
          <Link to="/console/earnings" className="stat"><span className="eyebrow sig">{t('Available', '可提现')}</span><b>{usd(data.balance.available)}</b><small>{data.balance.pending > 0 ? `${usd(data.balance.pending)} ${t('pending', '待结算')}` : t('Open earnings', '查看收益')} →</small></Link>
        </div>

        <div className="cols">
          <div className="stack l">
            <div className="card">
              <header><h3>{t('Your games', '你的游戏')}</h3><span className="dim right" style={{ fontSize: 13 }}>{t('Created and updated by your agent', '由你的智能体创建和更新')}</span></header>
              {projects.length ? projects.map((p) => (
                <Link to={`/console/p/${p.id}`} className="proj" key={p.id}>
                  <div className="thumb" style={p.cover ? undefined : artStyle(p.slug)}>{p.cover && <img src={p.cover} alt="" loading="lazy" />}</div>
                  <div style={{ minWidth: 0 }}><div className="row"><b className="clip">{p.title}</b><StatusBadge status={p.status} /></div>
                    <div className="mute clip" style={{ fontSize: 13, marginTop: 4 }}>{p.live_version ? `${t('live', '线上')} v${p.live_version}` : t('not published', '未发布')}{p.preview_version ? ` · ${t('preview', '预览')} v${p.preview_version}` : ''} · {t('updated', '更新于')} {ago(p.updated_at)}</div></div>
                  <div className="row tail mute num" style={{ fontSize: 13 }}><span>{price(p.price_cents)}</span><span>{count(p.plays, 'play', 'plays', '次游玩')}</span><Stars rating={p.rating} /></div>
                </Link>
              )) : (
                <div className="pad stack"><b>{t('No games yet', '还没有游戏')}</b><p className="mute">{t('Games are made by your agent, not in this console. Connect it, then ask for a game.', '游戏由你的智能体创作，而不是在控制台里手动创建。先连接智能体，再让它为你做一款游戏。')}</p><Code text={starterPrompt()} /></div>
              )}
            </div>
            {!!data.library.length && <div><div className="section-h" style={{ marginTop: 8 }}><h2 style={{ fontSize: 20 }}>{t('Games you bought', '已购游戏')}</h2></div><div className="grid" style={{ paddingBottom: 0 }}>{data.library.map((g: any) => <GameTile key={g.id} g={g} />)}</div></div>}
          </div>

          <div className="stack l">
            <div className="card"><header><h3>{t('Connect your agent', '连接你的智能体')}</h3></header><div className="pad"><ConnectAgent /></div></div>
            <div className="card">
              <header><h3>{t('Connected agents', '已连接的智能体')}</h3></header>
              {agents.data?.agents.length ? agents.data.agents.map((a) => (
                <div className="proj" style={{ gridTemplateColumns: 'minmax(0,1fr) auto' }} key={a.id}>
                  <div style={{ minWidth: 0 }}><b className="clip">{a.client}</b><div className="mute" style={{ fontSize: 13 }}>{t('connected', '连接于')} {date(a.created_at)}{a.expires_at ? ` · ${t('expires', '到期')} ${date(a.expires_at)}` : ''}</div></div>
                  <button className="btn sm danger" onClick={() => revoke(a.id)} disabled={busy === 'rv' + a.id}>{t('Revoke', '撤销')}</button>
                </div>
              )) : <div className="pad mute">{agents.loading ? t('Loading…', '加载中…') : t('No agent has access to your account.', '目前没有智能体可以访问你的账户。')}</div>}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
