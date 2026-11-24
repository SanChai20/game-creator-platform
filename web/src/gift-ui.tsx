// Gifts between friends (src/gifts.ts), on the web. The game page offers "Gift to a friend" (pay for a friend; the game
// lands in their library) and, on a paid game the player does not own, "Ask a friend to gift it". Both open GiftDialog,
// which lists the player's friends. A gift goes through Stripe Checkout like any purchase, and is non-refundable: the
// dialog says so before the player continues, and Checkout asks them to tick it.
import { useEffect, useState } from 'react';
import { api, price, t, useAct, useApp } from './lib';
import { Button, Modal, Notice, Textarea } from './ui';

interface GiftFriend { id: string; name: string; owned: boolean }
export interface GameGift { asked: { request: string; friend: { id: string; name: string } }[]; asked_by: { request: string; friend: { id: string; name: string } }[] }

export const NON_REFUNDABLE = () => t('Gifts are non-refundable. Once you pay, the game is your friend\'s and neither of you can refund it.', '赠送的游戏不可退款。付款后游戏即归好友所有，你们双方都不能退款。');

/** Opens Stripe Checkout to buy `slug` for friend `to` (answering gift request `request`, when there is one). */
export async function giveGift(slug: string, to: string, request?: string) {
  const r = await api<{ url: string }>(`/games/${encodeURIComponent(slug)}/gift`, { body: { to, ...(request ? { request } : {}) } });
  location.href = r.url;
}

/** The friend picker. mode 'give': pay for a friend. mode 'ask': ask a friend to gift it to you. */
export function GiftDialog({ mode, slug, title, cents, gift, preselect, onClose, onDone }: { mode: 'give' | 'ask'; slug: string; title: string; cents: number; gift: GameGift | null; preselect?: string; onClose: () => void; onDone?: () => unknown }) {
  const { toast } = useApp(), { busy, act } = useAct();
  const [friends, setFriends] = useState<GiftFriend[] | null>(null), [err, setErr] = useState('');
  const [pick, setPick] = useState(preselect || ''), [note, setNote] = useState('');
  useEffect(() => { api<{ friends: GiftFriend[] }>(`/games/${encodeURIComponent(slug)}/gift-friends`).then((r) => setFriends(r.friends), (e) => setErr((e as Error).message)); }, [slug]);
  const asked = new Set((gift?.asked || []).map((a) => a.friend.id));
  const usable = (f: GiftFriend) => mode === 'give' ? !f.owned : !asked.has(f.id);
  const request = mode === 'give' ? gift?.asked_by.find((a) => a.friend.id === pick)?.request : undefined;
  const go = () => {
    if (!pick) return;
    if (mode === 'give') void act('gift', () => giveGift(slug, pick, request));
    else void act('ask', async () => {
      const r = await api<{ already: boolean }>(`/games/${encodeURIComponent(slug)}/gift-request`, { body: { to: pick, note } });
      const name = friends?.find((f) => f.id === pick)?.name || '';
      toast(r.already ? t('You already asked {name} for this game.', '你已经向 {name} 请求过这款游戏。', { name }) : t('Asked {name}. We will tell you when they answer.', '已向 {name} 发送请求，对方回应后会通知你。', { name }));
      await onDone?.(); onClose();
    });
  };
  return (
    <Modal onClose={onClose}>
      <div className="stack l gift-dialog">
        <div className="stack s">
          <h2>{mode === 'give' ? t('Gift {title} to a friend', '将 {title} 赠送给好友', { title }) : t('Ask a friend to gift you {title}', '请好友赠送你 {title}', { title })}</h2>
          <p className="mute fs-sm">{mode === 'give' ? t('You pay {price} and the game goes straight to your friend\'s library.', '你支付 {price}，游戏会直接进入好友的游戏库。', { price: price(cents) }) : t('Your friend gets a request and can buy it for you. You can only ask friends.', '好友会收到请求，并可以为你购买。只能向好友请求。')}</p>
        </div>
        {err ? <Notice tone="bad">{err}</Notice> : !friends ? <p className="mute">{t('Loading friends…', '正在加载好友…')}</p>
          : !friends.length ? <Notice tone="info" title={t('No friends yet', '还没有好友')}>{t('Gifts are only possible between friends. Add a friend first from the Friends panel.', '只有好友之间才能赠送游戏。请先在好友面板中添加好友。')}</Notice>
          : <ul className="gift-friends" role="radiogroup" aria-label={t('Friends', '好友')}>{friends.map((f) => {
            const ok = usable(f);
            return <li key={f.id}><label className={'gift-friend' + (ok ? '' : ' off')}>
              <input type="radio" name="gift-friend" value={f.id} checked={pick === f.id} disabled={!ok} onChange={() => setPick(f.id)} />
              <span className="grow clip"><b>{f.name}</b></span>
              {mode === 'give' && f.owned ? <span className="dim fs-sm">{t('Already has it', '已拥有')}</span>
                : mode === 'ask' && asked.has(f.id) ? <span className="dim fs-sm">{t('Asked', '已请求')}</span>
                : mode === 'give' && gift?.asked_by.some((a) => a.friend.id === f.id) ? <span className="fs-sm gift-wants">{t('Asked you for it', '向你请求过')}</span> : null}
            </label></li>;
          })}</ul>}
        {mode === 'ask' && !!friends?.length && <Textarea rows={2} maxLength={200} placeholder={t('Add a note (optional)', '附言（可选）')} value={note} onChange={(e) => setNote(e.target.value)} />}
        {mode === 'give' && <Notice tone="info" title={t('Non-refundable', '不可退款')}>{NON_REFUNDABLE()}</Notice>}
        <div className="row wrapx gift-actions">
          <Button onClick={onClose}>{t('Cancel', '取消')}</Button>
          <Button variant="primary" onClick={go} disabled={!pick || !friends?.find((f) => f.id === pick && usable(f)) || !!busy}>
            {mode === 'give' ? t('Continue to payment · {price}', '前往付款 · {price}', { price: price(cents) }) : t('Send request', '发送请求')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
