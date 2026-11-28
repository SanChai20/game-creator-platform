// Player-made levels (src/levels.js): the shelf on a game's page. Players make and share levels inside the game
// (GCP.levels.publish); here anyone finds them, sorted by rating, newest or most played, and plays one, which opens the
// game with GCP.launch.level. Players who played a level rate it; anyone signed in reports one; the game's creator hides
// levels or turns sharing off; makers delete their own.
import { useEffect, useState } from 'react';
import { ago, api, num, Star, t, useAct, useApp } from './lib';
import { Badge, Button, Segmented, Select } from './ui';
import { SectionHead } from './store';
import './follow.css';

export interface Level {
  id: string; title: string; description: string | null; by: { id: string; name: string };
  plays: number; ratings: number; rating: number | null; my_stars: number | null; created_at: number; updated_at: number;
  hidden: boolean; hidden_by: string | null; mine: boolean; can_hide: boolean; can_delete: boolean;
}
type Sort = 'top' | 'new' | 'played' | 'mine';
type Shelf = { levels: Level[]; more: boolean; supported: boolean; open: boolean; off: boolean };

const REASONS: [string, () => string][] = [['spam', () => t('Spam', '垃圾信息')], ['harassment', () => t('Harassment', '骚扰')], ['hate', () => t('Hate', '仇恨言论')], ['sexual', () => t('Sexual content', '色情内容')], ['broken', () => t('Broken or unplayable', '无法游玩')], ['other', () => t('Something else', '其他')]];

function RateLevel({ l, onRated }: { l: Level; onRated: (stars: number, rating: number | null, ratings: number) => void }) {
  const { busy, act } = useAct();
  const rate = (n: number) => act('rate', async () => { const r = await api<{ stars: number; rating: number | null; ratings: number }>(`/levels/${encodeURIComponent(l.id)}/rate`, { body: { stars: n } }); onRated(r.stars, r.rating, r.ratings); });
  return (
    <span className="rate lv-rate" role="radiogroup" aria-label={t('Your rating', '你的评分')}>
      {[1, 2, 3, 4, 5].map((n) => <button key={n} type="button" role="radio" aria-checked={l.my_stars === n} aria-label={`${n}`} className={n <= (l.my_stars || 0) ? 'on' : ''} disabled={busy === 'rate'} onClick={() => void rate(n)}><Star /></button>)}
    </span>
  );
}

function LevelRow({ l, signedIn, onPlay, onChange, onGone }: { l: Level; signedIn: boolean; onPlay: (id: string) => void; onChange: (l: Level) => void; onGone: () => void }) {
  const { busy, act } = useAct(), [reason, setReason] = useState<string | null>(null), [rating, setRating] = useState(false);
  const hide = () => act('hide', async () => { await api(`/levels/${encodeURIComponent(l.id)}/hidden`, { method: 'PUT', body: { hidden: !l.hidden } }); onChange({ ...l, hidden: !l.hidden, hidden_by: l.hidden ? null : 'creator' }); });
  const remove = () => act('del', async () => { await api(`/levels/${encodeURIComponent(l.id)}`, { method: 'DELETE' }); onGone(); }, t('The level is deleted.', '关卡已删除。'));
  const report = () => reason && act('rep', async () => { await api(`/levels/${encodeURIComponent(l.id)}/report`, { body: { reason } }); setReason(null); }, t('Thanks. We will take a look.', '谢谢，我们会查看。'));
  return (
    <li className="lv-row">
      <div className="stack lv-main">
        <b className="lv-title">{l.title}{l.hidden && <> <Badge>{t('Hidden', '已隐藏')}</Badge></>}</b>
        <span className="dim fs-sm">
          {t('By {name}', '作者：{name}', { name: l.by.name })} · {ago(l.created_at)} · {l.plays === 1 ? t('1 play', '1 次游玩') : t('{n} plays', '{n} 次游玩', { n: num(l.plays) })}
          {' · '}{l.rating != null ? <span className="lv-stars">★ {l.rating.toFixed(1)} <span className="dim">({num(l.ratings)})</span></span> : t('No ratings yet', '暂无评分')}
        </span>
        {l.description && <span className="fs-sm lv-desc">{l.description}</span>}
        {rating && <RateLevel l={l} onRated={(stars, r, n) => { onChange({ ...l, my_stars: stars, rating: r, ratings: n }); setRating(false); }} />}
        {reason !== null && (
          <span className="row wrap-row"><Select value={reason} onChange={(e) => setReason(e.target.value)} aria-label={t('Reason', '原因')}>{REASONS.map(([k, lab]) => <option key={k} value={k}>{lab()}</option>)}</Select>
            <Button size="sm" onClick={() => void report()} disabled={busy === 'rep'}>{t('Send report', '提交举报')}</Button><Button size="sm" variant="ghost" onClick={() => setReason(null)}>{t('Cancel', '取消')}</Button></span>
        )}
      </div>
      <div className="row wrap-row lv-acts">
        <Button size="sm" variant="primary" onClick={() => onPlay(l.id)}>{t('Play', '开始玩')}</Button>
        {signedIn && !l.mine && <Button size="sm" variant="ghost" onClick={() => setRating((v) => !v)}>{l.my_stars ? t('Your rating: {n}★', '你的评分：{n}★', { n: l.my_stars }) : t('Rate', '评分')}</Button>}
        {signedIn && !l.mine && reason === null && <button type="button" className="linkish fs-sm" onClick={() => setReason('spam')}>{t('Report', '举报')}</button>}
        {l.can_hide && <Button size="sm" variant="ghost" onClick={() => void hide()} disabled={busy === 'hide'}>{l.hidden ? t('Show it again', '重新显示') : t('Hide', '隐藏')}</Button>}
        {l.can_delete && <Button size="sm" variant="danger" onClick={() => void remove()} disabled={busy === 'del'}>{t('Delete', '删除')}</Button>}
      </div>
    </li>
  );
}

/** The game page's level shelf. Shown when the live version supports levels, or when levels are already shared. */
export function LevelsSection({ slug, owner, onPlay }: { slug: string; owner: boolean; onPlay: (id: string) => void }) {
  const { user, toast } = useApp(), { busy, act } = useAct();
  const [sort, setSort] = useState<Sort>('top'), [shelf, setShelf] = useState<Shelf | null>(null);
  const base = `/games/${encodeURIComponent(slug)}/levels`;
  const load = async (s: Sort, offset = 0) => {
    const r = await api<Shelf>(`${base}?sort=${s}&offset=${offset}`);
    setShelf((old) => (offset && old ? { ...r, levels: [...old.levels, ...r.levels] } : r));
  };
  useEffect(() => { load(sort).catch(() => setShelf(null)); }, [slug, sort]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!shelf || (!shelf.supported && !shelf.levels.length && sort !== 'mine')) return null;
  const toggle = () => act('off', async () => { const r = await api<{ off: boolean }>(base, { method: 'PUT', body: { on: shelf.off } }); setShelf({ ...shelf, off: r.off, open: !r.off && shelf.supported }); });
  const sorts: [Sort, string][] = [['top', t('Top rated', '评分最高')], ['new', t('Newest', '最新')], ['played', t('Most played', '最多游玩')], ...(user ? [['mine', t('Mine', '我的')] as [Sort, string]] : [])];
  const note = owner
    ? (shelf.off ? t('Sharing is off: players cannot share new levels. Levels already shared stay until you hide them.', '分享已关闭：玩家无法分享新关卡。已分享的关卡会保留，直到你隐藏它们。') : t('Levels players made in your game and shared. You can hide any of them.', '玩家在你的游戏中制作并分享的关卡。你可以隐藏其中任何一个。'))
    : t('Levels other players made in this game. Make your own in the game and share it.', '其他玩家在这款游戏中制作的关卡。你也可以在游戏里制作并分享自己的关卡。');
  return (
    <section className="stack l" id="levels">
      <SectionHead title={t('Player levels', '玩家关卡')} note={note} />
      <div className="row wrap-row">
        <Segmented wrap options={sorts} value={sort} onChange={(s) => setSort(s)} label={t('Sort levels', '关卡排序')} />
        {owner && shelf.supported && <Button size="sm" variant="ghost" onClick={() => void toggle()} disabled={busy === 'off'}>{shelf.off ? t('Let players share levels', '允许玩家分享关卡') : t('Turn level sharing off', '关闭关卡分享')}</Button>}
      </div>
      {shelf.levels.length ? (
        <ul className="lv-list">
          {shelf.levels.map((l) => (
            <LevelRow key={l.id} l={l} signedIn={!!user} onPlay={onPlay}
              onChange={(n) => setShelf((s) => s && { ...s, levels: s.levels.map((x) => (x.id === n.id ? n : x)) })}
              onGone={() => setShelf((s) => s && { ...s, levels: s.levels.filter((x) => x.id !== l.id) })} />
          ))}
        </ul>
      ) : <p className="mute fs-sm">{sort === 'mine' ? t('You have not shared a level of this game yet.', '你还没有分享过这款游戏的关卡。') : t('No levels yet. Make one in the game and share it.', '还没有关卡。在游戏里制作一个并分享吧。')}</p>}
      {shelf.more && <div><Button size="sm" onClick={() => void load(sort, shelf.levels.length).catch((e) => toast((e as Error).message, true))}>{t('Show more', '显示更多')}</Button></div>}
    </section>
  );
}
