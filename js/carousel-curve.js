// ------------------------------------------- carousel: curved-wall renderer
// Draws the carousel items on a WebGL canvas and bends them like the inside
// of a sphere: the middle of the strip stays flat, and only close to the
// screen edges does the wall curve -- each image grows taller and squeezes
// narrower progressively along its width, so its top and bottom edges bow
// into real curves before it dissolves into the edge.
//
// No libraries: one tiny shader program, one subdivided quad per item.
// carousel.js keeps doing layout, the loop, drag and video playback on the
// (now invisible) DOM items; this file only paints them. If WebGL isn't
// available it returns null and carousel.js keeps its CSS fallback.
window.createCarouselCurve = function (carousel, track, opts) {
  'use strict';

  var CURVE = {
    edgeStart: 0.42,   // where the curve begins (0 = centre, 1 = screen edge)
    bulge: 0.38,       // extra height at the very edge (0.38 = +38%)
    squeeze: 0.22,     // how much items narrow as they reach the edge
    fadeStart: 0.86,   // where items start dissolving into the edge
    segments: 48,      // columns per item -> smoothness of the curve
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
    'uniform float uEdge, uBulge, uSqueeze, uFade;',
    'varying vec2 vUv;',
    'varying vec2 vLocal;',
    'varying float vAlpha;',
    'void main() {',
    '  vec2 p = uRect.xy + a * uRect.zw;',
    '  vec2 c = uView * 0.5;',
    '  float u = (p.x - c.x) / c.x;',                    // -1 left .. +1 right
    '  float t = smoothstep(uEdge, 1.0, abs(u));',       // 0 until near the edge
    '  float k = t * t;',                                // ease in: a curve, not a ramp
    '  p.y = c.y + (p.y - c.y) * (1.0 + uBulge * k);',   // taller towards the edge
    '  p.x = c.x + (p.x - c.x) * (1.0 - uSqueeze * k * abs(u));', // squeezed in
    '  float u2 = abs((p.x - c.x) / c.x);',
    '  vAlpha = 1.0 - smoothstep(uFade, 1.02, u2);',
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
    'varying vec2 vUv;',
    'varying vec2 vLocal;',
    'varying float vAlpha;',
    'void main() {',
    // rounded-rectangle mask in item space
    '  vec2 h = uSize * 0.5;',
    '  vec2 q = abs(vLocal - h) - (h - vec2(uRadius));',
    '  float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - uRadius;',
    '  float m = 1.0 - smoothstep(-0.75, 0.75, d);',
    '  vec3 col = uReady > 0.5 ? texture2D(uTex, vUv).rgb : uBlank;',
    '  float a = m * vAlpha;',
    '  gl_FragColor = vec4(col * a, a);',
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
  ['uRect', 'uView', 'uEdge', 'uBulge', 'uSqueeze', 'uFade', 'uTex', 'uReady',
   'uBlank', 'uSize', 'uRadius'].forEach(function (n) { U[n] = gl.getUniformLocation(prog, n); });

  // one subdivided strip (N columns x 1 row) shared by every item
  var N = CURVE.segments, verts = [];
  for (var i = 0; i < N; i++) {
    var x0 = i / N, x1 = (i + 1) / N;
    verts.push(x0, 0, x1, 0, x0, 1,  x0, 1, x1, 0, x1, 1);
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
  gl.uniform1f(U.uEdge, CURVE.edgeStart);
  gl.uniform1f(U.uBulge, CURVE.bulge);
  gl.uniform1f(U.uSqueeze, CURVE.squeeze);
  gl.uniform1f(U.uFade, CURVE.fadeStart);
  var blank = (getComputedStyle(document.documentElement).getPropertyValue('--paper-2').trim() || '#EFE7D8');
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
    return { el: el, media: media, tex: tex, ready: false, last: -1,
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
    var th = Math.min(mh, Math.round(h * dpr * (1 + CURVE.bulge)));
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
  var W = 0, H = 0, dpr = 1;
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
    // narrow screens: items are wide relative to the view, so a gentler curve
    var small = W < 640;
    gl.uniform1f(U.uEdge, small ? 0.55 : CURVE.edgeStart);
    gl.uniform1f(U.uBulge, small ? CURVE.bulge * 0.45 : CURVE.bulge);
    gl.uniform1f(U.uSqueeze, small ? CURVE.squeeze * 0.5 : CURVE.squeeze);
    slots.forEach(function (s) { s.ready = false; s.last = -1; });
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
      // the edge squeeze pulls items from beyond the screen into view, so
      // cull against the widened (unwarped) range
      var reach = W * (0.5 + CURVE.squeeze);
      if (x > W + reach || x + w < -reach) continue;
      var s = slots[i];
      upload(s, w, itemH);
      gl.bindTexture(gl.TEXTURE_2D, s.tex);
      gl.uniform1f(U.uReady, s.ready ? 1 : 0);
      gl.uniform4f(U.uRect, x, padTop, w, itemH);
      gl.uniform2f(U.uSize, w, itemH);
      gl.drawArrays(gl.TRIANGLES, 0, VERTS);
    }
  }

  // the GPU can drop the context (driver reset, too many tabs): fall back
  canvas.addEventListener('webglcontextlost', function (e) {
    e.preventDefault();
    carousel.classList.remove('carousel--gl');
    canvas.remove();
    if (opts && opts.onLost) opts.onLost();
  });

  resize();
  return { render: render, resize: resize };
};
