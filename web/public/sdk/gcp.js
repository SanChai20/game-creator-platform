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
  var frameHooks = [];
  if (P.on) (function () {
    function hookGL(gl) {
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
          if (src == null) G.targets++; else if (w * h >= 256) { G.textures++; G.texels += w * h; }
        }
        return tex.apply(gl, arguments);
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
  var raf = window.requestAnimationFrame.bind(window), lastT = -1, lastFrameAt = 0;
  window.requestAnimationFrame = function (cb) { return raf(function (t) { if (t !== lastT) { lastT = t; S.frames++; lastFrameAt = performance.now(); for (var i = 0; i < frameHooks.length; i++) frameHooks[i](); } cb(t); }); };

  function api(path, body, method) {
    if (standalone) return Promise.reject(new Error('offline'));
    return fetch(cfg.api + '/api/rt/' + path, { method: method || 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify(Object.assign({ t: cfg.token }, body || {})) })
      .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status)); return j; }); });
  }

  // Heartbeat: play time counts only while the tab is visible and frames are advancing.
  var beatFrames = 0, fpsEma = 0;
  function beat(last) {
    if (standalone || !S.ready) return;
    var advanced = S.frames - beatFrames; beatFrames = S.frames;
    fpsEma = advanced / 15;
    var body = JSON.stringify({ t: cfg.token, frames: S.frames, active: advanced > 0 && document.visibilityState === 'visible', fps: Math.round(fpsEma), errors: pending.splice(0, 5), fatal: S.fatal });
    if (last && navigator.sendBeacon) navigator.sendBeacon(cfg.api + '/api/rt/beat', new Blob([body], { type: 'text/plain' }));
    else fetch(cfg.api + '/api/rt/beat', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: body, keepalive: true }).catch(function () { });
  }
  setInterval(beat, 15000);
  window.addEventListener('pagehide', function () { beat(true); });

  function lsKey(k) { return 'gcp:' + cfg.gameId + ':' + k; }
  var LS = { get: function (k) { try { var v = localStorage.getItem(lsKey(k)); return v == null ? null : JSON.parse(v); } catch (e) { return null; } }, set: function (k, v) { try { localStorage.setItem(lsKey(k), JSON.stringify(v)); } catch (e) { /* private mode */ } }, del: function (k) { try { localStorage.removeItem(lsKey(k)); } catch (e) { /* ignore */ } } };

  function Room(code, opts) {
    var self = this, handlers = {}, ws = null, closed = false, tries = 0;
    this.code = code; this.id = null; this.hostId = null; this.peers = []; this.state = null; this.connected = false;
    Object.defineProperty(this, 'isHost', { get: function () { return self.id !== null && self.id === self.hostId; } });
    function emit(type, a, b) { (handlers[type] || []).slice().forEach(function (fn) { try { fn(a, b); } catch (e) { console.error(e); } }); }
    this.on = function (type, fn) { (handlers[type] = handlers[type] || []).push(fn); return self; };
    this.off = function (type, fn) { handlers[type] = (handlers[type] || []).filter(function (f) { return f !== fn; }); return self; };
    /** Send to everyone else, or to one peer id, or to 'host'. */
    this.send = function (data, to) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(to ? { t: 'msg', to: to, d: data } : { t: 'msg', d: data })); };
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
        else if (m.t === 'msg') emit('message', m.d, m.from);
        else if (m.t === 'state') { self.state = m.d; emit('state', m.d); }
        else if (m.t === 'error') emit('error', new Error(m.message));
      };
      ws.onclose = function (ev) {
        self.connected = false; emit('close', ev.code);
        if (!closed && ev.code !== 4001 && ev.code !== 4003 && tries < 6) setTimeout(connect, Math.min(8000, 500 * Math.pow(2, tries++)));
      };
    }
    connect();
  }

  var autostartFns = [], playFn = null;
  // The play-through a game may register: the verifier runs it and reports each step, so "playable" can mean
  // "the whole loop was played to the end" instead of only "it booted". Limits: 60 steps, one run at a time.
  S.playthrough = false;
  S.runPlaythrough = function (limitMs) {
    if (!playFn) return Promise.resolve({ ran: false });
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
    var out = function (ok, error) { over = true; return { ran: true, ok: ok, error: error || '', steps: steps, ms: Math.round(performance.now() - t0), frames: S.frames - frames0 }; };
    var limit = new Promise(function (r) { setTimeout(function () { r(out(false, 'The play-through did not finish within ' + Math.round(limitMs / 1000) + ' s.')); }, limitMs); });
    var run; try { run = Promise.resolve(playFn(t)); } catch (e) { run = Promise.reject(e); }
    return Promise.race([limit, run.then(function () { return out(true); }, function (e) { return out(false, String(e && e.message || e).slice(0, 400)); })]);
  };
  var GCP = window.GCP = {
    sdk: 1,
    env: cfg.env, gameId: cfg.gameId, version: cfg.version, player: cfg.player, standalone: standalone,
    /** Loading progress, 0..1. Purely informational: shown in verification reports. */
    progress: function (f, label) { P.progress++; S.progress = Math.max(0, Math.min(1, +f || 0)); if (label != null) S.label = String(label).slice(0, 120); },
    /** Call once when the first playable frame is on screen. Required. */
    ready: function (info) {
      if (S.ready) return; S.ready = true; S.readyAt = performance.now(); S.progress = 1; if (info) S.stats = info;
      if (GCP.test.autostart) setTimeout(function () { autostartFns.forEach(function (fn) { try { fn(); } catch (e) { note(S.errors, 'autostart hook threw: ' + (e && e.message || e)); } }); }, 0);
      if (!standalone) { api('beat', { frames: S.frames, active: false, first: true, loadMs: Math.round(S.readyAt - S.boot) }).catch(function () { }); }
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
    /** Game-wide data every player can read. Written only by the game's server code. */
    shared: { get: function (key) { return api('save', { op: 'get', key: key, shared: true }).then(function (r) { return r.value; }).catch(function () { return null; }); } },
    leaderboard: {
      /** Keeps each player's best score per board. order: 'desc' (default, higher is better) or 'asc'. */
      submit: function (board, score, order) { return api('score', { op: 'submit', board: board, score: +score, order: order || 'desc' }).catch(function () { return null; }); },
      top: function (board, limit, order) { return api('score', { op: 'top', board: board, limit: limit || 10, order: order || 'desc' }).then(function (r) { return r.rows; }).catch(function () { return []; }); },
    },
    /** Realtime room on the platform (Durable Object WebSocket relay). First player in is the host. */
    room: function (code, opts) { return new Room(String(code || 'lobby').slice(0, 40), opts); },
    /** Calls the game's own server code (server/index.js in the bundle) with the player's identity attached. Returns a fetch Response. */
    server: function (path, init) {
      init = init || {}; var h = new Headers(init.headers || {}); if (cfg.token) h.set('x-gcp-token', cfg.token);
      return fetch((cfg.base || '') + '/api/' + String(path || '').replace(/^\/+/, ''), Object.assign({}, init, { headers: h }));
    },
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
    },
    /** Ask the platform page to toggle fullscreen (works inside the play frame). */
    fullscreen: function () { try { parent.postMessage({ gcp: 'fullscreen' }, '*'); } catch (e) { /* not framed */ } },
  };
})();
