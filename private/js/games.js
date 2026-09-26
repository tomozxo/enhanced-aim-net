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
// How finely each game's ADS multipliers can be set.
const MULT_RULES_2 = { step: 0.01, decimals: 2, min: 0.01, max: 10 };
const MULT_RULES_3 = { step: 0.001, decimals: 3, min: 0.01, max: 10 };
// CS2's zoom_sensitivity_ratio is often set in the console to 6 decimals
// (0.818933 is the well-known one), finer than its menu slider.
const CS_ZOOM_RULES = { step: 0.000001, decimals: 6, min: 0.01, max: 10 };

const COMMON_RESOLUTIONS = [
  { value: '1920x1080', aspect: '16:9' },
  { value: '2560x1440', aspect: '16:9' },
  { value: '1600x900', aspect: '16:9' },
  { value: '1280x720', aspect: '16:9' },
  { value: '1920x1200', aspect: '16:10' },
  { value: '1680x1050', aspect: '16:10' },
  { value: '1920x1440', aspect: '4:3' },
  { value: '1440x1080', aspect: '4:3' },
  { value: '1280x960', aspect: '4:3' },
  { value: '1024x768', aspect: '4:3' },
  { value: '1280x1024', aspect: '5:4' },
];

const tanHalf = (deg) => Math.tan((deg * DEG) / 2);
/** The vertical FOV a sight of `m`× magnification gives (a change in focal
 * length, the way optics actually zoom). */
const magnified = (vDeg, m) => (2 * Math.atan(tanHalf(vDeg) / m)) / DEG;

// ---------- Aiming down sights (The Range) ----------
// Each game's sights, and what its own ADS setting does to the turn while
// you aim, checked September 2026:
//   Siege: Ubisoft's ADS system in sensMath.js (relative to hip-fire).
//   Valorant: zooming divides the 103° FOV by the zoom (1.25× on the Vandal
//     and Phantom, 2.5× on the Operator's first zoom) and the turn by the
//     same, times the ADS or scoped multiplier - 1.0 matches at the screen
//     edge.
//   CS2: rifles like the AK and M4 don't aim down sights at all; the AUG and
//     SG 553 scope to a 45° FOV, the AWP to 40° (both measured on 4:3), and
//     the turn scales by zoomed FOV / 90 × zoom_sensitivity_ratio.
//   Apex: the turn scales by the change in focal length (tan ratio) × the
//     ADS multiplier; the 2× HCOG is a 69.68° FOV on 16:9.
//   Call of Duty: "Relative" ADS (the default) with its 1.33 monitor
//     distance coefficient, × the ADS multiplier.
//   Overwatch 2: Widowmaker's and Ana's scopes divide the vertical FOV by
//     2.348 (51° wide at FOV 103), and the turn is your sens × "Relative aim
//     sensitivity while zoomed" (30% by default).
//   Marvel Rivals: most heroes don't aim down sights, so the range leaves it
//   out.
//
// ads: { sights: [{ id, label, optic: 'dot'|'scope', reticle, key, setting,
// rules }], view(s, sightId) -> vertical FOV while aimed, degPerCount(s,
// sightId) -> {x, y} while aimed }. `key` is the setting holding your
// in-game value for that sight, `setting` what the game calls it.

/** A simple game's ADS: its FOV while aimed, and how much slower (or
 * faster) than hip-fire the turn gets, from its sights. */
function simpleAds(game, { sights, vFov, factor }) {
  const find = (id) => sights.find((x) => x.id === id) || sights[0];
  return {
    sights,
    view(s, id) {
      return vFov(s, find(id), game.view(s).vFovDeg);
    },
    degPerCount(s, id) {
      const sight = find(id);
      const hipV = game.view(s).vFovDeg;
      const f = factor(s, sight, hipV, vFov(s, sight, hipV));
      const d = game.degPerCount('main', s);
      return { x: d.x * f, y: d.y * f };
    },
  };
}

/**
 * Valorant and CS2 work the same way apart from their constants: one sens
 * value, a fixed yaw, and a locked vertical FOV. Both keep the vertical FOV
 * the same at every resolution and widen or narrow the horizontal FOV to fit
 * the aspect ratio. That's why 4:3 shows less of the world side-to-side, and
 * why stretching it makes everything look wider.
 */
function simpleGame({ id, name, short, yaw, vFovDeg, fovSlider, fovNote, defaults, rules, arrowStep, sensLabel, ads }) {
  const game = {
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
      // Games with their own FOV slider show a horizontal FOV measured at
      // 16:9 (Call of Duty, Overwatch) or 4:3 (Apex, which is Source-based
      // like CS), and keep the vertical where it is when the aspect ratio
      // changes.
      const v = fovSlider
        ? vFovFromH(Math.max(fovSlider.min, Math.min(fovSlider.max, Number(s.fov) || fovSlider.min)), fovSlider.basis || 16 / 9)
        : vFovDeg;
      return {
        aspect: r.w / r.h,
        vFovDeg: v,
        stretch: s.displayMode !== 'black-bars',
        renderSize: r,
      };
    },
  };
  game.ads = ads ? simpleAds(game, ads) : null;
  return game;
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
    // The range's sights are the two optics Siege's model covers, using
    // your ADS value for each - the same numbers as the 1× and 2.5× tabs.
    ads: {
      sights: [
        { id: 'ads1x', label: '1× red dot', optic: 'dot', key: 'ads1x', setting: '1× ADS', rules: { step: 1, decimals: 0, min: 1, max: 100 } },
        { id: 'ads25x', label: '2.5× scope', optic: 'scope', reticle: 'chevron', key: 'ads25x', setting: '2.5× ADS', rules: { step: 1, decimals: 0, min: 1, max: 100 } },
      ],
      view: (s, id) => r6HipVFov(s) * (SIGHT_FOV_SCALE[id] || SIGHT_FOV_SCALE.ads1x),
      degPerCount: (s, id) => r6DegPerCount(SIGHT_FOV_SCALE[id] ? id : 'ads1x', s),
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
    defaults: { sens: 0.4, resolution: '1920x1080', displayMode: 'stretch', adsMult: 1, scopedMult: 1 },
    // Valorant takes sens to 3 decimals. Fine-tune stops narrowing at ±2%,
    // about the smallest change you can actually feel, and pools rounds
    // from there.
    rules: { step: 0.001, decimals: 3, min: 0.01, max: 10, minSpreadPct: 0.02 },
    arrowStep: 0.01,
    sensLabel: 'Same number as your Valorant sensitivity',
    ads: {
      sights: [
        { id: 'rifle', label: 'Vandal / Phantom · 1.25×', optic: 'dot', zoom: 1.25, key: 'adsMult', setting: 'ADS sens multiplier', rules: MULT_RULES_3 },
        { id: 'operator', label: 'Operator · 2.5×', optic: 'scope', reticle: 'sniper', zoom: 2.5, key: 'scopedMult', setting: 'Scoped sens multiplier', rules: MULT_RULES_3 },
      ],
      vFov: (_s, sight) => vFovFromH(103 / sight.zoom, 16 / 9),
      factor: (s, sight) => (Number(s[sight.key]) || 1) / sight.zoom,
    },
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
    defaults: { sens: 1.5, resolution: '1920x1080', displayMode: 'stretch', zoomRatio: 1 },
    // CS2's settings menu takes sens to 2 decimals, so that's the finest a
    // recommendation can be - one you can actually type in.
    rules: { step: 0.01, decimals: 2, min: 0.01, max: 8, minSpreadPct: 0.02 },
    arrowStep: 0.05,
    sensLabel: 'Same number as your CS2 sensitivity (default m_yaw)',
    ads: {
      sights: [
        { id: 'aug', label: 'AUG / SG 553 scope', optic: 'scope', reticle: 'dot', fov: 45, key: 'zoomRatio', setting: 'Zoom sensitivity', rules: CS_ZOOM_RULES },
        { id: 'awp', label: 'AWP scope', optic: 'scope', reticle: 'sniper', fov: 40, key: 'zoomRatio', setting: 'Zoom sensitivity', rules: CS_ZOOM_RULES },
      ],
      vFov: (_s, sight) => vFovFromH(sight.fov, 4 / 3),
      factor: (s, sight) => (Number(s.zoomRatio) || 1) * (sight.fov / 90),
    },
  }),

  // Apex is Source-derived, so it shares CS2's 0.022 per count. Its FOV
  // slider (70-110) is a horizontal FOV measured on 4:3, like CS - 90 is
  // 106.26° wide on 16:9.
  apex: simpleGame({
    id: 'apex',
    name: 'Apex Legends',
    short: 'Apex',
    yaw: 0.022,
    fovSlider: { min: 70, max: 110, basis: 4 / 3 },
    fovNote: "Apex's own slider, 70-110",
    defaults: { sens: 1.6, fov: 90, resolution: '1920x1080', displayMode: 'stretch', adsScalar: 1 },
    rules: { step: 0.01, decimals: 2, min: 0.1, max: 20, minSpreadPct: 0.02 },
    arrowStep: 0.05,
    sensLabel: 'Same number as your Apex mouse sensitivity',
    ads: {
      sights: [
        { id: 'hcog2', label: '2× HCOG Bruiser', optic: 'scope', reticle: 'chevron', key: 'adsScalar', setting: 'ADS sens multiplier', rules: MULT_RULES_2 },
      ],
      vFov: () => vFovFromH(69.68, 16 / 9),
      factor: (s, _sight, hipV, adsV) => (Number(s.adsScalar) || 1) * (tanHalf(adsV) / tanHalf(hipV)),
    },
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
    defaults: { sens: 6, fov: 100, resolution: '1920x1080', displayMode: 'stretch', adsMult: 1 },
    rules: { step: 0.01, decimals: 2, min: 0.1, max: 20, minSpreadPct: 0.02 },
    arrowStep: 0.25,
    sensLabel: 'Same number as your Call of Duty sensitivity (Black Ops 6/7, Warzone)',
    // A reflex sight zooms about 1.2× ("Affected" ADS FOV, so it follows
    // your FOV slider). Relative ADS keeps the same monitor distance at
    // 1.33 × the half-height, the game's default coefficient.
    ads: {
      sights: [{ id: 'reflex', label: 'Reflex sight', optic: 'dot', zoom: 1.2, key: 'adsMult', setting: 'ADS sens multiplier', rules: MULT_RULES_2 }],
      vFov: (_s, sight, hipV) => magnified(hipV, sight.zoom),
      factor: (s, _sight, hipV, adsV) =>
        (Number(s.adsMult) || 1) * (Math.atan(1.33 * tanHalf(adsV)) / Math.atan(1.33 * tanHalf(hipV))),
    },
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
    defaults: { sens: 5, fov: 103, resolution: '1920x1080', displayMode: 'stretch', zoomRel: 30 },
    rules: { step: 0.01, decimals: 2, min: 0.1, max: 100, minSpreadPct: 0.02 },
    arrowStep: 0.25,
    sensLabel: 'Same number as your Overwatch sensitivity',
    ads: {
      sights: [
        {
          id: 'widow',
          label: 'Widowmaker / Ana scope',
          optic: 'scope',
          reticle: 'sniper',
          key: 'zoomRel',
          setting: 'Zoomed sens %',
          rules: { step: 0.01, decimals: 2, min: 0.01, max: 100 },
        },
      ],
      vFov: (_s, _sight, hipV) => hipV / 2.348,
      factor: (s) => (Number(s.zoomRel) || 30) / 100,
    },
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

/** Display form: Siege as a whole number; the rest to their own decimals
 * (Valorant 3, CS2 and most others 2) with trailing zeros trimmed (0.4,
 * 0.368, 1.5). */
export function formatSens(game, v) {
  if (v == null || !isFinite(v)) return '—';
  return String(Number(Number(v).toFixed(game.rules.decimals)));
}

export function tabLabel(game, tabId) {
  return (game.tabs.find((t) => t.id === tabId) || game.tabs[0]).label;
}
