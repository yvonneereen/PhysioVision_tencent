import assert from "node:assert/strict";

import { FeedbackEngine } from "../feedback/engine.js";
import { DRAFT_EXERCISES } from "../exercises/catalog.js";
import { EXERCISE_MAP } from "../exercises/registry.js";

const visible = (value) => ({
  value,
  lowConfidence: false,
  weakPoints: [],
});

const handShapeFrame = (label, score = 0.9) => ({
  handShape: visible(label),
  handShapeScore: visible(score),
  handFrameReady: visible(1),
});

const wristFrame = (wristBend) => ({
  elbow: visible(170),
  wristBend: visible(wristBend),
  palmDown: visible(0.8),
  forearmHorizontal: visible(0.9),
  forearmVelocity: visible(0.05),
  wristMatch: visible(0.02),
});

const hidden = {
  value: Number.NaN,
  lowConfidence: true,
  weakPoints: ["rightKnee"],
};

// Every selectable exercise must provide at least one specific correction in
// addition to the shared tracking and phase-order guidance in main.js. This
// prevents future catalogue additions from silently falling back to generic
// feedback only.
for (const exercise of Object.values(EXERCISE_MAP)) {
  assert.ok(
    Object.keys(exercise.cues ?? {}).length > 0,
    `${exercise.id} has no movement-specific correction cue`
  );
}

function valueForCondition(condition) {
  if (Array.isArray(condition)) return (condition[0] + condition[1]) / 2;
  if (condition && Object.hasOwn(condition, "equals")) return condition.equals;
  if (condition && Array.isArray(condition.oneOf)) return condition.oneOf[0];
  throw new Error(`Unsupported test condition ${JSON.stringify(condition)}`);
}

function measurementsForPhase(exercise, phaseName) {
  const phase = exercise.phases.find((candidate) => candidate.name === phaseName);
  const defaults = {};
  exercise.phases.forEach((candidate) => {
    Object.entries(candidate).forEach(([key, condition]) => {
      if (key !== "name" && !(key in defaults)) {
        defaults[key] = visible(valueForCondition(condition));
      }
    });
  });
  Object.entries(phase).forEach(([key, condition]) => {
    if (key !== "name") defaults[key] = visible(valueForCondition(condition));
  });
  return defaults;
}

const halfSquatPose = (overrides = {}) => ({
  leftKnee: visible(170),
  rightKnee: visible(170),
  leftHip: visible(165),
  rightHip: visible(165),
  torsoLean: visible(10),
  leftKneeForwardRatio: visible(0),
  rightKneeForwardRatio: visible(0),
  ...overrides,
});

const halfSquatBottom = (overrides = {}) =>
  halfSquatPose({
    leftKnee: visible(110),
    rightKnee: visible(110),
    leftHip: visible(115),
    rightHip: visible(115),
    torsoLean: visible(25),
    ...overrides,
  });

assert.equal(
  EXERCISE_MAP["half-squats"].prescription.sets,
  1,
  "the unassigned wellness fallback should finish after its 10-repetition target"
);

{
  const engine = new FeedbackEngine("half-squats", "right");
  const result = engine.update(halfSquatPose({ rightKnee: hidden }));

  assert.equal(result.trackingReady, true);
  assert.deepEqual(result.missingMeasurements, []);
  assert.equal(result.trackingSide, "left");
  assert.equal(result.limitedTracking, true);
  assert.equal(result.symmetryAvailable, false);
}

{
  const engine = new FeedbackEngine("half-squats", "left", {
    version: 1,
    exerciseId: "half-squats",
    affectedSide: "right",
    phaseRanges: { squat: { leftKnee: [120, 130] } },
  });
  assert.equal(engine.exercise.activeCalibration, undefined);
}

{
  const engine = new FeedbackEngine("half-squats", "right", {
    version: 1,
    exerciseId: "half-squats",
    affectedSide: "right",
    phaseRanges: {
      standing: { knee: [160, 180] },
      squat: { knee: [118, 142] },
    },
  });
  engine.update(halfSquatPose(), 0);
  engine.update(halfSquatPose(), 400);
  const outsidePersonalTarget = halfSquatPose({
    leftKnee: visible(150),
    rightKnee: visible(150),
  });
  assert.equal(
    engine.update(outsidePersonalTarget, 800).detectedPhase,
    null,
    "an active calibration must replace the generic squat target range",
  );
  const personalTarget = halfSquatPose({
    leftKnee: visible(130),
    rightKnee: visible(130),
  });
  assert.equal(engine.update(personalTarget, 900).detectedPhase, "squat");
}

{
  const engine = new FeedbackEngine("half-squats", "right");
  const result = engine.update(halfSquatPose());

  assert.equal(result.trackingReady, true);
  assert.deepEqual(result.missingMeasurements, []);
}

{
  const engine = new FeedbackEngine("half-squats", "right");
  const standing = halfSquatPose({
    leftKneeForwardRatio: hidden,
    rightKneeForwardRatio: hidden,
  });
  const squat = halfSquatBottom({
    leftKneeForwardRatio: hidden,
    rightKneeForwardRatio: hidden,
  });

  assert.equal(engine.update(standing, 0).trackingReady, true);
  engine.update(standing, 400);
  engine.update(squat, 500);
  engine.update(squat, 900);
  engine.update(standing, 1000);
  const completed = engine.update(standing, 1400);

  assert.equal(completed.trackingReady, true);
  assert.equal(completed.repCount, 1);
}

{
  const engine = new FeedbackEngine("half-squats", "right");
  const standing = halfSquatPose({ leftKnee: hidden });
  const squat = halfSquatBottom({ leftKnee: hidden });
  engine.update(standing, 0);
  engine.update(standing, 400);
  engine.update(squat, 500);
  const result = engine.update(squat, 900);

  assert.equal(result.trackingReady, true);
  assert.equal(result.trackingSide, "right");
  assert.equal(result.phase, "squat");
  assert.equal(result.repCount, 0);
}

{
  const engine = new FeedbackEngine("half-squats", "right");
  engine.update(halfSquatPose(), 0);
  const ready = engine.update(halfSquatPose(), 400);

  assert.equal(ready.startConfirmed, true);
  assert.equal(engine.update(halfSquatBottom(), 500).phase, "standing");
  assert.equal(engine.update(halfSquatBottom(), 679).phase, "standing");
  assert.equal(engine.update(halfSquatBottom(), 680).phase, "squat");
  assert.equal(engine.update(halfSquatPose(), 1000).repCount, 0);

  const completed = engine.update(halfSquatPose(), 1140);
  assert.equal(completed.phase, "standing");
  assert.equal(completed.repCount, 1);
}

{
  const engine = new FeedbackEngine("half-squats", "right");
  const partialReturn = halfSquatPose({
    leftKnee: visible(150),
    rightKnee: visible(150),
  });
  const recoveredReturn = halfSquatPose({
    leftKnee: visible(156),
    rightKnee: visible(156),
  });

  engine.update(halfSquatPose(), 0);
  engine.update(halfSquatPose(), 400);
  engine.update(halfSquatBottom(), 500);
  engine.update(halfSquatBottom(), 680);
  assert.equal(
    engine.update(partialReturn, 760).repCount,
    0,
    "a partially recovered squat must not count as standing"
  );
  const returning = engine.update(recoveredReturn, 900);
  assert.equal(
    returning.progress,
    1,
    "return progress should reach 100% at the same angle used for recognition"
  );
  const completed = engine.update(recoveredReturn, 1040);
  assert.equal(
    completed.repCount,
    1,
    "recovering most of the observed excursion should count without requiring the exact baseline angle"
  );
}

{
  const engine = new FeedbackEngine("half-squats", "right");
  let timestamp = 0;
  engine.update(halfSquatPose(), timestamp);
  timestamp += 220;
  engine.update(halfSquatPose(), timestamp);

  for (let repetition = 1; repetition <= 4; repetition += 1) {
    const kneeAngle = repetition === 2 ? 70 : 110;
    const bottom = halfSquatBottom({
      leftKnee: visible(kneeAngle),
      rightKnee: visible(kneeAngle),
    });
    timestamp += 60;
    engine.update(bottom, timestamp);
    timestamp += 180;
    engine.update(bottom, timestamp);
    timestamp += 60;
    engine.update(halfSquatPose(), timestamp);
    timestamp += 140;
    engine.update(halfSquatPose(), timestamp);
  }

  assert.equal(
    engine.repCount,
    4,
    "four complete returns to standing, including one deep squat, must count as four repetitions",
  );
}

{
  const engine = new FeedbackEngine("half-squats", "right");
  engine.update(halfSquatPose(), 0);
  engine.update(halfSquatPose(), 400);
  engine.update(halfSquatBottom(), 500);
  engine.update(halfSquatBottom(), 900);

  assert.equal(engine.update(halfSquatPose(), 1000).repCount, 0);
  assert.equal(
    engine.update(halfSquatPose(), 1180).repCount,
    1,
    "a visible standing return should count without a second 400 ms hold"
  );
}

{
  const engine = new FeedbackEngine("half-squats", "right");
  engine.update(halfSquatPose(), 0);
  engine.update(halfSquatPose(), 400);
  engine.update(halfSquatBottom(), 500);
  engine.update(halfSquatBottom(), 900);
  engine.update(halfSquatPose(), 1000);

  assert.equal(
    engine.update(halfSquatBottom(), 1100).repCount,
    0,
    "a single fleeting standing frame must not complete a repetition"
  );
}

{
  const engine = new FeedbackEngine("half-squats", "right");
  let timestamp = 0;
  engine.update(halfSquatPose(), timestamp);
  engine.update(halfSquatPose(), timestamp += 400);
  for (let repetition = 1; repetition <= 10; repetition += 1) {
    engine.update(halfSquatBottom(), timestamp += 100);
    engine.update(halfSquatBottom(), timestamp += 400);
    engine.update(halfSquatPose(), timestamp += 100);
    const result = engine.update(halfSquatPose(), timestamp += 180);
    assert.equal(result.repCount, repetition);
  }
  assert.equal(engine.repCount, 10, "the target repetition must be recorded");
}

{
  // Exercise the engine with the same faster EMA used by main.js and a
  // continuous, no-pause home-exercise cadence. Every standing return must be
  // credited before the following descent begins.
  const engine = new FeedbackEngine("half-squats", "right");
  let timestamp = 0;
  let smoothedKnee = 170;
  const feedRawKnee = (rawKnee, durationMs) => {
    let result = null;
    const frameCount = Math.ceil(durationMs / 40);
    for (let frame = 0; frame < frameCount; frame += 1) {
      smoothedKnee += 0.65 * (rawKnee - smoothedKnee);
      timestamp += 40;
      result = engine.update(halfSquatPose({
        leftKnee: visible(smoothedKnee),
        rightKnee: visible(smoothedKnee),
      }), timestamp);
    }
    return result;
  };

  feedRawKnee(170, 480);
  for (let repetition = 1; repetition <= 10; repetition += 1) {
    feedRawKnee(110, 360);
    const returned = feedRawKnee(170, 360);
    assert.equal(
      returned.repCount,
      repetition,
      `continuous repetition ${repetition} should count on its own standing return`
    );
  }
  assert.equal(engine.repCount, 10);
}

{
  const engine = new FeedbackEngine("half-squats", "right");
  engine.update(halfSquatBottom(), 0);
  engine.update(halfSquatBottom(), 500);
  engine.update(halfSquatPose(), 600);
  const result = engine.update(halfSquatPose(), 1000);

  assert.equal(result.startConfirmed, true);
  assert.equal(result.repCount, 0);
}

{
  const engine = new FeedbackEngine("half-squats", "right");
  const oneMeasurableKnee = halfSquatPose({
    leftKnee: hidden,
    rightHip: hidden,
  });
  const result = engine.update(oneMeasurableKnee);

  assert.equal(result.trackingReady, true);
  assert.equal(result.trackingSide, "right");
}

{
  const engine = new FeedbackEngine("half-squats", "right");
  const result = engine.update(halfSquatPose({
    leftKnee: hidden,
    rightKnee: hidden,
  }));
  assert.equal(result.trackingReady, false);
  assert.equal(result.progress, 0);
  assert.ok(result.missingMeasurements.length > 0);
  assert.deepEqual(result.missingLandmarks, ["rightKnee"]);
}

{
  const engine = new FeedbackEngine("half-squats", "right");
  const shallowSquat = halfSquatPose({
    rightKnee: visible(140),
    rightHip: visible(140),
  });
  engine.update(halfSquatPose(), 0);
  engine.update(halfSquatPose(), 400);
  engine.update(shallowSquat, 500);
  assert.equal(engine.update(shallowSquat, 900).phase, "squat");
  engine.update(halfSquatPose(), 1000);
  assert.equal(engine.update(halfSquatPose(), 1400).repCount, 1);
}

{
  const engine = new FeedbackEngine("half-squats", "right");
  const shallowSquat = halfSquatPose({
    rightKnee: visible(152),
    rightHip: hidden,
  });
  const standingWithHiddenHip = halfSquatPose({ rightHip: hidden });

  engine.update(standingWithHiddenHip, 0);
  engine.update(standingWithHiddenHip, 400);
  engine.update(shallowSquat, 500);
  engine.update(shallowSquat, 900);
  engine.update(standingWithHiddenHip, 1000);
  const completed = engine.update(standingWithHiddenHip, 1400);

  assert.equal(completed.repCount, 1);
  assert.equal(completed.trackingReady, true);
}

{
  const engine = new FeedbackEngine("half-squats", "right");
  const smallStandingSway = halfSquatPose({ rightKnee: visible(162) });

  engine.update(halfSquatPose(), 0);
  engine.update(halfSquatPose(), 400);
  engine.update(smallStandingSway, 500);
  engine.update(smallStandingSway, 1000);
  engine.update(halfSquatPose(), 1100);
  const result = engine.update(halfSquatPose(), 1600);

  assert.equal(result.repCount, 0);
  assert.equal(result.phase, "standing");
}

{
  const engine = new FeedbackEngine("half-squats", "right");
  const rightOnlyStanding = halfSquatPose({ leftKnee: hidden });
  const leftOnlySquat = halfSquatPose({
    leftKnee: visible(150),
    rightKnee: hidden,
  });

  engine.update(rightOnlyStanding, 0);
  engine.update(rightOnlyStanding, 400);
  engine.update(leftOnlySquat, 500);
  engine.update(leftOnlySquat, 900);
  engine.update(rightOnlyStanding, 1000);
  const completed = engine.update(rightOnlyStanding, 1400);

  assert.equal(completed.repCount, 1);
}

{
  const engine = new FeedbackEngine("half-squats", "right");
  const squat = halfSquatBottom();
  const noKnees = halfSquatPose({ leftKnee: hidden, rightKnee: hidden });

  engine.update(halfSquatPose(), 0);
  engine.update(halfSquatPose(), 200);
  engine.update(noKnees, 260);
  engine.update(halfSquatPose(), 400);
  engine.update(squat, 500);
  engine.update(squat, 700);
  engine.update(noKnees, 760);
  engine.update(squat, 900);
  engine.update(halfSquatPose(), 1000);
  engine.update(halfSquatPose(), 1200);
  engine.update(noKnees, 1260);
  const completed = engine.update(halfSquatPose(), 1400);

  assert.equal(completed.startConfirmed, true);
  assert.equal(completed.repCount, 1);
}

{
  const engine = new FeedbackEngine("half-squats", "right");
  const kneeForward = engine.update(
    halfSquatPose({ leftKneeForwardRatio: visible(0.2) })
  );
  const torsoLean = engine.update(halfSquatPose({ torsoLean: visible(45) }));
  const multipleProblems = engine.update(
    halfSquatBottom({
      leftKnee: visible(70),
      rightKnee: visible(70),
      torsoLean: visible(45),
    })
  );

  assert.ok(
    kneeForward.cues.includes(
      "The camera observed forward knee movement relative to the foot. This is an observation only; follow your prescribed technique."
    )
  );
  assert.equal(
    kneeForward.cueDetails[0].qualityReliable,
    false,
    "front-camera knee-forward depth can guide but must not lower quality",
  );
  assert.deepEqual(
    torsoLean.cues,
    [],
    "torso lean must not be judged against one universal angle",
  );
  assert.ok(
    multipleProblems.cues.includes(
      "You are going deeper than needed for this half squat. Make the next squat shallower and lower only a little."
    ),
    "a clearly deep movement should produce immediate half-squat coaching",
  );
  assert.equal(multipleProblems.cueDetails[0].guidanceAllowed, true);
  assert.equal(
    multipleProblems.cueDetails[0].scoringEligible,
    false,
    "depth coaching must not lower movement quality",
  );
  assert.equal(kneeForward.cueDetails[0].scoringEligible, false);
  assert.equal(
    kneeForward.cueDetails[0].ruleCard.validationStatus,
    "unvalidated",
  );
}

{
  const engine = new FeedbackEngine("half-squats", "right", {
    version: 1,
    exerciseId: "half-squats",
    affectedSide: "right",
    phaseRanges: {
      standing: { knee: [160, 180] },
      squat: { knee: [118, 142] },
    },
  });
  engine.update(halfSquatPose(), 0);
  engine.update(halfSquatPose(), 220);

  const deepSquat = halfSquatBottom({
    leftKnee: visible(80),
    rightKnee: visible(80),
  });
  engine.update(deepSquat, 300);
  const heldDeepSquat = engine.update(deepSquat, 500);
  engine.update(halfSquatPose(), 560);
  const completed = engine.update(halfSquatPose(), 720);

  assert.equal(
    heldDeepSquat.detectedPhase,
    "squat",
    "going deeper than the saved target should still reach the squat phase",
  );
  assert.ok(
    heldDeepSquat.cues.includes(
      "You are going lower than your saved comfortable half-squat range. Make the next squat shallower and stop near the depth used during calibration."
    ),
    "the camera should coach a return to the personalized depth",
  );
  assert.equal(
    completed.repCount,
    1,
    "a too-deep squat should be counted and coached instead of silently discarded",
  );
}

{
  const engine = new FeedbackEngine("half-squats", "right");
  const unequalBending = engine.update(halfSquatPose({
    leftKnee: visible(130),
    rightKnee: visible(170),
  }));
  assert.ok(
    unequalBending.cues.includes(
      "The camera observed different knee-bending angles. This does not assess knee-to-toe alignment."
    )
  );
  assert.equal(unequalBending.cueDetails[0].scoringEligible, false);
}

{
  const engine = new FeedbackEngine("heel-cord-stretch", "right");
  const result = engine.update({
    rightAnkle: visible(100),
    rightKnee: hidden,
  });

  assert.equal(result.trackingReady, true);
}

{
  const engine = new FeedbackEngine("heel-cord-stretch", "right");
  engine.update({ rightAnkle: visible(100) });
  const holding = engine.update({ rightAnkle: visible(70) });
  const trackingLost = engine.update({ rightAnkle: hidden });

  assert.equal(holding.inHold, true);
  assert.equal(holding.trackingReady, true);
  assert.equal(trackingLost.inHold, true);
  assert.equal(trackingLost.trackingReady, false);
  assert.deepEqual(trackingLost.cues, []);
}

{
  const engine = new FeedbackEngine("heel-cord-stretch", "right");
  const neutral = engine.update({ rightAnkle: visible(135) });
  const stretch = engine.update({ rightAnkle: visible(125) });

  assert.equal(neutral.detectedPhase, "neutral");
  assert.equal(stretch.detectedPhase, "stretch");
  assert.equal(stretch.inHold, true);
}

{
  const engine = new FeedbackEngine("ankle_pumps", "right");
  const toesUp = { rightAnkle: visible(75), rightKnee: visible(165) };
  const toesDown = { rightAnkle: visible(120), rightKnee: visible(165) };

  engine.update(toesUp, 0);
  assert.equal(engine.update(toesUp, 300).startConfirmed, true);
  engine.update(toesDown, 400);
  assert.equal(engine.update(toesDown, 700).phase, "toes_down");
  engine.update(toesUp, 800);
  const completed = engine.update(toesUp, 1100);

  assert.equal(completed.repCount, 1);
  assert.equal(completed.phase, "toes_up");
}

{
  const engine = new FeedbackEngine("ankle_pumps", "right");
  const transition = engine.update({
    rightAnkle: visible(93),
    rightKnee: visible(165),
  });

  assert.equal(transition.trackingReady, true);
  assert.equal(transition.positionRecognized, false);
  assert.equal(transition.detectedPhase, null);
}

{
  const engine = new FeedbackEngine("heel_slides", "left");
  const bent = { leftKnee: visible(90) };
  const extended = { leftKnee: visible(165) };

  engine.update(bent, 0);
  engine.update(bent, 300);
  engine.update(extended, 400);
  engine.update(extended, 700);
  engine.update(bent, 800);
  const completed = engine.update(bent, 1100);

  assert.equal(completed.repCount, 1);
}

{
  const engine = new FeedbackEngine("heel_slides", "left");
  const result = engine.update({ leftKnee: visible(45) });

  assert.deepEqual(result.cues, [
    "Use a smaller knee bend and keep the movement within your comfortable range",
  ]);
}

{
  const engine = new FeedbackEngine("hip_bridge", "right");
  const down = { rightHip: visible(130), rightKnee: visible(90) };
  const raised = { rightHip: visible(168), rightKnee: visible(90) };

  engine.update(down, 0);
  engine.update(down, 300);
  engine.update(raised, 400);
  engine.update(raised, 700);
  engine.update(down, 800);
  const completed = engine.update(down, 1100);

  assert.equal(completed.repCount, 1);
}

{
  const engine = new FeedbackEngine("tendon_glides", "right");
  const sequence = [
    "open_hand",
    "hook_fist",
    "open_hand",
    "full_fist",
    "open_hand",
    "tabletop",
    "open_hand",
    "straight_fist",
    "open_hand",
  ];
  let timestamp = 0;
  engine.update(handShapeFrame(sequence[0]), timestamp);
  timestamp += 350;
  engine.update(handShapeFrame(sequence[0]), timestamp);
  for (const shape of sequence.slice(1)) {
    timestamp += 50;
    engine.update(handShapeFrame(shape), timestamp);
    timestamp += 350;
    engine.update(handShapeFrame(shape), timestamp);
  }
  assert.equal(engine.repCount, 1);
  assert.equal(engine.currentPhase, "open_hand");
}

{
  const engine = new FeedbackEngine("tendon_glides", "right");
  engine.update(handShapeFrame("open_hand"), 0);
  engine.update(handShapeFrame("open_hand"), 350);
  engine.update(handShapeFrame("full_fist"), 400);
  const outOfOrder = engine.update(handShapeFrame("full_fist"), 800);

  assert.equal(outOfOrder.repCount, 0);
  assert.equal(outOfOrder.phase, "open_hand");
  assert.equal(outOfOrder.sequenceOnTrack, false);
  assert.equal(outOfOrder.expectedNextPhase, "hook_fist");
}

{
  const engine = new FeedbackEngine("tendon_glides", "right");
  const unclearShape = engine.update(handShapeFrame("open_hand", 0.5));

  assert.deepEqual(unclearShape.cues, [
    "Slow down and make each finger shape clearly before moving to the next one",
  ]);
}

{
  const engine = new FeedbackEngine("stress_ball_squeeze", "right");
  const handOutsideFrame = handShapeFrame("open_hand");
  handOutsideFrame.handFrameReady = visible(0);
  const result = engine.update(handOutsideFrame);

  assert.deepEqual(result.cues, [
    "Move your complete working hand and the ball into the centre of the camera view",
  ]);
}

{
  const engine = new FeedbackEngine("wrist_extension_stretch", "right");
  engine.update(wristFrame(0), 0);
  engine.update(wristFrame(0), 350);
  engine.update(wristFrame(-35), 400);
  const holding = engine.update(wristFrame(-35), 750);
  assert.equal(holding.inHold, true);
  assert.equal(holding.holdPositionMaintained, true);

  const betweenPhases = engine.update(wristFrame(-13.5), 800);
  assert.equal(betweenPhases.inHold, true);
  assert.equal(betweenPhases.holdPositionMaintained, false);

  engine.completeHold();
  assert.equal(engine.repCount, 1);
  assert.equal(engine.startConfirmed, false);

  engine.update(wristFrame(-35), 850);
  const cannotRepeatWithoutNeutral = engine.update(wristFrame(-35), 1250);
  assert.equal(cannotRepeatWithoutNeutral.inHold, false);

  engine.update(wristFrame(0), 1300);
  const returned = engine.update(wristFrame(0), 1650);
  assert.equal(returned.startConfirmed, true);
}

// Every supplied prototype has an executable, stable phase sequence. This
// verifies the registry/engine contract independently of camera-landmark tests.
for (const catalogExercise of DRAFT_EXERCISES) {
  const exercise = EXERCISE_MAP[catalogExercise.id];
  const engine = new FeedbackEngine(exercise.id, "right");
  const confirmationMs = exercise.phaseConfirmationMs ?? 0;
  let timestamp = 0;

  engine.update(measurementsForPhase(exercise, engine.stages[0]), timestamp);
  timestamp += confirmationMs;
  engine.update(measurementsForPhase(exercise, engine.stages[0]), timestamp);

  for (const stage of engine.stages.slice(1)) {
    timestamp += 20;
    engine.update(measurementsForPhase(exercise, stage), timestamp);
    timestamp += confirmationMs;
    engine.update(measurementsForPhase(exercise, stage), timestamp);
  }

  if (exercise.category === "stretch" || exercise.category === "balance") {
    assert.equal(engine.inHold, true, `${exercise.id} did not enter its hold`);
    engine.completeHold();
  }
  assert.equal(engine.repCount, 1, `${exercise.id} did not complete its sequence`);
}

console.log("feedback engine tracking tests passed");
