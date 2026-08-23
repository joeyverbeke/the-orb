import * as THREE from 'three/webgpu';
import {
  Fn, vec3, vec4, float, uniform, attribute, positionLocal,
  modelViewMatrix, modelWorldMatrix, cameraProjectionMatrix, cameraPosition,
  mix, dot, normalize, saturate, smoothstep, length, abs, fract, pow,
  mx_fractal_noise_float, mx_fractal_noise_vec3, time,
} from 'three/tsl';

import { createStage } from '../../src/lib/stage.js';
import { mountTopbar, mountFatal } from '../../src/lib/hud.js';
import { createPanel } from '../../src/lib/panel.js';
import { orb } from '../../src/orb/link.js';
import { createMotion } from '../../src/orb/motion.js';
import { createResponse, MOTION_STORE, MOTION_DEFAULTS } from '../../src/orb/response.js';
import { buildCloud } from '../data-body/cloud.js';

// Global tuning for how much movement counts as "a lot".
//
// The point of the curve is that a nudge and a real gesture should not scale
// the same way. Linear mapping gives every small knock a proportionate share of
// the range; an exponent above 1 keeps the bottom quiet and saves the range for
// movements that were actually meant.
//
// It tests against the data body because judging a response curve needs
// something reacting to it, and the numbers tuned here are the ones every
// experiment uses.

const DEG = 180 / Math.PI;
const POINTS = 60000;

// The look is not what is being tuned here, so it is read from whatever the
// data body was last set to and otherwise left alone.
function dataBodyLook() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem('panel:data-body') || '{}'); } catch { /* defaults */ }
  const num = (k, d) => (typeof saved[k] === 'number' ? saved[k] : d);
  const str = (k, d) => (typeof saved[k] === 'string' ? saved[k] : d);
  return {
    size: num('point-size', 0.0075),
    sizeVar: num('size-variation', 0.7),
    soft: num('softness', 0.75),
    bright: num('brightness', 0.28),
    shell: num('shell-thickness', 0.09),
    rimGlow: num('rim-glow', 1.4),
    sparkle: num('sparkle', 0.75),
    undRest: num('und-rest', 0.02),
    undMoving: num('und-moving', 0.16),
    undDetail: num('undulation-detail', 1.5),
    undSpeed: num('undulation-speed', 0.09),
    driftRest: num('drift-rest', 0.02),
    driftMoving: num('drift-moving', 0.14),
    driftDetail: num('drift-detail', 1.1),
    driftSpeed: num('drift-speed', 0.06),
    core: str('body', '#2f5f8f'),
    crest: str('crests', '#eaf4ff'),
    moving: str('when-moving', '#b06cff'),
  };
}

async function main() {
  const stage = await createStage({
    canvas: document.getElementById('view'),
    position: [0, 0, 3.4],
    background: 0x05060a,
  });
  const hud = mountTopbar({ title: 'motion response', backend: stage.backend });

  // Persists to panel:orb-motion, which is what every experiment reads.
  const panel = createPanel({ title: 'Motion response', storageKey: MOTION_STORE });
  const L = dataBodyLook();

  panel.group('Turning');
  const pTurnDead = panel.slider('Ignore below (deg/s)', {
    key: 'turn-deadzone', value: MOTION_DEFAULTS['turn-deadzone'],
    min: 0, max: 60, step: 0.5,
    note: 'Turning slower than this counts as holding still.' });
  const pTurnFull = panel.slider('Full at (deg/s)', {
    key: 'turn-full', value: MOTION_DEFAULTS['turn-full'],
    min: 20, max: 500, step: 5 });
  const pTurnCurve = panel.slider('Curve', {
    key: 'turn-curve', value: MOTION_DEFAULTS['turn-curve'],
    min: 0.3, max: 4, step: 0.05,
    note: 'Above 1, small turns do less and big ones do more. Below 1 is the '
        + 'opposite — twitchy at the bottom.' });

  panel.group('Settling');
  const pAttack = panel.slider('Rise time (s)', {
    key: 'attack-s', value: MOTION_DEFAULTS['attack-s'],
    min: 0.01, max: 1.5, step: 0.01,
    note: 'How quickly it responds when you start moving.' });
  const pRelease = panel.slider('Fall time (s)', {
    key: 'release-s', value: MOTION_DEFAULTS['release-s'],
    min: 0.05, max: 6, step: 0.05,
    note: 'How long it takes to calm down once you stop.' });

  panel.group('Haptics');
  const pHapLink = panel.toggle('Link to turning', MOTION_DEFAULTS['haptic-link'], {
    key: 'haptic-link',
    note: 'On, the motor follows the same curve as the visuals — a small turn '
        + 'is felt as little as it is seen. Off hands the motor back to each '
        + 'experiment to do its own thing with.' });
  const pHapStrength = panel.slider('Strength at full turn', {
    key: 'haptic-strength', value: MOTION_DEFAULTS['haptic-strength'],
    min: 0, max: 1, step: 0.01 });
  const pHapIdle = panel.slider('Strength when still', {
    key: 'haptic-idle', value: MOTION_DEFAULTS['haptic-idle'],
    min: 0, max: 1, step: 0.01,
    note: 'Above zero leaves a constant presence in the hand. The ERM has a '
        + 'floor below which it does not turn at all, set in the firmware.' });

  panel.group('Live');
  panel.readout('turn (deg/s)', () => liveTurn.toFixed(0));
  panel.readout('intensity', () => response.level.toFixed(2));
  panel.readout('motor', () => {
    const h = response.haptic;
    return h === null ? 'unlinked' : h.toFixed(2);
  });
  panel.readout('fps', () => stage.fps.toFixed(0));
  panel.actions();

  // The tool drives the response from its own controls so the curve moves as
  // sliders drag; experiments read the same values from storage.
  const response = createResponse({
    'turn-deadzone': pTurnDead, 'turn-full': pTurnFull, 'turn-curve': pTurnCurve,
    'attack-s': pAttack, 'release-s': pRelease,
    'haptic-link': pHapLink, 'haptic-strength': pHapStrength,
    'haptic-idle': pHapIdle,
  });

  // --- scene ----------------------------------------------------------------
  const { scene } = stage;
  scene.add(new THREE.HemisphereLight(0x6f86ff, 0x140d08, 0.4));

  const uLevel = uniform(float(0));
  const uUndDepth = uniform(float(L.undRest));
  const uDrift = uniform(float(L.driftRest));
  // Object-space directions are looked up through this so that re-levelling --
  // which silently redefines the body when the orb is set down -- leaves the
  // picture untouched. See src/orb/motion.js.
  const uField = uniform(new THREE.Matrix3());

  const geometry = buildCloud(POINTS);
  const corner = attribute('aCorner', 'vec2');
  const seed = attribute('aSeed', 'float');
  const dir = normalize(positionLocal);
  const fieldDir = normalize(uField.mul(dir));

  const radius = Fn(() => {
    const drift = time.mul(L.undSpeed);
    const field = mx_fractal_noise_float(
      fieldDir.mul(L.undDetail).add(vec3(0.0, drift, drift.mul(0.45))), 3, 2.0, 0.5);
    return float(1).add(seed.sub(0.5).mul(L.shell)).add(field.mul(uUndDepth));
  })();

  const flowT = time.mul(L.driftSpeed);
  const flow = mx_fractal_noise_vec3(
    fieldDir.mul(L.driftDetail).add(vec3(flowT, flowT.mul(0.7), flowT.mul(1.3))), 2, 2.0, 0.5)
    .mul(uDrift);

  const centreLocal = dir.mul(radius).add(flow);
  const centreView = modelViewMatrix.mul(vec4(centreLocal, 1.0));
  const pointSize = float(L.size).mul(float(1 - L.sizeVar * 0.5).add(seed.mul(L.sizeVar)));

  const material = new THREE.MeshBasicNodeMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  material.vertexNode = cameraProjectionMatrix.mul(vec4(
    centreView.xyz.add(vec3(corner.x.mul(pointSize), corner.y.mul(pointSize), 0.0)), 1.0));

  const crest = saturate(radius.sub(1.0).mul(4.0));
  const dirWorld = normalize(modelWorldMatrix.mul(vec4(dir, 0.0)).xyz);
  const toEye = normalize(cameraPosition.sub(modelWorldMatrix.mul(vec4(centreLocal, 1.0)).xyz));
  const rim = float(1).sub(abs(dot(dirWorld, toEye)));

  const CORE = new THREE.Color(L.core);
  const CREST = new THREE.Color(L.crest);
  const MOVING = new THREE.Color(L.moving);

  material.colorNode = Fn(() => {
    const base = mix(vec3(CORE.r, CORE.g, CORE.b), vec3(CREST.r, CREST.g, CREST.b), crest);
    const tinted = mix(base, vec3(MOVING.r, MOVING.g, MOVING.b), uLevel.mul(0.65));
    return vec4(tinted.mul(float(1).add(rim.mul(L.rimGlow))), 1.0);
  })();

  const d = length(corner);
  const disc = smoothstep(1.0, 1.0 - L.soft, d);
  const other = fract(seed.mul(91.7));
  const twinkle = mix(float(1), pow(other, float(2.5)).mul(2.4).add(0.12), float(L.sparkle));
  material.opacityNode = disc.mul(disc).mul(twinkle).mul(L.bright);

  const cloud = new THREE.Mesh(geometry, material);
  cloud.frustumCulled = false;
  scene.add(cloud);

  // --- curve graph ----------------------------------------------------------
  const graph = document.getElementById('graph');
  const gctx = graph.getContext('2d');
  const css = getComputedStyle(document.body);
  const COL_TURN = css.getPropertyValue('--y').trim();
  const COL_HAPTIC = css.getPropertyValue('--hot').trim();

  function drawGraph() {
    const dpr = Math.min(devicePixelRatio, 2);
    const w = graph.clientWidth, h = graph.clientHeight;
    if (graph.width !== w * dpr) { graph.width = w * dpr; graph.height = h * dpr; }
    gctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    gctx.clearRect(0, 0, w, h);

    gctx.strokeStyle = '#1a1e28';
    gctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const y = (h - 1) * (i / 4) + 0.5;
      gctx.beginPath(); gctx.moveTo(0, y); gctx.lineTo(w, y); gctx.stroke();
    }
    // Linear reference, so the effect of the curve is visible as a departure
    // from it rather than as an abstract shape.
    gctx.strokeStyle = '#2c3140';
    gctx.setLineDash([3, 3]);
    gctx.beginPath(); gctx.moveTo(0, h); gctx.lineTo(w, 0); gctx.stroke();
    gctx.setLineDash([]);

    // X is a fraction of each channel's own full-scale, so both fit one axis
    // despite being different units.
    const plot = (fn, full, colour) => {
      gctx.strokeStyle = colour; gctx.lineWidth = 1.6;
      gctx.beginPath();
      for (let i = 0; i <= 120; i++) {
        const f = i / 120;
        const y = h - fn(f * full) * (h - 2) - 1;
        i ? gctx.lineTo(f * w, y) : gctx.moveTo(f * w, y);
      }
      gctx.stroke();
    };
    const full = pTurnFull.value;
    plot((v) => response.shape(v), full, COL_TURN);

    // The motor curve is the same shape scaled by the haptic settings, which
    // is the whole point of linking them: what is seen and what is felt are
    // the same gesture read the same way.
    if (pHapLink.value) {
      plot((v) => response.hapticFor(response.shape(v)) ?? 0, full, COL_HAPTIC);
    }

    const dot = (frac, val, colour) => {
      const x = Math.min(frac, 1) * w;
      const y = h - val * (h - 2) - 1;
      gctx.fillStyle = colour;
      gctx.beginPath(); gctx.arc(x, y, 3.2, 0, Math.PI * 2); gctx.fill();
    };
    dot(liveTurn / Math.max(full, 1), response.shape(liveTurn), COL_TURN);
    if (pHapLink.value) {
      dot(liveTurn / Math.max(full, 1), response.haptic ?? 0, COL_HAPTIC);
    }
  }

  const elLevel = document.getElementById('level');
  const elTurn = document.getElementById('nTurn');
  const elOut = document.getElementById('nLevel');
  const elHaptic = document.getElementById('nHaptic');

  // --- device ---------------------------------------------------------------
  const motion = createMotion(orb, { delayMs: 70 });
  const smoothed = new THREE.Quaternion();
  // Everything visible is a function of this one rotation, and nothing is
  // rotated by the attitude directly -- that is what makes a re-level
  // invisible. See src/orb/motion.js.
  const lookup = new THREE.Quaternion();
  const lookupMat = new THREE.Matrix3();
  const lookupM4 = new THREE.Matrix4();
  let liveTurn = 0, started = false, lastGraph = 0, lastEpoch = -1;

  stage.onUpdate((dt) => {
    const m = motion.sample();
    if (m.valid) {
      // The field compensation is instantaneous, so easing towards a re-levelled
      // attitude would drag the body across a picture that has already moved --
      // that is the stutter. Snap on the frame it changes and nothing shows.
      if (!started || m.epoch !== lastEpoch) {
        smoothed.copy(m.quaternion);
        lastEpoch = m.epoch;
        started = true;
      } else {
        smoothed.slerp(m.quaternion, 1 - Math.exp(-dt * 22));
      }
      liveTurn = m.omega.length() * DEG;
    }

    const level = response.update(liveTurn, dt);

    // Feel it while tuning it -- a haptic curve judged only by eye is guesswork.
    const felt = response.haptic;
    if (felt === null) orb.releaseHaptic(); else orb.setHaptic(felt);

    // L = attitude^-1 * field
    lookup.copy(smoothed).invert().multiply(m.field);
    lookupMat.setFromMatrix4(lookupM4.makeRotationFromQuaternion(lookup));
    uField.value.copy(lookupMat);
    uLevel.value = level;
    uUndDepth.value = L.undRest + (L.undMoving - L.undRest) * level;
    uDrift.value = L.driftRest + (L.driftMoving - L.driftRest) * level;

    const now = performance.now();
    if (now - lastGraph > 33) {
      lastGraph = now;
      drawGraph();
      elLevel.style.width = (level * 100).toFixed(1) + '%';
      elTurn.textContent = liveTurn.toFixed(0);
      elOut.textContent = level.toFixed(2);
      elHaptic.textContent = felt === null ? '–' : felt.toFixed(2);
    }

    hud.update(stage);
    panel.tick();
  });

  orb.connect();
}

main().catch(mountFatal);
