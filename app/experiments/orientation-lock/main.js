import * as THREE from 'three/webgpu';
import {
  Fn, vec3, vec4, float, uniform, varying, positionLocal, normalLocal,
  normalWorld, cameraPosition, positionWorld, mix, dot, pow, clamp, sin, atan,
  normalize, saturate, transformNormalToView, mx_fractal_noise_float, time,
} from 'three/tsl';

import { createStage } from '../../src/lib/stage.js';
import { mountTopbar, mountFatal } from '../../src/lib/hud.js';
import { createPanel } from '../../src/lib/panel.js';
import { orb } from '../../src/orb/link.js';
import { createMotion } from '../../src/orb/motion.js';

// The body carries the orb's attitude one to one. Its surface is always slowly
// undulating, and turning it drags ripples through the material -- running
// around the axis of rotation, trailing behind the way the surface moves.
//
// Every number that shapes the feel is on the panel (space), because none of
// them are decidable except by turning the thing in your hand.

const DEG = 180 / Math.PI;

async function main() {
  const stage = await createStage({
    canvas: document.getElementById('view'),
    position: [0, 0, 3.2],
  });
  const hud = mountTopbar({ title: 'viscous body', backend: stage.backend });
  const panel = createPanel({ title: 'Viscous body', storageKey: 'viscous-body' });

  const { scene } = stage;

  // --- lighting -------------------------------------------------------------
  scene.add(new THREE.HemisphereLight(0x6f86ff, 0x140d08, 0.4));
  const key = new THREE.DirectionalLight(0xfff0dc, 2.2);
  key.position.set(2.4, 3, 2.2);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0x35d6c4, 1.5);
  rim.position.set(-3, -0.6, -1.8);
  scene.add(rim);
  const fill = new THREE.PointLight(0xff8a3c, 6.0, 12);
  fill.position.set(-1.4, 1.8, 2.4);
  scene.add(fill);

  // --- controls -------------------------------------------------------------
  panel.group('Resting surface');
  const pUndAmount = panel.slider('Undulation depth', {
    value: 0.05, min: 0, max: 0.15, step: 0.001,
    note: 'How much the surface moves when nothing is happening.' });
  const pUndDetail = panel.slider('Undulation detail', {
    value: 1.35, min: 0.4, max: 4, step: 0.01,
    note: 'Higher = smaller, busier lumps.' });
  const pUndSpeed = panel.slider('Undulation speed', {
    value: 0.07, min: 0, max: 0.5, step: 0.005 });

  panel.group('Ripples');
  const pRipples = panel.toggle('Ripples', true, {
    note: 'Off leaves only the resting undulation.' });
  const pRipDepth = panel.slider('Ripple depth', {
    value: 0.026, min: 0, max: 0.12, step: 0.001,
    note: 'Keep below the undulation depth and a turn disturbs the material '
        + 'rather than replacing it.' });
  const pRipCount = panel.slider('Ripples around', {
    value: 4, min: 1, max: 12, step: 1,
    note: 'How many wave crests fit around the spin axis. High values read as '
        + 'noise rather than as a wave you can follow.' });
  const pRipSpeed = panel.slider('Ripple travel speed', {
    value: 5.0, min: 0, max: 20, step: 0.1 });
  const pRipSettle = panel.slider('Settle time (s)', {
    value: 1.4, min: 0.1, max: 6, step: 0.05,
    note: 'How long ripples keep going after you stop. This is the viscosity.' });
  const pRipBelt = panel.slider('Belt tightness', {
    value: 1.0, min: 0.3, max: 4, step: 0.05,
    note: 'Higher squeezes the ripples into a narrower band around the axis.' });
  const pTurnFull = panel.slider('Turn for full ripple (deg/s)', {
    value: 170, min: 20, max: 500, step: 5,
    note: 'How hard you have to turn it to reach maximum ripple.' });
  const pAgainst = panel.toggle('Ripples trail the turn', true, {
    note: 'On: they stream off against the way you turned, like drag. Off: '
        + 'they run with it. Flip this if it feels backwards in the hand.' });

  panel.group('Motion');
  const pFollow = panel.slider('Follow speed', {
    value: 22, min: 3, max: 60, step: 0.5,
    note: 'How tightly the body tracks the orb. Lower lags behind.' });
  const pAxisSteady = panel.slider('Axis steadiness', {
    value: 3.5, min: 0.5, max: 15, step: 0.1,
    note: 'Lower is steadier: the ripple direction changes more reluctantly.' });
  const pAxisMin = panel.slider('Min turn to aim ripples (deg/s)', {
    value: 20, min: 2, max: 90, step: 1,
    note: 'Below this a turn is too small to say which way it went, so the '
        + 'direction is left alone.' });
  const pDelay = panel.slider('Motion delay (ms)', {
    value: 70, min: 0, max: 220, step: 5,
    note: 'How far behind live the render runs so it can interpolate between '
        + 'real samples. Lower is more responsive; too low and it stutters '
        + 'when frames arrive late.' });

  panel.group('Look');
  const pRough = panel.slider('Roughness', { value: 0.26, min: 0.02, max: 0.7, step: 0.01 });
  const pMetal = panel.slider('Metalness', { value: 0.16, min: 0, max: 1, step: 0.01 });
  const pCoat = panel.slider('Wet coating', { value: 1.0, min: 0, max: 1, step: 0.01 });
  const pGlow = panel.slider('Glow when moving', { value: 0.7, min: 0, max: 2.5, step: 0.02 });
  const pHeat = panel.slider('Colour shift when moving', { value: 0.5, min: 0, max: 1, step: 0.01 });
  const cDeep = panel.color('Deep colour', '#040b15', {
    note: 'The troughs, and most of the body when it is still.' });
  const cBody = panel.color('Surface colour', '#175a80');
  const cHot = panel.color('Colour when moving', '#f2570f');
  const cGlow = panel.color('Ripple glow', '#ff7524');
  const cRim = panel.color('Rim light', '#2a4d6e');
  const cMarker = panel.color('Marker colour', '#59ffea');
  const pMarker = panel.toggle('Show marker', true, {
    note: 'A rigid feature on the body. Without it, rotation of a shifting '
        + 'surface is genuinely ambiguous.' });
  const pCage = panel.toggle('Show cage', true);

  panel.group('Haptics');
  const pHaptics = panel.toggle('Drive the motor', true, {
    note: 'Off hands the motor back to the orb’s own modes.' });
  const pHapAmount = panel.slider('Haptic strength', { value: 0.9, min: 0, max: 1, step: 0.01 });

  panel.group('Live');
  panel.readout('turn speed (deg/s)', () => liveTurn.toFixed(0));
  panel.readout('ripple', () => ripple.toFixed(2));
  panel.readout('fps', () => stage.fps.toFixed(0));
  panel.readout('buffered (ms)', () => (motion.state.lead * 1000).toFixed(0));
  panel.actions();

  // --- uniforms the panel does not own --------------------------------------
  // The spin axis plus an orthonormal pair spanning the plane across it. The
  // basis is built on the CPU, where degenerate cases can be handled properly
  // and carried forward frame to frame; deriving it in the shader would make
  // the pattern snap whenever the axis crossed a singularity.
  const uAxis   = uniform(new THREE.Vector3(0, 1, 0));
  const uU      = uniform(new THREE.Vector3(1, 0, 0));
  const uW      = uniform(new THREE.Vector3(0, 0, 1));
  const uPhase  = uniform(float(0));   // travelling-wave phase
  const uRipple = uniform(float(0));   // 0..1, viscous envelope
  const uSpin   = uniform(float(0));   // 0..1, instantaneous
  const uDir    = uniform(float(1));   // +1 trails the turn, -1 leads it

  // --- surface --------------------------------------------------------------
  // One height field, used for both displacement and normals, so the shading
  // can never disagree with the silhouette.
  const surface = Fn(([p]) => {
    const n = normalize(p);
    const drift = time.mul(pUndSpeed);

    // Two fractal fields drifting on different headings. A single drifting
    // field just slides; two make it seem to evolve.
    const slow = mx_fractal_noise_float(
      p.mul(pUndDetail).add(vec3(0.0, drift, drift.mul(0.45))), 3, 2.0, 0.5);
    const fine = mx_fractal_noise_float(
      p.mul(pUndDetail.mul(1.9)).sub(vec3(drift.mul(0.7), 0.0, drift.mul(0.55))), 2, 2.0, 0.5);
    const idle = slow.add(fine.mul(0.32)).mul(pUndAmount);

    // Angle around the spin axis. Because the axis flips when the rotation
    // reverses, this angle's sense flips with it -- so the same phase term
    // always trails the motion, whichever way it is turned.
    const phi = atan(dot(n, uW), dot(n, uU));
    const along = dot(n, uAxis);
    const belt = pow(clamp(float(1).sub(along.mul(along)), 0, 1), pRipBelt);

    // Adding the phase sends crests against the direction of rotation: the
    // material lags rather than leads. uDir flips that.
    const travel = uPhase.mul(uDir);
    const w1 = sin(phi.mul(pRipCount).add(travel));
    const w2 = sin(phi.mul(pRipCount.mul(1.75)).add(travel.mul(1.35)).add(slow.mul(0.8)));
    const wave = w1.mul(0.7).add(w2.mul(0.3)).mul(belt).mul(uRipple);

    return idle.add(wave.mul(pRipDepth));
  });

  const N = normalize(normalLocal);
  const height = surface(positionLocal);

  // Displacement changes the silhouette but not the normals -- without this the
  // form would light as a smooth sphere however much it deformed. Forward
  // differences in object space: no tangent basis, so no artefacts at the poles
  // where one would be degenerate.
  const E = 0.028;
  const gradient = vec3(
    surface(positionLocal.add(vec3(E, 0, 0))).sub(height),
    surface(positionLocal.add(vec3(0, E, 0))).sub(height),
    surface(positionLocal.add(vec3(0, 0, E))).sub(height),
  ).div(E);
  const tangential = gradient.sub(N.mul(dot(gradient, N)));

  // varying() pins this to the vertex stage. Four fractal-noise evaluations per
  // fragment would be ~3.4M a frame; per vertex it is ~46k, and the mesh is
  // dense enough that interpolating is indistinguishable.
  const bumped = varying(normalize(N.sub(tangential.mul(0.9))));

  // --- material -------------------------------------------------------------
  const material = new THREE.MeshPhysicalNodeMaterial({ clearcoatRoughness: 0.22 });

  material.positionNode = positionLocal.add(N.mul(height));
  material.normalNode = transformNormalToView(bumped);

  const viewDir = normalize(cameraPosition.sub(positionWorld));
  const facing = clamp(dot(normalize(normalWorld), viewDir), 0, 1);
  const fresnel = pow(float(1).sub(facing), float(3.2));

  const crest = saturate(height.mul(7.0));

  material.colorNode = Fn(() => {
    const base = mix(cDeep, cBody, crest);
    const stirred = mix(base, cHot, uSpin.mul(pHeat));
    return vec4(stirred.add(cRim.mul(fresnel)), 1.0);
  })();

  material.emissiveNode = cGlow
    .mul(crest.mul(uRipple).mul(pGlow))
    .add(cRim.mul(fresnel.mul(0.4)));

  material.roughnessNode = pRough.sub(crest.mul(0.16));
  material.metalnessNode = pMetal;
  material.clearcoatNode = pCoat;

  const mesh = new THREE.Mesh(new THREE.IcosahedronGeometry(1, 48), material);
  scene.add(mesh);

  // A fixed feature on the body, riding above the undulation so it is never
  // swallowed by it.
  const marker = new THREE.Group();
  const head = new THREE.Mesh(
    new THREE.SphereGeometry(0.072, 28, 28),
    new THREE.MeshPhysicalNodeMaterial({
      color: 0x0b0d12,
      emissiveNode: cMarker.mul(0.9),
      roughness: 0.3, metalness: 0.0,
    }),
  );
  head.position.set(0, 1.12, 0);
  const stalk = new THREE.Mesh(
    new THREE.CylinderGeometry(0.012, 0.012, 0.16, 12),
    new THREE.MeshBasicNodeMaterial({ color: 0x1d6f68 }),
  );
  stalk.position.set(0, 1.04, 0);
  marker.add(head, stalk);
  mesh.add(marker);                    // child, so it turns with the body

  // Fixed in world: the stationary reference the rotation is read against.
  const cage = new THREE.LineSegments(
    new THREE.WireframeGeometry(new THREE.IcosahedronGeometry(1.55, 1)),
    new THREE.LineBasicMaterial({ color: 0x232633, transparent: true, opacity: 0.45 }),
  );
  scene.add(cage);

  // --- device ---------------------------------------------------------------
  // Frames arrive in clumps; this replays them against their device timestamps
  // so every rendered frame lands between two real samples.
  const motion = createMotion(orb, { delayMs: pDelay.value });

  const smoothed = new THREE.Quaternion();
  const axis = new THREE.Vector3(0, 1, 0);
  const nextAxis = new THREE.Vector3();
  const basisU = new THREE.Vector3(1, 0, 0);
  const basisW = new THREE.Vector3(0, 0, 1);
  const scratch = new THREE.Vector3();

  // Re-orthogonalise the carried-forward basis against the current axis, so it
  // moves continuously rather than jumping whenever the axis drifts.
  function updateBasis() {
    basisU.sub(scratch.copy(axis).multiplyScalar(basisU.dot(axis)));
    if (basisU.lengthSq() < 1e-6) {
      basisU.set(Math.abs(axis.x) < 0.9 ? 1 : 0, Math.abs(axis.x) < 0.9 ? 0 : 1, 0);
      basisU.sub(scratch.copy(axis).multiplyScalar(basisU.dot(axis)));
    }
    basisU.normalize();
    basisW.crossVectors(axis, basisU);
  }

  let phase = 0;
  let ripple = 0;
  let spin = 0;
  let liveTurn = 0;
  let started = false;
  let hadHaptics = false;

  stage.onUpdate((dt) => {
    motion.delayMs = pDelay.value;
    const m = motion.sample();

    if (m.valid) {
      if (!started) { smoothed.copy(m.quaternion); started = true; }
      smoothed.slerp(m.quaternion, 1 - Math.exp(-dt * pFollow.value));

      const omega = m.omega;                     // rad/s, object space
      const mag = omega.length();
      liveTurn = mag * DEG;

      // Only redefine the axis when there is a real turn to define it. Below
      // this, normalising angular velocity is mostly noise, and the ripple
      // direction would thrash while the orb sits nearly still.
      if (liveTurn > pAxisMin.value) {
        nextAxis.copy(omega).divideScalar(mag);
        axis.lerp(nextAxis, 1 - Math.exp(-dt * pAxisSteady.value)).normalize();
      }
      updateBasis();

      const norm = Math.min(liveTurn / Math.max(pTurnFull.value, 1), 1);
      spin += (norm - spin) * (1 - Math.exp(-dt * 8));

      // Fills fast, drains slowly. This is the viscosity.
      ripple = Math.max(ripple * Math.exp(-dt / Math.max(pRipSettle.value, 0.05)), norm);
    }

    // Crests keep moving once started, mostly driven by how hard it is turning.
    phase += (0.25 + spin * pRipSpeed.value) * dt;

    mesh.quaternion.copy(smoothed);
    marker.visible = pMarker.value;
    cage.visible = pCage.value;

    uAxis.value.copy(axis);
    uU.value.copy(basisU);
    uW.value.copy(basisW);
    uPhase.value = phase;
    uRipple.value = pRipples.value ? ripple : 0;
    uSpin.value = spin;
    uDir.value = pAgainst.value ? 1 : -1;

    // The hand feels the slosh, not the motion: it keeps going after you stop
    // and settles as the ripples drain.
    if (pHaptics.value) {
      const felt = pRipples.value ? ripple : spin;
      orb.setHaptic(Math.min(1, (felt * 0.9 + spin * 0.15) * pHapAmount.value));
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
