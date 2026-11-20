// On-screen controls for touch screens: which keys a game is played with, so the platform can give phones and tablets a
// stick and buttons that press those keys for the player. One module, no imports, shared by the Worker (detected at
// deploy and stored with each version, or the first time an older version's page is opened), the web app (handed to the
// game through the player) and the tests. The SDK (web/public/sdk/gcp.js) draws the controls and presses the keys.
//
//   detected   the platform reads the game's own code (never libraries) for the keys it checks: WASD and the arrow keys
//              become a stick, other keys (Space, Enter, Shift, E…) become buttons, most important first.
//   declared   gcp.json "controls" overrides it: { "touch": "auto" | "overlay" | "none", "stick": "wasd" | "arrows" |
//              "both" | "none", "buttons": [{ "key": "Space", "label": "Jump" }, …] }.
//   show       whether the controls appear by themselves on a touch screen: when the creator asked for them, or when the
//              game has keys to press and no touch controls of its own. Players can still hide or show them in the game menu.

export type Stick = 'wasd' | 'arrows' | 'both';
export interface TouchButton { code: string; key: string; keyCode: number; label: string }
export interface TouchControls {
  v: 1;
  source: 'declared' | 'detected';
  mode: 'auto' | 'overlay' | 'none';
  show: boolean;                    // appear by themselves on touch screens
  stick: Stick | null;
  buttons: TouchButton[];           // at most MAX_BUTTONS, most important first
  gamepad: boolean;                 // the game reads gamepads but no keys were found: the controls act as a gamepad instead
  own_touch: boolean;               // the code shows touch controls of its own
  evidence: string;                 // why, in a few words
}
export interface ControlsIssue { level: 'error' | 'warning'; field: string; message: string; hint?: string }

export const MAX_BUTTONS = 6;

/** Every key a button can press, by its KeyboardEvent.code, with the key value and legacy keyCode a game may read instead. */
const KEYS: Record<string, [key: string, keyCode: number, label: string]> = {
  Space: [' ', 32, 'Space'], Enter: ['Enter', 13, 'Enter'], ShiftLeft: ['Shift', 16, 'Shift'], ShiftRight: ['Shift', 16, 'Shift'],
  ControlLeft: ['Control', 17, 'Ctrl'], AltLeft: ['Alt', 18, 'Alt'], Tab: ['Tab', 9, 'Tab'], Backspace: ['Backspace', 8, '⌫'], Escape: ['Escape', 27, 'Esc'],
  ArrowUp: ['ArrowUp', 38, '↑'], ArrowDown: ['ArrowDown', 40, '↓'], ArrowLeft: ['ArrowLeft', 37, '←'], ArrowRight: ['ArrowRight', 39, '→'],
};
for (let c = 65; c <= 90; c++) { const l = String.fromCharCode(c); KEYS['Key' + l] = [l.toLowerCase(), c, l]; }
for (let d = 0; d <= 9; d++) KEYS['Digit' + d] = [String(d), 48 + d, String(d)];
export const KEY_CODES = Object.keys(KEYS);

/** The KeyboardEvent fields for a code (what the SDK puts on the events it fires). */
export function keyInfo(code: string, label?: string): TouchButton | null {
  const k = KEYS[code]; if (!k) return null;
  return { code, key: k[0], keyCode: k[1], label: (label || k[2]).slice(0, 12) };
}

// Which keys the buttons get, most important first. Keys the platform keeps (Escape opens its menu) and the movement keys
// the stick already presses never get a button; modifiers come last, since they are rarely an action of their own.
const PRIORITY = ['Space', 'Enter', 'ShiftLeft', 'KeyE', 'KeyF', 'KeyJ', 'KeyK', 'KeyZ', 'KeyX', 'KeyC', 'KeyQ', 'KeyR', 'KeyV', 'KeyL', 'KeyI', 'KeyU',
  'Digit1', 'Digit2', 'Digit3', 'Digit4', 'KeyG', 'KeyH', 'KeyT', 'KeyB', 'KeyN', 'KeyO', 'KeyY', 'Tab', 'KeyP', 'KeyM', 'ControlLeft', 'AltLeft'];
const NEVER = new Set(['Escape', 'ShiftRight', 'Backspace']);
const WASD = ['KeyW', 'KeyA', 'KeyS', 'KeyD'], ARROWS = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];

/** A library or an engine's own file, not the game's code: its key tables say nothing about this game. */
export const LIBRARY_PATH = /(^|\/)(vendor|vendors|lib|libs|third[-_]?party|node_modules|external|deps)\/|\.min\.m?js$|(^|\/)(three|pixi|phaser|babylon|playcanvas|howler|tone|matter|cannon|ammo|rapier|p5|kaboom|excalibur|melonjs|gsap|lodash|react|vue)[\w.-]*\.m?js$/i;

// Key names as the code compares them. A code string ('KeyW', "ArrowUp", `Space`) is specific enough anywhere; a bare key
// value ('w', ' ') only counts beside .key, a keyCode only beside keyCode or which.
const CODE_RX = /["'`](Key[A-Z]|Digit[0-9]|Arrow(?:Up|Down|Left|Right)|Space|Enter|NumpadEnter|Shift(?:Left|Right)|Control(?:Left|Right)|Alt(?:Left|Right)|Tab|Escape)["'`]/g;
// keys.KeyW, held.ArrowUp: a code read as a property, in a file that listens for keys
const PROP_RX = /[\w\]]\.(Key[A-Z]|Digit[0-9]|Arrow(?:Up|Down|Left|Right)|Space|ShiftLeft|ShiftRight)\b/g;
// { KeyW: 'up', ArrowUp: 'up' }: a code as an object key
const OBJKEY_RX = /[{,]\s*(Key[A-Z]|Digit[0-9]|Arrow(?:Up|Down|Left|Right)|Space|Enter|ShiftLeft|ShiftRight)\s*:/g;
const KEYVAL_RX = /\.key\s*(?:\.toLowerCase\(\)\s*|\.toUpperCase\(\)\s*)?(?:===?|!==?)\s*["'`]([A-Za-z0-9 ]|Shift|Enter|Tab|Escape|Esc|Spacebar|Up|Down|Left|Right)["'`]/g;
const KEYCASE_RX = /\bcase\s+["'`]([A-Za-z0-9 ])["'`]\s*:/g;
const KEYMAP_RX = /[{,]\s*["'`]?([a-zA-Z])["'`]?\s*:\s*\[?\s*["'`]?(?:up|down|left|right|jump|fire|shoot|attack|dash|interact|use|action)/gi;
const KEYCODE_RX = /\b(?:keyCode|which)\s*(?:===?|!==?)\s*(\d{1,3})\b/g;
const KEYCODE_CASE_RX = /\bcase\s+(\d{1,3})\s*:/g;
// Touch controls of the game's own: touch events, a check for a finger, or the platform's own hint that the screen is touch.
const OWN_TOUCH_RX = /["']touch(?:start|end|move)["']|\bontouchstart\b|pointerType\s*[!=]==?\s*["']touch["']|["']touch["']\s*[!=]==?\s*\w+\.pointerType|\(\s*pointer\s*:\s*coarse\s*\)|maxTouchPoints|\bdisplay\.touch\b|\bGCP\.display\b[^;]{0,40}\btouch\b|\.(?:activePointer|pointer1)\b|(?:@gcp\/|\/kits\/v\d+\/)(?:input|craft|craft2d)\.js/;
const GAMEPAD_RX = /getGamepads\s*\(|["']gamepadconnected["']/;
const KEYBOARD_RX = /["'](?:keydown|keyup|keypress)["']|\bonkey(?:down|up|press)\b/;

const VAL_TO_CODE: Record<string, string> = { ' ': 'Space', Spacebar: 'Space', Enter: 'Enter', Shift: 'ShiftLeft', Tab: 'Tab', Escape: 'Escape', Esc: 'Escape', Up: 'ArrowUp', Down: 'ArrowDown', Left: 'ArrowLeft', Right: 'ArrowRight' };
const valueToCode = (v: string) => VAL_TO_CODE[v] ?? (/^[a-z]$/i.test(v) ? 'Key' + v.toUpperCase() : /^\d$/.test(v) ? 'Digit' + v : null);
const KEYCODE_TO_CODE: Record<number, string> = { 32: 'Space', 13: 'Enter', 16: 'ShiftLeft', 17: 'ControlLeft', 18: 'AltLeft', 9: 'Tab', 27: 'Escape', 37: 'ArrowLeft', 38: 'ArrowUp', 39: 'ArrowRight', 40: 'ArrowDown' };
for (let c = 65; c <= 90; c++) KEYCODE_TO_CODE[c] = 'Key' + String.fromCharCode(c);
for (let d = 0; d <= 9; d++) KEYCODE_TO_CODE[48 + d] = 'Digit' + d;

export interface ControlsInput { texts: Map<string, string> | Record<string, string>; declared?: unknown; declaredInput?: string[] | null }

/** The keys a bundle's own code checks, by code, in the order of how often they appear. */
export function detectKeys(texts: Map<string, string> | Record<string, string>): { keys: string[]; files: string[] } {
  const map = texts instanceof Map ? texts : new Map(Object.entries(texts));
  const count = new Map<string, number>(), files: string[] = [];
  const bump = (code: string | null | undefined) => { if (code && KEYS[code]) count.set(code, (count.get(code) || 0) + 1); };
  for (const [f, src] of map) {
    if (f.startsWith('server/') || !/\.(m?js|html?)$/i.test(f) || LIBRARY_PATH.test(f) || src.length > 3_000_000) continue;
    if (!KEYBOARD_RX.test(src) && !/\.(?:code|key|keyCode)\b/.test(src)) continue;
    const before = count.size;
    if (KEYBOARD_RX.test(src)) { for (const m of src.matchAll(PROP_RX)) bump(m[1]); for (const m of src.matchAll(OBJKEY_RX)) bump(m[1]); }
    for (const m of src.matchAll(CODE_RX)) bump(m[1] === 'NumpadEnter' ? 'Enter' : m[1] === 'ControlRight' ? 'ControlLeft' : m[1] === 'AltRight' ? 'AltLeft' : m[1]);
    if (/\.key\b/.test(src)) {
      for (const m of src.matchAll(KEYVAL_RX)) bump(valueToCode(m[1]));
      for (const m of src.matchAll(KEYCASE_RX)) bump(valueToCode(m[1]));
      for (const m of src.matchAll(KEYMAP_RX)) bump(valueToCode(m[1]));
    }
    if (/\b(?:keyCode|which)\b/.test(src)) {
      for (const m of src.matchAll(KEYCODE_RX)) bump(KEYCODE_TO_CODE[+m[1]]);
      if (/switch\s*\(\s*[\w.]*\b(?:keyCode|which)\s*\)/.test(src)) for (const m of src.matchAll(KEYCODE_CASE_RX)) bump(KEYCODE_TO_CODE[+m[1]]);
    }
    if (count.size > before || [...src.matchAll(CODE_RX)].length) files.push(f);
  }
  const keys = [...count.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
  return { keys, files };
}

/** The layout for a set of keys: a stick for WASD and/or the arrows, buttons for the rest, most important first. */
export function layoutFor(keys: string[]): { stick: Stick | null; buttons: TouchButton[] } {
  const has = (k: string) => keys.includes(k);
  const wasd = WASD.every(has), arrows = ARROWS.every(has);
  const stick: Stick | null = wasd && arrows ? 'both' : wasd ? 'wasd' : arrows ? 'arrows' : null;
  const moving = new Set(stick === 'both' ? [...WASD, ...ARROWS] : stick === 'wasd' ? WASD : stick === 'arrows' ? ARROWS : []);
  const rest = keys.filter((k) => !moving.has(k) && !NEVER.has(k) && !(stick && ARROWS.includes(k)));
  // Arrows without a stick (a game that only uses left and right, say) are buttons too, after the actions.
  const ranked = [...PRIORITY.filter((k) => rest.includes(k)), ...rest.filter((k) => !PRIORITY.includes(k) && !ARROWS.includes(k)), ...ARROWS.filter((k) => rest.includes(k))];
  return { stick, buttons: ranked.slice(0, MAX_BUTTONS).map((k) => keyInfo(k)!).filter(Boolean) };
}

/** Reads gcp.json "controls". Returns what it understood (null: nothing declared) and what was wrong. */
export function parseControls(raw: unknown): { value: { mode: TouchControls['mode']; stick?: Stick | null; buttons?: TouchButton[] } | null; issues: ControlsIssue[] } {
  const issues: ControlsIssue[] = [];
  if (raw == null) return { value: null, issues };
  if (typeof raw === 'string') raw = { touch: raw };
  if (typeof raw !== 'object' || Array.isArray(raw)) { issues.push({ level: 'error', field: 'controls', message: 'controls must be an object.', hint: 'Example: {"touch": "overlay", "stick": "wasd", "buttons": [{"key": "Space", "label": "Jump"}]}' }); return { value: null, issues }; }
  const r = raw as Record<string, unknown>;
  const known = ['touch', 'stick', 'buttons'];
  for (const k of Object.keys(r)) if (!known.includes(k)) issues.push({ level: 'warning', field: 'controls', message: `Unknown field "${k}" in controls.`, hint: `Known fields: ${known.join(', ')}.` });
  const modeRaw = String(r.touch ?? 'auto').toLowerCase();
  const mode = (['auto', 'overlay', 'none'] as const).find((m) => m === modeRaw) ?? (modeRaw === 'own' || modeRaw === 'off' || modeRaw === 'false' ? 'none' : modeRaw === 'on' || modeRaw === 'true' ? 'overlay' : null);
  if (!mode) issues.push({ level: 'error', field: 'controls.touch', message: `controls.touch must be "auto", "overlay" or "none", not "${modeRaw}".`, hint: '"none" when the game has touch controls of its own, "overlay" to always offer the platform\'s stick and buttons on touch screens.' });
  const out: { mode: TouchControls['mode']; stick?: Stick | null; buttons?: TouchButton[] } = { mode: mode ?? 'auto' };
  if (r.stick !== undefined) {
    const s = String(r.stick).toLowerCase();
    if (s === 'none' || s === 'false' || r.stick === null) out.stick = null;
    else if (s === 'wasd' || s === 'arrows' || s === 'both') out.stick = s;
    else issues.push({ level: 'error', field: 'controls.stick', message: `controls.stick must be "wasd", "arrows", "both" or "none", not "${s}".` });
  }
  if (r.buttons !== undefined) {
    if (!Array.isArray(r.buttons)) issues.push({ level: 'error', field: 'controls.buttons', message: 'controls.buttons must be a list.', hint: 'Example: [{"key": "Space", "label": "Jump"}, {"key": "KeyE", "label": "Use"}]' });
    else {
      const got: TouchButton[] = [];
      for (const b of r.buttons) {
        const o = (typeof b === 'string' ? { key: b } : b) as { key?: unknown; label?: unknown } | null;
        const name = String(o?.key ?? '');
        const code = KEYS[name] ? name : valueToCode(name) ?? (KEYS['Key' + name.toUpperCase()] ? 'Key' + name.toUpperCase() : null);
        if (!code) { issues.push({ level: 'error', field: 'controls.buttons', message: `Unknown key "${name}".`, hint: 'Name keys by KeyboardEvent.code: Space, Enter, ShiftLeft, KeyE, Digit1, ArrowUp…' }); continue; }
        if (code === 'Escape') { issues.push({ level: 'warning', field: 'controls.buttons', message: 'Escape is left out: the platform\'s menu button already sends it.' }); continue; }
        const info = keyInfo(code, typeof o?.label === 'string' && o.label.trim() ? o.label.trim() : undefined);
        if (info && !got.some((g) => g.code === code)) got.push(info);
      }
      if (got.length > MAX_BUTTONS) issues.push({ level: 'warning', field: 'controls.buttons', message: `Only the first ${MAX_BUTTONS} buttons are shown.` });
      out.buttons = got.slice(0, MAX_BUTTONS);
    }
  }
  return { value: out, issues };
}

/** The controls record stored with a version: the declaration (if any) laid over what the code shows. */
export function buildControls(input: ControlsInput): { controls: TouchControls; issues: ControlsIssue[] } {
  const map = input.texts instanceof Map ? input.texts : new Map(Object.entries(input.texts));
  const { value: decl, issues } = parseControls(input.declared);
  const own = [...map].find(([f, s]) => !f.startsWith('server/') && !LIBRARY_PATH.test(f) && /\.(m?js|html?)$/i.test(f) && OWN_TOUCH_RX.test(s));
  const pads = [...map].some(([f, s]) => !f.startsWith('server/') && /\.(m?js|html?)$/i.test(f) && GAMEPAD_RX.test(s));
  const { keys, files } = detectKeys(map);
  const auto = layoutFor(keys);
  const stick = decl && decl.stick !== undefined ? decl.stick : auto.stick;
  const buttons = decl && decl.buttons !== undefined ? decl.buttons : auto.buttons;
  const any = !!stick || buttons.length > 0;
  const gamepad = !any && pads && !own;
  const declaredTouch = !!input.declaredInput?.includes('touch');
  const mode = decl?.mode ?? 'auto';
  const show = mode === 'overlay' ? (any || gamepad) : mode === 'none' ? false : (any || gamepad) && !own && !declaredTouch;
  const why = decl ? 'declared in gcp.json controls'
    : own ? `the game has touch controls of its own (${own[0]})`
    : declaredTouch ? 'requirements.input lists touch'
    : any ? `keys found in ${files.slice(0, 3).join(', ')}` : gamepad ? 'the game reads gamepads' : 'no keys found in the game\'s code';
  return {
    controls: { v: 1, source: decl ? 'declared' : 'detected', mode, show, stick: stick ?? null, buttons: gamepad ? padButtons() : buttons, gamepad, own_touch: !!own, evidence: why },
    issues,
  };
}

/** The four face buttons a gamepad-only game gets (A, B, X, Y in the standard layout). */
function padButtons(): TouchButton[] { return ['A', 'B', 'X', 'Y'].map((l, i) => ({ code: 'Pad' + i, key: '', keyCode: 0, label: l })); }

/** Checks a record handed to the player (from the API) before the SDK trusts it; anything odd is dropped. */
export function sanitizeControls(c: unknown): TouchControls | null {
  if (!c || typeof c !== 'object') return null;
  const o = c as Partial<TouchControls>;
  if (o.v !== 1) return null;
  const buttons = Array.isArray(o.buttons) ? o.buttons.slice(0, MAX_BUTTONS).map((b) => (b && /^Pad[0-3]$/.test(String(b.code)) ? { code: String(b.code), key: '', keyCode: 0, label: String(b.label || '').slice(0, 12) } : keyInfo(String(b?.code), typeof b?.label === 'string' ? b.label : undefined))).filter(Boolean) as TouchButton[] : [];
  const stick = o.stick === 'wasd' || o.stick === 'arrows' || o.stick === 'both' ? o.stick : null;
  return { v: 1, source: o.source === 'declared' ? 'declared' : 'detected', mode: o.mode === 'overlay' || o.mode === 'none' ? o.mode : 'auto', show: !!o.show, stick, buttons, gamepad: !!o.gamepad, own_touch: !!o.own_touch, evidence: String(o.evidence || '').slice(0, 200) };
}
