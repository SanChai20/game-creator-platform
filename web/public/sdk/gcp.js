/* Game Creator SDK. The platform injects this script at the top of every game document, before any
   game code runs, so `GCP` is always defined. Nothing here draws or decides how a game looks or plays.

   The contract (the only hard rules):
     GCP.ready()            call once, when the first playable frame is on screen
     GCP.progress(f, label) optional, 0..1 while loading
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
  window.requestAnimationFrame = function (cb) { if (S.held) { held.push(cb); return 0; } return raf(function (t) { if (t !== lastT) { lastT = t; S.frames++; lastFrameAt = performance.now(); for (var i = 0; i < frameHooks.length; i++) frameHooks[i](); } cb(t); }); };

  function api(path, body, method) {
    if (standalone) return Promise.reject(new Error('offline'));
    return fetch(cfg.api + '/api/rt/' + path, { method: method || 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify(Object.assign({ t: cfg.token }, body || {})) })
      .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status)); return j; }); });
  }

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

  // Heartbeat: play time counts only while the tab is visible and frames are advancing.
  var beatFrames = 0, fpsEma = 0;
  function beat(last) {
    if (standalone || !S.ready) return;
    var advanced = S.frames - beatFrames; beatFrames = S.frames;
    fpsEma = advanced / 15;
    var body = JSON.stringify({ t: cfg.token, frames: S.frames, active: advanced > 0 && document.visibilityState === 'visible', fps: Math.round(fpsEma), errors: pending.splice(0, 5), fatal: S.fatal });
    if (last && navigator.sendBeacon) navigator.sendBeacon(cfg.api + '/api/rt/beat', new Blob([body], { type: 'text/plain' }));
    else fetch(cfg.api + '/api/rt/beat', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: body, keepalive: true }).then(function (r) { if ((r.status === 401 || r.status === 402) && trial) trialOver(); return r.json(); }).then(onBeat).catch(function () { });
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
    /** Send to everyone else, or to one peer id, or to 'host'. Each message carries its send time, which receivers get as meta.at. */
    this.send = function (data, to) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(to ? { t: 'msg', to: to, d: data, at: clock() } : { t: 'msg', d: data, at: clock() })); };
    /** Host only: store a snapshot that late joiners receive in their 'open' event (max 256 KB). */
    this.setState = function (data) { self.state = data; if (ws && ws.readyState === 1) ws.send(JSON.stringify({ t: 'state', d: data })); };
    this.leave = function () { closed = true; if (ws) ws.close(1000); };
    function connect() {
      if (standalone) { setTimeout(function () { self.id = 'local'; self.hostId = 'local'; self.connected = true; emit('open', { id: 'local', host: true, peers: [], state: null }); }, 0); return; }
      var u = cfg.api.replace(/^http/, 'ws') + '/api/rt/room?room=' + encodeURIComponent(code) + '&t=' + encodeURIComponent(cfg.token) + (opts && opts.max ? '&max=' + opts.max : '');
      ws = new WebSocket(u);
      ws.onmessage = function (ev) {
        var m; try { m = JSON.parse(ev.data); } catch (e) { return; }
        if (m.t === 'welcome') { tries = 0; self.id = m.id; self.hostId = m.host; self.peers = m.peers; self.state = m.state; self.connected = true; emit('open', { id: m.id, host: self.isHost, peers: m.peers, state: m.state }); }
        else if (m.t === 'join') { self.peers.push(m.peer); emit('join', m.peer); }
        else if (m.t === 'leave') { self.peers = self.peers.filter(function (p) { return p.id !== m.id; }); var was = self.hostId; self.hostId = m.host; emit('leave', m.id); if (was !== m.host) emit('host', m.host); }
        else if (m.t === 'msg') { seen.messages++; if (m.d && m.d.gcpWorld === 'op') seen.worldOps++; emit('message', m.d, m.from, { at: typeof m.at === 'number' ? m.at : undefined, received: performance.now() }); }
        else if (m.t === 'state') { seen.states++; self.state = m.d; emit('state', m.d); }
        else if (m.t === 'error') emit('error', new Error(m.message));
      };
      ws.onclose = function (ev) {
        self.connected = false; seen.closes++; emit('close', ev.code);
        if (!closed && ev.code !== 4001 && ev.code !== 4003 && tries < 6) setTimeout(connect, Math.min(8000, 500 * Math.pow(2, tries++)));
      };
    }
    connect();
  }

  var autostartFns = [], playFn = null, pairFn = null;
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
  var display = { fullscreen: false, mode: 'inline', orientation: 'any', touch: coarse }, displayFns = [];
  function markDisplay() { var c = document.documentElement && document.documentElement.classList; if (!c) return; c.toggle('gcp-fullscreen', display.fullscreen); c.toggle('gcp-touch', display.touch); }
  markDisplay();
  var GCP = window.GCP = {
    sdk: 1,
    env: cfg.env, gameId: cfg.gameId, version: cfg.version, player: cfg.player, standalone: standalone,
    /** The player's platform language as a BCP 47 tag (en, zh, zh-TW, ja, ko, es), from ?gcp_lang or the browser. A game that
        declares languages.follows_platform in gcp.json opens in this language when it has it, and otherwise in its default. */
    lang: String(q.get('gcp_lang') || (navigator.language || 'en')).slice(0, 20),
    /** Loading progress, 0..1. Purely informational: shown in verification reports. */
    progress: function (f, label) { P.progress++; S.progress = Math.max(0, Math.min(1, +f || 0)); if (label != null) S.label = String(label).slice(0, 120); },
    /** Call once when the first playable frame is on screen. Required. */
    ready: function (info) {
      if (S.ready) return; S.ready = true; S.readyAt = performance.now(); S.progress = 1; if (info) S.stats = info;
      if (GCP.test.autostart) setTimeout(function () { autostartFns.forEach(function (fn) { try { fn(); } catch (e) { note(S.errors, 'autostart hook threw: ' + (e && e.message || e)); } }); }, 0);
      if (!standalone) { api('beat', { frames: S.frames, active: false, first: true, loadMs: Math.round(S.readyAt - S.boot) }).then(onBeat).catch(function () { }); }
    },
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
    /** Game-wide data every player can read. Written only by the game's server code. */
    shared: { get: function (key) { return api('save', { op: 'get', key: key, shared: true }).then(function (r) { return r.value; }).catch(function () { return null; }); } },
    leaderboard: {
      /** Keeps each player's best score per board. order: 'desc' (default, higher is better) or 'asc'. */
      submit: function (board, score, order) { return api('score', { op: 'submit', board: board, score: +score, order: order || 'desc' }).catch(function () { return null; }); },
      top: function (board, limit, order) { return api('score', { op: 'top', board: board, limit: limit || 10, order: order || 'desc' }).then(function (r) { return r.rows; }).catch(function () { return []; }); },
    },
    /** Realtime room on the platform (Durable Object WebSocket relay). First player in is the host. */
    room: function (code, opts) { return new Room(String(code || 'lobby').slice(0, 40), opts); },
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
    },
    /** Ask the platform page for fullscreen (works inside the play frame, and on iPhones, where the game is given the
        whole visible screen instead). No argument toggles; true enters; false leaves. Call it from a tap or key press. */
    fullscreen: function (on) {
      var msg = { gcp: 'fullscreen' }; if (on === true || on === false) msg.on = on;
      if (window.parent !== window) { try { parent.postMessage(msg, '*'); } catch (e) { /* not framed */ } return; }
      var d = document, el = d.documentElement;   // standalone: the page itself
      if (d.fullscreenElement) { if (on !== true) d.exitFullscreen().catch(function () { }); }
      else if (on !== false && el.requestFullscreen) el.requestFullscreen().catch(function () { });
    },
    /** How the game is shown right now. Kept up to date by the platform page:
        { fullscreen, mode: 'inline' | 'fullscreen' | 'immersive', orientation: 'any' | 'landscape' | 'portrait', touch }.
        touch is true on phones and tablets (a finger is the main pointer): show on-screen controls then. */
    display: display,
    /** fn(display) whenever it changes (entering or leaving fullscreen, for example). */
    onDisplay: function (fn) { if (typeof fn === 'function') displayFns.push(fn); },
    /** Preferences for the player around the game: { orientation: 'landscape' | 'portrait' | 'any' (overrides the declared
        requirement; the platform locks the screen to it in fullscreen where the browser allows, and asks the player to
        turn the phone where it does not), exitButton: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right' | 'none'
        (where the platform's small exit-fullscreen button sits on touch screens; 'none' if the game has its own) }. */
    setDisplay: function (prefs) { prefs = prefs || {}; try { parent.postMessage({ gcp: 'display_prefs', orientation: prefs.orientation, exitButton: prefs.exitButton }, '*'); } catch (e) { /* not framed */ } },
  };
  window.addEventListener('message', function (e) {
    var d = e.data; if (e.source !== window.parent || !d || d.gcp !== 'display') return;
    display.fullscreen = !!d.fullscreen; display.mode = String(d.mode || 'inline'); display.orientation = String(d.orientation || 'any'); display.touch = !!d.touch;
    markDisplay();
    displayFns.slice().forEach(function (fn) { try { fn(display); } catch (err) { console.error(err); } });
  });
  if (window.parent !== window) { try { parent.postMessage({ gcp: 'display_query' }, '*'); } catch (e) { /* not framed */ } }
  // What the verifier reads. The game runs in the same page, so the verifier's view is a read-only window onto the SDK's own
  // state: a page cannot write frames, ready or a passing play-through into it, or swap the functions the verifier calls.
  var view = {};
  ['boot', 'ready', 'readyAt', 'frames', 'fatal', 'progress', 'label', 'stats', 'held', 'playthrough', 'twoPlayers', 'probe'].forEach(function (k) { Object.defineProperty(view, k, { get: function () { return S[k]; }, enumerable: true }); });
  ['errors', 'warnings', 'missing'].forEach(function (k) { Object.defineProperty(view, k, { get: function () { return S[k].slice(); }, enumerable: true }); });
  ['hold', 'runPlaythrough', 'runTwoPlayers', 'roomInfo'].forEach(function (k) { Object.defineProperty(view, k, { value: S[k], enumerable: true }); });
  try { Object.defineProperty(window, '__GCP', { value: Object.freeze(view), writable: false, configurable: false }); } catch (e) { /* already locked */ }
})();
