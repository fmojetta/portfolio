// Hero: "I turn insights into [user flows → prototypes → high-fidelity UI]"
//
// The headline is real, static HTML. The last line (the "slot") is drawn by a
// 3D particle field (Three.js, WebGL2) that walks through the design process:
// each stage is rendered at a higher fidelity than the one before -- early
// stages are sparse, loose, chunky dots; later ones are dense and precise --
// until the final stage resolves into the crisp HTML text itself. Hovering the
// crisp text breaks it back into particles.
//
// Performance (old / low-end machines):
//   * All particles are ONE draw call (THREE.Points + a tiny shader).
//   * Physics runs on the CPU over flat Float32Arrays (no per-particle objects).
//   * Pixel ratio capped at 1.5, dropping to 1 (then fewer particles) if the
//     measured frame time is poor.
//   * The loop stops while the hero is off screen or the tab is hidden.
//   * If WebGL2 / ES modules / the CDN are unavailable, or the visitor prefers
//     reduced motion, the crisp static headline is shown instead.

import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.min.js';

// ------------------------------------------------------------------ config
// Physics values are "per frame at 60fps" and in CSS px.
const CONFIG = {
  // timing (ms)
  stageMs: 2100,          // how long each low-fi stage is shown
  settleMs: 1300,         // final stage: time for particles to land before going crisp
  holdMs: 3800,           // final stage: how long the crisp text stays
  rebreakMs: 1200,        // after a hover-break, wait this long before re-crisping

  // fidelity ramp: values at the first stage -> last stage
  gapRamp: [1.7, 1.0],    // sampling gap multiplier (higher = fewer particles)
  jitterRamp: [0.7, 0.1], // positional noise, in units of the gap (sketchiness)
  sizeRamp: [1.5, 1.0],   // dot size multiplier (chunky -> fine)

  gap: 2.2,               // px between points at gapRefSize, at full fidelity
  gapRefSize: 100,
  gapMin: 1.3,
  particleSize: 1.15,     // dot radius (CSS px) at full fidelity
  particleSizeMin: 0.6,
  depth: 14,              // thickness of the text slab (px)

  // 3D
  fov: 30,
  tiltX: 0.08,            // subtle cursor tilt (rad) -- kept small so the particle
  tiltY: 0.12,            // line stays readable next to the static text
  tiltEase: 0.05,

  // transitions
  morphSpeed: 1.7,        // stage -> stage burst
  blastSpeed: 3.4,        // crisp -> first stage (full restart) burst
  explodeDepth: 1.6,      // z velocity relative to xy -> particles fly at the camera
  scatterHold: 14,
  wander: 1.0,
  wanderThreshold: 0.6,

  // cursor
  mouseRadius: 110,
  repelForce: 2.6,
  swirl: 0.9,
  turbulence: 4.5,
  pushDepth: 0.9,

  returnSpeed: 0.022,
  friction: 0.8,
  fadeEase: 0.12,         // particle fade speed when handing over to crisp text

  maxPixelRatio: 1.5,
};

const hero = document.querySelector('.hero');
const canvas = document.getElementById('scene');
const slot = document.getElementById('heroSlot');
const crisp = document.getElementById('heroCrisp');
const STAGES = slot.dataset.stages.split('|').map((s) => s.trim()).filter(Boolean);
const LAST = STAGES.length - 1;

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
if (reducedMotion.matches) {
  // static headline only; nothing else to do
  throw new Error('reduced motion: static hero');
}

const lerp = (a, b, t) => a + (b - a) * t;

// ------------------------------------------------------------------ three
const renderer = new THREE.WebGLRenderer({
  canvas,
  alpha: true,
  antialias: false,               // dots are anti-aliased in the shader
  powerPreference: 'low-power',
});
renderer.setClearColor(0x000000, 0);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(CONFIG.fov, 1, 1, 10000);
const group = new THREE.Group();
scene.add(group);

const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#0000ee';
const paper = getComputedStyle(document.documentElement).getPropertyValue('--paper').trim() || '#f2f2f2';

const material = new THREE.ShaderMaterial({
  transparent: true,
  depthWrite: false,
  uniforms: {
    uColor: { value: new THREE.Color(accent) },
    uFog: { value: new THREE.Color(paper) },
    uSize: { value: 2 },      // dot diameter in CSS px at z = 0
    uPR: { value: 1 },
    uDist: { value: 1000 },   // camera distance to the z = 0 plane
    uOpacity: { value: 1 },
  },
  vertexShader: /* glsl */ `
    uniform float uSize;
    uniform float uPR;
    uniform float uDist;
    varying float vFog;
    void main() {
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      gl_Position = projectionMatrix * mv;
      float d = -mv.z;
      gl_PointSize = max(1.0, uSize * uPR * uDist / d);
      vFog = smoothstep(uDist * 1.05, uDist * 1.8, d);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform vec3 uColor;
    uniform vec3 uFog;
    uniform float uOpacity;
    varying float vFog;
    void main() {
      float r = length(gl_PointCoord - 0.5);
      float a = 1.0 - smoothstep(0.38, 0.5, r);
      if (a <= 0.0) discard;
      gl_FragColor = vec4(mix(uColor, uFog, vFog * 0.85), a * uOpacity);
    }
  `,
});

// ---------------------------------------------------------- particle state
let capacity = 0;
let count = 0;
let pos, vel, home, hold, ease, lnFric, spin;
let posAttr;
const geometry = new THREE.BufferGeometry();

function ensureCapacity(n) {
  if (n <= capacity) return;
  const cap = Math.ceil(n * 1.25);
  const grow = (old, size) => {
    const a = new Float32Array(cap * size);
    if (old) a.set(old.subarray(0, Math.min(old.length, a.length)));
    return a;
  };
  pos = grow(pos, 3);
  vel = grow(vel, 3);
  home = grow(home, 3);
  hold = grow(hold, 1);
  ease = grow(ease, 1);
  lnFric = grow(lnFric, 1);
  spin = grow(spin, 1);
  for (let i = capacity; i < cap; i++) {
    ease[i] = CONFIG.returnSpeed * (0.4 + Math.random() * 1.2);
    lnFric[i] = Math.log(CONFIG.friction * (0.97 + Math.random() * 0.04));
    spin[i] = (Math.random() - 0.5) * 0.018;
  }
  capacity = cap;
  posAttr = new THREE.BufferAttribute(pos, 3);
  posAttr.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute('position', posAttr);
}

const points = new THREE.Points(geometry, material);
points.frustumCulled = false;
group.add(points);

// ---------------------------------------------------------- text sampling
// The particle text is drawn exactly where the crisp HTML text sits, using the
// same computed font, so the hand-over between the two is seamless.
const SS = 2;   // offscreen supersampling for sub-pixel precision
const off = document.createElement('canvas');
const octx = off.getContext('2d', { willReadFrequently: true });

let W = 0, H = 0;           // canvas size, CSS px
let densityScale = 1;       // > 1 when adaptive quality drops particles

function sample(text, fidelity) {
  const cs = getComputedStyle(crisp);
  const size = parseFloat(cs.fontSize);
  const font = `${cs.fontWeight} ${size * SS}px ${cs.fontFamily}`;

  const cRect = canvas.getBoundingClientRect();
  const sRect = crisp.getBoundingClientRect();
  const cx = (sRect.left + sRect.width / 2) - cRect.left;   // slot centre, canvas px

  octx.font = font;
  const m = octx.measureText(text);
  const ascent = (m.fontBoundingBoxAscent || size * SS * 0.8) / SS;
  const baseline = (sRect.top - cRect.top) + ascent;

  // only rasterise the band around the line, not the whole hero
  const top = Math.max(0, Math.floor(baseline - size * 1.2));
  const bandH = Math.ceil(size * 1.8);
  const left = Math.max(0, Math.floor(cx - m.width / SS / 2 - size * 0.5));
  const bandW = Math.min(W - left, Math.ceil(m.width / SS + size));
  const w = Math.max(1, bandW * SS), h = Math.max(1, bandH * SS);
  if (off.width !== w || off.height !== h) { off.width = w; off.height = h; }
  else octx.clearRect(0, 0, w, h);

  octx.font = font;
  octx.fillStyle = '#fff';
  octx.textAlign = 'center';
  octx.textBaseline = 'alphabetic';
  octx.fillText(text, (cx - left) * SS, (baseline - top) * SS);
  const data = octx.getImageData(0, 0, w, h).data;

  const scale = size / CONFIG.gapRefSize;
  const gapMul = lerp(CONFIG.gapRamp[0], CONFIG.gapRamp[1], fidelity);
  const gap = Math.max(CONFIG.gapMin, CONFIG.gap * scale) * gapMul * densityScale;
  const step = Math.max(1, Math.round(gap * SS));
  const realGap = step / SS;
  const jitter = lerp(CONFIG.jitterRamp[0], CONFIG.jitterRamp[1], fidelity) * realGap;

  const baseR = Math.max(CONFIG.particleSizeMin, CONFIG.particleSize * (realGap / gapMul / CONFIG.gap));
  material.uniforms.uSize.value = baseR * 2 * lerp(CONFIG.sizeRamp[0], CONFIG.sizeRamp[1], fidelity);

  const out = [];
  for (let y = 0; y < h; y += step) {
    for (let x = 0; x < w; x += step) {
      if (data[(y * w + x) * 4 + 3] > 128) {
        out.push(
          left + x / SS - W / 2 + (Math.random() - 0.5) * jitter,
          -(top + y / SS - H / 2) + (Math.random() - 0.5) * jitter,
          (Math.random() - 0.5) * CONFIG.depth
        );
      }
    }
  }
  return out;
}

function setText(stageIndex) {
  const fidelity = LAST > 0 ? stageIndex / LAST : 1;
  const t = sample(STAGES[stageIndex], fidelity);
  const n = t.length / 3;
  const prev = count;
  ensureCapacity(n);
  for (let i = 0; i < n * 3; i++) home[i] = t[i];
  for (let i = prev; i < n; i++) {
    // new particles are born from a random existing one -> they "split off"
    const k = i * 3;
    const src = prev > 0 ? Math.floor(Math.random() * prev) * 3 : k;
    pos[k] = prev > 0 ? pos[src] : home[k];
    pos[k + 1] = prev > 0 ? pos[src + 1] : home[k + 1];
    pos[k + 2] = prev > 0 ? pos[src + 2] : home[k + 2];
    vel[k] = vel[k + 1] = vel[k + 2] = 0;
    hold[i] = 0;
  }
  // a lower-fidelity stage needs fewer points: instead of deleting the extras
  // mid-flight, send them to stack on a random point of the new text
  for (let i = n; i < prev; i++) {
    const k = i * 3, j = Math.floor(Math.random() * n) * 3;
    home[k] = home[j]; home[k + 1] = home[j + 1]; home[k + 2] = home[j + 2];
  }
  count = Math.max(n, prev);
  geometry.setDrawRange(0, count);
  posAttr.needsUpdate = true;
}

function explode(speed) {
  for (let i = 0; i < count; i++) {
    const k = i * 3;
    const ang = Math.random() * Math.PI * 2;
    const r = Math.random();
    const spd = speed * (0.35 + r * r * 1.5);
    vel[k] += Math.cos(ang) * spd;
    vel[k + 1] += Math.sin(ang) * spd;
    vel[k + 2] += (Math.random() - 0.35) * spd * CONFIG.explodeDepth;
    hold[i] = Math.random() * CONFIG.scatterHold;
  }
}

// ------------------------------------------------------------ choreography
const seq = { stage: 0, t: 0, crisp: false, brokeAt: -1e9 };

function goStage(i, speed) {
  seq.stage = i;
  seq.t = 0;
  setText(i);
  explode(speed);
}

function setCrisp(on) {
  if (seq.crisp === on) return;
  seq.crisp = on;
  hero.classList.toggle('is-crisp', on);
}

function updateSequence(ms) {
  seq.t += ms;
  if (seq.stage < LAST) {
    if (seq.t > CONFIG.stageMs) goStage(seq.stage + 1, CONFIG.morphSpeed);
    return;
  }
  const end = CONFIG.settleMs + CONFIG.holdMs;
  if (seq.t > end) {
    if (hoveringSlot) { seq.t = end - 400; return; }   // don't yank it away mid-play
    setCrisp(false);
    goStage(0, CONFIG.blastSpeed);
    return;
  }
  if (!seq.crisp && seq.t > CONFIG.settleMs && !hoveringSlot &&
      seq.t - seq.brokeAt > CONFIG.rebreakMs) {
    snapToHome();
    setCrisp(true);
  }
}

// once crisp, park the (invisible) particles exactly on their targets so the
// next break starts from a perfect copy of the text
function snapToHome() {
  pos.set(home.subarray(0, count * 3));
  for (let i = 0; i < count * 3; i++) vel[i] = 0;
  posAttr.needsUpdate = true;
}

// ------------------------------------------------------------------ cursor
const mouse = { active: false, x: 0, y: 0, nx: 0, ny: 0 };
let hoveringSlot = false;
const raycaster = new THREE.Raycaster();
const plane = new THREE.Plane();
const hit = new THREE.Vector3();
const ndc = new THREE.Vector2();
const tilt = { x: 0, y: 0 };

function pointer(clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  ndc.set(
    ((clientX - rect.left) / rect.width) * 2 - 1,
    -((clientY - rect.top) / rect.height) * 2 + 1
  );
  mouse.nx = ndc.x;
  mouse.ny = ndc.y;
  mouse.active = true;

  const s = crisp.getBoundingClientRect();
  const pad = 24;
  hoveringSlot = clientX > s.left - pad && clientX < s.right + pad &&
                 clientY > s.top - pad && clientY < s.bottom + pad;
  if (hoveringSlot && seq.crisp) {
    // break the polished UI back into particles
    setCrisp(false);
    seq.brokeAt = seq.t;
  }
}

function pointerOut() {
  mouse.active = false;
  hoveringSlot = false;
}

// the content layer sits above the canvas, so listen on the whole hero
hero.addEventListener('pointermove', (e) => pointer(e.clientX, e.clientY));
hero.addEventListener('pointerleave', pointerOut);
hero.addEventListener('touchmove', (e) => {
  if (e.touches[0]) pointer(e.touches[0].clientX, e.touches[0].clientY);
}, { passive: true });
hero.addEventListener('touchend', pointerOut);

function updateMouseLocal() {
  if (!mouse.active) return;
  group.updateMatrixWorld();
  raycaster.setFromCamera(ndc, camera);
  plane.normal.set(0, 0, 1).applyQuaternion(group.quaternion);
  plane.constant = 0;
  if (raycaster.ray.intersectPlane(plane, hit)) {
    group.worldToLocal(hit);
    mouse.x = hit.x;
    mouse.y = hit.y;
  }
}

function updateTilt(dtf) {
  // flatten while the last stage lands, so the hand-over to HTML text is exact
  const flat = seq.stage === LAST;
  const tx = !flat && mouse.active ? -mouse.ny * CONFIG.tiltX : 0;
  const ty = !flat && mouse.active ? mouse.nx * CONFIG.tiltY : 0;
  const k = 1 - Math.pow(1 - CONFIG.tiltEase, dtf);
  tilt.x += (tx - tilt.x) * k;
  tilt.y += (ty - tilt.y) * k;
  group.rotation.set(tilt.x, tilt.y, 0);
}

// ----------------------------------------------------------------- physics
let camDist = 1000;

function step(dtf) {
  const R = CONFIG.mouseRadius;
  const mx = mouse.x, my = mouse.y, ma = mouse.active && !seq.crisp;
  const wanderT = CONFIG.wanderThreshold;
  const wander = CONFIG.wander * dtf;
  const zMax = camDist * 0.6;

  for (let i = 0; i < count; i++) {
    const k = i * 3;
    let x = pos[k], y = pos[k + 1], z = pos[k + 2];
    let vx = vel[k], vy = vel[k + 1], vz = vel[k + 2];

    if (ma) {
      const dx = x - mx, dy = y - my;
      const d2 = dx * dx + dy * dy;
      if (d2 < R * R && d2 > 1e-8) {
        const dist = Math.sqrt(d2);
        const nx = dx / dist, ny = dy / dist;
        const t = 1 - dist / R;
        const f = t * t * CONFIG.repelForce * R * 0.12 * dtf;
        vx += nx * f - ny * f * CONFIG.swirl;
        vy += ny * f + nx * f * CONFIG.swirl;
        vz += (z >= 0 ? 1 : -1) * f * CONFIG.pushDepth;
        vx += (Math.random() - 0.5) * CONFIG.turbulence * t * dtf;
        vy += (Math.random() - 0.5) * CONFIG.turbulence * t * dtf;
      }
    }

    if (hold[i] > 0) {
      hold[i] -= dtf;
    } else {
      const hx = home[k] - x, hy = home[k + 1] - y, hz = home[k + 2] - z;
      const e = ease[i] * dtf, s = spin[i] * dtf;
      vx += hx * e - hy * s;
      vy += hy * e + hx * s;
      vz += hz * e;
    }

    if (Math.abs(vx) + Math.abs(vy) + Math.abs(vz) > wanderT) {
      vx += (Math.random() - 0.5) * wander;
      vy += (Math.random() - 0.5) * wander;
      vz += (Math.random() - 0.5) * wander;
    }

    const damp = Math.exp(lnFric[i] * dtf);
    vx *= damp; vy *= damp; vz *= damp;
    x += vx * dtf; y += vy * dtf; z += vz * dtf;
    if (z > zMax) { z = zMax; vz = 0; }

    pos[k] = x; pos[k + 1] = y; pos[k + 2] = z;
    vel[k] = vx; vel[k + 1] = vy; vel[k + 2] = vz;
  }
  posAttr.needsUpdate = true;
}

// ------------------------------------------------------------------ render
let pixelRatio = Math.min(window.devicePixelRatio || 1, CONFIG.maxPixelRatio);

function resize() {
  W = Math.max(1, canvas.clientWidth);
  H = Math.max(1, canvas.clientHeight);
  renderer.setPixelRatio(pixelRatio);
  renderer.setSize(W, H, false);
  material.uniforms.uPR.value = pixelRatio;

  // 1 world unit == 1 CSS px on the z = 0 plane
  camDist = (H / 2) / Math.tan(THREE.MathUtils.degToRad(CONFIG.fov / 2));
  camera.aspect = W / H;
  camera.position.set(0, 0, camDist);
  camera.near = camDist * 0.05;
  camera.far = camDist * 4;
  camera.updateProjectionMatrix();
  material.uniforms.uDist.value = camDist;

  setText(seq.stage);
  if (seq.crisp) snapToHome();
}

// ---------------------------------------------------------- adaptive quality
const perf = { frames: 0, total: 0, tier: 0 };

function adapt(ms) {
  if (perf.tier >= 2) return;
  perf.frames++;
  perf.total += ms;
  if (perf.frames < 120) return;
  const avg = perf.total / perf.frames;
  perf.frames = 0;
  perf.total = 0;
  if (avg < 24) return;                     // ~40fps+ is fine
  if (perf.tier === 0 && pixelRatio > 1) {
    pixelRatio = 1;
    perf.tier = 1;
  } else {
    densityScale = 1.5;
    perf.tier = 2;
    count = 0;
  }
  resize();
  snapToHome();
}

// -------------------------------------------------------------------- loop
const FRAME_MS = 1000 / 60;
let last = 0;
let running = false;
let booted = false;
let rafId = 0;

function frame(now) {
  rafId = requestAnimationFrame(frame);
  const ms = last ? Math.min(now - last, 100) : FRAME_MS;
  last = now;
  const dtf = Math.max(ms / FRAME_MS, 0.01);

  updateSequence(ms);
  updateTilt(dtf);
  updateMouseLocal();

  const target = seq.crisp ? 0 : 1;
  const u = material.uniforms.uOpacity;
  u.value += (target - u.value) * (1 - Math.pow(1 - CONFIG.fadeEase, dtf));
  if (!seq.crisp) step(dtf);

  renderer.render(scene, camera);
  adapt(ms);
}

function start() {
  if (running || !booted) return;
  running = true;
  last = 0;
  rafId = requestAnimationFrame(frame);
}

function stop() {
  running = false;
  cancelAnimationFrame(rafId);
}

let inView = true;
new IntersectionObserver((entries) => {
  inView = entries[0].isIntersecting;
  inView && !document.hidden ? start() : stop();
}).observe(canvas);

document.addEventListener('visibilitychange', () => {
  !document.hidden && inView ? start() : stop();
});

let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    resize();
    if (!running) renderer.render(scene, camera);
  }, 150);
});

// ------------------------------------------------------------------- boot
async function boot() {
  try {
    const cs = getComputedStyle(crisp);
    await document.fonts.load(`${cs.fontWeight} 100px ${cs.fontFamily}`);
    await document.fonts.ready;
  } catch (_) { /* use whatever font is available */ }

  hero.classList.add('hero--3d');   // hides the crisp text until its turn
  resize();
  // start the first stage scattered across the hero, flying in
  for (let i = 0; i < count; i++) {
    const k = i * 3;
    pos[k] = (Math.random() - 0.5) * W;
    pos[k + 1] = (Math.random() - 0.5) * H;
    pos[k + 2] = (Math.random() - 0.5) * camDist * 0.6;
  }
  booted = true;
  if (inView && !document.hidden) start();
}

boot();
