import * as THREE from 'three/webgpu';
import {
  Fn, vec2, vec3, vec4, float, uniform, attribute, positionLocal,
  modelViewMatrix, modelWorldMatrix, cameraProjectionMatrix, cameraPosition,
  mix, dot, pow, clamp, sin, atan, normalize, saturate, smoothstep, length,
  abs, fract,
  mx_fractal_noise_float, mx_fractal_noise_vec3, time,
} from 'three/tsl';

import { createStage } from '../../src/lib/stage.js';
import { mountTopbar, mountFatal } from '../../src/lib/hud.js';
import { createPanel } from '../../src/lib/panel.js';
import { orb } from '../../src/orb/link.js';
import { createMotion } from '../../src/orb/motion.js';
import { createResponse } from '../../src/orb/response.js';
import { buildCloud } from './cloud.js';

// The sphere resolved as a cloud rather than a surface.
//
// Same signal chain as the stirred body -- movement drives the undulation,
// turning drags ripples against the way you turned -- but there is no skin
// here, so all of it has to be legible in where the points sit and how bright
// they are. Additive blending does most of the work: the shell is denser along
// the silhouette, so the rim accumulates and glows without being asked to.

const DEG = 180 / Math.PI;
const MAX_POINTS = 160000;

async function main() {
  const stage = await createStage({
    canvas: document.getElementById('view'),
    position: [0, 0, 3.4],
    background: 0x05060a,
  });
  const hud = mountTopbar({ title: 'data body', backend: stage.backend });
  const panel = createPanel({
    title: 'Data body',
    storageKey: 'data-body',
    inheritFrom: 'stirred-body',
  });
  const { scene } = stage;

  // --- controls -------------------------------------------------------------
  panel.group('Cloud');
  const pCount = panel.slider('Point count', {
    value: 90000, min: 5000, max: MAX_POINTS, step: 1000,
    note: 'Drawn from a pre-built pool, so this is free to move.' });
  const pSize = panel.slider('Point size', {
    value: 0.0075, min: 0.001, max: 0.04, step: 0.0005 });
  const pSizeVar = panel.slider('Size variation', {
    value: 0.7, min: 0, max: 1, step: 0.01 });
  const pSoft = panel.slider('Softness', {
    value: 0.75, min: 0, max: 1, step: 0.01,
    note: 'Hard little dots through to diffuse motes.' });
  const pBright = panel.slider('Brightness', {
    value: 0.28, min: 0.02, max: 2, step: 0.01,
    note: 'Additive, so this compounds where points overlap. Low values let '
        + 'the dense rim glow without the body turning into fog.' });
  const pShell = panel.slider('Shell thickness', {
    value: 0.09, min: 0, max: 0.6, step: 0.005,
    note: 'How far points scatter either side of the surface.' });
  const pRimGlow = panel.slider('Rim glow', {
    value: 1.4, min: 0, max: 4, step: 0.02,
    note: 'Extra brightness along the silhouette, where the shell stacks up '
        + 'deepest along the line of sight.' });
  const pSparkle = panel.slider('Sparkle', {
    value: 0.75, min: 0, max: 1, step: 0.01,
    note: 'How uneven the points are. At zero every point is equally bright; '
        + 'high leaves a scatter of bright motes among dim ones.' });

  panel.group('Resting surface');
  const pUndRest = panel.slider('Undulation at rest', {
    // Was a single 'Undulation depth'; adopt that value if still stored.
    key: 'und-rest', from: 'undulation-depth',
    value: 0.02, min: 0, max: 0.3, step: 0.001 });
  const pUndMoving = panel.slider('Undulation when moving', {
    key: 'und-moving',
    value: 0.16, min: 0, max: 0.6, step: 0.001 });
  const pUndDetail = panel.slider('Undulation detail', {
    value: 1.5, min: 0.3, max: 5, step: 0.01 });
  const pUndSpeed = panel.slider('Undulation speed', {
    value: 0.09, min: 0, max: 0.5, step: 0.005 });

  panel.group('Drift');
  const pFlowRest = panel.slider('Drift at rest', {
    // Was a single 'Drift amount'; adopt that value if it is still stored.
    key: 'drift-rest', from: 'drift-amount',
    value: 0.02, min: 0, max: 0.4, step: 0.002,
    note: 'A slow vector field the points swim through. This is most of what '
        + 'makes it read as a cloud and not a shell of dots.' });
  const pFlowMoving = panel.slider('Drift when moving', {
    key: 'drift-moving',
    value: 0.14, min: 0, max: 0.6, step: 0.002,
    note: 'Drift at full movement. Follows the same envelope as the '
        + 'undulation, so the cloud loosens and re-settles as one thing.' });
  const pFlowScale = panel.slider('Drift detail', {
    value: 1.1, min: 0.2, max: 4, step: 0.02 });
  const pFlowSpeed = panel.slider('Drift speed', {
    value: 0.06, min: 0, max: 0.6, step: 0.005 });

  panel.group('Ripples');
  const pRipples = panel.toggle('Ripples', true);
  const pRipDepth = panel.slider('Ripple depth', {
    value: 0.05, min: 0, max: 0.3, step: 0.002 });
  const pRipCount = panel.slider('Ripples around', { value: 4, min: 1, max: 12, step: 1 });
  const pRipSpeed = panel.slider('Ripple travel speed', { value: 5, min: 0, max: 20, step: 0.1 });
  const pRipSettle = panel.slider('Settle time (s)', { value: 1.4, min: 0.1, max: 6, step: 0.05 });
  const pRipBelt = panel.slider('Belt tightness', { value: 1.0, min: 0.3, max: 4, step: 0.05 });
  const pTurnFull = panel.slider('Turn for full ripple (deg/s)', {
    value: 170, min: 20, max: 500, step: 5 });
  const pAgainst = panel.toggle('Ripples trail the turn', true);

  panel.group('Motion');
  const pFollow = panel.slider('Follow speed', { value: 22, min: 3, max: 60, step: 0.5 });
  const pAxisSteady = panel.slider('Axis steadiness', { value: 3.5, min: 0.5, max: 15, step: 0.1 });
  const pAxisMin = panel.slider('Min turn to aim ripples (deg/s)', {
    value: 20, min: 2, max: 90, step: 1 });
  const pDelay = panel.slider('Motion delay (ms)', { value: 70, min: 0, max: 220, step: 5 });

  panel.group('Colour');
  const cCore = panel.color('Body', '#2f5f8f', {
    note: 'The bulk of the cloud, where nothing much is happening.' });
  const cCrest = panel.color('Crests', '#eaf4ff');
  const cMoving = panel.color('When moving', '#b06cff');
  const pHeat = panel.slider('Colour shift when moving', { value: 0.65, min: 0, max: 1, step: 0.01 });

  panel.group('Haptics');
  const pHaptics = panel.toggle('Drive the motor', true);

  panel.group('Live');
  panel.readout('turn speed (deg/s)', () => liveTurn.toFixed(0));
  panel.readout('movement', () => stirred.toFixed(2));
  panel.readout('drift', () => uDrift.value.toFixed(3));
  panel.readout('ripple', () => ripple.toFixed(2));
  panel.readout('points', () => (Math.round(pCount.value / 1000) + 'k'));
  panel.readout('fps', () => stage.fps.toFixed(0));
  panel.actions();

  // --- uniforms the panel does not own --------------------------------------
  const uAxis = uniform(new THREE.Vector3(0, 1, 0));
  const uU = uniform(new THREE.Vector3(1, 0, 0));
  const uW = uniform(new THREE.Vector3(0, 0, 1));
  const uPhase = uniform(float(0));
  const uRipple = uniform(float(0));
  const uSpin = uniform(float(0));
  const uDir = uniform(float(1));
  const uUndDepth = uniform(float(0.02));
  // Object-space directions are looked up through this so that re-levelling
  // -- which silently redefines the body when the orb is set down -- leaves
  // the picture untouched. See src/orb/motion.js.
  const uField = uniform(new THREE.Matrix3());
  const uDrift = uniform(float(0.02));      // driven the same way

  // --- geometry -------------------------------------------------------------
  const geometry = buildCloud(MAX_POINTS);

  const corner = attribute('aCorner', 'vec2');
  const seed = attribute('aSeed', 'float');
  const dir = normalize(positionLocal);
  const fieldDir = normalize(uField.mul(dir));

  // Where this point sits, radially, before billboarding.
  const radius = Fn(() => {
    const drift = time.mul(pUndSpeed);
    const field = mx_fractal_noise_float(
      fieldDir.mul(pUndDetail).add(vec3(0.0, drift, drift.mul(0.45))), 3, 2.0, 0.5);

    // Scatter either side of the surface, deterministic per point.
    const shell = seed.sub(0.5).mul(pShell);

    const phi = atan(dot(fieldDir, uW), dot(fieldDir, uU));
    const along = dot(fieldDir, uAxis);
    const belt = pow(clamp(float(1).sub(along.mul(along)), 0, 1), pRipBelt);
    const wave = sin(phi.mul(pRipCount).add(uPhase.mul(uDir)))
      .mul(belt).mul(uRipple).mul(pRipDepth);

    return float(1).add(shell).add(field.mul(uUndDepth)).add(wave);
  })();

  // A slow vector field the whole cloud swims through, so it drifts rather
  // than sitting rigidly on a shell.
  const flowT = time.mul(pFlowSpeed);
  const flow = mx_fractal_noise_vec3(
    fieldDir.mul(pFlowScale).add(vec3(flowT, flowT.mul(0.7), flowT.mul(1.3))), 2, 2.0, 0.5)
    .mul(uDrift);

  const centreLocal = dir.mul(radius).add(flow);

  // --- billboard ------------------------------------------------------------
  // Offset in view space, where the camera axes are the coordinate axes, so
  // every quad faces the viewer and perspective scales it for free.
  const centreView = modelViewMatrix.mul(vec4(centreLocal, 1.0));
  const pointSize = pSize.mul(float(1).sub(pSizeVar.mul(0.5)).add(seed.mul(pSizeVar)));
  const offsetView = vec3(corner.x.mul(pointSize), corner.y.mul(pointSize), 0.0);

  const material = new THREE.MeshBasicNodeMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });

  material.vertexNode = cameraProjectionMatrix.mul(
    vec4(centreView.xyz.add(offsetView), 1.0));

  // --- shading --------------------------------------------------------------
  // How far this point has been pushed off the base shell: crests are the
  // parts that have been thrown outward.
  const crest = saturate(radius.sub(1.0).mul(4.0));

  // Where the shell runs edge-on to the viewer -- the silhouette, where a real
  // point cloud stacks up deepest along the line of sight. Note the abs():
  // without it this brightens the entire far hemisphere instead of the rim,
  // which reads as a glowing blob rather than a shell.
  const dirWorld = normalize(modelWorldMatrix.mul(vec4(dir, 0.0)).xyz);
  const toEye = normalize(cameraPosition.sub(modelWorldMatrix.mul(vec4(centreLocal, 1.0)).xyz));
  const rim = float(1).sub(abs(dot(dirWorld, toEye)));

  material.colorNode = Fn(() => {
    const base = mix(cCore, cCrest, crest);
    const tinted = mix(base, cMoving, uSpin.mul(pHeat));
    return vec4(tinted.mul(float(1).add(rim.mul(pRimGlow))), 1.0);
  })();

  // Soft disc. Squaring the falloff keeps a bright core inside a wide halo,
  // which is what stops a dense field reading as flat grey mush.
  const d = length(corner);
  const disc = smoothstep(1.0, mix(0.95, 0.0, pSoft), d);

  // A second pseudo-random per point, decorrelated from the seed driving size
  // and shell depth -- reusing that one would make brightness merely restate
  // them, and the field ends up looking uniform.
  const other = fract(seed.mul(91.7));
  const twinkle = mix(float(1), pow(other, float(2.5)).mul(2.4).add(0.12), pSparkle);

  material.opacityNode = disc.mul(disc).mul(twinkle).mul(pBright);

  const cloud = new THREE.Mesh(geometry, material);
  cloud.frustumCulled = false;
  scene.add(cloud);

  // --- device ---------------------------------------------------------------
  const motion = createMotion(orb, { delayMs: pDelay.value });
  const response = createResponse();
  const smoothed = new THREE.Quaternion();
  // Everything visible is a function of this one rotation, and nothing is
  // rotated by the attitude directly -- that is what makes a re-level
  // invisible. See src/orb/motion.js.
  const lookup = new THREE.Quaternion();
  const lookupMat = new THREE.Matrix3();
  const lookupM4 = new THREE.Matrix4();
  const axis = new THREE.Vector3(0, 1, 0);
  const nextAxis = new THREE.Vector3();
  const basisU = new THREE.Vector3(1, 0, 0);
  const basisW = new THREE.Vector3(0, 0, 1);
  const scratch = new THREE.Vector3();

  function updateBasis() {
    basisU.sub(scratch.copy(axis).multiplyScalar(basisU.dot(axis)));
    if (basisU.lengthSq() < 1e-6) {
      basisU.set(Math.abs(axis.x) < 0.9 ? 1 : 0, Math.abs(axis.x) < 0.9 ? 0 : 1, 0);
      basisU.sub(scratch.copy(axis).multiplyScalar(basisU.dot(axis)));
    }
    basisU.normalize();
    basisW.crossVectors(axis, basisU);
  }

  let phase = 0, ripple = 0, spin = 0, stirred = 0;
  let liveTurn = 0;
  let lastEpoch = -1;
  let started = false, hadHaptics = false;

  stage.onUpdate((dt) => {
    motion.delayMs = pDelay.value;
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
        smoothed.slerp(m.quaternion, 1 - Math.exp(-dt * pFollow.value));
      }

      const omega = m.omega;
      const mag = omega.length();
      liveTurn = mag * DEG;

      if (liveTurn > pAxisMin.value) {
        nextAxis.copy(omega).divideScalar(mag);
        axis.lerp(nextAxis, 1 - Math.exp(-dt * pAxisSteady.value)).normalize();
      }
      updateBasis();

      const norm = Math.min(liveTurn / Math.max(pTurnFull.value, 1), 1);
      spin += (norm - spin) * (1 - Math.exp(-dt * 8));

      // Deadzone, full scale, curve and settling all live in the Motion
      // tool now, so every experiment answers to movement the same way.
      stirred = response.update(liveTurn, dt);

      ripple = Math.max(ripple * Math.exp(-dt / Math.max(pRipSettle.value, 0.05)), norm);
    }

    phase += (0.25 + spin * pRipSpeed.value) * dt;

    geometry.setDrawRange(0, Math.floor(pCount.value) * 6);

    // L = attitude^-1 * field
    lookup.copy(smoothed).invert().multiply(m.field);
    lookupMat.setFromMatrix4(lookupM4.makeRotationFromQuaternion(lookup));
    uField.value.copy(lookupMat);
    // The spin axis and its basis live in body space, but the field is now
    // looked up through `field` -- so they have to be carried into the same
    // space or the ripple bands drift off the axis they belong to.
    uAxis.value.copy(axis).applyMatrix3(lookupMat);
    uU.value.copy(basisU).applyMatrix3(lookupMat);
    uW.value.copy(basisW).applyMatrix3(lookupMat);
    uPhase.value = phase;
    uRipple.value = pRipples.value ? ripple : 0;
    uSpin.value = spin;
    uDir.value = pAgainst.value ? 1 : -1;
    uUndDepth.value = pUndRest.value + (pUndMoving.value - pUndRest.value) * stirred;
    uDrift.value = pFlowRest.value + (pFlowMoving.value - pFlowRest.value) * stirred;

    if (pHaptics.value) {
      // Linked, the motor follows the same curve as everything else,
      // tuned once in the Motion tool. Unlinked, this experiment gets
      // to have its own character -- here, the slosh rather than the
      // gesture that caused it.
      const linked = response.haptic;
      const own = Math.min(1, (pRipples.value ? ripple : spin) * 0.9 + spin * 0.15);
      orb.setHaptic(linked === null ? own : linked);
      hadHaptics = true;
    } else if (hadHaptics) {
      orb.releaseHaptic();
      hadHaptics = false;
    }

    hud.update(stage);
    panel.tick();
  });

  orb.connect();
}

main().catch(mountFatal);
