// Calibration: a short flick check at three sensitivities.
//
// Why this test (researched September 2026):
// - NVIDIA's study of mouse sensitivity in first-person targeting (Boudaoud
//   et al. 2022: 13 FPS players, 4,000 flicks each, 5-160 cm/360) found
//   everyone performed about equally well anywhere in a broad 20-80 cm/360
//   band, so racing nearby sensitivities against the clock mostly measures
//   noise. What did change steadily was the flick itself: the higher the
//   sensitivity, the more corrective movements; the lower, the slower you
//   turn. Their advice: high enough that your hand isn't the limit, low
//   enough that over- and undershooting targets isn't common.
// - Tools built on that idea (Oblivity; AutoGain in pointing research) read
//   where the first, ballistic part of each flick ends - past the target or
//   short of it - and look for the setting where those balance.
// So every flick here is recorded as a path, and three things are read out
// of it: where the first movement stopped relative to the head, how many
// corrections followed, and how long the whole thing took. The answer is
// the sensitivity where your first movement lands on the head - neither
// past it nor short of it.

export const INITIAL_SPREAD_PCT = 0.2;
export const CANDIDATES_COUNT = 3;

// One pass: a few warm-up flicks, then six short rounds - each sensitivity
// twice, in an order (middle, low, high, high, low, middle) that gives every
// one the same average position, so warming up or tiring out as you go
// doesn't favour any of them. The first flicks after a change are still
// getting used to it, so they aren't scored.
export const WARMUP_FLICKS = 6;
export const FLICKS_PER_ROUND = 12;
export const SETTLE_FLICKS = 2;
const ROUND_ORDER = [1, 0, 2, 2, 0, 1];
export const TOTAL_ROUNDS = ROUND_ORDER.length;
export const TOTAL_SCORED_FLICKS = TOTAL_ROUNDS * (FLICKS_PER_ROUND - SETTLE_FLICKS);
export const PASS_SECONDS = 90; // roughly, warm-up and countdowns included

// Each fine-tune pass keeps the flicks from the passes before it: the
// balance point is fitted across every sensitivity tried, so more passes
// means more data around the answer. Capped so saved state can't grow
// forever.
const MAX_POOLED_PASSES = 3;

// What a game's sens values can be (see `rules` in games.js). Siege's
// sliders are whole numbers 1-100, so that's the default here.
const SIEGE_RULES = { step: 1, decimals: 0, min: 1, max: 100, minSpreadPct: 0 };

function toStep(v, rules) {
  return Number((Math.round(v / rules.step) * rules.step).toFixed(rules.decimals));
}

/**
 * Three candidates `delta` apart, e.g. Siege 50 @ 20% -> 40 / 50 / 60, or
 * CS2 0.74 @ 20% -> 0.59 / 0.74 / 0.89. Every value is one the game accepts.
 * Normally centred on baseSens; shifted up or down when that would fall off
 * either end of the range, so there are always three distinct values.
 *
 * The gap never goes below the game's finest step: ±1 for Siege's whole-
 * number sliders, or ±2% for the others, about the smallest change you can
 * actually feel. `finest` marks a set that's at that floor.
 */
export function buildCandidates(baseSens, spreadPct, rules = SIEGE_RULES) {
  const base = Math.max(rules.min, Math.min(rules.max, toStep(baseSens, rules)));
  const minDelta = Math.max(rules.step, toStep(base * rules.minSpreadPct, rules));
  const delta = Math.max(minDelta, toStep(base * spreadPct, rules));
  let values = [base - delta, base, base + delta];
  if (values[0] < rules.min) values = [base, base + delta, base + 2 * delta];
  else if (values[2] > rules.max) values = [base - 2 * delta, base - delta, base];
  return values
    .map((v) => toStep(v, rules))
    .map((sens) => ({ sens, isBase: sens === base, delta, finest: delta <= minDelta }));
}

export function buildQueue(candidates) {
  const base = candidates.find((c) => c.isBase) || candidates[1];
  const queue = [
    {
      type: 'check',
      flicks: WARMUP_FLICKS,
      settle: WARMUP_FLICKS,
      scored: false,
      phaseLabel: 'WARM-UP',
      getReadyLabel: 'Warm-up',
      candidateSens: base.sens,
      countdown: 3,
    },
  ];
  ROUND_ORDER.forEach((ci, i) => {
    const c = candidates[ci];
    queue.push({
      type: 'check',
      flicks: FLICKS_PER_ROUND,
      settle: SETTLE_FLICKS,
      scored: true,
      // Which sensitivity a round uses isn't shown, so it can't sway you.
      phaseLabel: `ROUND ${i + 1} OF ${ROUND_ORDER.length}`,
      getReadyLabel: `Round ${i + 1} of ${ROUND_ORDER.length}`,
      candidateSens: c.sens,
      isBase: c.isBase,
      countdown: 2,
    });
  });
  return queue;
}

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

/** Straight line through (ln sens, landing error) for every flick. */
function fitLine(points) {
  const n = points.length;
  if (n < 6) return null;
  const mx = mean(points.map((p) => p.x));
  const my = mean(points.map((p) => p.y));
  let sxx = 0;
  let sxy = 0;
  for (const p of points) {
    sxx += (p.x - mx) ** 2;
    sxy += (p.x - mx) * (p.y - my);
  }
  if (sxx <= 1e-9) return null;
  return { slope: sxy / sxx, mx, my };
}

/**
 * Where your first movement balances: landing on the head rather than past
 * it or short of it. Across the sensitivities tried, landing error rises
 * with sensitivity (faster sens, further the same hand movement carries
 * you), so a line through every flick's error against ln(sens) crosses zero
 * at the balance point. Its reliability comes from re-fitting on resampled
 * flicks: a tight spread of answers is a clear result.
 */
function balancePoint(flicks) {
  const points = flicks.map((f) => ({ x: Math.log(f.sens), y: clampErr(f.err) }));
  const fit = fitLine(points);
  if (!fit || !(fit.slope > 0.05)) return null;
  const x = fit.mx - fit.my / fit.slope;

  // Bootstrap: refit on 200 resamples of the same flicks.
  const xs = [];
  let flat = 0;
  for (let k = 0; k < 200; k++) {
    const sample = points.map(() => points[(Math.random() * points.length) | 0]);
    const f = fitLine(sample);
    if (!f || !(f.slope > 0.05)) {
      flat++;
      continue;
    }
    xs.push(f.mx - f.my / f.slope);
  }
  xs.sort((a, b) => a - b);
  const lo = xs[Math.floor(xs.length * 0.1)] ?? x;
  const hi = xs[Math.floor(xs.length * 0.9)] ?? x;
  return { x, slope: fit.slope, width: hi - lo, flatShare: flat / 200 };
}

/**
 * Pools every scored flick from `results` (block results carrying
 * `flicks`), summarises each candidate, and finds the recommendation:
 *   - the balance point, when your landing error clearly rises with
 *     sensitivity (it nearly always does), kept within 10% of the values
 *     actually tested and rounded to what the game accepts;
 *   - otherwise the candidate whose first flick landed on the head most
 *     often (keeping your current setting on a tie).
 */
export function scoreResults(candidates, results, rules = SIEGE_RULES) {
  const flicks = results.flatMap((r) => (r.flicks || []).map((f) => ({ ...f, sens: r.candidateSens })));
  const summaries = candidates.map((c) => ({
    sens: c.sens,
    isBase: c.isBase,
    ...summariseFlicks(flicks.filter((f) => f.sens === c.sens)),
  }));

  const sensValues = [...new Set(flicks.map((f) => f.sens))];
  const lo = Math.log(Math.min(...sensValues)) - 0.1;
  const hi = Math.log(Math.max(...sensValues)) + 0.1;
  const balance = sensValues.length >= 2 ? balancePoint(flicks) : null;

  let bestSens;
  let confidence;
  let clamped = null;
  if (balance) {
    let x = balance.x;
    if (x < lo) {
      x = lo;
      clamped = 'low';
    } else if (x > hi) {
      x = hi;
      clamped = 'high';
    }
    bestSens = Math.max(rules.min, Math.min(rules.max, toStep(Math.exp(x), rules)));
    if (clamped || balance.flatShare > 0.2 || balance.width > 0.3) confidence = 'tie';
    else if (balance.width > 0.12) confidence = 'close';
    else confidence = 'clear';
    if (clamped && confidence !== 'tie') confidence = 'close';
  } else {
    const ranked = [...summaries].sort(
      (a, b) => (b.landRate || 0) - (a.landRate || 0) || (b.isBase ? 1 : 0) - (a.isBase ? 1 : 0)
    );
    bestSens = ranked[0].sens;
    confidence = 'tie';
  }

  // The tested value nearest the recommendation stands in for its stats.
  const nearest = [...summaries].sort((a, b) => Math.abs(a.sens - bestSens) - Math.abs(b.sens - bestSens))[0];
  return {
    method: 'flick-check',
    candidates: summaries,
    best: { ...nearest, sens: bestSens, isBase: candidates.some((c) => c.isBase && c.sens === bestSens) },
    balance: balance ? { sens: Math.exp(balance.x), slope: balance.slope, clamped } : null,
    confidence,
    totalFlicks: flicks.length,
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
    text: 'Your first movement carries you past the head more often than not, then you come back. A lower sensitivity settles that.',
  },
  'slightly-over': {
    title: 'You overshoot slightly',
    text: 'Your first movement tends to land a little past the head. A step down is worth trying.',
  },
  balanced: {
    title: 'Your flicks land where you aim',
    text: "No consistent pull either way - the misses are spread rather than one-sided. That's what a sensitivity that suits you looks like.",
  },
  'slightly-under': {
    title: 'You stop slightly short',
    text: 'Your first movement tends to stop a little short of the head, so you finish with a nudge. A step up is worth trying.',
  },
  under: {
    title: 'You stop short',
    text: 'Your first movement stops short of the head and you creep the rest of the way, which costs time. A higher sensitivity fixes that.',
  },
};

export const CONFIDENCE_TEXT = {
  clear: { label: 'Clear result', hint: 'Your flicks balance out clearly here. Another pass can still narrow it down.' },
  close: { label: 'Close call', hint: 'Another pass will pin it down.' },
  tie: { label: 'Needs another pass', hint: 'Not enough of a pattern yet - run another pass before applying.' },
};

/**
 * Plans the next pass from a saved result: centred on the recommendation,
 * with half the spread - or the same spread when the answer sat at the edge
 * of what was tested, since the balance point is further out. The earlier
 * flicks come along, so the fit uses everything.
 */
export function planFineTune(prev, rules = SIEGE_RULES) {
  const edge = prev.balance && prev.balance.clamped;
  const spreadPct = edge ? prev.spreadPct : prev.spreadPct * 0.5;
  const candidates = buildCandidates(prev.best.sens, spreadPct, rules);
  return {
    candidates,
    spreadPct,
    atFinestStep: candidates[0].finest,
    carryOver: prev.rawResults || [],
    pooledPasses: Math.min((prev.pooledPasses || 1) + 1, MAX_POOLED_PASSES),
  };
}

/** Keeps the most recent MAX_POOLED_PASSES passes' worth of rounds. */
export function capPooledResults(rows) {
  const max = TOTAL_ROUNDS * MAX_POOLED_PASSES;
  return rows.length > max ? rows.slice(rows.length - max) : rows;
}
