import { ensureSession } from './session.js';
import { getState, subscribe, updateSettings, setActiveTab, setResult, basisFor, isStale } from './state.js';
import { baseSensForTab, estimateCm360, formatCm360, compensateAdsForHipfireChange } from './sensMath.js';
import { applyAccent, initThemePicker, initModeToggle } from './theme.js';
import { DrillEngine } from './drills.js';
import { buildCandidates, buildQueue, scoreResults, narrowedSpread, INITIAL_SPREAD_PCT } from './calibration.js';

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
  });

  let run = null; // { candidates, spreadPct, passCount, centeredOn, tab, isPractice }

  function setDrillTabsHighlight(tab) {
    $('drillTabs').querySelectorAll('.tab').forEach((el) => {
      el.classList.toggle('active', el.dataset.tab === tab);
    });
  }

  function startCalibration({ recalibrate = false } = {}) {
    if (run) return;
    const tab = getState().activeTab;
    const settings = getState().settings;
    const prev = getState().results[tab];

    let baseSens, spreadPct, passCount, centeredOn;
    if (recalibrate && prev) {
      baseSens = prev.best.sens;
      spreadPct = narrowedSpread(prev.spreadPct);
      passCount = (prev.passCount || 1) + 1;
      centeredOn = 'previous-best';
    } else {
      baseSens = baseSensForTab(tab, settings);
      spreadPct = INITIAL_SPREAD_PCT;
      passCount = 1;
      centeredOn = 'base';
    }

    const candidates = buildCandidates(baseSens, spreadPct);
    run = {
      candidates,
      spreadPct,
      delta: candidates[0].delta,
      centeredValue: baseSens,
      passCount,
      centeredOn,
      tab,
      isPractice: false,
    };

    setDrillTabsHighlight(tab);
    $('drillStatus').textContent = recalibrate ? 'Fine-tuning…' : 'Calibrating…';
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
    } else {
      const scored = scoreResults(run.candidates, results);
      setResult(
        run.tab,
        {
          ...scored,
          spreadPct: run.spreadPct,
          delta: run.delta,
          centeredValue: run.centeredValue,
          passCount: run.passCount,
          centeredOn: run.centeredOn,
        },
        basisFor(run.tab)
      );
      $('resultsTitle').textContent = 'Calibration complete';
      $('resultsSub').textContent = `Recommended sensitivity: ${scored.best.sens} (score ${scored.best.score}/100).`;
    }
    $('resultsOverlay').classList.add('active');
    run = null;
  }

  $('closeResultsBtn').addEventListener('click', () => {
    engine.exit();
    $('resultsOverlay').classList.remove('active');
    renderAll();
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
    if (e.target.id === 'recalibrateBtn') startCalibration({ recalibrate: true });
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

/** ADS·1x is nullable (empty = "use the estimate") and steps by 0.5, unlike
 * the other sidebar fields, so it gets its own binding instead of bindStepper. */
function bindAds1xMeasured() {
  const wrap = document.querySelector('.stepper[data-field="ads1xMeasured"]');
  const input = wrap.querySelector('input');
  const up = wrap.querySelector('[data-dir="1"]');
  const down = wrap.querySelector('[data-dir="-1"]');
  const step = 0.5;

  function commit(v) {
    if (v == null) {
      updateSettings({ measuredCm360_1x: null });
      return;
    }
    updateSettings({ measuredCm360_1x: Math.max(1, Math.round(v * 10) / 10) });
  }

  function currentOrEstimate() {
    const raw = input.value.trim();
    if (raw) return Number(raw);
    return estimateCm360('ads1x', { ...getState().settings, measuredCm360_1x: null });
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
    updateSettings({ measuredCm360_hipfire: v ? Number(v) : null });
  });
  $('measuredAds25xInput').addEventListener('change', (e) => {
    const v = e.target.value.trim();
    updateSettings({ measuredCm360_ads25x: v ? Number(v) : null });
  });
}

function bindTabs() {
  $('mainTabs').querySelectorAll('.tab').forEach((btn) => {
    btn.addEventListener('click', () => setActiveTab(btn.dataset.tab));
  });
}

// ---------- Rendering ----------

function renderAll() {
  const state = getState();
  renderSettingsInputs(state);
  renderTabsUI(state);
  renderStats(state);
  renderRecommendation(state);
  renderComparison(state);
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
  ads1xInput.value = s.measuredCm360_1x ?? '';
  const estimate = estimateCm360('ads1x', { ...s, measuredCm360_1x: null });
  ads1xInput.placeholder = `Est. ${formatCm360(estimate)}`;

  $('measuredHipfireInput').value = s.measuredCm360_hipfire ?? '';
  $('measuredAds25xInput').value = s.measuredCm360_ads25x ?? '';
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

  const result = state.results[tab];
  if (result) {
    $('statAccuracy').textContent = result.best.accuracy != null ? `${Math.round(result.best.accuracy * 100)}%` : '—';
    $('statTargets').textContent = result.best.totalHits ?? '—';
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

  badge.style.display = 'none';
  const baseSens = baseSensForTab(tab, state.settings);
  const delta = result.best.sens - Math.round(baseSens);
  const deltaText = result.best.isBase
    ? 'Matches your current setting.'
    : `${delta > 0 ? '+' : ''}${delta} from your current ${Math.round(baseSens)}.`;
  const refinedText = result.passCount > 1 ? ` · refined ×${result.passCount - 1}` : '';

  body.innerHTML = `
    <div class="rec-value">${result.best.sens}</div>
    <p class="rec-sub">${deltaText} Scored ${result.best.score}/100${refinedText}.</p>
    <div class="rec-actions">
      <button id="applyRecBtn" class="btn-accent">Apply to ${TAB_LABELS[tab]}</button>
      <button id="recalibrateBtn" class="plain-btn">Recalibrate</button>
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
          <td>${c.sens}${c.isBase ? ' · base' : ''}</td>
          <td>—</td><td>—</td><td>—</td><td>—</td>
        </tr>`
      )
      .join('');
    footnote.textContent = `Pass 1 will test ±${preview[0].delta} around ${baseSens}. Score: flicking, targets, tracking weighted equally at 33% each, relative to the best in each drill.`;
    return;
  }

  tbody.innerHTML = result.candidates
    .map((c) => {
      const cls = [c.isBase ? 'base' : '', c === result.best ? 'best' : ''].filter(Boolean).join(' ');
      return `<tr class="${cls}">
        <td>${c.sens}${c.isBase ? ' · base' : ''}</td>
        <td>${c.flickHitsPerSec.toFixed(2)}</td>
        <td>${c.clearedPerSec.toFixed(2)}</td>
        <td>${Math.round(c.onTargetPct * 100)}%</td>
        <td>${c.score}</td>
      </tr>`;
    })
    .join('');

  footnote.textContent = `Pass ${result.passCount} tested ±${result.delta} around ${result.centeredValue}. Score: flicking, targets, tracking weighted equally at 33% each, relative to the best in each drill.`;
}

main();
