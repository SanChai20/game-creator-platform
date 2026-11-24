// The Refund button for a game purchase, on the game's page and in the purchase history. The server decides
// (src/refunds.ts) and sends the state: when the purchase can be refunded the button is enabled; when it cannot, it is
// greyed out and every reason is listed under it (more than a day since buying, 10 minutes or more played, refunded
// once before). An eligible refund goes through at once; an account that refunds too often sends a request instead.
import { api, dateTime, t, useAct, useApp } from './lib';
import { Button } from './ui';

export type RefundReason = 'window' | 'played' | 'refunded_before' | 'not_charged' | 'gift' | 'off' | 'denied' | 'not_paid';
export interface RefundState {
  purchase_id: string; refundable: boolean; reasons: RefundReason[]; review: boolean; until: number;
  played_seconds: number; max_play_seconds: number; window_hours: number;
  request: { id: string; status: 'pending' | 'refunded' | 'denied' | 'closed'; created_at: number; decided_at: number | null; decision_note: string | null } | null;
}

const minutes = (s: number) => Math.floor(s / 60);

/** The sentence for one reason a purchase cannot be refunded. */
export function reasonLine(r: RefundReason, st: RefundState): string {
  const max = minutes(st.max_play_seconds);
  switch (r) {
    case 'window': return st.window_hours === 24 ? t('More than 1 day has passed since you bought it.', '距离购买已超过 1 天。') : t('More than {hours} hours have passed since you bought it.', '距离购买已超过 {hours} 小时。', { hours: st.window_hours });
    case 'played': return t('You have played it for {played} minutes. Games can be refunded only with less than {minutes} minutes played.', '你已游玩 {played} 分钟。游玩时间不足 {minutes} 分钟的游戏才能退款。', { played: minutes(st.played_seconds), minutes: max });
    case 'refunded_before': return t('You refunded this game once before, so buying it again is final.', '你曾为这款游戏退款一次，再次购买后不能再退款。');
    case 'not_charged': return t('This game was given to you, so there is nothing to refund.', '这款游戏是赠送给你的，没有需要退回的款项。');
    case 'gift': return t('A friend gave you this game. Gifted games are non-refundable.', '这款游戏是好友赠送的。赠送的游戏不可退款。');
    case 'off': return t('Refunds are turned off on this platform right now.', '平台目前已关闭退款。');
    case 'denied': return st.request?.decision_note ? t('Your refund request was declined: {note}', '你的退款申请未获批准：{note}', { note: st.request.decision_note }) : t('Your refund request was declined.', '你的退款申请未获批准。');
    case 'not_paid': return t('This purchase was already refunded.', '这笔购买已经退款。');
  }
}

/** The policy in one line, for next to the button. */
export const policyLine = (st: Pick<RefundState, 'window_hours' | 'max_play_seconds'>) => st.window_hours === 24
  ? t('Games can be refunded within 1 day of buying and with less than {minutes} minutes played, once per game.', '游戏在购买后 1 天内且游玩不足 {minutes} 分钟时可以退款，每款游戏限一次。', { minutes: minutes(st.max_play_seconds) })
  : t('Games can be refunded within {hours} hours of buying and with less than {minutes} minutes played, once per game.', '游戏在购买后 {hours} 小时内且游玩不足 {minutes} 分钟时可以退款，每款游戏限一次。', { hours: st.window_hours, minutes: minutes(st.max_play_seconds) });

export const TIMELINE = () => t('The money goes back to the card or account you paid with. It usually takes 5 to 10 business days to show up, depending on your bank.', '款项将原路退回到你付款的银行卡或账户，通常需要 5 到 10 个工作日到账，具体取决于你的银行。');

/** The Refund button with its state: enabled, greyed out with the reasons, or the request already made. */
export function RefundBox({ st, title, onDone, compact }: { st: RefundState; title: string; onDone: () => unknown; compact?: boolean }) {
  const { busy, act } = useAct(), { toast } = useApp();
  const req = st.request;
  if (st.reasons.includes('not_charged') || st.reasons.includes('not_paid')) return null;
  if (st.reasons.includes('gift')) return <p className="refund-box dim fs-sm">{reasonLine('gift', st)}</p>;
  if (req?.status === 'pending') return (
    <div className="refund-box" role="status">
      <b className="fs-sm">{t('Refund requested', '已申请退款')}</b>
      <p className="mute fs-sm">{t('Sent {when}. The platform reviews it, usually within 2 business days, and emails you the decision.', '已于 {when} 提交。平台通常会在 2 个工作日内审核，并通过邮件告知结果。', { when: dateTime(req.created_at) })}</p>
    </div>
  );
  const go = () => {
    const ask = st.review
      ? t('Ask the platform to refund {title}? Refunds from your account are reviewed by the platform, usually within 2 business days.', '要向平台申请退款 {title} 吗？你的账户的退款需由平台审核，通常需要 2 个工作日。', { title })
      : t('Refund {title}? The game leaves your library, and a game refunded once cannot be refunded again if you buy it later.', '确定为 {title} 退款吗？该游戏将从你的游戏库中移除；退款后如再次购买，将不能再次退款。', { title });
    if (!confirm(`${ask}\n\n${TIMELINE()}`)) return;
    void act('refund', async () => {
      const r = await api<{ status: 'refunded' | 'pending' }>(`/me/purchases/${encodeURIComponent(st.purchase_id)}/refund`, { method: 'POST', body: {} });
      if (r.status === 'refunded') toast(t('Refunded. {timeline}', '已退款。{timeline}', { timeline: TIMELINE() }));
      else toast(t('Refund requested. The platform reviews it, usually within 2 business days, and emails you the decision.', '已提交退款申请。平台通常会在 2 个工作日内审核，并通过邮件告知结果。'));
      await onDone();
    });
  };
  return (
    <div className={'refund-box' + (st.refundable ? '' : ' off')}>
      <Button size="sm" onClick={go} disabled={!st.refundable || busy === 'refund'} aria-describedby={`rf-${st.purchase_id}`}>
        {st.review ? t('Request a refund', '申请退款') : t('Refund', '退款')}
      </Button>
      <div id={`rf-${st.purchase_id}`} className="stack s">
        {st.refundable
          ? <p className="mute fs-sm">{t('You can refund it until {time}, while you have played less than {minutes} minutes (played so far: {played} min).', '在 {time} 前且游玩不足 {minutes} 分钟时可以退款（已游玩 {played} 分钟）。', { time: dateTime(st.until), minutes: minutes(st.max_play_seconds), played: minutes(st.played_seconds) })}</p>
          : <><p className="fs-sm"><b>{t('Not refundable', '不可退款')}</b></p><ul className="refund-why fs-sm">{st.reasons.map((r) => <li key={r}>{reasonLine(r, st)}</li>)}</ul></>}
        {!compact && <p className="dim fs-xs">{policyLine(st)}</p>}
      </div>
    </div>
  );
}

