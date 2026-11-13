// @gcp/hud.js — the game's interface as DOM on top of the canvas: counters, bars, a timer, objectives, hints,
// toasts, a start screen and an end screen. Works over 2D and 3D games. Everything is positioned inside the
// safe area, scales down on phones, and never blocks the canvas except for its own buttons.
//   const hud = createHud({ accent: '#ffb347' });
//   const coins = hud.counter('Coins', { icon: '●', value: 0 });   coins.add(1);
//   const hp = hud.bar('Health', { value: 100, max: 100, color: '#e5484d' });   hp.set(64);
//   hud.objective('Find the three keys');   hud.hint('WASD to move, Space to jump', 6);
//   await hud.title({ title: 'Lantern Isle', subtitle: 'Light every beacon before dawn', controls: 'WASD · drag to look · Space' });
//   hud.end({ win: true, title: 'You made it', stats: { Time: '1:42', Coins: 12 }, onRestart: restart });

const CSS = `
.gh{position:fixed;inset:0;z-index:40;pointer-events:none;font:600 15px/1.35 system-ui,-apple-system,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;color:var(--gh-ink);-webkit-user-select:none;user-select:none;--gh-pad:max(14px,env(safe-area-inset-left))}
.gh *{box-sizing:border-box}
.gh-c{position:absolute;display:flex;flex-direction:column;gap:8px;max-width:46vw}
.gh-tl{left:max(14px,env(safe-area-inset-left));top:max(14px,env(safe-area-inset-top));align-items:flex-start}
.gh-tr{right:max(14px,env(safe-area-inset-right));top:max(14px,env(safe-area-inset-top));align-items:flex-end}
.gh-bl{left:max(14px,env(safe-area-inset-left));bottom:max(14px,env(safe-area-inset-bottom));align-items:flex-start}
.gh-br{right:max(14px,env(safe-area-inset-right));bottom:max(14px,env(safe-area-inset-bottom));align-items:flex-end}
.gh-tc{left:50%;top:max(14px,env(safe-area-inset-top));transform:translateX(-50%);align-items:center;max-width:70vw;text-align:center}
.gh-bc{left:50%;bottom:max(22px,env(safe-area-inset-bottom));transform:translateX(-50%);align-items:center;max-width:80vw;text-align:center}
.gh-p{background:var(--gh-panel);border:1px solid var(--gh-line);border-radius:12px;padding:7px 12px;box-shadow:0 4px 18px rgba(0,0,0,.25);display:flex;align-items:center;gap:8px;white-space:nowrap}
.gh-l{font-size:11px;letter-spacing:.08em;text-transform:uppercase;opacity:.7;font-weight:700}
.gh-v{font-size:19px;font-weight:800;font-variant-numeric:tabular-nums;min-width:1.2em;text-align:right;transition:transform .18s}
.gh-i{color:var(--gh-accent);font-size:17px}
.gh-pop{transform:scale(1.35);color:var(--gh-accent)}
.gh-bar{width:min(190px,34vw);height:10px;border-radius:6px;background:rgba(255,255,255,.14);overflow:hidden}
.gh-bar i{display:block;height:100%;width:100%;border-radius:6px;transition:width .25s}
.gh-obj{font-size:15px;text-shadow:0 1px 4px rgba(0,0,0,.8)}
.gh-hint{font-size:14px;font-weight:500;opacity:0;transition:opacity .4s;text-shadow:0 1px 4px rgba(0,0,0,.8)}
.gh-toast{animation:gh-in .25s ease-out;transition:opacity .4s,transform .4s}
.gh-key{display:inline-grid;place-items:center;min-width:26px;height:26px;padding:0 7px;border-radius:7px;background:var(--gh-ink);color:#16181c;font-weight:800;font-size:13px}
.gh-s{position:absolute;inset:0;display:grid;place-items:center;background:radial-gradient(ellipse at center,rgba(8,10,14,.55),rgba(8,10,14,.9));pointer-events:auto;animation:gh-fade .35s ease-out;padding:20px;text-align:center}
.gh-card{max-width:min(520px,92vw)}
.gh-t{font-size:clamp(30px,7vw,58px);font-weight:900;letter-spacing:.01em;line-height:1.05;margin:0 0 10px;text-shadow:0 4px 24px rgba(0,0,0,.5)}
.gh-sub{font-size:clamp(14px,2.6vw,18px);font-weight:500;opacity:.85;margin:0 0 18px}
.gh-ctl{font-size:13px;font-weight:500;opacity:.7;margin:14px 0 0}
.gh-stats{display:flex;gap:10px;justify-content:center;flex-wrap:wrap;margin:0 0 18px}
.gh-b{pointer-events:auto;cursor:pointer;border:0;border-radius:12px;padding:13px 30px;font:800 17px system-ui,sans-serif;background:var(--gh-accent);color:#16181c;box-shadow:0 6px 22px rgba(0,0,0,.35);transition:transform .12s}
.gh-b:hover{transform:translateY(-2px) scale(1.03)}.gh-b:active{transform:scale(.97)}
.gh-sb{pointer-events:auto;cursor:pointer;border:1px solid var(--gh-line);border-radius:10px;padding:8px 12px;font:700 14px system-ui,sans-serif;background:var(--gh-panel);color:var(--gh-ink)}
.gh-vig{position:absolute;inset:0;opacity:0;transition:opacity .5s;pointer-events:none}
.gh-x{position:absolute;left:50%;top:50%;width:6px;height:6px;margin:-3px;border-radius:50%;background:#fff;box-shadow:0 0 0 2px rgba(0,0,0,.4)}
@keyframes gh-in{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
@keyframes gh-fade{from{opacity:0}to{opacity:1}}
@media (max-width:600px){.gh{font-size:13px}.gh-v{font-size:16px}.gh-p{padding:5px 9px}}
`;
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const fmtTime = (s) => { s = Math.max(0, Math.ceil(s)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };

/**
 * Creates the interface layer. Options: accent (colour of highlights and buttons), ink (text colour),
 * panel (panel background), parent (default document.body).
 * Corners for every widget: 'tl' | 'tr' | 'bl' | 'br' (default varies).
 *   hud.counter(label, { icon, value, corner })      -> { value, set(v), add(n) }
 *   hud.bar(label, { value, max, color, corner })    -> { value, set(v), add(n) }
 *   hud.timer({ seconds, countdown, corner, onEnd }) -> { time, start(), stop(), reset(seconds) }   starts at once
 *   hud.objective(text)        the current goal, top centre (null clears it)
 *   hud.hint(text, seconds)    a line at the bottom that fades out
 *   hud.toast(text, { color }) a short notice that stacks and disappears
 *   hud.prompt(key, text)      "[E] Open the chest" above the bottom; hud.prompt(null) hides it
 *   hud.button(label, onPress, { corner })   a small on-screen button (mute, pause, restart)
 *   hud.title({ title, subtitle, controls, button, onStart }) -> Promise   a start screen; resolves on click, tap, Enter or Space
 *   hud.end({ win, title, subtitle, stats, button, onRestart })            an end screen with a restart button
 *   hud.damage(strength), hud.flash(color), hud.fade(toBlack, seconds), hud.crosshair(true | false), hud.clear()
 */
export function createHud({ accent = '#ffb347', ink = '#f3efe6', panel = 'rgba(16,18,22,.72)', parent = document.body } = {}) {
  if (!document.getElementById('gh-css')) { const s = el('style'); s.id = 'gh-css'; s.textContent = CSS; document.head.appendChild(s); }
  const root = el('div', 'gh'); root.style.setProperty('--gh-accent', accent); root.style.setProperty('--gh-ink', ink); root.style.setProperty('--gh-panel', panel); root.style.setProperty('--gh-line', 'rgba(255,255,255,.14)');
  const C = {}; for (const k of ['tl', 'tr', 'bl', 'br', 'tc', 'bc']) { C[k] = el('div', 'gh-c gh-' + k); root.appendChild(C[k]); }
  const vig = el('div', 'gh-vig'); root.appendChild(vig); parent.appendChild(root);
  const obj = el('div', 'gh-p gh-obj'); obj.style.display = 'none'; C.tc.appendChild(obj);
  const prompt = el('div', 'gh-p'); prompt.style.display = 'none'; C.bc.appendChild(prompt);
  const hint = el('div', 'gh-hint'); C.bc.appendChild(hint);
  let hintT = 0, screen = null, cross = null; const timers = new Set();
  const pop = (v) => { v.classList.add('gh-pop'); setTimeout(() => v.classList.remove('gh-pop'), 180); };
  const hud = {
    el: root,
    counter(label, { icon = '', value = 0, corner = 'tl' } = {}) {
      const p = el('div', 'gh-p'), v = el('span', 'gh-v', String(value)); if (icon) p.appendChild(el('span', 'gh-i', icon)); p.appendChild(el('span', 'gh-l', label)); p.appendChild(v); C[corner].appendChild(p);
      const c = { value, el: p, set(n) { if (n !== c.value) pop(v); c.value = n; v.textContent = String(n); return c; }, add(n = 1) { return c.set(c.value + n); }, remove() { p.remove(); } }; return c;
    },
    bar(label, { value = 100, max = 100, color = accent, corner = 'tl' } = {}) {
      const p = el('div', 'gh-p'), b = el('div', 'gh-bar'), f = el('i'); f.style.background = color; b.appendChild(f); p.appendChild(el('span', 'gh-l', label)); p.appendChild(b); C[corner].appendChild(p);
      const c = { value, max, el: p, set(n) { c.value = Math.max(0, Math.min(c.max, n)); f.style.width = (c.value / c.max * 100) + '%'; return c; }, add(n) { return c.set(c.value + n); }, remove() { p.remove(); } }; c.set(value); return c;
    },
    timer({ seconds = 0, countdown = seconds > 0, corner = 'tr', label = 'Time', onEnd } = {}) {
      const c = hud.counter(label, { value: fmtTime(seconds), corner, icon: '◷' }); let t = seconds, last = performance.now(), on = true, ended = false;
      const id = setInterval(() => { const now = performance.now(), dt = Math.min(0.5, (now - last) / 1000); last = now; if (!on || document.hidden) return; t += countdown ? -dt : dt; if (countdown && t <= 0 && !ended) { t = 0; ended = true; on = false; if (onEnd) onEnd(); } const s = fmtTime(t); if (c.el.lastChild.textContent !== s) c.el.lastChild.textContent = s; tm.time = t; }, 100); timers.add(id);
      const tm = { time: t, el: c.el, start() { on = true; last = performance.now(); return tm; }, stop() { on = false; return tm; }, reset(s = seconds) { t = s; ended = false; tm.time = t; c.el.lastChild.textContent = fmtTime(t); return tm; }, remove() { clearInterval(id); c.remove(); } }; return tm;
    },
    objective(text) { obj.style.display = text ? '' : 'none'; if (text) { obj.textContent = ''; obj.appendChild(el('span', 'gh-i', '◆')); obj.appendChild(el('span', null, text)); } return hud; },
    hint(text, seconds = 5) { hint.textContent = text || ''; hint.style.opacity = text ? '1' : '0'; clearTimeout(hintT); if (text && seconds > 0) hintT = setTimeout(() => { hint.style.opacity = '0'; }, seconds * 1000); return hud; },
    toast(text, { color, seconds = 2.6, corner = 'tc' } = {}) { const t = el('div', 'gh-p gh-toast', text); if (color) t.style.color = color; C[corner].appendChild(t); setTimeout(() => { t.style.opacity = '0'; t.style.transform = 'translateY(-8px)'; setTimeout(() => t.remove(), 420); }, seconds * 1000); return hud; },
    prompt(key, text) { prompt.style.display = key || text ? '' : 'none'; prompt.textContent = ''; if (key) prompt.appendChild(el('span', 'gh-key', key)); if (text) prompt.appendChild(el('span', null, text)); return hud; },
    button(label, onPress, { corner = 'tr' } = {}) { const b = el('button', 'gh-sb', label); b.addEventListener('click', (e) => { e.stopPropagation(); onPress(b); b.blur(); }); C[corner].appendChild(b); return b; },
    title({ title = document.title, subtitle = '', controls = '', button = 'Play', onStart } = {}) {
      return new Promise((res) => {
        hud.closeScreen(); screen = el('div', 'gh-s'); const card = el('div', 'gh-card'); card.appendChild(el('h1', 'gh-t', title)); if (subtitle) card.appendChild(el('p', 'gh-sub', subtitle));
        const b = el('button', 'gh-b', button); card.appendChild(b); if (controls) card.appendChild(el('p', 'gh-ctl', controls)); screen.appendChild(card); root.appendChild(screen);
        const go = (e) => { if (e && e.type === 'keydown' && e.code !== 'Enter' && e.code !== 'Space') return; removeEventListener('keydown', go); hud.closeScreen(); if (onStart) onStart(); res(); };
        b.addEventListener('click', go); addEventListener('keydown', go); hud.start = go;
      });
    },
    end({ win = true, title = win ? 'You win' : 'Game over', subtitle = '', stats = {}, button = 'Play again', onRestart } = {}) {
      hud.closeScreen(); screen = el('div', 'gh-s'); const card = el('div', 'gh-card'), t = el('h1', 'gh-t', title); if (!win) t.style.color = '#ff8a70'; else t.style.color = accent; card.appendChild(t); if (subtitle) card.appendChild(el('p', 'gh-sub', subtitle));
      const st = el('div', 'gh-stats'); for (const k in stats) { const p = el('div', 'gh-p'); p.appendChild(el('span', 'gh-l', k)); p.appendChild(el('span', 'gh-v', String(stats[k]))); st.appendChild(p); } if (st.children.length) card.appendChild(st);
      const b = el('button', 'gh-b', button); b.addEventListener('click', () => { hud.closeScreen(); if (onRestart) onRestart(); }); card.appendChild(b); screen.appendChild(card); root.appendChild(screen); hud.restart = () => b.click(); return hud;
    },
    closeScreen() { if (screen) { screen.remove(); screen = null; } return hud; },
    get screenOpen() { return !!screen; },
    damage(strength = 0.6) { vig.style.transition = 'none'; vig.style.background = `radial-gradient(ellipse at center, transparent 45%, rgba(220,30,30,${strength}))`; vig.style.opacity = '1'; requestAnimationFrame(() => { vig.style.transition = 'opacity .6s'; vig.style.opacity = '0'; }); return hud; },
    flash(color = '#fff', seconds = 0.35) { vig.style.transition = 'none'; vig.style.background = color; vig.style.opacity = '0.8'; requestAnimationFrame(() => { vig.style.transition = `opacity ${seconds}s`; vig.style.opacity = '0'; }); return hud; },
    fade(toBlack = true, seconds = 0.6) { vig.style.background = '#000'; vig.style.transition = `opacity ${seconds}s`; vig.style.opacity = toBlack ? '1' : '0'; return new Promise((r) => setTimeout(r, seconds * 1000)); },
    crosshair(on = true) { if (on && !cross) { cross = el('div', 'gh-x'); root.appendChild(cross); } else if (!on && cross) { cross.remove(); cross = null; } return hud; },
    clear() { for (const k in C) [...C[k].children].forEach((c) => { if (c !== obj && c !== prompt && c !== hint) c.remove(); }); timers.forEach(clearInterval); timers.clear(); hud.objective(null).prompt(null).hint('').closeScreen(); return hud; },
    remove() { hud.clear(); root.remove(); },
  };
  return hud;
}
