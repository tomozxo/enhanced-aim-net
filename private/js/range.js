// The Range: a walk-around 3D shooting range with pop-up training dummies
// and a rifle, for flicking onto real heads at real distances.
//
// Modelled on the practice ranges in the games themselves (checked
// September 2026): Valorant's range marks 5, 10, 20, 30 and 50 m and pops
// bots up to shoot; Siege's shooting range has lanes at 5-30 m with
// silhouettes and dummies; Apex and Call of Duty ranges use dummies that
// stand or strafe at marked distances. So this is an outdoor range with a
// covered firing line, lanes, distance markers, cover in the field and
// dummies about 1.8 m tall with a real-sized head (21 cm wide, 24 cm tall).
//
// Everything is in metres. The sens and FOV come from the same game models
// as the drills (games.js), so a flick here turns exactly as far as it
// would in the game. Movement follows CS2 with a rifle: about 5.5 m/s
// running, just over half that walking.
//
// Nothing is loaded from outside: every texture is painted on a canvas.

import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js';
import { DEFAULT_CROSSHAIR_COLOR, drawCrosshair, getCrosshair } from './crosshairs.js';
import { analyseFlick, summariseFlicks, verdictFor, AIM_VERDICTS } from './calibration.js';

const DEG = Math.PI / 180;

// Player
const EYE = 1.62;
const EYE_CROUCH = 1.16;
const SPEED = { run: 5.5, walk: 3.0, crouch: 1.9 };
const ACCEL = 45; // m/s² towards the wanted speed - snappy, like CS/Valorant
const GRAVITY = 20;
const JUMP_SPEED = 6.2;
const PLAYER_R = 0.3;
const PITCH_LIMIT = 89 * DEG;

// Rifle
const FIRE_MS = 100; // 600 rounds a minute
const MAG_SIZE = 30;
const RELOAD_MS = 2100;

// Dummies
const HEAD_R = 0.105; // 21 cm wide
const HEAD_Y = 1.67;
const STRAFE_SPEED = 3.0;

// Head test
const TEST_DUMMIES = 30;
const TEST_DISTANCES = { close: [8, 14], mid: [14, 24], far: [24, 38], mixed: [8, 38] };
const TEST_FLICK = { min: 4 * DEG, max: 24 * DEG }; // like the flick check
const TEST_MAX_CM = 7;

// The layout: firing line at z = 0, downrange is -z.
const LANE_W = 3.2;
const LANES = 8;
const BAY_HALF = (LANE_W * LANES) / 2 + 2.4; // 15.2
const FIELD_END = -60;
const BOUNDS = { xMin: -BAY_HALF + PLAYER_R, xMax: BAY_HALF - PLAYER_R, zMin: FIELD_END + 2.6, zMax: 9.4 };
const TARGET_AREA = { xMin: -13.4, xMax: 13.4, zMin: -54, zMax: -5 };

const rand = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const wrapPi = (a) => Math.atan2(Math.sin(a), Math.cos(a));

// ---------- Painted textures ----------

function canvas(size = 512) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  return c;
}

/** Fine per-pixel grain, ±amount on each channel. */
function grain(ctx, size, amount) {
  const img = ctx.getImageData(0, 0, size, size);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (Math.random() - 0.5) * amount;
    d[i] += n;
    d[i + 1] += n;
    d[i + 2] += n;
  }
  ctx.putImageData(img, 0, 0);
}

/** Soft blotches - the slow variation real surfaces have. Drawn wrapped, so
 * the texture tiles without a seam. */
function blotches(ctx, size, count, rMin, rMax, colors, alpha) {
  for (let i = 0; i < count; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    const r = rand(rMin, rMax);
    const col = colors[(Math.random() * colors.length) | 0];
    for (const ox of [-size, 0, size]) {
      for (const oy of [-size, 0, size]) {
        const g = ctx.createRadialGradient(x + ox, y + oy, 0, x + ox, y + oy, r);
        g.addColorStop(0, col.replace('A', alpha));
        g.addColorStop(1, col.replace('A', 0));
        ctx.fillStyle = g;
        ctx.fillRect(x + ox - r, y + oy - r, r * 2, r * 2);
      }
    }
  }
}

function dots(ctx, size, count, rMin, rMax, colors) {
  for (let i = 0; i < count; i++) {
    ctx.fillStyle = colors[(Math.random() * colors.length) | 0];
    ctx.beginPath();
    ctx.arc(Math.random() * size, Math.random() * size, rand(rMin, rMax), 0, Math.PI * 2);
    ctx.fill();
  }
}

function cracks(ctx, size, count, color) {
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  for (let i = 0; i < count; i++) {
    let x = Math.random() * size;
    let y = Math.random() * size;
    let a = Math.random() * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(x, y);
    const steps = 6 + ((Math.random() * 10) | 0);
    for (let k = 0; k < steps; k++) {
      a += rand(-0.7, 0.7);
      x += Math.cos(a) * rand(4, 14);
      y += Math.sin(a) * rand(4, 14);
      ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
}

// ---------- The engine ----------

export class RangeEngine {
  /**
   * overlayEl/stageEl/canvasEl: the fullscreen overlay, the stage inside it
   * and the canvas. el: the HUD and card elements (see app.html).
   * onFinish(summary): a head test finished. onRawInputChange(raw).
   */
  constructor({ overlayEl, stageEl, canvasEl, el, onFinish, onRawInputChange }) {
    this.overlay = overlayEl;
    this.stage = stageEl;
    this.canvas = canvasEl;
    this.el = el;
    this.onFinish = onFinish;
    this.onRawInputChange = onRawInputChange;
    this.built = false;
    this.active = false;
    this.running = false;
    this.paused = false;
    this.keys = new Set();
    this.rafId = null;
    this._bindEvents();
  }

  // ---------- Setting up ----------

  _build() {
    if (this.built) return;
    this.built = true;
    const r = (this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, powerPreference: 'high-performance' }));
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 1.0;
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFSoftShadowMap;
    // Nothing that casts a shadow ever moves, so the shadows are drawn once.
    r.shadowMap.autoUpdate = false;
    r.autoClear = false;
    this.maxAniso = r.capabilities.getMaxAnisotropy();

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.FogExp2(0xc9d6e2, 0.003);
    this.camera = new THREE.PerspectiveCamera(70, 16 / 9, 0.05, 900);
    this.camera.rotation.order = 'YXZ';

    this.solids = []; // meshes a bullet stops on
    this.colliders = []; // { x0, x1, z0, z1 } the player can't walk through

    this._buildTextures();
    this._buildSky();
    this._buildLights();
    this._buildGround();
    this._buildBay();
    this._buildField();
    this._buildSurroundings();
    this._buildDummyParts();
    this._buildViewmodel();
    this._buildEffects();

    this.renderer.shadowMap.needsUpdate = true;
  }

  _tex(c, repeatX = 1, repeatY = repeatX, srgb = true) {
    const t = new THREE.CanvasTexture(c);
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(repeatX, repeatY);
    t.anisotropy = this.maxAniso;
    return t;
  }

  _buildTextures() {
    const T = (this.tex = {});

    // Poured concrete slabs for the covered bay: 4 m squares with sawn
    // joints, trowel marks, stains and hairline cracks.
    {
      const c = canvas(512);
      const x = c.getContext('2d');
      x.fillStyle = '#8f8d88';
      x.fillRect(0, 0, 512, 512);
      blotches(x, 512, 26, 40, 140, ['rgba(70,68,64,A)', 'rgba(170,168,160,A)'], 0.18);
      blotches(x, 512, 10, 20, 60, ['rgba(60,55,50,A)'], 0.12);
      cracks(x, 512, 5, 'rgba(50,48,45,0.35)');
      grain(x, 512, 22);
      x.fillStyle = 'rgba(40,40,38,0.75)';
      x.fillRect(0, 0, 512, 3);
      x.fillRect(0, 0, 3, 512);
      T.slab = c;
    }
    // Cast concrete wall panels: formwork seams and the rows of tie holes
    // real poured walls have.
    {
      const c = canvas(512);
      const x = c.getContext('2d');
      x.fillStyle = '#a3a19b';
      x.fillRect(0, 0, 512, 512);
      blotches(x, 512, 30, 30, 120, ['rgba(80,78,72,A)', 'rgba(190,188,182,A)'], 0.16);
      for (let i = 0; i < 40; i++) {
        // water streaks running down
        const sx = Math.random() * 512;
        const g = x.createLinearGradient(sx, 0, sx, 512);
        g.addColorStop(0, 'rgba(60,60,58,0.14)');
        g.addColorStop(1, 'rgba(60,60,58,0)');
        x.fillStyle = g;
        x.fillRect(sx, rand(0, 200), rand(2, 7), rand(120, 400));
      }
      grain(x, 512, 20);
      x.fillStyle = 'rgba(55,55,52,0.7)';
      x.fillRect(0, 0, 3, 512);
      x.fillRect(0, 254, 512, 2);
      for (const ty of [80, 176, 336, 432]) {
        for (const tx of [96, 256, 416]) {
          x.fillStyle = 'rgba(40,40,40,0.8)';
          x.beginPath();
          x.arc(tx, ty, 5, 0, Math.PI * 2);
          x.fill();
          x.fillStyle = 'rgba(150,148,142,0.8)';
          x.beginPath();
          x.arc(tx - 1, ty - 1, 2, 0, Math.PI * 2);
          x.fill();
        }
      }
      T.wall = c;
    }
    // Downrange: packed dirt and gravel.
    {
      const c = canvas(512);
      const x = c.getContext('2d');
      x.fillStyle = '#86765f';
      x.fillRect(0, 0, 512, 512);
      blotches(x, 512, 40, 30, 110, ['rgba(95,80,60,A)', 'rgba(150,135,110,A)', 'rgba(110,100,80,A)'], 0.28);
      dots(x, 512, 2600, 0.6, 2.2, ['rgba(60,52,42,0.55)', 'rgba(170,160,140,0.5)', 'rgba(120,110,95,0.5)']);
      grain(x, 512, 26);
      T.dirt = c;
    }
    // Grass outside the walls.
    {
      const c = canvas(512);
      const x = c.getContext('2d');
      x.fillStyle = '#5e6b40';
      x.fillRect(0, 0, 512, 512);
      blotches(x, 512, 40, 40, 140, ['rgba(80,95,50,A)', 'rgba(110,112,70,A)', 'rgba(60,70,38,A)'], 0.3);
      for (let i = 0; i < 9000; i++) {
        x.strokeStyle = Math.random() < 0.5 ? 'rgba(90,110,55,0.5)' : 'rgba(55,65,35,0.45)';
        const px = Math.random() * 512;
        const py = Math.random() * 512;
        x.beginPath();
        x.moveTo(px, py);
        x.lineTo(px + rand(-2, 2), py - rand(3, 8));
        x.stroke();
      }
      grain(x, 512, 18);
      T.grass = c;
    }
    // Planks for the benches, crates and wood.
    {
      const c = canvas(512);
      const x = c.getContext('2d');
      x.fillStyle = '#8a6a48';
      x.fillRect(0, 0, 512, 512);
      for (let p = 0; p < 4; p++) {
        const y0 = p * 128;
        x.fillStyle = ['#8d6c49', '#7f6141', '#94724e', '#86674a'][p];
        x.fillRect(0, y0, 512, 128);
        for (let i = 0; i < 40; i++) {
          x.strokeStyle = `rgba(60,40,22,${rand(0.08, 0.25)})`;
          x.lineWidth = rand(0.6, 1.6);
          x.beginPath();
          let yy = y0 + rand(4, 124);
          x.moveTo(0, yy);
          for (let xx = 0; xx <= 512; xx += 32) {
            yy += rand(-1.2, 1.2);
            x.lineTo(xx, yy);
          }
          x.stroke();
        }
        x.fillStyle = 'rgba(40,28,16,0.6)';
        x.fillRect(0, y0, 512, 2);
      }
      grain(x, 512, 16);
      T.wood = c;
    }
    // Painted steel, worn at the edges.
    {
      const c = canvas(256);
      const x = c.getContext('2d');
      x.fillStyle = '#5b5f63';
      x.fillRect(0, 0, 256, 256);
      blotches(x, 256, 20, 10, 60, ['rgba(40,42,45,A)', 'rgba(120,125,128,A)'], 0.2);
      for (let i = 0; i < 60; i++) {
        x.strokeStyle = 'rgba(170,170,170,0.18)';
        x.beginPath();
        const px = Math.random() * 256;
        const py = Math.random() * 256;
        x.moveTo(px, py);
        x.lineTo(px + rand(-12, 12), py + rand(-3, 3));
        x.stroke();
      }
      grain(x, 256, 14);
      T.steel = c;
    }
    // Acoustic panelling for the lane dividers.
    {
      const c = canvas(256);
      const x = c.getContext('2d');
      x.fillStyle = '#4b4f55';
      x.fillRect(0, 0, 256, 256);
      for (let yy = 0; yy < 256; yy += 8) {
        for (let xx = (yy / 8) % 2 ? 4 : 0; xx < 256; xx += 8) {
          x.fillStyle = 'rgba(25,27,30,0.55)';
          x.beginPath();
          x.arc(xx, yy, 1.6, 0, Math.PI * 2);
          x.fill();
        }
      }
      grain(x, 256, 10);
      T.acoustic = c;
    }
    // Hessian sandbags.
    {
      const c = canvas(256);
      const x = c.getContext('2d');
      x.fillStyle = '#9b8b68';
      x.fillRect(0, 0, 256, 256);
      for (let i = 0; i < 256; i += 3) {
        x.fillStyle = 'rgba(80,68,48,0.25)';
        x.fillRect(0, i, 256, 1);
        x.fillRect(i, 0, 1, 256);
      }
      blotches(x, 256, 14, 10, 50, ['rgba(70,60,40,A)'], 0.25);
      grain(x, 256, 18);
      T.bag = c;
    }
  }

  /** A distance sign: white plate, black numerals, thin red border. */
  _signTexture(text, w = 512, h = 256) {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const x = c.getContext('2d');
    x.fillStyle = '#eceae4';
    x.fillRect(0, 0, w, h);
    x.strokeStyle = '#b3261e';
    x.lineWidth = 14;
    x.strokeRect(10, 10, w - 20, h - 20);
    x.fillStyle = '#16161a';
    x.font = `700 ${Math.round(h * 0.56)}px Inter, "Segoe UI", Arial, sans-serif`;
    x.textAlign = 'center';
    x.textBaseline = 'middle';
    x.fillText(text, w / 2, h / 2 + h * 0.03);
    grain(x, Math.min(w, h), 8);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = this.maxAniso;
    return t;
  }

  /** Paint on the ground: a number, or a lane number. */
  _paintTexture(text, color) {
    const c = document.createElement('canvas');
    c.width = 256;
    c.height = 256;
    const x = c.getContext('2d');
    x.fillStyle = color;
    x.font = '700 170px Inter, "Segoe UI", Arial, sans-serif';
    x.textAlign = 'center';
    x.textBaseline = 'middle';
    x.fillText(text, 128, 136);
    // Worn paint: knock holes out of it.
    x.globalCompositeOperation = 'destination-out';
    dots(x, 256, 500, 0.5, 2.5, ['rgba(0,0,0,0.6)']);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = this.maxAniso;
    return t;
  }

  _mat(opts) {
    return new THREE.MeshStandardMaterial({ envMapIntensity: 0.55, ...opts });
  }

  _buildSky() {
    // A gradient dome with a soft sun glow, and the same dome (plus a
    // bright sun) baked into an environment map so metal and gloss pick up
    // a believable sky.
    const sunDir = new THREE.Vector3(-0.45, 0.62, 0.64).normalize();
    this.sunDir = sunDir;
    const skyMat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {
        top: { value: new THREE.Color(0x4f7fbf) },
        horizon: { value: new THREE.Color(0xd4e2ec) },
        ground: { value: new THREE.Color(0x9aa39c) },
        sun: { value: sunDir },
      },
      vertexShader: `varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      // Soft fair-weather clouds: layered value noise projected onto a
      // flat cloud deck, thinning out towards the horizon.
      fragmentShader: `uniform vec3 top; uniform vec3 horizon; uniform vec3 ground; uniform vec3 sun; varying vec3 vDir;
        float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float noise(vec2 p){ vec2 i = floor(p); vec2 f = fract(p); f = f*f*(3.0-2.0*f);
          return mix(mix(hash(i), hash(i+vec2(1,0)), f.x), mix(hash(i+vec2(0,1)), hash(i+vec2(1,1)), f.x), f.y); }
        float fbm(vec2 p){ float v = 0.0; float a = 0.5; for (int k = 0; k < 5; k++){ v += a*noise(p); p *= 2.03; a *= 0.5; } return v; }
        void main(){
          vec3 d = normalize(vDir);
          float h = d.y;
          vec3 col = h > 0.0 ? mix(horizon, top, pow(clamp(h,0.0,1.0), 0.55)) : mix(horizon, ground, clamp(-h*4.0,0.0,1.0));
          float s = max(dot(d, sun), 0.0);
          col += vec3(1.0,0.93,0.8) * (pow(s, 900.0) * 3.0 + pow(s, 24.0) * 0.18);
          if (h > 0.02) {
            vec2 uv = d.xz / (h + 0.12) * 1.6;
            float c = smoothstep(0.5, 0.78, fbm(uv + vec2(3.1, 7.7)));
            float shade = 0.82 + 0.18 * fbm(uv * 1.7 + 11.0);
            col = mix(col, vec3(0.97, 0.97, 0.98) * shade, c * smoothstep(0.02, 0.22, h) * 0.85);
          }
          gl_FragColor = vec4(col, 1.0);
        }`,
    });
    const sky = new THREE.Mesh(new THREE.SphereGeometry(800, 48, 24), skyMat);
    this.scene.add(sky);
    this.skyMat = skyMat;

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const envScene = new THREE.Scene();
    envScene.add(new THREE.Mesh(new THREE.SphereGeometry(50, 32, 16), skyMat));
    const sunBall = new THREE.Mesh(new THREE.SphereGeometry(4, 16, 8), new THREE.MeshBasicMaterial({ color: 0xfff1d6 }));
    sunBall.position.copy(sunDir).multiplyScalar(40);
    envScene.add(sunBall);
    const floor = new THREE.Mesh(new THREE.CircleGeometry(49, 32), new THREE.MeshBasicMaterial({ color: 0x6f6452 }));
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -2;
    envScene.add(floor);
    this.envMap = pmrem.fromScene(envScene, 0.035).texture;
    pmrem.dispose();
    this.scene.environment = this.envMap;
  }

  _buildLights() {
    const hemi = new THREE.HemisphereLight(0xc2d6ea, 0x6b604d, 0.75);
    this.scene.add(hemi);
    const sun = new THREE.DirectionalLight(0xfff0dc, 2.6);
    sun.position.copy(this.sunDir).multiplyScalar(80);
    sun.target.position.set(0, 0, -24);
    sun.castShadow = true;
    sun.shadow.mapSize.set(4096, 4096);
    const s = sun.shadow.camera;
    s.left = -48;
    s.right = 48;
    s.top = 60;
    s.bottom = -60;
    s.near = 10;
    s.far = 220;
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.03;
    this.scene.add(sun, sun.target);
    // A warm fill under the roof, where the sun can't reach.
    const fill = new THREE.PointLight(0xffe2b8, 18, 16, 1.6);
    fill.position.set(0, 3.1, 1.8);
    this.scene.add(fill);
  }

  /** Adds a mesh that stops bullets, optionally casting/receiving shadows,
   * and optionally a box the player can't walk through. */
  _solid(mesh, { cast = true, receive = true, collide = false } = {}) {
    mesh.castShadow = cast;
    mesh.receiveShadow = receive;
    this.scene.add(mesh);
    this.solids.push(mesh);
    if (collide) {
      mesh.updateMatrixWorld(true);
      const b = new THREE.Box3().setFromObject(mesh);
      this.colliders.push({ x0: b.min.x - PLAYER_R, x1: b.max.x + PLAYER_R, z0: b.min.z - PLAYER_R, z1: b.max.z + PLAYER_R });
    }
    return mesh;
  }

  _box(w, h, d, mat, x, y, z, opts) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x, y, z);
    return this._solid(m, opts);
  }

  _buildGround() {
    const T = this.tex;
    const grass = this._mat({ map: this._tex(T.grass, 60), roughness: 0.95 });
    const outside = new THREE.Mesh(new THREE.PlaneGeometry(600, 600), grass);
    outside.rotation.x = -Math.PI / 2;
    outside.position.y = -0.02;
    this._solid(outside, { cast: false });

    // The field, downrange of the firing line.
    const dirtTex = this._tex(T.dirt, 8, 16);
    const dirt = this._mat({ map: dirtTex, bumpMap: this._tex(T.dirt, 8, 16, false), bumpScale: 1.4, roughness: 0.96 });
    const field = new THREE.Mesh(new THREE.PlaneGeometry(BAY_HALF * 2, -FIELD_END - 1.5), dirt);
    field.rotation.x = -Math.PI / 2;
    field.position.set(0, 0, (FIELD_END - 1.5) / 2);
    this._solid(field, { cast: false });

    // The covered bay and the area behind it: concrete slabs.
    const slab = this._mat({ map: this._tex(T.slab, (BAY_HALF * 2) / 4, 12 / 4), roughness: 0.88 });
    const bay = new THREE.Mesh(new THREE.PlaneGeometry(BAY_HALF * 2, 12), slab);
    bay.rotation.x = -Math.PI / 2;
    bay.position.set(0, 0.004, 4.5);
    this._solid(bay, { cast: false });

    // Painted lines: the firing line in yellow, distance lines in white.
    const paint = (w, d, color, x, z) => {
      const m = new THREE.Mesh(
        new THREE.PlaneGeometry(w, d),
        this._mat({ color, roughness: 0.8, polygonOffset: true, polygonOffsetFactor: -2 })
      );
      m.rotation.x = -Math.PI / 2;
      m.position.set(x, 0.012, z);
      m.receiveShadow = true;
      this.scene.add(m);
    };
    paint(BAY_HALF * 2, 0.12, 0xd9b733, 0, -1.4);
    for (const d of [5, 10, 20, 30, 50]) {
      paint(BAY_HALF * 2 - 1, 0.1, 0xd8d6cf, 0, -1.5 - d);
      for (const side of [-1, 1]) {
        const num = new THREE.Mesh(
          new THREE.PlaneGeometry(1.4, 1.4),
          new THREE.MeshStandardMaterial({ map: this._paintTexture(String(d), '#e8e6df'), transparent: true, roughness: 0.85, polygonOffset: true, polygonOffsetFactor: -2 })
        );
        num.rotation.x = -Math.PI / 2;
        num.position.set(side * (BAY_HALF - 1.4), 0.013, -1.5 - d + 0.95);
        num.receiveShadow = true;
        this.scene.add(num);
      }
    }
  }

  _buildBay() {
    const T = this.tex;
    const concreteWall = this._mat({ map: this._tex(T.wall, 1, 1), roughness: 0.92 });
    const steel = this._mat({ map: this._tex(T.steel, 1), metalness: 0.55, roughness: 0.5 });
    const darkSteel = this._mat({ color: 0x2c2f33, metalness: 0.6, roughness: 0.45 });
    const wood = this._mat({ map: this._tex(T.wood, 1), roughness: 0.75 });
    const acoustic = this._mat({ map: this._tex(T.acoustic, 2, 2), roughness: 0.95 });

    // Roof over the firing line: a slab on steel columns, with a band of
    // light fittings underneath.
    const roofMat = this._mat({ color: 0x6e6c68, roughness: 0.9 });
    this._box(BAY_HALF * 2, 0.26, 7.4, roofMat, 0, 3.5, 2.3);
    for (let i = 0; i <= 4; i++) {
      const x = -BAY_HALF + 1 + (i * (BAY_HALF * 2 - 2)) / 4;
      this._box(0.3, 3.37, 0.3, darkSteel, x, 1.685, -0.9, { collide: true });
      this._box(0.3, 3.37, 0.3, darkSteel, x, 1.685, 5.6, { collide: true });
      this._box(0.18, 0.3, 7.2, darkSteel, x, 3.23, 2.3, { cast: false });
    }
    const lamp = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfff4de, emissiveIntensity: 2.2 });
    for (let i = 0; i < LANES; i++) {
      const x = -BAY_HALF + 2.4 + LANE_W * (i + 0.5);
      const m = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.04, 0.22), lamp);
      m.position.set(x, 3.35, 1.4);
      this.scene.add(m);
    }

    // The lanes: a bench at the firing line in each, with gaps either side
    // to walk through, and acoustic dividers between lanes.
    for (let i = 0; i < LANES; i++) {
      const cx = -BAY_HALF + 2.4 + LANE_W * (i + 0.5);
      this._box(1.35, 0.06, 0.62, wood, cx, 1.0, -0.62, { collide: true });
      for (const lx of [-0.58, 0.58]) {
        this._box(0.05, 0.97, 0.05, darkSteel, cx + lx, 0.485, -0.4);
        this._box(0.05, 0.97, 0.05, darkSteel, cx + lx, 0.485, -0.86);
      }
      this._box(1.25, 0.04, 0.5, darkSteel, cx, 0.35, -0.62, { cast: false });
      // Lane number on the floor.
      const num = new THREE.Mesh(
        new THREE.PlaneGeometry(0.7, 0.7),
        new THREE.MeshStandardMaterial({ map: this._paintTexture(String(i + 1), '#d9b733'), transparent: true, roughness: 0.8, polygonOffset: true, polygonOffsetFactor: -2 })
      );
      num.rotation.x = -Math.PI / 2;
      num.position.set(cx, 0.014, 0.35);
      num.receiveShadow = true;
      this.scene.add(num);
    }
    for (let i = 0; i <= LANES; i++) {
      const x = -BAY_HALF + 2.4 + LANE_W * i;
      this._box(0.06, 2.1, 1.7, acoustic, x, 1.05, 0.15, { collide: true });
      this._box(0.1, 0.06, 1.74, steel, x, 2.13, 0.15, { cast: false });
    }

    // Behind the bay: a wall with lockers, a door and a sign.
    this._box(BAY_HALF * 2, 4.2, 0.4, concreteWall, 0, 2.1, 10, { collide: true });
    const lockerMat = this._mat({ color: 0x3f5563, metalness: 0.4, roughness: 0.55 });
    for (let i = 0; i < 7; i++) {
      const lx = -12 + i * 0.62;
      this._box(0.58, 1.9, 0.5, lockerMat, lx, 0.95, 9.5, { collide: i === 0 || i === 6 });
      this._box(0.04, 0.16, 0.02, darkSteel, lx + 0.18, 1.1, 9.24, { cast: false });
      for (const vy of [1.55, 1.62, 1.69]) this._box(0.3, 0.012, 0.02, darkSteel, lx, vy, 9.245, { cast: false });
    }
    this.colliders.push({ x0: -12.4 - PLAYER_R, x1: -8.1 + PLAYER_R, z0: 9.2 - PLAYER_R, z1: 10 });
    // A table with ammo cans.
    this._box(2.2, 0.06, 0.8, wood, 8.5, 0.92, 9.2, { collide: true });
    for (const lx of [7.5, 9.5]) this._box(0.06, 0.9, 0.7, darkSteel, lx, 0.45, 9.2);
    const can = this._mat({ color: 0x4a5236, metalness: 0.35, roughness: 0.6 });
    for (const [ax, az] of [[7.9, 9.1], [8.3, 9.3], [8.9, 9.1]]) this._box(0.3, 0.19, 0.14, can, ax, 1.045, az);
    // Door.
    this._box(1.2, 2.3, 0.08, this._mat({ color: 0x2e3a44, metalness: 0.5, roughness: 0.45 }), 12.3, 1.15, 9.78, { cast: false });
    // Sign above the lanes' back wall.
    const sign = new THREE.Mesh(
      new THREE.PlaneGeometry(4.8, 1.1),
      new THREE.MeshStandardMaterial({ map: this._signTexture('THE RANGE', 1024, 232), roughness: 0.6 })
    );
    sign.position.set(0, 2.9, 9.79);
    sign.rotation.y = Math.PI;
    this.scene.add(sign);
  }

  _buildField() {
    const T = this.tex;
    const wallMat = this._mat({ map: this._tex(T.wall, 1, 1), roughness: 0.92 });
    const wallEnd = FIELD_END - 6; // meets the tall wall behind the berm
    const wallLen = 10 - wallEnd; // from behind the bay to the back
    // Side walls in 4 m cast panels.
    const panels = Math.ceil(wallLen / 4);
    for (const side of [-1, 1]) {
      for (let i = 0; i < panels; i++) {
        const z = 10 - 2 - i * 4;
        this._box(0.45, 4.4, 4, wallMat, side * (BAY_HALF + 0.22), 2.2, z, { collide: true });
      }
      // Coping along the top.
      this._box(0.6, 0.12, wallLen, this._mat({ color: 0x8c8a85, roughness: 0.9 }), side * (BAY_HALF + 0.22), 4.46, (10 + wallEnd) / 2, { cast: false });
    }

    // Back stop: an earth berm in front of a tall wall.
    const dirtMat = this._mat({ map: this._tex(T.dirt, 10, 3), roughness: 0.97 });
    const bermShape = new THREE.Shape();
    bermShape.moveTo(0, 0);
    bermShape.lineTo(7.5, 0);
    bermShape.lineTo(7.5, 6.2);
    bermShape.lineTo(5.4, 6.2);
    bermShape.quadraticCurveTo(2.4, 3.8, 0, 0);
    const bermGeo = new THREE.ExtrudeGeometry(bermShape, { depth: BAY_HALF * 2 + 0.2, bevelEnabled: false });
    bermGeo.rotateY(Math.PI / 2);
    const berm = new THREE.Mesh(bermGeo, dirtMat);
    berm.position.set(-BAY_HALF - 0.1, 0, FIELD_END + 2.5);
    this._solid(berm);
    this._box(BAY_HALF * 2 + 1, 9, 0.6, wallMat, 0, 4.5, FIELD_END - 5.3);

    // Distance signs on both walls: 5, 10, 20, 30 and 50 m.
    for (const d of [5, 10, 20, 30, 50]) {
      const tex = this._signTexture(`${d} M`);
      for (const side of [-1, 1]) {
        const s = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 0.8), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.55 }));
        s.position.set(side * (BAY_HALF - 0.01), 2.4, -1.5 - d);
        s.rotation.y = -side * (Math.PI / 2);
        s.receiveShadow = true;
        this.scene.add(s);
      }
    }

    // Cover in the field: jersey barriers, sandbag walls, crates, barrels,
    // tyres - the kind of thing range dummies stand behind.
    const concrete = this._mat({ map: this._tex(T.slab, 0.5), roughness: 0.9, color: 0xc9c6bd });
    const jersey = new THREE.Shape();
    jersey.moveTo(-0.3, 0);
    jersey.lineTo(0.3, 0);
    jersey.lineTo(0.22, 0.25);
    jersey.lineTo(0.1, 0.8);
    jersey.lineTo(-0.1, 0.8);
    jersey.lineTo(-0.22, 0.25);
    jersey.closePath();
    const jerseyGeo = new THREE.ExtrudeGeometry(jersey, { depth: 3, bevelEnabled: true, bevelSize: 0.02, bevelThickness: 0.02, bevelSegments: 2 });
    jerseyGeo.translate(0, 0, -1.5);
    jerseyGeo.rotateY(Math.PI / 2);
    for (const [x, z, a] of [[-9, -12, 0], [6.5, -22, 0.1], [-4, -34, -0.08], [10.5, -41, 0]]) {
      const m = new THREE.Mesh(jerseyGeo, concrete);
      m.position.set(x, 0, z);
      m.rotation.y = a;
      this._solid(m, { collide: true });
    }
    const bag = this._mat({ map: this._tex(this.tex.bag, 1), roughness: 0.95 });
    const bagGeo = new THREE.CapsuleGeometry(0.16, 0.42, 4, 10);
    bagGeo.rotateZ(Math.PI / 2);
    bagGeo.scale(1, 0.55, 0.9);
    const sandbags = (cx, cz, n, rows) => {
      for (let row = 0; row < rows; row++) {
        for (let i = 0; i < n - (row % 2); i++) {
          const m = new THREE.Mesh(bagGeo, bag);
          m.position.set(cx + (i - (n - 1) / 2) * 0.72 + (row % 2) * 0.36, 0.1 + row * 0.17, cz + rand(-0.03, 0.03));
          m.rotation.y = rand(-0.06, 0.06);
          this._solid(m);
        }
      }
      this.colliders.push({ x0: cx - n * 0.36 - PLAYER_R, x1: cx + n * 0.36 + PLAYER_R, z0: cz - 0.3 - PLAYER_R, z1: cz + 0.3 + PLAYER_R });
    };
    sandbags(-3.2, -17, 5, 4);
    sandbags(4, -29, 4, 3);
    const crate = this._mat({ map: this._tex(this.tex.wood, 1), roughness: 0.8 });
    for (const [x, y, z, s] of [[9.5, 0.5, -27, 1], [10.6, 0.5, -27.2, 1], [10, 1.5, -27.1, 1], [-11, 0.45, -46, 0.9]]) {
      this._box(s, s, s, crate, x, y * s, z, { collide: true }).rotation.y = rand(-0.1, 0.1);
    }
    const barrelGeo = new THREE.CylinderGeometry(0.29, 0.29, 0.88, 24);
    const barrelMat = this._mat({ color: 0x2f4d6b, metalness: 0.45, roughness: 0.55, map: this._tex(this.tex.steel, 1) });
    for (const [x, z] of [[12.2, -8.5], [12.8, -9.3], [-12.5, -24], [-12.3, -24.7]]) {
      const m = new THREE.Mesh(barrelGeo, barrelMat);
      m.position.set(x, 0.44, z);
      this._solid(m, { collide: true });
    }
    const tyre = new THREE.TorusGeometry(0.34, 0.13, 10, 24);
    tyre.rotateX(Math.PI / 2);
    const rubber = this._mat({ color: 0x1b1b1c, roughness: 0.9 });
    for (let i = 0; i < 4; i++) {
      const m = new THREE.Mesh(tyre, rubber);
      m.position.set(-11.2, 0.13 + i * 0.25, -33);
      this._solid(m);
    }
    this.colliders.push({ x0: -11.7 - PLAYER_R, x1: -10.7 + PLAYER_R, z0: -33.5 - PLAYER_R, z1: -32.5 + PLAYER_R });

    // Floodlight poles along the walls.
    const pole = this._mat({ color: 0x3a3d40, metalness: 0.6, roughness: 0.5 });
    const head = this._mat({ color: 0x2a2c2e, metalness: 0.5, roughness: 0.4 });
    for (const z of [-10, -26, -42]) {
      for (const side of [-1, 1]) {
        const x = side * (BAY_HALF - 0.4);
        this._box(0.14, 7.2, 0.14, pole, x, 3.6, z, { collide: true });
        this._box(0.7, 0.35, 0.4, head, x - side * 0.3, 7.1, z, { cast: false }).rotation.z = side * 0.35;
      }
    }
  }

  _buildSurroundings() {
    // Rolling hills on the horizon and a treeline behind the walls, so the
    // range sits somewhere rather than floating in a void.
    const hills = new THREE.CylinderGeometry(360, 360, 1, 96, 1, true);
    const pos = hills.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      if (pos.getY(i) > 0) {
        const a = Math.atan2(pos.getZ(i), pos.getX(i));
        const h = 22 + Math.sin(a * 3.1) * 10 + Math.sin(a * 7.7 + 1.3) * 6 + Math.sin(a * 17.3) * 2.5;
        pos.setY(i, h);
      } else pos.setY(i, -2);
    }
    hills.computeVertexNormals();
    const hillMat = new THREE.MeshStandardMaterial({ color: 0x55664a, roughness: 1, side: THREE.BackSide });
    this.scene.add(new THREE.Mesh(hills, hillMat));

    const trunkGeo = new THREE.CylinderGeometry(0.14, 0.2, 2.4, 6);
    const crownGeo = new THREE.ConeGeometry(1.6, 5.2, 7);
    const trunks = new THREE.InstancedMesh(trunkGeo, this._mat({ color: 0x4a3a2a, roughness: 1 }), 90);
    const crowns = new THREE.InstancedMesh(crownGeo, this._mat({ color: 0x33472c, roughness: 1 }), 90);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const sc = new THREE.Vector3();
    let n = 0;
    const place = (x, z) => {
      const s = rand(0.8, 1.5);
      sc.set(s, s * rand(0.9, 1.25), s);
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rand(0, Math.PI));
      m.compose(new THREE.Vector3(x, 1.2 * sc.y, z), q, sc);
      trunks.setMatrixAt(n, m);
      m.compose(new THREE.Vector3(x, (2.4 + 2.4) * sc.y, z), q, sc);
      crowns.setMatrixAt(n, m);
      n++;
    };
    for (let i = 0; i < 90; i++) {
      const band = i % 3;
      if (band === 0) place(rand(-60, 60), rand(FIELD_END - 16, FIELD_END - 40));
      else place((band === 1 ? -1 : 1) * rand(BAY_HALF + 8, BAY_HALF + 40), rand(FIELD_END - 20, 30));
    }
    trunks.count = crowns.count = n;
    trunks.castShadow = crowns.castShadow = true;
    this.scene.add(trunks, crowns);
  }

  // ---------- Dummies ----------

  _buildDummyParts() {
    // A training bot, like the ones in Valorant's and Apex's ranges: a light
    // polymer shell, dark joints, a glossy visor and a strip of the accent
    // colour across the chest. 1.8 m tall with a real-sized head.
    const G = (this.dummyGeo = {});
    G.foot = new THREE.BoxGeometry(0.1, 0.07, 0.25);
    G.shin = new THREE.CapsuleGeometry(0.058, 0.34, 4, 12);
    G.thigh = new THREE.CapsuleGeometry(0.074, 0.32, 4, 12);
    G.pelvis = new THREE.CapsuleGeometry(0.1, 0.16, 4, 14);
    G.pelvis.rotateZ(Math.PI / 2);
    G.waist = new THREE.CylinderGeometry(0.12, 0.13, 0.16, 16);
    G.chest = new THREE.CapsuleGeometry(0.17, 0.2, 6, 18);
    G.chest.scale(1.25, 1, 0.72);
    G.shoulder = new THREE.SphereGeometry(0.07, 14, 10);
    G.upperArm = new THREE.CapsuleGeometry(0.052, 0.24, 4, 10);
    G.foreArm = new THREE.CapsuleGeometry(0.046, 0.22, 4, 10);
    G.hand = new THREE.SphereGeometry(0.047, 12, 8);
    G.neck = new THREE.CylinderGeometry(0.048, 0.055, 0.11, 12);
    G.head = new THREE.SphereGeometry(HEAD_R, 28, 20);
    G.head.scale(1, 1.14, 1.05);
    // Centred on the face (+z, which three.js's sphere puts at phi = π/2).
    G.visor = new THREE.SphereGeometry(HEAD_R * 1.035, 28, 12, Math.PI * 0.14, Math.PI * 0.72, Math.PI * 0.36, Math.PI * 0.22);
    G.visor.scale(1, 1.14, 1.05);
    G.strip = new THREE.BoxGeometry(0.24, 0.022, 0.02);
    G.base = new THREE.CylinderGeometry(0.34, 0.38, 0.05, 28);
    this.dummies = [];
  }

  _dummyMaterials() {
    const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#a50fec';
    return {
      shell: this._mat({ color: 0xd9dbdf, roughness: 0.5, metalness: 0.05 }),
      joint: this._mat({ color: 0x2c3036, roughness: 0.65, metalness: 0.2 }),
      visor: this._mat({ color: 0x0c0d10, roughness: 0.12, metalness: 0.6, envMapIntensity: 1.2 }),
      strip: new THREE.MeshStandardMaterial({ color: accent, emissive: accent, emissiveIntensity: 1.4 }),
      base: this._mat({ color: 0x3d4146, metalness: 0.6, roughness: 0.45 }),
    };
  }

  _makeDummy() {
    const G = this.dummyGeo;
    const M = this._dummyMaterials();
    const root = new THREE.Group(); // at the feet; pops up and falls about this point
    const body = new THREE.Group();
    root.add(body);
    const parts = [];
    const add = (geo, mat, x, y, z, zone = 'body', rot) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      if (rot) m.rotation.set(rot[0], rot[1], rot[2]);
      m.castShadow = false;
      m.receiveShadow = true;
      m.userData.zone = zone;
      body.add(m);
      if (zone) parts.push(m);
      return m;
    };
    for (const s of [-1, 1]) {
      add(G.foot, M.joint, s * 0.1, 0.035, 0.03);
      add(G.shin, M.shell, s * 0.1, 0.3, 0);
      add(G.thigh, M.shell, s * 0.1, 0.72, 0);
      add(G.shoulder, M.joint, s * 0.26, 1.44, 0);
      add(G.upperArm, M.shell, s * 0.29, 1.25, 0, 'body', [0, 0, s * 0.08]);
      add(G.foreArm, M.shell, s * 0.305, 0.98, 0.02, 'body', [-0.08, 0, s * 0.04]);
      add(G.hand, M.joint, s * 0.31, 0.83, 0.03);
    }
    add(G.pelvis, M.shell, 0, 0.95, 0);
    add(G.waist, M.joint, 0, 1.08, 0);
    add(G.chest, M.shell, 0, 1.31, 0);
    add(G.strip, M.strip, 0, 1.36, 0.125, 'body');
    add(G.neck, M.joint, 0, 1.53, 0);
    const head = add(G.head, M.shell, 0, HEAD_Y, 0, 'head');
    add(G.visor, M.visor, 0, HEAD_Y, 0, 'head');
    const base = new THREE.Mesh(G.base, M.base);
    base.position.y = 0.025;
    base.receiveShadow = true;
    root.add(base);
    // A soft contact shadow (the shadow map is drawn once and doesn't know
    // the dummies are there).
    const blob = new THREE.Mesh(new THREE.CircleGeometry(0.55, 24), this.blobMat);
    blob.rotation.x = -Math.PI / 2;
    blob.position.y = 0.055;
    root.add(blob);
    this.scene.add(root);
    const d = { root, body, parts, head, mats: M, state: 'hidden', t: 0, alive: false };
    parts.forEach((p) => (p.userData.dummy = d));
    root.visible = false;
    return d;
  }

  _dummy() {
    let d = this.dummies.find((x) => x.state === 'hidden');
    if (!d) {
      d = this._makeDummy();
      this.dummies.push(d);
    }
    return d;
  }

  /** Pops a dummy up at (x, z), facing the player. */
  _spawnDummy(x, z, { strafe = false, anchor = null, respawn = 0, use = null } = {}) {
    const d = use || this._dummy();
    d.root.position.set(x, 0, z);
    d.root.rotation.set(0, Math.atan2(this.player.x - x, this.player.z - z), 0);
    d.body.rotation.set(-Math.PI / 2, 0, 0);
    d.body.position.set(0, 0, 0);
    d.root.visible = true;
    d.state = 'rising';
    d.t = 0;
    d.alive = true;
    d.hits = 0;
    d.strafe = strafe ? { vx: 0, want: (Math.random() < 0.5 ? -1 : 1) * STRAFE_SPEED, next: rand(0.35, 0.9), anchor: x } : null;
    d.home = anchor || { x, z };
    d.respawn = respawn;
    d.flash = 0;
    return d;
  }

  _headCenter(d, out = new THREE.Vector3()) {
    return d.head.getWorldPosition(out);
  }

  _updateDummies(dt) {
    for (const d of this.dummies) {
      if (d.state === 'hidden') {
        if (d.respawnAt && performance.now() >= d.respawnAt) {
          d.respawnAt = 0;
          const home = d.home;
          d.state = 'hidden';
          this._spawnDummy(home.x, home.z, { strafe: d.wasStrafing, anchor: home, respawn: d.respawn, use: d });
        }
        continue;
      }
      d.t += dt;
      if (d.state === 'rising') {
        // Up in a fifth of a second with a little overshoot, like a
        // spring-loaded pop-up target.
        const k = Math.min(1, d.t / 0.2);
        const e = 1 + 2.2 * (k - 1) ** 3 + 1.2 * (k - 1) ** 2;
        d.body.rotation.x = -Math.PI / 2 * (1 - e);
        if (k >= 1) {
          d.body.rotation.x = 0;
          d.state = 'up';
        }
      } else if (d.state === 'falling') {
        const k = Math.min(1, d.t / 0.34);
        d.body.rotation.x = -Math.PI / 2 * k * k;
        if (k >= 1) {
          d.state = 'down';
          d.t = 0;
        }
      } else if (d.state === 'down') {
        if (d.t > 0.5) {
          d.root.position.y -= dt * 1.6;
          if (d.t > 0.9) {
            d.root.visible = false;
            d.state = 'hidden';
            d.root.position.y = 0;
          }
        }
      }
      if (d.state === 'up' && d.strafe) {
        // Side to side like a player strafing: quick stops, random timing,
        // turning back before it reaches the end of its patch.
        const s = d.strafe;
        s.next -= dt;
        const off = d.root.position.x - s.anchor;
        if (s.next <= 0 || (off > 2.4 && s.want > 0) || (off < -2.4 && s.want < 0)) {
          s.want = -Math.sign(s.want || 1) * STRAFE_SPEED;
          s.next = rand(0.3, 0.95);
        }
        s.vx += clamp(s.want - s.vx, -40 * dt, 40 * dt);
        d.root.position.x = clamp(d.root.position.x + s.vx * dt, TARGET_AREA.xMin, TARGET_AREA.xMax);
        d.root.rotation.y = Math.atan2(this.player.x - d.root.position.x, this.player.z - d.root.position.z);
      }
      if (d.flash > 0) {
        d.flash = Math.max(0, d.flash - dt);
        d.mats.shell.emissive.setScalar(d.flash * 4);
      }
      if (d.jolt) {
        d.jolt *= Math.exp(-dt * 14);
        d.body.rotation.y = d.jolt * Math.sin(d.t * 40);
        if (Math.abs(d.jolt) < 0.002) d.jolt = 0;
      }
    }
  }

  _killDummy(d) {
    d.alive = false;
    d.state = 'falling';
    d.t = 0;
    d.wasStrafing = !!d.strafe;
    if (d.respawn > 0) d.respawnAt = performance.now() + d.respawn;
  }

  // ---------- The rifle ----------

  /** A rounded box, for the rifle's parts and the gloves. */
  _rbox(w, h, d, r, mat) {
    const s = new THREE.Shape();
    const x = -w / 2;
    const y = -h / 2;
    s.moveTo(x + r, y);
    s.lineTo(x + w - r, y);
    s.quadraticCurveTo(x + w, y, x + w, y + r);
    s.lineTo(x + w, y + h - r);
    s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    s.lineTo(x + r, y + h);
    s.quadraticCurveTo(x, y + h, x, y + h - r);
    s.lineTo(x, y + r);
    s.quadraticCurveTo(x, y, x + r, y);
    const b = Math.min(r, d / 2) * 0.6;
    const g = new THREE.ExtrudeGeometry(s, { depth: d - 2 * b, bevelEnabled: true, bevelThickness: b, bevelSize: b * 0.6, bevelSegments: 2, curveSegments: 4 });
    g.translate(0, 0, -(d - 2 * b) / 2);
    return new THREE.Mesh(g, mat);
  }

  /** A side profile (u forward along the barrel, v up) given thickness. */
  _profile(points, width, mat, bevel = 0.003) {
    const s = new THREE.Shape(points.map(([u, v]) => new THREE.Vector2(u, v)));
    const g = new THREE.ExtrudeGeometry(s, { depth: width - 2 * bevel, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 2, curveSegments: 6 });
    g.translate(0, 0, -(width - 2 * bevel) / 2);
    g.rotateY(Math.PI / 2); // u -> -z (forward)
    return new THREE.Mesh(g, mat);
  }

  _buildViewmodel() {
    this.vmScene = new THREE.Scene();
    this.vmScene.environment = this.envMap;
    this.vmCamera = new THREE.PerspectiveCamera(50, 16 / 9, 0.01, 10);
    this.vmScene.add(new THREE.HemisphereLight(0xcfe0f0, 0x5a5046, 0.9));
    const key = new THREE.DirectionalLight(0xfff0dc, 2.2);
    key.position.set(0.5, 1.2, 0.6);
    this.vmScene.add(key);
    const rim = new THREE.DirectionalLight(0xbcd0ff, 0.6);
    rim.position.set(-0.8, 0.4, -1);
    this.vmScene.add(rim);

    const metal = new THREE.MeshStandardMaterial({ color: 0x2b2d31, metalness: 0.7, roughness: 0.36, envMapIntensity: 0.9 });
    const black = new THREE.MeshStandardMaterial({ color: 0x17181b, metalness: 0.15, roughness: 0.62, envMapIntensity: 0.6 });
    const tan = new THREE.MeshStandardMaterial({ color: 0x8b7c61, metalness: 0.08, roughness: 0.66, envMapIntensity: 0.5 });
    const steel = new THREE.MeshStandardMaterial({ color: 0x4b4e53, metalness: 0.85, roughness: 0.3, envMapIntensity: 1 });
    const glove = new THREE.MeshStandardMaterial({ color: 0x2a2d31, roughness: 0.9, metalness: 0 });
    const knuckle = new THREE.MeshStandardMaterial({ color: 0x1c1e21, roughness: 0.75, metalness: 0.05 });
    const sleeve = new THREE.MeshStandardMaterial({ color: 0x4d523f, roughness: 0.95, metalness: 0 });

    const gun = (this.gun = new THREE.Group());
    const add = (m, x, y, z, rx = 0, ry = 0, rz = 0) => {
      m.position.set(x, y, z);
      m.rotation.set(rx, ry, rz);
      gun.add(m);
      return m;
    };
    // Receiver and lower.
    add(this._rbox(0.05, 0.06, 0.3, 0.008, metal), 0, 0.03, -0.02);
    add(this._rbox(0.046, 0.05, 0.19, 0.008, metal), 0, -0.02, 0.0);
    add(this._rbox(0.052, 0.05, 0.075, 0.006, metal), 0, -0.05, -0.075);
    // Ejection port and forward assist on the right side.
    add(new THREE.Mesh(new THREE.BoxGeometry(0.004, 0.022, 0.07), black), 0.026, 0.03, -0.01);
    add(new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.03, 10), steel), 0.03, 0.045, 0.06, Math.PI / 2);
    // Charging handle.
    add(new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.012, 0.02), black), 0, 0.062, 0.12);
    // Handguard (two-tone tan) with M-LOK slots.
    add(this._rbox(0.058, 0.058, 0.32, 0.012, tan), 0, 0.031, -0.33);
    for (let i = 0; i < 4; i++) {
      for (const s of [-1, 1]) add(new THREE.Mesh(new THREE.BoxGeometry(0.004, 0.012, 0.034), black), s * 0.0295, 0.028, -0.22 - i * 0.065);
    }
    // Top rail with its teeth.
    add(new THREE.Mesh(new THREE.BoxGeometry(0.024, 0.01, 0.62), black), 0, 0.066, -0.17);
    const teeth = new THREE.InstancedMesh(new THREE.BoxGeometry(0.026, 0.006, 0.005), black, 60);
    const tm = new THREE.Matrix4();
    for (let i = 0; i < 60; i++) teeth.setMatrixAt(i, tm.makeTranslation(0, 0.073, 0.13 - i * 0.01));
    gun.add(teeth);
    // Barrel, gas block, muzzle brake.
    add(new THREE.Mesh(new THREE.CylinderGeometry(0.0105, 0.0105, 0.16, 16), steel), 0, 0.03, -0.56, Math.PI / 2);
    add(new THREE.Mesh(new THREE.CylinderGeometry(0.0165, 0.0165, 0.06, 16), black), 0, 0.03, -0.665, Math.PI / 2);
    for (let i = 0; i < 3; i++) add(new THREE.Mesh(new THREE.CylinderGeometry(0.0168, 0.0168, 0.005, 16), steel), 0, 0.03, -0.645 - i * 0.015, Math.PI / 2);
    this.muzzle = new THREE.Object3D();
    this.muzzle.position.set(0, 0.03, -0.7);
    gun.add(this.muzzle);
    // Magazine: a curved box mag.
    const mag = [];
    for (let i = 0; i <= 8; i++) {
      const t = i / 8;
      mag.push([0.03 + 0.05 * t * t, -0.05 - 0.19 * t]);
    }
    for (let i = 8; i >= 0; i--) {
      const t = i / 8;
      mag.push([0.03 + 0.05 * t * t + 0.058, -0.05 - 0.19 * t + 0.006 * t]);
    }
    this.mag = add(this._profile(mag.map(([u, v]) => [u + 0.04, v]), 0.03, black, 0.004), 0, 0, 0);
    // Pistol grip, angled back.
    add(this._profile([[-0.005, -0.03], [-0.052, -0.03], [-0.088, -0.15], [-0.086, -0.165], [-0.045, -0.165], [-0.03, -0.15]], 0.036, black, 0.006), 0, 0, 0.02);
    // Trigger guard and trigger.
    add(new THREE.Mesh(new THREE.BoxGeometry(0.008, 0.004, 0.07), black), 0, -0.07, -0.035);
    add(this._profile([[0, 0], [0.006, -0.028], [0.0, -0.032], [-0.006, -0.004]], 0.006, steel, 0.001), 0, -0.04, -0.03);
    // Stock and buffer tube.
    add(new THREE.Mesh(new THREE.CylinderGeometry(0.017, 0.017, 0.16, 16), black), 0, 0.02, 0.2, Math.PI / 2);
    add(this._profile([[-0.14, 0.05], [-0.34, 0.05], [-0.36, 0.035], [-0.36, -0.07], [-0.33, -0.08], [-0.2, -0.02], [-0.14, -0.005]], 0.042, black, 0.006), 0, -0.005, 0);
    // A red dot sight.
    add(this._rbox(0.03, 0.018, 0.06, 0.004, black), 0, 0.08, -0.02);
    add(new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.075, 24, 1, true), metal), 0, 0.106, -0.02, Math.PI / 2);
    for (const z of [0.018, -0.058]) add(new THREE.Mesh(new THREE.TorusGeometry(0.02, 0.003, 8, 24), metal), 0, 0.106, z);
    add(
      new THREE.Mesh(
        new THREE.CircleGeometry(0.019, 24),
        new THREE.MeshStandardMaterial({ color: 0x7fa6c9, metalness: 0.9, roughness: 0.05, transparent: true, opacity: 0.35, envMapIntensity: 1.5 })
      ),
      0,
      0.106,
      -0.056
    );
    add(new THREE.Mesh(new THREE.SphereGeometry(0.0016, 8, 6), new THREE.MeshBasicMaterial({ color: 0xff2a2a })), 0, 0.106, -0.05);

    // Gloved hands and sleeves. Right hand round the grip, trigger finger
    // on the trigger; left hand under the handguard, fingers over the side.
    const hands = new THREE.Group();
    gun.add(hands);
    const hadd = (m, x, y, z, rx = 0, ry = 0, rz = 0) => {
      m.position.set(x, y, z);
      m.rotation.set(rx, ry, rz);
      hands.add(m);
      return m;
    };
    // A tapered segment between two points - forearms, wrists, fingers.
    const limb = (from, to, r0, r1, mat, sides = 14) => {
      const a = new THREE.Vector3(...from);
      const b = new THREE.Vector3(...to);
      const m = new THREE.Mesh(new THREE.CylinderGeometry(r1, r0, a.distanceTo(b), sides), mat);
      m.position.copy(a).add(b).multiplyScalar(0.5);
      m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
      hands.add(m);
      return m;
    };
    const joint = (at, r, mat) => hadd(new THREE.Mesh(new THREE.SphereGeometry(r, 10, 8), mat), ...at);
    const finger = (from, to, r = 0.0098) => {
      limb(from, to, r, r * 0.92, glove, 8);
      joint(from, r, knuckle);
      joint(to, r * 0.92, glove);
    };
    // Right hand round the pistol grip (which angles back ~20°): palm on
    // the right side and back, three fingers wrapped round the front, index
    // finger on the trigger, thumb over the left side.
    hadd(this._rbox(0.034, 0.085, 0.078, 0.014, glove), 0.027, -0.098, 0.074, -0.34, 0, 0);
    for (let i = 0; i < 3; i++) {
      const y = -0.078 - i * 0.024;
      const z = 0.03 + i * 0.009;
      finger([0.03, y, z + 0.01], [-0.006, y - 0.002, z - 0.004]);
      finger([-0.006, y - 0.002, z - 0.004], [-0.024, y - 0.004, z + 0.012], 0.0092);
    }
    finger([0.026, -0.052, 0.032], [0.008, -0.056, -0.012], 0.009);
    finger([0.008, -0.056, -0.012], [0.003, -0.068, -0.024], 0.0085);
    finger([-0.014, -0.066, 0.09], [-0.026, -0.042, 0.045], 0.011);
    limb([0.03, -0.128, 0.112], [0.052, -0.172, 0.17], 0.031, 0.034, glove);
    limb([0.052, -0.172, 0.17], [0.2, -0.43, 0.5], 0.04, 0.052, sleeve);
    // Left hand under the handguard: palm below, fingers up the left side,
    // thumb along the right.
    hadd(this._rbox(0.07, 0.03, 0.095, 0.012, glove), -0.004, -0.014, -0.4, 0, 0, -0.08);
    for (let i = 0; i < 4; i++) {
      const z = -0.366 - i * 0.022;
      finger([-0.03, -0.012, z], [-0.036, 0.022, z], 0.0092);
      finger([-0.036, 0.022, z], [-0.028, 0.046, z - 0.002], 0.0086);
    }
    finger([0.03, -0.006, -0.37], [0.034, 0.026, -0.41], 0.0105);
    limb([-0.012, -0.028, -0.37], [-0.05, -0.1, -0.33], 0.031, 0.034, glove);
    limb([-0.05, -0.1, -0.33], [-0.27, -0.44, -0.06], 0.04, 0.052, sleeve);

    gun.traverse((o) => {
      if (o.isMesh) o.frustumCulled = false;
    });
    this.vmRoot = new THREE.Group();
    this.vmRoot.add(gun);
    this.vmScene.add(this.vmRoot);
    // Down in the bottom-right, pointing just inside the crosshair, the way
    // shooters hold a rifle at the ready in Valorant and CS2.
    this.vmRest = new THREE.Vector3(0.2, -0.235, -0.44);
    this.vmRoot.position.copy(this.vmRest);
    gun.rotation.set(0.01, -0.035, 0);

    // Muzzle flash: a flat star facing the camera plus a burst of light.
    const flashTex = (() => {
      const c = document.createElement('canvas');
      c.width = c.height = 128;
      const x = c.getContext('2d');
      const g = x.createRadialGradient(64, 64, 0, 64, 64, 64);
      g.addColorStop(0, 'rgba(255,250,230,1)');
      g.addColorStop(0.25, 'rgba(255,200,110,0.9)');
      g.addColorStop(1, 'rgba(255,140,40,0)');
      x.fillStyle = g;
      x.beginPath();
      for (let i = 0; i < 16; i++) {
        const a = (i / 16) * Math.PI * 2;
        const rr = i % 2 ? 22 : 62;
        x.lineTo(64 + Math.cos(a) * rr, 64 + Math.sin(a) * rr);
      }
      x.fill();
      const t = new THREE.CanvasTexture(c);
      t.colorSpace = THREE.SRGBColorSpace;
      return t;
    })();
    this.flash = new THREE.Sprite(new THREE.SpriteMaterial({ map: flashTex, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
    this.flash.visible = false;
    this.vmScene.add(this.flash);
    this.flashLight = new THREE.PointLight(0xffb566, 0, 1.2, 2);
    this.vmScene.add(this.flashLight);
    this.worldFlash = new THREE.PointLight(0xffb566, 0, 7, 2);
    this.scene.add(this.worldFlash);
  }

  // ---------- Impacts ----------

  _buildEffects() {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const x = c.getContext('2d');
    const g = x.createRadialGradient(32, 32, 0, 32, 32, 30);
    g.addColorStop(0, 'rgba(12,10,8,0.95)');
    g.addColorStop(0.35, 'rgba(30,26,22,0.8)');
    g.addColorStop(0.7, 'rgba(60,55,48,0.25)');
    g.addColorStop(1, 'rgba(60,55,48,0)');
    x.fillStyle = g;
    x.fillRect(0, 0, 64, 64);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    this.decalMat = new THREE.MeshStandardMaterial({ map: t, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, roughness: 1 });
    this.decalGeo = new THREE.PlaneGeometry(0.07, 0.07);
    this.decals = [];

    const pc = document.createElement('canvas');
    pc.width = pc.height = 64;
    const px = pc.getContext('2d');
    const pg = px.createRadialGradient(32, 32, 0, 32, 32, 32);
    pg.addColorStop(0, 'rgba(190,175,150,0.7)');
    pg.addColorStop(1, 'rgba(190,175,150,0)');
    px.fillStyle = pg;
    px.fillRect(0, 0, 64, 64);
    const pt = new THREE.CanvasTexture(pc);
    pt.colorSpace = THREE.SRGBColorSpace;
    this.puffMat = new THREE.SpriteMaterial({ map: pt, transparent: true, depthWrite: false });
    this.puffs = [];

    const bc = document.createElement('canvas');
    bc.width = bc.height = 64;
    const bx = bc.getContext('2d');
    const bg = bx.createRadialGradient(32, 32, 0, 32, 32, 32);
    bg.addColorStop(0, 'rgba(0,0,0,0.45)');
    bg.addColorStop(1, 'rgba(0,0,0,0)');
    bx.fillStyle = bg;
    bx.fillRect(0, 0, 64, 64);
    const bt = new THREE.CanvasTexture(bc);
    this.blobMat = new THREE.MeshBasicMaterial({ map: bt, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3 });
  }

  _impact(hit) {
    const n = hit.face ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld) : new THREE.Vector3(0, 1, 0);
    let decal = this.decals.length >= 60 ? this.decals.shift() : new THREE.Mesh(this.decalGeo, this.decalMat);
    decal.position.copy(hit.point).addScaledVector(n, 0.003);
    decal.lookAt(decal.position.clone().add(n));
    decal.rotateZ(Math.random() * Math.PI);
    const s = rand(0.7, 1.2);
    decal.scale.set(s, s, 1);
    this.scene.add(decal);
    this.decals.push(decal);
    const puff = new THREE.Sprite(this.puffMat.clone());
    puff.position.copy(hit.point).addScaledVector(n, 0.05);
    puff.userData.t = 0;
    this.scene.add(puff);
    this.puffs.push(puff);
  }

  _updateEffects(dt) {
    this.puffs = this.puffs.filter((p) => {
      p.userData.t += dt;
      const k = p.userData.t / 0.45;
      if (k >= 1) {
        this.scene.remove(p);
        p.material.dispose();
        return false;
      }
      const s = 0.08 + k * 0.45;
      p.scale.set(s, s, 1);
      p.position.y += dt * 0.25;
      p.material.opacity = 0.7 * (1 - k);
      return true;
    });
  }

  // ---------- Sound ----------

  _audio() {
    if (this.ctx) return this.ctx;
    try {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      const len = this.ctx.sampleRate * 0.4;
      this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const d = this.noise.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      // A short outdoor tail for the shot, made from decaying noise.
      const tail = this.ctx.sampleRate * 0.9;
      this.verb = this.ctx.createConvolver();
      const ir = this.ctx.createBuffer(2, tail, this.ctx.sampleRate);
      for (let ch = 0; ch < 2; ch++) {
        const c = ir.getChannelData(ch);
        for (let i = 0; i < tail; i++) c[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / tail, 4) * 0.5;
      }
      this.verb.buffer = ir;
      this.verbGain = this.ctx.createGain();
      this.verbGain.gain.value = 0.35;
      this.verb.connect(this.verbGain).connect(this.ctx.destination);
    } catch {
      this.ctx = null;
    }
    return this.ctx;
  }

  _volume() {
    return clamp(Number(this.cfg?.settings?.hitVolume ?? 100), 0, 100) / 100;
  }

  _soundShot() {
    const vol = this._volume();
    const ctx = vol > 0 && this._audio();
    if (!ctx) return;
    if (ctx.state === 'suspended') ctx.resume();
    const now = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.playbackRate.value = rand(0.92, 1.05);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(5200, now);
    lp.frequency.exponentialRampToValueAtTime(900, now + 0.12);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(0.5 * vol, now + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.16);
    src.connect(lp).connect(g);
    g.connect(ctx.destination);
    g.connect(this.verb);
    src.start(now);
    src.stop(now + 0.2);
    const thump = ctx.createOscillator();
    thump.type = 'sine';
    thump.frequency.setValueAtTime(110, now);
    thump.frequency.exponentialRampToValueAtTime(45, now + 0.09);
    const tg = ctx.createGain();
    tg.gain.setValueAtTime(0.5 * vol, now);
    tg.gain.exponentialRampToValueAtTime(0.0001, now + 0.11);
    thump.connect(tg).connect(ctx.destination);
    thump.start(now);
    thump.stop(now + 0.12);
  }

  _soundHit(head) {
    const vol = this._volume();
    const ctx = vol > 0 && this._audio();
    if (!ctx) return;
    const now = ctx.currentTime + 0.03;
    const tones = head ? [2150, 3220] : [760];
    for (const f of tones) {
      const o = ctx.createOscillator();
      o.type = head ? 'sine' : 'triangle';
      o.frequency.setValueAtTime(f, now);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, now);
      g.gain.exponentialRampToValueAtTime((head ? 0.12 : 0.1) * vol, now + 0.004);
      g.gain.exponentialRampToValueAtTime(0.0001, now + (head ? 0.22 : 0.07));
      o.connect(g).connect(ctx.destination);
      o.start(now);
      o.stop(now + 0.25);
    }
  }

  _soundClick(pitch = 1) {
    const vol = this._volume();
    const ctx = vol > 0 && this._audio();
    if (!ctx) return;
    const now = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 2400 * pitch;
    bp.Q.value = 3;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.25 * vol, now);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.05);
    src.connect(bp).connect(g).connect(ctx.destination);
    src.start(now);
    src.stop(now + 0.06);
  }

  // ---------- Input ----------

  _bindEvents() {
    document.addEventListener('pointerlockchange', () => {
      if (!this.active) return;
      const locked = document.pointerLockElement === this.canvas;
      if (!locked && this.running && !this.paused) this._pause();
    });
    window.addEventListener('blur', () => {
      if (this.active && this.running && !this.paused) this._pause();
    });
    document.addEventListener('mousemove', (e) => {
      if (!this.running || this.paused || document.pointerLockElement !== this.canvas) return;
      this._look(e.movementX, e.movementY, e.timeStamp);
    });
    document.addEventListener('mousedown', (e) => {
      if (!this.running || this.paused || document.pointerLockElement !== this.canvas) return;
      if (e.button === 0) {
        this.trigger = true;
        this._tryFire(performance.now());
      }
    });
    document.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.trigger = false;
    });
    document.addEventListener('keydown', (e) => {
      if (!this.running || this.paused) return;
      if (['Space', 'KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyC', 'KeyR', 'ShiftLeft', 'ShiftRight'].includes(e.code)) e.preventDefault();
      this.keys.add(e.code);
      if (e.code === 'KeyR') this._reload();
      if (e.code === 'Space' && this.player.onGround) {
        this.player.vy = JUMP_SPEED;
        this.player.onGround = false;
      }
    });
    document.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('resize', () => this.active && this._resize());
  }

  _rotationScale() {
    const { game, tab, settings } = this.cfg;
    const d = game.degPerCount(tab, settings);
    return { x: d.x * DEG, y: d.y * DEG };
  }

  _look(mx, my, t) {
    const s = this._rotationScale();
    const p = this.player;
    p.yaw -= mx * s.x;
    p.pitch = clamp(p.pitch - my * s.y, -PITCH_LIMIT, PITCH_LIMIT);
    // The rifle lags the view a touch, the way a real one's weight does.
    this.sway.x += clamp(mx * s.x, -0.05, 0.05);
    this.sway.y += clamp(my * s.y, -0.05, 0.05);
    if (this.flick) this.flick.path.push({ t: t ?? performance.now(), yaw: p.yaw, pitch: p.pitch });
  }

  // ---------- Starting and stopping ----------

  /**
   * cfg: { game, tab, settings } with the session's sens already applied,
   * mode: 'test' | 'free', dummies: 'standing' | 'strafing',
   * distance: 'close' | 'mid' | 'far' | 'mixed', sens (for the summary).
   */
  async start(cfg) {
    this._build();
    this.cfg = cfg;
    this.active = true;
    this.overlay.classList.add('active');
    this.stage.classList.remove('show-cursor');
    this.el.results.classList.remove('active');
    this.el.pause.classList.remove('active');
    this._reset();
    this._resize();
    try {
      if (this.overlay.requestFullscreen) await this.overlay.requestFullscreen();
    } catch {
      /* windowed is fine */
    }
    this._resize();
    const locked = await this._lock();
    if (!locked) this._pause('nolock');
    if (cfg.mode === 'test') this._countdown();
    else this._beginFree();
    if (!this.rafId) this._frame();
  }

  _reset() {
    // Free roam starts in a booth; the head test starts out in the open at
    // the firing line, so the lane dividers never hide a dummy.
    const start = this.cfg && this.cfg.mode === 'test' ? { x: 0, z: -3.2 } : { x: 1.6, z: 2.6 };
    this.player = { ...start, vx: 0, vz: 0, y: 0, vy: 0, onGround: true, yaw: 0, pitch: -1 * DEG, eye: EYE };
    this.punch = { pitch: 0, yaw: 0 };
    this.kick = { z: 0, vz: 0, rx: 0, vrx: 0, ry: 0, vry: 0 };
    this.sway = { x: 0, y: 0, ox: 0, oy: 0 };
    this.bob = 0;
    this.moving = 0;
    this.trigger = false;
    this.lastShot = 0;
    this.burst = 0;
    this.ammo = MAG_SIZE;
    this.reloadUntil = 0;
    this.flashUntil = 0;
    this.keys.clear();
    this.flick = null;
    this.test = null;
    this.stats = { shots: 0, heads: 0, bodies: 0, kills: 0 };
    for (const d of this.dummies) {
      d.state = 'hidden';
      d.root.visible = false;
      d.respawnAt = 0;
      d.alive = false;
    }
    for (const dec of this.decals) this.scene.remove(dec);
    this.decals = [];
    this.running = false;
    this.paused = false;
    this.lastFrame = performance.now();
    this._hud();
  }

  /** Captures the mouse with raw input where the browser has it. A request
   * that never answers counts as refused after a moment, so the range can't
   * hang waiting - it pauses, and Resume tries again. */
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

  _pause(reason) {
    this.paused = true;
    this.trigger = false;
    this.keys.clear();
    if (this.flick) this.flick.void = true;
    if (this.countdownTimer) {
      clearTimeout(this.countdownTimer);
      this.countdownTimer = null;
      this.el.getReady.classList.remove('active');
      this.countdownPending = true;
    }
    this.stage.classList.add('show-cursor');
    this.el.pauseReason.textContent =
      reason === 'nolock' ? "Your mouse wasn't captured. Click Resume to try again." : 'Paused. Click Resume to carry on.';
    this.el.pause.classList.add('active');
  }

  async resume() {
    this.el.pause.classList.remove('active');
    const locked = await this._lock();
    if (!locked) {
      this._pause('nolock');
      return;
    }
    this.paused = false;
    this.stage.classList.remove('show-cursor');
    this.lastFrame = performance.now();
    if (this.countdownPending) {
      this.countdownPending = false;
      this._countdown();
    }
  }

  exit() {
    this.active = false;
    this.running = false;
    this.paused = false;
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = null;
    if (this.countdownTimer) clearTimeout(this.countdownTimer);
    this.countdownTimer = null;
    this.el.getReady.classList.remove('active');
    this.el.pause.classList.remove('active');
    this.el.results.classList.remove('active');
    if (document.pointerLockElement === this.canvas) document.exitPointerLock();
    if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
    this.overlay.classList.remove('active');
  }

  // ---------- Head test ----------

  _countdown() {
    this.running = true; // you can look and walk about during the count
    this.el.getReadyLabel.textContent = 'Head test · 30 dummies';
    this.el.getReady.classList.add('active');
    let n = 3;
    this.el.getReadyNum.textContent = n;
    const tick = () => {
      n -= 1;
      if (n <= 0) {
        this.countdownTimer = null;
        this.el.getReady.classList.remove('active');
        this.test = { left: TEST_DUMMIES, records: [], started: performance.now(), elapsed: 0, current: null };
        this._nextTestDummy();
        return;
      }
      this.el.getReadyNum.textContent = n;
      this.countdownTimer = setTimeout(tick, 700);
    };
    if (this.paused) {
      this.countdownPending = true;
      this.el.getReady.classList.remove('active');
      return;
    }
    this.countdownTimer = setTimeout(tick, 700);
  }

  /** Where the next test dummy goes: off to one side of where you're
   * looking, by an angle like the flick check's (and never more than
   * TEST_MAX_CM of mouse movement), at a distance in the chosen band,
   * inside the field and in plain sight. */
  _testSpot() {
    const p = this.player;
    const [dMin, dMax] = TEST_DISTANCES[this.cfg.distance] || TEST_DISTANCES.mid;
    let maxA = TEST_FLICK.max;
    try {
      const { game, tab, settings } = this.cfg;
      const cm360 = game.cm360(tab, settings);
      if (cm360 > 0) maxA = Math.min(maxA, (TEST_MAX_CM / cm360) * 2 * Math.PI);
    } catch {
      /* keep the default */
    }
    maxA = Math.min(maxA, this.halfHFov * 0.8);
    const minA = Math.min(TEST_FLICK.min, maxA * 0.5);
    const eye = new THREE.Vector3(p.x, p.y + p.eye, p.z);
    for (let i = 0; i < 40; i++) {
      const a = p.yaw + (Math.random() < 0.5 ? -1 : 1) * Math.exp(rand(Math.log(minA), Math.log(maxA)));
      const dist = rand(dMin, dMax);
      const x = p.x - Math.sin(a) * dist;
      const z = p.z - Math.cos(a) * dist;
      if (x < TARGET_AREA.xMin || x > TARGET_AREA.xMax || z < TARGET_AREA.zMin || z > TARGET_AREA.zMax) continue;
      if (this.colliders.some((c) => x > c.x0 - 0.3 && x < c.x1 + 0.3 && z > c.z0 - 0.3 && z < c.z1 + 0.3)) continue;
      const head = new THREE.Vector3(x, HEAD_Y, z);
      if (!this._clearLine(eye, head)) continue;
      return { x, z };
    }
    // Facing somewhere odd (back towards the bay, into a wall): anywhere
    // downrange that can be seen, else straight down the middle.
    for (let i = 0; i < 40; i++) {
      const x = rand(-11, 11);
      const z = p.z - rand(dMin, dMax);
      if (z < TARGET_AREA.zMin || z > TARGET_AREA.zMax) continue;
      if (this.colliders.some((c) => x > c.x0 - 0.3 && x < c.x1 + 0.3 && z > c.z0 - 0.3 && z < c.z1 + 0.3)) continue;
      if (this._clearLine(eye, new THREE.Vector3(x, HEAD_Y, z))) return { x, z };
    }
    return { x: 0, z: clamp(p.z - dMin, TARGET_AREA.zMin, TARGET_AREA.zMax) };
  }

  _clearLine(from, to) {
    const dir = to.clone().sub(from);
    const len = dir.length();
    this.ray = this.ray || new THREE.Raycaster();
    this.ray.set(from, dir.normalize());
    this.ray.far = len - 0.2;
    return this.ray.intersectObjects(this.solids, false).length === 0;
  }

  _nextTestDummy() {
    const t = this.test;
    if (!t) return;
    if (t.left <= 0) {
      this._finishTest();
      return;
    }
    const spot = this._testSpot();
    const d = this._spawnDummy(spot.x, spot.z, { strafe: this.cfg.dummies === 'strafing' });
    // The flick to this head starts now, from wherever you're looking.
    const p = this.player;
    const eye = new THREE.Vector3(p.x, p.y + p.eye, p.z);
    const dx = spot.x - eye.x;
    const dz = spot.z - eye.z;
    const flat = Math.hypot(dx, dz);
    const yawT = p.yaw + wrapPi(Math.atan2(-dx, -dz) - p.yaw);
    const pitchT = Math.atan2(HEAD_Y - eye.y, flat);
    t.current = { dummy: d, spawned: performance.now(), shots: 0, bodies: 0, first: null };
    this.flick = {
      path: [{ t: performance.now(), yaw: p.yaw, pitch: p.pitch }],
      target: { yaw: yawT, pitch: pitchT, r: Math.atan(HEAD_R / Math.hypot(flat, HEAD_Y - eye.y)) },
      misses: 0,
      void: false,
      moving: !!d.strafe,
    };
  }

  _testShot(result) {
    const t = this.test;
    const c = t && t.current;
    if (!c) return;
    c.shots++;
    if (c.first === null) c.first = result;
    if (result !== 'head') {
      if (result === 'body') c.bodies++;
      if (this.flick) this.flick.misses++;
      return;
    }
    const now = performance.now();
    let read = null;
    const f = this.flick;
    if (f && !f.void && !f.moving) {
      f.path.push({ t: now, yaw: this.player.yaw, pitch: this.player.pitch });
      read = analyseFlick(f.path, f.target, f.misses);
    }
    t.records.push({ timeMs: now - c.spawned, shots: c.shots, bodies: c.bodies, firstHead: c.first === 'head', flick: read });
    t.left--;
    t.current = null;
    this.flick = null;
    setTimeout(() => this.running && this.test === t && this._nextTestDummy(), 260);
  }

  _finishTest() {
    const t = this.test;
    const recs = t.records;
    const med = (xs) => {
      const s = [...xs].sort((a, b) => a - b);
      const m = s.length >> 1;
      return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
    };
    const flicks = recs.map((r) => r.flick).filter(Boolean);
    const f = summariseFlicks(flicks);
    const shots = recs.reduce((s, r) => s + r.shots, 0);
    const summary = {
      date: Date.now(),
      game: this.cfg.game.id,
      sens: this.cfg.sens,
      cm360: this.cfg.game.cm360(this.cfg.tab, this.cfg.settings),
      dummies: this.cfg.dummies,
      distance: this.cfg.distance,
      kills: recs.length,
      timeMs: med(recs.map((r) => r.timeMs)),
      firstShotRate: recs.filter((r) => r.firstHead).length / recs.length,
      headAccuracy: recs.length / Math.max(1, shots),
      flicks: f.n,
      landRate: f.n ? f.landRate : null,
      bias: f.n ? f.bias : null,
      corrections: f.n ? f.corrections : null,
      totalMs: performance.now() - t.started,
    };
    this.test = null;
    this.running = false;
    this.trigger = false;
    if (document.pointerLockElement === this.canvas) document.exitPointerLock();
    this.stage.classList.add('show-cursor');
    this._showResults(summary);
    this.onFinish?.(summary);
  }

  _showResults(s) {
    const pct = (v) => (v == null || !isFinite(v) ? '—' : `${Math.round(v * 100)}%`);
    this.el.resultsSub.textContent = `${this.cfg.sensLabel} · ${s.dummies} dummies · ${s.distance} range`;
    const tiles = [
      ['Time to kill', `${Math.round(s.timeMs)} ms`],
      ['First-shot kills', pct(s.firstShotRate)],
      ['Headshot accuracy', pct(s.headAccuracy)],
      ['First flick on the head', pct(s.landRate)],
    ];
    this.el.resultsGrid.innerHTML = tiles
      .map(([k, v]) => `<div class="range-tile"><div class="stat-label">${k}</div><div class="stat-value">${v}</div></div>`)
      .join('');
    const box = this.el.aim;
    const verdict = s.bias != null ? AIM_VERDICTS[verdictFor(s.bias)] : null;
    if (!verdict) {
      box.hidden = true;
    } else {
      box.hidden = false;
      this.el.aimTitle.textContent = verdict.title;
      this.el.aimTag.textContent = `${s.flicks} flicks read`;
      this.el.aimText.textContent = verdict.text;
      this.el.aimDot.style.left = `${50 + (clamp(s.bias, -2, 2) / 2) * 50}%`;
    }
    this.el.results.classList.add('active');
  }

  // ---------- Free roam ----------

  _beginFree() {
    this.running = true;
    const spots = [
      [-9.6, -6.5], [-3.2, -11.5], [3.2, -11.5], [9.6, -16.5],
      [-6.4, -21.5], [0, -21.5], [6.4, -31.5], [-9.6, -31.5], [0, -41.5], [-3.2, -51.5], [6.4, -51.5],
    ];
    spots.forEach(([x, z], i) => this._spawnDummy(x, z, { strafe: i === 5 || i === 8, respawn: 1400 }));
  }

  // ---------- Shooting ----------

  _reload() {
    const now = performance.now();
    if (this.cfg.mode === 'test' || this.reloadUntil > now || this.ammo === MAG_SIZE) return;
    this.reloadUntil = now + RELOAD_MS;
    this.reloadStart = now;
    this._soundClick(0.8);
    setTimeout(() => this.active && this._soundClick(1.2), RELOAD_MS * 0.7);
  }

  _tryFire(now) {
    if (!this.running || this.paused) return;
    if (now < this.reloadUntil) return;
    if (now - this.lastShot < FIRE_MS - 2) return;
    if (this.cfg.mode !== 'test' && this.ammo <= 0) {
      this._reload();
      return;
    }
    this._fire(now);
  }

  _fire(now) {
    // A burst: shots close together. The first one of a burst goes exactly
    // where the crosshair is; each one after kicks the view up a little
    // (with some sideways wander), and the view settles back when you stop.
    if (now - this.lastShot > 260) this.burst = 0;
    this.lastShot = now;
    this.burst++;
    if (this.cfg.mode !== 'test') this.ammo--;
    this.stats.shots++;

    this._aimCamera();
    this.ray = this.ray || new THREE.Raycaster();
    const dir = new THREE.Vector3();
    this.camera.getWorldDirection(dir);
    this.ray.set(this.camera.position, dir);
    this.ray.far = 400;
    const targets = [];
    for (const d of this.dummies) if (d.alive && d.root.visible) targets.push(...d.parts);
    const hit = this.ray.intersectObjects([...targets, ...this.solids], false)[0];
    let result = 'miss';
    if (hit && hit.object.userData.dummy) {
      const d = hit.object.userData.dummy;
      if (hit.object.userData.zone === 'head') {
        result = 'head';
        this.stats.heads++;
        this.stats.kills++;
        this._killDummy(d);
        this._hitmarker(true);
        this._soundHit(true);
      } else {
        result = 'body';
        this.stats.bodies++;
        d.hits++;
        d.flash = 0.08;
        d.jolt = 0.06 * (Math.random() < 0.5 ? -1 : 1);
        this._hitmarker(false);
        this._soundHit(false);
        // Free roam: four to the body drops one too.
        if (this.cfg.mode !== 'test' && d.hits >= 4) {
          this.stats.kills++;
          this._killDummy(d);
        }
      }
    } else if (hit) {
      this._impact(hit);
    }
    if (this.test) this._testShot(result);

    // Recoil: the view kicks (applied after the shot, so the shot itself
    // went where you aimed) and the rifle jolts back.
    const room = 1 - this.punch.pitch / (5 * DEG);
    this.punch.pitch += 0.5 * DEG * Math.max(0.2, room);
    this.punch.yaw += rand(-0.22, 0.22) * DEG * Math.min(1, this.burst / 3);
    this.kick.vz += 1.6;
    this.kick.vrx += 22;
    this.kick.vry += rand(-6, 6);
    this.flashUntil = now + 45;
    this.flash.material.rotation = Math.random() * Math.PI;
    const fs = rand(0.07, 0.1);
    this.flash.scale.set(fs, fs, 1);
    this._soundShot();
  }

  _hitmarker(head) {
    const m = this.el.hitmarker;
    m.classList.remove('show', 'head');
    void m.offsetWidth;
    m.classList.add('show');
    if (head) m.classList.add('head');
  }

  // ---------- Each frame ----------

  _aimCamera() {
    const p = this.player;
    this.camera.position.set(p.x, p.y + p.eye, p.z);
    this.camera.rotation.set(p.pitch + this.punch.pitch, p.yaw + this.punch.yaw, 0);
    this.camera.updateMatrixWorld(true);
  }

  _move(dt) {
    const p = this.player;
    const k = this.keys;
    const crouch = k.has('KeyC');
    const walk = k.has('ShiftLeft') || k.has('ShiftRight');
    const fwd = (k.has('KeyW') ? 1 : 0) - (k.has('KeyS') ? 1 : 0);
    const side = (k.has('KeyD') ? 1 : 0) - (k.has('KeyA') ? 1 : 0);
    const speed = crouch ? SPEED.crouch : walk ? SPEED.walk : SPEED.run;
    let wx = 0;
    let wz = 0;
    if (fwd || side) {
      const len = Math.hypot(fwd, side);
      const sin = Math.sin(p.yaw);
      const cos = Math.cos(p.yaw);
      // Forward is -z at yaw 0; right is +x.
      wx = ((-sin * fwd + cos * side) / len) * speed;
      wz = ((-cos * fwd - sin * side) / len) * speed;
    }
    const accel = p.onGround ? ACCEL : ACCEL * 0.25;
    p.vx += clamp(wx - p.vx, -accel * dt, accel * dt);
    p.vz += clamp(wz - p.vz, -accel * dt, accel * dt);
    let nx = p.x + p.vx * dt;
    let nz = p.z + p.vz * dt;
    // Slide along anything in the way, one axis at a time.
    for (const c of this.colliders) {
      if (nx > c.x0 && nx < c.x1 && p.z > c.z0 && p.z < c.z1) nx = p.x;
    }
    for (const c of this.colliders) {
      if (nx > c.x0 && nx < c.x1 && nz > c.z0 && nz < c.z1) nz = p.z;
    }
    p.x = clamp(nx, BOUNDS.xMin, BOUNDS.xMax);
    p.z = clamp(nz, BOUNDS.zMin, BOUNDS.zMax);
    if (!p.onGround || p.vy) {
      p.vy -= GRAVITY * dt;
      p.y += p.vy * dt;
      if (p.y <= 0) {
        p.y = 0;
        p.vy = 0;
        p.onGround = true;
      }
    }
    p.eye += ((crouch ? EYE_CROUCH : EYE) - p.eye) * Math.min(1, dt * 12);
    const moving = Math.hypot(p.vx, p.vz);
    if (p.onGround) this.bob += moving * dt * 1.9;
    this.moving = moving;
  }

  _updateRecoil(dt, now) {
    // View punch settles back quickly once you stop shooting.
    const firing = now - this.lastShot < 140;
    const back = Math.exp(-dt * (firing ? 3 : 11));
    this.punch.pitch *= back;
    this.punch.yaw *= back;
    // The rifle's own jolt: springs back to rest.
    const k = this.kick;
    const spring = (x, v, stiff, damp) => {
      v += (-stiff * x - damp * v) * dt;
      return [x + v * dt, v];
    };
    [k.z, k.vz] = spring(k.z, k.vz, 260, 26);
    [k.rx, k.vrx] = spring(k.rx, k.vrx, 300, 28);
    [k.ry, k.vry] = spring(k.ry, k.vry, 260, 26);
  }

  _updateViewmodel(dt, now) {
    const s = this.sway;
    s.ox += (clamp(s.x * 2.2, -0.06, 0.06) - s.ox) * Math.min(1, dt * 14);
    s.oy += (clamp(s.y * 2.2, -0.05, 0.05) - s.oy) * Math.min(1, dt * 14);
    s.x *= Math.exp(-dt * 18);
    s.y *= Math.exp(-dt * 18);
    const move = clamp(this.moving / SPEED.run, 0, 1);
    const bx = Math.sin(this.bob) * 0.008 * move;
    const by = -Math.abs(Math.cos(this.bob)) * 0.01 * move;
    const breathe = Math.sin(now / 900) * 0.0012;
    const r = this.vmRoot;
    // Reloading: dip and roll the rifle, drop the magazine and bring it back.
    let dip = 0;
    let roll = 0;
    let magDrop = 0;
    if (now < this.reloadUntil) {
      const k = (now - this.reloadStart) / RELOAD_MS;
      const inOut = Math.sin(Math.min(1, k) * Math.PI);
      dip = inOut * 0.06;
      roll = inOut * 0.5;
      magDrop = k < 0.5 ? Math.min(1, k * 4) * 0.25 : Math.max(0, 1 - (k - 0.5) * 4) * 0.25;
      if (k >= 1) this.ammo = MAG_SIZE;
    } else if (this.reloadUntil && this.ammo < MAG_SIZE && now >= this.reloadUntil) {
      this.ammo = MAG_SIZE;
      this.reloadUntil = 0;
    }
    this.mag.position.y = -magDrop;
    r.position.set(this.vmRest.x + bx - s.ox * 0.25, this.vmRest.y + by + breathe - dip + s.oy * 0.18, this.vmRest.z + this.kick.z * 0.05);
    r.rotation.set(this.kick.rx * 0.012 + s.oy * 0.8 - dip * 2, this.kick.ry * 0.006 + s.ox * 0.9, roll + s.ox * 0.5);

    const on = now < this.flashUntil;
    this.flash.visible = on;
    if (on) {
      this.muzzle.getWorldPosition(this.flash.position);
      this.flashLight.position.copy(this.flash.position);
    }
    this.flashLight.intensity = on ? 3 : 0;
    this.worldFlash.intensity = on ? 12 : 0;
    this.worldFlash.position.copy(this.camera.position).addScaledVector(this.camera.getWorldDirection(new THREE.Vector3()), 1.2);
  }

  _frame() {
    this.rafId = requestAnimationFrame(() => this._frame());
    const now = performance.now();
    const dt = Math.min(0.05, (now - this.lastFrame) / 1000);
    this.lastFrame = now;
    if (!this.active) return;
    if (this.running && !this.paused) {
      this._move(dt);
      if (this.trigger) this._tryFire(now);
    }
    this._updateRecoil(dt, now);
    this._updateDummies(dt);
    this._updateEffects(dt);
    this._aimCamera();
    this._updateViewmodel(dt, now);
    const r = this.renderer;
    r.clear();
    r.render(this.scene, this.camera);
    r.clearDepth();
    r.render(this.vmScene, this.vmCamera);
    this._hud(now);
  }

  _hud(now = performance.now()) {
    const e = this.el;
    if (!e) return;
    if (this.cfg?.mode === 'test') {
      const t = this.test;
      const done = t ? TEST_DUMMIES - t.left : 0;
      e.hudMain.textContent = `${done} / ${TEST_DUMMIES}`;
      e.hudSub.textContent = t ? `${((now - t.started) / 1000).toFixed(1)}s` : 'Head test';
      e.ammo.textContent = '∞';
    } else {
      const s = this.stats || { kills: 0, heads: 0, shots: 0 };
      e.hudMain.textContent = `${s.kills} down`;
      e.hudSub.textContent = s.shots ? `Headshots ${Math.round((s.heads / s.shots) * 100)}% of shots` : 'Free roam';
      e.ammo.textContent = this.reloadUntil > now ? 'Reloading' : `${this.ammo} / ${MAG_SIZE}`;
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
    Object.assign(this.canvas.style, {
      position: 'absolute',
      width: `${w}px`,
      height: `${h}px`,
      left: `${(rect.width - w) / 2}px`,
      top: `${(rect.height - h) / 2}px`,
    });
    if (view.renderSize) {
      this.renderer.setPixelRatio(1);
      this.renderer.setSize(view.renderSize.w, view.renderSize.h, false);
    } else {
      this.renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
      this.renderer.setSize(w, h, false);
    }
    for (const cam of [this.camera, this.vmCamera]) cam.aspect = view.aspect;
    this.camera.fov = view.vFovDeg;
    this.camera.updateProjectionMatrix();
    this.vmCamera.updateProjectionMatrix();
    this.halfHFov = Math.atan(Math.tan((view.vFovDeg * DEG) / 2) * view.aspect);
    this._drawCrosshair(w, h, view.aspect, view.stretch);
  }

  _drawCrosshair(w, h, selected, stretch) {
    const el = this.stage.querySelector('.drill-crosshair');
    if (!el) return;
    if (!this.crosshairCanvas) {
      this.crosshairCanvas = document.createElement('canvas');
      el.appendChild(this.crosshairCanvas);
      el.classList.add('drawn');
    }
    const settings = this.cfg.settings;
    const dpr = window.devicePixelRatio || 1;
    const size = drawCrosshair(
      this.crosshairCanvas,
      getCrosshair(settings.crosshair),
      settings.crosshairColor || DEFAULT_CROSSHAIR_COLOR,
      (h * dpr) / 1080
    );
    const devW = Math.round(size * (stretch ? w / h / selected : 1));
    const stage = this.stage.getBoundingClientRect();
    el.style.width = `${devW / dpr}px`;
    el.style.height = `${size / dpr}px`;
    el.style.left = `${Math.round((stage.width * dpr - devW) / 2) / dpr}px`;
    el.style.top = `${Math.round((stage.height * dpr - size) / 2) / dpr}px`;
  }
}
