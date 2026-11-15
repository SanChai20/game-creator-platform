// The Vault: the home page's opening exhibition. The trending games stand in a 3D gallery as numbered collectibles
// (hall.js, three.js plus the materials kit), with the page's own text and controls laid over it in the DOM, so
// everything you need to read or press is ordinary, accessible HTML that works at once.
//
// The scene is an enhancement. It loads after the page is up, only where it will run well; until then, and on devices
// without WebGL 2, with Save-Data, on weak hardware or with effects switched off, the same exhibit is shown as a
// framed card in plain CSS. Reduced motion gets a still hall that only moves when you ask it to.
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as RPointerEvent } from 'react';
import { artStyle, count, Link, navigate, num, price, RARITY, rarity, rarityHint, Stars, t, useLang, type GameCard } from '../lib';
import { Button } from '../ui';
import { fxForced, fxTier, fxWeak, holdFx } from '../ui/fx';
import type { Exhibit, Hall } from './hall';

const MAX = 12;
type Mode = 'css' | 'loading' | '3d';

/** Two colours from a slug, matching artStyle(), for covers the scene has to paint itself. */
function artColors(seed: string): [string, string] {
  let h = 2166136261; for (let i = 0; i < seed.length; i++) { h ^= seed.charCodeAt(i); h = Math.imul(h, 16777619); } h >>>= 0;
  const a = h % 360, b = (a + 35 + ((h >> 9) % 90)) % 360;
  return [`hsl(${a} 70% 50%)`, `hsl(${b} 45% 16%)`];
}

export function Vault({ games }: { games: GameCard[] }) {
  const lang = useLang();
  const list = useMemo(() => games.slice(0, MAX), [games]);
  const [i, setI] = useState(0), [mode, setMode] = useState<Mode>('css'), [pct, setPct] = useState(0);
  const canvas = useRef<HTMLCanvasElement>(null), hall = useRef<Hall | null>(null), root = useRef<HTMLElement>(null);
  const g = list[Math.min(i, list.length - 1)], rar = rarity(g), R = RARITY[rar];
  const ids = list.map((x) => x.id).join(',');
  const playing = games.reduce((a, x) => a + (x.playing || 0), 0);

  const go = useCallback((n: number) => {
    const k = Math.max(0, Math.min(list.length - 1, n));
    if (hall.current) hall.current.focusOn(k); else setI(k);
  }, [list.length]);

  // Decide and load the scene. Re-built when the games or the language change (the cards are painted with text).
  useEffect(() => {
    const tier = fxTier(), forced = fxForced();
    if (tier === 'off' || (fxWeak() && !forced) || !list.length) { setMode('css'); return; }
    let gone = false, h: Hall | null = null;
    setMode('loading'); setPct(0.04);
    const begin = async () => {
      try {
        const mod = await import('./hall.js');
        if (gone || !canvas.current) return;
        setPct(0.3);
        const exhibits: Exhibit[] = list.map((x) => {
          const r = RARITY[rarity(x)];
          return {
            title: x.title, by: `${t('by', '作者')} ${x.author}`, cover: x.cover, color: r.color, rarityLabel: r.name(), foil: r.foil,
            ratingLabel: x.rating == null ? t('New', '新作') : `★ ${x.rating.toFixed(1)}`, playsLabel: `${num(x.plays)} ${t(x.plays === 1 ? 'play' : 'plays', '次')}`,
            priceLabel: price(x.price_cents), paid: x.price_cents > 0, art: artColors(x.slug),
          };
        });
        h = await mod.createHall(canvas.current, {
          exhibits, tier: tier as 'full' | 'lite' | 'still', start: Math.min(i, list.length - 1), forced,
          onProgress: (p) => { if (!gone) setPct(0.3 + p * 0.7); },
          onFocus: (k) => setI(k),
          onOpen: (k) => navigate(`/g/${list[k].slug}`),
          onFail: () => { hall.current = null; setMode('css'); holdFx(false); },
        });
        if (gone) { h?.dispose(); return; }
        if (!h) { setMode('css'); return; }
        hall.current = h; setMode('3d');
        (window as unknown as { __vault: Hall }).__vault = h; // live stats for checking performance: __vault.stats
      } catch (e) {
        console.warn('[vault] staying with the CSS exhibit:', (e as Error).message);
        if (!gone) setMode('css');
      }
    };
    // after the page has painted, so the text and the catalogue come first
    const idle = (window as unknown as { requestIdleCallback?: (f: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
    const id = idle ? idle(() => void begin(), { timeout: 900 }) : window.setTimeout(() => void begin(), 200);
    return () => {
      gone = true;
      const cancel = (window as unknown as { cancelIdleCallback?: (n: number) => void }).cancelIdleCallback;
      if (idle && cancel) cancel(id); else clearTimeout(id);
      hall.current?.dispose(); hall.current = null; h = null; holdFx(false);
    };
  }, [ids, lang]); // eslint-disable-line react-hooks/exhaustive-deps

  // Render only while the hall is on screen; hold the page's background layer while the hall fills the view.
  useEffect(() => {
    const el = root.current; if (!el || mode !== '3d') return;
    const io = new IntersectionObserver(([e]) => {
      hall.current?.setActive(e.intersectionRatio > 0.02);
      holdFx(e.intersectionRatio > 0.45);
    }, { threshold: [0, 0.02, 0.45, 0.6, 1] });
    io.observe(el);
    return () => { io.disconnect(); holdFx(false); };
  }, [mode]);

  // ← → (and A / D) browse the hall while it is on screen, unless you are typing somewhere.
  useEffect(() => {
    const f = (e: KeyboardEvent) => {
      if (e.altKey || e.ctrlKey || e.metaKey || e.defaultPrevented) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
      const r = root.current?.getBoundingClientRect(); if (!r || r.bottom < 80 || r.top > innerHeight - 80) return;
      const k = e.key.toLowerCase();
      if (k === 'arrowleft' || k === 'a') { e.preventDefault(); go(i - 1); }
      else if (k === 'arrowright' || k === 'd') { e.preventDefault(); go(i + 1); }
    };
    addEventListener('keydown', f); return () => removeEventListener('keydown', f);
  }, [i, go]);

  // Swipe on the CSS exhibit too, so phones without the scene browse the same way.
  const touch = useRef<{ x: number; y: number } | null>(null);
  const swipe = {
    onPointerDown: (e: RPointerEvent) => { touch.current = { x: e.clientX, y: e.clientY }; },
    onPointerUp: (e: RPointerEvent) => {
      const s = touch.current; touch.current = null; if (!s) return;
      const dx = e.clientX - s.x; if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(e.clientY - s.y)) go(i + (dx < 0 ? 1 : -1));
    },
  };

  const no = (n: number) => String(n + 1).padStart(2, '0');
  return (
    <section className={'vault vault-' + mode} ref={root} aria-roledescription={t('exhibition', '展览')} aria-label={t('The Vault: trending games', '藏馆：热门游戏')}>
      <div className="vault-stage">
        <canvas ref={canvas} className="vault-canvas" aria-hidden="true" />
        {mode !== '3d' && (
          <div className="vault-still" aria-hidden="true" {...swipe}>
            <div className="vs-spot" />
            <Link to={`/g/${g.slug}`} className="vs-card" key={g.id}>
              <span className="vs-frame" style={{ '--rc': R.color } as CSSProperties}>
                <span className="vs-head"><b>No. {no(i)}</b><b>{R.name()}</b></span>
                <span className="vs-art" style={g.cover ? undefined : artStyle(g.slug)}>{g.cover && <img src={g.cover} alt="" />}</span>
                <span className="vs-title">{g.title}</span>
              </span>
            </Link>
            <div className="vs-plinth" />
          </div>
        )}
        {mode === 'loading' && <div className="vault-load" role="progressbar" aria-label={t('Loading the 3D hall', '正在载入 3D 展厅')} aria-valuenow={Math.round(pct * 100)} aria-valuemin={0} aria-valuemax={100}><i style={{ transform: `scaleX(${pct})` }} /></div>}
      </div>

      <div className="wrap vault-ui">
        <div className="vault-intro">
          <span className="vault-kicker"><i aria-hidden="true" />{t('The Vault', '藏馆')} · {playing > 0 ? `${num(playing)} ${t('playing right now', '人正在游玩')}` : `${t('Now showing', '正在展出')} ${list.length}`}</span>
          <h1>{t('Web games, built by creators with their', '网页游戏，由创作者与')} <mark>{t('AI agents', 'AI 智能体')}</mark>{t('.', '打造。')}</h1>
        </div>

        <div className="exhibit" aria-live="polite">
          <div className="ex-tag" style={{ '--rc': R.color } as CSSProperties}>
            <span className="rar" title={rarityHint()}>{R.name()}</span>
            <span className="ex-no">No. {no(i)} <span>/ {String(list.length).padStart(2, '0')}</span></span>
            {g.featured && <span className="ex-feat">{t('Featured', '精选')}</span>}
          </div>
          <h2>{g.title}</h2>
          {g.tagline && <p className="lede">{g.tagline}</p>}
          <div className="ex-meta"><span>{t('by', '作者')} <b>{g.author}</b></span><Stars rating={g.rating} count={g.rating_count} /><span className="num">{count(g.plays, 'play', 'plays', '次游玩')}</span>{!!g.playing && <span className="ex-live">{num(g.playing)} {t('playing now', '人在玩')}</span>}</div>
          <div className="ex-actions">
            <Button to={`/g/${g.slug}`} variant="primary" size="lg">{g.price_cents > 0 ? `${t('Get it', '购买')} · ${price(g.price_cents)}` : `▶ ${t('Play free', '免费游玩')}`}</Button>
            <Button to={`/g/${g.slug}`} size="lg">{t('Details', '详情')}</Button>
          </div>
        </div>

        {list.length > 1 && (
          <div className="vault-nav">
            <button className="vn-arrow" onClick={() => go(i - 1)} disabled={i === 0} aria-label={t('Previous game', '上一款')}>←</button>
            <div className="vn-dots" role="group" aria-label={t('Choose a game', '选择游戏')}>
              {list.map((x, k) => <button key={x.id} className={k === i ? 'on' : ''} style={{ '--rc': RARITY[rarity(x)].color } as CSSProperties} onClick={() => go(k)} aria-label={`${no(k)} ${x.title}`} aria-current={k === i || undefined} />)}
            </div>
            <button className="vn-arrow" onClick={() => go(i + 1)} disabled={i === list.length - 1} aria-label={t('Next game', '下一款')}>→</button>
            <span className="vn-hint">{t('Arrow keys or drag to browse', '方向键或拖动浏览')}</span>
          </div>
        )}
      </div>
    </section>
  );
}
