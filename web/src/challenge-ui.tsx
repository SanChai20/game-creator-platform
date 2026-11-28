// Daily and weekly challenges (src/challenges.js): the home page's card with today's challenge game, the day's board,
// the player's streak, and the week's shared goal.
import { useEffect, useState } from 'react';
import { GameTile, Link, local, loginUrl, num, t, useApp, useData, type GameCard } from './lib';
import { SectionHead } from './store';
import './follow.css';

interface Row { rank: number; name: string; score: number; me: boolean }
interface Challenges {
  daily: { day: string; board: string; lower_wins: boolean; ends_at: number; game: GameCard; top: Row[]; mine: { score: number; rank: number } | null; players: number } | null;
  weekly: { week: string; ends_at: number; goal_minutes: number; minutes: number; game: GameCard } | null;
  streak: { streak: number; best: number; days: number; played_today: boolean };
}

function left(ms: number) {
  const m = Math.max(0, Math.round(ms / 60000)), d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60);
  return d ? t('{d}d {h}h left', '剩 {d} 天 {h} 小时', { d, h }) : h ? t('{h}h {m}m left', '剩 {h} 小时 {m} 分', { h, m: m % 60 }) : t('{m}m left', '剩 {m} 分钟', { m: m % 60 });
}
const score = (n: number) => (Number.isInteger(n) ? num(n) : String(Math.round(n * 100) / 100));

/** The home page's challenges card. Hidden when there is neither a daily challenge nor a weekly goal. */
export function ChallengesCard() {
  const { user } = useApp(), { data } = useData<Challenges>('/challenges');
  const [, tick] = useState(0);
  useEffect(() => { const id = setInterval(() => tick((x) => x + 1), 60000); return () => clearInterval(id); }, []);
  if (!data || (!data.daily && !data.weekly)) return null;
  const d = data.daily, w = data.weekly, s = data.streak, pct = w ? Math.min(100, Math.round((w.minutes / w.goal_minutes) * 100)) : 0;
  return (
    <section className="stack l" id="challenges">
      <SectionHead title={t('Daily challenge', '每日挑战')} note={t('One game for everyone today. Come back tomorrow to keep your streak.', '今天大家玩同一款游戏。明天再来，保持连续记录。')} />
      <div className="chal">
        {d && (
          <div className="chal-day">
            <GameTile g={d.game} />
            <div className="stack s">
              <div className="row wrap-row">
                <b className="grow">{t("Today's board", '今日排行')}</b>
                <span className="dim fs-sm">{left(d.ends_at - Date.now())}</span>
              </div>
              <span className="dim fs-sm">{d.lower_wins ? t('Lowest score wins.', '分数越低越好。') : t('Highest score wins.', '分数越高越好。')} {d.players === 1 ? t('1 player so far', '目前 1 位玩家') : t('{n} players so far', '目前 {n} 位玩家', { n: num(d.players) })}</span>
              {d.top.length ? (
                <ol className="chal-board">{d.top.slice(0, 5).map((r) => <li key={r.rank} className={r.me ? 'me' : ''}><span className="chal-rank">{r.rank}</span><span className="grow clip">{r.name}</span><b className="mono">{score(r.score)}</b></li>)}</ol>
              ) : <p className="mute fs-sm">{t('No scores yet today. Be the first.', '今天还没有分数，来拿第一吧。')}</p>}
              {d.mine && d.mine.rank > 5 && <p className="fs-sm">{t('You: #{rank} with {score}', '你：第 {rank} 名，{score} 分', { rank: d.mine.rank, score: score(d.mine.score) })}</p>}
              {user ? (
                <p className="fs-sm chal-streak">{s.streak ? (s.streak === 1 ? t('Streak: 1 day', '连续：1 天') : t('Streak: {n} days', '连续：{n} 天', { n: s.streak })) : t('Play today to start a streak.', '今天玩一局，开始连续记录。')}{s.best > 1 ? ` · ${t('best {n}', '最长 {n}', { n: s.best })}` : ''}{s.streak && !s.played_today ? ` · ${t('play today to keep it', '今天玩一局以保持')}` : ''}</p>
              ) : <p className="dim fs-sm"><Link to={loginUrl()}>{t('Sign in', '登录')}</Link> {t('to get on the board and keep a streak.', '即可上榜并保持连续记录。')}</p>}
            </div>
          </div>
        )}
        {w && (
          <div className="chal-week stack s">
            <b>{t('Weekly goal', '每周目标')}</b>
            <span className="fs-sm">{t('Play {game} together: {goal} minutes by everyone this week.', '一起玩 {game}：本周大家共同完成 {goal} 分钟。', { game: local(w.game, 'title'), goal: num(w.goal_minutes) })}</span>
            <div className="chal-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}><b style={{ width: `${pct}%` }} /></div>
            <span className="dim fs-sm">{t('{n} of {goal} minutes', '{n}/{goal} 分钟', { n: num(w.minutes), goal: num(w.goal_minutes) })} · {pct >= 100 ? t('Goal reached!', '目标达成！') : left(w.ends_at - Date.now())}</span>
            <Link className="sig fs-sm" to={`/g/${encodeURIComponent(w.game.slug)}`}>{t('Play {game}', '玩 {game}', { game: local(w.game, 'title') })} →</Link>
          </div>
        )}
      </div>
    </section>
  );
}
