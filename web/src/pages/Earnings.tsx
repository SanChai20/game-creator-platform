import { useEffect, useState } from 'react';
import { api, dateTime, Fail, Link, Modal, navigate, query, Spinner, StatusBadge, t, usd, useAct, useApp, useData } from '../lib';
import { ConsoleTabs } from './Console';

// Countries where Stripe can pay out to a connected account. The creator picks where their bank is.
const COUNTRIES = 'US United States,GB United Kingdom,CA Canada,AU Australia,NZ New Zealand,SG Singapore,HK Hong Kong,JP Japan,DE Germany,FR France,ES Spain,IT Italy,NL Netherlands,BE Belgium,AT Austria,CH Switzerland,IE Ireland,PT Portugal,SE Sweden,NO Norway,DK Denmark,FI Finland,PL Poland,CZ Czechia,RO Romania,BG Bulgaria,GR Greece,HU Hungary,HR Croatia,SK Slovakia,SI Slovenia,EE Estonia,LV Latvia,LT Lithuania,LU Luxembourg,MT Malta,CY Cyprus,MX Mexico,BR Brazil,TH Thailand,MY Malaysia,AE United Arab Emirates,IN India,ID Indonesia,PH Philippines,KR South Korea,TW Taiwan,VN Vietnam,TR Türkiye,ZA South Africa,IL Israel,CL Chile,CO Colombia,PE Peru,AR Argentina'.split(',').map((x) => [x.slice(0, 2), x.slice(3)]);

export function Earnings() {
  const { toast, refresh } = useApp(), { busy, act } = useAct();
  const { data, error, loading, reload } = useData<any>('/console/earnings');
  const [country, setCountry] = useState('US'), [manual, setManual] = useState(false), [details, setDetails] = useState('');

  useEffect(() => {
    const p = query().get('payout'); if (!p) return;
    navigate('/console/earnings', true);
    api<{ payouts_enabled: boolean }>('/billing/payout-account/refresh', { method: 'POST' }).then(async (r) => {
      toast(r.payouts_enabled ? t('Payout account ready.', '收款账户已就绪。') : t('Your payout account still needs a few details.', '收款账户还需要补充一些信息。'), !r.payouts_enabled); await refresh(); await reload();
    }, (e) => toast((e as Error).message, true));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (error && !data) return <div className="wrap page"><Fail error={error} retry={reload} /></div>;
  if (loading && !data) return <Spinner />;
  const b = data.balance, u = data.user, ready = u.payouts_enabled, enough = b.available >= data.min_cents;
  const pending = data.withdrawals.some((w: any) => w.status === 'pending');
  const setup = () => act('acct', async () => { const r = await api<{ url: string }>('/billing/payout-account', { body: { country } }); location.href = r.url; });
  const withdraw = (method: 'stripe' | 'manual') => act('wd', async () => { await api('/billing/withdraw', { body: { method, details } }); setManual(false); setDetails(''); await reload(); },
    method === 'stripe' ? t('Withdrawal sent to your payout account.', '提现已发送至你的收款账户。') : t('Withdrawal requested. An administrator will send it.', '已提交提现申请，管理员将为你打款。'));
  const kinds: Record<string, string> = { sale: t('Sale', '销售'), refund: t('Refund', '退款'), withdrawal: t('Withdrawal', '提现'), withdrawal_reversal: t('Withdrawal returned', '提现退回'), adjustment: t('Adjustment', '调整') };

  return (
    <div className="wrap page">
      <div className="page-h"><div className="stack"><span className="eyebrow">{t('Console', '控制台')}</span><h1>{t('Earnings', '收益')}</h1></div></div>
      <ConsoleTabs on="earnings" />
      <div className="stack l">
        <div className="stats">
          <div className="stat"><span className="eyebrow sig">{t('Available to withdraw', '可提现余额')}</span><b>{usd(b.available)}</b><small>{t('Minimum', '最低提现额')} {usd(data.min_cents)}</small></div>
          <div className="stat"><span className="eyebrow">{t('Pending', '待结算')}</span><b>{usd(b.pending)}</b><small>{t(`Sales clear after ${data.hold_days} days`, `销售收入在 ${data.hold_days} 天后可提现`)}</small></div>
          <div className="stat"><span className="eyebrow">{t('Your share', '你的分成')}</span><b>{100 - data.fee_percent}%</b><small>{t(`The platform keeps ${data.fee_percent}% of each sale`, `平台从每笔销售中收取 ${data.fee_percent}%`)}</small></div>
        </div>

        <div className="cols">
          <div className="stack l">
            <div className="card">
              <header><h3>{t('Withdraw', '提现')}</h3></header>
              <div className="pad stack l">
                {!data.payments && !data.manual ? <div className="notice">{t('Withdrawals are not open yet on this platform. Your balance is safe and keeps adding up.', '平台暂未开放提现。你的余额是安全的，并会持续累计。')}</div> : (
                  <>
                    {pending && <div className="notice">{t('A withdrawal is in progress. You can request another once it settles.', '有一笔提现正在处理中，完成后才能再次申请。')}</div>}
                    {!enough && !pending && <div className="notice">{t(`You can withdraw once your available balance reaches ${usd(data.min_cents)}. You are ${usd(Math.max(0, data.min_cents - b.available))} away.`, `可提现余额达到 ${usd(data.min_cents)} 后即可提现，还差 ${usd(Math.max(0, data.min_cents - b.available))}。`)}</div>}
                    {data.payments && (ready ? (
                      <div className="row wrapx"><div className="grow"><b>{t('Bank payout through Stripe', '通过 Stripe 提现至银行账户')}</b><div className="mute" style={{ fontSize: 13.5 }}>{t('Your payout account is ready', '收款账户已就绪')}{u.payout_country ? ` · ${u.payout_country}` : ''}</div></div>
                        <button className="btn pri" disabled={!enough || pending || busy === 'wd'} onClick={() => withdraw('stripe')}>{t('Withdraw', '提现')} {usd(b.available)}</button></div>
                    ) : (
                      <div className="stack">
                        <b>{u.has_payout_account ? t('Finish setting up your payout account', '完成收款账户设置') : t('Set up a payout account', '设置收款账户')}</b>
                        <p className="mute" style={{ fontSize: 13.5 }}>{t('Payouts go to your bank account through Stripe, which verifies your identity. This takes a few minutes and is done once.', '款项将通过 Stripe 打入你的银行账户，Stripe 会核实你的身份。整个过程只需几分钟，且只需完成一次。')}</p>
                        <div className="row wrapx">
                          {!u.has_payout_account && <select className="input" style={{ maxWidth: 260 }} value={country} onChange={(e) => setCountry(e.target.value)} aria-label={t('Country of your bank account', '银行账户所在国家/地区')}>{COUNTRIES.map(([c, n]) => <option key={c} value={c}>{n}</option>)}</select>}
                          <button className="btn pri" onClick={setup} disabled={busy === 'acct'}>{u.has_payout_account ? t('Continue setup', '继续设置') : t('Set up payouts', '开始设置')}</button>
                        </div>
                      </div>
                    ))}
                    {data.manual && <div className="row wrapx" style={{ borderTop: data.payments ? '1px solid var(--line)' : 0, paddingTop: data.payments ? 18 : 0 }}>
                      <div className="grow"><b>{t('Another method', '其他方式')}</b><div className="mute" style={{ fontSize: 13.5 }}>{t('Tell us where to send it (for example PayPal, Wise or a bank transfer). An administrator pays it by hand.', '告诉我们收款方式（例如 PayPal、Wise 或银行转账），由管理员人工打款。')}</div></div>
                      <button className="btn" disabled={!enough || pending} onClick={() => setManual(true)}>{t('Request', '申请')}</button></div>}
                  </>
                )}
              </div>
            </div>

            <div className="card">
              <header><h3>{t('History', '收支记录')}</h3></header>
              {data.ledger.length ? <div className="tbl-wrap"><table className="tbl"><thead><tr><th>{t('When', '时间')}</th><th>{t('What', '类型')}</th><th>{t('Note', '说明')}</th><th className="n">{t('Amount', '金额')}</th></tr></thead>
                <tbody>{data.ledger.map((l: any, i: number) => <tr key={i}><td className="mute" style={{ whiteSpace: 'nowrap' }}>{dateTime(l.created_at)}</td><td>{kinds[l.kind] || l.kind}{l.amount_cents > 0 && l.available_at > Date.now() && <span className="badge sig plain" style={{ marginLeft: 8 }}>{t('pending', '待结算')}</span>}</td><td className="mute">{l.note}</td><td className={'n ' + (l.amount_cents >= 0 ? 'good' : '')}>{l.amount_cents > 0 ? '+' : ''}{usd(l.amount_cents)}</td></tr>)}</tbody></table></div>
                : <div className="pad mute">{t('Nothing yet. Earnings from paid games appear here.', '暂无记录。付费游戏的收入会显示在这里。')}</div>}
            </div>
          </div>

          <div className="stack l">
            <div className="card">
              <header><h3>{t('By game', '按游戏统计')}</h3></header>
              {data.by_game.length ? <div className="tbl-wrap"><table className="tbl"><thead><tr><th>{t('Game', '游戏')}</th><th className="n">{t('Sales', '销量')}</th><th className="n">{t('You earned', '你的收益')}</th></tr></thead>
                <tbody>{data.by_game.map((g: any) => <tr key={g.slug}><td><Link to={`/g/${g.slug}`}>{g.title}</Link></td><td className="n">{g.n}</td><td className="n">{usd(g.net)}</td></tr>)}</tbody></table></div>
                : <div className="pad mute">{t('No sales yet. Set a price on a game from its project page.', '还没有销售。可以在项目页面为游戏设置价格。')}</div>}
            </div>
            <div className="card">
              <header><h3>{t('Withdrawals', '提现记录')}</h3></header>
              {data.withdrawals.length ? data.withdrawals.map((w: any) => (
                <div className="proj" style={{ gridTemplateColumns: 'minmax(0,1fr) auto' }} key={w.id}>
                  <div><b className="num">{usd(w.amount_cents)}</b><div className="mute" style={{ fontSize: 13 }}>{dateTime(w.created_at)} · {w.method === 'stripe' ? 'Stripe' : t('manual', '人工')}{w.error ? ` · ${w.error}` : ''}</div></div><StatusBadge status={w.status} />
                </div>)) : <div className="pad mute">{t('No withdrawals yet.', '暂无提现记录。')}</div>}
            </div>
          </div>
        </div>
      </div>

      {manual && <Modal onClose={() => setManual(false)}><div className="stack l">
        <h3 style={{ fontSize: 22 }}>{t('Request a withdrawal of', '申请提现')} {usd(b.available)}</h3>
        <label className="field"><span>{t('Where should it be sent?', '款项应汇往何处？')}</span><textarea className="input" value={details} onChange={(e) => setDetails(e.target.value)} maxLength={500} placeholder={t('For example: PayPal name@example.com, or bank name, account holder, IBAN and SWIFT.', '例如：PayPal 账号 name@example.com，或银行名称、户名、账号与 SWIFT 代码。')} autoFocus /></label>
        <div className="row"><button className="btn pri" disabled={details.trim().length < 8 || busy === 'wd'} onClick={() => withdraw('manual')}>{t('Send request', '提交申请')}</button><button className="btn ghost" onClick={() => setManual(false)}>{t('Cancel', '取消')}</button></div>
      </div></Modal>}
    </div>
  );
}
