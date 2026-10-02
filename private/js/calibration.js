// Calibration: finding the sensitivity that feels right to you.
//
// Why it works this way (researched October 2026):
// - Across a broad middle range of sensitivities, aiming performance barely
//   changes. NVIDIA's study of first-person targeting (Boudaoud et al. 2022:
//   13 FPS players, 4,000 flicks each) found everyone about equally good
//   anywhere from roughly 20 to 80 cm/360, and pointing research finds the
//   same flat middle with control-display gain (Casiez et al. 2008). Inside
//   that range the "best" sensitivity is a matter of preference - some
//   people like a slower, steadier feel, some a faster one - and no flick
//   statistic can pick it for them.
// - The earlier version picked the sensitivity where your first movement
//   landed dead on the head. Two things made that unreliable. Aimed
//   movements naturally stop a little short and finish with a small
//   correction, because overshooting costs more to fix (Elliott et al.,
//   "Goal-directed aiming: two components but multiple processes", 2010) -
//   so "lands dead on" sits above the speed that feels natural, which is
//   why it kept recommending something faster than you play. And your hand
//   adapts to a new sensitivity within a few flicks, which flattens the
//   difference between the values tested, so the answer swung with noise
//   from pass to pass.
// So now you rate how each short round felt - too slow, a bit slow, just
// right, a bit fast, too fast - and a Bayesian model of where "just right"
// sits for you picks every next sensitivity to test and stops once it has
// pinned it down. That's the approach psychophysics uses to measure a point
// of subjective equality (QUEST, Watson & Pelli 1983; the psi method,
// Kontsevich & Tyler 1999): each test is placed where it tells the model
// the most, so it converges quickly and lands in the same place each time.
// Rounds are blind - the value isn't shown - so the number can't sway you.
// Every flick is still read for where it landed, and that's reported
// alongside as a check on accuracy at the sensitivity you choose.

// One round: a handful of flicks at one sensitivity, then a rating. The
// first round is your current setting, as a reference.
export const FLICKS_PER_ROUND = 8;
// The first flick after a change of sensitivity is still getting used to
// it, so it isn't counted in the accuracy figures (it still counts towards
// how the round felt).
export const SETTLE_FLICKS = 1;
// Ratings asked for in one pass: at least MIN_ROUNDS, and it stops as soon
// as the answer is pinned to within PRECISION either way - or at MAX_ROUNDS.
export const MIN_ROUNDS = 7;
export const MAX_ROUNDS = 14;
const PRECISION = 0.045; // ± in ln(sens), so about ±4.5%
// About how long a pass takes, for the start screen (rounds are ~13 s).
export const PASS_MINUTES = '2-3';
// Rounds kept from earlier passes when you refine (so state can't grow
// forever).
const MAX_KEPT_ROUNDS = 42;

export const FEEL_OPTIONS = [
  { value: 1, label: 'Too slow' },
  { value: 2, label: 'A bit slow' },
  { value: 3, label: 'Just right' },
  { value: 4, label: 'A bit fast' },
  { value: 5, label: 'Too fast' },
];

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

// ---------- The feel model ----------
//
// What it learns: your "just right" sensitivity θ - on a log scale, since a
// 10% change feels the same size at any sensitivity - and how precisely you
// judge speed, σ. A round at sensitivity x feels like d = ln x - θ plus some
// noise: beyond about ±5.5% it starts to feel a bit fast or a bit slow, and
// beyond about ±17% too fast or too slow. A small allowance (LAPSE) covers
// pressing the wrong key. It's worked out exactly over a grid of θ values
// (your current setting ÷2.2 to ×2.2) and four levels of σ, starting from a
// wide guess centred on your current setting - which a few ratings outweigh.

const GRID_N = 241;
const GRID_HALF = Math.log(2.2);
const PRIOR_SD = 0.35;
const CUTS = [-0.17, -0.055, 0.055, 0.17];
const NOISE = [
  { s: 0.04, w: 0.2 },
  { s: 0.07, w: 0.35 },
  { s: 0.11, w: 0.3 },
  { s: 0.17, w: 0.15 },
];
const LAPSE = 0.04;

/** Standard normal CDF (Abramowitz & Stegun 7.1.26, error under 1.5e-7). */
function phi(z) {
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const erf = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return z >= 0 ? (1 + erf) / 2 : (1 - erf) / 2;
}

/** The chance of rating r (1-5) a round that's d (ln units) faster than
 * "just right", for someone who judges with noise s. */
function ratingChance(r, d, s) {
  const lo = r === 1 ? 0 : phi((CUTS[r - 2] - d) / s);
  const hi = r === 5 ? 1 : phi((CUTS[r - 1] - d) / s);
  return (1 - LAPSE) * Math.max(0, hi - lo) + LAPSE / 5;
}

/**
 * What the model believes after these rounds ([{ sens, rating }]):
 * { theta: grid of ln(sens), joint: [σ level][grid] probabilities, marg:
 * probabilities over θ alone }. base is the setting the first pass started
 * from - the centre of the starting guess.
 */
export function feelPosterior(base, rounds) {
  const c = Math.log(base);
  const theta = Array.from({ length: GRID_N }, (_, i) => c - GRID_HALF + (2 * GRID_HALF * i) / (GRID_N - 1));
  const rated = rounds.filter((r) => r.rating >= 1 && r.rating <= 5 && r.sens > 0);
  const logJoint = NOISE.map(({ s, w }) =>
    theta.map((th) => {
      let lp = Math.log(w) - (th - c) ** 2 / (2 * PRIOR_SD ** 2);
      for (const r of rated) lp += Math.log(ratingChance(r.rating, Math.log(r.sens) - th, s));
      return lp;
    })
  );
  let max = -Infinity;
  for (const row of logJoint) for (const v of row) max = Math.max(max, v);
  let total = 0;
  const joint = logJoint.map((row) =>
    row.map((v) => {
      const p = Math.exp(v - max);
      total += p;
      return p;
    })
  );
  for (const row of joint) for (let i = 0; i < row.length; i++) row[i] /= total;
  const marg = theta.map((_, i) => joint.reduce((s, row) => s + row[i], 0));
  return { theta, joint, marg };
}

/** A quantile of θ, as a sensitivity. */
function quantile(post, q) {
  const step = post.theta[1] - post.theta[0];
  let acc = 0;
  for (let i = 0; i < post.marg.length; i++) {
    const p = post.marg[i];
    if (acc + p >= q) {
      const f = p > 0 ? (q - acc) / p : 0;
      return Math.exp(post.theta[i] - step / 2 + f * step);
    }
    acc += p;
  }
  return Math.exp(post.theta[post.theta.length - 1]);
}

/** Where "just right" is: the median, and the range it's 80% sure of. */
export function feelEstimate(post) {
  const lo = quantile(post, 0.1);
  const hi = quantile(post, 0.9);
  return { median: quantile(post, 0.5), lo, hi, halfWidth: Math.log(hi / lo) / 2 };
}

function entropy(p) {
  let h = 0;
  for (const v of p) if (v > 0) h -= v * Math.log(v);
  return h;
}

/**
 * The next sensitivity to test: of the values the game accepts in the
 * plausible range, the one whose rating should narrow θ down the most (the
 * lowest expected uncertainty afterwards). Never within 2.5% of the last
 * round - a change you can feel is easier to judge - and picked at random
 * among near-equal choices, so the order can't be second-guessed.
 */
export function nextFeelSens(post, rules, lastSens) {
  const lo = quantile(post, 0.01) * 0.85;
  const hi = quantile(post, 0.99) * 1.15;
  const values = new Set();
  for (let k = 0; k <= 48; k++) {
    const v = clampSens(Math.exp(Math.log(lo) + (Math.log(hi / lo) * k) / 48), rules);
    if (v > 0) values.add(v);
  }
  let candidates = [...values].filter((v) => !(lastSens > 0) || Math.abs(Math.log(v / lastSens)) >= 0.025);
  if (!candidates.length) candidates = [...values];
  const scored = candidates.map((v) => {
    const x = Math.log(v);
    let expected = 0;
    for (let r = 1; r <= 5; r++) {
      const after = post.theta.map((th, i) => {
        let p = 0;
        for (let k = 0; k < NOISE.length; k++) p += post.joint[k][i] * ratingChance(r, x - th, NOISE[k].s);
        return p;
      });
      const pr = after.reduce((s, q) => s + q, 0);
      if (pr > 0) expected += pr * entropy(after.map((q) => q / pr));
    }
    return { v, expected };
  });
  scored.sort((a, b) => a.expected - b.expected);
  const near = scored.filter((s) => s.expected <= scored[0].expected + 0.01);
  return near[(Math.random() * near.length) | 0].v;
}

/** Whether this pass has pinned it down, or run its course. */
export function feelDone(post, roundsThisPass) {
  if (roundsThisPass >= MAX_ROUNDS) return true;
  return roundsThisPass >= MIN_ROUNDS && feelEstimate(post).halfWidth <= PRECISION;
}

/** A round for the drill engine: FLICKS_PER_ROUND flicks, then a rating. */
export function feelBlock(sens, index, label) {
  return {
    type: 'check',
    flicks: FLICKS_PER_ROUND,
    settle: SETTLE_FLICKS,
    scored: true,
    rate: true,
    phaseLabel: `ROUND ${index + 1}`,
    getReadyLabel: label || `Round ${index + 1}`,
    candidateSens: sens,
    countdown: index === 0 ? 3 : 2,
  };
}

/** What's kept of each flick: what the accuracy figures need. */
export function compactFlicks(flicks) {
  return (flicks || []).map((f) => ({
    err: f.err,
    landed: f.landed,
    corrections: f.corrections,
    timeMs: f.timeMs,
    misses: f.misses,
  }));
}

/**
 * Everything the rounds so far add up to: the recommendation (the median
 * of θ, rounded to what the game accepts), the range it's 80% sure of, how
 * sure that is, how each tested sensitivity felt and how your flicks went
 * at it, and accuracy at the answer itself.
 */
export function feelResult({ base, rounds, rules, passCount }) {
  const kept = rounds.slice(-MAX_KEPT_ROUNDS);
  const post = feelPosterior(base, kept);
  const est = feelEstimate(post);
  const best = clampSens(est.median, rules);
  const lo = clampSens(est.lo, rules);
  const hi = clampSens(est.hi, rules);
  const confidence = est.halfWidth <= PRECISION || lo === hi ? 'clear' : est.halfWidth <= 0.09 ? 'close' : 'tie';

  const bySens = new Map();
  for (const r of kept) bySens.set(r.sens, [...(bySens.get(r.sens) || []), r]);
  const candidates = [...bySens.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([sens, rs]) => ({
      sens,
      rounds: rs.length,
      feel: mean(rs.map((r) => r.rating)),
      isBase: sens === base,
      ...summariseFlicks(rs.flatMap((r) => r.flicks || [])),
    }));

  // How accurate you were at the answer: flicks from rounds within ±7%.
  const near = kept.filter((r) => Math.abs(Math.log(r.sens / best)) <= 0.07);
  const atBest = summariseFlicks(near.flatMap((r) => r.flicks || []));

  // The belief itself, thinned out for the chart: [ln sens, height 0-1].
  const peak = Math.max(...post.marg);
  const curve = [];
  for (let i = 0; i < post.theta.length; i += 4) curve.push([post.theta[i], post.marg[i] / peak]);

  return {
    method: 'feel',
    base,
    rounds: kept,
    passCount,
    best: { ...atBest, sens: best, isBase: best === base },
    range: { lo, hi },
    estimate: est.median,
    confidence,
    candidates,
    curve,
    totalRounds: kept.length,
    totalFlicks: candidates.reduce((s, c) => s + c.n, 0),
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
  clear: { label: 'Clear result', hint: 'Your ratings agree on this - it is pinned to within a step or two.' },
  close: { label: 'Close call', hint: 'Nearly there. A refine pass adds more rounds around it and narrows it down.' },
  tie: { label: 'Needs another pass', hint: 'Your ratings were mixed, so it is not pinned down yet. Run a refine pass before applying.' },
};
