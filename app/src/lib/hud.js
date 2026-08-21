import { orb } from '../orb/link.js';

// The bar every experiment carries: a way back to the index, whether the
// device link is up, and which GPU backend actually got used.
export function mountTopbar({ title, backend }) {
  const bar = document.createElement('div');
  bar.className = 'topbar';
  bar.innerHTML = `
    <a class="home" href="/">&larr; experiments</a>
    <h1></h1>
    <div class="stat" data-link>link <b>…</b></div>
    <div class="stat">backend <b data-backend>–</b></div>
    <div class="stat">fps <b data-fps>–</b></div>
    <div class="stat">orb <b data-held>–</b></div>`;
  bar.querySelector('h1').textContent = title;
  bar.querySelector('[data-backend]').textContent = backend ?? '–';
  document.body.prepend(bar);

  const linkEl = bar.querySelector('[data-link]');
  const linkVal = linkEl.querySelector('b');
  orb.onStatus(({ connected }) => {
    linkVal.textContent = connected ? 'up' : 'down — is bridge.py running?';
    linkEl.classList.toggle('bad', !connected);
  });

  const fpsEl = bar.querySelector('[data-fps]');
  const heldEl = bar.querySelector('[data-held]');
  return {
    update(stage) {
      fpsEl.textContent = stage.fps.toFixed(0);
      const f = orb.latest;
      heldEl.textContent = !f ? '–' : (f.held > 0.5 ? 'held' : 'set down');
    },
  };
}

// WebGPU can be missing entirely (older Safari, some Linux setups). Say so
// plainly rather than leaving a black canvas and no explanation.
export function mountFatal(err) {
  const box = document.createElement('div');
  box.style.cssText =
    'padding:24px;max-width:60ch;margin:40px auto;border:1px solid var(--x);' +
    'border-radius:8px;background:var(--panel)';
  box.innerHTML =
    `<h2 style="margin:0 0 10px;color:var(--x);font-size:13px">This experiment could not start</h2>
     <p style="color:var(--dim);margin:0 0 10px">
       Most often this means the browser has no WebGPU <em>and</em> no WebGL2 fallback.
       Chrome 113+, Edge 113+, or Safari 18+ should work.</p>
     <pre style="color:var(--dim);white-space:pre-wrap;margin:0;font-size:11px"></pre>`;
  box.querySelector('pre').textContent = String(err?.stack || err);
  document.body.appendChild(box);
  console.error(err);
}
