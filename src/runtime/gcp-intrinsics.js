// Evaluated before the game's own server modules (game-worker.js imports it first), so it captures the built-ins the
// runtime needs while nothing has been able to replace them yet. The game's server code shares this isolate: it may
// patch globalThis.fetch, TextEncoder, crypto.subtle, JSON, Object.prototype and the rest, but the runtime keeps using
// these originals. Every function is captured here, at load time, never looked up again when it is called: a wrapper
// that read `subtle.importKey` at call time would hand the key bytes to whatever the game put there.
//
// This is defence in depth, not the boundary. The boundary is that a game Worker holds nothing that reaches beyond its
// own game (no shared bucket binding, keys derived for this game only), so even a runtime that leaked its whole env
// would only give the game's code what its creator already controls.
const subtle = crypto.subtle;
const encodeFn = TextEncoder.prototype.encode, decodeFn = TextDecoder.prototype.decode;
const enc = new TextEncoder(), dec = new TextDecoder();
const realFetch = globalThis.fetch, realAtob = globalThis.atob, realBtoa = globalThis.btoa;
const importKeyFn = subtle.importKey, signFn = subtle.sign, verifyFn = subtle.verify;
const parseFn = JSON.parse, stringifyFn = JSON.stringify;
const keysFn = Object.keys, createFn = Object.create, hasOwnFn = Object.prototype.hasOwnProperty;
const apply = Reflect.apply;
export const I = Object.freeze({
  encode: (s) => apply(encodeFn, enc, [s]),
  decode: (b) => apply(decodeFn, dec, [b]),
  importKey: (...a) => apply(importKeyFn, subtle, a),
  sign: (...a) => apply(signFn, subtle, a),
  verify: (...a) => apply(verifyFn, subtle, a),
  fetch: (...a) => apply(realFetch, globalThis, a),
  // workerd built-ins refuse to run with the wrong `this`, so each one is called on the object it came from
  atob: (s) => apply(realAtob, globalThis, [s]), btoa: (s) => apply(realBtoa, globalThis, [s]),
  parse: (t) => apply(parseFn, JSON, [t]), stringify: (v) => apply(stringifyFn, JSON, [v]),
  hasOwn: (o, k) => o != null && apply(hasOwnFn, o, [k]),
  /** A copy of an object's own properties on an object with no prototype. Reading a property the copy does not have
      gives undefined, instead of running a getter the game's code put on Object.prototype with `this` set to it. */
  own: (o) => {
    const out = apply(createFn, Object, [null]);
    if (o == null) return out;
    const ks = apply(keysFn, Object, [o]);
    for (let i = 0; i < ks.length; i++) out[ks[i]] = o[ks[i]];
    return out;
  },
});
