// Mounts the effects behind and above the app. It reads the plan from gl.ts, loads the Three.js world only when the
// browser can run it (a separate chunk, fetched after the page has painted), paints the Canvas 2D world where it
// cannot, and adds the particle overlay. If the GPU path fails at any point (the chunk will not load, a shader will
// not compile, the context is lost), it records that for the session and moves to the Canvas 2D world; the page
// itself never changes.
import { useEffect, useRef, useState } from 'react';
import { useLocation } from '../../lib';
import { fxPlan, markGpuFailed, themeFor, type FxPlan } from './gl';
import { fxBurst, Overlay } from './overlay';
import type { World } from './world3d';
import { World2d } from './world2d';

type AnyWorld = Pick<World, 'start' | 'dispose' | 'setTheme' | 'pageChange'> & { stats: object };
const idle = (f: () => void) => { const w = window as Window & { requestIdleCallback?: (f: () => void, o?: { timeout: number }) => number }; if (w.requestIdleCallback) w.requestIdleCallback(f, { timeout: 600 }); else setTimeout(f, 60); };

export function GpuLayer() {
  const bg = useRef<HTMLCanvasElement>(null), top = useRef<HTMLCanvasElement>(null), world = useRef<AnyWorld | null>(null);
  const loc = useLocation(), path = loc.split('?')[0];
  const [plan, setPlan] = useState<FxPlan>(() => fxPlan());
  const theme = themeFor(path), themeRef = useRef(theme); themeRef.current = theme;

  useEffect(() => { const f = () => setPlan(fxPlan()); addEventListener('fxchange', f); return () => removeEventListener('fxchange', f); }, []);
  useEffect(() => { world.current?.setTheme(theme); world.current?.pageChange(); }, [path, theme]);

  // the world behind the page
  useEffect(() => {
    const cv = bg.current; if (!cv || plan.engine === 'none') return;
    let w: AnyWorld | null = null, dead = false;
    const expose = () => { (window as unknown as { __fx: unknown }).__fx = { plan, burst: fxBurst, get stats() { return world.current?.stats; } }; };
    const fail = (why: string) => { console.warn('[fx] GPU world off, using the Canvas 2D look:', why); markGpuFailed(why); };
    if (plan.engine === 'canvas') {
      try { w = new World2d(cv, plan.tier, themeRef.current); world.current = w; w.start(); expose(); } catch (e) { console.warn('[fx] effects off:', (e as Error).message); }
    } else {
      idle(() => {
        import('./world3d').then(({ World }) => {
          if (dead) return;
          try { w = new World(cv, plan.tier, themeRef.current, fail); world.current = w; w.start(); expose(); }
          catch (e) { fail((e as Error).message || 'init'); }
        }, () => { if (!dead) fail('chunk'); });
      });
    }
    return () => { dead = true; w?.dispose(); if (world.current === w) world.current = null; };
  }, [plan]);

  // the particle overlay above the page (not under reduced motion)
  useEffect(() => {
    const cv = top.current; if (!cv || plan.tier === 'off' || plan.tier === 'still') return;
    let o: Overlay | null = null;
    try { o = new Overlay(cv, plan.tier === 'full' ? 260 : plan.tier === 'lite' ? 110 : 160); } catch { return; }
    return () => o?.dispose();
  }, [plan]);

  if (plan.engine === 'none') return null;
  // A fresh canvas for each plan: one that held a WebGL context cannot be given a 2D context afterwards.
  return <>
    <canvas key={'bg-' + plan.engine + plan.tier} ref={bg} className="gpu-layer" aria-hidden="true" />
    {plan.tier !== 'still' && plan.tier !== 'off' && <canvas key="fx-top" ref={top} className="fx-overlay" aria-hidden="true" />}
  </>;
}
