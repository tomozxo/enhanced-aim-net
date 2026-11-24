// Recoil control: what each gun does to your aim while you hold the trigger,
// and how a spray is scored. Rust only for now - see below for why Siege
// isn't here.
//
// RUST (checked 24 November 2026)
//   How recoil works now: Facepunch's Combat Update (June 2022) replaced
//   pattern-based recoil with aim drift that's different on every burst,
//   and nothing in their devblogs from then to November 2026 has changed
//   that (the only recoil mentions since are a shield bug fix in April 2026,
//   the new mortar and ADS sway on boats). Every current gun's recoil
//   setting is a "...recoil.nopattern" one.
//   Per-gun values: the game client's own recoil settings, as published by
//   RustFront from client builds 25129251 (inspected 8 Sept 2026) and
//   25231061 (LMGs, 12 Sept 2026). Each shot kicks your aim by a random
//   amount inside the gun's pitch and yaw ranges, scaled by its recoil
//   curves (indexed by shot ÷ shots-until-max) and by the ADS scale while
//   aimed, eased in over its time-to-take; the cone each bullet leaves
//   inside comes from the gun's aim-cone curve over the magazine. Fire
//   rate, magazine and aimed cone are cross-checked against the Rust wiki's
//   current item pages (wiki.rustclash.com) - every one matches.
//   Left out because they couldn't be confirmed: the semi-automatics (SAR,
//   M39, SKS, M16A2 - no current recoil values found), and the "max recoil
//   radius" setting (how the game applies it isn't documented, and the
//   published client reading doesn't use it).
//
// RAINBOW SIX SIEGE: not included. Ubisoft keep retuning recoil (416-C in
// July 2026, M762 on 17 Nov 2026...) and no source publishes current per-gun
// numbers - the only per-gun figures found call themselves estimates.
//
// Everything is in degrees of view turn; pitch up and yaw right are
// positive here. The kick moves your actual aim - in Rust the bullets go
// where the view points - so the mouse movement that cancels it is exactly
// the game's: degrees ÷ the game's degrees per count at your sens.

/** A Unity animation curve's keys: [time, value, inSlope, outSlope]. */
const FLAT = [[0, 1, 0, 0], [1, 1, 0, 0]];
const AR_YAW = [[0, 0, 2.3384, 2.3384], [1, 1, -0.0767, -0.0767]];
const LR_YAW = [[0, 0, 2.3384, 2.3384], [0.0842, 0.7238, 0.9224, 0.9224], [1, 1, -0.0767, -0.0767]];
const SMG_YAW = [[0, 1, 0, 0], [0.1098, 1.0128, 0.5276, 0.5276], [0.2104, 1.2847, 3.3157, 3.3157], [0.5091, 1.5661, 1.7549, 1.7549], [0.75, 2, 0, 0], [1, 2, 0, 0]];
const LMG_YAW = [[0, -0.0005, 6.5629, 6.5629], [0.1, 1, 0.0109, 0.0109], [1, 1, 0, 0]];
const CONE_AR = [[0, -0.0005, 6.5629, 6.5629], [0.5, 1, 0.0279, 0.0279], [1, 1, 0, 0]];
const CONE_LR = [[0, -0.0005, 6.5805, 6.5805], [0.25, 1, 0.0279, 0.0279], [1, 1, 0, 0]];
const CONE_SMG = [[0, -0.0005, 6.5629, 6.5629], [0.1, 1, 0.0109, 0.0109], [1, 1, 0, 0]];
const CONE_HMLMG = [[0, 0.1, 8.9712, 8.9712], [0.1963, 0.4, -0.9537, -0.9537], [0.6, 0.4, 0.9549, 0.9549], [1, 0.75, 0.0935, 0.0935]];
const CONE_M249 = [[0, 0.05, 6.5629, 6.5629], [0.05, 0.5, 3.0281, 3.0281], [0.4127, 1.0065, 0.072, 0.072], [1, 1, 0.1303, 0.1303]];

const SRC_AR = 'client build 25129251, 8 Sept 2026';
const SRC_LMG = 'client build 25231061, 12 Sept 2026';

// delay: seconds between shots; yaw/pitch: per-shot range in degrees (the
// game's own sign: negative pitch kicks up); take: seconds each kick eases
// in over; ads: kick multiplier while aimed; untilMax: shots for the
// curves to reach their end; cones in degrees across.
export const RUST_GUNS = [
  { id: 'ak', name: 'Assault Rifle', delay: 0.1333, mag: 30, yaw: [1.5, 2.5], pitch: [-2.5, -3.5], take: 0.1, ads: 0.75, untilMax: 10, yawCurve: AR_YAW, pitchCurve: FLAT, hipCone: 2.5, cone: 0.2, coneCurve: CONE_AR, coneScale: 1.25, source: SRC_AR },
  { id: 'lr', name: 'LR-300 Assault Rifle', delay: 0.12, mag: 30, yaw: [-0.5, 0.5], pitch: [-2, -3], take: 0.1, ads: 0.75, untilMax: 15, yawCurve: LR_YAW, pitchCurve: FLAT, hipCone: 3, cone: 0.2, coneCurve: CONE_LR, coneScale: 1.25, source: SRC_AR },
  { id: 'mp5', name: 'MP5A4', delay: 0.1, mag: 30, yaw: [-1, 1], pitch: [-1, -3], take: 0.1, ads: 0.5, untilMax: 10, yawCurve: SMG_YAW, pitchCurve: FLAT, hipCone: 3, cone: 0.5, coneCurve: CONE_SMG, coneScale: 1, source: SRC_AR },
  { id: 'thompson', name: 'Thompson', delay: 0.13, mag: 20, yaw: [-1, 1], pitch: [-1.5, -2], take: 0.1, ads: 0.5, untilMax: 30, yawCurve: SMG_YAW, pitchCurve: FLAT, hipCone: 1.8, cone: 0.5, coneCurve: CONE_SMG, coneScale: 1.5, source: SRC_AR },
  { id: 'custom', name: 'Custom SMG', delay: 0.1, mag: 30, yaw: [-1, 1], pitch: [-1.5, -2], take: 0.1, ads: 0.5, untilMax: 30, yawCurve: SMG_YAW, pitchCurve: FLAT, hipCone: 1.8, cone: 0.5, coneCurve: CONE_SMG, coneScale: 1.5, source: SRC_AR },
  { id: 'm249', name: 'M249', delay: 0.12, mag: 100, yaw: [1.25, 2.25], pitch: [-3, -4], take: 0.15, ads: 0.5, untilMax: 20, yawCurve: LMG_YAW, pitchCurve: FLAT, hipCone: 4, cone: 0.2, coneCurve: CONE_M249, coneScale: 2.5, source: SRC_LMG },
  { id: 'hmlmg', name: 'HMLMG', delay: 0.125, mag: 60, yaw: [-1.25, -2.5], pitch: [-3, -4], take: 0.15, ads: 0.5, untilMax: 20, yawCurve: LMG_YAW, pitchCurve: FLAT, hipCone: 4, cone: 0.2, coneCurve: CONE_HMLMG, coneScale: 4.25, source: SRC_LMG },
].map((g) => ({ ...g, rpm: Math.round(60 / g.delay), auto: true, reset: 0.3 }));

export const RECOIL_GUNS = { rust: RUST_GUNS };

// Rust attachments (same client data, builds of September 2026): each
// changes some of recoil, time between shots, aimed cone, hip cone and
// magazine - multipliers multiply, additions add (both checked on a live
// server by the publisher). Cross-checked against Facepunch: scopes add
// recoil (July 2022), the silencer lost its accuracy bonus (July 2022, so it
// changes nothing here and isn't listed), and Gas Compression Overdrive fits
// the Thompson and Custom SMG (Sept 2024).
// Left out because they couldn't be confirmed: scopes and the holosight
// (how they change your aimed sens and zoom is unverified), the Burst
// Module (which of these guns take it), and crouching (marked experimental).
export const RUST_ATTACHMENTS = {
  muzzle: [
    { id: 'brake', name: 'Muzzle Brake', recoil: 0.5, aimCone: [1, 0.5], hipCone: [1, 2] },
    { id: 'boost', name: 'Muzzle Boost', delay: 0.9, aimCone: [1, 0.15], hipCone: [1, 0.5] },
  ],
  underbarrel: [{ id: 'laser', name: 'Laser Sight', aimCone: [0.8, 0], hipCone: [0.5, 0] }],
  magazine: [{ id: 'extended', name: 'Extended Magazine', mag: 1.25 }],
  gco: [{ id: 'gco', name: 'Gas Compression Overdrive', recoil: 1.1, delay: 1.2, only: ['thompson', 'custom'] }],
};
export const ATTACHMENT_SLOTS = [
  ['muzzle', 'Muzzle'],
  ['underbarrel', 'Underbarrel'],
  ['magazine', 'Magazine'],
  ['gco', 'Gas compression'],
];

/** The attachments that fit a gun, slot by slot. */
export function attachmentsFor(gun) {
  const out = {};
  for (const [slot] of ATTACHMENT_SLOTS) {
    const fits = (RUST_ATTACHMENTS[slot] || []).filter((a) => !a.only || a.only.includes(gun.id));
    if (fits.length) out[slot] = fits;
  }
  return out;
}

/** A gun with attachments fitted ({ slot: attachment id }): its recoil,
 * fire rate, cones and magazine changed by each one. */
export function withAttachments(gun, picks = {}) {
  const fits = attachmentsFor(gun);
  const on = Object.entries(picks)
    .map(([slot, id]) => (fits[slot] || []).find((a) => a.id === id))
    .filter(Boolean);
  if (!on.length) return { ...gun, recoilScale: 1, coneMod: [1, 0], hipMod: [1, 0], fitted: [] };
  const mul = (k) => on.reduce((v, a) => v * (a[k] ?? 1), 1);
  const cone = (k) => on.reduce(([s, o], a) => (a[k] ? [s * a[k][0], o + a[k][1]] : [s, o]), [1, 0]);
  const delay = gun.delay * mul('delay');
  return {
    ...gun,
    delay,
    rpm: Math.round(60 / delay),
    mag: Math.ceil(gun.mag * mul('mag')),
    recoilScale: mul('recoil'),
    coneMod: cone('aimCone'),
    hipMod: cone('hipCone'),
    fitted: on.map((a) => a.name),
  };
}

/** Target distances in metres. */
export const RECOIL_DISTANCES = { rust: [10, 25, 50] };

export const gunsFor = (gameId) => RECOIL_GUNS[gameId] || null;
export const gunById = (gameId, id) => {
  const guns = gunsFor(gameId);
  return guns ? guns.find((g) => g.id === id) || guns[0] : null;
};

/** Evaluates a Unity animation curve (cubic Hermite between keys), held
 * flat outside its first and last keys. */
export function evalCurve(keys, t) {
  if (!keys.length) return 0;
  if (t <= keys[0][0]) return keys[0][1];
  const last = keys[keys.length - 1];
  if (t >= last[0]) return last[1];
  for (let i = 1; i < keys.length; i++) {
    const [t1, v1, in1] = keys[i];
    if (t > t1) continue;
    const [t0, v0, , out0] = keys[i - 1];
    const dt = t1 - t0;
    const s = (t - t0) / dt;
    const s2 = s * s;
    const s3 = s2 * s;
    return (2 * s3 - 3 * s2 + 1) * v0 + (s3 - 2 * s2 + s) * dt * out0 + (-2 * s3 + 3 * s2) * v1 + (s3 - s2) * dt * in1;
  }
  return last[1];
}

/** The kick after shot `index` (0 = the first shot of the spray), in
 * degrees: { yaw: right +, pitch: up + }. `aimed` applies the ADS scale. */
export function kickFor(gun, index, aimed, rng = Math.random) {
  const t = Math.min(1, Math.max(0, Math.floor(index) / Math.max(1, gun.untilMax)));
  const scale = (aimed ? gun.ads : 1) * (gun.recoilScale ?? 1);
  const yaw = (gun.yaw[0] + (gun.yaw[1] - gun.yaw[0]) * rng()) * scale * evalCurve(gun.yawCurve, t);
  const pitch = -(gun.pitch[0] + (gun.pitch[1] - gun.pitch[0]) * rng()) * scale * evalCurve(gun.pitchCurve, t);
  return { yaw, pitch };
}

/** The cone (degrees across) shot `index` leaves inside: the hip-fire cone,
 * or the aimed cone plus the gun's curve over the magazine. */
export function coneFor(gun, index, aimed) {
  if (!aimed) {
    const [s, o] = gun.hipMod || [1, 0];
    return Math.max(0, gun.hipCone * s + o);
  }
  const t = (index / gun.mag) % 1;
  const [s, o] = gun.coneMod || [1, 0];
  return Math.max(0, (gun.cone + evalCurve(gun.coneCurve, t) * gun.coneScale) * s + o);
}

/** Milliseconds between shots. */
export const shotMs = (gun) => gun.delay * 1000;

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/** The thirds of a spray the feedback talks about. */
function phases(n) {
  if (n <= 6) return [{ from: 2, to: n, label: `shots 2-${n}` }];
  const a = Math.max(2, Math.round(n / 3));
  const b = Math.round((2 * n) / 3);
  return [
    { from: 2, to: a, label: `shots 2-${a}` },
    { from: a + 1, to: b, label: `shots ${a + 1}-${b}` },
    { from: b + 1, to: n, label: `shots ${b + 1}-${n}` },
  ];
}

/**
 * Scores one spray. shots: [{ dx, dy (degrees from the first bullet, right
 * and up), hit }]; applied: the recoil you actually got, cumulative per
 * shot (degrees); distance in metres.
 *  - onTarget: share of bullets that hit the target.
 *  - control: how much of the recoil you took out - 1 means every bullet
 *    went where the first did, 0 as far as if you hadn't pulled at all.
 *  - groupCm: average distance of each bullet from the first, at the target.
 *  - phases: the average miss through the opening, middle and end.
 */
export function scoreSpray(shots, applied, distance) {
  const n = shots.length;
  const later = shots.slice(1);
  const off = later.map((s) => Math.hypot(s.dx, s.dy));
  const free = applied.slice(1, n).map(([x, y]) => Math.hypot(x, y));
  const cmPerDeg = Math.tan(Math.PI / 180) * distance * 100;
  const control = free.length && mean(free) > 0 ? Math.max(0, Math.min(1, 1 - mean(off) / mean(free))) : null;
  return {
    shots: n,
    onTarget: n ? shots.filter((s) => s.hit).length / n : 0,
    control,
    groupCm: later.length ? mean(off) * cmPerDeg : 0,
    phases: phases(n).map((p) => {
      const part = shots.filter((_, i) => i + 1 >= p.from && i + 1 <= p.to);
      return { ...p, dx: mean(part.map((s) => s.dx)), dy: mean(part.map((s) => s.dy)) };
    }),
  };
}

/** One line of advice from a run: the part of the spray that went furthest
 * wrong, which way, and what to do about it. */
export function recoilAdvice(sprays, distance) {
  if (!sprays.length) return null;
  const cmPerDeg = Math.tan(Math.PI / 180) * distance * 100;
  const byLabel = new Map();
  for (const s of sprays) {
    for (const p of s.score.phases) {
      const a = byLabel.get(p.label) || { label: p.label, from: p.from, dx: [], dy: [] };
      a.dx.push(p.dx);
      a.dy.push(p.dy);
      byLabel.set(p.label, a);
    }
  }
  const parts = [...byLabel.values()].map((a) => ({ label: a.label, from: a.from, dx: mean(a.dx), dy: mean(a.dy) }));
  const worst = parts.reduce((w, p) => (Math.hypot(p.dx, p.dy) > Math.hypot(w.dx, w.dy) ? p : w), parts[0]);
  const cm = (deg) => `${Math.round(Math.abs(deg) * cmPerDeg)} cm`;
  const OK = 0.25; // a quarter of a degree - a head is under half a degree wide at 25 m
  if (Math.abs(worst.dx) < OK && Math.abs(worst.dy) < OK) {
    return { tone: 'good', title: 'Spray under control', text: 'No part of the spray strays more than a quarter of a degree from your first shot on average. Try a longer distance or a harder gun next.' };
  }
  const bits = [];
  if (Math.abs(worst.dy) >= OK) bits.push(worst.dy > 0 ? `climbing ${cm(worst.dy)} above your first shot - pull down harder there` : `dropping ${cm(worst.dy)} below your first shot - you're pulling down too hard there`);
  if (Math.abs(worst.dx) >= OK) bits.push(worst.dx > 0 ? `drifting ${cm(worst.dx)} right - pull left there` : `drifting ${cm(worst.dx)} left - pull right there`);
  return { tone: 'work', title: `Work on ${worst.label}`, text: `On ${worst.label} your bullets are ${bits.join(', and ')}.` };
}
