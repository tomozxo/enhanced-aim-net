// Approximate sensitivity model. This is NOT Ubisoft's exact formula - Siege
// doesn't publish one, and 1x optics apply an internal speed-up that isn't
// exposed as a settings-menu number at all. Each tab has its own tuned
// constant so the numbers move the right direction and land in a plausible
// range; "Match mouse movement" lets the user override the 1x estimate with
// a value they actually measured in-game.

const MODEL = {
  hipfire: { const: 0.00714 },
  ads1x: { const: 0.0003934 }, // tuned so 50 sens / 800 dpi -> ~58.1 cm/360
  ads25x: { const: 0.000254 },
};

function customMultiplierFactor(settings) {
  return settings.useCustomMultiplier ? settings.customMultiplier / 0.02 : 1;
}

export function baseSensForTab(tab, settings) {
  if (tab === 'hipfire') return (settings.hipfireH + settings.hipfireV) / 2;
  return settings.ads25x; // ads1x has no raw slider of its own; it borrows the 2.5x value as its input
}

function cm360FromSensValue(tab, sensValue, settings) {
  const degPerCount = MODEL[tab].const * sensValue * customMultiplierFactor(settings);
  const countsPer360 = 360 / degPerCount;
  const inches = countsPer360 / settings.dpi;
  return inches * 2.54;
}

const MEASURED_KEY = { hipfire: 'measuredCm360_hipfire', ads1x: 'measuredCm360_1x', ads25x: 'measuredCm360_ads25x' };

export function estimateCm360(tab, settings) {
  const measured = settings[MEASURED_KEY[tab]];
  if (measured) return Number(measured);
  const sensValue = baseSensForTab(tab, settings);
  return cm360FromSensValue(tab, sensValue, settings);
}

export function estimateCm360Axis(axis, settings) {
  // hip-fire only: H and V can differ, so drills track them independently -
  // but a measured override is a single real-world number, so it applies to
  // both axes equally (there's no way to separately measure H vs V).
  if (settings.measuredCm360_hipfire) return Number(settings.measuredCm360_hipfire);
  const sensValue = axis === 'h' ? settings.hipfireH : settings.hipfireV;
  return cm360FromSensValue('hipfire', sensValue, settings);
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
