// Calibration: an AI that learns, from your flicks alone, the sensitivity
// you aim best at.
//
// What the research says (checked October 2026):
// - Across a broad range of sensitivities, aim barely changes. NVIDIA's
//   study of first-person targeting (Boudaoud, Spjut & Kim 2022: 13 FPS
//   players, 4,000 flicks each) found everyone performing about equally
//   well anywhere across roughly a factor of four (20-80 cm/360); 11 of the
//   13 players' own sensitivities were already inside that range, and the
//   two outside it were among the weakest. Control-display gain studies in
//   pointing find the same flat middle (Casiez et al. 2008). So no test can
//   honestly pull one "magic number" out of that middle - any that claims
//   to is mostly reading noise, which is what made the earlier versions
//   swing from one run to the next.
// - What it can measure reliably is whether your aim gets worse at the
//   sensitivities around yours: too fast and the flick overshoots, hunts
//   and misses (your hand's precision, scaled up, outruns the head); too
//   slow and every flick takes longer to get there. Both show up in one
//   number - how long a flick takes to put a shot on the head - which
//   already carries the cost of overshooting and correcting. (The earlier
//   version looked only at where the first movement stopped, and aimed for
//   "dead on the head" - but aimed movements naturally stop a little short,
//   since an overshoot costs more to fix (Elliott et al. 2010), and your
//   hand adapts to a new sensitivity within a few flicks, which hides that
//   difference anyway.)
//
// So the test plays flicks onto heads at five sensitivities, from about
// 0.7x to 1.4x yours, in a blind order with each one early, in the middle
// and late. Every flick is read for how long it took to hit the head from
// the moment you started moving, with a penalty for each missed shot, and
// a Bayesian model fits all of them at once: where your aim is quickest
// (θ) and how sharply it gets worse away from there (κ), allowing for how
// hard each flick was (its distance and the head's size, Fitts' law) and
// for warming up or tiring over the run. Then it makes a decision: it
// recommends a different sensitivity only when the model predicts it's
// genuinely better than yours - by enough (WORTH_IT) to be worth getting
// used to - and otherwise tells you to keep yours, with the range you aim
// equally well across.

// The five sensitivities, as steps of ln(sens) around the centre: about
// 0.70x, 0.84x, 1x, 1.19x and 1.42x.
export const LADDER = [-0.35, -0.175, 0, 0.175, 0.35];
export const BLOCKS_PER_SENS = 3;
export const FLICKS_PER_BLOCK = 8;
// The first flick after a change is still getting used to it.
export const SETTLE_FLICKS = 1;
export const WARMUP_FLICKS = 6;
export const TOTAL_FLICKS = LADDER.length * BLOCKS_PER_SENS * FLICKS_PER_BLOCK;
export const PASS_MINUTES = '2½';

const MISS_MS = 250; // each missed shot before the hit counts as this much extra time
// Flicks kept across passes, so a refine pass builds on the earlier ones
// (and saved state can't grow forever).
const MAX_KEPT_FLICKS = 360;

const toStep = (v, rules) => Number((Math.round(v / rules.step) * rules.step).toFixed(rules.decimals));
const clampSens = (v, rules) => Math.max(rules.min, Math.min(rules.max, toStep(v, rules)));

// ---------- Reading a flick ----------

const STEP_MS = 4; // the path is resampled onto this grid
const STILL_MS = 32; // no reading for longer than this means the mouse was still

/**
 * Reads one flick from the path the crosshair took, from the moment the
 * target appeared to the shot that hit it.
 *   path   - [{ t, yaw, pitch }]: milliseconds and radians; the first entry
 *            is where the view was when the target appeared
 *   target - { yaw, pitch, r }: where it was and its radius, as angles
 *   misses - shots that missed before the hit
 * Positions are measured along the line from the start to the target (and
 * across it), in target radii. The first movement is the flick itself: it
 * ends when the speed drops below an eighth of its peak or turns back.
 * Everything after that is a correction. Returns null when there was no real
 * flick to read (the target was already under the crosshair).
 */
export function analyseFlick(path, target, misses = 0) {
  if (!path || path.length < 2 || !(target.r > 0)) return null;
  const start = path[0];
  const cosP = Math.cos((start.pitch + target.pitch) / 2);
  const dx = (target.yaw - start.yaw) * cosP;
  const dy = target.pitch - start.pitch;
  const D = Math.hypot(dx, dy);
  if (D < 2.5 * target.r) return null;
  const ux = dx / D;
  const uy = dy / D;
  const pts = path.map((s) => {
    const x = (s.yaw - start.yaw) * cosP;
    const y = s.pitch - start.pitch;
    return { t: s.t, a: x * ux + y * uy, c: -x * uy + y * ux };
  });

  // Resample onto an even grid. Readings arrive once per frame while the
  // mouse moves; a longer gap means it sat still, then moved in the last
  // frame before the next reading.
  const t0 = pts[0].t;
  const tEnd = pts[pts.length - 1].t;
  const grid = [];
  let j = 0;
  for (let t = t0; t <= tEnd + 1e-6; t += STEP_MS) {
    while (j < pts.length - 2 && pts[j + 1].t < t) j++;
    const p = pts[j];
    const q = pts[j + 1] || p;
    let f;
    if (t <= p.t || q.t <= p.t) f = t >= q.t ? 1 : 0;
    else if (q.t - p.t > STILL_MS) f = Math.max(0, Math.min(1, (t - (q.t - 16)) / 16));
    else f = Math.min(1, (t - p.t) / (q.t - p.t));
    grid.push({ t, a: p.a + (q.a - p.a) * f, c: p.c + (q.c - p.c) * f });
  }
  grid.push({ t: tEnd, a: pts[pts.length - 1].a, c: pts[pts.length - 1].c });
  const n = grid.length;

  // Speed along the flick line, smoothed over ~20 ms.
  const raw = grid.map((g, i) => {
    const a = grid[Math.max(0, i - 1)];
    const b = grid[Math.min(n - 1, i + 1)];
    const dt = b.t - a.t;
    return dt > 0 ? (b.a - a.a) / dt : 0;
  });
  const v = raw.map((_, i) => {
    let s = 0;
    let k = 0;
    for (let m = Math.max(0, i - 2); m <= Math.min(n - 1, i + 2); m++) {
      s += raw[m];
      k++;
    }
    return s / k;
  });

  const onsetIdx = grid.findIndex((g) => g.a >= 0.1 * D);
  if (onsetIdx < 0) return null; // never really set off towards it

  // The flick is the FIRST burst of movement, not the fastest: someone who
  // stops well short often follows up with a quicker second push, and that
  // push is a correction. The burst ends once the speed has fallen below an
  // eighth of its peak so far (or turned back).
  let vPeak = v[onsetIdx];
  let endIdx = n - 1; // shot while still moving: the flick ended on the hit
  for (let i = onsetIdx + 1; i < n; i++) {
    if (v[i] > vPeak) vPeak = v[i];
    else if (v[i] <= vPeak / 8) {
      endIdx = i;
      break;
    }
  }
  if (!(vPeak > 0)) return null;
  const end = grid[endIdx];
  const errA = (end.a - D) / target.r;
  const errC = end.c / target.r;

  // Corrections: separate bursts of movement after the flick ended, each
  // either back towards the start (after going past) or on towards the
  // target (after stopping short). Tiny jitters don't count.
  let corrections = 0;
  let back = 0;
  let onward = 0;
  const threshold = vPeak / 8;
  let i = endIdx + 1;
  while (i < n) {
    if (Math.abs(v[i]) <= threshold) {
      i++;
      continue;
    }
    const from = i;
    let sum = 0;
    while (i < n && Math.abs(v[i]) > threshold) sum += v[i++];
    const moved = Math.abs(grid[Math.min(i, n - 1)].a - grid[from].a);
    if ((i - from) * STEP_MS >= 12 && moved >= 0.15 * target.r) {
      corrections++;
      if (sum < 0) back++;
      else onward++;
    }
  }

  const RAD = 180 / Math.PI;
  return {
    distDeg: D * RAD,
    radiusDeg: target.r * RAD,
    err: errA, // + past the head, - short of it, in head radii
    cross: errC,
    landed: Math.hypot(errA, errC) <= 1,
    corrections,
    back,
    onward,
    timeMs: tEnd - t0,
    reactionMs: grid[onsetIdx].t - t0,
    misses,
  };
}

// ---------- Scoring ----------

const clampErr = (e) => Math.max(-4, Math.min(4, e));
const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : NaN);
function median(xs) {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** A sensitivity's flicks, summed up. */
export function summariseFlicks(flicks) {
  const n = flicks.length;
  if (!n) return { n: 0, bias: NaN, landRate: NaN, pastRate: NaN, shortRate: NaN, corrections: NaN, timeMs: NaN, missRate: NaN };
  const share = (pred) => flicks.filter(pred).length / n;
  return {
    n,
    bias: mean(flicks.map((f) => clampErr(f.err))),
    landRate: share((f) => f.landed),
    pastRate: share((f) => f.err > 1),
    shortRate: share((f) => f.err < -1),
    corrections: mean(flicks.map((f) => f.corrections)),
    timeMs: median(flicks.map((f) => f.timeMs)),
    missRate: mean(flicks.map((f) => f.misses)),
  };
}

// ---------- The test ----------

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = (Math.random() * (i + 1)) | 0;
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** The five sensitivities around `center`, as values the game accepts,
 * lowest first. Where the game's steps are too coarse to keep them apart
 * (Siege's whole numbers at low values), they're nudged up to stay
 * distinct. */
export function aiLadder(center, rules) {
  const values = [];
  for (const s of LADDER) {
    let v = clampSens(center * Math.exp(s), rules);
    while (values.includes(v) && v < rules.max) v = clampSens(v + rules.step, rules);
    if (!values.includes(v)) values.push(v);
  }
  return values.sort((a, b) => a - b);
}

/**
 * The run: a warm-up at the centre, then BLOCKS_PER_SENS rounds of each
 * sensitivity, in a fresh random order each time round (and never the same
 * one twice in a row) - so every sensitivity is played early, mid-run and
 * late, and none is favoured by warming up or tiring. Which one a round
 * uses isn't shown.
 */
export function aiQueue(center, rules) {
  const ladder = aiLadder(center, rules);
  const order = [];
  for (let rep = 0; rep < BLOCKS_PER_SENS; rep++) {
    let perm;
    do perm = shuffle(ladder.map((_, i) => i));
    while (order.length && perm[0] === order[order.length - 1]);
    order.push(...perm);
  }
  const warm = clampSens(center, rules);
  return [
    {
      type: 'check',
      flicks: WARMUP_FLICKS,
      settle: WARMUP_FLICKS,
      scored: false,
      phaseLabel: 'WARM-UP',
      getReadyLabel: 'Warm-up',
      candidateSens: warm,
      countdown: 3,
    },
    ...order.map((i, k) => ({
      type: 'check',
      flicks: FLICKS_PER_BLOCK,
      settle: SETTLE_FLICKS,
      scored: true,
      phaseLabel: `ROUND ${k + 1} OF ${order.length}`,
      getReadyLabel: `Round ${k + 1} of ${order.length}`,
      candidateSens: ladder[i],
      countdown: 2,
    })),
  ];
}

/** What's kept of each flick, from the drill's round results. `orderFrom`
 * numbers this pass's rounds after an earlier pass's. */
export function aiRecords(results, orderFrom = 0) {
  const out = [];
  results.forEach((r, k) => {
    for (const f of r.flicks || []) {
      if (!(f.distDeg > 0) || !(f.radiusDeg > 0) || !(f.timeMs > 0)) continue;
      out.push({
        sens: r.candidateSens,
        // Fitts' index of difficulty: how hard the flick was.
        id: Math.log2(f.distDeg / (2 * f.radiusDeg) + 1),
        timeMs: f.timeMs,
        mt: Math.max(60, f.timeMs - (f.reactionMs || 0)),
        misses: f.misses || 0,
        err: f.err,
        landed: f.landed,
        corrections: f.corrections,
        order: orderFrom + k,
      });
    }
  });
  return out;
}

// ---------- The model ----------
//
// y = ln(movement time to the head + MISS_MS per missed shot), modelled as
//     y = b0 + b1 * (Fitts ID) + b2 * (position in the run) + κ (x - θ)² + noise
// where x = ln(sens / base). θ is where your aim is quickest; κ how much
// slower it gets away from there (κ = 0: it doesn't matter). b0-b2 and the
// noise are worked out exactly for every (θ, κ) on a grid, and the priors
// are mild: θ centred on your current setting with an SD of 0.2 (about
// ±20% - you've trained your hand on it, which counts for something), κ
// half-normal, with some weight on "flat" (κ = 0).

const PRIOR_SD = 0.2;
const KAPPA = [0, 0.04, 0.1, 0.2, 0.35, 0.55, 0.8, 1.1, 1.5, 2.2, 3.2];
const KAPPA_SCALE = 0.9;
const FLAT_WEIGHT = 0.2;
const GRID_HALF = 0.9;
const GRID_N = 181;
// A change has to be predicted to make you at least this much quicker onto
// heads (as a fraction) - otherwise relearning muscle memory isn't worth it.
export const WORTH_IT = 0.015;


/** Inverse of a symmetric 3x3 matrix [[a,b,c],[b,d,e],[c,e,f]]. */
function inv3(m) {
  const [[a, b, c], [, d, e], [, , f]] = m;
  const A = d * f - e * e;
  const B = c * e - b * f;
  const C = b * e - c * d;
  const det = a * A + b * B + c * C;
  const D = a * f - c * c;
  const E = b * c - a * e;
  const F = a * d - b * b;
  return [
    [A / det, B / det, C / det],
    [B / det, D / det, E / det],
    [C / det, E / det, F / det],
  ];
}

/**
 * Fits the model to these flicks. base: the first pass's centre (x = 0);
 * current: your current setting (the prior's centre). Returns the joint
 * posterior over (κ, θ) and what the charts and decision need.
 */
export function aiModel(base, recs, current = base) {
  const n = recs.length;
  const xc = Math.log(current / base);
  const x = recs.map((r) => Math.log(r.sens / base));
  const maxOrder = Math.max(1, ...recs.map((r) => r.order));
  const t = recs.map((r) => r.order / maxOrder);
  const id = recs.map((r) => r.id);
  let y = recs.map((r) => Math.log(r.mt + MISS_MS * r.misses));
  // The odd flick where you looked away shouldn't swing it: clip at the
  // median ± 3 robust SDs.
  const med = median(y);
  const sd = median(y.map((v) => Math.abs(v - med))) * 1.4826 || 0.25;
  y = y.map((v) => Math.min(med + 3 * sd, Math.max(med - 3 * sd, v)));

  // Everything the grid needs, summed once.
  const cols = [recs.map(() => 1), id, t];
  const dot = (u, v) => u.reduce((s, ui, i) => s + ui * v[i], 0);
  const XtX = cols.map((u) => cols.map((v) => dot(u, v)));
  XtX[0][0] += 1e-9;
  XtX[1][1] += 1e-9;
  XtX[2][2] += 1e-9;
  const M = inv3(XtX);
  const x2 = x.map((v) => v * v);
  const Xy = cols.map((u) => dot(u, y));
  const X1 = cols.map((u) => u.reduce((s, v) => s + v, 0));
  const Xx = cols.map((u) => dot(u, x));
  const Xx2 = cols.map((u) => dot(u, x2));
  const yy = dot(y, y);
  const yx = dot(y, x);
  const yx2 = dot(y, x2);
  const sy = y.reduce((s, v) => s + v, 0);
  const s1 = x.reduce((s, v) => s + v, 0);
  const s2 = x2.reduce((s, v) => s + v, 0);
  const s3 = x.reduce((s, v) => s + v ** 3, 0);
  const s4 = x.reduce((s, v) => s + v ** 4, 0);

  const theta = Array.from({ length: GRID_N }, (_, i) => xc - GRID_HALF + (2 * GRID_HALF * i) / (GRID_N - 1));
  // κ's prior weights: some on flat, the rest half-normal across the grid.
  const dens = KAPPA.map((k, j) => (j === 0 ? 0 : Math.exp(-(k * k) / (2 * KAPPA_SCALE ** 2)) * ((KAPPA[j + 1] ?? k * 1.4) - KAPPA[j - 1]) / 2));
  const dsum = dens.reduce((s, v) => s + v, 0);
  const kw = dens.map((v, j) => (j === 0 ? FLAT_WEIGHT : ((1 - FLAT_WEIGHT) * v) / dsum));

  const logp = KAPPA.map((k, j) =>
    theta.map((th) => {
      const Xq = [0, 1, 2].map((c) => Xx2[c] - 2 * th * Xx[c] + th * th * X1[c]);
      const Xz = [0, 1, 2].map((c) => Xy[c] - k * Xq[c]);
      const yq = yx2 - 2 * th * yx + th * th * sy;
      const qq = s4 - 4 * th * s3 + 6 * th * th * s2 - 4 * th ** 3 * s1 + n * th ** 4;
      const zz = yy - 2 * k * yq + k * k * qq;
      let fit = 0;
      for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) fit += Xz[a] * M[a][b] * Xz[b];
      const rss = Math.max(1e-9, zz - fit);
      return -(n / 2) * Math.log(rss / n) - (th - xc) ** 2 / (2 * PRIOR_SD ** 2) + Math.log(kw[j]);
    })
  );
  let max = -Infinity;
  for (const row of logp) for (const v of row) max = Math.max(max, v);
  let total = 0;
  const joint = logp.map((row) =>
    row.map((v) => {
      const p = Math.exp(v - max);
      total += p;
      return p;
    })
  );
  for (const row of joint) for (let i = 0; i < row.length; i++) row[i] /= total;

  // Expected slowdown at x: E[κ (x - θ)²] = A (x - x*)² + floor.
  let A = 0;
  let B = 0;
  let C = 0;
  joint.forEach((row, j) =>
    row.forEach((p, i) => {
      A += p * KAPPA[j];
      B += p * KAPPA[j] * theta[i];
      C += p * KAPPA[j] * theta[i] ** 2;
    })
  );
  const xBest = A > 1e-12 ? B / A : xc;
  const slowdown = (xv) => A * xv * xv - 2 * B * xv + C; // E[κ (x - θ)²]

  // The flat fit (κ = 0), for each flick's difficulty-adjusted time.
  const beta = [0, 1, 2].map((a) => M[a][0] * Xy[0] + M[a][1] * Xy[1] + M[a][2] * Xy[2]);
  const resid = y.map((v, i) => v - (beta[0] + beta[1] * id[i] + beta[2] * t[i]));

  return { theta, joint, kappa: KAPPA, A, B, C, xBest, xc, slowdown, resid, x };
}

/** The chance that x is quicker than xRef (posterior over θ and κ). */
function chanceBetter(m, xv, xRef) {
  let p = 0;
  m.joint.forEach((row, j) => {
    const k = m.kappa[j];
    if (k === 0) return;
    row.forEach((q, i) => {
      if (k * ((xv - m.theta[i]) ** 2 - (xRef - m.theta[i]) ** 2) < 0) p += q;
    });
  });
  return p;
}

/** The chance that x is within WORTH_IT of the best there is. */
function chanceNearBest(m, xv) {
  let p = 0;
  m.joint.forEach((row, j) => {
    const k = m.kappa[j];
    row.forEach((q, i) => {
      if (k * (xv - m.theta[i]) ** 2 <= WORTH_IT) p += q;
    });
  });
  return p;
}

/**
 * The verdict, and everything the results show:
 *   keep        - your current setting is as good as any (no change is
 *                 predicted to be WORTH_IT better, with 75% certainty)
 *   best.sens   - what to use: your current setting when keep, otherwise
 *                 the model's quickest, in the game's steps
 *   gain        - how much quicker onto heads the change should make you
 *   zone        - the range you aim about equally well across (within
 *                 WORTH_IT of your best); open-ended when the data never
 *                 got worse that way
 *   confidence  - clear / close / tie (needs another pass)
 *   candidates  - per sensitivity tested: time to the head, accuracy
 *   curve, points - the fitted slowdown and the measured one, for the chart
 */
export function aiResult({ base, records, rules, passCount, current }) {
  const kept = records.slice(-MAX_KEPT_FLICKS);
  const cur = clampSens(current, rules);
  const m = aiModel(base, kept, cur);
  const xCur = Math.log(cur / base);
  const bestRaw = clampSens(base * Math.exp(m.xBest), rules);
  const xB = Math.log(bestRaw / base);
  const gain = Math.max(0, m.slowdown(xCur) - m.slowdown(xB));
  const pBetter = bestRaw === cur ? 0 : chanceBetter(m, xB, xCur);
  const keep = bestRaw === cur || gain < WORTH_IT || pBetter < 0.75;
  const best = keep ? cur : bestRaw;

  let confidence;
  if (keep) {
    const pNear = chanceNearBest(m, xCur);
    confidence = pNear >= 0.8 ? 'clear' : pNear >= 0.6 ? 'close' : 'tie';
  } else {
    confidence = pBetter >= 0.9 ? 'clear' : 'close';
  }

  // Where you aim about equally well.
  const tested = [...new Set(kept.map((r) => r.sens))].sort((a, b) => a - b);
  const xs = tested.map((s) => Math.log(s / base));
  const xMin = Math.min(...xs);
  const xMax = Math.max(...xs);
  const half = m.A > 1e-9 ? Math.sqrt(WORTH_IT / m.A) : Infinity;
  const zLo = m.xBest - half;
  const zHi = m.xBest + half;
  const zone = {
    lo: clampSens(base * Math.exp(Math.max(zLo, xMin)), rules),
    hi: clampSens(base * Math.exp(Math.min(zHi, xMax)), rules),
    openLo: zLo < xMin,
    openHi: zHi > xMax,
  };

  // Per sensitivity: what the table shows, and the measured slowdown.
  const curveAt = (xv) => m.slowdown(xv) - m.slowdown(m.xBest);
  const candidates = tested.map((sens) => {
    const idx = kept.map((r, i) => (r.sens === sens ? i : -1)).filter((i) => i >= 0);
    const rs = idx.map((i) => kept[i]);
    const res = idx.map((i) => m.resid[i]);
    const mean = res.reduce((s, v) => s + v, 0) / res.length;
    const se = Math.sqrt(res.reduce((s, v) => s + (v - mean) ** 2, 0) / Math.max(1, res.length - 1) / res.length);
    const share = (pred) => rs.filter(pred).length / rs.length;
    return {
      sens,
      n: rs.length,
      isBase: sens === cur,
      timeMs: median(rs.map((r) => r.timeMs)),
      landRate: share((r) => r.landed),
      pastRate: share((r) => r.err > 1),
      shortRate: share((r) => r.err < -1),
      corrections: rs.reduce((s, r) => s + r.corrections, 0) / rs.length,
      missRate: rs.reduce((s, r) => s + r.misses, 0) / rs.length,
      adj: mean,
      se,
    };
  });
  // Line the measured points up with the curve (they're relative to the
  // average flick; the curve to the best).
  const wsum = candidates.reduce((s, c) => s + c.n, 0);
  const offset = candidates.reduce((s, c) => s + c.n * (c.adj - curveAt(Math.log(c.sens / base))), 0) / wsum;
  const points = candidates.map((c) => [c.sens, c.adj - offset, c.se]);
  const curve = [];
  for (let k = 0; k <= 40; k++) {
    const xv = xMin - 0.05 + ((xMax - xMin + 0.1) * k) / 40;
    curve.push([base * Math.exp(xv), curveAt(xv)]);
  }

  // Accuracy at the answer: the tested sensitivity nearest it.
  const nearest = [...candidates].sort((a, b) => Math.abs(Math.log(a.sens / best)) - Math.abs(Math.log(b.sens / best)))[0];
  return {
    method: 'ai',
    base,
    current: cur,
    records: kept,
    passCount,
    keep,
    gain: keep ? 0 : gain,
    pBetter,
    best: { ...nearest, sens: best, isBase: best === cur },
    zone,
    confidence,
    candidates,
    curve,
    points,
    totalFlicks: kept.length,
  };
}

/** The verdict on one sensitivity's landing error (in head radii). */
export function verdictFor(bias) {
  if (!isFinite(bias)) return null;
  if (bias > 0.25) return bias > 0.6 ? 'over' : 'slightly-over';
  if (bias < -0.25) return bias < -0.6 ? 'under' : 'slightly-under';
  return 'balanced';
}

/**
 * Practice drills still read where shots land (in target radii, signed
 * along the flick): positive past the target, negative short of it.
 * Returns null until there are enough shots to mean anything.
 */
export function analyseAim(results, minShots = 25) {
  const shots = results.flatMap((r) => r.aim || []);
  if (shots.length < minShots) return null;
  const m = shots.reduce((s, v) => s + v, 0) / shots.length;
  const spread = Math.sqrt(shots.reduce((s, v) => s + (v - m) ** 2, 0) / shots.length);
  const past = shots.filter((v) => v > 0).length / shots.length;
  let verdict = 'balanced';
  if (m > 0.2) verdict = m > 0.5 ? 'over' : 'slightly-over';
  else if (m < -0.2) verdict = m < -0.5 ? 'under' : 'slightly-under';
  return { shots: shots.length, mean: m, spread, pastShare: past, verdict };
}

export const AIM_VERDICTS = {
  over: {
    title: 'You overshoot',
    text: 'Your first movement carries you past the head more often than not, then you come back. If it also feels fast, a slightly lower sensitivity settles that.',
  },
  'slightly-over': {
    title: 'You overshoot slightly',
    text: "Your first movement tends to land a little past the head. Fine if it feels right; if it feels twitchy, a step down is worth trying.",
  },
  balanced: {
    title: 'Your flicks land where you aim',
    text: "No consistent pull either way - the misses are spread rather than one-sided. That's what a sensitivity that suits you looks like.",
  },
  'slightly-under': {
    title: 'You stop just short',
    text: "Your first movement tends to stop just short of the head and you finish with a small nudge. That's how most people aim - a nudge forward is quicker to fix than coming back - so nothing needs changing.",
  },
  under: {
    title: 'You stop short',
    text: 'Your first movement stops well short of the head and you creep the rest of the way, which costs time. If it feels sluggish too, a slightly higher sensitivity may suit you.',
  },
};

export const CONFIDENCE_TEXT = {
  clear: { label: 'Clear result', hint: 'Your flicks show this clearly.' },
  close: { label: 'Close call', hint: 'Likely, but a refine pass would make sure.' },
  tie: { label: 'Needs another pass', hint: 'Not enough of a pattern yet - run a refine pass before changing anything.' },
};
