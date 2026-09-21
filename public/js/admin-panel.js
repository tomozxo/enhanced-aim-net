// Admin panel (public/admin.html). Kept in its own file rather than inline
// so the site's Content-Security-Policy can forbid inline scripts.
//
// Signing in: an admin key activates like any key (browser + PC lock) and
// its session is an HttpOnly cookie. Every request here also sends the PC's
// hardware fingerprint, so copied admin cookies don't work on another
// machine. The raw ADMIN_TOKEN still works as a way back in, but is only
// held in memory for this page - never saved.

// Only set when signing in with the raw ADMIN_TOKEN. An admin key's session
// is an HttpOnly cookie the browser sends by itself.
let token = '';

// Older versions kept the raw ADMIN_TOKEN in this tab's storage; clear it.
try {
  sessionStorage.removeItem('r6sf_admin_token');
} catch {}

/** The PC's hardware fingerprint as a header value (base64 JSON, so any
 * character in a GPU name is safe to send). */
function fingerprintHeader() {
  const fp = window.enhancedFingerprint ? window.enhancedFingerprint() : null;
  const bytes = new TextEncoder().encode(JSON.stringify(fp));
  let bin = '';
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin);
}

const gate = document.getElementById('gate');
const panel = document.getElementById('panel');
const gateMsg = document.getElementById('gateMsg');
const createMsg = document.getElementById('createMsg');

document.querySelectorAll('.mode-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.documentElement.dataset.theme = btn.dataset.mode === 'light' ? 'light' : 'dark';
    try { localStorage.setItem('r6sf_theme_mode', btn.dataset.mode); } catch {}
    refreshModeButtons();
  });
});
function refreshModeButtons() {
  const mode = document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
  document.querySelectorAll('.mode-btn').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
}
refreshModeButtons();

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      'X-Enhanced-Fp': fingerprintHeader(),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(opts.headers || {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) throw new Error(data.message || `Request failed (${res.status})`);
  return data;
}

async function tryEnter() {
  const raw = document.getElementById('adminToken').value.trim();
  if (!raw) return;
  gateMsg.textContent = 'Checking...';
  gateMsg.className = 'gate-msg';
  try {
    if (/^R6S-/i.test(raw)) {
      // An admin key signs in like any key (same browser + PC lock); the
      // session comes back as a cookie.
      const res = await fetch('/api/auth/activate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: raw, fp: window.enhancedFingerprint ? window.enhancedFingerprint() : null }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.message || 'That key did not activate.');
      if (!data.isAdmin) throw new Error('That key works, but it is not an admin key.');
      token = '';
      await api('/api/admin/keys');
    } else {
      token = raw;
      await api('/api/admin/keys');
    }
    gate.style.display = 'none';
    panel.style.display = '';
    loadKeys();
    loadWhoami();
  } catch (e) {
    gateMsg.textContent = e.message;
    gateMsg.className = 'gate-msg';
  }
}

/** Straight into the panel if an admin key is already signed in on this
 * browser and PC (session cookie); otherwise show the sign-in box. */
async function trySavedSession() {
  token = '';
  try {
    await api('/api/admin/keys');
    panel.style.display = '';
    loadKeys();
    loadWhoami();
    return;
  } catch {}
  gate.style.display = 'flex';
}

async function loadWhoami() {
  const el = document.getElementById('whoamiText');
  try {
    const data = await api('/api/admin/me');
    if (data.viaRawToken) {
      el.innerHTML = 'Signed in with the raw <code class="key-code">ADMIN_TOKEN</code> from your server\'s .env file.';
    } else if (data.key) {
      el.innerHTML =
        `Signed in as <code class="key-code">${esc(data.key)}</code>${data.note ? ' &mdash; ' + esc(data.note) : ''}. ` +
        `Every key you generate below is created under this admin session.`;
    } else {
      el.textContent = '';
    }
  } catch {
    el.textContent = '';
  }
}

document.getElementById('unlockBtn').addEventListener('click', tryEnter);
document.getElementById('adminToken').addEventListener('keydown', (e) => { if (e.key === 'Enter') tryEnter(); });

// Short dates ("21 Sep, 9:53 pm") keep the table narrow enough to fit.
function fmt(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
}

// Notes are typed in by hand, so never insert them as HTML.
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function lockText(k) {
  if (!k.lockedDeviceId) return '—';
  if (!k.hardwareLocked) return 'Browser'; // activated before hardware locking; locks fully on next sign-in
  return k.gpuCount > 1 ? 'Browser + PC (2 GPUs)' : 'Browser + PC';
}

function blockedText(k) {
  if (!k.blockedAttempts) return '0';
  return `<span class="blocked-flag" title="Last one: ${esc(fmt(k.lastBlockedAt))}">${k.blockedAttempts} ⚠</span>`;
}

async function loadKeys() {
  const { keys } = await api('/api/admin/keys');
  const tbody = document.querySelector('#keysTable tbody');
  tbody.innerHTML = '';
  keys
    .slice()
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .forEach((k) => {
      const tr = document.createElement('tr');
      // data-label is what each value is called when a narrow window shows
      // the keys as cards instead of a table.
      tr.innerHTML = `
        <td data-label="Key"><code class="key-code">${k.key}</code></td>
        <td data-label="Status"><span class="status-pill ${k.status}">${k.status}</span></td>
        <td data-label="Note" class="note-cell">${esc(k.note) || '—'}</td>
        <td data-label="Admin">${k.isAdmin ? '✓' : ''}</td>
        <td data-label="Locked to">${lockText(k)}</td>
        <td data-label="Blocked attempts">${blockedText(k)}</td>
        <td data-label="Last seen">${fmt(k.lastSeenAt)}</td>
        <td data-label="Expires">${k.expiresAt ? fmt(k.expiresAt) : 'never'}</td>
        <td class="actions-cell">
          <div class="row-actions">
            <button class="btn-small" data-act="unlock" data-key="${k.key}" ${!k.lockedDeviceId ? 'disabled' : ''} title="Lets the key be activated on a new browser/PC">Reset lock</button>
            <button class="btn-small danger" data-act="revoke" data-key="${k.key}" ${k.status === 'revoked' ? 'disabled' : ''}>Revoke</button>
            <button class="btn-small danger" data-act="delete" data-key="${k.key}">Delete</button>
          </div>
        </td>
      `;
      tbody.appendChild(tr);
    });
}

document.querySelector('#keysTable tbody').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const { act, key } = btn.dataset;
  try {
    if (act === 'unlock') {
      if (!confirm(`Reset the lock on ${key}? It signs out wherever it's in use, and the next browser/PC to enter it becomes its new home.`)) return;
      await api(`/api/admin/keys/${key}/unlock`, { method: 'POST' });
    }
    if (act === 'revoke') {
      if (!confirm(`Revoke ${key}? This immediately locks out anyone using it.`)) return;
      await api(`/api/admin/keys/${key}/revoke`, { method: 'POST' });
    }
    if (act === 'delete') {
      if (!confirm(`Permanently delete ${key}? This can't be undone.`)) return;
      await api(`/api/admin/keys/${key}`, { method: 'DELETE' });
    }
    loadKeys();
  } catch (err) {
    alert(err.message);
  }
});

document.getElementById('createBtn').addEventListener('click', async () => {
  const note = document.getElementById('note').value;
  const expiresInDays = document.getElementById('expiresInDays').value;
  const isAdmin = document.getElementById('isAdminCheckbox').checked;
  createMsg.textContent = 'Generating...';
  createMsg.className = 'form-msg';
  try {
    const { key } = await api('/api/admin/keys', {
      method: 'POST',
      body: JSON.stringify({ note, expiresInDays: expiresInDays || null, isAdmin }),
    });
    createMsg.innerHTML = '';
    createMsg.className = 'form-msg ok';
    const label = document.createElement('span');
    label.textContent = `Created ${key.key}${isAdmin ? ' (admin)' : ''} — `;
    const copyBtn = document.createElement('button');
    copyBtn.className = 'btn-small';
    copyBtn.style.padding = '3px 9px';
    copyBtn.style.fontSize = '11px';
    copyBtn.textContent = 'Copy';
    copyBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(key.key);
        copyBtn.textContent = 'Copied';
        setTimeout(() => (copyBtn.textContent = 'Copy'), 1500);
      } catch {
        alert(key.key);
      }
    });
    createMsg.appendChild(label);
    createMsg.appendChild(copyBtn);
    document.getElementById('note').value = '';
    document.getElementById('expiresInDays').value = '';
    document.getElementById('isAdminCheckbox').checked = false;
    loadKeys();
  } catch (e) {
    createMsg.textContent = e.message;
    createMsg.className = 'form-msg err';
  }
});

document.getElementById('refreshBtn').addEventListener('click', loadKeys);

trySavedSession();
