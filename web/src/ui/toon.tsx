// Small cartoon pieces for the game-like UI: toon icons drawn as inline SVG (thick dark outline, a lit top and a
// shaded bottom, like the particle sprites) and a counter that rolls up to its value like a score.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { color } from './tokens';
import { fxBurst } from './fx/overlay';

const INK = color.ink;
export type ToonIconKind = 'pad' | 'play' | 'bag' | 'coin' | 'star' | 'trophy' | 'gem' | 'clock';

/** A cartoon icon. Decorative: it is hidden from assistive technology, the label beside it carries the meaning. */
export function ToonIcon({ kind }: { kind: ToonIconKind }) {
  const s = { stroke: INK, strokeWidth: 2.4, strokeLinejoin: 'round' as const, strokeLinecap: 'round' as const };
  const shine = <ellipse cx="-4" cy="-5" rx="2.4" ry="1.2" fill="#fff" opacity=".85" transform="rotate(-30)" />;
  const body: Record<ToonIconKind, ReactNode> = {
    pad: <><path d="M-10-4h20a6 6 0 0 1 5.6 8l-2 6a4 4 0 0 1-6.8 1.4L4 8h-8l-2.8 3.4a4 4 0 0 1-6.8-1.4l-2-6A6 6 0 0 1-10-4Z" fill={color.violet} {...s} /><path d="M-8 1h5M-5.5-1.5v5" {...s} strokeWidth={2} /><circle cx="5" cy="0" r="1.6" fill={color.accent} /><circle cx="8.5" cy="3" r="1.6" fill={color.hot} />{shine}</>,
    play: <><circle r="11" fill={color.accent} {...s} /><path d="M-3-5.5 6 0l-9 5.5Z" fill={INK} />{shine}</>,
    bag: <><path d="M-6-4v-2a6 6 0 0 1 12 0v2" fill="none" {...s} /><path d="M-10-4h20l-1.6 14H-8.4Z" fill={color.hot} {...s} /><path d="M-9.4 4h18.8" stroke="rgba(0,0,0,.25)" strokeWidth="3" />{shine}</>,
    coin: <><circle r="11" fill={color.gold} {...s} /><circle r="7" fill="none" stroke="rgba(0,0,0,.25)" strokeWidth="1.6" /><path d="M0-4.5 1.3-1.4 4.4-1 2-.1l.8 3.4L0 1.6l-2.8 1.7.8-3.4-2.4-1.9 3.1-.4Z" fill="rgba(0,0,0,.28)" />{shine}</>,
    star: <><path d="M0-11 3.2-4.4 10.5-3.4 5.2 1.7 6.5 9 0 5.5-6.5 9-5.2 1.7-10.5-3.4-3.2-4.4Z" fill={color.gold} {...s} />{shine}</>,
    trophy: <><path d="M-7-9h14v6a7 7 0 0 1-14 0Z" fill={color.gold} {...s} /><path d="M-7-6h-3a3 3 0 0 0 3 5M7-6h3a3 3 0 0 1-3 5" fill="none" {...s} /><path d="M-2 3h4v4h3v3h-10V7h3Z" fill={color.gold} {...s} />{shine}</>,
    gem: <><path d="M-9-3-5-8H5l4 5L0 10Z" fill={color.cyan} {...s} /><path d="M-9-3H9M-3-8-4-3 0 10M3-8 4-3 0 10" fill="none" stroke="rgba(20,12,38,.5)" strokeWidth="1.2" />{shine}</>,
    clock: <><circle r="11" fill={color.text} {...s} /><path d="M0-6V0l4 3" fill="none" {...s} />{shine}</>,
  };
  return <svg viewBox="-14 -14 28 28" aria-hidden="true" focusable="false">{body[kind]}</svg>;
}

const still = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Rolls a displayed figure ("42", "4.7K", "$126.50", "1,204") up from zero when it first appears, keeping its
 * prefix, suffix, separators and decimals, then gives it a small pop and a sparkle. Anything that is not a
 * figure is shown as it is. Screen readers get the final value straight away.
 */
export function CountUp({ value, burst }: { value: ReactNode; burst?: boolean }) {
  const text = typeof value === 'number' ? String(value) : typeof value === 'string' ? value : null;
  const m = text?.match(/^([^\d-]*)(-?[\d,]*\.?\d+)(.*)$/);
  const [shown, setShown] = useState<string | null>(null), ref = useRef<HTMLSpanElement>(null), done = useRef(false);
  useEffect(() => {
    if (!m || done.current || still()) return;
    const [, pre, num, post] = m, target = parseFloat(num.replace(/,/g, '')), dec = (num.split('.')[1] || '').length, commas = num.includes(',');
    if (!isFinite(target) || target === 0) return;
    done.current = true;
    const fmt = (v: number) => { let s = v.toFixed(dec); if (commas) { const [i, f] = s.split('.'); s = i.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (f ? '.' + f : ''); } return pre + s + post; };
    const t0 = performance.now(), dur = 650 + Math.min(500, Math.log10(Math.abs(target) + 1) * 150);
    let raf = 0;
    const tick = (now: number) => {
      const k = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - k, 3);
      if (k < 1) { setShown(fmt(target * e)); raf = requestAnimationFrame(tick); }
      else { setShown(null); const el = ref.current?.closest('.stat-v, .kpi b') as HTMLElement | null; el?.classList.add('counted'); if (burst && ref.current) fxBurst(ref.current, 'sparkle', 0.5); }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [text]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!m) return <>{value}</>;
  return <span ref={ref} className="count-up">{shown === null ? text : <><span aria-hidden="true">{shown}</span><span className="sr-only">{text}</span></>}</span>;
}
