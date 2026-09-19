const TOKEN_KEY = 'r6sf_token';
const RECHECK_MS = 5 * 60 * 1000;

function bounceToActivation(message) {
  if (message) sessionStorage.setItem('r6sf_gate_msg', message);
  window.location.href = '/index.html';
}

async function verify() {
  const token = localStorage.getItem(TOKEN_KEY);
  if (!token) {
    bounceToActivation();
    return null;
  }
  try {
    const res = await fetch('/api/auth/verify', { headers: { Authorization: `Bearer ${token}` } });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      localStorage.removeItem(TOKEN_KEY);
      bounceToActivation(data.message || 'Session expired. Re-activate your key.');
      return null;
    }
    return data;
  } catch {
    // Server unreachable - don't kick the user out of a working session over
    // a transient network blip, just skip this check.
    return { ok: true, offline: true };
  }
}

export async function ensureSession() {
  const session = await verify();
  if (!session) return null;

  setInterval(verify, RECHECK_MS);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') verify();
  });

  return session;
}
