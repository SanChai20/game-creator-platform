// "Continue playing": the signed-in player's own games, most recently played first, on the store front and in their
// library. Each card opens the game straight away (/g/:slug?play=1), which hands the game GCP.launch.continue so it
// can load the saved run. Where the player is comes from the game's GCP.resume when it says, otherwise from the
// platform's own record (play time, last played, last saved). Built from the account's data, so it follows the player
// to every device; signed-out visitors keep the browser's own "Jump back in".
import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { ago, api, artStyle, CoverImg, genreHue, Link, shown, MatureTag, num, playTime, t, useAct, type GameCard } from './lib';
import { SectionHead } from './store';

export interface ContinueInfo { first_played: number; last_played: number; sessions: number; seconds: number; saved_at: number | null; resume: { label: string; detail?: string; progress?: number; at: number } | null; owned: boolean }
export type ContinueGame = GameCard & { progress: ContinueInfo };

/** The words under the title: the game's own (Act 2, Floor 14) or, without them, when the player last saved or played. */
export function whereLeft(p: ContinueInfo) {
  if (p.resume) return p.resume.label;
  return p.saved_at ? t('Saved {time}', '{time}存档', { time: ago(p.saved_at) }) : t('Played {time}', '{time}玩过', { time: ago(p.last_played) });
}

/** One game on the Continue row: the cover opens it, the button says what pressing does, × takes it off the row. */
export function ContinueCard({ g: raw, onHide }: { g: ContinueGame; onHide?: (slug: string) => void }) {
  const g = shown(raw), p = g.progress, go = p.owned ? `/g/${g.slug}?play=1` : `/g/${g.slug}`, title = g.title, genre = g.tags[0];
  const pct = p.resume?.progress != null ? Math.round(p.resume.progress * 100) : null;
  return (
    <article className="cont" style={{ '--h': genre ? genreHue(genre) : 350 } as CSSProperties}>
      <Link to={go} className="cont-art" style={g.cover ? undefined : artStyle(g.slug)} aria-label={p.owned ? t('Continue {title}', '继续游玩 {title}', { title }) : title}>
        {g.cover ? <CoverImg g={g} src={g.cover} /> : <span className="mono-title">{title}</span>}
        <MatureTag g={g} />
        {p.owned && <span className="cont-go" aria-hidden="true"><i className="play-tri" /></span>}
        {pct !== null && <span className="cont-bar on-art" aria-hidden="true"><b style={{ width: `${pct}%` }} /></span>}
      </Link>
      <div className="cont-b">
        <Link to={`/g/${g.slug}`} className="cont-t clip">{title}</Link>
        <p className="cont-where clip" title={p.resume?.detail ? `${p.resume.label} · ${p.resume.detail}` : undefined}>
          {p.resume && <i className="cont-pin" aria-hidden="true" />}{whereLeft(p)}{pct !== null && <span className="cont-pct num"> · {pct}%</span>}
        </p>
        {p.resume?.detail && <p className="cont-detail clip">{p.resume.detail}</p>}
        <p className="cont-meta">{t('{time} played · {ago}', '已玩 {time} · {ago}', { time: playTime(p.seconds), ago: ago(p.last_played) })}</p>
      </div>
      <div className="cont-act">
        <Link to={go} className={'btn btn-sm' + (p.owned ? ' btn-primary' : '')}>{p.owned ? t('Continue', '继续游戏') : t('View game', '查看游戏')}</Link>
        {onHide && <button type="button" className="cont-x" onClick={() => onHide(g.slug)} aria-label={t('Remove {title} from Continue playing', '从“继续游玩”中移除 {title}', { title })} title={t('Remove from Continue playing', '从“继续游玩”中移除')}>×</button>}
      </div>
    </article>
  );
}

/** Takes a game off the row (until it is played again), with an Undo-free toast: playing it brings it back. */
export function useHide(setGames: (f: (l: ContinueGame[]) => ContinueGame[]) => void) {
  const { act } = useAct();
  return useCallback((slug: string) => {
    setGames((l) => l.filter((g) => g.slug !== slug));
    void act('hide' + slug, () => api(`/me/continue/${encodeURIComponent(slug)}`, { method: 'DELETE' }), t('Removed. It comes back when you play it again.', '已移除，再次游玩后会重新出现。'));
  }, [act, setGames]);
}

/** The store front's Continue row for a signed-in player. Nothing until it loads, and nothing for someone who has not played yet. */
export function ContinueRow({ onEmpty }: { onEmpty?: () => void }) {
  const [games, setGames] = useState<ContinueGame[] | null>(null), row = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let on = true;
    api<{ games: ContinueGame[] }>('/me/continue?limit=10').then((r) => { if (on) { setGames(r.games); if (!r.games.length) onEmpty?.(); } }, () => { if (on) { setGames([]); onEmpty?.(); } });
    return () => { on = false; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const hide = useHide((f) => setGames((l) => f(l || [])));
  if (!games?.length) return null;
  const total = games.reduce((a, g) => a + g.progress.seconds, 0);
  return (
    <section className="cont-shelf">
      <SectionHead title={t('Continue playing', '继续游玩')} note={t('{n} games · {time} played. Pick up where you left off, on any device.', '{n} 款游戏 · 已玩 {time}。在任何设备上从上次离开的地方继续。', { n: num(games.length), time: playTime(total) })} to="/library" more={t('Your library', '我的游戏库')} />
      <div className="cont-row" ref={row}>{games.map((g) => <ContinueCard key={g.id} g={g} onHide={hide} />)}</div>
    </section>
  );
}
