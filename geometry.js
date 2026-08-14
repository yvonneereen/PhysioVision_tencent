// Pure geometry helpers for pose analysis.
// All functions operate on landmark objects shaped { x, y, z } (any consistent unit).
// Prefer MediaPipe worldLandmarks (metric, hip-centered) so angles are camera-invariant.

/** Vector from point b to point a. */
function sub(a, b) {
  return { x: a.x - b.x, y: a.y - b.y, z: (a.z ?? 0) - (b.z ?? 0) };
}

function dot(u, v) {
  return u.x * v.x + u.y * v.y + u.z * v.z;
}

function norm(u) {
  return Math.sqrt(dot(u, u));
}

// Landmarks below this visibility score are treated as unreliable (occluded /
// off-frame / poorly inferred) and excluded from angle calculations.
export const VISIBILITY_THRESHOLD = 0.5;

/** True if a landmark exists and is confidently visible. */
export function isVisible(lm, threshold = VISIBILITY_THRESHOLD) {
  // visibility may be undefined on some builds; treat missing as unreliable.
  return !!lm && (lm.visibility ?? 0) >= threshold;
}

/**
 * Angle at vertex B formed by points A-B-C, in degrees (0–180).
 * e.g. knee flexion = angle(hip, knee, ankle).
 */
export function angle(a, b, c) {
  const ba = sub(a, b);
  const bc = sub(c, b);
  const denom = norm(ba) * norm(bc);
  if (denom === 0) return NaN;
  let cos = dot(ba, bc) / denom;
  cos = Math.min(1, Math.max(-1, cos)); // clamp for float safety
  return (Math.acos(cos) * 180) / Math.PI;
}

/**
 * Angle at B (A-B-C) that returns a NaN value and a low-confidence flag when
 * any of the three landmarks is not confidently visible.
 * @returns {{ value: number, lowConfidence: boolean, weakPoints: string[] }}
 */
export function angleWithConfidence(a, b, c, names = ["a", "b", "c"], threshold = VISIBILITY_THRESHOLD) {
  const points = [a, b, c];
  const weakPoints = [];
  points.forEach((p, i) => {
    if (!isVisible(p, threshold)) weakPoints.push(names[i]);
  });
  if (weakPoints.length > 0) {
    return { value: NaN, lowConfidence: true, weakPoints };
  }
  return { value: angle(a, b, c), lowConfidence: false, weakPoints };
}

/** Euclidean distance between two points. */
export function distance(a, b) {
  return norm(sub(a, b));
}

function midpoint(a, b) {
  return {
    x: (a.x + b.x) / 2,
    y: (a.y + b.y) / 2,
    z: ((a.z ?? 0) + (b.z ?? 0)) / 2,
  };
}

/** Absolute difference between two angles (left vs right symmetry), in degrees. */
export function symmetry(angleLeft, angleRight) {
  if (Number.isNaN(angleLeft) || Number.isNaN(angleRight)) return NaN;
  return Math.abs(angleLeft - angleRight);
}

// MediaPipe Pose landmark indices (BlazePose 33-point model).
export const LM = {
  nose: 0,
  leftShoulder: 11, rightShoulder: 12,
  leftElbow: 13, rightElbow: 14,
  leftWrist: 15, rightWrist: 16,
  leftHip: 23, rightHip: 24,
  leftKnee: 25, rightKnee: 26,
  leftAnkle: 27, rightAnkle: 28,
  leftHeel: 29, rightHeel: 30,
  leftFootIndex: 31, rightFootIndex: 32,
};

// Joint definitions: [pointA, vertexB, pointC] as landmark index keys.
const JOINTS = {
  // Shoulder elevation: hip-shoulder-elbow. Arm beside the trunk is near 0°;
  // an arm raised overhead approaches 180°.
  leftShoulder: ["leftHip", "leftShoulder", "leftElbow"],
  rightShoulder: ["rightHip", "rightShoulder", "rightElbow"],
  leftKnee:   ["leftHip",      "leftKnee",   "leftAnkle"],
  rightKnee:  ["rightHip",     "rightKnee",  "rightAnkle"],
  leftElbow:  ["leftShoulder", "leftElbow",  "leftWrist"],
  rightElbow: ["rightShoulder","rightElbow", "rightWrist"],
  leftHip:    ["leftShoulder", "leftHip",    "leftKnee"],
  rightHip:   ["rightShoulder","rightHip",   "rightKnee"],
  // Ankle: ~90° neutral standing; >90° plantarflexed (tiptoe), <85° dorsiflexed (calf stretch)
  leftAnkle:  ["leftKnee",  "leftAnkle",  "leftFootIndex"],
  rightAnkle: ["rightKnee", "rightAnkle", "rightFootIndex"],
  // Heel angle (vertex AT heel between knee and toe): opens as heel rises
  leftHeelAngle:  ["leftKnee",  "leftHeel",  "leftFootIndex"],
  rightHeelAngle: ["rightKnee", "rightHeel", "rightFootIndex"],
};

/**
 * Compute a standard set of joint angles from a landmark array.
 * Each entry is { value, lowConfidence, weakPoints }: value is NaN and
 * lowConfidence true when any contributing landmark is not confidently visible.
 * The `visibility` field must come from the normalized `landmarks` (worldLandmarks
 * do not carry it), so pass those in via `visLm`. If omitted, `lm` is used for both.
 */
export function jointAngles(lm, visLm = lm, threshold = VISIBILITY_THRESHOLD) {
  const result = {};

  // Standard 3-point joint angles
  for (const [name, [ka, kb, kc]] of Object.entries(JOINTS)) {
    const weak = [ka, kb, kc].filter((k) => !isVisible(visLm[LM[k]], threshold));
    result[name] = weak.length > 0
      ? { value: NaN, lowConfidence: true, weakPoints: weak }
      : { value: angle(lm[LM[ka]], lm[LM[kb]], lm[LM[kc]]), lowConfidence: false, weakPoints: [] };
  }

  // Foot inclination: angle the foot makes with the horizontal floor plane, measured at the heel.
  // 0° = foot flat; increases as heel rises (calf raise). Uses world Y-up coordinates.
  for (const [side, hKey, tKey] of [
    ["left",  "leftHeel",  "leftFootIndex"],
    ["right", "rightHeel", "rightFootIndex"],
  ]) {
    const name = `${side}FootInclination`;
    const weakPts = [hKey, tKey].filter((k) => !isVisible(visLm[LM[k]], threshold));
    if (weakPts.length > 0) {
      result[name] = { value: NaN, lowConfidence: true, weakPoints: weakPts };
    } else {
      result[name] = { value: _footInclination(lm[LM[hKey]], lm[LM[tKey]]), lowConfidence: false, weakPoints: [] };
    }
  }

  // Half-squat form measurements. These remain confidence-gated like the
  // standard joint angles so incomplete poses can never produce a green cue.
  result.torsoLean = _measurement(
    lm,
    visLm,
    ["leftShoulder", "rightShoulder", "leftHip", "rightHip"],
    (leftShoulder, rightShoulder, leftHip, rightHip) =>
      _torsoLean(leftShoulder, rightShoulder, leftHip, rightHip),
    threshold
  );

  for (const side of ["left", "right"]) {
    result[`${side}KneeForwardRatio`] = _measurement(
      lm,
      visLm,
      [
        "nose",
        "leftShoulder",
        "rightShoulder",
        `${side}Knee`,
        `${side}Ankle`,
        `${side}FootIndex`,
      ],
      (nose, leftShoulder, rightShoulder, knee, ankle, toe) =>
        _kneeForwardRatio(
          nose,
          leftShoulder,
          rightShoulder,
          knee,
          ankle,
          toe
        ),
      threshold
    );
  }

  return result;
}

function _measurement(lm, visLm, keys, calculate, threshold) {
  const weakPoints = keys.filter((key) => !isVisible(visLm[LM[key]], threshold));
  if (weakPoints.length > 0) {
    return { value: NaN, lowConfidence: true, weakPoints };
  }

  return {
    value: calculate(...keys.map((key) => lm[LM[key]])),
    lowConfidence: false,
    weakPoints: [],
  };
}

// Degrees the shoulder-to-hip line leans away from vertical (0° = upright).
function _torsoLean(leftShoulder, rightShoulder, leftHip, rightHip) {
  const shoulderMid = midpoint(leftShoulder, rightShoulder);
  const hipMid = midpoint(leftHip, rightHip);
  const trunk = sub(shoulderMid, hipMid);
  const trunkLength = norm(trunk);
  if (trunkLength === 0) return NaN;
  const verticalShare = Math.min(1, Math.abs(trunk.y) / trunkLength);
  return (Math.acos(verticalShare) * 180) / Math.PI;
}

// How far the knee projects beyond the toe in the body's facing direction,
// divided by shin length. A body-relative ratio is more portable across users
// than a raw distance in metres.
function _kneeForwardRatio(
  nose,
  leftShoulder,
  rightShoulder,
  knee,
  ankle,
  toe
) {
  const shoulderMid = midpoint(leftShoulder, rightShoulder);
  const facing = {
    x: nose.x - shoulderMid.x,
    y: 0,
    z: (nose.z ?? 0) - shoulderMid.z,
  };
  const facingLength = norm(facing);
  const shinLength = distance(knee, ankle);
  if (facingLength === 0 || shinLength === 0) return NaN;

  const kneeFromToe = sub(knee, toe);
  const forwardDistance = dot(kneeFromToe, facing) / facingLength;
  return forwardDistance / shinLength;
}

// Degrees the foot is inclined above horizontal: 0° when flat, ~20–40° on
// tiptoe. MediaPipe's pose coordinate system follows the image's vertical
// direction, so smaller Y values are higher in the frame. A raised heel is
// therefore above (and has a smaller Y value than) the toe.
function _footInclination(heel, toe) {
  const dx = toe.x - heel.x;
  const dz = (toe.z ?? 0) - (heel.z ?? 0);
  const horizontalDist = Math.sqrt(dx * dx + dz * dz);
  if (horizontalDist === 0) return NaN;
  const elevation = (toe.y ?? 0) - (heel.y ?? 0);
  return (Math.atan2(Math.max(0, elevation), horizontalDist) * 180) / Math.PI;
}
