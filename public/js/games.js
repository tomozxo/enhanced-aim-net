// Everything that differs between the games the drills can calibrate for:
// which sens values there are, how a sens value turns into degrees of
// rotation per mouse count, and what the game's camera looks like (field of
// view, aspect ratio, stretched or black bars, render resolution).
//
// Valorant and CS2 are exact. Both games turn the camera by a fixed number of
// degrees per mouse count, times your sens:
//   Valorant: 0.07  deg/count at sens 1
//   CS2:      0.022 deg/count at sens 1 (the default m_yaw / m_pitch)
// so the drill turns exactly as far as the game does for the same movement.
// Siege doesn't publish a formula, so it uses this app's estimate from
// sensMath.js unless the user has measured their real cm/360.

import { estimateCm360, estimateCm360Axis, baseSensForTab } from './sensMath.js';

const DEG = Math.PI / 180;

/** Vertical FOV (degrees) for a horizontal FOV at a given aspect ratio. */
export function vFovFromH(hDeg, aspect) {
  return (2 * Math.atan(Math.tan((hDeg * DEG) / 2) / aspect)) / DEG;
}
/** Horizontal FOV (degrees) for a vertical FOV at a given aspect ratio. */
export function hFovFromV(vDeg, aspect) {
  return (2 * Math.atan(Math.tan((vDeg * DEG) / 2) * aspect)) / DEG;
}

function parseAspect(ratioStr) {
  const [w, h] = String(ratioStr).split(':').map(Number);
  return w / h;
}

export function parseResolution(res) {
  const [w, h] = String(res).split('x').map(Number);
  return { w, h };
}

const DEG_PER_CM360 = (cm360, dpi) => (360 * 2.54) / (cm360 * dpi);

// Resolutions offered for Valorant and CS2: the native ones people run, plus
// the usual stretched-res picks. Whether a non-native one is stretched or
// shown with black bars is a separate setting, the same as in-game.
const COMMON_RESOLUTIONS = [
  { value: '1920x1080', aspect: '16:9' },
  { value: '2560x1440', aspect: '16:9' },
  { value: '1600x900', aspect: '16:9' },
  { value: '1280x720', aspect: '16:9' },
  { value: '1920x1200', aspect: '16:10' },
  { value: '1680x1050', aspect: '16:10' },
  { value: '1440x1080', aspect: '4:3' },
  { value: '1280x960', aspect: '4:3' },
  { value: '1024x768', aspect: '4:3' },
  { value: '1280x1024', aspect: '5:4' },
];

/**
 * Valorant and CS2 work the same way apart from their constants: one sens
 * value, a fixed yaw, and a locked vertical FOV. Both keep the vertical FOV
 * the same at every resolution and widen or narrow the horizontal FOV to fit
 * the aspect ratio. That's why 4:3 shows less of the world side-to-side, and
 * why stretching it makes everything look wider.
 */
function simpleGame({ id, name, short, yaw, vFovDeg, fovNote, defaults, rules, arrowStep, sensLabel }) {
  return {
    id,
    name,
    short,
    exact: true,
    tabs: [{ id: 'main', label: 'Sensitivity' }],
    defaults,
    rules,
    arrowStep,
    sensLabel,
    fovNote,
    yaw,
    vFovDeg,
    resolutions: COMMON_RESOLUTIONS,
    baseSens: (_tab, s) => s.sens,
    withCandidate: (s, _tab, sens) => ({ ...s, sens }),
    applySens: (_tab, sens) => ({ sens }),
    degPerCount: (_tab, s) => ({ x: s.sens * yaw, y: s.sens * yaw }),
    cm360: (_tab, s) => (s.sens > 0 && s.dpi > 0 ? (2.54 * 360) / (s.dpi * s.sens * yaw) : NaN),
    view(s) {
      const r = parseResolution(s.resolution);
      return {
        aspect: r.w / r.h,
        vFovDeg,
        stretch: s.displayMode !== 'black-bars',
        renderSize: r,
      };
    },
  };
}

export const GAMES = {
  r6: {
    id: 'r6',
    name: 'Rainbow Six Siege',
    short: 'R6',
    exact: false,
    tabs: [
      { id: 'hipfire', label: 'Hip-fire' },
      { id: 'ads1x', label: '1× ADS' },
      { id: 'ads25x', label: '2.5× ADS' },
    ],
    defaults: {
      hipfireH: 4,
      hipfireV: 4,
      ads25x: 50,
      keepAdsSpeed: true,
      useCustomMultiplier: false,
      customMultiplier: 0.02,
      fov: 87,
      aspectRatio: '16:9',
      screenFill: 'keep-aspect',
      // Per-optic real-world calibration: { cm360, sens, dpi, mult } captured
      // at the moment it was measured, so the model can rescale it to other
      // sens values instead of returning one frozen number.
      calib: { hipfire: null, ads1x: null, ads25x: null },
    },
    // Siege's sliders are whole numbers from 1 to 100, so ±1 is the finest a
    // fine-tune pass can go.
    rules: { step: 1, decimals: 0, min: 1, max: 100, minSpreadPct: 0 },
    baseSens: (tab, s) => baseSensForTab(tab, s),
    withCandidate: (s, tab, sens) => (tab === 'hipfire' ? { ...s, hipfireH: sens, hipfireV: sens } : { ...s, ads25x: sens }),
    applySens: (tab, sens) => (tab === 'hipfire' ? { hipfireH: sens, hipfireV: sens } : { ads25x: sens }),
    degPerCount(tab, s) {
      if (tab === 'hipfire') {
        return { x: DEG_PER_CM360(estimateCm360Axis('h', s), s.dpi), y: DEG_PER_CM360(estimateCm360Axis('v', s), s.dpi) };
      }
      const d = DEG_PER_CM360(estimateCm360(tab, s), s.dpi);
      return { x: d, y: d };
    },
    cm360: (tab, s) => estimateCm360(tab, s),
    view(s) {
      const aspect = parseAspect(s.aspectRatio);
      const hFov = Math.max(60, Math.min(110, s.fov));
      return { aspect, vFovDeg: vFovFromH(hFov, aspect), stretch: s.screenFill !== 'keep-aspect', renderSize: null };
    },
  },

  valorant: simpleGame({
    id: 'valorant',
    name: 'Valorant',
    short: 'Valorant',
    yaw: 0.07,
    // Valorant's FOV is locked: 103° wide on 16:9, which is a 70.53° vertical
    // FOV that stays the same on every resolution.
    vFovDeg: vFovFromH(103, 16 / 9),
    fovNote: 'Locked by Valorant',
    defaults: { sens: 0.4, resolution: '1920x1080', displayMode: 'stretch' },
    // Valorant takes sens to 3 decimals. Fine-tune stops narrowing at ±2%,
    // about the smallest change you can actually feel, and pools rounds
    // from there.
    rules: { step: 0.001, decimals: 3, min: 0.01, max: 10, minSpreadPct: 0.02 },
    arrowStep: 0.01,
    sensLabel: 'Same number as your Valorant sensitivity',
  }),

  cs2: simpleGame({
    id: 'cs2',
    name: 'CS2 / CS:GO',
    short: 'CS2',
    yaw: 0.022,
    // CS2's FOV is 90° wide at 4:3 (73.74° vertical), fixed without cheats,
    // and gets wider on wider resolutions: about 106.26° on 16:9.
    vFovDeg: vFovFromH(90, 4 / 3),
    fovNote: 'Fixed by CS2',
    defaults: { sens: 1.5, resolution: '1920x1080', displayMode: 'stretch' },
    rules: { step: 0.001, decimals: 3, min: 0.01, max: 8, minSpreadPct: 0.02 },
    arrowStep: 0.05,
    sensLabel: 'Same number as your CS2 sensitivity (default m_yaw)',
  }),
};

export const GAME_ORDER = ['r6', 'valorant', 'cs2'];

export function getGame(id) {
  return GAMES[id] || GAMES.r6;
}

/** Rounds a sens to what the game accepts. */
export function quantizeSens(game, v) {
  const { step, decimals, min, max } = game.rules;
  const q = Number((Math.round(v / step) * step).toFixed(decimals));
  return Math.max(min, Math.min(max, q));
}

/** Display form: Siege as a whole number; Valorant/CS2 up to 3 decimals with
 * trailing zeros trimmed (0.4, 0.368, 1.5). */
export function formatSens(game, v) {
  if (v == null || !isFinite(v)) return '—';
  return String(Number(Number(v).toFixed(game.rules.decimals)));
}

export function tabLabel(game, tabId) {
  return (game.tabs.find((t) => t.id === tabId) || game.tabs[0]).label;
}
