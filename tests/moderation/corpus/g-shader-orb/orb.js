// Orb Drifter: everything is drawn by one fragment shader. Game state lives in JS and goes in as uniforms.
const canvas = document.getElementById('gl'), hud = document.getElementById('s');
const gl = canvas.getContext('webgl2', { antialias: false });
if (!gl) GCP.fatal('WebGL 2 is not available');
const VS = `#version 300 es
in vec2 p; void main() { gl_Position = vec4(p, 0., 1.); }`;
const FS = `#version 300 es
precision highp float;
uniform vec2 uRes; uniform float uTime; uniform vec2 uPlayer; uniform vec3 uOrb[6];
out vec4 o;
float hash(vec3 p) { p = fract(p * .3183099 + .1); p *= 17.; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float noise(vec3 x) { vec3 i = floor(x), f = fract(x); f = f * f * (3. - 2. * f);
  return mix(mix(mix(hash(i), hash(i + vec3(1,0,0)), f.x), mix(hash(i + vec3(0,1,0)), hash(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(hash(i + vec3(0,0,1)), hash(i + vec3(1,0,1)), f.x), mix(hash(i + vec3(0,1,1)), hash(i + vec3(1,1,1)), f.x), f.y), f.z); }
float fbm(vec3 p) { float a = .5, s = 0.; for (int i = 0; i < 5; i++) { s += a * noise(p); p *= 2.03; a *= .5; } return s; }
void main() {
  vec2 uv = (gl_FragCoord.xy - .5 * uRes) / uRes.y;
  vec3 ro = vec3(0., 0., uTime * .6), rd = normalize(vec3(uv, 1.2)), col = vec3(0.);
  float t = 0.;
  for (int i = 0; i < 28; i++) { vec3 q = ro + rd * t; float d = fbm(q * .7); col += vec3(.25, .1, .4) * d * d * .09 + vec3(.0, .15, .2) * pow(d, 4.) * .2; t += .35; }
  for (int k = 0; k < 6; k++) { vec2 c = uOrb[k].xy; float r = uOrb[k].z; col += vec3(1., .85, .4) * r * .004 / max(1e-4, dot(uv - c, uv - c)); }
  col += vec3(.4, .9, 1.) * .0025 / max(1e-4, dot(uv - uPlayer, uv - uPlayer));
  o = vec4(pow(col, vec3(.8)), 1.);
}`;
function compile(type, src) { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) GCP.fatal(gl.getShaderInfoLog(s)); return s; }
const prog = gl.createProgram();
gl.attachShader(prog, compile(gl.VERTEX_SHADER, VS)); gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FS)); gl.linkProgram(prog); gl.useProgram(prog);
const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
const loc = gl.getAttribLocation(prog, 'p'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
const U = (n) => gl.getUniformLocation(prog, n);
const uRes = U('uRes'), uTime = U('uTime'), uPlayer = U('uPlayer'), uOrb = U('uOrb');
let scale = 1, slow = 0;
const player = { x: 0, y: 0 }, aim = { x: 0, y: 0 }, orbs = [];
let score = 0;
for (let i = 0; i < 6; i++) orbs.push({ x: Math.random() - 0.5, y: Math.random() - 0.5, r: 1 });
function resize() { canvas.width = Math.max(64, innerWidth * scale | 0); canvas.height = Math.max(36, innerHeight * scale | 0); gl.viewport(0, 0, canvas.width, canvas.height); }
resize(); addEventListener('resize', resize);
const held = {};
addEventListener('keydown', (e) => { held[e.code] = true; }); addEventListener('keyup', (e) => { held[e.code] = false; });
addEventListener('pointermove', (e) => { aim.x = (e.clientX - innerWidth / 2) / innerHeight; aim.y = -(e.clientY - innerHeight / 2) / innerHeight; });
function update(dt) {
  const kx = (held.ArrowRight || held.KeyD ? 1 : 0) - (held.ArrowLeft || held.KeyA ? 1 : 0), ky = (held.ArrowUp || held.KeyW ? 1 : 0) - (held.ArrowDown || held.KeyS ? 1 : 0);
  if (kx || ky) { aim.x = player.x + kx * 0.2; aim.y = player.y + ky * 0.2; }
  player.x += (aim.x - player.x) * Math.min(1, dt * 4); player.y += (aim.y - player.y) * Math.min(1, dt * 4);
  for (const o of orbs) { o.y -= dt * 0.05; if (o.y < -0.6) { o.y = 0.6; o.x = Math.random() - 0.5; } if (Math.hypot(o.x - player.x, o.y - player.y) < 0.05) { score++; o.y = 0.6; o.x = Math.random() - 0.5; } }
}
let last = 0, frameCount = 0;
function loop(t) {
  const dt = Math.min(0.1, (t - last) / 1000 || 0.016); last = t;
  // drop the resolution while frames take long (software GPUs), raise it again when there is room
  if (dt > 0.05) slow++; else slow = Math.max(0, slow - 1);
  if (slow > 3 && scale > 0.2) { scale *= 0.7; slow = 0; resize(); }
  update(dt);
  gl.uniform2f(uRes, canvas.width, canvas.height); gl.uniform1f(uTime, t / 1000); gl.uniform2f(uPlayer, player.x, player.y);
  gl.uniform3fv(uOrb, orbs.flatMap((o) => [o.x, o.y, o.r]));
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  hud.textContent = 'Orbs ' + score;
  if (++frameCount === 2) GCP.ready();
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
GCP.test.onPlaythrough(async (t) => {
  t.step('catch an orb'); const o = orbs[0]; aim.x = o.x; aim.y = o.y; player.x = o.x; player.y = o.y;
  await t.until(() => score > 0, 5000, 'an orb'); t.assert(score > 0, 'scored');
});
