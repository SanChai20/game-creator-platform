// @gcp/play.js — the systems under a game with depth, and the interface that shows them. Engine-agnostic: plain
// data and DOM, so the same code serves 2D and 3D games. Each part works alone and they fit each other:
//   createInventory   slots, stacks, a hotbar, item definitions with painted icons
//   createCrafting    recipes that turn items into items, optionally near a station (campfire, workbench)
//   createNeeds       health, food, water, stamina or your own: drain, recovery, what happens when one runs out
//   createClock       a day that passes: hour, day number, dawn / day / dusk / night; drives the stage's light
//   createNodes       things in the world to use: trees to chop, rocks to mine, bushes to pick, doors, chests
//   createInteract    finds the nearest one, shows "[E] Chop the oak", uses it on the action, fills the inventory
//   createBuilder     pieces placed on a grid for a cost: walls, floors, fires, beds
//   createQuests      a list of steps the player ticks off, the spine of a tutorial or a campaign
//   createSave        the whole state in the player's cloud save (localStorage offline), with autosave
//   hotbarUI, inventoryUI, needsUI, clockUI, questUI, minimapUI, pauseMenu      the panels for them, on a createHud()
//   lobbyUI           the start screen of a game with rooms: host with a code, join with a code, or play alone
import { store } from './core.js';

const emitter = () => { const L = new Set(); return { on: (fn) => { L.add(fn); return () => L.delete(fn); }, emit: (...a) => { for (const fn of [...L]) fn(...a); } }; };
const D = typeof document !== 'undefined' ? document : null, el = (tag, cls, text) => { const e = D.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

// ---- items and their icons ----
const P = (c, pts, fill, line = '#1d2420') => { c.beginPath(); pts.forEach(([x, y], i) => (i ? c.lineTo(x, y) : c.moveTo(x, y))); c.closePath(); c.fillStyle = fill; c.fill(); if (line) { c.lineWidth = 0.05; c.strokeStyle = line; c.stroke(); } };
const E = (c, x, y, rx, ry, fill, line = '#1d2420') => { c.beginPath(); c.ellipse(x, y, rx, ry, 0, 0, 6.2832); c.fillStyle = fill; c.fill(); if (line) { c.lineWidth = 0.05; c.strokeStyle = line; c.stroke(); } };
const R = (c, x, y, w, h, fill, r = 0.05, line = '#1d2420') => { c.beginPath(); c.roundRect(x, y, w, h, r); c.fillStyle = fill; c.fill(); if (line) { c.lineWidth = 0.05; c.strokeStyle = line; c.stroke(); } };
const handle = (c) => { c.save(); c.translate(0.5, 0.5); c.rotate(0.785); R(c, -0.05, -0.36, 0.1, 0.78, '#8a5a34', 0.03); c.restore(); };
const ICON = {
  wood: (c) => { R(c, 0.12, 0.3, 0.76, 0.2, '#8a5a34', 0.1); R(c, 0.2, 0.52, 0.7, 0.2, '#7a4e2c', 0.1); E(c, 0.86, 0.4, 0.06, 0.1, '#d8b080'); E(c, 0.88, 0.62, 0.06, 0.1, '#d8b080'); },
  stone: (c) => { P(c, [[0.16, 0.66], [0.26, 0.36], [0.56, 0.24], [0.84, 0.44], [0.8, 0.72], [0.4, 0.8]], '#9a978f'); P(c, [[0.3, 0.4], [0.56, 0.3], [0.7, 0.44], [0.4, 0.5]], '#c2bfb6', null); },
  fiber: (c) => { c.lineCap = 'round'; for (let i = 0; i < 5; i++) { c.strokeStyle = i % 2 ? '#6a9a3a' : '#8ab84a'; c.lineWidth = 0.07; c.beginPath(); c.moveTo(0.3 + i * 0.1, 0.84); c.quadraticCurveTo(0.3 + i * 0.1, 0.5, 0.18 + i * 0.16, 0.18); c.stroke(); } R(c, 0.26, 0.6, 0.48, 0.1, '#c8a060', 0.04); },
  berry: (c) => { E(c, 0.36, 0.6, 0.18, 0.18, '#d83a4a'); E(c, 0.64, 0.58, 0.18, 0.18, '#c02a3e'); E(c, 0.5, 0.38, 0.17, 0.17, '#e8485a'); P(c, [[0.5, 0.2], [0.66, 0.12], [0.6, 0.26]], '#4a9440'); },
  meat: (c) => { E(c, 0.44, 0.48, 0.3, 0.24, '#c8584a'); E(c, 0.4, 0.44, 0.14, 0.1, '#e8887a', null); R(c, 0.66, 0.6, 0.22, 0.09, '#f0e8d8', 0.04); E(c, 0.88, 0.66, 0.06, 0.07, '#f0e8d8'); },
  cooked_meat: (c) => { E(c, 0.44, 0.48, 0.3, 0.24, '#8a4a2a'); E(c, 0.4, 0.44, 0.14, 0.1, '#b86a3a', null); R(c, 0.66, 0.6, 0.22, 0.09, '#f0e8d8', 0.04); E(c, 0.88, 0.66, 0.06, 0.07, '#f0e8d8'); },
  water: (c) => { P(c, [[0.5, 0.12], [0.76, 0.56], [0.66, 0.8], [0.5, 0.86], [0.34, 0.8], [0.24, 0.56]], '#4aa6e8'); E(c, 0.42, 0.6, 0.06, 0.1, '#bfe2ff', null); },
  ore: (c) => { ICON.stone(c); for (const [x, y] of [[0.36, 0.5], [0.6, 0.42], [0.62, 0.64]]) P(c, [[x, y - 0.07], [x + 0.07, y], [x, y + 0.07], [x - 0.07, y]], '#f2b040'); },
  ingot: (c) => { P(c, [[0.14, 0.66], [0.26, 0.4], [0.76, 0.4], [0.88, 0.66]], '#b8bec8'); P(c, [[0.26, 0.4], [0.76, 0.4], [0.7, 0.34], [0.32, 0.34]], '#e0e4ea'); },
  plank: (c) => { for (let i = 0; i < 3; i++) R(c, 0.14, 0.24 + i * 0.19, 0.72, 0.16, i % 2 ? '#c89858' : '#b88848', 0.02); },
  rope: (c) => { c.lineWidth = 0.12; c.strokeStyle = '#1d2420'; c.beginPath(); c.arc(0.5, 0.5, 0.26, 0, 6.3); c.stroke(); c.lineWidth = 0.07; c.strokeStyle = '#c8a060'; c.stroke(); },
  seed: (c) => { for (const [x, y] of [[0.36, 0.56], [0.58, 0.44], [0.6, 0.68]]) E(c, x, y, 0.1, 0.07, '#c8a060'); },
  wheat: (c) => { c.strokeStyle = '#b89030'; c.lineWidth = 0.05; c.beginPath(); c.moveTo(0.5, 0.88); c.lineTo(0.5, 0.3); c.stroke(); for (let i = 0; i < 4; i++) { E(c, 0.42, 0.3 + i * 0.1, 0.07, 0.05, '#e8c040'); E(c, 0.58, 0.3 + i * 0.1, 0.07, 0.05, '#e8c040'); } },
  axe: (c) => { handle(c); P(c, [[0.56, 0.14], [0.86, 0.2], [0.82, 0.5], [0.6, 0.4]], '#c8ced6'); },
  pickaxe: (c) => { handle(c); c.lineWidth = 0.14; c.strokeStyle = '#1d2420'; c.lineCap = 'round'; c.beginPath(); c.arc(0.5, 0.56, 0.42, -2.2, -0.5); c.stroke(); c.lineWidth = 0.08; c.strokeStyle = '#c8ced6'; c.stroke(); },
  sword: (c) => { c.save(); c.translate(0.5, 0.5); c.rotate(0.785); R(c, -0.05, -0.42, 0.1, 0.6, '#d8dee6', 0.03); R(c, -0.16, 0.16, 0.32, 0.07, '#f2c230', 0.02); R(c, -0.04, 0.22, 0.08, 0.18, '#6a4428', 0.03); c.restore(); },
  hoe: (c) => { handle(c); R(c, 0.56, 0.14, 0.3, 0.1, '#c8ced6', 0.02); },
  torch: (c) => { R(c, 0.44, 0.42, 0.12, 0.46, '#8a5a34', 0.03); P(c, [[0.5, 0.08], [0.68, 0.34], [0.5, 0.48], [0.32, 0.34]], '#ff8a2a'); P(c, [[0.5, 0.24], [0.58, 0.36], [0.5, 0.44], [0.42, 0.36]], '#ffe27a', null); },
  campfire: (c) => { R(c, 0.16, 0.66, 0.68, 0.12, '#6a4428', 0.05); P(c, [[0.5, 0.14], [0.74, 0.52], [0.62, 0.7], [0.38, 0.7], [0.26, 0.52]], '#ff8a2a'); P(c, [[0.5, 0.36], [0.6, 0.56], [0.5, 0.68], [0.4, 0.56]], '#ffe27a', null); },
  wall: (c) => { R(c, 0.14, 0.2, 0.72, 0.62, '#b88848', 0.03); for (let i = 1; i < 4; i++) { c.strokeStyle = '#7a5228'; c.lineWidth = 0.04; c.beginPath(); c.moveTo(0.14 + i * 0.18, 0.2); c.lineTo(0.14 + i * 0.18, 0.82); c.stroke(); } },
  floor: (c) => { P(c, [[0.5, 0.26], [0.9, 0.5], [0.5, 0.76], [0.1, 0.5]], '#c89858'); c.strokeStyle = '#7a5228'; c.lineWidth = 0.04; c.beginPath(); c.moveTo(0.3, 0.38); c.lineTo(0.7, 0.64); c.moveTo(0.7, 0.38); c.lineTo(0.3, 0.64); c.stroke(); },
  door: (c) => { R(c, 0.26, 0.12, 0.48, 0.76, '#8a5a34', 0.05); R(c, 0.32, 0.18, 0.36, 0.28, '#a87040', 0.03); E(c, 0.64, 0.54, 0.04, 0.04, '#f2c230'); },
  chest: (c) => { R(c, 0.14, 0.42, 0.72, 0.4, '#8a5a2a', 0.04); R(c, 0.14, 0.24, 0.72, 0.26, '#a87038', 0.12); R(c, 0.44, 0.42, 0.12, 0.16, '#f2c230', 0.02); },
  fence: (c) => { for (const x of [0.16, 0.44, 0.72]) P(c, [[x, 0.84], [x, 0.26], [x + 0.06, 0.16], [x + 0.12, 0.26], [x + 0.12, 0.84]], '#b88848'); R(c, 0.1, 0.36, 0.8, 0.09, '#9a6e38', 0.02); R(c, 0.1, 0.6, 0.8, 0.09, '#9a6e38', 0.02); },
  tent: (c) => { P(c, [[0.5, 0.14], [0.92, 0.82], [0.08, 0.82]], '#c8a868'); P(c, [[0.5, 0.36], [0.64, 0.82], [0.36, 0.82]], '#4a3a2a'); P(c, [[0.5, 0.14], [0.92, 0.82], [0.74, 0.82]], '#a88848', null); },
  bed: (c) => { R(c, 0.1, 0.46, 0.8, 0.26, '#c84a4a', 0.05); R(c, 0.1, 0.4, 0.26, 0.2, '#f0ece0', 0.06); R(c, 0.08, 0.7, 0.08, 0.14, '#6a4428', 0.02); R(c, 0.84, 0.7, 0.08, 0.14, '#6a4428', 0.02); },
  workbench: (c) => { R(c, 0.1, 0.32, 0.8, 0.16, '#b88848', 0.03); R(c, 0.16, 0.48, 0.1, 0.36, '#7a5228', 0.02); R(c, 0.74, 0.48, 0.1, 0.36, '#7a5228', 0.02); R(c, 0.4, 0.2, 0.3, 0.12, '#9aa2aa', 0.02); },
  coin: (c) => { E(c, 0.5, 0.5, 0.3, 0.32, '#f2c230'); E(c, 0.46, 0.46, 0.16, 0.18, '#ffe27a', null); },
  gem: (c) => { P(c, [[0.5, 0.14], [0.82, 0.42], [0.5, 0.86], [0.18, 0.42]], '#4ad0e8'); P(c, [[0.5, 0.14], [0.18, 0.42], [0.5, 0.48]], '#b0f0ff', null); },
  key: (c) => { c.lineCap = 'round'; for (const [w, col] of [[0.16, '#1d2420'], [0.08, '#f2c230']]) { c.lineWidth = w; c.strokeStyle = col; c.beginPath(); c.arc(0.32, 0.38, 0.14, 0, 6.3); c.moveTo(0.44, 0.48); c.lineTo(0.78, 0.8); c.moveTo(0.66, 0.68); c.lineTo(0.76, 0.6); c.stroke(); } },
  potion: (c) => { R(c, 0.42, 0.14, 0.16, 0.2, '#d8e4ea', 0.03); E(c, 0.5, 0.6, 0.26, 0.26, '#e04a6a'); E(c, 0.42, 0.52, 0.08, 0.1, '#ff9ab0', null); R(c, 0.4, 0.1, 0.2, 0.08, '#8a5a34', 0.02); },
  bandage: (c) => { c.save(); c.translate(0.5, 0.5); c.rotate(-0.6); R(c, -0.36, -0.13, 0.72, 0.26, '#f0e8d8', 0.12); R(c, -0.1, -0.1, 0.2, 0.2, '#e8d0b0', 0.03, null); c.restore(); },
};
/** The item kinds that come with a painted icon. Any other id works too: give it { name, color } or your own icon. */
export const ITEMS = Object.keys(ICON);
const ICONS = new Map();
/**
 * An item's icon as an image URL. Built-in kinds (wood, stone, fiber, berry, meat, cooked_meat, water, ore, ingot,
 * plank, rope, seed, wheat, axe, pickaxe, sword, hoe, torch, campfire, wall, floor, door, fence, tent, chest, bed, workbench,
 * coin, gem, key, potion, bandage) are painted; an unknown kind gets a tile with its first letter in def.color.
 * def.icon may be your own: an image URL, a canvas, or a function (ctx) that draws in a 1 × 1 square.
 */
export function itemIcon(id, def = {}) {
  const key = id + '|' + (def.color || ''); if (typeof def.icon === 'string') return def.icon; if (def.icon && def.icon.toDataURL) return def.icon.toDataURL(); if (ICONS.has(key)) return ICONS.get(key);
  const cv = D.createElement('canvas'); cv.width = cv.height = 72; const c = cv.getContext('2d', { willReadFrequently: true }); c.scale(72, 72);   // read back at once, so keep it off the GPU c.lineJoin = 'round';
  const draw = typeof def.icon === 'function' ? def.icon : ICON[def.like || id];
  if (draw) draw(c); else { R(c, 0.16, 0.16, 0.68, 0.68, def.color || '#8a94a6', 0.14); c.fillStyle = '#fff'; c.font = '700 0.42px system-ui'; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText(String(def.name || id).charAt(0).toUpperCase(), 0.5, 0.52); }
  const url = cv.toDataURL(); ICONS.set(key, url); return url;
}
const nice = (id) => id.replace(/_/g, ' ').replace(/^./, (ch) => ch.toUpperCase());

/**
 * What the player carries. Options: slots (default 24), hotbar (the first N slots, default 8), stack (most per slot,
 * default 99), items ({ id: { name, stack, icon, color, tool, food, water, heal, place } }: anything you put here
 * is yours to read back with inv.def(id)), start ({ wood: 3 }).
 *   inv.add(id, n) -> how many did not fit      inv.remove(id, n) -> true if it had them      inv.count(id), inv.has(id, n)
 *   inv.slots [{ id, n } | null], inv.selected (hotbar index), inv.select(i), inv.held -> { id, n, def } | null
 *   inv.move(from, to)  swaps or merges two slots      inv.def(id) -> the definition (with name filled in)
 *   inv.onChange(fn)    called after every change      inv.toJSON() / inv.load(data)  for saving
 */
export function createInventory({ slots = 24, hotbar = 8, stack = 99, items = {}, start } = {}) {
  const ev = emitter(), S = new Array(slots).fill(null), cap = (id) => (items[id] && items[id].stack) || stack;
  const inv = {
    slots: S, hotbar, selected: 0, onChange: ev.on, items,
    def: (id) => ({ name: nice(id), ...(items[id] || {}), id }),
    count: (id) => S.reduce((n, s) => n + (s && s.id === id ? s.n : 0), 0), has: (id, n = 1) => inv.count(id) >= n,
    add(id, n = 1) { const c = cap(id); for (const s of S) if (n > 0 && s && s.id === id && s.n < c) { const k = Math.min(n, c - s.n); s.n += k; n -= k; } for (let i = 0; i < S.length && n > 0; i++) if (!S[i]) { const k = Math.min(n, c); S[i] = { id, n: k }; n -= k; } ev.emit(inv); return n; },
    remove(id, n = 1) { if (inv.count(id) < n) return false; for (let i = S.length - 1; i >= 0 && n > 0; i--) { const s = S[i]; if (s && s.id === id) { const k = Math.min(n, s.n); s.n -= k; n -= k; if (!s.n) S[i] = null; } } ev.emit(inv); return true; },
    move(a, b) { if (a === b || !S[a]) return; const A = S[a], B = S[b]; if (B && B.id === A.id) { const k = Math.min(A.n, cap(A.id) - B.n); B.n += k; A.n -= k; if (!A.n) S[a] = null; } else { S[a] = B; S[b] = A; } ev.emit(inv); },
    select(i) { inv.selected = ((i % hotbar) + hotbar) % hotbar; ev.emit(inv); return inv; },
    get held() { const s = S[inv.selected]; return s ? { ...s, def: inv.def(s.id) } : null; },
    toJSON: () => ({ slots: S.map((s) => (s ? [s.id, s.n] : 0)), selected: inv.selected }),
    load(d) { if (d && Array.isArray(d.slots)) { for (let i = 0; i < S.length; i++) { const s = d.slots[i]; S[i] = s ? { id: s[0], n: s[1] } : null; } inv.selected = d.selected || 0; ev.emit(inv); } return inv; },
  };
  if (start) for (const id in start) inv.add(id, start[id]);
  return inv;
}

/**
 * Recipes. Each: { makes: 'axe', n: 1, needs: { wood: 3, stone: 2 }, station: 'workbench' (optional), name (optional) }.
 *   craft.can(recipe, stations) -> true when the inventory holds the parts and the station is in `stations` (a list of
 *                                  station names near the player; omit to ignore stations)
 *   craft.make(recipe, stations) -> true if it crafted      craft.recipes      craft.find('axe')      craft.onCraft(fn)
 */
export function createCrafting(inventory, recipes = []) {
  const ev = emitter(), list = recipes.map((r) => ({ n: 1, needs: {}, ...r, id: r.id || r.makes }));
  const C = { recipes: list, onCraft: ev.on, find: (id) => list.find((r) => r.id === id || r.makes === id),
    can(r, stations) { r = typeof r === 'string' ? C.find(r) : r; return !!r && Object.entries(r.needs).every(([id, n]) => inventory.has(id, n)) && (!r.station || !stations || stations.includes(r.station)); },
    make(r, stations) { r = typeof r === 'string' ? C.find(r) : r; if (!C.can(r, stations)) return false; for (const id in r.needs) inventory.remove(id, r.needs[id]); inventory.add(r.makes, r.n); ev.emit(r); return true; } };
  return C;
}

/**
 * The player's condition. defs: { health: { max: 100 }, food: { max: 100, drain: 0.6, empty: { health: -3 } },
 * water: { max: 100, drain: 0.9, empty: { health: -4 } }, stamina: { max: 100, regen: 14 } }. Per need: value (start,
 * default max), max, drain (lost per second), regen (gained per second), empty (what the others change by per second
 * while this one is at zero), full (the same while it is above 60%: e.g. food: { full: { health: 1 } }), color, label.
 *   needs.get('food'), needs.add('food', 25), needs.set(k, v), needs.use('stamina', 20) -> false when there is not enough
 *   needs.update(dt) every frame      needs.onChange(fn(key, value))      needs.onDeath(fn) when health reaches zero
 *   needs.toJSON() / needs.load(data)
 */
export function createNeeds(defs = { health: { max: 100 } }) {
  const ch = emitter(), dead = emitter(), V = {}, keys = Object.keys(defs); for (const k of keys) V[k] = defs[k].value ?? defs[k].max ?? 100;
  const max = (k) => defs[k].max ?? 100, set = (k, v) => { v = Math.max(0, Math.min(max(k), v)); if (v === V[k]) return; V[k] = v; ch.emit(k, v); if (k === 'health' && v <= 0 && !N.dead) { N.dead = true; dead.emit(); } };
  const N = { defs, values: V, keys, dead: false, onChange: ch.on, onDeath: dead.on, max, get: (k) => V[k], set, add: (k, n) => set(k, V[k] + n), ratio: (k) => V[k] / max(k),
    use(k, n) { if (V[k] < n) return false; set(k, V[k] - n); return true; },
    update(dt) { if (N.dead) return; for (const k of keys) { const d = defs[k]; let r = (d.regen || 0) - (d.drain || 0); for (const o of keys) { const e = defs[o]; if (e.empty && e.empty[k] && V[o] <= 0) r += e.empty[k]; if (e.full && e.full[k] && V[o] > max(o) * 0.6) r += e.full[k]; } if (r) set(k, V[k] + r * dt); } },
    toJSON: () => ({ ...V }), load(d) { if (d) for (const k of keys) if (typeof d[k] === 'number') set(k, d[k]); N.dead = V.health != null && V.health <= 0; return N; } };
  return N;
}

/**
 * Time of day. Options: dayLength (seconds for 24 hours, default 300), hour (start, default 8), stage (a createStage
 * or createStage2d: its light follows the clock).
 *   clock.hour (0..24), clock.day (from 1), clock.phase ('dawn' | 'day' | 'dusk' | 'night'), clock.isNight, clock.label ('Day 2 · 21:40')
 *   clock.update(dt) every frame      clock.set(hour)      clock.onPhase(fn(phase, day))      clock.toJSON() / clock.load(data)
 */
export function createClock({ dayLength = 300, hour = 8, stage } = {}) {
  const ev = emitter(), phaseOf = (h) => (h < 5 ? 'night' : h < 7.5 ? 'dawn' : h < 17.5 ? 'day' : h < 20 ? 'dusk' : 'night');
  const apply = () => { if (stage && stage.setTime) stage.setTime(C.hour); };
  const C = { hour, day: 1, phase: phaseOf(hour), dayLength, onPhase: ev.on, get isNight() { return C.phase === 'night'; },
    get label() { const h = Math.floor(C.hour), m = Math.floor((C.hour - h) * 6) * 10; return `Day ${C.day} · ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`; },
    update(dt) { C.hour += dt * 24 / C.dayLength; if (C.hour >= 24) { C.hour -= 24; C.day++; } const p = phaseOf(C.hour); if (p !== C.phase) { C.phase = p; ev.emit(p, C.day); } apply(); },
    set(h) { C.hour = ((h % 24) + 24) % 24; const p = phaseOf(C.hour); if (p !== C.phase) { C.phase = p; ev.emit(p, C.day); } apply(); return C; },
    toJSON: () => ({ hour: C.hour, day: C.day }), load(d) { if (d) { C.day = d.day || 1; C.set(d.hour ?? hour); } return C; } };
  apply(); return C;
}

/**
 * Things in the world the player can use. A node: { x, y, r (reach, default 1.2), label ('Chop the oak'), kind,
 * hp (hits to finish, default 1), tool (the item kind it needs in hand, optional), drops ({ wood: [2, 4] } or
 * { wood: 3 }), respawn (seconds; omit for never), ref (anything with .visible: it is hidden while the node is spent),
 * solid (its collision circle: switched off while it is spent), onUse(node) (for doors, chests, signs: called instead
 * of harvesting) }. y is the second ground axis: z in a 3D game.
 *   nodes.add(node) -> node      nodes.remove(node)      nodes.nearest(x, y, range) -> the closest usable node or null
 *   nodes.fromScatter(items, rule)  every scattered thing becomes a node: rule(item) returns the node's fields or
 *                                  nothing to skip it, e.g. (it) => it.type === 'tree' && { label: 'Chop the tree', hp: 3, drops: { wood: [2, 3] }, respawn: 90 }
 *   nodes.use(node, { tool, power, rand }) -> { ok: false, why: 'needs axe' } | { ok: true, done: false, hp } | { ok: true, done: true, drops: { wood: 3 } }
 *   nodes.update(dt) every frame (respawns)      nodes.list      nodes.onDeplete(fn(node, drops))
 *   node.id (numbered in the order added, the same on every device that builds the same world)   nodes.byId(id)
 *   nodes.useFor(node, inventory, opts)  use it and put the drops in that inventory: what a room's host calls for a guest
 */
export function createNodes() {
  let nextId = 1; const ev = emitter(), list = [], show = (n, on) => { if (n.ref) n.ref.visible = on; if (n.solid && typeof n.solid === 'object') n.solid.off = !on; };
  const N = { list, onDeplete: ev.on,
    add(n) { const node = { r: 1.2, hp: 1, id: n.id ?? nextId++, ...n, left: n.hp || 1, gone: false, timer: 0 }; list.push(node); return node; },
    byId: (id) => list.find((n) => n.id === id) || null,
    useFor(n, inventory, opts) { const r = N.use(n, opts); if (r.ok && r.done && inventory) { r.left = {}; for (const id in r.drops) { const k = inventory.add(id, r.drops[id]); if (k) r.left[id] = k; } } return r; },
    fromScatter(items, rule) { const out = []; for (const it of items) { const d = rule(it); if (d) out.push(N.add({ x: it.x, y: it.z ?? it.y, ref: it, solid: it.circle || (it.solid === true ? it : null), kind: it.type, ...d })); } return out; },
    remove(n) { const i = list.indexOf(n); if (i >= 0) list.splice(i, 1); },
    nearest(x, y, range = 0) { let best = null, bd = Infinity; for (const n of list) { if (n.gone) continue; const d = Math.hypot(n.x - x, n.y - y) - (n.r + range); if (d < 0 && d < bd) { bd = d; best = n; } } return best; },
    use(n, { tool, power = 1, rand = Math.random } = {}) {
      if (!n || n.gone) return { ok: false, why: 'nothing here' }; if (n.onUse) { n.onUse(n); return { ok: true, done: true, drops: {} }; }
      if (n.tool && n.tool !== tool) return { ok: false, why: 'needs ' + nice(n.tool).toLowerCase() };
      n.left -= power; if (n.left > 0) return { ok: true, done: false, hp: n.left };
      const drops = {}; for (const id in n.drops || {}) { const d = n.drops[id]; drops[id] = Array.isArray(d) ? d[0] + Math.floor(rand() * (d[1] - d[0] + 1)) : d; }
      n.gone = true; n.timer = n.respawn || 0; show(n, false); if (!n.respawn) N.remove(n); ev.emit(n, drops); return { ok: true, done: true, drops };
    },
    update(dt) { for (const n of list) if (n.gone && n.respawn) { n.timer -= dt; if (n.timer <= 0) { n.gone = false; n.left = n.hp || 1; show(n, true); } } } };
  return N;
}

/**
 * Ties the nodes to the player. Every frame it finds the nearest usable node, shows the prompt ("[E] Chop the oak",
 * with the right key for keyboard, touch or gamepad), and on the action uses it and puts what drops in the inventory.
 * Options: nodes, input, hud, at (() => ({ x, y }): where the player stands; y is z in 3D), action (the name bound
 * with input.bind, default 'interact'), inventory, tool (() => the kind in hand, e.g. () => inv.held && inv.held.def.tool),
 * power ((node, tool) => hits per press, e.g. 2 with the right tool), range (extra reach, default 0.3),
 * onHit(node, result) (every press: play a sound, shake the tree), onGet(node, drops) (when it is finished),
 * send(node, tool) (in a room where the host decides: called instead of using the node here; send node.id to the
 * host, which calls nodes.useFor(nodes.byId(id), thatPlayersInventory, { tool }) and sends back the result).
 * Returns { update() every frame, target (the node in reach or null), use() (press it yourself), enabled }.
 */
export function createInteract({ nodes, input, hud, at, action = 'interact', inventory, tool, power, range = 0.3, onHit, onGet, send } = {}) {
  let shown = null, key = '';
  const I = { target: null, enabled: true,
    use() { const n = I.target; if (!n) return null; if (send) { send(n, tool ? tool() : undefined); return { ok: true, sent: true }; } const t = tool ? tool() : undefined, r = nodes.use(n, { tool: t, power: power ? power(n, t) : 1 });
      if (r.ok && r.done && inventory) for (const id in r.drops) { const left = inventory.add(id, r.drops[id]); if (left && hud) hud.toast('The backpack is full'); }
      if (onHit) onHit(n, r); if (r.ok && r.done && onGet) onGet(n, r.drops); if (!r.ok && hud) hud.toast(nice(r.why)); shown = null; return r; },
    update() {
      const p = at(), n = I.enabled ? nodes.nearest(p.x, p.y, range) : null, k = n && input ? input.keyOf(action) : ''; I.target = n;
      if (hud && (n !== shown || k !== key)) { shown = n; key = k; hud.prompt(n ? k || 'E' : null, n ? n.label || 'Use' : null); }
      if (n && input && input.action(action)) I.use();
    } };
  return I;
}

/**
 * Building on a grid. Options: grid (cell size, default 1), inventory (costs are taken from it), pieces
 * ({ wall: { cost: { wood: 2 }, solid: 0.5, station: false, height: 0, layer: 'wall', make(x, y, piece) -> ref } }:
 * make puts the thing in your scene and returns something with remove() or .visible; height is how far its top
 * stands above its base, for floors, stairs and blocks the hero can stand on; layer lets pieces share a cell: a floor
 * ('floor'), a wall ('wall') and a roof ('roof') can all stand on one cell, one of each per level), levelHeight (the
 * height of one storey, default 3: a piece on level 1 stands that much higher), canPlace(x, y, kind, level) (your own
 * rule: not on water), solids (the array your controller collides with: solid pieces on level 0 are added to it and
 * taken out again). y is z in 3D.
 *   build.place(kind, x, y, { level, dir, inventory, free }) -> the piece, or { error: 'occupied' | 'cannot build here' | 'needs 2 wood' }
 *        level: the storey (0 is the ground); inventory: charge this one instead (a room's host charging a guest);
 *        free: charge nothing (the host already did)
 *   build.remove(x, y, { layer, level, inventory }) -> the piece taken away, or null (half the cost comes back)
 *   build.at(x, y, layer, level)   build.allAt(x, y) -> every piece on that cell   build.snap(x, y) -> [x, y]
 *   build.pieces (every placed piece: { kind, x, y, level, layer, base, ref })      build.solids      build.near(x, y, range) -> station names
 *   build.topAt(x, y, fromY) -> the highest top on that cell that the hero can step onto from height fromY (one step
 *        up at most), or 0. In 3D give the controller heightAt: (x, z) => Math.max(land.heightAt(x, z), land.heightAt(x, z)
 *        + build.topAt(x, z, hero.position.y - land.heightAt(x, z))): the hero walks on floors and climbs storey by storey
 *   build.onChange(fn)      build.toJSON() / build.load(data)
 * Stairs and ramps: use stairsPiece() and rampPiece() below, or give your own piece top(dx, dy, piece) instead of height: the height of its surface at an offset from
 * the cell centre, e.g. stairs that rise one storey towards +y: top: (dx, dy) => Math.max(0.05, (dy / grid + 0.5) * 3).
 * The hero walks up them a little at a time and steps off onto the floor of the storey above.
 */
export function createBuilder({ grid = 1, inventory, pieces = {}, canPlace, solids = [], levelHeight = 3 } = {}) {
  const ev = emitter(), placed = new Map(), snap = (x, y) => [Math.round(x / grid) * grid, Math.round(y / grid) * grid];
  const layerOf = (kind) => (pieces[kind] && pieces[kind].layer) || 'ground', key = (x, y, layer, level) => x + ',' + y + ',' + layer + ',' + (level || 0);
  const pay = (inv, cost, k) => { for (const id in cost) { if (k > 0) inv.remove(id, cost[id]); else inv.add(id, Math.ceil(cost[id] / 2)); } };
  const put = (kind, x, y, o = {}) => {
    const def = pieces[kind], level = o.level || 0, inv = o.inventory || inventory; if (!def) return { error: 'unknown piece ' + kind }; [x, y] = snap(x, y);
    if (placed.has(key(x, y, layerOf(kind), level))) return { error: 'occupied' }; if (canPlace && !canPlace(x, y, kind, level)) return { error: 'cannot build here' };
    if (!o.free && inv && def.cost) { const miss = Object.entries(def.cost).find(([id, n]) => !inv.has(id, n)); if (miss) return { error: `needs ${miss[1]} ${nice(miss[0]).toLowerCase()}` }; pay(inv, def.cost, 1); }
    const base = level * levelHeight, p = { kind, x, y, level, layer: layerOf(kind), base, dir: o.dir ?? def.dir ?? 0, ref: null, solid: def.solid && !level ? { x, y, z: y, r: def.solid } : null };
    p.ref = def.make ? def.make(x, y, p) : null; placed.set(key(x, y, p.layer, level), p); B.pieces.push(p); if (p.solid) solids.push(p.solid); ev.emit(B); return p;
  };
  const B = { pieces: [], solids, grid, levelHeight, snap, onChange: ev.on, defs: pieces,
    at: (x, y, layer, level = 0) => { [x, y] = snap(x, y); if (layer) return placed.get(key(x, y, layer, level)) || null; return B.pieces.find((p) => p.x === x && p.y === y && p.level === level) || null; },
    allAt: (x, y) => { [x, y] = snap(x, y); return B.pieces.filter((p) => p.x === x && p.y === y); },
    topAt(x, y, fromY = Infinity) { let top = 0; for (const p of B.allAt(x, y)) { const d = pieces[p.kind], h = d.top ? d.top(x - p.x, y - p.y, p) : d.height || 0; if (!h) continue; const t = p.base + h; if (t > top && t <= fromY + 1.2) top = t; } return top; },
    place: (kind, x, y, o) => put(kind, x, y, o),
    remove(x, y, o = {}) { const p = o.layer ? B.at(x, y, o.layer, o.level || 0) : B.allAt(x, y).filter((q) => o.level == null || q.level === o.level).sort((a, b) => b.base - a.base)[0]; if (!p) return null;
      placed.delete(key(p.x, p.y, p.layer, p.level)); B.pieces.splice(B.pieces.indexOf(p), 1); if (p.solid) solids.splice(solids.indexOf(p.solid), 1);
      if (p.ref) { if (p.ref.remove) p.ref.remove(); else if (p.ref.removeFromParent) p.ref.removeFromParent(); else p.ref.visible = false; }
      const inv = o.inventory || inventory, c = pieces[p.kind].cost; if (inv && c && !o.free) pay(inv, c, -1); ev.emit(B); return p; },
    near(x, y, range = 3) { return [...new Set(B.pieces.filter((p) => pieces[p.kind].station && Math.hypot(p.x - x, p.y - y) <= range).map((p) => (pieces[p.kind].station === true ? p.kind : pieces[p.kind].station)))]; },
    toJSON: () => B.pieces.map((p) => (p.dir ? [p.kind, p.x, p.y, p.level, p.dir] : p.level ? [p.kind, p.x, p.y, p.level] : [p.kind, p.x, p.y])),
    load(d) { if (Array.isArray(d)) for (const [k, x, y, level, dir] of d) put(k, x, y, { free: true, level, dir }); return B; } };
  return B;
}

const turn = (dx, dy, dir) => (dir === 1 ? dx : dir === 2 ? -dy : dir === 3 ? -dx : dy);   // distance along the way up
/**
 * A standard stairs piece for createBuilder: it rises `rise` (default 3, one storey) across one cell, so the hero walks
 * up and steps onto a floor placed on level 1 next to it. Options: grid (the builder's cell size, default 1), rise,
 * dir (which way it goes up: 0 towards +y, 1 +x, 2 -y, 3 -x; y is z in 3D), cost, layer (default 'floor'), make
 * (x, y, piece) -> ref (draw it; piece.dir and piece.base are there). In 3D the stairs prop draws it:
 *   pieces: { stairs: stairsPiece({ grid: 2, cost: { wood: 4 }, make: (x, z, p) => place(prop('stairs', { width: 2, depth: 2 }),
 *             x, land.heightAt(x, z) + p.base, z, { rotY: p.dir * Math.PI / 2 }) }) }
 * build.place('stairs', x, z, { dir: 1 }) turns one piece; otherwise the dir given here is used.
 */
export function stairsPiece({ grid = 1, rise = 3, dir = 0, cost, layer = 'floor', make, name } = {}) {
  return { cost, layer, height: rise, dir, ramp: true, name, make,
    top: (dx, dy, p) => Math.max(0.05, Math.min(rise, (turn(dx, dy, p && p.dir != null ? p.dir : dir) / grid + 0.5) * rise)) };
}
/** A ramp: the same as stairsPiece with a gentler default rise (1.5, half a storey). Draw it with prop('ramp') in 3D. */
export function rampPiece(opts = {}) { return stairsPiece({ rise: 1.5, ...opts }); }

/**
 * A list of steps. steps: [{ id, text: 'Gather 5 wood', done: () => inv.has('wood', 5), reward: () => {} }]. A step
 * is finished when its done() returns true (checked by quests.update()) or when you call quests.complete(id).
 *   quests.update() every frame (cheap)      quests.current -> the first unfinished step or null      quests.finished
 *   quests.onStep(fn(step, index))      quests.onAll(fn)      quests.onChange(fn) (any change, a load too)      quests.toJSON() / quests.load(data)
 * Call quests.update() every frame: steps are checked in order, and only the current one counts.
 */
export function createQuests(steps = []) {
  const st = emitter(), all = emitter(), ch = emitter(), S = steps.map((s) => ({ ...s, complete: false }));
  const finish = (s) => { if (s.complete) return; s.complete = true; if (s.reward) s.reward(); st.emit(s, S.indexOf(s)); ch.emit(Q); if (S.every((x) => x.complete)) { Q.finished = true; all.emit(); } };
  const Q = { steps: S, finished: false, onStep: st.on, onAll: all.on, onChange: ch.on, get current() { return S.find((s) => !s.complete) || null; },
    update() { for (let i = 0; i < S.length; i++) { const s = Q.current; if (s && s.done && s.done()) finish(s); else break; } },   // a step already met when it comes up is ticked at once
    complete(id) { const s = S.find((x) => x.id === id); if (s) finish(s); },
    toJSON: () => S.filter((s) => s.complete).map((s) => s.id), load(d) { if (Array.isArray(d)) for (const s of S) s.complete = d.includes(s.id); Q.finished = S.every((x) => x.complete); ch.emit(Q); return Q; } };
  return Q;
}

/**
 * Saving. parts: { inv, needs, clock, build, quests, ... }: anything with toJSON() and load(). The save lives in the
 * player's cloud save on the platform (GCP.save) and in localStorage when offline; { cloud: false } keeps it on this
 * device only (localStorage), e.g. a world a room's host keeps for everyone.
 *   await save.load() -> true if there was one (every part is restored)      save.now()      await save.clear()
 *   save.auto(seconds)  saves by itself, and when the tab is hidden      save.extra (your own plain data, saved along)
 * clear() also stops the autosave, so a finished game is not saved again: call it when the game ends.
 */
export function createSave(key = 'save', parts = {}, { version = 1, cloud = true } = {}) {
  const G = () => cloud && window.GCP && window.GCP.save; let timer = 0, off = false;
  const S = { extra: {},
    async load() { let d = null; try { d = G() ? await G().get(key) : store.get(key); } catch { d = store.get(key); } if (!d || d.v !== version) return false; for (const k in parts) if (d.parts && d.parts[k] !== undefined) parts[k].load(d.parts[k]); S.extra = d.extra || {}; return true; },
    now() { if (off) return null; const d = { v: version, t: Date.now(), extra: S.extra, parts: {} }; for (const k in parts) d.parts[k] = parts[k].toJSON(); if (G()) G().set(key, d); else store.set(key, d); return d; },
    clear() { off = true; clearInterval(timer); store.set(key, null); return Promise.resolve(G() ? G().remove(key) : true); },
    auto(seconds = 20) { off = false; clearInterval(timer); timer = setInterval(S.now, seconds * 1000); D.addEventListener('visibilitychange', () => { if (D.hidden) S.now(); }); return S; } };
  return S;
}

// ---- the panels ----
const CSS = `
.gp-hot{display:flex;gap:6px;pointer-events:auto}
.gp-slot{position:relative;flex:none;width:min(52px,calc(94vw / var(--gp-n,8) - 6px));aspect-ratio:1;border-radius:11px;background:var(--gh-panel);border:2px solid var(--gh-line);display:grid;place-items:center;cursor:pointer;transition:transform .1s,border-color .1s}
.gp-slot img{width:74%;height:74%;pointer-events:none}
.gp-slot b{position:absolute;right:4px;bottom:1px;font-size:12px;font-weight:800;text-shadow:0 1px 2px #000,0 0 3px #000}
.gp-slot u{position:absolute;left:5px;top:2px;font-size:10px;opacity:.6;text-decoration:none}
.gp-slot.on{border-color:var(--gh-accent);transform:translateY(-4px);box-shadow:0 6px 16px rgba(0,0,0,.4)}
.gp-slot.pick{border-color:#fff;border-style:dashed}
.gp-win{position:absolute;inset:0;display:grid;place-items:center;background:rgba(8,10,14,.55);pointer-events:auto;animation:gh-fade .18s ease-out;padding:14px}
.gp-box{background:rgba(22,25,31,.96);border:1px solid var(--gh-line);border-radius:16px;padding:16px 18px;box-shadow:0 18px 60px rgba(0,0,0,.5);max-width:96vw;max-height:92vh;overflow:auto;display:flex;gap:20px;flex-wrap:wrap;justify-content:center}
.gp-h{font-size:12px;letter-spacing:.1em;text-transform:uppercase;opacity:.65;margin:0 0 10px;font-weight:800;display:flex;justify-content:space-between;gap:20px}
.gp-grid{display:grid;grid-template-columns:repeat(var(--gp-cols,6),52px);gap:6px;--gp-n:1}
.gp-info{min-height:34px;margin-top:10px;font-size:13px;font-weight:500;max-width:342px;display:flex;align-items:center;gap:8px}.gp-info span{flex:1;opacity:.85}
.gp-x{pointer-events:auto;cursor:pointer;border:0;background:none;color:inherit;font-size:14px;opacity:.7;padding:0 2px}
.gp-btn.gp-ghost{background:rgba(255,255,255,.14);color:inherit}.gp-rec.off{opacity:.62}.gp-craft{max-height:70vh;overflow:auto}
.gp-rec{display:flex;align-items:center;gap:10px;padding:7px 8px;border-radius:10px;border:1px solid transparent;min-width:250px}
.gp-rec:hover{border-color:var(--gh-line);background:rgba(255,255,255,.04)}
.gp-rec img{width:34px;height:34px}.gp-rec div{flex:1;font-size:14px}.gp-rec small{display:block;font-weight:500;font-size:12px;opacity:.9}
.gp-rec small i{font-style:normal;margin-right:8px}.gp-rec small i.no{color:#ff8a70}
.gp-btn{pointer-events:auto;cursor:pointer;border:0;border-radius:9px;padding:7px 13px;font:800 13px system-ui,sans-serif;background:var(--gh-accent);color:#16181c}
.gp-btn:disabled{opacity:.3;cursor:default}
.gp-needs{display:flex;flex-direction:column;gap:5px;background:var(--gh-panel);border:1px solid var(--gh-line);border-radius:12px;padding:9px 11px}
.gp-need{display:flex;align-items:center;gap:8px;font-size:11px;font-weight:800;letter-spacing:.06em;text-transform:uppercase}
.gp-need span{width:54px;opacity:.75}.gp-need div{width:min(150px,20vw);height:9px;border-radius:5px;background:rgba(255,255,255,.14);overflow:hidden}
.gp-need i{display:block;height:100%;border-radius:5px;transition:width .3s}
.gp-need.low i{animation:gp-pulse .7s infinite alternate}
.gp-q{background:var(--gh-panel);border:1px solid var(--gh-line);border-radius:12px;padding:9px 12px;font-size:13px;font-weight:600;display:flex;flex-direction:column;gap:4px;max-width:260px;white-space:normal;text-align:left}
.gp-q p{margin:0;display:flex;gap:7px;opacity:.55}.gp-q p.now{opacity:1}.gp-q p.ok{opacity:.5;text-decoration:line-through}
.gp-map{border-radius:12px;border:2px solid var(--gh-line);box-shadow:0 4px 18px rgba(0,0,0,.3);display:block;image-rendering:pixelated;background:#1a1d24}
.gp-menu{display:flex;flex-direction:column;gap:10px;align-items:stretch;min-width:240px;text-align:center}
.gp-menu h2{margin:0 0 6px;font-size:26px}.gp-row{display:flex;gap:8px}.gp-code{flex:1;min-width:0;width:150px;pointer-events:auto;border:1px solid var(--gh-line);border-radius:9px;background:rgba(255,255,255,.08);color:inherit;font:800 16px system-ui,sans-serif;letter-spacing:.18em;text-align:center;padding:8px;text-transform:uppercase;-webkit-user-select:text;user-select:text}.gp-err{color:#ff8a70;min-height:1em}.gp-menu table{font-size:13px;font-weight:500;opacity:.85;margin:4px auto;text-align:left;border-spacing:10px 3px}
@keyframes gp-pulse{from{opacity:1}to{opacity:.45}}
@media (max-width:600px){.gp-grid{--gp-n:8.6;grid-template-columns:repeat(var(--gp-cols,6),auto)}.gp-box{padding:12px}.gp-rec{min-width:0}}
`;
const css = () => { if (!D.getElementById('gp-css')) { const s = el('style'); s.id = 'gp-css'; s.textContent = CSS; D.head.appendChild(s); } };
const corner = (hud, c) => hud.el.querySelector('.gh-' + c);
const slotEl = (inv, i, label) => { const d = el('div', 'gp-slot'), s = inv.slots[i]; if (label) d.appendChild(el('u', null, label)); if (s) { const im = el('img'); im.src = itemIcon(s.id, inv.def(s.id)); im.alt = s.id; d.appendChild(im); if (s.n > 1) d.appendChild(el('b', null, String(s.n))); d.title = inv.def(s.id).name; } return d; };

/**
 * The hotbar: the first slots of the inventory along the bottom, the held one raised. Click or tap selects; with
 * { input } the number keys, the mouse wheel and a gamepad's shoulder buttons select too (call bar.update() every
 * frame). Returns { el, update(), remove() }.
 */
export function hotbarUI(hud, inv, { input, corner: at = 'bc' } = {}) {
  css(); const bar = el('div', 'gp-hot'); bar.style.setProperty('--gp-n', inv.hotbar); corner(hud, at).appendChild(bar);
  const draw = () => { bar.textContent = ''; for (let i = 0; i < inv.hotbar; i++) { const d = slotEl(inv, i, String((i + 1) % 10)); if (i === inv.selected) d.classList.add('on'); d.addEventListener('pointerdown', (e) => { e.stopPropagation(); inv.select(i); }); bar.appendChild(d); } };
  const off = inv.onChange(draw); draw();
  return { el: bar, update() { if (!input) return; for (let i = 0; i < inv.hotbar; i++) if (input.pressed('Digit' + ((i + 1) % 10))) inv.select(i); if (input.wheel) inv.select(inv.selected + input.wheel); if (input.pressed('Pad4')) inv.select(inv.selected - 1); if (input.pressed('Pad5')) inv.select(inv.selected + 1); }, remove() { off(); bar.remove(); } };
}

/**
 * The inventory window, with a crafting list beside it when you pass { crafting }. Click or tap a slot to pick it
 * up, then another to move or merge; the line under the grid names the picked thing and offers Use (eat, equip,
 * place) and Drop when you pass those. Options: crafting (a createCrafting), stations (() => names of stations near
 * the player), title, onOpen, onClose, onUse(slotIndex, item) (also on a double click), onDrop(slotIndex, item),
 * canUse(item) (which things show the Use button; default: those with food, water, heal or place in their definition).
 * Returns { open(), close(), toggle(), isOpen, refresh() }. Escape closes it.
 */
export function inventoryUI(hud, inv, { crafting, stations, title = 'Backpack', onOpen, onClose, onUse, onDrop, canUse } = {}) {
  css(); let win = null, pick = -1, offInv = null;
  const usable = (it) => (canUse ? canUse(it) : !!(it.def.food || it.def.water || it.def.heal || it.def.place)), about = (f) => f.name + (f.about ? ': ' + f.about : f.food ? ': food' : f.tool ? ': a tool' : f.place ? ': place it in the world' : '');
  const draw = () => {
    if (!win) return; const box = win.firstChild; box.textContent = '';
    const left = el('div'), h = el('p', 'gp-h', title), x = el('button', 'gp-x', '✕'); x.addEventListener('click', () => U.close()); h.appendChild(x); left.appendChild(h);
    const grid = el('div', 'gp-grid'), info = el('div', 'gp-info'); grid.style.setProperty('--gp-cols', inv.slots.length > 30 ? 8 : 6);
    const tell = (i) => { info.textContent = ''; const s = inv.slots[i]; if (!s) { info.appendChild(el('span', null, 'Pick a thing up, then choose where it goes.')); return; } const it = { ...s, def: inv.def(s.id) }; info.appendChild(el('span', null, about(it.def)));
      if (i === pick) { if (onUse && usable(it)) { const b = el('button', 'gp-btn', 'Use'); b.addEventListener('click', () => { pick = -1; onUse(i, it); draw(); }); info.appendChild(b); } if (onDrop) { const b = el('button', 'gp-btn gp-ghost', 'Drop'); b.addEventListener('click', () => { pick = -1; onDrop(i, it); draw(); }); info.appendChild(b); } } };
    inv.slots.forEach((s, i) => { const d = slotEl(inv, i, i < inv.hotbar ? String((i + 1) % 10) : ''); if (i === pick) d.classList.add('pick'); if (i === inv.selected) d.classList.add('on');
      d.addEventListener('pointerenter', () => { if (pick < 0 && s) tell(i); });
      d.addEventListener('click', () => { if (pick < 0) { if (s) pick = i; } else if (pick === i) pick = -1; else { inv.move(pick, i); pick = -1; } draw(); });
      d.addEventListener('dblclick', () => { pick = -1; if (s && onUse) onUse(i, { ...s, def: inv.def(s.id) }); draw(); });
      grid.appendChild(d); });
    left.appendChild(grid); left.appendChild(info); tell(pick); box.appendChild(left);
    if (crafting) { const near = stations ? stations() : undefined, right = el('div', 'gp-craft'); right.appendChild(el('p', 'gp-h', 'Craft'));
      for (const r of crafting.recipes) { const f = inv.def(r.makes), ok = crafting.can(r, near), row = el('div', 'gp-rec' + (ok ? '' : ' off')), im = el('img'), tx = el('div'), need = el('small'), b = el('button', 'gp-btn', 'Make'); im.src = itemIcon(r.makes, f); im.alt = ''; tx.textContent = (r.name || f.name) + (r.n > 1 ? ' × ' + r.n : '');
        for (const id in r.needs) need.appendChild(el('i', inv.has(id, r.needs[id]) ? '' : 'no', `${Math.min(inv.count(id), 99)}/${r.needs[id]} ${inv.def(id).name.toLowerCase()}`));
        if (r.station) need.appendChild(el('i', near && !near.includes(r.station) ? 'no' : '', 'at a ' + nice(r.station).toLowerCase())); tx.appendChild(need);
        b.disabled = !ok; b.addEventListener('click', () => { crafting.make(r, near); }); row.appendChild(im); row.appendChild(tx); row.appendChild(b); right.appendChild(row); }
      box.appendChild(right); }
  };
  const key = (e) => { if (e.code === 'Escape' && win) { e.stopPropagation(); U.close(); } };
  const U = { get isOpen() { return !!win; },
    open() { if (win) return U; win = el('div', 'gp-win'); win.appendChild(el('div', 'gp-box')); win.addEventListener('pointerdown', (e) => { if (e.target === win) U.close(); }); hud.el.appendChild(win); offInv = inv.onChange(draw); addEventListener('keydown', key, true); pick = -1; draw(); if (onOpen) onOpen(); return U; },
    close() { if (!win) return U; win.remove(); win = null; if (offInv) offInv(); removeEventListener('keydown', key, true); if (onClose) onClose(); return U; },
    toggle() { return win ? U.close() : U.open(); }, refresh: draw };
  return U;
}

/** Bars for a createNeeds(), stacked in a corner (default top left). A bar pulses when it is under a quarter. Options: corner, colors ({ food: '#e8a23a' }), labels. */
export function needsUI(hud, needs, { corner: at = 'tl', colors = {}, labels = {} } = {}) {
  css(); const COL = { health: '#e5484d', food: '#e8a23a', water: '#4aa6e8', stamina: '#6ad86a', warmth: '#ff8a4a', energy: '#c8a0ff' }, box = el('div', 'gp-needs'), rows = {};
  for (const k of needs.keys) { const r = el('div', 'gp-need'), b = el('div'), f = el('i'); f.style.background = colors[k] || needs.defs[k].color || COL[k] || '#c8ccd2'; b.appendChild(f); r.appendChild(el('span', null, labels[k] || needs.defs[k].label || nice(k))); r.appendChild(b); box.appendChild(r); rows[k] = [r, f]; }
  const set = (k) => { const [r, f] = rows[k], t = needs.ratio(k); f.style.width = (t * 100) + '%'; r.classList.toggle('low', t < 0.25); };
  needs.keys.forEach(set); const off = needs.onChange(set); corner(hud, at).appendChild(box);
  return { el: box, remove() { off(); box.remove(); } };
}

/** The day and the hour of a createClock() as a small panel (default top right). Call ui.update() every frame or so. */
export function clockUI(hud, clock, { corner: at = 'tr' } = {}) {
  const p = el('div', 'gh-p'), ic = el('span', 'gh-i'), tx = el('span'); p.appendChild(ic); p.appendChild(tx); corner(hud, at).appendChild(p); let last = '';
  const U = { el: p, update() { const s = clock.label; if (s !== last) { last = s; tx.textContent = s; ic.textContent = clock.phase === 'night' ? '☾' : clock.phase === 'day' ? '☀' : '◐'; } }, remove() { p.remove(); } }; U.update(); return U;
}

/**
 * The steps of a createQuests() as a checklist (default top right): the current step bright, the one before it
 * struck out, the next ones dim, and how many are done. Options: corner, title (default 'Quests'), max (lines shown
 * at once, default 4; 0 shows every step).
 */
export function questUI(hud, quests, { corner: at = 'tr', title = 'Quests', max = 4 } = {}) {
  css(); const box = el('div', 'gp-q'); corner(hud, at).appendChild(box);
  const draw = () => { box.textContent = ''; const S = quests.steps, cur = quests.current, i = cur ? S.indexOf(cur) : S.length, n = S.filter((s) => s.complete).length;
    const head = el('span', 'gh-l', title + ' '); head.appendChild(el('b', null, n + ' / ' + S.length)); box.appendChild(head);
    const from = max ? Math.max(0, Math.min(i - 1, S.length - max)) : 0, to = max ? Math.min(S.length, from + max) : S.length;
    for (let k = from; k < to; k++) { const s = S[k], p = el('p', s.complete ? 'ok' : s === cur ? 'now' : ''); p.appendChild(el('span', null, s.complete ? '✔' : s === cur ? '▸' : '·')); p.appendChild(el('span', null, s.text)); box.appendChild(p); } };
  const off = quests.onChange ? quests.onChange(draw) : quests.onStep(draw); draw(); return { el: box, refresh: draw, remove() { off(); box.remove(); } };
}

/**
 * A small map. Options: size (pixels, default 132), range (world units from the centre to the edge, default 40),
 * center (() => ({ x, y })), color ((x, y) => a CSS colour or { r, g, b } in 0..1 for that spot of the world: e.g.
 * land.mapColor from ground2d, or (x, z) => land.colorAt(x, z) from terrain), markers (() => [{ x, y, color }]),
 * corner. It redraws a few times a second by itself. Returns { el, remove() }.
 */
export function minimapUI(hud, { size = 132, range = 40, center, color, markers, corner: at = 'tr', cells = 44 } = {}) {
  css(); const cv = el('canvas', 'gp-map'); cv.width = cv.height = cells; cv.style.width = cv.style.height = `min(${size}px, 30vw)`; corner(hud, at).appendChild(cv); const c = cv.getContext('2d'), img = c.createImageData(cells, cells);
  const hexOf = new Map(), parse = (v) => { if (typeof v !== 'string') return [Math.sqrt(v.r) * 255, Math.sqrt(v.g) * 255, Math.sqrt(v.b) * 255]; let o = hexOf.get(v); if (!o) { c.fillStyle = v; const h = c.fillStyle; o = [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]; hexOf.set(v, o); } return o; };
  const draw = () => { const p = center ? center() : { x: 0, y: 0 }, d = img.data;
    if (color) { for (let j = 0; j < cells; j++) for (let i = 0; i < cells; i++) { const o = parse(color(p.x + (i / (cells - 1) * 2 - 1) * range, p.y + (j / (cells - 1) * 2 - 1) * range)), k = (j * cells + i) * 4; d[k] = o[0]; d[k + 1] = o[1]; d[k + 2] = o[2]; d[k + 3] = 255; } c.putImageData(img, 0, 0); } else c.clearRect(0, 0, cells, cells);
    for (const m of markers ? markers() : []) { const x = ((m.x - p.x) / range + 1) / 2 * cells, y = ((m.y - p.y) / range + 1) / 2 * cells; if (x < 0 || y < 0 || x >= cells || y >= cells) continue; c.fillStyle = m.color || '#fff'; c.fillRect(Math.round(x) - 1, Math.round(y) - 1, 2, 2); }
    c.fillStyle = '#fff'; c.fillRect(cells / 2 - 1, cells / 2 - 1, 3, 3); c.fillStyle = '#16181c'; c.fillRect(cells / 2, cells / 2, 1, 1); };
  draw(); const id = setInterval(draw, 300); return { el: cv, refresh: draw, remove() { clearInterval(id); cv.remove(); } };
}

/**
 * A pause menu on Escape (or P): Resume, the controls, your own buttons, Restart. Options: title, controls ([['WASD',
 * 'Move'], ['E', 'Use']]), buttons ([['Save', fn], ['Sound', fn]]), onPause, onResume, onRestart. Returns { open(), close(), isOpen }.
 */
export function pauseMenu(hud, { title = 'Paused', controls = [], buttons = [], onPause, onResume, onRestart } = {}) {
  css(); let win = null;
  const M = { get isOpen() { return !!win; },
    open() { if (win || hud.screenOpen) return M; win = el('div', 'gp-win'); const box = el('div', 'gp-box'), m = el('div', 'gp-menu'); m.appendChild(el('h2', null, title));
      const b = (label, fn, main) => { const x = el('button', main ? 'gh-b' : 'gh-sb', label); x.addEventListener('click', fn); m.appendChild(x); };
      b('Resume', () => M.close(), true); if (controls.length) { const t = el('table'); for (const [k, what] of controls) { const r = el('tr'), a = el('td'); a.appendChild(el('span', 'gh-key', k)); r.appendChild(a); r.appendChild(el('td', null, what)); t.appendChild(r); } m.appendChild(t); }
      for (const [label, fn] of buttons) b(label, fn); if (onRestart) b('Restart', () => { M.close(); onRestart(); });
      box.appendChild(m); win.appendChild(box); hud.el.appendChild(win); if (onPause) onPause(); return M; },
    close() { if (!win) return M; win.remove(); win = null; if (onResume) onResume(); return M; } };
  addEventListener('keydown', (e) => { if (e.target && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return; if (e.code === 'Escape' || e.code === 'KeyP') { if (win) M.close(); else if (!hud.el.querySelector('.gp-win')) M.open(); } });
  return M;
}

/**
 * The start screen of a multiplayer game: Host a room (a short code to share is made for you), Join one by its code,
 * or Play alone. Resolves with { mode: 'host' | 'join' | 'solo', code }; open the room with it:
 *   const lobby = lobbyUI(hud, { title: 'Wildstead' });  GCP.test.onAutostart(() => lobby.solo());
 *   const { mode, code } = await lobby;   // lobby.solo(), lobby.host(code), lobby.join(code) settle it from code
 *   const room = mode === 'solo' ? null : GCP.room(code);        // or joinSession(code, …) from @gcp/net.js
 * Options: title, subtitle, solo (false hides Play alone), codeLength (default 4), code (prefilled, e.g. from GCP.test.param('room')).
 * A link that carries ?room=CODE fills the code in, so a host can share the page address with it.
 */
export function lobbyUI(hud, { title = '', subtitle = 'Play together', solo = true, codeLength = 4, code = '' } = {}) {
  css(); const make = () => Array.from({ length: codeLength }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ'[(Math.random() * 24) | 0]).join('');
  let api = null; const out = new Promise((res) => {
    const win = el('div', 'gp-win'), box = el('div', 'gp-box'), m = el('div', 'gp-menu'), inp = el('input', 'gp-code'), err = el('small', 'gp-err', '');
    const done = (mode, c) => { win.remove(); res({ mode, code: c }); }, clean = () => inp.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
    const b = (label, fn, main) => { const x = el('button', main ? 'gh-b' : 'gh-sb', label); x.addEventListener('click', fn); m.appendChild(x); return x; };
    if (title) m.appendChild(el('h2', null, title)); if (subtitle) m.appendChild(el('small', null, subtitle));
    b('Host a room', () => done('host', make()), true);
    const row = el('div', 'gp-row'); inp.placeholder = 'ROOM CODE'; inp.maxLength = 8; inp.autocapitalize = 'characters'; inp.spellcheck = false; inp.value = code || new URLSearchParams(location.search).get('room') || ''; row.appendChild(inp); m.appendChild(row);
    const join = () => { const c = clean(); if (c.length < 2) { err.textContent = 'Type the code the host shared'; inp.focus(); return; } done('join', c); };
    const jb = el('button', 'gp-btn', 'Join'); jb.addEventListener('click', join); row.appendChild(jb); inp.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.code === 'Enter') join(); }); m.appendChild(err);
    if (solo) b('Play alone', () => done('solo', ''));
    box.appendChild(m); win.appendChild(box); hud.el.appendChild(win);
    api = { solo: () => done('solo', ''), host: (c) => done('host', c || make()), join: (c) => done('join', String(c).toUpperCase()) };
  });
  // the promise can also be settled from code, e.g. GCP.test.onAutostart(() => lobby.solo())
  return Object.assign(out, { solo: () => api.solo(), host: (c) => api.host(c), join: (c) => api.join(c) });
}
