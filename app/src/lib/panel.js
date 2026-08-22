import { Color } from 'three/webgpu';
import { float, uniform } from 'three/tsl';

// A tuning panel any experiment can mount. Space opens and closes it.
//
// Sliders hand back TSL uniforms, so a value can be wired straight into a
// shader *and* read from CPU code as `.value` -- no per-frame plumbing to keep
// in sync, and no chance of the panel and the shader disagreeing.
//
// Values persist per experiment, because tuning happens across reloads. "Copy"
// puts them on the clipboard in a form that can be pasted back into the source
// once a setting has won.

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

export function createPanel({ title = 'Tuning', storageKey, inheritFrom } = {}) {
  const store = storageKey ? `panel:${storageKey}` : null;

  const read = (k) => {
    try { return JSON.parse(localStorage.getItem(k) || '{}'); } catch { return {}; }
  };

  // An experiment forked from another starts where that one was left, rather
  // than at the code defaults -- otherwise every fork begins by re-tuning
  // settings that were already decided. Only until it has been touched itself;
  // after that it keeps its own.
  let saved = store ? read(store) : {};
  if (inheritFrom && !Object.keys(saved).length) saved = read(`panel:${inheritFrom}`);

  const entries = [];     // { key, def, read(), apply(v) }
  const readouts = [];    // { el, fn }

  const root = document.createElement('aside');
  root.className = 'panel';
  root.innerHTML = `
    <div class="phead"><b></b><span>space to close</span></div>
    <div class="body"></div>`;
  root.querySelector('b').textContent = title;
  const body = root.querySelector('.body');
  document.body.appendChild(root);

  const hint = document.createElement('div');
  hint.className = 'panel-hint';
  hint.textContent = 'space — tuning';
  document.body.appendChild(hint);

  const persist = () => {
    if (!store) return;
    const out = {};
    for (const e of entries) out[e.key] = e.read();
    localStorage.setItem(store, JSON.stringify(out));
  };

  const api = {
    group(name) {
      const h = document.createElement('h2');
      h.textContent = name;
      body.appendChild(h);
      return api;
    },

    /** Returns a TSL uniform. Read or write `.value` from anywhere. */
    slider(label, { value, min, max, step = 0.001, note } = {}) {
      const key = slug(label);
      const start = typeof saved[key] === 'number' ? saved[key] : value;
      const node = uniform(float(start));

      const el = document.createElement('div');
      el.className = 'ctl';
      el.innerHTML = `
        <div class="top"><label></label><output></output></div>
        <input type="range">
        ${note ? '<p class="hintline"></p>' : ''}`;
      el.querySelector('label').textContent = label;
      if (note) el.querySelector('.hintline').textContent = note;

      const input = el.querySelector('input');
      const out = el.querySelector('output');
      Object.assign(input, { min, max, step, value: start });

      const decimals = step < 0.01 ? 3 : step < 1 ? 2 : 0;
      const show = (v) => { out.textContent = Number(v).toFixed(decimals); };
      show(start);

      input.addEventListener('input', () => {
        node.value = parseFloat(input.value);
        show(node.value);
        persist();
      });

      body.appendChild(el);
      entries.push({
        key, def: value,
        read: () => node.value,
        apply: (v) => { node.value = v; input.value = v; show(v); },
      });
      return node;
    },

    /** Returns a plain holder with a boolean `.value`. */
    toggle(label, value = false, { note } = {}) {
      const key = slug(label);
      const start = typeof saved[key] === 'boolean' ? saved[key] : value;
      const node = { value: start };

      const el = document.createElement('div');
      el.className = 'ctl';
      el.innerHTML = `<div class="row2"><button></button></div>
        ${note ? '<p class="hintline"></p>' : ''}`;
      if (note) el.querySelector('.hintline').textContent = note;

      const btn = el.querySelector('button');
      const paint = () => {
        btn.textContent = `${label}: ${node.value ? 'on' : 'off'}`;
        btn.classList.toggle('on', node.value);
      };
      paint();
      btn.addEventListener('click', () => { node.value = !node.value; paint(); persist(); });

      body.appendChild(el);
      entries.push({
        key, def: value,
        read: () => node.value,
        apply: (v) => { node.value = v; paint(); },
      });
      return node;
    },

    /**
     * Returns a TSL uniform holding a THREE.Color. The picker works in sRGB
     * and three converts to the working space, so what is picked is what is
     * seen.
     */
    color(label, hex, { note } = {}) {
      const key = slug(label);
      const start = typeof saved[key] === 'string' ? saved[key] : hex;
      const node = uniform(new Color(start));

      const el = document.createElement('div');
      el.className = 'ctl';
      el.innerHTML = `
        <div class="top"><label></label><input type="color"></div>
        ${note ? '<p class="hintline"></p>' : ''}`;
      el.querySelector('label').textContent = label;
      if (note) el.querySelector('.hintline').textContent = note;

      const input = el.querySelector('input');
      input.value = start;
      input.addEventListener('input', () => {
        node.value.set(input.value);
        persist();
      });

      body.appendChild(el);
      entries.push({
        key, def: hex,
        read: () => input.value,
        apply: (v) => { input.value = v; node.value.set(v); },
      });
      return node;
    },

    /** A live number, refreshed by tick(). */
    readout(label, fn) {
      const el = document.createElement('div');
      el.className = 'live';
      el.innerHTML = '<span></span><b>–</b>';
      el.querySelector('span').textContent = label;
      body.appendChild(el);
      readouts.push({ el: el.querySelector('b'), fn });
      return api;
    },

    actions() {
      const row = document.createElement('div');
      row.className = 'row2';
      row.style.marginTop = '18px';

      const copy = document.createElement('button');
      copy.textContent = 'copy settings';
      copy.addEventListener('click', async () => {
        const out = {};
        for (const e of entries) out[e.key] = e.read();
        const text = JSON.stringify(out, null, 2);
        try {
          await navigator.clipboard.writeText(text);
          copy.textContent = 'copied';
        } catch {
          console.log(text);
          copy.textContent = 'logged to console';
        }
        setTimeout(() => { copy.textContent = 'copy settings'; }, 1400);
      });

      const reset = document.createElement('button');
      reset.textContent = 'reset';
      reset.addEventListener('click', () => {
        for (const e of entries) e.apply(e.def);
        persist();
      });

      row.append(copy, reset);
      body.appendChild(row);
      return api;
    },

    tick() {
      if (!open) return;                      // nothing to refresh while hidden
      const now = performance.now();
      if (now - lastTick < 100) return;
      lastTick = now;
      for (const r of readouts) r.el.textContent = r.fn();
    },

    get open() { return open; },
    show() { setOpen(true); },
    hide() { setOpen(false); },
  };

  let open = false;
  let lastTick = 0;

  function setOpen(v) {
    open = v;
    root.classList.toggle('open', open);
    hint.style.display = open ? 'none' : '';
  }

  addEventListener('keydown', (e) => {
    // Accept either: some automation and remapped layouts deliver one without
    // the other.
    if (e.code !== 'Space' && e.key !== ' ') return;
    const t = e.target;
    // Typing a space in a text field must not toggle the panel. Range inputs
    // are deliberately not exempt: after dragging a slider the range keeps
    // focus, and space would otherwise stop working until you clicked away.
    const typing = t && (t.tagName === 'TEXTAREA' || t.isContentEditable ||
      (t.tagName === 'INPUT' && t.type !== 'range'));
    if (typing) return;
    e.preventDefault();                        // otherwise space scrolls the page
    setOpen(!open);
  });

  return api;
}
