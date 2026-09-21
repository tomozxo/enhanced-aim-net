const BLOCK_DURATION_SEC = 7;
const WARMUP_DURATION_SEC = 5;
const DRILL_ORDER = ['flick', 'targets', 'tracking'];
const DRILL_NAMES = { flick: 'Flicking', targets: 'Targets', tracking: 'Tracking' };
const ROUNDS_PER_COMBO = 3; // "Repeated rounds help check whether a setting performs consistently."

// Siege's sens sliders are whole numbers from 1 to 100, so every candidate
// has to be one of those - there's no point recommending a value the game
// won't let you set.
const MIN_SENS = 1;
const MAX_SENS = 100;

// When a fine-tune pass re-tests the exact same three values (because the
// spread is already down to ±1), its rounds are pooled with the previous
// pass's. Capped so a long run of fine-tuning can't grow saved state forever.
const MAX_POOLED_PASSES = 4;

export const INITIAL_SPREAD_PCT = 0.15;
export const CANDIDATES_COUNT = 3;
export const TOTAL_SCORED_BLOCKS = CANDIDATES_COUNT * DRILL_ORDER.length * ROUNDS_PER_COMBO; // 27

/** Three candidates `delta` apart, e.g. 50 @ 15% -> 42 / 50 / 58. Normally
 * centred on baseSens; shifted up or down when that would fall off either
 * end of the slider, so you always get three distinct values to compare. */
export function buildCandidates(baseSens, spreadPct) {
  const base = Math.round(baseSens);
  const delta = Math.max(1, Math.round(base * spreadPct));
  let values = [base - delta, base, base + delta];
  if (values[0] < MIN_SENS) values = [base, base + delta, base + 2 * delta];
  else if (values[2] > MAX_SENS) values = [base - 2 * delta, base - delta, base];
  return values.map((sens) => ({ sens, isBase: sens === base, delta }));
}

export function buildQueue(candidates) {
  const queue = [];
  queue.push({
    type: 'flick',
    durationSec: WARMUP_DURATION_SEC,
    scored: false,
    phaseLabel: 'WARM-UP',
    getReadyLabel: 'Warm-up',
    candidateSens: null,
  });

  candidates.forEach((c, ci) => {
    DRILL_ORDER.forEach((type) => {
      for (let round = 1; round <= ROUNDS_PER_COMBO; round++) {
        queue.push({
          type,
          durationSec: BLOCK_DURATION_SEC,
          scored: true,
          phaseLabel: `TEST ${ci + 1} OF ${candidates.length}`,
          getReadyLabel: `Test ${ci + 1} of ${candidates.length} · ${DRILL_NAMES[type]} · Round ${round} of ${ROUNDS_PER_COMBO}`,
          candidateSens: c.sens,
          isBase: c.isBase,
          round,
        });
      }
    });
  });

  return queue;
}

function avg(rows, field) {
  const vals = rows.map((r) => r[field]).filter((v) => v != null);
  if (!vals.length) return 0;
  return vals.reduce((s, v) => s + v, 0) / vals.length;
}
function sum(rows, field) {
  return rows.reduce((s, r) => s + (r[field] || 0), 0);
}

/**
 * Groups scored block results by candidate (averaging repeated rounds) and
 * gives each a 0-100 score:
 *   - Flick: hits per second.
 *   - Targets: dots cleared per second.
 *   - Tracking: share of the round the crosshair was on the dot.
 * A hit anywhere on a target counts - the inner circle and the outer band
 * are worth the same. "Inner hits" is kept as a stat to look at, and doesn't
 * affect the score. Each drill is normalised against the best candidate in
 * that drill, and the three are weighted equally.
 */
export function scoreResults(candidates, results) {
  const byCandidate = candidates.map((c) => {
    const own = results.filter((r) => r.candidateSens === c.sens);
    const flicks = own.filter((r) => r.type === 'flick');
    const targets = own.filter((r) => r.type === 'targets');
    const tracking = own.filter((r) => r.type === 'tracking');
    const shots = [...flicks, ...targets];
    const hits = sum(shots, 'hits');
    const clicks = sum(shots, 'clicks');
    return {
      sens: c.sens,
      isBase: c.isBase,
      flickHitsPerSec: avg(flicks, 'flickHitsPerSec'),
      clearedPerSec: avg(targets, 'clearedPerSec'),
      onTargetPct: avg(tracking, 'onTargetPct'),
      innerHitPct: hits ? sum(shots, 'innerHits') / hits : null,
      accuracy: clicks ? hits / clicks : null,
      totalHits: hits,
      roundsPerDrill: Math.min(flicks.length, targets.length, tracking.length),
    };
  });

  const maxOf = (field) => Math.max(...byCandidate.map((c) => c[field]), 0.0001);
  const maxFlick = maxOf('flickHitsPerSec');
  const maxCleared = maxOf('clearedPerSec');
  const maxTracking = maxOf('onTargetPct');

  byCandidate.forEach((c) => {
    const n = c.flickHitsPerSec / maxFlick + c.clearedPerSec / maxCleared + c.onTargetPct / maxTracking;
    c.score = Math.round((n / 3) * 100);
  });

  // On a tie, keep what you already play on rather than recommending a change.
  const ranked = [...byCandidate].sort((a, b) => b.score - a.score || (b.isBase ? 1 : 0) - (a.isBase ? 1 : 0));
  const best = ranked[0];
  const margin = ranked.length > 1 ? ranked[0].score - ranked[1].score : 100;

  return { candidates: byCandidate, best, margin, confidence: confidenceFor(margin) };
}

/**
 * How decisively the winner won, in score points over the runner-up. These
 * thresholds are rules of thumb from how much scores typically wobble between
 * rounds, not a formal statistical test - they're there to tell you whether
 * another fine-tune pass is worth doing.
 */
export function confidenceFor(margin) {
  if (margin >= 8) return 'clear';
  if (margin >= 3) return 'close';
  return 'tie';
}

export const CONFIDENCE_TEXT = {
  clear: { label: 'Clear winner', hint: 'This one stood out. Fine-tuning further can still narrow it down.' },
  close: { label: 'Close call', hint: 'Another fine-tune pass will make this more reliable.' },
  tie: { label: 'Too close to call', hint: 'The top two were nearly even - fine-tune again before applying.' },
};

export function narrowedSpread(previousSpreadPct) {
  // No percentage floor any more: buildCandidates already stops at a ±1
  // step, which is the finest the in-game slider goes.
  return previousSpreadPct * 0.5;
}

/**
 * Plans the next fine-tune pass from a saved result: centred on the previous
 * winner with half the spread. Once the spread is already down to ±1 it can't
 * narrow any further, so it re-tests the same three values and pools the new
 * rounds with the old ones - more rounds on the same values is what makes the
 * recommendation more reliable at that point.
 */
export function planFineTune(prev) {
  const spreadPct = narrowedSpread(prev.spreadPct);
  const candidates = buildCandidates(prev.best.sens, spreadPct);
  const sameValues =
    prev.rawResults &&
    prev.candidates.length === candidates.length &&
    prev.candidates.every((c, i) => c.sens === candidates[i].sens);
  const pooled = sameValues ? (prev.pooledPasses || 1) + 1 : 1;
  return {
    candidates,
    spreadPct,
    atFinestStep: candidates[0].delta === 1,
    carryOver: sameValues ? prev.rawResults : [],
    pooledPasses: Math.min(pooled, MAX_POOLED_PASSES),
  };
}

/** Keeps only the most recent MAX_POOLED_PASSES passes' worth of rounds. */
export function capPooledResults(rows) {
  const perPass = TOTAL_SCORED_BLOCKS;
  const max = perPass * MAX_POOLED_PASSES;
  return rows.length > max ? rows.slice(rows.length - max) : rows;
}
