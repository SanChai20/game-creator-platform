// The GPU layer: one persistent WebGL 2 canvas behind the page, with a small deferred rendering pipeline.
//
//   1. field   the living background (domain-warped noise in the brand colours, dot matrix), at low resolution
//   2. scene   the field upscaled, then every registered surface (game covers, the billboard, game posters) drawn as
//              a textured quad exactly where its DOM box is, with rounded corners, cover fit, pointer parallax and a
//              hover ripple with RGB split. Brightness pushed past 1 on hover feeds the bloom.
//   3. bloom   bright pass and a separable Gaussian blur at quarter resolution
//   4. post    composite: bloom, radial chromatic aberration, scanlines, film grain, vignette, and the level-load
//              transition (a pixelation that resolves plus a lime scan line) on every page change
//
// The DOM stays on top for all text, controls and accessibility. A surface's own <img> is hidden only after its
// texture is on the GPU, and shown again the moment anything goes wrong, so nothing is ever missing.
import { fxForced, fxHeld, loop, palette, type FxTier } from './gl';

// ---- shaders (GLSL ES 3.00) -------------------------------------------------------------------------------------
const FULL_VS = `#version 300 es
in vec2 p;void main(){gl_Position=vec4(p,0.,1.);}`;

const FIELD_FS = `#version 300 es
precision mediump float;
uniform vec2 res;uniform float t,s;uniform vec2 m;uniform vec3 ink,violet,accent,hot;out vec4 o;
float h(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
float n(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);
  return mix(mix(h(i),h(i+vec2(1.,0.)),f.x),mix(h(i+vec2(0.,1.)),h(i+1.),f.x),f.y);}
float fbm(vec2 p){float v=0.,a=.5;for(int i=0;i<5;i++){v+=a*n(p);p=p*2.03+vec2(1.7,9.2);a*=.5;}return v;}
void main(){
  vec2 uv=gl_FragCoord.xy/res,p=(gl_FragCoord.xy-.5*res)/res.y;
  vec2 lean=(m-.5)*vec2(.22,.14);
  vec2 q=vec2(fbm(p*1.3+lean+t*.025),fbm(p*1.3-lean-t*.02+3.1));
  vec2 r=vec2(fbm(p*1.6+q*1.7+t*.01),fbm(p*1.6-q*1.3+5.2));
  float f=fbm(p*1.5+r*1.9),g=fbm(p*2.3-q*1.1+t*.015+7.);
  float top=smoothstep(0.,1.,uv.y);
  vec3 c=ink;
  c=mix(c,violet*.58,smoothstep(.42,.95,f)*(.3+.7*top));
  c=mix(c,hot*.36,smoothstep(.6,.97,g)*.6*top);
  c+=accent*.22*pow(smoothstep(.62,1.,f*g*1.7),2.)*top;
  vec2 cell=fract(gl_FragCoord.xy/(22.*s))-.5;
  c+=smoothstep(.1,0.,length(cell))*(.03+.06*f)*(.4+.6*top);
  c=mix(ink,c,.22+.78*smoothstep(-.2,.85,uv.y));
  o=vec4(c,1.);
}`;

const BLIT_FS = `#version 300 es
precision mediump float;uniform sampler2D tex;uniform vec2 res;out vec4 o;
void main(){o=texture(tex,gl_FragCoord.xy/res);}`;

const QUAD_VS = `#version 300 es
in vec2 p;uniform vec4 rect;uniform vec2 view;out vec2 v;
void main(){v=p;vec2 px=rect.xy+p*rect.zw;gl_Position=vec4(px.x/view.x*2.-1.,1.-px.y/view.y*2.,0.,1.);}`;

const QUAD_FS = `#version 300 es
precision highp float;
in vec2 v;uniform sampler2D tex;uniform vec4 rect;uniform vec2 img,mouse;uniform float t,dpr,radius,hover,kind,seed;
uniform vec3 accent;out vec4 o;
void main(){
  float ca=rect.z/rect.w,ia=img.x/img.y;
  vec2 st=v;
  if(ca>ia)st.y=(st.y-.5)*ia/ca+.5;else st.x=(st.x-.5)*ca/ia+.5;
  vec2 pm=(mouse-rect.xy)/rect.zw;
  // billboard and posters drift slowly and lean away from the pointer; tiles zoom a touch on hover
  float zoom=kind>.5?1.06+.02*sin(t*.15+seed):1.+.05*hover;
  vec2 par=kind>.5?(clamp(pm,0.,1.)-.5)*.025:vec2(0.);
  st=(st-.5)/zoom+.5-par;
  vec2 d=(v-pm)*vec2(ca,1.);float dist=length(d);
  float rip=sin(dist*34.-t*7.)*exp(-dist*4.5)*.011*hover;
  st+=normalize(d+1e-5)*rip/vec2(ca,1.);
  float ab=.0045*hover+.0006;
  vec3 c=vec3(texture(tex,st+vec2(ab,0.)).r,texture(tex,st).g,texture(tex,st-vec2(ab,0.)).b);
  c*=1.+.32*hover;
  c+=accent*exp(-dist*7.)*.22*hover;
  vec2 px=v*rect.zw;vec2 q=abs(px-rect.zw*.5)-(rect.zw*.5-radius);
  float sd=length(max(q,0.))+min(max(q.x,q.y),0.)-radius;
  float a=clamp(.5-sd*dpr,0.,1.);
  o=vec4(c*a,a);
}`;

const BRIGHT_FS = `#version 300 es
precision mediump float;uniform sampler2D tex;uniform vec2 res;out vec4 o;
void main(){vec2 uv=gl_FragCoord.xy/res;vec2 px=1./res*.5;
  vec3 c=(texture(tex,uv+px).rgb+texture(tex,uv-px).rgb+texture(tex,uv+vec2(px.x,-px.y)).rgb+texture(tex,uv-vec2(px.x,-px.y)).rgb)*.25;
  float l=max(c.r,max(c.g,c.b));o=vec4(c*smoothstep(.68,1.15,l),1.);}`;

const BLUR_FS = `#version 300 es
precision mediump float;uniform sampler2D tex;uniform vec2 res,dir;out vec4 o;
void main(){vec2 uv=gl_FragCoord.xy/res,s=dir/res;
  vec3 c=texture(tex,uv).rgb*.227;
  c+=(texture(tex,uv+s*1.385).rgb+texture(tex,uv-s*1.385).rgb)*.316;
  c+=(texture(tex,uv+s*3.231).rgb+texture(tex,uv-s*3.231).rgb)*.07;
  o=vec4(c,1.);}`;

const POST_FS = `#version 300 es
precision highp float;
uniform sampler2D scene,bloom;uniform vec2 res;uniform float t,dpr,tr,bloomK,grain;uniform vec3 accent;out vec4 o;
float h(vec2 p){return fract(sin(dot(p,vec2(12.9898,78.233)))*43758.5453);}
void main(){
  vec2 uv=gl_FragCoord.xy/res;
  if(tr>0.){float b=max(1.,floor(tr*tr*28.*dpr));uv=(floor(gl_FragCoord.xy/b)+.5)*b/res;}
  vec2 c=uv-.5;float r2=dot(c,c);
  vec2 ab=c*r2*.012;
  vec3 col=vec3(texture(scene,uv+ab).r,texture(scene,uv).g,texture(scene,uv-ab).b);
  col+=texture(bloom,uv).rgb*bloomK;
  col*=.972+.028*sin(gl_FragCoord.y/dpr*1.7);
  col+=(h(gl_FragCoord.xy+fract(t)*91.)-.5)*grain;
  col*=1.-r2*.5;
  if(tr>0.){float line=smoothstep(.012,0.,abs(uv.y-tr));col+=accent*(line*.32);col=mix(col,col*.6,tr*.5);}
  o=vec4(col,1.);
}`;

// ---- small GL helpers ---------------------------------------------------------------------------------------------
type Prog = { use: () => void; u: (n: string) => WebGLUniformLocation | null };
function compile(gl: WebGL2RenderingContext, vs: string, fs: string): Prog {
  const sh = (type: number, src: string) => {
    const s = gl.createShader(type)!; gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS) && !gl.isContextLost()) throw new Error('shader: ' + gl.getShaderInfoLog(s));
    return s;
  };
  const p = gl.createProgram()!;
  gl.attachShader(p, sh(gl.VERTEX_SHADER, vs)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs));
  gl.bindAttribLocation(p, 0, 'p'); gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS) && !gl.isContextLost()) throw new Error('link: ' + gl.getProgramInfoLog(p));
  const cache = new Map<string, WebGLUniformLocation | null>();
  return { use: () => gl.useProgram(p), u: (n) => { if (!cache.has(n)) cache.set(n, gl.getUniformLocation(p, n)); return cache.get(n)!; } };
}
type Target = { fb: WebGLFramebuffer; tex: WebGLTexture; w: number; h: number };
function target(gl: WebGL2RenderingContext, w: number, h: number): Target {
  const tex = gl.createTexture()!; gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const fb = gl.createFramebuffer()!; gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  return { fb, tex, w, h };
}

// ---- surfaces: DOM elements whose picture the GPU draws -------------------------------------------------------------
// Mark an element with data-gl="tile" | "hero" | "poster". Its picture comes from data-gl-src, or else its first <img>.
type Surface = { el: HTMLElement; host: HTMLElement | null; src: string; kind: number; seed: number; hover: number; radius: number };
type Tex = { tex: WebGLTexture; w: number; h: number; used: number };

export type PipelineStats = { fps: number; ms: number; surfaces: number; scale: number; tier: FxTier };

export class Pipeline {
  private gl: WebGL2RenderingContext;
  private progs: Record<'field' | 'blit' | 'quad' | 'bright' | 'blur' | 'post', Prog>;
  private vaoFull: WebGLVertexArrayObject; private vaoQuad: WebGLVertexArrayObject;
  private field?: Target; private scene?: Target; private b1?: Target; private b2?: Target;
  private surfaces: Surface[] = []; private textures = new Map<string, Tex | 'loading' | 'failed'>();
  private mouse = { x: -1e4, y: -1e4, nx: .5, ny: .5, sx: .5, sy: .5 };
  private stopLoop = () => {}; private observer?: MutationObserver; private dirty = true;
  private transition = -1; private dpr = 1; private downgrades = 0; private windowStart = 0; private count = 0; private cpu = 0; private lastFrame = 0;
  private t0 = performance.now() - 40000; private held = fxHeld();
  stats: PipelineStats;

  constructor(private canvas: HTMLCanvasElement, private tier: FxTier, private onFail: () => void) {
    const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, depth: false, stencil: false, premultipliedAlpha: true, powerPreference: tier === 'full' ? 'default' : 'low-power' });
    if (!gl) throw new Error('no webgl2');
    this.gl = gl;
    this.progs = {
      field: compile(gl, FULL_VS, FIELD_FS), blit: compile(gl, FULL_VS, BLIT_FS), quad: compile(gl, QUAD_VS, QUAD_FS),
      bright: compile(gl, FULL_VS, BRIGHT_FS), blur: compile(gl, FULL_VS, BLUR_FS), post: compile(gl, FULL_VS, POST_FS),
    };
    const vao = (data: number[]) => {
      const a = gl.createVertexArray()!; gl.bindVertexArray(a);
      const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0); return a;
    };
    this.vaoFull = vao([-1, -1, 3, -1, -1, 3]);
    this.vaoQuad = vao([0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1]);
    this.stats = { fps: 0, ms: 0, surfaces: 0, scale: 0, tier };
    this.dpr = this.baseDpr();
    this.resize();
    canvas.addEventListener('webglcontextlost', this.lost);
    addEventListener('resize', this.resize);
    if (tier !== 'still') addEventListener('pointermove', this.move, { passive: true });
    addEventListener('fx:hold', this.hold);
    if (tier === 'full') {
      this.observer = new MutationObserver(() => { this.dirty = true; });
      this.observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-gl', 'data-gl-src', 'src'] });
    }
  }

  private baseDpr() { return this.tier === 'full' ? Math.min(devicePixelRatio || 1, 1.5) : Math.min(devicePixelRatio || 1, 1) * 0.75; }

  /** Starts rendering. The still tier draws a single frame and stops. */
  start() {
    if (this.held) return;
    if (this.tier === 'still') { this.frame(performance.now()); return; }
    this.stopLoop = loop((now) => this.frame(now), this.tier === 'lite' ? 30 : 60);
  }
  /** Another GPU scene (the home page's exhibition hall) fills the view: stop drawing behind it until it lets go (holdFx). */
  private hold = (e: Event) => {
    const h = !!(e as CustomEvent).detail;
    if (h === this.held) return;
    this.held = h;
    if (h) { this.stopLoop(); this.stopLoop = () => {}; } else this.start();
  };
  /** A page change: play the level-load transition. */
  pageChange() { if (this.tier !== 'still') this.transition = performance.now(); this.dirty = true; }

  dispose() {
    this.stopLoop(); this.observer?.disconnect();
    removeEventListener('resize', this.resize); removeEventListener('pointermove', this.move); removeEventListener('fx:hold', this.hold);
    this.canvas.removeEventListener('webglcontextlost', this.lost);
    this.release();
    this.gl.getExtension('WEBGL_lose_context')?.loseContext();
  }

  private release() {
    for (const s of this.surfaces) this.show(s);
    this.surfaces = [];
    delete document.documentElement.dataset.fxLive;
  }
  /** Hands a picture back to the DOM. */
  private show(s: Surface) { s.el.classList.remove('gl-on'); s.host?.classList.remove('gl-host'); }
  private lost = (e: Event) => { e.preventDefault(); this.stopLoop(); this.release(); this.onFail(); };
  private move = (e: PointerEvent) => { this.mouse.x = e.clientX; this.mouse.y = e.clientY; this.mouse.nx = e.clientX / innerWidth; this.mouse.ny = 1 - e.clientY / innerHeight; };

  private resize = () => {
    const gl = this.gl, w = Math.max(1, Math.round(innerWidth * this.dpr)), h = Math.max(1, Math.round(innerHeight * this.dpr));
    if (this.canvas.width === w && this.canvas.height === h && this.scene) return;
    this.canvas.width = w; this.canvas.height = h;
    for (const t of [this.field, this.scene, this.b1, this.b2]) if (t) { gl.deleteTexture(t.tex); gl.deleteFramebuffer(t.fb); }
    const fs = this.tier === 'full' ? 0.4 : 0.5; // the field is soft: a fraction of the pixels is plenty
    this.field = target(gl, Math.max(1, Math.round(w * fs / this.dpr)), Math.max(1, Math.round(h * fs / this.dpr)));
    this.scene = target(gl, w, h);
    this.b1 = target(gl, Math.max(1, w >> 2), Math.max(1, h >> 2));
    this.b2 = target(gl, Math.max(1, w >> 2), Math.max(1, h >> 2));
    this.stats.scale = this.dpr;
    if (this.tier === 'still') this.frame(performance.now());
  };

  // Rebuild the surface list after the DOM changes. Only the full tier lets the GPU take over pictures.
  private scan() {
    this.dirty = false;
    if (this.tier !== 'full') return;
    const els = Array.from(document.querySelectorAll<HTMLElement>('[data-gl]'));
    const keep = new Set(els);
    for (const s of this.surfaces) if (!keep.has(s.el)) this.show(s);
    const prev = new Map(this.surfaces.map((s) => [s.el, s]));
    this.surfaces = [];
    for (const el of els) {
      const src = el.dataset.glSrc || el.querySelector('img')?.currentSrc || el.querySelector('img')?.src || '';
      if (!src) { el.classList.remove('gl-on'); continue; }
      const host = el.closest<HTMLElement>('[data-gl-host]');
      const old = prev.get(el);
      const kind = el.dataset.gl === 'tile' ? 0 : 1;
      const radius = parseFloat(getComputedStyle(el).borderTopLeftRadius) || (host ? parseFloat(getComputedStyle(host).borderTopLeftRadius) || 0 : 0);
      let seed = 0; for (let i = 0; i < src.length; i++) seed = (seed * 31 + src.charCodeAt(i)) % 1000;
      this.surfaces.push(old && old.src === src ? { ...old, radius, host } : { el, host, src, kind, seed, hover: 0, radius });
      this.load(src, el);
    }
    // Keep the texture cache bounded: drop pictures no longer on the page once there are more than 48.
    if (this.textures.size > 48) {
      const live = new Set(this.surfaces.map((s) => s.src));
      for (const [k, v] of this.textures) if (!live.has(k) && typeof v === 'object') { this.gl.deleteTexture(v.tex); this.textures.delete(k); }
    }
    this.stats.surfaces = this.surfaces.length;
  }

  private load(src: string, el: HTMLElement) {
    if (this.textures.has(src)) return;
    this.textures.set(src, 'loading');
    const domImg = el.dataset.glSrc ? null : el.querySelector('img');
    const img = domImg && domImg.complete && domImg.naturalWidth ? domImg : new Image();
    const upload = () => {
      const gl = this.gl;
      try {
        const tex = gl.createTexture()!; gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img); // throws on a cross-origin picture without CORS
        gl.generateMipmap(gl.TEXTURE_2D);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        this.textures.set(src, { tex, w: img.naturalWidth, h: img.naturalHeight, used: 0 });
      } catch { this.textures.set(src, 'failed'); }
    };
    if (img === domImg) upload();
    else { img.crossOrigin = 'anonymous'; img.decoding = 'async'; img.onload = upload; img.onerror = () => this.textures.set(src, 'failed'); img.src = src; }
  }

  private frame(nowMs: number) {
    const gl = this.gl;
    if (gl.isContextLost() || !this.scene || !this.field || !this.b1 || !this.b2) return;
    const start = performance.now();
    if (this.dirty) this.scan();
    const t = (nowMs - this.t0) / 1000, W = this.canvas.width, H = this.canvas.height;
    const m = this.mouse; m.sx += (m.nx - m.sx) * 0.05; m.sy += (m.ny - m.sy) * 0.05;
    const P = this.progs;

    // 1. field
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.field.fb); gl.viewport(0, 0, this.field.w, this.field.h);
    gl.bindVertexArray(this.vaoFull); gl.disable(gl.BLEND);
    P.field.use();
    gl.uniform2f(P.field.u('res'), this.field.w, this.field.h); gl.uniform1f(P.field.u('t'), t); gl.uniform1f(P.field.u('s'), this.field.w / innerWidth);
    gl.uniform2f(P.field.u('m'), m.sx, m.sy);
    gl.uniform3fv(P.field.u('ink'), palette.ink); gl.uniform3fv(P.field.u('violet'), palette.violet); gl.uniform3fv(P.field.u('accent'), palette.accent); gl.uniform3fv(P.field.u('hot'), palette.hot);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // 2. scene: the field, then the surfaces on top
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.scene.fb); gl.viewport(0, 0, W, H);
    P.blit.use(); gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.field.tex);
    gl.uniform1i(P.blit.u('tex'), 0); gl.uniform2f(P.blit.u('res'), W, H);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    if (this.surfaces.length) {
      gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.bindVertexArray(this.vaoQuad); P.quad.use();
      gl.uniform2f(P.quad.u('view'), innerWidth, innerHeight); gl.uniform1f(P.quad.u('t'), t); gl.uniform1f(P.quad.u('dpr'), this.dpr);
      gl.uniform2f(P.quad.u('mouse'), m.x, m.y); gl.uniform3fv(P.quad.u('accent'), palette.accent); gl.uniform1i(P.quad.u('tex'), 0);
      for (const s of this.surfaces) {
        const tx = this.textures.get(s.src);
        if (!tx || tx === 'loading') continue;
        if (tx === 'failed') { this.show(s); continue; }
        const r = s.el.getBoundingClientRect();
        if (r.width < 2 || r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) continue;
        const link = s.el.closest('a');
        const hovered = (link ?? s.el).matches(':hover');
        s.hover += ((hovered ? 1 : 0) - s.hover) * 0.12;
        gl.bindTexture(gl.TEXTURE_2D, tx.tex);
        gl.uniform4f(P.quad.u('rect'), r.left, r.top, r.width, r.height);
        gl.uniform2f(P.quad.u('img'), tx.w, tx.h); gl.uniform1f(P.quad.u('radius'), s.radius);
        gl.uniform1f(P.quad.u('hover'), s.hover); gl.uniform1f(P.quad.u('kind'), s.kind); gl.uniform1f(P.quad.u('seed'), s.seed);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
        if (!s.el.classList.contains('gl-on')) { s.el.classList.add('gl-on'); s.host?.classList.add('gl-host'); } // hide the DOM picture only once the GPU has drawn it
      }
      gl.disable(gl.BLEND);
    }

    // 3. bloom
    gl.bindVertexArray(this.vaoFull);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.b1.fb); gl.viewport(0, 0, this.b1.w, this.b1.h);
    P.bright.use(); gl.bindTexture(gl.TEXTURE_2D, this.scene.tex); gl.uniform1i(P.bright.u('tex'), 0); gl.uniform2f(P.bright.u('res'), this.b1.w, this.b1.h);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    P.blur.use(); gl.uniform1i(P.blur.u('tex'), 0); gl.uniform2f(P.blur.u('res'), this.b1.w, this.b1.h);
    for (const [from, to, dx, dy] of [[this.b1, this.b2, 1, 0], [this.b2, this.b1, 0, 1], [this.b1, this.b2, 2, 0], [this.b2, this.b1, 0, 2]] as const) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, to.fb); gl.bindTexture(gl.TEXTURE_2D, from.tex); gl.uniform2f(P.blur.u('dir'), dx, dy);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    // 4. post, to the screen
    gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, W, H);
    P.post.use();
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.scene.tex); gl.uniform1i(P.post.u('scene'), 0);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.b1.tex); gl.uniform1i(P.post.u('bloom'), 1);
    gl.activeTexture(gl.TEXTURE0);
    const since = (nowMs - this.transition) / 650;
    gl.uniform2f(P.post.u('res'), W, H); gl.uniform1f(P.post.u('t'), t); gl.uniform1f(P.post.u('dpr'), this.dpr);
    gl.uniform1f(P.post.u('tr'), this.transition > 0 && since < 1 ? 1 - since : 0);
    gl.uniform1f(P.post.u('bloomK'), this.tier === 'full' ? 0.75 : 0.5); gl.uniform1f(P.post.u('grain'), 0.035);
    gl.uniform3fv(P.post.u('accent'), palette.accent);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    document.documentElement.dataset.fxLive = '1';

    // Frame budget: CPU time per frame and the real frame interval. If the device cannot keep up, lower the
    // resolution once, then hand the pictures back to the DOM and drop to the lite tier, then stop animating.
    // Frame budget, measured over 2-second windows: real frame interval and CPU time per frame. If the device
    // cannot keep up, lower the resolution once, then hand the pictures back to the DOM and drop to the lite tier,
    // then stop animating and keep the last frame.
    this.cpu += performance.now() - start; this.count++;
    if (nowMs - this.lastFrame > 500) { this.windowStart = 0; this.count = 0; this.cpu = 0; } // back from a hidden tab: start a fresh window
    this.lastFrame = nowMs;
    if (!this.windowStart) this.windowStart = nowMs;
    else if (nowMs - this.windowStart >= 2000) {
      const span = (nowMs - this.windowStart) / this.count;
      this.stats.fps = Math.round(1000 / span); this.stats.ms = Math.round((this.cpu / this.count) * 100) / 100;
      this.windowStart = nowMs; this.count = 0; this.cpu = 0;
      if (span > (this.tier === 'full' ? 16.7 : 33.4) * 1.6 && !fxForced()) this.downgrade();
    }
  }

  private downgrade() {
    this.downgrades++;
    if (this.downgrades === 1) { this.dpr = Math.max(0.6, this.dpr * 0.66); this.resize(); }
    else if (this.downgrades === 2 && this.tier === 'full') { this.tier = 'lite'; this.stats.tier = 'lite'; this.release(); this.dpr = this.baseDpr(); this.resize(); }
    else { this.stopLoop(); this.stats.tier = 'still'; }
  }
}
