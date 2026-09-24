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
// Siege uses the model in sensMath.js: its hip-fire formula, and Ubisoft's
// ADS system on top (ADS relative to hip-fire, scaled by the sight's zoom).

import {
  estimateCm360,
  degPerCount as r6DegPerCount,
  baseSensForTab,
  r6HipVFov,
  SIGHT_FOV_SCALE,
  MODEL_VERSION,
} from './sensMath.js';

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
function simpleGame({ id, name, short, yaw, vFovDeg, fovSlider, fovNote, defaults, rules, arrowStep, sensLabel }) {
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
    fovSlider,
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
      // Games with their own FOV slider (Apex, Call of Duty) show a
      // horizontal FOV measured at 16:9, and keep the vertical where it is
      // when the aspect ratio changes.
      const v = fovSlider
        ? vFovFromH(Math.max(fovSlider.min, Math.min(fovSlider.max, Number(s.fov) || fovSlider.min)), 16 / 9)
        : vFovDeg;
      return {
        aspect: r.w / r.h,
        vFovDeg: v,
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
    // Bumped when the model changes what a sens value feels like, so results
    // tested under the old model show "retest required" (see basisFor).
    // 2: real hip-fire constant, ADS relative to hip-fire, vertical FOV.
    // 3: ADS zoom ratio by focal length (depends on FOV).
    // 4: Ubisoft's own FOV multipliers - 2.5x was using the 3.0x row.
    modelVersion: MODEL_VERSION,
    defaults: {
      hipfireH: 4,
      hipfireV: 4,
      ads1x: 50,
      ads25x: 50,
      keepAdsSpeed: true,
      useCustomMultiplier: false,
      customMultiplier: 0.02,
      fov: 60, // Siege's own default; its FOV setting is vertical (60-90)
      aspectRatio: '16:9',
      screenFill: 'keep-aspect',
      // Per-optic real-world calibration: { cm360, dpi, factor } - how far
      // the model was off when measured, so it rescales to other sens values.
      calib: { hipfire: null, ads1x: null, ads25x: null },
    },
    // Siege's sliders are whole numbers from 1 to 100, so ±1 is the finest a
    // fine-tune pass can go.
    rules: { step: 1, decimals: 0, min: 1, max: 100, minSpreadPct: 0 },
    baseSens: (tab, s) => baseSensForTab(tab, s),
    withCandidate: (s, tab, sens) => (tab === 'hipfire' ? { ...s, hipfireH: sens, hipfireV: sens } : { ...s, [tab]: sens }),
    applySens: (tab, sens) => (tab === 'hipfire' ? { hipfireH: sens, hipfireV: sens } : { [tab]: sens }),
    degPerCount: (tab, s) => r6DegPerCount(tab, s),
    cm360: (tab, s) => estimateCm360(tab, s),
    /** Siege's FOV setting is vertical, 60-90 (Ubisoft's ADS guide), widened
     * to fit the aspect ratio - up to a 150° horizontal cap, past which the
     * vertical gives way. Aiming down a sight narrows it by the sight's zoom,
     * the same as in-game; without that the ADS drills showed a hip-fire
     * view turning at ADS speed, which felt far slower than the game. */
    view(s, tab) {
      const aspect = parseAspect(s.aspectRatio);
      // The same FOV the sens model uses, so what you see and how fast it
      // turns can't disagree.
      const vFov = r6HipVFov(s) * (SIGHT_FOV_SCALE[tab] || 1);
      return { aspect, vFovDeg: vFov, stretch: s.screenFill !== 'keep-aspect', renderSize: null };
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

  // Apex is Source-derived, so it shares CS2's 0.022 per count. Its FOV
  // slider (70-110) is a horizontal FOV at 16:9.
  apex: simpleGame({
    id: 'apex',
    name: 'Apex Legends',
    short: 'Apex',
    yaw: 0.022,
    fovSlider: { min: 70, max: 110 },
    fovNote: "Apex's own slider, 70-110",
    defaults: { sens: 1.6, fov: 90, resolution: '1920x1080', displayMode: 'stretch' },
    rules: { step: 0.01, decimals: 2, min: 0.1, max: 20, minSpreadPct: 0.02 },
    arrowStep: 0.05,
    sensLabel: 'Same number as your Apex mouse sensitivity',
  }),

  // Call of Duty turns 0.0066° per count at sensitivity 1 - the constant
  // every converter uses, still current for Black Ops 6/7 and Warzone
  // (sens 1 at 800 DPI is 173.2 cm/360). FOV slider 60-120, horizontal.
  cod: simpleGame({
    id: 'cod',
    name: 'Call of Duty',
    short: 'CoD',
    yaw: 0.0066,
    fovSlider: { min: 60, max: 120 },
    fovNote: "Call of Duty's own slider, 60-120",
    defaults: { sens: 6, fov: 100, resolution: '1920x1080', displayMode: 'stretch' },
    rules: { step: 0.01, decimals: 2, min: 0.1, max: 20, minSpreadPct: 0.02 },
    arrowStep: 0.25,
    sensLabel: 'Same number as your Call of Duty sensitivity (Black Ops 6/7, Warzone)',
  }),

  // Overwatch 2 turns 0.0066 deg per count at sens 1. Its FOV slider is
  // 80-103, horizontal.
  overwatch: simpleGame({
    id: 'overwatch',
    name: 'Overwatch 2',
    short: 'OW2',
    yaw: 0.0066,
    fovSlider: { min: 80, max: 103 },
    fovNote: "Overwatch's own slider, 80-103",
    defaults: { sens: 5, fov: 103, resolution: '1920x1080', displayMode: 'stretch' },
    rules: { step: 0.01, decimals: 2, min: 0.1, max: 100, minSpreadPct: 0.02 },
    arrowStep: 0.25,
    sensLabel: 'Same number as your Overwatch sensitivity',
  }),

  // Marvel Rivals shares Overwatch's 0.0066, so the same number at the same
  // DPI is the same turn in both (sens 5 at 800 DPI is 34.6 cm/360 in each).
  // Some converters list it as 0.022 like CS2, which would make a normal
  // sens about 10 cm/360 - far faster than anyone plays.
  rivals: simpleGame({
    id: 'rivals',
    name: 'Marvel Rivals',
    short: 'Rivals',
    yaw: 0.0066,
    fovSlider: { min: 60, max: 120 },
    fovNote: "Marvel Rivals' own slider, horizontal",
    defaults: { sens: 5, fov: 103, resolution: '1920x1080', displayMode: 'stretch' },
    rules: { step: 0.01, decimals: 2, min: 0.1, max: 100, minSpreadPct: 0.02 },
    arrowStep: 0.25,
    sensLabel: 'Same number as your Marvel Rivals sensitivity',
  }),
};

export const GAME_ORDER = ['r6', 'valorant', 'cs2', 'apex', 'cod', 'overwatch', 'rivals'];

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
