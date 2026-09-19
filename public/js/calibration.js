const BLOCK_DURATION_SEC = 7;
const WARMUP_DURATION_SEC = 5;
const DRILL_ORDER = ['flick', 'targets', 'tracking'];
const DRILL_NAMES = { flick: 'Flicking', targets: 'Targets', tracking: 'Tracking' };
const ROUNDS_PER_COMBO = 3; // "Repeated rounds help check whether a setting performs consistently."

export const INITIAL_SPREAD_PCT = 0.15;
export const CANDIDATES_COUNT = 3;
export const TOTAL_SCORED_BLOCKS = CANDIDATES_COUNT * DRILL_ORDER.length * ROUNDS_PER_COMBO; // 27

/** Symmetric absolute spread around baseSens, e.g. 50 @ 15% -> 42 / 50 / 58. */
export function buildCandidates(baseSens, spreadPct) {
  const delta = Math.max(1, Math.round(baseSens * spreadPct));
  const low = Math.max(1, baseSens - delta);
  const high = baseSens + delta;
  return [
    { sens: low, isBase: false },
    { sens: baseSens, isBase: true },
    { sens: high, isBase: false },
  ].map((c) => ({ ...c, delta }));
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
  if (!rows.length) return 0;
  return rows.reduce((sum, r) => sum + (r[field] || 0), 0) / rows.length;
}
function sum(rows, field) {
  return rows.reduce((s, r) => s + (r[field] || 0), 0);
}

/** Groups scored block results by candidate sens (averaging repeated rounds) and computes a normalized 0-100 score per candidate. */
export function scoreResults(candidates, results) {
  const byCandidate = candidates.map((c) => {
    const own = results.filter((r) => r.candidateSens === c.sens);
    const flicks = own.filter((r) => r.type === 'flick');
    const targets = own.filter((r) => r.type === 'targets');
    const tracking = own.filter((r) => r.type === 'tracking');
    return {
      sens: c.sens,
      isBase: c.isBase,
      flickHitsPerSec: avg(flicks, 'flickHitsPerSec'),
      clearedPerSec: avg(targets, 'clearedPerSec'),
      onTargetPct: avg(tracking, 'onTargetPct'),
      accuracy: flicks.length ? avg(flicks, 'accuracy') : null,
      totalHits: sum(flicks, 'hits') + sum(targets, 'hits'),
    };
  });

  const maxFlick = Math.max(...byCandidate.map((c) => c.flickHitsPerSec), 0.0001);
  const maxCleared = Math.max(...byCandidate.map((c) => c.clearedPerSec), 0.0001);
  const maxTracking = Math.max(...byCandidate.map((c) => c.onTargetPct), 0.0001);

  byCandidate.forEach((c) => {
    const nFlick = c.flickHitsPerSec / maxFlick;
    const nCleared = c.clearedPerSec / maxCleared;
    const nTracking = c.onTargetPct / maxTracking;
    c.score = Math.round(((nFlick + nCleared + nTracking) / 3) * 100);
  });

  const best = byCandidate.reduce((a, b) => (b.score > a.score ? b : a), byCandidate[0]);
  return { candidates: byCandidate, best };
}

export function narrowedSpread(previousSpreadPct) {
  return Math.max(0.05, previousSpreadPct * 0.5);
}
