import assert from "node:assert/strict";

import {
  buildSessionAssessmentSummary,
  calculatePrototypeMovementScore,
  calculateMovementQuality,
  CoachingQualitySession,
  isClinicalRuleScoreable,
  movementQualityFromSession,
} from "../movement-quality.js";

assert.deepEqual(
  calculatePrototypeMovementScore({
    repetitions: 10,
    cuesTriggered: [
      { kind: "movement_observation", rule_id: "knee-difference", cue_text: "Different knee-bending angles", trigger_count: 5 },
      { kind: "movement_observation", rule_id: "knee-forward", cue_text: "Forward knee movement", trigger_count: 5 },
      { kind: "movement_observation", rule_id: "personal-range", cue_text: "Below saved range", trigger_count: 10 },
    ],
  }),
  {
    score: 80,
    total_deduction: 20,
    deductions: [
      { rule_id: "knee-difference", cue_text: "Different knee-bending angles", observed_repetitions: 5, deduction: 5 },
      { rule_id: "knee-forward", cue_text: "Forward knee movement", observed_repetitions: 5, deduction: 5 },
      { rule_id: "personal-range", cue_text: "Below saved range", observed_repetitions: 10, deduction: 10 },
    ],
  },
  "prototype observations should create transparent frequency-based deductions",
);

const metadata = {
  kind: "coaching_quality",
  scoring_version: 3,
  validated_rule_count: 1,
  validated_rule_versions: ["PV-TEST-1"],
  cue_text: "",
  trigger_count: 0,
  deduction: 0,
};

const validatedRuleCard = {
  clinicalClaim: "The measured test signal exceeded its approved threshold.",
  intendedPopulation: "Older adults in the approved exercise programme.",
  measuredSignal: "Test joint angle.",
  cameraView: "front",
  thresholdSource: "Locked validation protocol PV-TEST-1.",
  feedback: "Use the approved correction.",
  unableToAssessConditions: ["Low confidence"],
  contraindicationsContext: "Clinician restrictions take precedence.",
  validationStatus: "clinically_validated",
  technicalValidationStatus: "validated",
  clinicianApproval: {
    approved: true,
    approvedBy: "Test physiotherapist",
    approvedAt: "2026-08-13",
    version: "PV-TEST-1",
  },
};

const validatedCue = (id, message) => ({
  id,
  message,
  condition: "testAngle>10",
  scoringEligible: true,
  ruleCard: validatedRuleCard,
});

assert.equal(isClinicalRuleScoreable(validatedCue("test", "Test")), true);
assert.equal(
  isClinicalRuleScoreable({
    id: "unvalidated",
    message: "Prototype",
    scoringEligible: true,
    ruleCard: { ...validatedRuleCard, validationStatus: "unvalidated" },
  }),
  false,
  "a developer flag must not bypass missing clinical validation",
);
assert.equal(
  isClinicalRuleScoreable({
    scoringEligible: true,
    ruleCard: {
      validationStatus: "clinically_validated",
      technicalValidationStatus: "validated",
      clinicianApproval: {
        approved: true,
        approvedBy: "Test physiotherapist",
        approvedAt: "2026-08-13",
        version: "INCOMPLETE",
      },
    },
  }),
  false,
  "approval flags must not substitute for a complete clinical rule card",
);

assert.equal(
  calculateMovementQuality({ repetitions: 0 }),
  null,
  "an unmeasured session must not receive a quality score",
);

assert.equal(
  calculateMovementQuality({ repetitions: 12, cuesTriggered: [metadata] }),
  100,
  "a measured coached session without deductions should score 100",
);

assert.equal(
  calculateMovementQuality({
    repetitions: 12,
    cuesTriggered: [
      metadata,
      { scoring_version: 3, rule_version: "PV-TEST-1", scoring_eligible: true, delivered: true, outcome: "persisted", deduction: 5 },
    ],
  }),
  95,
  "only an issue that persisted after delivered coaching should deduct points",
);

assert.equal(
  calculateMovementQuality({
    repetitions: 12,
    cuesTriggered: [
      metadata,
      ...Array.from({ length: 10 }, () => ({
        scoring_version: 3,
        rule_version: "PV-TEST-1",
        scoring_eligible: true,
        delivered: true,
        outcome: "persisted",
        deduction: 5,
      })),
    ],
  }),
  70,
  "deductions must be capped so corrections cannot destroy the score",
);

{
  const tracker = new CoachingQualitySession({ stableForMs: 800 });
  const cue = validatedCue("torso", "Bring your chest upright");
  tracker.configureRules({ "torsoLean>40": cue });
  assert.equal(tracker.observe({ cue, timestampMs: 0, repetitionNumber: 1 }).reminder, null);
  assert.equal(tracker.observe({ cue, timestampMs: 799, repetitionNumber: 1 }).reminder, null);
  const reminder = tracker.observe({ cue, timestampMs: 800, repetitionNumber: 1 }).reminder;
  assert.ok(reminder, "a reliable issue should be reminded only after it is stable");
  tracker.markDisplayed(reminder.id);
  tracker.confirmDelivery(reminder.id, {
    repetitionNumber: 1,
    spoken: true,
    voiceRequired: true,
  });

  // The issue must itself remain stable during each of the two grace reps.
  tracker.observe({ cue, timestampMs: 1000, repetitionNumber: 2 });
  tracker.observe({ cue, timestampMs: 1800, repetitionNumber: 2 });
  tracker.observe({ cue, timestampMs: 2000, repetitionNumber: 3 });
  tracker.observe({ cue, timestampMs: 2800, repetitionNumber: 3 });
  tracker.observe({ cue: null, timestampMs: 3000, repetitionNumber: 4 });
  tracker.finish(3);

  const record = tracker.cuesForPersistence().find(
    (item) => item.kind === "coaching_reminder",
  );
  assert.equal(record.outcome, "persisted");
  assert.equal(record.deduction, 5);
  assert.equal(record.condition, "testAngle>10");
  assert.equal(record.measured_signal, "Test joint angle.");
  assert.equal(record.rule_version, "PV-TEST-1");
  assert.equal(
    calculateMovementQuality({
      repetitions: 3,
      cuesTriggered: tracker.cuesForPersistence(),
    }),
    95,
  );

  assert.equal(
    tracker.observe({ cue, timestampMs: 4000, repetitionNumber: 4 }).reminder,
    null,
    "the same issue must not be counted twice in one session",
  );
}

{
  const tracker = new CoachingQualitySession({ stableForMs: 0 });
  const cue = validatedCue("knees", "Use the approved knee correction");
  tracker.configureRules({ "kneeDiff>15": cue });
  tracker.observe({ cue, timestampMs: 0, repetitionNumber: 1 });
  const reminder = tracker.observe({ cue, timestampMs: 1, repetitionNumber: 1 }).reminder;
  tracker.markDisplayed(reminder.id);
  tracker.confirmDelivery(reminder.id, {
    repetitionNumber: 1,
    spoken: true,
    voiceRequired: true,
  });
  tracker.observe({ cue: null, timestampMs: 100, repetitionNumber: 2 });
  tracker.observe({ cue: null, timestampMs: 200, repetitionNumber: 3 });
  tracker.finish(3);
  const record = tracker.cuesForPersistence().find(
    (item) => item.kind === "coaching_reminder",
  );
  assert.equal(record.outcome, "improved");
  assert.equal(record.deduction, 0, "responding to guidance must not lose points");
}

{
  const tracker = new CoachingQualitySession({ stableForMs: 0 });
  const unreliable = {
    id: "front-depth",
    message: "Keep your foot flat",
    qualityReliable: false,
  };
  tracker.observe({ cue: unreliable, timestampMs: 0, repetitionNumber: 1 });
  const observation = tracker.observe({
    cue: unreliable,
    timestampMs: 1000,
    repetitionNumber: 1,
  });
  assert.equal(observation.reminder, null);
  tracker.finish(3);
  const records = tracker.cuesForPersistence();
  assert.equal(records.length, 2);
  assert.equal(records[1].kind, "movement_observation");
  assert.equal(records[1].scoring_eligible, false);
  assert.equal(
    calculateMovementQuality({ repetitions: 3, cuesTriggered: records }),
    null,
    "an unvalidated observation must not produce or lower a score",
  );
}

{
  const tracker = new CoachingQualitySession({ stableForMs: 0 });
  const cue = validatedCue("audio-wait", "Use the approved standing cue");
  tracker.configureRules({ "knee<150": cue });
  tracker.observe({ cue, timestampMs: 0, repetitionNumber: 1 });
  const reminder = tracker.observe({ cue, timestampMs: 1, repetitionNumber: 1 }).reminder;
  tracker.markDisplayed(reminder.id);
  assert.equal(
    tracker.confirmDelivery(reminder.id, {
      repetitionNumber: 1,
      spoken: false,
      voiceRequired: true,
    }),
    false,
    "a voice-mode reminder is not delivered until speech finishes",
  );
  // It was never confirmed because another sentence prevented speech.
  tracker.finish(3);
  assert.equal(
    calculateMovementQuality({
      repetitions: 3,
      cuesTriggered: tracker.cuesForPersistence(),
    }),
    100,
    "an undelivered reminder must never cause a deduction",
  );
}

assert.equal(
  movementQualityFromSession({
    reps_completed: 12,
    quality_score: 0,
    cues_triggered: [{
      cue_text: "Make the squat a little shallower",
      trigger_count: 207,
    }],
    symmetry_warnings_count: 0,
  }),
  null,
  "legacy detections without validation or delivery evidence must not create a score",
);

{
  const tracker = new CoachingQualitySession({ stableForMs: 0 });
  tracker.configureRules({ "torsoLean>40": "Prototype torso observation" });
  tracker.observe({
    cue: {
      id: "prototype-torso",
      message: "Prototype torso observation",
      scoringEligible: false,
    },
    repetitionNumber: 1,
  });
  const summary = buildSessionAssessmentSummary({
    cuesTriggered: tracker.cuesForPersistence(),
    repetitionsCompleted: 6,
    repetitionsMinimum: 6,
    repetitionsTarget: 10,
    setsCompleted: 1,
    setsTarget: 1,
    tracking: {
      totalFrames: 10,
      assessableFrames: 8,
      limitedTrackingFrames: 2,
      missingMeasurements: { leftKnee: 2 },
    },
  });
  assert.equal(summary.tracking_validity.status, "partially_assessable");
  assert.equal(summary.tracking_validity.low_confidence_frames_pct, 20);
  assert.equal(summary.prescription_completion.status, "complete");
  assert.equal(summary.movement_execution.status, "prototype_scored");
  assert.equal(summary.movement_execution.score, 99);
  assert.deepEqual(summary.movement_execution.prototype_deductions, [{
    rule_id: "prototype-torso",
    cue_text: "Prototype torso observation",
    observed_repetitions: 1,
    deduction: 1,
  }]);
  assert.equal(summary.symptoms_and_safety.camera_inference_used, false);
}

console.log("movement quality coaching tests passed");
