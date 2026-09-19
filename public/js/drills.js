import { estimateCm360, estimateCm360Axis } from './sensMath.js';

const DRILL_LABELS = { flick: 'FLICK', targets: 'TARGETS', tracking: 'TRACKING' };

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function parseAspect(ratioStr) {
  const [w, h] = ratioStr.split(':').map(Number);
  return w / h;
}

function rand(min, max) {
  return min + Math.random() * (max - min);
}

export class DrillEngine {
  constructor({ overlayEl, stageEl, canvasEl, elements, onBlockComplete, onQueueComplete, onPauseChange, onStartError }) {
    this.overlay = overlayEl;
    this.stage = stageEl;
    this.canvas = canvasEl;
    this.ctx = canvasEl.getContext('2d');
    this.el = elements; // { phaseLabel, timer, getReady, getReadyLabel, getReadyNum, pauseOverlay, pauseReason, resumeBtn }
    this.onBlockComplete = onBlockComplete;
    this.onQueueComplete = onQueueComplete;
    this.onPauseChange = onPauseChange;
    this.onStartError = onStartError;

    this.queue = [];
    this.queueIndex = -1;
    this.running = false;
    this.paused = false;
    this.crosshair = { x: 0, y: 0 };
    this.targets = [];
    this.metrics = null;
    this.blockElapsedMs = 0;
    this.blockDurationMs = 0;
    this.lastFrameTime = 0;
    this.rafId = null;
    this.trackPhase = 0;
    this.windowBlurredRecently = false;

    this._bindEvents();
    this.el.resumeBtn.addEventListener('click', () => this._requestLock());
  }

  _bindEvents() {
    document.addEventListener('pointerlockchange', () => {
      const locked = document.pointerLockElement === this.canvas;
      if (!locked && this.running && !this.paused) {
        this._pause(this.windowBlurredRecently ? 'blur' : 'esc');
      }
    });
    window.addEventListener('blur', () => {
      this.windowBlurredRecently = true;
      if (this.running && !this.paused) this._pause('blur');
    });
    window.addEventListener('focus', () => {
      this.windowBlurredRecently = false;
    });
    document.addEventListener('mousemove', (e) => {
      if (!this.running || this.paused) return;
      if (document.pointerLockElement !== this.canvas) return;
      this._applyMovement(e.movementX, e.movementY);
    });
    document.addEventListener('mousedown', (e) => {
      if (!this.running || this.paused || e.button !== 0) return;
      if (document.pointerLockElement !== this.canvas) return;
      this._handleShoot();
    });
    window.addEventListener('resize', () => this._resizeCanvas());
  }

  configure(sensSettings) {
    this.sensSettings = sensSettings; // { tab, settings }
  }

  _resizeCanvas() {
    if (!this.sensSettings) return; // window can resize before the first configure()/run()
    const stageRect = this.stage.getBoundingClientRect();
    const { screenFill, aspectRatio } = this.sensSettings.settings;
    let w = stageRect.width;
    let h = stageRect.height;
    if (screenFill === 'keep-aspect') {
      const targetRatio = parseAspect(aspectRatio);
      if (w / h > targetRatio) {
        w = h * targetRatio;
      } else {
        h = w / targetRatio;
      }
    }
    this.canvas.width = Math.round(w * devicePixelRatio);
    this.canvas.height = Math.round(h * devicePixelRatio);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.canvas.style.left = `${(stageRect.width - w) / 2}px`;
    this.canvas.style.top = `${(stageRect.height - h) / 2}px`;
    this.canvas.style.position = 'absolute';
    this.ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
    this.cw = w;
    this.ch = h;
    if (!this.crosshair.x) this.crosshair = { x: w / 2, y: h / 2 };
  }

  /** Swaps in the block's candidate sens value (hip-fire H/V or the ADS value) on top of the live settings, so each calibration block actually tests that candidate rather than whatever's live in the sidebar. */
  _effectiveSettings() {
    const base = this.sensSettings.settings;
    const sens = this.currentCandidateSens;
    if (sens == null) return base;
    if (this.sensSettings.tab === 'hipfire') return { ...base, hipfireH: sens, hipfireV: sens };
    return { ...base, ads25x: sens };
  }

  _movementScale() {
    const tab = this.sensSettings.tab;
    const settings = this._effectiveSettings();
    const fov = settings.fov;
    const pxPerDegree = this.cw / fov;
    const dpi = settings.dpi;

    const degPerPxFor = (cm360) => (360 * 2.54) / (cm360 * dpi);

    if (tab === 'hipfire') {
      const cmH = estimateCm360Axis('h', settings);
      const cmV = estimateCm360Axis('v', settings);
      return {
        x: degPerPxFor(cmH) * pxPerDegree,
        y: degPerPxFor(cmV) * pxPerDegree,
      };
    }
    const cm = estimateCm360(tab, settings);
    const s = degPerPxFor(cm) * pxPerDegree;
    return { x: s, y: s };
  }

  _applyMovement(mx, my) {
    const scale = this._movementScale();
    this.crosshair.x = Math.max(0, Math.min(this.cw, this.crosshair.x + mx * scale.x));
    this.crosshair.y = Math.max(0, Math.min(this.ch, this.crosshair.y + my * scale.y));
  }

  /** queueBlocks: [{ type, durationSec, scored, phaseLabel, getReadyLabel, candidateSens }] */
  async run(queueBlocks) {
    this.queue = queueBlocks;
    this.queueIndex = -1;
    this.results = [];
    try {
      await this._requestFullscreenAndLock();
      this._next();
    } catch (err) {
      // Something unexpected blew up before the first block even showed -
      // surface it instead of leaving the page looking like nothing happened.
      console.error('[DrillEngine] failed to start calibration:', err);
      this.overlay.classList.remove('active');
      this.onStartError?.(err);
    }
  }

  async _requestFullscreenAndLock() {
    // Make the overlay visible BEFORE requesting fullscreen - some browsers
    // refuse (or no-op) a fullscreen request on an element that's still
    // display:none, which used to make "Start calibration" look like it did
    // nothing at all.
    this.overlay.classList.add('active');
    this._resizeCanvas();
    try {
      if (this.overlay.requestFullscreen) await this.overlay.requestFullscreen();
    } catch (err) {
      // Fullscreen can be denied (no user-gesture activation left, browser
      // policy, running inside an iframe, etc). Drills still work windowed.
      console.warn('[DrillEngine] fullscreen unavailable, continuing windowed:', err);
    }
    this._resizeCanvas(); // viewport size can change once fullscreen settles
    await this._requestLock();
  }

  async _requestLock() {
    this.el.pauseOverlay.classList.remove('active');
    try {
      await this.canvas.requestPointerLock({ unadjustedMovement: true });
    } catch (err) {
      // Some browsers reject the unadjustedMovement option entirely - retry plain.
      try {
        await this.canvas.requestPointerLock();
      } catch (err2) {
        console.warn('[DrillEngine] pointer lock unavailable, mouse movement will not register:', err2);
      }
    }
    if (this.paused) {
      this.paused = false;
      this.onPauseChange?.(false);
      // Don't let the paused interval count as elapsed time on resume.
      this.lastFrameTime = performance.now();
      this._loop();
    }
  }

  _pause(reason) {
    this.paused = true;
    this.onPauseChange?.(true);
    this.el.pauseReason.textContent =
      reason === 'blur' ? 'Paused because the window lost focus.' : 'Paused. Click to resume.';
    this.el.pauseOverlay.classList.add('active');
    if (this.rafId) cancelAnimationFrame(this.rafId);
  }

  async _next() {
    this.queueIndex += 1;
    if (this.queueIndex >= this.queue.length) {
      this._finishQueue();
      return;
    }
    const block = this.queue[this.queueIndex];
    await this._showGetReady(block);
    this._startBlock(block);
  }

  _showGetReady(block) {
    return new Promise((resolve) => {
      this.el.getReadyLabel.textContent = block.getReadyLabel;
      this.el.getReady.classList.add('active');
      let n = 3;
      this.el.getReadyNum.textContent = n;
      const tick = setInterval(() => {
        n -= 1;
        if (n <= 0) {
          clearInterval(tick);
          this.el.getReady.classList.remove('active');
          resolve();
          return;
        }
        this.el.getReadyNum.textContent = n;
      }, 700);
    });
  }

  _startBlock(block) {
    this.currentBlock = block;
    this.currentCandidateSens = block.candidateSens;
    this.blockDurationMs = block.durationSec * 1000;
    this.blockElapsedMs = 0;
    this.el.phaseLabel.textContent = `${block.phaseLabel} / ${DRILL_LABELS[block.type]}`;
    this.targets = [];
    this.metrics = { hits: 0, clicks: 0, cleared: 0, onTargetMs: 0, spawned: 0 };
    this.trackPhase = Math.random() * 1000;
    this._spawnForBlock(block);
    this.running = true;
    this.paused = false;
    this.lastFrameTime = performance.now();
    this._loop();
  }

  _spawnForBlock(block) {
    const margin = 90;
    if (block.type === 'flick') {
      this.targets = [this._randomTarget(margin, 26)];
      this.metrics.spawned = 1;
    } else if (block.type === 'targets') {
      this.targets = Array.from({ length: 5 }, () => this._randomTarget(margin, 22));
      this.metrics.spawned = 5;
    } else if (block.type === 'tracking') {
      this.targets = [{ x: this.cw / 2, y: this.ch / 2, r: 24 }];
    }
  }

  _randomTarget(margin, r) {
    return { x: rand(margin, this.cw - margin), y: rand(margin, this.ch - margin), r };
  }

  _handleShoot() {
    const block = this.currentBlock;
    if (!block || (block.type !== 'flick' && block.type !== 'targets')) return;
    this.metrics.clicks += 1;
    let hitIdx = -1;
    let bestDist = Infinity;
    this.targets.forEach((t, i) => {
      const d = Math.hypot(t.x - this.crosshair.x, t.y - this.crosshair.y);
      if (d <= t.r && d < bestDist) {
        bestDist = d;
        hitIdx = i;
      }
    });
    if (hitIdx === -1) return;
    this.metrics.hits += 1;
    if (block.type === 'flick') {
      this.targets = [this._randomTarget(90, 26)];
    } else {
      this.targets.splice(hitIdx, 1);
      this.metrics.cleared += 1;
      if (this.targets.length === 0) {
        this.targets = Array.from({ length: 5 }, () => this._randomTarget(90, 22));
        this.metrics.spawned += 5;
      }
    }
  }

  _updateTracking(dtMs) {
    const t = this.targets[0];
    if (!t) return;
    this.trackPhase += dtMs / 1000;
    const cx = this.cw / 2;
    const cy = this.ch / 2;
    const rx = Math.min(this.cw, this.ch) * 0.28;
    const ry = Math.min(this.cw, this.ch) * 0.2;
    t.x = cx + Math.sin(this.trackPhase * 0.9) * rx + Math.sin(this.trackPhase * 2.1) * rx * 0.18;
    t.y = cy + Math.cos(this.trackPhase * 0.7) * ry + Math.cos(this.trackPhase * 1.7) * ry * 0.18;
    const d = Math.hypot(t.x - this.crosshair.x, t.y - this.crosshair.y);
    if (d <= t.r) this.metrics.onTargetMs += dtMs;
  }

  _loop() {
    if (!this.running || this.paused) return;
    const now = performance.now();
    const dt = now - this.lastFrameTime;
    this.lastFrameTime = now;
    this.blockElapsedMs += dt;

    if (this.currentBlock.type === 'tracking') this._updateTracking(dt);

    this._render();

    const remaining = this.blockDurationMs - this.blockElapsedMs;
    if (this.blockDurationMs >= 300000) {
      // Open-ended (freeform practice) block: count elapsed time up as m:ss
      // instead of counting a huge duration down, which just looks broken.
      const totalSec = Math.floor(this.blockElapsedMs / 1000);
      const m = Math.floor(totalSec / 60);
      const s = String(totalSec % 60).padStart(2, '0');
      this.el.timer.textContent = `${m}:${s}`;
    } else {
      this.el.timer.textContent = `${Math.max(0, remaining / 1000).toFixed(1)}s`;
    }

    if (remaining <= 0) {
      this._endBlock();
      return;
    }
    this.rafId = requestAnimationFrame(() => this._loop());
  }

  _endBlock() {
    this.running = false;
    const block = this.currentBlock;
    const elapsedSec = this.blockDurationMs / 1000;
    const result = {
      type: block.type,
      candidateSens: block.candidateSens,
      scored: block.scored,
      flickHitsPerSec: block.type === 'flick' ? this.metrics.hits / elapsedSec : null,
      clearedPerSec: block.type === 'targets' ? this.metrics.cleared / elapsedSec : null,
      onTargetPct: block.type === 'tracking' ? this.metrics.onTargetMs / this.blockDurationMs : null,
      accuracy: this.metrics.clicks ? this.metrics.hits / this.metrics.clicks : null,
      hits: this.metrics.hits,
      clicks: this.metrics.clicks,
    };
    if (block.scored) this.results.push(result);
    this.onBlockComplete?.(result, this.queueIndex, this.queue.length);
    this._next();
  }

  _finishQueue() {
    // Release the mouse so the results card is clickable, but stay fullscreen
    // until the user dismisses it via exit().
    if (document.exitPointerLock) document.exitPointerLock();
    this.onQueueComplete?.(this.results);
  }

  exit() {
    if (document.exitPointerLock) document.exitPointerLock();
    if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
    this.overlay.classList.remove('active');
  }

  stop() {
    this.running = false;
    if (this.rafId) cancelAnimationFrame(this.rafId);
    if (document.exitPointerLock) document.exitPointerLock();
    if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
    this.overlay.classList.remove('active');
  }

  _render() {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.cw, this.ch);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, this.cw, this.ch);

    this._drawGrid(ctx);

    const fill = cssVar('--target-fill') || '#d8c9ab';
    const ring = cssVar('--target-ring') || '#a9946a';
    this.targets.forEach((t) => {
      ctx.beginPath();
      ctx.arc(t.x, t.y, t.r, 0, Math.PI * 2);
      ctx.fillStyle = fill;
      ctx.fill();
      ctx.beginPath();
      ctx.arc(t.x, t.y, t.r * 0.42, 0, Math.PI * 2);
      ctx.strokeStyle = ring;
      ctx.lineWidth = 2;
      ctx.stroke();
    });

    this._drawCrosshair(ctx);
  }

  _drawGrid(ctx) {
    const cols = 8;
    const rows = 6;
    const cx = this.cw / 2;
    const cy = this.ch / 2;
    const bow = Math.max(8, (100 - this.sensSettings.settings.fov) * 0.6 + 14);
    ctx.strokeStyle = 'rgba(255,255,255,0.055)';
    ctx.lineWidth = 1;

    for (let i = 0; i <= cols; i++) {
      const x = (this.cw / cols) * i;
      const off = ((x - cx) / cx) ** 2 * bow;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.quadraticCurveTo(x + (x < cx ? off : -off), cy, x, this.ch);
      ctx.stroke();
    }
    for (let j = 0; j <= rows; j++) {
      const y = (this.ch / rows) * j;
      const off = ((y - cy) / cy) ** 2 * bow;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.quadraticCurveTo(cx, y + (y < cy ? off : -off), this.cw, y);
      ctx.stroke();
    }
  }

  _drawCrosshair(ctx) {
    const { x, y } = this.crosshair;
    ctx.strokeStyle = '#f2f2f2';
    ctx.lineWidth = 1.4;
    const len = 7;
    const gap = 3;
    ctx.beginPath();
    ctx.moveTo(x - len - gap, y);
    ctx.lineTo(x - gap, y);
    ctx.moveTo(x + gap, y);
    ctx.lineTo(x + len + gap, y);
    ctx.moveTo(x, y - len - gap);
    ctx.lineTo(x, y - gap);
    ctx.moveTo(x, y + gap);
    ctx.lineTo(x, y + len + gap);
    ctx.stroke();
  }
}
