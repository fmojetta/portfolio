// Small particle icons (used in the "Let's talk" footer).
//
// Same look as the hero's particle headline -- bright electric dots of
// slightly different sizes, each with its own brightness, twinkle and drift,
// white sparks, a soft halo and additive glow -- but packaged as tiny,
// self-contained canvases:
//   * markup: <span class="p-icon" data-particle-icon="chat"></span>
//   * each icon forms (flies in) the first time it scrolls into view
//   * the cursor scatters its particles; they settle back
//   * one shared animation loop that only runs while an icon is on screen
//   * reduced motion: drawn once, still
(function () {
  'use strict';

  var icons = Array.prototype.slice.call(document.querySelectorAll('[data-particle-icon]'));
  if (!icons.length || !window.Path2D) return;

  var reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  var CONFIG = {
    dotColor: '#8EA2FF',      // same palette as the hero particles (js/hero.js)
    sparkColor: '#E2E8FF',
    glowColor: '#3B5BFF',
    glowSize: 2.8,
    glowAlpha: 0.11,
    gap: 2.4,                 // px between sampled points
    dotR: 1.05,               // base dot radius (px)
    line: 4.2,                // stroke width in the 100-unit drawing box
    alphaMin: 0.7,
    twinkle: 0.45,
    drift: [0.3, 1.2],        // px, each particle's own wandering radius
    returnSpeed: 0.05,
    friction: 0.86,
    mouseRadius: 60,
    push: 1.6,
  };

  // Hand-drawn shapes in a 100x100 box (deliberately a little wobbly).
  var SHAPES = {
    // speech balloon with a tail and three "typing" dots
    chat: [
      'M20 14 C34 11 66 11 80 14 C88 16 90 22 90 32 L90 50 C90 60 86 64 78 65 L46 66 L28 84 L31 66 L22 65 C14 64 10 60 10 50 L10 32 C10 22 12 16 20 14',
      'M33 40 C35 38 38 38 39 40 C40 43 37 45 35 44 C33 43 32 41 33 40',
      'M48 40 C50 38 53 38 54 40 C55 43 52 45 50 44 C48 43 47 41 48 40',
      'M63 40 C65 38 68 38 69 40 C70 43 67 45 65 44 C63 43 62 41 63 40',
    ],
    // envelope with its flap open and a letter peeking out
    mail: [
      'M10 46 L11 88 L90 87 L89 46',           // body
      'M10 46 L50 13 L89 46',                  // open flap
      'M11 87 L41 63',                         // bottom-left fold
      'M90 87 L60 63',                         // bottom-right fold
      'M10 46 L50 72 L89 46',                  // inner seam
      'M24 56 L24 30 L76 30 L76 56',           // letter
      'M33 40 L67 40', 'M33 48 L58 48',        // lines on the letter
    ],
  };

  function rand(a, b) { return a + Math.random() * (b - a); }

  // rasterise a shape into the icon's box and return home points
  function sample(name, size, gap) {
    var paths = SHAPES[name] || [];
    var SS = 2, box = Math.ceil(size * SS);
    var c = document.createElement('canvas');
    c.width = c.height = box;
    var x = c.getContext('2d', { willReadFrequently: true });
    x.scale(box / 100, box / 100);
    x.lineWidth = CONFIG.line;
    x.lineCap = x.lineJoin = 'round';
    x.strokeStyle = '#fff';
    for (var i = 0; i < paths.length; i++) x.stroke(new Path2D(paths[i]));
    var data = x.getImageData(0, 0, box, box).data;
    var step = Math.max(1, Math.round(gap * SS)), out = [];
    for (var py = 0; py < box; py += step) {
      for (var px = 0; px < box; px += step) {
        if (data[(py * box + px) * 4 + 3] > 128) {
          out.push(px / SS + rand(-0.4, 0.4), py / SS + rand(-0.4, 0.4));
        }
      }
    }
    return out;
  }

  // ------------------------------------------------------------- one icon
  function Icon(el) {
    this.el = el;
    this.canvas = document.createElement('canvas');
    this.canvas.setAttribute('aria-hidden', 'true');
    el.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d');
    this.mouse = { x: -1e4, y: -1e4 };
    this.formed = false;
    this.visible = false;
    this.layout();
  }

  Icon.prototype.layout = function () {
    var size = this.el.clientWidth || 100;
    var pad = Math.round(size * 0.35);              // room for the fly-in / scatter
    this.size = size;
    this.pad = pad;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    var full = size + pad * 2;
    this.full = full;
    this.canvas.style.cssText = 'position:absolute;left:' + (-pad) + 'px;top:' + (-pad) +
      'px;width:' + full + 'px;height:' + full + 'px;pointer-events:none;';
    this.canvas.width = Math.round(full * this.dpr);
    this.canvas.height = Math.round(full * this.dpr);

    // small icons (phones) need finer dots, or detail clumps into a blob
    var small = size < 80;
    this.gap = small ? 1.6 : CONFIG.gap;
    this.dotR = small ? 0.7 : CONFIG.dotR;
    var pts = sample(this.el.getAttribute('data-particle-icon'), size, this.gap);
    var n = pts.length / 2;
    this.n = n;
    var F = Float32Array;
    this.px = new F(n); this.py = new F(n); this.vx = new F(n); this.vy = new F(n);
    this.hx = new F(n); this.hy = new F(n); this.sz = new F(n); this.al = new F(n);
    this.tw = new F(n); this.tp = new F(n); this.da = new F(n);
    this.dfx = new F(n); this.dfy = new F(n); this.dpx = new F(n); this.dpy = new F(n);
    this.hold = new F(n); this.ease = new F(n);
    for (var i = 0; i < n; i++) {
      this.hx[i] = pts[i * 2] + pad;
      this.hy[i] = pts[i * 2 + 1] + pad;
      // start scattered; they fly in when the icon first appears
      this.px[i] = this.formed || reduced ? this.hx[i] : rand(0, full);
      this.py[i] = this.formed || reduced ? this.hy[i] : rand(0, full);
      var r = (Math.random() + Math.random()) / 2 - 0.5;
      if (Math.random() < 0.12) r = 0.5 + Math.random() * 0.5;
      this.sz[i] = Math.max(0.4, 1 + r * 0.9);
      this.al[i] = CONFIG.alphaMin + Math.random() * (1 - CONFIG.alphaMin);
      this.tw[i] = rand(0.5, 2.2) / 1000;
      this.tp[i] = Math.random() * Math.PI * 2;
      this.da[i] = rand(CONFIG.drift[0], CONFIG.drift[1]);
      this.dfx[i] = rand(0.25, 0.9) / 1000;
      this.dfy[i] = rand(0.25, 0.9) / 1000;
      this.dpx[i] = Math.random() * Math.PI * 2;
      this.dpy[i] = Math.random() * Math.PI * 2;
      this.ease[i] = CONFIG.returnSpeed * rand(0.6, 1.3);
      this.hold[i] = this.formed ? 0 : rand(0, 40);  // staggered arrival
    }
  };

  Icon.prototype.step = function (dtf, t) {
    var R = CONFIG.mouseRadius, R2 = R * R, mx = this.mouse.x, my = this.mouse.y;
    var damp = Math.pow(CONFIG.friction, dtf);
    for (var i = 0; i < this.n; i++) {
      var x = this.px[i], y = this.py[i], ux = this.vx[i], uy = this.vy[i];
      var dx = x - mx, dy = y - my, d2 = dx * dx + dy * dy;
      if (d2 < R2 && d2 > 1e-6) {                    // cursor scatters them
        var d = Math.sqrt(d2), f = (1 - d / R) * CONFIG.push * dtf;
        ux += dx / d * f; uy += dy / d * f;
      }
      if (this.hold[i] > 0) {
        this.hold[i] -= dtf;
      } else {
        var tx = this.hx[i] + Math.sin(t * this.dfx[i] + this.dpx[i]) * this.da[i];
        var ty = this.hy[i] + Math.cos(t * this.dfy[i] + this.dpy[i]) * this.da[i];
        var e = this.ease[i] * dtf;
        ux += (tx - x) * e; uy += (ty - y) * e;
      }
      ux *= damp; uy *= damp;
      this.px[i] = x + ux * dtf; this.py[i] = y + uy * dtf;
      this.vx[i] = ux; this.vy[i] = uy;
    }
  };

  Icon.prototype.draw = function (t) {
    var c = this.ctx, TAU = Math.PI * 2, i, a, r;
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    c.clearRect(0, 0, this.full, this.full);
    c.globalCompositeOperation = 'lighter';
    // halo
    c.fillStyle = CONFIG.glowColor;
    c.globalAlpha = CONFIG.glowAlpha;
    c.beginPath();
    for (i = 0; i < this.n; i++) {
      r = this.dotR * CONFIG.glowSize * this.sz[i];
      c.moveTo(this.px[i] + r, this.py[i]);
      c.arc(this.px[i], this.py[i], r, 0, TAU);
    }
    c.fill();
    // dots in brightness buckets; the brightest is a white spark
    var B = 5, tA = CONFIG.twinkle;
    for (var b = 0; b < B; b++) {
      var lo = b / B, hi = (b + 1) / B, top = b === B - 1;
      c.fillStyle = top ? CONFIG.sparkColor : CONFIG.dotColor;
      c.globalAlpha = top ? 1 : hi;
      c.beginPath();
      for (i = 0; i < this.n; i++) {
        a = this.al[i] * (1 - tA * 0.5 + tA * 0.5 * Math.sin(t * this.tw[i] + this.tp[i]));
        if (a < lo || (a >= hi && !top)) continue;
        r = this.dotR * this.sz[i];
        c.moveTo(this.px[i] + r, this.py[i]);
        c.arc(this.px[i], this.py[i], r, 0, TAU);
      }
      c.fill();
    }
    c.globalAlpha = 1;
    c.globalCompositeOperation = 'source-over';
  };

  var list = icons.map(function (el) { return new Icon(el); });

  if (reduced) {
    list.forEach(function (ic) { ic.draw(0); });
    return;
  }

  // ------------------------------------------------- one shared, lazy loop
  var running = false, last = 0, clock = 0, raf = 0;
  function anyVisible() { return list.some(function (ic) { return ic.visible; }); }
  function frame(now) {
    var ms = last ? Math.min(now - last, 100) : 16.7;
    last = now; clock += ms;
    var dtf = ms / 16.7;
    list.forEach(function (ic) {
      if (!ic.visible) return;
      ic.step(dtf, clock);
      ic.draw(clock);
    });
    raf = anyVisible() ? requestAnimationFrame(frame) : (running = false, 0);
  }
  function start() {
    if (running) return;
    running = true; last = 0;
    raf = requestAnimationFrame(frame);
  }

  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) {
      var ic = list.find(function (x) { return x.el === e.target; });
      if (!ic) return;
      ic.visible = e.isIntersecting;
      if (ic.visible) { ic.formed = true; start(); }
    });
  }, { threshold: 0.2 });
  list.forEach(function (ic) { io.observe(ic.el); });

  // cursor: icons react when the pointer passes near them
  window.addEventListener('pointermove', function (e) {
    list.forEach(function (ic) {
      if (!ic.visible) return;
      var r = ic.canvas.getBoundingClientRect();
      ic.mouse.x = e.clientX - r.left;
      ic.mouse.y = e.clientY - r.top;
    });
  }, { passive: true });

  var rt;
  window.addEventListener('resize', function () {
    clearTimeout(rt);
    rt = setTimeout(function () { list.forEach(function (ic) { ic.layout(); }); }, 200);
  });
})();
