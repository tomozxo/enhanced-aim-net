// The recoil trainer's guns: what each one does to your aim while you hold
// the trigger, for Rust and Rainbow Six Siege, and how a spray is scored.
//
// Where the numbers come from (checked November 2026). Neither Facepunch nor
// Ubisoft publish per-bullet recoil, so these are community figures from
// people who demonstrate the sprays, not values read out of the games:
//
//   Rust - fire rate, magazine and aim cone: the Rust wiki (wiki.rustclash.com
//     item pages: AK 450 RPM, LR-300 500, MP5A4 600, Custom SMG 600,
//     Thompson 462, SAR 343; aim cone 0.2° on the rifles, 0.5° on the SMGs).
//     How far each gun climbs and swings, how much aiming down sights cuts
//     that (the ADS scale) and the hip-fire cone: RustAssist's weapon pages
//     (AK: pitch 4-30°, yaw -2 to 8°, ADS ×0.5, hip cone 2.5°). Shape of
//     each spray: XGamingServer's Rust recoil-pattern viewer, the
//     bullet-by-bullet dots it shows for each gun when you don't pull down.
//     A third source agrees on the size: SprayTrace's pages give the aimed
//     climb as AK 13°, LR-300 10.5°, MP5A4 8.5°, Thompson 7°, Custom SMG
//     7.5° - against RustAssist's 15, 9, 5, 7.5 and 7.5 once the ADS scale
//     is applied - and the recoil reset (how long off the trigger before the
//     pattern starts again). Rust's pattern is fixed - the same every spray -
//     with the aim cone on top, which is why it can be learnt. The M249,
//     HMLMG and M39 had no spray demonstration to copy, so their path is
//     built from their recoil ranges alone (marked `estimated`).
//   Siege - fire rate, magazine, how far it climbs and how wide the sideways
//     kick wanders: SprayTrace's Rainbow Six Siege pattern pages. Siege's
//     sideways kick is random every spray (inside a set width) on top of a
//     steady climb, and the first few shots kick hardest (Ubisoft's own
//     patch notes talk about a "first-shot" recoil multiplier). So a Siege
//     spray here climbs the same every time and wanders differently each
//     time - you learn the pull-down and react to the side kick, the way
//     you have to in the game.
//
// Everything is in degrees of view turn. The kick moves your actual aim -
// in both games the bullets go where the crosshair now points - so the
// mouse movement that cancels it is exactly the game's: degrees ÷ the
// game's degrees per count at your sens (games.js), for hip-fire or ADS.

/** Cumulative [right, up] of each bullet when you don't pull at all, in
 * the viewer's units; scaled to degrees by `climb` below. */
const RUST_SHAPES = {
  ak: [[0,0],[0,12],[2,22],[-1,32],[-2,42],[3,50],[5,58],[-4,65],[-5,70],[2,75],[8,78],[10,81],[6,84],[-3,87],[-12,89],[-18,90],[-20,92],[-15,94],[-6,97],[2,100],[10,102],[18,103],[22,104],[25,104],[22,105],[12,106],[-2,107],[-14,108],[-20,109],[-22,110]],
  lr: [[0,0],[0,10],[-2,18],[-4,26],[-6,34],[-4,42],[0,50],[4,56],[8,60],[6,66],[-1,70],[-8,72],[-14,74],[-17,76],[-15,78],[-8,80],[2,82],[12,84],[18,85],[20,86],[15,88],[6,90],[-4,92],[-14,94],[-20,95],[-18,97],[-10,99],[0,100],[10,101],[16,102]],
  mp5: [[0,0],[0,8],[-1,16],[-2,22],[-2,28],[-1,34],[1,40],[3,44],[5,48],[4,52],[1,55],[-3,58],[-6,60],[-8,62],[-7,64],[-4,66],[0,68],[5,70],[8,71],[9,72],[7,74],[3,75],[-2,76],[-6,77],[-9,78],[-8,80],[-4,81],[0,82],[4,83],[7,84]],
  thompson: [[0,0],[0,14],[-2,26],[-3,38],[-2,48],[2,56],[6,62],[4,68],[-2,72],[-8,75],[-11,78],[-10,81],[-4,83],[3,85],[8,86],[10,88],[7,90],[0,92],[-6,93],[-9,94]],
  // 24 dots in the viewer; the gun holds 30, so the last six repeat the
  // snake's last swing (see extend()).
  custom: [[0,0],[0,9],[-1,18],[-2,26],[-1,32],[2,38],[4,44],[3,48],[-1,52],[-5,55],[-7,57],[-5,60],[0,62],[4,64],[6,66],[4,68],[-1,70],[-5,72],[-7,74],[-4,76],[0,78],[4,80],[6,82],[5,84]],
};

/** Carries a pattern on past its last dot by repeating the steps of its
 * last `period` shots. */
function extend(shape, n, period) {
  const out = shape.map((p) => [...p]);
  while (out.length < n) {
    const k = out.length;
    const a = out[k - period];
    const b = out[k - period - 1];
    const last = out[k - 1];
    out.push([last[0] + (a[0] - b[0]), last[1] + (a[1] - b[1])]);
  }
  return out;
}

/** A shape in degrees, hip-fire: scaled so its last bullet sits `climb`
 * up, and its side-to-side swing spans `yawSpan` (the gun's yaw range). */
function toDegrees(shape, climb, yawSpan) {
  const top = shape[shape.length - 1][1];
  const xs = shape.map((p) => p[0]);
  const wide = Math.max(...xs) - Math.min(...xs);
  const kx = wide > 0 ? yawSpan / wide : 0;
  return shape.map(([x, y]) => [x * kx, (y * climb) / top]);
}

/** A path for a gun with no demonstration to copy: the climb comes on
 * fastest early and levels off by `untilMax` shots, as the demonstrated
 * patterns do; the sideways part is a slow swing (or a steady drift) inside
 * its yaw range. */
function builtPath(n, climb, untilMax, yawMin, yawMax) {
  const out = [];
  for (let k = 0; k < n; k++) {
    const t = Math.min(1, k / Math.max(1, untilMax - 1));
    const y = climb * (1 - (1 - t) ** 2);
    const x = yawMin < 0 ? Math.sin(k / 4.5) * Math.min(-yawMin, yawMax) : yawMin + (yawMax - yawMin) * t;
    out.push([k ? x : 0, y]);
  }
  return out;
}

// hip: degrees the whole magazine climbs from the hip; ads: the share of
// that left when aimed; hipCone / aimCone: degrees across.
export const RUST_GUNS = [
  { id: 'ak', name: 'Assault Rifle (AK-47)', rpm: 450, mag: 30, auto: true, ads: 0.5, hipCone: 2.5, aimCone: 0.2, reset: 0.5, fixed: toDegrees(RUST_SHAPES.ak, 30, 10) },
  { id: 'lr', name: 'LR-300', rpm: 500, mag: 30, auto: true, ads: 0.75, hipCone: 3, aimCone: 0.2, reset: 0.45, fixed: toDegrees(RUST_SHAPES.lr, 12, 6) },
  { id: 'mp5', name: 'MP5A4', rpm: 600, mag: 30, auto: true, ads: 0.5, hipCone: 3, aimCone: 0.5, reset: 0.35, fixed: toDegrees(RUST_SHAPES.mp5, 10, 7.25) },
  { id: 'thompson', name: 'Thompson', rpm: 462, mag: 20, auto: true, ads: 0.5, hipCone: 1.8, aimCone: 0.5, reset: 0.35, fixed: toDegrees(RUST_SHAPES.thompson, 15, 11.5) },
  { id: 'custom', name: 'Custom SMG', rpm: 600, mag: 30, auto: true, ads: 0.5, hipCone: 1.8, aimCone: 0.5, reset: 0.35, fixed: toDegrees(extend(RUST_SHAPES.custom, 30, 12), 15, 11.5) },
  { id: 'm249', name: 'M249', rpm: 500, mag: 100, auto: true, ads: 0.5, hipCone: 4, aimCone: 0.2, reset: 0.5, estimated: true, fixed: builtPath(100, 6, 30, -1, 1) },
  { id: 'hmlmg', name: 'HMLMG', rpm: 480, mag: 60, auto: true, ads: 0.5, hipCone: 4, aimCone: 0.2, reset: 0.5, estimated: true, fixed: builtPath(60, 4, 10, 0.5, 0.75) },
  // Semi-automatics: one shot per click; the climb is spread evenly over
  // the magazine, so you tap and pull down between taps.
  { id: 'sar', name: 'Semi-Automatic Rifle', rpm: 343, mag: 16, auto: false, ads: 0.6, hipCone: 1.8, aimCone: 0.25, reset: 0.6, fixed: Array.from({ length: 16 }, (_, i) => [0, (i * 6) / 15]) },
  { id: 'm39', name: 'M39 Rifle', rpm: 343, mag: 20, auto: false, ads: 0.6, hipCone: 3, aimCone: 0.1, reset: 0.6, estimated: true, fixed: builtPath(20, 7, 20, -1.5, 1.5) },
];

// Siege: { rpm, mag, climb (degrees over 30 rounds), width (degrees the
// side kick wanders inside) } from SprayTrace; recoil resets 0.4 s off
// the trigger.
const SIEGE = [
  ['r4c', 'R4-C', 'Rifle', 860, 25, 7.0, 4.0],
  ['ak12', 'AK-12', 'Rifle', 850, 30, 8.0, 5.0],
  ['552', '552 Commando', 'Rifle', 690, 30, 7.0, 4.0],
  ['416c', '416-C Carbine', 'Rifle', 740, 30, 7.0, 4.0],
  ['f2', 'F2', 'Rifle', 980, 25, 6.5, 4.0],
  ['c9', 'Commando 9', 'Rifle', 780, 25, 7.0, 4.0],
  ['aug', 'AUG A2', 'Rifle', 720, 30, 7.0, 4.0],
  ['mp5', 'MP5', 'SMG', 800, 30, 6.0, 3.0],
  ['p90', 'P90', 'SMG', 970, 50, 6.0, 4.0],
  ['mpx', 'MPX', 'SMG', 830, 30, 6.0, 3.0],
  ['ump', 'UMP45', 'SMG', 600, 25, 6.0, 3.0],
  ['6p41', '6P41', 'LMG', 680, 100, 8.0, 5.0],
  ['lmge', 'LMG-E', 'LMG', 720, 150, 8.0, 5.0],
  ['t95', 'T-95 LSW', 'LMG', 650, 80, 8.5, 5.5],
];
export const SIEGE_GUNS = SIEGE.map(([id, name, cls, rpm, mag, climb, width]) => ({ id, name, cls, rpm, mag, climb, width, auto: true, ads: 1, hipCone: 0, aimCone: 0, reset: 0.4 }));

export const RECOIL_GUNS = { rust: RUST_GUNS, r6: SIEGE_GUNS };

/** Distances the drill can put the target at, in metres: Rust's fights
 * run longer than Siege's, which are mostly inside a building. */
export const RECOIL_DISTANCES = { rust: [10, 25, 50], r6: [5, 10, 15, 25] };

export const gunsFor = (gameId) => RECOIL_GUNS[gameId] || null;
export const gunById = (gameId, id) => {
  const guns = gunsFor(gameId);
  return guns ? guns.find((g) => g.id === id) || guns[0] : null;
};

/** A small seeded random source, so a spray can be replayed exactly. */
export function seeded(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

/**
 * Where each bullet of one full magazine would go if you didn't pull at all:
 * cumulative [right, up] in degrees, bullet 1 at [0, 0]. Rust's is the same
 * every time; Siege's climbs the same and wanders sideways differently on
 * each spray (from `rng`).
 */
export function sprayPattern(gun, rng = Math.random) {
  if (gun.fixed) return gun.fixed.map((p) => [...p]);
  // Siege. The kick after shot k: the first three are the strongest (the
  // first-shot multiplier), then a steady climb that adds up to `climb`
  // over 30 rounds. Long LMG belts settle to under half that after 30.
  const first = [1.6, 1.35, 1.15];
  const sum = first.reduce((a, b) => a + b, 0) + (29 - first.length);
  const step = gun.climb / sum;
  // The sideways wander: a random walk that starts after the third shot and
  // stays inside the gun's width, turning back off its edges.
  const half = gun.width / 2;
  const sigma = gun.width * 0.115;
  const gauss = () => {
    const u = Math.max(1e-9, rng());
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
  };
  const out = [[0, 0]];
  let x = 0;
  let y = 0;
  for (let k = 1; k < gun.mag; k++) {
    const w = k <= first.length ? first[k - 1] : k < 30 ? 1 : 0.4;
    y += step * w * (0.9 + 0.2 * rng());
    if (k >= 3) {
      x += gauss() * sigma;
      if (x > half) x = 2 * half - x;
      if (x < -half) x = -2 * half - x;
    }
    out.push([x, y]);
  }
  return out;
}

/** Milliseconds between shots. */
export const shotMs = (gun) => 60000 / gun.rpm;

/** How far the view moves (degrees) between shot k and k+1 of a pattern. */
export function kickAfter(pattern, k) {
  if (k + 1 >= pattern.length) return [0, 0];
  return [pattern[k + 1][0] - pattern[k][0], pattern[k + 1][1] - pattern[k][1]];
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/** The thirds of a spray the feedback talks about: its opening shots, the
 * middle and the end. */
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
 * Scores one spray. shots: [{ x, y (cm on the target, from the aim point),
 * dx, dy (degrees from the first bullet), hit }]; pattern: the spray's
 * uncontrolled pattern (degrees); distance in metres.
 *  - onTarget: share of bullets that hit the target.
 *  - control: how much of the recoil you took out - 1 means every bullet
 *    went where the first did, 0 means they spread as far as if you hadn't
 *    pulled at all.
 *  - groupCm: average distance of each bullet from the first, in cm at the
 *    target.
 *  - phases: the average miss (degrees, up/right positive) through the
 *    opening, middle and end of the spray, for the feedback.
 */
export function scoreSpray(shots, pattern, distance) {
  const n = shots.length;
  const later = shots.slice(1);
  const off = later.map((s) => Math.hypot(s.dx, s.dy));
  const free = pattern.slice(1, n).map(([x, y]) => Math.hypot(x, y));
  const cmPerDeg = Math.tan(Math.PI / 180) * distance * 100;
  const control = free.length && mean(free) > 0 ? Math.max(0, Math.min(1, 1 - mean(off) / mean(free))) : null;
  return {
    shots: n,
    hits: shots.filter((s) => s.hit !== 'miss').length,
    heads: shots.filter((s) => s.hit === 'head').length,
    onTarget: n ? shots.filter((s) => s.hit !== 'miss').length / n : 0,
    control,
    groupCm: later.length ? mean(off) * cmPerDeg : 0,
    phases: phases(n).map((p) => {
      const part = shots.filter((_, i) => i + 1 >= p.from && i + 1 <= p.to);
      return { ...p, dx: mean(part.map((s) => s.dx)), dy: mean(part.map((s) => s.dy)) };
    }),
  };
}

/** One line of advice from a run's sprays: the part of the spray that went
 * furthest wrong, which way, and what to do about it. Phases average over
 * every spray of the run (a full magazine each). */
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
  const parts = [...byLabel.values()].map((a) => ({ label: a.label, from: a.from, dx: mean(a.dx), dy: mean(a.dy) })).sort((a, b) => a.from - b.from);
  const worst = parts.reduce((w, p) => (Math.hypot(p.dx, p.dy) > Math.hypot(w.dx, w.dy) ? p : w), parts[0]);
  const cm = (deg) => `${Math.round(Math.abs(deg) * cmPerDeg)} cm`;
  // A quarter of a degree is about where a miss starts to matter: a head is
  // under half a degree wide at 25 m.
  const OK = 0.25;
  if (Math.abs(worst.dx) < OK && Math.abs(worst.dy) < OK) {
    return { tone: 'good', title: 'Spray under control', text: `No part of the spray strays more than a quarter of a degree from your first shot on average. Try a longer distance or a harder gun next.` };
  }
  const bits = [];
  if (Math.abs(worst.dy) >= OK) {
    bits.push(
      worst.dy > 0
        ? `climbing ${cm(worst.dy)} above your first shot - pull down harder there`
        : `dropping ${cm(worst.dy)} below your first shot - you're pulling down too hard there`
    );
  }
  if (Math.abs(worst.dx) >= OK) {
    bits.push(worst.dx > 0 ? `drifting ${cm(worst.dx)} right - pull left there` : `drifting ${cm(worst.dx)} left - pull right there`);
  }
  return {
    tone: 'work',
    title: `Work on ${worst.label}`,
    text: `On ${worst.label} your bullets are ${bits.join(', and ')}.`,
    parts,
  };
}
