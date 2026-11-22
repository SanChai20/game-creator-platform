import { useEffect, useMemo, useState } from 'react';
import { Pager } from '../store';
import { ago, api, bytes, date, dateTime, Fail, Link, num, playTime, series, t, tr, usd, useAct, useApp, useData, count } from '../lib';
import { Badge, Bars, Button, Card, ChartBlock, CheckRow, Input, PageHeader, SearchInput, Stat, StatGrid, StatusBadge, Switch, RowMenu, Table, Tabs } from '../ui';
import { AdminSkeleton } from '../skeletons';

const MB = 1024 * 1024;

const tabs = (): [string, string][] => [['overview', t('Overview', '概览')], ['settings', t('Settings', '参数设置')], ['users', t('Users', '用户')], ['games', t('Games', '游戏')], ['money', t('Money', '资金')], ['reports', t('Reports', '举报')]];

export function Admin({ tab }: { tab: string }) {
  return (
    <div className="wrap page">
      <PageHeader eyebrow={t('Admin', '管理后台')} title={tabs().find(([k]) => k === tab)?.[1] || t('Admin', '管理后台')} />
      <Tabs active={tab} items={tabs().map(([k, label]) => ({ key: k, to: k === 'overview' ? '/admin' : `/admin/${k}`, label }))} />
      {tab === 'overview' ? <Overview /> : tab === 'settings' ? <Settings /> : tab === 'users' ? <Users /> : tab === 'games' ? <Games /> : tab === 'money' ? <Money /> : tab === 'reports' ? <Reports /> : null}
    </div>
  );
}

function Overview() {
  const { data, error, loading, reload } = useData<any>('/admin/overview');
  if (error && !data) return <Fail error={error} retry={reload} />;
  if (loading && !data) return <AdminSkeleton tab="overview" />;
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
        <Stat tone="accent" label={t('Platform revenue', '平台收入')} value={usd(data.sales.fees + (data.skill_sales?.fees || 0) + data.creator_fees.total)} sub={<>{usd(data.sales.fees)} {t('from sales', '来自销售分成')} · {usd(data.skill_sales?.fees || 0)} {t('from skills', '来自技能')} · {usd(data.creator_fees.total)} {t('creator fees', '创作者费用')}</>} />
        <Stat label={t('Game sales', '游戏销售额')} value={usd(data.sales.gross)} sub={<>{count(data.sales.n, 'sale', 'sales', '笔')} · {usd(data.sales.gross30)} {t('in 30 days', '近 30 天')}</>} />
        <Stat label={t('Skill sales', '技能销售额')} value={usd(data.skill_sales?.gross || 0)} sub={<>{count(data.skill_sales?.n || 0, 'sale', 'sales', '笔')} · {t('{n} skills shared, {paid} paid', '已分享 {n} 个技能，{paid} 个付费', { n: data.skill_sales?.shared || 0, paid: data.skill_sales?.paid || 0 })}</>} />
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
      <Jobs jobs={data.jobs || []} picks={data.picks || []} />
      <Card title={t('Flagged uploads', '被标记的上传')} aside={t('copies of other creators\' games and uploads that are not games, caught before publishing', '发布前拦截的抄袭作品与非游戏上传')}>
        {data.flags?.length ? <Table><thead><tr><th>{t('Game', '游戏')}</th><th>{t('Creator', '创作者')}</th><th>{t('Why', '原因')}</th><th className="n">{t('When', '时间')}</th></tr></thead>
          <tbody>{data.flags.map((f: any, i: number) => <tr key={i}><td><b>{f.title}</b> <span className="dim mono fs-xs">v{f.version}</span></td><td className="mono fs-sm">{f.email}</td><td className="fs-sm"><Badge tone={f.kind === 'not_game_flagged' ? 'neutral' : 'accent'} dot={false}>{f.kind === 'copy_flagged' ? t('Copy', '抄袭') : f.kind === 'player_report' ? t('Player report', '玩家举报') : t('Not a game', '非游戏')}</Badge> <span className="mute">{f.detail}</span></td><td className="n fs-sm">{ago(f.created_at)}</td></tr>)}</tbody></Table>
          : <div className="pad mute">{t('Nothing flagged.', '暂无标记。')}</div>}
      </Card>
    </div>
  );
}

const JOB_LABEL = (): Record<string, string> => ({
  playing: t('Playing now counts', '在线人数统计'), trending: t('Trending scores', '热门分数'), picks: t('Today\'s picks', '今日推荐'),
  transfers: t('Stripe transfer retries', 'Stripe 转账重试'), rollout: t('Game runtime rollout', '游戏运行时更新'), mature: t('Age rating backfill', '年龄分级补全'),
  payouts: t('Automatic payouts', '自动提现'), cleanup: t('Expired data cleanup', '过期数据清理'), fingerprints: t('Originality fingerprint backfill', '原创性指纹补全'),
});
/** The scheduled jobs: they run by themselves; this only shows that they do (a job late by more than two of its periods, or failing, is marked). */
function Jobs({ jobs, picks }: { jobs: { job: string; every: number; last_run_at: number | null; last_ok_at: number | null; last_error: string | null; runs: number }[]; picks: { id: string; slug: string; title: string; reason: string }[] }) {
  const L = JOB_LABEL(), late = (j: (typeof jobs)[number]) => !j.last_ok_at || Date.now() - j.last_ok_at > (j.every * 2 + 5) * 60000;
  return (
    <div className="cols">
      <Card title={t('Scheduled jobs', '定时任务')} aside={t('They run on their own; nothing here needs doing', '自动运行，无需手动操作')} pad><div>
        {jobs.map((j) => <CheckRow key={j.job} ok={!j.last_error && !late(j)} title={L[j.job] || j.job}
          detail={j.last_error ? j.last_error : j.last_ok_at ? t('Last ran {when}', '上次运行：{when}', { when: ago(j.last_ok_at) }) : t('Not run yet', '尚未运行')} />)}
      </div></Card>
      <Card title={t('Today\'s picks', '今日推荐')} aside={t('Chosen every day from play numbers and ratings', '每天根据游玩数据与评分自动选出')} pad>
        {picks.length ? <ol className="stack s">{picks.map((p) => <li key={p.id}><Link to={`/g/${p.slug}`}>{p.title}</Link> <span className="dim fs-xs">{p.reason}</span></li>)}</ol>
          : <div className="mute">{t('Chosen at the next run, within 10 minutes.', '将在下次运行时选出（10 分钟内）。')}</div>}
      </Card>
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
  if (loading && !data) return <AdminSkeleton tab="settings" />;
  const show = (k: string) => { const d = data!.defs[k], v = data!.values[k]; return k in draft ? draft[k] : d.type === 'cents' ? (v / 100).toFixed(2) : d.type === 'bytes' ? String(Math.round((v / MB) * 100) / 100) : d.type === 'bool' ? !!v : String(v); };
  const dirty = Object.keys(draft).length;
  const save = () => act('save', async () => {
    const out: Record<string, unknown> = {};
    for (const [k, raw] of Object.entries(draft)) {
      const d = data!.defs[k];
      if (d.type === 'bool' || d.type === 'text' || d.type === 'select') out[k] = raw;
      else { const n = Number(raw); if (!Number.isFinite(n)) throw new Error(`${tr(d.label)}: ${t('enter a number', '请输入数字')}`); out[k] = d.type === 'cents' ? Math.round(n * 100) : d.type === 'bytes' ? Math.round(n * MB) : d.type === 'int' ? Math.round(n) : n; }
    }
    await api('/admin/settings', { method: 'PUT', body: out }); await reload(); await refresh();
  }, t('Settings saved.', '设置已保存。'));
  return (
    <div className="stack l" style={{ maxWidth: 900 }}>
      {groups.map(([group, keys]) => (
        <Card key={group} title={tr(group)}>
          {keys.map((k) => { const d = data!.defs[k], v = show(k), changed = k in draft; return (
            <label className="set-row" key={k}>
              <div><b>{tr(d.label)}</b>{d.help && <div className="mute fs-sm">{tr(d.help)}</div>}<div className="dim mono fs-xs">{k}{changed && <span className="sig"> · {t('changed', '已修改')}</span>}</div></div>
              {d.type === 'bool' ? <Switch checked={v as boolean} onChange={(e) => setDraft({ ...draft, [k]: e.target.checked })} />
                : d.type === 'select' ? <select className="input" value={v as string} onChange={(e) => setDraft({ ...draft, [k]: e.target.value })}>{(d.options || []).map((o: string) => <option key={o} value={o}>{tr(o)}</option>)}</select>
                : <div className="row">{d.type === 'cents' && <span className="mute">$</span>}<Input mono={d.type !== 'text'} inputMode={d.type === 'text' ? 'text' : 'decimal'} value={v as string} onChange={(e) => setDraft({ ...draft, [k]: e.target.value })} />{d.type === 'bytes' && <span className="mute">MB</span>}</div>}
            </label>); })}
        </Card>
      ))}
      {dirty > 0 && <div className="savebar"><span className="grow"><b className="sig">{dirty}</b> {t('unsaved changes', '项未保存的修改')}</span><Button variant="ghost" onClick={() => setDraft({})}>{t('Discard', '放弃')}</Button><Button variant="primary" onClick={save} disabled={busy === 'save'}>{t('Save changes', '保存修改')}</Button></div>}
    </div>
  );
}

/** A searched, paged admin list: the search waits for typing to pause, and a new search starts at page 1. */
function useSearch(base: string) {
  const [q, setQ] = useState(''), [applied, setApplied] = useState(''), [page, setPage] = useState(1);
  useEffect(() => { const i = setTimeout(() => { setApplied(q); setPage(1); }, 300); return () => clearTimeout(i); }, [q]);
  const d = useData<any>(`${base}?q=${encodeURIComponent(applied)}&page=${page}`);
  const pages = d.data ? Math.max(1, Math.ceil(d.data.total / d.data.per_page)) : 1;
  const pager = d.data && pages > 1 ? <div className="list-foot"><span className="dim fs-sm">{t('{total} in all', '共 {total} 条', { total: num(d.data.total) })}</span><Pager page={page} pages={pages} onPage={(p) => { setPage(p); scrollTo({ top: 0 }); }} /></div> : null;
  return { q, setQ, pager, ...d };
}

/** An account's creator license as the users table shows it. */
const lic = (u: { creator: number; creator_plan: string | null; creator_until: number | null }) =>
  !u.creator ? 'none' : u.creator_plan !== 'term' ? 'lifetime' : (u.creator_until || 0) > Date.now() ? 'term' : 'expired';

function Users() {
  const { user: me } = useApp(), { busy, act } = useAct(), { q, setQ, pager, data, error, loading, reload } = useSearch('/admin/users');
  const patch = (id: string, body: Record<string, unknown>, msg: string) => act(id, async () => { await api(`/admin/users/${id}`, { method: 'PATCH', body }); await reload(); }, msg);
  const adjust = (u: any) => {
    const raw = prompt(t('Adjust the balance of {email} by how many dollars? Use a minus sign to deduct.', '将 {email} 的余额调整多少美元？扣减请加负号。', { email: u.email })); if (!raw) return;
    const n = Math.round(parseFloat(raw) * 100); if (!Number.isFinite(n) || n === 0) return;
    void patch(u.id, { adjust_cents: n, note: prompt(t('Note shown to the user', '向用户显示的备注')) || undefined }, t('Balance adjusted.', '余额已调整。'));
  };
  return (
    <div className="stack l">
      <div className="admin-tools"><SearchInput placeholder={t('Search by email or name', '按邮箱或名称搜索')} value={q} onChange={(e) => setQ(e.target.value)} /></div>
      {error && !data ? <Fail error={error} retry={reload} /> : loading && !data ? <AdminSkeleton tab="table" /> : (
        <Card><Table dense stickyEnd>
          <thead><tr><th>{t('User', '用户')}</th><th>{t('Status', '状态')}</th><th className="n">{t('Games', '游戏')}</th><th className="n">{t('Balance', '余额')}</th><th className="n">{t('Bought', '已购')}</th><th className="n">{t('Played', '游玩')}</th><th>{t('Joined', '注册')}</th><th>{t('Seen', '最近活跃')}</th><th /></tr></thead>
          <tbody>{data.users.map((u: any) => (
            <tr key={u.id}>
              <td><b>{u.name}</b><div className="mute fs-sm">{u.email}</div></td>
              <td><div className="row wrapx" style={{ gap: 6 }}><StatusBadge status={u.status} />{u.role === 'admin' && <Badge tone="accent" dot={false}>admin</Badge>}{lic(u) === 'lifetime' && <Badge tone="good" dot={false}>{t('lifetime license', '永久许可')}</Badge>}{lic(u) === 'term' && <Badge tone="good" dot={false}>{t('license until {date}', '许可至 {date}', { date: date(u.creator_until) })}</Badge>}{lic(u) === 'expired' && <Badge dot={false}>{t('license ended {date}', '许可已于 {date} 到期', { date: date(u.creator_until) })}</Badge>}{!!u.stripe_payouts_enabled && <Badge dot={false}>{t('payouts', '可收款')} {u.payout_country}</Badge>}{!!u.two_factor && <Badge dot={false}>{t('2FA', '两步验证')}</Badge>}</div></td>
              <td className="n">{u.live}/{u.projects}</td><td className="n">{usd(u.balance)}</td><td className="n">{u.bought}</td><td className="n">{playTime(u.played)}</td>
              <td className="mute">{date(u.created_at)}</td><td className="mute">{ago(u.last_seen_at)}</td>
              <td><RowMenu label={t('Actions for {name}', '{name} 的操作', { name: u.email })} disabled={busy === u.id} actions={[
                lic(u) !== 'lifetime' && { label: t('Grant lifetime license', '授予永久许可'), onClick: () => patch(u.id, { license: 'lifetime' }, t('Updated.', '已更新。')) },
                lic(u) !== 'term' && { label: t('Grant time-limited license', '授予限时许可'), onClick: () => patch(u.id, { license: 'term' }, t('Updated.', '已更新。')) },
                (lic(u) === 'term' || lic(u) === 'lifetime') && { label: t('Remove license', '取消许可'), danger: true, onClick: () => patch(u.id, { license: 'none' }, t('Updated.', '已更新。')) },
                { label: t('Adjust', '调整余额'), onClick: () => adjust(u) },
                u.id !== me!.id && { label: u.role === 'admin' ? t('Remove admin', '取消管理员') : t('Make admin', '设为管理员'), onClick: () => patch(u.id, { role: u.role === 'admin' ? 'user' : 'admin' }, t('Updated.', '已更新。')) },
                !!u.two_factor && { label: t('Turn off two-factor', '关闭两步验证'), danger: true, onClick: () => { if (confirm(t('Turn off two-factor sign-in for {email}? Do this only after confirming it is really them, for example from their account email. They can then sign in with an email code alone.', '要为 {email} 关闭两步验证登录吗？请先确认确实是本人（例如通过其账户邮箱），再执行此操作。之后对方仅需邮箱验证码即可登录。', { email: u.email }))) void patch(u.id, { two_factor: false }, t('Two-factor sign-in turned off.', '已关闭两步验证登录。')); } },
                u.id !== me!.id && { label: u.status === 'active' ? t('Suspend', '停用') : t('Restore', '恢复'), danger: u.status === 'active', onClick: () => patch(u.id, { status: u.status === 'active' ? 'suspended' : 'active' }, t('Updated.', '已更新。')) },
              ]} /></td>
            </tr>))}</tbody>
        </Table>{!data.users.length && <div className="pad mute">{t('No users match.', '没有匹配的用户。')}</div>}{pager}</Card>
      )}
    </div>
  );
}

/** Creators' requests for more storage for one game: approve (with the amount asked, or another) or deny. */
function StorageRequests({ onChange }: { onChange: () => void }) {
  const { busy, act } = useAct(), { data, reload } = useData<any>('/admin/storage-requests');
  if (!data?.requests?.length) return null;
  const decide = (r: any, approve: boolean) => {
    const mbs = approve ? prompt(t('Storage to grant "{title}", in MB', '为《{title}》分配的存储空间（MB）', { title: r.title }), String(Math.round(r.bytes / MB))) : '';
    if (mbs === null) return;
    const note = prompt(approve ? t('Note for the creator (optional)', '给创作者的备注（可选）') : t('Reason shown to the creator', '向创作者显示的原因'));
    if (note === null) return;
    void act(r.id, async () => { await api(`/admin/storage-requests/${r.id}`, { body: { action: approve ? 'approve' : 'deny', megabytes: mbs || undefined, note } }); await reload(); onChange(); }, approve ? t('Storage granted.', '已分配存储空间。') : t('Request denied.', '已拒绝申请。'));
  };
  const waiting = data.requests.filter((r: any) => r.status === 'pending').length;
  return (
    <Card title={t('Storage requests', '存储空间申请')} aside={t('creators asking for more storage for one game', '创作者为单款游戏申请更多存储空间')} actions={waiting > 0 ? <Badge tone="accent">{waiting} {t('waiting', '笔待处理')}</Badge> : undefined}>
      <Table stickyEnd><thead><tr><th>{t('Game', '游戏')}</th><th className="n">{t('Asked for', '申请')}</th><th className="n">{t('Has', '现有')}</th><th className="n">{t('Used', '已用')}</th><th>{t('Why', '原因')}</th><th>{t('Status', '状态')}</th><th /></tr></thead>
        <tbody>{data.requests.map((r: any) => <tr key={r.id}>
          <td><b>{r.title}</b><div className="mute fs-sm">{r.author} · {r.author_email}</div><div className="dim fs-xs">{ago(r.created_at)}</div></td>
          <td className="n">{bytes(r.bytes)}</td><td className="n">{bytes(r.storage_bytes ?? data.default_bytes)}</td><td className="n">{bytes(r.used_now)}</td>
          <td className="fs-sm" style={{ maxWidth: 380, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{r.reason}{r.note && <div className="mute">{t('Answer', '答复')}: {r.note}</div>}</td>
          <td><StatusBadge status={r.status} />{r.status === 'approved' && r.granted_bytes ? <div className="dim fs-xs">{bytes(r.granted_bytes)}</div> : null}</td>
          <td>{r.status === 'pending' && <div className="row-actions"><Button size="sm" variant="primary" disabled={busy === r.id} onClick={() => decide(r, true)}>{t('Approve', '批准')}</Button><Button size="sm" variant="danger" disabled={busy === r.id} onClick={() => decide(r, false)}>{t('Deny', '拒绝')}</Button></div>}</td>
        </tr>)}</tbody></Table>
    </Card>
  );
}

/** Versions the verification browser could not run (WebGPU, or no browser): approve to publish, or deny with a reason. */
function Reviews({ onChange }: { onChange: () => void }) {
  const { busy, act } = useAct(), { data, reload } = useData<any>('/admin/reviews');
  if (!data?.reviews?.length) return null;
  const decide = (r: any, approve: boolean) => {
    const note = prompt(approve ? t('Note for the creator (optional)', '给创作者的备注（可选）') : t('Reason shown to the creator', '向创作者显示的原因'));
    if (note === null) return;
    const key = `${r.project_id}:${r.n}`;
    void act(key, async () => { await api(`/admin/reviews/${r.project_id}/${r.n}`, { body: { action: approve ? 'approve' : 'deny', note } }); await reload(); onChange(); }, approve ? t('Approved. The version is being published.', '已批准，该版本正在发布。') : t('Review denied.', '已拒绝审核。'));
  };
  const waiting = data.reviews.filter((r: any) => r.review === 'pending').length;
  const why = (w: string) => (w === 'webgpu' ? t('Needs WebGPU', '需要 WebGPU') : w === 'no_browser' ? t('Browser unavailable', '浏览器不可用') : t('Other', '其他'));
  return (
    <Card title={t('Version reviews', '版本审核')} aside={t('versions the verification browser could not run, checked by a person before they go live', '验证浏览器无法运行的版本，上线前需人工检查')} actions={waiting > 0 ? <Badge tone="accent">{waiting} {t('waiting', '笔待处理')}</Badge> : undefined}>
      <Table stickyEnd><thead><tr><th>{t('Game', '游戏')}</th><th className="n">{t('Version', '版本')}</th><th>{t('Why', '原因')}</th><th>{t('Status', '状态')}</th><th /></tr></thead>
        <tbody>{data.reviews.map((r: any) => { const key = `${r.project_id}:${r.n}`; return <tr key={key}>
          <td><b>{r.title}</b> <a className="fs-sm" href={`/console/p/${r.project_id}`} target="_blank" rel="noreferrer">{t('Open project', '打开项目')}</a><div className="mute fs-sm">{r.author} · {r.author_email}</div><div className="dim fs-xs">{ago(r.created_at)}</div></td>
          <td className="n">{r.n}</td>
          <td className="fs-sm">{why(r.why)}{r.review_note && <div className="mute">{t('Answer', '答复')}: {r.review_note}</div>}</td>
          <td><StatusBadge status={r.review} /></td>
          <td>{r.review === 'pending' && <div className="row-actions"><Button size="sm" variant="primary" disabled={busy === key} onClick={() => decide(r, true)}>{t('Approve', '批准')}</Button><Button size="sm" variant="danger" disabled={busy === key} onClick={() => decide(r, false)}>{t('Deny', '拒绝')}</Button></div>}</td>
        </tr>; })}</tbody></Table>
    </Card>
  );
}

// The release gate for one game (src/release-gate.ts): every platform requirement for a version, the waivers on it, and
// an admin's way to let one version through a rule a verifier got wrong. Every rule is checked again before it goes live.
function ReleasePanel({ game, onClose }: { game: any; onClose: () => void }) {
  const [version, setVersion] = useState<number | null>(null);
  const { busy, act } = useAct(), { data, error, loading, reload } = useData<any>(`/admin/games/${game.id}/release${version ? `?version=${version}` : ''}`);
  const tone = (st: string) => (st === 'pass' ? 'good' : st === 'fail' ? 'bad' : st === 'waived' ? 'accent' : 'neutral');
  const label = (st: string) => (st === 'pass' ? t('Met', '满足') : st === 'fail' ? t('Not met', '未满足') : st === 'waived' ? t('Waived', '已豁免') : t('Not checked', '未检查'));
  const n = data?.version;
  const waiveRule = (r: any) => {
    const reason = prompt(t('Why may version {n} go live although "{rule}" is not met? This stays on record with the release.', '为什么允许版本 {n} 在未满足“{rule}”的情况下上线？此原因会随发布记录保存。', { n, rule: r.title }));
    if (reason === null) return;
    const days = prompt(t('For how many days (1 to 30)?', '有效天数（1 至 30）？'), '7');
    if (days === null) return;
    void act(r.id, async () => { await api(`/admin/games/${game.id}/release/${n}/waivers`, { body: { rule: r.id, reason, days: Number(days) } }); await reload(); }, t('Waived for this version.', '已为该版本豁免。'));
  };
  const unwaive = (rule: string) => act(rule, async () => { await api(`/admin/games/${game.id}/release/${n}/waivers/${rule}`, { method: 'DELETE' }); await reload(); }, t('Waiver removed.', '已撤销豁免。'));
  const publish = () => act('publish', async () => { await api(`/admin/games/${game.id}/release/${n}/publish`, { body: {} }); await reload(); }, t('Publishing. Every requirement is checked again before it goes live.', '正在发布。上线前会再次检查所有要求。'));
  return (
    <Card title={t('Release requirements: {title}', '发布要求：{title}', { title: game.title })} aside={data ? t('ruleset {r}', '规则集 {r}', { r: data.ruleset }) : undefined}
      actions={<>
        {data?.versions?.length > 0 && <select value={n ?? ''} onChange={(e) => setVersion(Number(e.target.value))} aria-label={t('Version', '版本')}>{data.versions.map((v: any) => <option key={v.n} value={v.n}>v{v.n} · {v.status}{v.published_at ? ` · ${t('was live', '曾上线')}` : ''}</option>)}</select>}
        {data?.requirements?.ok && <Button size="sm" variant="primary" disabled={busy === 'publish'} onClick={() => void publish()}>{t('Publish v{n}', '发布 v{n}', { n })}</Button>}
        <Button size="sm" onClick={onClose}>{t('Close', '关闭')}</Button>
      </>}>
      {error && !data ? <Fail error={error} retry={reload} /> : loading && !data ? <div className="pad mute">{t('Checking…', '检查中…')}</div> : !data?.requirements ? <div className="pad mute">{t('This game has no versions yet.', '该游戏还没有版本。')}</div> : (<>
        <div className="pad">{data.requirements.ok ? <Badge tone="good">{t('Version {n} meets every requirement', '版本 {n} 满足全部要求', { n })}</Badge> : <Badge tone="bad">{t('Version {n} cannot go live', '版本 {n} 无法上线', { n })}</Badge>}</div>
        <Table dense><thead><tr><th>{t('Requirement', '要求')}</th><th>{t('Status', '状态')}</th><th>{t('Why and what to do', '原因与处理')}</th><th /></tr></thead>
          <tbody>{data.requirements.rules.map((r: any) => <tr key={r.id}>
            <td><b>{r.title}</b><div className="dim mono fs-xs">{r.id}</div></td>
            <td><Badge tone={tone(r.status) as any}>{label(r.status)}</Badge></td>
            <td className="fs-sm">{r.reason}{r.fix && <div className="mute">{r.fix}</div>}{r.waiver_reason && <div className="mute">{t('Waived until {d}: {why}', '豁免至 {d}：{why}', { d: dateTime(Date.parse(r.waived_until)), why: r.waiver_reason })}</div>}</td>
            <td>{r.status === 'fail' && data.waivable.includes(r.id) && <Button size="sm" disabled={busy === r.id} onClick={() => waiveRule(r)}>{t('Waive', '豁免')}</Button>}
              {r.status === 'waived' && <Button size="sm" variant="danger" disabled={busy === r.id} onClick={() => void unwaive(r.id)}>{t('Remove waiver', '撤销豁免')}</Button>}</td>
          </tr>)}</tbody></Table>
        {data.waivers?.length > 0 && <div className="pad fs-sm mute">{t('Waivers on record', '豁免记录')}: {data.waivers.map((w: any) => `v${w.version} ${w.rule} (${w.admin_email || w.created_by}, ${w.revoked_at ? t('removed', '已撤销') : w.expires_at < Date.now() ? t('ended', '已到期') : t('until {d}', '至 {d}', { d: date(w.expires_at) })}): ${w.reason}`).join(' · ')}</div>}
      </>)}
    </Card>
  );
}

function Games() {
  const { config } = useApp(), defaultStorage = config.settings.bundle_max_bytes as number;
  const { busy, act } = useAct(), { q, setQ, pager, data, error, loading, reload } = useSearch('/admin/games');
  const [release, setRelease] = useState<any>(null);
  const storage = (g: any) => {
    const raw = prompt(t('Storage for "{title}" in MB. Leave empty for the platform default ({mb} MB).', '《{title}》的存储空间（MB）。留空则使用平台默认值（{mb} MB）。', { title: g.title, mb: Math.round(defaultStorage / MB) }), g.storage_bytes != null ? String(Math.round(g.storage_bytes / MB)) : '');
    if (raw === null) return;
    if (raw.trim() && !(Number(raw) > 0)) return;
    void patch(g.id, { storage_mb: raw.trim() ? Number(raw) : null }, t('Storage updated.', '存储空间已更新。'));
  };
  const patch = (id: string, body: Record<string, unknown>, msg: string) => act(id, async () => { await api(`/admin/games/${id}`, { method: 'PATCH', body }); await reload(); }, msg);
  const remove = (g: any) => { const reason = prompt(t('Remove "{title}" from the platform? Give the reason shown to its creator.', '确定将《{title}》从平台移除吗？请填写向创作者显示的原因。', { title: g.title })); if (reason !== null) void patch(g.id, { action: 'remove', reason }, t('Game removed.', '游戏已移除。')); };
  return (
    <div className="stack l">
      <Reviews onChange={reload} />
      <StorageRequests onChange={reload} />
      {release && <ReleasePanel key={release.id} game={release} onClose={() => { setRelease(null); void reload(); }} />}
      <div className="admin-tools"><SearchInput placeholder={t('Search by title, address or creator email', '按标题、地址或创作者邮箱搜索')} value={q} onChange={(e) => setQ(e.target.value)} /></div>
      {error && !data ? <Fail error={error} retry={reload} /> : loading && !data ? <AdminSkeleton tab="table" /> : (
        <Card><Table dense stickyEnd>
          <thead><tr><th>{t('Game', '游戏')}</th><th>{t('Status', '状态')}</th><th className="n">{t('Price', '价格')}</th><th className="n">{t('Plays', '游玩')}</th><th className="n">{t('7 days', '近 7 天')}</th><th className="n">{t('Time', '时长')}</th><th className="n">{t('Rating', '评分')}</th><th className="n">{t('Sales', '销量')}</th><th className="n">{t('Fees', '平台分成')}</th><th className="n">{t('Errors', '错误')}</th><th className="n">{t('Storage', '存储空间')}</th><th /></tr></thead>
          <tbody>{data.games.map((g: any) => (
            <tr key={g.id}>
              <td>{g.status === 'live' ? <Link to={`/g/${g.slug}`}><b>{g.title}</b></Link> : <b>{g.title}</b>}<div className="mute fs-sm">{g.author} · {g.author_email}</div>{g.removed_reason && <div className="bad fs-sm">{g.removed_reason}</div>}</td>
              <td><div className="row" style={{ gap: 6 }}><StatusBadge status={g.status} />{!!g.featured && <Badge tone="accent" dot={false}>{t('featured', '精选')}</Badge>}</div><div className="dim mono fs-xs" style={{ marginTop: 4 }}>{g.live_version ? `v${g.live_version}` : '—'}</div></td>
              <td className="n">{g.price_cents > 0 ? usd(g.price_cents) : t('Free', '免费')}</td><td className="n">{num(g.plays)}</td><td className="n">{num(g.plays7)}</td><td className="n">{playTime(g.seconds)}</td>
              <td className="n">{g.rating_count ? (g.rating_sum / g.rating_count).toFixed(1) : '—'} <span className="dim">({g.rating_count})</span></td>
              <td className="n">{g.sales}</td><td className="n">{usd(g.fees)}</td><td className={'n' + (g.errors > 0 ? ' bad' : '')}>{num(g.errors)}</td>
              <td className={'n' + (g.used_bytes > (g.storage_bytes ?? defaultStorage) ? ' bad' : '')}>{bytes(g.used_bytes)}<div className="dim fs-xs">{t('of {size}', '共 {size}', { size: bytes(g.storage_bytes ?? defaultStorage) })}{g.storage_bytes != null && ` · ${t('set for this game', '单独设置')}`}</div></td>
              <td><RowMenu label={t('Actions for {name}', '{name} 的操作', { name: g.title })} disabled={busy === g.id} actions={[
                { label: t('Release requirements', '发布要求'), onClick: () => setRelease(g) },
                { label: t('Storage', '存储空间'), onClick: () => storage(g) },
                g.status === 'live' && { label: g.featured ? t('Unfeature', '取消精选') : t('Feature', '设为精选'), onClick: () => patch(g.id, { featured: !g.featured }, t('Updated.', '已更新。')) },
                g.status === 'live' && { label: t('Take offline', '下线'), onClick: () => patch(g.id, { action: 'offline' }, t('Game taken offline.', '游戏已下线。')) },
                g.status === 'removed' ? { label: t('Restore', '恢复'), onClick: () => patch(g.id, { action: 'restore' }, t('Game restored.', '游戏已恢复。')) } : { label: t('Remove', '移除'), danger: true, onClick: () => remove(g) },
              ]} /></td>
            </tr>))}</tbody>
        </Table>{!data.games.length && <div className="pad mute">{t('No games match.', '没有匹配的游戏。')}</div>}{pager}</Card>
      )}
    </div>
  );
}

function Money() {
  const { busy, act } = useAct(), { data, error, loading, reload } = useData<any>('/admin/money');
  const [grant, setGrant] = useState({ email: '', slug: '' });
  if (error && !data) return <Fail error={error} retry={reload} />;
  if (loading && !data) return <AdminSkeleton tab="money" />;
  const settle = (w: any, action: 'paid' | 'reject') => {
    const note = prompt(action === 'paid' ? t('Reference for this payment (for your records)', '本次打款的参考编号（用于留档）') : t('Reason shown to the creator', '向创作者显示的原因')); if (note === null) return;
    void act(w.id, async () => { await api(`/admin/withdrawals/${w.id}`, { body: { action, note } }); await reload(); }, action === 'paid' ? t('Marked as paid.', '已标记为已打款。') : t('Rejected. The balance was returned.', '已拒绝，余额已退回。'));
  };
  const refund = (x: any) => { if (confirm(t('Refund {price} to {buyer}? Access is revoked, the creator\'s credit is reversed (from their payout if it was already sent) and the platform gives back its cut.', '确定向 {buyer} 退款 {price} 吗？对方将失去访问权限，创作者的相应收益会被冲回（若已打款则从打款中收回），平台也会退回其分成。', { price: usd(x.price_cents), buyer: x.buyer }))) void act(x.id, async () => { await api(`/admin/purchases/${x.id}/refund`, { method: 'POST' }); await reload(); }, t('Refunded.', '已退款。')); };
  const doGrant = () => act('grant', async () => { await api('/admin/grant-game', { body: grant }); setGrant({ email: '', slug: '' }); await reload(); }, t('Access granted.', '已授予访问权限。'));
  const waiting = data.withdrawals.filter((w: any) => w.status === 'pending');
  return (
    <div className="stack l">
      <Card title={t('Withdrawals', '提现')} actions={<>{waiting.length > 0 && <Badge tone="accent">{waiting.length} {t('waiting', '笔待处理')}</Badge>}</>}>
        {data.withdrawals.length ? <Table stickyEnd><thead><tr><th>{t('Creator', '创作者')}</th><th className="n">{t('Amount', '金额')}</th><th>{t('Method', '方式')}</th><th>{t('Status', '状态')}</th><th>{t('Requested', '申请时间')}</th><th /></tr></thead>
          <tbody>{data.withdrawals.map((w: any) => <tr key={w.id}>
            <td><b>{w.name}</b><div className="mute fs-sm">{w.email}</div></td><td className="n">{usd(w.amount_cents)}</td>
            <td>{w.method === 'stripe' ? 'Stripe' : t('Manual', '人工')}{w.details && <div className="mute fs-sm" style={{ maxWidth: 320, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{w.details}</div>}{w.provider_ref && <div className="dim mono fs-xs">{w.provider_ref}</div>}{w.error && <div className="bad fs-sm">{w.error}</div>}</td>
            <td><StatusBadge status={w.status} /></td><td className="mute">{dateTime(w.created_at)}</td>
            <td>{w.status === 'pending' && w.method === 'manual' && <div className="row-actions"><Button size="sm" variant="primary" disabled={busy === w.id} onClick={() => settle(w, 'paid')}>{t('Mark paid', '标记已打款')}</Button><Button size="sm" variant="danger" disabled={busy === w.id} onClick={() => settle(w, 'reject')}>{t('Reject', '拒绝')}</Button></div>}</td>
          </tr>)}</tbody></Table> : <div className="pad mute">{t('No withdrawals yet.', '暂无提现。')}</div>}
      </Card>
      <Refunds rows={data.refunds || []} reload={reload} />
      <Card title={t('Game sales', '游戏销售')}>
        {data.purchases.length ? <Table stickyEnd><thead><tr><th>{t('Game', '游戏')}</th><th>{t('Buyer', '买家')}</th><th>{t('Creator', '创作者')}</th><th className="n">{t('Price', '价格')}</th><th className="n">{t('Platform', '平台')}</th><th className="n">{t('Creator', '创作者')}</th><th>{t('Status', '状态')}</th><th>{t('When', '时间')}</th><th /></tr></thead>
          <tbody>{data.purchases.map((x: any) => <tr key={x.id}><td>{x.item === 'skill' ? <><Link to={`/creator-store/${x.slug}`}>{x.title}</Link> <Badge dot={false} tone="accent">{t('skill', '技能')}</Badge></> : <Link to={`/g/${x.slug}`}>{x.title}</Link>}</td><td className="mute">{x.buyer}</td><td className="mute">{x.creator}</td><td className="n">{usd(x.price_cents)}</td><td className="n">{usd(x.fee_cents)}</td><td className="n">{usd(x.net_cents)}</td><td><StatusBadge status={x.status} />{x.provider === 'admin' && <Badge dot={false}>{t('granted', '赠送')}</Badge>}</td><td className="mute">{dateTime(x.created_at)}</td>
            <td style={{ textAlign: 'right' }}>{x.status === 'paid' && x.item === 'skill' ? <span className="dim fs-sm">{t('Non-refundable', '不可退款')}</span> : x.status === 'paid' && <Button size="sm" variant="danger" disabled={busy === x.id} onClick={() => refund(x)}>{x.provider === 'admin' ? t('Revoke', '撤销') : t('Refund', '退款')}</Button>}</td></tr>)}</tbody></Table> : <div className="pad mute">{t('No sales yet.', '暂无销售。')}</div>}
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

/** Every game refund, open requests first: the ones the platform could not settle by itself wait here for a decision. */
const REVIEW: Record<string, () => string> = {
  play_unconfirmed: () => t('Play time could not be confirmed', '无法确认游玩时间'),
  frequent: () => t('Account refunds often: self-service turned off', '该账户退款频繁：已关闭自助退款'),
  account: () => t('Account without self-service refunds', '该账户无自助退款权限'),
  manual: () => t('Automatic refunds are off', '自动退款已关闭'),
  refund_failed: () => t('Stripe did not refund it: try again', 'Stripe 未能退款：请重试'),
  admin: () => t('Refunded by an admin', '由管理员退款'),
};
function Refunds({ rows, reload }: { rows: any[]; reload: () => Promise<unknown> }) {
  const { busy, act } = useAct();
  const open = rows.filter((r) => r.status === 'pending');
  const decide = (r: any, action: 'approve' | 'deny') => {
    const note = action === 'deny' ? prompt(t('Reason shown to the buyer', '向买家显示的原因')) : '';
    if (note === null) return;
    if (action === 'approve' && !confirm(t('Refund {price} to {buyer}?', '确定向 {buyer} 退款 {price} 吗？', { price: usd(r.price_cents), buyer: r.buyer || '—' }))) return;
    void act(r.id, async () => { await api(`/admin/refunds/${r.id}`, { body: { action, note } }); await reload(); }, action === 'approve' ? t('Refunded.', '已退款。') : t('Declined. The buyer was told why.', '已拒绝，并已告知买家原因。'));
  };
  const restore = (r: any) => act('rv' + r.user_id, async () => { await api(`/admin/users/${r.user_id}/refund-review`, { body: { on: false } }); await reload(); }, t('Self-service refunds are back on for this account.', '已为该账户恢复自助退款。'));
  return (
    <Card title={t('Refunds', '退款')} actions={open.length > 0 ? <Badge tone="accent">{open.length} {t('waiting', '笔待处理')}</Badge> : undefined}>
      {rows.length ? <Table stickyEnd><thead><tr><th>{t('Game', '游戏')}</th><th>{t('Buyer', '买家')}</th><th className="n">{t('Price', '价格')}</th><th>{t('Played', '已游玩')}</th><th>{t('Asked', '申请时间')}</th><th>{t('Status', '状态')}</th><th>{t('Books', '账目')}</th><th /></tr></thead>
        <tbody>{rows.map((r) => <tr key={r.id}>
          <td><Link to={`/g/${r.slug}`}>{r.title}</Link>{r.note && <div className="mute fs-sm" style={{ maxWidth: 280, whiteSpace: 'pre-wrap' }}>“{r.note}”</div>}</td>
          <td className="mute">{r.buyer || '—'}{r.buyer_review_at && <div><Badge dot={false} tone="accent">{t('no self-service', '无自助退款')}</Badge></div>}</td>
          <td className="n">{usd(r.price_cents)}</td>
          <td className="mute">{t('{n} min', '{n} 分钟', { n: Math.floor((r.played_seconds || 0) / 60) })} · {t('bought {when}', '购买于 {when}', { when: dateTime(r.bought_at) })}</td>
          <td className="mute">{dateTime(r.created_at)}</td>
          <td><StatusBadge status={r.status} />{r.review_reason && REVIEW[r.review_reason] && <div className="mute fs-sm">{REVIEW[r.review_reason]()}</div>}{r.decided_by && <div className="dim fs-xs">{r.decided_by === 'auto' ? t('automatic', '自动') : r.decided_by.startsWith('admin:') ? t('by an admin', '由管理员') : t('from Stripe', '来自 Stripe')}</div>}{r.decision_note && <div className="mute fs-sm">{r.decision_note}</div>}</td>
          <td className="mute fs-sm">{r.status === 'refunded' && r.creator_net_cents != null ? <>
            {t('Creator −{amount}', '创作者 −{amount}', { amount: usd(r.creator_net_cents) })} · {t('Platform cut −{amount}', '平台分成 −{amount}', { amount: usd(r.platform_fee_cents || 0) })}
            {r.stripe_fee_cents != null && <div>{t('Stripe fee {amount}, borne by the {who}', 'Stripe 手续费 {amount}，由{who}承担', { amount: usd(r.stripe_fee_cents), who: r.fee_bearer === 'creator' ? t('creator', '创作者') : t('platform', '平台') })}</div>}
            {r.transfer_reversal_cents > 0 && <div>{t('{amount} taken back from payout {ref}', '已从打款 {ref} 收回 {amount}', { amount: usd(r.transfer_reversal_cents), ref: r.transfer_ref })}</div>}
          </> : '—'}</td>
          <td>{r.status === 'pending' ? <div className="row-actions"><Button size="sm" variant="primary" disabled={busy === r.id} onClick={() => decide(r, 'approve')}>{t('Refund', '退款')}</Button><Button size="sm" variant="danger" disabled={busy === r.id} onClick={() => decide(r, 'deny')}>{t('Decline', '拒绝')}</Button></div>
            : r.buyer_review_at ? <Button size="sm" disabled={busy === 'rv' + r.user_id} onClick={() => restore(r)}>{t('Restore self-service', '恢复自助退款')}</Button> : null}</td>
        </tr>)}</tbody></Table> : <div className="pad mute">{t('No refunds yet.', '暂无退款。')}</div>}
    </Card>
  );
}

// Players' reports of other players (the friends panel's Report). Open ones first; each shows the recent messages the
// reporter's chat held with the player, and lets the moderator close it, or suspend the player from the Users tab.
const REASONS = (): Record<string, string> => ({ harassment: t('Harassment or bullying', '骚扰或欺凌'), spam: t('Spam or scams', '垃圾信息或诈骗'), hate: t('Hate speech', '仇恨言论'), cheating: t('Cheating', '作弊'), name: t('Offensive name', '不当名称'), other: t('Something else', '其他') });
function Reports() {
  const [closed, setClosed] = useState(false), { busy, act } = useAct();
  const { data, error, loading, reload } = useData<any>(`/admin/social-reports${closed ? '?status=closed' : ''}`);
  const set = (r: any, status: string) => act(String(r.id), async () => { await api(`/admin/social-reports/${r.id}`, { body: { status } }); await reload(); }, t('Updated.', '已更新。'));
  const suspend = (r: any) => act(String(r.id), async () => { await api(`/admin/users/${r.target.id}`, { method: 'PATCH', body: { status: 'suspended' } }); await api(`/admin/social-reports/${r.id}`, { body: { status: 'actioned' } }); await reload(); }, t('Player suspended.', '已停用该玩家。'));
  return (
    <div className="stack l">
      <div className="admin-tools row"><label className="row fs-sm"><Switch checked={closed} onChange={(e) => setClosed(e.target.checked)} /> {t('Show closed reports', '显示已处理的举报')}</label></div>
      {error && !data ? <Fail error={error} retry={reload} /> : loading && !data ? <AdminSkeleton tab="table" /> : !data.reports.length ? <Card pad><span className="mute">{closed ? t('No closed reports.', '没有已处理的举报。') : t('No open reports.', '没有待处理的举报。')}</span></Card> : (
        <div className="stack">{data.reports.map((r: any) => (
          <Card key={r.id} pad>
            <div className="stack s">
              <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
                <span><b>{r.target.name}</b> <span className="mute fs-sm">{r.target.email}</span> {r.target.status !== 'active' && <Badge tone="bad">{r.target.status}</Badge>} {r.target.reports > 1 && <Badge tone="accent">{t('{n} reports', '{n} 次举报', { n: r.target.reports })}</Badge>}</span>
                <span className="mute fs-sm">{dateTime(r.created_at)}</span>
              </div>
              <div><Badge>{REASONS()[r.reason] || r.reason}</Badge> <span className="fs-sm">{t('by {name}', '举报人：{name}', { name: r.reporter.name })} <span className="mute">{r.reporter.email}</span></span></div>
              {r.detail && <p style={{ whiteSpace: 'pre-wrap' }}>{r.detail}</p>}
              {r.messages.length > 0 && <div className="stack s fs-sm" style={{ borderLeft: '3px solid var(--line-2)', paddingLeft: 12 }}>{r.messages.map((m: any, i: number) => <div key={i}><b>{m.from === r.target.id ? r.target.name : r.reporter.name}:</b> {m.body} <span className="dim">{ago(m.at)}</span></div>)}</div>}
              <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                {r.status === 'open' ? <>
                  <Button size="sm" variant="ghost" disabled={busy === String(r.id)} onClick={() => void set(r, 'dismissed')}>{t('Dismiss', '驳回')}</Button>
                  <Button size="sm" variant="secondary" disabled={busy === String(r.id)} onClick={() => void set(r, 'actioned')}>{t('Mark handled', '标记为已处理')}</Button>
                  {r.target.status === 'active' && <Button size="sm" variant="danger" disabled={busy === String(r.id)} onClick={() => { if (confirm(t('Suspend {name}? They are signed out everywhere.', '要停用 {name} 吗？对方将在所有设备上退出登录。', { name: r.target.name }))) void suspend(r); }}>{t('Suspend player', '停用该玩家')}</Button>}
                </> : <><StatusBadge status={r.status} /><Button size="sm" variant="ghost" disabled={busy === String(r.id)} onClick={() => void set(r, 'open')}>{t('Reopen', '重新打开')}</Button></>}
              </div>
            </div>
          </Card>))}</div>
      )}
    </div>
  );
}
