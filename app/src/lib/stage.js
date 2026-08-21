import * as THREE from 'three/webgpu';

// Renderer + scene + camera + resize + loop. Everything an experiment needs
// before it starts being interesting, so an experiment file is only about what
// makes it different.

export async function createStage({
  canvas,
  fov = 45,
  near = 0.1,
  far = 100,
  position = [0, 0, 4],
  background = 0x0e0f15,
} = {}) {
  // WebGPURenderer falls back to a WebGL2 backend on its own when WebGPU is
  // unavailable. Worth surfacing which one you actually got: the TSL is the
  // same either way, but the performance is not.
  const renderer = new THREE.WebGPURenderer({ canvas, antialias: true });
  await renderer.init();

  const backend = renderer.backend?.isWebGPUBackend ? 'WebGPU' : 'WebGL2';

  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(background);

  const camera = new THREE.PerspectiveCamera(fov, 1, near, far);
  camera.position.set(...position);
  camera.lookAt(0, 0, 0);

  // Measure the *container*, never the canvas. setSize writes the canvas's
  // width/height attributes, which are also its intrinsic size -- so a canvas
  // that is laid out from its own content will grow every time it is resized,
  // compounding until it is many times the size of the window. Observing the
  // parent breaks that loop; `false` keeps CSS sizing out of it entirely.
  const host = renderer.domElement.parentElement ?? document.body;
  const resize = () => {
    const w = host.clientWidth || 1;
    const h = host.clientHeight || 1;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  new ResizeObserver(resize).observe(host);
  resize();

  const updates = new Set();
  let last = performance.now();
  let fps = 0;

  renderer.setAnimationLoop(() => {
    const now = performance.now();
    const dt = Math.min((now - last) / 1000, 0.1);   // clamp, so a hidden tab
    last = now;                                      // can't jump the world
    fps += ((1 / Math.max(dt, 1e-4)) - fps) * 0.05;

    for (const fn of updates) fn(dt, now / 1000);
    renderer.render(scene, camera);
  });

  return {
    THREE, renderer, scene, camera, backend,
    onUpdate(fn) { updates.add(fn); return () => updates.delete(fn); },
    get fps() { return fps; },
    dispose() { renderer.setAnimationLoop(null); renderer.dispose(); },
  };
}
