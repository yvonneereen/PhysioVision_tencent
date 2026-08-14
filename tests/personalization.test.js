import assert from "node:assert/strict";

import { EXERCISES, EXERCISE_MAP } from "../exercises/registry.js";
import {
  applyCalibration,
  calibrationFrameMatchesPhase,
  clearCalibration,
  createCalibration,
  getCalibration,
  inspectCalibrationFrame,
  loadProfile,
  saveCalibration,
  saveProfile,
  validateCalibrationCapture,
} from "../personalization.js";

const halfSquat = EXERCISE_MAP["half-squats"];

{
  const visible = (value) => ({
    value,
    lowConfidence: false,
    weakPoints: [],
  });
  const angles = {
    leftKnee: visible(120),
    leftHip: visible(125),
    rightHip: visible(125),
  };
  angles.rightKnee = {
    value: NaN,
    lowConfidence: true,
    weakPoints: ["rightHip", "rightKnee", "rightAnkle"],
  };
  const inspection = inspectCalibrationFrame(halfSquat, angles, "right");
  assert.deepEqual(inspection.frame, { knee: 120 });
  assert.deepEqual(inspection.missingMeasurements, []);
  assert.equal(inspection.trackingSide, "left");

  angles.leftKnee = {
    value: NaN,
    lowConfidence: true,
    weakPoints: ["leftHip", "leftKnee", "leftAnkle"],
  };
  const unavailable = inspectCalibrationFrame(halfSquat, angles, "right");
  assert.equal(unavailable.frame, null);
  assert.deepEqual(unavailable.missingMeasurements, ["knee"]);
  assert.deepEqual(unavailable.weakPoints, [
    "rightHip",
    "rightKnee",
    "rightAnkle",
  ]);
}

function frames(values, count = 12) {
  return Array.from({ length: count }, (_, index) =>
    Object.fromEntries(
      Object.entries(values).map(([key, value]) => [
        key,
        value + ((index % 3) - 1) * 0.3,
      ])
    )
  );
}

const standing = frames({
  knee: 170,
  hip: 165,
});

const targetCaptures = [
  frames({
    knee: 132,
    hip: 138,
  }),
  frames({
    knee: 128,
    hip: 134,
  }),
  frames({
    knee: 130,
    hip: 136,
  }),
];

{
  const calibration = createCalibration(halfSquat, {
    affectedSide: "right",
    startFrames: standing,
    targetCaptures: [targetCaptures[1]],
  });

  assert.equal(calibration.target.knee.median, 128);
  assert.equal(calibration.target.knee.repetitions, 1);
  assert.ok(calibration.target.knee.variability > 0);
}

{
  const calibration = createCalibration(halfSquat, {
    affectedSide: "right",
    startFrames: standing,
    targetCaptures,
  });

  assert.equal(calibration.target.knee.median, 130);
  assert.deepEqual(calibration.phaseRanges.squat.knee, [118, 142]);
  assert.equal(calibration.naturalKneeDifference, null);

  const personalised = applyCalibration(halfSquat, calibration);
  const squat = personalised.phases.find((phase) => phase.name === "squat");
  assert.deepEqual(squat.knee, [118, 142]);
  assert.equal(personalised.symmetry.maxDiffDeg, 15);

  const tampered = applyCalibration(halfSquat, {
    ...calibration,
    phaseRanges: {
      squat: {
        knee: [-100, 999],
        hip: [-100, 999],
      },
    },
  });
  const tamperedSquat = tampered.phases.find((phase) => phase.name === "squat");
  assert.deepEqual(tamperedSquat.knee, [45, 165]);
  assert.deepEqual(tamperedSquat.hip, [90, 135]);
}

{
  const legacy = applyCalibration(halfSquat, {
    version: 1,
    exerciseId: "half-squats",
    affectedSide: "right",
    phaseRanges: {
      standing: { rightKnee: [158, 180], rightHip: [153, 180] },
      squat: { rightKnee: [118, 142], rightHip: [122, 146] },
    },
  });
  const squat = legacy.phases.find((phase) => phase.name === "squat");
  assert.deepEqual(squat.knee, [118, 142]);
  assert.deepEqual(squat.hip, [90, 135]);
}

{
  const standingFrame = {
    knee: 170,
    hip: 165,
  };
  const squatFrame = {
    knee: 130,
    hip: 136,
  };

  assert.equal(
    calibrationFrameMatchesPhase(halfSquat, standingFrame, "start"),
    true
  );
  assert.equal(
    calibrationFrameMatchesPhase(halfSquat, standingFrame, "target"),
    false
  );
  assert.equal(
    calibrationFrameMatchesPhase(halfSquat, squatFrame, "target"),
    true
  );
}

{
  assert.equal(
    calibrationFrameMatchesPhase(
      halfSquat,
      { knee: 152, hip: 158 },
      "target"
    ),
    true
  );
}

{
  const implausibleCapture = frames({
    knee: 35,
    hip: 135,
  });

  assert.throws(
    () => validateCalibrationCapture(halfSquat, implausibleCapture, "target"),
    /prescribed or approved/
  );
}

{
  for (const exercise of EXERCISES) {
    assert.ok(exercise.calibration, `${exercise.id} needs a calibration contract`);
    assert.ok(exercise.calibration.startPhase, exercise.id);
    assert.ok(exercise.calibration.targetPhase, exercise.id);
    assert.ok(exercise.calibration.captureKeys.length > 0, exercise.id);
    assert.ok(Array.isArray(exercise.calibration.personalizedKeys), exercise.id);
  }
}

{
  const calfRaises = EXERCISE_MAP["calf-raises"];
  assert.equal(calfRaises.calibration.version, 2);
  assert.throws(
    () => createCalibration(calfRaises, {
      affectedSide: "right",
      startFrames: frames({ footInclination: 2 }),
      targetCaptures: [frames({ footInclination: 8 })],
    }),
    /too close to the starting position/
  );
  const calibration = createCalibration(calfRaises, {
    affectedSide: "right",
    startFrames: frames({ footInclination: 2 }),
    targetCaptures: [frames({ footInclination: 24 })],
  });
  assert.equal(calibration.version, 2);
  assert.deepEqual(calibration.phaseRanges.flat.footInclination, [0, 7]);
  assert.deepEqual(calibration.phaseRanges.raised.footInclination, [19, 29]);
}

function calibrationValue(condition) {
  if (Array.isArray(condition)) return (condition[0] + condition[1]) / 2;
  if (condition && Object.hasOwn(condition, "equals")) return condition.equals;
  if (condition && Array.isArray(condition.oneOf)) return condition.oneOf[0];
  throw new Error(`Unsupported calibration condition ${JSON.stringify(condition)}`);
}

function safeCalibrationFrames(config, captureType, count = 12) {
  const conditions = {
    ...(config.safeRanges?.[captureType] ?? {}),
    ...(config.safeConditions?.[captureType] ?? {}),
  };
  const frame = Object.fromEntries(config.captureKeys.map((key) => [
    key,
    calibrationValue(conditions[key]),
  ]));
  return Array.from({ length: count }, () => ({ ...frame }));
}

{
  for (const exercise of EXERCISES) {
    const config = exercise.calibration;
    const targetFrames = safeCalibrationFrames(config, "target");
    const calibration = createCalibration(exercise, {
      affectedSide: "right",
      startFrames: safeCalibrationFrames(config, "start"),
      targetCaptures: [targetFrames, targetFrames, targetFrames],
    });
    const personalised = applyCalibration(exercise, calibration);
    assert.equal(personalised.activeCalibration.exerciseId, exercise.id);

    for (const key of config.personalizedKeys) {
      const range = calibration.phaseRanges[config.targetPhase]?.[key];
      const safe = config.safeRanges.target[key];
      assert.ok(range, `${exercise.id}.${key} was not personalized`);
      assert.ok(range[0] >= safe[0], `${exercise.id}.${key} loosened its minimum`);
      assert.ok(range[1] <= safe[1], `${exercise.id}.${key} loosened its maximum`);
    }
  }
}

{
  const ankleMotion = EXERCISE_MAP.ankle_range_of_motion;
  const ratioFrames = (values, count = 12) =>
    Array.from({ length: count }, (_, index) =>
      Object.fromEntries(Object.entries(values).map(([key, value]) => [
        key,
        value + ((index % 3) - 1) * 0.003,
      ]))
    );
  const startFrames = ratioFrames({ toeMotion: 0.02, legMotion: 0.03 });
  const motionCaptures = [0.28, 0.3, 0.32].map((toeMotion) =>
    ratioFrames({ toeMotion, legMotion: 0.04 })
  );
  const calibration = createCalibration(ankleMotion, {
    affectedSide: "right",
    startFrames,
    targetCaptures: motionCaptures,
  });

  assert.equal(calibration.target.toeMotion.median, 0.3);
  assert.deepEqual(calibration.phaseRanges.letter_motion.toeMotion, [0.24, 0.36]);
  const personalised = applyCalibration(ankleMotion, calibration);
  assert.deepEqual(
    personalised.phases.find((phase) => phase.name === "letter_motion").toeMotion,
    [0.24, 0.36]
  );
  assert.deepEqual(
    personalised.phases.find((phase) => phase.name === "letter_motion").legMotion,
    [0, 0.12]
  );
}

function categoricalFrames(handShape, count = 12) {
  return Array.from({ length: count }, () => ({
    handShape,
    handShapeScore: 0.9,
    handFrameReady: 1,
  }));
}

{
  const tendonGlides = EXERCISE_MAP.tendon_glides;
  const calibration = createCalibration(tendonGlides, {
    affectedSide: "right",
    startFrames: categoricalFrames("open_hand"),
    targetCaptures: [
      categoricalFrames("hook_fist"),
      categoricalFrames("hook_fist"),
      categoricalFrames("hook_fist"),
    ],
  });

  assert.equal(calibration.start.handShape.value, "open_hand");
  assert.equal(calibration.target.handShape.value, "hook_fist");
  assert.deepEqual(calibration.phaseRanges.open_hand, {});
  assert.deepEqual(calibration.phaseRanges.hook_fist, {});
  assert.throws(
    () => validateCalibrationCapture(
      tendonGlides,
      categoricalFrames("full_fist"),
      "target"
    ),
    /Hand Shape/
  );
}

{
  const values = new Map();
  globalThis.window = {
    sessionStorage: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
    },
    dispatchEvent: () => {},
  };
  if (typeof globalThis.CustomEvent === "undefined") {
    globalThis.CustomEvent = class CustomEvent {
      constructor(type, options) {
        this.type = type;
        this.detail = options?.detail;
      }
    };
  }
  const left = {
    version: 1,
    exerciseId: "ankle_pumps",
    affectedSide: "left",
  };
  const right = { ...left, affectedSide: "right" };
  saveCalibration(left);
  saveCalibration(right);
  assert.equal(getCalibration("ankle_pumps", "left").affectedSide, "left");
  assert.equal(getCalibration("ankle_pumps", "right").affectedSide, "right");

  saveCalibration({
    version: 1,
    exerciseId: "calf-raises",
    affectedSide: "right",
  });
  assert.equal(getCalibration("calf-raises", "right"), null);
  saveCalibration({
    version: 2,
    exerciseId: "calf-raises",
    affectedSide: "right",
  });
  assert.equal(getCalibration("calf-raises", "right").version, 2);
  clearCalibration("ankle_pumps", "left");
  assert.equal(getCalibration("ankle_pumps", "left"), null);
  assert.equal(getCalibration("ankle_pumps", "right").affectedSide, "right");

  const savedProfile = saveProfile({
    emergencyContactName: "  Alex Tan  ",
    emergencyContactRelationship: "Family member",
    emergencyContactPhone: "  +65 9123 4567  ",
    emergencyContactConsent: true,
  }, { syncBackend: false });
  assert.equal(savedProfile.emergencyContactName, "Alex Tan");
  assert.equal(savedProfile.emergencyContactRelationship, "Family member");
  assert.equal(savedProfile.emergencyContactPhone, "+65 9123 4567");
  assert.equal(savedProfile.emergencyContactConsent, true);
  assert.equal(loadProfile().emergencyContactName, "Alex Tan");

  const clearedProfile = saveProfile({
    emergencyContactName: "",
    emergencyContactRelationship: "",
    emergencyContactPhone: "",
    emergencyContactConsent: false,
  }, { syncBackend: false });
  assert.equal(clearedProfile.emergencyContactName, "");
  assert.equal(clearedProfile.emergencyContactRelationship, "");
  assert.equal(clearedProfile.emergencyContactPhone, "");
  assert.equal(clearedProfile.emergencyContactConsent, false);
}

console.log("personal calibration tests passed");
