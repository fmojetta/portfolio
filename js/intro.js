// Opening animation (~1.5s), played when the page loads at the top:
//   1. the carousel starts centred on screen, zoomed in, spinning fast, with
//      motion blur and its wall bent into a tight tunnel;
//   2. it zooms out and glides down into its real place while the spin
//      decelerates to normal speed and the curve relaxes;
//   3. the hero text rises in, then the particles form (js/hero.js waits for
//      the "introdone" event).
// The <head> adds the "intro" class only when motion is allowed and the page
// is at the top; without that class this script does nothing.
(function () {
  'use strict';

  var root = document.documentElement;
  if (!root.classList.contains('intro')) return;

  // reloaded mid-page: skip straight to the normal page
  if (window.scrollY > 10) { finish(); return; }

  var showcase = document.querySelector('.showcase');
  var hero = document.querySelector('.hero');
  if (!showcase || !hero) { finish(); return; }

  var T = {
    hold: 400,          // ms spinning fast, fully zoomed, before it moves
    move: 1800,         // ms: zoom-out + glide + slow-down
    reveal: 0.55,       // fraction of `move` at which the hero starts appearing
    zoom: 2.3,          // starting scale
    spin: 20,           // starting speed multiplier
    curve: 1.5,        // starting curve multiplier (tunnel)
    blur: 0,            // starting motion blur (px)
  };

  // where the carousel has to move to sit in the middle of the screen
  var r = showcase.getBoundingClientRect();
  var dy = window.innerHeight / 2 - (r.top + r.height / 2);

  // sweep: gentle start, fast middle, long soft landing
  function inOutQuart(t) { return t < 0.5 ? 8 * t * t * t * t : 1 - Math.pow(-2 * t + 2, 4) / 2; }
  function outExpo(t) { return t >= 1 ? 1 : 1 - Math.pow(2, -10 * t); }

  // p: progress of the move (0 = still zoomed in, 1 = in place)
  function apply(p) {
    var e = inOutQuart(p);
    var scale = T.zoom + (1 - T.zoom) * e;
    showcase.style.transform = 'translate3d(0,' + (dy * (1 - e)).toFixed(1) + 'px,0) scale(' + scale.toFixed(4) + ')';
    showcase.style.filter = p < 1 ? 'blur(' + (T.blur * (1 - outExpo(p))).toFixed(2) + 'px)' : '';
    window.introSpeed = 1 + (T.spin - 1) * (1 - outExpo(p));
    window.introCurve = 1 + (T.curve - 1) * (1 - e);
  }

  apply(0);
  root.classList.add('intro-ready');   // carousel is positioned: show it

  var t0 = 0, revealed = false;
  function frame(now) {
    if (!t0) t0 = now;
    var p = Math.min(Math.max((now - t0 - T.hold) / T.move, 0), 1);
    apply(p);
    if (!revealed && p >= T.reveal) {
      revealed = true;
      root.classList.add('intro-reveal');           // hero text rises in (CSS)
    }
    if (p < 1) requestAnimationFrame(frame);
    else finish();
  }
  // wait one frame so the starting state is painted before moving
  requestAnimationFrame(function () { requestAnimationFrame(frame); });

  function finish() {
    if (showcase) { showcase.style.transform = ''; showcase.style.filter = ''; }
    window.introSpeed = 1;
    window.introCurve = 1;
    root.classList.add('intro-reveal');
    root.classList.remove('intro', 'intro-ready');
    document.dispatchEvent(new Event('introdone'));
    // drop the reveal class once its transitions are done
    setTimeout(function () { root.classList.remove('intro-reveal'); }, 1200);
  }
})();
