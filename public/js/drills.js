import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js';
import { estimateCm360, estimateCm360Axis } from './sensMath.js';

const DRILL_LABELS = { flick: 'FLICK', targets: 'TARGETS', tracking: 'TRACKING' };
const TARGET_DISTANCE = 22; // world units targets sit out in front of the camera
const CAMERA_HEIGHT = 6; // "elevated in the air" - eye height above the floor grid
const TRACK_YAW_RANGE = (22 * Math.PI) / 180; // how far the tracking target swings left/right
const TRACK_PITCH_RANGE = (7 * Math.PI) / 180;
// Flick/clear spawns: wide left-right, deliberately shallow up-down, so the
// drill is a horizontal flick exercise and never walks you into the floor.
const SPAWN_YAW_SPREAD = (30 * Math.PI) / 180;
const SPAWN_PITCH_RANGE = (7 * Math.PI) / 180;
const WALL_RADIUS = 46; // grid backdrop, comfortably behind the targets at 22
const WALL_HEIGHT = 44;

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

const HALF_PI = Math.PI / 2;
const PITCH_LIMIT = HALF_PI - 0.01;

export class DrillEngine {
  constructor({ overlayEl, stageEl, canvasEl, elements, onBlockComplete, onQueueComplete, onPauseChange, onStartError }) {
    this.overlay = overlayEl;
    this.stage = stageEl;
    this.canvas = canvasEl;
    this.el = elements; // { phaseLabel, timer, getReady, getReadyLabel, getReadyNum, pauseOverlay, pauseReason, resumeBtn }
    this.onBlockComplete = onBlockComplete;
    this.onQueueComplete = onQueueComplete;
    this.onPauseChange = onPauseChange;
    this.onStartError = onStartError;

    this.queue = [];
    this.queueIndex = -1;
    this.running = false;
    this.paused = false;
    // True from run() until the queue finishes or exit()/stop() is called -
    // covers get-ready countdowns too, not just an actively running block,
    // so losing the mouse during "get ready" also surfaces the pause menu
    // instead of leaving no way back to the main page short of a refresh.
    this.sessionActive = false;
    this.phase = 'idle'; // 'idle' | 'getready' | 'running' - drives what resuming from pause does
    this.getReadyTimer = null;
    this.pendingBlock = null;
    this.getReadyCount = 0;
    this.yaw = 0;
    this.pitch = 0;
    this.targets = []; // { mesh, r } - r is the hit-test radius in world units
    this.metrics = null;
    this.blockElapsedMs = 0;
    this.blockDurationMs = 0;
    this.lastFrameTime = 0;
    this.rafId = null;
    this.trackPhase = 0;
    this.windowBlurredRecently = false;

    this._initScene();
    this._bindEvents();
    this.el.resumeBtn.addEventListener('click', () => this._requestLock());
  }

  // ---------- Three.js scene: a first-person view of a lit void with a
  // floor grid receding to the horizon and shaded spheres to flick onto. ----------
  _initScene() {
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x05030a);
    // Light fog so the grid fades with distance instead of ending in a hard
    // line. Kept gentle - heavy fog just puts the void back.
    this.scene.fog = new THREE.FogExp2(0x05030a, 0.011);

    this.camera = new THREE.PerspectiveCamera(90, 1, 0.1, 500);
    this.camera.position.set(0, CAMERA_HEIGHT, 0);
    this.camera.rotation.order = 'YXZ';

    // Targets are unlit (flat MeshBasicMaterial, see _makeTargetMaterial) so
    // they read as a consistent bright color from every angle instead of
    // having a dim "shadow" side that's harder to see - no scene lighting
    // needed for that, the grid surfaces don't react to lights either.

    const floor = new THREE.GridHelper(400, 80, 0x4a2a5e, 0x241436);
    floor.position.y = 0;
    this.scene.add(floor);

    // A grid wall wrapping the whole arena, so there's always a backdrop
    // behind a target instead of pitch black - a bright dot against a
    // textured surface is far easier to pick out than one floating in a void.
    const wall = new THREE.Mesh(
      new THREE.CylinderGeometry(WALL_RADIUS, WALL_RADIUS, WALL_HEIGHT, 72, 1, true),
      new THREE.MeshBasicMaterial({
        map: this._makeGridTexture(),
        side: THREE.BackSide,
        transparent: true,
      })
    );
    wall.position.y = WALL_HEIGHT / 2 - 6;
    this.scene.add(wall);

    this.targetGeo = new THREE.SphereGeometry(1, 24, 18);

    this.raycaster = new THREE.Raycaster();
    this.centerNDC = new THREE.Vector2(0, 0);
  }

  /** Procedural grid cell, tiled around the arena wall. */
  _makeGridTexture() {
    const size = 128;
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#07040e';
    ctx.fillRect(0, 0, size, size);
    ctx.strokeStyle = '#2a1940';
    ctx.lineWidth = 2;
    ctx.strokeRect(0, 0, size, size);
    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    // Fewer, larger cells: tiling them too finely just blurs the lines into
    // a flat wash of colour at distance instead of reading as a grid.
    tex.repeat.set(26, 6);
    return tex;
  }

  _makeTargetMaterial() {
    // Flat/unlit on purpose - a shaded sphere has a dim side depending on
    // light angle, which makes it harder to see exactly where "the target"
    // is. Bright and flat from every angle is easier to read at a glance.
    const fill = new THREE.Color(cssVar('--target-fill') || '#c837ff');
    // fog:false keeps every target the exact same brightness regardless of
    // distance - the backdrop fades away, the thing you're aiming at doesn't.
    return new THREE.MeshBasicMaterial({ color: fill, fog: false });
  }

  _bindEvents() {
    document.addEventListener('pointerlockchange', () => {
      const locked = document.pointerLockElement === this.canvas;
      if (!locked && this.sessionActive && !this.paused) {
        this._pause(this.windowBlurredRecently ? 'blur' : 'esc');
      }
    });
    window.addEventListener('blur', () => {
      this.windowBlurredRecently = true;
      if (this.sessionActive && !this.paused) this._pause('blur');
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
    const { screenFill, aspectRatio, fov } = this.sensSettings.settings;
    const selected = parseAspect(aspectRatio);

    let w = stageRect.width;
    let h = stageRect.height;
    if (screenFill === 'keep-aspect') {
      // Letterbox/pillarbox: the canvas itself takes the selected shape.
      if (w / h > selected) {
        w = h * selected;
      } else {
        h = w / selected;
      }
    }
    // For "stretch to fill" the canvas keeps the full screen shape, but the
    // camera below still frames at the selected ratio - so a 4:3 image gets
    // stretched across a 16:9 screen exactly like a stretched res in-game.
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.canvas.style.left = `${(stageRect.width - w) / 2}px`;
    this.canvas.style.top = `${(stageRect.height - h) / 2}px`;
    this.canvas.style.position = 'absolute';
    this.cw = w;
    this.ch = h;

    this.renderer.setSize(w, h, false);
    // Always frame using the SELECTED in-game aspect, never the window's.
    // Previously this used the canvas shape, which meant "stretch to fill"
    // rendered an undistorted native image and the setting did nothing.
    this.camera.aspect = selected;
    // Horizontal FOV setting -> the vertical FOV Three.js wants.
    const hFovRad = (Math.max(60, Math.min(110, fov)) * Math.PI) / 180;
    const vFovRad = 2 * Math.atan(Math.tan(hFovRad / 2) / selected);
    this.camera.fov = (vFovRad * 180) / Math.PI;
    this.camera.updateProjectionMatrix();
  }

  /** Swaps in the block's candidate sens value (hip-fire H/V or the ADS value) on top of the live settings, so each calibration block actually tests that candidate rather than whatever's live in the sidebar. */
  _effectiveSettings() {
    const base = this.sensSettings.settings;
    const sens = this.currentCandidateSens;
    if (sens == null) return base;
    if (this.sensSettings.tab === 'hipfire') return { ...base, hipfireH: sens, hipfireV: sens };
    return { ...base, ads25x: sens };
  }

  /** Degrees of camera rotation per raw mouse-movement unit, straight from the cm/360 model - no screen-pixel conversion needed since we're rotating a real camera now. */
  _rotationScale() {
    const tab = this.sensSettings.tab;
    const settings = this._effectiveSettings();
    const dpi = settings.dpi;
    const degPerPxFor = (cm360) => (360 * 2.54) / (cm360 * dpi);

    if (tab === 'hipfire') {
      const cmH = estimateCm360Axis('h', settings);
      const cmV = estimateCm360Axis('v', settings);
      return { x: degPerPxFor(cmH) * (Math.PI / 180), y: degPerPxFor(cmV) * (Math.PI / 180) };
    }
    const cm = estimateCm360(tab, settings);
    const s = degPerPxFor(cm) * (Math.PI / 180);
    return { x: s, y: s };
  }

  _applyMovement(mx, my) {
    const scale = this._rotationScale();
    this.yaw -= mx * scale.x;
    this.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, this.pitch - my * scale.y));
    this.camera.rotation.y = this.yaw;
    this.camera.rotation.x = this.pitch;
    // Keep the world matrix current immediately, rather than only after the
    // next render - a click (_handleShoot) or a target spawn can happen
    // between animation frames and both rely on an up-to-date camera transform.
    this.camera.updateMatrixWorld(true);
  }

  /** queueBlocks: [{ type, durationSec, scored, phaseLabel, getReadyLabel, candidateSens }] */
  async run(queueBlocks) {
    this.queue = queueBlocks;
    this.queueIndex = -1;
    this.results = [];
    this.sessionActive = true;
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
      this.stage.classList.remove('show-cursor');
      this.onPauseChange?.(false);
      if (this.phase === 'getready') {
        // Restart the 3-count fresh rather than trying to resume mid-tick -
        // simpler, and losing at most a couple seconds of countdown is fine.
        this.getReadyCount = 3;
        this.el.getReadyNum.textContent = this.getReadyCount;
        this._tickGetReady();
      } else if (this.phase === 'running') {
        // Don't let the paused interval count as elapsed time on resume.
        this.lastFrameTime = performance.now();
        this._loop();
      }
    }
  }

  _pause(reason) {
    this.paused = true;
    this.stage.classList.add('show-cursor');
    this.onPauseChange?.(true);
    this.el.pauseReason.textContent =
      reason === 'blur' ? 'Paused because the window lost focus.' : 'Paused. Click to resume.';
    this.el.pauseOverlay.classList.add('active');
    if (this.rafId) cancelAnimationFrame(this.rafId);
    if (this.getReadyTimer) {
      clearTimeout(this.getReadyTimer);
      this.getReadyTimer = null;
    }
  }

  _next() {
    this.queueIndex += 1;
    if (this.queueIndex >= this.queue.length) {
      this._finishQueue();
      return;
    }
    this._runGetReady(this.queue[this.queueIndex]);
  }

  /** A chained setTimeout instead of a Promise/setInterval, specifically so
   * pausing partway through is just "stop scheduling the next tick" and
   * resuming is "schedule it again" - no half-settled promise to worry about. */
  _runGetReady(block) {
    this.phase = 'getready';
    this.pendingBlock = block;
    this.el.getReadyLabel.textContent = block.getReadyLabel;
    this.el.getReady.classList.add('active');
    this.getReadyCount = 3;
    this.el.getReadyNum.textContent = this.getReadyCount;
    this._tickGetReady();
  }

  _tickGetReady() {
    this.getReadyTimer = setTimeout(() => {
      this.getReadyTimer = null;
      this.getReadyCount -= 1;
      if (this.getReadyCount <= 0) {
        this.el.getReady.classList.remove('active');
        this._startBlock(this.pendingBlock);
        return;
      }
      this.el.getReadyNum.textContent = this.getReadyCount;
      this._tickGetReady();
    }, 700);
  }

  _startBlock(block) {
    this.currentBlock = block;
    this.currentCandidateSens = block.candidateSens;
    this.blockDurationMs = block.durationSec * 1000;
    this.blockElapsedMs = 0;
    this.el.phaseLabel.textContent = `${block.phaseLabel} / ${DRILL_LABELS[block.type]}`;
    this._clearTargets();
    this.metrics = { hits: 0, clicks: 0, cleared: 0, onTargetMs: 0, spawned: 0 };
    // Recentre the view at the start of every block so a candidate never
    // inherits wherever the last block happened to leave the camera aimed.
    this.yaw = 0;
    this.pitch = 0;
    this.camera.rotation.y = 0;
    this.camera.rotation.x = 0;
    this.camera.updateMatrixWorld(true);
    this.trackPhase = Math.random() * 1000;
    this._spawnForBlock(block);
    this.phase = 'running';
    this.running = true;
    this.paused = false;
    this.lastFrameTime = performance.now();
    this._loop();
  }

  _clearTargets() {
    this.targets.forEach((t) => this.scene.remove(t.mesh));
    this.targets = [];
  }

  _spawnForBlock(block) {
    this._clearTargets();
    if (block.type === 'flick') {
      this.targets = [this._randomTarget(0.85)];
      this.metrics.spawned = 1;
    } else if (block.type === 'targets') {
      this.targets = this._spawnWave(5, 0.7);
      this.metrics.spawned = 5;
    } else if (block.type === 'tracking') {
      this.targets = [this._targetAtAngles(0, 0, 0.8)];
    }
  }

  /** Spawns at a yaw offset from wherever you're currently looking (so it's
   * always on screen to flick to) but at an ABSOLUTE world pitch near eye
   * level. Pitch being absolute is the important part: taking it from the
   * current view meant every spawn inherited the last one's pitch, so
   * chasing a low target dragged the next one lower again and the whole
   * session gradually walked down into the floor. */
  _randomTarget(radius) {
    const yaw = this.yaw + rand(-SPAWN_YAW_SPREAD, SPAWN_YAW_SPREAD);
    return this._targetAtAngles(yaw, rand(-SPAWN_PITCH_RANGE, SPAWN_PITCH_RANGE), radius);
  }

  /** A wave of targets spread evenly across the flick range so they don't pile up on top of each other. */
  _spawnWave(count, radius) {
    const band = (SPAWN_YAW_SPREAD * 2) / count;
    return Array.from({ length: count }, (_, i) => {
      const yaw = this.yaw - SPAWN_YAW_SPREAD + band * (i + rand(0.2, 0.8));
      return this._targetAtAngles(yaw, rand(-SPAWN_PITCH_RANGE, SPAWN_PITCH_RANGE), radius);
    });
  }

  _targetAtAngles(yaw, pitch, radius) {
    const pos = this.camera.position.clone().add(this._dirFromAngles(yaw, pitch).multiplyScalar(TARGET_DISTANCE));

    const mesh = new THREE.Mesh(this.targetGeo, this._makeTargetMaterial());
    mesh.scale.setScalar(radius);
    mesh.position.copy(pos);
    // Make it raycast-ready immediately rather than only after the next
    // render() - a click can land before the renderer refreshes matrixWorld.
    mesh.updateMatrixWorld();
    this.scene.add(mesh);
    return { mesh, r: radius };
  }

  _handleShoot() {
    const block = this.currentBlock;
    if (!block || (block.type !== 'flick' && block.type !== 'targets')) return;
    this.metrics.clicks += 1;
    const hitIdx = this._raycastHit();
    if (hitIdx === -1) return;
    this.metrics.hits += 1;
    if (block.type === 'flick') {
      this.scene.remove(this.targets[0].mesh);
      this.targets = [this._randomTarget(0.85)];
    } else {
      this.scene.remove(this.targets[hitIdx].mesh);
      this.targets.splice(hitIdx, 1);
      this.metrics.cleared += 1;
      if (this.targets.length === 0) {
        this.targets = this._spawnWave(5, 0.7);
        this.metrics.spawned += 5;
      }
    }
  }

  /** Raycasts from the crosshair (screen centre) into the scene, returns the index of the hit target in this.targets, or -1. */
  _raycastHit() {
    this.raycaster.setFromCamera(this.centerNDC, this.camera);
    const meshes = this.targets.map((t) => t.mesh);
    const hits = this.raycaster.intersectObjects(meshes, false);
    if (!hits.length) return -1;
    return meshes.indexOf(hits[0].object);
  }

  /** World-space direction for a yaw/pitch pair, where (0,0) is the
   * direction the camera faces at the start of every block (-Z, since
   * _startBlock recentres the view). */
  _dirFromAngles(yaw, pitch) {
    const cp = Math.cos(pitch);
    return new THREE.Vector3(-Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp);
  }

  _updateTracking(dtMs) {
    const t = this.targets[0];
    if (!t) return;
    this.trackPhase += dtMs / 1000;

    // These angles are WORLD-space on purpose. Deriving the position from
    // the current camera (unprojecting a screen coordinate) pinned the
    // target to the screen instead of the world: turning the mouse carried
    // the target along with the view, so it could never be tracked or
    // missed. It has to move independently of where you're looking.
    const yaw =
      Math.sin(this.trackPhase * 0.9) * TRACK_YAW_RANGE + Math.sin(this.trackPhase * 2.1) * TRACK_YAW_RANGE * 0.18;
    const pitch =
      Math.cos(this.trackPhase * 0.7) * TRACK_PITCH_RANGE + Math.cos(this.trackPhase * 1.7) * TRACK_PITCH_RANGE * 0.18;

    t.mesh.position.copy(this.camera.position).add(this._dirFromAngles(yaw, pitch).multiplyScalar(TARGET_DISTANCE));
    // Raycasting reads matrixWorld, which the renderer only refreshes on its
    // next render() - without this the on-target check would test where the
    // target was last frame, not where it just moved to.
    t.mesh.updateMatrixWorld();

    if (this._raycastHit() === 0) this.metrics.onTargetMs += dtMs;
  }

  _loop() {
    if (!this.running || this.paused) return;
    const now = performance.now();
    const dt = now - this.lastFrameTime;
    this.lastFrameTime = now;
    this.blockElapsedMs += dt;

    if (this.currentBlock.type === 'tracking') this._updateTracking(dt);

    this.renderer.render(this.scene, this.camera);

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
    // Set false *before* releasing the lock below - exitPointerLock() fires
    // a pointerlockchange event, and if sessionActive were still true that
    // would immediately re-trigger _pause() right as we're wrapping up.
    this.sessionActive = false;
    this.phase = 'idle';
    this.running = false;
    // Release the mouse so the results card is clickable, but stay fullscreen
    // until the user dismisses it via exit().
    if (document.exitPointerLock) document.exitPointerLock();
    this.stage.classList.add('show-cursor');
    this.onQueueComplete?.(this.results);
  }

  /** Common teardown for exit()/stop() - cancels anything that could still fire later and resurrect the drill after the caller thinks it's gone. */
  _resetState() {
    this.sessionActive = false;
    this.phase = 'idle';
    this.running = false;
    this.paused = false;
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = null;
    if (this.getReadyTimer) clearTimeout(this.getReadyTimer);
    this.getReadyTimer = null;
    this.el.getReady.classList.remove('active');
    this.el.pauseOverlay.classList.remove('active');
    this.stage.classList.remove('show-cursor');
    this._clearTargets();
  }

  exit() {
    this._resetState();
    if (document.exitPointerLock) document.exitPointerLock();
    if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
    this.overlay.classList.remove('active');
  }

  stop() {
    this._resetState();
    if (document.exitPointerLock) document.exitPointerLock();
    if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
    this.overlay.classList.remove('active');
  }
}
