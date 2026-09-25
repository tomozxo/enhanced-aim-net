// Two-way sensitivity conversion: take the sens someone already uses in one
// game and work out the sens that gives the same physical turn distance in
// another. Everything routes through cm/360 (centimetres of mousepad for a
// full 360 turn), which is the one figure every game agrees on:
//
//   cm360 = (2.54 * 360) / (dpi * sens * yaw)
//   sens  = (2.54 * 360) / (dpi * cm360 * yaw)
//
// `yaw` is degrees of view rotation per mouse count at sensitivity 1. The
// values below are the long-settled community constants for each game, the
// same ones the big conversion sites use. Two sanity checks against numbers
// people actually quote: CS2 at 1.0 / 800 DPI = 51.9 cm, Valorant at 0.4 /
// 800 DPI = 40.8 cm. Both match.
//
// Games are only listed here when their in-game slider really is a linear
// multiplier on a fixed yaw. Fortnite, Destiny 2, Battlefield and PUBG all
// map their sliders through their own curves, so a single constant would be
// wrong for them - they go through the cm/360 option instead.

export const CM360_ID = 'cm360';

// Source-engine derived titles all share 0.022, which is why CS, Apex,
// Titanfall and TF2 convert 1:1 between each other.
const GAMES = [
  { id: 'valorant', name: 'Valorant', yaw: 0.07, decimals: 3, min: 0.1, max: 10 },
  { id: 'cs2', name: 'CS2 / CS:GO', yaw: 0.022, decimals: 2 },
  { id: 'apex', name: 'Apex Legends', yaw: 0.022, decimals: 3 },
  { id: 'titanfall2', name: 'Titanfall 2', yaw: 0.022, decimals: 3 },
  { id: 'tf2', name: 'Team Fortress 2', yaw: 0.022, decimals: 3 },
  { id: 'quake', name: 'Quake Live / Champions', yaw: 0.022, decimals: 3 },
  // Aim Lab's own scale turns at the Source rate too (its m_yaw defaults to
  // 0.022), so it's 1:1 with CS2 at the same DPI. If you've picked a game
  // under Aim Lab's "sensitivity scale" instead, that profile makes Aim Lab
  // use that game's numbers - so convert to the game, not to this.
  { id: 'aimlab', name: 'Aim Lab (default scale)', yaw: 0.022, decimals: 3 },
  { id: 'overwatch2', name: 'Overwatch 2', yaw: 0.0066, decimals: 2, min: 1, max: 100 },
  // Same turn rate as Overwatch, so the same number carries straight over.
  { id: 'rivals', name: 'Marvel Rivals', yaw: 0.0066, decimals: 2, min: 1, max: 100 },
  { id: 'cod', name: 'Call of Duty / Warzone', yaw: 0.0066, decimals: 2, min: 1, max: 20 },
];

// Siege's hip-fire yaw is passed in rather than fixed, because it moves with
// the custom multiplier (and a measured cm/360, if the user entered one).
// Only hip-fire is offered. Siege's ADS values aren't a sens on their own:
// they're relative to hip-fire (50 = same feel as hip-fire), so matching one
// to another game's cm/360 gave nonsense like "1321". Convert hip-fire and
// your ADS values carry over as they are.
export const R6_OPTICS = [
  { id: 'r6_hipfire', tab: 'hipfire', name: 'Rainbow Six Siege — Hip-fire', decimals: 0, min: 1, max: 100 },
];

/** The full picker list. `r6HipYaw` is Siege's hip-fire degrees per count
 * per sens point (sensMath's hipDegPerSensPoint). */
export function buildGameList(r6HipYaw) {
  return [
    ...R6_OPTICS.map((o) => ({ ...o, yaw: r6HipYaw, isR6: true })),
    ...GAMES,
    { id: CM360_ID, name: 'Other game — enter cm/360° directly', decimals: 1, isCm360: true },
  ];
}

export function findGame(list, id) {
  return list.find((g) => g.id === id) || null;
}

export function cm360FromSens(sens, dpi, yaw) {
  if (!(sens > 0) || !(dpi > 0) || !(yaw > 0)) return NaN;
  return (2.54 * 360) / (dpi * sens * yaw);
}

export function sensFromCm360(cm360, dpi, yaw) {
  if (!(cm360 > 0) || !(dpi > 0) || !(yaw > 0)) return NaN;
  return (2.54 * 360) / (dpi * cm360 * yaw);
}

/** cm/360 for whatever is entered on the "from" side, whether that's a game
 * sens or a cm/360 typed in directly. */
export function toCm360(game, value, dpi) {
  if (!game) return NaN;
  if (game.isCm360) return value > 0 ? Number(value) : NaN;
  return cm360FromSens(Number(value), Number(dpi), game.yaw);
}

/** The reverse: the number to type into the "to" game's settings menu. */
export function fromCm360(game, cm360, dpi) {
  if (!game) return NaN;
  if (game.isCm360) return cm360;
  return sensFromCm360(cm360, Number(dpi), game.yaw);
}

export function formatSens(sens, decimals = 3) {
  if (!isFinite(sens) || sens <= 0) return '—';
  if (decimals === 0) return String(Math.round(sens));
  return sens.toFixed(decimals);
}

/** Siege's sliders stop at 1 and 100, CoD's at 20, and so on. A conversion
 * can land outside that, which is worth saying out loud rather than printing
 * a number the game won't accept. */
export function rangeWarning(game, sens) {
  if (!game || !isFinite(sens) || sens <= 0) return '';
  if (game.min != null && sens < game.min) {
    return `That's below ${game.name}'s lowest setting (${game.min}) — you'd need to drop your DPI to match it.`;
  }
  if (game.max != null && sens > game.max) {
    return `That's above ${game.name}'s highest setting (${game.max}) — you'd need to raise your DPI to match it.`;
  }
  return '';
}
