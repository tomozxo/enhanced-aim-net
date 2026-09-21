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
    // Per-optic real-world calibration: { cm360, sens, dpi, mult } captured
    // at the moment it was measured, so the model can rescale it to other
    // sens values instead of returning one frozen number.
    calib: {
      hipfire: null,
      ads1x: null,
      ads25x: null,
    },
    accentColor: '#a50fec',
    // Sensitivity converter panel. The sens/DPI keys are deliberately absent
    // rather than null: absent means "never touched", which seeds the fields
    // from the main settings above, while an explicit null means the user
    // emptied the box and it should stay empty. Deliberately not part of
    // basisFor(): converting a number doesn't change the drills.
    convert: { from: 'r6_hipfire', to: 'valorant' },
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

/** Older builds stored a bare measured cm/360 per optic with no record of
 * what sens it was measured at. Carry those over by assuming they were
 * measured at whatever sens is saved now - the best guess available, and
 * still better than dropping the measurement. */
function migrateLegacyMeasurements(settings) {
  if (settings.calib && (settings.calib.hipfire || settings.calib.ads1x || settings.calib.ads25x)) return settings;
  const calib = { hipfire: null, ads1x: null, ads25x: null, ...(settings.calib || {}) };
  const legacy = [
    ['hipfire', settings.measuredCm360_hipfire, settings.hipfireH],
    ['ads1x', settings.measuredCm360_1x, settings.ads25x],
    ['ads25x', settings.measuredCm360_ads25x, settings.ads25x],
  ];
  legacy.forEach(([tab, cm360, sens]) => {
    if (cm360 > 0 && sens > 0 && settings.dpi > 0) {
      calib[tab] = { cm360: Number(cm360), sens: Number(sens), dpi: Number(settings.dpi), mult: 1 };
    }
  });
  delete settings.measuredCm360_hipfire;
  delete settings.measuredCm360_1x;
  delete settings.measuredCm360_ads25x;
  return { ...settings, calib };
}

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return structuredClone(DEFAULTS);
    const parsed = JSON.parse(raw);
    const settings = migrateLegacyMeasurements({
      ...structuredClone(DEFAULTS.settings),
      ...(parsed.settings || {}),
    });
    return {
      ...structuredClone(DEFAULTS),
      ...parsed,
      settings,
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
    useCustomMultiplier: s.useCustomMultiplier,
    customMultiplier: s.customMultiplier,
    calib: s.calib,
  });
}

export function isStale(tab) {
  const current = state.results[tab];
  if (!current) return true;
  return state.resultBasis[tab] !== basisFor(tab);
}
