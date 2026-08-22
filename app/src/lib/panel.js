import { Color } from 'three/webgpu';
import { float, uniform } from 'three/tsl';

// A tuning panel any experiment can mount. Space opens and closes it.
//
// Sliders hand back TSL uniforms, so a value can be wired straight into a
// shader *and* read from CPU code as `.value` -- no per-frame plumbing to keep
// in sync, and no chance of the panel and the shader disagreeing.
//
// Persistence rules, learned the hard way:
//
//   * A control's storage key defaults to a slug of its label, so **renaming a
//     label loses the tuning**. Pass an explicit `key` to make a control's
//     identity independent of what it is called, and `from` to adopt the value
//     of a key it used to have.
//   * Saving merges into whatever is already stored rather than replacing it,
//     so values belonging to controls that are not mounted right now -- renamed,
//     removed while experimenting, or living on a different branch of the code
//     -- survive instead of being quietly dropped.

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
    // Merge, never replace: see the note at the top of this file.
    const out = read(store);
    for (const e of entries) out[e.key] = e.read();
    try {
      localStorage.setItem(store, JSON.stringify(out));
    } catch (err) {
      console.warn('tuning could not be saved', err);
    }
  };

  // Value to start a control at: its own key, then any key it was renamed
  // from, then the code default.
  const startValue = (key, from, def, ok) => {
    if (ok(saved[key])) return saved[key];
    if (from && ok(saved[from])) return saved[from];
    return def;
  };

  const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
  const isBool = (v) => typeof v === 'boolean';
  const isStr = (v) => typeof v === 'string';

  const api = {
    group(name) {
      const h = document.createElement('h2');
      h.textContent = name;
      body.appendChild(h);
      return api;
    },

    /** Returns a TSL uniform. Read or write `.value` from anywhere. */
    slider(label, { value, min, max, step = 0.001, note, key, from } = {}) {
      const id = key ?? slug(label);
      const start = startValue(id, from, value, isNum);
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
        key: id, def: value,
        read: () => node.value,
        apply: (v) => { node.value = v; input.value = v; show(v); },
      });
      return node;
    },

    /** Returns a plain holder with a boolean `.value`. */
    toggle(label, value = false, { note, key, from } = {}) {
      const id = key ?? slug(label);
      const start = startValue(id, from, value, isBool);
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
        key: id, def: value,
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
    color(label, hex, { note, key, from } = {}) {
      const id = key ?? slug(label);
      const start = startValue(id, from, hex, isStr);
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
        key: id, def: hex,
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

      const snapshot = () => {
        const out = {};
        for (const e of entries) out[e.key] = e.read();
        return JSON.stringify(out, null, 2);
      };

      const copy = document.createElement('button');
      copy.textContent = 'copy settings';
      copy.addEventListener('click', async () => {
        const text = snapshot();
        try {
          await navigator.clipboard.writeText(text);
          copy.textContent = 'copied';
        } catch {
          console.log(text);
          copy.textContent = 'logged to console';
        }
        setTimeout(() => { copy.textContent = 'copy settings'; }, 1400);
      });

      // The other half of copy: a way back from a saved blob. Without this,
      // "copy settings" is a one-way door and there is no route to undo a bad
      // session or move a tuning between machines.
      const paste = document.createElement('button');
      paste.textContent = 'paste settings';
      paste.addEventListener('click', () => {
        const text = prompt('Paste settings JSON:');
        if (!text) return;
        let data;
        try { data = JSON.parse(text); } catch { alert('That is not valid JSON.'); return; }
        let applied = 0;
        for (const e of entries) {
          if (data[e.key] !== undefined) { e.apply(data[e.key]); applied++; }
        }
        persist();
        paste.textContent = `applied ${applied}`;
        setTimeout(() => { paste.textContent = 'paste settings'; }, 1600);
      });

      // Two-step: a stray click here would otherwise wipe a whole tuning
      // session with no undo.
      const reset = document.createElement('button');
      let armed = false;
      let disarm;
      reset.textContent = 'reset';
      reset.addEventListener('click', () => {
        if (!armed) {
          armed = true;
          reset.textContent = 'reset — sure?';
          reset.classList.add('on');
          disarm = setTimeout(() => {
            armed = false; reset.textContent = 'reset'; reset.classList.remove('on');
          }, 3000);
          return;
        }
        clearTimeout(disarm);
        armed = false;
        reset.textContent = 'reset';
        reset.classList.remove('on');
        for (const e of entries) e.apply(e.def);
        persist();
      });

      row.append(copy, paste, reset);
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
