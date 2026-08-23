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
    key: 'goal-size-v3', value: 32, min: 4, max: 60, step: 1 });
  const pGoalDepth = panel.slider('Suck-in depth', {
    key: 'goal-depth-v3', value: 0.85, min: 0, max: 1, step: 0.01,
    note: 'How far the points inside it are dragged toward the core. This is '
        + 'the depth at rest; aiming multiplies it by the surge, and the '
        + 'result is saturated, so it can be run hard without inverting.' });
  const pGoalConverge = panel.slider('Funnel', {
    key: 'goal-converge-v3', value: 0.6, min: 0, max: 0.9, step: 0.01,
    note: 'Pulls points sideways toward the axis too, so it reads as a throat '
        + 'rather than a dent.' });
  const pGoalGather = panel.slider('Draws points in from (x size)', {
    key: 'goal-gather', value: 2.2, min: 1, max: 2.5, step: 0.05,
    note: 'The funnel reaches well outside the coloured disc and leans the '
        + 'surrounding points toward the axis too. That is what actually makes '
        + 'it denser: the points have to come from somewhere, so the throat '
        + 'thickens and the field around it thins.' });
  const pGoalDensity = panel.slider('Density compensation', {
    key: 'goal-density', value: 1.3, min: 0, max: 4, step: 0.05,
    note: 'Dims each point by how much the funnel crowded it together. 2 is '
        + 'the physical value -- area goes as the square -- and holds the '
        + 'throat at exactly the brightness of its surroundings, which is one '
        + 'notch too honest: it should read as hotter than the field it sits '
        + 'in. Under 2 leaves some of the pile-up in. 0 is a lamp.' });
  const pGoalEye = panel.slider('Dark eye', {
    key: 'goal-eye-v2', value: 0.72, min: 0.05, max: 0.99, step: 0.01,
    note: 'Where the throat goes black. Something has to, or the funnel piles '
        + 'points onto the axis and additive blending makes the centre the '
        + 'brightest part of it. But this coordinate climbs fast -- at 0.38 it '
        + 'erased everything inside 15 of 26 degrees, which is the whole wall '
        + 'of the funnel. Keep it high: black the pupil, not the throat.' });
  const pGoalArms = panel.slider('Spiral arms', { key: 'goal-arms', value: 3, min: 1, max: 9, step: 1 });
  const pGoalTwist = panel.slider('Spiral twist', { key: 'goal-twist', value: 7, min: 0, max: 24, step: 0.5 });
  const pGoalSpin = panel.slider('Spiral speed', { key: 'goal-spin', value: 1.6, min: 0, max: 8, step: 0.05 });
  const pGoalGlow = panel.slider('Glow', {
    key: 'goal-glow-v3', value: 3.1, min: 0, max: 8, step: 0.05,
    note: 'Density compensation takes real brightness out of the throat, so '
        + 'this carries more of it than it used to.' });
  const pGoalLift = panel.slider('Spiral contrast', { key: 'goal-lift', value: 1.1, min: 0, max: 3, step: 0.05 });
  const pGoalPeek = panel.slider('Peek from behind', {
    key: 'goal-peek-v2', value: 0.15, min: 0, max: 1, step: 0.01,
    note: 'The cloud is additive and writes no depth, so the far side shows '
        + 'through everything. This is how much of the throat survives that — '
        + 'low enough to be a rumour when it is round the back, and it opens '
        + 'up as it is brought toward you.' });
  // One colour per stage, not three. Body and "when moving" are derived from
  // it below, so every stage keeps the shape of the one that was tuned by
  // hand: a body that is almost black and crests that carry all the colour.
  const cBecomes = panel.color('Becomes', '#d8452c', { key: 'becomes-col' });
  const pBodyDark = panel.slider('Body darkness', {
    key: 'body-dark', value: 0.12, min: 0.01, max: 0.6, step: 0.01,
    note: 'What the stage colour is multiplied down to for the bulk of the '
        + 'cloud. Low: almost black, carrying just enough of the colour to '
        + 'read as its shadow.' });
  const pMovingHue = panel.slider('Moving-colour hue shift', {
    key: 'moving-hue', value: 0.06, min: -0.5, max: 0.5, step: 0.005 });
  const pMovingLift = panel.slider('Moving-colour lift', {
    key: 'moving-lift', value: 0.5, min: 0, max: 1, step: 0.01 });
  const pRestLift = panel.slider('Set-down lift', {
    key: 'rest-lift', value: 0.5, min: 0, max: 1, step: 0.01,
    note: 'A body that is almost black is invisible at rest -- there is barely '
        + 'any crest to carry the colour until something moves. Set down, the '
        + 'derived stages lift this far toward their crest colour so the orb '
        + 'is there to look at again. The first stage is never touched: it is '
        + 'what was tuned by hand, and it already works at rest.' });
  const pHueStep = panel.slider('Hue step per stage', {
    key: 'hue-step', value: 0.17, min: 0, max: 0.5, step: 0.005,
    note: 'The first transition lands on the colour above. After that each new '
        + 'stage is the last one rotated by this.' });

  // --- when the hole stops playing fair -------------------------------------
  panel.group('Evasion');
  const pEvadeAfter = panel.slider('Catches before it backs away', {
    key: 'evade-after', value: 2, min: 0, max: 6, step: 1,
    note: 'After this many turns won at the hole, it stops being catchable and '
        + 'starts keeping its distance. Winning at the spot puts it back to '
        + 'nought, so the two errands take it in turns.' });
  const pFleeFrom = panel.slider('Starts backing away at (deg)', {
    key: 'flee-from', value: 75, min: 20, max: 150, step: 5 });
  const pFleeFloor = panel.slider('Never closer than (deg)', {
    key: 'flee-floor', value: 45, min: 25, max: 120, step: 1,
    note: 'A hard stop, not a tendency — it is pushed back out the instant it '
        + 'is inside. Keep it well clear of the aim window (which opens at 20 '
        + 'and slackens to ~34) or a fast enough turn could still land it.' });
  const pFleeSpeed = panel.slider('Backs away at (deg/s)', {
    key: 'flee-speed', value: 130, min: 20, max: 400, step: 5,
    note: 'How fast it slides once you are inside. The hard stop is what '
        + 'guarantees it cannot be cornered; this is what makes the retreat '
        + 'legible as a retreat rather than a wall.' });

  panel.group('Transition');
  const pAimAngle = panel.slider('Counts as centred (deg)', {
    key: 'aim-angle-v2', value: 20, min: 3, max: 45, step: 1 });
  const pAimWide = panel.slider('Starts reacting (deg)', {
    key: 'aim-wide', value: 55, min: 15, max: 120, step: 1,
    note: 'The point brightens and deepens as it comes inside this, so closing '
        + 'in has feedback before it fires.' });
  const pAimSurge = panel.slider('Surge when near', {
    key: 'aim-surge', value: 1.2, min: 0, max: 4, step: 0.05 });
  const pAimSlack = panel.slider('Slack once inside (x)', {
    key: 'aim-slack', value: 1.7, min: 1, max: 3, step: 0.05,
    note: 'How much wider the window gets once you are in it. Without this the '
        + 'hold almost never completes.' });
  const pAimHold = panel.slider('Hold to fire (s)', {
    key: 'aim-hold', value: 0.35, min: 0, max: 2, step: 0.05 });
  const pInSecs = panel.slider('Collapse (s)', { key: 'in-secs', value: 0.55, min: 0.1, max: 2, step: 0.05 });
  const pOutSecs = panel.slider('Bloom (s)', { key: 'out-secs', value: 0.95, min: 0.1, max: 3, step: 0.05 });
  const pCollapseDepth = panel.slider('Collapse depth', {
    key: 'collapse-depth', value: 0.96, min: 0.2, max: 0.995, step: 0.005 });
  const pFlash = panel.slider('Flash', { key: 'flash', value: 2.6, min: 0, max: 8, step: 0.05 });

  // --- the second errand ----------------------------------------------------
  // The hand is sent somewhere the eye is given no reason to go. Nothing marks
  // it; the only way to find it is to notice the pulse quickening.
  panel.group('The spot');
  const pSpotSep = panel.slider('Keep clear of the goal (deg)', {
    key: 'spot-sep', value: 80, min: 20, max: 170, step: 5,
    note: 'How far the motor\'s errand is placed from the eye\'s. Wide enough '
        + 'that the two genuinely pull against each other.' });
  const pSpotFromStart = panel.slider('Never starts closer than (deg)', {
    key: 'spot-from-start', value: 85, min: 40, max: 140, step: 5,
    note: 'Clearance from where the orb faces you when it is set down. This '
        + 'has to stay well outside "counts as found", or the spot is already '
        + 'half-discovered before anything is turned.' });
  const pSpotReach = panel.slider('Felt from (deg)', {
    key: 'spot-reach', value: 130, min: 30, max: 180, step: 5,
    note: 'Outside this the pulse is at its slowest and weakest. Inside, both '
        + 'climb the closer the spot comes to facing you.' });
  const pSpotFound = panel.slider('Counts as found (deg)', {
    key: 'spot-found-v2', value: 34, min: 5, max: 70, step: 1,
    note: 'A scalar motor gives no direction, only warmth, so the target has '
        + 'to be broad enough to stumble into. Too tight and it cannot be '
        + 'found at all.' });
  const pStillTurn = panel.slider('Counts as held still (deg/s)', {
    key: 'spot-still', value: 25, min: 5, max: 90, step: 1 });
  const pPulseAfter = panel.slider('Hold before the colour joins in (s)', {
    key: 'spot-after', value: 1.6, min: 0, max: 6, step: 0.1,
    note: 'Standing on the spot keeps the motor going even though nothing is '
        + 'moving — the one place that rule is broken. Hold it this long and '
        + 'the body starts pulsing on the same beat, which is the only '
        + 'confirmation there is.' });
  const pPulseFade = panel.slider('Colour pulse fades in over (s)', {
    key: 'spot-fade', value: 1.2, min: 0.1, max: 5, step: 0.1 });
  const pSpotFire = panel.slider('Hold past the pulse to fire (s)', {
    key: 'spot-fire', value: 2.5, min: 0.5, max: 8, step: 0.1,
    note: 'Keep standing on the spot this long after the colour joins in and '
        + 'the orb turns over from here instead. This is the second route, '
        + 'and once the hole starts backing away it is the only one — so the '
        + 'colour pulse stops being a confirmation and becomes a countdown.' });
  const pFoundBright = panel.slider('Colour pulse brightness', {
    key: 'spot-bright', value: 0.85, min: 0, max: 1, step: 0.01,
    note: 'This overrides the fade-to-nothing, so the body flashes back into '
        + 'view on every beat while the orb sits perfectly still.' });
  const pFoundTint = panel.slider('Colour pulse tint', {
    key: 'spot-tint', value: 0.8, min: 0, max: 1, step: 0.01,
    note: 'How far each flash pushes toward the "when moving" colour.' });

  // --- the motor, arguing ---------------------------------------------------
  panel.group('Haptics');
  const pHaptics = panel.toggle('Drive the motor', true, { key: 'haptics-on' });
  const pHzFar = panel.slider('Rate far from the spot (Hz)', {
    key: 'hap-hz-far', value: 1.1, min: 0.2, max: 14, step: 0.1 });
  const pHzNear = panel.slider('Rate on the spot (Hz)', {
    key: 'hap-hz-near', value: 8, min: 0.2, max: 14, step: 0.1 });
  const pAmpFar = panel.slider('Strength far from the spot', {
    key: 'hap-amp-far-v2', value: 0.6, min: 0, max: 1, step: 0.01 });
  const pAmpNear = panel.slider('Strength on the spot', {
    key: 'hap-amp-near', value: 1, min: 0, max: 1, step: 0.01,
    note: 'Rate and strength both climb toward the spot. Getting warmer is the '
        + 'whole signal, so this wants plenty of range under it.' });
  const pPulseShape = panel.slider('Pulse shape', {
    key: 'hap-shape-v2', value: 1.5, min: 1, max: 6, step: 0.1,
    note: 'Higher is a shorter, sharper knock inside each cycle — and a '
        + 'shorter knock is a weaker one, because an ERM needs 40-60 ms just '
        + 'to spin up. Low keeps the pulse fat enough to actually arrive.' });
  const pHapFloor = panel.slider('Floor between knocks', {
    key: 'hap-floor-v2', value: 0.2, min: 0, max: 0.5, step: 0.01,
    note: 'Keeps the motor turning between knocks, so each one starts from a '
        + 'spinning rotor rather than a standstill.' });
  const pHapMoveFull = panel.slider('Turn that fully wakes the motor (deg/s)', {
    key: 'hap-move-full', value: 45, min: 10, max: 200, step: 5,
    note: 'Deliberately not the ramp the picture uses. Searching for the spot '
        + 'is done with slow, hunting turns, and on the visual ramp -- which '
        + 'wants 90 deg/s -- those barely open the gate at all. That, rather '
        + 'than the strength, is what made it feel like nothing was there.' });
  const pMoveGate = panel.slider('How much stillness quiets it', {
    key: 'hap-move-gate-v2', value: 0.85, min: 0, max: 1, step: 0.01,
    note: '1 = the motor says nothing unless the orb is being turned. Standing '
        + 'on the spot overrides this whatever it is set to — which is what '
        + 'makes arriving there unmistakable.' });
  const pYesStrength = panel.slider('Reward strength', {
    key: 'hap-yes', value: 1, min: 0, max: 1, step: 0.01,
    note: 'Winning at the spot is the hand\'s errand, so it gets a swell that '
        + 'rises and falls with the collapse — the opposite shape to the two '
        + 'flat knocks the eye\'s win earns.' });
  const pNoStrength = panel.slider('Refusal strength', {
    key: 'hap-no-amp', value: 1, min: 0, max: 1, step: 0.01,
    note: 'Reaching the collapsing point is the wrong answer as far as the '
        + 'hand is concerned, so it gets two flat refusals rather than a '
        + 'reward. No, no.' });
  const pNoLen = panel.slider('Refusal pulse (s)', {
    key: 'hap-no-len', value: 0.22, min: 0.05, max: 0.6, step: 0.01 });
  const pNoGap = panel.slider('Refusal gap (s)', {
    key: 'hap-no-gap', value: 0.14, min: 0.02, max: 0.5, step: 0.01 });

  panel.group('Live');
  panel.readout('turn speed (deg/s)', () => liveTurn.toFixed(0));
  // How far the orb is from neutral. Should drop to ~0 on every transition
  // and on every set-down; anything else means a re-level did not take.
  panel.readout('attitude (deg)', () =>
    (2 * Math.acos(Math.min(1, Math.abs(smoothed.w))) * DEG).toFixed(0));
  panel.readout('visible', () => bodyVis.toFixed(2));
  panel.readout('goal off-centre (deg)', () => goalAngle.toFixed(0));
  panel.readout('spot off-centre (deg)', () => spotAngle.toFixed(0));
  panel.readout('held on the spot (s)', () => foundHold.toFixed(1));
  panel.readout('motor', () => motorLevel.toFixed(2));
  panel.readout('hole caught', () => goalWins + (evading ? ' — backing away' : ''));
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
  const uPulse = uniform(float(0));       // the colour pulse, on the motor's beat

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
  // Saturated, and applied as a fraction of the radius rather than subtracted
  // from it. As a subtraction, depth x surge can exceed the radius itself
  // (0.5 x 2.2), which pushes the throat's centre through the origin and out
  // the far side -- so the hole appears to vanish at the moment it is centred,
  // which is exactly when it matters most.
  const gPull = saturate(gFalloff.mul(pGoalDepth).mul(gSurge));
  const gPhi = atan(dot(dir, uGoalW), dot(dir, uGoalU));
  const gSwirl = sin(gPhi.mul(pGoalArms).sub(gHole.mul(pGoalTwist))
    .sub(time.mul(pGoalSpin))).mul(0.5).add(0.5);
  const gCore = smoothstep(pGoalEye, float(1.0), gHole);   // the dark eye of it

  // A second, wider cone that only moves points -- it has no colour of its
  // own. Everything inside it leans toward the axis, so the throat is fed from
  // the surrounding field instead of being made only of the points that
  // happened to start there.
  const gWideEdge = cos(pGoalSize.mul(pGoalGather).mul(D2R));
  const gWide = saturate(dot(dir, uGoalDir).sub(gWideEdge).div(float(1).sub(gWideEdge)))
    .mul(uGoalMix);

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

    const rBase = float(1).add(shell).add(field.mul(uUndDepth)).add(wave);
    return rBase.mul(float(1).sub(gPull.mul(0.96)));
  })();

  const flowT = time.mul(pFlowSpeed);
  const flow = mx_fractal_noise_vec3(
    fieldDir.mul(pFlowScale).add(vec3(flowT, flowT.mul(0.7), flowT.mul(1.3))), 2, 2.0, 0.5)
    .mul(uDrift);

  // Inside the point, lean the whole direction toward its axis as well: a
  // purely radial pull is a dent, and a dent does not read as something being
  // swallowed.
  // How hard this point was squeezed toward the axis. Kept as its own value
  // because the shading has to undo it: a mix of `t` toward a point shrinks
  // the angular scale by about (1-t), so the solid angle -- and with it the
  // on-screen density -- goes as (1-t)^2. Left uncompensated, the funnel looks
  // right from the side and becomes a solid blob end-on, which is exactly the
  // view it is aimed from.
  const gSqueeze = saturate(pow(gWide, float(1.8)).mul(pGoalConverge));
  const dirHole = normalize(mix(dir, uGoalDir, gSqueeze));

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
    // The colour pulse rides the same beat as the motor and pushes the same
    // way movement does, so standing on the spot looks like being moved.
    const tinted = mix(base, uMoving, saturate(uSpin.mul(pHeat).add(uPulse.mul(pFoundTint))));
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
    .mul(float(1).sub(gCore.mul(0.98)))
    .mul(pow(saturate(float(1).sub(gSqueeze)), pGoalDensity));

  const cloud = new THREE.Mesh(geometry, material);
  cloud.frustumCulled = false;
  scene.add(cloud);

  // --- device ---------------------------------------------------------------
  // No re-levelling. Up comes from gravity and never moves, so a turn of the
  // wrist maps to the same movement on screen from every pose -- which is the
  // whole of what was wrong before. Setting the orb down changes nothing now;
  // heading is declared with `h`, at a moment that carries intent.
  const motion = createMotion(orb, { delayMs: pDelay.value, relevel: false });
  const response = createResponse();
  const smoothed = new THREE.Quaternion();
  // The whole lookup, now that the frame never moves: L = A^-1. A feature at
  // field coordinate p lands on screen at A p and turns by exactly the wrist
  // rotation -- the same as the hole, which is placed as A * goalBody. There is
  // nothing left to compensate, so the compensation is gone: no `field`, no
  // conjugation, and none of the drift that came with it.
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

  // --- the spot the motor is steering toward --------------------------------
  // Placed at random rather than opposite the goal: a fixed relationship would
  // be learnable in one sitting, and then the conflict is just a rule the
  // participant is following rather than two pulls being weighed.
  const spotHome = new THREE.Vector3();
  const spotBody = new THREE.Vector3();
  const spotScreen = new THREE.Vector3();
  const spotTarget = new THREE.Vector3();
  const spotPick = new THREE.Vector3();
  const fleeAxis = new THREE.Vector3();
  const fleeQ = new THREE.Quaternion();

  function placeSpot() {
    for (let i = 0; i < 128; i++) {
      spotPick.randomDirection();
      if (spotPick.angleTo(goalHome) * DEG < pSpotSep.value) continue;
      if (spotPick.angleTo(viewDir) * DEG < pSpotFromStart.value) continue;
      spotHome.copy(spotPick);
      return;
    }
    // A large separation leaves very little sphere to land on, so rejection
    // sampling can come up empty. Directly opposite the goal always satisfies
    // it, and is where the conflict is sharpest anyway.
    spotHome.copy(goalHome).negate();
  }
  placeSpot();
  spotBody.copy(spotHome);
  spotScreen.copy(spotHome);

  // Both errands, placed against the view as it is right now: the hole on the
  // far side and tilted up until it just crests the top, the spot somewhere
  // random and well out of reach. Nothing here reads the orb's pose except
  // through `smoothed`, so it lands correctly however the orb is being held.
  function placeErrands() {
    refreshGoalHome();
    invAtt.copy(smoothed).invert();
    goalBody.copy(goalHome).applyQuaternion(invAtt);
    placeSpot();
    spotBody.copy(spotHome).applyQuaternion(invAtt);
    foundHold = 0;
  }

  // --- the chain of stages --------------------------------------------------
  // Stage 0 is whatever the pickers say, so the orb starts in exactly the
  // colours that were tuned. Every stage after is the previous goal, and the
  // next goal is that rotated round the wheel.
  const curBody = new THREE.Color();
  const curCrest = new THREE.Color();
  const curMoving = new THREE.Color();
  const nextCol = new THREE.Color();      // the vivid colour the orb will become
  const shownBody = new THREE.Color();    // curBody, lifted when set down
  const hsl = { h: 0, s: 0, l: 0 };
  // Manipulated in sRGB rather than the working space: these numbers are the
  // ones the picker showed, so halving a lightness does what it looks like it
  // should. In linear space the same arithmetic lands somewhere else.
  const SRGB = THREE.SRGBColorSpace;
  let stageIdx = 0;

  const rotateHue = (c, step) => {
    c.getHSL(hsl, SRGB);
    c.setHSL((hsl.h + step + 1) % 1, hsl.s, hsl.l, SRGB);
  };

  // One colour in, three out. The crests carry it whole and the body is a near
  // black holding just enough of it to read as its shadow -- the shape the
  // first stage was tuned into by hand, kept for every stage after.
  function deriveStage(col) {
    col.getHSL(hsl, SRGB);
    curCrest.copy(col);
    curBody.setHSL(hsl.h, Math.min(1, hsl.s * 1.2), hsl.l * pBodyDark.value, SRGB);
    curMoving.setHSL((hsl.h + pMovingHue.value + 1) % 1, hsl.s,
      hsl.l + (1 - hsl.l) * pMovingLift.value, SRGB);
  }

  function syncStageZero() {
    curBody.copy(cCore.value);
    curCrest.copy(cCrest.value);
    curMoving.copy(cMoving.value);
    nextCol.copy(cBecomes.value);
  }
  syncStageZero();

  function advanceStage() {
    if (fireSource === 'spot') goalWins = 0;
    else goalWins++;
    deriveStage(nextCol);
    rotateHue(nextCol, pHueStep.value);
    stageIdx++;

    // No re-levelling here any more. That was an attempt to make the mapping
    // consistent from this instant on; with the frame fixed to gravity it is
    // consistent from every instant, and re-basing it on whatever pose the win
    // happened in is exactly what made the spot's win feel wrong.
    placeErrands();
    goalMix = 0;
    armed = false;
  }

  addEventListener('keydown', (e) => {
    const el = e.target;
    if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
    const k = e.key.toLowerCase();
    if (k === 'r') {
      stageIdx = 0;
      goalWins = 0;
      syncStageZero();
      placeErrands();
      goalMix = 0;
      armed = false;
    } else if (k === 'h') {
      // "This way is me." The only thing gravity cannot tell us.
      motion.tareHeading();
    } else if (k === 't' && phaseState === 'idle') {
      // Fires the transition by hand. The collapse is most of what there is to
      // look at and it is a nuisance to have to earn it every time -- and with
      // no orb plugged in there is no way to aim at all.
      phaseState = 'in';
      stateT = 0;
      dwell = 0;
      fireSource = 'goal';
    }
  });

  // --- running state --------------------------------------------------------
  let phase = 0, ripple = 0, spin = 0, stirred = 0;
  let liveTurn = 0;
  let lastEpoch = -1;
  let started = false, hadHaptics = false;

  let heldAmt = 0, moveVis = 0, bodyVis = 1, goalVis = 1;
  let goalAngle = 180, aimNear = 0;
  let spotAngle = 180, spotNear = 0, foundHold = 0, foundPulse = 0;
  let dwell = 0, armed = false, goalMix = 1, goalOpen = 0.1;
  // Turns won at the hole since the last one won at the spot. Past the
  // threshold the hole stops being catchable and the spot is the only way on.
  // Turns won at the hole since the last one won at the spot -- and only
  // within one spell in the hand. See the set-down check below.
  let goalWins = 0, evading = false, fireSource = 'goal';
  let wasHeld = false;
  let phaseState = 'idle', stateT = 0, collapse = 0;
  let hapPhase = 0, motorLevel = 0;

  stage.onUpdate((dt) => {
    motion.delayMs = pDelay.value;
    const m = motion.sample();
    const relevelled = m.valid && (!started || m.epoch !== lastEpoch);

    if (m.valid) {
      if (relevelled) {
        // Only a declared heading tare reaches here now. It does turn the
        // picture about the vertical, which is the point of it, so snap rather
        // than drag the body across a frame that has already moved.
        smoothed.copy(m.quaternion);
        lastEpoch = m.epoch;
        if (!started) { started = true; placeErrands(); }
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
    }

    goalTarget.copy(goalBody).applyQuaternion(smoothed).normalize();

    // --- the hole stops playing fair ----------------------------------------
    // Once it has been caught enough times it slides around the orb to keep
    // its distance from the eye: gently at the outer radius, harder the closer
    // you get, and hard-stopped outside the aim window so it cannot be
    // cornered by turning faster. Rotating about cross(viewDir, goal) is the
    // one axis that moves it directly away from the eye; carried into body
    // space so the retreat is a real move of the hole, not a screen effect.
    evading = goalWins >= pEvadeAfter.value;
    if (evading && phaseState === 'idle') {
      const off = Math.acos(Math.max(-1, Math.min(1, goalTarget.dot(viewDir)))) * DEG;
      const urgency = smooth01(ramp(pFleeFrom.value - off, 0,
        Math.max(pFleeFrom.value - pFleeFloor.value, 1)));
      const push = pFleeSpeed.value * urgency * dt
        + Math.max(0, pFleeFloor.value - off);
      if (push > 0) {
        fleeAxis.crossVectors(viewDir, goalTarget);
        // Dead centre has no "away" to point at; any perpendicular will do.
        if (fleeAxis.lengthSq() < 1e-8) fleeAxis.set(1, 0, 0);
        fleeAxis.normalize().applyQuaternion(invAtt.copy(smoothed).invert());
        fleeQ.setFromAxisAngle(fleeAxis, push * D2R);
        goalBody.applyQuaternion(fleeQ).normalize();
        goalTarget.copy(goalBody).applyQuaternion(smoothed).normalize();
      }
    }

    goalScreen.lerp(goalTarget, 1 - Math.exp(-dt * pFollow.value)).normalize();
    updateGoalBasis();

    goalAngle = Math.acos(Math.max(-1, Math.min(1, goalScreen.dot(viewDir)))) * DEG;

    // --- and where the motor's spot is --------------------------------------
    spotTarget.copy(spotBody).applyQuaternion(smoothed).normalize();
    spotScreen.lerp(spotTarget, 1 - Math.exp(-dt * pFollow.value)).normalize();
    spotAngle = Math.acos(Math.max(-1, Math.min(1, spotScreen.dot(viewDir)))) * DEG;

    // Warmth: 0 at the edge of what can be felt, 1 once it is facing you.
    spotNear = smooth01(ramp(pSpotReach.value - spotAngle,
      0, Math.max(pSpotReach.value - pSpotFound.value, 1)));
    // Eased rather than a switch, so arriving does not click.
    const foundAmt = smooth01(ramp(pSpotFound.value - spotAngle, 0,
      Math.max(pSpotFound.value * 0.6, 1)));

    const still = liveTurn < pStillTurn.value;
    if (spotAngle > pSpotFound.value) foundHold = Math.max(0, foundHold - dt * 2);
    else if (still) foundHold += dt;      // holding it, but not while fidgeting
    foundPulse = smooth01(ramp(foundHold - pPulseAfter.value, 0, pPulseFade.value));

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
      // Hysteresis. A bare threshold plus the tremor of a hand holding a ball
      // means the dwell chatters across the edge and never completes -- and
      // with the decay running faster than the build, every near-miss wipes
      // the progress. Once you are in, it takes a bigger move to fall out.
      const edge = dwell > 0 ? pAimAngle.value * pAimSlack.value : pAimAngle.value;
      if (armed && goalAngle < edge) {
        dwell += dt;
        if (dwell >= pAimHold.value) {
          phaseState = 'in'; stateT = 0; dwell = 0; fireSource = 'goal';
        }
      } else {
        dwell = Math.max(0, dwell - dt * 0.5);
      }

      // The other way through. Standing on the spot long enough turns the orb
      // over from there instead -- and once the hole is backing away, this is
      // the only route left.
      if (foundHold >= pPulseAfter.value + pSpotFire.value) {
        phaseState = 'in'; stateT = 0; dwell = 0; fireSource = 'spot'; foundHold = 0;
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
    // Setting the orb down ends the session: the hole forgets it was ever
    // caught and goes back to the far side, and the spot is hidden again.
    // This used to ride on the re-levelling epoch; now that setting the orb
    // down changes no frames, it is read off `held` directly, which is what it
    // always meant.
    if (wasHeld && !heldTarget) {
      goalWins = 0;
      placeErrands();
    }
    wasHeld = !!heldTarget;
    heldAmt += (heldTarget - heldAmt) * (1 - Math.exp(-dt * 6));

    const moveTarget = smooth01(ramp(liveTurn, pVisMin.value, pVisFull.value));
    const tau = moveTarget > moveVis ? pVisAttack.value : pVisRelease.value;
    moveVis += (moveTarget - moveVis) * (1 - Math.exp(-dt / Math.max(tau, 0.01)));

    // The motor's beat, computed whether or not the motor is running: the
    // colour pulse rides the same phase and has to stay in step with it.
    const hz = pHzFar.value + (pHzNear.value - pHzFar.value) * spotNear;
    hapPhase += hz * dt;
    const wave = Math.pow(0.5 + 0.5 * Math.sin(hapPhase * Math.PI * 2), pPulseShape.value);
    const colourPulse = phaseState === 'idle' ? foundPulse * wave : 0;

    const active = pDimFloor.value + (1 - pDimFloor.value) * moveVis;
    bodyVis = 1 + (active - 1) * heldAmt;
    // Standing on the spot is the one thing allowed to break "only while
    // moving": the body flashes back on every beat while nothing is moving.
    bodyVis = Math.max(bodyVis, colourPulse * pFoundBright.value);
    const goalActive = Math.max(active, pGoalFloor.value);
    goalVis = 1 + (goalActive - 1) * heldAmt;

    // --- uniforms -----------------------------------------------------------
    lookup.copy(smoothed).invert();
    lookupMat.setFromMatrix4(lookupM4.makeRotationFromQuaternion(lookup));
    uField.value.copy(lookupMat);
    // Straight through. These come off the gyro in body coordinates, and with
    // L = A^-1 a body direction *is* its own field coordinate, so the transform
    // that used to be here was the attitude applied a second time.
    uAxis.value.copy(axis);
    uU.value.copy(basisU);
    uW.value.copy(basisW);
    uPhase.value = phase;
    uRipple.value = pRipples.value ? ripple : 0;
    uSpin.value = spin;
    uDir.value = pAgainst.value ? 1 : -1;
    uUndDepth.value = pUndRest.value + (pUndMoving.value - pUndRest.value) * stirred;
    uDrift.value = pFlowRest.value + (pFlowMoving.value - pFlowRest.value) * stirred;

    if (stageIdx === 0) syncStageZero();
    // Set down, a derived stage's near-black body is lifted toward its crest
    // colour -- otherwise "visible again when set down" is true of the
    // brightness and false of anything you can actually see.
    shownBody.copy(curBody);
    if (stageIdx > 0) shownBody.lerp(curCrest, pRestLift.value * (1 - heldAmt));
    uBody.value.copy(shownBody);
    uCrest.value.copy(curCrest);
    uMoving.value.copy(curMoving);
    uGoalCol.value.copy(nextCol);

    uGoalDir.value.copy(goalScreen);
    uGoalU.value.copy(goalU);
    uGoalW.value.copy(goalW);
    uGoalMix.value = goalMix;
    // Forced open only through the collapse -- during the bloom the *new*
    // throat is the one on screen, and holding it wide there makes it flare
    // and then drop away as the real values take over.
    // Added, not maxed: aimNear has already saturated by the time the window
    // is entered, so anything bounded by it cannot show the hold filling. This
    // drives the surge past its normal ceiling instead, and the throat visibly
    // winds up over the hold rather than firing out of nowhere.
    const charging = aimNear + dwell / Math.max(pAimHold.value, 0.01);
    uAim.value = phaseState === 'in' ? 1 : (phaseState === 'out' ? aimNear : charging);
    uGoalOpen.value = phaseState === 'in' ? 1 : goalOpen;
    uCollapse.value = collapse;
    uFlash.value = pFlash.value * Math.pow(collapse, 3);
    uVis.value = bodyVis;
    uGoalVis.value = goalVis;
    uPulse.value = colourPulse;

    // --- the motor, arguing -------------------------------------------------
    if (pHaptics.value) {
      if (phaseState !== 'idle') {
        if (fireSource === 'spot') {
          // The hand's own errand, so this one is met with a swell that rises
          // and falls with the collapse rather than a refusal.
          motorLevel = pYesStrength.value * Math.sqrt(Math.max(collapse, 0));
        } else {
          // Reaching the collapsing point is the eye's win, not the hand's.
          // Two flat refusals -- no, no -- and then silence.
          const since = stateT + (phaseState === 'out' ? pInSecs.value : 0);
          const len = pNoLen.value;
          const gap = pNoGap.value;
          const knocking = since < len || (since >= len + gap && since < len * 2 + gap);
          motorLevel = knocking ? pNoStrength.value : 0;
        }
      } else {
        // Warmer is faster and harder, full stop. Nothing on screen says where
        // the spot is, so the gradient itself has to carry the whole message.
        const amp = pAmpFar.value + (pAmpNear.value - pAmpFar.value) * spotNear;
        const hapMove = smooth01(ramp(liveTurn, pVisMin.value, pHapMoveFull.value));
        const gate = Math.max(1 - pMoveGate.value * (1 - hapMove), foundAmt);
        motorLevel = clamp01(amp * gate * (pHapFloor.value + (1 - pHapFloor.value) * wave));
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
