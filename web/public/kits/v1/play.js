// @gcp/play.js — the systems under a game with depth, and the interface that shows them. Engine-agnostic: plain
// data and DOM, so the same code serves 2D and 3D games. Each part works alone and they fit each other:
//   createInventory   slots, stacks, a hotbar, item definitions with painted icons
//   createCrafting    recipes that turn items into items, optionally near a station (campfire, workbench)
//   createNeeds       health, food, water, stamina or your own: drain, recovery, what happens when one runs out
//   createClock       a day that passes: hour, day number, dawn / day / dusk / night; drives the stage's light
//   createNodes       things in the world to use: trees to chop, rocks to mine, bushes to pick, doors, chests
//   createInteract    finds the nearest one, shows "[E] Chop the oak", uses it on the action, fills the inventory
//   createBuilder     pieces placed on a grid for a cost: walls, floors, fires, beds, storeys, stairs
//   createCrops       farming: plant, (water,) grow in four stages, harvest through the nodes
//   createQuests      a list of steps the player ticks off, the spine of a tutorial or a campaign
//   createWorldSync   one shared world in a room: the host decides, every player sees the same pieces, nodes and crops
//   createLoopback    rooms that talk inside one page, to test a shared world with two players in one play-through
//   createSave        the whole state in the player's cloud save (localStorage offline), with autosave
//   hotbarUI, inventoryUI, needsUI, clockUI, questUI, minimapUI, pauseMenu      the panels for them, on a createHud()
//   lobbyUI           the start screen of a game with rooms: host with a code, join with a code, or play alone
import { store } from './core.js';
import { loadImage, panelOpen } from './ui.js';

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
function iconCanvas(id, def) {
  const key = id + '|' + (def.color || '') + '|' + (def.like || ''); if (ICONS.has(key)) return ICONS.get(key);
  const cv = D.createElement('canvas'); cv.width = cv.height = 72; const c = cv.getContext('2d', { willReadFrequently: true }); c.scale(72, 72); c.lineJoin = 'round';   // read back at once, so keep it off the GPU
  const draw = typeof def.icon === 'function' ? def.icon : ICON[def.like || id];
  if (draw) draw(c); else { R(c, 0.16, 0.16, 0.68, 0.68, def.color || '#8a94a6', 0.14); c.fillStyle = '#fff'; c.font = '700 0.42px system-ui'; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText(String(def.name || id).charAt(0).toUpperCase(), 0.5, 0.52); }
  ICONS.set(key, cv); return cv;
}
/**
 * An item's icon as an image URL. Built-in kinds (wood, stone, fiber, berry, meat, cooked_meat, water, ore, ingot,
 * plank, rope, seed, wheat, axe, pickaxe, sword, hoe, torch, campfire, wall, floor, door, fence, tent, chest, bed, workbench,
 * coin, gem, key, potion, bandage) are painted; an unknown kind gets a tile with its first letter in def.color.
 * def.icon may be your own: an image URL, a canvas, or a function (ctx) that draws in a 1 × 1 square.
 */
export function itemIcon(id, def = {}) {
  if (typeof def.icon === 'string') return def.icon; if (def.icon && def.icon.toDataURL) return def.icon.toDataURL();
  const cv = iconCanvas(id, def); return cv.__url || (cv.__url = cv.toDataURL());
}
/** An item's icon as something u.image() draws (a canvas, or an image loading from def.icon's URL). */
export function itemImage(id, def = {}) {
  if (typeof def.icon === 'string') return loadImage(def.icon); if (def.icon && def.icon.getContext) return def.icon;
  return iconCanvas(id, def);
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
 * solid (its collision circle: switched off while it is spent; a node whose ref was taken out for good by chunks.forget()
 * or chunks.load() is skipped and dropped by itself), when(node) (usable only while it returns true: a ripe
 * crop, a door with the key in hand; notYet is what it says otherwise), onUse(node) (for doors, chests, signs: called instead
 * of harvesting) }. y is the second ground axis: z in a 3D game.
 *   nodes.add(node) -> node      nodes.remove(node)      nodes.nearest(x, y, range) -> the closest usable node or null
 *   nodes.fromScatter(items, rule)  every scattered thing becomes a node: rule(item) returns the node's fields or
 *                                  nothing to skip it, e.g. (it) => it.type === 'tree' && { label: 'Chop the tree', hp: 3, drops: { wood: [2, 3] }, respawn: 90 }
 *   nodes.use(node, { tool, power, rand }) -> { ok: false, why: 'needs axe' } | { ok: true, done: false, hp } | { ok: true, done: true, drops: { wood: 3 } }
 *   nodes.update(dt) every frame (respawns)      nodes.list      nodes.onDeplete(fn(node, drops))
 *   nodes.removeWhere(fn)  drop every node fn(node) is true for: e.g. the nodes of a chunk that unloads
 *   node.id (numbered in the order added, the same on every device that builds the same world)   nodes.byId(id)
 *   nodes.useFor(node, inventory, opts)  use it and put the drops in that inventory: what a room's host calls for a guest
 */
export function createNodes() {
  let nextId = 1; const ev = emitter(), list = [], show = (n, on) => { if (n.ref) n.ref.visible = on; if (n.solid && typeof n.solid === 'object') n.solid.off = !on; };
  const N = { list, onDeplete: ev.on,
    add(n) { const node = { r: 1.2, hp: 1, id: n.id ?? nextId++, ...n, left: n.hp || 1, gone: false, timer: 0 }; list.push(node); return node; },
    byId: (id) => { const n = list.find((n) => n.id === id); if (n && n.ref && n.ref.gone) { N.remove(n); return null; } return n || null; },   // a thing its chunks forgot is no node any more
    useFor(n, inventory, opts) { const r = N.use(n, opts); if (r.ok && r.done && inventory) { r.left = {}; for (const id in r.drops) { const k = inventory.add(id, r.drops[id]); if (k) r.left[id] = k; } } return r; },
    fromScatter(items, rule) { const out = []; for (const it of items) { if (it.gone) continue; const d = rule(it); if (d) out.push(N.add({ x: it.x, y: it.z ?? it.y, ref: it, ...(it.key ? { id: it.key } : {}), solid: it.circle || (it.solid === true ? it : null), kind: it.type, ...d })); } return out; },
    remove(n) { const i = list.indexOf(n); if (i >= 0) list.splice(i, 1); },
    removeWhere(fn) { for (let i = list.length - 1; i >= 0; i--) if (fn(list[i])) list.splice(i, 1); },
    nearest(x, y, range = 0) { let best = null, bd = Infinity; for (const n of list) { if (n.gone || (n.ref && n.ref.gone) || (n.when && !n.when(n))) continue; const d = Math.hypot(n.x - x, n.y - y) - (n.r + range); if (d < 0 && d < bd) { bd = d; best = n; } } return best; },
    use(n, { tool, power = 1, rand = Math.random } = {}) {
      if (n && n.ref && n.ref.gone) { N.remove(n); n = null; } if (!n || n.gone) return { ok: false, why: 'nothing here' }; if (n.when && !n.when(n)) return { ok: false, why: n.notYet || 'not ready yet' }; if (n.onUse) { n.onUse(n); return { ok: true, done: true, drops: {} }; }
      if (n.tool && n.tool !== tool) return { ok: false, why: 'needs ' + nice(n.tool).toLowerCase() };
      n.left -= power; if (n.left > 0) return { ok: true, done: false, hp: n.left };
      const drops = {}; for (const id in n.drops || {}) { const d = n.drops[id]; drops[id] = Array.isArray(d) ? d[0] + Math.floor(rand() * (d[1] - d[0] + 1)) : d; }
      n.gone = true; n.timer = n.respawn || 0; show(n, false); if (!n.respawn) N.remove(n); ev.emit(n, drops); return { ok: true, done: true, drops };
    },
    update(dt) { for (let i = list.length - 1; i >= 0; i--) if (list[i].ref && list[i].ref.gone) list.splice(i, 1); for (const n of list) if (n.gone && n.respawn) { n.timer -= dt; if (n.timer <= 0) { n.gone = false; n.left = n.hp || 1; show(n, true); } } } };
  return N;
}

/**
 * Ties the nodes to the player. Every frame it finds the nearest usable node, shows the prompt ("[E] Chop the oak",
 * with the right key for keyboard, touch or gamepad), and on the action uses it and puts what drops in the inventory.
 * Options: nodes, input, hud, at (() => ({ x, y }): where the player stands; y is z in 3D), action (the name bound
 * with input.bind, default 'interact'), inventory, tool (() => the kind in hand, e.g. () => inv.held && inv.held.def.tool),
 * power ((node, tool) => hits per press, e.g. 2 with the right tool), range (extra reach, default 0.3),
 * onHit(node, result) (every press: play a sound, shake the tree), onGet(node, drops) (when it is finished),
 * send(node, tool, power) (in a room where the host decides: called instead of using the node here. Return the
 * promise of the result, as createWorldSync's use does, and onHit, onGet and the toasts run when it arrives:
 * send: (node, tool, power) => sync.use(node, { tool, power }). Without a world sync, send node.id to the host,
 * which calls nodes.useFor(nodes.byId(id), thatPlayersInventory, { tool, power }) and sends back the result).
 * Returns { update() every frame, target (the node in reach or null), use() (press it yourself), enabled }.
 */
export function createInteract({ nodes, input, hud, at, action = 'interact', inventory, tool, power, range = 0.3, onHit, onGet, send } = {}) {
  let shown = null, key = '';
  const I = { target: null, enabled: true,
    use() { const n = I.target; if (!n) return null; const t = tool ? tool() : undefined, pw = power ? power(n, t) : 1;
      if (send) {   // the host decides: the feedback runs when its answer arrives
        const p = send(n, t, pw); if (p && typeof p.then === 'function') p.then((r) => { r = r || {}; const ok = !!r.ok && !r.error;
          if (ok && r.done && hud && r.left && typeof r.left === 'object' && Object.keys(r.left).length) hud.toast('The backpack is full');
          if (onHit) onHit(n, r); if (ok && r.done && onGet) onGet(n, r.drops || {}); if (!ok && hud && (r.why || r.error)) hud.toast(nice(r.why || r.error)); shown = null; });
        return { ok: true, sent: true }; }
      const r = nodes.use(n, { tool: t, power: pw });
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
 * Farming. Crops are planted on a grid, grow through four stages (0 seeds, 1 sprout, 2 growing, 3 ripe) and are
 * harvested through the same nodes and prompt as trees and rocks. Options: nodes (a createNodes; required), types
 * ({ wheat: { seed: 'seed', grow: 90, yields: { wheat: [2, 3], seed: [1, 2] }, regrow: false, label: 'Harvest the wheat' } }:
 * grow is seconds from seed to ripe, regrow keeps the plant and grows the fruit again), grid (default 1), water
 * (true: a crop grows only while watered, and each new stage dries it again), make (x, y, crop) -> ref (draw it; it is
 * called again at every stage, the old ref removed): cropSprites() from @gcp/craft2d.js and cropModels(land) from
 * @gcp/craft.js draw them for you.
 *   crops.plant(type, x, y, { inventory }) -> the crop, or { error: 'occupied' | 'needs a seed' }   (takes one seed from inventory)
 *   crops.water(x, y) -> true      crops.at(x, y)      crops.list ({ type, x, y, stage, t, watered })
 *   crops.update(dt) every frame (or with the clock: crops.update(dt * speed))      crops.onRipe(fn(crop))      crops.onHarvest(fn(crop, drops))
 *   crops.toJSON() / crops.load(data)   (the stage and the growth so far are kept)
 */
export function createCrops({ nodes, types = {}, grid = 1, water = false, make } = {}) {
  if (!nodes) throw new Error('createCrops() needs { nodes } (a createNodes()): ripe crops are harvested through it.');
  const ripe = emitter(), cut = emitter(), list = [], snap = (v) => Math.round(v / grid) * grid;
  const draw = (c) => { if (c.ref) { if (c.ref.remove) c.ref.remove(); else if (c.ref.removeFromParent) c.ref.removeFromParent(); else c.ref.visible = false; } c.ref = make ? make(c.x, c.y, c) : null; };
  const stageOf = (c) => Math.min(3, Math.floor(c.t / (types[c.type].grow || 60) * 3));
  const sow = (type, x, y, t = 0, watered = false) => {
    const d = types[type], c = { type, x, y, t, watered, stage: 0, ref: null, node: null }; c.stage = stageOf(c); list.push(c); draw(c);
    c.node = nodes.add({ id: 'crop:' + x + ',' + y, x, y, r: grid * 0.75, kind: 'crop', crop: c, label: d.label || 'Harvest the ' + nice(type).toLowerCase(), drops: d.yields || { [type]: 1 }, when: () => c.stage === 3, notYet: 'not ripe yet' });
    return c;
  };
  nodes.onDeplete((n, drops) => { const c = n.crop; if (!c || !list.includes(c)) return; cut.emit(c, drops);
    if (types[c.type].regrow) { c.t = (types[c.type].grow || 60) * 2 / 3; c.stage = 2; draw(c); c.node = nodes.add({ id: n.id, x: n.x, y: n.y, r: n.r, kind: 'crop', crop: c, label: n.label, drops: n.drops, when: n.when, notYet: n.notYet }); }
    else { list.splice(list.indexOf(c), 1); const make0 = make; make = null; draw(c); make = make0; } });
  const C = { list, types, onRipe: ripe.on, onHarvest: cut.on,
    at: (x, y) => list.find((c) => c.x === snap(x) && c.y === snap(y)) || null,
    plant(type, x, y, { inventory } = {}) { const d = types[type]; if (!d) return { error: 'unknown crop ' + type }; x = snap(x); y = snap(y); if (C.at(x, y)) return { error: 'occupied' };
      if (inventory && d.seed) { if (!inventory.has(d.seed)) return { error: 'needs a ' + nice(d.seed).toLowerCase() }; inventory.remove(d.seed, 1); } return sow(type, x, y); },
    water(x, y) { const c = C.at(x, y); if (!c) return false; c.watered = true; if (make) draw(c); return true; },
    update(dt) { for (const c of list) { if (c.stage >= 3 || (water && !c.watered)) continue; c.t += dt; const s = stageOf(c); if (s !== c.stage) { c.stage = s; if (water) c.watered = false; draw(c); if (s === 3) ripe.emit(c); } } },
    toJSON: () => list.map((c) => [c.type, c.x, c.y, Math.round(c.t * 10) / 10, c.watered ? 1 : 0]),
    load(d) { if (Array.isArray(d)) for (const [type, x, y, t, w] of d) if (types[type] && !C.at(x, y)) sow(type, x, y, t, !!w); return C; } };
  return C;
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
 * One shared world in a room (GCP.room or a createLoopback room). The host decides every change: a guest's request
 * goes to the host, which checks it, applies it and sends it to everyone, so every player sees the same placed pieces,
 * the same felled trees and the same crops. Each player keeps their own inventory: a guest pays for a piece and gets
 * the drops of a tree on their own device when the host says yes. A late joiner gets the whole world when it joins.
 * Options: build, nodes, crops, chunks (chunks2d or terrainChunks: what is gone for good), inventory (this player's),
 * onChange(op) (after any change from anyone: a sound, a puff of dust).
 *   const sync = createWorldSync(room, { build, nodes, crops, inventory: inv });
 *   await sync.place('wall', x, y, { level: 1 })   -> the result ({ error } when the host refused)
 *   await sync.remove(x, y, { layer })   await sync.plant('wheat', x, y)   await sync.water(x, y)
 *   await sync.use(node, { tool, power })   -> { ok, done, drops, hp (hits left), left ({ wood: 2 }: drops that did not
 *                                              fit this player's backpack) } or { error }, the same for host and guest
 *   createInteract({ ..., send: (node, tool, power) => sync.use(node, { tool, power }) })   routes the interact prompt through it
 * Alone (no room, or before it opens) every call applies at once, so the same code serves one player and many.
 * On an endless map a guest may use a thing far from the host: with `chunks` given, the host loads that piece of land
 * unseen for a while (chunks.ensure) and answers as for its own, so nothing more is needed in the game.
 */
export function createWorldSync(room, { build, nodes, crops, chunks, inventory, onChange } = {}) {
  let seq = 0, timer = 0; const wait = new Map(), spent = new Set(), host = () => !room || !room.connected || room.isHost;
  const snapshot = () => ({ build: build ? build.toJSON() : null, crops: crops ? crops.toJSON() : null, chunks: chunks ? chunks.toJSON() : null, spent: [...spent] });
  const share = () => { if (!room || !room.isHost || timer) return; timer = setTimeout(() => { timer = 0; room.setState({ world: snapshot() }); }, 400); };
  const finishNode = (n) => { if (!n || n.gone || n.onUse) return; const w = n.when; n.when = null; n.left = 0; nodes.use(n, { power: 1e9, tool: n.tool, rand: () => 0 }); n.when = w; if (chunks && n.ref && n.ref.key && !n.respawn) chunks.forget(n.ref); };
  if (nodes) nodes.onDeplete((n) => { if (!n.respawn) spent.add(n.id); });
  // apply a change everyone agreed on; `mine` marks the player who asked (they pay and they get the drops)
  const apply = (op, a, mine) => {
    if (op === 'place') { const p = build.place(a.kind, a.x, a.y, { level: a.level, dir: a.dir, free: !mine, inventory: mine ? inventory : undefined }); return p.error ? { error: p.error } : { ok: true, x: p.x, y: p.y }; }
    if (op === 'remove') { const p = build.remove(a.x, a.y, { layer: a.layer, level: a.level, free: !mine, inventory: mine ? inventory : undefined }); return p ? { ok: true, kind: p.kind } : { error: 'nothing there' }; }
    if (op === 'plant') { const c = crops.plant(a.type, a.x, a.y, { inventory: mine ? inventory : undefined }); return c.error ? { error: c.error } : { ok: true }; }
    if (op === 'water') return crops.water(a.x, a.y) ? { ok: true } : { error: 'nothing planted there' };
    if (op === 'use') { let n = nodes.byId(a.id);
      if (!n && a.left == null && a.x != null && chunks && chunks.ensure && host()) { chunks.ensure(a.x, a.y); n = nodes.byId(a.id); }   // a guest far from the host: load that land unseen
      if (!n) return { error: 'gone' }; if (a.left != null) { if (a.done) finishNode(n); else n.left = a.left; return { ok: true }; }
      const own = !!n.onUse, o = { tool: a.tool, power: Math.max(1, Math.min(20, Math.floor(a.power) || 1)) }, r = mine ? nodes.useFor(n, inventory, o) : nodes.use(n, o); if (r.ok && r.done && chunks && n.ref && n.ref.key && !n.respawn) chunks.forget(n.ref); return r.ok ? { ok: true, done: r.done, drops: r.drops, hp: Math.max(0, n.left), left: r.left, local: own } : { error: r.why }; }
    return { error: 'unknown change ' + op };
  };
  const decide = (op, a, from) => {   // host: check and apply, then tell everyone what happened
    let r; try { r = apply(op, a, !from); } catch (e) { r = { error: String(e.message || e) }; }
    if (!r.error && !r.local && room && room.connected) { const out = op === 'use' ? { id: a.id, left: r.hp, done: r.done } : a; room.send({ gcpWorld: 'op', op, a: out, by: from || room.id }); share(); }
    if (!r.error && onChange) onChange({ op, ...a, by: from || (room && room.id) });
    return r;
  };
  // a guest pays and collects on its own device, once the host has said yes (the world itself changes through the 'op' everyone gets)
  const afford = (cost) => { if (!inventory || !cost) return null; const miss = Object.entries(cost).find(([id, n]) => !inventory.has(id, n)); return miss ? `needs ${miss[1]} ${String(miss[0]).replace(/[_-]/g, ' ')}` : null; };
  const before = (op, a) => {
    if (op === 'place') { const d = build && build.defs[a.kind]; if (!d) return 'unknown piece ' + a.kind; return afford(d.cost); }
    if (op === 'plant') { const d = crops && crops.types[a.type]; if (!d) return 'unknown crop ' + a.type; return d.seed ? afford({ [d.seed]: 1 }) : null; }
    return null;
  };
  const settle = (op, a, r) => {
    if (!inventory || r.error) return r;
    if (op === 'place') { const c = build.defs[a.kind].cost; for (const id in c || {}) inventory.remove(id, c[id]); }
    if (op === 'remove' && r.kind) { const c = build.defs[r.kind].cost; for (const id in c || {}) inventory.add(id, Math.ceil(c[id] / 2)); }
    if (op === 'plant') { const d = crops.types[a.type]; if (d.seed) inventory.remove(d.seed, 1); }
    if (op === 'use' && r.done && r.drops) { r.left = {}; for (const id in r.drops) { const k = inventory.add(id, r.drops[id]); if (k) r.left[id] = k; } }
    return r;
  };
  const ask = (op, a) => {
    if (host()) return Promise.resolve(decide(op, a, null));
    const no = before(op, a); if (no) return Promise.resolve({ error: no });
    const id = ++seq; room.send({ gcpWorld: 'ask', id, op, a }, 'host');
    return new Promise((res) => { wait.set(id, { op, a, res }); setTimeout(() => { if (wait.delete(id)) res({ error: 'the host did not answer' }); }, 8000); });
  };
  if (room) {
    room.on('message', (m, from) => {
      if (!m || !m.gcpWorld) return;
      if (m.gcpWorld === 'ask' && room.isHost) room.send({ gcpWorld: 'reply', id: m.id, r: decide(m.op, m.a, from) }, from);
      else if (m.gcpWorld === 'reply') { const w = wait.get(m.id); if (w) { wait.delete(m.id); w.res(settle(w.op, w.a, m.r)); } }
      else if (m.gcpWorld === 'op' && !room.isHost) { apply(m.op, m.a, false); if (onChange) onChange({ op: m.op, ...m.a, by: m.by }); }   // every player's change, our own too
    });
    const take = (st) => { const w = st && st.world; if (!w) return; if (build && w.build && !build.pieces.length) build.load(w.build); if (crops && w.crops && !crops.list.length) crops.load(w.crops); if (chunks && w.chunks) chunks.load(w.chunks); for (const id of w.spent || []) { spent.add(id); finishNode(nodes && nodes.byId(id)); } };
    room.on('open', (o) => { if (!room.isHost) take(o.state); else share(); });
    room.on('state', take);
    room.on('join', () => share());
    if (chunks && nodes) chunks.onLoad(() => { for (const id of spent) finishNode(nodes.byId(id)); });
  }
  const S = { get isHost() { return host(); }, snapshot,
    place: (kind, x, y, o = {}) => ask('place', { kind, x, y, level: o.level, dir: o.dir }),
    remove: (x, y, o = {}) => ask('remove', { x, y, layer: o.layer, level: o.level }),
    use: (node, o = {}) => (node.onUse ? Promise.resolve(nodes.use(node, { tool: o.tool })) : ask('use', { id: node.id, tool: o.tool, power: o.power, x: node.x, y: node.y })),   // a bed or a door works on this device only
    plant: (type, x, y) => ask('plant', { type, x, y }), water: (x, y) => ask('water', { x, y }) };
  return S;
}

/**
 * Rooms that talk to each other inside one page, with the same API as GCP.room (on, send, setState, isHost, id,
 * peers, connected). The first is the host. Use them to prove a shared world works with two players in one
 * play-through: two worlds built from the same seed, one sync on each, and assert they agree.
 *   const [a, b] = createLoopback(2);   const hostSync = createWorldSync(a, {...}), guestSync = createWorldSync(b, {...});
 * Messages arrive on a later tick, as they would over a network; await sync calls, or t.frames(2), before checking.
 */
export function createLoopback(n = 2) {
  const rooms = [], ids = Array.from({ length: n }, (_, i) => 'p' + (i + 1)); let state = null;
  for (let i = 0; i < n; i++) {
    const L = {}, id = ids[i], fire = (ev, ...a) => (L[ev] || []).forEach((f) => f(...a));
    const R = { id, hostId: ids[0], connected: true, state: null, get isHost() { return id === ids[0]; }, get peers() { return ids.filter((x) => x !== id).map((x) => ({ id: x, name: x })); },
      on(ev, f) { (L[ev] ||= []).push(f); return R; }, off(ev, f) { L[ev] = (L[ev] || []).filter((x) => x !== f); return R; }, fire,
      send(data, to) { const copy = JSON.parse(JSON.stringify(data)); setTimeout(() => { for (const r of rooms) if (r !== R && (!to || to === r.id || (to === 'host' && r.isHost))) r.fire('message', copy, id); }, 0); },
      setState(d) { if (!R.isHost) return; state = JSON.parse(JSON.stringify(d)); setTimeout(() => { for (const r of rooms) if (r !== R) { r.state = state; r.fire('state', state); } }, 0); },
      leave() { R.connected = false; } };
    rooms.push(R);
  }
  setTimeout(() => rooms.forEach((r) => r.fire('open', { id: r.id, host: r.isHost, peers: r.peers, state })), 0);
  return rooms;
}

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
// Drawn in the hud's canvas (@gcp/hud.js on @gcp/ui.js), so they are in the frame the platform captures for feedback.
// A game can draw its own panels with the same pieces: hud.window(draw), drawSlot(hud, u, …), itemImage(id, def),
// smallButton(hud, u, …), windowHeading(hud, u, …), windowClose(hud, u, …).

const slotSize = (u, n) => Math.max(30, Math.min(52, (u.w * 0.94) / n - 6));
/**
 * One inventory slot at x, y of size s: the item's icon, its count, an optional key label; on (the held one, raised
 * with the accent border), pick (picked up: a dashed white border), hover.
 */
export function drawSlot(hud, u, inv, i, x, y, s, { label = '', on = false, pick = false, hover = false } = {}) {
  const it = inv.slots[i], c = u.ctx;
  if (on) y -= 4;
  u.panel(x, y, s, s, { fill: hud.slotFill || hud.panel, radius: 11, shadow: on ? { color: 'rgba(0,0,0,.4)', blur: 16, y: 6 } : null });
  if (pick) { c.save(); c.setLineDash([5, 4]); u.panel(x, y, s, s, { stroke: '#fff', line: 2, radius: 11 }); c.restore(); }
  else u.panel(x, y, s, s, { stroke: on ? hud.accent : hover ? 'rgba(255,255,255,.32)' : hud.slotLine || hud.line, line: 2, radius: 11 });
  if (it) { const k = s * 0.74; u.image(itemImage(it.id, inv.def(it.id)), x + (s - k) / 2, y + (s - k) / 2, k, k); if (it.n > 1) u.text(String(it.n), x + s - 4, y + s - 3, { size: 12, weight: 800, align: 'right', base: 'bottom', color: hud.ink, stroke: { color: 'rgba(0,0,0,.85)', width: 2 } }); }
  if (label) u.text(label, x + 5, y + 3, { size: 10, weight: 600, base: 'top', color: hud.ink, alpha: 0.6 });
}
/** A small accent (or ghost) button, as in the backpack: true when pressed. */
export function smallButton(hud, u, id, x, y, label, { ghost = false, disabled = false, w } = {}) {
  const bw = w || u.measure(label, { size: 13, weight: 800 }) + 26;
  return { w: bw, pressed: u.button(id, x, y, bw, 30, label, { fill: ghost ? 'rgba(255,255,255,.14)' : hud.accent, color: ghost ? hud.ink : '#16181c', size: 13, weight: 800, radius: 9, shadow: null, disabled }) && !disabled };
}
let uid = 0;

/**
 * The hotbar: the first slots of the inventory along the bottom, the held one raised. Click or tap selects; with
 * { input } the number keys, the mouse wheel and a gamepad's shoulder buttons select too (call bar.update() every
 * frame). Returns { el, update(), remove() }.
 */
export function hotbarUI(hud, inv, { input, corner: at = 'bc' } = {}) {
  const id = 'hot' + (++uid);
  const item = hud.item(at, {
    measure(u) { const s = slotSize(u, inv.hotbar); return { w: inv.hotbar * s + (inv.hotbar - 1) * 6, h: s + 4 }; },
    draw(u, x, y) { const s = slotSize(u, inv.hotbar); for (let i = 0; i < inv.hotbar; i++) { const sx = x + i * (s + 6), r = u.hit(id + ':' + i, sx, y, s, s + 4, { focusable: false }); if (r.clicked) inv.select(i); drawSlot(hud, u, inv, i, sx, y + 4, s, { label: String((i + 1) % 10), on: i === inv.selected, hover: r.hover }); } },
  });
  return { el: item, update() { if (!input) return; for (let i = 0; i < inv.hotbar; i++) if (input.pressed('Digit' + ((i + 1) % 10))) inv.select(i); if (input.wheel) inv.select(inv.selected + input.wheel); if (input.pressed('Pad4')) inv.select(inv.selected - 1); if (input.pressed('Pad5')) inv.select(inv.selected + 1); }, remove() { item.remove(); } };
}

/** A section heading in a window ("BACKPACK"), with room on its right. */
export const windowHeading = (hud, u, text, x, y) => u.text(text, x, y, { size: 12, weight: 800, upper: true, spacing: 1.2, alpha: 0.65, base: 'top', color: hud.ink });
/** The ✕ that closes a window, its right edge at x: true when pressed. */
export const windowClose = (hud, u, id, x, y) => { const r = u.hit(id, x - 22, y - 4, 26, 24); u.text('✕', x - 9, y + 8, { size: 14, weight: 700, align: 'center', base: 'middle', color: hud.ink, alpha: r.hover || r.focused ? 1 : 0.7 }); return r.clicked; };

/**
 * The inventory window, with a crafting list beside it when you pass { crafting }. Click or tap a slot to pick it
 * up, then another to move or merge; the line under the grid names the picked thing and offers Use (eat, equip,
 * place) and Drop when you pass those. Options: crafting (a createCrafting), stations (() => names of stations near
 * the player), title, onOpen, onClose, onUse(slotIndex, item) (also on a double click), onDrop(slotIndex, item),
 * canUse(item) (which things show the Use button; default: those with food, water, heal or place in their definition).
 * Returns { open(), close(), toggle(), isOpen, refresh() }. Escape closes it.
 */
export function inventoryUI(hud, inv, { crafting, stations, title = 'Backpack', onOpen, onClose, onUse, onDrop, canUse } = {}) {
  const id = 'inv' + (++uid); let W = null, pick = -1, hoverSlot = -1, lastClick = { i: -1, t: 0 };
  const usable = (it) => (canUse ? canUse(it) : !!(it.def.food || it.def.water || it.def.heal || it.def.place)), about = (f) => f.name + (f.about ? ': ' + f.about : f.food ? ': food' : f.tool ? ': a tool' : f.place ? ': place it in the world' : '');
  const lay = (u) => {
    const cols = inv.slots.length > 30 ? 8 : 6, rows = Math.ceil(inv.slots.length / cols), s = Math.min(52, Math.max(28, (Math.min(u.w * 0.96 - 8, 600) - 36 - 12 - (cols - 1) * 6) / cols));
    const gw = cols * s + (cols - 1) * 6, gh = rows * s + (rows - 1) * 6, leftH = 22 + gh + 10 + 34;
    const rw = 290, recH = 52, rh = crafting ? 22 + crafting.recipes.length * recH : 0;
    const side = crafting && gw + rw + 20 + 36 <= u.w * 0.96 - 8;
    const bw = side ? gw + rw + 20 + 36 : Math.max(gw, crafting ? Math.min(rw, u.w * 0.96 - 44) : 0) + 36;
    const inner = side ? Math.max(leftH, Math.min(rh, u.h * 0.7)) : leftH + (crafting ? 20 + rh : 0);
    return { cols, s, gw, gh, rw: side ? rw : bw - 36, rh, recH, side, bw, bh: Math.min(inner + 32, u.h * 0.92 - 8), inner };
  };
  function drawLeft(u, x, y, L) {
    windowHeading(hud, u, title, x, y); if (windowClose(hud, u, id + ':x', x + L.gw, y)) { U.close(); return; }
    let hov = -1;
    inv.slots.forEach((sl, i) => {
      const sx = x + (i % L.cols) * (L.s + 6), sy = y + 22 + Math.floor(i / L.cols) * (L.s + 6), r = u.hit(id + ':s' + i, sx, sy, L.s, L.s, { focusable: false });
      if (r.hover && sl) hov = i;
      if (r.clicked) { const t = performance.now(); if (lastClick.i === i && t - lastClick.t < 380 && sl && onUse) { pick = -1; onUse(i, { ...sl, def: inv.def(sl.id) }); lastClick.i = -1; } else { lastClick = { i, t }; if (pick < 0) { if (sl) pick = i; } else if (pick === i) pick = -1; else { inv.move(pick, i); pick = -1; } } }
      drawSlot(hud, u, inv, i, sx, sy, L.s, { label: i < inv.hotbar ? String((i + 1) % 10) : '', on: i === inv.selected && false, pick: i === pick, hover: r.hover });
      if (i === inv.selected && i !== pick) u.panel(sx, sy, L.s, L.s, { stroke: hud.accent, line: 2, radius: 11 });
    });
    hoverSlot = hov;
    // the line under the grid: what the picked (or hovered) thing is, and what you can do with it
    const iy = y + 22 + L.gh + 10, show = pick >= 0 ? pick : hoverSlot, sl = show >= 0 ? inv.slots[show] : null;
    let bx = x + L.gw;
    if (sl && show === pick) {
      const it = { ...sl, def: inv.def(sl.id) };
      if (onDrop) { const w = u.measure('Drop', { size: 13, weight: 800 }) + 26; bx -= w; if (smallButton(hud, u, id + ':drop', bx, iy + 2, 'Drop', { ghost: true, w }).pressed) { pick = -1; onDrop(show, it); } bx -= 8; }
      if (onUse && usable(it)) { const w = u.measure('Use', { size: 13, weight: 800 }) + 26; bx -= w; if (smallButton(hud, u, id + ':use', bx, iy + 2, 'Use', { w }).pressed) { pick = -1; onUse(show, it); } bx -= 8; }
    }
    u.text(sl ? about(inv.def(sl.id)) : 'Pick a thing up, then choose where it goes.', x, iy + 17, { size: 13, weight: 500, base: 'middle', alpha: 0.85, color: hud.ink, width: Math.max(80, bx - x - 6), lines: 2 });
  }
  function drawCraft(u, x, top, L) {
    const near = stations ? stations() : undefined;
    windowHeading(hud, u, 'Craft', x, top);
    crafting.recipes.forEach((r, k) => {
      const y = top + 22 + k * L.recH, f = inv.def(r.makes), ok = crafting.can(r, near), rh = L.recH - 4;
      const hv = u.hit(id + ':r' + k, x, y, L.rw, rh, { focusable: false, cursor: '' });
      if (hv.hover) u.panel(x, y, L.rw, rh, { fill: 'rgba(255,255,255,.04)', stroke: hud.line, radius: 10 });
      u.alpha(ok ? 1 : 0.62, () => {
        u.image(itemImage(r.makes, f), x + 8, y + (rh - 34) / 2, 34, 34);
        const bw = u.measure('Make', { size: 13, weight: 800 }) + 26, tx = x + 52, tw = L.rw - 52 - bw - 16;
        u.text((r.name || f.name) + (r.n > 1 ? ' × ' + r.n : ''), tx, y + 16, { size: 14, weight: 600, base: 'middle', color: hud.ink, width: tw, lines: 1 });
        let nx = tx; const parts = [];
        for (const nid in r.needs) parts.push([`${Math.min(inv.count(nid), 99)}/${r.needs[nid]} ${inv.def(nid).name.toLowerCase()}`, inv.has(nid, r.needs[nid])]);
        if (r.station) parts.push(['at a ' + nice(r.station).toLowerCase(), !(near && !near.includes(r.station))]);
        for (const [t, have] of parts) { if (nx > tx + tw) break; const m = u.text(t, nx, y + 34, { size: 12, weight: 500, base: 'middle', color: have ? hud.ink : '#ff8a70', alpha: 0.9 }); nx += m.w + 8; }
        if (smallButton(hud, u, id + ':m' + k, x + L.rw - bw - 8, y + (rh - 30) / 2, 'Make', { disabled: !ok, w: bw }).pressed) crafting.make(r, near);
      });
    });
  }
  const U = { get isOpen() { return !!W && W.isOpen; },
    open() { if (U.isOpen) return U; pick = -1;
      W = hud.window((u, x, y, bw, bh) => {
        const L = lay(u), px = x + 18, py = y + 16;
        if (L.side) { drawLeft(u, px, py, L); if (!W || !W.isOpen) return; const cx = px + L.gw + 20, ch = bh - 32; if (L.rh > ch) u.scroll(id + ':cs', cx, py, L.rw, ch, L.rh, (uu, top) => drawCraft(u, cx, top, L), { bar: 'rgba(255,255,255,.3)' }); else drawCraft(u, cx, py, L); }
        else { const ch = bh - 32; u.scroll(id + ':all', px - 4, py, bw - 28, ch, L.inner, (uu, top) => { drawLeft(u, px, top, L); if (crafting && W && W.isOpen) drawCraft(u, px, top + 22 + L.gh + 10 + 34 + 20, L); }, { bar: 'rgba(255,255,255,.3)' }); }
      }, { width: (u) => lay(u).bw, height: (u) => lay(u).bh, onClose: () => { W = null; if (onClose) onClose(); } });
      if (onOpen) onOpen(); return U; },
    close() { if (W) W.close(); return U; },
    toggle() { return U.isOpen ? U.close() : U.open(); }, refresh() { return U; } };
  return U;
}

/** Bars for a createNeeds(), stacked in a corner (default top left). A bar pulses when it is under a quarter. Options: corner, colors ({ food: '#e8a23a' }), labels. */
export function needsUI(hud, needs, { corner: at = 'tl', colors = {}, labels = {} } = {}) {
  const COL = { health: '#e5484d', food: '#e8a23a', water: '#4aa6e8', stamina: '#6ad86a', warmth: '#ff8a4a', energy: '#c8a0ff' }, id = 'needs' + (++uid);
  const name = (k) => labels[k] || needs.defs[k].label || nice(k), col = (k) => colors[k] || needs.defs[k].color || COL[k] || '#c8ccd2';
  const item = hud.item(at, {
    measure(u) { const bw = Math.min(150, u.w * 0.2), lw = Math.max(54, ...needs.keys.map((k) => u.measure(name(k).toUpperCase(), { size: 11, weight: 800, spacing: 0.66 }))); return { w: 22 + lw + 8 + bw, h: 18 + needs.keys.length * 14 + (needs.keys.length - 1) * 5 }; },
    draw(u, x, y, w, h) {
      u.panel(x, y, w, h, { fill: hud.panel, stroke: hud.line, radius: 12, shadow: { color: 'rgba(0,0,0,.25)', blur: 18, y: 4 } });
      const bw = Math.min(150, u.w * 0.2), bx = x + w - 11 - bw;
      needs.keys.forEach((k, i) => { const cy = y + 9 + i * 19 + 7, t = needs.ratio(k), low = t < 0.25, a = low ? 0.45 + 0.55 * (0.5 + 0.5 * Math.cos(u.time * Math.PI / 0.7)) : 1;
        u.text(name(k), x + 11, cy, { size: 11, weight: 800, upper: true, spacing: 0.66, alpha: 0.75, base: 'middle', color: hud.ink });
        u.alpha(a, () => u.bar(bx, cy - 4.5, bw, 9, u.anim(id + k, t, 8), { color: col(k), radius: 5 })); });
    },
  });
  return { el: item, remove() { item.remove(); } };
}

/** The day and the hour of a createClock() as a small panel (default top right). Call ui.update() every frame or so. */
export function clockUI(hud, clock, { corner: at = 'tr' } = {}) {
  const l = hud.label(at, () => [[clock.phase === 'night' ? '☾' : clock.phase === 'day' ? '☀' : '◐', clock.label]]);
  return { el: l.el, update() {}, remove() { l.remove(); } };
}

/**
 * The steps of a createQuests() as a checklist (default top right): the current step bright, the one before it
 * struck out, the next ones dim, and how many are done. Options: corner, title (default 'Quests'), max (lines shown
 * at once, default 4; 0 shows every step).
 */
export function questUI(hud, quests, { corner: at = 'tr', title = 'Quests', max = 4 } = {}) {
  const rows = (u, tw) => { const S = quests.steps, cur = quests.current, i = cur ? S.indexOf(cur) : S.length;
    const from = max ? Math.max(0, Math.min(i - 1, S.length - max)) : 0, to = max ? Math.min(S.length, from + max) : S.length, out = [];
    for (let k = from; k < to; k++) { const s = S[k], lines = u.wrap(s.text, tw - 16, { size: 13, weight: 600 }); out.push({ s, lines, cur: s === cur }); } return out; };
  const item = hud.item(at, {
    measure(u, maxW) { const w = Math.min(260, maxW), rs = rows(u, w - 24); return { w, h: 18 + 17 + rs.reduce((t, r) => t + r.lines.length * 17 + 4, 0) }; },
    draw(u, x, y, w, h) {
      const S = quests.steps, n = S.filter((s) => s.complete).length;
      u.panel(x, y, w, h, { fill: hud.panel, stroke: hud.line, radius: 12, shadow: { color: 'rgba(0,0,0,.25)', blur: 18, y: 4 } });
      const hd = u.text(title + ' ', x + 12, y + 9, { size: 11, weight: 700, upper: true, spacing: 0.9, alpha: 0.7, base: 'top', color: hud.ink });
      u.text(n + ' / ' + S.length, x + 12 + hd.w + 2, y + 9, { size: 11, weight: 800, alpha: 0.7, base: 'top', color: hud.ink });
      let ry = y + 9 + 17 + 4;
      for (const r of rows(u, w - 24)) {
        const a = r.s.complete ? 0.5 : r.cur ? 1 : 0.55;
        u.alpha(a, () => {
          u.text(r.s.complete ? '✔' : r.cur ? '▸' : '·', x + 12, ry, { size: 13, weight: 600, base: 'top', color: hud.ink });
          r.lines.forEach((l, j) => { const m = u.text(l, x + 28, ry + j * 17, { size: 13, weight: 600, base: 'top', color: hud.ink }); if (r.s.complete) u.panel(x + 28, ry + j * 17 + 8, m.w, 1.5, { fill: hud.ink }); });
        });
        ry += r.lines.length * 17 + 4;
      }
    },
  });
  return { el: item, refresh() {}, remove() { item.remove(); } };
}

/**
 * A small map. Options: size (pixels, default 132), range (world units from the centre to the edge, default 40),
 * center (() => ({ x, y })), color ((x, y) => a CSS colour or { r, g, b } in 0..1 for that spot of the world: e.g.
 * land.mapColor from ground2d, or (x, z) => land.colorAt(x, z) from terrain), markers (() => [{ x, y, color }]),
 * corner. It redraws a few times a second by itself. Returns { el, remove() }.
 */
export function minimapUI(hud, { size = 132, range = 40, center, color, markers, corner: at = 'tr', cells = 44 } = {}) {
  const cv = el('canvas'); cv.width = cv.height = cells; const c = cv.getContext('2d', { willReadFrequently: true }), img = c.createImageData(cells, cells);
  const hexOf = new Map(), parse = (v) => { if (typeof v !== 'string') return [Math.sqrt(v.r) * 255, Math.sqrt(v.g) * 255, Math.sqrt(v.b) * 255]; let o = hexOf.get(v); if (!o) { c.fillStyle = v; const h = c.fillStyle; o = [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]; hexOf.set(v, o); } return o; };
  const draw = () => { const p = center ? center() : { x: 0, y: 0 }, d = img.data;
    if (color) { for (let j = 0; j < cells; j++) for (let i = 0; i < cells; i++) { const o = parse(color(p.x + (i / (cells - 1) * 2 - 1) * range, p.y + (j / (cells - 1) * 2 - 1) * range)), k = (j * cells + i) * 4; d[k] = o[0]; d[k + 1] = o[1]; d[k + 2] = o[2]; d[k + 3] = 255; } c.putImageData(img, 0, 0); } else { c.fillStyle = '#1a1d24'; c.fillRect(0, 0, cells, cells); }
    for (const m of markers ? markers() : []) { const x = ((m.x - p.x) / range + 1) / 2 * cells, y = ((m.y - p.y) / range + 1) / 2 * cells; if (x < 0 || y < 0 || x >= cells || y >= cells) continue; c.fillStyle = m.color || '#fff'; c.fillRect(Math.round(x) - 1, Math.round(y) - 1, 2, 2); }
    c.fillStyle = '#fff'; c.fillRect(cells / 2 - 1, cells / 2 - 1, 3, 3); c.fillStyle = '#16181c'; c.fillRect(cells / 2, cells / 2, 1, 1); };
  draw(); const timer = setInterval(draw, 300);
  const item = hud.item(at, {
    measure(u) { const s = Math.min(size, u.w * 0.3); return { w: s, h: s }; },
    draw(u, x, y, w, h) {
      u.panel(x, y, w, h, { fill: '#1a1d24', radius: 12, shadow: { color: 'rgba(0,0,0,.3)', blur: 18, y: 4 } });
      u.clip(x + 2, y + 2, w - 4, h - 4, () => { u.ctx.imageSmoothingEnabled = false; u.ctx.drawImage(cv, x + 2, y + 2, w - 4, h - 4); u.ctx.imageSmoothingEnabled = true; }, { radius: 10 });
      u.panel(x, y, w, h, { stroke: hud.line, line: 2, radius: 12 });
    },
  });
  return { el: item, canvas: cv, refresh: draw, remove() { clearInterval(timer); item.remove(); } };
}

// The platform's Escape rule for everything this kit opens: Esc closes an open window first. A game with a pauseMenu keeps
// Esc for it (the menu offers Quit game in the platform's player); without one, an Esc with nothing open opens the
// platform's menu.
let escRule = false, pauseOwnsEsc = false;
function escapeRule(hud) { if (escRule || !window.GCP || typeof GCP.onEscape !== 'function') return; escRule = true; GCP.onEscape(() => pauseOwnsEsc || hud.windowOpen); }
const inPlayer = () => !!(window.GCP && typeof GCP.quit === 'function' && window.parent !== window);

/** A column of menu rows, centred: [{ h, draw(x, y, w) }] -> total height. */
const stack = (rows, gap = 10) => rows.reduce((t, r) => t + r.h, 0) + gap * Math.max(0, rows.length - 1);
const bigBtn = (hud, u, id, label, x, y, w, onPress) => { if (u.button(id, x, y, w, 46, label, { fill: hud.accent, color: '#16181c', size: 17, weight: 800, radius: 12, shadow: { color: 'rgba(0,0,0,.35)', blur: 22, y: 6 }, family: hud.font })) onPress(); };
const subBtn = (hud, u, id, label, x, y, w, onPress) => { if (u.button(id, x, y, w, 36, label, { fill: hud.panel, color: hud.ink, size: 14, weight: 700, radius: 10, stroke: hud.line, line: 1, shadow: null, hover: 'rgba(40,44,52,.9)', family: hud.font })) onPress(); };
function keyCap(hud, u, k, x, cy) { const w = Math.max(26, u.measure(k, { size: 13, weight: 800 }) + 14); u.panel(x, cy - 13, w, 26, { fill: hud.ink, radius: 7 }); u.text(k, x + w / 2, cy + 0.5, { size: 13, weight: 800, color: '#16181c', align: 'center', base: 'middle' }); return w; }

/**
 * A pause menu on Escape (or P): Resume, the controls, your own buttons, Restart, and Quit game in the platform's player. Options: title, controls ([['WASD',
 * 'Move'], ['E', 'Use']]), buttons ([['Save', fn], ['Sound', fn]]), onPause, onResume, onRestart. Returns { open(), close(), isOpen }.
 */
export function pauseMenu(hud, { title = 'Paused', controls = [], buttons = [], onPause, onResume, onRestart } = {}) {
  escapeRule(hud); pauseOwnsEsc = true; const id = 'pause' + (++uid); let W = null;
  const rows = () => {
    const r = [{ h: 32, draw: (u, x, y, w) => u.text(title, x + w / 2, y + 16, { size: 26, weight: 800, align: 'center', base: 'middle', color: hud.titleColor || hud.ink, family: hud.titleFont, shadow: hud.titleShadow, width: w, lines: 1 }) }];
    r.push({ h: 46, draw: (u, x, y, w) => bigBtn(hud, u, id + ':resume', 'Resume', x, y, w, () => M.close()) });
    if (controls.length) r.push({ h: controls.length * 32, draw: (u, x, y, w) => { const kw = Math.max(...controls.map(([k]) => Math.max(26, u.measure(k, { size: 13, weight: 800 }) + 14))), tw = Math.max(...controls.map(([, t]) => u.measure(t, { size: 13, weight: 500 }))), sx = x + (w - kw - 12 - tw) / 2;
      controls.forEach(([k, t], i) => { const cy = y + i * 32 + 16; keyCap(hud, u, k, sx, cy); u.text(t, sx + kw + 12, cy, { size: 13, weight: 500, base: 'middle', color: hud.ink, alpha: 0.85 }); }); } });
    buttons.forEach(([label, fn], i) => r.push({ h: 36, draw: (u, x, y, w) => subBtn(hud, u, id + ':b' + i, label, x, y, w, fn) }));
    if (onRestart) r.push({ h: 36, draw: (u, x, y, w) => subBtn(hud, u, id + ':restart', 'Restart', x, y, w, () => { M.close(); onRestart(); }) });
    if (inPlayer()) r.push({ h: 36, draw: (u, x, y, w) => subBtn(hud, u, id + ':quit', 'Quit game', x, y, w, () => GCP.quit()) });
    return r;
  };
  const M = { get isOpen() { return !!W && W.isOpen; },
    open() { if (M.isOpen || hud.screenOpen || hud.windowOpen) return M;
      const width = (u) => Math.max(276, ...controls.map(([k, t]) => u.measure(k, { size: 13, weight: 800 }) + u.measure(t, { size: 13 }) + 80));
      W = hud.window((u, x, y, bw, bh) => { const rs = rows(); let ry = y + 18; u.nav = true; for (const r of rs) { r.draw(u, x + 18, ry, bw - 36); ry += r.h + 10; } },
        { width, height: () => stack(rows()) + 36, escape: false, closeOnBackdrop: false, onClose: () => { hud.ui.nav = false; W = null; if (onResume) onResume(); } });
      if (onPause) onPause(); return M; },
    close() { if (W) W.close(); return M; } };
  addEventListener('keydown', (e) => { if (e.target && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return; if (e.code === 'Escape' || e.code === 'KeyP') { if (M.isOpen) M.close(); else if (!hud.windowOpen) M.open(); } });
  return M;
}

/**
 * The start screen of a multiplayer game: Host a room (a short code to share is made for you), Join one by its code,
 * or Play alone. Resolves with { mode: 'host' | 'join' | 'solo', code }; open the room with it:
 *   const lobby = lobbyUI(hud, { title: 'Wildstead' });  GCP.test.onAutostart(() => lobby.solo());
 *   const { mode, code } = await lobby;   // lobby.solo(), lobby.host(code), lobby.join(code) settle it from code
 *   const room = mode === 'solo' ? null : GCP.room(code);        // or joinSession(code, …) from @gcp/net.js
 * Options: title, subtitle, solo (false hides Play alone), codeLength (default 4), code (prefilled, e.g. from GCP.test.param('room')),
 * hint (a small line under the buttons, e.g. the controls: 'WASD move · E use · F place').
 * A link that carries ?room=CODE fills the code in, so a host can share the page address with it.
 * The code box is the one page element: a text field (the platform contract allows them), placed over the canvas.
 */
export function lobbyUI(hud, { title = '', subtitle = 'Play together', solo = true, codeLength = 4, code = '', hint = '' } = {}) {
  const make = () => Array.from({ length: codeLength }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ'[(Math.random() * 24) | 0]).join(''), id = 'lobby' + (++uid);
  let api = null; const out = new Promise((res) => {
    let err = '', W = null, settled = false;
    const inp = el('input'); inp.placeholder = 'ROOM CODE'; inp.maxLength = 8; inp.autocapitalize = 'characters'; inp.spellcheck = false; inp.autocomplete = 'off'; inp.setAttribute('aria-label', 'Room code');
    inp.value = code || new URLSearchParams(location.search).get('room') || '';
    inp.style.cssText = `position:fixed;z-index:45;box-sizing:border-box;margin:0;border:1px solid ${hud.line};border-radius:9px;background:rgba(255,255,255,.08);color:${hud.ink};font:800 16px system-ui,sans-serif;letter-spacing:.18em;text-align:center;padding:0 8px;text-transform:uppercase;outline:none;-webkit-user-select:text;user-select:text;display:none`;
    D.body.appendChild(inp);
    const done = (mode, c) => { if (settled) return; settled = true; inp.remove(); if (W) W.close(); res({ mode, code: c }); }, clean = () => inp.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
    const join = () => { const c = clean(); if (c.length < 2) { err = 'Type the code the host shared'; inp.focus(); return; } done('join', c); };
    inp.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.code === 'Enter') join(); });
    const rows = (u, w) => {
      const r = [];
      if (title) r.push({ h: 32, draw: (x, y) => u.text(title, x + w / 2, y + 16, { size: 26, weight: 800, align: 'center', base: 'middle', color: hud.titleColor || hud.ink, family: hud.titleFont, shadow: hud.titleShadow, width: w, lines: 1 }) });
      if (subtitle) { const n = Math.min(3, u.wrap(subtitle, w, { size: 13, weight: 500 }).length); r.push({ h: n * 17, draw: (x, y) => u.text(subtitle, x + w / 2, y, { size: 13, weight: 500, align: 'center', base: 'top', color: hud.ink, alpha: 0.8, width: w, lines: 3 }) }); }
      r.push({ h: 46, draw: (x, y) => bigBtn(hud, u, id + ':host', 'Host a room', x, y, w, () => done('host', make())) });
      r.push({ h: 36, draw: (x, y) => { const jw = u.measure('Join', { size: 13, weight: 800 }) + 26, fw = w - jw - 8; Object.assign(inp.style, { display: 'block', left: x + 'px', top: y + 'px', width: fw + 'px', height: '36px' }); if (smallButton(hud, u, id + ':join', x + fw + 8, y + 3, 'Join', { w: jw }).pressed) join(); } });
      if (err) r.push({ h: 16, draw: (x, y) => u.text(err, x + w / 2, y + 8, { size: 13, weight: 600, align: 'center', base: 'middle', color: '#ff8a70' }) });
      if (solo) r.push({ h: 36, draw: (x, y) => subBtn(hud, u, id + ':solo', 'Play alone', x, y, w, () => done('solo', '')) });
      if (hint) { const ls = u.wrap(hint, w, { size: 12, weight: 500 }); r.push({ h: ls.length * 16, draw: (x, y) => u.text(hint, x + w / 2, y, { size: 12, weight: 500, align: 'center', base: 'top', color: hud.ink, alpha: 0.7, width: w, lineHeight: 1.33 }) }); }
      return r;
    };
    const width = (u) => Math.min(340, u.w * 0.9);
    W = hud.window((u, x, y, bw) => { let ry = y + 18; for (const r of rows(u, bw - 36)) { r.draw(x + 18, ry); ry += r.h + 10; } }, { width, height: (u) => stack(rows(u, width(u) - 36)) + 36, escape: false, closeOnBackdrop: false, onClose: () => { inp.style.display = 'none'; } });
    api = { solo: () => done('solo', ''), host: (c) => done('host', c || make()), join: (c) => done('join', String(c).toUpperCase()) };
  });
  // the promise can also be settled from code, e.g. GCP.test.onAutostart(() => lobby.solo())
  return Object.assign(out, { solo: () => api.solo(), host: (c) => api.host(c), join: (c) => api.join(c) });
}
