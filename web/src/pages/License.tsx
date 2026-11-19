// Creator licenses in the web app (the rules are in src/license.ts).
//   LicenseGate  what /console and every page under it show to an account without a valid license: a Get License button
//   License      /license, the two licenses side by side; choosing one opens Stripe Checkout, or grants a free one at once
//   LicensePass  the license as the console shows it to a creator
import { useEffect, useState } from 'react';
import { api, date, navigate, query, t, usd, useApp, type License as Lic } from '../lib';
import { Button, CelScene, Eyebrow, Notice, Spinner } from '../ui';
import '../license.css';

const DAY = 86400000;
type Plan = 'term' | 'lifetime';

/** "1 year", "2 years" or "90 days": how long a time-limited license lasts. */
export function termLength(days: number) {
  const years = days / 365;
  if (Number.isInteger(years)) return years === 1 ? t('1 year', '1 年') : t('{n} years', '{n} 年', { n: years });
  return days === 1 ? t('1 day', '1 天') : t('{n} days', '{n} 天', { n: days });
}

function useOffers() {
  const { config } = useApp(), s = config.settings;
  return {
    term: { cents: Number(s.license_term_cents) || 0, days: Math.max(1, Number(s.license_term_days) || 365) },
    lifetime: { cents: Number(s.license_lifetime_cents) || 0 },
    payments: config.payments,
  };
}

/** Asks for a license: a free one is granted at once, a paid one goes to Stripe. Resolves true when it was granted. */
async function getLicense(plan: Plan): Promise<boolean> {
  const r = await api<{ url?: string; ok?: boolean }>('/billing/license', { body: { plan } });
  if (r.url) { location.href = r.url; return false; }
  return true;
}

/** Shown instead of the console to an account that has no valid creator license. */
export function LicenseGate() {
  const { user, refresh, toast } = useApp(), offers = useOffers(), [busy, setBusy] = useState(false);
  const lic = user!.license;
  const go = async () => {
    // A free lifetime license leaves nothing to choose: the button grants it and opens the console.
    if (offers.lifetime.cents > 0) { navigate('/license'); return; }
    setBusy(true);
    try { if (await getLicense('lifetime')) { await refresh(); toast(t('Creator license active.', '创作者许可已生效。')); navigate('/console', true); } }
    catch (e) { toast((e as Error).message, true); }
    finally { setBusy(false); }
  };
  return (
    <div className="wrap page">
      <section className="lead solo ink lic-gate">
        <CelScene seed={7} />
        <div className="lead-in">
          <Eyebrow tone="accent">{t('Creator', '创作者')}</Eyebrow>
          <h1>{lic?.expired ? t('Your license has ended', '你的许可已到期') : t('Become a creator', '成为创作者')}</h1>
          <p>{lic?.expired
            ? t('Your time-limited creator license ended on {date}. Get a license to open the console again. Your live games stay live.', '你的限时创作者许可已于 {date} 到期。获取许可即可重新打开控制台。已上线的游戏会继续上线。', { date: date(lic.until) })
            : t('The console is where creators follow their games, previews, players and earnings. It opens with a creator license.', '控制台是创作者管理游戏、预览、玩家与收益的地方。获得创作者许可后即可打开。')}</p>
          <div className="row wrapx lead-actions">
            <Button variant="primary" size="lg" onClick={go} disabled={busy}>{t('Get License', '获取许可')} <em aria-hidden="true">→</em></Button>
            <Button to="/create" variant="ghost" size="lg">{t('How creating works', '了解创作流程')}</Button>
          </div>
        </div>
      </section>
    </div>
  );
}

function Plan({ plan, featured, cents, unit, name, pitch, perks, cta, busy, disabled, onPick }: {
  plan: Plan; featured?: boolean; cents: number; unit: string; name: string; pitch: string; perks: string[]; cta: string; busy: boolean; disabled: boolean; onPick: () => void;
}) {
  return (
    <article className={'lic-plan' + (featured ? ' ink featured' : '')} aria-labelledby={`lic-${plan}`}>
      {featured && <span className="lic-ribbon">{t('Best value', '最划算')}</span>}
      <header>
        <span className="lic-kind">{plan === 'lifetime' ? t('Lifetime', '永久') : t('Time-limited', '限时')}</span>
        <h2 id={`lic-${plan}`}>{name}</h2>
        <p>{pitch}</p>
      </header>
      <div className="lic-price">
        <b>{cents > 0 ? usd(cents) : t('Free', '免费')}</b>
        <span>{unit}</span>
      </div>
      <ul className="ticks">{perks.map((p) => <li key={p}>{p}</li>)}</ul>
      <Button variant={featured ? 'primary' : 'secondary'} size="lg" block onClick={onPick} disabled={disabled}>{busy ? <Spinner /> : cta}</Button>
    </article>
  );
}

/** /license: both licenses side by side. */
export function License() {
  const { user, refresh, toast } = useApp(), offers = useOffers(), [busy, setBusy] = useState<Plan | 'confirm' | null>(null);

  // Back from Stripe: the license is granted from the paid session (the webhook does the same), then the console opens.
  useEffect(() => {
    const paid = query().get('paid');
    if (!paid) { if (user?.creator) navigate('/console', true); return; }
    setBusy('confirm');
    api<{ result: string }>('/billing/confirm', { body: { session_id: paid } }).then(async (r) => {
      await refresh();
      if (r.result === 'duplicate_refunded') { toast(t('You already had a creator license, so this payment was refunded.', '你已拥有创作者许可，本次付款已退回。')); navigate('/console', true); return; }
      toast(t('Creator license active. Welcome to the console.', '创作者许可已生效，欢迎来到控制台。'));
      navigate('/console', true);
    }, (e) => { setBusy(null); navigate('/license', true); toast((e as Error).message, true); });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (busy === 'confirm' || user?.creator) return <div className="wrap page lic-wait"><Spinner /><p className="mute">{t('Activating your license…', '正在激活许可…')}</p></div>;

  const pick = async (plan: Plan) => {
    setBusy(plan);
    try { if (await getLicense(plan)) { await refresh(); toast(t('Creator license active.', '创作者许可已生效。')); navigate('/console', true); } else return; }
    catch (e) { toast((e as Error).message, true); }
    setBusy(null);
  };
  const len = termLength(offers.term.days);
  const noPay = (cents: number) => cents > 0 && !offers.payments;
  const common = [t('The creator console', '创作者控制台'), t('Publish as many games as you like', '不限数量发布游戏'), t('Sell games and withdraw earnings', '出售游戏并提现收益')];

  return (
    <div className="wrap page lic-page">
      <header className="lic-head">
        <Eyebrow tone="accent">{t('Creator license', '创作者许可')}</Eyebrow>
        <h1>{t('Choose your license', '选择你的许可')}</h1>
        <p className="mute">{t('Pay once. No subscription, nothing renews by itself.', '一次付清。不是订阅，不会自动续费。')}</p>
      </header>

      <div className="lic-plans">
        <Plan plan="term" cents={offers.term.cents} name={t('Creator · {len}', '创作者 · {len}', { len })}
          pitch={t('Everything a creator needs, for {len}.', '创作者所需的一切，为期 {len}。', { len })}
          unit={t('one-time · valid {len}', '一次性 · 有效期 {len}', { len })}
          perks={[...common, t('Valid for {len} from the day you get it', '自获取之日起 {len} 内有效', { len })]}
          cta={offers.term.cents > 0 ? t('Choose {len}', '选择 {len}', { len }) : t('Get it free', '免费获取')}
          busy={busy === 'term'} disabled={!!busy || noPay(offers.term.cents)} onPick={() => void pick('term')} />
        <Plan plan="lifetime" featured cents={offers.lifetime.cents} name={t('Creator · Lifetime', '创作者 · 永久')}
          pitch={t('Pay once and keep creating for good.', '一次付费，永久创作。')}
          unit={t('one-time · never expires', '一次性 · 永不过期')}
          perks={[...common, t('Never expires, nothing to renew', '永不过期，无需续期')]}
          cta={offers.lifetime.cents > 0 ? t('Choose lifetime', '选择永久') : t('Get it free', '免费获取')}
          busy={busy === 'lifetime'} disabled={!!busy || noPay(offers.lifetime.cents)} onPick={() => void pick('lifetime')} />
      </div>

      <div className="lic-foot">
        {(noPay(offers.term.cents) || noPay(offers.lifetime.cents)) && <Notice tone="bad">{t('Payments are not set up on this platform yet.', '平台尚未开通支付。')}</Notice>}
        <p className="dim fs-sm">{t('The two licenses cannot be converted into each other, and while one is valid you cannot buy the other. Payment by Stripe.', '两种许可不能互相转换；在一种许可有效期内，不能购买另一种。通过 Stripe 支付。')} <a href="/legal/refunds">{t('Refund policy', '退款政策')}</a></p>
      </div>
    </div>
  );
}

/** The creator's license, as the console shows it. */
export function LicensePass({ license, name }: { license: Lic; name: string }) {
  const { config } = useApp(), life = license.plan === 'lifetime';
  const left = !life && license.until ? Math.max(0, Math.ceil((license.until - Date.now()) / DAY)) : 0;
  const share = life ? 1 : Math.min(1, left / Math.max(1, Number(config.settings.license_term_days) || 365));
  return (
    <div className={'lic-pass ink' + (life ? ' life' : '')} role="group" aria-label={t('Creator license', '创作者许可')}>
      <div className="lic-seal" aria-hidden="true"><svg viewBox="0 0 40 40"><path d="M20 3l4.2 8.6 9.5 1.4-6.9 6.7 1.6 9.4L20 24.7l-8.4 4.4 1.6-9.4-6.9-6.7 9.5-1.4z" /></svg></div>
      <div className="lic-body">
        <span className="lic-eye">{t('Creator license', '创作者许可')}</span>
        <b className="lic-title">{life ? t('Lifetime', '永久') : t('Time-limited', '限时')}</b>
        <span className="lic-meta">{life ? t('Never expires', '永不过期') : t('Valid until {date} · {n} days left', '有效期至 {date} · 剩余 {n} 天', { date: date(license.until), n: left })}</span>
        {!life && <span className="lic-meter" aria-hidden="true"><i style={{ width: `${Math.max(4, Math.round(share * 100))}%` }} /></span>}
        <span className="lic-holder clip">{name}{license.since ? ` · ${t('since {date}', '始于 {date}', { date: date(license.since) })}` : ''}</span>
      </div>
    </div>
  );
}
