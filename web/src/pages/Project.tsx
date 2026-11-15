import { useEffect, useState } from 'react';
import { ago, api, Bars, bytes, dateTime, Fail, Link, Modal, num, playTime, series, Spinner, Stars, StatusBadge, t, usd, useAct, useApp, useData, count } from '../lib';
import { Stage } from './Game';

function Report({ v }: { v: any }) {
  const r = v.report;
  if (!r) return <p className="mute">{v.status === 'verified' || v.status === 'failed' ? t('No report was stored for this version.', '该版本没有保存报告。') : t('Working on it. This page refreshes by itself.', '处理中，页面会自动刷新。')}</p>;
  return (
    <div className="stack">
      {(r.checks || []).map((c: any) => (
        <div className="check" key={c.id}><i className={c.ok ? 'ok' : 'no'}>{c.ok ? '✓' : '×'}</i><div><b>{c.label}</b>{c.detail && <div className="mute" style={{ fontSize: 13 }}>{c.detail}</div>}{!c.ok && c.hint && <div className="sig" style={{ fontSize: 13, marginTop: 4 }}>{c.hint}</div>}</div></div>
      ))}
      {r.playthrough === null && (r.checks || []).some((c: any) => c.id === 'input') && <p className="mute" style={{ fontSize: 13 }}>{t('Only start-up, rendering and input were checked. This version has no play-through script, so nothing confirmed that it can be played to the end. Ask your agent to add one.', '仅检查了启动、渲染与输入。该版本没有试玩脚本，因此无法确认游戏能否完整玩到结束。可以让你的智能体补上。')}</p>}
      {!!r.errors?.length && <div className="log">{r.errors.join('\n')}</div>}
      {!!r.missing?.length && <div className="log">{t('Files that failed to load', '加载失败的文件')}:{'\n'}{r.missing.join('\n')}</div>}
      {r.browser === 'unavailable' && <p className="mute" style={{ fontSize: 13 }}>{t('The automatic browser check could not run for this version. Play the preview yourself for a short while to verify it.', '该版本无法进行自动浏览器检查。请亲自试玩预览版一小段时间来完成验证。')}</p>}
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
      <div className="page-h">
        <div className="stack"><Link to="/console" className="eyebrow">← {t('Console', '控制台')}</Link><div className="row wrapx"><h1>{p.title}</h1><StatusBadge status={p.status} /></div>{p.tagline && <p className="mute">{p.tagline}</p>}</div>
        <div className="row wrapx right">
          {p.preview_version && <button className="btn" onClick={playPreview} disabled={busy === 'pv'}>{t('Play preview', '试玩预览')} v{p.preview_version}</button>}
          {p.status === 'live' && <Link to={`/g/${p.slug}`} className="btn">{t('Store page', '商店页面')}</Link>}
          {p.status === 'live' && <button className="btn danger" onClick={offline} disabled={busy === 'off'}>{t('Take offline', '下线')}</button>}
          {p.status === 'offline' && p.live_version && <button className="btn pri" onClick={online} disabled={busy === 'on'}>{t('Put back online', '重新上线')}</button>}
        </div>
      </div>
      {p.status === 'removed' && <div className="notice bad" style={{ marginBottom: 22 }}>{t('This game was removed by the platform.', '该游戏已被平台移除。')} {p.removed_reason}</div>}

      <div className="stack l">
        <div className="stats">
          <div className="stat"><span className="eyebrow">{t('Plays', '游玩次数')}</span><b>{num(p.plays)}</b><small>{num(sum30('plays'))} {t('in 30 days', '近 30 天')}</small></div>
          <div className="stat"><span className="eyebrow">{t('Time played', '游玩时长')}</span><b>{playTime(p.minutes * 60)}</b><small>{playTime(sum30('seconds'))} {t('in 30 days', '近 30 天')}</small></div>
          <div className="stat"><span className="eyebrow">{t('Rating', '评分')}</span><b>{p.rating != null ? p.rating.toFixed(1) : '—'}</b><small>{count(p.rating_count, 'rating', 'ratings', '个评分')}</small></div>
          <div className="stat"><span className="eyebrow">{t('Sales', '销量')}</span><b>{num(data.sales.n)}</b><small>{usd(data.sales.net)} {t('to you', '归你所得')} · {usd(data.sales.gross)} {t('gross', '总额')}</small></div>
        </div>

        <div className="cols">
          <div className="stack l">
            <div className="card">
              <header><h3>{t('Versions', '版本')}</h3><span className="dim right" style={{ fontSize: 13 }}>{t('Your agent deploys, verifies and publishes', '由智能体部署、验证并发布')}</span></header>
              {versions.length ? versions.map((v) => (
                <div className="ver" key={v.version}>
                  <button onClick={() => setOpen(open === v.version ? null : v.version)} aria-expanded={open === v.version}>
                    <b className="mono">v{v.version}</b><StatusBadge status={v.status} />
                    {p.live_version === v.version && <span className="badge good plain">{t('Live', '线上')}</span>}
                    {p.preview_version === v.version && <span className="badge info plain">{t('Preview', '预览')}</span>}
                    {v.human_ok && <span className="badge plain">{t('Verified by play', '试玩验证')}</span>}
                    <span className="mute clip grow" style={{ fontSize: 13 }}>{v.note || v.stage}</span>
                    <span className="dim" style={{ fontSize: 13, whiteSpace: 'nowrap' }}>{ago(v.created_at)}</span>
                  </button>
                  {open === v.version && (
                    <div className="body">
                      <div className="stack">{v.report?.summary && <p>{v.report.summary}</p>}<Report v={v} /></div>
                      <div className="stack">
                        {v.screenshot ? <a href={v.screenshot} target="_blank" rel="noreferrer"><img src={v.screenshot} alt={t('Verification screenshot', '验证截图')} style={{ borderRadius: 10, border: '1px solid var(--line-2)' }} /></a> : <div className="empty" style={{ padding: 24 }}>{t('No screenshot', '暂无截图')}</div>}
                        <dl className="kv">
                          <dt>{t('Files', '文件')}</dt><dd>{v.files} · {bytes(v.bytes)}</dd>
                          {v.report?.metrics && <><dt>{t('Load time', '加载耗时')}</dt><dd>{v.report.metrics.loadMs} ms</dd><dt>{t('Frame rate in check', '检查帧率')}</dt><dd>{v.report.metrics.fps} fps</dd></>}
                          <dt>{t('Created', '创建于')}</dt><dd>{dateTime(v.created_at)}</dd>
                          {v.published_at && <><dt>{t('Published', '发布于')}</dt><dd>{dateTime(v.published_at)}</dd></>}
                        </dl>
                      </div>
                    </div>
                  )}
                </div>
              )) : <div className="pad mute">{t('No version yet. Ask your agent to run deploy_preview.', '还没有版本。让你的智能体执行 deploy_preview。')}</div>}
            </div>

            <div className="card">
              <header><h3>{t('Last 30 days', '近 30 天')}</h3></header>
              <div className="pad stack l">
                <div className="stack"><span className="eyebrow">{t('Plays per day', '每日游玩次数')}</span><Bars data={plays} tip={(d) => `${d.label} · ${d.value}`} /></div>
                <div className="stack"><span className="eyebrow">{t('Minutes played per day', '每日游玩分钟数')}</span><Bars data={mins} tip={(d) => `${d.label} · ${d.value} min`} /></div>
              </div>
            </div>

            {!!data.errors.length && <div className="card">
              <header><h3>{t('Errors players hit', '玩家遇到的错误')}</h3></header>
              <div className="tbl-wrap"><table className="tbl"><thead><tr><th>{t('Message', '信息')}</th><th>{t('Version', '版本')}</th><th className="n">{t('Count', '次数')}</th><th className="n">{t('Last seen', '最近出现')}</th></tr></thead>
                <tbody>{data.errors.map((e: any, i: number) => <tr key={i}><td className="mono" style={{ fontSize: 12.5, wordBreak: 'break-word' }}>{e.message}</td><td>v{e.version} · {e.env}</td><td className="n">{e.count}</td><td className="n">{ago(e.last_at)}</td></tr>)}</tbody></table></div>
            </div>}
          </div>

          <div className="stack l">
            <div className="card">
              <header><h3>{t('Price', '价格')}</h3></header>
              <div className="pad stack">
                {priceText === null ? (
                  <div className="row"><b style={{ fontSize: 30, letterSpacing: '-.03em' }}>{p.price_cents > 0 ? usd(p.price_cents) : t('Free', '免费')}</b>{s.paid_games_enabled && <button className="btn sm right" onClick={() => setPriceText((p.price_cents / 100).toFixed(2))}>{t('Change', '修改')}</button>}</div>
                ) : (
                  <div className="row"><span className="mute">$</span><input className="input mono" inputMode="decimal" value={priceText} onChange={(e) => setPriceText(e.target.value)} autoFocus aria-label={t('Price in US dollars', '美元价格')} /><button className="btn pri" onClick={savePrice} disabled={busy === 'price'}>{t('Save', '保存')}</button><button className="btn ghost" onClick={() => setPriceText(null)}>{t('Cancel', '取消')}</button></div>
                )}
                {data.split ? <dl className="kv"><dt>{t('Platform fee', '平台服务费')}</dt><dd>{usd(data.split.fee)}</dd><dt>{t('You receive per sale', '每笔销售你获得')}</dt><dd className="good">{usd(data.split.net)}</dd></dl>
                  : <p className="mute" style={{ fontSize: 13.5 }}>{s.paid_games_enabled ? t(`Free to play. Set a price between ${usd(s.game_price_min_cents)} and ${usd(s.game_price_max_cents)} to sell it; the platform keeps ${s.platform_fee_percent}% of each sale.`, `目前免费。可在 ${usd(s.game_price_min_cents)} 至 ${usd(s.game_price_max_cents)} 之间定价销售，平台从每笔销售中收取 ${s.platform_fee_percent}%。`) : t('Paid games are turned off on this platform.', '平台暂未开放付费游戏。')}</p>}
              </div>
            </div>
            <div className="card pad stack">
              <span className="eyebrow">{t('Details', '详情')}</span>
              <dl className="kv">
                <dt>{t('Address', '地址')}</dt><dd className="mono clip">/g/{p.slug}</dd>
                <dt>{t('Working files', '工作区文件')}</dt><dd>{data.files.count} · {bytes(data.files.bytes)}</dd>
                <dt>{t('Tags', '标签')}</dt><dd>{p.tags.join(', ') || '—'}</dd>
                <dt>{t('Rating', '评分')}</dt><dd><Stars rating={p.rating} count={p.rating_count} /></dd>
                <dt>{t('Project id', '项目 ID')}</dt><dd className="mono">{p.id}</dd>
              </dl>
            </div>
            <div className="card">
              <header><h3>{t('Activity', '动态')}</h3></header>
              <div className="pad stack">{data.events.length ? data.events.slice(0, 14).map((e: any, i: number) => (
                <div key={i} className="row" style={{ alignItems: 'baseline', fontSize: 13.5 }}><span className="badge plain">{e.kind}</span><span className="grow mute" style={{ minWidth: 0, wordBreak: 'break-word' }}>{e.version ? `v${e.version} ` : ''}{e.detail}</span><span className="dim" style={{ whiteSpace: 'nowrap' }}>{ago(e.created_at)}</span></div>
              )) : <span className="mute">{t('Nothing yet.', '暂无动态。')}</span>}</div>
            </div>
          </div>
        </div>
      </div>

      {preview && <Modal wide onClose={() => { setPreview(null); void reload(); }}><div className="stack">
        <div className="row"><b>{p.title}</b><span className="badge info">{t('Preview', '预览')} v{p.preview_version}</span><button className="btn sm right" onClick={() => { setPreview(null); void reload(); }}>{t('Close', '关闭')}</button></div>
        <Stage poster={null} seed={p.slug} url={preview} />
        <p className="dim" style={{ fontSize: 13 }}>{t('Only you can open the preview. Playing it without errors also counts as verification when the automatic check cannot run the game.', '预览仅你本人可见。当自动检查无法运行游戏时，你无错误地试玩一段时间也算通过验证。')}</p>
      </div></Modal>}
    </div>
  );
}
