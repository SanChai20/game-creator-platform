// a game's render worker: draws into the canvas it was handed when the page asks for a frame
let gl = null;
self.onmessage = (e) => {
  if (e.data && e.data.canvas) gl = e.data.canvas.getContext('webgl2', { preserveDrawingBuffer: false }) || e.data.canvas.getContext('webgl', { preserveDrawingBuffer: false });
  if (e.data && e.data.frame && gl) { gl.clearColor(0.1, 0.8, 0.1, 1); gl.clear(gl.COLOR_BUFFER_BIT); }
};
