// A player's profile (/u/<id>): what they play, for how long, the achievements they unlocked and the reviews they
// wrote, shown to the people they chose (src/profiles.js). The owner edits theirs on the Account page.
import { useEffect, useState } from 'react';
import { api, date, Fail, getLang, Link, num, playTime, shown, t, useAct, useApp, useData, type GameCard } from '../lib';
import { Badge, Button, Card, EmptyState, PageHeader, Stat, StatGrid } from '../ui';
import { SectionHead } from '../store';
import { creatorPath, Monogram } from '../follow';
import '../follow.css';

interface ShowGame extends Pick<GameCard, 'id' | 'slug' | 'title' | 'tagline' | 'cover' | 'lang' | 'i18n' | 'age'> { minutes: number; achievements: number; last_played: number | null }
interface ProfileData {
  id: string; name: string; joined_at: number; self: boolean; private: boolean; relation: string | null;
  bio?: string | null; visibility?: string; creator?: boolean;
  stats?: { games: number; minutes: number; achievements: number; reviews: number };
  showcase?: ShowGame[];
  achievements?: { id: string; name: string; description: string; unlocked_at: number; game: { slug: string; title: string } }[];
  reviews?: { rating: number; body: string; at: number; game: { slug: string; title: string; cover: string | null } }[];
}

function FriendAction({ id, relation }: { id: string; relation: string | null }) {
  const { user } = useApp(), { busy, act } = useAct(), [rel, setRel] = useState(relation);
  if (!user || !rel || rel === 'friends' || rel === 'blocked' || rel === 'blocked_by') return rel === 'friends' ? <Badge tone="good">{t('Friends', '好友')}</Badge> : null;
  if (rel === 'requested') return <Badge>{t('Request sent', '已发送请求')}</Badge>;
  const send = () => act('friend', async () => { const r = await api<{ state: string }>('/social/requests', { body: { to: id } }); setRel(r.state === 'friends' ? 'friends' : 'requested'); });
  return <Button size="sm" variant="primary" onClick={() => void send()} disabled={busy === 'friend'}>{rel === 'incoming' ? t('Accept friend request', '接受好友请求') : t('Add friend', '添加好友')}</Button>;
}

export function Profile({ id }: { id: string }) {
  const { data, error, loading, reload } = useData<ProfileData>(`/players/${encodeURIComponent(id)}?lang=${getLang()}`);
  useEffect(() => { if (data) document.title = t('{name} · Player', '{name} · 玩家', { name: data.name }); }, [data]);
  if (error && !data) return <div className="wrap page">{error.status === 404 ? <EmptyState title={t('No such player', '找不到这位玩家')} action={<Button to="/" variant="primary">{t('Back to the store', '返回商店')}</Button>}>{t('The link may be old, or the account may have closed.', '链接可能已失效，或该账户已关闭。')}</EmptyState> : <Fail error={error} retry={reload} />}</div>;
  if (loading || !data) return <div className="wrap page" aria-busy="true" />;
  const p = data, s = p.stats;
  const head = (
    <div className="row prof-head">
      <Monogram id={p.id} name={p.name} size="xl" />
      <div className="grow stack s">
        <PageHeader eyebrow={t('Player', '玩家')} title={p.name} sub={t('Joined {date}', '{date} 加入', { date: date(p.joined_at) })} />
        {p.bio && <p className="prof-bio">{p.bio}</p>}
        <div className="row wrap-row">
          {p.creator && <Link className="sig fs-sm" to={creatorPath(p.id)}>{t('Their games as a creator', '作为创作者的作品')} →</Link>}
          {p.self ? <Button size="sm" to="/account#acct-profile">{t('Edit profile', '编辑资料')}</Button> : <FriendAction id={p.id} relation={p.relation} />}
          {p.self && <span className="dim fs-sm">{p.visibility === 'everyone' ? t('Anyone can see this page.', '所有人都能看到此页面。') : p.visibility === 'friends' ? t('Only your friends can see this page.', '只有你的好友能看到此页面。') : t('Only you can see this page.', '只有你能看到此页面。')}</span>}
        </div>
      </div>
    </div>
  );
  if (p.private) return <div className="wrap page stack xl">{head}<Card pad><p className="mute">{t('This profile is private. Friends may be able to see it.', '此资料未公开，好友或许可以查看。')}</p></Card></div>;
  return (
    <div className="wrap page stack xl">
      {head}
      {s && <StatGrid>
        <Stat label={t('Games played', '玩过的游戏')} value={num(s.games)} />
        <Stat label={t('Time played', '游玩时长')} value={playTime(s.minutes * 60)} />
        <Stat label={t('Achievements', '成就')} value={num(s.achievements)} />
        <Stat label={t('Reviews', '评价')} value={num(s.reviews)} />
      </StatGrid>}
      {!!p.showcase?.length && (
        <section className="stack l">
          <SectionHead title={t('Showcase', '展示柜')} />
          <div className="prof-show">{p.showcase.map((raw) => { const g = shown(raw as never) as ShowGame; return (
            <Link key={g.id} to={`/g/${g.slug}`} className="prof-game">
              <div className="art" style={g.cover ? { backgroundImage: `url(${g.cover})` } : undefined} />
              <b className="clip">{g.title}</b>
              <span className="dim fs-sm">{g.minutes ? playTime(g.minutes * 60) : t('Not played yet', '还没玩过')}{g.achievements ? ` · ★ ${g.achievements}` : ''}</span>
            </Link>); })}</div>
        </section>
      )}
      <div className="cols">
        <section className="stack l">
          <SectionHead title={t('Recent achievements', '最近解锁的成就')} />
          {p.achievements?.length ? <ul className="ach-list">{p.achievements.map((a) => (
            <li key={a.game.slug + a.id}><span className="ach-ico on" aria-hidden="true">★</span><span className="grow"><b>{a.name}</b><span className="dim fs-sm"><Link to={`/g/${a.game.slug}`}>{a.game.title}</Link> · {date(a.unlocked_at)}</span></span></li>
          ))}</ul> : <p className="mute fs-sm">{t('No achievements yet.', '还没有成就。')}</p>}
        </section>
        <section className="stack l">
          <SectionHead title={t('Reviews', '评价')} />
          {p.reviews?.length ? <div className="stack">{p.reviews.map((r) => (
            <Card key={r.game.slug} pad><div className="stack s"><div className="row"><Link className="grow sig" to={`/g/${r.game.slug}`}>{r.game.title}</Link><span aria-label={t('{n} of 5 stars', '{n}/5 星', { n: r.rating })}>{'★'.repeat(r.rating)}<span className="dim">{'★'.repeat(5 - r.rating)}</span></span></div>{r.body && <p className="fs-sm">{r.body}</p>}<span className="dim fs-sm">{date(r.at)}</span></div></Card>
          ))}</div> : <p className="mute fs-sm">{t('No reviews yet.', '还没有评价。')}</p>}
        </section>
      </div>
    </div>
  );
}
