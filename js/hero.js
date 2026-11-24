// Hero: "I love making things [look right → work in code → ship faster with AI]"
//
// The headline is real, static HTML. Its last line (the "slot") is drawn by a
// 2D canvas particle field that walks through the design process: each stage
// is rendered at a higher fidelity than the one before -- early stages are
// sparse, loose, chunky dots; later ones are dense and precise. No libraries.
//
// Liquid feel:
//   * flow    -- a smooth current; off at rest (flowAmp 0), used only to
//                loosen the letters while they wait for the pour wave
//   * stir    -- the cursor drags particles along its own movement and leaves
//                a swirling wake, like a hand through water
//   * pour    -- between sentences the particles stream to the next word in a
//                left-to-right wave, arcing on the way, instead of exploding
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
    stageMs: 7500,          // how long each sentence is shown
    stageLastMs: 8000,      // ... and the final one

    fidelityRamp: false,    // true: phrases go sketchy -> precise; false: all crisp
    // fidelity ramp: first stage -> last stage
    gapRamp: [1.7, 1.0],    // sampling gap multiplier (higher = fewer particles)
    jitterRamp: [0.7, 0.1], // positional noise, in units of the gap (sketchiness)
    sizeRamp: [1.5, 1.0],   // dot size multiplier (chunky -> fine)

    // overrides for small text (headline under 48px, i.e. phones)
    small: {
      gapRamp: [1.25, 1.0],
      jitterRamp: [0.3, 0.05],
      gapMin: 1.1,
      particleSizeMin: 0.5,
      sizeVar: 0.2,
    },

    gap: 2.2,               // px between points at gapRefSize, full fidelity
    gapRefSize: 100,
    gapMin: 1.3,
    particleSize: 1.15,     // dot radius (CSS px) at full fidelity
    particleSizeMin: 0.6,
    sizeVar: 0.45,          // per-particle size spread: most dots near the base
                            // size, a few noticeably bigger or smaller (0 = uniform)

    // flow: a smooth current that ripples the letters (CSS px, radians/ms)
    flowAmp: 0,             // resting ripple (px); 0 = letters sit still once formed
    flowScale: 0.018,       // spatial frequency (lower = broader waves)
    flowSpeed: 0.0007,      // how fast the current changes

    // pour: stage -> stage transition
    pourMs: 800,            // left-to-right sweep duration of the wave
    pourJitter: 200,        // random extra delay per particle (ms)
    meltAmp: 7,             // while waiting for the wave, letters loosen into a
                            // ripple of up to this many px ...
    meltCreep: 0.18,        // ... and creep this far toward their new place
    pourLift: 1.3,          // upward kick at release -> particles arc over

    // stir: cursor
    mouseRadius: 120,
    stir: 0.10,             // how strongly particles take on the cursor's motion
    part: 0.9,              // gentle outward push so the cursor parts the text
    vortex: 0.035,          // swirl strength, scales with cursor speed

    returnSpeed: 0.03,
    friction: 0.86,         // higher = longer, silkier wakes
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
  var color = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#6D86FF';

  function lerp(a, b, t) { return a + (b - a) * t; }

  // -------------------------------------------------------- particle state
  var capacity = 0, count = 0;
  var px, py, vx, vy, hx, hy, ox, oy, hold, hs, ease, lnFric, spin, sz;

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
    ox = grow(ox, cap); oy = grow(oy, cap);
    hold = grow(hold, cap); hs = grow(hs, cap);
    ease = grow(ease, cap); lnFric = grow(lnFric, cap); spin = grow(spin, cap);
    sz = grow(sz, cap);
    for (var i = capacity; i < cap; i++) {   // no two particles move alike
      // narrow spread: no slow stragglers leaving the line empty mid-switch
      ease[i] = CONFIG.returnSpeed * (0.75 + Math.random() * 0.6);
      lnFric[i] = Math.log(CONFIG.friction * (0.97 + Math.random() * 0.04));
      spin[i] = (Math.random() - 0.5) * 0.018;
      // size multiplier: averaging two randoms clusters values near 1, so the
      // field reads as organic grain with the odd larger droplet
      var r = (Math.random() + Math.random()) / 2 - 0.5;   // -0.5..0.5, peaked at 0
      sz[i] = r;   // raw spread; scaled by sizeVarNow at draw time
    }
    capacity = cap;
  }

  // -------------------------------------------------------- text sampling
  // Particles are drawn exactly where the HTML text sits, in the same font.
  var SS = 2;   // offscreen supersampling for sub-pixel precision
  var off = document.createElement('canvas');
  var octx = off.getContext('2d', { willReadFrequently: true });

  var W = 0, H = 0, dpr = 1;
  var dotR = 1;      // current dot radius, CSS px (eases toward dotTarget)
  var dotTarget = 1;
  var sizeVarNow = CONFIG.sizeVar;   // size spread for the current text size
  var cache = [];    // pre-sampled stages, rebuilt on resize, so switching
                     // sentences never stalls a frame on text rasterising

  function sample(text, fidelity) {
    var cs = getComputedStyle(crisp);
    var size = parseFloat(cs.fontSize);
    var font = cs.fontStyle + ' ' + cs.fontWeight + ' ' + (size * SS) + 'px ' + cs.fontFamily;

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

    // Small text (phones) has thin strokes, so it needs denser, calmer dots
    // to stay legible: a finer gap, a flatter fidelity ramp and less noise.
    var small = size < 48;
    var ramp = small ? CONFIG.small : CONFIG;
    var gapMul = lerp(ramp.gapRamp[0], ramp.gapRamp[1], fidelity);
    var gap = Math.max(small ? CONFIG.small.gapMin : CONFIG.gapMin,
                       CONFIG.gap * size / CONFIG.gapRefSize) * gapMul;
    var step = Math.max(1, Math.round(gap * SS));
    var realGap = step / SS;
    var jitter = lerp(ramp.jitterRamp[0], ramp.jitterRamp[1], fidelity) * realGap;
    sizeVarNow = small ? CONFIG.small.sizeVar : CONFIG.sizeVar;

    var baseR = Math.max(small ? CONFIG.small.particleSizeMin : CONFIG.particleSizeMin, CONFIG.particleSize * (realGap / gapMul / CONFIG.gap));
    var radius = baseR * lerp(CONFIG.sizeRamp[0], CONFIG.sizeRamp[1], fidelity);

    var out = [];
    for (var y = 0; y < h; y += step) {
      for (var x = 0; x < w; x += step) {
        if (data[(y * w + x) * 4 + 3] > 128) {
          out.push(left + x / SS + (Math.random() - 0.5) * jitter,
                   top + y / SS + (Math.random() - 0.5) * jitter);
        }
      }
    }
    return { pts: out, r: radius };
  }

  function buildCache() {
    cache = STAGES.map(function (text, i) {
      return sample(text, CONFIG.fidelityRamp && LAST > 0 ? i / LAST : 1);
    });
  }

  function setText(stage) {
    var c = cache[stage], t = c.pts;
    dotTarget = c.r;
    var n = t.length / 2;
    var prev = count;
    ensureCapacity(n);
    // remember where everyone was headed: they wait there until the pour
    // wave reaches them
    for (var i = 0; i < prev; i++) { ox[i] = hx[i]; oy[i] = hy[i]; }
    for (i = 0; i < n; i++) { hx[i] = t[i * 2]; hy[i] = t[i * 2 + 1]; }
    // new particles split off from a random existing one
    for (i = prev; i < n; i++) {
      var src = prev > 0 ? Math.floor(Math.random() * prev) : i;
      px[i] = prev > 0 ? px[src] : hx[i];
      py[i] = prev > 0 ? py[src] : hy[i];
      ox[i] = prev > 0 ? ox[src] : hx[i];
      oy[i] = prev > 0 ? oy[src] : hy[i];
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

  // Pour: each particle waits on its old letter until a left-to-right wave
  // reaches it, then springs (arcing) to its place in the new word.
  function pour() {
    var minX = Infinity, maxX = -Infinity;
    for (var i = 0; i < count; i++) {
      if (ox[i] < minX) minX = ox[i];
      if (ox[i] > maxX) maxX = ox[i];
    }
    var span = Math.max(1, maxX - minX);
    for (i = 0; i < count; i++) {
      var ms = ((ox[i] - minX) / span) * CONFIG.pourMs + Math.random() * CONFIG.pourJitter;
      hold[i] = hs[i] = ms / FRAME_MS;   // in 60fps-frame units
    }
  }

  // --------------------------------------------------------- choreography
  var stage = 0, stageT = 0;

  function goStage(i) {
    stage = i;
    stageT = 0;
    setText(i);
    pour();
  }

  function updateSequence(ms) {
    stageT += ms;
    var end = stage === LAST ? CONFIG.stageLastMs : CONFIG.stageMs;
    if (stageT > end) {
      goStage(stage === LAST ? 0 : stage + 1);
    }
  }

  // ---------------------------------------------------------------- cursor
  // vx/vy: cursor velocity in px per 60fps frame, smoothed; it decays every
  // frame, so a resting cursor stops stirring
  var mouse = { active: false, x: 0, y: 0, vx: 0, vy: 0, t: 0 };

  function pointer(clientX, clientY) {
    var rect = canvas.getBoundingClientRect();
    var x = clientX - rect.left, y = clientY - rect.top;
    var now = performance.now();
    if (mouse.active && mouse.t) {
      var f = Math.max(now - mouse.t, 1) / FRAME_MS;
      var k = 0.5;   // smoothing
      mouse.vx += ((x - mouse.x) / f - mouse.vx) * k;
      mouse.vy += ((y - mouse.y) / f - mouse.vy) * k;
    }
    mouse.x = x; mouse.y = y; mouse.t = now;
    mouse.active = true;
  }
  function pointerOut() { mouse.active = false; mouse.vx = mouse.vy = 0; mouse.t = 0; }

  // the text layer sits above the canvas, so listen on the whole hero
  hero.addEventListener('pointermove', function (e) { pointer(e.clientX, e.clientY); });
  hero.addEventListener('pointerleave', pointerOut);
  hero.addEventListener('touchmove', function (e) {
    if (e.touches[0]) pointer(e.touches[0].clientX, e.touches[0].clientY);
  }, { passive: true });
  hero.addEventListener('touchend', pointerOut);

  // --------------------------------------------------------------- physics
  var clockMs = 0;

  function step(dtf) {
    var R = CONFIG.mouseRadius, R2 = R * R;
    var mx = mouse.x, my = mouse.y, ma = mouse.active;
    var mvx = mouse.vx, mvy = mouse.vy;
    var mspeed = Math.sqrt(mvx * mvx + mvy * mvy);
    var A = CONFIG.flowAmp, K = CONFIG.flowScale, T = clockMs * CONFIG.flowSpeed;

    for (var i = 0; i < count; i++) {
      var x = px[i], y = py[i], ux = vx[i], uy = vy[i];

      // stir: inside the cursor's reach, particles take on its motion, get a
      // soft outward nudge, and swirl around it in proportion to its speed
      if (ma) {
        var dx = x - mx, dy = y - my, d2 = dx * dx + dy * dy;
        if (d2 < R2 && d2 > 1e-8) {
          var dist = Math.sqrt(d2), nx = dx / dist, ny = dy / dist;
          var t = 1 - dist / R, w = t * t * dtf;
          ux += (mvx - ux) * CONFIG.stir * w * 4;
          uy += (mvy - uy) * CONFIG.stir * w * 4;
          ux += nx * CONFIG.part * w;
          uy += ny * CONFIG.part * w;
          var sw = mspeed * CONFIG.vortex * w * 4;
          ux += -ny * sw;
          uy += nx * sw;
        }
      }

      // target: the old letter while waiting for the pour wave, else the new
      // While waiting the letter "melts": its ripple grows and it starts to
      // creep toward the new word, so nothing ever sits frozen.
      var waiting = hold[i] > 0;
      var bx = hx[i], by = hy[i], amp = A;
      if (waiting) {
        var pr = 1 - hold[i] / hs[i];               // 0 -> 1 as the wave arrives
        var creep = pr * pr * CONFIG.meltCreep;
        bx = ox[i] + (hx[i] - ox[i]) * creep;
        by = oy[i] + (hy[i] - oy[i]) * creep;
        amp = A + pr * CONFIG.meltAmp;
        hold[i] -= dtf;
        if (hold[i] <= 0) {        // released: arc up and over to the new word
          uy -= CONFIG.pourLift * (0.6 + Math.random() * 0.8);
          ux += (Math.random() - 0.5) * 0.8;
        }
      }

      // flow: smooth current, sampled at the particle's home so each letter
      // ripples as one surface rather than jittering dot by dot
      var fx = Math.sin(by * K + T) + 0.5 * Math.sin((bx + by) * K * 1.7 - T * 1.3);
      var fy = Math.cos(bx * K - T * 0.9) + 0.5 * Math.cos((bx - by) * K * 1.3 + T * 1.1);
      var ex = bx + fx * amp - x, ey = by + fy * amp - y;
      var e = ease[i] * dtf, s = spin[i] * dtf;
      ux += ex * e - ey * s;   // spring toward the drifting target, curling in
      uy += ey * e + ex * s;

      var damp = Math.exp(lnFric[i] * dtf);
      ux *= damp; uy *= damp;
      px[i] = x + ux * dtf; py[i] = y + uy * dtf;
      vx[i] = ux; vy[i] = uy;
    }

    // a still cursor stops stirring
    var decay = Math.pow(0.85, dtf);
    mouse.vx *= decay; mouse.vy *= decay;
  }

  function draw() {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = color;
    ctx.beginPath();
    var TAU = Math.PI * 2;
    var sv = sizeVarNow * 2;
    for (var i = 0; i < count; i++) {
      var r = dotR * Math.max(0.35, 1 + sz[i] * sv);
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
    buildCache();
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
    clockMs += ms;
    dotR += (dotTarget - dotR) * (1 - Math.pow(0.94, dtf));   // sizes morph, never jump
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
    dotR = dotTarget;
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
    document.fonts.load(cs.fontStyle + ' ' + cs.fontWeight + ' 100px ' + cs.fontFamily)
      .then(function () { return document.fonts.ready; })
      .then(boot, boot);
  } else {
    window.addEventListener('load', boot);
  }
})();
