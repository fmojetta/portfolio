// ------------------------------------------- carousel: curved-wall renderer
// Draws the carousel items on a WebGL canvas as if they were printed on the
// inside wall of a cylinder around the viewer, using the real projection:
// a point at distance s along the wall sits at angle th = s / R, and lands on
// screen at  x = R * tan(th),  y = y / cos(th).
// Near the centre that is almost flat; towards the edges both factors grow
// smoothly and ever faster, so images widen and grow taller there and their
// top and bottom edges bow into continuous curves -- then dissolve.
//
// No libraries: one tiny shader program, one subdivided quad per item.
// carousel.js keeps doing layout, the loop, drag and video playback on the
// (now invisible) DOM items; this file only paints them. If WebGL isn't
// available it returns null and carousel.js keeps its CSS fallback.
window.createCarouselCurve = function (carousel, track, opts) {
  'use strict';

  var CURVE = {
    angle: 44,         // how far round the wall you see at the screen edge (deg).
                       // Higher = stronger curve; the edge is 1/cos(angle) taller
                       // (44deg -> +39%)
    angleSmall: 34,    // the same on narrow screens
    fadeStart: 0.86,   // fraction of that angle where items start dissolving

    // glass at the edges: the outer bands of the wall look like thick curved
    // glass -- content is refracted (shifted and magnified), the colour
    // channels split into a thin rainbow fringe, and a soft light catches
    // the rim. All in screen space (0 = centre, 1 = screen edge).
    glassStart: 0.7,   // where the glass band begins
    refract: 0.07,     // how far content is displaced at the very edge (uv)
    magnify: 0.0,      // vertical magnification at the edge (0 = off)
    aberration: 0.55,  // colour fringe strength (relative split of channels)
    rim: 0.10,         // brightness of the soft light line where the glass begins
    sheen: 0.06,       // brightness of the wider soft sheen inside the band
    segments: 48,      // columns per item -> smoothness of the curve
    rows: 10,          // rows per item -> keeps lines inside the images straight
    maxDpr: 1.5,
  };

  var canvas = document.createElement('canvas');
  canvas.className = 'carousel__gl';
  canvas.setAttribute('aria-hidden', 'true');
  var gl = canvas.getContext('webgl', { premultipliedAlpha: true, antialias: true, alpha: true });
  if (!gl) return null;

  // ------------------------------------------------------------- shaders
  var VS = [
    'attribute vec2 a;',             // 0..1 across the item
    'uniform vec4 uRect;',           // x, y, w, h in CSS px (carousel box)
    'uniform vec2 uView;',           // carousel box size, CSS px
    'uniform float uR, uMax, uFade;',// wall radius (px), max angle (rad), fade start
    'varying vec2 vLocal;',
    'varying vec2 vUv;',
    'varying float vAlpha;',
    'varying float vU;',             // screen position, -1 left edge .. 1 right edge
    'void main() {',
    '  vec2 p = uRect.xy + a * uRect.zw;',
    '  vec2 c = uView * 0.5;',
    '  float th = clamp((p.x - c.x) / uR, -1.45, 1.45);',  // angle round the wall
    '  p.x = c.x + uR * tan(th);',
    '  p.y = c.y + (p.y - c.y) / cos(th);',
    '  vAlpha = 1.0 - smoothstep(uFade, 1.0, abs(th) / uMax);',
    '  vU = (p.x - c.x) / c.x;',
    '  vUv = a;',
    '  vLocal = a * uRect.zw;',
    '  vec2 ndc = p / uView * 2.0 - 1.0;',
    '  gl_Position = vec4(ndc.x, -ndc.y, 0.0, 1.0);',
    '}'
  ].join('\n');

  var FS = [
    'precision mediump float;',
    'uniform sampler2D uTex;',
    'uniform float uReady;',
    'uniform vec3 uBlank;',
    'uniform vec2 uSize;',          // item size, CSS px
    'uniform float uRadius;',
    'uniform float uGlass, uRefract, uMag, uCA, uRim, uSheen;',
    'varying vec2 vUv;',
    'varying vec2 vLocal;',
    'varying float vAlpha;',
    'varying float vU;',
    'void main() {',
    // rounded-rectangle mask in item space
    '  vec2 h = uSize * 0.5;',
    '  vec2 q = abs(vLocal - h) - (h - vec2(uRadius));',
    '  float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - uRadius;',
    '  float m = 1.0 - smoothstep(-0.75, 0.75, d);',
    // glass band: 0 in the middle of the screen, rising to 1 at the edge
    '  float au = abs(vU);',
    '  float g = smoothstep(uGlass, 1.0, au);',
    '  float k = g * g;',
    '  float dir = sign(vU);',
    // refraction: pull content outward (as through a thick convex rim) and
    // magnify it a little vertically
    '  vec2 uv = vUv;',
    '  uv.y = 0.5 + (uv.y - 0.5) * (1.0 - k * uMag);',
    '  float dx = -dir * k * uRefract;',
    // chromatic aberration: each channel refracts by a slightly different amount
    '  vec3 col;',
    '  if (uReady > 0.5) {',
    '    col.r = texture2D(uTex, clamp(uv + vec2(dx * (1.0 + uCA), 0.0), 0.0, 1.0)).r;',
    '    col.g = texture2D(uTex, clamp(uv + vec2(dx, 0.0), 0.0, 1.0)).g;',
    '    col.b = texture2D(uTex, clamp(uv + vec2(dx * (1.0 - uCA), 0.0), 0.0, 1.0)).b;',
    '  } else { col = uBlank; }',
    // light: a crisp rim where the glass begins plus a soft sheen inside it
    '  float rim = exp(-pow((au - uGlass) / 0.02, 2.0)) * uRim;',
    '  float sheen = exp(-pow((au - (uGlass + 1.0) * 0.5) / 0.06, 2.0)) * uSheen;',
    '  col = col + vec3(rim + sheen);',
    '  float a = m * vAlpha;',
    '  gl_FragColor = vec4(min(col, 1.0) * a, a);',
    '}'
  ].join('\n');

  function compile(type, src) {
    var s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  }
  var prog;
  try {
    prog = gl.createProgram();
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
  } catch (e) {
    return null;
  }
  gl.useProgram(prog);
  var U = {};
  ['uRect', 'uView', 'uR', 'uMax', 'uFade', 'uTex', 'uReady',
   'uBlank', 'uSize', 'uRadius', 'uGlass', 'uRefract', 'uMag', 'uCA', 'uRim',
   'uSheen'].forEach(function (n) { U[n] = gl.getUniformLocation(prog, n); });

  // one subdivided strip (N columns x 1 row) shared by every item
  // grid of N columns x M rows: the rows keep straight lines inside the
  // images straight (one tall row per column showed a sawtooth from affine
  // texture interpolation across the bent quads)
  var N = CURVE.segments, M = CURVE.rows, verts = [];
  for (var i = 0; i < N; i++) {
    var x0 = i / N, x1 = (i + 1) / N;
    for (var j = 0; j < M; j++) {
      var y0 = j / M, y1 = (j + 1) / M;
      verts.push(x0, y0, x1, y0, x0, y1,  x0, y1, x1, y0, x1, y1);
    }
  }
  var buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(verts), gl.STATIC_DRAW);
  var aLoc = gl.getAttribLocation(prog, 'a');
  gl.enableVertexAttribArray(aLoc);
  gl.vertexAttribPointer(aLoc, 2, gl.FLOAT, false, 0, 0);
  var VERTS = verts.length / 2;

  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.uniform1i(U.uTex, 0);
  gl.uniform1f(U.uFade, CURVE.fadeStart);
  gl.uniform1f(U.uGlass, CURVE.glassStart);
  gl.uniform1f(U.uRefract, CURVE.refract);
  gl.uniform1f(U.uMag, CURVE.magnify);
  gl.uniform1f(U.uCA, CURVE.aberration);
  gl.uniform1f(U.uRim, CURVE.rim);
  gl.uniform1f(U.uSheen, CURVE.sheen);
  var blank = (getComputedStyle(document.documentElement).getPropertyValue('--paper-2').trim() || '#1D1B18');
  var bc = parseInt(blank.replace('#', ''), 16);
  gl.uniform3f(U.uBlank, (bc >> 16 & 255) / 255, (bc >> 8 & 255) / 255, (bc & 255) / 255);

  // --------------------------------------------------------- media → texture
  // Each item's media is drawn (object-fit: cover) into a small canvas sized
  // for the screen, then uploaded. Videos re-upload only when a new frame has
  // actually been decoded, and only while the item is on screen.
  var slots = [];
  function slotFor(el) {
    var media = el.querySelector('video, img');
    var tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return { el: el, media: media, tex: tex, ready: false, last: -1, seenAt: 0,
             c: document.createElement('canvas') };
  }

  function upload(s, w, h) {
    var m = s.media;
    var isVideo = m.tagName === 'VIDEO';
    var mw = isVideo ? m.videoWidth : m.naturalWidth;
    var mh = isVideo ? m.videoHeight : m.naturalHeight;
    if (!mw || !mh) return;
    if (isVideo) {
      if (m.readyState < 2 || m.currentTime === s.last) return;
      s.last = m.currentTime;
    } else if (s.ready) {
      return;   // images upload once
    }
    // texture at ~display resolution (with the edge bulge), never above source
    var th = Math.min(mh, Math.round(h * dpr / Math.cos(thMax)));
    var tw = Math.max(1, Math.round(th * w / h));
    if (s.c.width !== tw || s.c.height !== th) { s.c.width = tw; s.c.height = th; }
    var cx = s.c.getContext('2d');
    // object-fit: cover crop
    var sr = mw / mh, dr = tw / th, sx = 0, sy = 0, sw = mw, sh = mh;
    if (sr > dr) { sw = mh * dr; sx = (mw - sw) / 2; } else { sh = mw / dr; sy = (mh - sh) / 2; }
    cx.drawImage(m, sx, sy, sw, sh, 0, 0, tw, th);
    gl.bindTexture(gl.TEXTURE_2D, s.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, s.c);
    s.ready = true;
  }

  // ------------------------------------------------------------- render
  var W = 0, H = 0, dpr = 1, wallR = 1, thMax = 1;
  canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;';
  carousel.style.position = 'relative';
  carousel.appendChild(canvas);
  carousel.classList.add('carousel--gl');

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, CURVE.maxDpr);
    W = carousel.clientWidth;
    H = carousel.clientHeight;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.uniform2f(U.uView, W, H);
    // wall radius such that the screen edge sits at the chosen angle
    var deg = W < 640 ? CURVE.angleSmall : CURVE.angle;
    thMax = deg * Math.PI / 180;
    wallR = (W / 2) / Math.tan(thMax);
    gl.uniform1f(U.uR, wallR);
    gl.uniform1f(U.uMax, thMax);
    slots.forEach(function (s) { s.ready = false; s.last = -1; s.seenAt = 0; });
  }

  function render(offset, centers, widths, itemH, padTop, radius) {
    var kids = track.children;
    if (slots.length !== kids.length) {
      slots = [];
      for (var k = 0; k < kids.length; k++) slots.push(slotFor(kids[k]));
    }
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.uniform1f(U.uRadius, radius);
    gl.activeTexture(gl.TEXTURE0);
    for (var i = 0; i < slots.length; i++) {
      var w = widths[i], x = centers[i] + offset - w / 2;
      // visible wall: |s| <= R * maxAngle around the centre
      var span = wallR * thMax, cx = W / 2;
      if (x > cx + span || x + w < cx - span) continue;
      var s = slots[i];
      upload(s, w, itemH);
      // Watchdog: some browsers (Firefox, notably on Android) never decode
      // frames for a video whose element is invisible. If an on-screen video
      // hasn't produced a frame in time, hand back to the DOM carousel.
      if (!s.ready && s.media && s.media.tagName === 'VIDEO') {
        var now = performance.now();
        if (!s.seenAt) s.seenAt = now;
        else if (now - s.seenAt > 2500) { fail(); return; }
      }
      gl.bindTexture(gl.TEXTURE_2D, s.tex);
      gl.uniform1f(U.uReady, s.ready ? 1 : 0);
      gl.uniform4f(U.uRect, x, padTop, w, itemH);
      gl.uniform2f(U.uSize, w, itemH);
      gl.drawArrays(gl.TRIANGLES, 0, VERTS);
    }
  }

  // Give the carousel back to the DOM/CSS version for good.
  var failed = false;
  function fail() {
    if (failed) return;
    failed = true;
    carousel.classList.remove('carousel--gl');
    canvas.remove();
    if (opts && opts.onLost) opts.onLost();
  }

  // the GPU can drop the context (driver reset, too many tabs): fall back
  canvas.addEventListener('webglcontextlost', function (e) {
    e.preventDefault();
    fail();
  });

  resize();
  return { render: render, resize: resize };
};
