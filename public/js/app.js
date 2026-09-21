import { ensureSession } from './session.js';
import { getState, subscribe, updateSettings, setActiveTab, setResult, basisFor, isStale } from './state.js';
import {
  baseSensForTab,
  estimateCm360,
  formatCm360,
  compensateAdsForHipfireChange,
  calibrationFrom,
  isCalibrated,
  yawForTab,
  customMultiplierFactor,
} from './sensMath.js';
import { applyAccent, initThemePicker, initModeToggle } from './theme.js';
import { DrillEngine } from './drills.js';
import {
  buildCandidates,
  buildQueue,
  scoreResults,
  planFineTune,
  capPooledResults,
  CONFIDENCE_TEXT,
  INITIAL_SPREAD_PCT,
} from './calibration.js';
import {
  buildGameList,
  findGame,
  toCm360,
  fromCm360,
  formatSens,
  rangeWarning,
  CM360_ID,
} from './sensConvert.js';

const TAB_LABELS = { hipfire: 'Hip-fire', ads1x: '1× ADS', ads25x: '2.5× ADS' };

const $ = (id) => document.getElementById(id);

async function main() {
  const session = await ensureSession();
  if (!session) return;

  document.getElementById('pageRoot').style.display = '';
  applyAccent(getState().settings.accentColor);
  initModeToggle();

  bindSettingsFields();
  bindExpanders();
  bindTabs();
  bindConvert();
  initThemePicker({
    getAccent: () => getState().settings.accentColor,
    onChange: (hex) => {
      updateSettings({ accentColor: hex });
      applyAccent(hex);
    },
  });

  const engine = new DrillEngine({
    overlayEl: $('drillOverlay'),
    stageEl: $('drillStage'),
    canvasEl: $('drillCanvas'),
    elements: {
      phaseLabel: $('drillPhaseLabel'),
      timer: $('drillTimer'),
      score: $('drillScore'),
      hitPop: $('drillHitPop'),
      getReady: $('getReady'),
      getReadyLabel: $('getReadyLabel'),
      getReadyNum: $('getReadyNum'),
      pauseOverlay: $('pauseOverlay'),
      pauseReason: $('pauseReason'),
      resumeBtn: $('resumeBtn'),
    },
    onBlockComplete: (result, index, total) => {
      $('drillStatus').textContent = `Block ${index + 1} / ${total}`;
    },
    onQueueComplete: (results) => handleQueueComplete(engine, results),
    onPauseChange: (paused) => {
      if (paused) $('drillStatus').textContent = 'Paused';
    },
    onStartError: (err) => {
      run = null;
      alert(
        `Couldn't start the drill: ${err?.message || err}\n\nOpen the browser console (F12) for the full error if this keeps happening.`
      );
    },
  });

  let run = null; // { candidates, spreadPct, delta, centeredValue, passCount, centeredOn, carryOver, pooledPasses, tab, isPractice }

  function setDrillTabsHighlight(tab) {
    $('drillTabs').querySelectorAll('.tab').forEach((el) => {
      el.classList.toggle('active', el.dataset.tab === tab);
    });
  }

  /** A fresh calibration tests your current sens ±15%. A fine-tune pass
   * centres on the last winner with half the spread; once that's down to ±1
   * (the finest the in-game slider goes) it re-tests the same values and
   * pools the rounds instead, so each extra pass still adds reliability. */
  function startCalibration({ fineTune = false } = {}) {
    if (run) return;
    const tab = getState().activeTab;
    const settings = getState().settings;
    const prev = getState().results[tab];
    const canFineTune = fineTune && prev && !isStale(tab);

    let candidates, spreadPct, centeredValue, carryOver, pooledPasses;
    if (canFineTune) {
      ({ candidates, spreadPct, carryOver, pooledPasses } = planFineTune(prev));
      centeredValue = prev.best.sens;
    } else {
      centeredValue = Math.round(baseSensForTab(tab, settings));
      spreadPct = INITIAL_SPREAD_PCT;
      candidates = buildCandidates(centeredValue, spreadPct);
      carryOver = [];
      pooledPasses = 1;
    }

    const passCount = canFineTune ? (prev.passCount || 1) + 1 : 1;
    run = {
      candidates,
      spreadPct,
      delta: candidates[0].delta,
      centeredValue,
      passCount,
      centeredOn: canFineTune ? 'previous-best' : 'base',
      carryOver,
      pooledPasses,
      tab,
      isPractice: false,
    };

    setDrillTabsHighlight(tab);
    $('drillStatus').textContent = canFineTune ? `Fine-tuning · pass ${passCount}` : 'Calibrating…';
    engine.configure({ tab, settings });
    engine.run(buildQueue(candidates));
  }

  // "Practice": a quick 20s feel-check of the selected drill at your current
  // setting. "Fullscreen": the same drill left running open-ended, so you can
  // just play until you're done - end it from the pause screen (Esc) whenever.
  function startPractice({ freeform = false } = {}) {
    if (run) return;
    const tab = getState().activeTab;
    const settings = getState().settings;
    const type = $('drillPreview').value;
    const label = { flick: 'Flicking', targets: 'Targets', tracking: 'Tracking' }[type];
    run = { isPractice: true, tab };

    setDrillTabsHighlight(tab);
    $('drillStatus').textContent = freeform ? 'Free practice' : 'Practice';
    engine.configure({ tab, settings });
    engine.run([
      {
        type,
        durationSec: freeform ? 3600 : 20,
        scored: false,
        phaseLabel: freeform ? 'FREE PRACTICE' : 'PRACTICE',
        getReadyLabel: `${freeform ? 'Free practice' : 'Practice'} · ${label}`,
        candidateSens: null,
      },
    ]);
  }

  function handleQueueComplete(engineRef, results) {
    if (!run) return;
    if (run.isPractice) {
      $('resultsTitle').textContent = 'Practice complete';
      $('resultsSub').textContent = 'No scoring in practice mode - just a feel check.';
      $('resultsRec').hidden = true;
      $('fineTuneBtn').hidden = true;
      $('applyResultsBtn').hidden = true;
    } else {
      const pooled = capPooledResults([...run.carryOver, ...results]);
      const scored = scoreResults(run.candidates, pooled);
      const saved = {
        ...scored,
        spreadPct: run.spreadPct,
        delta: run.delta,
        centeredValue: run.centeredValue,
        passCount: run.passCount,
        centeredOn: run.centeredOn,
        pooledPasses: run.pooledPasses,
        rawResults: pooled,
      };
      setResult(run.tab, saved, basisFor(run.tab));
      showCalibrationResults(saved, run.tab);
    }
    $('resultsOverlay').classList.add('active');
    run = null;
  }

  function showCalibrationResults(result, tab) {
    const conf = CONFIDENCE_TEXT[result.confidence];
    const values = result.candidates.map((c) => c.sens).join(' / ');
    $('resultsTitle').textContent =
      result.passCount > 1 ? `Fine-tune pass ${result.passCount - 1} complete` : 'Calibration complete';
    $('resultsSub').textContent = `${TAB_LABELS[tab]} · tested ${values}${poolNote(result)}`;

    $('resultsRec').hidden = false;
    $('resultsRecValue').textContent = result.best.sens;
    $('resultsConfidence').className = `badge ${CONFIDENCE_BADGE[result.confidence]}`;
    $('resultsConfidence').textContent = conf.label;
    $('resultsTableBody').innerHTML = comparisonRowsHtml(result);
    $('resultsHint').textContent = fineTuneHint(result);

    // Whichever action makes more sense right now gets the accent colour: a
    // clear winner you're not already on is ready to apply; anything closer,
    // or a winner that's already your setting, points at another pass.
    const current = Math.round(baseSensForTab(tab, getState().settings));
    const alreadySet = result.best.sens === current;
    const readyToApply = result.confidence === 'clear' && !alreadySet;
    $('fineTuneBtn').hidden = false;
    $('fineTuneBtn').className = readyToApply ? 'plain-btn' : 'btn-accent';

    const apply = $('applyResultsBtn');
    apply.hidden = false;
    apply.className = readyToApply ? 'btn-accent' : 'plain-btn';
    apply.disabled = alreadySet;
    apply.textContent = alreadySet ? `${current} is already set` : `Apply ${result.best.sens}`;
  }

  $('closeResultsBtn').addEventListener('click', () => {
    engine.exit();
    $('resultsOverlay').classList.remove('active');
    renderAll();
  });

  // Straight into the next, narrower pass without leaving fullscreen - the
  // click itself is the user gesture pointer lock needs.
  $('fineTuneBtn').addEventListener('click', () => {
    $('resultsOverlay').classList.remove('active');
    startCalibration({ fineTune: true });
  });

  $('applyResultsBtn').addEventListener('click', () => {
    applyRecommendation();
    $('applyResultsBtn').disabled = true;
    $('applyResultsBtn').textContent = 'Applied ✓';
  });

  $('startCalibrationBtn').addEventListener('click', () => startCalibration());
  $('practiceBtn').addEventListener('click', () => startPractice());
  $('fullscreenBtn').addEventListener('click', () => startPractice({ freeform: true }));

  $('endSessionBtn').addEventListener('click', () => {
    // Works for a calibration run too, not just practice - quitting early
    // just means that pass's data doesn't get scored/saved.
    engine.exit();
    run = null;
    $('pauseOverlay').classList.remove('active');
    renderAll();
  });

  $('exitFullscreenBtn').addEventListener('click', () => {
    // Leaves fullscreen but keeps the session paused (not ended) - "Resume
    // round" continues windowed. Separate from End session on purpose.
    if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
  });

  document.addEventListener('click', (e) => {
    if (e.target.id === 'applyRecBtn') applyRecommendation();
    if (e.target.id === 'fineTuneCardBtn') startCalibration({ fineTune: true });
  });

  $('clearComparisonBtn').addEventListener('click', () => {
    setResult(getState().activeTab, null, null);
    renderAll();
  });

  subscribe(() => renderAll());
  renderAll();
}

function applyRecommendation() {
  const tab = getState().activeTab;
  const result = getState().results[tab];
  if (!result) return;
  const sens = result.best.sens;
  if (tab === 'hipfire') {
    updateSettings({ hipfireH: sens, hipfireV: sens });
  } else {
    updateSettings({ ads25x: sens });
  }
}

// ---------- Settings field bindings ----------

function bindStepper(field, { step = 1, min = 1, max = 100, decimals = 0 } = {}) {
  const wrap = document.querySelector(`.stepper[data-field="${field}"]`);
  const input = wrap.querySelector('input');
  const up = wrap.querySelector('[data-dir="1"]');
  const down = wrap.querySelector('[data-dir="-1"]');

  function commit(raw) {
    let v = Math.max(min, Math.min(max, raw));
    v = Math.round(v / step) * step;
    if (decimals === 0) v = Math.round(v);
    applyFieldChange(field, v);
  }

  up.addEventListener('click', () => commit(Number(input.value) + step));
  down.addEventListener('click', () => commit(Number(input.value) - step));
  input.addEventListener('change', () => commit(Number(input.value) || min));
}

function applyFieldChange(field, value) {
  if (field === 'hipfireH' || field === 'hipfireV') {
    const s = getState().settings;
    const oldAvg = (s.hipfireH + s.hipfireV) / 2;
    const patch = { [field]: value };
    const newAvg = field === 'hipfireH' ? (value + s.hipfireV) / 2 : (s.hipfireH + value) / 2;
    if (s.keepAdsSpeed) {
      patch.ads25x = compensateAdsForHipfireChange(oldAvg, newAvg, s.ads25x);
    }
    updateSettings(patch);
  } else {
    updateSettings({ [field]: value });
  }
}

function bindSettingsFields() {
  bindStepper('hipfireH', { step: 1, min: 1, max: 50 });
  bindStepper('hipfireV', { step: 1, min: 1, max: 50 });
  bindStepper('ads25x', { step: 1, min: 1, max: 100 });
  bindStepper('dpi', { step: 50, min: 100, max: 26000 });
  bindStepper('fov', { step: 1, min: 60, max: 110 });

  $('keepAdsSpeed').addEventListener('change', (e) => updateSettings({ keepAdsSpeed: e.target.checked }));

  $('useCustomMultiplier').addEventListener('change', (e) => {
    updateSettings({ useCustomMultiplier: e.target.checked });
    $('customMultiplier').disabled = !e.target.checked;
  });

  $('customMultiplier').addEventListener('change', (e) => {
    updateSettings({ customMultiplier: Number(e.target.value) || 0.02 });
  });

  $('aspectRatio').addEventListener('change', (e) => updateSettings({ aspectRatio: e.target.value }));
  $('screenFill').addEventListener('change', (e) => updateSettings({ screenFill: e.target.value }));

  bindAds1xMeasured();
}

/** Writes a measured cm/360 for one optic into the calibration snapshot
 * (or clears it). Everything else derives from there. */
function setCalibration(tab, cm360) {
  const s = getState().settings;
  const calib = { ...s.calib, [tab]: cm360 == null ? null : calibrationFrom(tab, cm360, s) };
  updateSettings({ calib });
}

/** ADS·1x is nullable (empty = "use the estimate") and steps by 0.5, unlike
 * the other sidebar fields, so it gets its own binding instead of bindStepper. */
function bindAds1xMeasured() {
  const wrap = document.querySelector('.stepper[data-field="ads1xMeasured"]');
  const input = wrap.querySelector('input');
  const up = wrap.querySelector('[data-dir="1"]');
  const down = wrap.querySelector('[data-dir="-1"]');
  const step = 0.5;

  function commit(v) {
    setCalibration('ads1x', v == null ? null : Math.max(1, Math.round(v * 10) / 10));
  }

  function currentOrEstimate() {
    const raw = input.value.trim();
    if (raw) return Number(raw);
    const s = getState().settings;
    return estimateCm360('ads1x', { ...s, calib: { ...s.calib, ads1x: null } });
  }

  up.addEventListener('click', () => commit(currentOrEstimate() + step));
  down.addEventListener('click', () => commit(currentOrEstimate() - step));
  input.addEventListener('change', () => {
    const raw = input.value.trim();
    commit(raw ? Number(raw) : null);
  });
}

function bindExpanders() {
  $('themeToggle').addEventListener('click', () => {
    $('themeToggle').classList.toggle('open');
    $('themeBody').classList.toggle('open');
  });
  $('calibrateToggle').addEventListener('click', () => {
    $('calibrateToggle').classList.toggle('open');
    $('calibrateBody').classList.toggle('open');
  });

  $('modelNoteLink').addEventListener('click', () => {
    const input = $('ads1xMeasuredInput');
    input.focus();
    input.scrollIntoView({ behavior: 'smooth', block: 'center' });
  });

  $('measuredHipfireInput').addEventListener('change', (e) => {
    const v = e.target.value.trim();
    setCalibration('hipfire', v ? Number(v) : null);
  });
  $('measuredAds25xInput').addEventListener('change', (e) => {
    const v = e.target.value.trim();
    setCalibration('ads25x', v ? Number(v) : null);
  });
}

function bindTabs() {
  $('mainTabs').querySelectorAll('.tab').forEach((btn) => {
    btn.addEventListener('click', () => setActiveTab(btn.dataset.tab));
  });
}

// ---------- Rendering ----------

const CONFIDENCE_BADGE = { clear: 'ok', close: 'close', tie: 'retest' };

const fmtPts = (v) => (v == null || !isFinite(v) ? '—' : String(Math.round(v)));
const fmtPct = (v) => (v == null || !isFinite(v) ? '—' : `${Math.round(v * 100)}%`);

function poolNote(result) {
  return result.pooledPasses > 1
    ? ` · ${result.best.roundsPerDrill} rounds per drill, pooled over ${result.pooledPasses} passes`
    : '';
}

function fineTuneHint(result) {
  if (result.delta === 1) {
    return (
      `You're down to ±1, the finest step Siege's slider has. Fine-tuning again re-tests ` +
      `these same values and pools the rounds, so the answer gets more reliable each pass.`
    );
  }
  return `${CONFIDENCE_TEXT[result.confidence].hint} Next pass tests ±${Math.max(1, Math.round(result.best.sens * result.spreadPct * 0.5))} around ${result.best.sens}.`;
}

/** Table rows shared by the results screen and the comparison card. Matches
 * the winner by sens rather than object identity, since results reloaded
 * from localStorage are fresh copies. */
function comparisonRowsHtml(result) {
  const tag = result.centeredOn === 'previous-best' ? 'last best' : 'current';
  return result.candidates
    .map((c) => {
      const cls = [c.isBase ? 'base' : '', c.sens === result.best.sens ? 'best' : ''].filter(Boolean).join(' ');
      return `<tr class="${cls}">
        <td>${c.sens}${c.isBase ? ` · ${tag}` : ''}</td>
        <td>${fmtPts(c.flickPts)}</td>
        <td>${fmtPts(c.targetsPts)}</td>
        <td>${fmtPct(c.centredPct)}</td>
        <td>${c.score}</td>
      </tr>`;
    })
    .join('');
}

const SCORING_FOOTNOTE =
  'Flick & Targets: bullseye points per second (centre hit 100, rim hit 50, miss −25). ' +
  'Tracking: how centred you kept the crosshair on the dot. Each drill is a third of the score, relative to the best in that drill.';

function renderAll() {
  const state = getState();
  renderSettingsInputs(state);
  renderTabsUI(state);
  renderStats(state);
  renderRecommendation(state);
  renderComparison(state);
  renderConvert(state);
}

// ---------- Sensitivity converter ----------

/** Siege's three optics as yaw constants, so they can sit in the converter's
 * game list alongside Valorant/CS/etc. The custom-multiplier factor is folded
 * in here because it scales every optic the same way. */
function r6YawMap(settings) {
  const mult = customMultiplierFactor(settings);
  return {
    hipfire: yawForTab('hipfire', settings) * mult,
    ads1x: yawForTab('ads1x', settings) * mult,
    ads25x: yawForTab('ads25x', settings) * mult,
  };
}

function convertList() {
  return buildGameList(r6YawMap(getState().settings));
}

/** The converter's own fields default to whatever the user already has set
 * up above, so the card is showing something meaningful before it's touched. */
function convertValues(state) {
  const s = state.settings;
  const c = s.convert || {};
  const from = c.from || 'r6_hipfire';
  const fallbackSens =
    from === 'r6_hipfire' ? s.hipfireH : from === 'r6_ads1x' || from === 'r6_ads25x' ? s.ads25x : 1;
  return {
    from,
    to: c.to || 'valorant',
    sens: c.sens === undefined ? fallbackSens : c.sens,
    fromDpi: c.fromDpi === undefined ? s.dpi : c.fromDpi,
    toDpi: c.toDpi === undefined ? s.dpi : c.toDpi,
  };
}

function patchConvert(patch) {
  const current = convertValues(getState());
  updateSettings({ convert: { ...current, ...patch } });
}

function fillGameSelect(el, list, selectedId) {
  el.innerHTML = list
    .map((g) => `<option value="${g.id}">${g.name}</option>`)
    .join('');
  el.value = selectedId;
}

function bindConvert() {
  const list = convertList();
  const v = convertValues(getState());
  fillGameSelect($('convertFromGame'), list, v.from);
  fillGameSelect($('convertToGame'), list, v.to);

  $('convertFromGame').addEventListener('change', (e) => patchConvert({ from: e.target.value }));
  $('convertToGame').addEventListener('change', (e) => patchConvert({ to: e.target.value }));
  $('convertFromSens').addEventListener('input', (e) => patchConvert({ sens: numOrNull(e.target.value) }));
  $('convertFromDpi').addEventListener('input', (e) => patchConvert({ fromDpi: numOrNull(e.target.value) }));
  $('convertToDpi').addEventListener('input', (e) => patchConvert({ toDpi: numOrNull(e.target.value) }));

  // Swapping carries the *result* back into the input box, so flipping
  // direction twice round-trips to where you started instead of silently
  // reinterpreting the old number as the other game's sens.
  $('convertSwapBtn').addEventListener('click', () => {
    const cur = convertValues(getState());
    const games = convertList();
    const cm = toCm360(findGame(games, cur.from), cur.sens, cur.fromDpi);
    const toGame = findGame(games, cur.to);
    const swappedSens = fromCm360(toGame, cm, cur.toDpi);
    patchConvert({
      from: cur.to,
      to: cur.from,
      fromDpi: cur.toDpi,
      toDpi: cur.fromDpi,
      sens: isFinite(swappedSens) && swappedSens > 0 ? roundTo(swappedSens, toGame) : cur.sens,
    });
  });
}

function numOrNull(raw) {
  const n = Number(raw);
  return raw === '' || !isFinite(n) ? null : n;
}

function roundTo(sens, game) {
  const d = game && game.decimals != null ? game.decimals : 3;
  return Number(sens.toFixed(d));
}

function renderConvert(state) {
  const games = convertList();
  const v = convertValues(state);
  const fromGame = findGame(games, v.from);
  const toGame = findGame(games, v.to);

  // Selects are rebuilt rather than just re-selected: the R6 entries' names
  // are static, but the list is cheap and this keeps it correct if it grows.
  if ($('convertFromGame').options.length !== games.length) {
    fillGameSelect($('convertFromGame'), games, v.from);
    fillGameSelect($('convertToGame'), games, v.to);
  } else {
    $('convertFromGame').value = v.from;
    $('convertToGame').value = v.to;
  }

  const fromIsCm = fromGame && fromGame.id === CM360_ID;
  const toIsCm = toGame && toGame.id === CM360_ID;
  $('convertFromSensLbl').textContent = fromIsCm ? 'cm/360°' : 'Sensitivity';
  $('convertToSensLbl').textContent = toIsCm ? 'cm/360°' : 'Sensitivity';
  // cm/360 is a DPI-independent figure, so the DPI box on that side has
  // nothing to do - grey it out rather than implying it matters.
  $('convertFromDpi').disabled = !!fromIsCm;
  $('convertToDpi').disabled = !!toIsCm;

  if (document.activeElement !== $('convertFromSens')) $('convertFromSens').value = v.sens ?? '';
  if (document.activeElement !== $('convertFromDpi')) $('convertFromDpi').value = v.fromDpi ?? '';
  if (document.activeElement !== $('convertToDpi')) $('convertToDpi').value = v.toDpi ?? '';

  const cm360 = toCm360(fromGame, v.sens, v.fromDpi);
  const result = fromCm360(toGame, cm360, v.toDpi);
  $('convertResult').textContent = formatSens(result, toGame ? toGame.decimals : 3);

  $('convertCm').innerHTML =
    isFinite(cm360) && cm360 > 0
      ? `Both work out to <b>${cm360.toFixed(1)} cm/360°</b>${
          v.fromDpi !== v.toDpi && !fromIsCm && !toIsCm ? ' — DPI difference accounted for.' : '.'
        }`
      : 'Enter a sensitivity to convert.';

  const warn = rangeWarning(toGame, result);
  $('convertWarn').hidden = !warn;
  $('convertWarn').textContent = warn;

  const others = games.filter((g) => g.id !== v.from && g.id !== CM360_ID);
  $('convertBody').innerHTML = others
    .map((g) => {
      const s = fromCm360(g, cm360, v.toDpi);
      const best = g.id === v.to ? ' class="best"' : '';
      return `<tr${best}><td>${g.name}</td><td>${formatSens(s, g.decimals)}</td></tr>`;
    })
    .join('');
}

function renderSettingsInputs(state) {
  const s = state.settings;
  document.querySelector('.stepper[data-field="hipfireH"] input').value = s.hipfireH;
  document.querySelector('.stepper[data-field="hipfireV"] input').value = s.hipfireV;
  document.querySelector('.stepper[data-field="ads25x"] input').value = s.ads25x;
  document.querySelector('.stepper[data-field="dpi"] input').value = s.dpi;
  document.querySelector('.stepper[data-field="fov"] input').value = s.fov;
  $('keepAdsSpeed').checked = s.keepAdsSpeed;
  $('useCustomMultiplier').checked = s.useCustomMultiplier;
  $('customMultiplier').value = s.customMultiplier;
  $('customMultiplier').disabled = !s.useCustomMultiplier;
  $('aspectRatio').value = s.aspectRatio;
  $('screenFill').value = s.screenFill;
  const ads1xInput = $('ads1xMeasuredInput');
  ads1xInput.value = s.calib?.ads1x?.cm360 ?? '';
  const estimate = estimateCm360('ads1x', { ...s, calib: { ...s.calib, ads1x: null } });
  ads1xInput.placeholder = `Est. ${formatCm360(estimate)}`;

  $('measuredHipfireInput').value = s.calib?.hipfire?.cm360 ?? '';
  $('measuredAds25xInput').value = s.calib?.ads25x?.cm360 ?? '';
}

function renderTabsUI(state) {
  $('mainTabs').querySelectorAll('.tab').forEach((el) => {
    el.classList.toggle('active', el.dataset.tab === state.activeTab);
  });
  $('comparisonTag').textContent = TAB_LABELS[state.activeTab];
  $('modelNote').style.display = state.activeTab === 'ads1x' ? '' : 'none';

  const result = state.results[state.activeTab];
  const spread = result ? result.spreadPct : INITIAL_SPREAD_PCT;
  $('refineSub').textContent = `We test your current setting and approximately ${Math.round(spread * 100)}% either side.`;
}

function renderStats(state) {
  const tab = state.activeTab;
  const s = state.settings;
  const sens = baseSensForTab(tab, s);
  $('statActiveSens').textContent = tab === 'hipfire' ? Math.round(sens * 10) / 10 : sens;
  $('statCm360').textContent = formatCm360(estimateCm360(tab, s));
  // Make it obvious whether this number is anchored to a real measurement
  // or is still just the model's guess.
  const calibrated = isCalibrated(tab, s);
  $('cm360Label').textContent = calibrated ? 'Measured cm/360°' : 'Estimated cm/360°';
  $('cm360Label').title = calibrated
    ? 'Derived from the cm/360 you measured in-game for this optic.'
    : 'Model estimate - measure your real cm/360 under "Calibrate to your real sens" to make this exact.';

  const result = state.results[tab];
  if (result) {
    $('statAccuracy').textContent = result.best.accuracy != null ? `${Math.round(result.best.accuracy * 100)}%` : '—';
    $('statTargets').textContent = fmtPct(result.best.precision);
  } else {
    $('statAccuracy').textContent = '—';
    $('statTargets').textContent = '—';
  }
}

function renderRecommendation(state) {
  const tab = state.activeTab;
  const result = state.results[tab];
  const stale = isStale(tab);
  const badge = $('retestBadge');
  const body = $('recommendationBody');

  if (!result) {
    badge.style.display = 'inline-block';
    badge.className = 'badge incomplete';
    badge.textContent = 'INCOMPLETE';
    body.innerHTML =
      '<p class="card-empty">0 of 27 scored rounds recorded. Every setting needs every drill in all 3 blocks before a recommendation.</p>';
    return;
  }

  if (stale) {
    badge.style.display = 'inline-block';
    badge.className = 'badge retest';
    badge.textContent = 'RETEST REQUIRED';
    body.innerHTML =
      '<p class="card-empty">These results used earlier settings or an older scoring method. Run a fresh calibration before applying a recommendation.</p>';
    return;
  }

  const conf = CONFIDENCE_TEXT[result.confidence] || CONFIDENCE_TEXT.close;
  badge.style.display = 'inline-block';
  badge.className = `badge ${CONFIDENCE_BADGE[result.confidence] || 'close'}`;
  badge.textContent = conf.label.toUpperCase();

  const current = Math.round(baseSensForTab(tab, state.settings));
  const delta = result.best.sens - current;
  const deltaText =
    delta === 0 ? 'Matches your current setting.' : `${delta > 0 ? '+' : ''}${delta} from your current ${current}.`;
  const refinedText = result.passCount > 1 ? ` · fine-tuned ×${result.passCount - 1}` : '';

  body.innerHTML = `
    <div class="rec-value">${result.best.sens}</div>
    <p class="rec-sub">${deltaText} Scored ${result.best.score}/100${refinedText}.</p>
    <p class="rec-sub rec-hint">${fineTuneHint(result)}</p>
    <div class="rec-actions">
      <button id="applyRecBtn" class="btn-accent"${delta === 0 ? ' disabled' : ''}>Apply to ${TAB_LABELS[tab]}</button>
      <button id="fineTuneCardBtn" class="plain-btn">Fine-tune further</button>
    </div>
  `;
}

function renderComparison(state) {
  const tab = state.activeTab;
  const result = state.results[tab];
  const tbody = $('comparisonBody');
  const footnote = $('comparisonFootnote');

  if (!result) {
    // Preview which sensitivities a fresh run would test, before any data exists.
    const baseSens = baseSensForTab(tab, state.settings);
    const preview = buildCandidates(baseSens, INITIAL_SPREAD_PCT);
    tbody.innerHTML = preview
      .map(
        (c) => `<tr class="${c.isBase ? 'base' : ''}">
          <td>${c.sens}${c.isBase ? ' · current' : ''}</td>
          <td>—</td><td>—</td><td>—</td><td>—</td>
        </tr>`
      )
      .join('');
    footnote.textContent = `Pass 1 will test ${preview.map((c) => c.sens).join(' / ')}. ${SCORING_FOOTNOTE}`;
    return;
  }

  tbody.innerHTML = comparisonRowsHtml(result);
  footnote.textContent = `Pass ${result.passCount} tested ${result.candidates.map((c) => c.sens).join(' / ')}${poolNote(result)}. ${SCORING_FOOTNOTE}`;
}

main();
