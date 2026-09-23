// Rainbow Six Siege sensitivity model.
//
// Hip-fire: each mouse count turns you
//     sens × 0.00572958° × (MouseSensitivityMultiplierUnit / 0.02)
// Ubisoft doesn't publish this, but it's what the sens community uses, and
// it's the only value that fits mouse-sensitivity.com's recommended ranges:
// their top recommended sens at 400/800/1200/1600 DPI (20/10/7/5) all land
// on the same ~20 cm/360 with it. The earlier guess here (0.00714) was 25%
// too fast.
//
// ADS (the system since Y5S3) works *relative to hip-fire*. From Ubisoft's
// "Guide to ADS sensitivity in Y5S3": an ADS value of 50 is neutral - the
// same mouse movement covers the same distance on your monitor as it does in
// hip-fire - and that neutral point is 1 / XFactorAiming (0.02 by default,
// hence 50). "Same distance on your monitor" is 0% monitor distance
// matching (focal-length scaling): the turn shrinks by how much the sight
// magnifies the middle of the screen - a ratio of tangents, so it depends
// on your FOV:
//     ADS °/count = hip-fire °/count × (ADS value × 0.02) × zoom ratio
//     zoom ratio  = tan(sight vFOV / 2) / tan(your vFOV / 2)
// Each sight's vertical FOV is a fixed fraction of yours: 0.9 for 1×, 0.35
// for 2.5× (reverse-engineered, github.com/Skwuruhl/siegeads; Ubisoft only
// publishes its table as an image, so these two are the estimated part).
// At FOV 60 the ratios are 0.88 / 0.32; at FOV 90, 0.85 / 0.28.
// History: v1 ignored hip-fire for ADS (felt far slower than the game); v2
// used a flat 0.9 / 0.35 (2-19% too fast, depending on FOV).
//
// Measuring your real cm/360 for an optic ("Calibrate to your real sens")
// stores how far the model is off at that moment, and every later sens
// value is scaled by the same amount - so a measurement fixes the formula,
// not just one number.

export const HIP_DEG_PER_COUNT = 0.00572958; // per sens point, at multiplier 0.02
const DEFAULT_MULT_UNIT = 0.02; // MouseSensitivityMultiplierUnit default
const X_FACTOR_AIMING = 0.02; // default; makes ADS 50 the neutral value
export const SIGHT_FOV_SCALE = { ads1x: 0.9, ads25x: 0.35 }; // sight vFOV as a fraction of yours
// Saved with each measurement, so ones taken against an older ADS formula
// can be recognised (state.js drops those for ADS).
export const MODEL_VERSION = 3;

const RAD = Math.PI / 180;

/** Siege's hip-fire vertical FOV (degrees) for these settings: the 60-90
 * slider, widened to the aspect ratio up to a 150° horizontal cap - past
 * that, the vertical FOV gives way instead. */
export function r6HipVFov(settings) {
  const [w, h] = String(settings.aspectRatio || '16:9').split(':').map(Number);
  const aspect = w > 0 && h > 0 ? w / h : 16 / 9;
  const v = Math.max(60, Math.min(90, Number(settings.fov) || 60));
  if (2 * Math.atan(Math.tan((v * RAD) / 2) * aspect) <= 150 * RAD) return v;
  return (2 * Math.atan(Math.tan((150 * RAD) / 2) / aspect)) / RAD;
}

/** How much a sight slows the turn at ADS 50 - tan(sight vFOV/2) /
 * tan(hip vFOV/2). 1 for hip-fire. */
export function sightZoomRatio(tab, settings) {
  const k = SIGHT_FOV_SCALE[tab];
  if (!k) return 1;
  const v = r6HipVFov(settings) * RAD;
  return Math.tan((k * v) / 2) / Math.tan(v / 2);
}

export function customMultiplierFactor(settings) {
  return settings.useCustomMultiplier ? settings.customMultiplier / DEFAULT_MULT_UNIT : 1;
}

/** The optic's own in-game slider value (hip-fire: the H/V average). */
export function baseSensForTab(tab, settings) {
  if (tab === 'hipfire') return (settings.hipfireH + settings.hipfireV) / 2;
  if (tab === 'ads1x') return settings.ads1x;
  return settings.ads25x;
}

/** Degrees per mouse count straight from the formula, for each axis. */
function modelDegPerCount(tab, s) {
  const mult = customMultiplierFactor(s);
  const hipX = s.hipfireH * HIP_DEG_PER_COUNT * mult;
  const hipY = s.hipfireV * HIP_DEG_PER_COUNT * mult;
  if (tab === 'hipfire') return { x: hipX, y: hipY };
  const ads = baseSensForTab(tab, s) * X_FACTOR_AIMING * sightZoomRatio(tab, s);
  return { x: hipX * ads, y: hipY * ads };
}

const degFromCm360 = (cm360, dpi) => (360 * 2.54) / (cm360 * dpi);

/**
 * How much a measured cm/360 says the model is off by for this optic
 * (measured speed / model speed), or 1 without a measurement.
 * Measurements saved by older versions stored { cm360, sens, dpi, mult }
 * without the full settings; those are rebuilt from what's saved now.
 */
function calibrationFactor(tab, s) {
  const c = s.calib && s.calib[tab];
  if (!c) return 1;
  if (c.factor > 0) return c.factor;
  if (!(c.cm360 > 0) || !(c.dpi > 0)) return 1;
  if (!(c.sens > 0)) return 1;
  const then = { ...s, useCustomMultiplier: true, customMultiplier: (c.mult || 1) * DEFAULT_MULT_UNIT };
  if (tab === 'hipfire') Object.assign(then, { hipfireH: c.sens, hipfireV: c.sens });
  else then[tab] = c.sens;
  const model = modelDegPerCount(tab, then).x;
  return model > 0 ? degFromCm360(c.cm360, c.dpi) / model : 1;
}

export function isCalibrated(tab, settings) {
  const c = settings.calib && settings.calib[tab];
  return !!(c && (c.factor > 0 || (c.cm360 > 0 && c.dpi > 0)));
}

/** The ADS value at which this optic turns exactly as far as hip-fire does
 * - the value where ADS and hip-fire share a cm/360. Handy as a sanity
 * check against the game, and what neutralCalibrationFrom() pins. */
export function neutralAdsValue(tab, settings) {
  const zoom = sightZoomRatio(tab, settings) * calibrationFactor(tab, settings);
  if (!SIGHT_FOV_SCALE[tab] || !(zoom > 0)) return NaN;
  return 1 / (X_FACTOR_AIMING * zoom);
}

/**
 * Calibration without a ruler: "in game, this optic's ADS value X feels the
 * same speed as my hip-fire". At that value the optic must turn exactly as
 * far as hip-fire, which pins the sight's zoom - the one estimated part of
 * the model - for every other ADS value too.
 */
export function neutralCalibrationFrom(tab, adsValue, settings) {
  const v = Number(adsValue);
  const zoom = sightZoomRatio(tab, settings);
  if (!SIGHT_FOV_SCALE[tab] || !(v > 0) || !(zoom > 0)) return null;
  return { neutral: v, factor: 1 / (v * X_FACTOR_AIMING * zoom), model: MODEL_VERSION };
}

/** Degrees of rotation per mouse count, per axis - what the drill uses. */
export function degPerCount(tab, settings) {
  const m = modelDegPerCount(tab, settings);
  const f = calibrationFactor(tab, settings);
  return { x: m.x * f, y: m.y * f };
}

export function estimateCm360(tab, settings) {
  const d = degPerCount(tab, settings).x;
  if (!(d > 0) || !(settings.dpi > 0)) return NaN;
  return (360 * 2.54) / (d * settings.dpi);
}

/** Hip-fire degrees per count for 1 sens point (with the multiplier and any
 * hip-fire measurement) - what the game converter needs for Siege. */
export function hipDegPerSensPoint(settings) {
  return HIP_DEG_PER_COUNT * customMultiplierFactor(settings) * calibrationFactor('hipfire', settings);
}

/** Turns "I measured X cm/360 in-game for this optic" into a stored
 * correction, worked out against the settings right now. */
export function calibrationFrom(tab, cm360, settings) {
  const value = Number(cm360);
  if (!(value > 0) || !(settings.dpi > 0)) return null;
  const model = modelDegPerCount(tab, settings).x;
  if (!(model > 0)) return null;
  return { cm360: value, dpi: settings.dpi, factor: degFromCm360(value, settings.dpi) / model, model: MODEL_VERSION };
}

/**
 * "Keep ADS speed when hip-fire changes": in Siege, ADS speed is your
 * hip-fire speed scaled by the ADS value, so raising hip-fire speeds ADS up
 * too. With the toggle on, the ADS values are scaled the other way so every
 * ADS optic keeps the speed it had.
 */
export function compensateAdsForHipfireChange(oldAvg, newAvg, adsValue) {
  if (!oldAvg || oldAvg === newAvg) return adsValue;
  const compensated = adsValue * (oldAvg / newAvg);
  return Math.max(1, Math.min(100, Math.round(compensated)));
}

export function formatCm360(cm) {
  if (!isFinite(cm) || cm <= 0) return '—';
  return `${cm.toFixed(1)}`;
}
