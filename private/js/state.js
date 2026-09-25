import { GAMES, quantizeSens } from './games.js';
import { MODEL_VERSION } from './sensMath.js';

const STORAGE_KEY = 'r6sf_state_v1'; // name kept; the shape inside is versioned

// Settings that belong to you rather than to a game: the same mouse (DPI),
// the site's accent colour, and the sens converter card.
const SHARED_KEYS = ['dpi', 'accentColor', 'convert'];
const SHARED_DEFAULTS = {
  dpi: 800,
  accentColor: '#a50fec',
  // Sensitivity converter panel. The sens/DPI keys are deliberately absent
  // rather than null: absent means "never touched", which seeds the fields
  // from the main settings, while an explicit null means the user emptied
  // the box and it should stay empty. Deliberately not part of basisFor():
  // converting a number doesn't change the drills.
  convert: { from: 'r6_hipfire', to: 'valorant' },
};

/**
 * Saved shape (version 2):
 *   { version, game, shared: {...}, games: { r6: GameState, valorant: ..., cs2: ... } }
 *   GameState = { settings, activeTab, results: {tab: result}, resultBasis: {tab: basis} }
 *
 * getState() hands out a flattened view of whichever game is selected -
 * { game, settings: {...shared, ...gameSettings}, activeTab, results,
 * resultBasis } - which is the same shape the app used back when it was
 * Siege-only, so most of the app doesn't need to know games exist.
 */

function gameDefaults(id) {
  const def = GAMES[id];
  const tabs = def.tabs.map((t) => t.id);
  return {
    settings: structuredClone(def.defaults),
    activeTab: tabs[0],
    results: Object.fromEntries(tabs.map((t) => [t, null])),
    resultBasis: Object.fromEntries(tabs.map((t) => [t, null])),
  };
}

function fresh() {
  return normalise({ version: 2, game: 'r6', shared: {}, games: {} });
}

/** Siege settings saved before the model rework (games.js modelVersion 2):
 * - FOV went up to 110; R6's own (vertical) slider stops at 90.
 * - The old "ADS · 1x" box was a measured cm/360 filed against the 2.5x
 *   value, since 1x had no value of its own. Now that it does, there's no
 *   telling what 1x value that was measured at, so it's dropped rather than
 *   quietly skewing 1x. */
function upgradeR6Settings(s) {
  const out = { ...s, fov: Math.max(60, Math.min(90, Number(s.fov) || 60)) };
  const c1 = s.calib && s.calib.ads1x;
  if (c1 && !(c1.factor > 0)) out.calib = { ...s.calib, ads1x: null };
  // An ADS measurement stores how far off the formula was at the time. One
  // taken against an older ADS formula (before model 3) would push the new
  // one off by the same amount, so it's dropped to be measured again.
  // Hip-fire's formula hasn't changed, so its measurement stays.
  for (const tab of ['ads1x', 'ads25x']) {
    const c = out.calib && out.calib[tab];
    if (c && c.factor > 0 && c.model !== MODEL_VERSION) out.calib = { ...out.calib, [tab]: null };
  }
  return out;
}

/** A sens saved finer than the game accepts (CS2 used to allow 3 decimals
 * here, but its menu only takes 2) is rounded to what can actually be set. */
function fitSensToGame(id, s) {
  return s.sens > 0 ? { ...s, sens: quantizeSens(GAMES[id], s.sens) } : s;
}

/** Fills in anything missing - a game added since this was saved, a new
 * setting, a new tab - without touching what's there. */
function normalise(p) {
  const games = {};
  for (const id of Object.keys(GAMES)) {
    const def = gameDefaults(id);
    const saved = (p.games && p.games[id]) || {};
    const tabs = Object.keys(def.results);
    const settings = { ...def.settings, ...(saved.settings || {}) };
    games[id] = {
      settings: id === 'r6' ? upgradeR6Settings(settings) : fitSensToGame(id, settings),
      activeTab: tabs.includes(saved.activeTab) ? saved.activeTab : def.activeTab,
      results: Object.fromEntries(tabs.map((t) => [t, saved.results?.[t] ?? null])),
      resultBasis: Object.fromEntries(tabs.map((t) => [t, saved.resultBasis?.[t] ?? null])),
    };
  }
  return {
    version: 2,
    game: GAMES[p.game] ? p.game : 'r6',
    shared: { ...structuredClone(SHARED_DEFAULTS), ...(p.shared || {}) },
    games,
  };
}

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

/** Version 1 was Siege-only: { settings, activeTab, results, resultBasis }.
 * Its settings split into the shared ones and Siege's own; its results are
 * Siege results. Nothing is lost. */
function migrateV1(p) {
  const merged = migrateLegacyMeasurements({
    ...structuredClone(GAMES.r6.defaults),
    ...structuredClone(SHARED_DEFAULTS),
    ...(p.settings || {}),
  });
  const shared = {};
  const r6 = {};
  for (const [k, v] of Object.entries(merged)) (SHARED_KEYS.includes(k) ? shared : r6)[k] = v;
  return normalise({
    version: 2,
    game: 'r6',
    shared,
    games: { r6: { settings: r6, activeTab: p.activeTab, results: p.results, resultBasis: p.resultBasis } },
  });
}

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return fresh();
    const parsed = JSON.parse(raw);
    return parsed.version === 2 ? normalise(parsed) : migrateV1(parsed);
  } catch {
    return fresh();
  }
}

let data = load();
let view = buildView();
const listeners = new Set();

function buildView() {
  const g = data.games[data.game];
  return {
    game: data.game,
    settings: { ...data.shared, ...g.settings },
    activeTab: g.activeTab,
    results: g.results,
    resultBasis: g.resultBasis,
  };
}

function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch {
    // Storage full or blocked (private window) - the app still works for
    // this visit, it just won't remember anything.
  }
}

function notify() {
  view = buildView();
  persist();
  listeners.forEach((fn) => fn(view));
}

function patchGame(id, patch) {
  data = { ...data, games: { ...data.games, [id]: { ...data.games[id], ...patch } } };
}

export function getState() {
  return view;
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Switches which game the page is calibrating for. */
export function setGame(id) {
  if (!GAMES[id] || id === data.game) return;
  data = { ...data, game: id };
  notify();
}

/** A specific game's settings (plus the shared ones), whichever game is
 * currently selected. The Siege sidebar and the converter's Siege entries
 * use this so they always read Siege's numbers. */
export function getGameSettings(id) {
  return { ...data.shared, ...data.games[id].settings };
}

/** Writes to the selected game, except shared keys (DPI etc.), which go to
 * the shared settings. */
export function updateSettings(patch) {
  updateGameSettings(data.game, patch);
}

export function updateGameSettings(id, patch) {
  const shared = {};
  const own = {};
  for (const [k, v] of Object.entries(patch)) (SHARED_KEYS.includes(k) ? shared : own)[k] = v;
  data = { ...data, shared: { ...data.shared, ...shared } };
  patchGame(id, { settings: { ...data.games[id].settings, ...own } });
  notify();
}

export function setActiveTab(tab) {
  patchGame(data.game, { activeTab: tab });
  notify();
}

export function setResult(tab, result, basis) {
  const g = data.games[data.game];
  patchGame(data.game, {
    results: { ...g.results, [tab]: result },
    resultBasis: { ...g.resultBasis, [tab]: basis },
  });
  notify();
}

export function clearResult(tab) {
  setResult(tab, null, null);
}

/** A compact fingerprint of everything that changes how a given sens value
 * feels in the drills. The sens values themselves are deliberately left
 * out: a calibration tests fixed values (e.g. 42 / 50 / 58), so moving your
 * current sens - including applying the recommendation - doesn't make those
 * results any less true. Including them used to mark results "retest
 * required" the instant you applied them, and blocked fine-tuning.
 * Settings a game doesn't have are undefined and drop out of the string, so
 * a Siege fingerprint is exactly what it was before other games existed. */
export function basisFor(tab) {
  const s = view.settings;
  return JSON.stringify({
    tab,
    dpi: s.dpi,
    fov: s.fov,
    aspectRatio: s.aspectRatio,
    screenFill: s.screenFill,
    useCustomMultiplier: s.useCustomMultiplier,
    customMultiplier: s.customMultiplier,
    calib: s.calib,
    resolution: s.resolution,
    displayMode: s.displayMode,
    // A game's model version (Siege only so far): results tested under an
    // older formula felt different to the same numbers now.
    model: GAMES[data.game].modelVersion,
    // Bumped whenever scoring changes meaning, so results scored the old way
    // show "retest required" instead of being compared against new ones.
    // v2: bullseye points scoring. v3: back to hit-based, ringed targets.
    // v4: targets sized to the screen (smaller), room further back.
    // v5: 3D balls at aim-trainer size (~6% of the screen).
    // v6: flat bullseyes at ~3.5% - head-sized, micro-adjustment scale.
    scoring: 6,
  });
}

export function isStale(tab) {
  const current = view.results[tab];
  if (!current) return true;
  return view.resultBasis[tab] !== basisFor(tab);
}
