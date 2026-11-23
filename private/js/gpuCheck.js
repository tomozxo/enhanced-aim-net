// Is the browser drawing 3D on the graphics card? When Chrome's hardware
// acceleration is off (or the GPU is blocklisted) WebGL falls back to a
// software renderer (SwiftShader, llvmpipe, Microsoft Basic Render), which
// runs the drills and the range at a few frames a second however good the
// PC is. Asking for a context with failIfMajorPerformanceCaveat is the
// browser's own way of saying "only if it's hardware".

let cached = null;

export function gpuInfo() {
  if (cached) return cached;
  let renderer = '';
  let software = false;
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2') || c.getContext('webgl');
    if (!gl) {
      cached = { renderer: 'none', software: true, webgl: false };
      return cached;
    }
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    renderer = String(dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    const hw = document.createElement('canvas').getContext('webgl', { failIfMajorPerformanceCaveat: true });
    hw?.getExtension('WEBGL_lose_context')?.loseContext();
    software = !hw || /swiftshader|llvmpipe|software|basic render|mesa offscreen/i.test(renderer);
  } catch {
    /* no answer - assume it's fine */
  }
  cached = { renderer, software, webgl: true };
  return cached;
}

/** A banner across the top of the app when 3D is being drawn in software,
 * with what to change. */
export function showGpuWarning() {
  const g = gpuInfo();
  if (!g.software || document.getElementById('gpuWarning')) return;
  const isChrome = /Chrome\//.test(navigator.userAgent) && !/Edg\//.test(navigator.userAgent);
  const isEdge = /Edg\//.test(navigator.userAgent);
  const where = isEdge
    ? 'Edge: Settings → System and performance → turn on "Use graphics acceleration when available" → Restart.'
    : isChrome
      ? 'Chrome: Settings → System → turn on "Use graphics acceleration when available" → Relaunch. (chrome://gpu should then say "Hardware accelerated".)'
      : "Turn on your browser's hardware / graphics acceleration and restart it.";
  const div = document.createElement('div');
  div.id = 'gpuWarning';
  div.className = 'gpu-warning';
  div.innerHTML = `<b>Your browser isn't using your graphics card</b>, so the drills and the range will run at only a few frames a second. ${where} <button type="button" aria-label="Dismiss">✕</button>`;
  div.querySelector('button').addEventListener('click', () => div.remove());
  document.body.prepend(div);
}
