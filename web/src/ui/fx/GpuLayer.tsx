// Mounts the GPU layer behind the app. It decides the tier, starts the pipeline, plays the level-load transition on
// page changes, and falls back to the plain CSS look if anything fails (no WebGL 2, a shader error, a lost context).
import { useEffect, useRef, useState } from 'react';
import { useLocation } from '../../lib';
import { fxTier, type FxTier } from './gl';
import { Pipeline } from './pipeline';

export function GpuLayer() {
  const ref = useRef<HTMLCanvasElement>(null), pipe = useRef<Pipeline | null>(null), loc = useLocation();
  const [tier, setTier] = useState<FxTier>(() => fxTier()), [failed, setFailed] = useState(0);

  useEffect(() => { const f = () => setTier(fxTier()); addEventListener('fxchange', f); return () => removeEventListener('fxchange', f); }, []);
  useEffect(() => { pipe.current?.pageChange(); }, [loc.split('?')[0]]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const cv = ref.current; if (!cv || tier === 'off' || failed > 1) return;
    let p: Pipeline;
    try { p = new Pipeline(cv, tier, () => setFailed((n) => n + 1)); }
    catch (e) { console.warn('[fx] GPU layer off:', (e as Error).message); setFailed(2); return; }
    pipe.current = p; p.start();
    (window as unknown as { __fx: Pipeline }).__fx = p; // live stats for checking performance: __fx.stats
    return () => { p.dispose(); pipe.current = null; };
  }, [tier, failed]);

  // A lost context gets one fresh canvas; a second failure leaves the CSS look in place.
  if (tier === 'off' || failed > 1) return null;
  return <canvas key={`${tier}-${failed}`} ref={ref} className="gpu-layer" aria-hidden="true" />;
}
