import { Quaternion, Vector3 } from 'three/webgpu';

// The BNO085 reports a gravity-referenced frame with Z up. Three.js is Y up.
// The mapping that lines them up is a cyclic permutation of the axes:
//
//     three.x = sensor.y      (right)
//     three.y = sensor.z      (up)
//     three.z = sensor.x      (toward the viewer)
//
// A cyclic permutation is a proper rotation (determinant +1), so a quaternion
// converts by permuting its vector part the same way and leaving w alone.
// Getting this wrong is not obvious on screen -- it looks like a plausible
// rotation about the wrong axis -- so it lives here once rather than in each
// experiment.

export function sensorQuaternion(frame, target = new Quaternion()) {
  return target.set(frame.qy, frame.qz, frame.qx, frame.qw);
}

export function sensorVector(x, y, z, target = new Vector3()) {
  return target.set(y, z, x);
}

/** Angular velocity in three-space, radians/sec. */
export function angularVelocity(frame, target = new Vector3()) {
  return sensorVector(frame.gx, frame.gy, frame.gz, target);
}

/** Rotation speed magnitude, deg/sec -- frame-independent. */
export function rotationSpeed(frame) {
  const { gx, gy, gz } = frame;
  return Math.hypot(gx, gy, gz) * 180 / Math.PI;
}

export const isHeld = (frame) => frame.held > 0.5;
