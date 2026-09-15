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
    { type: 'image', src: 'media/image1.jpg',  ratio: 1 },
    /*{ type: 'image', src: 'https://picsum.photos/id/1057/1200/800', ratio: 3 / 2 },
    { type: 'image', src: 'https://picsum.photos/id/1069/900/1200', ratio: 3 / 4 },
    { type: 'image', src: 'https://picsum.photos/id/1074/1600/900', ratio: 16 / 9 },
    { type: 'image', src: 'https://picsum.photos/id/1080/800/800',  ratio: 1 }*/
  ];

  function itemHeight() {
    return parseFloat(getComputedStyle(showcase).getPropertyValue('--item-height'));
  }

  function buildItem(media, h) {
    var el = document.createElement('div');
    el.className = 'carousel__item';
    el.style.width = (h * media.ratio) + 'px';

    if (media.type === 'video') {
      var v = document.createElement('video');
      v.src = media.src;
      v.autoplay = true; v.loop = true; v.muted = true;
      v.setAttribute('playsinline', '');
      el.appendChild(v);
    } else {
      var img = document.createElement('img');
      img.src = media.src;
      img.alt = '';
      img.draggable = false;
      el.appendChild(img);
    }
    return el;
  }

  // Two copies of the set: translate by one set-width and wrap seamlessly.
  var setWidth = 0;

  function measure() {
    var gap = parseFloat(getComputedStyle(track).gap) || 0;
    var h = itemHeight();
    setWidth = MEDIA.reduce(function (sum, m) { return sum + h * m.ratio + gap; }, 0);
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
    requestAnimationFrame(tick);
  }

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
  requestAnimationFrame(tick);
})();
