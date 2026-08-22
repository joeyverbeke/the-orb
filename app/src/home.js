import { orb } from './orb/link.js';

// Auto-discovery: every experiments/<name>/meta.js becomes a card. Vite
// resolves this glob at build time, so there is no registry to keep in sync
// with the filesystem.
const metas = import.meta.glob('../experiments/*/meta.js', { eager: true });

const entries = Object.entries(metas).map(([path, mod]) => {
  const slug = path.split('/').at(-2);
  const meta = mod.default ?? mod;
  return {
    slug,
    href: `/experiments/${slug}/`,
    title: meta.title ?? slug,
    blurb: meta.blurb ?? '',
    kind: meta.kind ?? 'experiment',
    order: meta.order ?? 100,
  };
}).sort((a, b) => a.order - b.order || a.title.localeCompare(b.title));

const GROUPS = [
  ['experiment', 'Experiments'],
  ['tool', 'Tools'],
];

const sections = document.getElementById('sections');

for (const [kind, label] of GROUPS) {
  const group = entries.filter(e => e.kind === kind);
  if (!group.length) continue;

  const h = document.createElement('h2');
  h.textContent = label;
  sections.appendChild(h);

  const grid = document.createElement('div');
  grid.className = 'grid';
  for (const e of group) {
    const a = document.createElement('a');
    a.className = `card ${e.kind}`;
    a.href = e.href;
    a.innerHTML = `<h3></h3><p></p><span class="tag"></span>`;
    a.querySelector('h3').textContent = e.title;
    a.querySelector('p').textContent = e.blurb;
    a.querySelector('.tag').textContent = e.kind;
    grid.appendChild(a);
  }
  sections.appendChild(grid);
}

if (!entries.length) {
  sections.innerHTML = '<p class="empty">No experiments yet.</p>';
}

// The index shows link state too, so a dead bridge is obvious before you open
// anything and find an inert page.
const linkEl = document.getElementById('link');
const linkVal = linkEl.querySelector('b');
orb.onStatus(({ connected, device }) => {
  linkVal.textContent = !connected ? 'down — is bridge.py running?'
    : !device ? 'no orb — plug it in'
    : 'up';
  linkEl.classList.toggle('bad', !connected || !device);
});
orb.connect();
