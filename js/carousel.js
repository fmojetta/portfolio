// ------------------------------------------------------- infinite carousel
(function () {
  'use strict';

  var carousel = document.getElementById('carousel');
  var track = document.getElementById('carouselTrack');
  var showcase = carousel.parentNode;

  // Aspect ratios drive the width; every item keeps the same height.
  var MEDIA = [
    { type: 'video', src: 'media/video1.mp4', poster: 'media/video1-poster.jpg', ratio: 3 / 2 },
    { type: 'video', src: 'media/video3.mp4', poster: 'media/video3-poster.jpg', ratio: 1 },
    { type: 'video', src: 'media/video2.mp4', poster: 'media/video2-poster.jpg', ratio: 3 / 2 },
    { type: 'image', src: 'media/image1-700.jpg',  ratio: 1 },
    /*{ type: 'image', src: 'https://picsum.photos/id/1057/1200/800', ratio: 3 / 2 },
    { type: 'image', src: 'https://picsum.photos/id/1069/900/1200', ratio: 3 / 4 },
    { type: 'image', src: 'https://picsum.photos/id/1074/1600/900', ratio: 16 / 9 },
    { type: 'image', src: 'https://picsum.photos/id/1080/800/800',  ratio: 1 }*/
  ];

  function itemHeight() {
    return parseFloat(getComputedStyle(showcase).getPropertyValue('--item-height'));
  }

  // Play each video only while it is (nearly) on screen; pause it otherwise.
  var visibleVideos = [];
  function tryPlay(v) {
    var p = v.play();
    if (p && p.catch) p.catch(function () {});   // blocked: retried on first touch
  }
  var videoObserver = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) {
      var v = e.target, i = visibleVideos.indexOf(v);
      if (e.isIntersecting) {
        if (i < 0) visibleVideos.push(v);
        tryPlay(v);
      } else {
        if (i >= 0) visibleVideos.splice(i, 1);
        v.pause();
      }
    });
  }, { rootMargin: '200px 0px' });

  // Some mobile browsers (iOS Low Power Mode, data saver) refuse to start
  // videos until the visitor interacts with the page: retry on the first touch
  // or scroll anywhere, not only on the carousel.
  function unlock() {
    visibleVideos.forEach(tryPlay);
    ['touchstart', 'pointerdown', 'scroll', 'keydown'].forEach(function (t) {
      window.removeEventListener(t, unlock, true);
    });
  }
  ['touchstart', 'pointerdown', 'scroll', 'keydown'].forEach(function (t) {
    window.addEventListener(t, unlock, { capture: true, passive: true });
  });

  function buildItem(media, h) {
    var el = document.createElement('div');
    el.className = 'carousel__item';
    el.style.width = (h * media.ratio) + 'px';

    if (media.type === 'video') {
      var v = document.createElement('video');
      // no autoplay: videos download and play only while near the viewport
      v.src = media.src;
      if (media.poster) v.poster = media.poster;   // shown until it plays
      v.preload = 'none';
      v.loop = true;
      // iOS checks the muted *attribute* when deciding whether a script may
      // start a video without a tap; the property alone isn't enough
      v.muted = true; v.defaultMuted = true;
      v.setAttribute('muted', '');
      v.setAttribute('playsinline', '');
      v.setAttribute('webkit-playsinline', '');
      v.setAttribute('aria-hidden', 'true');
      videoObserver.observe(v);
      el.appendChild(v);
    } else {
      var img = document.createElement('img');
      img.src = media.src;
      img.alt = '';
      img.loading = 'lazy';
      img.decoding = 'async';
      img.draggable = false;
      el.appendChild(img);
    }
    return el;
  }

  // Two copies of the set: translate by one set-width and wrap seamlessly.
  var setWidth = 0;

  // item centres inside the track (both copies) + the visible width, cached
  // so the sphere effect never reads layout during animation
  var centers = [], widths = [], viewW = 0, itemH = 0;

  function measure() {
    var gap = parseFloat(getComputedStyle(track).gap) || 0;
    var h = itemHeight();
    setWidth = MEDIA.reduce(function (sum, m) { return sum + h * m.ratio + gap; }, 0);
    itemH = h;
    centers = [];
    var x = 0;
    for (var pass = 0; pass < 2; pass++) {
      for (var i = 0; i < MEDIA.length; i++) {
        var w = h * MEDIA[i].ratio;
        centers.push(x + w / 2);
        widths.push(w);
        x += w + gap;
      }
    }
    viewW = carousel.clientWidth;
  }

  // ------------------------------------------------------- inside a sphere
  // Each item is placed on the inner wall of a sphere around the viewer: the
  // centre of the strip is farthest away, and towards the screen edges the
  // wall curves in -- items swing to face you, come closer and stretch
  // (barrel distortion), then dissolve into the edge mask.
  // CSS version of the curved wall (phones/tablets, or when WebGL isn't
  // available): each card is placed on the inside of a cylinder around the
  // viewer with real 3D perspective -- the same geometry the WebGL renderer
  // uses. The viewer sits at the cylinder's centre (perspective = radius), so
  // a card at angle th is drawn at x = R*tan(th): flat in the middle,
  // swinging in and growing towards the edges.
  var SPHERE = {
    angle: 44,        // how far round the wall you see at the screen edge (deg)
    angleSmall: 32,   // phones: cards are wide relative to the screen, so the
                      // wall must be wider (smaller angle) to keep them in frame
  };
  var wallR = 0, thMax = 0;

  function sphereSetup() {
    if (!viewW) return;
    var deg = viewW < 640 ? SPHERE.angleSmall : SPHERE.angle;
    thMax = deg * Math.PI / 180;
    wallR = (viewW / 2) / Math.tan(thMax);
    carousel.style.perspective = wallR.toFixed(1) + 'px';
    carousel.style.perspectiveOrigin = '50% 50%';
    track.style.transformStyle = 'preserve-3d';
  }

  function sphere() {
    if (!viewW) return;
    if (!wallR) sphereSetup();
    var half = viewW / 2, R = wallR, lim = Math.min(1.45, thMax * 1.6);
    var kids = track.children;
    for (var i = 0; i < kids.length; i++) {
      var sx = centers[i] + offset - half;               // distance along the wall
      var th = sx / R;
      if (th < -lim - 0.6 || th > lim + 0.6) continue;   // well off screen
      th = Math.max(-lim, Math.min(lim, th));
      kids[i].style.transform =
        'translate3d(' + (R * Math.sin(th) - sx).toFixed(1) + 'px,0,' +
        (R * (1 - Math.cos(th))).toFixed(1) + 'px)' +
        ' rotateY(' + (-th).toFixed(4) + 'rad)';
    }
  }


  function build() {
    var h = itemHeight();
    var frag = document.createDocumentFragment();
    for (var pass = 0; pass < 2; pass++) {
      for (var i = 0; i < MEDIA.length; i++) frag.appendChild(buildItem(MEDIA[i], h));
    }
    track.innerHTML = '';
    track.appendChild(frag);
    measure();
  }

  // ------------------------------------------------------------- motion
  var BASE_SPEED  = 70;   // px/s, normal
  var HOVER_SPEED = 25;   // px/s, while hovered
  var EASE        = 6;    // how fast the speed eases toward its target
  var FRICTION    = 4;    // how fast throw momentum decays

  var offset = 0;         // current translateX (negative = moved forward)
  var speed = BASE_SPEED;
  var hovering = false;

  var dragging = false;
  var pointerId = null;
  var dragStartX = 0, dragStartOffset = 0;
  var lastMoveX = 0, lastMoveT = 0;
  var throwVel = 0;       // px/s carried over after release

  function wrap() {
    if (setWidth <= 0) return;
    while (offset <= -setWidth) offset += setWidth;
    while (offset > 0) offset -= setWidth;
  }

  var lastT = performance.now();
  function tick(now) {
    var dt = Math.min((now - lastT) / 1000, 0.05);  // clamp after tab switches
    lastT = now;

    if (!dragging) {
      var target = hovering ? HOVER_SPEED : BASE_SPEED;
      speed += (target - speed) * Math.min(1, EASE * dt);

      // leftover throw momentum bleeds off, then plain auto-scroll takes over
      if (Math.abs(throwVel) > 1) {
        offset += throwVel * dt;
        throwVel -= throwVel * Math.min(1, FRICTION * dt);
      } else {
        throwVel = 0;
      }
      offset -= speed * dt;
      wrap();
    }

    track.style.transform = 'translate3d(' + offset + 'px,0,0)';
    if (curve) {
      curve.render(offset, centers, widths, itemH, padTop, radius);
    } else {
      sphere();
    }
    rafId = running ? requestAnimationFrame(tick) : 0;
  }

  // Stop the loop while the carousel is off screen; resume where it left off.
  var running = false, rafId = 0;
  function startLoop() {
    if (running) return;
    running = true;
    lastT = performance.now();
    rafId = requestAnimationFrame(tick);
  }
  function stopLoop() {
    running = false;
    cancelAnimationFrame(rafId);
  }
  new IntersectionObserver(function (entries) {
    entries[0].isIntersecting ? startLoop() : stopLoop();
  }, { rootMargin: '100px 0px' }).observe(carousel);

  // -------------------------------------------------------------- hover
  carousel.addEventListener('pointerenter', function (e) {
    if (e.pointerType === 'mouse') hovering = true;
  });
  carousel.addEventListener('pointerleave', function (e) {
    if (e.pointerType === 'mouse') hovering = false;
  });

  // --------------------------------------------------------------- drag
  carousel.addEventListener('pointerdown', function (e) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    dragging = true;
    pointerId = e.pointerId;
    carousel.setPointerCapture(pointerId);
    carousel.classList.add('is-dragging');

    dragStartX = lastMoveX = e.clientX;
    dragStartOffset = offset;
    lastMoveT = performance.now();
    throwVel = 0;
  });

  carousel.addEventListener('pointermove', function (e) {
    if (!dragging || e.pointerId !== pointerId) return;
    e.preventDefault();

    offset = dragStartOffset + (e.clientX - dragStartX);
    wrap();

    var now = performance.now();
    var dt = (now - lastMoveT) / 1000;
    if (dt > 0.001) {
      throwVel = (e.clientX - lastMoveX) / dt;
      lastMoveX = e.clientX;
      lastMoveT = now;
    }
  });

  function endDrag(e) {
    if (!dragging || (e && e.pointerId !== pointerId)) return;
    dragging = false;
    carousel.classList.remove('is-dragging');
    if (pointerId !== null && carousel.hasPointerCapture(pointerId)) {
      carousel.releasePointerCapture(pointerId);
    }
    pointerId = null;

    // stale flick (finger paused before release) shouldn't fling
    if (performance.now() - lastMoveT > 120) throwVel = 0;
    throwVel = Math.max(-2500, Math.min(2500, throwVel));
  }

  carousel.addEventListener('pointerup', endDrag);
  carousel.addEventListener('pointercancel', endDrag);

  // item widths derive from the CSS height variable, so they follow the breakpoint
  var carouselResizeTimer;
  window.addEventListener('resize', function () {
    clearTimeout(carouselResizeTimer);
    carouselResizeTimer = setTimeout(function () {
      var h = itemHeight();
      var kids = track.children;
      for (var i = 0; i < kids.length; i++) {
        kids[i].style.width = (h * MEDIA[i % MEDIA.length].ratio) + 'px';
      }
      measure();
      wrap();
      sphereSetup();
      if (curve) { readBox(); curve.resize(); }
    }, 150);
  });

  build();

  // Curved-wall WebGL renderer (js/carousel-curve.js). Without WebGL, or if
  // the GPU drops the context, the CSS sphere above stays in charge.
  var curve = null, padTop = 0, radius = 0;
  function readBox() {
    var cs = getComputedStyle(carousel);
    padTop = parseFloat(cs.paddingTop) || 0;
    radius = parseFloat(getComputedStyle(showcase).getPropertyValue('--radius')) || 0;
  }
  // WebGL curve on desktop only. Phones and tablets get the CSS sphere with the
  // real <video> elements visible: mobile Safari won't autoplay videos it
  // considers hidden, and Firefox on Android hands WebGL black video frames.
  var desktop = window.matchMedia('(hover: hover) and (pointer: fine)').matches;
  if (desktop && window.createCarouselCurve) {
    try {
      curve = window.createCarouselCurve(carousel, track, {
        onLost: function () {
          curve = null;
          // the DOM items are visible again: make sure their videos run
          var vids = track.querySelectorAll('video');
          for (var i = 0; i < vids.length; i++) {
            var p = vids[i].play();
            if (p && p.catch) p.catch(function () {});
          }
        }
      });
    } catch (e) { curve = null; }
    if (curve) readBox();
  }
})();
