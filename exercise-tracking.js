// Exercise-level adapters that turn Pose/Hand Landmarker results into the
// confidence-aware measurements consumed by FeedbackEngine.

import {
  distance,
  jointAngles,
  LM,
  VISIBILITY_THRESHOLD,
} from "./geometry.js?v=2";
import {
  HAND_LM,
  selectTrackedHand,
  summarizeHandResult,
} from "./hand-geometry.js";
import {
  isFinitePoint,
  landmarkQuality,
  limbStillness,
  measurementResult,
  movementVelocity,
} from "./movement-measurements.js";

export const TRACKING_MODES = Object.freeze({
  POSE: "pose",
  HAND: "hand",
  POSE_AND_HAND: "pose_and_hand",
});

export function exerciseUsesHand(exercise) {
  return [TRACKING_MODES.HAND, TRACKING_MODES.POSE_AND_HAND]
    .includes(exercise?.trackingMode);
}

function imageDistance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function derivedMeasurement(source, value, reason = null) {
  return measurementResult(value, {
    score: source?.confidence?.score ?? 0,
    weakPoints: source?.weakPoints ?? [],
    forceLowConfidence: Boolean(source?.lowConfidence),
    unavailable: !source || source.confidence.status === "unavailable"
      || value === null || value === undefined
      || (typeof value === "number" && !Number.isFinite(value)),
    reason: reason ?? source?.confidence?.reason ?? null,
  });
}

/** Match a detected hand to the selected Pose wrist in the same image. */
export function matchHandToPoseWrist(
  poseLandmarks,
  hands,
  side,
  options = {}
) {
  const wristIndex = side === "left" ? LM.leftWrist : LM.rightWrist;
  const poseWrist = poseLandmarks?.[wristIndex];
  const poseQuality = landmarkQuality(
    [poseWrist],
    [`${side}_pose_wrist`],
    { threshold: options.visibilityThreshold ?? VISIBILITY_THRESHOLD }
  );
  if (!poseQuality.usable || !Array.isArray(hands) || hands.length === 0) {
    return measurementResult(null, {
      score: poseQuality.score,
      unavailable: true,
      reason: hands?.length ? "pose_wrist_unreliable" : "hand_not_detected",
      weakPoints: hands?.length ? poseQuality.weakPoints : ["hand_landmarks"],
    });
  }

  const candidates = hands
    .filter((hand) => isFinitePoint(hand.landmarks?.[HAND_LM.wrist]))
    .map((hand) => ({
      hand,
      distance: imageDistance(poseWrist, hand.landmarks[HAND_LM.wrist]),
    }))
    .sort((a, b) => a.distance - b.distance);
  if (!candidates.length) {
    return measurementResult(null, {
      unavailable: true,
      reason: "hand_wrist_unavailable",
      weakPoints: ["hand_wrist"],
    });
  }

  const match = candidates[0];
  const maximumDistance = options.maximumDistance ?? 0.14;
  const framingReady = match.hand.framing.ready;
  const usable = match.distance <= maximumDistance && framingReady;
  return measurementResult(match, {
    score: usable ? 1 : 0.25,
    forceLowConfidence: !usable,
    reason: !framingReady
      ? match.hand.framing.reason
      : match.distance > maximumDistance ? "pose_hand_wrist_mismatch" : null,
    weakPoints: usable
      ? []
      : [!framingReady ? match.hand.framing.reason : "pose_hand_wrist_match"],
  });
}

/**
 * Signed turn from the Pose forearm axis to the Hand Landmarker middle-finger
 * axis. Negative means fingers turn upward on an upright screen; positive means
 * downward. The forearm must be mostly horizontal for that interpretation.
 */
export function signedWristBend(
  poseElbow,
  poseWrist,
  handWrist,
  middleMcp,
  options = {}
) {
  const quality = landmarkQuality(
    [poseElbow, poseWrist, handWrist, middleMcp],
    ["pose_elbow", "pose_wrist", "hand_wrist", "middle_mcp"],
    options
  );
  if (!quality.usable) {
    return measurementResult(NaN, {
      score: quality.score,
      unavailable: true,
      reason: "wrist_landmark_unreliable",
      weakPoints: quality.weakPoints,
    });
  }

  const forearm = {
    x: poseWrist.x - poseElbow.x,
    y: poseWrist.y - poseElbow.y,
  };
  const handAxis = {
    x: middleMcp.x - handWrist.x,
    y: middleMcp.y - handWrist.y,
  };
  const forearmLength = Math.hypot(forearm.x, forearm.y);
  const handLength = Math.hypot(handAxis.x, handAxis.y);
  if (!forearmLength || !handLength) {
    return measurementResult(NaN, {
      unavailable: true,
      reason: "degenerate_wrist_axis",
      weakPoints: ["wrist_axis"],
    });
  }
  const horizontalRatio = Math.abs(forearm.x) / forearmLength;
  const cross = forearm.x * handAxis.y - forearm.y * handAxis.x;
  const dot = forearm.x * handAxis.x + forearm.y * handAxis.y;
  let value = Math.atan2(cross, dot) * 180 / Math.PI;
  // Canonicalize left- and right-facing arms: screen-up remains negative.
  value *= Math.sign(forearm.x) || 1;
  const minimumHorizontalRatio = options.minimumHorizontalRatio ?? 0.45;
  const orientationUsable = horizontalRatio >= minimumHorizontalRatio;

  return measurementResult(value, {
    score: quality.score,
    forceLowConfidence: !orientationUsable,
    reason: orientationUsable ? null : "forearm_not_horizontal_enough",
    weakPoints: orientationUsable ? [] : ["forearm_orientation"],
  });
}

function forearmHorizontalMeasurement(elbow, wrist) {
  const quality = landmarkQuality(
    [elbow, wrist],
    ["pose_elbow", "pose_wrist"]
  );
  if (!quality.usable) {
    return measurementResult(NaN, {
      score: quality.score,
      unavailable: true,
      reason: "forearm_landmark_unreliable",
      weakPoints: quality.weakPoints,
    });
  }
  const length = imageDistance(elbow, wrist);
  return measurementResult(length
    ? Math.abs(wrist.x - elbow.x) / length
    : NaN, {
    score: quality.score,
    unavailable: !length,
    reason: length ? null : "degenerate_forearm_axis",
    weakPoints: length ? [] : ["forearm_axis"],
  });
}

function forearmVelocityMeasurement(history, side, options = {}) {
  const elbowIndex = side === "left" ? LM.leftElbow : LM.rightElbow;
  const wristIndex = side === "left" ? LM.leftWrist : LM.rightWrist;
  const stillness = limbStillness(history, [elbowIndex, wristIndex], {
    referencePair: [elbowIndex, wristIndex],
    velocityThreshold: options.forearmVelocityThreshold ?? 0.3,
    minimumFrames: options.minimumStillnessFrames ?? 4,
    minimumDurationMs: options.minimumStillnessDurationMs ?? 250,
    threshold: options.visibilityThreshold ?? VISIBILITY_THRESHOLD,
  });
  return derivedMeasurement(
    stillness,
    stillness.value?.rmsVelocity ?? NaN,
    stillness.confidence.reason
  );
}

function recentHistory(history, durationMs) {
  if (!Array.isArray(history) || !history.length) return [];
  const latest = history.at(-1).timestampMs;
  return history.filter((frame) => latest - frame.timestampMs <= durationMs);
}

export function measureCombinedWristFrame({
  poseResult,
  handResult,
  side = "right",
  frame = {},
  poseHistory = [],
  options = {},
}) {
  const poseLandmarks = poseResult?.landmarks?.[0];
  const poseWorldLandmarks = poseResult?.worldLandmarks?.[0];
  if (!poseLandmarks || !poseWorldLandmarks) return {};

  const hands = summarizeHandResult(handResult, frame);
  const match = matchHandToPoseWrist(poseLandmarks, hands, side, options);
  if (match.confidence.status === "unavailable") return {};

  const hand = match.value.hand;
  const handLandmarks = hand.landmarks;
  const shoulderIndex = side === "left" ? LM.leftShoulder : LM.rightShoulder;
  const elbowIndex = side === "left" ? LM.leftElbow : LM.rightElbow;
  const wristIndex = side === "left" ? LM.leftWrist : LM.rightWrist;
  const elbow = poseLandmarks[elbowIndex];
  const wrist = poseLandmarks[wristIndex];
  const angles = jointAngles(poseWorldLandmarks, poseLandmarks);
  const rawElbowAngle = angles[`${side}Elbow`];
  const elbowQuality = landmarkQuality(
    [
      poseLandmarks[shoulderIndex],
      poseLandmarks[elbowIndex],
      poseLandmarks[wristIndex],
    ],
    [`${side}_shoulder`, `${side}_elbow`, `${side}_wrist`]
  );
  const elbowAngle = measurementResult(rawElbowAngle.value, {
    score: elbowQuality.score,
    weakPoints: [...elbowQuality.weakPoints, ...rawElbowAngle.weakPoints],
    unavailable: rawElbowAngle.lowConfidence || !Number.isFinite(rawElbowAngle.value),
    reason: rawElbowAngle.lowConfidence ? "elbow_landmark_unreliable" : null,
  });
  const wristBend = signedWristBend(
    elbow,
    wrist,
    handLandmarks[HAND_LM.wrist],
    handLandmarks[HAND_LM.middleMcp],
    options
  );
  if (match.lowConfidence) {
    wristBend.lowConfidence = true;
    wristBend.confidence.status = "low";
    wristBend.confidence.score = Math.min(
      wristBend.confidence.score,
      match.confidence.score
    );
    wristBend.confidence.reason = match.confidence.reason;
    wristBend.weakPoints = [...new Set([
      ...wristBend.weakPoints,
      ...match.weakPoints,
    ])];
  }

  return {
    elbow: elbowAngle,
    wristBend,
    palmDown: derivedMeasurement(hand.palm, hand.palm.value?.normal?.y ?? NaN),
    forearmHorizontal: forearmHorizontalMeasurement(elbow, wrist),
    forearmVelocity: forearmVelocityMeasurement(
      recentHistory(poseHistory, 800),
      side,
      options
    ),
    wristMatch: derivedMeasurement(match, match.value.distance),
  };
}

export function measureHandSequenceFrame({
  handResult,
  side = "right",
  frame = {},
}) {
  const hands = summarizeHandResult(handResult, frame);
  const hand = selectTrackedHand(hands, side);
  if (!hand) return {};
  const shape = hand.handShape;
  return {
    handShape: derivedMeasurement(shape, shape.value?.label ?? null),
    handShapeScore: derivedMeasurement(
      shape,
      shape.value?.classificationScore ?? NaN
    ),
    handFrameReady: derivedMeasurement(
      hand.framing,
      hand.framing.ready ? 1 : 0
    ),
  };
}

function posePointMeasurement(landmarks, indices, names, calculate, options = {}) {
  const points = indices.map((index) => landmarks?.[index]);
  const quality = landmarkQuality(points, names, options);
  const value = quality.usable ? calculate(...points) : NaN;
  return measurementResult(value, {
    score: quality.score,
    weakPoints: quality.weakPoints,
    unavailable: !quality.usable
      || value === null
      || value === undefined
      || (typeof value === "number" && !Number.isFinite(value)),
    reason: quality.usable ? null : "required_landmark_unreliable",
  });
}

function midpoint(a, b) {
  return {
    x: (a.x + b.x) / 2,
    y: (a.y + b.y) / 2,
    z: ((a.z ?? 0) + (b.z ?? 0)) / 2,
  };
}

function safeRatio(numerator, denominator) {
  return denominator > 0 ? numerator / denominator : NaN;
}

function sideIndices(side) {
  const cap = side === "left" ? "left" : "right";
  return {
    shoulder: LM[`${cap}Shoulder`],
    elbow: LM[`${cap}Elbow`],
    wrist: LM[`${cap}Wrist`],
    hip: LM[`${cap}Hip`],
    knee: LM[`${cap}Knee`],
    ankle: LM[`${cap}Ankle`],
    heel: LM[`${cap}Heel`],
    foot: LM[`${cap}FootIndex`],
  };
}

function scaledMeasurement(landmarks, indices, names, calculate, options = {}) {
  return posePointMeasurement(landmarks, indices, names, (...points) => {
    const value = calculate(...points);
    return Number.isFinite(value) ? value : NaN;
  }, options);
}

function relativeMotionRangeImpl(history, pointIndices, anchorIndices, referencePair, options = {}) {
  if (!Array.isArray(history) || history.length === 0) {
    return measurementResult(NaN, {
      unavailable: true,
      reason: "missing_pose_history",
      weakPoints: ["time_window"],
    });
  }

  const samples = [];
  const scores = [];
  const weakPoints = [];
  for (const frame of history) {
    const points = pointIndices.map((index) => frame.landmarks?.[index]);
    const anchors = anchorIndices.map((index) => frame.landmarks?.[index]);
    const refs = referencePair.map((index) => frame.landmarks?.[index]);
    const all = [...points, ...anchors, ...refs];
    const names = all.map((_point, index) => `motion_${index}`);
    const quality = landmarkQuality(all, names, options);
    scores.push(quality.score);
    weakPoints.push(...quality.weakPoints);
    if (!quality.usable) continue;
    const point = points.length === 1 ? points[0] : midpoint(points[0], points[1]);
    const anchor = anchors.length === 1 ? anchors[0] : midpoint(anchors[0], anchors[1]);
    const scale = distance(refs[0], refs[1]);
    if (!scale) continue;
    samples.push({
      x: (point.x - anchor.x) / scale,
      y: (point.y - anchor.y) / scale,
    });
  }

  if (!samples.length) {
    return measurementResult(NaN, {
      unavailable: true,
      reason: "no_usable_motion_samples",
      weakPoints,
    });
  }
  const xs = samples.map((sample) => sample.x);
  const ys = samples.map((sample) => sample.y);
  const value = Math.hypot(
    Math.max(...xs) - Math.min(...xs),
    Math.max(...ys) - Math.min(...ys)
  );
  return measurementResult(value, {
    score: Math.min(...scores),
    weakPoints,
    forceLowConfidence: samples.length !== history.length,
    reason: samples.length === history.length ? null : "incomplete_motion_window",
  });
}

function localTrajectory(history, pointIndex, anchorIndex, referencePair) {
  const points = [];
  const weakPoints = [];
  const scores = [];
  for (const frame of history ?? []) {
    const point = frame.landmarks?.[pointIndex];
    const anchor = frame.landmarks?.[anchorIndex];
    const referenceA = frame.landmarks?.[referencePair[0]];
    const referenceB = frame.landmarks?.[referencePair[1]];
    const quality = landmarkQuality(
      [point, anchor, referenceA, referenceB],
      ["trajectory_point", "trajectory_anchor", "reference_a", "reference_b"]
    );
    scores.push(quality.score);
    weakPoints.push(...quality.weakPoints);
    if (!quality.usable) continue;
    const scale = distance(referenceA, referenceB);
    if (!scale) continue;
    points.push({
      x: (point.x - anchor.x) / scale,
      y: (point.y - anchor.y) / scale,
      z: 0,
      visibility: quality.score,
    });
  }

  const motion = relativeMotionRangeImpl(
    history,
    [pointIndex],
    [anchorIndex],
    referencePair
  );
  if (points.length < 8 || motion.lowConfidence || motion.value < 0.08) {
    const score = scores.length ? Math.min(...scores) : 0;
    return {
      motion,
      direction: measurementResult("none", {
        score,
        weakPoints,
        forceLowConfidence: !points.length,
        unavailable: !points.length,
      }),
      circularity: measurementResult(0, {
        score,
        weakPoints,
        forceLowConfidence: !points.length,
        unavailable: !points.length,
      }),
    };
  }

  // Calculate the same compact descriptors as circularTrajectory, but on
  // ankle-relative, body-normalised points so whole-leg motion does not look
  // like an ankle circle.
  const centre = {
    x: points.reduce((sum, point) => sum + point.x, 0) / points.length,
    y: points.reduce((sum, point) => sum + point.y, 0) / points.length,
  };
  const radii = points.map((point) => Math.hypot(
    point.x - centre.x,
    point.y - centre.y
  ));
  const meanRadius = radii.reduce((sum, radius) => sum + radius, 0) / radii.length;
  const radialDeviation = Math.sqrt(
    radii.reduce((sum, radius) => sum + (radius - meanRadius) ** 2, 0)
      / radii.length
  );
  const angles = points.map((point) => Math.atan2(
    point.y - centre.y,
    point.x - centre.x
  ));
  let sweep = 0;
  for (let index = 1; index < angles.length; index += 1) {
    let difference = angles[index] - angles[index - 1];
    while (difference > Math.PI) difference -= Math.PI * 2;
    while (difference < -Math.PI) difference += Math.PI * 2;
    sweep += difference;
  }
  const coverage = Math.min(1, Math.abs(sweep) / (Math.PI * 2));
  const radialScore = meanRadius
    ? Math.max(0, 1 - (radialDeviation / meanRadius) * 2)
    : 0;
  const circularity = radialScore * coverage;
  const score = scores.length ? Math.min(...scores) : 0;
  return {
    motion,
    direction: measurementResult(
      sweep >= 0 ? "clockwise" : "counterclockwise",
      { score, weakPoints }
    ),
    circularity: measurementResult(circularity, { score, weakPoints }),
  };
}

/**
 * Adds exercise-specific Pose features to the standard joint-angle set.
 * These are camera observations only; they do not measure pain, force,
 * weight-bearing, support stability, or whether resistance is appropriate.
 */
export function measurePoseExerciseFrame({
  poseResult,
  exercise,
  side = "right",
  poseHistory = [],
  visibilityThreshold = VISIBILITY_THRESHOLD,
}) {
  const landmarks = poseResult?.landmarks?.[0];
  const worldLandmarks = poseResult?.worldLandmarks?.[0];
  if (!landmarks || !worldLandmarks) return {};

  const measurements = jointAngles(worldLandmarks, landmarks, visibilityThreshold);
  const working = sideIndices(side);
  const opposite = sideIndices(side === "left" ? "right" : "left");
  const both = {
    shoulders: [LM.leftShoulder, LM.rightShoulder],
    hips: [LM.leftHip, LM.rightHip],
    knees: [LM.leftKnee, LM.rightKnee],
    ankles: [LM.leftAnkle, LM.rightAnkle],
    wrists: [LM.leftWrist, LM.rightWrist],
  };

  const add = (key, value) => { measurements[key] = value; };
  // Every metric below inherits the frame's visibility threshold, so calibration
  // can loosen it (occluded side-lying / floor poses still measure) without
  // affecting live rep-tracking, which keeps the default.
  const qualityOptions = { threshold: visibilityThreshold };
  const bodyScaleMeasurement = (lm, indices, names, calculate) =>
    scaledMeasurement(lm, indices, names, calculate, qualityOptions);
  const relativeMotionRange = (history, pointIndices, anchorIndices, referencePair) =>
    relativeMotionRangeImpl(history, pointIndices, anchorIndices, referencePair, qualityOptions);
  const id = exercise?.id;

  if ([
    "supported_single_leg_balance",
    "supported_forward_step_up",
  ].includes(id)) {
    add("workingFootClearance", bodyScaleMeasurement(
      landmarks,
      [working.ankle, opposite.ankle, working.knee],
      ["working_ankle", "standing_ankle", "working_knee"],
      (workingAnkle, standingAnkle, workingKnee) => safeRatio(
        Math.max(0, standingAnkle.y - workingAnkle.y),
        distance(workingKnee, workingAnkle)
      )
    ));
  }

  if (id === "supported_single_leg_balance") {
    add(
      "standingKnee",
      measurements[`${side === "left" ? "right" : "left"}Knee`]
    );
  }

  if (id === "clamshell") {
    add("kneeSeparation", bodyScaleMeasurement(
      landmarks,
      [...both.knees, working.hip],
      ["left_knee", "right_knee", "working_hip"],
      (leftKnee, rightKnee, workingHip) => safeRatio(
        distance(leftKnee, rightKnee),
        distance(workingHip, landmarks[working.knee])
      )
    ));
    add("ankleSeparation", bodyScaleMeasurement(
      landmarks,
      [...both.ankles, working.knee],
      ["left_ankle", "right_ankle", "working_knee"],
      (leftAnkle, rightAnkle, workingKnee) => safeRatio(
        distance(leftAnkle, rightAnkle),
        distance(workingKnee, landmarks[working.ankle])
      )
    ));
  }

  if (["ankle_rotations", "ankle_range_of_motion", "pendulum"].includes(id)) {
    const isArm = id === "pendulum";
    const trajectory = localTrajectory(
      poseHistory,
      isArm ? working.wrist : working.foot,
      isArm ? working.shoulder : working.ankle,
      isArm
        ? [working.shoulder, working.wrist]
        : [working.knee, working.ankle]
    );
    add(isArm ? "wristMotion" : "toeMotion", trajectory.motion);
    if (id === "ankle_rotations") {
      add("circleDirection", trajectory.direction);
      add("circleScore", trajectory.circularity);
    }
    if (!isArm) {
      add("legMotion", relativeMotionRange(
        poseHistory,
        [working.knee],
        [working.hip],
        [working.hip, working.ankle]
      ));
    }
  }

  if (id === "hip_flexor_stretch") {
    add("oppositeHip", measurements[`${side === "left" ? "right" : "left"}Hip`]);
  }

  if (id === "crossover_arm_stretch") {
    add("wristAcrossMidline", bodyScaleMeasurement(
      landmarks,
      [working.wrist, ...both.shoulders],
      ["working_wrist", "left_shoulder", "right_shoulder"],
      (wrist, leftShoulder, rightShoulder) => {
        const centreX = (leftShoulder.x + rightShoulder.x) / 2;
        const crossing = side === "right" ? centreX - wrist.x : wrist.x - centreX;
        return crossing / distance(leftShoulder, rightShoulder);
      }
    ));
  }

  if (id === "external_rotation_with_resistance_band") {
    add("wristOutwardRatio", bodyScaleMeasurement(
      landmarks,
      [working.elbow, working.wrist],
      ["working_elbow", "working_wrist"],
      (elbow, wrist) => safeRatio(
        Math.abs(wrist.x - elbow.x),
        distance(elbow, wrist)
      )
    ));
  }

  if (id === "shoulder_forward_elevation_assisted") {
    add("handProximity", bodyScaleMeasurement(
      landmarks,
      [...both.wrists, LM.leftElbow, LM.rightElbow],
      ["left_wrist", "right_wrist", "left_elbow", "right_elbow"],
      (leftWrist, rightWrist, leftElbow, rightElbow) => safeRatio(
        distance(leftWrist, rightWrist),
        (distance(leftElbow, leftWrist) + distance(rightElbow, rightWrist)) / 2
      )
    ));
  }

  if (["walking_progression", "walking_with_mobility_aid"].includes(id)) {
    add("footLead", bodyScaleMeasurement(
      landmarks,
      [working.foot, opposite.foot, working.hip, working.ankle],
      ["working_foot", "opposite_foot", "working_hip", "working_ankle"],
      (workingFoot, oppositeFoot, workingHip, workingAnkle) => {
        let directionSign = 1;
        if (poseHistory.length >= 2) {
          const first = poseHistory[0].landmarks;
          const last = poseHistory.at(-1).landmarks;
          const firstHipX = (first[LM.leftHip].x + first[LM.rightHip].x) / 2;
          const lastHipX = (last[LM.leftHip].x + last[LM.rightHip].x) / 2;
          if (Math.abs(lastHipX - firstHipX) > 0.02) {
            directionSign = Math.sign(lastHipX - firstHipX);
          }
        }
        return safeRatio(
          (workingFoot.x - oppositeFoot.x) * directionSign,
          distance(workingHip, workingAnkle)
        );
      }
    ));
  }

  if (id === "walking_with_mobility_aid") {
    add("handMotion", relativeMotionRange(
      poseHistory,
      both.wrists,
      both.hips,
      both.shoulders
    ));
  }

  // ── Per-landmark velocity and overall body speed ──────────────────────────
  // Uses the two most recent history frames. Values are in body-normalised
  // units per second (same scale as landmarkDisplacement).
  if (poseHistory.length >= 2) {
    const prev = poseHistory.at(-2);
    const curr = poseHistory.at(-1);
    const elapsedMs = curr.timestampMs - prev.timestampMs;
    const hipDist = distance(curr.landmarks[LM.leftHip], curr.landmarks[LM.rightHip]);
    const scale = hipDist > 0 ? hipDist : 1;
    const velocityOpts = { referenceA: curr.landmarks[LM.leftHip], referenceB: curr.landmarks[LM.rightHip] };

    const LANDMARK_KEYS = {
      ankle:    working.ankle,
      knee:     working.knee,
      hip:      working.hip,
      shoulder: working.shoulder,
      wrist:    working.wrist,
      foot:     working.foot,
    };

    let speedSum = 0;
    let speedCount = 0;
    for (const [name, idx] of Object.entries(LANDMARK_KEYS)) {
      const vel = movementVelocity(prev.landmarks[idx], curr.landmarks[idx], elapsedMs, velocityOpts);
      add(`${name}Speed`, vel);
      if (!vel.lowConfidence && Number.isFinite(vel.value)) {
        speedSum += vel.value;
        speedCount++;
      }
    }

    add("overallSpeed", measurementResult(
      speedCount > 0 ? speedSum / speedCount : NaN,
      { unavailable: speedCount === 0 }
    ));
  }

  return measurements;
}

export function measureCombinedForearmFrame({
  poseResult,
  handResult,
  side = "right",
  frame = {},
  poseHistory = [],
  options = {},
}) {
  const poseLandmarks = poseResult?.landmarks?.[0];
  const poseWorldLandmarks = poseResult?.worldLandmarks?.[0];
  if (!poseLandmarks || !poseWorldLandmarks) return {};
  const hands = summarizeHandResult(handResult, frame);
  const match = matchHandToPoseWrist(poseLandmarks, hands, side, options);
  if (match.confidence.status === "unavailable") return {};
  const hand = match.value.hand;
  const sideLm = sideIndices(side);
  const angles = jointAngles(poseWorldLandmarks, poseLandmarks);
  const upperArmMotion = relativeMotionRangeImpl(
    recentHistory(poseHistory, 800),
    [sideLm.elbow],
    [sideLm.shoulder],
    [LM.leftShoulder, LM.rightShoulder]
  );
  return {
    elbow: measurementResult(angles[`${side}Elbow`].value, {
      unavailable: angles[`${side}Elbow`].lowConfidence,
      weakPoints: angles[`${side}Elbow`].weakPoints,
    }),
    palmDirection: derivedMeasurement(
      hand.palm,
      hand.palm.value?.direction ?? null
    ),
    handFrameReady: derivedMeasurement(hand.framing, hand.framing.ready ? 1 : 0),
    wristMatch: derivedMeasurement(match, match.value.distance),
    upperArmMotion,
  };
}

export function measureCombinedExerciseFrame(options) {
  if (options.exercise?.id === "forearm_supination_pronation_strengthening") {
    return measureCombinedForearmFrame(options);
  }
  return measureCombinedWristFrame(options);
}

export function measureHandExerciseFrame(options) {
  return measureHandSequenceFrame(options);
}
