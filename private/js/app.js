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
  neutralCalibrationFrom,
  neutralAdsValue,
  isCalibrated,
  hipDegPerSensPoint,
} from './sensMath.js';
import { applyAccent, initThemePicker, initModeToggle } from './theme.js';
import { DrillEngine, previewHitSound } from './drills.js';
import { RangeEngine } from './range.js';
import { CROSSHAIRS, CROSSHAIR_COLORS, DEFAULT_CROSSHAIR_COLOR, drawCrosshair, getCrosshair } from './crosshairs.js';
import {
  buildCandidates,
  buildQueue,
  scoreResults,
  planFineTune,
  capPooledResults,
  analyseAim,
  AIM_VERDICTS,
  CONFIDENCE_TEXT,
  INITIAL_SPREAD_PCT,
  TOTAL_SCORED_FLICKS,
  PASS_SECONDS,
  verdictFor,
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

/** A result's winning sens, rounded to what the game accepts now - results
 * saved before a game's step changed (CS2 used to be 3 decimals) can hold a
 * value like 0.742 that the game can't take. */
function bestSens(game, result) {
  return quantizeSens(game, result.best.sens);
}

/** Calibrating and the converter swap places in the right-hand column
 * rather than sitting one below the other, so neither needs scrolling to.
 * Which one is showing is a this-visit thing, so it isn't saved. */
function bindViewSwitch() {
  const switcher = $('viewSwitch');
  switcher.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-view]');
    if (!btn) return;
    switcher.querySelectorAll('[data-view]').forEach((b) => {
      const on = b === btn;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    $('viewCalibrate').hidden = btn.dataset.view !== 'calibrate';
    $('viewConvert').hidden = btn.dataset.view !== 'convert';
    $('viewRange').hidden = btn.dataset.view !== 'range';
    if (btn.dataset.view === 'range') renderRangePanel();
  });
}

// ---------- The Range ----------
// Its settings and head-test history are this browser's own, kept apart
// from the calibration state: { dummies, distance, history: [...] }.

const RANGE_KEY = 'r6sf_range_v1';
function loadRange() {
  try {
    return JSON.parse(localStorage.getItem(RANGE_KEY)) || {};
  } catch {
    return {};
  }
}
function saveRange(data) {
  try {
    localStorage.setItem(RANGE_KEY, JSON.stringify(data));
  } catch {
    /* private window etc. - it just won't be remembered */
  }
}

/** The range always uses a game's main sens: hip-fire for Siege. */
const rangeTab = (game) => game.tabs[0].id;
let rangeSensFor = null; // the game the sens box was filled in for
let rangeSensEdited = false; // typed in by hand, so leave it alone

/** The session's settings: yours, with the range's sens swapped in. */
function rangeSettings(game) {
  const state = getState();
  const tab = rangeTab(game);
  let sens = Number($('rangeSens').value);
  if (!(sens > 0)) sens = currentSens(game, tab, state.settings);
  sens = quantizeSens(game, sens);
  return { tab, sens, settings: game.withCandidate(state.settings, tab, sens) };
}

function renderRangePanel() {
  if ($('viewRange').hidden) return;
  const state = getState();
  const game = getGame(state.game);
  const input = $('rangeSens');
  if (rangeSensFor !== game.id) {
    rangeSensFor = game.id;
    rangeSensEdited = false;
  }
  if (!rangeSensEdited && document.activeElement !== input) {
    input.value = formatGameSens(game, currentSens(game, rangeTab(game), state.settings));
  }
  const { tab, settings } = rangeSettings(game);
  $('rangeCm').textContent = formatCm360(game.cm360(tab, settings));
  const data = loadRange();
  $('rangeDummies').value = data.dummies || 'standing';
  $('rangeDistance').value = data.distance || 'mid';
  renderRangeAds(game, data);
  renderRangeHistory(game);
}

// ---------- The Range: aiming down sights ----------
// Which sight you aim with is the range's own choice (saved per game);
// the ADS value is your real in-game setting, so it's saved with your
// settings - for Siege it's the same number as the 1× / 2.5× tabs.

/** The chosen sight for this game, or null for a game without ADS. */
function rangeSight(game, data = loadRange()) {
  const sights = (game.ads && game.ads.sights) || [];
  return sights.find((s) => s.id === (data.sights || {})[game.id]) || sights[0] || null;
}

const fmtAds = (sight, v) => (v == null || !isFinite(v) ? '' : String(Number(Number(v).toFixed(sight.rules.decimals))));

function quantizeAds(sight, v) {
  const { step, decimals, min, max } = sight.rules;
  return Math.max(min, Math.min(max, Number((Math.round(v / step) * step).toFixed(decimals))));
}

/** cm/360 while aimed with this sight, with an ADS value swapped in (the
 * box being typed in) or the saved one. */
function rangeAdsCm(game, sight, settings, adsValue) {
  const s = adsValue > 0 ? { ...settings, [sight.key]: adsValue } : settings;
  const d = game.ads.degPerCount(s, sight.id).x;
  return d > 0 && s.dpi > 0 ? (2.54 * 360) / (d * s.dpi) : NaN;
}

const ADS_NOTES = {
  r6: 'Right-click aims with your ADS value for that sight - the same numbers as the 1× and 2.5× tabs.',
  valorant: 'Right-click aims: the Vandal and Phantom zoom 1.25× and use your ADS multiplier, the Operator 2.5× and your scoped multiplier.',
  cs2: "CS2's AK and M4 don't aim down sights, so right-click scopes in like the AUG / SG 553 or the AWP, with your Zoom sensitivity (zoom_sensitivity_ratio).",
  apex: 'Right-click aims down a 2× HCOG with your ADS sensitivity multiplier.',
  cod: 'Right-click aims down a reflex sight with your ADS sensitivity multiplier (Relative, coefficient 1.33 - the defaults).',
  overwatch: "Right-click scopes in like Widowmaker or Ana, with your Relative aim sensitivity while zoomed.",
};

function renderRangeAds(game, data) {
  const sight = rangeSight(game, data);
  document.querySelectorAll('[data-ads-field]').forEach((el) => (el.hidden = !sight));
  $('rangeAdsNote').textContent = sight
    ? ADS_NOTES[game.id] || ''
    : `Most ${game.name} heroes don't aim down sights, so right-click does nothing in the range.`;
  if (!sight) return;
  const select = $('rangeSight');
  if (select.dataset.game !== game.id) {
    select.dataset.game = game.id;
    select.innerHTML = game.ads.sights.map((s) => `<option value="${s.id}">${s.label}</option>`).join('');
  }
  select.value = sight.id;
  $('rangeAdsLabel').textContent = sight.setting;
  const input = $('rangeAdsSens');
  const { settings } = rangeSettings(game);
  if (document.activeElement !== input) input.value = fmtAds(sight, settings[sight.key]);
  $('rangeAdsCm').textContent = formatCm360(rangeAdsCm(game, sight, settings, Number(input.value)));
  $('rangeAdsMode').value = data.adsMode === 'toggle' ? 'toggle' : 'hold';
}

const LANDS = {
  over: 'Past',
  'slightly-over': 'Slightly past',
  balanced: 'On target',
  'slightly-under': 'Slightly short',
  under: 'Short',
};

function renderRangeHistory(game) {
  const rows = (loadRange().history || []).filter((h) => h.game === game.id);
  const distance = { close: 'close', mid: 'mid', far: 'far', mixed: 'mixed' };
  $('rangeHistoryBody').innerHTML = rows.length
    ? rows
        .map(
          (h) => `<tr>
            <td>${formatGameSens(game, h.sens)} <span class="comparison-tag">${formatCm360(h.cm360)} cm</span></td>
            <td>${h.dummies === 'strafing' ? 'Strafing' : 'Standing'} · ${distance[h.distance] || h.distance}${
              h.adsShare >= 0.5 ? ' · aimed' : ''
            }</td>
            <td>${fmtMs(h.timeMs)}</td>
            <td>${fmtPct(h.firstShotRate)}</td>
            <td>${fmtPct(h.landRate)}</td>
            <td>${h.bias == null ? '—' : LANDS[verdictFor(h.bias)]}</td>
          </tr>`
        )
        .join('')
    : '<tr><td colspan="6" class="card-empty">No head tests yet.</td></tr>';
}

function bindRange() {
  const engine = new RangeEngine({
    overlayEl: $('rangeOverlay'),
    stageEl: $('rangeStage'),
    canvasEl: $('rangeCanvas'),
    el: {
      pause: $('rangePause'),
      pauseReason: $('rangePauseReason'),
      results: $('rangeResults'),
      resultsSub: $('rangeResultsSub'),
      resultsGrid: $('rangeResultsGrid'),
      aim: $('rangeAimRead'),
      aimTitle: $('rangeAimTitle'),
      aimTag: $('rangeAimTag'),
      aimText: $('rangeAimText'),
      aimDot: $('rangeAimDot'),
      getReady: $('rangeGetReady'),
      getReadyLabel: $('rangeGetReadyLabel'),
      getReadyNum: $('rangeGetReadyNum'),
      hitmarker: $('rangeHitmarker'),
      hudMain: $('rangeHudMain'),
      hudSub: $('rangeHudSub'),
      ammo: $('rangeAmmo'),
    },
    onFinish: (summary) => {
      const data = loadRange();
      data.history = [summary, ...(data.history || [])].slice(0, 30);
      saveRange(data);
      renderRangePanel();
    },
  });

  const start = (mode) => {
    const game = currentGame();
    const { tab, sens, settings } = rangeSettings(game);
    const data = loadRange();
    data.dummies = $('rangeDummies').value;
    data.distance = $('rangeDistance').value;
    saveRange(data);
    const sight = rangeSight(game, data);
    engine.start({
      game,
      tab,
      settings,
      sens,
      sensLabel: `${game.short} ${formatGameSens(game, sens)}`,
      mode,
      dummies: data.dummies,
      distance: data.distance,
      sight: sight ? sight.id : null,
      adsMode: data.adsMode === 'toggle' ? 'toggle' : 'hold',
    });
  };

  $('rangeSens').addEventListener('input', () => {
    rangeSensEdited = true;
    const game = currentGame();
    const { tab, settings } = rangeSettings(game);
    $('rangeCm').textContent = formatCm360(game.cm360(tab, settings));
    const sight = rangeSight(game);
    if (sight) $('rangeAdsCm').textContent = formatCm360(rangeAdsCm(game, sight, settings, Number($('rangeAdsSens').value)));
  });
  $('rangeSight').addEventListener('change', () => {
    const data = loadRange();
    data.sights = { ...(data.sights || {}), [currentGame().id]: $('rangeSight').value };
    saveRange(data);
    renderRangePanel();
  });
  $('rangeAdsMode').addEventListener('change', () => {
    const data = loadRange();
    data.adsMode = $('rangeAdsMode').value;
    saveRange(data);
  });
  $('rangeAdsSens').addEventListener('input', () => {
    const game = currentGame();
    const sight = rangeSight(game);
    if (!sight) return;
    const { settings } = rangeSettings(game);
    $('rangeAdsCm').textContent = formatCm360(rangeAdsCm(game, sight, settings, Number($('rangeAdsSens').value)));
  });
  $('rangeAdsSens').addEventListener('change', () => {
    const game = currentGame();
    const sight = rangeSight(game);
    const v = Number($('rangeAdsSens').value);
    if (!sight) return;
    if (!(v > 0)) return renderRangePanel(); // put the saved value back
    updateSettings({ [sight.key]: quantizeAds(sight, v) });
  });
  for (const id of ['rangeDummies', 'rangeDistance']) {
    $(id).addEventListener('change', () => {
      const data = loadRange();
      data.dummies = $('rangeDummies').value;
      data.distance = $('rangeDistance').value;
      saveRange(data);
    });
  }
  $('rangeTestBtn').addEventListener('click', () => start('test'));
  $('rangeFreeBtn').addEventListener('click', () => start('free'));
  $('rangeResumeBtn').addEventListener('click', () => engine.resume());
  $('rangeLeaveBtn').addEventListener('click', () => {
    engine.exit();
    renderRangePanel();
  });
  $('rangeAgainBtn').addEventListener('click', () => start('test'));
  $('rangeDoneBtn').addEventListener('click', () => {
    engine.exit();
    renderRangePanel();
  });
  $('rangeClearBtn').addEventListener('click', () => {
    const data = loadRange();
    const game = currentGame();
    data.history = (data.history || []).filter((h) => h.game !== game.id);
    saveRange(data);
    renderRangePanel();
  });
}

/**
 * The aim read-out on the results card: where your shots landed relative
 * to the target, over the whole run. The marker sits left of centre when
 * flicks stop short and right when they go past; dead centre means they
 * land where they're aimed.
 */
function renderAimRead(aim) {
  const box = $('aimRead');
  box.querySelectorAll('.aim-bar-dot.extra').forEach((el) => el.remove());
  $('aimBarDot').hidden = false;
  if (!aim) {
    box.hidden = true;
    return;
  }
  const verdict = AIM_VERDICTS[aim.verdict];
  box.hidden = false;
  $('aimReadTitle').textContent = verdict.title;
  $('aimReadTag').textContent = `${aim.shots} shots read`;
  $('aimReadText').textContent = verdict.text;
  // One target width either way fills the bar; anything past that pins.
  const pos = Math.max(-1, Math.min(1, aim.mean));
  $('aimBarDot').style.left = `${50 + pos * 50}%`;
  box.dataset.verdict = aim.verdict;
}

/**
 * The flick check's read-out: where your first movement landed at each
 * sensitivity tested, on one bar from "short of the head" to "past it" -
 * one marker per sensitivity, the current one in the accent colour. The
 * verdict is for your current setting; the text says where it balances.
 */
function renderBalanceRead(result, game) {
  const box = $('aimRead');
  box.querySelectorAll('.aim-bar-dot.extra').forEach((el) => el.remove());
  const rows = (result.candidates || []).filter((c) => c.n > 0 && isFinite(c.bias));
  if (!rows.length) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  $('aimBarDot').hidden = true;
  const fmt = (v) => formatGameSens(game, v);
  const current = rows.find((c) => c.isBase) || rows[Math.floor(rows.length / 2)];
  const verdict = AIM_VERDICTS[verdictFor(current.bias)];
  $('aimReadTitle').textContent = `At ${fmt(current.sens)}: ${verdict.title.charAt(0).toLowerCase()}${verdict.title.slice(1)}`;
  $('aimReadTag').textContent = `${result.totalFlicks} flicks read`;
  const balance = result.balance && !result.balance.clamped ? ` Your flicks balance out at ${fmt(result.best.sens)}.` : '';
  $('aimReadText').textContent = verdict.text + balance;
  const bar = box.querySelector('.aim-bar');
  for (const c of rows) {
    const dot = document.createElement('span');
    dot.className = `aim-bar-dot extra${c === current ? '' : ' other'}`;
    // A full head-width (two radii) either way fills the bar.
    dot.style.left = `${50 + (Math.max(-2, Math.min(2, c.bias)) / 2) * 50}%`;
    dot.dataset.label = fmt(c.sens);
    bar.appendChild(dot);
  }
}

/** An admin key is an ordinary key that can also hand out keys, so it gets
 * the whole tool plus a way through to the panel. The link is built here if
 * the page doesn't already have it, so a page still cached from an older
 * version can't leave an admin with no way back. */
function showAdminLink() {
  let link = $('adminLink');
  if (!link) {
    link = document.createElement('a');
    link.id = 'adminLink';
    link.className = 'topbar-link';
    link.href = '/admin.html';
    link.textContent = 'Manage keys ↗';
    document.querySelector('.topbar')?.insertBefore(link, document.querySelector('.topbar .mode-toggle'));
  }
  link.hidden = false;
}

async function main() {
  const session = await ensureSession();
  if (!session) return;

  document.getElementById('pageRoot').style.display = '';
  if (session.isAdmin) showAdminLink();
  applyAccent(getState().settings.accentColor);
  initModeToggle();

  bindGamePicker();
  bindViewSwitch();
  bindSettingsFields();
  bindSimpleGameFields();
  bindExpanders();
  bindHitVolume();
  bindCrosshair();
  bindRange();
  bindMouseCheck();
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
    const label = { flick: 'Flicking', bounce: 'Bounce', targets: 'Targets', tracking: 'Tracking' }[type];
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
      // Practice still has shots to read, just fewer, so it asks for less.
      renderAimRead(analyseAim(results, 12));
    } else {
      const pooled = capPooledResults([...run.carryOver, ...results]);
      const scored = scoreResults(run.candidates, pooled, currentGame().rules);
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
    renderBalanceRead(result, game);

    // Whichever action makes more sense right now gets the accent colour: a
    // clear winner you're not already on is ready to apply; anything closer,
    // or a winner that's already your setting, points at another pass.
    const current = currentSens(game, tab, getState().settings);
    const alreadySet = bestSens(game, result) === current;
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
  updateSettings(currentGame().applySens(tab, bestSens(currentGame(), result)));
}

// ---------- Game picker ----------

/** A dropdown rather than a row of buttons: there are enough games now that
 * buttons wrapped onto two lines, and the list will only grow. */
function bindGamePicker() {
  $('gamePicker').innerHTML =
    '<span class="game-picker-label">Game</span>' +
    '<div class="select-wrap game-select"><select id="gameSelect" aria-label="Game to calibrate for">' +
    GAME_ORDER.map((id) => `<option value="${id}">${GAMES[id].name}</option>`).join('') +
    '</select></div>' +
    '<span class="game-option-tag" id="gameExactTag"></span>';
  $('gameSelect').addEventListener('change', (e) => setGame(e.target.value));
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
  // Valorant and CS2 have a locked FOV, so theirs is a read-out. Apex and
  // Call of Duty have a slider, so theirs is a field to copy across.
  const fovRow = game.fovSlider
    ? `<div class="field-row">
      <div class="field-label">Field of view<small>${game.fovNote}</small></div>
      <div class="stepper stepper-wide" data-simple-field="fov">
        <input type="number" step="1" min="${game.fovSlider.min}" max="${game.fovSlider.max}" id="simpleFovInput" />
        <div class="stepper-arrows"><button type="button" data-dir="1">▲</button><button type="button" data-dir="-1">▼</button></div>
      </div>
    </div>
    <div class="field-row">
      <div class="field-label">That works out to</div>
      <div class="field-static" id="simpleFovText">—</div>
    </div>`
    : `<div class="field-row">
      <div class="field-label">Field of view<small>${game.fovNote}</small></div>
      <div class="field-static" id="simpleFovText">—</div>
    </div>`;
  $('simpleViewFields').innerHTML = `
    ${fovRow}
    <div class="field-row">
      <div class="field-label">Resolution</div>
      <div class="select-wrap"><select id="simpleResolution">${resOptions}</select></div>
    </div>
    <div class="fill-hint">If the resolution doesn't match your monitor</div>
    <div class="field-row">
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
    if (e.target.id === 'simpleFovInput') commitFov(Number(e.target.value));
  });
  $('simpleViewFields').addEventListener('click', (e) => {
    const btn = e.target.closest('.stepper[data-simple-field="fov"] [data-dir]');
    if (!btn) return;
    const cur = Number($('simpleFovInput').value) || currentGame().defaults.fov;
    commitFov(cur + Number(btn.dataset.dir));
  });
}

function commitFov(v) {
  const game = currentGame();
  if (!game.fovSlider || !isFinite(v)) return renderAll();
  const clamped = Math.max(game.fovSlider.min, Math.min(game.fovSlider.max, Math.round(v)));
  updateGameSettings(game.id, { fov: clamped });
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
  if (game.fovSlider) {
    const fovInput = $('simpleFovInput');
    if (document.activeElement !== fovInput) fovInput.value = s.fov;
    $('simpleFovText').textContent = `${Number(hFov.toFixed(1))}° wide at this resolution`;
  } else {
    $('simpleFovText').textContent = `${Number(hFov.toFixed(1))}° wide`;
  }
}

/** Shows the selected game's parts of the page and hides the others. */
function renderGameChrome(state) {
  const game = getGame(state.game);
  $('gameSelect').value = game.id;
  $('gameExactTag').textContent = game.exact ? 'exact sens' : 'estimated sens';
  document.querySelectorAll('[data-game-only]').forEach((el) => {
    el.hidden = !el.dataset.gameOnly.split(' ').includes(game.id);
  });
  $('sidebarTitle').textContent = `Your ${game.short} settings`;
  $('calibrationHint').textContent = `${TOTAL_SCORED_FLICKS} flicks at 3 sensitivities · about ${Math.round(PASS_SECONDS / 30) / 2} min${
    game.tabs.length > 1 ? ' per optic' : ''
  } · fullscreen`;
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
      patch.ads1x = compensateAdsForHipfireChange(oldAvg, newAvg, s.ads1x);
      patch.ads25x = compensateAdsForHipfireChange(oldAvg, newAvg, s.ads25x);
    }
    updateR6(patch);
  } else {
    updateR6({ [field]: value });
  }
}

function bindSettingsFields() {
  bindStepper('hipfireH', { step: 1, min: 1, max: 100 });
  bindStepper('hipfireV', { step: 1, min: 1, max: 100 });
  bindStepper('ads1x', { step: 1, min: 1, max: 100 });
  bindStepper('ads25x', { step: 1, min: 1, max: 100 });
  bindStepper('dpi', { step: 50, min: 100, max: 26000 });
  bindStepper('fov', { step: 1, min: 60, max: 90 });

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
}

/** Writes a measured cm/360 for one Siege optic into the calibration
 * snapshot (or clears it). Everything else derives from there. */
function setCalibration(tab, cm360) {
  const s = getGameSettings('r6');
  const calib = { ...s.calib, [tab]: cm360 == null ? null : calibrationFrom(tab, cm360, s) };
  updateR6({ calib });
}

// The "measured cm/360°" box for each Siege optic, and the ruler-free
// alternative for the ADS optics ("the value that matches hip-fire").
const MEASURED_INPUTS = { hipfire: 'measuredHipfireInput', ads1x: 'measuredAds1xInput', ads25x: 'measuredAds25xInput' };
const NEUTRAL_INPUTS = { ads1x: 'neutralAds1xInput', ads25x: 'neutralAds25xInput' };

/**
 * Mouse check: counts the movement the browser is given over a distance you
 * measure with a ruler, and works back to the DPI your mouse is really
 * sending. R6 is fed the same counts by the same mouse, so this answers two
 * questions at once - whether the DPI here matches the mouse (the wrong DPI
 * slot makes the game feel nothing like the drill) and whether this browser
 * gets the mouse unaltered (Windows pointer speed and acceleration change
 * it when raw input isn't available, but never change the game).
 */
function bindMouseCheck() {
  const overlay = $('mouseCheckOverlay');
  const card = overlay.querySelector('.modal-card');
  const startBtn = $('mouseCheckStart');
  const useBtn = $('mouseCheckUse');
  const result = $('mouseCheckResult');
  let counts = 0;
  let capturing = false;
  let raw = true;
  let measured = null;

  const close = () => {
    if (document.pointerLockElement === card) document.exitPointerLock();
    overlay.classList.remove('active');
  };

  $('mouseCheckBtn').addEventListener('click', () => {
    result.hidden = true;
    useBtn.hidden = true;
    startBtn.hidden = false;
    $('mouseCheckStep').textContent =
      "Lay a ruler along your mousepad. Put your mouse at one end, press Start, drag it straight along the ruler by the distance below, then click to finish.";
    overlay.classList.add('active');
  });
  $('mouseCheckClose').addEventListener('click', close);

  document.addEventListener('mousemove', (e) => {
    if (capturing && document.pointerLockElement === card) counts += Math.abs(e.movementX);
  });

  startBtn.addEventListener('click', async () => {
    counts = 0;
    raw = true;
    try {
      await card.requestPointerLock({ unadjustedMovement: true });
    } catch (err) {
      if (err && err.name === 'NotSupportedError') {
        raw = false;
        try {
          await card.requestPointerLock();
        } catch {
          result.hidden = false;
          result.innerHTML = '<span class="warn">This browser wouldn\'t capture the mouse. Try Chrome or Edge.</span>';
          return;
        }
      } else {
        return; // lock refused (e.g. pressed Esc a moment ago) - just try again
      }
    }
    capturing = true;
    card.classList.add('capturing');
    startBtn.hidden = true;
    result.hidden = true;
    $('mouseCheckStep').textContent = 'Now drag straight along the ruler, then click.';
  });

  // The click that ends the measurement: the mouse is captured, so this is
  // the natural way to finish without touching the keyboard.
  document.addEventListener('mousedown', () => {
    if (!capturing) return;
    capturing = false;
    card.classList.remove('capturing');
    document.exitPointerLock();
    const cm = Number($('mouseCheckDistance').value) || 20;
    measured = Math.round(counts / (cm / 2.54));
    const set = getState().settings.dpi;
    const ratio = measured / set;
    const off = Math.abs(ratio - 1) > 0.12;
    startBtn.hidden = false;
    startBtn.textContent = 'Measure again';
    $('mouseCheckStep').textContent = `Moved ${cm} cm and the browser counted ${Math.round(counts)} steps.`;
    result.hidden = false;
    useBtn.hidden = !off;
    // What the movement works out to at the DPI set here. A reading that
    // comes in low is usually this: the pad was measured rather than the
    // mouse's own travel, and the mouse body eats several centimetres.
    const impliedCm = Math.round((counts / set) * 2.54 * 10) / 10;
    result.innerHTML =
      `Your mouse is really sending about <b>${measured} DPI</b>. This page is set to ${set}.` +
      (off
        ? `<span class="warn">That's ${ratio > 1 ? 'higher' : 'lower'} than the DPI set here, by about ${Math.round(
            (ratio > 1 ? ratio : 1 / ratio) * 10
          ) / 10}×.${
            raw
              ? ` If your mouse really is on ${set} DPI, then it only travelled ${impliedCm} cm - measure the mouse's own travel rather than the width of the pad and try again. Otherwise it's on a different DPI step: check which step is active in your mouse software, and that R6 was played on the same one.`
              : " This browser isn't getting raw mouse input, so Windows pointer speed and acceleration are changing it. R6 ignores those, which is why the game feels different. Use Chrome or Edge."
          }</span>`
        : ' That matches, so the drill and R6 are getting the same mouse movement.') +
      (raw ? '' : '<span class="warn">Raw mouse input was unavailable in this browser, so this reading includes your Windows mouse settings.</span>');
  });

  useBtn.addEventListener('click', () => {
    if (measured > 0) updateSettings({ dpi: measured });
    close();
  });
}

/** "Hit sound": how loud the pop is when a target is hit, 0 (off) to 100.
 * Letting go of the slider plays the pop once at the new level. */
function hitVolumeText(v) {
  return v > 0 ? `${v}%` : 'Off';
}

function bindHitVolume() {
  const slider = $('hitVolume');
  slider.addEventListener('input', () => {
    const v = Number(slider.value);
    $('hitVolumeValue').textContent = hitVolumeText(v);
    updateSettings({ hitVolume: v });
  });
  slider.addEventListener('change', () => previewHitSound(Number(slider.value)));
}

// ---------- Crosshair ----------
// A dropdown of the crosshairs, each shown as a picture with a plain name,
// drawn in the chosen colour (white until one is picked). The list floats
// over the page so the sidebar's scrolling can't cut it off.

/** A picture box: the arena's grey with the crosshair on it. */
function crosshairPicture() {
  const box = document.createElement('span');
  box.className = 'xh-pic';
  box.appendChild(document.createElement('canvas'));
  return box;
}

function bindCrosshair() {
  const trigger = $('crosshairTrigger');
  const menu = $('crosshairMenu');
  // Lives on the page body, not inside the sidebar, so the sidebar can't
  // clip it and nothing in it can scroll the sidebar.
  document.body.appendChild(menu);

  for (const c of CROSSHAIRS) {
    const opt = document.createElement('button');
    opt.type = 'button';
    opt.className = 'xh-option';
    opt.setAttribute('role', 'option');
    opt.dataset.id = c.id;
    opt.append(crosshairPicture(), c.label);
    opt.addEventListener('click', () => {
      updateSettings({ crosshair: c.id });
      closeMenu();
      trigger.focus();
    });
    menu.appendChild(opt);
  }

  function place() {
    const tile = trigger.closest('.crosshair-tile').getBoundingClientRect();
    const t = trigger.getBoundingClientRect();
    menu.style.left = `${tile.left}px`;
    menu.style.width = `${tile.width}px`;
    // Below the button if the whole list fits there; otherwise whichever
    // side has more room, scrolling if even that isn't enough.
    menu.style.maxHeight = 'none';
    const natural = menu.offsetHeight;
    const below = innerHeight - t.bottom - 18;
    const above = t.top - 18;
    const down = natural <= below || below >= above;
    const room = Math.max(120, down ? below : above);
    menu.style.maxHeight = `${room}px`;
    menu.style.top = `${down ? t.bottom + 6 : t.top - 6 - Math.min(natural, room)}px`;
  }
  function openMenu() {
    menu.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    place();
    (menu.querySelector('[aria-selected="true"]') || menu.firstElementChild).focus({ preventScroll: true });
  }
  function closeMenu() {
    if (menu.hidden) return;
    menu.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
  }
  trigger.addEventListener('click', () => (menu.hidden ? openMenu() : closeMenu()));
  document.addEventListener('mousedown', (e) => {
    if (!menu.contains(e.target) && !trigger.contains(e.target)) closeMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (menu.hidden) return;
    const opts = [...menu.children];
    const i = opts.indexOf(document.activeElement);
    if (e.key === 'Escape') {
      closeMenu();
      trigger.focus();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next = i < 0 ? 0 : (i + (e.key === 'ArrowDown' ? 1 : -1) + opts.length) % opts.length;
      opts[next].focus({ preventScroll: true });
      opts[next].scrollIntoView({ block: 'nearest' });
    }
  });
  window.addEventListener('resize', closeMenu);
  // Scrolling the sidebar carries the list along with its button.
  document.querySelector('.sidebar').addEventListener('scroll', () => {
    if (!menu.hidden) place();
  });

  const colors = $('crosshairColors');
  for (const c of CROSSHAIR_COLORS) {
    const swatch = document.createElement('button');
    swatch.type = 'button';
    swatch.className = 'accent-swatch';
    swatch.title = c.name;
    swatch.dataset.hex = c.hex;
    swatch.style.background = c.hex;
    swatch.addEventListener('click', () => updateSettings({ crosshairColor: c.hex }));
    colors.appendChild(swatch);
  }
  // Any other colour: a rainbow dot with the colour picker hidden inside it.
  const customWrap = document.createElement('label');
  customWrap.className = 'accent-swatch swatch-custom';
  customWrap.id = 'crosshairCustomSwatch';
  customWrap.title = 'Any colour';
  const custom = document.createElement('input');
  custom.type = 'color';
  custom.id = 'crosshairCustomColor';
  custom.setAttribute('aria-label', 'Any colour');
  custom.addEventListener('input', () => updateSettings({ crosshairColor: custom.value }));
  customWrap.appendChild(custom);
  colors.appendChild(customWrap);
}

/** A crosshair's picture is its true 1080p size, the same as in the drill
 * on a 1080p screen - so the list shows them in proportion, sharp, and
 * without blowing the small ones up into blobs. */
function drawPicture(box, preset, color) {
  const dpr = window.devicePixelRatio || 1;
  const canvas = box.querySelector('canvas');
  const size = drawCrosshair(canvas, preset, color, dpr);
  canvas.style.width = canvas.style.height = `${size / dpr}px`;
}

function renderCrosshair(s) {
  const preset = getCrosshair(s.crosshair);
  const color = (s.crosshairColor || DEFAULT_CROSSHAIR_COLOR).toLowerCase();
  drawPicture($('crosshairTrigger').querySelector('.xh-pic'), preset, color);
  $('crosshairName').textContent = preset.label;
  $('crosshairMenu').querySelectorAll('.xh-option').forEach((opt) => {
    opt.setAttribute('aria-selected', opt.dataset.id === preset.id ? 'true' : 'false');
    drawPicture(opt.querySelector('.xh-pic'), getCrosshair(opt.dataset.id), color);
  });
  let matched = false;
  $('crosshairColors').querySelectorAll('.accent-swatch[data-hex]').forEach((el) => {
    const on = el.dataset.hex === color;
    el.classList.toggle('active', on);
    matched = matched || on;
  });
  // The rainbow dot is the selected one when the colour isn't a preset.
  $('crosshairCustomSwatch').classList.toggle('active', !matched);
  const custom = $('crosshairCustomColor');
  if (document.activeElement !== custom && /^#[0-9a-f]{6}$/.test(color)) custom.value = color;
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

  // "Measure your real cm/360° for it" opens the calibrate section at the
  // box for the optic being looked at.
  $('modelNoteLink').addEventListener('click', () => {
    $('calibrateToggle').classList.add('open');
    $('calibrateBody').classList.add('open');
    const input = $(MEASURED_INPUTS[getState().activeTab] || MEASURED_INPUTS.hipfire);
    input.focus();
    input.scrollIntoView({ behavior: 'smooth', block: 'center' });
  });

  for (const [tab, id] of Object.entries(MEASURED_INPUTS)) {
    $(id).addEventListener('change', (e) => {
      const v = e.target.value.trim();
      setCalibration(tab, v ? Number(v) : null);
    });
  }

  // Each optic holds one correction, so entering one of these replaces
  // whatever was in the other box for that optic.
  for (const [tab, id] of Object.entries(NEUTRAL_INPUTS)) {
    $(id).addEventListener('change', (e) => {
      const v = e.target.value.trim();
      const s = getGameSettings('r6');
      updateR6({ calib: { ...s.calib, [tab]: v ? neutralCalibrationFrom(tab, Number(v), s) : null } });
    });
  }
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

const fmtPct = (v) => (v == null || !isFinite(v) ? '—' : `${Math.round(v * 100)}%`);

function poolNote(result) {
  return result.pooledPasses > 1 ? ` · ${result.totalFlicks} flicks from ${result.pooledPasses} passes` : '';
}

/** Results saved by the old four-drill calibration have none of the flick
 * check's numbers; they're shown as needing a retest. */
const isFlickCheck = (result) => result && result.method === 'flick-check';

function fineTuneHint(result, game) {
  const edge = result.balance && result.balance.clamped;
  if (edge) {
    const way = edge === 'low' ? 'lower' : 'higher';
    return `You ${edge === 'low' ? 'went past the head' : 'stopped short'} even at the ${
      edge === 'low' ? 'lowest' : 'highest'
    } value tested, so the balance point is ${way} still. Another pass tests around ${formatGameSens(game, result.best.sens)}.`;
  }
  const finest = result.atFinestStep ?? result.candidates?.[0]?.finest;
  if (finest) {
    return `You're down to the finest step ${game.short} allows. Another pass adds more flicks around this value, so the answer gets steadier.`;
  }
  const next = buildCandidates(result.best.sens, result.spreadPct * 0.5, game.rules)[0].delta;
  return `${CONFIDENCE_TEXT[result.confidence].hint} Another pass tests ±${formatGameSens(game, next)} around ${formatGameSens(
    game,
    result.best.sens
  )} and keeps these flicks.`;
}

const fmtMs = (v) => (v == null || !isFinite(v) ? '—' : `${Math.round(v)} ms`);
const fmtFix = (v) => (v == null || !isFinite(v) ? '—' : v.toFixed(1));

/** Table rows shared by the results screen and the comparison card. */
function comparisonRowsHtml(result, game) {
  const tag = result.centeredOn === 'previous-best' ? 'last pick' : 'current';
  return result.candidates
    .map((c) => {
      const cls = [c.isBase ? 'base' : '', c.sens === result.best.sens ? 'best' : ''].filter(Boolean).join(' ');
      return `<tr class="${cls}">
        <td>${formatGameSens(game, c.sens)}${c.isBase ? ` · ${tag}` : ''}</td>
        <td>${fmtPct(c.landRate)}</td>
        <td>${fmtPct(c.pastRate)}</td>
        <td>${fmtPct(c.shortRate)}</td>
        <td>${fmtFix(c.corrections)}</td>
        <td>${fmtMs(c.timeMs)}</td>
      </tr>`;
    })
    .join('');
}

const SCORING_FOOTNOTE =
  'On head: flicks whose first movement stopped on the head. Past / Short: stopped beyond it or before it. ' +
  'Fixes: corrections per flick. Time: typical time from the target appearing to the hit. ' +
  'The pick is the sensitivity where your first movement balances out - neither past the head nor short of it.';

function renderAll() {
  const state = getState();
  renderGameChrome(state);
  renderRangePanel();
  renderSettingsInputs(state);
  renderTabsUI(state);
  renderStats(state);
  renderRecommendation(state);
  renderComparison(state);
  renderConvert(state);
}

// ---------- Sensitivity converter ----------

/** Siege hip-fire goes in the list with its yaw worked out from the user's
 * custom multiplier (and hip-fire measurement, if any). */
function convertList() {
  return buildGameList(hipDegPerSensPoint(getGameSettings('r6')));
}

/** The converter's own fields default to whatever the user already has set
 * up above, so the card is showing something meaningful before it's touched.
 * Siege's entry always reads Siege's settings, and Valorant/CS2 read the
 * sens saved for them here, whichever game is selected. A saved choice
 * that's no longer in the list (the old Siege ADS entries) falls back to
 * the default instead of leaving the picker blank. */
function convertValues(state) {
  const s = state.settings;
  const r6 = getGameSettings('r6');
  const c = s.convert || {};
  const list = convertList();
  const listed = (id) => !!id && !!findGame(list, id);
  const fromDropped = !listed(c.from);
  const from = fromDropped ? 'r6_hipfire' : c.from;
  const fallbackSens = from === 'r6_hipfire' ? r6.hipfireH : GAMES[from] ? getGameSettings(from).sens : 1;
  return {
    from,
    to: listed(c.to) ? c.to : from === 'valorant' ? 'r6_hipfire' : 'valorant',
    // A sens saved against a dropped entry was an ADS value - start fresh.
    sens: c.sens === undefined || fromDropped ? fallbackSens : c.sens,
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

  // Siege's hip-fire number means nothing without the multiplier it's used
  // with, so say which one the conversion assumed.
  const r6 = getGameSettings('r6');
  const r6Note =
    v.from === 'r6_hipfire' || v.to === 'r6_hipfire'
      ? ` R6 uses your multiplier setting (${r6.useCustomMultiplier ? Number(r6.customMultiplier) : '0.02, the default'}); ADS values carry over unchanged.`
      : '';
  $('convertCm').innerHTML =
    isFinite(cm360) && cm360 > 0
      ? `Both work out to <b>${cm360.toFixed(1)} cm/360°</b>${
          v.fromDpi !== v.toDpi && !fromIsCm && !toIsCm ? ' — DPI difference accounted for.' : '.'
        }${r6Note}`
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
  const hitVolume = s.hitVolume ?? 100;
  if (document.activeElement !== $('hitVolume')) $('hitVolume').value = hitVolume;
  $('hitVolumeValue').textContent = hitVolumeText(hitVolume);
  renderCrosshair(s);
  $('keepAdsSpeed').checked = s.keepAdsSpeed;
  $('useCustomMultiplier').checked = s.useCustomMultiplier;
  $('customMultiplier').value = s.customMultiplier;
  $('customMultiplier').disabled = !s.useCustomMultiplier;
  $('aspectRatio').value = s.aspectRatio;
  $('screenFill').value = s.screenFill;
  document.querySelector('.stepper[data-field="ads1x"] input').value = s.ads1x;
  // Each empty "measured" box shows what the model expects, so it's easy to
  // see how far off a measurement is.
  for (const [tab, id] of Object.entries(MEASURED_INPUTS)) {
    const input = $(id);
    if (document.activeElement !== input) input.value = s.calib?.[tab]?.cm360 ?? '';
    const estimate = estimateCm360(tab, { ...s, calib: { ...s.calib, [tab]: null } });
    input.placeholder = `Estimate ${formatCm360(estimate)}`;
  }
  // The same for the ruler-free boxes, where the placeholder is the value
  // the model expects to match hip-fire.
  for (const [tab, id] of Object.entries(NEUTRAL_INPUTS)) {
    const input = $(id);
    if (document.activeElement !== input) input.value = s.calib?.[tab]?.neutral ?? '';
    const expected = neutralAdsValue(tab, { ...s, calib: { ...s.calib, [tab]: null } });
    input.placeholder = expected > 100 ? 'Estimate: above 100' : `Estimate ${Math.round(expected)}`;
  }
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
  // Siege's ADS optics rest on the estimated sight zoom until measured.
  const estimatedOptic =
    game.id === 'r6' && state.activeTab !== 'hipfire' && !isCalibrated(state.activeTab, getGameSettings('r6'));
  $('modelNote').style.display = estimatedOptic ? '' : 'none';
  if (estimatedOptic) {
    // A check anyone can make in-game without a ruler: at this value the
    // optic should feel exactly like hip-fire. If it doesn't, the value that
    // does goes in the calibrate section and fixes this optic.
    const expected = neutralAdsValue(state.activeTab, getGameSettings('r6'));
    $('modelNoteCheck').textContent =
      expected > 100
        ? 'Worth knowing: no value on this sight matches hip-fire speed - even 100 is slower.'
        : `Check it in R6: this sight should feel exactly like your hip-fire at ${Math.round(expected)}.`;
  }

  // "Start calibration" is always a fresh pass around your current setting -
  // the narrower passes are what "Fine-tune further" does.
  $('refineSub').textContent =
    `Flicks at your current setting and ${Math.round(INITIAL_SPREAD_PCT * 100)}% either side, ` +
    `to find where your flicks land on the head instead of past or short of it.`;
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
  if (isFlickCheck(result)) {
    $('statAccuracy').textContent = fmtPct(result.best.landRate);
    $('statTargets').textContent = fmtFix(result.best.corrections);
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
    badge.textContent = 'NOT RUN YET';
    body.innerHTML =
      `<p class="card-empty">No flick check yet. It takes about ${Math.round(PASS_SECONDS / 30) / 2} minutes: ` +
      `${TOTAL_SCORED_FLICKS} flicks onto head-sized targets, read for where each one lands.</p>`;
    return;
  }

  if (stale || !isFlickCheck(result)) {
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
  const same = bestSens(game, result) === current;
  const delta = bestSens(game, result) - current;
  const deltaText = same
    ? 'Matches your current setting.'
    : `${delta > 0 ? '+' : '−'}${fmt(Math.abs(delta))} from your current ${fmt(current)}.`;
  const refinedText = result.passCount > 1 ? ` · fine-tuned ×${result.passCount - 1}` : '';
  const landed = isFinite(result.best.landRate) ? ` First flick on the head ${fmtPct(result.best.landRate)} of the time` : '';

  body.innerHTML = `
    <div class="rec-value">${fmt(result.best.sens)}</div>
    <p class="rec-sub">${deltaText}${landed}${refinedText}.</p>
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

  if (!isFlickCheck(result)) {
    // Preview which sensitivities a fresh run would test, before any data exists.
    const preview = buildCandidates(currentSens(game, tab, state.settings), INITIAL_SPREAD_PCT, game.rules);
    tbody.innerHTML = preview
      .map(
        (c) => `<tr class="${c.isBase ? 'base' : ''}">
          <td>${formatGameSens(game, c.sens)}${c.isBase ? ' · current' : ''}</td>
          <td>—</td><td>—</td><td>—</td><td>—</td><td>—</td>
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
