// a game's render worker: draws into the canvas it was handed when the page asks for a frame (green, with a white square
// that moves 6 px each frame, so a picture of the wrong frame shows)
let gl = null, drew = false;
self.onmessage = (e) => {
  if (e.data && e.data.canvas) { gl = e.data.canvas.getContext('webgl2', { preserveDrawingBuffer: false }) || e.data.canvas.getContext('webgl', { preserveDrawingBuffer: false }); self.postMessage({ gl: !!gl }); }
  if (e.data && e.data.frame && gl) {
    gl.disable(gl.SCISSOR_TEST); gl.clearColor(0.1, 0.8, 0.1, 1); gl.clear(gl.COLOR_BUFFER_BIT);
    if (typeof e.data.frame === 'number') { gl.enable(gl.SCISSOR_TEST); gl.scissor((e.data.frame * 6) % 400, 20, 60, 60); gl.clearColor(1, 1, 1, 1); gl.clear(gl.COLOR_BUFFER_BIT); gl.disable(gl.SCISSOR_TEST); }
    if (!drew) { drew = true; self.postMessage({ drew: true }); }   // the page is ready only once the worker has drawn
  }
};
