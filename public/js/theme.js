const SWATCHES = ['#8b5cf6', '#e5493a', '#e58a3a', '#e0c93a', '#4ac26b', '#3ab6e5', '#c04ae0', '#e04a8f'];
const MODE_KEY = 'r6sf_theme_mode';

export function getMode() {
  try {
    return localStorage.getItem(MODE_KEY) === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

export function applyMode(mode) {
  document.documentElement.dataset.theme = mode === 'light' ? 'light' : 'dark';
  try {
    localStorage.setItem(MODE_KEY, mode);
  } catch {
    /* private browsing etc. - theme just won't persist */
  }
}

export function initModeToggle() {
  const btns = document.querySelectorAll('.mode-btn');
  if (!btns.length) return;
  function refresh() {
    const mode = getMode();
    btns.forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
  }
  btns.forEach((b) => {
    b.addEventListener('click', () => {
      applyMode(b.dataset.mode);
      refresh();
    });
  });
  applyMode(getMode());
  refresh();
}

export function applyAccent(hex) {
  document.documentElement.style.setProperty('--accent', hex);
  // Rough translucent variant used for a couple of subtle fills.
  document.documentElement.style.setProperty('--accent-dim', hex + '33');
}

export function initThemePicker({ getAccent, onChange }) {
  const picker = document.getElementById('accentPicker');
  const swatchWrap = document.getElementById('accentSwatches');

  swatchWrap.innerHTML = '';
  SWATCHES.forEach((hex) => {
    const btn = document.createElement('button');
    btn.className = 'accent-swatch';
    btn.style.background = hex;
    btn.dataset.hex = hex;
    btn.title = hex;
    btn.addEventListener('click', () => {
      picker.value = hex;
      onChange(hex);
      refreshActive();
    });
    swatchWrap.appendChild(btn);
  });

  function refreshActive() {
    const current = getAccent();
    [...swatchWrap.children].forEach((el) => {
      el.classList.toggle('active', el.dataset.hex.toLowerCase() === current.toLowerCase());
    });
  }

  picker.addEventListener('input', () => {
    onChange(picker.value);
    refreshActive();
  });

  picker.value = getAccent();
  applyAccent(getAccent());
  refreshActive();
}
