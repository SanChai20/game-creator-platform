// Gifts between friends (src/gifts.ts): requests friends sent this player (gift it or decline), the player's own open
// requests (cancel), and the gifts they received and gave. Gifts are non-refundable.
import { useEffect, useState } from 'react';
import { Fail, Link, ago, api, date, price, t, useAct, useData } from '../lib';
import { Badge, Button, Card, EmptyState, ListPager, PageHeader, Section } from '../ui';
import { PageSkeleton } from '../skeletons';
import { NON_REFUNDABLE, giveGift } from '../gift-ui';

const PER = 10;

interface Req { id: string; note: string | null; created_at: number; expires_at: number; friend: { id: string; name: string }; game: { id: string; slug: string; title: string; price_cents: number; sale_price_cents: number; sale_starts_at: number | null; sale_ends_at: number | null; live: boolean }; owned: boolean }
interface Gift { id: string; price_cents: number; status: string; created_at: number; friend: { id: string; name: string }; game: { slug: string; title: string } }
/** What the game sells for now: its sale price while a sale runs (src/sales.ts saleOf). */
const priceNow = (g: Req['game']) => { const n = Date.now(); return g.sale_price_cents > 0 && g.sale_price_cents < g.price_cents && (g.sale_ends_at || 0) > n && (g.sale_starts_at || 0) <= n ? g.sale_price_cents : g.price_cents; };
interface Totals { incoming: number; outgoing: number; received: number; sent: number }
interface Data { enabled: boolean; per_page?: number; incoming: Req[]; outgoing: Req[]; received: Gift[]; sent: Gift[]; totals?: Totals }

export function Gifts() {
  const [pg, setPg] = useState({ incoming: 1, outgoing: 1, received: 1, sent: 1 });
  const path = `/me/gifts?incoming_page=${pg.incoming}&outgoing_page=${pg.outgoing}&received_page=${pg.received}&sent_page=${pg.sent}&per_page=${PER}`;
  const { data, error, loading, reload } = useData<Data>(path), { busy, act } = useAct();
  useEffect(() => {
    if (!data?.totals) return;
    const clamp = (cur: number, tot: number) => Math.min(cur, Math.max(1, Math.ceil(tot / PER)));
    const next = {
      incoming: clamp(pg.incoming, data.totals.incoming),
      outgoing: clamp(pg.outgoing, data.totals.outgoing),
      received: clamp(pg.received, data.totals.received),
      sent: clamp(pg.sent, data.totals.sent),
    };
    if (next.incoming !== pg.incoming || next.outgoing !== pg.outgoing || next.received !== pg.received || next.sent !== pg.sent) setPg(next);
  }, [data, pg]);
  if (error && !data) return <div className="wrap page"><Fail error={error} retry={reload} /></div>;
  if (loading && !data) return <PageSkeleton />;
  const d = data!;
  const totals: Totals = d.totals || { incoming: d.incoming.length, outgoing: d.outgoing.length, received: d.received.length, sent: d.sent.length };
  const decline = (r: Req) => act('d' + r.id, async () => { await api(`/me/gifts/requests/${r.id}/decline`, { method: 'POST' }); await reload(); }, t('Declined. {name} was told.', '已拒绝，并已告知 {name}。', { name: r.friend.name }));
  const cancel = (r: Req) => act('c' + r.id, async () => { await api(`/me/gifts/requests/${r.id}`, { method: 'DELETE' }); await reload(); }, t('Request cancelled.', '请求已取消。'));
  const gift = (r: Req) => act('g' + r.id, () => giveGift(r.game.slug, r.friend.id, r.id));
  const empty = !totals.incoming && !totals.outgoing && !totals.received && !totals.sent;
  return (
    <div className="wrap page gifts">
      <PageHeader back={{ to: '/library', label: t('Library', '游戏库') }} title={t('Gifts', '礼物')}
        sub={<>{t('Buy a game for a friend from its page, or ask a friend to gift you one. Gifts are only possible between friends.', '你可以在游戏页面为好友购买游戏，或请好友赠送给你。只有好友之间才能赠送。')} {t('Gifts are non-refundable.', '赠送的游戏不可退款。')}</>} />
      {!d.enabled && <p className="mute">{t('Gifts are turned off on this platform right now.', '平台目前已关闭礼物功能。')}</p>}
      {empty ? <EmptyState title={t('No gifts yet', '还没有礼物')} action={<Button to="/" variant="primary">{t('Find a game', '去找游戏')}</Button>}>{t('Gift requests from friends and the gifts you give and receive show up here.', '好友的礼物请求，以及你赠送和收到的礼物都会显示在这里。')}</EmptyState> : <>
        {totals.incoming > 0 && <Section title={t('Friends asking you', '好友的请求')} sub={NON_REFUNDABLE()}><Card><ul className="gift-list">{d.incoming.map((r) => (
          <li key={r.id} className="gift-row">
            <div className="gift-main">
              <b>{t('{name} would like {game}', '{name} 想要 {game}', { name: r.friend.name, game: r.game.title })}</b>
              <div className="mute fs-sm"><Link to={`/g/${r.game.slug}`}>{r.game.title}</Link> · {price(priceNow(r.game))} · {ago(r.created_at)}</div>
              {r.note && <div className="fs-sm gift-note">“{r.note}”</div>}
            </div>
            <div className="gift-act">
              {r.owned ? <span className="dim fs-sm">{t('They have it now', '对方已拥有')}</span>
                : <Button size="sm" variant="primary" onClick={() => void gift(r)} disabled={!d.enabled || !r.game.live || !!busy}>{t('Gift it · {price}', '赠送 · {price}', { price: price(priceNow(r.game)) })}</Button>}
              <Button size="sm" variant="ghost" onClick={() => void decline(r)} disabled={!!busy}>{t('Decline', '拒绝')}</Button>
            </div>
          </li>))}</ul><ListPager flush page={pg.incoming} total={totals.incoming} perPage={PER} onPage={(p) => setPg((s) => ({ ...s, incoming: p }))} /></Card></Section>}
        {totals.outgoing > 0 && <Section title={t('Your requests', '你的请求')}><Card><ul className="gift-list">{d.outgoing.map((r) => (
          <li key={r.id} className="gift-row">
            <div className="gift-main"><b>{t('You asked {name} for {game}', '你向 {name} 请求了 {game}', { name: r.friend.name, game: r.game.title })}</b><div className="mute fs-sm">{ago(r.created_at)} · {t('open until {when}', '有效期至 {when}', { when: date(r.expires_at) })}</div></div>
            <div className="gift-act"><Button size="sm" variant="ghost" onClick={() => void cancel(r)} disabled={!!busy}>{t('Cancel request', '取消请求')}</Button></div>
          </li>))}</ul><ListPager flush page={pg.outgoing} total={totals.outgoing} perPage={PER} onPage={(p) => setPg((s) => ({ ...s, outgoing: p }))} /></Card></Section>}
        {totals.received > 0 && <Section title={t('Gifts you received', '收到的礼物')}><Card><ul className="gift-list">{d.received.map((g) => (
          <li key={g.id} className="gift-row">
            <div className="gift-main"><Link to={`/g/${g.game.slug}`}><b>{g.game.title}</b></Link><div className="mute fs-sm">{t('From {name}', '来自 {name}', { name: g.friend.name })} · {date(g.created_at)}</div></div>
            {g.status !== 'paid' && <Badge tone="accent">{t('On hold', '暂停')}</Badge>}
          </li>))}</ul><ListPager flush page={pg.received} total={totals.received} perPage={PER} onPage={(p) => setPg((s) => ({ ...s, received: p }))} /></Card></Section>}
        {totals.sent > 0 && <Section title={t('Gifts you gave', '送出的礼物')}><Card><ul className="gift-list">{d.sent.map((g) => (
          <li key={g.id} className="gift-row">
            <div className="gift-main"><Link to={`/g/${g.game.slug}`}><b>{g.game.title}</b></Link><div className="mute fs-sm">{t('To {name}', '送给 {name}', { name: g.friend.name })} · {price(g.price_cents)} · {date(g.created_at)} · {t('Non-refundable', '不可退款')}</div></div>
          </li>))}</ul><ListPager flush page={pg.sent} total={totals.sent} perPage={PER} onPage={(p) => setPg((s) => ({ ...s, sent: p }))} /></Card></Section>}
      </>}
    </div>
  );
}
