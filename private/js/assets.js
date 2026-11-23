// Free CC0 assets from Poly Haven (polyhaven.com - public domain, no
// attribution required, credited in the range anyway): photo-scanned PBR
// textures, HDRI skies and glTF models, loaded straight from their CDN.
//
// Everything degrades gracefully: a material is handed back at once with a
// detailed procedural fallback already on it, and the scanned maps replace
// it when (if) they arrive. A model that fails to load just isn't placed;
// the caller's own geometry stays.

import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.160.0/+esm';
import { GLTFLoader } from 'https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/loaders/GLTFLoader.js/+esm';
import { RGBELoader } from 'https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/loaders/RGBELoader.js/+esm';

const CDN = 'https://dl.polyhaven.org/file/ph-assets';
const API = 'https://api.polyhaven.com';

const texLoader = new THREE.TextureLoader();
texLoader.setCrossOrigin('anonymous');
const cache = new Map();

function loadTex(url, srgb) {
  const key = url + (srgb ? '#s' : '');
  if (!cache.has(key)) {
    cache.set(
      key,
      new Promise((resolve, reject) => {
        texLoader.load(
          url,
          (t) => {
            t.wrapS = t.wrapT = THREE.RepeatWrapping;
            t.anisotropy = 8;
            if (srgb) t.colorSpace = THREE.SRGBColorSpace;
            resolve(t);
          },
          undefined,
          reject
        );
      })
    );
  }
  return cache.get(key);
}

/**
 * Applies a Poly Haven texture set to a material: albedo, OpenGL normal map,
 * and the packed ARM map (ambient occlusion in red, roughness in green,
 * metalness in blue - the channels three.js reads each from). `repeat` tiles
 * them; `res` is '1k' or '2k'. Resolves true once applied, false if it
 * couldn't load (the material keeps whatever it had).
 */
export async function applyPolyTexture(material, id, { repeat = [1, 1], res = '1k', metal = false, normalScale = 1 } = {}) {
  const base = `${CDN}/Textures/jpg/${res}/${id}/${id}`;
  try {
    const [diff, nor, arm] = await Promise.all([loadTex(`${base}_diff_${res}.jpg`, true), loadTex(`${base}_nor_gl_${res}.jpg`, false), loadTex(`${base}_arm_${res}.jpg`, false)]);
    const set = (t) => {
      const c = t.clone();
      c.repeat.set(repeat[0], repeat[1]);
      c.needsUpdate = true;
      return c;
    };
    material.map = set(diff);
    material.normalMap = set(nor);
    material.normalScale = new THREE.Vector2(normalScale, normalScale);
    const a = set(arm);
    material.aoMap = a;
    material.roughnessMap = a;
    material.roughness = 1;
    if (metal) {
      material.metalnessMap = a;
      material.metalness = 1;
    }
    material.bumpMap = null;
    material.color.setHex(0xffffff);
    material.needsUpdate = true;
    return true;
  } catch {
    return false;
  }
}

/** An HDRI sky (equirectangular .hdr), as a background and a prefiltered
 * environment map for reflections and ambient light. */
export async function loadHdri(renderer, id, res = '1k') {
  const tex = await new RGBELoader().loadAsync(`${CDN}/HDRIs/hdr/${res}/${id}_${res}.hdr`);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  const pmrem = new THREE.PMREMGenerator(renderer);
  const env = pmrem.fromEquirectangular(tex).texture;
  pmrem.dispose();
  return { background: tex, environment: env };
}

const modelCache = new Map();

/**
 * A Poly Haven glTF model. The API lists the .gltf and every file it
 * references (buffers, textures), and the loader is pointed at those.
 * Resolves to the scene (cloned per call, sharing geometry and materials),
 * or null if it couldn't load.
 */
export async function loadPolyModel(id, res = '1k') {
  if (!modelCache.has(id)) {
    modelCache.set(
      id,
      (async () => {
        const files = await (await fetch(`${API}/files/${id}`)).json();
        const g = files.gltf && (files.gltf[res] || files.gltf['1k'] || Object.values(files.gltf)[0]);
        const entry = g && g.gltf;
        if (!entry) throw new Error('no gltf');
        const include = entry.include || {};
        const manager = new THREE.LoadingManager();
        manager.setURLModifier((url) => {
          for (const [path, f] of Object.entries(include)) if (url.endsWith(path)) return f.url;
          return url;
        });
        const loader = new GLTFLoader(manager);
        loader.setCrossOrigin('anonymous');
        const gltf = await loader.loadAsync(entry.url);
        gltf.scene.traverse((o) => {
          if (o.isMesh) {
            o.castShadow = true;
            o.receiveShadow = true;
            const m = o.material;
            if (m && m.map) m.map.anisotropy = 8;
            // Foliage cards: cut out, not blended, so they sort and shadow
            // properly.
            if (m && m.transparent && m.map) {
              m.transparent = false;
              m.alphaTest = 0.5;
              m.side = THREE.DoubleSide;
            }
          }
        });
        return gltf.scene;
      })().catch(() => null)
    );
  }
  const scene = await modelCache.get(id);
  return scene ? scene.clone(true) : null;
}

/** Credits shown in the range (CC0 needs none, but it's fair to say). */
export const ASSET_CREDIT = 'Textures, skies and models: Poly Haven (CC0)';
