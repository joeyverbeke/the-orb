import * as THREE from 'three/webgpu';
import {
  Fn, vec3, vec4, float, uniform, attribute, positionLocal,
  modelViewMatrix, modelWorldMatrix, cameraProjectionMatrix, cameraPosition,
  mix, dot, pow, clamp, sin, cos, atan, normalize, saturate, smoothstep, length,
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

// Two instructions at once, and they do not agree.
//
// Forked from the data body, so the cloud, the undulation and the ripples are
// the same machinery. Three things are added on top, and each one is a lever
// on the same wrist:
//
//   * The body only exists while it is moving. Set down it is at full colour;
//     picked up and held still it fades to almost nothing, so stopping erases
//     the picture. That is what makes turning feel like the only way to look.
//
//   * A collapsing point sits on the far side, tilted up far enough to just
//     crest the top of the sphere. It is body-fixed, so it comes round as the
//     orb is turned; aim it at the eye and hold it and the whole cloud drains
//     into it and blooms back in the colours the point was. That is the
//     visual instruction: turn *this* way.
//
//   * The motor says the opposite. It pulses while turning, and both the rate
//     and the strength of the pulse fall away the faster the point is being
//     brought toward centre. Turn where the eye wants and the hand goes quiet;
//     turn anywhere else and it insists.
//
// The goal direction is carried in *body* coordinates and pushed through the
// attitude each frame (`goalScreen = attitude * goalBody`), rather than through
// the field lookup the noise uses. That is deliberate: the field lookup is a
// conjugation, which is invisible for texture but would put a rotation of the
// wrist and a rotation of the target on differently-oriented axes -- and the
// whole experiment is about which way the wrist is being asked to go. Attitude
// is identity at the moment the orb is set down, so the far-side placement is
// exact.

const DEG = 180 / Math.PI;
const D2R = Math.PI / 180;
const MAX_POINTS = 160000;

const smooth01 = (x) => x * x * (3 - 2 * x);
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const ramp = (x, lo, hi) => clamp01((x - lo) / Math.max(hi - lo, 1e-6));

async function main() {
  const stage = await createStage({
    canvas: document.getElementById('view'),
    position: [0, 0, 3.4],
    background: 0x05060a,
  });
  const hud = mountTopbar({ title: 'counterpull', backend: stage.backend });
  const panel = createPanel({
    title: 'Counterpull',
    storageKey: 'counterpull',
    inheritFrom: 'data-body',
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
    value: 0.75, min: 0, max: 1, step: 0.01 });
  const pBright = panel.slider('Brightness', {
    value: 0.28, min: 0.02, max: 2, step: 0.01 });
  const pShell = panel.slider('Shell thickness', {
    value: 0.09, min: 0, max: 0.6, step: 0.005 });
  const pRimGlow = panel.slider('Rim glow', {
    value: 1.4, min: 0, max: 4, step: 0.02 });
  const pSparkle = panel.slider('Sparkle', {
    value: 0.75, min: 0, max: 1, step: 0.01 });

  panel.group('Resting surface');
  const pUndRest = panel.slider('Undulation at rest', {
    key: 'und-rest', value: 0.02, min: 0, max: 0.3, step: 0.001 });
  const pUndMoving = panel.slider('Undulation when moving', {
    key: 'und-moving', value: 0.16, min: 0, max: 0.6, step: 0.001 });
  const pUndDetail = panel.slider('Undulation detail', {
    value: 1.5, min: 0.3, max: 5, step: 0.01 });
  const pUndSpeed = panel.slider('Undulation speed', {
    value: 0.09, min: 0, max: 0.5, step: 0.005 });

  panel.group('Drift');
  const pFlowRest = panel.slider('Drift at rest', {
    key: 'drift-rest', value: 0.02, min: 0, max: 0.4, step: 0.002 });
  const pFlowMoving = panel.slider('Drift when moving', {
    key: 'drift-moving', value: 0.14, min: 0, max: 0.6, step: 0.002 });
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
  const cCore = panel.color('Body', '#2f5f8f');
  const cCrest = panel.color('Crests', '#eaf4ff');
  const cMoving = panel.color('When moving', '#b06cff');
  const pHeat = panel.slider('Colour shift when moving', { value: 0.65, min: 0, max: 1, step: 0.01 });

  // --- only visible while moving --------------------------------------------
  panel.group('Only while moving');
  const pDimFloor = panel.slider('Held and still', {
    key: 'vis-floor', value: 0.05, min: 0, max: 0.5, step: 0.005,
    note: 'What is left of the body when it is in the hand and not turning. '
        + 'Near zero means stopping erases it. Set down it is always 1 — the '
        + 'colours below are exactly what you tuned.' });
  const pVisMin = panel.slider('Turn to start showing (deg/s)', {
    key: 'vis-min', value: 10, min: 0, max: 60, step: 1 });
  const pVisFull = panel.slider('Turn for full colour (deg/s)', {
    key: 'vis-full', value: 90, min: 20, max: 400, step: 5 });
  const pVisAttack = panel.slider('Fade in (s)', {
    key: 'vis-attack', value: 0.07, min: 0.01, max: 1, step: 0.01 });
  const pVisRelease = panel.slider('Fade out (s)', {
    key: 'vis-release', value: 0.3, min: 0.02, max: 2, step: 0.01,
    note: 'Short, so stopping reads as the picture going out rather than '
        + 'settling.' });
  const pGoalFloor = panel.slider('Goal keeps this much', {
    key: 'goal-floor', value: 0.4, min: 0, max: 1, step: 0.01,
    note: 'The draining point does not fade with the body — it is the lure, so '
        + 'it stays legible when everything else has gone.' });

  // --- the thing to aim at --------------------------------------------------
  panel.group('Goal');
  const pGoalTilt = panel.slider('Tilt from far pole (deg)', {
    key: 'goal-tilt', value: 62, min: 0, max: 180, step: 1,
    note: 'Where it sits when the orb is set down. 0 is dead opposite the eye, '
        + '90 is straight up, 180 is facing you — drag it there to tune the '
        + 'funnel head-on. Around 60 leaves it just cresting the top, which is '
        + 'the whole point.' });
  const pGoalSize = panel.slider('Size (deg)', {
    key: 'goal-size', value: 22, min: 4, max: 60, step: 1 });
  const pGoalDepth = panel.slider('Suck-in depth', {
    key: 'goal-depth', value: 0.42, min: 0, max: 1, step: 0.01,
    note: 'How far the points inside it are dragged toward the core.' });
  const pGoalConverge = panel.slider('Funnel', {
    key: 'goal-converge', value: 0.35, min: 0, max: 0.9, step: 0.01,
    note: 'Pulls points sideways toward the axis too, so it reads as a throat '
        + 'rather than a dent.' });
  const pGoalEye = panel.slider('Dark eye', {
    key: 'goal-eye', value: 0.38, min: 0.05, max: 0.95, step: 0.01,
    note: 'How much of the throat goes black. The funnel piles points toward '
        + 'the axis and additive blending stacks them, so without this the '
        + 'centre is the brightest part of it and there is no hole.' });
  const pGoalArms = panel.slider('Spiral arms', { key: 'goal-arms', value: 3, min: 1, max: 9, step: 1 });
  const pGoalTwist = panel.slider('Spiral twist', { key: 'goal-twist', value: 7, min: 0, max: 24, step: 0.5 });
  const pGoalSpin = panel.slider('Spiral speed', { key: 'goal-spin', value: 1.6, min: 0, max: 8, step: 0.05 });
  const pGoalGlow = panel.slider('Glow', { key: 'goal-glow', value: 1.9, min: 0, max: 6, step: 0.05 });
  const pGoalLift = panel.slider('Spiral contrast', { key: 'goal-lift', value: 1.1, min: 0, max: 3, step: 0.05 });
  const pGoalPeek = panel.slider('Peek from behind', {
    key: 'goal-peek', value: 0.1, min: 0, max: 1, step: 0.01,
    note: 'The cloud is additive and writes no depth, so the far side shows '
        + 'through everything. This is how much of the throat survives that — '
        + 'low enough to be a rumour when it is round the back, and it opens '
        + 'up as it is brought toward you.' });
  const cGoalBody = panel.color('Becomes — body', '#c8402c', { key: 'goal-body-col' });
  const cGoalCrest = panel.color('Becomes — crests', '#ffd9b0', { key: 'goal-crest-col' });
  const cGoalMoving = panel.color('Becomes — when moving', '#ff9a3c', { key: 'goal-moving-col' });
  const pHueStep = panel.slider('Hue step per stage', {
    key: 'hue-step', value: 0.17, min: 0, max: 0.5, step: 0.005,
    note: 'The first transition lands on the three colours above. After that '
        + 'each new stage is the last one rotated by this.' });

  panel.group('Transition');
  const pAimAngle = panel.slider('Counts as centred (deg)', {
    key: 'aim-angle', value: 15, min: 3, max: 45, step: 1 });
  const pAimWide = panel.slider('Starts reacting (deg)', {
    key: 'aim-wide', value: 55, min: 15, max: 120, step: 1,
    note: 'The point brightens and deepens as it comes inside this, so closing '
        + 'in has feedback before it fires.' });
  const pAimSurge = panel.slider('Surge when near', {
    key: 'aim-surge', value: 1.2, min: 0, max: 4, step: 0.05 });
  const pAimHold = panel.slider('Hold to fire (s)', {
    key: 'aim-hold', value: 0.35, min: 0, max: 2, step: 0.05 });
  const pInSecs = panel.slider('Collapse (s)', { key: 'in-secs', value: 0.55, min: 0.1, max: 2, step: 0.05 });
  const pOutSecs = panel.slider('Bloom (s)', { key: 'out-secs', value: 0.95, min: 0.1, max: 3, step: 0.05 });
  const pCollapseDepth = panel.slider('Collapse depth', {
    key: 'collapse-depth', value: 0.96, min: 0.2, max: 0.995, step: 0.005 });
  const pFlash = panel.slider('Flash', { key: 'flash', value: 2.6, min: 0, max: 8, step: 0.05 });

  // --- the motor, arguing ---------------------------------------------------
  panel.group('Haptics');
  const pHaptics = panel.toggle('Drive the motor', true, { key: 'haptics-on' });
  const pHapAmp = panel.slider('Pulse strength', {
    key: 'hap-amp', value: 0.9, min: 0, max: 1, step: 0.01 });
  const pHzAway = panel.slider('Rate turning away (Hz)', {
    key: 'hap-hz-away', value: 7, min: 0.5, max: 14, step: 0.1 });
  const pHzToward = panel.slider('Rate turning toward (Hz)', {
    key: 'hap-hz-toward', value: 1.2, min: 0.2, max: 14, step: 0.1,
    note: 'The motor is the counter-argument: fast and hard when you turn away '
        + 'from the point, slow and soft as you close on it.' });
  const pAnti = panel.slider('How much closing in quiets it', {
    key: 'hap-anti', value: 0.92, min: 0, max: 1, step: 0.01,
    note: '1 = closing at full speed silences the motor entirely.' });
  const pApproachFull = panel.slider('Closing speed that counts as full (deg/s)', {
    key: 'hap-approach-full', value: 110, min: 20, max: 400, step: 5 });
  const pApproachTau = panel.slider('Closing-speed smoothing (s)', {
    key: 'hap-approach-tau', value: 0.14, min: 0.02, max: 1, step: 0.01 });
  const pPulseShape = panel.slider('Pulse shape', {
    key: 'hap-shape', value: 2.2, min: 1, max: 6, step: 0.1,
    note: 'Higher is a shorter, sharper knock inside each cycle.' });
  const pHapFloor = panel.slider('Floor while turning', {
    key: 'hap-floor', value: 0.06, min: 0, max: 0.5, step: 0.01 });
  const pFireBuzz = panel.slider('Buzz through the collapse', {
    key: 'hap-fire', value: 1, min: 0, max: 1, step: 0.01 });

  panel.group('Live');
  panel.readout('turn speed (deg/s)', () => liveTurn.toFixed(0));
  panel.readout('visible', () => bodyVis.toFixed(2));
  panel.readout('goal off-centre (deg)', () => goalAngle.toFixed(0));
  panel.readout('closing (deg/s)', () => approach.toFixed(0));
  panel.readout('motor', () => motorLevel.toFixed(2));
  panel.readout('stage', () => String(stageIdx));
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
  const uField = uniform(new THREE.Matrix3());
  const uDrift = uniform(float(0.02));

  // Colours are driven from the CPU rather than straight off the pickers,
  // because the chain of stages rewrites them: stage 0 mirrors the panel live,
  // every stage after is whatever the last goal was.
  const uBody = uniform(new THREE.Color('#2f5f8f'));
  const uCrest = uniform(new THREE.Color('#eaf4ff'));
  const uMoving = uniform(new THREE.Color('#b06cff'));
  const uGoalCol = uniform(new THREE.Color('#c8402c'));

  const uGoalDir = uniform(new THREE.Vector3(0, 0, -1));
  const uGoalU = uniform(new THREE.Vector3(1, 0, 0));
  const uGoalW = uniform(new THREE.Vector3(0, 1, 0));
  const uGoalMix = uniform(float(1));     // fades the point in after a stage change
  const uAim = uniform(float(0));         // 0..1, how close to centred
  const uGoalOpen = uniform(float(0.1));  // 0..1, how much of the throat is facing you
  const uCollapse = uniform(float(0));
  const uFlash = uniform(float(0));
  const uVis = uniform(float(1));
  const uGoalVis = uniform(float(1));

  // --- geometry -------------------------------------------------------------
  const geometry = buildCloud(MAX_POINTS);

  const corner = attribute('aCorner', 'vec2');
  const seed = attribute('aSeed', 'float');
  const dir = normalize(positionLocal);
  const fieldDir = normalize(uField.mul(dir));

  // --- the goal region, in screen space -------------------------------------
  // Everything about the point is a function of `dir` and `uGoalDir`, both in
  // the space the camera is looking down, so "aimed at the eye" is literally
  // uGoalDir pointing at the camera. No field lookup involved.
  const gEdge = cos(pGoalSize.mul(D2R));
  const gHole = saturate(dot(dir, uGoalDir).sub(gEdge).div(float(1).sub(gEdge)))
    .mul(uGoalMix);                       // 0 at the rim, 1 at the throat
  const gFalloff = pow(gHole, float(1.6));
  const gSurge = float(1).add(uAim.mul(pAimSurge));
  const gPull = gFalloff.mul(pGoalDepth).mul(gSurge);
  const gPhi = atan(dot(dir, uGoalW), dot(dir, uGoalU));
  const gSwirl = sin(gPhi.mul(pGoalArms).sub(gHole.mul(pGoalTwist))
    .sub(time.mul(pGoalSpin))).mul(0.5).add(0.5);
  const gCore = smoothstep(pGoalEye, float(1.0), gHole);   // the dark eye of it

  // Where this point sits, radially, before billboarding.
  const radius = Fn(() => {
    const drift = time.mul(pUndSpeed);
    const field = mx_fractal_noise_float(
      fieldDir.mul(pUndDetail).add(vec3(0.0, drift, drift.mul(0.45))), 3, 2.0, 0.5);

    const shell = seed.sub(0.5).mul(pShell);

    const phi = atan(dot(fieldDir, uW), dot(fieldDir, uU));
    const along = dot(fieldDir, uAxis);
    const belt = pow(clamp(float(1).sub(along.mul(along)), 0, 1), pRipBelt);
    const wave = sin(phi.mul(pRipCount).add(uPhase.mul(uDir)))
      .mul(belt).mul(uRipple).mul(pRipDepth);

    return float(1).add(shell).add(field.mul(uUndDepth)).add(wave).sub(gPull);
  })();

  const flowT = time.mul(pFlowSpeed);
  const flow = mx_fractal_noise_vec3(
    fieldDir.mul(pFlowScale).add(vec3(flowT, flowT.mul(0.7), flowT.mul(1.3))), 2, 2.0, 0.5)
    .mul(uDrift);

  // Inside the point, lean the whole direction toward its axis as well: a
  // purely radial pull is a dent, and a dent does not read as something being
  // swallowed.
  const dirHole = normalize(mix(dir, uGoalDir, saturate(gFalloff.mul(pGoalConverge))));

  // The collapse is the same scale applied to everything, so the cloud draws
  // itself down to a point and comes back rather than deforming.
  const collapseScale = float(1).sub(uCollapse.mul(pCollapseDepth));
  const centreLocal = dirHole.mul(radius).add(flow).mul(collapseScale);

  // --- billboard ------------------------------------------------------------
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
  const crest = saturate(radius.sub(1.0).mul(4.0));

  const dirWorld = normalize(modelWorldMatrix.mul(vec4(dir, 0.0)).xyz);
  const toEye = normalize(cameraPosition.sub(modelWorldMatrix.mul(vec4(centreLocal, 1.0)).xyz));
  const rim = float(1).sub(abs(dot(dirWorld, toEye)));

  material.colorNode = Fn(() => {
    const base = mix(uBody, uCrest, crest);
    const tinted = mix(base, uMoving, uSpin.mul(pHeat));
    // uVis is the whole "only while moving" idea: multiplying the colour, not
    // the opacity, means additive blending takes it all the way to nothing.
    const bodyCol = tinted.mul(float(1).add(rim.mul(pRimGlow))).mul(uVis);

    const holeCol = uGoalCol
      .mul(pGoalGlow)
      .mul(float(1).add(gSwirl.mul(pGoalLift)))
      .mul(float(1).sub(gCore.mul(0.99)))
      .mul(gSurge)
      .mul(uGoalOpen)
      .mul(uGoalVis);

    const out = mix(bodyCol, holeCol, saturate(gHole.mul(1.6)));
    return vec4(out.mul(float(1).add(uFlash)), 1.0);
  })();

  const d = length(corner);
  const disc = smoothstep(1.0, mix(0.95, 0.0, pSoft), d);
  const other = fract(seed.mul(91.7));
  const twinkle = mix(float(1), pow(other, float(2.5)).mul(2.4).add(0.12), pSparkle);

  // The eye is taken out of opacity as well as colour. Dimming the colour
  // alone is not enough: the funnel piles points onto the axis and additive
  // blending stacks a hundred of them, so a hundredth of the brightness each
  // still adds up to the brightest thing on screen.
  material.opacityNode = disc.mul(disc).mul(twinkle).mul(pBright)
    .mul(float(1).sub(gCore.mul(0.98)));

  const cloud = new THREE.Mesh(geometry, material);
  cloud.frustumCulled = false;
  scene.add(cloud);

  // --- device ---------------------------------------------------------------
  const motion = createMotion(orb, { delayMs: pDelay.value });
  const response = createResponse();
  const smoothed = new THREE.Quaternion();
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

  // --- the goal -------------------------------------------------------------
  // `home` here is where the point belongs when the orb is set down: on the
  // far side, tilted up until it just breaks the top edge.
  const goalHome = new THREE.Vector3();
  const goalBody = new THREE.Vector3();     // fixed to the device
  const goalScreen = new THREE.Vector3();   // attitude * goalBody, eased
  const goalTarget = new THREE.Vector3();
  const goalU = new THREE.Vector3(1, 0, 0);
  const goalW = new THREE.Vector3(0, 1, 0);
  const viewDir = stage.camera.position.clone().normalize();
  const invAtt = new THREE.Quaternion();

  let lastTilt = null;
  function refreshGoalHome() {
    lastTilt = pGoalTilt.value;
    const t = lastTilt * D2R;
    goalHome.set(0, Math.sin(t), -Math.cos(t)).normalize();
  }
  refreshGoalHome();
  goalBody.copy(goalHome);
  goalScreen.copy(goalHome);

  function updateGoalBasis() {
    goalU.set(0, 1, 0);
    goalU.sub(scratch.copy(goalScreen).multiplyScalar(goalU.dot(goalScreen)));
    if (goalU.lengthSq() < 1e-6) goalU.set(1, 0, 0)
      .sub(scratch.copy(goalScreen).multiplyScalar(goalScreen.x));
    goalU.normalize();
    goalW.crossVectors(goalScreen, goalU);
  }

  // --- the chain of stages --------------------------------------------------
  // Stage 0 is whatever the pickers say, so the orb starts in exactly the
  // colours that were tuned. Every stage after is the previous goal, and the
  // next goal is that rotated round the wheel.
  const curBody = new THREE.Color();
  const curCrest = new THREE.Color();
  const curMoving = new THREE.Color();
  const goalBodyCol = new THREE.Color();
  const goalCrestCol = new THREE.Color();
  const goalMovingCol = new THREE.Color();
  const hsl = { h: 0, s: 0, l: 0 };
  let stageIdx = 0;

  const rotateHue = (c, step) => {
    c.getHSL(hsl);
    c.setHSL((hsl.h + step) % 1, hsl.s, hsl.l);
  };

  function syncStageZero() {
    curBody.copy(cCore.value);
    curCrest.copy(cCrest.value);
    curMoving.copy(cMoving.value);
    goalBodyCol.copy(cGoalBody.value);
    goalCrestCol.copy(cGoalCrest.value);
    goalMovingCol.copy(cGoalMoving.value);
  }
  syncStageZero();

  function advanceStage() {
    curBody.copy(goalBodyCol);
    curCrest.copy(goalCrestCol);
    curMoving.copy(goalMovingCol);
    const step = pHueStep.value;
    rotateHue(goalBodyCol, step);
    rotateHue(goalCrestCol, step);
    rotateHue(goalMovingCol, step);
    stageIdx++;

    // A fresh point, put back where it belongs relative to the eye rather than
    // relative to the device, so the same gesture is asked for again no matter
    // how the orb happens to be held right now.
    refreshGoalHome();
    goalBody.copy(goalHome).applyQuaternion(invAtt.copy(smoothed).invert());
    goalMix = 0;
    armed = false;
    settle = 0.4;
  }

  addEventListener('keydown', (e) => {
    const el = e.target;
    if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
    const k = e.key.toLowerCase();
    if (k === 'r') {
      stageIdx = 0;
      syncStageZero();
      refreshGoalHome();
      goalBody.copy(goalHome);
      goalMix = 0;
      armed = false;
      settle = 0.4;
    } else if (k === 't' && phaseState === 'idle') {
      // Fires the transition by hand. The collapse is most of what there is to
      // look at and it is a nuisance to have to earn it every time -- and with
      // no orb plugged in there is no way to aim at all.
      phaseState = 'in';
      stateT = 0;
      dwell = 0;
    }
  });

  // --- running state --------------------------------------------------------
  let phase = 0, ripple = 0, spin = 0, stirred = 0;
  let liveTurn = 0;
  let lastEpoch = -1;
  let started = false, hadHaptics = false;

  let heldAmt = 0, moveVis = 0, bodyVis = 1, goalVis = 1;
  let goalAngle = 180, prevAngle = 180, approach = 0, aimNear = 0;
  // Re-placing the point moves it without the wrist moving, and the closing
  // speed is a difference over time -- so a placement reads as an enormous turn
  // and the motor answers a gesture nobody made. Deaf for as long as the glide
  // to the new spot takes.
  let settle = 0;
  let dwell = 0, armed = false, goalMix = 1, goalOpen = 0.1;
  let phaseState = 'idle', stateT = 0, collapse = 0;
  let hapPhase = 0, motorLevel = 0;

  stage.onUpdate((dt) => {
    motion.delayMs = pDelay.value;
    const m = motion.sample();
    const relevelled = m.valid && (!started || m.epoch !== lastEpoch);

    if (m.valid) {
      if (relevelled) {
        smoothed.copy(m.quaternion);
        lastEpoch = m.epoch;
        started = true;
        // Set down means the secret goes back to the far side. Only the
        // target moves — the eased direction glides there over a few frames.
        refreshGoalHome();
        goalBody.copy(goalHome);
        settle = 0.4;
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
      stirred = response.update(liveTurn, dt);
      ripple = Math.max(ripple * Math.exp(-dt / Math.max(pRipSettle.value, 0.05)), norm);
    }

    phase += (0.25 + spin * pRipSpeed.value) * dt;
    geometry.setDrawRange(0, Math.floor(pCount.value) * 6);

    // --- where the point is now ---------------------------------------------
    // Dragging the tilt slider has to show something, and the only honest
    // place to put the point while tuning is where it would be if the orb had
    // just been set down.
    if (pGoalTilt.value !== lastTilt) {
      refreshGoalHome();
      goalBody.copy(goalHome).applyQuaternion(invAtt.copy(smoothed).invert());
      settle = 0.4;
    }

    goalTarget.copy(goalBody).applyQuaternion(smoothed).normalize();
    goalScreen.lerp(goalTarget, 1 - Math.exp(-dt * pFollow.value)).normalize();
    updateGoalBasis();

    prevAngle = goalAngle;
    goalAngle = Math.acos(Math.max(-1, Math.min(1, goalScreen.dot(viewDir)))) * DEG;

    // Positive = the point is being brought toward the eye. This, and only
    // this, is what the motor argues with.
    if (settle > 0) {
      settle -= dt;
      approach = 0;
    } else {
      const rawApproach = (prevAngle - goalAngle) / Math.max(dt, 1e-4);
      approach += (rawApproach - approach) * (1 - Math.exp(-dt / Math.max(pApproachTau.value, 0.02)));
    }

    aimNear = smooth01(ramp(pAimWide.value - goalAngle, 0, Math.max(pAimWide.value - pAimAngle.value, 1)));
    // Fully open once it is inside the reacting angle, a rumour by the time it
    // is round the back. Squared, because a linear ramp still reads as a lamp
    // shining through the far side.
    const openness = Math.pow(
      smooth01(ramp(150 - goalAngle, 0, Math.max(150 - pAimWide.value, 1))), 1.6);
    goalOpen = pGoalPeek.value + (1 - pGoalPeek.value) * openness;
    goalMix += (1 - goalMix) * (1 - Math.exp(-dt * 2.2));

    // --- fire ---------------------------------------------------------------
    if (phaseState === 'idle') {
      if (!armed && goalAngle > pAimWide.value) armed = true;
      if (armed && goalAngle < pAimAngle.value) {
        dwell += dt;
        if (dwell >= pAimHold.value) { phaseState = 'in'; stateT = 0; dwell = 0; }
      } else {
        dwell = Math.max(0, dwell - dt * 2);
      }
    } else {
      stateT += dt;
      if (phaseState === 'in') {
        const k = Math.min(stateT / Math.max(pInSecs.value, 0.05), 1);
        collapse = k * k * k;                       // accelerates into the throat
        if (k >= 1) { advanceStage(); phaseState = 'out'; stateT = 0; }
      } else {
        const k = Math.min(stateT / Math.max(pOutSecs.value, 0.05), 1);
        const e = 1 - Math.pow(1 - k, 3);           // and eases back out
        collapse = 1 - e;
        if (k >= 1) { phaseState = 'idle'; collapse = 0; }
      }
    }

    // --- only visible while moving ------------------------------------------
    const heldTarget = orb.latest && orb.latest.held > 0.5 ? 1 : 0;
    heldAmt += (heldTarget - heldAmt) * (1 - Math.exp(-dt * 6));

    const moveTarget = smooth01(ramp(liveTurn, pVisMin.value, pVisFull.value));
    const tau = moveTarget > moveVis ? pVisAttack.value : pVisRelease.value;
    moveVis += (moveTarget - moveVis) * (1 - Math.exp(-dt / Math.max(tau, 0.01)));

    const active = pDimFloor.value + (1 - pDimFloor.value) * moveVis;
    bodyVis = 1 + (active - 1) * heldAmt;
    const goalActive = Math.max(active, pGoalFloor.value);
    goalVis = 1 + (goalActive - 1) * heldAmt;

    // --- uniforms -----------------------------------------------------------
    lookup.copy(smoothed).invert().multiply(m.field);
    lookupMat.setFromMatrix4(lookupM4.makeRotationFromQuaternion(lookup));
    uField.value.copy(lookupMat);
    uAxis.value.copy(axis).applyMatrix3(lookupMat);
    uU.value.copy(basisU).applyMatrix3(lookupMat);
    uW.value.copy(basisW).applyMatrix3(lookupMat);
    uPhase.value = phase;
    uRipple.value = pRipples.value ? ripple : 0;
    uSpin.value = spin;
    uDir.value = pAgainst.value ? 1 : -1;
    uUndDepth.value = pUndRest.value + (pUndMoving.value - pUndRest.value) * stirred;
    uDrift.value = pFlowRest.value + (pFlowMoving.value - pFlowRest.value) * stirred;

    if (stageIdx === 0) syncStageZero();
    uBody.value.copy(curBody);
    uCrest.value.copy(curCrest);
    uMoving.value.copy(curMoving);
    uGoalCol.value.copy(goalBodyCol);

    uGoalDir.value.copy(goalScreen);
    uGoalU.value.copy(goalU);
    uGoalW.value.copy(goalW);
    uGoalMix.value = goalMix;
    uAim.value = phaseState === 'idle' ? aimNear : 1;
    uGoalOpen.value = phaseState === 'idle' ? goalOpen : 1;
    uCollapse.value = collapse;
    uFlash.value = pFlash.value * Math.pow(collapse, 3);
    uVis.value = bodyVis;
    uGoalVis.value = goalVis;

    // --- the motor, arguing -------------------------------------------------
    if (pHaptics.value) {
      if (phaseState !== 'idle') {
        // Through the collapse it stops arguing and just confirms.
        motorLevel = pFireBuzz.value * Math.max(collapse, 0.15);
        hapPhase = 0;
      } else {
        // 0 = turning away or standing still, 1 = closing on the point fast.
        const reward = clamp01(approach / Math.max(pApproachFull.value, 1));
        const hz = pHzAway.value + (pHzToward.value - pHzAway.value) * reward;
        hapPhase += hz * dt;
        const wave = Math.pow(0.5 + 0.5 * Math.sin(hapPhase * Math.PI * 2), pPulseShape.value);
        // `stirred` is the shared response curve, so how much turning counts
        // as turning is still decided once, in the Motion tool.
        const gate = Math.max(stirred, moveVis * 0.35);
        const amp = pHapAmp.value * gate * (1 - reward * pAnti.value);
        motorLevel = clamp01(amp * (pHapFloor.value + (1 - pHapFloor.value) * wave));
      }
      orb.setHaptic(motorLevel);
      hadHaptics = true;
    } else if (hadHaptics) {
      motorLevel = 0;
      orb.releaseHaptic();
      hadHaptics = false;
    }

    hud.update(stage);
    panel.tick();
  });

  orb.connect();
}

main().catch(mountFatal);
