import { useEffect, useState } from 'react';
import { ago, api, bytes, dateTime, Fail, num, playTime, series, Stars, t, usd, useAct, useApp, useData, count } from '../lib';
import { Badge, Bars, Button, Card, ChartBlock, CheckRow, EmptyState, Input, KeyValue, Modal, Notice, PageHeader, Spinner, Stat, StatGrid, StatusBadge, Table } from '../ui';
import { Stage } from './Game';

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

export function Project({ id }: { id: string }) {
  const { config } = useApp(), { busy, act } = useAct(), s = config.settings;
  const { data, error, loading, reload } = useData<any>(`/console/projects/${id}`);
  const [open, setOpen] = useState<number | null>(null), [preview, setPreview] = useState<string | null>(null), [priceText, setPriceText] = useState<string | null>(null);

  // While a deployment is running, keep the page fresh.
  const working = !!data?.versions.some((v: any) => ['queued', 'deploying', 'verifying'].includes(v.status));
  useEffect(() => { if (!working) return; const i = setInterval(() => void reload(), 4000); return () => clearInterval(i); }, [working, reload]);
  useEffect(() => { if (data && open === null && data.versions[0]) setOpen(data.versions[0].version); }, [data]); // eslint-disable-line react-hooks/exhaustive-deps

  if (error && !data) return <div className="wrap page"><Fail error={error} retry={reload} /></div>;
  if (loading && !data) return <Spinner />;
  const p = data.project, versions = data.versions as any[];
  const playPreview = () => act('pv', async () => { const r = await api<{ url: string }>(`/console/projects/${id}/preview`, { method: 'POST' }); setPreview(r.url); });
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
      {p.status === 'removed' && <div style={{ marginBottom: 22 }}><Notice tone="bad">{t('This game was removed by the platform.', '该游戏已被平台移除。')} {p.removed_reason}</Notice></div>}

      <div className="stack l">
        <StatGrid>
          <Stat label={t('Plays', '游玩次数')} value={num(p.plays)} sub={`${num(sum30('plays'))} ${t('in 30 days', '近 30 天')}`} />
          <Stat label={t('Time played', '游玩时长')} value={playTime(p.minutes * 60)} sub={`${playTime(sum30('seconds'))} ${t('in 30 days', '近 30 天')}`} />
          <Stat label={t('Rating', '评分')} value={p.rating != null ? p.rating.toFixed(1) : '—'} sub={count(p.rating_count, 'rating', 'ratings', '个评分')} />
          <Stat tone="accent" label={t('Sales', '销量')} value={num(data.sales.n)} sub={`${usd(data.sales.net)} ${t('to you', '归你所得')} · ${usd(data.sales.gross)} ${t('gross', '总额')}`} />
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

            {!!data.errors.length && <Card title={t('Errors players hit', '玩家遇到的错误')}>
              <Table><thead><tr><th>{t('Message', '信息')}</th><th>{t('Version', '版本')}</th><th className="n">{t('Count', '次数')}</th><th className="n">{t('Last seen', '最近出现')}</th></tr></thead>
                <tbody>{data.errors.map((e: any, i: number) => <tr key={i}><td className="mono bad fs-sm" style={{ wordBreak: 'break-word' }}>{e.message}</td><td>v{e.version} · {e.env}</td><td className="n">{e.count}</td><td className="n">{ago(e.last_at)}</td></tr>)}</tbody></Table>
            </Card>}
          </div>

          <div className="stack l">
            <Card title={t('Price', '价格')} pad>
              {priceText === null ? (
                <div className="row"><b className="price-big">{p.price_cents > 0 ? usd(p.price_cents) : t('Free', '免费')}</b>{s.paid_games_enabled && <Button size="sm" className="right" onClick={() => setPriceText((p.price_cents / 100).toFixed(2))}>{t('Change', '修改')}</Button>}</div>
              ) : (
                <div className="price-edit"><span className="mute">$</span><Input mono inputMode="decimal" value={priceText} onChange={(e) => setPriceText(e.target.value)} autoFocus aria-label={t('Price in US dollars', '美元价格')} /><Button variant="primary" onClick={savePrice} disabled={busy === 'price'}>{t('Save', '保存')}</Button><Button variant="ghost" onClick={() => setPriceText(null)}>{t('Cancel', '取消')}</Button></div>
              )}
              {data.split ? <KeyValue items={[[t('Platform fee', '平台服务费'), usd(data.split.fee)], [t('You receive per sale', '每笔销售你获得'), usd(data.split.net), 'good']]} />
                : <p className="mute fs-sm">{s.paid_games_enabled ? t(`Free to play. Set a price between ${usd(s.game_price_min_cents)} and ${usd(s.game_price_max_cents)} to sell it; the platform keeps ${s.platform_fee_percent}% of each sale.`, `目前免费。可在 ${usd(s.game_price_min_cents)} 至 ${usd(s.game_price_max_cents)} 之间定价销售，平台从每笔销售中收取 ${s.platform_fee_percent}%。`) : t('Paid games are turned off on this platform.', '平台暂未开放付费游戏。')}</p>}
            </Card>
            <Card title={t('Details', '详情')} pad>
              <KeyValue items={[
                [t('Address', '地址'), `/g/${p.slug}`, 'mono'],
                [t('Working files', '工作区文件'), `${data.files.count} · ${bytes(data.files.bytes)}`],
                [t('Tags', '标签'), p.tags.join(', ') || '—'],
                [t('Rating', '评分'), <Stars rating={p.rating} count={p.rating_count} />],
                [t('Project id', '项目 ID'), p.id, 'mono'],
              ]} />
            </Card>
            <Card title={t('Activity', '动态')} pad>
              {data.events.length ? <div>{data.events.slice(0, 14).map((e: any, i: number) => (
                <div key={i} className="activity"><Badge dot={false}>{e.kind}</Badge><span className="mute" style={{ wordBreak: 'break-word' }}>{e.version ? `v${e.version} ` : ''}{e.detail}</span><span className="dim" style={{ whiteSpace: 'nowrap' }}>{ago(e.created_at)}</span></div>
              ))}</div> : <span className="mute">{t('Nothing yet.', '暂无动态。')}</span>}
            </Card>
          </div>
        </div>
      </div>

      {preview && <Modal wide onClose={() => { setPreview(null); void reload(); }}><div className="stack">
        <div className="row"><b>{p.title}</b><Badge tone="info">{t('Preview', '预览')} v{p.preview_version}</Badge><Button size="sm" className="right" onClick={() => { setPreview(null); void reload(); }}>{t('Close', '关闭')}</Button></div>
        <Stage poster={null} seed={p.slug} url={preview} />
        <p className="dim fs-sm">{t('Only you can open the preview. Playing it without errors also counts as verification when the automatic check cannot run the game.', '预览仅你本人可见。当自动检查无法运行游戏时，你无错误地试玩一段时间也算通过验证。')}</p>
      </div></Modal>}
    </div>
  );
}
