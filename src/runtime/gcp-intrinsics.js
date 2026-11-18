// Evaluated before the game's own server modules (game-worker.js imports it first), so it captures the built-ins the
// runtime needs while nothing has been able to replace them yet. The game's server code shares this isolate: it may
// patch globalThis.fetch, TextEncoder, crypto.subtle and the rest, but the runtime keeps using these originals, so the
// play key and the store key never pass through code the game controls.
const subtle = crypto.subtle;
const encodeFn = TextEncoder.prototype.encode, decodeFn = TextDecoder.prototype.decode;
const enc = new TextEncoder(), dec = new TextDecoder();
const realFetch = globalThis.fetch, realAtob = globalThis.atob, realBtoa = globalThis.btoa;
const apply = Reflect.apply;
export const I = Object.freeze({
  encode: (s) => apply(encodeFn, enc, [s]),
  decode: (b) => apply(decodeFn, dec, [b]),
  importKey: (...a) => apply(subtle.importKey, subtle, a),
  sign: (...a) => apply(subtle.sign, subtle, a),
  verify: (...a) => apply(subtle.verify, subtle, a),
  fetch: (...a) => apply(realFetch, globalThis, a),
  // workerd built-ins refuse to run with the wrong `this`, so each one is called on the object it came from
  atob: (s) => apply(realAtob, globalThis, [s]), btoa: (s) => apply(realBtoa, globalThis, [s]),
  parse: (t) => apply(JSON.parse, JSON, [t]), stringify: (v) => apply(JSON.stringify, JSON, [v]),
});
