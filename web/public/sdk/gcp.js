/* HearthCade SDK. The platform injects this script at the top of every game document, before any
   game code runs, so `GCP` is always defined. Nothing here draws or decides how a game looks or plays.

   The contract (the only hard rules):
     GCP.ready()            call once, when the first playable frame is on screen
     GCP.progress(f, label) optional, 0..1 while loading (again after ready() while a world or level loads)
     GCP.fatal(err)         call if the game cannot start (also set automatically by nothing: uncaught
                            errors are recorded, not fatal, unless they stop frames from advancing)
   Everything else is optional help: saves, leaderboards, rooms, test hooks. */
(function () {
  'use strict';
  var cfg = window.__GCP_CONFIG || null;
  // the config carries the player's play token: keep it inside the SDK, out of reach of the page's own scripts
  try { delete window.__GCP_CONFIG; } catch (e) { window.__GCP_CONFIG = undefined; }
  try { var cs = document.currentScript, prev = cs && cs.previousElementSibling; if (prev && prev.tagName === 'SCRIPT' && prev.textContent.indexOf('__GCP_CONFIG') >= 0) prev.remove(); } catch (e) { /* not in a document */ }
  var standalone = !cfg;           // opened outside the platform (local file / local dev server)
  if (standalone) cfg = { api: '', token: '', gameId: 'local', version: 0, env: 'local', base: '', player: { id: 'local', name: 'Player' }, kind: 'owner', session: 'local' };
  var q = new URLSearchParams(location.search);
  var S = window.__GCP = { boot: performance.now(), ready: false, readyAt: 0, frames: 0, fatal: null, errors: [], warnings: [], progress: 0, label: '', missing: [], stats: null };

  // Keep the play token out of the address bar (the game Worker also set it as a cookie).
  if (q.has('gcp_t')) { try { q.delete('gcp_t'); history.replaceState(null, '', location.pathname + (q.toString() ? '?' + q : '') + location.hash); } catch (e) { /* sandboxed */ } }

  function note(list, msg) { msg = String(msg).slice(0, 500); if (list.length < 25 && list.indexOf(msg) < 0) list.push(msg); pending.push(msg); }
  var pending = [];
  window.addEventListener('error', function (e) {
    if (e.target && e.target !== window && (e.target.src || e.target.href)) { var u = e.target.src || e.target.href; if (S.missing.length < 25) S.missing.push(String(u).slice(0, 300)); return; }
    note(S.errors, (e.message || 'Error') + (e.filename ? ' @ ' + String(e.filename).split('/').pop() + ':' + e.lineno + ':' + e.colno : ''));
  }, true);
  window.addEventListener('unhandledrejection', function (e) { var r = e.reason; note(S.errors, 'Unhandled promise rejection: ' + (r && (r.stack || r.message) || r)); });
  var cerr = console.error;
  console.error = function () { try { if (S.warnings.length < 25) S.warnings.push(Array.prototype.map.call(arguments, function (a) { return a && a.stack ? a.stack : typeof a === 'object' ? JSON.stringify(a) : String(a); }).join(' ').slice(0, 500)); } catch (e) { /* cyclic */ } return cerr.apply(console, arguments); };

  // ---- probes for the craft review. Only under verification (?gcp_autostart) or ?gcp_probe: players never pay for them. ----
  // They count what the page draws, plays and listens to, for any engine, without the game doing anything.
  var P = S.probe = { on: q.has('gcp_autostart') || q.has('gcp_probe'), gl: null, c2d: null, audio: { contexts: 0, starts: 0 }, listeners: {}, progress: 0, services: {} };
  var frameHooks = [], glRef = null;
  if (P.on) (function () {
    function hookGL(gl) {
      glRef = gl;
      var G = P.gl = P.gl || { calls: 0, tris: 0, passes: 0, programs: 0, textures: 0, targets: 0, texels: 0, frames: 0, sumCalls: 0, sumTris: 0, maxCalls: 0, maxTris: 0, maxPasses: 0, instanced: 0, kinds: 0 };
      var seen = [], vao = null, kinds = typeof Set === 'function' ? new Set() : null;
      function draw(name, countAt, instAt) {
        var f = gl[name]; if (!f) return;
        gl[name] = function () {
          var mode = arguments[0], n = arguments[countAt] || 0, inst = instAt == null ? 1 : (arguments[instAt] || 1);
          G.calls++; if (instAt != null && inst > 1) G.instanced++; if (kinds && vao) kinds.add(vao);
          G.tris += (mode === 4 ? n / 3 : mode === 5 || mode === 6 ? Math.max(0, n - 2) : 0) * inst;
          return f.apply(gl, arguments);
        };
      }
      draw('drawElements', 1); draw('drawArrays', 2); draw('drawElementsInstanced', 1, 4); draw('drawArraysInstanced', 2, 3); draw('drawRangeElements', 3);
      var bva = gl.bindVertexArray; if (bva) gl.bindVertexArray = function (v) { vao = v; return bva.apply(gl, arguments); };   // one vertex array per distinct shape drawn
      var link = gl.linkProgram; gl.linkProgram = function () { G.programs++; return link.apply(gl, arguments); };
      var tex = gl.texImage2D; gl.texImage2D = function (target, level) {
        if (level === 0 && target === 3553) {
          var a = arguments, src = a.length <= 6 ? a[5] : a[8], w = a.length <= 6 ? (src && (src.videoWidth || src.width)) || 0 : a[3], h = a.length <= 6 ? (src && (src.videoHeight || src.height)) || 0 : a[4];
          if (src == null) { G.targets++; if (bound && tmap) tmap.set(bound, w * h); } else if (w * h >= 256) { G.textures++; G.texels += w * h; }
        }
        return tex.apply(gl, arguments);
      };
      // a texture painted on the GPU (drawn into a render target, then given mipmaps to be sampled as a surface) is a texture too
      var bound = null, unit = 0, units = {}, tmap = typeof WeakMap === 'function' ? new WeakMap() : null;
      var at = gl.activeTexture; gl.activeTexture = function (u) { unit = u; bound = units[u] || null; return at.apply(gl, arguments); };
      var bt = gl.bindTexture; gl.bindTexture = function (target, t) { if (target === 3553) bound = units[unit] = t; return bt.apply(gl, arguments); };
      var mip = gl.generateMipmap; gl.generateMipmap = function (target) {
        if (target === 3553 && bound && tmap) { var n = tmap.get(bound); if (n >= 256) { G.textures++; G.texels += n; tmap.set(bound, 0); } }
        return mip.apply(gl, arguments);
      };
      var sto = gl.texStorage2D; if (sto) gl.texStorage2D = function (target, levels, fmt, w, h) { if (target === 3553 && w * h >= 256) { G.textures++; G.texels += w * h; } return sto.apply(gl, arguments); };
      var bind = gl.bindFramebuffer; gl.bindFramebuffer = function (t, fb) { if (fb && seen.indexOf(fb) < 0) { seen.push(fb); G.passes++; } return bind.apply(gl, arguments); };
      frameHooks.push(function () {
        if (G.calls) { G.frames++; G.sumCalls += G.calls; G.sumTris += G.tris; if (G.calls > G.maxCalls) G.maxCalls = G.calls; if (G.tris > G.maxTris) G.maxTris = G.tris; if (G.passes > G.maxPasses) G.maxPasses = G.passes; if (kinds && kinds.size > G.kinds) G.kinds = kinds.size; }
        G.calls = 0; G.tris = 0; G.passes = 0; seen.length = 0; if (kinds) kinds.clear();
      });
    }
    var getCtx = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type) {
      var ctx = getCtx.apply(this, arguments);
      try { if (ctx && !ctx.__gcp && /^(webgl|experimental-webgl)/.test(String(type))) { Object.defineProperty(ctx, '__gcp', { value: 1 }); hookGL(ctx); } } catch (e) { /* a probe must never break a game */ }
      return ctx;
    };
    // 2D canvas: operations on visible canvases per frame, and how many off-screen canvases were painted (baked sprites and textures)
    var C = P.c2d = { ops: 0, images: 0, frames: 0, sumOps: 0, sumImages: 0, baked: 0 }, bakedSet = typeof WeakSet === 'function' ? new WeakSet() : null, proto = window.CanvasRenderingContext2D && CanvasRenderingContext2D.prototype;
    if (proto) ['drawImage', 'fillRect', 'fill', 'stroke', 'fillText', 'strokeRect'].forEach(function (name) {
      var f = proto[name]; if (!f) return;
      proto[name] = function () {
        var cv = this.canvas;
        if (cv && cv.isConnected) { C.ops++; if (name === 'drawImage') C.images++; }
        else if (cv && bakedSet && !bakedSet.has(cv)) { bakedSet.add(cv); C.baked++; }
        return f.apply(this, arguments);
      };
    });
    frameHooks.push(function () { if (C.ops) { C.frames++; C.sumOps += C.ops; C.sumImages += C.images; } C.ops = 0; C.images = 0; });
    // sound: contexts created and sources actually started
    ['AudioContext', 'webkitAudioContext'].forEach(function (n) { var A = window[n]; if (!A) return; var W = function (o) { P.audio.contexts++; return new A(o); }; W.prototype = A.prototype; try { Object.setPrototypeOf(W, A); } catch (e) { /* old browser */ } window[n] = W; });
    [window.AudioScheduledSourceNode, window.AudioBufferSourceNode, window.OscillatorNode].forEach(function (N) { if (!N || !N.prototype || N.prototype.__gcp || !Object.prototype.hasOwnProperty.call(N.prototype, 'start')) return; var st = N.prototype.start; N.prototype.start = function () { P.audio.starts++; return st.apply(this, arguments); }; N.prototype.__gcp = 1; });
    if (window.HTMLMediaElement) { var play = HTMLMediaElement.prototype.play; HTMLMediaElement.prototype.play = function () { P.audio.starts++; return play.apply(this, arguments); }; }
    // input: which kinds of events the game listens for
    var add = EventTarget.prototype.addEventListener, watch = { keydown: 1, keyup: 1, pointerdown: 1, pointermove: 1, mousedown: 1, mousemove: 1, touchstart: 1, touchmove: 1, wheel: 1, resize: 1, gamepadconnected: 1, visibilitychange: 1, blur: 1 };
    EventTarget.prototype.addEventListener = function (type) { if (watch[type]) P.listeners[type] = (P.listeners[type] || 0) + 1; return add.apply(this, arguments); };
  })();

  // Count frames for any engine by wrapping requestAnimationFrame. Frames are what "alive" means.
  var raf0 = window.requestAnimationFrame.bind(window), lastT = -1, lastFrameAt = 0;
  // In the portrait pass frames are paced: a full-quality frame on a CPU renderer takes far longer to draw than to submit,
  // and unpaced the browser falls many frames behind, so a picture would wait for all of them. Each frame ends with a
  // fence; the next one is requested when the graphics side reports that fence passed (WebGL 2), or after a pause.
  var fence = null;
  function paced(cb) {
    var t0 = performance.now();
    (function wait() {
      var gl = glRef, done = true;
      if (gl && fence) { try { var r = gl.clientWaitSync(fence, 0, 0); done = r === gl.ALREADY_SIGNALED || r === gl.CONDITION_SATISFIED || r === gl.WAIT_FAILED; } catch (e) { done = true; } }
      else if (!gl || !gl.fenceSync) done = performance.now() - t0 > 400;
      if (!done && performance.now() - t0 < 10000) return setTimeout(wait, 40);
      if (gl && fence) { try { gl.deleteSync(fence); } catch (e) { /* context lost */ } fence = null; }
      raf0(function (t) { cb(t); var g = glRef; if (g && g.fenceSync && !fence) { try { fence = g.fenceSync(g.SYNC_GPU_COMMANDS_COMPLETE, 0); g.flush(); } catch (e) { fence = null; } } });
    })();
    return 0;
  }
  var raf = q.has('gcp_portrait') ? paced : raf0;
  // The verifier can hold the frame loop still while it photographs a slow, full-quality frame (see the portrait pass).
  var held = [];
  S.hold = function (on) { S.held = !!on; if (!on) { var h = held; held = []; for (var i = 0; i < h.length; i++) window.requestAnimationFrame(h[i]); } };
  window.requestAnimationFrame = function (cb) { if (S.held) { held.push(cb); return 0; } return raf(function (t) { if (t !== lastT) { lastT = t; S.frames++; lastFrameAt = performance.now(); for (var i = 0; i < frameHooks.length; i++) frameHooks[i](); } cb(t); if (afterDraw) afterDraw(t); }); };
  var afterDraw = null;   // set while the creator's console takes a picture of the game (see "creator feedback" below)

  function api(path, body, method) {
    if (standalone) return Promise.reject(new Error('offline'));
    if (ended) return Promise.reject(new Error(ended.message));
    return fetch(cfg.api + '/api/rt/' + path, { method: method || 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify(Object.assign({ t: cfg.token }, body || {})) })
      .then(function (r) { return r.json().then(function (j) { if (!r.ok) { if (r.status === 401 && j.code === 'session_ended') sessionEnded(j); throw new Error(j.error || ('HTTP ' + r.status)); } return j; }); });
  }

  // ---- the session's binding to the player's platform identity ----
  // A session belongs to the sign-in that started it (or to this browser's guest id). When the player signs out, signs in
  // as someone else, or signs in after playing as a guest, the platform refuses the old session: the game is stopped
  // here before it can play on as the wrong player, and the page around it starts a session for the right one.
  var ended = null;
  function sessionEnded(j) {
    if (ended) return; ended = { reason: (j && j.hint) || 'unknown', message: (j && j.error) || 'This play session ended.' };
    S.hold(true);
    try { parent.postMessage({ gcp: 'session_ended', reason: ended.reason }, '*'); } catch (e) { /* not framed */ }
    try {
      var d = document.createElement('div');
      d.setAttribute('style', 'position:fixed;inset:0;z-index:2147483647;display:grid;place-items:center;background:rgba(11,13,15,.92);color:#e8e4da;font:15px/1.5 system-ui,sans-serif;text-align:center;padding:24px');
      d.innerHTML = '<div><b style="display:block;font-size:22px;margin-bottom:6px">This play session ended</b><span style="opacity:.7"></span></div>';
      d.querySelector('span').textContent = ended.message;
      (document.body || document.documentElement).appendChild(d);
    } catch (e) { /* no DOM yet */ }
  }
  // Long sessions: a fresh token shortly before this one runs out, while the session is still bound, so saves never start
  // failing in the middle of play. The game's own origin gets it too, so a reload later still opens.
  function tokenExp(tk) { try { return JSON.parse(atob(String(tk).split('.')[0].replace(/-/g, '+').replace(/_/g, '/'))).x * 1000; } catch (e) { return 0; } }
  function renew() {
    if (standalone || ended || !cfg.token) return;
    api('renew', {}).then(function (r) {
      if (!r || !r.token) return;
      cfg.token = r.token;
      fetch((cfg.base || '') + '/__gcp/token', { method: 'POST', body: r.token, credentials: 'same-origin' }).catch(function () { });
    }).catch(function () { });
  }
  if (!standalone && cfg.kind !== 'verify') setInterval(function () { var x = tokenExp(cfg.token); if (!trial && x && x - Date.now() < 15 * 60000) renew(); }, 60000);

  // Free trial of a paid game: the platform signs a trial token that ends with the trial. The server counts the time
  // and refuses the platform services once it is used; here the game is paused and the platform page is told.
  var trial = null;
  try { var tb = JSON.parse(atob(String(cfg.token).split('.')[0].replace(/-/g, '+').replace(/_/g, '/'))); if (tb && tb.tr) trial = { until: (tb.x - 20) * 1000, over: false }; } catch (e) { /* no token */ }
  function trialOver() {
    if (!trial || trial.over) return; trial.over = true;
    S.hold(true);
    try { parent.postMessage({ gcp: 'trial_over' }, '*'); } catch (e) { /* not framed */ }
    try {
      var d = document.createElement('div');
      d.setAttribute('style', 'position:fixed;inset:0;z-index:2147483647;display:grid;place-items:center;background:rgba(11,13,15,.92);color:#e8e4da;font:15px/1.5 system-ui,sans-serif;text-align:center;padding:24px');
      d.innerHTML = '<div><b style="display:block;font-size:22px;margin-bottom:6px">Your free trial has ended</b><span style="opacity:.7">Buy the game on its page to keep playing.</span></div>';
      (document.body || document.documentElement).appendChild(d);
    } catch (e) { /* no DOM yet */ }
  }
  function onBeat(j) { if (j && j.trial) { if (j.trial.over) trialOver(); else if (!j.trial.bought) trial.until = Math.min(trial.until, Date.now() + j.trial.remaining_seconds * 1000); } }
  if (trial) setInterval(function () { if (!trial.over && !trial.ending && Date.now() >= trial.until) { trial.ending = true; beat(); setTimeout(trialOver, 3000); } }, 1000);

  // Heartbeat: tells the platform the game is running and passes on its errors. It moves no play number: play time,
  // plays and players online are measured by the platform from the page that shows the game (src/play-clock.ts).
  var beatFrames = 0, fpsEma = 0;
  function beat(last) {
    if (standalone || !S.ready || ended) return;
    var advanced = S.frames - beatFrames; beatFrames = S.frames;
    fpsEma = advanced / 15;
    var body = JSON.stringify({ t: cfg.token, frames: S.frames, active: advanced > 0 && document.visibilityState === 'visible', fps: Math.round(fpsEma), errors: pending.splice(0, 5), fatal: S.fatal });
    if (last && navigator.sendBeacon) navigator.sendBeacon(cfg.api + '/api/rt/beat', new Blob([body], { type: 'text/plain' }));
    else {
      // A dropped connection (ERR_CONNECTION_CLOSED after a long frame or a network switch) is tried once more, so the
      // play time it reports is not lost.
      var send = function () { return fetch(cfg.api + '/api/rt/beat', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: body, keepalive: true }); };
      send().catch(function () { return new Promise(function (ok) { setTimeout(ok, 2000); }).then(send); })
        .then(function (r) { return r.json().then(function (j) { if (r.status === 401 && j && j.code === 'session_ended') sessionEnded(j); else if ((r.status === 401 || r.status === 402) && trial) trialOver(); return r.ok ? j : null; }); }).then(onBeat).catch(function () { });
    }
  }
  setInterval(beat, 15000);
  window.addEventListener('pagehide', function () { beat(true); });

  // The offline copy is kept per game, environment and player, so two people who share a browser never see each other's saves.
  function lsKey(k) { return 'gcp:' + cfg.gameId + ':' + cfg.env + ':' + (cfg.player && cfg.player.id || 'anon') + ':' + k; }
  var LS = { get: function (k) { try { var v = localStorage.getItem(lsKey(k)); return v == null ? null : JSON.parse(v); } catch (e) { return null; } }, set: function (k, v) { try { localStorage.setItem(lsKey(k), JSON.stringify(v)); } catch (e) { /* private mode */ } }, del: function (k) { try { localStorage.removeItem(lsKey(k)); } catch (e) { /* ignore */ } } };

  // Smooth playback of timed samples from one remote sender (GCP.smooth). Samples arrive in bursts; stamping them with
  // their arrival time turns network jitter into movement jitter, and a fixed small delay runs dry whenever one message is
  // late. So each sample carries its send time (room messages do this by themselves: the third argument of 'message').
  // The buffer learns the offset between the sender's clock and ours from the lowest one-way offset seen recently, plays
  // back about one send interval plus the recent jitter behind the newest sample, nudges its clock at 0.9x..1.1x instead of
  // jumping, slows down rather than freezing when a message is late, and never goes backwards.
  var clock = function () { return Math.round(performance.timeOrigin + performance.now()); };
  function Smooth(o) {
    o = o || {};
    this.fixed = typeof o.delay === 'number' ? o.delay : null; this.minDelay = o.minDelay != null ? o.minDelay : 40; this.maxDelay = o.maxDelay != null ? o.maxDelay : 350;
    this.extrap = o.extrapolate != null ? o.extrapolate : 120; this.size = o.size || 40;
    this.items = []; this.offs = []; this.base = 0; this.interval = 66; this.jitter = 0; this.delay = this.fixed != null ? this.fixed : 100;
    this.play = null; this.lastNow = 0; this.lastPush = 0;
  }
  Smooth.prototype.clear = function () { this.items.length = 0; this.offs.length = 0; this.play = null; };
  /** Add a sample. sentAt: the sender's clock (ms) when it was taken, e.g. meta.at from a room message; arrival time if left out. */
  Smooth.prototype.push = function (v, sentAt, recvAt) {
    recvAt = recvAt != null ? recvAt : performance.now();
    if (typeof sentAt !== 'number' || !isFinite(sentAt)) sentAt = recvAt;
    var I = this.items, prev = I[I.length - 1];
    if (prev && sentAt <= prev.t) { if (prev.t - sentAt > 5000) this.clear(); else return; }   // duplicate or out of date; a big step back means the sender restarted
    if (prev && sentAt - prev.t > 3000) this.clear();                                          // a long silence: start over instead of crawling through the gap
    prev = I[I.length - 1];
    if (prev) this.interval += (Math.min(sentAt - prev.t, 500) - this.interval) * 0.1;
    I.push({ t: sentAt, v: v }); if (I.length > this.size) I.shift();
    this.lastPush = recvAt;
    var off = recvAt - sentAt, min = Infinity, max = -Infinity, i;
    this.offs.push({ r: recvAt, o: off });
    while (this.offs.length > 1 && recvAt - this.offs[0].r > 4000) this.offs.shift();
    for (i = 0; i < this.offs.length; i++) { if (this.offs[i].o < min) min = this.offs[i].o; if (this.offs[i].o > max) max = this.offs[i].o; }
    this.base = min; this.jitter = max - min;
    if (this.fixed == null) {
      var want = Math.max(this.minDelay, Math.min(this.maxDelay, this.interval * 1.15 + this.jitter + 8));
      this.delay += (want - this.delay) * (want > this.delay ? 0.25 : 0.03);
    }
  };
  /** Where playback is now: { a, b, k } (two samples and the blend between them, a little above 1 while running ahead), or null before the first sample. */
  Smooth.prototype.sample = function (t) {
    var I = this.items, n = I.length; if (!n) return null;
    t = t != null ? t : performance.now();
    var target = t - this.base - this.delay, L = I[n - 1];
    if (this.play == null || Math.abs(target - this.play) > 600) this.play = target;
    else {
      var dt = Math.max(0, t - this.lastNow), err = target - this.play, over = this.play - L.t;
      // past the newest sample (a late message): ease to a stop at `extrapolate` ms ahead instead of freezing and then jumping
      this.play += dt * (1 + Math.max(-0.1, Math.min(0.1, err / 200))) * (over > 0 ? Math.max(0, 1 - over / this.extrap) : 1);
    }
    this.lastNow = t;
    var p = this.play;
    if (n === 1 || p <= I[0].t) return { a: I[0].v, b: I[0].v, k: 0 };
    if (p >= L.t) { var A = I[n - 2], span = Math.max(1, L.t - A.t); return { a: A.v, b: L.v, k: 1 + Math.min(p - L.t, this.extrap, span) / span, ahead: true }; }
    var lo = 0, hi = n - 1;
    while (hi - lo > 1) { var m = (lo + hi) >> 1; if (I[m].t <= p) lo = m; else hi = m; }
    return { a: I[lo].v, b: I[hi].v, k: (p - I[lo].t) / Math.max(1, I[hi].t - I[lo].t) };
  };
  /** The blended value now. Numbers, and the number fields of objects and arrays (one level deep), are blended; anything else comes from the newer sample. */
  Smooth.prototype.value = function (t) {
    var s = this.sample(t); if (!s) return null;
    var a = s.a, b = s.b, k = s.k;
    if (typeof b === 'number') return typeof a === 'number' ? a + (b - a) * k : b;
    if (!b || typeof b !== 'object') return b;
    var out = Array.isArray(b) ? b.slice() : Object.assign({}, b);
    for (var key in b) if (typeof b[key] === 'number' && a && typeof a[key] === 'number') out[key] = a[key] + (b[key] - a[key]) * k;
    return out;
  };
  Object.defineProperty(Smooth.prototype, 'age', { get: function () { return this.items.length ? performance.now() - this.lastPush : Infinity; } });
  Object.defineProperty(Smooth.prototype, 'last', { get: function () { return this.items.length ? this.items[this.items.length - 1].v : null; } });

  function Room(code, opts) {
    var self = this, handlers = {}, ws = null, closed = false, tries = 0;
    this.code = code; this.id = null; this.hostId = null; this.peers = []; this.state = null; this.connected = false;
    var seen = { messages: 0, worldOps: 0, states: 0, closes: 0 };   // what arrived, for the two-player check's report
    (S.rooms = S.rooms || []).push(function () { return { code: code, id: self.id, host: self.hostId, isHost: self.isHost, connected: self.connected, peers: self.peers.map(function (p) { return p.id; }), messages: seen.messages, world_ops: seen.worldOps, states: seen.states, closes: seen.closes }; });
    Object.defineProperty(this, 'isHost', { get: function () { return self.id !== null && self.id === self.hostId; } });
    function emit(type, a, b, c) { (handlers[type] || []).slice().forEach(function (fn) { try { fn(a, b, c); } catch (e) { console.error(e); } }); }
    this.on = function (type, fn) { (handlers[type] = handlers[type] || []).push(fn); return self; };
    this.off = function (type, fn) { handlers[type] = (handlers[type] || []).filter(function (f) { return f !== fn; }); return self; };
    /** Send to everyone else, or to one peer id, or to 'host'. Each message carries its send time, which receivers get as meta.at.
        data is JSON, or an ArrayBuffer / typed array for packed binary data (receivers get an ArrayBuffer). */
    this.send = function (data, to) {
      if (!ws || ws.readyState !== 1) return false;
      if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) { ws.send(binFrame(data, to)); return true; }
      ws.send(JSON.stringify(to ? { t: 'msg', to: to, d: data, at: clock() } : { t: 'msg', d: data, at: clock() }));
      return true;
    };
    /** Round-trip time to the room in ms (measured every few seconds while connected), or null before the first answer. */
    this.rtt = null;
    var pingN = 0, pingAt = {}, pingTimer = 0;
    function ping() { if (ws && ws.readyState === 1) { pingAt[++pingN] = performance.now(); ws.send(JSON.stringify({ t: 'ping', n: pingN })); } }
    // [1][target 0 all | 1 host | 2 peer][len][peer id][at float64 LE][payload] (src/room-wire.ts)
    function binFrame(data, to) {
      var payload = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      var id = to && to !== 'host' ? new TextEncoder().encode(String(to)).subarray(0, 255) : new Uint8Array(0);
      var head = id.length ? 3 + id.length : 2, out = new Uint8Array(head + 8 + payload.length);
      out[0] = 1; out[1] = to === 'host' ? 1 : id.length ? 2 : 0;
      if (id.length) { out[2] = id.length; out.set(id, 3); }
      new DataView(out.buffer, head, 8).setFloat64(0, clock(), true);
      out.set(payload, head + 8);
      return out.buffer;
    }
    function onBinary(buf) {
      var u = new Uint8Array(buf);
      if (u.length < 2 || u[0] !== 1 || u.length < 2 + u[1] + 8) return;
      var from = new TextDecoder().decode(u.subarray(2, 2 + u[1])), at = new DataView(buf, 2 + u[1], 8).getFloat64(0, true);
      seen.messages++;
      emit('message', buf.slice(2 + u[1] + 8), from, { at: isFinite(at) ? at : undefined, received: performance.now() });
    }
    /** Host only: store a snapshot that late joiners receive in their 'open' event (max 256 KB). */
    this.setState = function (data) { self.state = data; if (ws && ws.readyState === 1) ws.send(JSON.stringify({ t: 'state', d: data })); };
    this.leave = function () { closed = true; clearInterval(pingTimer); if (ws) ws.close(1000); };
    function connect() {
      if (standalone) { setTimeout(function () { self.id = 'local'; self.hostId = 'local'; self.connected = true; emit('open', { id: 'local', host: true, peers: [], state: null }); }, 0); return; }
      var u = cfg.api.replace(/^http/, 'ws') + '/api/rt/room?room=' + encodeURIComponent(code) + '&t=' + encodeURIComponent(cfg.token) + (opts && opts.max ? '&max=' + opts.max : '');
      ws = new WebSocket(u);
      ws.binaryType = 'arraybuffer';
      ws.onmessage = function (ev) {
        if (typeof ev.data !== 'string') return onBinary(ev.data);
        var m; try { m = JSON.parse(ev.data); } catch (e) { return; }
        if (m.t === 'welcome') {
          tries = 0; self.id = m.id; self.hostId = m.host; self.peers = m.peers; self.state = m.state; self.connected = true;
          clearInterval(pingTimer); ping(); pingTimer = setInterval(ping, 5000);
          emit('open', { id: m.id, host: self.isHost, peers: m.peers, state: m.state });
        }
        else if (m.t === 'pong') { if (m.n && pingAt[m.n]) { var r = performance.now() - pingAt[m.n]; self.rtt = self.rtt == null ? r : self.rtt * 0.7 + r * 0.3; delete pingAt[m.n]; } }
        else if (m.t === 'join') { self.peers.push(m.peer); emit('join', m.peer); }
        else if (m.t === 'leave') { self.peers = self.peers.filter(function (p) { return p.id !== m.id; }); var was = self.hostId; self.hostId = m.host; emit('leave', m.id); if (was !== m.host) emit('host', m.host); }
        else if (m.t === 'msg') { seen.messages++; if (m.d && m.d.gcpWorld === 'op') seen.worldOps++; emit('message', m.d, m.from, { at: typeof m.at === 'number' ? m.at : undefined, received: performance.now() }); }
        else if (m.t === 'state') { seen.states++; self.state = m.d; emit('state', m.d); }
        else if (m.t === 'error') { var err = new Error(m.message); if (m.code) err.code = m.code; emit('error', err); }
      };
      ws.onclose = function (ev) {
        self.connected = false; seen.closes++; clearInterval(pingTimer); pingAt = {}; emit('close', ev.code);
        if (!closed && ev.code !== 4001 && ev.code !== 4003 && ev.code !== 4008 && tries < 6) setTimeout(connect, Math.min(8000, 500 * Math.pow(2, tries++)));
      };
    }
    connect();
  }

  // ----- server-run matches (GCP.match) ----------------------------------------------------------------------------
  // find() waits in the platform's matchmaker, then connects to the match the game's own server/match.js runs at a fixed
  // tick. Inputs go up numbered at the tick rate; snapshots come down (full or as a delta) with the number of your last
  // input the server applied. The SDK replays your newer inputs through predict() (your own entity moves at once and is
  // corrected smoothly), plays everyone else back a little in the past between snapshots, and tells the server which
  // moment you were looking at with each input, so hit checks (ctx.hitscan) judge shots on what you saw.
  function mpatch(a, n) {
    if (n === undefined || n === null) return a;
    if (Object.prototype.hasOwnProperty.call(n, 'v')) return n.v;
    var out = a && typeof a === 'object' && !Array.isArray(a) ? Object.assign({}, a) : {}, k;
    if (n.x) for (k = 0; k < n.x.length; k++) delete out[n.x[k]];
    if (n.o) for (k in n.o) out[k] = mpatch(out[k], n.o[k]);
    return out;
  }
  var ANGLES = { a: 1, angle: 1, yaw: 1, pitch: 1, rot: 1, heading: 1 };
  function blendEnt(p, q, k, angles) {
    if (!p || !q || typeof q !== 'object') return q;
    var o = Array.isArray(q) ? q.slice() : Object.assign({}, q);
    for (var f in q) {
      if (typeof q[f] !== 'number' || typeof p[f] !== 'number') continue;
      if (angles[f]) { var d = q[f] - p[f]; d = ((d + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI; o[f] = p[f] + d * Math.min(k, 1); }
      else o[f] = p[f] + (q[f] - p[f]) * k;
    }
    return o;
  }
  function Match(opts) {
    var self = this, handlers = {}, mm = null, ws = null, ticket = null, tries = 0, closed = false, timer = 0, pingTimer = 0, started = false;
    opts = opts || {};
    var entitiesOf = typeof opts.entities === 'function' ? opts.entities : function (v) { return v && (v.players || v.entities) || {}; };
    var angles = Object.assign({}, ANGLES); (opts.angles || []).forEach(function (a) { angles[a] = 1; });
    this.phase = 'searching'; this.id = null; this.you = cfg.player && cfg.player.id; this.players = []; this.tickRate = 0; this.tick = 0;
    this.state = null; this.ack = 0; this.rtt = null; this.result = null; this.renderTick = null;
    var buf = new Smooth({ minDelay: opts.delay != null ? opts.delay : 50, maxDelay: 250, extrapolate: 100 });
    // what the verifier's two-player check reports when it fails: who this page is, who the lobby listed, how far it got
    var seen = { code: opts.code != null ? String(opts.code) : null, lobby: [], snapshots: 0, closes: 0, error: '' };
    (S.matches = S.matches || []).push(function () { return { code: seen.code, phase: self.phase, you: self.you, match: self.id, lobby: seen.lobby, players: (self.players || []).map(function (p) { return p && p.id; }), snapshots: seen.snapshots, closes: seen.closes, error: seen.error }; });
    var n = 0, pending = [], current = {}, pressed = {}, tickMs = 33, predicted = null, prevPredicted = null, predictedAt = 0, offset = {}, pings = {};
    function emit(type, a, b) { (handlers[type] || []).slice().forEach(function (fn) { try { fn(a, b); } catch (e) { console.error(e); } }); }
    this.on = function (type, fn) { (handlers[type] = handlers[type] || []).push(fn); return self; };
    this.off = function (type, fn) { handlers[type] = (handlers[type] || []).filter(function (f) { return f !== fn; }); return self; };
    /** The input held right now (sent every tick until changed): what is pressed, where you aim. Keep it small. */
    this.input = function (data) { current = data || {}; return self; };
    /** A one-off action (a shot, a jump) that goes out with the next input only, even if pressed between two ticks. */
    this.press = function (name) { pressed[String(name)] = true; return self; };
    /** Private lobby: the player who opened it starts with whoever is there (at least min). */
    this.start = function () { if (mm && mm.readyState === 1) mm.send(JSON.stringify({ t: 'start' })); };
    /** Stop searching, or leave the match. */
    this.cancel = this.leave = function () {
      closed = true; clearInterval(timer); clearInterval(pingTimer);
      if (mm) try { mm.send(JSON.stringify({ t: 'cancel' })); mm.close(1000); } catch (e) { /* closed */ }
      if (ws) try { ws.close(1000); } catch (e) { /* closed */ }
    };
    function selfOf(v) { var e = entitiesOf(v); return e && e[self.you] || null; }
    function clone(x) { return x == null ? x : JSON.parse(JSON.stringify(x)); }
    function repredict() {
      if (typeof opts.predict !== 'function' || !self.state) return;
      var base = selfOf(self.state); if (!base) { predicted = null; return; }
      var p = clone(base), dt = 1 / (self.tickRate || 30);
      for (var i = 0; i < pending.length; i++) { try { p = opts.predict(p, pending[i].d, dt, self.state) || p; } catch (e) { console.error(e); break; } }
      // the correction (where the server says we are vs where we had predicted) fades out instead of snapping
      if (predicted) for (var f in p) if (typeof p[f] === 'number' && typeof predicted[f] === 'number' && !angles[f]) {
        var err = predicted[f] + (offset[f] || 0) - p[f];
        offset[f] = Math.abs(err) > (opts.snapDistance || 5) ? 0 : err;
      }
      predicted = p;
    }
    function sendInput() {
      if (!ws || ws.readyState !== 1 || self.phase !== 'running') return;
      var d = Object.assign({}, current, pressed); pressed = {};
      n++; pending.push({ n: n, d: d }); if (pending.length > 120) pending.shift();
      // the moment the player is looking at (others are drawn this far in the past), for the server's hit checks;
      // kept current here too, so it is right even in a game that never calls view()
      if (buf.sample() && buf.play != null) self.renderTick = buf.play / tickMs;
      ws.send(JSON.stringify({ t: 'i', n: n, v: self.renderTick, d: d }));
      if (typeof opts.predict === 'function' && predicted) {
        prevPredicted = predicted;
        try { predicted = opts.predict(clone(predicted), d, 1 / (self.tickRate || 30), self.state) || predicted; } catch (e) { console.error(e); }
        predictedAt = performance.now();
      }
    }
    /** What to draw now: me (your entity, predicted when you passed predict), others (everyone else, interpolated), state (the newest snapshot). */
    this.view = function () {
      var s = buf.sample(), others = {}, me = null;
      if (s) {
        var A = entitiesOf(s.a), B = entitiesOf(s.b);
        for (var id in B) if (id !== self.you) others[id] = blendEnt(A && A[id], B[id], Math.min(s.k, 1.25), angles);
        self.renderTick = buf.play != null ? buf.play / tickMs : null;
      }
      if (predicted) {
        var k = Math.min(1, (performance.now() - predictedAt) / tickMs);
        me = prevPredicted ? blendEnt(prevPredicted, predicted, k, angles) : predicted;
        me = Object.assign({}, me);
        var decay = Math.exp(-(performance.now() - (self._lastView || performance.now())) / 100);
        for (var f in offset) { offset[f] *= decay; if (typeof me[f] === 'number') me[f] += offset[f]; }
        self._lastView = performance.now();
      } else me = selfOf(self.state);
      return { me: me, others: others, state: self.state, tick: self.tick, renderTick: self.renderTick };
    };
    function connectMatch() {
      ws = new WebSocket(location.origin.replace(/^http/, 'ws') + (cfg.base || '') + '/__gcp/match?t=' + encodeURIComponent(ticket));
      ws.onmessage = function (ev) {
        var m; try { m = JSON.parse(ev.data); } catch (e) { return; }
        if (m.t === 's') {
          seen.snapshots++;
          self.tick = m.k; self.state = m.f ? m.d : mpatch(self.state, m.d);
          if (m.a > self.ack) { self.ack = m.a; while (pending.length && pending[0].n <= self.ack) pending.shift(); }
          buf.push(self.state, m.k * tickMs);
          repredict(); emit('snapshot', self.state, m.k);
        }
        else if (m.t === 'e') emit('event', m.d, m.k);
        else if (m.t === 'hello') {
          tries = 0; self.id = m.match; self.you = m.you; self.tickRate = m.tickRate; tickMs = 1000 / m.tickRate; self.players = m.players; self.maxRewindMs = m.maxRewindMs;
          if (m.ack > self.ack) self.ack = m.ack;
          pending = pending.filter(function (p) { return p.n > self.ack; });
          if (m.phase === 'running') start();
          clearInterval(pingTimer); pingTimer = setInterval(function () { if (ws && ws.readyState === 1) { var k = Math.random(); pings[k] = performance.now(); ws.send(JSON.stringify({ t: 'p', n: k })); } }, 2000);
        }
        else if (m.t === 'start') { self.players = m.players; start(); }
        else if (m.t === 'wait' || m.t === 'players') { self.players = m.players; emit('players', m.players); }
        else if (m.t === 'po') { if (pings[m.n]) { var r = performance.now() - pings[m.n]; self.rtt = self.rtt == null ? r : self.rtt * 0.7 + r * 0.3; delete pings[m.n]; } }
        else if (m.t === 'end') { self.phase = 'ended'; self.result = m.result; clearInterval(timer); emit('end', m.result); }
        else if (m.t === 'error') { seen.error = String(m.code || m.message || ''); var e = new Error(m.message); e.code = m.code; emit('error', e); }
      };
      ws.onclose = function (ev) {
        clearInterval(timer); clearInterval(pingTimer); seen.closes++;
        var final = closed || self.phase === 'ended' || ev.code === 1000 || ev.code === 4001 || ev.code === 4002 || ev.code === 4003 || ev.code === 4004 || ev.code === 4009 || ev.code === 4500;   // 4009: removed from the match
        if (!final && tries < 5) { self.phase = self.phase === 'running' ? 'reconnecting' : self.phase; emit('reconnecting', tries + 1); setTimeout(connectMatch, Math.min(4000, 300 * Math.pow(2, tries++))); return; }
        if (self.phase !== 'ended') { self.phase = 'closed'; emit('close', ev.code, ev.reason); }
      };
    }
    function start() {
      if (self.phase === 'running') return;
      self.phase = 'running'; clearInterval(timer);
      // inputs on a steady clock at the tick rate; the timer keeps its remainder so 30 Hz stays 30 Hz
      var next = performance.now();
      timer = setInterval(function () { var t = performance.now(), sent = 0; while (next <= t && sent < 4) { sendInput(); next += tickMs; sent++; } if (t - next > 500) next = t; }, Math.max(4, tickMs / 4));
      if (started) { emit('reconnected'); return; }
      started = true;
      emit('start', { you: self.you, players: self.players, tickRate: self.tickRate, state: self.state });
    }
    if (standalone) { setTimeout(function () { var e = new Error('Server-run matches need the platform: open the game from its page.'); e.code = 'standalone'; self.phase = 'closed'; emit('error', e); emit('close', 0); }, 0); return; }
    var q = '/api/rt/match?t=' + encodeURIComponent(cfg.token);
    ['queue', 'players', 'min', 'teams', 'code', 'mode'].forEach(function (k) { if (opts[k] != null) q += '&' + k + '=' + encodeURIComponent(opts[k]); });
    mm = new WebSocket(cfg.api.replace(/^http/, 'ws') + q);
    mm.onmessage = function (ev) {
      var m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.t === 'queued') emit('queued', { waiting: m.waiting, waited: m.waited || 0 });
      else if (m.t === 'lobby') { seen.lobby = (m.players || []).map(function (p) { return p && p.id; }); emit('lobby', { code: m.code, players: m.players, owner: m.owner, need: m.need }); }
      else if (m.t === 'found') { ticket = m.ticket; self.id = m.match; self.players = m.players; self.phase = 'connecting'; emit('found', { match: m.match, players: m.players, region: m.region }); connectMatch(); }
      else if (m.t === 'error') {
        seen.error = String(m.code || m.message || ''); var e = new Error(m.message); e.code = m.code; emit('error', e);
        // the search moved to another tab, or the session ended: this one is over (close it ourselves, whatever the server does)
        if (m.code === 'replaced' || m.code === 'session_ended') { closed = true; self.phase = 'closed'; try { mm.close(1000); } catch (x) { /* closed */ } emit('close', m.code === 'replaced' ? 4002 : 4001, m.message); }
      }
    };
    mm.onclose = function (ev) { if (!ticket) seen.closes++; if (!ticket && !closed) { self.phase = 'closed'; emit('close', ev.code, ev.reason); } };
  }

  var autostartFns = [], playFn = null, pairFn = null, stateFn = null;
  S.debugState = function () { if (!stateFn) return null; var v = stateFn(); if (v === undefined || v === null) return null; var j = typeof v === 'string' ? v : JSON.stringify(v); return String(j).slice(0, 4000); };
  // The play-through a game may register: the verifier runs it and reports each step, so "playable" can mean
  // "the whole loop was played to the end" instead of only "it booted". Limits: 60 steps, one run at a time.
  S.playthrough = false;
  S.runPlaythrough = function (limitMs) { return runScript(playFn, limitMs, 'play-through'); };
  // The two-player check a multiplayer game may register (GCP.test.onTwoPlayers): the verifier opens the game twice in one
  // room, runs this in both pages and compares what each returns, so "multiplayer" is proved across two real browsers.
  S.twoPlayers = false;
  S.runTwoPlayers = function (limitMs) { var two = GCP.test.twoPlayers; return runScript(pairFn, limitMs, 'two-player check', two ? two.role : 'host'); };
  /** Every GCP.room this page opened: its id, the host, the peers it knows, and how much arrived (messages, createWorldSync ops, state snapshots). */
  S.roomInfo = function () { return (S.rooms || []).map(function (f) { try { return f(); } catch (e) { return null; } }).filter(Boolean); };
  /** Every GCP.match.find this page made: the lobby code, its phase, this player's id, who the lobby listed, the match's players. */
  S.matchInfo = function () { return (S.matches || []).map(function (f) { try { return f(); } catch (e) { return null; } }).filter(Boolean); };
  function runScript(fn, limitMs, what, arg) {
    if (!fn) return Promise.resolve({ ran: false });
    var steps = [], t0 = performance.now(), frames0 = S.frames, over = false;
    var wait = function (ms) { return new Promise(function (r) { setTimeout(r, Math.max(0, +ms || 0)); }); };
    var until = function (fn, timeoutMs, label) {
      var end = performance.now() + (timeoutMs || 5000);
      return new Promise(function (res, rej) {
        (function poll() {
          var v; try { v = fn(); } catch (e) { return rej(e); }
          if (v) return res(v);
          if (over || performance.now() > end) return rej(new Error('Timed out waiting for ' + (label || 'a condition') + ' (' + Math.round((timeoutMs || 5000) / 1000) + ' s).'));
          setTimeout(poll, 30);
        })();
      });
    };
    var t = {
      /** Names what is about to be tried. The report lists the steps, and a failure names the last one. */
      step: function (label) { if (steps.length < 60) steps.push(String(label).slice(0, 120)); },
      assert: function (cond, message) { if (!cond) throw new Error(String(message || 'Assertion failed')); },
      wait: wait,
      /** Resolves after n more frames have been drawn. Fails if the loop has stopped. */
      frames: function (n) { var target = S.frames + (n || 1); return until(function () { return S.frames >= target; }, 8000, (n || 1) + ' more frame(s)'); },
      until: until,
      /** Presses a key by its physical code ('KeyW', 'Space', 'ArrowLeft') the way a keyboard would, held for holdMs. */
      key: function (code, holdMs) {
        var key = code === 'Space' ? ' ' : /^Key[A-Z]$/.test(code) ? code.slice(3).toLowerCase() : /^Digit\d$/.test(code) ? code.slice(5) : code;
        var fire = function (type) { var e = new KeyboardEvent(type, { code: code, key: key, bubbles: true, cancelable: true }); (document.activeElement || document.body).dispatchEvent(e); };
        fire('keydown'); return wait(holdMs == null ? 120 : holdMs).then(function () { fire('keyup'); });
      },
    };
    var out = function (ok, error, result) { over = true; return { ran: true, ok: ok, error: error || '', steps: steps, ms: Math.round(performance.now() - t0), frames: S.frames - frames0, result: result === undefined ? null : result }; };
    var limit = new Promise(function (r) { setTimeout(function () { r(out(false, 'The ' + what + ' did not finish within ' + Math.round(limitMs / 1000) + ' s.')); }, limitMs); });
    var run; try { run = Promise.resolve(fn(t, arg)); } catch (e) { run = Promise.reject(e); }
    return Promise.race([limit, run.then(function (v) { return out(true, '', v); }, function (e) { return out(false, String(e && e.message || e).slice(0, 400)); })]);
  }
  // Display state, sent by the platform page (see GCP.display). The <html> element carries gcp-fullscreen and gcp-touch classes to match.
  var coarse = false; try { coarse = matchMedia('(pointer: coarse)').matches && matchMedia('(hover: none)').matches; } catch (e) { /* old browser */ }
  // safe: the screen's notch, rounded corners and home indicator, in CSS px, as the platform page measures them. An iframe
  // never gets safe-area insets of its own (env(safe-area-inset-*) is always 0 in a frame), so they come from the page,
  // also as the CSS variables --gcp-safe-top/right/bottom/left on <html>.
  var display = { fullscreen: false, mode: 'inline', orientation: 'any', touch: coarse, edgeToEdge: false, safe: { top: 0, right: 0, bottom: 0, left: 0 }, paused: false, menu: false }, displayFns = [];
  function markDisplay() {
    var h = document.documentElement, c = h && h.classList; if (!c) return; c.toggle('gcp-fullscreen', display.fullscreen); c.toggle('gcp-touch', display.touch);
    ['top', 'right', 'bottom', 'left'].forEach(function (k) { h.style.setProperty('--gcp-safe-' + k, (display.safe[k] || 0) + 'px'); });
  }
  markDisplay();
  // In the platform's player, swipes and pinches must reach the game and never the page: a pinch or an overscroll can
  // otherwise zoom the game or drop the browser out of fullscreen on phones and tablets. Panning stays allowed, so a game's
  // own scrolling lists keep working.
  var guardCss = 'html.gcp-guard,html.gcp-guard body{overscroll-behavior:none;touch-action:pan-x pan-y;-webkit-touch-callout:none;-webkit-text-size-adjust:100%}';
  function guard() {
    var on = display.fullscreen && display.touch, h = document.documentElement; if (!h || !h.classList) return;
    h.classList.toggle('gcp-guard', on);
    if (on && document.head && !document.getElementById('gcp-guard')) { var st = document.createElement('style'); st.id = 'gcp-guard'; st.textContent = guardCss; document.head.appendChild(st); }
  }
  var noPinch = function (e) { if (display.fullscreen && display.touch && e.cancelable) e.preventDefault(); };
  try { document.addEventListener('gesturestart', noPinch, { passive: false }); document.addEventListener('gesturechange', noPinch, { passive: false }); } catch (e) { /* old browser */ }
  function toParent(msg) { if (window.parent !== window) { try { parent.postMessage(msg, '*'); } catch (e) { /* not framed */ } } }
  var escFn = null;
  function runEscape(e) {
    var used = false; try { used = escFn() === true; } catch (err) { console.error(err); }
    if (e && (used || display.fullscreen)) e.preventDefault();
    if (used) return;
    if (display.fullscreen) toParent({ gcp: 'menu', on: true });   // nothing of the game's was open: the platform menu
  }
  // ---- GPU warm-up. Every page in the browser shares one GPU process, so a game that builds all its shaders and uploads
  // all its textures in one go stalls the GPU for everything else, the platform page around it included, until it is done.
  // Done here for every game, so no game has to know about it:
  //   - every WebGL context asks for KHR_parallel_shader_compile, so the browser builds shaders on worker threads;
  //   - three.js renderers are found as they are made (three announces them to __THREE_DEVTOOLS__). While the game is
  //     loading (before GCP.ready(), or while GCP.progress() is below 1 after it), a draw to the screen whose scene holds
  //     materials not built yet is held back: those are compiled a few at a time with compileAsync, with a pause between
  //     batches, and their textures are uploaded a few at a time; then the frame is drawn. Draws into render targets are
  //     never held back, because a game may read them back at once.
  // GCP.gpu.auto = false (set before the renderer is made) turns the automatic part off; GCP.gpu.warmup() and
  // GCP.gpu.upload() do the same work on request, for a level loaded later or for an engine the platform does not know.
  var GPU = { auto: true, stats: { held: 0, compiled: 0, uploaded: 0, batches: 0, ms: 0, skipped: '' } };
  S.gpu = GPU.stats;
  var BATCH = 4, REST_MS = 16, BIG_TEXELS = 512 * 512, WARM_CAP_MS = 12000;
  var pause = function (ms) { return new Promise(function (r) { setTimeout(r, ms == null ? REST_MS : ms); }); };
  function parallel(ctx) { try { if (ctx && typeof ctx.getExtension === 'function') ctx.getExtension('KHR_parallel_shader_compile'); } catch (e) { /* not WebGL */ } }
  [window.HTMLCanvasElement, window.OffscreenCanvas].forEach(function (C) {
    if (!C || !C.prototype.getContext) return;
    var get = C.prototype.getContext;
    C.prototype.getContext = function (type) { var ctx = get.apply(this, arguments); if (ctx && /^(webgl|experimental-webgl)/.test(String(type))) parallel(ctx); return ctx; };
  });

  function texturesOf(m, out) {
    var add = function (v) { if (v && v.isTexture && !v.isRenderTargetTexture && out.indexOf(v) < 0) out.push(v); };
    for (var k in m) { if (k !== 'uniforms' && Object.prototype.hasOwnProperty.call(m, k)) add(m[k]); }
    if (m.uniforms) for (var u in m.uniforms) { var v = m.uniforms[u] && m.uniforms[u].value; if (Array.isArray(v)) v.forEach(add); else add(v); }
  }
  function texels(t) { var i = t.image; if (!i) return 0; if (Array.isArray(i)) i = i[0] || {}; return (i.width || 0) * (i.height || 0) * (i.depth || 1); }
  /** Upload textures a few at a time (one at a time when large), with a pause between, instead of all on the first frame. */
  function upload(renderer, list) {
    if (!renderer || typeof renderer.initTexture !== 'function') return Promise.resolve();
    var seen = renderer.__gcpTex || (renderer.__gcpTex = new WeakSet());
    var todo = list.filter(function (t) { return t && t.isTexture && !seen.has(t) && t.image; });
    return todo.reduce(function (p, t, i) {
      return p.then(function () {
        seen.add(t); try { renderer.initTexture(t); GPU.stats.uploaded++; } catch (e) { /* uploaded on first use instead */ }
        return texels(t) >= BIG_TEXELS || i % BATCH === BATCH - 1 ? pause() : null;
      });
    }, Promise.resolve());
  }
  /** Take any link wait still outstanding now, in small pieces (only matters without KHR_parallel_shader_compile). */
  function settle(renderer) {
    try {
      var gl = renderer.getContext(), done = renderer.__gcpSettled || (renderer.__gcpSettled = new WeakSet());
      (renderer.info && renderer.info.programs || []).forEach(function (pr) { if (pr && pr.program && !done.has(pr)) { done.add(pr); gl.getProgramParameter(pr.program, gl.LINK_STATUS); } });
    } catch (e) { /* context lost */ }
  }
  /** The meshes in a scene whose material this renderer has not warmed yet. */
  function fresh(renderer, scene) {
    var warm = renderer.__gcpWarm || (renderer.__gcpWarm = new WeakSet()), out = [];
    scene.traverseVisible(function (o) {
      if (!o.material) return;
      var ms = Array.isArray(o.material) ? o.material : [o.material];
      for (var i = 0; i < ms.length; i++) if (ms[i] && !warm.has(ms[i])) { out.push(o); return; }
    });
    return out;
  }
  /** Compile what a scene needs and upload its textures, a few objects at a time, without blocking the GPU process. */
  function warmup(renderer, scene, camera) {
    if (!renderer || !scene || typeof renderer.compileAsync !== 'function') return Promise.resolve();
    var t0 = performance.now(), objs = fresh(renderer, scene), warm = renderer.__gcpWarm, target = renderer.getRenderTarget ? renderer.getRenderTarget() : null;
    if (!objs.length) return Promise.resolve();
    var batches = [], cur = [];
    objs.forEach(function (o) { cur.push(o); if (cur.length >= BATCH) { batches.push(cur); cur = []; } });
    if (cur.length) batches.push(cur);
    return batches.reduce(function (p, b) {
      return p.then(function () {
        if (performance.now() - t0 > WARM_CAP_MS) { GPU.stats.skipped = 'time cap'; return; }
        // compile into the same target the game was drawing to, so the programs built are the ones it will use
        var prev = renderer.getRenderTarget ? renderer.getRenderTarget() : null;
        if (renderer.setRenderTarget && prev !== target) renderer.setRenderTarget(target);
        var jobs = b.map(function (o) { return renderer.compileAsync(o, camera, scene).catch(function () { }); });
        if (renderer.setRenderTarget && prev !== target) renderer.setRenderTarget(prev);
        return Promise.all(jobs).then(function () {
          settle(renderer); GPU.stats.batches++;
          var tex = [];
          b.forEach(function (o) { (Array.isArray(o.material) ? o.material : [o.material]).forEach(function (m) { if (m) { if (!warm.has(m)) GPU.stats.compiled++; warm.add(m); texturesOf(m, tex); } }); });
          return upload(renderer, tex);
        }).then(function () { return pause(); });
      });
    }, Promise.resolve()).then(function () { GPU.stats.ms += Math.round(performance.now() - t0); });
  }
  function gate(renderer) {
    if (!renderer || renderer.__gcpGate || typeof renderer.render !== 'function' || typeof renderer.compileAsync !== 'function' || !renderer.isWebGLRenderer) return;
    var render = renderer.render, job = null, last = null, drew = 0;
    renderer.__gcpGate = true;
    renderer.render = function (scene, camera) {
      var loading = !S.ready || S.busy;
      if (!GPU.auto || !loading || !scene || !scene.isObject3D || (renderer.xr && renderer.xr.isPresenting) || (renderer.getRenderTarget && renderer.getRenderTarget() !== null)) { drew++; return render.apply(this, arguments); }
      if (!job && fresh(renderer, scene).length) {
        job = warmup(renderer, scene, camera).catch(function () { }).then(function () {
          job = null;
          // a game that draws only when something changes gets the frame it asked for
          var n = drew; requestAnimationFrame(function () { if (drew === n && last) { var prev = renderer.getRenderTarget(); renderer.setRenderTarget(null); renderer.render(last[0], last[1]); renderer.setRenderTarget(prev); } });
        });
      }
      if (job) { GPU.stats.held++; last = [scene, camera]; return; }
      drew++; return render.apply(this, arguments);
    };
  }
  try {
    var dt = window.__THREE_DEVTOOLS__;
    if (!dt) { dt = new EventTarget(); Object.defineProperty(window, '__THREE_DEVTOOLS__', { value: dt, writable: true, configurable: true }); }
    dt.addEventListener('observe', function (e) { var o = e.detail; if (o && o.isWebGLRenderer) gate(o); });
  } catch (e) { /* no EventTarget: the helpers below still work */ }
  GPU.warmup = function (renderer, scenes, camera) {
    var list = Array.isArray(scenes) ? scenes : [scenes];
    return list.reduce(function (p, sc) { return p.then(function () { return warmup(renderer, sc, camera); }); }, Promise.resolve());
  };
  GPU.upload = upload;

  // GCP.resume.set may be called every frame by mistake: at most one call reaches the platform every 5 seconds (the
  // latest value wins), and a waiting value is sent at once when the tab is hidden.
  var resumeNext = null, resumeTimer = 0, resumeLast = 0;
  function resumeFlush() {
    clearTimeout(resumeTimer); resumeTimer = 0;
    if (!resumeNext) return Promise.resolve(true);
    var b = resumeNext; resumeNext = null; resumeLast = Date.now();
    return api('resume', b).then(function () { return true; }).catch(function () { return false; });
  }
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden' && resumeNext) resumeFlush(); });

  // The platform language can change while the game runs (the player picks another one on the page around it): GCP.lang
  // follows, the address keeps it (a game that reloads itself opens in it), and GCP.onLang handlers hear about it.
  var langFns = [];
  function setLang(raw) {
    var l = String(raw || '').slice(0, 20);
    if (!/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(l) || l === GCP.lang) return;
    var was = GCP.lang; GCP.lang = l;
    try { var u = new URLSearchParams(location.search); u.set('gcp_lang', l); history.replaceState(history.state, '', location.pathname + '?' + u + location.hash); } catch (e) { /* sandboxed */ }
    langFns.slice().forEach(function (fn) { try { fn(l, was); } catch (err) { console.error(err); } });
  }
  var GCP = window.GCP = {
    sdk: 1,
    env: cfg.env, gameId: cfg.gameId, version: cfg.version, player: cfg.player, standalone: standalone,
    /** The player's platform language as a BCP 47 tag (en, zh, zh-TW, ja, ko, es), from ?gcp_lang or the browser. A game that
        declares languages.follows_platform in gcp.json opens in this language when it has it, and otherwise in its default. */
    lang: String(q.get('gcp_lang') || (navigator.language || 'en')).slice(0, 20),
    /** fn(lang, previous) when the player switches the platform language while the game is running (same codes as GCP.lang,
        which is already updated when fn runs). The game keeps running either way: a game that can switch its text live
        does it here; a game that cannot ignores it and picks up the new language the next time it is opened. Returns a
        function that stops listening. */
    onLang: function (fn) {
      if (typeof fn !== 'function') return function () { };
      langFns.push(fn);
      return function () { var i = langFns.indexOf(fn); if (i >= 0) langFns.splice(i, 1); };
    },
    /** Loading progress, 0..1, shown in verification reports. Called again after ready() (loading a world or a level), it
        tells the platform the game is on a loading screen until it reaches 1, so the version's picture waits for play. */
    progress: function (f, label) { P.progress++; S.progress = Math.max(0, Math.min(1, +f || 0)); if (label != null) S.label = String(label).slice(0, 120); if (S.ready) S.busy = S.progress < 1; },
    /** Call once when the first playable frame is on screen. Required. */
    ready: function (info) {
      if (S.ready) return; S.ready = true; S.readyAt = performance.now(); S.progress = 1; if (info) S.stats = info;
      if (GCP.test.autostart) setTimeout(function () { autostartFns.forEach(function (fn) { try { fn(); } catch (e) { note(S.errors, 'autostart hook threw: ' + (e && e.message || e)); } }); }, 0);
      if (!standalone) { api('beat', { frames: S.frames, active: false, first: true, loadMs: Math.round(S.readyAt - S.boot) }).then(onBeat).catch(function () { }); }
    },
    /** GPU warm-up (see above): automatic for three.js while loading; warmup(renderer, scene|scenes, camera) and upload(renderer, textures) on request. */
    gpu: GPU,
    /** Call when the game cannot start. Shows up as the failure reason in verification. */
    fatal: function (err) { S.fatal = String(err && (err.stack || err.message) || err).slice(0, 1000); console.error('[fatal] ' + S.fatal); },
    /** Optional numbers for reports and the console (draw calls, triangles, quality, …). */
    stats: function (obj) { S.stats = obj; },
    /** Per-player cloud saves (JSON, 256 KB per key). Falls back to localStorage offline. */
    save: {
      get: function (key) { return api('save', { op: 'get', key: key }).then(function (r) { if (r.value != null) LS.set(key, r.value); return r.value; }).catch(function () { return LS.get(key); }); },
      set: function (key, value) { LS.set(key, value); return api('save', { op: 'set', key: key, value: value }).then(function () { return true; }).catch(function () { return false; }); },
      remove: function (key) { LS.del(key); return api('save', { op: 'delete', key: key }).then(function () { return true; }).catch(function () { return false; }); },
    },
    /** Named numbers kept per player and game: add (default +1), max, min, set. Each resolves to the stored value, or null offline. */
    playerStats: {
      add: function (name, n) { return api('stats', { op: 'add', name: name, value: n == null ? 1 : +n }).then(function (r) { return r.value; }).catch(function () { return null; }); },
      max: function (name, v) { return api('stats', { op: 'max', name: name, value: +v }).then(function (r) { return r.value; }).catch(function () { return null; }); },
      min: function (name, v) { return api('stats', { op: 'min', name: name, value: +v }).then(function (r) { return r.value; }).catch(function () { return null; }); },
      set: function (name, v) { return api('stats', { op: 'set', name: name, value: +v }).then(function (r) { return r.value; }).catch(function () { return null; }); },
      get: function (name) { return api('stats', { op: 'get', name: name }).then(function (r) { return r.value; }).catch(function () { return null; }); },
      all: function () { return api('stats', { op: 'all' }).then(function (r) { return r.stats; }).catch(function () { return {}; }); },
    },
    /** What the platform recorded for this player in this game: sessions, play seconds, first and last played, stats, best scores. */
    playRecord: function () { return api('record', {}).catch(function () { return null; }); },
    /** How the player opened the game. continue is true when they pressed Continue on the platform (their Continue row,
        library or the game page after playing before): skip the title screen and load their saved run if there is one. */
    launch: { continue: q.get('gcp_continue') === '1' },
    /** Where the player left off, shown on their Continue row and library. Optional; games without it still appear there.
        set({ label: 'Act 2, Floor 14', detail?: 'Ember Knight, 3 relics', progress?: 0..1 }) at checkpoints; clear() when
        the run ends and there is nothing to resume; get() returns what was last set, or null. */
    resume: {
      set: function (info) {
        if (!info || typeof info !== 'object') info = { label: info };
        resumeNext = { op: 'set', label: info.label, detail: info.detail, progress: info.progress };
        var wait = Math.max(0, 5000 - (Date.now() - resumeLast));
        if (!wait) return resumeFlush();
        if (!resumeTimer) resumeTimer = setTimeout(resumeFlush, wait);
        return Promise.resolve(true);
      },
      clear: function () { resumeNext = null; clearTimeout(resumeTimer); resumeTimer = 0; return api('resume', { op: 'clear' }).then(function () { return true; }).catch(function () { return false; }); },
      get: function () { return api('resume', { op: 'get' }).then(function (r) { return r.resume; }).catch(function () { return null; }); },
    },
    /** Game-wide data every player can read. Written only by the game's server code. */
    shared: { get: function (key) { return api('save', { op: 'get', key: key, shared: true }).then(function (r) { return r.value; }).catch(function () { return null; }); } },
    leaderboard: {
      /** Keeps each player's best score per board. order: 'desc' (default, higher is better) or 'asc'. */
      submit: function (board, score, order) { return api('score', { op: 'submit', board: board, score: +score, order: order || 'desc' }).catch(function () { return null; }); },
      top: function (board, limit, order) { return api('score', { op: 'top', board: board, limit: limit || 10, order: order || 'desc' }).then(function (r) { return r.rows; }).catch(function () { return []; }); },
    },
    /** Realtime room on the platform (Durable Object WebSocket relay). First player in is the host. */
    room: function (code, opts) { return new Room(String(code || 'lobby').slice(0, 40), opts); },
    /** Server-run matches: the game's server/match.js runs the match at a fixed tick on the platform, near the players. */
    match: {
      /** Finds a match: { queue, players, min, teams, mode, code, predict(me, input, dt, state), entities(view), angles, delay }. */
      find: function (opts) { return new Match(opts); },
    },
    /** A playback buffer for one remote stream (a host's snapshots, one player's position): push(value, meta.at) when a message
        arrives, value() or sample() every frame. Movement comes out smooth on a jittery connection. Options: delay (fixed ms;
        adaptive when left out), minDelay, maxDelay, extrapolate (ms to keep moving past the newest sample). */
    smooth: function (opts) { return new Smooth(opts); },
    /** Calls the game's own server code (server/index.js in the bundle) with the player's identity attached. Returns a fetch Response. */
    server: function (path, init) {
      init = init || {}; var h = new Headers(init.headers || {}); if (cfg.token) h.set('x-gcp-token', cfg.token);
      return fetch((cfg.base || '') + '/api/' + String(path || '').replace(/^\/+/, ''), Object.assign({}, init, { headers: h }));
    },
    /** True when the platform is taking the game's picture (?gcp_portrait=1): draw at full quality, as on a device with a
        graphics card, even if this browser is slow. createStage() from the craft blocks does this by itself. */
    portrait: q.has('gcp_portrait'),
    /** Hooks the verifier uses; games may use them for their own automated tests too. */
    test: {
      autostart: q.has('gcp_autostart'),
      seed: q.get('gcp_seed'),
      param: function (name) { return q.get(name); },
      /** Register a function that skips menus and drops straight into play. Called after ready() when ?gcp_autostart is set. */
      onAutostart: function (fn) { autostartFns.push(fn); },
      onStart: function (fn) { autostartFns.push(fn); },   // same thing, shorter name
      /** Register one async function that plays the game to its end by itself: fn(t) with t.step, t.assert, t.wait, t.frames, t.until, t.key.
          The verifier runs it after the game is ready and fails the version if it throws. Optional, and worth having. */
      onPlaythrough: function (fn) { playFn = typeof fn === 'function' ? fn : null; S.playthrough = !!playFn; },
      /** For a game with rooms. The verifier opens the game in two pages with ?gcp_two=host and ?gcp_two=guest and the same ?gcp_room=CODE;
          GCP.test.twoPlayers is then { role, code } (otherwise null), so the autostart hook can host or join that room instead of playing alone.
          Register one async function fn(t, role) that waits for the other player, changes the world a little and returns
          { players: how many this page sees (itself included), world: a string that is equal in both pages when their worlds agree }.
          The verifier runs it in both pages at once and fails the version if either throws, sees fewer than two players, or the worlds differ. */
      twoPlayers: q.get('gcp_two') ? { role: q.get('gcp_two') === 'guest' ? 'guest' : 'host', code: String(q.get('gcp_room') || 'VERIFY').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8) || 'VERIFY' } : null,
      onTwoPlayers: function (fn) { pairFn = typeof fn === 'function' ? fn : null; S.twoPlayers = !!pairFn; },
      /** Register fn() returning a small JSON-able object that says where the game is right now (level, scene, the
          player's position, score, open menu…). It is attached to the screenshots the creator sends their agent from the
          preview, and debug_preview returns it with every screenshot, so the agent can tell what the picture shows.
          Keep it under 4 KB; it is never called for players. */
      onState: function (fn) { stateFn = typeof fn === 'function' ? fn : null; },
    },
    /** Open (true), close (false) or toggle (no argument) the platform's menu in the player: Resume and Quit game. Give your
        own pause screen a button for it when the game hides the platform's menu button (setDisplay({ exitButton: 'none' })). */
    menu: function (on) { var msg = { gcp: 'menu' }; if (on === true || on === false) msg.on = on; toParent(msg); },
    /** Quit: the player closes and the player is back on the game's page. Save first. */
    quit: function () { toParent({ gcp: 'quit' }); },
    /** Ask the platform page for fullscreen (works inside the play frame, and on iPhones, where the game is given the whole
        visible screen instead). No argument toggles; true enters; false goes back to the window on the page. Call it from a
        tap or key press. The player also has a Fullscreen button and Alt+Enter, and phones start in fullscreen. */
    fullscreen: function (on) {
      var msg = { gcp: 'fullscreen' }; if (on === true || on === false) msg.on = on;
      if (window.parent !== window) { try { parent.postMessage(msg, '*'); } catch (e) { /* not framed */ } return; }
      var d = document, el = d.documentElement;   // standalone: the page itself
      if (d.fullscreenElement) { if (on !== true) d.exitFullscreen().catch(function () { }); }
      else if (on !== false && el.requestFullscreen) el.requestFullscreen().catch(function () { });
    },
    /** How the game is shown right now. Kept up to date by the platform page:
        { fullscreen, mode: 'inline' | 'fullscreen' | 'immersive', orientation: 'any' | 'landscape' | 'portrait', touch, edgeToEdge, safe,
        paused, menu }. paused is true while the player cannot play: the platform menu is open (menu is then true too) or the
        game stopped answering and the not-responding card is up. Pause the game's clock and sound while it lasts.
        touch is true on phones and tablets (a finger is the main pointer): show on-screen controls then. edgeToEdge is true
        while the frame covers the whole screen, notch included (see setDisplay); safe is then { top, right, bottom, left } in
        CSS px: keep buttons and text that far in from each edge (also the CSS variables --gcp-safe-top and so on). */
    display: display,
    /** fn(display) whenever it changes (entering or leaving fullscreen, for example). */
    onDisplay: function (fn) { if (typeof fn === 'function') displayFns.push(fn); },
    /** The Escape rule: Esc never drops the player out of the game. It first closes whatever the game has open, and an Esc
        with nothing open opens the platform menu (Resume, Quit game). Register fn(); it is called on every Esc press and
        returns true when the game used the key (it closed a menu, a dialog, a map…). A game that registers nothing and
        calls preventDefault() on its own Esc keydown keeps the key too. In fullscreen the platform asks the browser to send
        Esc to the game (the Keyboard Lock API, Chromium browsers; holding Esc still leaves). Firefox and Safari leave
        fullscreen on Esc whatever the page does: the game then carries on in its window on the page. */
    onEscape: function (fn) {
      escFn = typeof fn === 'function' ? fn : null;
      toParent({ gcp: 'escape', on: !!escFn });
    },
    /** Preferences for the player around the game: { orientation: 'landscape' | 'portrait' | 'any' (overrides the declared
        requirement; the platform locks the screen to it in fullscreen where the browser allows, and asks the player to
        turn the phone where it does not), exitButton: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right' | 'none'
        (where the platform's small exit-fullscreen button sits on touch screens; 'none' if the game has its own),
        edgeToEdge: true (in fullscreen the game covers the whole screen, under the notch and the rounded corners too, and
        keeps its own buttons inside display.safe; left out, the platform keeps the whole frame clear of them, which leaves
        black bars on phones with a notch) }. */
    setDisplay: function (prefs) { prefs = prefs || {}; try { parent.postMessage({ gcp: 'display_prefs', orientation: prefs.orientation, exitButton: prefs.exitButton, edgeToEdge: prefs.edgeToEdge }, '*'); } catch (e) { /* not framed */ } },
  };
  window.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !e.repeat && escFn) runEscape(e); }, true);
  // A game without onEscape: an Esc it did not take for itself (preventDefault) opens the platform menu.
  // Alt+Enter toggles the player's fullscreen, the shortcut PC games use (the page around the game cannot hear keys
  // pressed in it; the key press counts as the player's gesture there too).
  window.addEventListener('keydown', function (e) { if (e.key === 'Enter' && e.altKey && !e.repeat && window.parent !== window) { e.preventDefault(); toParent({ gcp: 'fullscreen' }); } }, true);
  // Checked once the key has reached every listener of the game, wherever it registered.
  window.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape' || e.repeat || escFn || !display.fullscreen) return;
    setTimeout(function () { if (!e.defaultPrevented) toParent({ gcp: 'menu', on: true }); }, 0);
  });
  // ---- creator feedback: the console asks for a picture of the game while its creator plays the preview. Only on the
  // preview, only for the game's owner, only when the platform's own page asks. The picture is what the creator sees:
  //   - every canvas is copied right after the game drew a frame (a WebGL canvas still holds that frame then, whatever
  //     its settings), so the picture is one frame, frozen;
  //   - when page elements are showing too (an HTML menu, a collection page, a HUD), the page is redrawn with them at
  //     that same moment: each element with the styles it has right now (animations stopped where they are), each
  //     canvas replaced by its copy. Where the browser refuses that (some Safari versions) the canvases alone are sent,
  //     and the console says page elements are missing.
  var platformOrigin = ''; try { platformOrigin = new URL(cfg.api || location.origin, location.href).origin; } catch (e) { /* no platform */ }
  var fpsAt = 0, fpsN = 0, fpsNow = 0;
  frameHooks.push(function () { var t = performance.now(); fpsN++; if (!fpsAt) fpsAt = t; if (t - fpsAt >= 1000) { fpsNow = Math.round(fpsN * 1000 / (t - fpsAt)); fpsN = 0; fpsAt = t; } });
  var shown = function (el, st) { st = st || getComputedStyle(el); return st.display !== 'none' && st.visibility !== 'hidden' && +st.opacity !== 0; };
  function onScreen(r, vw, vh) { return r.width >= 2 && r.height >= 2 && r.right > 0 && r.bottom > 0 && r.left < vw && r.top < vh; }
  /** Whether anything besides the canvases shows on screen: text, pictures, or a painted box that does not hold a canvas. */
  function pageShowsElements(vw, vh) {
    var cs = document.querySelectorAll('canvas'), all = document.body ? document.body.getElementsByTagName('*') : [], n = 0;
    for (var i = 0; i < all.length && n < 3000; i++, n++) {
      var el = all[i], tag = el.tagName;
      if (tag === 'CANVAS' || tag === 'SCRIPT' || tag === 'STYLE') continue;
      var r = el.getBoundingClientRect(); if (!onScreen(r, vw, vh)) continue;
      var st = getComputedStyle(el); if (!shown(el, st)) continue;
      if (tag === 'IMG' || tag === 'VIDEO' || tag === 'svg' || tag === 'INPUT' || tag === 'BUTTON') return true;
      for (var c = el.firstChild; c; c = c.nextSibling) if (c.nodeType === 3 && c.nodeValue.trim()) return true;
      var holds = false; for (var j = 0; j < cs.length; j++) if (el.contains(cs[j])) { holds = true; break; }
      if (!holds && (!/rgba\(0, 0, 0, 0\)|transparent/.test(st.backgroundColor) || st.backgroundImage !== 'none')) return true;
    }
    return false;
  }
  /**
   * The page as it is now, drawn through an SVG picture of its elements. snaps: canvas -> data URL of its frozen frame.
   * Each element is copied with the styles it has at this moment; SVG icons element by element (fills and strokes set by
   * the game's style sheet, gradients, currentColor), ::before and ::after as elements of their own, and the pictures and
   * fonts the page uses from its own site embedded, since a picture drawn this way cannot load files.
   */
  function domPicture(snaps, vw, vh, w, h, bg, done) {
    var doc = document.implementation.createHTMLDocument(''), n = 0, imgs = 0, SKIP = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, LINK: 1, META: 1, TEMPLATE: 1, IFRAME: 1, OBJECT: 1, EMBED: 1 };
    var SVGNS = 'http://www.w3.org/2000/svg', here = location.href.split('#')[0], files = {}, nfiles = 0;
    var SVGPROPS = ['fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-opacity', 'stroke-dasharray', 'stroke-dashoffset', 'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit', 'opacity', 'visibility', 'display', 'color', 'stop-color', 'stop-opacity', 'transform', 'transform-origin', 'transform-box', 'rotate', 'scale', 'translate', 'filter', 'clip-path', 'clip-rule', 'mask', 'mix-blend-mode', 'font-family', 'font-size', 'font-weight', 'font-style', 'letter-spacing', 'text-anchor', 'dominant-baseline', 'paint-order', 'vector-effect', 'marker-start', 'marker-mid', 'marker-end', 'flood-color', 'flood-opacity', 'lighting-color', 'shape-rendering'];
    // url(...) in a style: a reference into this page (an SVG gradient, a filter) becomes url(#id); a file of this site is
    // fetched below and embedded; anything else is left out
    function urls(v) {
      return v.replace(/url\(\s*(["']?)(.*?)\1\s*\)/g, function (all, q, u) {
        if (/^data:/.test(u)) return all;
        var abs; try { abs = new URL(u, here).href; } catch (e) { return 'none'; }
        var i = abs.indexOf('#'); if (i >= 0 && abs.slice(0, i) === here) return 'url("' + abs.slice(i) + '")';
        if (/^https?:/.test(abs) && !files[abs] && nfiles < 60) { files[abs] = 1; nfiles++; }
        return files[abs] ? 'url("' + abs + '")' : 'none';
      });
    }
    function styleOf(src, pseudo) {
      var cs = getComputedStyle(src, pseudo), out = '';
      for (var i = 0; i < cs.length; i++) { var k = cs[i]; if (/^(animation|transition)/.test(k)) continue; var v = cs.getPropertyValue(k); if (v.indexOf('url(') >= 0) v = urls(v); out += k + ':' + v + ';'; }
      return out + 'animation:none;transition:none;';
    }
    function svgStyleOf(src) {
      var cs = getComputedStyle(src), out = '';
      for (var i = 0; i < SVGPROPS.length; i++) { var v = cs.getPropertyValue(SVGPROPS[i]); if (!v) continue; if (v.indexOf('url(') >= 0) v = urls(v); out += SVGPROPS[i] + ':' + v + ';'; }
      return out + 'animation:none;transition:none;';
    }
    function pictureOf(el) {   // an <img> or a <video> frame, as a data URL (same-site files only)
      if (++imgs > 80) return '';
      try { var c = document.createElement('canvas'), iw = el.naturalWidth || el.videoWidth, ih = el.naturalHeight || el.videoHeight; if (!iw || !ih) return ''; var k = Math.min(1, 1024 / Math.max(iw, ih)); c.width = Math.max(1, Math.round(iw * k)); c.height = Math.max(1, Math.round(ih * k)); c.getContext('2d').drawImage(el, 0, 0, c.width, c.height); return c.toDataURL('image/png'); } catch (e) { return ''; }
    }
    // an SVG element and everything in it, each with its own computed styles (the page's style sheet is not in the picture)
    function copySvg(src, top) {
      if (src.nodeType === 3) return doc.createTextNode(src.nodeValue);
      if (src.nodeType !== 1 || src.tagName === 'script' || ++n > 6000) return null;
      var el = doc.importNode(src, false);
      el.setAttribute('style', top ? styleOf(src) : svgStyleOf(src));
      var href = src.getAttribute('href') || src.getAttributeNS('http://www.w3.org/1999/xlink', 'href');
      if (href && src.tagName === 'image') { var hu = urls('url("' + href + '")').match(/^url\("(.*)"\)$/); if (hu) el.setAttribute('href', hu[1]); else el.removeAttribute('href'); el.removeAttributeNS('http://www.w3.org/1999/xlink', 'href'); }
      for (var c = src.firstChild; c; c = c.nextSibling) { var k = copySvg(c, false); if (k) el.appendChild(k); }
      return el;
    }
    // ::before / ::after, as a span with the pseudo-element's styles and text
    function pseudo(src, which) {
      var cs; try { cs = getComputedStyle(src, which); } catch (e) { return null; }
      var content = cs.getPropertyValue('content');
      if (!content || content === 'none' || content === 'normal' || cs.display === 'none') return null;
      var el = doc.createElement('span'), text = '', m, re = /"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'/g;
      while ((m = re.exec(content))) text += (m[1] !== undefined ? m[1] : m[2]).replace(/\\([0-9a-fA-F]{1,6}) ?/g, function (a, hx) { return String.fromCodePoint(parseInt(hx, 16)); }).replace(/\\(.)/g, '$1');
      el.setAttribute('style', styleOf(src, which));
      if (text) el.textContent = text;
      return el;
    }
    function copy(src) {
      if (src.nodeType === 3) return doc.createTextNode(src.nodeValue);
      if (src.nodeType !== 1 || SKIP[src.tagName] || ++n > 6000) return null;
      var st = getComputedStyle(src); if (st.display === 'none') return null;
      var tag = src.tagName, el;
      if (src.namespaceURI === SVGNS) return copySvg(src, true);
      if (tag === 'CANVAS' || tag === 'IMG' || tag === 'VIDEO') {
        el = doc.createElement('img'); var u = tag === 'CANVAS' ? snaps.get(src) || '' : pictureOf(src);
        if (u) el.setAttribute('src', u); el.setAttribute('style', styleOf(src)); return el;
      }
      el = doc.createElement(tag === 'BODY' ? 'div' : tag.toLowerCase());
      el.setAttribute('style', styleOf(src));
      if (tag === 'INPUT') { el.setAttribute('value', src.value); if (src.checked) el.setAttribute('checked', ''); }
      if (tag === 'TEXTAREA') el.textContent = src.value;
      var b = pseudo(src, '::before'); if (b) el.appendChild(b);
      for (var c = src.firstChild; c; c = c.nextSibling) { var k = copy(c); if (k) el.appendChild(k); }
      var a = pseudo(src, '::after'); if (a) el.appendChild(a);
      return el;
    }
    // the fonts the page loaded from its style sheets, so text keeps its typeface
    function fontRules() {
      var out = [];
      try {
        for (var i = 0; i < document.styleSheets.length; i++) {
          var sh = document.styleSheets[i], rules; try { rules = sh.cssRules; } catch (e) { continue; }
          for (var j = 0; j < rules.length && out.length < 30; j++) {
            var r = rules[j]; if (!r.style || r.type !== 5) continue;   // CSSFontFaceRule
            var fam = r.style.getPropertyValue('font-family'), srcv = r.style.getPropertyValue('src'), m = srcv.match(/url\(\s*["']?([^"')]+)["']?\s*\)/);
            if (!fam || !m) continue;
            var abs; try { abs = new URL(m[1], sh.href || here).href; } catch (e) { continue; }
            var fmt = (srcv.match(/format\(\s*["']?([^"')]+)/) || [])[1] || '';
            out.push({ family: fam, url: abs, format: fmt, weight: r.style.getPropertyValue('font-weight'), style: r.style.getPropertyValue('font-style'), range: r.style.getPropertyValue('unicode-range') });
          }
        }
      } catch (e) { /* no fonts */ }
      return out;
    }
    var root = doc.createElement('div');
    root.setAttribute('style', 'position:relative;overflow:hidden;width:' + vw + 'px;height:' + vh + 'px;background:' + bg + ';margin-top:' + (-scrollY) + 'px;margin-left:' + (-scrollX) + 'px');
    var body = copy(document.body); if (body) root.appendChild(body);
    var xml = new XMLSerializer().serializeToString(root);
    // fonts: only those whose family the copied page names
    var fonts = fontRules().filter(function (f) { var name = f.family.replace(/^["']|["']$/g, ''); return name && xml.indexOf(name) >= 0; });
    for (var i = 0; i < fonts.length; i++) files[fonts[i].url] = 1;
    var list = Object.keys(files), got = {}, budget = 6e6, over = false;
    var giveUp = setTimeout(function () { render(); }, 3500);
    function load(u) {
      if (!/^https?:/.test(u) || new URL(u).origin !== location.origin) return Promise.resolve();   // other sites: left out
      return fetch(u, { credentials: 'same-origin' }).then(function (r) { return r.ok ? r.blob() : null; }).then(function (b) {
        if (!b || b.size > budget) return; budget -= b.size;
        return new Promise(function (ok) { var fr = new FileReader(); fr.onload = function () { got[u] = fr.result; ok(); }; fr.onerror = function () { ok(); }; fr.readAsDataURL(b); });
      }).catch(function () { /* left out */ });
    }
    Promise.all(list.map(load)).then(function () { clearTimeout(giveUp); render(); });
    function esc(s) { return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'); }
    function render() {
      if (over) return; over = true;
      var x = xml;
      x = x.replace(/url\(&quot;(https?:[^&]*?(?:&amp;[^&]*?)*)&quot;\)/g, function (all, u) { var d = got[u.replace(/&amp;/g, '&')]; return d ? 'url(&quot;' + d + '&quot;)' : 'none'; });
      x = x.replace(/ href="(https?:[^"]*)"/g, function (all, u) { var d = got[u.replace(/&amp;/g, '&')]; return d ? ' href="' + d + '"' : ''; });
      var css = fonts.filter(function (f) { return got[f.url]; }).map(function (f) {
        return '@font-face{font-family:' + f.family + ';src:url("' + got[f.url] + '")' + (f.format ? ' format("' + f.format + '")' : '') + (f.weight ? ';font-weight:' + f.weight : '') + (f.style ? ';font-style:' + f.style : '') + (f.range ? ';unicode-range:' + f.range : '') + '}';
      }).join('');
      if (css) x = x.replace(/^<div([^>]*)>/, function (all) { return all + '<style>' + esc(css).replace(/&quot;/g, '"') + '</style>'; });
      // The picture is made at the page's own size in CSS pixels and scaled when it is drawn: a foreignObject scaled by
      // the SVG itself (a viewBox other than its size, or a transform) is drawn at the wrong size or place by some
      // engines (WebKit), while drawing an SVG picture larger is something every browser does right.
      var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + vw + '" height="' + vh + '" viewBox="0 0 ' + vw + ' ' + vh + '"><foreignObject x="0" y="0" width="100%" height="100%">' + x + '</foreignObject></svg>';
      var img = new Image(), fin = false, t = setTimeout(function () { if (!fin) { fin = true; done(null); } }, 5000);
      img.onload = function () {
        if (fin) return; fin = true; clearTimeout(t);
        try { var c = document.createElement('canvas'); c.width = w; c.height = h; c.getContext('2d').drawImage(img, 0, 0, w, h); done(c.toDataURL('image/jpeg', 0.86)); } catch (e) { done(null); }
      };
      img.onerror = function () { if (!fin) { fin = true; clearTimeout(t); done(null); } };
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    }
  }
  /**
   * Where a canvas's picture is drawn on screen: inside its border and padding, and inside the bars object-fit leaves
   * (contain, scale-down) or beyond the box it crops to (cover), at its object-position. A canvas stretched to its box
   * (the default) fills it.
   */
  function canvasBox(c, r, st) {
    var px = function (v) { return parseFloat(v) || 0; };
    var x = r.left + px(st.borderLeftWidth) + px(st.paddingLeft), y = r.top + px(st.borderTopWidth) + px(st.paddingTop);
    var w = Math.max(0, r.width - px(st.borderLeftWidth) - px(st.borderRightWidth) - px(st.paddingLeft) - px(st.paddingRight));
    var h = Math.max(0, r.height - px(st.borderTopWidth) - px(st.borderBottomWidth) - px(st.paddingTop) - px(st.paddingBottom));
    var fit = st.objectFit || 'fill', iw = c.width, ih = c.height;
    if (fit === 'fill' || !iw || !ih || !w || !h) return { x: x, y: y, w: w, h: h };
    // a transformed canvas (rotate, scale) has a bounding box larger than its layout box: object-fit cannot be placed then
    if (Math.abs(r.width - c.offsetWidth) > 1 || Math.abs(r.height - c.offsetHeight) > 1) return { x: x, y: y, w: w, h: h };
    var k = fit === 'cover' ? Math.max(w / iw, h / ih) : fit === 'none' ? 1 : fit === 'scale-down' ? Math.min(1, w / iw, h / ih) : Math.min(w / iw, h / ih);
    var dw = iw * k, dh = ih * k, pos = (st.objectPosition || '50% 50%').split(/\s+/);
    var at = function (v, free) { if (/%$/.test(v)) return free * parseFloat(v) / 100; if (v === 'left' || v === 'top') return 0; if (v === 'right' || v === 'bottom') return free; if (v === 'center') return free / 2; return parseFloat(v) || 0; };
    return { x: x + at(pos[0] || '50%', w - dw), y: y + at(pos[1] || pos[0] || '50%', h - dh), w: dw, h: dh, clip: { x: x, y: y, w: w, h: h } };
  }
  // picture false: only the game's state and counters (the console took the picture itself, from the browser's tab capture)
  function captureGame(id, picture) {
    var vw = Math.max(1, innerWidth), vh = Math.max(1, innerHeight), dpr = window.devicePixelRatio || 1;
    var scale = Math.min(dpr, 1600 / vw, 1600 / vh), out = document.createElement('canvas');
    out.width = Math.round(vw * scale); out.height = Math.round(vh * scale);
    var g = out.getContext('2d'), drew = 0, done = false, timer = 0, copies = [], bg = '#000';
    try { var b = getComputedStyle(document.body).backgroundColor; if (b && !/rgba\(0, 0, 0, 0\)|transparent/.test(b)) bg = b; else { b = getComputedStyle(document.documentElement).backgroundColor; if (b && !/rgba\(0, 0, 0, 0\)|transparent/.test(b)) bg = b; } } catch (e) { /* no body */ }
    // every canvas on screen, copied as it is at this moment: the composite for the canvas-only picture, and one copy per
    // canvas for the picture of the whole page
    function compose() {
      g.fillStyle = bg; g.fillRect(0, 0, out.width, out.height); drew = 0; copies = [];
      var cs = document.querySelectorAll('canvas');
      for (var i = 0; i < cs.length; i++) {
        var c = cs[i], r = c.getBoundingClientRect(); if (!c.width || !c.height || !onScreen(r, vw, vh)) continue;
        var st = getComputedStyle(c); if (!shown(c, st)) continue;
        try {
          var bx = canvasBox(c, r, st);
          g.save();
          if (bx.clip) { g.beginPath(); g.rect(bx.clip.x * scale, bx.clip.y * scale, bx.clip.w * scale, bx.clip.h * scale); g.clip(); }
          g.globalAlpha = Math.max(0, Math.min(1, +st.opacity || 1)); g.drawImage(c, bx.x * scale, bx.y * scale, bx.w * scale, bx.h * scale); drew++;
          g.restore();
          var k = document.createElement('canvas'); k.width = Math.max(1, Math.round(Math.min(c.width, r.width * scale))); k.height = Math.max(1, Math.round(Math.min(c.height, r.height * scale)));
          k.getContext('2d').drawImage(c, 0, 0, k.width, k.height); copies.push([c, k]);
        } catch (e) { /* not drawable */ }
      }
      g.globalAlpha = 1;
    }
    function send(image, error, method) {
      var state = null; try { state = S.debugState(); } catch (e) { state = 'onState threw: ' + (e && e.message || e); }
      toParent({ gcp: 'capture_result', id: id, image: image, error: error, canvases: drew, method: method,
        state: state, frames: S.frames, fps: fpsNow, ready: S.ready, label: S.label || '', errors: S.errors.slice(0, 10), warnings: S.warnings.slice(0, 10),
        viewport: { width: vw, height: vh } });
    }
    function finish() {
      if (done) return; done = true; afterDraw = null; clearTimeout(timer);
      if (!picture) { send('', '', 'game'); return; }
      var canvasOnly = '', error = '';
      if (drew) { try { canvasOnly = out.toDataURL('image/jpeg', 0.86); } catch (e) { error = 'tainted'; } }
      var page = false; try { page = pageShowsElements(vw, vh); } catch (e) { /* keep the canvases */ }
      if (!page) { send(canvasOnly, error || (drew ? '' : 'no_canvas'), 'game'); return; }
      var snaps = new Map();
      for (var i = 0; i < copies.length; i++) { try { snaps.set(copies[i][0], copies[i][1].toDataURL('image/png')); } catch (e) { /* tainted: left blank */ } }
      try {
        domPicture(snaps, vw, vh, out.width, out.height, bg, function (full) {
          if (full) send(full, '', 'page');
          else send(canvasOnly, canvasOnly ? 'page_elements_missing' : (error || 'no_picture'), 'game');
        });
      } catch (e) { send(canvasOnly, canvasOnly ? 'page_elements_missing' : (error || 'no_picture'), 'game'); }
    }
    // the frame being drawn now: copy after every callback of it, and finish once the frame is over
    var armed = -1;
    afterDraw = function (t) { if (armed < 0) { armed = t; setTimeout(finish, 0); } if (t === armed) compose(); };
    // a game that is not drawing (paused, turn-based, a page of elements): take what the canvases hold now
    timer = setTimeout(function () { if (armed < 0) { compose(); finish(); } }, 500);
  }
  window.addEventListener('message', function (e) {
    var d = e.data;
    if (e.source === window.parent && d && d.gcp === 'capture') {
      if (cfg.env === 'preview' && cfg.kind === 'owner' && e.origin === platformOrigin) captureGame(String(d.id || '').slice(0, 40), d.picture !== false);
      else toParent({ gcp: 'capture_result', id: String(d.id || '').slice(0, 40), error: 'not_allowed' });
      return;
    }
    // The player's watchdog: an answer proves the game's main thread is free. A game stuck in a long loop cannot answer,
    // and the player then offers Wait or Quit game.
    if (e.source === window.parent && d && d.gcp === 'ping') { toParent({ gcp: 'pong', n: d.n, frames: S.frames }); return; }
    if (e.source === window.parent && d && d.gcp === 'escape_key' && escFn) { runEscape(null); return; }
    if (e.source === window.parent && d && d.gcp === 'lang') { setLang(d.lang); return; }
    if (e.source !== window.parent || !d || d.gcp !== 'display') return;
    display.fullscreen = !!d.fullscreen; display.mode = String(d.mode || 'inline'); display.orientation = String(d.orientation || 'any'); display.touch = !!d.touch;
    display.edgeToEdge = !!d.edgeToEdge; var sf = d.safe || {}, n = function (v) { v = +v; return isFinite(v) && v > 0 ? Math.min(200, Math.round(v)) : 0; };
    display.safe = { top: n(sf.top), right: n(sf.right), bottom: n(sf.bottom), left: n(sf.left) };
    display.paused = !!d.paused; display.menu = !!d.menu;
    markDisplay(); guard();
    displayFns.slice().forEach(function (fn) { try { fn(display); } catch (err) { console.error(err); } });
  });
  toParent({ gcp: 'display_query' });
  // What the verifier reads. The game runs in the same page, so the verifier's view is a read-only window onto the SDK's own
  // state: a page cannot write frames, ready or a passing play-through into it, or swap the functions the verifier calls.
  var view = {};
  ['boot', 'ready', 'readyAt', 'frames', 'fatal', 'progress', 'label', 'stats', 'held', 'busy', 'playthrough', 'twoPlayers', 'probe'].forEach(function (k) { Object.defineProperty(view, k, { get: function () { return S[k]; }, enumerable: true }); });
  ['errors', 'warnings', 'missing'].forEach(function (k) { Object.defineProperty(view, k, { get: function () { return S[k].slice(); }, enumerable: true }); });
  ['hold', 'runPlaythrough', 'runTwoPlayers', 'roomInfo', 'matchInfo', 'debugState'].forEach(function (k) { Object.defineProperty(view, k, { value: S[k], enumerable: true }); });
  try { Object.defineProperty(window, '__GCP', { value: Object.freeze(view), writable: false, configurable: false }); } catch (e) { /* already locked */ }
})();
