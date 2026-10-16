// Interactive parts of the hivedesk site, built with Voodoo.js
// (https://kwy404.github.io/Voodoo.js/). Voodoo is loaded with data-manual:
// this module adds a few helpers to V.config.globals, then calls V.start().
// The page declares the rest in HTML: v-data, v-model, v-copy, v-tabs,
// v-scrollspy. Nothing here talks to a server.

const V = window.V;

// Download time for a model of `gb` gigabytes on a `mbps` Mbit/s link.
function dlTime(gb, mbps) {
  const seconds = (Number(gb) * 8e9) / (Number(mbps) * 1e6);
  if (!isFinite(seconds) || seconds <= 0) return 'a few minutes';
  if (seconds < 90) return 'a minute';
  const min = Math.round(seconds / 60);
  if (min < 60) return `${min} minutes`;
  const h = Math.floor(min / 60), m = min % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

if (V) {
  Object.assign(V.config.globals, { dlTime });
  V.start();
} else {
  document.documentElement.classList.add('no-voodoo');
}

// Pause the hero loop when it is off screen, to save battery.
const desk = document.querySelector('.desk');
if (desk && 'IntersectionObserver' in window) {
  new IntersectionObserver(([e]) => desk.classList.toggle('is-paused', !e.isIntersecting)).observe(desk);
}
