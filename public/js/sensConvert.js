// Converts a cm/360° figure into other games' sensitivity values, using
// each game's "yaw" constant (degrees of view rotation per mouse count at
// sensitivity 1.0) - the same cm360 = (2.54*360)/(dpi*sens*yaw) relationship
// this app already uses for R6, just solved for `sens` instead of `cm360`.
// These yaw values are the ones the sens-conversion community has settled
// on for each game (the same numbers sites like mouse-sensitivity.com use),
// not something reverse-engineered here - still worth double-checking
// in-game if a game updates its sensitivity handling.

export const CONVERT_GAMES = [
  { id: 'valorant', name: 'Valorant', yaw: 0.07 },
  { id: 'cs2', name: 'CS2 / CS:GO', yaw: 0.022 },
  { id: 'apex', name: 'Apex Legends', yaw: 0.022 },
  { id: 'overwatch2', name: 'Overwatch 2', yaw: 0.0066 },
  { id: 'fortnite', name: 'Fortnite', yaw: 0.0066 },
  { id: 'warzone', name: 'Call of Duty / Warzone', yaw: 0.0066 },
];

export function sensForGame(cm360, dpi, yaw) {
  if (!cm360 || !dpi || !yaw || !isFinite(cm360)) return null;
  return (2.54 * 360) / (dpi * cm360 * yaw);
}

export function formatSens(sens) {
  if (sens == null || !isFinite(sens)) return '—';
  return sens >= 10 ? sens.toFixed(1) : sens.toFixed(3);
}
