// The range's post-processing chain: ambient occlusion (GTAO - the soft
// contact shadow where things meet), a subtle bloom on bright highlights,
// ACES tone mapping and sRGB output, SMAA anti-aliasing and a slight
// vignette. The gun is drawn after all of this in its own pass (range.js),
// so it can never clip into the world or pick up the world's AO.

import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.160.0/+esm';
import { EffectComposer } from 'https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/postprocessing/EffectComposer.js/+esm';
import { RenderPass } from 'https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/postprocessing/RenderPass.js/+esm';
import { GTAOPass } from 'https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/postprocessing/GTAOPass.js/+esm';
import { UnrealBloomPass } from 'https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/postprocessing/UnrealBloomPass.js/+esm';
import { OutputPass } from 'https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/postprocessing/OutputPass.js/+esm';
import { SMAAPass } from 'https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/postprocessing/SMAAPass.js/+esm';
import { ShaderPass } from 'https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/postprocessing/ShaderPass.js/+esm';
import { VignetteShader } from 'https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/shaders/VignetteShader.js/+esm';

export class PostChain {
  constructor(renderer, scene, camera) {
    this.renderer = renderer;
    const size = renderer.getSize(new THREE.Vector2());
    const c = (this.composer = new EffectComposer(renderer));
    c.addPass(new RenderPass(scene, camera));
    this.ao = new GTAOPass(scene, camera, size.x, size.y);
    this.ao.blendIntensity = 0.85;
    this.ao.updateGtaoMaterial({ radius: 0.6, distanceExponent: 1.4, thickness: 1.2, scale: 1, samples: 12 });
    c.addPass(this.ao);
    this.bloom = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), 0.16, 0.45, 0.92);
    c.addPass(this.bloom);
    c.addPass(new OutputPass());
    this.smaa = new SMAAPass(size.x, size.y);
    c.addPass(this.smaa);
    this.vignette = new ShaderPass(VignetteShader);
    this.vignette.uniforms.offset.value = 1.05;
    this.vignette.uniforms.darkness.value = 0.85;
    c.addPass(this.vignette);
  }

  /** Per-map look: how strong the bloom, AO and vignette are. */
  setLook({ bloom = 0.16, ao = 0.85, vignette = 0.85 } = {}) {
    this.bloom.strength = bloom;
    this.ao.blendIntensity = ao;
    this.vignette.uniforms.darkness.value = vignette;
  }

  setSize(w, h, pixelRatio) {
    this.composer.setPixelRatio(pixelRatio);
    this.composer.setSize(w, h);
  }

  render(dt) {
    this.composer.render(dt);
  }
}
