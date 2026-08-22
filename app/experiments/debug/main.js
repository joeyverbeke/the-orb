import { orb as link } from '../../src/orb/link.js';

// ---------------------------------------------------------------------------
// Modes and tunables. The orb is the source of truth for values; this table
// only describes how to present and command them.
// ---------------------------------------------------------------------------

// Two independent choices. Any quantity works with any source.
const QUANTITIES = [
  [0, "speed", "How fast it is turning right now. Instantaneous — stop and it stops."],
  [1, "wind",  "Turning accumulates and bleeds away when you stop. Rewards sustained winding."],
  [2, "dial",  "How far it sits from a reference orientation. Turn back and it drops. Position, not effort."],
];

const SOURCES = [
  [0, "1-axis",        "The selected axis alone."],
  [1, "3-axis",        "Y → strength, X → pulse rate, Z → grain. One gesture, three qualities."],
  [2, "any-direction", "Magnitude across all three — direction doesn't matter."],
];

const SLIDERS = [
  ["deadzone_dps", "deadzone",  "d", 0,  120, 0.5, "dps",  null],
  ["saturate_dps", "saturate",  "s", 5,  400, 1,   "dps",  null],
  ["gamma",        "curve",     "g", 0.2, 2.5, 0.05, "",   null],
  ["tau_ms",       "smoothing", "t", 0,  400, 5,   "ms",   null],
  ["floor_rtp",    "ERM floor", "f", 0,  126, 1,   "rtp",  null],
  ["pulse",        "pulse",     "P", 0,    1, 0.01, "",    null],
  ["grain",        "grain",     "G", 0,    1, 0.01, "",    null],
  ["wind_full_deg","wind full", "W", 90, 3600, 10, "deg",  null],
  ["wind_decay_ms","wind decay","D", 100, 8000, 50, "ms",  null],
  ["dial_full_deg","dial full", "L", 10,  360, 5,  "deg",  null],
  ["hold",         "hold level","H", 0,    1, 0.01, "",    null],
  ["presence_still_deg",  "set-down °", "n", 0.2, 8,  0.1, "°",  null],
  ["presence_putdown_ms", "set-down wait","o", 200, 4000, 100, "ms", null],
];

// Which controls the current quantity/source pair actually reads. Everything
// else greys out rather than disappearing -- a control that vanishes is harder
// to reason about than one that is visibly inert.
function relevant(key, q, src) {
  switch (key) {
    case "deadzone_dps":
    case "saturate_dps":  return q === 0;          // speed only
    case "wind_full_deg":
    case "wind_decay_ms": return q === 1;
    case "dial_full_deg": return q === 2;
    // In 3-axis these are driven by X and Z, so the sliders stop mattering.
    case "pulse":
    case "grain":         return src !== 1;
    case "presence_still_deg":
    case "presence_putdown_ms": return gate;
    default:              return true;
  }
}

const $ = id => document.getElementById(id);
const RAD2DEG = 57.2957795;

let quantity = 0, source = 2, haptics = true, dragging = null;
let holding = false, holdLevel = 0.5, gate = true;
let cfg = {};

// --- connection -------------------------------------------------------------
// The socket, reconnect and command framing all live in src/orb/link.js now,
// shared with every experiment.

const send = (cmd) => link.send(cmd);

// --- rolling buffers --------------------------------------------------------

const N = 600;                       // ~6 s at 100 Hz
const buf = { gx:[], gy:[], gz:[], out:[], strength:[] };
let latest = null;

function push(f) {
  latest = f;
  buf.gx.push(f.gx * RAD2DEG);
  buf.gy.push(f.gy * RAD2DEG);
  buf.gz.push(f.gz * RAD2DEG);
  buf.out.push(f.out);
  buf.strength.push(f.strength);
  for (const k in buf) if (buf[k].length > N) buf[k].shift();
}

// --- drawing ----------------------------------------------------------------

function fit(cv) {
  const dpr = devicePixelRatio || 1;
  const w = cv.clientWidth, h = cv.clientHeight;
  if (cv.width !== w*dpr || cv.height !== h*dpr) {
    cv.width = w*dpr; cv.height = h*dpr;
  }
  const g = cv.getContext("2d");
  g.setTransform(dpr,0,0,dpr,0,0);
  g.clearRect(0,0,w,h);
  return [g,w,h];
}

function line(g, data, w, h, lo, hi, color, width) {
  if (data.length < 2) return;
  g.strokeStyle = color; g.lineWidth = width || 1.25;
  g.beginPath();
  for (let i = 0; i < data.length; i++) {
    const x = (i / (N-1)) * w;
    const y = h - ((data[i]-lo)/(hi-lo)) * h;
    i ? g.lineTo(x,y) : g.moveTo(x,y);
  }
  g.stroke();
}

function hline(g, w, h, v, lo, hi, color, dash) {
  if (v < lo || v > hi) return;
  const y = h - ((v-lo)/(hi-lo))*h;
  g.strokeStyle = color; g.lineWidth = 1; g.setLineDash(dash||[]);
  g.beginPath(); g.moveTo(0,y); g.lineTo(w,y); g.stroke();
  g.setLineDash([]);
}

// --- the orb ----------------------------------------------------------------

// Quaternion -> rotation matrix, columns being where the body axes point.
function quatMatrix(w,x,y,z) {
  const n = Math.hypot(w,x,y,z) || 1;
  w/=n; x/=n; y/=n; z/=n;
  return [
    [1-2*(y*y+z*z),   2*(x*y-z*w),   2*(x*z+y*w)],
    [  2*(x*y+z*w), 1-2*(x*x+z*z),   2*(y*z-x*w)],
    [  2*(x*z-y*w),   2*(y*z+x*w), 1-2*(x*x+y*y)],
  ];
}

const apply = (m,v) => [
  m[0][0]*v[0]+m[0][1]*v[1]+m[0][2]*v[2],
  m[1][0]*v[0]+m[1][1]*v[1]+m[1][2]*v[2],
  m[2][0]*v[0]+m[2][1]*v[1]+m[2][2]*v[2],
];

const matMul = (a,b) => a.map(r => [0,1,2].map(j =>
  r[0]*b[0][j] + r[1]*b[1][j] + r[2]*b[2][j]));
const rotZ = a => [[Math.cos(a),-Math.sin(a),0],[Math.sin(a),Math.cos(a),0],[0,0,1]];

// Fixed camera. Levelled, the orb reads square-on: body Y onto screen-right,
// body Z onto screen-up, and body X straight at the viewer -- so X sits as a
// dot at the centre. That is exactly rotZ(-90 deg).
const VIEW = rotZ(-Math.PI/2);

// Display-only zero. The IMU's mounting inside the orb is arbitrary, so rather
// than hard-code a remap, capture whatever pose it is in now as upright.
// Purely client-side -- the firmware still works in the sensor's own frame,
// which is the frame 3-axis reads.
// Persisted: the page is reloaded often while the firmware is being changed,
// and re-levelling every time would be tedious.
let homeQ = null;
try {
  const saved = localStorage.getItem("orbHome");
  if (saved) homeQ = JSON.parse(saved);
} catch (e) { homeQ = null; }
const qMul = (a,b) => [
  a[0]*b[0] - a[1]*b[1] - a[2]*b[2] - a[3]*b[3],
  a[0]*b[1] + a[1]*b[0] + a[2]*b[3] - a[3]*b[2],
  a[0]*b[2] - a[1]*b[3] + a[2]*b[0] + a[3]*b[1],
  a[0]*b[3] + a[1]*b[2] - a[2]*b[1] + a[3]*b[0],
];
const qConj = q => [q[0], -q[1], -q[2], -q[3]];

// Latitude and longitude rings, generated once in body space.
const RINGS = (() => {
  const rings = [], SEG = 48;
  for (let k = -2; k <= 2; k++) {                 // latitudes
    const lat = k * Math.PI/6, r = Math.cos(lat), zz = Math.sin(lat);
    const pts = [];
    for (let i = 0; i <= SEG; i++) {
      const a = i/SEG * Math.PI*2;
      pts.push([r*Math.cos(a), r*Math.sin(a), zz]);
    }
    rings.push({pts, major: k === 0});
  }
  for (let k = 0; k < 6; k++) {                   // longitudes
    const lon = k * Math.PI/6, pts = [];
    for (let i = 0; i <= SEG; i++) {
      const a = i/SEG * Math.PI*2;
      pts.push([Math.cos(a)*Math.cos(lon), Math.cos(a)*Math.sin(lon), Math.sin(a)]);
    }
    rings.push({pts, major: false});
  }
  return rings;
})();

function drawOrb() {
  const [g,w,h] = fit($("orb"));
  const cx = w/2, cy = h/2, R = Math.min(w,h)*0.38;

  // Screen frame: X right, Z up. For a right-handed frame that puts +Y *into*
  // the screen (toward-viewer = X x Z = -Y), so depth-toward-viewer is -Y.
  // Getting this backwards swapped the near and far halves of the sphere and
  // made every rotation read in the wrong direction.
  const proj = p => [cx + p[0]*R, cy - p[2]*R, -p[1]];

  let qv = latest ? [latest.qw, latest.qx, latest.qy, latest.qz] : [1,0,0,0];
  if (homeQ) qv = qMul(qConj(homeQ), qv);
  const q = matMul(VIEW, quatMatrix(qv[0], qv[1], qv[2], qv[3]));

  // Silhouette, so the sphere reads as a solid even when rings are sparse.
  g.beginPath(); g.arc(cx, cy, R, 0, Math.PI*2);
  g.fillStyle = "#15171f"; g.fill();
  g.strokeStyle = "#2a2d3a"; g.lineWidth = 1; g.stroke();

  for (const ring of RINGS) {
    const proj_pts = ring.pts.map(p => proj(apply(q, p)));
    // Two passes so the far half is visibly behind the near half -- without
    // that the sphere reads as a flat circle and the rotation is ambiguous.
    for (const near of [false, true]) {
      g.beginPath();
      let drawing = false;
      for (const p of proj_pts) {
        const isNear = p[2] >= 0;
        if (isNear !== near) { drawing = false; continue; }
        drawing ? g.lineTo(p[0],p[1]) : (g.moveTo(p[0],p[1]), drawing = true);
      }
      g.strokeStyle = near ? (ring.major ? "#5a6180" : "#3a3f55") : "#23262f";
      g.lineWidth = near && ring.major ? 1.4 : 1;
      g.stroke();
    }
  }

  // Body axes, coloured to match the rotation graph.
  const AXES = [
    [[1,0,0], "--x", "X"],
    [[0,1,0], "--y", "Y"],
    [[0,0,1], "--z", "Z"],
  ];
  const css = getComputedStyle(document.body);
  const drawn = AXES.map(([v,varname,label]) => {
    const e = apply(q, v);
    return {e, p: proj(e), color: css.getPropertyValue(varname).trim(), label};
  }).sort((a,b) => b.e[1] - a.e[1]);      // far axes (larger +y) first

  for (const a of drawn) {
    const tip = [cx + a.e[0]*R*1.18, cy - a.e[2]*R*1.18];
    const behind = a.e[1] > 0;
    g.globalAlpha = behind ? 0.3 : 1;
    g.strokeStyle = a.color; g.lineWidth = behind ? 1.5 : 2.5;
    g.beginPath(); g.moveTo(cx,cy); g.lineTo(tip[0],tip[1]); g.stroke();
    g.fillStyle = a.color;
    g.beginPath(); g.arc(tip[0], tip[1], behind ? 3 : 4.5, 0, Math.PI*2); g.fill();
    g.font = "600 10px ui-monospace,monospace";
    g.fillText(a.label, tip[0]+7, tip[1]+3);
  }
  g.globalAlpha = 1;
}

function draw() {
  drawOrb();

  // gyro
  let [g,w,h] = fit($("gyro"));
  let peak = 40;
  for (const k of ["gx","gy","gz"]) for (const v of buf[k]) peak = Math.max(peak, Math.abs(v));
  peak = Math.min(peak * 1.15, 600);

  g.strokeStyle = "#222532"; g.lineWidth = 1;
  g.beginPath(); g.moveTo(0,h/2); g.lineTo(w,h/2); g.stroke();

  const dz = +cfg.deadzone_dps || 0, sat = +cfg.saturate_dps || 0;
  for (const s of [1,-1]) {
    hline(g,w,h, s*dz,  -peak,peak, "#3a3f55", [3,3]);
    hline(g,w,h, s*sat, -peak,peak, "#4a3550", [3,3]);
  }
  line(g, buf.gx, w,h, -peak,peak, getComputedStyle(document.body).getPropertyValue("--x"));
  line(g, buf.gy, w,h, -peak,peak, getComputedStyle(document.body).getPropertyValue("--y"));
  line(g, buf.gz, w,h, -peak,peak, getComputedStyle(document.body).getPropertyValue("--z"));

  g.fillStyle = "#6a7090"; g.font = "10px ui-monospace,monospace";
  g.fillText(`±${peak.toFixed(0)} deg/s`, 6, 12);

  // haptic
  [g,w,h] = fit($("hap"));
  g.strokeStyle = "#222532"; g.lineWidth = 1;
  g.beginPath(); g.moveTo(0,h-1); g.lineTo(w,h-1); g.stroke();
  line(g, buf.strength, w,h, 0,1, "#5a5f75", 1);
  line(g, buf.out,      w,h, 0,1, "#ff8c42", 1.6);
  g.fillStyle = "#6a7090"; g.font = "10px ui-monospace,monospace";
  g.fillText("1.0", 6, 12);

  if (latest) {
    $("nx").textContent = (latest.gx*RAD2DEG).toFixed(1);
    $("ny").textContent = (latest.gy*RAD2DEG).toFixed(1);
    $("nz").textContent = (latest.gz*RAD2DEG).toFixed(1);
    $("nraw").textContent   = latest.raw.toFixed(1);
    $("qx").textContent     = latest.mx.toFixed(1);
    $("qy").textContent     = latest.my.toFixed(1);
    $("qz").textContent     = latest.mz.toFixed(1);
    $("ndisp").textContent  = latest.disp.toFixed(1);
    const held = latest.held > 0.5;
    $("heldtag").textContent = held ? "— held" : "— set down";
    $("heldtag").style.color = held ? "var(--ok)" : "var(--dim)";
    $("nraw2").textContent  = latest.raw.toFixed(1);
    $("nout").textContent   = latest.out.toFixed(2);
    $("nrtp").textContent   = latest.rtp.toFixed(0);
    $("npulse").textContent = latest.pulse.toFixed(2);
    $("ngrain").textContent = latest.grain.toFixed(2);
    $("hz").textContent     = latest.loop_hz.toFixed(0);
    $("bar").style.width    = (latest.out*100).toFixed(1) + "%";
  }
  requestAnimationFrame(draw);
}

// --- controls ---------------------------------------------------------------

function buildControls() {
  QUANTITIES.forEach(([id,label]) => {
    const b = document.createElement("button");
    b.textContent = label; b.dataset.q = id;
    b.onclick = () => send("Q " + id);
    $("quantities").appendChild(b);
  });

  SOURCES.forEach(([id,label]) => {
    const b = document.createElement("button");
    b.textContent = label; b.dataset.src = id;
    b.onclick = () => send("S " + id);
    $("sources").appendChild(b);
  });

  const ax = $("axes");
  ["x","y","z"].forEach((label,i) => {
    const b = document.createElement("button");
    b.textContent = label; b.dataset.axis = i;
    b.onclick = () => send("a " + i);
    ax.appendChild(b);
  });

  const box = $("sliders");
  SLIDERS.forEach(([key,label,cmd,min,max,step,unit]) => {
    const row = document.createElement("div");
    row.className = "row"; row.dataset.key = key;
    row.innerHTML =
      `<label>${label}</label>
       <input type=range min=${min} max=${max} step=${step}>
       <output>–</output>`;
    const input = row.querySelector("input");
    const out   = row.querySelector("output");
    input.oninput = () => {
      out.textContent = (+input.value).toFixed(step < 1 ? 2 : 0) + (unit ? " "+unit : "");
      dragging = key;
      send(`${cmd} ${input.value}`);
    };
    // Let the orb's echo take over again once the hand is off the slider.
    input.onchange = () => { dragging = null; };
    box.appendChild(row);
  });

  $("btnref").onclick   = () => send("R");
  $("btnsweep").onclick = () => send("m");
  $("btnstop").onclick  = () => send("z");
  $("btnhap").onclick   = () => send("h " + (haptics ? 0 : 1));
  $("btnhold").onclick  = () => send("H " + (holding ? -1 : holdLevel));
  $("btngate").onclick  = () => send("k " + (gate ? 0 : 1));

  $("btnlevel").onclick = () => {
    if (!latest) return;
    homeQ = [latest.qw, latest.qx, latest.qy, latest.qz];
    localStorage.setItem("orbHome", JSON.stringify(homeQ));
    $("btnlevel").classList.add("on");
  };
  $("btnlevelclr").onclick = () => {
    homeQ = null;
    localStorage.removeItem("orbHome");
    $("btnlevel").classList.remove("on");
  };
  $("btnlevel").classList.toggle("on", !!homeQ);
}

function applyConfig(c) {
  cfg = c;
  quantity = +c.quantity || 0;
  source   = +c.source   || 0;
  haptics  = c.haptics_on === "1";

  $("modename").textContent = `${c.quantity_name || "?"} · ${c.source_name || "?"}`;
  $("drv").textContent      = c.drv_ready === "1" ? "ok" : "MISSING";
  $("drv").style.color      = c.drv_ready === "1" ? "" : "var(--x)";
  $("resets").textContent   = c.imu_resets ?? "–";

  document.querySelectorAll("#quantities button").forEach(b =>
    b.classList.toggle("on", +b.dataset.q === quantity));
  document.querySelectorAll("#sources button").forEach(b =>
    b.classList.toggle("on", +b.dataset.src === source));
  document.querySelectorAll("#axes button").forEach(b =>
    b.classList.toggle("on", +b.dataset.axis === (+c.use_axis)));

  // The axis picker only means anything for the 1-axis source.
  const axisOff = source !== 0;
  $("axes").style.opacity     = axisOff ? ".32" : "1";
  $("axishead").style.opacity = axisOff ? ".32" : "1";

  // Only 3-axis actually routes the axes to those three roles.
  $("axisnums").style.opacity = source === 1 ? "1" : ".45";
  const unit = quantity === 0 ? "dps" : "deg";
  $("rawlabel").textContent = `driving strength · ${unit}`;

  $("btnhap").textContent = "haptics: " + (haptics ? "on" : "off");
  $("btnhap").classList.toggle("on", haptics);

  gate = c.presence_gate === "1";
  $("btngate").textContent = "silence when set down: " + (gate ? "on" : "off");
  $("btngate").classList.toggle("on", gate);
  $("modehint").textContent =
    (QUANTITIES.find(m => m[0] === quantity) || [,,""])[2] + " " +
    (SOURCES.find(m => m[0] === source) || [,,""])[2];

  const hv = parseFloat(c.hold);
  holding = hv >= 0;
  if (holding) holdLevel = hv;                 // remember it across toggles
  $("btnhold").textContent = "hold: " + (holding ? holdLevel.toFixed(2) : "off");
  $("btnhold").classList.toggle("on", holding);

  SLIDERS.forEach(([key,label,cmd,min,max,step,unit,onlyModes]) => {
    const row = document.querySelector(`.row[data-key="${key}"]`);
    if (!row) return;
    // Dim what the active mode ignores, rather than hiding it -- a control
    // that vanishes is harder to reason about than one that greys out.
    let inactive = !relevant(key, quantity, source);
    // Hold bypasses the mode entirely, so everything upstream stops mattering.
    if (holding && ["deadzone_dps","saturate_dps","gamma","tau_ms",
                    "wind_full_deg","wind_decay_ms","dial_full_deg"].includes(key)) {
      inactive = true;
    }
    if (key === "hold") inactive = !holding;
    row.classList.toggle("off", !!inactive);

    if (dragging === key) return;              // don't fight the hand
    // A disengaged hold reads back as -1, which is below the slider's range;
    // keep showing the remembered level instead of snapping it to zero.
    const v = (key === "hold") ? holdLevel : parseFloat(c[key]);
    if (Number.isNaN(v)) return;
    row.querySelector("input").value = v;
    row.querySelector("output").textContent =
      v.toFixed(step < 1 ? 2 : 0) + (unit ? " "+unit : "");
  });
}

buildControls();
requestAnimationFrame(draw);

// --- wiring -----------------------------------------------------------------

link.onFrame(push);
link.onConfig(applyConfig);
link.onStatus(({ connected, device }) => {
  const el = document.getElementById("linkstat");
  el.querySelector("b").textContent =
    !connected ? "down \u2014 is bridge.py running?"
    : !device ? "no orb \u2014 plug it in"
    : "up";
  el.classList.toggle("bad", !connected || !device);
});
link.connect();
