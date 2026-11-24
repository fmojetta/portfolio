// Hero: "I turn insights into [user flows → prototypes → high-fidelity UI]"
//
// The headline is real, static HTML. Its last line (the "slot") is drawn by a
// 2D canvas particle field that walks through the design process: each stage
// is rendered at a higher fidelity than the one before -- early stages are
// sparse, loose, chunky dots; later ones are dense and precise. The cursor
// scatters the particles. No libraries.
//
// The crisp HTML text in the slot is the static fallback (no JS, or reduced
// motion); while the canvas runs it is hidden but still read by screen readers.
//
// Performance:
//   * one canvas path + one fill per frame for all particles
//   * physics over flat Float32Arrays (no per-particle objects)
//   * device pixel ratio capped at 2
//   * the loop stops while the hero is off screen or the tab is hidden
(function () {
  'use strict';

  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  // ---------------------------------------------------------------- config
  // Physics values are "per frame at 60fps" and in CSS px.
  var CONFIG = {
    stageMs: 6500,          // how long each sentence is shown
    stageLastMs: 8000,      // ... and the final one ("high-fidelity UI")

    // fidelity ramp: first stage -> last stage
    gapRamp: [1.7, 1.0],    // sampling gap multiplier (higher = fewer particles)
    jitterRamp: [0.7, 0.1], // positional noise, in units of the gap (sketchiness)
    sizeRamp: [1.5, 1.0],   // dot size multiplier (chunky -> fine)

    gap: 2.2,               // px between points at gapRefSize, full fidelity
    gapRefSize: 100,
    gapMin: 1.3,
    particleSize: 1.15,     // dot radius (CSS px) at full fidelity
    particleSizeMin: 0.6,

    // transitions
    morphSpeed: 1.7,        // stage -> stage burst
    blastSpeed: 3.4,        // last stage -> first stage (restart) burst
    scatterHold: 14,
    wander: 1.0,
    wanderThreshold: 0.6,

    // cursor
    mouseRadius: 110,
    repelForce: 2.6,
    swirl: 0.9,
    turbulence: 4.5,

    returnSpeed: 0.022,
    friction: 0.8,
    maxDpr: 2,
  };

  var hero = document.querySelector('.hero');
  var canvas = document.getElementById('scene');
  var slot = document.getElementById('heroSlot');
  var crisp = document.getElementById('heroCrisp');
  if (!hero || !canvas || !slot || !crisp) return;
  var ctx = canvas.getContext('2d');
  if (!ctx) return;

  var STAGES = slot.dataset.stages.split('|').map(function (s) { return s.trim(); }).filter(Boolean);
  var LAST = STAGES.length - 1;
  var color = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#0000ee';

  function lerp(a, b, t) { return a + (b - a) * t; }

  // -------------------------------------------------------- particle state
  var capacity = 0, count = 0;
  var px, py, vx, vy, hx, hy, hold, ease, lnFric, spin;

  function grow(old, cap) {
    var a = new Float32Array(cap);
    if (old) a.set(old.subarray(0, Math.min(old.length, cap)));
    return a;
  }

  function ensureCapacity(n) {
    if (n <= capacity) return;
    var cap = Math.ceil(n * 1.25);
    px = grow(px, cap); py = grow(py, cap);
    vx = grow(vx, cap); vy = grow(vy, cap);
    hx = grow(hx, cap); hy = grow(hy, cap);
    hold = grow(hold, cap);
    ease = grow(ease, cap); lnFric = grow(lnFric, cap); spin = grow(spin, cap);
    for (var i = capacity; i < cap; i++) {   // no two particles move alike
      ease[i] = CONFIG.returnSpeed * (0.4 + Math.random() * 1.2);
      lnFric[i] = Math.log(CONFIG.friction * (0.97 + Math.random() * 0.04));
      spin[i] = (Math.random() - 0.5) * 0.018;
    }
    capacity = cap;
  }

  // -------------------------------------------------------- text sampling
  // Particles are drawn exactly where the HTML text sits, in the same font.
  var SS = 2;   // offscreen supersampling for sub-pixel precision
  var off = document.createElement('canvas');
  var octx = off.getContext('2d', { willReadFrequently: true });

  var W = 0, H = 0, dpr = 1;
  var dotR = 1;   // current dot radius, CSS px

  function sample(text, fidelity) {
    var cs = getComputedStyle(crisp);
    var size = parseFloat(cs.fontSize);
    var font = cs.fontWeight + ' ' + (size * SS) + 'px ' + cs.fontFamily;

    var cRect = canvas.getBoundingClientRect();
    var tRect = crisp.getBoundingClientRect();
    var lRect = slot.getBoundingClientRect();
    var cx = (lRect.left + lRect.width / 2) - cRect.left;

    octx.font = font;
    var m = octx.measureText(text);
    var ascent = (m.fontBoundingBoxAscent || size * SS * 0.8) / SS;
    var baseline = (tRect.top - cRect.top) + ascent;

    // rasterise only the band around the line
    var top = Math.max(0, Math.floor(baseline - size * 1.2));
    var bandH = Math.ceil(size * 1.8);
    var left = Math.max(0, Math.floor(cx - m.width / SS / 2 - size * 0.5));
    var bandW = Math.min(W - left, Math.ceil(m.width / SS + size));
    var w = Math.max(1, bandW * SS), h = Math.max(1, bandH * SS);
    if (off.width !== w || off.height !== h) { off.width = w; off.height = h; }
    else octx.clearRect(0, 0, w, h);

    octx.font = font;
    octx.fillStyle = '#fff';
    octx.textAlign = 'center';
    octx.textBaseline = 'alphabetic';
    octx.fillText(text, (cx - left) * SS, (baseline - top) * SS);
    var data = octx.getImageData(0, 0, w, h).data;

    var gapMul = lerp(CONFIG.gapRamp[0], CONFIG.gapRamp[1], fidelity);
    var gap = Math.max(CONFIG.gapMin, CONFIG.gap * size / CONFIG.gapRefSize) * gapMul;
    var step = Math.max(1, Math.round(gap * SS));
    var realGap = step / SS;
    var jitter = lerp(CONFIG.jitterRamp[0], CONFIG.jitterRamp[1], fidelity) * realGap;

    var baseR = Math.max(CONFIG.particleSizeMin, CONFIG.particleSize * (realGap / gapMul / CONFIG.gap));
    dotR = baseR * lerp(CONFIG.sizeRamp[0], CONFIG.sizeRamp[1], fidelity);

    var out = [];
    for (var y = 0; y < h; y += step) {
      for (var x = 0; x < w; x += step) {
        if (data[(y * w + x) * 4 + 3] > 128) {
          out.push(left + x / SS + (Math.random() - 0.5) * jitter,
                   top + y / SS + (Math.random() - 0.5) * jitter);
        }
      }
    }
    return out;
  }

  function setText(stage) {
    var t = sample(STAGES[stage], LAST > 0 ? stage / LAST : 1);
    var n = t.length / 2;
    var prev = count;
    ensureCapacity(n);
    for (var i = 0; i < n; i++) { hx[i] = t[i * 2]; hy[i] = t[i * 2 + 1]; }
    // new particles split off from a random existing one
    for (i = prev; i < n; i++) {
      var src = prev > 0 ? Math.floor(Math.random() * prev) : i;
      px[i] = prev > 0 ? px[src] : hx[i];
      py[i] = prev > 0 ? py[src] : hy[i];
      vx[i] = vy[i] = 0;
      hold[i] = 0;
    }
    // a sparser stage doesn't delete particles mid-flight: extras stack on
    // random points of the new text
    for (i = n; i < prev; i++) {
      var j = Math.floor(Math.random() * n);
      hx[i] = hx[j]; hy[i] = hy[j];
    }
    count = Math.max(n, prev);
  }

  function explode(speed) {
    for (var i = 0; i < count; i++) {
      var ang = Math.random() * Math.PI * 2;
      var r = Math.random();
      var spd = speed * (0.35 + r * r * 1.5);
      vx[i] += Math.cos(ang) * spd;
      vy[i] += Math.sin(ang) * spd;
      hold[i] = Math.random() * CONFIG.scatterHold;
    }
  }

  // --------------------------------------------------------- choreography
  var stage = 0, stageT = 0;

  function goStage(i, speed) {
    stage = i;
    stageT = 0;
    setText(i);
    explode(speed);
  }

  function updateSequence(ms) {
    stageT += ms;
    var end = stage === LAST ? CONFIG.stageLastMs : CONFIG.stageMs;
    if (stageT > end) {
      var last = stage === LAST;
      goStage(last ? 0 : stage + 1, last ? CONFIG.blastSpeed : CONFIG.morphSpeed);
    }
  }

  // ---------------------------------------------------------------- cursor
  var mouse = { active: false, x: 0, y: 0 };

  function pointer(clientX, clientY) {
    var rect = canvas.getBoundingClientRect();
    mouse.x = clientX - rect.left;
    mouse.y = clientY - rect.top;
    mouse.active = true;
  }
  function pointerOut() { mouse.active = false; }

  // the text layer sits above the canvas, so listen on the whole hero
  hero.addEventListener('pointermove', function (e) { pointer(e.clientX, e.clientY); });
  hero.addEventListener('pointerleave', pointerOut);
  hero.addEventListener('touchmove', function (e) {
    if (e.touches[0]) pointer(e.touches[0].clientX, e.touches[0].clientY);
  }, { passive: true });
  hero.addEventListener('touchend', pointerOut);

  // --------------------------------------------------------------- physics
  function step(dtf) {
    var R = CONFIG.mouseRadius, R2 = R * R;
    var mx = mouse.x, my = mouse.y, ma = mouse.active;
    var wander = CONFIG.wander * dtf, wanderT = CONFIG.wanderThreshold;

    for (var i = 0; i < count; i++) {
      var x = px[i], y = py[i], ux = vx[i], uy = vy[i];

      if (ma) {
        var dx = x - mx, dy = y - my, d2 = dx * dx + dy * dy;
        if (d2 < R2 && d2 > 1e-8) {
          var dist = Math.sqrt(d2), nx = dx / dist, ny = dy / dist;
          var t = 1 - dist / R;
          var f = t * t * CONFIG.repelForce * R * 0.12 * dtf;
          ux += nx * f - ny * f * CONFIG.swirl;
          uy += ny * f + nx * f * CONFIG.swirl;
          ux += (Math.random() - 0.5) * CONFIG.turbulence * t * dtf;
          uy += (Math.random() - 0.5) * CONFIG.turbulence * t * dtf;
        }
      }

      if (hold[i] > 0) {
        hold[i] -= dtf;
      } else {
        var ex = hx[i] - x, ey = hy[i] - y;
        var e = ease[i] * dtf, s = spin[i] * dtf;
        ux += ex * e - ey * s;   // spring home, curling in instead of straight
        uy += ey * e + ex * s;
      }

      if (Math.abs(ux) + Math.abs(uy) > wanderT) {
        ux += (Math.random() - 0.5) * wander;
        uy += (Math.random() - 0.5) * wander;
      }

      var damp = Math.exp(lnFric[i] * dtf);
      ux *= damp; uy *= damp;
      px[i] = x + ux * dtf; py[i] = y + uy * dtf;
      vx[i] = ux; vy[i] = uy;
    }
  }

  function draw() {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = color;
    ctx.beginPath();
    var r = dotR, TAU = Math.PI * 2;
    for (var i = 0; i < count; i++) {
      ctx.moveTo(px[i] + r, py[i]);
      ctx.arc(px[i], py[i], r, 0, TAU);
    }
    ctx.fill();
  }

  // ----------------------------------------------------------------- setup
  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, CONFIG.maxDpr);
    W = Math.max(1, canvas.clientWidth);
    H = Math.max(1, canvas.clientHeight);
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    setText(stage);
  }

  // ------------------------------------------------------------------ loop
  var FRAME_MS = 1000 / 60;
  var last = 0, running = false, booted = false, rafId = 0, inView = true;

  function frame(now) {
    rafId = requestAnimationFrame(frame);
    var ms = last ? Math.min(now - last, 100) : FRAME_MS;
    last = now;
    var dtf = Math.max(ms / FRAME_MS, 0.01);
    updateSequence(ms);
    step(dtf);
    draw();
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

  new IntersectionObserver(function (entries) {
    inView = entries[0].isIntersecting;
    inView && !document.hidden ? start() : stop();
  }).observe(canvas);

  document.addEventListener('visibilitychange', function () {
    !document.hidden && inView ? start() : stop();
  });

  var resizeTimer;
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      resize();
      if (!running) draw();
    }, 150);
  });

  function boot() {
    hero.classList.add('hero--canvas');   // hides the static fallback text
    resize();
    // the first sentence flies in from across the hero
    for (var i = 0; i < count; i++) {
      px[i] = Math.random() * W;
      py[i] = Math.random() * H;
    }
    booted = true;
    if (inView && !document.hidden) start();
  }

  // wait for the web font so the sampled glyphs are the real letterforms
  var cs = getComputedStyle(crisp);
  if (document.fonts && document.fonts.load) {
    document.fonts.load(cs.fontWeight + ' 100px ' + cs.fontFamily)
      .then(function () { return document.fonts.ready; })
      .then(boot, boot);
  } else {
    window.addEventListener('load', boot);
  }
})();
