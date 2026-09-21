// Keeps the app's session honest. The session itself is an HttpOnly cookie
// the server set at activation; this checks in with the machine's hardware
// fingerprint (fingerprint.js) when the app opens and every minute after,
// so a session that's been replaced (the key activated somewhere else) or is
// being used from the wrong PC ends within a minute.

const RECHECK_MS = 60 * 1000;

function bounceToActivation(message) {
  if (message) sessionStorage.setItem('r6sf_gate_msg', message);
  window.location.href = '/index.html';
}

async function checkIn() {
  const fp = window.enhancedFingerprint ? window.enhancedFingerprint() : null;
  const res = await fetch('/api/auth/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fp }),
  });
  const data = await res.json().catch(() => ({}));
  return { res, data };
}

export async function ensureSession() {
  // The first check has to actually succeed - the app only shows once the
  // server has confirmed this browser and PC. A couple of retries cover a
  // momentary network blip.
  let first = null;
  for (let attempt = 0; attempt < 3 && !first; attempt++) {
    try {
      first = await checkIn();
    } catch {
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  if (!first) {
    bounceToActivation("Couldn't reach the server. Try again in a moment.");
    return null;
  }
  if (!first.res.ok || !first.data.ok) {
    bounceToActivation(first.data.message || 'Enter your license key to continue.');
    return null;
  }

  // After that, a server hiccup (5xx) or dropped connection isn't held
  // against the user - only a definite "no" (401) ends the session.
  const recheck = async () => {
    try {
      const { res, data } = await checkIn();
      if (res.status === 401) bounceToActivation(data.message || 'Your session ended. Enter your key again.');
    } catch {
      /* network blip - try again next time */
    }
  };
  setInterval(recheck, RECHECK_MS);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') recheck();
  });

  return first.data;
}
