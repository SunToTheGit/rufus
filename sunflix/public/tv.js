'use strict';
/* The "TV" tag on the wordmark changes paint colour each time it is clicked, and remembers the
   last one on this device. The tag is a mask (tv.svg) over a two-colour gradient, so only the
   two custom properties below need to change. */
(() => {
  const PAINTS = [
    ['#ff7a3c', '#ff3d2e'], // red-orange (the default)
    ['#4fd0ff', '#2b6bff'], // blue
    ['#8dff6a', '#12c46b'], // green
    ['#ff8ad6', '#ff2e8a'], // pink
    ['#c79bff', '#7a3cff'], // purple
    ['#5ff5e0', '#0fb3c9'], // aqua
    ['#ffe45c', '#ffa51f'], // gold
    ['#e2ff4a', '#86e01a'], // lime
    ['#ff6b6b', '#c81e5a'], // crimson
    ['#f7f1e6', '#bdb4a2'], // chalk white
  ];
  const KEY = 'sunflix-tv-paint';
  let at = 0;
  try { at = Number(localStorage.getItem(KEY)) || 0; } catch { /* private mode */ }
  const paint = () => {
    const [a, b] = PAINTS[at % PAINTS.length];
    document.documentElement.style.setProperty('--tv-a', a);
    document.documentElement.style.setProperty('--tv-b', b);
  };
  paint();
  // Delegated, because the sign-in screen builds its own copy of the logo later.
  document.addEventListener('click', (e) => {
    const tag = e.target.closest && e.target.closest('.logo-tv');
    if (!tag) return;
    e.preventDefault(); // the tag sits inside the home link; a click on it only repaints
    e.stopPropagation();
    at = (at + 1) % PAINTS.length;
    try { localStorage.setItem(KEY, String(at)); } catch { /* private mode */ }
    paint();
    tag.classList.remove('pop');
    void tag.offsetWidth; // restart the animation
    tag.classList.add('pop');
  }, true);
})();
