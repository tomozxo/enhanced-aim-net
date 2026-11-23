// The guns the range's hands hold: one body per real-world weapon family,
// built from simple shapes. Each is drawn from the general, well-known look
// of the real firearm (an AK's wooden furniture and curved magazine, an
// MP5's slim tapered handguard, a Thompson's finned barrel and wooden
// grips...) with its own simplified rework - none of them is a copy of any
// game's model or texture.
//
// Every body shares one frame so the hands and sights (range.js) fit all of
// them: the bore runs along -z at y = 0.03, the pistol grip sits at z ≈ 0.02
// to 0.11, and the top of the rail the sights clamp to is y = 0.071 between
// z = 0.05 and -0.1. A body returns where its own left-hand hold is
// (leftZ/leftY: shift from the default handguard hold) and its magazine
// (for the reload animation).

import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js';

/** Which body each gun in the recoil trainer gets, by game and gun id. */
export const GUN_MODELS = {
  rust: {
    ak: ['ak', { furniture: 'wood' }],
    lr: ['ar', { stock: 'folder', handguard: 'black', barrel: 0.16 }],
    mp5: ['mp5', {}],
    thompson: ['thompson', {}],
    custom: ['scrap', {}],
    m249: ['lmg', { tone: 'black' }],
    hmlmg: ['lmg', { tone: 'olive', heavy: true }],
    sar: ['dmr', { furniture: 'wood' }],
    m39: ['dmr', { furniture: 'black' }],
  },
  r6: {
    r4c: ['ar', { handguard: 'black', stock: 'm4' }],
    ak12: ['ak', { furniture: 'polymer' }],
    552: ['ar', { handguard: 'ribbed', stock: 'folder', short: true }],
    '416c': ['ar', { handguard: 'tan', stock: 'folder', short: true }],
    f2: ['bullpup', { tone: 'black', handle: true }],
    c9: ['ar', { handguard: 'black', stock: 'm4', short: true, smgMag: true }],
    aug: ['bullpup', { tone: 'olive' }],
    mp5: ['mp5', {}],
    p90: ['p90', {}],
    mpx: ['ar', { handguard: 'black', stock: 'folder', short: true, smgMag: true }],
    ump: ['ump', {}],
    '6p41': ['lmg', { tone: 'black' }],
    lmge: ['lmg', { tone: 'black', drum: true }],
    t95: ['bullpup', { tone: 'black', long: true }],
  },
};

/** The gun a game's range hands you when no recoil gun is picked. */
export const DEFAULT_GUN = { rust: 'ak', r6: 'r4c' };

/** [family, options] for a game and gun id - the range's own rifle for
 * anything not listed. */
export function modelFor(gameId, gunId) {
  const g = GUN_MODELS[gameId];
  const id = gunId || DEFAULT_GUN[gameId];
  return (g && g[id]) || ['ar', { handguard: 'tan', stock: 'm4' }];
}

// ---------- Materials ----------

let MATS = null;
function woodTexture() {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 256;
  const x = c.getContext('2d');
  x.fillStyle = '#7a4a26';
  x.fillRect(0, 0, 64, 256);
  // Long grain along the length of the part.
  for (let i = 0; i < 70; i++) {
    const px = Math.random() * 64;
    x.strokeStyle = `rgba(${Math.random() < 0.5 ? '60,32,14' : '150,96,52'},${0.15 + Math.random() * 0.25})`;
    x.lineWidth = 0.5 + Math.random() * 1.6;
    x.beginPath();
    x.moveTo(px, 0);
    for (let y = 0; y <= 256; y += 32) x.lineTo(px + Math.sin(y / 40 + i) * 2.5, y);
    x.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}
function mats() {
  if (MATS) return MATS;
  const std = (o) => new THREE.MeshStandardMaterial(o);
  MATS = {
    blued: std({ color: 0x26282c, metalness: 0.75, roughness: 0.38, envMapIntensity: 0.9 }),
    steel: std({ color: 0x4b4e53, metalness: 0.85, roughness: 0.3, envMapIntensity: 1 }),
    worn: std({ color: 0x55534f, metalness: 0.8, roughness: 0.5, envMapIntensity: 0.8 }),
    black: std({ color: 0x17181b, metalness: 0.15, roughness: 0.62, envMapIntensity: 0.6 }),
    polymer: std({ color: 0x232427, metalness: 0.05, roughness: 0.75, envMapIntensity: 0.5 }),
    tan: std({ color: 0x8b7c61, metalness: 0.08, roughness: 0.66, envMapIntensity: 0.5 }),
    olive: std({ color: 0x4f5638, metalness: 0.08, roughness: 0.7, envMapIntensity: 0.5 }),
    wood: std({ color: 0xffffff, map: woodTexture(), metalness: 0.02, roughness: 0.55, envMapIntensity: 0.6 }),
    rust: std({ color: 0x6e4a30, metalness: 0.55, roughness: 0.85, envMapIntensity: 0.5 }),
    tape: std({ color: 0x2f3a2c, metalness: 0, roughness: 0.95 }),
    smoke: std({ color: 0x3a3a30, metalness: 0.1, roughness: 0.25, transparent: true, opacity: 0.7, envMapIntensity: 1.2 }),
  };
  return MATS;
}

// ---------- Shape helpers ----------

/** A rounded box. */
function rbox(w, h, d, r, mat) {
  const s = new THREE.Shape();
  const x = -w / 2;
  const y = -h / 2;
  r = Math.min(r, w / 2 - 1e-4, h / 2 - 1e-4);
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
  const g = new THREE.ExtrudeGeometry(s, { depth: Math.max(1e-4, d - 2 * b), bevelEnabled: true, bevelThickness: b, bevelSize: b * 0.6, bevelSegments: 2, curveSegments: 4 });
  g.translate(0, 0, -(d - 2 * b) / 2);
  return new THREE.Mesh(g, mat);
}

/** A side profile ([forward, up] points) extruded to a width. */
function profile(points, width, mat, bevel = 0.003) {
  const s = new THREE.Shape(points.map(([u, v]) => new THREE.Vector2(u, v)));
  const g = new THREE.ExtrudeGeometry(s, { depth: Math.max(1e-4, width - 2 * bevel), bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 2, curveSegments: 6 });
  g.translate(0, 0, -(width - 2 * bevel) / 2);
  g.rotateY(Math.PI / 2); // u -> -z (forward)
  return new THREE.Mesh(g, mat);
}

/** A cylinder along the bore (z), from z0 to z1. */
function tube(r, z0, z1, y, mat, x = 0, seg = 16) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, Math.abs(z1 - z0), seg), mat);
  m.rotation.x = Math.PI / 2;
  m.position.set(x, y, (z0 + z1) / 2);
  return m;
}

/** A curved magazine's side profile: `curve` is how far forward its foot
 * sweeps, `len` how far it hangs below the receiver. */
function magShape(front, depth, len, curve, top = -0.05) {
  const pts = [];
  for (let i = 0; i <= 8; i++) {
    const t = i / 8;
    pts.push([front + curve * t * t, top - len * t]);
  }
  for (let i = 8; i >= 0; i--) {
    const t = i / 8;
    pts.push([front + curve * t * t + depth, top - len * t + 0.006 * t]);
  }
  return pts;
}

class Body {
  constructor() {
    this.group = new THREE.Group();
    this.mag = null;
    this.leftZ = 0;
    this.leftY = 0;
  }
  add(m, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) {
    m.position.set(x, y, z);
    m.rotation.set(rx, ry, rz);
    this.group.add(m);
    return m;
  }
  put(m) {
    this.group.add(m);
    return m;
  }
  /** The top rail the sights clamp to, from z0 to z1, with its teeth. */
  rail(z0 = 0.13, z1 = -0.47, mat = mats().black) {
    const len = z0 - z1;
    this.add(new THREE.Mesh(new THREE.BoxGeometry(0.024, 0.01, len), mat), 0, 0.066, (z0 + z1) / 2);
    const n = Math.floor(len / 0.01);
    const teeth = new THREE.InstancedMesh(new THREE.BoxGeometry(0.026, 0.006, 0.005), mat, n);
    const m4 = new THREE.Matrix4();
    for (let i = 0; i < n; i++) teeth.setMatrixAt(i, m4.makeTranslation(0, 0.073, z0 - i * 0.01));
    this.group.add(teeth);
  }
  /** Pistol grip behind the trigger, angled back. */
  grip(mat, wide = 0.036) {
    this.add(profile([[-0.005, -0.03], [-0.052, -0.03], [-0.088, -0.15], [-0.086, -0.165], [-0.045, -0.165], [-0.03, -0.15]], wide, mat, 0.006), 0, 0, 0.02);
  }
  trigger(guard = mats().black) {
    const M = mats();
    this.add(new THREE.Mesh(new THREE.BoxGeometry(0.008, 0.004, 0.07), guard), 0, -0.07, -0.035);
    this.add(profile([[0, 0], [0.006, -0.028], [0.0, -0.032], [-0.006, -0.004]], 0.006, M.steel, 0.001), 0, -0.04, -0.03);
  }
  magazine(points, width, mat) {
    this.mag = this.put(profile(points, width, mat, 0.004));
    return this.mag;
  }
  muzzleBrake(z, r, mat) {
    this.put(tube(r, z, z - 0.05, 0.03, mat));
    for (let i = 0; i < 3; i++) this.put(tube(r + 0.0005, z - 0.01 - i * 0.014, z - 0.014 - i * 0.014, 0.03, mats().black));
  }
  done() {
    this.group.traverse((o) => {
      if (o.isMesh) {
        o.frustumCulled = false;
        o.castShadow = false;
      }
    });
    return this;
  }
}

// ---------- The families ----------

/** AR-pattern carbines: R4-C, 416-C, 552, Commando 9, MPX, LR-300. */
function ar(o) {
  const M = mats();
  const b = new Body();
  const metal = M.blued;
  b.add(rbox(0.05, 0.06, 0.3, 0.008, metal), 0, 0.03, -0.02);
  b.add(rbox(0.046, 0.05, 0.19, 0.008, metal), 0, -0.02, 0.0);
  b.add(rbox(0.052, 0.05, 0.075, 0.006, metal), 0, -0.05, -0.075);
  b.add(new THREE.Mesh(new THREE.BoxGeometry(0.004, 0.022, 0.07), M.black), 0.026, 0.03, -0.01);
  b.add(new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.03, 10), M.steel), 0.03, 0.045, 0.06, Math.PI / 2);
  b.add(new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.012, 0.02), M.black), 0, 0.062, 0.12);
  // Handguard: shorter on the compact carbines.
  const hgLen = o.short ? 0.26 : 0.32;
  const hgMid = -0.17 - hgLen / 2;
  const hgMat = o.handguard === 'tan' ? M.tan : M.polymer;
  b.add(rbox(0.058, 0.058, hgLen, 0.012, hgMat), 0, 0.031, hgMid);
  if (o.handguard === 'ribbed') {
    for (let i = 0; i < 9; i++) b.add(rbox(0.062, 0.05, 0.012, 0.01, M.black), 0, 0.028, -0.19 - i * 0.026);
  } else {
    for (let i = 0; i < Math.floor(hgLen / 0.08); i++) {
      for (const s of [-1, 1]) b.add(new THREE.Mesh(new THREE.BoxGeometry(0.004, 0.012, 0.034), M.black), s * 0.0295, 0.028, -0.22 - i * 0.065);
    }
  }
  b.rail(0.13, -0.17 - hgLen);
  // Barrel, gas block and brake.
  const front = -0.17 - hgLen;
  const barrelEnd = front - (o.barrel || (o.short ? 0.1 : 0.16));
  b.put(tube(0.0105, front, barrelEnd, 0.03, M.steel));
  b.muzzleBrake(barrelEnd, 0.0165, M.black);
  // Magazine: curved rifle mag, or a straight 9 mm stick on the SMGs.
  if (o.smgMag) b.magazine(magShape(0.08, 0.04, 0.17, 0.012), 0.026, M.polymer);
  else b.magazine(magShape(0.07, 0.058, 0.19, 0.05), 0.03, M.polymer);
  b.grip(M.polymer);
  b.trigger();
  // Stock: an M4-style collapsing stock, or a folding skeleton.
  if (o.stock === 'folder') {
    b.add(rbox(0.03, 0.05, 0.04, 0.008, M.black), 0, 0.02, 0.15);
    b.add(rbox(0.018, 0.014, 0.2, 0.005, M.black), 0, 0.045, 0.26);
    b.add(rbox(0.018, 0.014, 0.21, 0.005, M.black), 0, -0.03, 0.255, 0.28);
    b.add(rbox(0.04, 0.13, 0.024, 0.008, M.polymer), 0, -0.005, 0.36);
  } else {
    b.put(tube(0.017, 0.12, 0.28, 0.02, M.black));
    b.add(profile([[-0.14, 0.05], [-0.34, 0.05], [-0.36, 0.035], [-0.36, -0.07], [-0.33, -0.08], [-0.2, -0.02], [-0.14, -0.005]], 0.042, M.polymer, 0.006), 0, -0.005, 0);
  }
  b.leftZ = o.short ? 0.05 : 0;
  return b;
}

/** Kalashnikov pattern: wooden AKM-style (Rust's assault rifle) or the
 * modern black AK-12 with a railed handguard. */
function ak(o) {
  const M = mats();
  const b = new Body();
  const modern = o.furniture === 'polymer';
  const furn = modern ? M.polymer : M.wood;
  // Stamped receiver and the rounded dust cover over it.
  b.add(rbox(0.048, 0.064, 0.34, 0.006, M.blued), 0, 0.026, -0.005);
  b.add(rbox(0.046, 0.022, 0.3, 0.01, M.blued), 0, 0.058, 0.0);
  // Rivets down the side.
  for (const z of [0.1, 0.06, -0.12, -0.15]) for (const s of [-1, 1]) b.add(new THREE.Mesh(new THREE.SphereGeometry(0.003, 6, 4), M.steel), s * 0.025, 0.006, z);
  // The big charging handle on the right and the safety lever.
  b.add(rbox(0.012, 0.012, 0.03, 0.005, M.steel), 0.033, 0.038, -0.06);
  b.add(rbox(0.004, 0.02, 0.15, 0.003, M.steel), 0.026, 0.02, 0.04);
  b.rail(0.12, -0.11, M.black);
  // Handguard: wooden lower and gas-tube cover, or a railed AK-12 one.
  if (modern) {
    b.add(rbox(0.058, 0.062, 0.3, 0.01, M.polymer), 0, 0.03, -0.33);
    for (let i = 0; i < 5; i++) for (const s of [-1, 1]) b.add(new THREE.Mesh(new THREE.BoxGeometry(0.004, 0.014, 0.04), M.black), s * 0.0295, 0.028, -0.22 - i * 0.055);
    b.rail(-0.18, -0.47, M.black);
  } else {
    b.add(profile([[0.17, 0.042], [0.44, 0.042], [0.46, 0.03], [0.46, -0.004], [0.42, -0.012], [0.19, -0.016], [0.17, -0.004]], 0.056, furn, 0.008), 0, 0, 0);
    b.add(rbox(0.036, 0.028, 0.2, 0.012, furn), 0, 0.064, -0.3);
    b.put(tube(0.011, -0.4, -0.52, 0.064, M.blued));
    // Finger grooves along the lower handguard.
    for (const s of [-1, 1]) b.add(new THREE.Mesh(new THREE.BoxGeometry(0.003, 0.006, 0.22), M.black), s * 0.0285, 0.016, -0.31);
  }
  // Gas block, barrel, front sight and slant brake.
  b.add(rbox(0.024, 0.05, 0.03, 0.006, M.blued), 0, 0.048, -0.53);
  b.put(tube(0.0098, -0.46, -0.66, 0.03, M.blued));
  b.add(rbox(0.016, 0.05, 0.022, 0.004, M.blued), 0, 0.052, -0.62);
  b.add(new THREE.Mesh(new THREE.BoxGeometry(0.003, 0.022, 0.003), M.black), 0, 0.083, -0.62);
  b.put(tube(0.0135, -0.66, -0.71, 0.03, modern ? M.black : M.blued));
  b.add(new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.01, 0.03), M.black), 0, 0.044, -0.695, 0.35);
  // The curved 30-round magazine with its ribs.
  const mag = b.magazine(magShape(0.07, 0.06, 0.2, 0.075), 0.03, modern ? M.polymer : M.blued);
  for (let i = 1; i <= 3; i++) {
    const rib = profile(magShape(0.07 + i * 0.015, 0.004, 0.19, 0.075 + 0.005 * i, -0.06), 0.032, M.black, 0.001);
    mag.add(rib);
  }
  b.grip(modern ? M.polymer : M.wood, 0.034);
  b.trigger(M.blued);
  // Stock: the long fixed wooden one, or the AK-12's adjustable tube stock.
  if (modern) {
    b.put(tube(0.016, 0.16, 0.34, 0.032, M.black));
    b.add(profile([[-0.24, 0.06], [-0.4, 0.06], [-0.42, 0.04], [-0.42, -0.08], [-0.38, -0.09], [-0.25, -0.02]], 0.044, M.polymer, 0.006), 0, -0.01, 0);
  } else {
    b.add(profile([[-0.16, 0.045], [-0.5, 0.025], [-0.52, 0.015], [-0.52, -0.105], [-0.49, -0.115], [-0.3, -0.045], [-0.16, -0.012]], 0.038, M.wood, 0.007), 0, 0, 0);
    b.add(rbox(0.04, 0.125, 0.012, 0.004, M.blued), 0, -0.04, 0.522);
  }
  return b;
}

/** MP5-pattern: slim round receiver, tapered handguard, cocking tube,
 * steeply curved magazine and a sliding stock. */
function mp5() {
  const M = mats();
  const b = new Body();
  b.put(tube(0.026, 0.15, -0.17, 0.036, M.blued, 0, 20));
  b.add(rbox(0.044, 0.04, 0.17, 0.01, M.polymer), 0, -0.01, 0.02);
  b.add(rbox(0.04, 0.03, 0.06, 0.008, M.blued), 0, -0.035, -0.08);
  // Cocking tube along the top, its handle forward on the left.
  b.put(tube(0.011, -0.17, -0.41, 0.064, M.blued));
  b.add(new THREE.Mesh(new THREE.CylinderGeometry(0.005, 0.005, 0.05, 8), M.black), -0.03, 0.064, -0.36, 0, 0, Math.PI / 2);
  // Tapered handguard, flared at the front.
  b.add(profile([[0.17, 0.05], [0.37, 0.048], [0.385, 0.056], [0.395, 0.056], [0.395, -0.008], [0.37, -0.012], [0.17, -0.01]], 0.052, M.polymer, 0.009), 0, 0, 0);
  for (let i = 0; i < 6; i++) for (const s of [-1, 1]) b.add(new THREE.Mesh(new THREE.BoxGeometry(0.003, 0.03, 0.006), M.black), s * 0.027, 0.02, -0.2 - i * 0.03);
  // Barrel with its lugs and the hooded front sight.
  b.put(tube(0.0095, -0.4, -0.48, 0.03, M.steel));
  b.put(tube(0.013, -0.46, -0.48, 0.03, M.blued));
  b.add(new THREE.Mesh(new THREE.TorusGeometry(0.012, 0.003, 6, 16), M.blued), 0, 0.078, -0.41);
  b.add(rbox(0.012, 0.024, 0.016, 0.003, M.blued), 0, 0.068, -0.41);
  // Drum rear sight.
  b.add(new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.02, 14), M.blued), 0, 0.072, 0.13, 0, 0, Math.PI / 2);
  b.rail(0.11, -0.12);
  b.magazine(magShape(0.065, 0.034, 0.17, 0.07), 0.024, M.blued);
  b.grip(M.polymer);
  b.trigger(M.polymer);
  // Sliding stock: two rods and a butt plate.
  for (const y of [0.05, 0.0]) b.put(tube(0.0055, 0.15, 0.33, y, M.steel));
  b.add(rbox(0.036, 0.11, 0.022, 0.008, M.polymer), 0, 0.015, 0.34);
  b.leftZ = 0.09;
  b.leftY = 0.01;
  return b;
}

/** Thompson-style: milled receiver, finned barrel and compensator, wooden
 * stock, grip and vertical foregrip, a stick magazine. */
function thompson() {
  const M = mats();
  const b = new Body();
  b.add(rbox(0.05, 0.064, 0.3, 0.012, M.blued), 0, 0.032, 0.02);
  b.add(rbox(0.044, 0.04, 0.15, 0.01, M.blued), 0, -0.02, 0.02);
  // Bolt knob on top, rear sight ears.
  b.add(new THREE.Mesh(new THREE.SphereGeometry(0.009, 10, 8), M.steel), 0, 0.072, -0.04);
  b.rail(0.12, -0.05);
  // Finned barrel and the compensator.
  b.put(tube(0.012, -0.13, -0.46, 0.03, M.blued));
  for (let i = 0; i < 12; i++) b.put(tube(0.019, -0.15 - i * 0.017, -0.155 - i * 0.017, 0.03, M.blued));
  b.add(rbox(0.03, 0.034, 0.06, 0.006, M.blued), 0, 0.032, -0.48);
  b.add(new THREE.Mesh(new THREE.BoxGeometry(0.004, 0.02, 0.004), M.black), 0, 0.056, -0.47);
  // Vertical wooden foregrip under the barrel.
  b.add(profile([[0.24, -0.005], [0.31, -0.005], [0.3, -0.13], [0.285, -0.14], [0.255, -0.14], [0.245, -0.125]], 0.036, M.wood, 0.008), 0, 0, 0);
  b.add(rbox(0.03, 0.016, 0.08, 0.005, M.blued), 0, 0.006, -0.28);
  // Straight 20-round stick magazine ahead of the trigger.
  b.magazine([[0.04, -0.03], [0.085, -0.03], [0.085, -0.21], [0.04, -0.21]], 0.026, M.blued);
  b.grip(M.wood, 0.034);
  b.trigger(M.blued);
  b.add(profile([[-0.14, 0.05], [-0.48, 0.035], [-0.5, 0.02], [-0.5, -0.11], [-0.47, -0.12], [-0.28, -0.06], [-0.14, -0.02]], 0.04, M.wood, 0.008), 0, 0, 0);
  b.add(rbox(0.042, 0.13, 0.012, 0.004, M.blued), 0, -0.045, 0.502);
  // Left hand round the vertical grip.
  b.leftZ = 0.12;
  b.leftY = -0.085;
  return b;
}

/** UMP-style: a boxy polymer SMG, straight .45 magazine, side-folding
 * skeleton stock. */
function ump() {
  const M = mats();
  const b = new Body();
  b.add(rbox(0.052, 0.07, 0.44, 0.012, M.polymer), 0, 0.03, -0.12);
  b.add(rbox(0.046, 0.05, 0.12, 0.01, M.polymer), 0, -0.025, 0.0);
  for (let i = 0; i < 5; i++) for (const s of [-1, 1]) b.add(new THREE.Mesh(new THREE.BoxGeometry(0.003, 0.03, 0.02), M.black), s * 0.027, 0.03, -0.18 - i * 0.04);
  b.add(new THREE.Mesh(new THREE.CylinderGeometry(0.005, 0.005, 0.04, 8), M.black), -0.03, 0.05, -0.28, 0, 0, Math.PI / 2);
  b.rail(0.09, -0.34);
  b.put(tube(0.01, -0.34, -0.42, 0.03, M.steel));
  b.muzzleBrake(-0.42, 0.014, M.black);
  b.magazine([[0.075, -0.02], [0.125, -0.02], [0.13, -0.2], [0.08, -0.2]], 0.03, M.polymer);
  b.grip(M.polymer);
  b.trigger(M.polymer);
  b.add(rbox(0.016, 0.06, 0.04, 0.006, M.black), 0, 0.02, 0.1);
  b.add(rbox(0.016, 0.016, 0.22, 0.005, M.polymer), 0, 0.045, 0.22);
  b.add(rbox(0.016, 0.016, 0.24, 0.005, M.polymer), 0, -0.02, 0.22, 0.26);
  b.add(rbox(0.034, 0.12, 0.02, 0.008, M.polymer), 0, 0.0, 0.335);
  b.leftZ = 0.11;
  return b;
}

/** Rust's Custom SMG is a homemade gun, so this is a homemade-looking one:
 * welded sheet-steel box, pipe barrel, bolt heads, tape and a wire stock. */
function scrap() {
  const M = mats();
  const b = new Body();
  b.add(rbox(0.054, 0.066, 0.34, 0.003, M.rust), 0, 0.03, -0.07);
  b.add(rbox(0.046, 0.04, 0.14, 0.003, M.worn), 0, -0.02, 0.02);
  for (const z of [0.07, 0.0, -0.1, -0.2]) for (const s of [-1, 1]) b.add(new THREE.Mesh(new THREE.CylinderGeometry(0.0045, 0.0045, 0.004, 6), M.steel), s * 0.028, 0.05, z, 0, 0, Math.PI / 2);
  // Weld beads along the seams.
  for (let i = 0; i < 14; i++) b.add(new THREE.Mesh(new THREE.SphereGeometry(0.003, 5, 4), M.worn), 0.027, 0.0, 0.08 - i * 0.022);
  b.rail(0.1, -0.12, M.worn);
  b.put(tube(0.013, -0.24, -0.5, 0.03, M.worn));
  for (let i = 0; i < 3; i++) b.put(tube(0.016, -0.28 - i * 0.03, -0.295 - i * 0.03, 0.03, M.tape));
  b.add(rbox(0.04, 0.04, 0.09, 0.004, M.tape), 0, 0.03, -0.3);
  b.magazine([[0.07, -0.02], [0.105, -0.02], [0.11, -0.2], [0.075, -0.2]], 0.024, M.worn);
  b.grip(M.tape);
  b.trigger(M.worn);
  // Bent-rod stock.
  b.put(tube(0.006, 0.1, 0.34, 0.04, M.worn));
  b.add(new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, 0.26, 6), M.worn), 0, -0.02, 0.23, Math.PI / 2 - 0.45);
  b.add(rbox(0.03, 0.12, 0.012, 0.003, M.rust), 0, -0.01, 0.345);
  b.leftZ = 0.05;
  return b;
}

/** Belt-fed light machine guns: big receiver and feed cover, carry handle,
 * long barrel with a heat shield, folded bipod, an ammo box or drum. */
function lmg(o) {
  const M = mats();
  const b = new Body();
  const body = o.tone === 'olive' ? M.olive : M.polymer;
  b.add(rbox(0.066, 0.08, 0.4, 0.008, M.blued), 0, 0.022, -0.05);
  b.add(rbox(0.06, 0.02, 0.24, 0.006, M.blued), 0, 0.058, -0.02);
  b.rail(0.12, -0.12);
  // Carry handle ahead of the sights.
  const handle = new THREE.Mesh(new THREE.TorusGeometry(0.035, 0.006, 6, 14, Math.PI), M.black);
  b.add(handle, 0, 0.07, -0.32, 0, Math.PI / 2, 0);
  // Barrel, heat shield, flash hider.
  b.put(tube(0.012, -0.25, -0.8, 0.03, M.blued));
  b.add(rbox(0.03, 0.02, 0.2, 0.006, M.black), 0, 0.05, -0.38);
  b.put(tube(0.015, -0.8, -0.86, 0.03, M.black));
  b.add(rbox(0.05, 0.05, 0.2, 0.01, body), 0, 0.0, -0.33);
  // Folded bipod.
  for (const s of [-1, 1]) b.add(new THREE.Mesh(new THREE.CylinderGeometry(0.004, 0.004, 0.2, 6), M.steel), s * 0.012, -0.01, -0.62, Math.PI / 2);
  // Ammo: a box hanging left, or a round drum.
  if (o.drum) {
    const drum = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.075, 0.07, 24), M.polymer);
    drum.rotation.z = Math.PI / 2;
    drum.position.set(0, -0.09, -0.1);
    b.mag = b.put(drum);
  } else {
    b.mag = b.add(rbox(o.heavy ? 0.1 : 0.085, 0.11, 0.12, 0.01, o.tone === 'olive' ? M.olive : M.polymer), -0.01, -0.09, -0.1);
  }
  b.grip(M.polymer);
  b.trigger(M.blued);
  b.add(profile([[-0.15, 0.05], [-0.4, 0.045], [-0.42, 0.03], [-0.42, -0.09], [-0.39, -0.1], [-0.25, -0.05], [-0.15, -0.02]], 0.048, body, 0.008), 0, 0, 0);
  b.leftZ = 0.08;
  b.leftY = -0.02;
  return b;
}

/** Bullpups: AUG (olive shell, integrated vertical grip), F2 (black with a
 * long carry-handle rail), T-95 (long black). The magazine sits behind the
 * grip. */
function bullpup(o) {
  const M = mats();
  const b = new Body();
  const shell = o.tone === 'olive' ? M.olive : M.polymer;
  const front = o.long ? -0.36 : -0.3;
  // One long shell from the butt to the handguard, the grip inside a big
  // trigger guard.
  b.add(profile([[-0.42, 0.045], [-0.42, -0.075], [-0.39, -0.088], [-0.31, -0.06], [-0.2, -0.055], [-0.17, -0.03], [0.0, -0.03], [0.02, -0.012], [-front - 0.02, -0.004], [-front, 0.004], [-front, 0.05], [-0.1, 0.058], [-0.3, 0.052]], 0.054, shell, 0.012), 0, 0, 0);
  b.add(profile([[0.02, -0.035], [0.11, -0.035], [0.13, -0.06], [0.12, -0.16], [0.06, -0.16], [0.04, -0.06]], 0.03, shell, 0.006), 0, 0, 0);
  b.grip(shell, 0.034);
  b.trigger(shell);
  b.add(rbox(0.06, 0.03, 0.04, 0.012, M.black), 0, 0.02, 0.4);
  // Magazine behind the grip.
  b.magazine(magShape(-0.27, 0.05, 0.17, o.long ? 0.015 : 0.035, -0.045), 0.03, o.tone === 'olive' ? M.smoke : M.polymer);
  // Barrel and brake.
  b.put(tube(0.011, front, front - 0.18, 0.03, M.steel));
  b.muzzleBrake(front - 0.18, 0.016, M.black);
  // Top: the F2's long carry handle, or a plain rail.
  if (o.handle) {
    b.add(rbox(0.03, 0.03, 0.46, 0.006, M.polymer), 0, 0.075, -0.06);
    b.add(rbox(0.024, 0.03, 0.03, 0.005, M.polymer), 0, 0.05, 0.14);
    b.add(rbox(0.024, 0.03, 0.03, 0.005, M.polymer), 0, 0.05, -0.27);
  }
  b.rail(0.14, front + 0.02);
  // AUG's folding vertical grip.
  if (o.tone === 'olive') {
    b.add(profile([[0.22, -0.005], [0.27, -0.005], [0.265, -0.12], [0.225, -0.12]], 0.034, shell, 0.008), 0, 0, 0);
    b.leftZ = 0.15;
    b.leftY = -0.08;
  } else {
    b.leftZ = 0.12;
  }
  return b;
}

/** P90-style: one rounded shell with a thumbhole front grip and the
 * magazine lying flat along the top. */
function p90() {
  const M = mats();
  const b = new Body();
  b.add(profile([[-0.3, 0.05], [-0.3, -0.13], [-0.25, -0.15], [-0.12, -0.15], [-0.07, -0.06], [0.0, -0.05], [0.05, -0.14], [0.09, -0.15], [0.17, -0.15], [0.2, -0.1], [0.27, -0.03], [0.29, 0.04], [0.26, 0.055], [-0.2, 0.058]], 0.06, M.polymer, 0.014), 0, 0, 0);
  // Thumbhole cut: a dark slot so the shape reads.
  b.add(rbox(0.062, 0.05, 0.05, 0.02, M.black), 0, -0.09, -0.12);
  // The translucent magazine along the top, the rail over it.
  b.mag = b.add(rbox(0.05, 0.016, 0.38, 0.006, M.smoke), 0, 0.064, -0.02);
  b.rail(0.12, -0.12);
  b.put(tube(0.01, -0.29, -0.36, 0.03, M.steel));
  b.put(tube(0.014, -0.34, -0.38, 0.03, M.black));
  b.grip(M.polymer);
  b.leftZ = 0.24;
  b.leftY = -0.1;
  return b;
}

/** Semi-automatic rifles: the SAR as a wooden-stocked rifle, the M39 as a
 * black chassis marksman rifle. */
function dmr(o) {
  const M = mats();
  const b = new Body();
  const wood = o.furniture === 'wood';
  const stock = wood ? M.wood : M.polymer;
  b.add(rbox(0.044, 0.05, 0.3, 0.008, M.blued), 0, 0.035, -0.01);
  b.add(rbox(0.008, 0.012, 0.08, 0.003, M.steel), 0.026, 0.04, -0.06);
  b.rail(0.13, -0.15);
  // One-piece stock from the butt to the fore-end (wooden), or a railed
  // chassis (black).
  b.add(profile([[-0.5, 0.03], [-0.52, 0.02], [-0.52, -0.1], [-0.48, -0.11], [-0.18, -0.05], [-0.1, -0.03], [0.0, -0.03], [0.5, -0.02], [0.52, 0.0], [0.52, 0.03], [0.15, 0.03], [-0.15, 0.04]], 0.05, stock, 0.008), 0, 0, 0);
  if (!wood) b.rail(-0.18, -0.5, M.black);
  b.put(tube(0.0105, -0.52, -0.78, 0.035, M.blued));
  if (wood) b.add(rbox(0.012, 0.035, 0.018, 0.003, M.blued), 0, 0.06, -0.76);
  else b.muzzleBrake(-0.76, 0.016, M.black);
  b.magazine([[0.06, -0.02], [0.12, -0.02], [0.125, -0.13], [0.065, -0.13]], 0.032, M.blued);
  b.grip(stock, 0.034);
  b.trigger(M.blued);
  return b;
}

const FAMILIES = { ar, ak, mp5, thompson, ump, scrap, lmg, bullpup, p90, dmr };

/** Builds a gun body for a [family, options] pair. */
export function buildGunBody([family, options]) {
  return (FAMILIES[family] || ar)(options || {}).done();
}
