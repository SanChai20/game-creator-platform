// Measures what this browser and device can do, for the store page's compatibility verdict. Runs once per page load.
// Everything here asks the browser directly (a real WebGPU adapter request, real WebGL contexts) rather than guessing
// from the user agent; the user agent is used only to name the browser and system for minimum versions and known issues.
import { parseUA, type Device, type Feature, type Probe, type Tri } from './compat';

const SIMD = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]);

function gl(): { webgl: boolean; webgl2: boolean; renderer: string; software: boolean | null } {
  let webgl = false, webgl2 = false, renderer = '';
  try {
    const c2 = document.createElement('canvas'), g2 = c2.getContext('webgl2');
    webgl2 = !!g2;
    const c1 = document.createElement('canvas'), g1 = (c1.getContext('webgl') || c1.getContext('experimental-webgl')) as WebGLRenderingContext | null;
    webgl = !!g1 || webgl2;
    const g = (g2 || g1) as WebGLRenderingContext | null;
    if (g) {
      const ext = g.getExtension('WEBGL_debug_renderer_info');
      renderer = String((ext ? g.getParameter(ext.UNMASKED_RENDERER_WEBGL) : g.getParameter(g.RENDERER)) || '');
      g.getExtension('WEBGL_lose_context')?.loseContext();
      g2 && g1 && (g1.getExtension('WEBGL_lose_context')?.loseContext());
    }
  } catch { /* no WebGL */ }
  const software = !renderer ? null : /swiftshader|llvmpipe|softpipe|software|basic render|microsoft basic|mesa offscreen/i.test(renderer) ? true : false;
  return { webgl, webgl2, renderer, software };
}

async function webgpu(): Promise<Tri> {
  const nav = navigator as Navigator & { gpu?: { requestAdapter: () => Promise<unknown> } };
  if (!nav.gpu) return false;
  try { return !!(await Promise.race([nav.gpu.requestAdapter(), new Promise((r) => setTimeout(() => r(undefined), 2500))])) || false; } catch { return false; }
}

function device(touch: boolean): Device {
  const uad = (navigator as Navigator & { userAgentData?: { mobile?: boolean } }).userAgentData, ua = navigator.userAgent;
  const short = Math.min(screen.width, screen.height), fine = matchMedia('(any-pointer: fine)').matches;
  if (uad?.mobile || /iPhone|iPod|Android.+Mobile|Mobile Safari/.test(ua) && short < 600) return 'mobile';
  if (/iPad|Tablet|Android(?!.+Mobile)/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) || (touch && !fine)) return short < 600 ? 'mobile' : 'tablet';
  return 'desktop';
}

let cached: Promise<Probe> | null = null;
/** What this browser has. Resolves in well under a second; WebGPU's adapter request is the slow part and is capped. */
export function probe(): Promise<Probe> {
  return cached ??= (async () => {
    const g = gl(), touch = navigator.maxTouchPoints > 0 || 'ontouchstart' in window;
    const fine = matchMedia('(any-pointer: fine)').matches, dev = device(touch);
    const has = (v: unknown): Tri => !!v;
    let simd: Tri = null;
    try { simd = typeof WebAssembly === 'object' ? WebAssembly.validate(SIMD) : false; } catch { simd = false; }
    const el = document.createElement('div') as HTMLDivElement & { webkitRequestFullscreen?: unknown };
    const features: Partial<Record<Feature, Tri>> = {
      'webassembly': typeof WebAssembly === 'object',
      'wasm-simd': simd,
      // games run in their own frame without cross-origin isolation, so threads are never available to them
      'wasm-threads': false,
      'web-audio': has(window.AudioContext || (window as unknown as { webkitAudioContext?: unknown }).webkitAudioContext),
      'audio-worklet': has(window.AudioWorkletNode),
      'pointer-lock': dev === 'desktop' ? has(el.requestPointerLock) : has(el.requestPointerLock) && fine,
      'fullscreen': has(el.requestFullscreen || el.webkitRequestFullscreen) && document.fullscreenEnabled !== false,
      'web-workers': has(window.Worker),
      'offscreen-canvas': has(window.OffscreenCanvas),
      'indexeddb': has(window.indexedDB),
      'webxr': has((navigator as Navigator & { xr?: unknown }).xr) ? null : false,  // the API exists; whether a headset is there is only known when the game asks
      'webrtc': has(window.RTCPeerConnection),
      'es-modules': 'noModule' in HTMLScriptElement.prototype,
      'import-maps': typeof HTMLScriptElement.supports === 'function' ? HTMLScriptElement.supports('importmap') : false,
      'device-motion': has(window.DeviceMotionEvent) ? (dev === 'desktop' ? null : true) : false,
    };
    const pads = (() => { try { return Array.from(navigator.getGamepads?.() || []).some(Boolean); } catch { return false; } })();
    const { browser, os } = parseUA(navigator.userAgent, navigator.maxTouchPoints);
    const mem = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
    return {
      graphics: { canvas: has(document.createElement('canvas').getContext('2d')), webgl: g.webgl, webgl2: g.webgl2, webgpu: await webgpu() },
      gpu: g.software === null ? null : g.software ? 'software' : 'hardware', renderer: g.renderer,
      features,
      // A keyboard cannot be detected. On a computer assume one; on a phone or tablet it is unknown (one may be attached).
      input: { keyboard: dev === 'desktop' ? true : null, mouse: fine ? true : dev === 'desktop' ? null : false, touch: touch ? true : dev === 'desktop' ? false : null, gamepad: pads ? true : has(navigator.getGamepads) ? null : false },
      device: dev, browser, os,
      memory_gb: typeof mem === 'number' ? mem : null,
      orientation: innerWidth >= innerHeight ? 'landscape' : 'portrait',
    };
  })();
}
