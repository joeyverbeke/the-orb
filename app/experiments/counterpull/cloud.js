import * as THREE from 'three/webgpu';

// A point cloud built as billboarded quads.
//
// WebGPU has no sized point primitive -- its PointList topology draws one
// pixel, with no size, softness or falloff -- so a cloud that is meant to glow
// has to be quads. Four vertices per point, camera-facing, shaded as soft
// discs. The redundancy is the price of control over how each point looks.

export function buildCloud(maxPoints) {
  const geometry = new THREE.BufferGeometry();

  const positions = new Float32Array(maxPoints * 4 * 3);   // base direction
  const corners = new Float32Array(maxPoints * 4 * 2);     // quad corner, -1..1
  const seeds = new Float32Array(maxPoints * 4);           // per-point random
  const indices = new Uint32Array(maxPoints * 6);

  // Fibonacci lattice: an even covering of the sphere with no pole clumping,
  // which a naive lat/long distribution would give.
  const golden = Math.PI * (3 - Math.sqrt(5));
  const order = new Uint32Array(maxPoints);
  for (let i = 0; i < maxPoints; i++) order[i] = i;

  // The lattice walks pole to pole, so drawing the first N of it in lattice
  // order gives a polar cap rather than a sphere. Shuffling means any prefix
  // is an even sample of the whole surface, which is what lets the point-count
  // control work by just moving the draw range.
  for (let i = maxPoints - 1; i > 0; i--) {
    const j = (Math.random() * (i + 1)) | 0;
    const t = order[i]; order[i] = order[j]; order[j] = t;
  }

  for (let i = 0; i < maxPoints; i++) {
    const n = order[i];
    const y = 1 - (n / (maxPoints - 1)) * 2;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const theta = golden * n;
    const x = Math.cos(theta) * r;
    const z = Math.sin(theta) * r;

    const seed = Math.random();
    const v = i * 4;

    for (let c = 0; c < 4; c++) {
      const o = (v + c) * 3;
      positions[o] = x; positions[o + 1] = y; positions[o + 2] = z;
      seeds[v + c] = seed;
    }
    const co = v * 2;
    corners[co]     = -1; corners[co + 1] = -1;
    corners[co + 2] =  1; corners[co + 3] = -1;
    corners[co + 4] =  1; corners[co + 5] =  1;
    corners[co + 6] = -1; corners[co + 7] =  1;

    const t = i * 6;
    indices[t] = v; indices[t + 1] = v + 1; indices[t + 2] = v + 2;
    indices[t + 3] = v; indices[t + 4] = v + 2; indices[t + 5] = v + 3;
  }

  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('aCorner', new THREE.BufferAttribute(corners, 2));
  geometry.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));

  // Points move well outside the unit sphere once displaced, and an automatic
  // bounding sphere from the base positions would cull the cloud from close up.
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 4);

  return geometry;
}
