const STORAGE_KEY = 'r6sf_state_v1';

const DEFAULTS = {
  settings: {
    hipfireH: 4,
    hipfireV: 4,
    ads25x: 50,
    keepAdsSpeed: true,
    useCustomMultiplier: false,
    customMultiplier: 0.02,
    dpi: 800,
    fov: 87,
    aspectRatio: '16:9',
    screenFill: 'keep-aspect',
    measuredCm360_1x: null,
    accentColor: '#e5493a',
  },
  activeTab: 'hipfire', // hipfire | ads1x | ads25x
  // Per-tab calibration results. null until a calibration run finishes.
  results: {
    hipfire: null,
    ads1x: null,
    ads25x: null,
  },
  // Settings snapshot each result was computed against, so we can detect staleness.
  resultBasis: {
    hipfire: null,
    ads1x: null,
    ads25x: null,
  },
};

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return structuredClone(DEFAULTS);
    const parsed = JSON.parse(raw);
    return {
      ...structuredClone(DEFAULTS),
      ...parsed,
      settings: { ...structuredClone(DEFAULTS.settings), ...(parsed.settings || {}) },
      results: { ...structuredClone(DEFAULTS.results), ...(parsed.results || {}) },
      resultBasis: { ...structuredClone(DEFAULTS.resultBasis), ...(parsed.resultBasis || {}) },
    };
  } catch {
    return structuredClone(DEFAULTS);
  }
}

let state = load();
const listeners = new Set();

function persist() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

export function getState() {
  return state;
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function notify() {
  persist();
  listeners.forEach((fn) => fn(state));
}

export function updateSettings(patch) {
  state = { ...state, settings: { ...state.settings, ...patch } };
  notify();
}

export function setActiveTab(tab) {
  state = { ...state, activeTab: tab };
  notify();
}

export function setResult(tab, result, basis) {
  state = {
    ...state,
    results: { ...state.results, [tab]: result },
    resultBasis: { ...state.resultBasis, [tab]: basis },
  };
  notify();
}

export function clearResult(tab) {
  setResult(tab, null, null);
}

/** A compact fingerprint of everything that affects a tab's drill feel/estimate. */
export function basisFor(tab) {
  const s = state.settings;
  return JSON.stringify({
    tab,
    hipfireH: s.hipfireH,
    hipfireV: s.hipfireV,
    ads25x: s.ads25x,
    dpi: s.dpi,
    fov: s.fov,
    aspectRatio: s.aspectRatio,
    measuredCm360_1x: s.measuredCm360_1x,
  });
}

export function isStale(tab) {
  const current = state.results[tab];
  if (!current) return true;
  return state.resultBasis[tab] !== basisFor(tab);
}
