import assert from "node:assert/strict";

import {
  analysePatientTrend,
  effectivePatientPathway,
  findUpcomingConsultation,
  isClinicianGuidedProfile,
  isCurrentPrescription,
  isPhysiotherapistRequestPending,
  mergeConsultationTranscript,
  shouldShowPhysiotherapistRequest,
  walkingConfidencePlanNeedsRefresh,
} from "../patient-dashboard-state.js";

assert.equal(
  effectivePatientPathway({
    pathway_choice: "unselected",
    care_path: "clinician",
    primary_clinician: "clinician-1",
  }),
  "physiotherapist",
  "an existing clinician link must override a stale unselected pathway",
);

assert.equal(
  effectivePatientPathway({ pathway_choice: "unselected" }),
  "unselected",
  "an unlinked patient should still be asked to choose a pathway",
);

const dates = [
  "2026-07-27T08:00:00Z",
  "2026-07-25T08:00:00Z",
  "2026-07-23T08:00:00Z",
];

function session(index, overrides = {}) {
  return {
    id: `session-${index}`,
    exercise: "half-squat",
    exercise_name: "Half Squats",
    affected_side: "right",
    started_at: dates[index],
    ...overrides,
  };
}

assert.equal(
  analysePatientTrend({
    sessions: dates.map((started_at, index) => ({
      id: `quality-${index}`,
      exercise: "half-squat",
      affected_side: "right",
      started_at,
      quality_score: [62, 72, 80][index],
    })),
    now: new Date("2026-07-27T12:00:00Z"),
  }).status,
  "review_suggested",
);

assert.equal(
  analysePatientTrend({
    sessions: dates.map((_, index) => session(index)),
    painCheckins: dates.map((checked_at, index) => ({
      session: `session-${index}`,
      timing: "after",
      checked_at,
      pain_level: [6, 5, 3][index],
      recovery_status: index < 2 ? "worse" : "same",
    })),
  }).reason,
  "pain_increase",
);

assert.equal(
  analysePatientTrend({
    escalations: [{
      status: "open",
      trigger_type: "quality_decline",
      description: "Measured movement quality has decreased.",
      created_at: dates[0],
    }],
  }).title,
  "A physiotherapist review is suggested",
);

assert.equal(
  analysePatientTrend({
    sessions: dates.map((started_at, index) => ({
      id: `improving-${index}`,
      exercise: "half-squat",
      affected_side: "right",
      started_at,
      quality_score: [84, 80, 76][index],
    })),
  }).status,
  "improving",
);

const scopedTrend = analysePatientTrend({
  sessions: [
    session(0, { quality_score: 88 }),
    session(1, { quality_score: 80 }),
    session(2, { quality_score: 72 }),
    session(0, {
      id: "other-exercise",
      exercise: "calf-raise",
      exercise_name: "Calf Raises",
      quality_score: 10,
    }),
    session(0, {
      id: "other-side",
      affected_side: "left",
      quality_score: 12,
    }),
  ],
  focusSessionId: "session-0",
});

assert.deepEqual(scopedTrend.qualitySeries, [72, 80, 88]);
assert.equal(scopedTrend.focusExercise, "half-squat");
assert.equal(scopedTrend.focusSide, "right");

const pairedPainTrend = analysePatientTrend({
  sessions: dates.map((_, index) => session(index)),
  painCheckins: dates.flatMap((checked_at, index) => [
    {
      session: `session-${index}`,
      timing: "before",
      checked_at,
      pain_level: [3, 4, 4][index],
    },
    {
      session: `session-${index}`,
      timing: "after",
      checked_at: new Date(new Date(checked_at).getTime() + 60_000).toISOString(),
      pain_level: [5, 4, 3][index],
      recovery_status: ["worse", "same", "better"][index],
    },
  ]),
});

assert.equal(pairedPainTrend.latestPainChange, 2);
assert.deepEqual(pairedPainTrend.painResponseSeries, [-1, 0, 2]);
assert.equal(pairedPainTrend.latestRecovery, "worse");

const standaloneSafetyPainIsVisibleButExcludedFromExerciseTrend = analysePatientTrend({
  sessions: dates.map((_, index) => session(index)),
  painCheckins: dates.map((checked_at) => ({
    timing: "after",
    checked_at,
    pain_level: 10,
    recovery_status: "worse",
  })),
});

assert.equal(
  standaloneSafetyPainIsVisibleButExcludedFromExerciseTrend.latestPain,
  10,
  "the latest pain card must include a safety check recorded without an exercise session",
);
assert.equal(
  standaloneSafetyPainIsVisibleButExcludedFromExerciseTrend.reason,
  null,
  "a standalone check-in must not be treated as a completed exercise pain-response trend",
);

const firstRealMeasurement = analysePatientTrend({
  sessions: [session(0, { quality_score: 82 })],
});

assert.equal(firstRealMeasurement.status, "first_measurement");
assert.equal(firstRealMeasurement.movementMeasurementCount, 1);
assert.equal(firstRealMeasurement.trendReadingCount, 1);
assert.equal(firstRealMeasurement.fullTrendEstablished, false);
assert.equal(
  firstRealMeasurement.title,
  "Your first real movement measurement is recorded",
);

const twoSessionPreliminaryTrend = analysePatientTrend({
  sessions: [
    session(0, { quality_score: 82 }),
    session(1, { quality_score: 70 }),
  ],
});

assert.equal(twoSessionPreliminaryTrend.status, "preliminary");
assert.equal(twoSessionPreliminaryTrend.preliminaryDirection, "improving");
assert.equal(twoSessionPreliminaryTrend.movementMeasurementCount, 2);
assert.equal(twoSessionPreliminaryTrend.fullTrendEstablished, false);
assert.equal(
  twoSessionPreliminaryTrend.title,
  "Your preliminary direction is improving",
);

const savedWithoutMeasuredMovement = analysePatientTrend({
  sessions: [session(0, { quality_score: null })],
  painCheckins: [{
    session: "session-0",
    timing: "after",
    checked_at: dates[0],
    pain_level: 4,
    recovery_status: "same",
  }],
});

assert.equal(savedWithoutMeasuredMovement.status, "first_measurement");
assert.equal(savedWithoutMeasuredMovement.movementMeasurementCount, 0);
assert.equal(
  savedWithoutMeasuredMovement.title,
  "Your first linked session check-in is recorded",
);

const legacyFrameCountedQuality = analysePatientTrend({
  sessions: [session(0, {
    reps_completed: 12,
    quality_score: 0,
    cues_triggered: [{
      cue_text: "Make the squat a little shallower",
      trigger_count: 207,
    }],
    symmetry_warnings_count: 0,
  })],
});

assert.equal(legacyFrameCountedQuality.averageQuality, null);
assert.deepEqual(legacyFrameCountedQuality.qualitySeries, []);

assert.equal(
  isCurrentPrescription(
    {
      is_active: true,
      valid_from: "2026-07-01",
      valid_until: "2026-07-31",
    },
    new Date("2026-07-27T12:00:00Z"),
  ),
  true,
);

assert.equal(
  findUpcomingConsultation(
    [
      {
        id: 1,
        status: "cancelled",
        scheduled_at: "2026-08-03T09:00:00Z",
      },
      {
        id: 2,
        status: "requested",
        scheduled_at: "2026-08-04T09:00:00Z",
      },
      {
        id: 3,
        status: "confirmed",
        scheduled_at: "2026-08-02T09:00:00Z",
      },
    ],
    new Date("2026-08-01T09:00:00Z"),
  )?.id,
  3,
);

assert.equal(
  findUpcomingConsultation(
    [{
      status: "requested",
      scheduled_at: "2026-07-31T09:00:00Z",
    }],
    new Date("2026-08-01T09:00:00Z"),
  ),
  null,
);

assert.equal(
  findUpcomingConsultation(
    [
      {
        id: 4,
        status: "confirmed",
        scheduled_at: "2026-08-04T09:00:00Z",
      },
      {
        id: 5,
        status: "requested",
        scheduled_at: null,
        created_at: "2026-08-01T10:00:00Z",
      },
    ],
    new Date("2026-08-01T09:00:00Z"),
  )?.id,
  5,
  "an unscheduled patient request remains visible while awaiting the physiotherapist",
);

assert.equal(
  findUpcomingConsultation(
    [{ id: 6, status: "confirmed", scheduled_at: null }],
    new Date("2026-08-01T09:00:00Z"),
  ),
  null,
  "a confirmed consultation must have a scheduled time",
);

assert.equal(
  isClinicianGuidedProfile({ pathway_choice: "physiotherapist" }),
  true,
);

assert.equal(
  isClinicianGuidedProfile({ carePath: "clinician" }),
  true,
);

assert.equal(
  isClinicianGuidedProfile({ primaryClinician: { id: 12 } }),
  true,
);

assert.equal(
  shouldShowPhysiotherapistRequest({
    pathwayChoice: "wellness",
    wellnessScreeningStatus: "eligible",
  }),
  true,
);

assert.equal(
  isPhysiotherapistRequestPending({
    pathwayChoice: "wellness",
    physiotherapistRequestedAt: "2026-08-06T09:30:00Z",
  }),
  true,
  "a pending request must not make a wellness patient clinician-guided",
);

assert.equal(
  isClinicianGuidedProfile({
    pathwayChoice: "wellness",
    physiotherapistRequestedAt: "2026-08-06T09:30:00Z",
  }),
  false,
);

assert.equal(
  mergeConsultationTranscript(
    "My knee has felt stiff.",
    "  It is worse   after half squats.  ",
  ),
  "My knee has felt stiff. It is worse after half squats.",
  "speech should be appended as clean, editable text",
);

assert.equal(
  mergeConsultationTranscript("Keep this message.", "   "),
  "Keep this message.",
  "an empty recognition result must not erase existing notes",
);

assert.equal(
  mergeConsultationTranscript("12345", "67890", 8),
  "12345 67",
  "speech input must respect the consultation message length limit",
);

assert.equal(
  isPhysiotherapistRequestPending({
    pathwayChoice: "physiotherapist",
    primaryClinician: { id: 12 },
    physiotherapistRequestedAt: "2026-08-06T09:30:00Z",
  }),
  false,
);

assert.equal(
  shouldShowPhysiotherapistRequest({
    pathwayChoice: "physiotherapist",
    primaryClinician: { id: 12 },
  }),
  false,
);

assert.equal(
  shouldShowPhysiotherapistRequest({
    pathwayChoice: "wellness",
    medical_history: "Recent knee replacement",
  }),
  false,
  "a patient with medical history must not see the self-referral action",
);

assert.equal(
  walkingConfidencePlanNeedsRefresh({
    goal: "Walk with confidence",
    days: Array.from({ length: 6 }, () => ({
      exercise_ids: ["half-squats"],
    })),
  }),
  true,
  "an older strength-only walking plan should require a new reviewed draft",
);

assert.equal(
  walkingConfidencePlanNeedsRefresh({
    goal: "Walk with confidence",
    days: [
      { exercise_ids: ["supported_single_leg_balance"] },
      { exercise_ids: ["heel-cord-stretch"] },
      { exercise_ids: ["half-squats"] },
      { exercise_ids: ["heel-cord-stretch"] },
      { exercise_ids: ["supported_single_leg_balance"] },
      { exercise_ids: ["calf-raises"] },
    ],
  }),
  false,
  "a walking plan with the required supported balance should remain active",
);

assert.equal(
  shouldShowPhysiotherapistRequest({
    pathwayChoice: "wellness",
    hasRelevantHistory: true,
  }),
  false,
  "the browser profile medical-history flag must also hide self-referral",
);

console.log("patient dashboard state tests passed");
