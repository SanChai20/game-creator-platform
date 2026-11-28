// Curated collections (src/collections.js): the lists page (/collections), one list's page (/collections/:slug), the
// game page's "Add to list" and the home page's staff picks.
import { useState, type CSSProperties } from 'react';

// a stable colour for a game without a cover
const hue = (s: string) => [...s].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) % 360, 7);
import { api, Fail, GameTile, Link, loginUrl, navigate, num, t, useAct, useApp, useData, type GameCard } from './lib';
import { Badge, Button, Card, EmptyState, Input, PageHeader, Textarea } from './ui';
import { SectionHead } from './store';
import './follow.css';

interface ListSum { id: string; slug: string; title: string; description: string | null; public: boolean; staff_pick: boolean; followers: number; owner: { id: string; name: string }; games: number; covers: { slug: string; title: string; cover: string | null }[]; hidden?: boolean }
interface Browse { staff: ListSum[]; popular: ListSum[]; mine: ListSum[]; following: ListSum[] }

function ListCard({ l }: { l: ListSum }) {
  return (
    <Link to={`/collections/${l.slug}`} className="list-card">
      <div className="list-covers" aria-hidden="true">{[0, 1, 2, 3].map((i) => { const c = l.covers[i]; return c?.cover ? <img key={i} src={c.cover} alt="" loading="lazy" /> : c ? <span key={i} className="list-fill" style={{ '--h': hue(c.slug) } as CSSProperties}>{c.title.slice(0, 1)}</span> : <span key={i} />; })}</div>
      <div className="stack s">
        <b className="clip">{l.title}</b>
        <span className="dim fs-sm">{t('by {name}', '{name} 整理', { name: l.owner.name })} · {l.games === 1 ? t('1 game', '1 款游戏') : t('{n} games', '{n} 款游戏', { n: num(l.games) })}{l.followers ? ` · ${l.followers === 1 ? t('1 follower', '1 位关注者') : t('{n} followers', '{n} 位关注者', { n: num(l.followers) })}` : ''}</span>
        {(l.staff_pick || !l.public) && <span>{l.staff_pick && <Badge tone="good">{t('Staff pick', '编辑精选')}</Badge>} {!l.public && <Badge>{t('Private', '私密')}</Badge>}</span>}
      </div>
    </Link>
  );
}
const ListGrid = ({ lists }: { lists: ListSum[] }) => <div className="list-grid">{lists.map((l) => <ListCard key={l.id} l={l} />)}</div>;

/** Home: the staff's lists. */
export function StaffLists() {
  const { data } = useData<{ lists: ListSum[] }>('/collections/featured');
  if (!data?.lists.length) return null;
  return (
    <section className="stack l">
      <SectionHead title={t('Staff picks', '编辑精选')} note={t('Lists of games put together by the HearthCade team.', 'HearthCade 团队整理的游戏清单。')} to="/collections" />
      <ListGrid lists={data.lists.slice(0, 3)} />
    </section>
  );
}

export function CollectionsPage() {
  const { user } = useApp(), { busy, act } = useAct(), { data, error, reload } = useData<Browse>('/collections');
  const [title, setTitle] = useState<string | null>(null);
  if (error && !data) return <div className="wrap page"><Fail error={error} retry={reload} /></div>;
  const create = () => title !== null && act('new', async () => { const r = await api<{ slug: string }>('/collections', { body: { title } }); navigate(`/collections/${r.slug}`); });
  return (
    <div className="wrap page stack l">
      <PageHeader title={t('Lists', '清单')} sub={t('Games picked by players and staff, a few at a time. Follow the ones you like, or make your own.', '由玩家和编辑精心挑选的游戏清单。关注你喜欢的，或者自己整理一份。')}
        actions={user ? (title === null ? <Button variant="primary" onClick={() => setTitle('')}>{t('New list', '新建清单')}</Button> : null) : <Button to={loginUrl('/collections')}>{t('Sign in to make a list', '登录后创建清单')}</Button>} />
      {title !== null && (
        <form className="row wrap-row" onSubmit={(e) => { e.preventDefault(); void create(); }}>
          <Input className="grow" value={title} maxLength={80} onChange={(e) => setTitle(e.target.value)} placeholder={t('Title, such as Best 10-minute puzzlers', '标题，例如：最佳十分钟解谜游戏')} aria-label={t('Title', '标题')} autoFocus />
          <Button variant="primary" type="submit" disabled={busy === 'new' || !title.trim()}>{t('Create', '创建')}</Button><Button variant="ghost" onClick={() => setTitle(null)}>{t('Cancel', '取消')}</Button>
        </form>
      )}
      {!data ? null : <>
        {!!data.mine.length && <section className="stack"><SectionHead title={t('Your lists', '你的清单')} /><ListGrid lists={data.mine} /></section>}
        {!!data.following.length && <section className="stack"><SectionHead title={t('Lists you follow', '你关注的清单')} /><ListGrid lists={data.following} /></section>}
        {!!data.staff.length && <section className="stack"><SectionHead title={t('Staff picks', '编辑精选')} /><ListGrid lists={data.staff} /></section>}
        <section className="stack"><SectionHead title={t('Most followed', '最受关注')} />
          {data.popular.length ? <ListGrid lists={data.popular} /> : <EmptyState title={t('No lists yet', '还没有清单')}>{t('Make the first one: pick a few games you love and say why.', '来创建第一份清单吧：挑几款你喜欢的游戏，说说理由。')}</EmptyState>}
        </section>
      </>}
    </div>
  );
}

interface ListView { collection: ListSum; games: (GameCard & { note: string | null })[]; mine: boolean; following: boolean }

export function CollectionPage({ slug }: { slug: string }) {
  const { user, toast } = useApp(), { busy, act } = useAct(), { data, error, reload } = useData<ListView>(`/collections/${encodeURIComponent(slug)}`);
  const [edit, setEdit] = useState<{ title: string; description: string; public: boolean } | null>(null), [note, setNote] = useState<{ id: string; text: string } | null>(null);
  if (error && !data) return <div className="wrap page"><Fail error={error} retry={reload} /></div>;
  if (!data) return <div className="wrap page" />;
  const l = data.collection, base = `/collections/${encodeURIComponent(slug)}`;
  const follow = () => { if (!user) return navigate(loginUrl(base)); void act('follow', async () => { await api(`${base}/follow`, { body: { on: !data.following } }); await reload(); }); };
  const share = async () => { const url = location.origin + base; try { if (typeof navigator.share === 'function') await navigator.share({ title: l.title, url }); else { await navigator.clipboard.writeText(url); toast(t('Link copied.', '链接已复制。')); } } catch { /* closed */ } };
  const save = () => edit && act('save', async () => { await api(base, { method: 'PUT', body: edit }); setEdit(null); await reload(); }, t('Saved.', '已保存。'));
  const remove = () => act('del', async () => { await api(base, { method: 'DELETE' }); navigate('/collections'); }, t('The list is deleted.', '清单已删除。'));
  const drop = (id: string) => act('drop', async () => { await api(`${base}/games/${id}`, { method: 'DELETE' }); await reload(); });
  const move = (i: number, d: number) => act('move', async () => { const ids = data.games.map((g) => g.id); [ids[i], ids[i + d]] = [ids[i + d], ids[i]]; await api(`${base}/order`, { method: 'PUT', body: { ids } }); await reload(); });
  const saveNote = () => note && act('note', async () => { await api(`${base}/games`, { body: { game: note.id, note: note.text } }); setNote(null); await reload(); });
  return (
    <div className="wrap page stack l">
      <PageHeader eyebrow={<Link to="/collections">{t('Lists', '清单')}</Link>} title={l.title}
        sub={<>{t('By', '作者')} <Link to={`/u/${encodeURIComponent(l.owner.id)}`}>{l.owner.name}</Link> · {l.games === 1 ? t('1 game', '1 款游戏') : t('{n} games', '{n} 款游戏', { n: num(l.games) })}{l.followers ? ` · ${l.followers === 1 ? t('1 follower', '1 位关注者') : t('{n} followers', '{n} 位关注者', { n: num(l.followers) })}` : ''}</>}
        badge={l.staff_pick ? <Badge tone="good">{t('Staff pick', '编辑精选')}</Badge> : !l.public ? <Badge>{t('Private', '私密')}</Badge> : undefined}
        actions={<div className="row">{!data.mine && <Button variant={data.following ? undefined : 'primary'} onClick={follow} disabled={busy === 'follow'}>{data.following ? t('Following', '已关注') : t('Follow', '关注')}</Button>}{l.public && <Button onClick={() => void share()}>{t('Share', '分享')}</Button>}{data.mine && !edit && <Button variant="ghost" onClick={() => setEdit({ title: l.title, description: l.description || '', public: l.public })}>{t('Edit', '编辑')}</Button>}</div>} />
      {l.hidden && <p className="bad fs-sm">{t('This list was taken down by the HearthCade team. Only you can see it.', '此清单已被 HearthCade 团队下架，只有你能看到。')}</p>}
      {edit ? (
        <Card pad><div className="stack s">
          <Input value={edit.title} maxLength={80} onChange={(e) => setEdit({ ...edit, title: e.target.value })} aria-label={t('Title', '标题')} />
          <Textarea rows={3} maxLength={600} value={edit.description} onChange={(e) => setEdit({ ...edit, description: e.target.value })} placeholder={t('What makes these games belong together?', '这些游戏为什么放在一起？')} aria-label={t('Description', '描述')} />
          <label className="row fs-sm"><input type="checkbox" checked={edit.public} onChange={(e) => setEdit({ ...edit, public: e.target.checked })} /> {t('Public: anyone with the link can see and follow it', '公开：任何拿到链接的人都能查看和关注')}</label>
          <div className="row"><Button size="sm" variant="primary" onClick={() => void save()} disabled={busy === 'save' || !edit.title.trim()}>{t('Save', '保存')}</Button><Button size="sm" variant="ghost" onClick={() => setEdit(null)}>{t('Cancel', '取消')}</Button><span className="grow" /><Button size="sm" variant="ghost" onClick={() => void remove()} disabled={busy === 'del'}>{t('Delete list', '删除清单')}</Button></div>
        </div></Card>
      ) : l.description && <p className="mute" style={{ maxWidth: 720 }}>{l.description}</p>}
      {data.games.length ? (
        <div className="grid browse-grid">{data.games.map((g, i) => (
          <div key={g.id} className="stack s">
            <GameTile g={g} />
            {note?.id === g.id ? (
              <div className="stack s"><Textarea rows={2} maxLength={140} value={note.text} onChange={(e) => setNote({ id: g.id, text: e.target.value })} aria-label={t('Note', '备注')} autoFocus /><div className="row"><Button size="sm" variant="primary" onClick={() => void saveNote()} disabled={busy === 'note'}>{t('Save', '保存')}</Button><Button size="sm" variant="ghost" onClick={() => setNote(null)}>{t('Cancel', '取消')}</Button></div></div>
            ) : g.note && <p className="fs-sm list-note">{g.note}</p>}
            {data.mine && note?.id !== g.id && (
              <div className="row fs-sm list-tools">
                <button type="button" className="linkish" onClick={() => setNote({ id: g.id, text: g.note || '' })}>{g.note ? t('Edit note', '编辑备注') : t('Add a note', '添加备注')}</button>
                {i > 0 && <button type="button" className="linkish" onClick={() => void move(i, -1)} aria-label={t('Move earlier', '前移')}>←</button>}
                {i < data.games.length - 1 && <button type="button" className="linkish" onClick={() => void move(i, 1)} aria-label={t('Move later', '后移')}>→</button>}
                <button type="button" className="linkish" onClick={() => void drop(g.id)}>{t('Remove', '移除')}</button>
              </div>
            )}
          </div>
        ))}</div>
      ) : <EmptyState title={t('No games on this list yet', '此清单还没有游戏')}>{data.mine ? t('Open a game\'s page and choose Add to list.', '打开游戏页面，选择"加入清单"。') : null}</EmptyState>}
    </div>
  );
}

/** The game page's "Add to list": tick the viewer's lists, or start a new one with this game. */
export function AddToList({ slug }: { slug: string }) {
  const { user, toast } = useApp(), { busy, act } = useAct();
  const [open, setOpen] = useState(false), [title, setTitle] = useState('');
  const { data, reload } = useData<{ lists: { id: string; slug: string; title: string; public: boolean; has: boolean }[] }>(open && user ? `/me/lists?game=${encodeURIComponent(slug)}` : null);
  if (!user) return null;
  const toggle = (l: { slug: string; title: string; has: boolean }) => act('t' + l.slug, async () => {
    if (l.has) await api(`/collections/${l.slug}/games/${encodeURIComponent(slug)}`, { method: 'DELETE' }); else await api(`/collections/${l.slug}/games`, { body: { game: slug } });
    await reload(); toast(l.has ? t('Removed from {title}.', '已从「{title}」移除。', { title: l.title }) : t('Added to {title}.', '已加入「{title}」。', { title: l.title }));
  });
  const create = () => act('new', async () => { const r = await api<{ slug: string; title: string }>('/collections', { body: { title, game: slug } }); setTitle(''); await reload(); toast(t('Added to {title}.', '已加入「{title}」。', { title: r.title })); });
  return (
    <div className="stack s">
      <Button block onClick={() => setOpen(!open)} aria-expanded={open}>{t('Add to list', '加入清单')}</Button>
      {open && (
        <div className="stack s list-pick">
          {data?.lists.map((l) => <label key={l.id} className="row fs-sm"><input type="checkbox" checked={l.has} disabled={busy === 't' + l.slug} onChange={() => void toggle(l)} /><span className="grow clip">{l.title}</span>{!l.public && <span className="dim">{t('Private', '私密')}</span>}</label>)}
          <form className="row" onSubmit={(e) => { e.preventDefault(); if (title.trim()) void create(); }}>
            <Input className="grow" value={title} maxLength={80} onChange={(e) => setTitle(e.target.value)} placeholder={t('New list', '新建清单')} aria-label={t('New list title', '新清单标题')} />
            <Button size="sm" type="submit" disabled={busy === 'new' || !title.trim()}>{t('Create', '创建')}</Button>
          </form>
        </div>
      )}
    </div>
  );
}
