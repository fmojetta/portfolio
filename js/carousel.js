// ------------------------------------------------------- infinite carousel
(function () {
  'use strict';

  var carousel = document.getElementById('carousel');
  var track = document.getElementById('carouselTrack');
  var showcase = carousel.parentNode;

  // Aspect ratios drive the width; every item keeps the same height.
  var MEDIA = [
    { type: 'video', src: 'media/video1.mp4', ratio: 3 / 2 },
    { type: 'video', src: 'media/video3.mp4',  ratio: 1 },
    { type: 'video', src: 'media/video2.mp4', ratio: 3 / 2 },
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
  var videoObserver = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) {
      var v = e.target;
      if (e.isIntersecting) {
        var p = v.play();
        if (p && p.catch) p.catch(function () {});
      } else {
        v.pause();
      }
    });
  }, { rootMargin: '200px 0px' });

  function buildItem(media, h) {
    var el = document.createElement('div');
    el.className = 'carousel__item';
    el.style.width = (h * media.ratio) + 'px';

    if (media.type === 'video') {
      var v = document.createElement('video');
      // no autoplay: videos download and play only while near the viewport
      v.src = media.src;
      v.preload = 'none';
      v.loop = true; v.muted = true;
      v.setAttribute('playsinline', '');
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
  var centers = [], viewW = 0;

  function measure() {
    var gap = parseFloat(getComputedStyle(track).gap) || 0;
    var h = itemHeight();
    setWidth = MEDIA.reduce(function (sum, m) { return sum + h * m.ratio + gap; }, 0);
    centers = [];
    var x = 0;
    for (var pass = 0; pass < 2; pass++) {
      for (var i = 0; i < MEDIA.length; i++) {
        var w = h * MEDIA[i].ratio;
        centers.push(x + w / 2);
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
  var SPHERE = {
    angle: 42,        // max rotateY (deg) at the screen edges
    depth: 140,       // how far edge items come toward the viewer (px)
    stretch: 0.22,    // extra height at the edges (barrel bulge)
    squash: 0.06,     // slight horizontal squeeze at the edges
    perspective: 900, // px
  };

  function sphere() {
    if (!viewW) return;
    var half = viewW / 2;
    var mobile = viewW < 640;
    var A = mobile ? SPHERE.angle * 0.7 : SPHERE.angle;
    var D = mobile ? SPHERE.depth * 0.6 : SPHERE.depth;
    var kids = track.children;
    for (var i = 0; i < kids.length; i++) {
      var u = (centers[i] + offset - half) / half;      // -1 left edge, +1 right edge
      if (u < -1.6 || u > 1.6) continue;                 // off screen: leave as is
      var a = Math.max(-1.4, Math.min(1.4, u));
      var e = a * a;                                     // 0 centre -> 1 edges
      kids[i].style.transform =
        'perspective(' + SPHERE.perspective + 'px)' +
        ' translateZ(' + (e * D).toFixed(1) + 'px)' +
        ' rotateY(' + (-a * A).toFixed(2) + 'deg)' +
        ' scale(' + (1 - e * SPHERE.squash).toFixed(3) + ',' + (1 + e * SPHERE.stretch).toFixed(3) + ')';
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
    sphere();
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
    }, 150);
  });

  build();
})();
