import { useEffect, useMemo, useState } from 'react';
import { ago, api, date, dateTime, Fail, Link, num, playTime, series, t, usd, useAct, useApp, useData, count } from '../lib';
import { Badge, Bars, Button, Card, ChartBlock, CheckRow, Input, PageHeader, SearchInput, Spinner, Stat, StatGrid, StatusBadge, Switch, Table, Tabs } from '../ui';

const tabs = (): [string, string][] => [['overview', t('Overview', '概览')], ['settings', t('Settings', '参数设置')], ['users', t('Users', '用户')], ['games', t('Games', '游戏')], ['money', t('Money', '资金')]];

export function Admin({ tab }: { tab: string }) {
  return (
    <div className="wrap page">
      <PageHeader eyebrow={t('Admin', '管理后台')} title={tabs().find(([k]) => k === tab)?.[1] || t('Admin', '管理后台')} />
      <Tabs active={tab} items={tabs().map(([k, label]) => ({ key: k, to: k === 'overview' ? '/admin' : `/admin/${k}`, label }))} />
      {tab === 'overview' ? <Overview /> : tab === 'settings' ? <Settings /> : tab === 'users' ? <Users /> : tab === 'games' ? <Games /> : tab === 'money' ? <Money /> : null}
    </div>
  );
}

function Overview() {
  const { data, error, loading, reload } = useData<any>('/admin/overview');
  if (error && !data) return <Fail error={error} retry={reload} />;
  if (loading && !data) return <Spinner />;
  const h = data.health, items: [string, boolean, string][] = [
    [t('Game deployment', '游戏部署'), h.deploy, h.deploy ? `${t('driver', '驱动')}: ${h.driver}` : t('CF_API_TOKEN and CF_ACCOUNT_ID are not set', '未设置 CF_API_TOKEN 与 CF_ACCOUNT_ID')],
    [t('Browser verification', '浏览器验证'), h.browser, h.browser ? t('ready', '就绪') : t('no browser binding', '缺少浏览器绑定')],
    [t('Payments (Stripe)', '支付（Stripe）'), h.payments, h.payments ? t('ready', '就绪') : t('STRIPE_SECRET_KEY is not set: the creator fee, game sales and Stripe payouts are off', '未设置 STRIPE_SECRET_KEY：创作者费用、游戏销售与 Stripe 提现均不可用')],
    [t('Stripe webhook', 'Stripe Webhook'), h.webhook, h.webhook ? t('ready', '就绪') : t('STRIPE_WEBHOOK_SECRET is not set: refunds and delayed payments will not sync', '未设置 STRIPE_WEBHOOK_SECRET：退款与延迟到账的支付无法同步')],
  ];
  return (
    <div className="stack l">
      <StatGrid>
        <Stat label={t('Users', '用户')} value={num(data.users.n)} sub={<>+{num(data.users.new30 || 0)} {t('in 30 days', '近 30 天')} · {num(data.users.creators || 0)} {t('creators', '位创作者')}</>} />
        <Stat label={t('Games live', '在线游戏')} value={num(data.games.live || 0)} sub={<>{num(data.games.paid || 0)} {t('paid', '款付费')} · {num(data.games.draft || 0)} {t('drafts', '款草稿')} · {num(data.games.offline || 0)} {t('offline', '款下线')}</>} />
        <Stat label={t('Plays, 30 days', '近 30 天游玩')} value={num(data.plays.plays)} sub={<>{playTime(data.plays.seconds)} · {count(data.plays.sessions, 'session', 'sessions', '次会话')}</>} />
        <Stat tone="accent" label={t('Platform revenue', '平台收入')} value={usd(data.sales.fees + data.creator_fees.total)} sub={<>{usd(data.sales.fees)} {t('from sales', '来自销售分成')} · {usd(data.creator_fees.total)} {t('creator fees', '创作者费用')}</>} />
        <Stat label={t('Game sales', '游戏销售额')} value={usd(data.sales.gross)} sub={<>{count(data.sales.n, 'sale', 'sales', '笔')} · {usd(data.sales.gross30)} {t('in 30 days', '近 30 天')}</>} />
        <Stat label={t('Owed to creators', '应付创作者')} value={usd(data.owed_cents)} sub={<>{data.pending_withdrawals.n} {t('withdrawals waiting', '笔提现待处理')} · {usd(data.pending_withdrawals.c)}</>} />
      </StatGrid>
      <div className="cols">
        <Card title={t('Last 30 days', '近 30 天')} pad><div className="stack l">
          <ChartBlock label={t('Plays per day', '每日游玩次数')}><Bars data={series<any>(data.daily, 30, (r) => r.plays)} tip={(d) => `${d.label} · ${d.value}`} /></ChartBlock>
          <ChartBlock label={t('Sign-ups per day', '每日注册')}><Bars data={series<any>(data.signups, 30, (r) => r.n)} tip={(d) => `${d.label} · ${d.value}`} /></ChartBlock>
          <ChartBlock label={t('Sales per day (USD)', '每日销售额（美元）')}><Bars data={series<any>(data.sales_daily, 30, (r) => r.gross / 100)} tip={(d) => `${d.label} · $${d.value.toFixed(2)}`} /></ChartBlock>
        </div></Card>
        <Card title={t('System', '系统状态')} pad><div>{items.map(([label, ok, detail]) => <CheckRow key={label} ok={ok} title={label} detail={detail} />)}</div></Card>
      </div>
    </div>
  );
}

function Settings() {
  const { refresh } = useApp(), { busy, act } = useAct();
  const { data, error, loading, reload } = useData<{ defs: Record<string, any>; values: Record<string, any> }>('/admin/settings');
  const [draft, setDraft] = useState<Record<string, string | boolean>>({});
  useEffect(() => { setDraft({}); }, [data]);
  const groups = useMemo(() => { const g = new Map<string, string[]>(); for (const [k, d] of Object.entries(data?.defs || {})) g.set(d.group, [...(g.get(d.group) || []), k]); return [...g.entries()]; }, [data]);
  if (error && !data) return <Fail error={error} retry={reload} />;
  if (loading && !data) return <Spinner />;
  const show = (k: string) => { const d = data!.defs[k], v = data!.values[k]; return k in draft ? draft[k] : d.type === 'cents' ? (v / 100).toFixed(2) : d.type === 'bool' ? !!v : String(v); };
  const dirty = Object.keys(draft).length;
  const save = () => act('save', async () => {
    const out: Record<string, unknown> = {};
    for (const [k, raw] of Object.entries(draft)) {
      const d = data!.defs[k];
      if (d.type === 'bool' || d.type === 'text') out[k] = raw;
      else { const n = Number(raw); if (!Number.isFinite(n)) throw new Error(`${d.label}: ${t('enter a number', '请输入数字')}`); out[k] = d.type === 'cents' ? Math.round(n * 100) : d.type === 'int' ? Math.round(n) : n; }
    }
    await api('/admin/settings', { method: 'PUT', body: out }); await reload(); await refresh();
  }, t('Settings saved.', '设置已保存。'));
  return (
    <div className="stack l" style={{ maxWidth: 900 }}>
      {groups.map(([group, keys]) => (
        <Card key={group} title={group}>
          {keys.map((k) => { const d = data!.defs[k], v = show(k), changed = k in draft; return (
            <label className="set-row" key={k}>
              <div><b>{d.label}</b><div className="dim mono fs-xs">{k}{changed && <span className="sig"> · {t('changed', '已修改')}</span>}</div></div>
              {d.type === 'bool' ? <Switch checked={v as boolean} onChange={(e) => setDraft({ ...draft, [k]: e.target.checked })} />
                : <div className="row">{d.type === 'cents' && <span className="mute">$</span>}<Input mono={d.type !== 'text'} inputMode={d.type === 'text' ? 'text' : 'decimal'} value={v as string} onChange={(e) => setDraft({ ...draft, [k]: e.target.value })} /></div>}
            </label>); })}
        </Card>
      ))}
      {dirty > 0 && <div className="savebar"><span className="grow"><b className="sig">{dirty}</b> {t('unsaved changes', '项未保存的修改')}</span><Button variant="ghost" onClick={() => setDraft({})}>{t('Discard', '放弃')}</Button><Button variant="primary" onClick={save} disabled={busy === 'save'}>{t('Save changes', '保存修改')}</Button></div>}
    </div>
  );
}

function useSearch(base: string) {
  const [q, setQ] = useState(''), [applied, setApplied] = useState('');
  useEffect(() => { const i = setTimeout(() => setApplied(q), 300); return () => clearTimeout(i); }, [q]);
  return { q, setQ, ...useData<any>(`${base}?q=${encodeURIComponent(applied)}`) };
}

function Users() {
  const { user: me } = useApp(), { busy, act } = useAct(), { q, setQ, data, error, loading, reload } = useSearch('/admin/users');
  const patch = (id: string, body: Record<string, unknown>, msg: string) => act(id, async () => { await api(`/admin/users/${id}`, { method: 'PATCH', body }); await reload(); }, msg);
  const adjust = (u: any) => {
    const raw = prompt(t(`Adjust the balance of ${u.email} by how many dollars? Use a minus sign to deduct.`, `将 ${u.email} 的余额调整多少美元？扣减请加负号。`)); if (!raw) return;
    const n = Math.round(parseFloat(raw) * 100); if (!Number.isFinite(n) || n === 0) return;
    void patch(u.id, { adjust_cents: n, note: prompt(t('Note shown to the user', '向用户显示的备注')) || undefined }, t('Balance adjusted.', '余额已调整。'));
  };
  return (
    <div className="stack l">
      <div className="admin-tools"><SearchInput placeholder={t('Search by email or name', '按邮箱或名称搜索')} value={q} onChange={(e) => setQ(e.target.value)} /></div>
      {error && !data ? <Fail error={error} retry={reload} /> : loading && !data ? <Spinner /> : (
        <Card><Table>
          <thead><tr><th>{t('User', '用户')}</th><th>{t('Status', '状态')}</th><th className="n">{t('Games', '游戏')}</th><th className="n">{t('Balance', '余额')}</th><th className="n">{t('Bought', '已购')}</th><th className="n">{t('Played', '游玩')}</th><th>{t('Joined', '注册')}</th><th>{t('Seen', '最近活跃')}</th><th /></tr></thead>
          <tbody>{data.users.map((u: any) => (
            <tr key={u.id}>
              <td><b>{u.name}</b><div className="mute fs-sm">{u.email}</div></td>
              <td><div className="row wrapx" style={{ gap: 6 }}><StatusBadge status={u.status} />{u.role === 'admin' && <Badge tone="accent" dot={false}>admin</Badge>}{!!u.creator && <Badge dot={false}>{t('creator', '创作者')}</Badge>}{!!u.stripe_payouts_enabled && <Badge dot={false}>{t('payouts', '可收款')} {u.payout_country}</Badge>}</div></td>
              <td className="n">{u.live}/{u.projects}</td><td className="n">{usd(u.balance)}</td><td className="n">{u.bought}</td><td className="n">{playTime(u.played)}</td>
              <td className="mute">{date(u.created_at)}</td><td className="mute">{ago(u.last_seen_at)}</td>
              <td><div className="row-actions">
                <Button size="sm" disabled={busy === u.id} onClick={() => patch(u.id, { creator: !u.creator }, t('Updated.', '已更新。'))}>{u.creator ? t('Remove license', '取消许可') : t('Grant license', '授予许可')}</Button>
                <Button size="sm" disabled={busy === u.id} onClick={() => adjust(u)}>{t('Adjust', '调整余额')}</Button>
                {u.id !== me!.id && <Button size="sm" disabled={busy === u.id} onClick={() => patch(u.id, { role: u.role === 'admin' ? 'user' : 'admin' }, t('Updated.', '已更新。'))}>{u.role === 'admin' ? t('Remove admin', '取消管理员') : t('Make admin', '设为管理员')}</Button>}
                {u.id !== me!.id && <Button size="sm" variant="danger" disabled={busy === u.id} onClick={() => patch(u.id, { status: u.status === 'active' ? 'suspended' : 'active' }, t('Updated.', '已更新。'))}>{u.status === 'active' ? t('Suspend', '停用') : t('Restore', '恢复')}</Button>}
              </div></td>
            </tr>))}</tbody>
        </Table>{!data.users.length && <div className="pad mute">{t('No users match.', '没有匹配的用户。')}</div>}</Card>
      )}
    </div>
  );
}

function Games() {
  const { busy, act } = useAct(), { q, setQ, data, error, loading, reload } = useSearch('/admin/games');
  const patch = (id: string, body: Record<string, unknown>, msg: string) => act(id, async () => { await api(`/admin/games/${id}`, { method: 'PATCH', body }); await reload(); }, msg);
  const remove = (g: any) => { const reason = prompt(t(`Remove "${g.title}" from the platform? Give the reason shown to its creator.`, `确定将《${g.title}》从平台移除吗？请填写向创作者显示的原因。`)); if (reason !== null) void patch(g.id, { action: 'remove', reason }, t('Game removed.', '游戏已移除。')); };
  return (
    <div className="stack l">
      <div className="admin-tools"><SearchInput placeholder={t('Search by title, address or creator email', '按标题、地址或创作者邮箱搜索')} value={q} onChange={(e) => setQ(e.target.value)} /></div>
      {error && !data ? <Fail error={error} retry={reload} /> : loading && !data ? <Spinner /> : (
        <Card><Table>
          <thead><tr><th>{t('Game', '游戏')}</th><th>{t('Status', '状态')}</th><th className="n">{t('Price', '价格')}</th><th className="n">{t('Plays', '游玩')}</th><th className="n">{t('7 days', '近 7 天')}</th><th className="n">{t('Time', '时长')}</th><th className="n">{t('Rating', '评分')}</th><th className="n">{t('Sales', '销量')}</th><th className="n">{t('Fees', '平台分成')}</th><th className="n">{t('Errors', '错误')}</th><th /></tr></thead>
          <tbody>{data.games.map((g: any) => (
            <tr key={g.id}>
              <td>{g.status === 'live' ? <Link to={`/g/${g.slug}`}><b>{g.title}</b></Link> : <b>{g.title}</b>}<div className="mute fs-sm">{g.author} · {g.author_email}</div>{g.removed_reason && <div className="bad fs-sm">{g.removed_reason}</div>}</td>
              <td><div className="row" style={{ gap: 6 }}><StatusBadge status={g.status} />{!!g.featured && <Badge tone="accent" dot={false}>{t('featured', '精选')}</Badge>}</div><div className="dim mono fs-xs" style={{ marginTop: 4 }}>{g.live_version ? `v${g.live_version}` : '—'}</div></td>
              <td className="n">{g.price_cents > 0 ? usd(g.price_cents) : t('Free', '免费')}</td><td className="n">{num(g.plays)}</td><td className="n">{num(g.plays7)}</td><td className="n">{playTime(g.seconds)}</td>
              <td className="n">{g.rating_count ? (g.rating_sum / g.rating_count).toFixed(1) : '—'} <span className="dim">({g.rating_count})</span></td>
              <td className="n">{g.sales}</td><td className="n">{usd(g.fees)}</td><td className={'n' + (g.errors > 0 ? ' bad' : '')}>{num(g.errors)}</td>
              <td><div className="row-actions">
                {g.status === 'live' && <Button size="sm" disabled={busy === g.id} onClick={() => patch(g.id, { featured: !g.featured }, t('Updated.', '已更新。'))}>{g.featured ? t('Unfeature', '取消精选') : t('Feature', '设为精选')}</Button>}
                {g.status === 'live' && <Button size="sm" disabled={busy === g.id} onClick={() => patch(g.id, { action: 'offline' }, t('Game taken offline.', '游戏已下线。'))}>{t('Take offline', '下线')}</Button>}
                {g.status === 'removed' ? <Button size="sm" disabled={busy === g.id} onClick={() => patch(g.id, { action: 'restore' }, t('Game restored.', '游戏已恢复。'))}>{t('Restore', '恢复')}</Button> : <Button size="sm" variant="danger" disabled={busy === g.id} onClick={() => remove(g)}>{t('Remove', '移除')}</Button>}
              </div></td>
            </tr>))}</tbody>
        </Table>{!data.games.length && <div className="pad mute">{t('No games match.', '没有匹配的游戏。')}</div>}</Card>
      )}
    </div>
  );
}

function Money() {
  const { busy, act } = useAct(), { data, error, loading, reload } = useData<any>('/admin/money');
  const [grant, setGrant] = useState({ email: '', slug: '' });
  if (error && !data) return <Fail error={error} retry={reload} />;
  if (loading && !data) return <Spinner />;
  const settle = (w: any, action: 'paid' | 'reject') => {
    const note = prompt(action === 'paid' ? t('Reference for this payment (for your records)', '本次打款的参考编号（用于留档）') : t('Reason shown to the creator', '向创作者显示的原因')); if (note === null) return;
    void act(w.id, async () => { await api(`/admin/withdrawals/${w.id}`, { body: { action, note } }); await reload(); }, action === 'paid' ? t('Marked as paid.', '已标记为已打款。') : t('Rejected. The balance was returned.', '已拒绝，余额已退回。'));
  };
  const refund = (x: any) => { if (confirm(t(`Refund ${usd(x.price_cents)} to ${x.buyer}? Access is revoked and the creator's credit is reversed.`, `确定向 ${x.buyer} 退款 ${usd(x.price_cents)} 吗？对方将失去访问权限，创作者的相应收益也会被冲回。`))) void act(x.id, async () => { await api(`/admin/purchases/${x.id}/refund`, { method: 'POST' }); await reload(); }, t('Refunded.', '已退款。')); };
  const doGrant = () => act('grant', async () => { await api('/admin/grant-game', { body: grant }); setGrant({ email: '', slug: '' }); await reload(); }, t('Access granted.', '已授予访问权限。'));
  const waiting = data.withdrawals.filter((w: any) => w.status === 'pending');
  return (
    <div className="stack l">
      <Card title={t('Withdrawals', '提现')} actions={<>{waiting.length > 0 && <Badge tone="accent">{waiting.length} {t('waiting', '笔待处理')}</Badge>}</>}>
        {data.withdrawals.length ? <Table><thead><tr><th>{t('Creator', '创作者')}</th><th className="n">{t('Amount', '金额')}</th><th>{t('Method', '方式')}</th><th>{t('Status', '状态')}</th><th>{t('Requested', '申请时间')}</th><th /></tr></thead>
          <tbody>{data.withdrawals.map((w: any) => <tr key={w.id}>
            <td><b>{w.name}</b><div className="mute fs-sm">{w.email}</div></td><td className="n">{usd(w.amount_cents)}</td>
            <td>{w.method === 'stripe' ? 'Stripe' : t('Manual', '人工')}{w.details && <div className="mute fs-sm" style={{ maxWidth: 320, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{w.details}</div>}{w.provider_ref && <div className="dim mono fs-xs">{w.provider_ref}</div>}{w.error && <div className="bad fs-sm">{w.error}</div>}</td>
            <td><StatusBadge status={w.status} /></td><td className="mute">{dateTime(w.created_at)}</td>
            <td>{w.status === 'pending' && w.method === 'manual' && <div className="row-actions"><Button size="sm" variant="primary" disabled={busy === w.id} onClick={() => settle(w, 'paid')}>{t('Mark paid', '标记已打款')}</Button><Button size="sm" variant="danger" disabled={busy === w.id} onClick={() => settle(w, 'reject')}>{t('Reject', '拒绝')}</Button></div>}</td>
          </tr>)}</tbody></Table> : <div className="pad mute">{t('No withdrawals yet.', '暂无提现。')}</div>}
      </Card>
      <Card title={t('Game sales', '游戏销售')}>
        {data.purchases.length ? <Table><thead><tr><th>{t('Game', '游戏')}</th><th>{t('Buyer', '买家')}</th><th>{t('Creator', '创作者')}</th><th className="n">{t('Price', '价格')}</th><th className="n">{t('Platform', '平台')}</th><th className="n">{t('Creator', '创作者')}</th><th>{t('Status', '状态')}</th><th>{t('When', '时间')}</th><th /></tr></thead>
          <tbody>{data.purchases.map((x: any) => <tr key={x.id}><td><Link to={`/g/${x.slug}`}>{x.title}</Link></td><td className="mute">{x.buyer}</td><td className="mute">{x.creator}</td><td className="n">{usd(x.price_cents)}</td><td className="n">{usd(x.fee_cents)}</td><td className="n">{usd(x.net_cents)}</td><td><StatusBadge status={x.status} />{x.provider === 'admin' && <Badge dot={false}>{t('granted', '赠送')}</Badge>}</td><td className="mute">{dateTime(x.created_at)}</td>
            <td style={{ textAlign: 'right' }}>{x.status === 'paid' && <Button size="sm" variant="danger" disabled={busy === x.id} onClick={() => refund(x)}>{x.provider === 'admin' ? t('Revoke', '撤销') : t('Refund', '退款')}</Button>}</td></tr>)}</tbody></Table> : <div className="pad mute">{t('No sales yet.', '暂无销售。')}</div>}
      </Card>
      <div className="cols">
        <Card title={t('Creator fee payments', '创作者费用')}>
          {data.payments.length ? <Table><thead><tr><th>{t('User', '用户')}</th><th className="n">{t('Amount', '金额')}</th><th>{t('Source', '来源')}</th><th>{t('When', '时间')}</th></tr></thead>
            <tbody>{data.payments.map((y: any) => <tr key={y.id}><td>{y.email}</td><td className="n">{usd(y.amount_cents)}</td><td className="mute">{y.provider}</td><td className="mute">{dateTime(y.created_at)}</td></tr>)}</tbody></Table> : <div className="pad mute">{t('None yet.', '暂无记录。')}</div>}
        </Card>
        <Card title={t('Give a player a game', '赠送游戏')}><div className="pad stack">
          <p className="mute fs-sm">{t('For support cases and testing. No charge is made and the creator is not credited.', '用于客服或测试场景。不产生扣款，创作者也不会获得收益。')}</p>
          <Input type="email" placeholder={t('Player email', '玩家邮箱')} value={grant.email} onChange={(e) => setGrant({ ...grant, email: e.target.value })} />
          <Input mono placeholder={t('Game address (the part after /g/) or project id', '游戏地址（/g/ 之后的部分）或项目 ID')} value={grant.slug} onChange={(e) => setGrant({ ...grant, slug: e.target.value })} />
          <div><Button disabled={!grant.email || !grant.slug || busy === 'grant'} onClick={doGrant}>{t('Grant access', '授予访问权限')}</Button></div>
        </div></Card>
      </div>
    </div>
  );
}
