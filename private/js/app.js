import { ensureSession } from './session.js';
import {
  getState,
  subscribe,
  updateSettings,
  updateGameSettings,
  getGameSettings,
  setGame,
  setActiveTab,
  setResult,
  basisFor,
  isStale,
} from './state.js';
import {
  GAMES,
  GAME_ORDER,
  getGame,
  quantizeSens,
  formatSens as formatGameSens,
  tabLabel,
  hFovFromV,
  parseResolution,
} from './games.js';
import {
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

const $ = (id) => document.getElementById(id);

/** The game the page is currently calibrating for (an entry from games.js). */
const currentGame = () => getGame(getState().game);

/** What to call the thing being calibrated: Siege's optic ("2.5× ADS"), or
 * just the game for the ones with a single sens ("Valorant"). */
function scopeLabel(game, tab) {
  return game.tabs.length > 1 ? tabLabel(game, tab) : game.short;
}

/** The sens currently set for this tab, rounded to what the game accepts. */
function currentSens(game, tab, settings) {
  return quantizeSens(game, game.baseSens(tab, settings));
}

async function main() {
  const session = await ensureSession();
  if (!session) return;

  document.getElementById('pageRoot').style.display = '';
  applyAccent(getState().settings.accentColor);
  initModeToggle();

  bindGamePicker();
  bindSettingsFields();
  bindSimpleGameFields();
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
    // Raw input is what makes the drill's sens match the game's 1:1, so say
    // clearly when the browser can't provide it.
    onRawInputChange: (raw) => {
      const note = $('rawInputNote');
      note.hidden = false;
      note.className = raw ? 'raw-input ok' : 'raw-input warn';
      note.textContent = raw
        ? 'Raw mouse input'
        : 'No raw input in this browser - Windows mouse settings are affecting the drill. Use Chrome or Edge for exact sens.';
    },
  });

  let run = null; // { candidates, spreadPct, delta, centeredValue, passCount, centeredOn, carryOver, pooledPasses, tab, isPractice }

  function setDrillTabsHighlight(tab) {
    $('drillTabs').querySelectorAll('.tab').forEach((el) => {
      el.classList.toggle('active', el.dataset.tab === tab);
    });
  }

  /** A fresh calibration tests your current sens ±15%. A fine-tune pass
   * centres on the last winner with half the spread; once that's at the
   * game's finest step (±1 on Siege's sliders, ±2% for Valorant/CS2) it
   * re-tests the same values and pools the rounds instead, so each extra
   * pass still adds reliability. */
  function startCalibration({ fineTune = false } = {}) {
    if (run) return;
    const game = currentGame();
    const tab = getState().activeTab;
    const settings = getState().settings;
    const prev = getState().results[tab];
    const canFineTune = fineTune && prev && !isStale(tab);

    let candidates, spreadPct, centeredValue, carryOver, pooledPasses;
    if (canFineTune) {
      ({ candidates, spreadPct, carryOver, pooledPasses } = planFineTune(prev, game.rules));
      centeredValue = prev.best.sens;
    } else {
      centeredValue = currentSens(game, tab, settings);
      spreadPct = INITIAL_SPREAD_PCT;
      candidates = buildCandidates(centeredValue, spreadPct, game.rules);
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
      atFinestStep: candidates[0].finest,
      carryOver,
      pooledPasses,
      tab,
      isPractice: false,
    };

    setDrillTabsHighlight(tab);
    $('drillStatus').textContent = canFineTune ? `Fine-tuning · pass ${passCount}` : 'Calibrating…';
    engine.configure({ game, tab, settings });
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
    engine.configure({ game: currentGame(), tab, settings });
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
        atFinestStep: run.atFinestStep,
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
    const game = currentGame();
    const fmt = (v) => formatGameSens(game, v);
    const conf = CONFIDENCE_TEXT[result.confidence];
    const values = result.candidates.map((c) => fmt(c.sens)).join(' / ');
    $('resultsTitle').textContent =
      result.passCount > 1 ? `Fine-tune pass ${result.passCount - 1} complete` : 'Calibration complete';
    $('resultsSub').textContent = `${scopeLabel(game, tab)} · tested ${values}${poolNote(result)}`;

    $('resultsRec').hidden = false;
    $('resultsRecValue').textContent = fmt(result.best.sens);
    $('resultsConfidence').className = `badge ${CONFIDENCE_BADGE[result.confidence]}`;
    $('resultsConfidence').textContent = conf.label;
    $('resultsTableBody').innerHTML = comparisonRowsHtml(result, game);
    $('resultsHint').textContent = fineTuneHint(result, game);

    // Whichever action makes more sense right now gets the accent colour: a
    // clear winner you're not already on is ready to apply; anything closer,
    // or a winner that's already your setting, points at another pass.
    const current = currentSens(game, tab, getState().settings);
    const alreadySet = result.best.sens === current;
    const readyToApply = result.confidence === 'clear' && !alreadySet;
    $('fineTuneBtn').hidden = false;
    $('fineTuneBtn').className = readyToApply ? 'plain-btn' : 'btn-accent';

    const apply = $('applyResultsBtn');
    apply.hidden = false;
    apply.className = readyToApply ? 'btn-accent' : 'plain-btn';
    apply.disabled = alreadySet;
    apply.textContent = alreadySet ? `${fmt(current)} is already set` : `Apply ${fmt(result.best.sens)}`;
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
  updateSettings(currentGame().applySens(tab, result.best.sens));
}

// ---------- Game picker ----------

function bindGamePicker() {
  $('gamePicker').innerHTML =
    '<span class="game-picker-label">Game</span>' +
    GAME_ORDER.map((id) => {
      const g = GAMES[id];
      return `<button class="game-option" role="tab" data-game="${id}">${g.name}<span class="game-option-tag">${
        g.exact ? 'exact sens' : 'estimated sens'
      }</span></button>`;
    }).join('');
  $('gamePicker').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-game]');
    if (btn) setGame(btn.dataset.game);
  });
}

// ---------- Valorant / CS2 sidebar fields ----------
// These games have one sens and a resolution, so their fields are built from
// the game's definition rather than written out per game in the HTML.

let builtSimpleGame = null;

function buildSimpleGameFields(game) {
  builtSimpleGame = game.id;
  $('simpleSensFields').innerHTML = `
    <div class="field-row">
      <div class="field-label">Sensitivity<small>${game.sensLabel}</small></div>
      <div class="stepper stepper-wide" data-simple-field="sens">
        <input type="number" step="any" min="${game.rules.min}" max="${game.rules.max}" inputmode="decimal" id="simpleSensInput" />
        <div class="stepper-arrows"><button type="button" data-dir="1">▲</button><button type="button" data-dir="-1">▼</button></div>
      </div>
    </div>`;

  const resOptions = game.resolutions
    .map((r) => {
      const { w, h } = parseResolution(r.value);
      return `<option value="${r.value}">${w} × ${h} (${r.aspect})</option>`;
    })
    .join('');
  $('simpleViewFields').innerHTML = `
    <div class="field-row">
      <div class="field-label">Field of view<small>${game.fovNote}</small></div>
      <div class="field-static" id="simpleFovText">—</div>
    </div>
    <div class="field-row">
      <div class="field-label">Resolution</div>
      <div class="select-wrap"><select id="simpleResolution">${resOptions}</select></div>
    </div>
    <div class="fill-hint">If the resolution doesn't match your monitor</div>
    <div class="field-row" style="padding-top:6px;border-bottom:none">
      <div class="select-wrap" style="width:100%">
        <select id="simpleDisplayMode" style="width:100%">
          <option value="stretch">Stretched (fills the screen)</option>
          <option value="black-bars">Black bars</option>
        </select>
      </div>
    </div>
    <p class="sidebar-note">Sens here is <b>exact</b>: the drill turns ${game.yaw}° per mouse count at sens 1, the
      same as ${game.short}, so the same mouse movement turns you the same distance.</p>`;
}

function bindSimpleGameFields() {
  const commitSens = (v) => {
    const game = currentGame();
    if (!isFinite(v) || v <= 0) return renderAll(); // put the saved value back
    updateGameSettings(game.id, { sens: quantizeSens(game, v) });
  };
  $('simpleSensFields').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-dir]');
    if (!btn) return;
    const game = currentGame();
    const cur = Number($('simpleSensInput').value) || game.defaults.sens;
    commitSens(cur + Number(btn.dataset.dir) * game.arrowStep);
  });
  $('simpleSensFields').addEventListener('change', (e) => {
    if (e.target.id === 'simpleSensInput') commitSens(Number(e.target.value));
  });
  $('simpleViewFields').addEventListener('change', (e) => {
    const id = currentGame().id;
    if (e.target.id === 'simpleResolution') updateGameSettings(id, { resolution: e.target.value });
    if (e.target.id === 'simpleDisplayMode') updateGameSettings(id, { displayMode: e.target.value });
  });
}

function renderSimpleGameFields(game, s) {
  if (game.id === 'r6') return;
  if (builtSimpleGame !== game.id) buildSimpleGameFields(game);
  const input = $('simpleSensInput');
  if (document.activeElement !== input) input.value = formatGameSens(game, s.sens);
  $('simpleResolution').value = s.resolution;
  $('simpleDisplayMode').value = s.displayMode;
  const view = game.view(s);
  const hFov = hFovFromV(view.vFovDeg, view.aspect);
  $('simpleFovText').textContent = `${Number(hFov.toFixed(1))}° wide`;
}

/** Shows the selected game's parts of the page and hides the others. */
function renderGameChrome(state) {
  const game = getGame(state.game);
  $('gamePicker')
    .querySelectorAll('[data-game]')
    .forEach((b) => {
      const on = b.dataset.game === game.id;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
  document.querySelectorAll('[data-game-only]').forEach((el) => {
    el.hidden = !el.dataset.gameOnly.split(' ').includes(game.id);
  });
  $('sidebarTitle').textContent = `Your ${game.short} settings`;
  $('calibrationHint').textContent = `27 × 7-second blocks + warm-up · about 4 minutes${
    game.tabs.length > 1 ? ' per optic' : ''
  } · runs fullscreen`;
  renderSimpleGameFields(game, state.settings);
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

// The Siege fields below always read and write Siege's own settings
// (updateGameSettings('r6', ...)), not "whichever game is selected" - so
// they can never end up writing Siege values into another game.
const updateR6 = (patch) => updateGameSettings('r6', patch);

function applyFieldChange(field, value) {
  if (field === 'dpi') {
    updateSettings({ dpi: value }); // shared by every game
  } else if (field === 'hipfireH' || field === 'hipfireV') {
    const s = getGameSettings('r6');
    const oldAvg = (s.hipfireH + s.hipfireV) / 2;
    const patch = { [field]: value };
    const newAvg = field === 'hipfireH' ? (value + s.hipfireV) / 2 : (s.hipfireH + value) / 2;
    if (s.keepAdsSpeed) {
      patch.ads25x = compensateAdsForHipfireChange(oldAvg, newAvg, s.ads25x);
    }
    updateR6(patch);
  } else {
    updateR6({ [field]: value });
  }
}

function bindSettingsFields() {
  bindStepper('hipfireH', { step: 1, min: 1, max: 50 });
  bindStepper('hipfireV', { step: 1, min: 1, max: 50 });
  bindStepper('ads25x', { step: 1, min: 1, max: 100 });
  bindStepper('dpi', { step: 50, min: 100, max: 26000 });
  bindStepper('fov', { step: 1, min: 60, max: 110 });

  $('keepAdsSpeed').addEventListener('change', (e) => updateR6({ keepAdsSpeed: e.target.checked }));

  $('useCustomMultiplier').addEventListener('change', (e) => {
    updateR6({ useCustomMultiplier: e.target.checked });
    $('customMultiplier').disabled = !e.target.checked;
  });

  $('customMultiplier').addEventListener('change', (e) => {
    updateR6({ customMultiplier: Number(e.target.value) || 0.02 });
  });

  $('aspectRatio').addEventListener('change', (e) => updateR6({ aspectRatio: e.target.value }));
  $('screenFill').addEventListener('change', (e) => updateR6({ screenFill: e.target.value }));

  bindAds1xMeasured();
}

/** Writes a measured cm/360 for one Siege optic into the calibration
 * snapshot (or clears it). Everything else derives from there. */
function setCalibration(tab, cm360) {
  const s = getGameSettings('r6');
  const calib = { ...s.calib, [tab]: cm360 == null ? null : calibrationFrom(tab, cm360, s) };
  updateR6({ calib });
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
    const s = getGameSettings('r6');
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
  // Delegated: the tab buttons are rebuilt whenever the game changes.
  $('mainTabs').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-tab]');
    if (btn) setActiveTab(btn.dataset.tab);
  });
}

// ---------- Rendering ----------

const CONFIDENCE_BADGE = { clear: 'ok', close: 'close', tie: 'retest' };

const fmtRate = (v) => (v == null || !isFinite(v) ? '—' : `${v.toFixed(2)}/s`);
const fmtPct = (v) => (v == null || !isFinite(v) ? '—' : `${Math.round(v * 100)}%`);

function poolNote(result) {
  return result.pooledPasses > 1
    ? ` · ${result.best.roundsPerDrill} rounds per drill, pooled over ${result.pooledPasses} passes`
    : '';
}

function fineTuneHint(result, game) {
  const finest = result.atFinestStep ?? result.candidates?.[0]?.finest ?? result.delta <= game.rules.step;
  if (finest) {
    const step =
      game.rules.decimals === 0
        ? `±1, the finest step ${game.short}'s slider has`
        : `±${Math.round(game.rules.minSpreadPct * 100)}%, about the smallest change you can feel`;
    return (
      `You're down to ${step}. Fine-tuning again re-tests these same values and pools ` +
      `the rounds, so the answer gets more reliable each pass.`
    );
  }
  const next = buildCandidates(result.best.sens, result.spreadPct * 0.5, game.rules)[0].delta;
  return `${CONFIDENCE_TEXT[result.confidence].hint} Next pass tests ±${formatGameSens(game, next)} around ${formatGameSens(
    game,
    result.best.sens
  )}.`;
}

/** Table rows shared by the results screen and the comparison card. Matches
 * the winner by sens rather than object identity, since results reloaded
 * from localStorage are fresh copies. */
function comparisonRowsHtml(result, game) {
  const tag = result.centeredOn === 'previous-best' ? 'last best' : 'current';
  return result.candidates
    .map((c) => {
      const cls = [c.isBase ? 'base' : '', c.sens === result.best.sens ? 'best' : ''].filter(Boolean).join(' ');
      return `<tr class="${cls}">
        <td>${formatGameSens(game, c.sens)}${c.isBase ? ` · ${tag}` : ''}</td>
        <td>${fmtRate(c.flickHitsPerSec)}</td>
        <td>${fmtRate(c.clearedPerSec)}</td>
        <td>${fmtPct(c.onTargetPct)}</td>
        <td>${c.score}</td>
      </tr>`;
    })
    .join('');
}

const SCORING_FOOTNOTE =
  'Flick: hits per second. Targets: dots cleared per second. Tracking: time on the dot. ' +
  'A hit anywhere on a target counts, inside or outside the ring. Each drill is a third of the score, relative to the best in that drill.';

function renderAll() {
  const state = getState();
  renderGameChrome(state);
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
  return buildGameList(r6YawMap(getGameSettings('r6')));
}

/** The converter's own fields default to whatever the user already has set
 * up above, so the card is showing something meaningful before it's touched.
 * Siege's entries always read Siege's settings, and Valorant/CS2 read the
 * sens saved for them here, whichever game is selected. */
function convertValues(state) {
  const s = state.settings;
  const r6 = getGameSettings('r6');
  const c = s.convert || {};
  const from = c.from || 'r6_hipfire';
  const fallbackSens =
    from === 'r6_hipfire'
      ? r6.hipfireH
      : from === 'r6_ads1x' || from === 'r6_ads25x'
        ? r6.ads25x
        : GAMES[from]
          ? getGameSettings(from).sens
          : 1;
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

/** The Siege sidebar always shows Siege's settings (it's hidden while
 * another game is selected, but stays correct underneath). */
function renderSettingsInputs(state) {
  const s = getGameSettings('r6');
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

let builtTabsFor = null;

function renderTabsUI(state) {
  const game = getGame(state.game);
  if (builtTabsFor !== game.id) {
    builtTabsFor = game.id;
    $('mainTabs').innerHTML = game.tabs
      .map((t) => `<button class="tab" data-tab="${t.id}">${t.label}</button>`)
      .join('');
    $('drillTabs').innerHTML = game.tabs.map((t) => `<span class="tab" data-tab="${t.id}">${t.label}</span>`).join('');
  }
  $('mainTabs').querySelectorAll('.tab').forEach((el) => {
    el.classList.toggle('active', el.dataset.tab === state.activeTab);
  });
  $('comparisonTag').textContent = scopeLabel(game, state.activeTab);
  $('modelNote').style.display = game.id === 'r6' && state.activeTab === 'ads1x' ? '' : 'none';

  // "Start calibration" is always a fresh ±15% pass - the narrower passes are
  // what "Fine-tune further" does - so this doesn't depend on past results.
  $('refineSub').textContent =
    `We test your current setting and about ${Math.round(INITIAL_SPREAD_PCT * 100)}% either side, ` +
    `then "Fine-tune further" narrows it down.`;
}

function renderStats(state) {
  const game = getGame(state.game);
  const tab = state.activeTab;
  const s = state.settings;
  const sens = game.baseSens(tab, s);
  $('statActiveSens').textContent =
    game.id === 'r6' ? (tab === 'hipfire' ? Math.round(sens * 10) / 10 : sens) : formatGameSens(game, sens);
  $('statCm360').textContent = formatCm360(game.cm360(tab, s));
  // Make it obvious whether this number is exact, anchored to a real
  // measurement, or still just the model's guess.
  if (game.exact) {
    $('cm360Label').textContent = 'cm/360°';
    $('cm360Label').title = `Exact: ${game.short}'s own formula at your sens and DPI.`;
  } else {
    const calibrated = isCalibrated(tab, s);
    $('cm360Label').textContent = calibrated ? 'Measured cm/360°' : 'Estimated cm/360°';
    $('cm360Label').title = calibrated
      ? 'Derived from the cm/360 you measured in-game for this optic.'
      : 'Model estimate - measure your real cm/360 under "Calibrate to your real sens" to make this exact.';
  }

  const result = state.results[tab];
  if (result) {
    $('statAccuracy').textContent = result.best.accuracy != null ? `${Math.round(result.best.accuracy * 100)}%` : '—';
    $('statTargets').textContent = fmtPct(result.best.innerHitPct);
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

  const game = getGame(state.game);
  const fmt = (v) => formatGameSens(game, v);
  const current = currentSens(game, tab, state.settings);
  const same = result.best.sens === current;
  const delta = result.best.sens - current;
  const deltaText = same
    ? 'Matches your current setting.'
    : `${delta > 0 ? '+' : '−'}${fmt(Math.abs(delta))} from your current ${fmt(current)}.`;
  const refinedText = result.passCount > 1 ? ` · fine-tuned ×${result.passCount - 1}` : '';

  body.innerHTML = `
    <div class="rec-value">${fmt(result.best.sens)}</div>
    <p class="rec-sub">${deltaText} Scored ${result.best.score}/100${refinedText}.</p>
    <p class="rec-sub rec-hint">${fineTuneHint(result, game)}</p>
    <div class="rec-actions">
      <button id="applyRecBtn" class="btn-accent"${same ? ' disabled' : ''}>Apply to ${scopeLabel(game, tab)}</button>
      <button id="fineTuneCardBtn" class="plain-btn">Fine-tune further</button>
    </div>
  `;
}

function renderComparison(state) {
  const game = getGame(state.game);
  const fmtList = (cands) => cands.map((c) => formatGameSens(game, c.sens)).join(' / ');
  const tab = state.activeTab;
  const result = state.results[tab];
  const tbody = $('comparisonBody');
  const footnote = $('comparisonFootnote');

  if (!result) {
    // Preview which sensitivities a fresh run would test, before any data exists.
    const preview = buildCandidates(currentSens(game, tab, state.settings), INITIAL_SPREAD_PCT, game.rules);
    tbody.innerHTML = preview
      .map(
        (c) => `<tr class="${c.isBase ? 'base' : ''}">
          <td>${formatGameSens(game, c.sens)}${c.isBase ? ' · current' : ''}</td>
          <td>—</td><td>—</td><td>—</td><td>—</td>
        </tr>`
      )
      .join('');
    footnote.textContent = `Pass 1 will test ${fmtList(preview)}. ${SCORING_FOOTNOTE}`;
    return;
  }

  tbody.innerHTML = comparisonRowsHtml(result, game);
  footnote.textContent = `Pass ${result.passCount} tested ${fmtList(result.candidates)}${poolNote(result)}. ${SCORING_FOOTNOTE}`;
}

main();
