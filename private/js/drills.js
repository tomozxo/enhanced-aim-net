import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js';

const DRILL_LABELS = { flick: 'FLICK', targets: 'TARGETS', tracking: 'TRACKING' };
const TARGET_DISTANCE = 44; // world units targets sit out in front of the camera
const CAMERA_HEIGHT = 12; // "elevated in the air" - eye height above the floor grid
const TRACK_YAW_RANGE = (22 * Math.PI) / 180; // how far the tracking target swings left/right
const TRACK_PITCH_RANGE = (7 * Math.PI) / 180;
// Flick/clear spawns: wide left-right, deliberately shallow up-down, so the
// drill is a horizontal flick exercise and never walks you into the floor.
const SPAWN_YAW_SPREAD = (30 * Math.PI) / 180;
const SPAWN_PITCH_RANGE = (7 * Math.PI) / 180;
const WALL_RADIUS = 92; // the grid room around you, well behind the targets at 44
const WALL_HEIGHT = 96; // floor at 0, ceiling at 96 - tall enough that the ceiling only shows at the top edge
const GRID_CELL = 8; // world units per grid square - about 5° across on the wall

// Target sizes are set by what's on screen, not fixed in the world: each
// target's angular radius is this fraction of the view's vertical FOV. Fixed
// sizes looked giant on narrow views - 4:3, FOV 60, and above all the 2.5x
// sight, which zoomed them to a sixth of the screen. Now a target is the
// same size on screen at any FOV, aspect ratio or zoom: at FOV 60 that's
// 0.8° / 0.65° / 0.75° of radius, about 2.7% of the screen height across
// for a flick target.
const TARGET_SIZE = { flick: 0.8 / 60, targets: 0.65 / 60, tracking: 0.75 / 60 };

// Each target has one ring splitting it into an inner circle and an outer
// band. Both are part of the target - a hit anywhere on it counts exactly
// the same. Where it landed is only recorded as a stat ("inner hits").
// This is the ring's midline, as a fraction of the target radius.
const INNER_FRACTION = 0.52;

// Targets drill: popping a dot brings a replacement in straight away, in a
// free spot inside the same area as the rest, so there are always this many
// up. A replacement keeps clear of the other dots, and of the crosshair so
// it can't land somewhere you'd hit without aiming.
const TARGETS_ON_SCREEN = 5;
const MIN_TARGET_GAP = (5 * Math.PI) / 180;
const MIN_CROSSHAIR_GAP = (6 * Math.PI) / 180;

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function rand(min, max) {
  return min + Math.random() * (max - min);
}

const HALF_PI = Math.PI / 2;
const PITCH_LIMIT = HALF_PI - 0.01;

export class DrillEngine {
  constructor({ overlayEl, stageEl, canvasEl, elements, onBlockComplete, onQueueComplete, onPauseChange, onStartError, onRawInputChange }) {
    this.overlay = overlayEl;
    this.stage = stageEl;
    this.canvas = canvasEl;
    this.el = elements; // { phaseLabel, timer, getReady, getReadyLabel, getReadyNum, pauseOverlay, pauseReason, resumeBtn }
    this.onBlockComplete = onBlockComplete;
    this.onQueueComplete = onQueueComplete;
    this.onPauseChange = onPauseChange;
    this.onStartError = onStartError;
    this.onRawInputChange = onRawInputChange;
    this.rawInput = null; // true = raw mouse counts, false = OS-adjusted, null = not captured yet

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
    this.targets = []; // { mesh, r, yaw, pitch } - r is the hit-test radius in world units
    this.metrics = null;
    this.blockElapsedMs = 0;
    this.blockDurationMs = 0;
    this.lastFrameTime = 0;
    this.rafId = null;
    this.trackPhase = 0;
    this.windowBlurredRecently = false;
    this._fitTargetArea(70, 16 / 9); // replaced with the real view on the first resize

    this._initScene();
    this._bindEvents();
    this.el.resumeBtn.addEventListener('click', () => this._requestLock());
  }

  // ---------- Three.js scene: a first-person view inside a gridded arena,
  // with ringed targets to flick onto and track. ----------
  _initScene() {
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x000000);
    // Light fog so the grid fades with distance instead of ending in a hard
    // line. Kept gentle - heavy fog just puts the void back.
    this.scene.fog = new THREE.FogExp2(0x000000, 0.0055);

    this.camera = new THREE.PerspectiveCamera(90, 1, 0.1, 500);
    this.camera.position.set(0, CAMERA_HEIGHT, 0);
    this.camera.rotation.order = 'YXZ';

    // Targets are unlit sprites (see _rebuildTargetMaterial) so they read as
    // a consistent bright colour from every angle - no scene lighting needed,
    // the grid surfaces don't react to lights either.

    // An enclosed room: floor, wall and ceiling all in the same black grid,
    // so wherever you look there's grid behind the targets - never a black
    // band. (The floor used to be a near-black void with thin grid lines, and
    // above the wall there was open black sky, which read as black bars
    // across the bottom and top of the screen.)
    // All three are opaque on purpose. As "transparent" materials they'd be
    // drawn after the targets, and each target sprite's see-through corners
    // would already have claimed that depth - leaving a dark square around
    // every target.
    // Tiled so every square is GRID_CELL across on all three surfaces.
    const wallRepeats = Math.round((2 * Math.PI * WALL_RADIUS) / GRID_CELL);
    const wall = new THREE.Mesh(
      new THREE.CylinderGeometry(WALL_RADIUS, WALL_RADIUS, WALL_HEIGHT, 96, 1, true),
      new THREE.MeshBasicMaterial({
        map: this._makeGridTexture(wallRepeats, WALL_HEIGHT / GRID_CELL),
        side: THREE.BackSide,
      })
    );
    wall.position.y = WALL_HEIGHT / 2;
    this.scene.add(wall);

    const capRepeats = (2 * WALL_RADIUS) / GRID_CELL;
    const capGeometry = new THREE.CircleGeometry(WALL_RADIUS, 96);
    const capMaterial = new THREE.MeshBasicMaterial({
      map: this._makeGridTexture(capRepeats, capRepeats),
      side: THREE.DoubleSide,
    });
    const floor = new THREE.Mesh(capGeometry, capMaterial);
    floor.rotation.x = -Math.PI / 2;
    this.scene.add(floor);
    const ceiling = new THREE.Mesh(capGeometry, capMaterial);
    ceiling.rotation.x = Math.PI / 2;
    ceiling.position.y = WALL_HEIGHT;
    this.scene.add(ceiling);

    // Scratch vectors for the per-frame aim test, so tracking doesn't
    // allocate two new vectors every frame.
    this._fwd = new THREE.Vector3();
    this._toTarget = new THREE.Vector3();
  }

  /** Procedural grid cell, tiled `repeatX` x `repeatY` times across a
   * surface - chosen per surface so the cells come out about the same size
   * on the wall, floor and ceiling. */
  _makeGridTexture(repeatX, repeatY) {
    const size = 128;
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, size, size);
    ctx.strokeStyle = '#3a3a3a';
    ctx.lineWidth = 3;
    ctx.strokeRect(0, 0, size, size);
    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(repeatX, repeatY);
    // Keeps the lines crisp on the floor and ceiling, which are seen at a
    // steep angle - without it they smear into a grey haze.
    tex.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
    return tex;
  }

  /** A bright purple disc with one white ring through it, separating an
   * inner circle from an outer band - a clear middle to aim for, while the
   * whole disc still counts as the target. */
  _makeTargetTexture() {
    const size = 256;
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const ctx = c.getContext('2d');
    const mid = size / 2;
    const R = mid - 1;
    const fill = cssVar('--target-fill') || '#c837ff';
    const disc = (r, color) => {
      ctx.beginPath();
      ctx.arc(mid, mid, r, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
    };
    const ringHalfWidth = 0.045;
    disc(R, fill);
    disc(R * (INNER_FRACTION + ringHalfWidth), '#ffffff');
    disc(R * (INNER_FRACTION - ringHalfWidth), fill);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  /** One shared material for every target in a run (rebuilt per run, so it
   * reads --target-fill after the stylesheet has loaded). A sprite always
   * faces the camera, so the ring never gets squashed into an ellipse
   * when it's off to one side. Flat and unlit, and fog:false keeps it full
   * brightness at any distance. */
  _rebuildTargetMaterial() {
    if (this.targetMaterial) {
      this.targetMaterial.map?.dispose();
      this.targetMaterial.dispose();
    }
    this.targetMaterial = new THREE.SpriteMaterial({
      map: this._makeTargetTexture(),
      fog: false,
      transparent: true,
      // Targets never need to hide anything behind them, so they don't write
      // depth - that way their see-through corners can't block the backdrop.
      depthWrite: false,
    });
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

  /** { game, tab, settings } - `game` is an entry from games.js, which owns
   * the game-specific parts: how a sens value becomes rotation, and what the
   * camera looks like. */
  configure(sensSettings) {
    this.sensSettings = sensSettings;
  }

  /** Where targets can appear, kept inside what's on screen. The fixed
   * ranges suit a normal field of view, but a 2.5x sight shows only ~36° of
   * the room, so its targets would spawn off-screen - flicks to dots you
   * can't see. These shrink to fit the view instead (never grow). */
  _fitTargetArea(vFovDeg, aspect) {
    const v = (vFovDeg * Math.PI) / 180;
    this.viewVFov = v; // what target sizes are measured against (_targetRadius)
    const h = 2 * Math.atan(Math.tan(v / 2) * aspect);
    const spawnYaw = Math.min(SPAWN_YAW_SPREAD, (0.8 * h) / 2);
    this.area = {
      spawnYaw,
      spawnPitch: Math.min(SPAWN_PITCH_RANGE, (0.6 * v) / 2),
      trackYaw: Math.min(TRACK_YAW_RANGE, (0.6 * h) / 2),
      trackPitch: Math.min(TRACK_PITCH_RANGE, (0.5 * v) / 2),
      targetGap: Math.min(MIN_TARGET_GAP, spawnYaw / 4),
      crosshairGap: Math.min(MIN_CROSSHAIR_GAP, spawnYaw / 3),
    };
  }

  _resizeCanvas() {
    if (!this.sensSettings) return; // window can resize before the first configure()/run()
    const stageRect = this.stage.getBoundingClientRect();
    const { game, settings, tab } = this.sensSettings;
    const { aspect: selected, vFovDeg, stretch, renderSize } = game.view(settings, tab);
    this._fitTargetArea(vFovDeg, selected);

    let w = stageRect.width;
    let h = stageRect.height;
    if (!stretch) {
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

    if (renderSize) {
      // Render at the chosen in-game resolution and let the browser scale it
      // to the canvas, the same way the GPU scales a stretched or black-bars
      // res up to your monitor - so 1280x960 stretched is as soft as in-game.
      this.renderer.setPixelRatio(1);
      this.renderer.setSize(renderSize.w, renderSize.h, false);
    } else {
      this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
      this.renderer.setSize(w, h, false);
    }
    // Always frame using the SELECTED in-game aspect, never the window's.
    // Using the canvas shape would render an undistorted native image even
    // when stretched, and the setting would do nothing.
    this.camera.aspect = selected;
    this.camera.fov = vFovDeg;
    this.camera.updateProjectionMatrix();
  }

  /** Swaps in the block's candidate sens value on top of the live settings, so each calibration block actually tests that candidate rather than whatever's live in the sidebar. */
  _effectiveSettings() {
    const { game, tab, settings } = this.sensSettings;
    const sens = this.currentCandidateSens;
    return sens == null ? settings : game.withCandidate(settings, tab, sens);
  }

  /** Radians of camera rotation per mouse count, from the game's own formula
   * (games.js). With raw input, one mouse count is one unit of movementX, so
   * this turns the camera exactly as far as the game would. */
  _rotationScale() {
    const { game, tab } = this.sensSettings;
    const d = game.degPerCount(tab, this._effectiveSettings());
    return { x: d.x * (Math.PI / 180), y: d.y * (Math.PI / 180) };
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
    // A run can start straight from the results screen ("Fine-tune further"),
    // which left the OS cursor showing - hide it again for aiming.
    this.stage.classList.remove('show-cursor');
    this._rebuildTargetMaterial();
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

  /**
   * Captures the mouse with raw input (`unadjustedMovement`): mouse counts
   * straight from the device, with no Windows pointer speed or "Enhance
   * pointer precision" applied - which is what Valorant and CS2 read too.
   * Only when the browser doesn't support raw input at all (Firefox, Safari)
   * does it fall back to a normal lock, and it reports that so the page can
   * warn about it.
   *
   * Any other refusal - most often Chrome's "you only just left the lock"
   * cooldown after pressing Esc - used to fall back too, which quietly turned
   * off raw input for the rest of the session after a pause. Now it just
   * reports failure and the pause screen stays up to click again.
   */
  async _lockPointer() {
    try {
      await this.canvas.requestPointerLock({ unadjustedMovement: true });
      this._setRawInput(true);
      return true;
    } catch (err) {
      if (err && err.name === 'NotSupportedError') {
        try {
          await this.canvas.requestPointerLock();
          this._setRawInput(false);
          return true;
        } catch (err2) {
          console.warn('[DrillEngine] pointer lock unavailable:', err2);
          return false;
        }
      }
      console.warn('[DrillEngine] pointer lock refused, click to try again:', err);
      return false;
    }
  }

  _setRawInput(raw) {
    if (this.rawInput === raw) return;
    this.rawInput = raw;
    this.onRawInputChange?.(raw);
  }

  async _requestLock() {
    this.el.pauseOverlay.classList.remove('active');
    const locked = await this._lockPointer();
    if (!locked) {
      // Without the mouse captured nothing registers, so running on would
      // just waste the round. Stay (or go back to being) paused.
      if (this.sessionActive) {
        this._pause('nolock');
      }
      return;
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
      reason === 'blur'
        ? 'Paused because the window lost focus.'
        : reason === 'nolock'
          ? "Your mouse wasn't captured. Click to try again."
          : 'Paused. Click to resume.';
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
    // If the mouse couldn't be captured at the start, this runs while paused;
    // the countdown starts once they click back in (see _requestLock).
    if (!this.paused) this._tickGetReady();
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
    this.metrics = {
      hits: 0, // anywhere on the target, inner circle or outer band
      innerHits: 0, // the subset that landed inside the ring
      clicks: 0,
      cleared: 0,
      onTargetMs: 0, // tracking: time the crosshair was anywhere on the dot
    };
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
      this.targets = [this._randomTarget(this._targetRadius('flick'))];
    } else if (block.type === 'targets') {
      // The area replacements spawn in stays put for the whole block, centred
      // on where you were facing when it started - so the group never slowly
      // wanders off to one side as you chase dots around.
      this.targetsAreaYaw = this.yaw;
      // Built one at a time with the same spacing rules as a replacement, so
      // the opening group can't overlap or start under the crosshair either.
      for (let i = 0; i < TARGETS_ON_SCREEN; i++) this.targets.push(this._replacementTarget(this._targetRadius('targets')));
    } else if (block.type === 'tracking') {
      this.targets = [this._targetAtAngles(0, 0, this._targetRadius('tracking'))];
    }
  }

  /** Spawns at a yaw offset from wherever you're currently looking (so it's
   * always on screen to flick to) but at an ABSOLUTE world pitch near eye
   * level. Pitch being absolute is the important part: taking it from the
   * current view meant every spawn inherited the last one's pitch, so
   * chasing a low target dragged the next one lower again and the whole
   * session gradually walked down into the floor. */
  _randomTarget(radius) {
    const yaw = this.yaw + rand(-this.area.spawnYaw, this.area.spawnYaw);
    return this._targetAtAngles(yaw, rand(-this.area.spawnPitch, this.area.spawnPitch), radius);
  }

  /** A replacement for a popped dot in the Targets drill: a random spot in
   * the same area as the rest of the group, clear of the other dots and of
   * the crosshair. Tries a handful of random spots and takes the first that
   * fits; with 5 small dots in a 60°-wide area one fits almost immediately,
   * and the fallback (the roomiest spot it saw) only matters in theory. */
  _replacementTarget(radius) {
    const angleBetween = (y1, p1, y2, p2) => Math.hypot((y1 - y2) * Math.cos((p1 + p2) / 2), p1 - p2);
    let best = null;
    for (let i = 0; i < 40; i++) {
      const yaw = this.targetsAreaYaw + rand(-this.area.spawnYaw, this.area.spawnYaw);
      const pitch = rand(-this.area.spawnPitch, this.area.spawnPitch);
      const gapToDots = Math.min(Infinity, ...this.targets.map((t) => angleBetween(yaw, pitch, t.yaw, t.pitch)));
      const gapToCrosshair = angleBetween(yaw, pitch, this.yaw, this.pitch);
      if (gapToDots >= this.area.targetGap && gapToCrosshair >= this.area.crosshairGap) {
        return this._targetAtAngles(yaw, pitch, radius);
      }
      const room = Math.min(gapToDots, gapToCrosshair);
      if (!best || room > best.room) best = { yaw, pitch, room };
    }
    return this._targetAtAngles(best.yaw, best.pitch, radius);
  }

  /** A target's radius in world units at TARGET_DISTANCE, sized to take up
   * the same share of the screen whatever the FOV or zoom (TARGET_SIZE). */
  _targetRadius(kind) {
    return TARGET_DISTANCE * Math.tan(TARGET_SIZE[kind] * this.viewVFov);
  }

  _targetAtAngles(yaw, pitch, radius) {
    const pos = this.camera.position.clone().add(this._dirFromAngles(yaw, pitch).multiplyScalar(TARGET_DISTANCE));

    // Sprite geometry is a unit quad, so the scale is the diameter.
    const mesh = new THREE.Sprite(this.targetMaterial);
    mesh.scale.set(radius * 2, radius * 2, 1);
    mesh.position.copy(pos);
    this.scene.add(mesh);
    return { mesh, r: radius, yaw, pitch };
  }

  _handleShoot() {
    const block = this.currentBlock;
    if (!block || (block.type !== 'flick' && block.type !== 'targets')) return;
    this.metrics.clicks += 1;
    const aimed = this._aimedTarget();
    if (!aimed) return;

    // Anywhere on the target is a hit - the outer band counts exactly the
    // same as the inner circle. Which one it was is only kept as a stat.
    this.metrics.hits += 1;
    if (aimed.offset <= INNER_FRACTION) this.metrics.innerHits += 1;

    if (block.type === 'flick') {
      this.scene.remove(this.targets[0].mesh);
      this.targets = [this._randomTarget(this._targetRadius('flick'))];
    } else {
      this.scene.remove(this.targets[aimed.index].mesh);
      this.targets.splice(aimed.index, 1);
      this.metrics.cleared += 1;
      this.targets.push(this._replacementTarget(this._targetRadius('targets')));
    }
  }

  /** How far the crosshair is from a target's centre, as a fraction of its
   * radius: 0 = dead centre, 1 = the rim, above 1 = off the target. The
   * crosshair is the camera's forward ray, so this is just the perpendicular
   * distance from the target's centre to that ray - the same test as
   * raycasting a sphere, but it also says whether you were inside the ring,
   * which a plain hit/miss raycast can't. */
  _offsetFor(target) {
    this.camera.getWorldDirection(this._fwd);
    this._toTarget.copy(target.mesh.position).sub(this.camera.position);
    const along = this._toTarget.dot(this._fwd);
    if (along <= 0) return Infinity; // behind you
    const perp = Math.sqrt(Math.max(0, this._toTarget.lengthSq() - along * along));
    return perp / target.r;
  }

  /** The target under the crosshair as { index, offset }, or null. If two
   * overlap, the one you're closer to the middle of wins. */
  _aimedTarget() {
    let best = null;
    this.targets.forEach((t, index) => {
      const offset = this._offsetFor(t);
      if (offset <= 1 && (!best || offset < best.offset)) best = { index, offset };
    });
    return best;
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
      Math.sin(this.trackPhase * 0.9) * this.area.trackYaw + Math.sin(this.trackPhase * 2.1) * this.area.trackYaw * 0.18;
    const pitch =
      Math.cos(this.trackPhase * 0.7) * this.area.trackPitch + Math.cos(this.trackPhase * 1.7) * this.area.trackPitch * 0.18;

    t.mesh.position.copy(this.camera.position).add(this._dirFromAngles(yaw, pitch).multiplyScalar(TARGET_DISTANCE));

    // Anywhere on the dot - inner circle or outer band - counts as on target.
    if (this._aimedTarget()) this.metrics.onTargetMs += dtMs;
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
    const m = this.metrics;
    const result = {
      type: block.type,
      candidateSens: block.candidateSens,
      scored: block.scored,
      flickHitsPerSec: block.type === 'flick' ? m.hits / elapsedSec : null,
      clearedPerSec: block.type === 'targets' ? m.cleared / elapsedSec : null,
      onTargetPct: block.type === 'tracking' ? m.onTargetMs / this.blockDurationMs : null,
      accuracy: m.clicks ? m.hits / m.clicks : null,
      hits: m.hits,
      innerHits: m.innerHits,
      clicks: m.clicks,
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
