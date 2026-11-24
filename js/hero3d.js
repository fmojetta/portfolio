// Hero: 3D particle text rendered with Three.js (WebGL2).
//
// Same idea as the 2D version in particles.js -- a sentence sampled into
// particles that springs back into shape, explodes and re-forms into the next
// sentence -- but the field lives in 3D: the text is a thin slab of points with
// depth, the whole thing tilts toward the cursor, and explosions fly toward and
// away from the camera with real perspective.
//
// Performance notes (old/low-end machines):
//   * All particles are ONE draw call (THREE.Points + a tiny shader). The GPU
//     draws the dots; the old canvas version re-tessellated thousands of arcs
//     on the CPU every frame.
//   * Physics runs on the CPU over flat Float32Arrays (no per-particle objects).
//     ~10k particles is well under 1ms per frame.
//   * Pixel ratio is capped at 1.5 and drops to 1 automatically if frames are
//     slow; if it is still slow, the particle density is reduced.
//   * The loop stops while the hero is off screen or the tab is hidden.
//   * No WebGL2 / old browser / CDN failure -> index.html falls back to the
//     original 2D canvas animation (particles.js).
//   * prefers-reduced-motion -> static text, sentences swap without explosions.

import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.min.js';

// ------------------------------------------------------------------ config
// Values are "per frame at 60fps" and in CSS px, like the 2D version.
const CONFIG = {
  texts: ["Hi, I'm Fabio", 'I design things'],
  cycleMs: 7000,          // time each sentence stays before it explodes
  color: '#0000ee',       // matches --accent in styles.css
  fogColor: '#f2f2f2',    // matches --paper: far particles fade into the page
  fontFamily: '"Space Grotesk", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
  fontWeight: 400,
  fontSize: { min: 50, vw: 10, max: 170 },   // clamp(min, vw, max) in CSS px

  gap: 2.4,               // px between sampled points at gapRefSize (lower = more particles)
  gapRefSize: 100,
  gapMin: 1.5,
  particleSize: 1.2,      // dot radius (CSS px) at gapRefSize
  particleSizeMin: 0.6,
  depth: 18,              // thickness of the text slab (px) -> visible when tilted

  // 3D
  fov: 30,
  tiltX: 0.22,            // max tilt (rad) following the cursor vertically
  tiltY: 0.38,            // ... and horizontally
  tiltEase: 0.05,
  idleSway: 0.06,         // slow automatic sway (rad) so it is 3D even without a mouse

  // explosion
  explodeSpeed: 3.2,
  explodeDepth: 1.6,      // z velocity relative to xy -> particles fly at the camera
  scatterHold: 18,
  wander: 1.1,
  wanderThreshold: 0.6,

  // cursor
  mouseRadius: 120,
  repelForce: 2.6,
  swirl: 0.9,
  turbulence: 4.5,
  pushDepth: 0.9,         // how much the cursor also pushes particles in z

  returnSpeed: 0.02,
  friction: 0.8,

  maxPixelRatio: 1.5,
};

// ------------------------------------------------------------------ setup
const canvas = document.getElementById('scene');

const renderer = new THREE.WebGLRenderer({
  canvas,
  alpha: true,
  antialias: false,               // dots are anti-aliased in the shader
  powerPreference: 'low-power',   // don't wake a discrete GPU for this
});
renderer.setClearColor(0x000000, 0);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(CONFIG.fov, 1, 1, 10000);
const group = new THREE.Group();
scene.add(group);

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

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
  // per-particle constants for the new slots -> no two particles move alike
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

// ------------------------------------------------------------------ shader
const material = new THREE.ShaderMaterial({
  transparent: true,
  depthWrite: false,
  uniforms: {
    uColor: { value: new THREE.Color(CONFIG.color) },
    uFog: { value: new THREE.Color(CONFIG.fogColor) },
    uSize: { value: 2 },      // dot diameter in CSS px at z = 0
    uPR: { value: 1 },        // renderer pixel ratio
    uDist: { value: 1000 },   // camera distance to the z = 0 plane
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
      // perspective size: exactly uSize px on the text plane, bigger when closer
      gl_PointSize = max(1.0, uSize * uPR * uDist / d);
      // depth cue: particles pushed far back fade toward the page colour
      vFog = smoothstep(uDist * 1.05, uDist * 1.8, d);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform vec3 uColor;
    uniform vec3 uFog;
    varying float vFog;
    void main() {
      float r = length(gl_PointCoord - 0.5);
      float a = 1.0 - smoothstep(0.38, 0.5, r);
      if (a <= 0.0) discard;
      gl_FragColor = vec4(mix(uColor, uFog, vFog * 0.85), a);
    }
  `,
});

const points = new THREE.Points(geometry, material);
points.frustumCulled = false;   // bounds change every frame; never cull
group.add(points);

// ---------------------------------------------------------- text sampling
const SS = 2;   // offscreen supersampling -> sub-pixel precision for small gaps
const off = document.createElement('canvas');
const octx = off.getContext('2d', { willReadFrequently: true });

let W = 0, H = 0;           // hero canvas size in CSS px
let densityScale = 1;       // > 1 when the adaptive quality drops particles
let currentText = 0;

function fontSizeFor(cssW) {
  const f = CONFIG.fontSize;
  return Math.max(f.min, Math.min(cssW * (f.vw / 100), f.max));
}

function sample(text) {
  const w = Math.max(1, Math.round(W * SS));
  const h = Math.max(1, Math.round(H * SS));
  if (off.width !== w || off.height !== h) { off.width = w; off.height = h; }
  else octx.clearRect(0, 0, w, h);

  const size = fontSizeFor(W);
  octx.fillStyle = '#fff';
  octx.textAlign = 'center';
  octx.textBaseline = 'middle';
  octx.font = `${CONFIG.fontWeight} ${size * SS}px ${CONFIG.fontFamily}`;
  octx.fillText(text, w / 2, h / 2);
  const data = octx.getImageData(0, 0, w, h).data;

  // keep particles-per-glyph constant across viewport sizes
  const scale = size / CONFIG.gapRefSize;
  const gap = Math.max(CONFIG.gapMin, CONFIG.gap * scale) * densityScale;
  const step = Math.max(1, Math.round(gap * SS));
  const realGap = step / SS;

  const radius = Math.max(CONFIG.particleSizeMin, CONFIG.particleSize * (realGap / CONFIG.gap));
  material.uniforms.uSize.value = radius * 2;

  const out = [];
  // jitter the grid a little so it reads as grain, not a lattice
  for (let y = 0; y < h; y += step) {
    for (let x = 0; x < w; x += step) {
      if (data[(y * w + x) * 4 + 3] > 128) {
        out.push(
          x / SS - W / 2 + (Math.random() - 0.5) * realGap * 0.3,
          -(y / SS - H / 2) + (Math.random() - 0.5) * realGap * 0.3,
          (Math.random() - 0.5) * CONFIG.depth
        );
      }
    }
  }
  return out;
}

function setText(text, scatterNew) {
  const t = sample(text);
  const n = t.length / 3;
  const prev = count;
  ensureCapacity(n);
  for (let i = 0; i < n * 3; i++) home[i] = t[i];
  // newly added particles start near their home, softly scattered
  for (let i = prev; i < n; i++) {
    const k = i * 3;
    const s = scatterNew ? 40 : 0;
    pos[k] = home[k] + (Math.random() - 0.5) * s;
    pos[k + 1] = home[k + 1] + (Math.random() - 0.5) * s;
    pos[k + 2] = home[k + 2] + (Math.random() - 0.5) * s;
    vel[k] = vel[k + 1] = vel[k + 2] = 0;
    hold[i] = 0;
  }
  count = n;
  geometry.setDrawRange(0, count);
  posAttr.needsUpdate = true;
}

function explode() {
  for (let i = 0; i < count; i++) {
    const k = i * 3;
    let ang = Math.atan2(pos[k + 1], pos[k]);
    if (!isFinite(ang)) ang = Math.random() * Math.PI * 2;
    ang += (Math.random() - 0.5) * 2.4;
    const r = Math.random();
    const spd = CONFIG.explodeSpeed * (0.35 + r * r * 1.5);
    vel[k] = Math.cos(ang) * spd;
    vel[k + 1] = Math.sin(ang) * spd;
    vel[k + 2] = (Math.random() - 0.35) * spd * CONFIG.explodeDepth; // biased toward the camera
    hold[i] = Math.random() * CONFIG.scatterHold;
  }
}

function snapHome() {
  pos.set(home.subarray(0, count * 3));
  vel.fill(0);
  posAttr.needsUpdate = true;
}

function cycle() {
  if (!running) return;   // don't burn work while off screen / hidden
  currentText = (currentText + 1) % CONFIG.texts.length;
  setText(CONFIG.texts[currentText], true);
  if (reducedMotion.matches) { snapHome(); renderOnce(); }
  else explode();
}

// ------------------------------------------------------------------ cursor
const mouse = { active: false, x: 0, y: 0, nx: 0, ny: 0 };  // local coords + NDC
const raycaster = new THREE.Raycaster();
const plane = new THREE.Plane();
const hit = new THREE.Vector3();
const ndc = new THREE.Vector2();
const tilt = { x: 0, y: 0, tx: 0, ty: 0 };

function pointer(clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  ndc.set(
    ((clientX - rect.left) / rect.width) * 2 - 1,
    -((clientY - rect.top) / rect.height) * 2 + 1
  );
  mouse.nx = ndc.x;
  mouse.ny = ndc.y;
  mouse.active = true;
}

// project the cursor onto the (tilted) text plane, in the group's local space
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

canvas.addEventListener('pointermove', (e) => pointer(e.clientX, e.clientY));
canvas.addEventListener('pointerleave', () => { mouse.active = false; });
canvas.addEventListener('touchmove', (e) => {
  if (e.touches[0]) pointer(e.touches[0].clientX, e.touches[0].clientY);
}, { passive: true });
canvas.addEventListener('touchend', () => { mouse.active = false; });

// ----------------------------------------------------------------- physics
let clock = 0;

function step(dtf) {
  const R = CONFIG.mouseRadius;
  const mx = mouse.x, my = mouse.y, ma = mouse.active;
  const wanderT = CONFIG.wanderThreshold;
  const wander = CONFIG.wander * dtf;

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
        vz += (z >= 0 ? 1 : -1) * f * CONFIG.pushDepth;   // burst open in depth too
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

    // never let a particle reach (or pass) the camera
    const zMax = camDist * 0.6;
    if (z > zMax) { z = zMax; vz = 0; }

    pos[k] = x; pos[k + 1] = y; pos[k + 2] = z;
    vel[k] = vx; vel[k + 1] = vy; vel[k + 2] = vz;
  }
  posAttr.needsUpdate = true;
}

// ------------------------------------------------------------------ render
let camDist = 1000;
let pixelRatio = Math.min(window.devicePixelRatio || 1, CONFIG.maxPixelRatio);

function resize() {
  W = Math.max(1, canvas.clientWidth);
  H = Math.max(1, canvas.clientHeight);
  renderer.setPixelRatio(pixelRatio);
  renderer.setSize(W, H, false);
  material.uniforms.uPR.value = pixelRatio;

  // place the camera so 1 world unit == 1 CSS px on the z = 0 plane
  camDist = (H / 2) / Math.tan(THREE.MathUtils.degToRad(CONFIG.fov / 2));
  camera.aspect = W / H;
  camera.position.set(0, 0, camDist);
  camera.near = camDist * 0.05;
  camera.far = camDist * 4;
  camera.updateProjectionMatrix();
  material.uniforms.uDist.value = camDist;

  setText(CONFIG.texts[currentText], false);
}

function updateTilt(dtf) {
  const sway = reducedMotion.matches ? 0 : CONFIG.idleSway;
  const t = clock * 0.008;
  tilt.tx = (mouse.active ? -mouse.ny * CONFIG.tiltX : 0) + Math.sin(t * 0.7) * sway * 0.5;
  tilt.ty = (mouse.active ? mouse.nx * CONFIG.tiltY : 0) + Math.sin(t) * sway;
  const k = 1 - Math.pow(1 - CONFIG.tiltEase, dtf);
  tilt.x += (tilt.tx - tilt.x) * k;
  tilt.y += (tilt.ty - tilt.y) * k;
  group.rotation.set(tilt.x, tilt.y, 0);
}

function renderOnce() {
  renderer.render(scene, camera);
}

// ---------------------------------------------------------- adaptive quality
// Measure real frame times for a couple of seconds; if the machine struggles,
// step down: pixel ratio 1, then fewer particles.
const perf = { frames: 0, total: 0, tier: 0 };

function adapt(ms) {
  if (perf.tier >= 2) return;
  perf.frames++;
  perf.total += ms;
  if (perf.frames < 120) return;
  const avg = perf.total / perf.frames;
  perf.frames = 0;
  perf.total = 0;
  if (avg < 24) return;                    // ~40fps+ is fine
  if (perf.tier === 0 && pixelRatio > 1) {
    pixelRatio = 1;
    perf.tier = 1;
    resize();
  } else {
    densityScale = 1.5;
    perf.tier = 2;
    count = 0;                              // rebuild the pool at the lower density
    resize();
  }
}

// -------------------------------------------------------------------- loop
const FRAME_MS = 1000 / 60;
let last = 0;
let running = false;
let rafId = 0;

function frame(now) {
  rafId = requestAnimationFrame(frame);
  const ms = last ? now - last : FRAME_MS;
  last = now;
  const dtf = Math.min(Math.max(ms / FRAME_MS, 0.01), 3);
  clock += dtf;

  updateTilt(dtf);
  updateMouseLocal();
  if (!reducedMotion.matches) step(dtf);
  renderer.render(scene, camera);
  adapt(ms);
}

let booted = false;

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
  resizeTimer = setTimeout(() => { resize(); if (!running) renderOnce(); }, 150);
});

// ------------------------------------------------------------------- boot
async function boot() {
  try {
    await document.fonts.load(`${CONFIG.fontWeight} 200px "Space Grotesk"`);
    await document.fonts.ready;
  } catch (_) { /* fall through with whatever font is available */ }
  resize();
  if (reducedMotion.matches) snapHome();
  renderOnce();
  booted = true;
  if (inView && !document.hidden) start();
  setInterval(cycle, CONFIG.cycleMs);
}

boot();
