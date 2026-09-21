(function () {
  // Sessions live in an HttpOnly cookie now (set by the server), so there's
  // no token for this page to store - clear the one older versions kept.
  try {
    localStorage.removeItem('r6sf_token');
  } catch {}

  const fingerprint = () => (window.enhancedFingerprint ? window.enhancedFingerprint() : null);

  document.querySelectorAll('.mode-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.documentElement.dataset.theme = btn.dataset.mode === 'light' ? 'light' : 'dark';
      try {
        localStorage.setItem('r6sf_theme_mode', btn.dataset.mode);
      } catch {}
      refreshModeButtons();
    });
  });
  function refreshModeButtons() {
    const mode = document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
    document.querySelectorAll('.mode-btn').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
  }
  refreshModeButtons();

  const input = document.getElementById('keyInput');
  const btn = document.getElementById('activateBtn');
  const msg = document.getElementById('gateMsg');

  const bounceMsg = sessionStorage.getItem('r6sf_gate_msg');
  if (bounceMsg) {
    msg.textContent = bounceMsg;
    sessionStorage.removeItem('r6sf_gate_msg');
  }

  const PREFIX = 'R6S';

  function formatAsTyped(value) {
    const clean = value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!clean) return '';
    // Backspacing down into the prefix itself leaves a fragment like "R" or
    // "R6" - that's a partial prefix, not typed body content. Leave it
    // exactly as-is instead of slapping a fresh "R6S-" in front of it (that
    // was the bug: deleting down to "R6" kept re-expanding into "R6S-R6").
    if (clean.length <= PREFIX.length && PREFIX.startsWith(clean)) return clean;
    const body = clean.startsWith(PREFIX) ? clean.slice(PREFIX.length) : clean;
    const groups = body.match(/.{1,4}/g) || [];
    return [PREFIX, ...groups].join('-');
  }

  input.addEventListener('input', () => {
    const pos = input.selectionStart;
    const before = input.value.length;
    input.value = formatAsTyped(input.value);
    const after = input.value.length;
    input.selectionStart = input.selectionEnd = Math.max(0, pos + (after - before));
  });

  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') activate(); });
  btn.addEventListener('click', activate);

  async function activate() {
    const key = input.value.trim();
    if (!key) return;
    btn.disabled = true;
    msg.textContent = 'Activating...';
    msg.className = 'gate-msg';
    try {
      const res = await fetch('/api/auth/activate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, fp: fingerprint() }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.message || 'Activation failed.');
      msg.textContent = data.isAdmin ? 'Admin key recognized. Loading panel...' : 'Activated. Loading...';
      msg.className = 'gate-msg ok';
      window.location.href = data.isAdmin ? '/admin.html' : '/app.html';
    } catch (err) {
      msg.textContent = err.message;
      msg.className = 'gate-msg';
      btn.disabled = false;
    }
  }

  // Already have a live session (cookie)? Skip straight to the tool. Not
  // when we were just sent back here with a message - that session ended.
  (async function autoRedirect() {
    if (bounceMsg) return;
    try {
      const res = await fetch('/api/auth/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fp: fingerprint() }),
      });
      const data = await res.json();
      if (res.ok && data.ok) window.location.href = data.isAdmin ? '/admin.html' : '/app.html';
    } catch {
      /* server unreachable, let them try activating again */
    }
  })();
})();
