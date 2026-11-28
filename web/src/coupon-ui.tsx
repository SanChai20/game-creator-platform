// Coupons and keys (src/coupons.js): the console card where a creator makes discount codes and batches of free keys,
// the "Have a code?" field on a paid game's page, and the /redeem page where a key holder gets the game.
import { useState } from 'react';
import { api, date, Link, loginUrl, navigate, num, price, t, useAct, useApp, useData } from './lib';
import { Badge, Button, Card, Input, PageHeader } from './ui';
import './follow.css';

interface Discount { id: string; code: string; percent_off: number; max_uses: number; uses: number; note: string | null; expires_at: number | null; created_at: number; working: boolean }
interface KeyBatch { batch: string; note: string | null; created_at: number; count: number; used: number; off: number }
interface CouponList { price_cents: number; discounts: Discount[]; batches: KeyBatch[] }
export interface Applied { code: string; percent_off: number; price_cents: number }

const copyText = async (s: string, toast: (m: string, bad?: boolean) => void, done: string) => {
  try { await navigator.clipboard.writeText(s); toast(done); } catch { toast(t('Copying is blocked here. Select the text and copy it.', '此处无法复制，请选中文本后手动复制。'), true); }
};

/** The console card: discount codes and key batches for a paid game. */
export function CouponsCard({ id, paid }: { id: string; paid: boolean }) {
  const { toast } = useApp(), { busy, act } = useAct();
  const { data, reload } = useData<CouponList>(paid ? `/console/projects/${id}/coupons` : null);
  const [form, setForm] = useState<{ code: string; pct: string; uses: string; days: string; note: string } | null>(null);
  const [keyForm, setKeyForm] = useState<{ count: string; note: string } | null>(null);
  const [keys, setKeys] = useState<{ batch: string; list: { key: string; used: boolean; off: boolean }[] } | null>(null);
  if (!paid) return null;
  if (!data) return null;
  const create = () => form && act('cp', async () => {
    await api(`/console/projects/${id}/coupons`, { body: { code: form.code || undefined, percent_off: Number(form.pct), max_uses: Number(form.uses) || 100, days: form.days ? Number(form.days) : undefined, note: form.note } });
    setForm(null); await reload();
  }, t('The discount code is ready.', '折扣码已生成。'));
  const makeKeys = () => keyForm && act('keys', async () => {
    const r = await api<{ batch: string; codes: string[] }>(`/console/projects/${id}/coupons`, { body: { kind: 'keys', count: Number(keyForm.count), note: keyForm.note } });
    setKeyForm(null); setKeys({ batch: r.batch, list: r.codes.map((key) => ({ key, used: false, off: false })) }); await reload();
  }, t('The keys are ready. Copy them to hand out.', '激活码已生成，复制后即可发放。'));
  const off = (body: { id?: string; batch?: string }) => act('off', async () => { await api(`/console/projects/${id}/coupons/off`, { body }); await reload(); if (body.batch && keys?.batch === body.batch) setKeys(null); }, t('Switched off.', '已停用。'));
  const show = (batch: string) => act('show', async () => { if (keys?.batch === batch) { setKeys(null); return; } const r = await api<{ keys: { key: string; used: boolean; off: boolean }[] }>(`/console/projects/${id}/coupons/keys/${batch}`); setKeys({ batch, list: r.keys }); });
  return (
    <Card title={t('Discount codes and keys', '折扣码与激活码')} pad>
      <div className="stack">
        <p className="mute fs-sm">{t('Make a discount code for your community, or free single-use keys for streamers, press and giveaways. A key is not a sale: you are not paid for it.', '为你的社区生成折扣码，或为主播、媒体和抽奖生成一次性免费激活码。激活码不算销售，你不会因此获得收入。')}</p>
        <div className="row wrap-row">
          {!form && <Button size="sm" variant="primary" onClick={() => { setKeyForm(null); setForm({ code: '', pct: '20', uses: '100', days: '', note: '' }); }}>{t('New discount code', '新建折扣码')}</Button>}
          {!keyForm && <Button size="sm" onClick={() => { setForm(null); setKeyForm({ count: '10', note: '' }); }}>{t('Make keys', '生成激活码')}</Button>}
          <Link to="/redeem" className="dim fs-sm">{t('Players redeem keys at /redeem', '玩家在 /redeem 兑换激活码')}</Link>
        </div>
        {form && (
          <div className="stack s">
            <div className="row wrap-row">
              <Input mono value={form.code} maxLength={24} onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '') })} placeholder={t('Code (made up if empty)', '折扣码（留空则自动生成）')} aria-label={t('Code', '折扣码')} autoFocus />
              <label className="row fs-sm">{t('% off', '折扣 %')} <Input mono inputMode="numeric" value={form.pct} onChange={(e) => setForm({ ...form, pct: e.target.value.replace(/[^0-9]/g, '') })} style={{ width: '4em' }} /></label>
              <label className="row fs-sm">{t('Uses', '次数')} <Input mono inputMode="numeric" value={form.uses} onChange={(e) => setForm({ ...form, uses: e.target.value.replace(/[^0-9]/g, '') })} style={{ width: '5em' }} /></label>
              <label className="row fs-sm">{t('Days', '天数')} <Input mono inputMode="numeric" value={form.days} placeholder="∞" onChange={(e) => setForm({ ...form, days: e.target.value.replace(/[^0-9]/g, '') })} style={{ width: '4em' }} /></label>
            </div>
            <Input value={form.note} maxLength={80} onChange={(e) => setForm({ ...form, note: e.target.value })} placeholder={t('Who it is for (only you see this)', '用途备注（仅你可见）')} aria-label={t('Note', '备注')} />
            {Number(form.pct) >= 5 && Number(form.pct) <= 90 && <span className="dim fs-sm">{t('Buyers pay {price}.', '买家支付 {price}。', { price: price(Math.max(Math.min(50, data.price_cents), Math.round(data.price_cents * (100 - Number(form.pct)) / 100))) })}</span>}
            <div className="row"><Button size="sm" variant="primary" onClick={() => void create()} disabled={busy === 'cp' || !(Number(form.pct) >= 5 && Number(form.pct) <= 90)}>{t('Create', '创建')}</Button><Button size="sm" variant="ghost" onClick={() => setForm(null)}>{t('Cancel', '取消')}</Button></div>
          </div>
        )}
        {keyForm && (
          <div className="stack s">
            <div className="row wrap-row">
              <label className="row fs-sm">{t('How many', '数量')} <Input mono inputMode="numeric" value={keyForm.count} onChange={(e) => setKeyForm({ ...keyForm, count: e.target.value.replace(/[^0-9]/g, '') })} style={{ width: '5em' }} autoFocus /></label>
              <Input value={keyForm.note} maxLength={80} onChange={(e) => setKeyForm({ ...keyForm, note: e.target.value })} placeholder={t('Who they are for, such as Streamers', '用途，例如：主播')} aria-label={t('Note', '备注')} />
            </div>
            <div className="row"><Button size="sm" variant="primary" onClick={() => void makeKeys()} disabled={busy === 'keys' || !(Number(keyForm.count) >= 1 && Number(keyForm.count) <= 100)}>{t('Make keys', '生成激活码')}</Button><Button size="sm" variant="ghost" onClick={() => setKeyForm(null)}>{t('Cancel', '取消')}</Button></div>
          </div>
        )}
        {data.discounts.map((d) => (
          <div key={d.id} className="stack s pt-row">
            <div className="row wrap-row"><b className="mono grow">{d.code}</b>{d.working ? <Badge tone="good">{t('{pct}% off', '{pct}% 折扣', { pct: d.percent_off })}</Badge> : <Badge>{d.uses >= d.max_uses ? t('Used up', '已用完') : t('Off', '已停用')}</Badge>}</div>
            <span className="dim fs-sm">{d.note ? `${d.note} · ` : ''}{t('{n} of {max} used', '已用 {n}/{max}', { n: num(d.uses), max: num(d.max_uses) })} · {d.expires_at ? t('until {date}', '至 {date}', { date: date(d.expires_at) }) : t('no end date', '无截止日期')}</span>
            {d.working && <div className="row"><Button size="sm" onClick={() => void copyText(d.code, toast, t('Code copied.', '折扣码已复制。'))}>{t('Copy', '复制')}</Button><Button size="sm" variant="ghost" onClick={() => void off({ id: d.id })} disabled={busy === 'off'}>{t('Switch off', '停用')}</Button></div>}
          </div>
        ))}
        {data.batches.map((b) => (
          <div key={b.batch} className="stack s pt-row">
            <div className="row wrap-row"><b className="grow">{b.note || t('Keys', '激活码')}</b><span className="fs-sm">{t('{n} of {max} redeemed', '已兑换 {n}/{max}', { n: num(b.used), max: num(b.count) })}</span></div>
            <span className="dim fs-sm">{t('{n} keys', '{n} 个激活码', { n: num(b.count) })} · {date(b.created_at)}{b.off ? ` · ${t('{n} switched off', '已停用 {n} 个', { n: num(b.off) })}` : ''}</span>
            <div className="row"><Button size="sm" onClick={() => void show(b.batch)}>{keys?.batch === b.batch ? t('Hide', '隐藏') : t('Show keys', '查看')}</Button>{b.count - b.used - b.off > 0 && <Button size="sm" variant="ghost" onClick={() => void off({ batch: b.batch })} disabled={busy === 'off'}>{t('Switch off unused', '停用未兑换的')}</Button>}</div>
            {keys?.batch === b.batch && <KeyList keys={keys.list} />}
          </div>
        ))}
      </div>
    </Card>
  );
}

function KeyList({ keys }: { keys: { key: string; used: boolean; off: boolean }[] }) {
  const { toast } = useApp(), unused = keys.filter((k) => !k.used && !k.off).map((k) => k.key);
  if (!unused.length) return <span className="dim fs-sm">{t('Every key of this batch is used or switched off.', '这批激活码已全部兑换或停用。')}</span>;
  return (
    <div className="stack s">
      <textarea className="input mono fs-sm" readOnly rows={Math.min(8, Math.max(2, unused.length))} value={unused.join('\n')} onFocus={(e) => e.target.select()} aria-label={t('Unused keys', '未兑换的激活码')} />
      <div className="row"><Button size="sm" variant="primary" onClick={() => void copyText(unused.join('\n'), toast, t('Keys copied.', '激活码已复制。'))}>{t('Copy {n} unused keys', '复制 {n} 个未兑换的激活码', { n: num(unused.length) })}</Button></div>
    </div>
  );
}

/** "Have a code?" under a paid game's buy button. Calls onApply with the price the code gives, or null to remove it. */
export function CouponField({ slug, applied, onApply }: { slug: string; applied: Applied | null; onApply: (a: Applied | null) => void }) {
  const { user } = useApp(), { busy, act } = useAct();
  const [open, setOpen] = useState(false), [code, setCode] = useState('');
  if (!user) return null;
  if (applied) return <p className="fs-sm gp-coupon"><Badge tone="good">{applied.code}</Badge> {t('{pct}% off: you pay {price}.', '优惠 {pct}%：你只需支付 {price}。', { pct: applied.percent_off, price: price(applied.price_cents) })} <button type="button" className="linkish" onClick={() => onApply(null)}>{t('Remove', '移除')}</button></p>;
  if (!open) return <p className="fs-sm gp-coupon"><button type="button" className="linkish" onClick={() => setOpen(true)}>{t('Have a discount code?', '有折扣码？')}</button></p>;
  const apply = () => act('coupon', async () => { onApply(await api<Applied>(`/games/${encodeURIComponent(slug)}/coupon?code=${encodeURIComponent(code)}`)); setOpen(false); });
  return (
    <form className="row gp-coupon" onSubmit={(e) => { e.preventDefault(); void apply(); }}>
      <Input mono value={code} maxLength={30} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder={t('Code', '折扣码')} aria-label={t('Discount code', '折扣码')} autoFocus />
      <Button size="sm" type="submit" disabled={busy === 'coupon' || code.replace(/[^A-Za-z0-9]/g, '').length < 4}>{t('Apply', '使用')}</Button>
    </form>
  );
}

/** /redeem: a key holder types their key and the game is theirs. */
export function RedeemPage() {
  const { user } = useApp(), { busy, act } = useAct();
  const [key, setKey] = useState(() => new URLSearchParams(location.search).get('key') || ''), [got, setGot] = useState<{ slug: string; title: string } | null>(null);
  const redeem = () => act('redeem', async () => { setGot(await api<{ slug: string; title: string }>('/redeem', { body: { key } })); });
  return (
    <div className="wrap page stack l" style={{ maxWidth: 640 }}>
      <PageHeader title={t('Redeem a key', '兑换激活码')} sub={t('A key from a creator gives you their game. Each key works once.', '创作者发放的激活码可兑换对应游戏，每个激活码只能使用一次。')} />
      {got ? (
        <Card pad><div className="stack">
          <b>{t('{title} is yours.', '{title} 已归你所有。', { title: got.title })}</b>
          <span className="mute fs-sm">{t('It is in your library, ready to play.', '已加入你的游戏库，随时可以开玩。')}</span>
          <div className="row"><Button variant="primary" onClick={() => navigate(`/g/${encodeURIComponent(got.slug)}?play=1`)}>{t('Play now', '立即游玩')}</Button><Button variant="ghost" onClick={() => { setGot(null); setKey(''); }}>{t('Redeem another', '再兑换一个')}</Button></div>
        </div></Card>
      ) : !user ? (
        <Card pad><p><Link to={loginUrl(`/redeem${key ? `?key=${encodeURIComponent(key)}` : ''}`)}>{t('Sign in', '登录')}</Link> {t('to redeem a key. The game goes to the account you sign in with.', '后即可兑换。游戏会归入你登录的账号。')}</p></Card>
      ) : (
        <Card pad>
          <form className="row wrap-row" onSubmit={(e) => { e.preventDefault(); void redeem(); }}>
            <Input mono className="grow" value={key} maxLength={40} onChange={(e) => setKey(e.target.value.toUpperCase())} placeholder="XXXXX-XXXXX-XXXXX" aria-label={t('Key', '激活码')} autoFocus />
            <Button variant="primary" type="submit" disabled={busy === 'redeem' || key.replace(/[^A-Za-z0-9]/g, '').length < 4}>{t('Redeem', '兑换')}</Button>
          </form>
        </Card>
      )}
    </div>
  );
}
