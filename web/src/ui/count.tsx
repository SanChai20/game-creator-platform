// A figure that rolls up to its value when it first appears.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { reducedMotion } from './fx/gl';

/**
 * Rolls a displayed figure ("42", "4.7K", "$126.50", "1,204") up from zero when it first appears, keeping its
 * prefix, suffix, separators and decimals. Anything that is not a figure is shown as it is. Screen readers get the
 * final value straight away, and under reduced motion nothing moves.
 */
export function CountUp({ value }: { value: ReactNode }) {
  const text = typeof value === 'number' ? String(value) : typeof value === 'string' ? value : null;
  const m = text?.match(/^([^\d-]*)(-?[\d,]*\.?\d+)(.*)$/);
  const [shown, setShown] = useState<string | null>(null), done = useRef(false);
  useEffect(() => {
    if (!m || done.current || reducedMotion()) return;
    const [, pre, num, post] = m, target = parseFloat(num.replace(/,/g, '')), dec = (num.split('.')[1] || '').length, commas = num.includes(',');
    if (!isFinite(target) || target === 0) return;
    done.current = true;
    const fmt = (v: number) => { let s = v.toFixed(dec); if (commas) { const [i, f] = s.split('.'); s = i.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (f ? '.' + f : ''); } return pre + s + post; };
    const t0 = performance.now(), dur = 600 + Math.min(400, Math.log10(Math.abs(target) + 1) * 120);
    let raf = 0;
    const tick = (now: number) => {
      const k = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - k, 4);
      if (k < 1) { setShown(fmt(target * e)); raf = requestAnimationFrame(tick); } else setShown(null);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [text]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!m) return <>{value}</>;
  return <span className="count-up">{shown === null ? text : <><span aria-hidden="true">{shown}</span><span className="sr-only">{text}</span></>}</span>;
}
