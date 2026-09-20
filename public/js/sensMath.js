// Sensitivity model, in two modes:
//
// 1. Uncalibrated (default): a per-optic "yaw" constant (degrees of view
//    rotation per mouse count at sens 1). These are educated guesses, NOT
//    Ubisoft's real formula - Siege doesn't publish one. Treat them as a
//    ballpark starting point, nothing more.
//
// 2. Calibrated: you measure your real in-game cm/360 once and enter it.
//    That measurement is converted into a yaw constant for that optic, so
//    every other sens value scales correctly off your real number - which
//    is what makes the drill actually match the game, and what makes the
//    candidates a calibration run tests (e.g. 42 / 50 / 58) genuinely feel
//    different from each other.
//
// Storing the measurement as a constant rather than as a fixed cm/360 is
// the important part: a fixed value would return the same number no matter
// what sens it was asked about, which silently made all three calibration
// candidates identical.

const FALLBACK_YAW = {
  hipfire: 0.00714,
  ads1x: 0.0003934,
  ads25x: 0.000254,
};

const DEFAULT_MULT_UNIT = 0.02; // R6's MouseSensitivityMultiplierUnit default

export function customMultiplierFactor(settings) {
  return settings.useCustomMultiplier ? settings.customMultiplier / DEFAULT_MULT_UNIT : 1;
}

export function baseSensForTab(tab, settings) {
  if (tab === 'hipfire') return (settings.hipfireH + settings.hipfireV) / 2;
  return settings.ads25x; // ads1x has no raw slider of its own; it borrows the 2.5x value as its input
}

/** The sens value a cm/360 measurement for this optic corresponds to. A
 * cm/360 is measured by turning horizontally, so hip-fire uses H, not the
 * H/V average. */
export function measuredSensForTab(tab, settings) {
  return tab === 'hipfire' ? settings.hipfireH : settings.ads25x;
}

function calibFor(tab, settings) {
  const c = settings.calib && settings.calib[tab];
  if (c && c.cm360 > 0 && c.sens > 0 && c.dpi > 0) return c;
  return null;
}

export function isCalibrated(tab, settings) {
  return !!calibFor(tab, settings);
}

/** Degrees of view rotation per mouse count at sens 1 - derived from the
 * user's own measurement when there is one, otherwise the fallback guess. */
function yawFor(tab, settings) {
  const c = calibFor(tab, settings);
  if (!c) return FALLBACK_YAW[tab];
  return (2.54 * 360) / (c.dpi * c.sens * (c.mult || 1) * c.cm360);
}

function cm360For(tab, sensValue, settings) {
  const degPerCount = yawFor(tab, settings) * sensValue * customMultiplierFactor(settings);
  if (!(degPerCount > 0) || !(settings.dpi > 0)) return NaN;
  return ((360 / degPerCount) / settings.dpi) * 2.54;
}

export function estimateCm360(tab, settings) {
  return cm360For(tab, baseSensForTab(tab, settings), settings);
}

export function estimateCm360Axis(axis, settings) {
  // hip-fire only: H and V can differ, so drills rotate each axis at its own
  // rate. Both share the same calibrated yaw - a measurement is one
  // horizontal turn, there's no way to measure V separately.
  const sensValue = axis === 'h' ? settings.hipfireH : settings.hipfireV;
  return cm360For('hipfire', sensValue, settings);
}

/** Turns "I measured X cm/360 in-game" into the stored snapshot, pinned to
 * the settings it was measured at so it can be rescaled later. */
export function calibrationFrom(tab, cm360, settings) {
  const value = Number(cm360);
  const sens = measuredSensForTab(tab, settings);
  if (!(value > 0) || !(sens > 0) || !(settings.dpi > 0)) return null;
  return { cm360: value, sens, dpi: settings.dpi, mult: customMultiplierFactor(settings) };
}

/**
 * "Keep ADS speed when hip-fire changes": in Siege, ADS turn speed is
 * coupled to hip-fire sens under the hood, so raising hip-fire also speeds
 * up ADS unless compensated. When the toggle is on, we scale the ADS·2.5x
 * value inversely to hip-fire's change so the estimated ADS cm/360 stays
 * put.
 */
export function compensateAdsForHipfireChange(oldAvg, newAvg, ads25x) {
  if (!oldAvg || oldAvg === newAvg) return ads25x;
  const ratio = newAvg / oldAvg;
  const compensated = ads25x / ratio;
  return Math.max(1, Math.min(100, Math.round(compensated)));
}

export function formatCm360(cm) {
  if (!isFinite(cm) || cm <= 0) return '—';
  return `${cm.toFixed(1)}`;
}
