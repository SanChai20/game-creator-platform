// Bundles (src/bundles.js): the public bundle page (/bundles/:slug), the bundle lines on a game page, and the console card
// where a creator groups their paid games. Owning one game of a bundle lowers the price of the rest.
import { useState } from 'react';
import { api, Fail, GameTile, Link, loginUrl, num, price, t, useAct, useApp, useData, usd, type GameCard } from './lib';
import { Badge, Button, Card, Input, PageHeader, Textarea } from './ui';
import './follow.css';

interface View {
  bundle: { slug: string; title: string; description: string | null; percent_off: number; owner: { id: string; name: string } };
  games: { game: GameCard; owned: boolean; discounted: boolean; price_cents: number }[];
  owned: number; total: number; rest_cents: number; rest_regular_cents: number;
}
export interface BundleLine { slug: string; title: string; percent_off: number; games: number; owned: number; applies: boolean }

export function BundlePage({ slug }: { slug: string }) {
  const { user } = useApp(), { data, error, reload } = useData<View>(`/bundles/${encodeURIComponent(slug)}`);
  if (error && !data) return <div className="wrap page"><Fail error={error} retry={reload} /></div>;
  if (!data) return <div className="wrap page" />;
  const b = data.bundle, left = data.total - data.owned;
  return (
    <div className="wrap page stack l">
      <PageHeader eyebrow={t('Bundle', '合集')} title={b.title} sub={<>{t('By', '作者')} <Link to={`/creator/${encodeURIComponent(b.owner.id)}`}>{b.owner.name}</Link></>} badge={<Badge tone="good">{t('Complete the set: {pct}% off', '集齐优惠：{pct}% 折扣', { pct: b.percent_off })}</Badge>} />
      {b.description && <p className="mute" style={{ maxWidth: 720 }}>{b.description}</p>}
      <Card pad>
        <div className="stack s">
          <b>{!user ? t('Own any game here and the rest are {pct}% off for you.', '拥有其中任意一款，其余游戏即可享受 {pct}% 折扣。', { pct: b.percent_off })
            : left === 0 ? t('You own every game in this bundle.', '你已拥有本合集中的全部游戏。')
            : data.owned ? t('You own {n} of {total}. The rest are {pct}% off for you.', '你已拥有 {n}/{total} 款，其余游戏可享 {pct}% 折扣。', { n: num(data.owned), total: num(data.total), pct: b.percent_off })
            : t('Buy any game here and the rest are {pct}% off for you.', '购买其中任意一款，其余游戏即可享受 {pct}% 折扣。', { pct: b.percent_off })}</b>
          {user && left > 0 && <span className="dim fs-sm">{data.rest_cents < data.rest_regular_cents ? t('The {n} you do not own: {price} (regular {regular}).', '你未拥有的 {n} 款：{price}（原价 {regular}）。', { n: num(left), price: usd(data.rest_cents), regular: usd(data.rest_regular_cents) }) : t('The {n} you do not own: {price}.', '你未拥有的 {n} 款：{price}。', { n: num(left), price: usd(data.rest_cents) })} {t('Each game is bought on its own.', '每款游戏单独购买。')}</span>}
          {!user && <span className="dim fs-sm"><Link to={loginUrl(`/bundles/${b.slug}`)}>{t('Sign in', '登录')}</Link> {t('to see your price.', '查看你的价格。')}</span>}
        </div>
      </Card>
      <div className="grid browse-grid">{data.games.map((x) => (
        <div key={x.game.id} className="stack s">
          <GameTile g={x.game} />
          <div className="row">{x.owned ? <Badge tone="good">{t('Owned', '已拥有')}</Badge> : x.discounted ? <><b>{price(x.price_cents)}</b><span className="dim fs-sm">{t('your bundle price', '你的合集价')}</span></> : <span className="dim fs-sm">{price(x.price_cents)}</span>}</div>
        </div>
      ))}</div>
    </div>
  );
}

/** On a paid game's page: the bundles it is in, and whether this player's price is lowered by one. */
export function BundleLines({ lines }: { lines: BundleLine[] }) {
  if (!lines.length) return null;
  return (
    <div className="stack s gp-bundles">
      {lines.map((l) => (
        <p key={l.slug} className="fs-sm">
          <Link to={`/bundles/${l.slug}`} className="sig">{l.title}</Link>{' · '}
          {l.applies ? t('you own {n} of {total}: {pct}% off the rest', '你已拥有 {n}/{total} 款：其余 {pct}% 折扣', { n: l.owned, total: l.games, pct: l.percent_off })
            : t('bundle of {n}: own one, get {pct}% off the rest', '{n} 款合集：拥有一款，其余 {pct}% 折扣', { n: l.games, pct: l.percent_off })}
        </p>
      ))}
    </div>
  );
}

interface Mine { bundles: { id: string; slug: string; title: string; description: string | null; percent_off: number; games: { id: string; slug: string; title: string; price_cents: number; status: string }[] }[]; games: { id: string; slug: string; title: string; price_cents: number; status: string }[] }

/** The console card on a game's page: the bundles this game is in, and a form for a new one. */
export function BundlesCard({ id, paid }: { id: string; paid: boolean }) {
  const { busy, act } = useAct();
  const { data, reload } = useData<Mine>(paid ? '/console/bundles' : null);
  const [form, setForm] = useState<{ edit: string | null; title: string; description: string; pct: string; games: string[] } | null>(null);
  if (!paid || !data) return null;
  const here = data.bundles.filter((b) => b.games.some((g) => g.id === id));
  const save = () => form && act('bundle', async () => {
    const body = { title: form.title, description: form.description, percent_off: Number(form.pct), games: form.games };
    if (form.edit) await api(`/console/bundles/${form.edit}`, { method: 'PUT', body }); else await api('/console/bundles', { body });
    setForm(null); await reload();
  }, form.edit ? t('The bundle is saved.', '合集已保存。') : t('The bundle is ready.', '合集已创建。'));
  const remove = (bid: string) => act('rm', async () => { await api(`/console/bundles/${bid}`, { method: 'DELETE' }); await reload(); }, t('The bundle is removed.', '合集已删除。'));
  const toggle = (g: string) => form && setForm({ ...form, games: form.games.includes(g) ? form.games.filter((x) => x !== g) : [...form.games, g] });
  const ok = form && form.title.trim() && Number(form.pct) >= 5 && Number(form.pct) <= 60 && form.games.length >= 2 && form.games.length <= 10;
  return (
    <Card title={t('Bundles', '合集')} pad>
      <div className="stack">
        <p className="mute fs-sm">{t('Group your paid games. Each is still bought on its own, and a player who owns one of them gets your discount on the rest.', '将你的付费游戏组成合集。每款游戏仍单独购买，已拥有其中一款的玩家购买其余游戏时可享受你设置的折扣。')}</p>
        {here.map((b) => (
          <div key={b.id} className="stack s pt-row">
            <div className="row wrap-row"><Link to={`/bundles/${b.slug}`} className="grow"><b>{b.title}</b></Link><Badge tone="good">{t('{pct}% off', '{pct}% 折扣', { pct: b.percent_off })}</Badge></div>
            <span className="dim fs-sm">{b.games.map((g) => g.title).join(' · ')}</span>
            <div className="row"><Button size="sm" onClick={() => setForm({ edit: b.id, title: b.title, description: b.description || '', pct: String(b.percent_off), games: b.games.map((g) => g.id) })}>{t('Edit', '编辑')}</Button><Button size="sm" variant="ghost" onClick={() => void remove(b.id)} disabled={busy === 'rm'}>{t('Remove', '移除')}</Button></div>
          </div>
        ))}
        {!form && (data.games.length >= 2
          ? <div><Button size="sm" variant="primary" onClick={() => setForm({ edit: null, title: '', description: '', pct: '20', games: [id] })}>{t('New bundle', '新建合集')}</Button></div>
          : <p className="dim fs-sm">{t('A bundle needs at least 2 of your paid games.', '合集至少需要 2 款你的付费游戏。')}</p>)}
        {form && (
          <div className="stack s">
            <Input value={form.title} maxLength={80} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder={t('Title, such as The Star Hop trilogy', '标题，例如：星跳三部曲')} aria-label={t('Title', '标题')} autoFocus />
            <Textarea rows={2} maxLength={600} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder={t('What ties these games together? (optional)', '这些游戏有什么关联？（可选）')} aria-label={t('Description', '描述')} />
            <label className="row fs-sm">{t('% off the rest', '其余游戏折扣 %')} <Input mono inputMode="numeric" value={form.pct} onChange={(e) => setForm({ ...form, pct: e.target.value.replace(/[^0-9]/g, '') })} style={{ width: '4em' }} /></label>
            <div className="stack s">{data.games.map((g) => (
              <label key={g.id} className="row fs-sm"><input type="checkbox" checked={form.games.includes(g.id)} onChange={() => toggle(g.id)} /><span className="grow clip">{g.title}</span><span className="dim">{price(g.price_cents)}{g.status !== 'live' ? ` · ${t('not live', '未上线')}` : ''}</span></label>
            ))}</div>
            <span className="dim fs-sm">{t('{n} games chosen (2 to 10). Discount 5 to 60%.', '已选 {n} 款（2 到 10 款）。折扣 5% 到 60%。', { n: form.games.length })}</span>
            <div className="row"><Button size="sm" variant="primary" onClick={() => void save()} disabled={busy === 'bundle' || !ok}>{form.edit ? t('Save', '保存') : t('Create', '创建')}</Button><Button size="sm" variant="ghost" onClick={() => setForm(null)}>{t('Cancel', '取消')}</Button></div>
          </div>
        )}
      </div>
    </Card>
  );
}
