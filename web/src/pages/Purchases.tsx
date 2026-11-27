// The buyer's purchase history: every game and build skill they bought, newest first. Each game purchase carries its
// Refund button (enabled, or greyed out with every reason it cannot be refunded); build skills are final and say so.
import { useEffect, useState } from 'react';
import { Fail, Link, date, price, t, useData } from '../lib';
import { Badge, Button, Card, EmptyState, ListPager, PageHeader, StatusBadge } from '../ui';
import { PageSkeleton } from '../skeletons';
import { RefundBox, TIMELINE, policyLine, type RefundState } from '../refund-ui';

const PER = 20;

interface Purchase { id: string; item: 'game' | 'skill'; title: string; slug: string; price_cents: number; status: string; gift: boolean; gifted_by?: { id: string; name: string } | null; created_at: number; refunded_at: number | null; refund: RefundState | null }
interface Data { purchases: Purchase[]; total: number; page: number; per_page: number; pages: number; policy: { window_hours: number; max_play_minutes: number } }

export function Purchases() {
  const [page, setPage] = useState(1);
  const { data, error, loading, reload } = useData<Data>(`/me/purchases?page=${page}&per_page=${PER}`);
  useEffect(() => { if (data && page > data.pages) setPage(data.pages); }, [data, page]);
  if (error && !data) return <div className="wrap page"><Fail error={error} retry={reload} /></div>;
  if (loading && !data) return <PageSkeleton />;
  const d = data!, policy = { window_hours: d.policy.window_hours, max_play_seconds: d.policy.max_play_minutes * 60 };
  return (
    <div className="wrap page purchases">
      <PageHeader back={{ to: '/library', label: t('Library', '游戏库') }} title={t('Purchases and refunds', '购买记录与退款')}
        sub={<>{policyLine(policy)} {t('Build skills are non-refundable.', '构建技能不可退款。')} {t('Gifts are non-refundable.', '赠送的游戏不可退款。')} <Link to="/legal/refunds">{t('Refund policy', '退款政策')}</Link></>} />
      {!d.total && !d.purchases.length ? (
        <EmptyState title={t('No purchases yet', '还没有购买记录')} action={<Button to="/" variant="primary">{t('Find a game', '去找游戏')}</Button>}>{t('Games and build skills you buy are listed here, with their refunds.', '你购买的游戏和构建技能会列在这里，退款也在这里办理。')}</EmptyState>
      ) : (
        <Card>
          <ul className="purchase-list">{d.purchases.map((x) => (
            <li key={x.id} className="purchase-row">
              <div className="purchase-main">
                <Link to={x.item === 'skill' ? `/creator-store/${x.slug}` : `/g/${x.slug}`}><b>{x.title}</b></Link>
                {x.item === 'skill' && <Badge dot={false} tone="accent">{t('Build skill', '构建技能')}</Badge>}
                <div className="mute fs-sm">{x.gifted_by ? t('Gift from {name}', '来自 {name} 的礼物', { name: x.gifted_by.name }) : x.gift ? t('Given to you', '赠送') : price(x.price_cents)} · {date(x.created_at)}{x.refunded_at ? ` · ${t('refunded {when}', '{when}退款', { when: date(x.refunded_at) })}` : ''}</div>
              </div>
              <div className="purchase-state"><StatusBadge status={x.status === 'dispute_won' ? 'paid' : x.status} /></div>
              <div className="purchase-act">
                {x.item === 'skill' ? <span className="dim fs-sm">{t('Non-refundable', '不可退款')}</span>
                  : x.status === 'refunded' ? (x.refunded_at && Date.now() - x.refunded_at < 14 * 86400000 ? <span className="dim fs-sm">{TIMELINE()}</span> : null)
                  : x.refund ? <RefundBox st={x.refund} title={x.title} onDone={reload} compact /> : null}
              </div>
            </li>
          ))}</ul>
          <ListPager flush page={page} total={d.total} perPage={d.per_page || PER} onPage={(p) => { setPage(p); scrollTo({ top: 0 }); }} />
        </Card>
      )}
    </div>
  );
}
