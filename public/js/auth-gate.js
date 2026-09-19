(function () {
  const TOKEN_KEY = 'r6sf_token';

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

  function formatAsTyped(value) {
    const clean = value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    const body = clean.startsWith('R6S') ? clean.slice(3) : clean;
    const groups = body.match(/.{1,4}/g) || [];
    return ['R6S', ...groups].join('-');
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
        body: JSON.stringify({ key }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.message || 'Activation failed.');
      localStorage.setItem(TOKEN_KEY, data.token);
      msg.textContent = data.isAdmin ? 'Admin key recognized. Loading panel...' : 'Activated. Loading...';
      msg.className = 'gate-msg ok';
      window.location.href = data.isAdmin ? '/admin.html' : '/app.html';
    } catch (err) {
      msg.textContent = err.message;
      msg.className = 'gate-msg';
      btn.disabled = false;
    }
  }

  // Already have a live session? Skip straight to the tool.
  (async function autoRedirect() {
    const token = localStorage.getItem(TOKEN_KEY);
    if (!token) return;
    try {
      const res = await fetch('/api/auth/verify', {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (res.ok && data.ok) window.location.href = data.isAdmin ? '/admin.html' : '/app.html';
      else localStorage.removeItem(TOKEN_KEY);
    } catch {
      /* server unreachable, let them try activating again */
    }
  })();
})();
