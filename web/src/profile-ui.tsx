// The Account page's profile card (src/profiles.js): who sees the profile, the bio, and the games in the showcase.
import { useEffect, useState } from 'react';
import { api, Link, playTime, t, useAct, useData } from './lib';
import { Button, Segmented, Textarea } from './ui';

type Vis = 'everyone' | 'friends' | 'nobody';
interface Settings { id: string; visibility: Vis; bio: string | null; showcase: string[] | null; choices: { id: string; slug: string; title: string; seconds: number }[] }

export function ProfileSettings() {
  const { data, reload } = useData<Settings>('/me/profile');
  const { busy, act } = useAct();
  const [vis, setVis] = useState<Vis>('friends'), [bio, setBio] = useState(''), [pick, setPick] = useState<string[] | null>(null);
  useEffect(() => { if (data) { setVis(data.visibility); setBio(data.bio || ''); setPick(data.showcase); } }, [data]);
  if (!data) return null;
  const toggle = (id: string) => setPick((p) => { const cur = p || []; return cur.includes(id) ? cur.filter((x) => x !== id) : cur.length >= 6 ? cur : [...cur, id]; });
  const changed = vis !== data.visibility || bio !== (data.bio || '') || JSON.stringify(pick) !== JSON.stringify(data.showcase);
  const save = () => act('profile', async () => { await api('/me/profile', { method: 'PUT', body: { visibility: vis, bio, showcase: pick && pick.length ? pick : null } }); await reload(); }, t('Profile saved.', '资料已保存。'));
  return (
    <div className="stack l">
      <div className="stack s">
        <b>{t('Who can see your profile', '谁能看到你的资料')}</b>
        <Segmented label={t('Who can see your profile', '谁能看到你的资料')} value={vis} onChange={setVis} options={[['everyone', t('Everyone', '所有人')], ['friends', t('Friends', '好友')], ['nobody', t('Only me', '仅自己')]]} />
        <span className="dim fs-sm">{t('Your profile shows the games you play, your play time, achievements and reviews. With Everyone, your name on reviews links to it.', '你的资料会显示你玩的游戏、游玩时长、成就和评价。选择“所有人”时，评价中的名字会链接到你的资料。')}</span>
      </div>
      <div className="stack s">
        <b>{t('About you', '关于你')}</b>
        <Textarea value={bio} maxLength={160} rows={2} onChange={(e) => setBio(e.target.value)} placeholder={t('A line about you and the games you like', '一句话介绍你和你喜欢的游戏')} aria-label={t('About you', '关于你')} />
      </div>
      <div className="stack s">
        <b>{t('Showcase', '展示柜')}</b>
        <span className="dim fs-sm">{t('Pick up to 6 games to show first. With none picked, your most played games show.', '最多选择 6 款游戏优先展示。未选择时显示你玩得最多的游戏。')}</span>
        {data.choices.length ? <div className="row wrap-row">{data.choices.slice(0, 40).map((g) => {
          const on = !!pick?.includes(g.id);
          return <Button key={g.id} size="sm" variant={on ? 'primary' : 'ghost'} onClick={() => toggle(g.id)} aria-pressed={on}>{on ? `${(pick || []).indexOf(g.id) + 1}. ` : ''}{g.title}{g.seconds ? ` · ${playTime(g.seconds)}` : ''}</Button>;
        })}</div> : <span className="mute fs-sm">{t('Play a game and it shows up here.', '玩过的游戏会出现在这里。')}</span>}
      </div>
      <div className="row"><Button variant="primary" onClick={() => void save()} disabled={!changed || busy === 'profile'}>{t('Save profile', '保存资料')}</Button><Link className="sig fs-sm" to={`/u/${encodeURIComponent(data.id)}`}>{t('View your profile', '查看我的资料')} →</Link></div>
    </div>
  );
}
