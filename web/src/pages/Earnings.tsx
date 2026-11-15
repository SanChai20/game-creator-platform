import { useEffect, useState } from 'react';
import { api, dateTime, Fail, Link, navigate, query, t, usd, useAct, useApp, useData } from '../lib';
import { Badge, Button, Card, Field, ListRow, Modal, Notice, PageHeader, Select, Spinner, Stat, StatGrid, StatusBadge, Table, Textarea } from '../ui';
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
      <PageHeader eyebrow={t('Console', '控制台')} title={t('Earnings', '收益')} />
      <ConsoleTabs on="earnings" />
      <div className="stack l">
        <StatGrid>
          <Stat icon="coin" tone="accent" label={t('Available to withdraw', '可提现余额')} value={usd(b.available)} sub={`${t('Minimum', '最低提现额')} ${usd(data.min_cents)}`} />
          <Stat icon="clock" label={t('Pending', '待结算')} value={usd(b.pending)} sub={t('Sales clear after {n} days', '销售收入在 {n} 天后可提现', { n: data.hold_days })} />
          <Stat icon="trophy" label={t('Your share', '你的分成')} value={`${100 - data.fee_percent}%`} sub={t('The platform keeps {cut}% of each sale', '平台从每笔销售中收取 {cut}%', { cut: data.fee_percent })} />
        </StatGrid>

        <div className="cols">
          <div className="stack l">
            <Card title={t('Withdraw', '提现')} pad>
              <div className="stack l">
                {!data.payments && !data.manual ? <Notice>{t('Withdrawals are not open yet on this platform. Your balance is safe and keeps adding up.', '平台暂未开放提现。你的余额是安全的，并会持续累计。')}</Notice> : (
                  <>
                    {pending && <Notice tone="info">{t('A withdrawal is in progress. You can request another once it settles.', '有一笔提现正在处理中，完成后才能再次申请。')}</Notice>}
                    {!enough && !pending && <Notice>{t('You can withdraw once your available balance reaches {min}. You are {available} away.', '可提现余额达到 {min} 后即可提现，还差 {available}。', { min: usd(data.min_cents), available: usd(Math.max(0, data.min_cents - b.available)) })}</Notice>}
                    {data.payments && (ready ? (
                      <div className="row wrapx"><div className="grow"><b>{t('Bank payout through Stripe', '通过 Stripe 提现至银行账户')}</b><div className="mute fs-sm">{t('Your payout account is ready', '收款账户已就绪')}{u.payout_country ? ` · ${u.payout_country}` : ''}</div></div>
                        <Button variant="primary" data-fx-burst="coins" disabled={!enough || pending || busy === 'wd'} onClick={() => withdraw('stripe')}>{t('Withdraw', '提现')} {usd(b.available)}</Button></div>
                    ) : (
                      <div className="stack">
                        <b>{u.has_payout_account ? t('Finish setting up your payout account', '完成收款账户设置') : t('Set up a payout account', '设置收款账户')}</b>
                        <p className="mute fs-sm">{t('Payouts go to your bank account through Stripe, which verifies your identity. This takes a few minutes and is done once.', '款项将通过 Stripe 打入你的银行账户，Stripe 会核实你的身份。整个过程只需几分钟，且只需完成一次。')}</p>
                        <div className="row wrapx">
                          {!u.has_payout_account && <Select style={{ maxWidth: 260 }} value={country} onChange={(e) => setCountry(e.target.value)} aria-label={t('Country of your bank account', '银行账户所在国家/地区')}>{COUNTRIES.map(([c, n]) => <option key={c} value={c}>{n}</option>)}</Select>}
                          <Button variant="primary" onClick={setup} disabled={busy === 'acct'}>{u.has_payout_account ? t('Continue setup', '继续设置') : t('Set up payouts', '开始设置')}</Button>
                        </div>
                      </div>
                    ))}
                    {data.manual && <div className="row wrapx" style={{ borderTop: data.payments ? '1px solid var(--line)' : 0, paddingTop: data.payments ? 18 : 0 }}>
                      <div className="grow"><b>{t('Another method', '其他方式')}</b><div className="mute fs-sm">{t('Tell us where to send it (for example PayPal, Wise or a bank transfer). An administrator pays it by hand.', '告诉我们收款方式（例如 PayPal、Wise 或银行转账），由管理员人工打款。')}</div></div>
                      <Button disabled={!enough || pending} onClick={() => setManual(true)}>{t('Request', '申请')}</Button></div>}
                  </>
                )}
              </div>
            </Card>

            <Card title={t('History', '收支记录')}>
              {data.ledger.length ? <Table><thead><tr><th>{t('When', '时间')}</th><th>{t('What', '类型')}</th><th>{t('Note', '说明')}</th><th className="n">{t('Amount', '金额')}</th></tr></thead>
                <tbody>{data.ledger.map((l: any, i: number) => <tr key={i}><td className="mute" style={{ whiteSpace: 'nowrap' }}>{dateTime(l.created_at)}</td><td><span className="row s">{kinds[l.kind] || l.kind}{l.amount_cents > 0 && l.available_at > Date.now() && <Badge tone="accent" dot={false}>{t('pending', '待结算')}</Badge>}</span></td><td className="mute">{l.note}</td><td className={'n ' + (l.amount_cents >= 0 ? 'good' : '')}>{l.amount_cents > 0 ? '+' : ''}{usd(l.amount_cents)}</td></tr>)}</tbody></Table>
                : <div className="pad mute">{t('Nothing yet. Earnings from paid games appear here.', '暂无记录。付费游戏的收入会显示在这里。')}</div>}
            </Card>
          </div>

          <div className="stack l">
            <Card title={t('By game', '按游戏统计')}>
              {data.by_game.length ? <Table><thead><tr><th>{t('Game', '游戏')}</th><th className="n">{t('Sales', '销量')}</th><th className="n">{t('You earned', '你的收益')}</th></tr></thead>
                <tbody>{data.by_game.map((g: any) => <tr key={g.slug}><td><Link to={`/g/${g.slug}`}>{g.title}</Link></td><td className="n">{g.n}</td><td className="n">{usd(g.net)}</td></tr>)}</tbody></Table>
                : <div className="pad mute">{t('No sales yet. Set a price on a game from its project page.', '还没有销售。可以在项目页面为游戏设置价格。')}</div>}
            </Card>
            <Card title={t('Withdrawals', '提现记录')}>
              {data.withdrawals.length ? data.withdrawals.map((w: any) => (
                <ListRow key={w.id} title={<b className="num">{usd(w.amount_cents)}</b>} meta={<>{dateTime(w.created_at)} · {w.method === 'stripe' ? 'Stripe' : t('manual', '人工')}{w.error ? ` · ${w.error}` : ''}</>} tail={<StatusBadge status={w.status} />} />
              )) : <div className="pad mute">{t('No withdrawals yet.', '暂无提现记录。')}</div>}
            </Card>
          </div>
        </div>
      </div>

      {manual && <Modal onClose={() => setManual(false)}><div className="stack l">
        <h3 style={{ fontSize: 22 }}>{t('Request a withdrawal of', '申请提现')} {usd(b.available)}</h3>
        <Field label={t('Where should it be sent?', '款项应汇往何处？')}><Textarea value={details} onChange={(e) => setDetails(e.target.value)} maxLength={500} placeholder={t('For example: PayPal name@example.com, or bank name, account holder, IBAN and SWIFT.', '例如：PayPal 账号 name@example.com，或银行名称、户名、账号与 SWIFT 代码。')} autoFocus /></Field>
        <div className="row"><Button variant="primary" disabled={details.trim().length < 8 || busy === 'wd'} onClick={() => withdraw('manual')}>{t('Send request', '提交申请')}</Button><Button variant="ghost" onClick={() => setManual(false)}>{t('Cancel', '取消')}</Button></div>
      </div></Modal>}
    </div>
  );
}
