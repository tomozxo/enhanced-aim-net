// Reads the hardware details the server locks license keys to (see
// server/fingerprint.js): the graphics card the browser renders on, CPU core
// count, memory, screen and OS. Sent with activation and with each check-in;
// the server only ever stores hashes of them.
//
// A classic script (not a module) so the key screen, the admin panel and the
// app can all use it: window.enhancedFingerprint().
(function () {
  let gpuCache = null;

  function readGpu() {
    if (gpuCache !== null) return gpuCache;
    gpuCache = '';
    try {
      const canvas = document.createElement('canvas');
      const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
      if (gl) {
        const ext = gl.getExtension('WEBGL_debug_renderer_info');
        const vendor = ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR);
        const renderer = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
        gpuCache = `${vendor} | ${renderer}`;
        // Browsers only allow a handful of WebGL contexts at once, and the
        // drills need one - give this one back straight away.
        const lose = gl.getExtension('WEBGL_lose_context');
        if (lose) lose.loseContext();
      }
    } catch (e) {
      /* no WebGL - the server treats an unknown GPU as a weaker lock */
    }
    return gpuCache;
  }

  window.enhancedFingerprint = function () {
    const s = window.screen || {};
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round((s.width || 0) * dpr);
    const h = Math.round((s.height || 0) * dpr);
    return {
      gpu: readGpu(),
      cores: String(navigator.hardwareConcurrency || ''),
      memory: String(navigator.deviceMemory || ''),
      screen: `${Math.max(w, h)}x${Math.min(w, h)}x${s.colorDepth || ''}`,
      platform: (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '',
    };
  };
})();
