// Recoil control: a first-person view down a shooting lane at a large paper
// target. Pick a gun and a distance, put the crosshair on the target's chest
// and hold the trigger; the gun's recoil (recoil.js) moves your aim and you
// pull it back with your own sens - hip-fire, or your ADS sens while you
// hold right-click. Eight full magazines, then a breakdown of where each
// part of the spray went wrong.
//
// No gun is drawn: it's just you, the crosshair and the target. Sens, FOV and
// ADS come from the same game models as everything else (games.js), so the
// mouse movement that holds a spray here is the one it takes in the game.

import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js';
import { DEFAULT_CROSSHAIR_COLOR, drawCrosshair, getCrosshair } from './crosshairs.js';
import { kickFor, coneFor, shotMs, scoreSpray, recoilAdvice } from './recoil.js';
import { gpuInfo } from './gpuCheck.js';

const DEG = Math.PI / 180;
const EYE = 1.62;
const AIM_Y = 1.35; // the mark on the target's chest
const SPRAYS = 8;
const RELOAD_MS = 900;
const MIN_SHOTS = 5; // a shorter burst isn't scored
const PITCH_LIMIT = 89 * DEG;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// The paper target: 1.6 m wide, 2.0 m tall, its bottom 0.15 m off the floor.
const PAPER = { w: 1.6, h: 2.0, y0: 0.15 };
const TEX_W = 640;
const TEX_H = 800;

/** Where a point on the paper (metres, from its bottom-left) is on the
 * silhouette - a head, neck, shoulders and torso, as on a range target. */
function onSilhouette(x, y) {
  // x from the paper's centre, y up from the floor.
  const head = Math.hypot(x, (y - 1.66) / 1.15) < 0.115;
  const neck = Math.abs(x) < 0.07 && y > 1.48 && y < 1.58;
  const shoulders = y > 1.3 && y <= 1.5 && Math.abs(x) < 0.26 - (y - 1.3) * 0.55;
  const torso = y > 0.75 && y <= 1.3 && Math.abs(x) < 0.26;
  return head || neck || shoulders || torso;
}

export class RecoilControl {
  /** el: { pause, pauseReason, results, resultsTitle, resultsSub,
   * resultsGrid, recoilRead, aim, getReady, getReadyLabel, getReadyNum,
   * hitmarker, hudMain, hudSub, ammo }. onFinish(summary). */
  constructor({ overlayEl, stageEl, canvasEl, el, onFinish, onRawInputChange }) {
    this.overlay = overlayEl;
    this.stage = stageEl;
    this.canvas = canvasEl;
    this.el = el;
    this.onFinish = onFinish;
    this.onRawInputChange = onRawInputChange;
    this.crosshairEl = stageEl.querySelector('.drill-crosshair');
    this.active = false;
    this.running = false;
    this.paused = false;
    this.rafId = null;
    this.built = false;
    this._bindEvents();
  }

  // ---------- The scene ----------

  _build() {
    if (this.built) return;
    this.built = true;
    const r = (this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, powerPreference: 'high-performance' }));
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 1.35;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0c0d0f);
    this.scene.fog = new THREE.Fog(0x16171a, 45, 110);
    this.camera = new THREE.PerspectiveCamera(70, 16 / 9, 0.05, 200);
    this.camera.rotation.order = 'YXZ';

    const tex = (w, h, draw, repeat = [1, 1]) => {
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      draw(c.getContext('2d'), w, h);
      const t = new THREE.CanvasTexture(c);
      t.colorSpace = THREE.SRGBColorSpace;
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.repeat.set(repeat[0], repeat[1]);
      t.anisotropy = r.capabilities.getMaxAnisotropy();
      return t;
    };
    const noise = (x, w, h, amount) => {
      const img = x.getImageData(0, 0, w, h);
      for (let i = 0; i < img.data.length; i += 4) {
        const n = (Math.random() - 0.5) * amount;
        img.data[i] += n;
        img.data[i + 1] += n;
        img.data[i + 2] += n;
      }
      x.putImageData(img, 0, 0);
    };
    // A long, dim indoor lane: concrete floor with a painted firing line,
    // dark block walls, a ceiling with strip lights down its length.
    const LEN = 70;
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(8, LEN),
      new THREE.MeshStandardMaterial({
        roughness: 0.85,
        map: tex(256, 256, (x, w, h) => {
          x.fillStyle = '#6a6b6c';
          x.fillRect(0, 0, w, h);
          noise(x, w, h, 26);
          x.fillStyle = 'rgba(20,20,20,0.6)';
          x.fillRect(0, 0, w, 2);
        }, [4, 35]),
      })
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(0, 0, -LEN / 2 + 3);
    this.scene.add(floor);
    const wallMat = new THREE.MeshStandardMaterial({
      roughness: 0.95,
      map: tex(256, 128, (x, w, h) => {
        x.fillStyle = '#5a5d62';
        x.fillRect(0, 0, w, h);
        x.strokeStyle = 'rgba(0,0,0,0.5)';
        for (let row = 0; row < 4; row++) for (let col = 0; col < 3; col++) x.strokeRect(col * 96 + (row % 2) * 48, row * 32, 96, 32);
        noise(x, w, h, 18);
      }, [LEN / 2, 2]),
    });
    for (const s of [-1, 1]) {
      const wall = new THREE.Mesh(new THREE.PlaneGeometry(LEN, 4.2), wallMat);
      wall.rotation.y = -s * Math.PI / 2;
      wall.position.set(s * 4, 2.1, -LEN / 2 + 3);
      this.scene.add(wall);
    }
    const ceil = new THREE.Mesh(new THREE.PlaneGeometry(8, LEN), new THREE.MeshStandardMaterial({ color: 0x3a3c40, roughness: 1 }));
    ceil.rotation.x = Math.PI / 2;
    ceil.position.set(0, 4.2, -LEN / 2 + 3);
    this.scene.add(ceil);
    const lineMat = new THREE.MeshStandardMaterial({ color: 0xc9a227, roughness: 0.7 });
    const line = new THREE.Mesh(new THREE.PlaneGeometry(8, 0.1), lineMat);
    line.rotation.x = -Math.PI / 2;
    line.position.set(0, 0.005, -0.8);
    this.scene.add(line);
    // Strip lights down the ceiling, and soft light over the target.
    const stripMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xf4f6ff, emissiveIntensity: 1.8 });
    for (let z = -2; z > -LEN + 3; z -= 6) {
      const s = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.04, 1.6), stripMat);
      s.position.set(0, 4.17, z);
      this.scene.add(s);
    }
    this.scene.add(new THREE.HemisphereLight(0xe8edf2, 0x3a3631, 2.4));
    this.targetLight = new THREE.SpotLight(0xfff1dc, 60, 0, 0.5, 0.6, 1.4);
    this.scene.add(this.targetLight, this.targetLight.target);

    // The target: paper on a frame, a hazard-striped base, a dark backstop.
    this.paperCanvas = document.createElement('canvas');
    this.paperCanvas.width = TEX_W;
    this.paperCanvas.height = TEX_H;
    this.paperTex = new THREE.CanvasTexture(this.paperCanvas);
    this.paperTex.colorSpace = THREE.SRGBColorSpace;
    this.paperTex.anisotropy = r.capabilities.getMaxAnisotropy();
    this._drawPaper();
    this.target = new THREE.Group();
    const paper = new THREE.Mesh(new THREE.PlaneGeometry(PAPER.w, PAPER.h), new THREE.MeshStandardMaterial({ map: this.paperTex, roughness: 0.9 }));
    paper.position.set(0, PAPER.y0 + PAPER.h / 2, 0);
    const frameMat = new THREE.MeshStandardMaterial({ color: 0x3a3c40, metalness: 0.6, roughness: 0.5 });
    for (const s of [-1, 1]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.05, PAPER.y0 + PAPER.h + 0.05, 0.05), frameMat);
      post.position.set(s * (PAPER.w / 2 + 0.03), (PAPER.y0 + PAPER.h) / 2, -0.03);
      this.target.add(post);
    }
    const stripes = tex(256, 32, (x, w, h) => {
      x.fillStyle = '#1b1b1b';
      x.fillRect(0, 0, w, h);
      x.fillStyle = '#e2b51c';
      for (let i = -2; i < 12; i++) {
        x.beginPath();
        x.moveTo(i * 32, h);
        x.lineTo(i * 32 + 16, h);
        x.lineTo(i * 32 + 32, 0);
        x.lineTo(i * 32 + 16, 0);
        x.fill();
      }
    });
    const base = new THREE.Mesh(new THREE.BoxGeometry(PAPER.w + 0.4, 0.14, 0.5), new THREE.MeshStandardMaterial({ map: stripes, roughness: 0.6 }));
    base.position.set(0, 0.07, 0);
    this.target.add(paper, base);
    this.backstop = new THREE.Mesh(new THREE.PlaneGeometry(8, 4.2), new THREE.MeshStandardMaterial({ color: 0x2a2b2d, roughness: 1 }));
    this.scene.add(this.target, this.backstop);
  }

  /** The paper: buff card, a black silhouette with white scoring rings
   * round the chest, a small mark to aim at; bullet holes punched into it as
   * you shoot. */
  _drawPaper() {
    const x = this.paperCanvas.getContext('2d');
    const W = TEX_W;
    const H = TEX_H;
    const px = (m) => (m / PAPER.w) * W; // metres across to pixels
    const py = (yWorld) => H - ((yWorld - PAPER.y0) / PAPER.h) * H; // world height to pixels
    x.fillStyle = '#d9cfb4';
    x.fillRect(0, 0, W, H);
    // Faint grid.
    x.strokeStyle = 'rgba(90,80,60,0.18)';
    x.lineWidth = 1;
    for (let i = 0; i <= 16; i++) {
      x.beginPath();
      x.moveTo((i / 16) * W, 0);
      x.lineTo((i / 16) * W, H);
      x.stroke();
    }
    for (let i = 0; i <= 20; i++) {
      x.beginPath();
      x.moveTo(0, (i / 20) * H);
      x.lineTo(W, (i / 20) * H);
      x.stroke();
    }
    // The silhouette, drawn by testing each pixel against the same shape the
    // hits are scored on, so what you see is exactly what counts.
    const img = x.getImageData(0, 0, W, H);
    for (let j = 0; j < H; j++) {
      const yWorld = PAPER.y0 + ((H - j) / H) * PAPER.h;
      for (let i = 0; i < W; i++) {
        const xm = (i / W - 0.5) * PAPER.w;
        if (onSilhouette(xm, yWorld)) {
          const k = (j * W + i) * 4;
          img.data[k] = img.data[k + 1] = img.data[k + 2] = 34 + Math.random() * 8;
        }
      }
    }
    x.putImageData(img, 0, 0);
    // Scoring rings round the chest mark, and the mark.
    x.strokeStyle = 'rgba(235,235,230,0.85)';
    x.lineWidth = 2;
    const cx = W / 2;
    const cy = py(AIM_Y);
    for (const r of [0.06, 0.12, 0.18, 0.24]) {
      x.beginPath();
      x.arc(cx, cy, px(r), 0, Math.PI * 2);
      x.stroke();
    }
    x.fillStyle = '#ff5a1f';
    x.beginPath();
    x.arc(cx, cy, px(0.018), 0, Math.PI * 2);
    x.fill();
    x.fillStyle = 'rgba(235,235,230,0.85)';
    x.font = `bold ${Math.round(px(0.04))}px Arial`;
    x.textAlign = 'center';
    for (const [r, n] of [[0.09, '9'], [0.15, '8'], [0.21, '7']]) x.fillText(n, cx, cy - px(r) + 5);
    this.paperTex.needsUpdate = true;
  }

  /** A bullet hole at (xm across from centre, yWorld up from the floor). */
  _hole(xm, yWorld) {
    if (Math.abs(xm) > PAPER.w / 2 || yWorld < PAPER.y0 || yWorld > PAPER.y0 + PAPER.h) return;
    const x = this.paperCanvas.getContext('2d');
    const i = (xm / PAPER.w + 0.5) * TEX_W;
    const j = TEX_H - ((yWorld - PAPER.y0) / PAPER.h) * TEX_H;
    const g = x.createRadialGradient(i, j, 0, i, j, 6);
    g.addColorStop(0, 'rgba(10,8,6,1)');
    g.addColorStop(0.45, 'rgba(10,8,6,0.95)');
    g.addColorStop(0.7, 'rgba(120,100,70,0.6)');
    g.addColorStop(1, 'rgba(120,100,70,0)');
    x.fillStyle = g;
    x.beginPath();
    x.arc(i, j, 6, 0, Math.PI * 2);
    x.fill();
    this.paperTex.needsUpdate = true;
  }

  _placeTarget(dist) {
    this.target.position.set(0, 0, -dist);
    this.backstop.position.set(0, 2.1, -dist - 1.5);
    this.targetLight.position.set(0, 4, -dist + 3);
    this.targetLight.target.position.set(0, 1.2, -dist);
  }

  // ---------- Input ----------

  _bindEvents() {
    document.addEventListener('pointerlockchange', () => {
      if (!this.active) return;
      if (document.pointerLockElement !== this.canvas && this.running && !this.paused) this._pause();
    });
    window.addEventListener('blur', () => {
      if (this.active && this.running && !this.paused) this._pause();
    });
    document.addEventListener('mousemove', (e) => {
      if (!this.running || this.paused || document.pointerLockElement !== this.canvas) return;
      this._look(e.movementX, e.movementY);
    });
    document.addEventListener('mousedown', (e) => {
      if (!this.running || this.paused || document.pointerLockElement !== this.canvas) return;
      if (e.button === 0) this.trigger = true;
      if (e.button === 2) this._adsButton(true);
    });
    document.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.trigger = false;
      if (e.button === 2) this._adsButton(false);
    });
    this.overlay.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('resize', () => this.active && this._resize());
  }

  _adsButton(down) {
    if (!this.sight) return;
    if (this.cfg.adsMode === 'toggle') {
      if (down && this.running && !this.paused) this.adsWant = !this.adsWant;
    } else this.adsWant = down && this.running && !this.paused;
  }

  _aimed() {
    return !!(this.sight && this.adsWant);
  }

  _scale() {
    return this._aimed() ? this.scaleAds : this.scaleHip;
  }

  _look(mx, my) {
    const s = this._scale();
    this.yaw -= mx * s.x;
    this.pitch = clamp(this.pitch - my * s.y, -PITCH_LIMIT, PITCH_LIMIT);
  }

  async _lock() {
    const within = (p) => Promise.race([p, new Promise((_, no) => setTimeout(() => no(new Error('timeout')), 1500))]);
    try {
      await within(this.canvas.requestPointerLock({ unadjustedMovement: true }));
      this.onRawInputChange?.(true);
      return true;
    } catch (err) {
      if (err && err.name === 'NotSupportedError') {
        try {
          await within(this.canvas.requestPointerLock());
          this.onRawInputChange?.(false);
          return true;
        } catch {
          return false;
        }
      }
      return false;
    }
  }

  // ---------- Starting, pausing, leaving ----------

  /** cfg: { game, tab, settings, sens, sensLabel, gun, distance, sight,
   * adsMode }. */
  async start(cfg) {
    this._build();
    this.cfg = cfg;
    this.gun = cfg.gun;
    const { game, tab, settings } = cfg;
    const d = game.degPerCount(tab, settings);
    this.scaleHip = { x: d.x * DEG, y: d.y * DEG };
    this.sight = ((game.ads && game.ads.sights) || []).find((s) => s.id === cfg.sight) || null;
    if (this.sight) {
      const a = game.ads.degPerCount(settings, this.sight.id);
      this.scaleAds = { x: a.x * DEG, y: a.y * DEG };
      this.adsVFov = game.ads.view(settings, this.sight.id);
    } else {
      this.scaleAds = this.scaleHip;
      this.adsVFov = null;
    }
    this._placeTarget(cfg.distance);
    this._drawPaper();
    this.yaw = 0;
    this.pitch = Math.atan2(AIM_Y - EYE, cfg.distance);
    this.adsWant = false;
    this.trigger = false;
    this.kicks = [];
    this.spray = null;
    this.ammo = this.gun.mag;
    this.reloadUntil = 0;
    this.lastShot = 0;
    this.run = { sprays: [], started: performance.now() };
    this.active = true;
    this.overlay.classList.add('active');
    this.stage.classList.remove('show-cursor');
    this.el.results.classList.remove('active');
    this.el.pause.classList.remove('active');
    this.renderScale = gpuInfo().software ? 0.5 : 1;
    this.frameTimes = [];
    this.overlay.dataset.wantFs = '1';
    try {
      if (this.overlay.requestFullscreen) await this.overlay.requestFullscreen();
    } catch {
      /* windowed is fine */
    }
    this._resize();
    const locked = await this._lock();
    this.running = true;
    this.paused = false;
    if (!locked) this._pause('nolock');
    this.lastFrame = performance.now();
    if (!this.rafId) this._frame();
  }

  _pause(reason) {
    this.paused = true;
    this.trigger = false;
    this.adsWant = false;
    this.stage.classList.add('show-cursor');
    this.el.pauseReason.textContent = reason === 'nolock' ? "Your mouse wasn't captured. Click Resume to try again." : 'Paused. Click Resume to carry on.';
    this.el.pause.classList.add('active');
  }

  async resume() {
    this.el.pause.classList.remove('active');
    if (this.overlay.dataset.wantFs !== '0' && !document.fullscreenElement) {
      try {
        await this.overlay.requestFullscreen?.();
      } catch {
        /* windowed */
      }
      this._resize();
    }
    if (!(await this._lock())) {
      this._pause('nolock');
      return;
    }
    this.paused = false;
    this.stage.classList.remove('show-cursor');
    this.lastFrame = performance.now();
  }

  exit() {
    this.active = false;
    this.running = false;
    this.paused = false;
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = null;
    this.el.pause.classList.remove('active');
    this.el.results.classList.remove('active');
    if (document.pointerLockElement === this.canvas) document.exitPointerLock();
    if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
    this.overlay.classList.remove('active');
  }

  // ---------- Shooting ----------

  _tryFire(now) {
    if (!this.running || this.paused || now < this.reloadUntil || this.ammo <= 0) return;
    if (this.run.sprays.length >= SPRAYS) return;
    if (now - this.lastShot < shotMs(this.gun) - 2) return;
    this._fire(now);
  }

  _fire(now) {
    // A new spray if the trigger's been off long enough for recoil to reset.
    if (!this.spray || now - this.lastShot > this.gun.reset * 1000) {
      if (this.spray) this._endSpray();
      this._drawPaper();
      this.spray = { shots: [], applied: [[0, 0]], first: null, aimed: 0 };
    }
    const sp = this.spray;
    const index = sp.shots.length;
    const aimed = this._aimed();
    this.lastShot = now;
    this.ammo--;
    // Where this bullet goes: the view direction, plus a random point in
    // the gun's cone for this shot.
    const cone = coneFor(this.gun, index, aimed) * DEG;
    const a = Math.sqrt(Math.random()) * (cone / 2);
    const t = Math.random() * Math.PI * 2;
    const yaw = this.yaw - Math.cos(t) * a;
    const pitch = this.pitch + Math.sin(t) * a;
    // Its impact on the target's plane.
    const dist = this.cfg.distance;
    const dz = Math.cos(pitch) * Math.cos(yaw);
    let hit = false;
    if (dz > 0) {
      const tRay = dist / dz;
      const xm = -Math.sin(yaw) * Math.cos(pitch) * tRay;
      const ym = EYE + Math.sin(pitch) * tRay;
      hit = onSilhouette(xm, ym);
      this._hole(xm, ym);
      if (hit) this._hitmarker();
    }
    if (!sp.first) sp.first = { yaw, pitch };
    sp.shots.push({ dx: -(yaw - sp.first.yaw) / DEG, dy: (pitch - sp.first.pitch) / DEG, hit });
    if (aimed) sp.aimed++;
    // The kick before the next shot: moves your aim, eased in over the
    // gun's time-to-take.
    const k = kickFor(this.gun, index, aimed);
    const last = sp.applied[sp.applied.length - 1];
    sp.applied.push([last[0] + k.yaw, last[1] + k.pitch]);
    this.kicks.push({ yaw: -k.yaw * DEG, pitch: k.pitch * DEG, t: 0, dur: this.gun.take * 1000 });
    if (this.ammo <= 0) this._endSpray();
  }

  _hitmarker() {
    const m = this.el.hitmarker;
    if (!m) return;
    m.classList.remove('show');
    void m.offsetWidth;
    m.classList.add('show');
  }

  _endSpray() {
    const sp = this.spray;
    this.spray = null;
    if (!sp) return;
    const run = this.run;
    if (sp.shots.length >= MIN_SHOTS) {
      run.sprays.push({ shots: sp.shots, applied: sp.applied, aimed: sp.aimed, score: scoreSpray(sp.shots, sp.applied, this.cfg.distance) });
    }
    if (this.ammo < this.gun.mag) {
      this.reloadUntil = performance.now() + RELOAD_MS;
      this.ammo = this.gun.mag;
    }
    if (run.sprays.length >= SPRAYS) {
      this.trigger = false;
      setTimeout(() => this.active && this.run === run && this._finish(), 600);
    }
  }

  _finish() {
    const sprays = this.run.sprays;
    const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
    const controls = sprays.map((s) => s.score.control).filter((v) => v != null);
    const shots = sprays.reduce((n, s) => n + s.shots.length, 0);
    const aimed = sprays.reduce((n, s) => n + s.aimed, 0);
    const advice = recoilAdvice(sprays, this.cfg.distance);
    const summary = {
      kind: 'recoil',
      date: Date.now(),
      game: this.cfg.game.id,
      gun: this.gun.id,
      gunName: this.gun.name,
      fitted: this.gun.fitted || [],
      distance: this.cfg.distance,
      sens: this.cfg.sens,
      sprays: sprays.length,
      control: mean(controls),
      bestControl: controls.length ? Math.max(...controls) : null,
      onTarget: mean(sprays.map((s) => s.score.onTarget)),
      groupCm: mean(sprays.map((s) => s.score.groupCm)),
      adsShare: shots ? aimed / shots : 0,
      advice: advice && { title: advice.title, text: advice.text, tone: advice.tone },
    };
    this.running = false;
    this.trigger = false;
    if (document.pointerLockElement === this.canvas) document.exitPointerLock();
    this.stage.classList.add('show-cursor');
    this._showResults(summary, sprays);
    this.onFinish?.(summary);
  }

  _showResults(s, sprays) {
    const pct = (v) => (v == null || !isFinite(v) ? '—' : `${Math.round(v * 100)}%`);
    this.el.resultsTitle.textContent = `${s.gunName} · ${s.distance} m`;
    if (s.fitted.length) this.el.resultsTitle.textContent += ` · ${s.fitted.join(', ')}`;
    this.el.resultsSub.textContent = `${this.cfg.sensLabel} · ${s.sprays} sprays${this.sight ? ` · ${Math.round(s.adsShare * 100)}% of shots aimed` : ''}`;
    const tiles = [
      ['Recoil controlled', pct(s.control)],
      ['Bullets on target', pct(s.onTarget)],
      ['Spread from first shot', s.groupCm == null ? '—' : `${Math.round(s.groupCm)} cm`],
      ['Best spray', pct(s.bestControl)],
    ];
    this.el.resultsGrid.innerHTML = tiles.map(([k, v]) => `<div class="range-tile"><div class="stat-label">${k}</div><div class="stat-value">${v}</div></div>`).join('');
    const box = this.el.recoilRead;
    box.hidden = false;
    box.innerHTML = `${this._chart(sprays)}${s.advice ? `<div class="recoil-advice ${s.advice.tone}"><b>${s.advice.title}</b><span>${s.advice.text}</span></div>` : ''}`;
    this.el.results.classList.add('active');
  }

  /** The spray in degrees from your first shot: the recoil you were given
   * (if you hadn't pulled) against where your bullets went, averaged over
   * the sprays. */
  _chart(sprays) {
    const r1 = (v) => Math.round(v * 10) / 10;
    const n = Math.max(...sprays.map((s) => s.shots.length));
    const avg = (get) =>
      Array.from({ length: n }, (_, k) => {
        const vs = sprays.filter((s) => s.shots.length > k).map((s) => get(s, k));
        return vs.length ? vs.reduce((a, b) => a + b, 0) / vs.length : 0;
      });
    const pat = { x: avg((s, k) => s.applied[k][0]), y: avg((s, k) => s.applied[k][1]) };
    const you = { x: avg((s, k) => s.shots[k].dx), y: avg((s, k) => s.shots[k].dy) };
    const halfW = Math.max(1.5, ...[...pat.x, ...you.x].map(Math.abs)) * 1.15;
    const top = Math.max(2, ...pat.y, ...you.y) * 1.08;
    const bottom = Math.max(1, ...you.y.map((v) => -v)) * 1.15;
    const W = 300;
    const H = 260;
    const scale = Math.min(W / 2 / halfW, H / (top + bottom));
    const px = (x) => r1(W / 2 + x * scale);
    const py = (y) => r1((top - y) * scale);
    const line = (xs, ys) => xs.map((x, k) => `${px(x)},${py(ys[k])}`).join(' ');
    return `<div class="rc-charts rc-single"><figure><figcaption>The spray, from your first shot (degrees)</figcaption>
      <svg viewBox="0 0 ${W} ${r1((top + bottom) * scale)}" class="rc-svg" role="img" aria-label="The recoil against your spray">
        <line x1="${px(-halfW)}" x2="${px(halfW)}" y1="${py(0)}" y2="${py(0)}" class="rc-axis"/>
        <line x1="${px(0)}" x2="${px(0)}" y1="${py(top)}" y2="${py(-bottom)}" class="rc-axis"/>
        <polyline points="${line(pat.x, pat.y)}" class="rc-pat"/>
        <polyline points="${line(you.x, you.y)}" class="rc-you"/>
        ${you.x.map((x, k) => `<circle cx="${px(x)}" cy="${py(you.y[k])}" r="2" class="rc-you-dot"/>`).join('')}
      </svg><div class="rc-key"><i class="k-pat"></i>If you don't pull <i class="k-you"></i>Yours</div></figure></div>`;
  }

  // ---------- Each frame ----------

  _frame() {
    this.rafId = requestAnimationFrame(() => this._frame());
    const now = performance.now();
    const dt = Math.min(0.05, (now - this.lastFrame) / 1000);
    this._adapt(now - this.lastFrame);
    this.lastFrame = now;
    if (!this.active) return;
    if (this.running && !this.paused) {
      if (this.trigger) this._tryFire(now);
      // The spray's over when the trigger's been off long enough.
      if (this.spray && !this.trigger && now - this.lastShot > this.gun.reset * 1000) this._endSpray();
    }
    // Kicks ease into your aim.
    if (this.kicks.length) {
      const ease = (k) => 1 - (1 - k) * (1 - k);
      for (const k of this.kicks) {
        const k0 = Math.min(1, k.t / k.dur);
        k.t += dt * 1000;
        const f = ease(Math.min(1, k.t / k.dur)) - ease(k0);
        this.yaw += k.yaw * f;
        this.pitch = clamp(this.pitch + k.pitch * f, -PITCH_LIMIT, PITCH_LIMIT);
      }
      this.kicks = this.kicks.filter((k) => k.t < k.dur);
    }
    const fov = this._aimed() && this.adsVFov ? this.adsVFov : this.hipVFov;
    if (Math.abs(this.camera.fov - fov) > 1e-4) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
    this.camera.position.set(0, EYE, 0);
    this.camera.rotation.set(this.pitch, this.yaw, 0);
    this.renderer.render(this.scene, this.camera);
    this._hud(now);
  }

  _hud(now) {
    const e = this.el;
    const done = this.run.sprays.length;
    e.hudMain.textContent = `${this.gun.name} · ${this.cfg.distance} m`;
    e.hudSub.textContent = done >= SPRAYS ? 'Done' : this.spray ? `Spray ${done + 1} of ${SPRAYS} · ${this.spray.shots.length} / ${this.gun.mag}` : `Spray ${done + 1} of ${SPRAYS} · hold to empty the magazine on the mark`;
    e.ammo.textContent = now < this.reloadUntil ? 'Reloading' : `${this.ammo} / ${this.gun.mag}`;
  }

  /** Frame rate first: a slow GPU gets a lower internal resolution. */
  _adapt(ms) {
    if (this.paused || !this.running) return;
    this.frameTimes.push(ms);
    if (this.frameTimes.length < 45) return;
    const s = [...this.frameTimes].sort((a, b) => a - b);
    const typical = s[Math.floor(s.length * 0.6)];
    this.frameTimes.length = 0;
    const cur = this.renderScale;
    const next = typical > 19 ? Math.max(0.5, cur - 0.15) : typical < 12 && cur < 1 ? Math.min(1, cur + 0.05) : cur;
    if (next !== cur) {
      this.renderScale = next;
      this._resize();
    }
  }

  // ---------- Sizing ----------

  _resize() {
    if (!this.built || !this.cfg) return;
    const { game, tab, settings } = this.cfg;
    const view = game.view(settings, tab);
    const rect = this.stage.getBoundingClientRect();
    let w = rect.width;
    let h = rect.height;
    if (!(w > 0 && h > 0)) return;
    if (!view.stretch) {
      if (w / h > view.aspect) w = h * view.aspect;
      else h = w / view.aspect;
    }
    Object.assign(this.canvas.style, { position: 'absolute', width: `${w}px`, height: `${h}px`, left: `${(rect.width - w) / 2}px`, top: `${(rect.height - h) / 2}px` });
    const scale = this.renderScale || 1;
    if (view.renderSize) {
      this.renderer.setPixelRatio(1);
      this.renderer.setSize(Math.round(view.renderSize.w * scale), Math.round(view.renderSize.h * scale), false);
    } else {
      this.renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5) * scale);
      this.renderer.setSize(w, h, false);
    }
    this.camera.aspect = view.aspect;
    this.hipVFov = view.vFovDeg;
    this.camera.fov = view.vFovDeg;
    this.camera.updateProjectionMatrix();
    this._drawCrosshair(w, h, view.aspect, view.stretch);
  }

  _drawCrosshair(w, h, selected, stretch) {
    const el = this.crosshairEl;
    if (!el) return;
    if (!this.crosshairCanvas) {
      this.crosshairCanvas = document.createElement('canvas');
      el.appendChild(this.crosshairCanvas);
      el.classList.add('drawn');
    }
    const settings = this.cfg.settings;
    const dpr = window.devicePixelRatio || 1;
    const size = drawCrosshair(this.crosshairCanvas, getCrosshair(settings.crosshair), settings.crosshairColor || DEFAULT_CROSSHAIR_COLOR, (h * dpr) / 1080);
    const devW = Math.round(size * (stretch ? w / h / selected : 1));
    const stage = this.stage.getBoundingClientRect();
    el.style.width = `${devW / dpr}px`;
    el.style.height = `${size / dpr}px`;
    el.style.left = `${Math.round((stage.width * dpr - devW) / 2) / dpr}px`;
    el.style.top = `${Math.round((stage.height * dpr - size) / 2) / dpr}px`;
  }
}
