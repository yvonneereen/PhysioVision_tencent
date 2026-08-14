import assert from "node:assert/strict";
import fs from "node:fs";

import {
  buildPlannedSessionKey,
  completedExerciseIdsForPlannedSession,
  minimumRepetitionsPerSet,
  nextIncompleteExerciseId,
  painBaselineForNextExercise,
  parsePlannedSessionNote,
  planWeekKey,
  serializePlannedSessionNote,
  sessionReachedTarget,
  sessionsForPlannedSession,
} from "../planned-session-progress.js";

assert.equal(planWeekKey(new Date(2026, 7, 9)), "2026-08-03");
assert.equal(planWeekKey(new Date(2026, 7, 10)), "2026-08-10");

const sessionKey = buildPlannedSessionKey({
  acceptedAt: "2026-08-01T10:00:00Z",
  day: "Mon",
  dayIndex: 0,
  exerciseIds: ["half-squats", "calf-raises"],
  date: new Date(2026, 7, 9),
});
const notes = serializePlannedSessionNote({
  sessionKey,
  sessionDay: "Monday",
  sessionTitle: "Leg Strength & Ankle Balance",
});
assert.deepEqual(parsePlannedSessionNote(notes), {
  sessionKey,
  sessionDay: "Monday",
  sessionTitle: "Leg Strength & Ankle Balance",
});
assert.equal(parsePlannedSessionNote("ordinary clinician note"), null);
assert.equal(
  minimumRepetitionsPerSet({ reps: 10, repsMin: 6 }),
  6,
  "a repetition range should use its lower bound as the completion threshold",
);
assert.equal(
  minimumRepetitionsPerSet({ reps: 10 }),
  10,
  "an exact prescription should use its assigned repetition count",
);

const sessions = [
  {
    exercise: "half-squats",
    reps_completed: 10,
    reps_target: 10,
    sets_completed: 1,
    sets_target: 1,
    quality_score: 90,
    notes,
  },
  {
    exercise: "calf-raises",
    reps_completed: 4,
    reps_target: 10,
    sets_completed: 1,
    sets_target: 1,
    notes,
  },
];
assert.equal(sessionReachedTarget(sessions[0]), true);
assert.equal(sessionReachedTarget(sessions[1]), false);
assert.equal(
  sessionReachedTarget({
    reps_completed: 5,
    reps_target: 10,
    reps_minimum: 6,
    sets_completed: 0,
    sets_target: 1,
  }),
  false,
  "five repetitions should not complete an assigned range of six to ten",
);
assert.equal(
  sessionReachedTarget({
    reps_completed: 6,
    reps_target: 10,
    reps_minimum: 6,
    sets_completed: 1,
    sets_target: 1,
  }),
  true,
  "six repetitions should complete an assigned range of six to ten",
);
assert.deepEqual(
  completedExerciseIdsForPlannedSession(sessions, sessionKey),
  ["half-squats"],
);
assert.equal(
  nextIncompleteExerciseId(
    ["half-squats", "calf-raises"],
    ["half-squats"],
  ),
  "calf-raises",
);
assert.equal(
  nextIncompleteExerciseId(
    ["half-squats", "calf-raises"],
    ["half-squats", "calf-raises"],
  ),
  null,
);
assert.deepEqual(sessionsForPlannedSession(sessions, sessionKey), [sessions[0]]);

const calfRaiseBaseline = painBaselineForNextExercise({
  nextExerciseId: "calf-raises",
  painLevel: 4,
});
assert.deepEqual(
  calfRaiseBaseline,
  { exerciseId: "calf-raises", painLevel: 4 },
  "the pain answer after Half Squats should become the Calf Raises baseline",
);
assert.deepEqual(
  [
    "before Half Squats",
    "after Half Squats",
    ...(calfRaiseBaseline ? [] : ["before Calf Raises"]),
    "after Calf Raises",
  ],
  [
    "before Half Squats",
    "after Half Squats",
    "after Calf Raises",
  ],
  "a two-exercise session should ask for pain exactly three times",
);
assert.equal(
  painBaselineForNextExercise({
    nextExerciseId: "calf-raises",
    painLevel: null,
  }),
  null,
  "a skipped intermediate pain check must not create an invented baseline",
);
assert.equal(
  painBaselineForNextExercise({ painLevel: 4 }),
  null,
  "the final exercise should not create another starting baseline",
);

const mainSource = fs.readFileSync(new URL("../main.js", import.meta.url), "utf8");
const dashboardSource = fs.readFileSync(
  new URL("../patient-dashboard.js", import.meta.url),
  "utf8",
);
const htmlSource = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");

assert.match(
  mainSource,
  /notes:\s*serializePlannedSessionNote\(\{[\s\S]*?sessionKey:\s*activeSessionKey/,
  "completed exercises should persist their exact weekly plan-session key",
);
assert.match(
  mainSource,
  /function showPostExerciseDestination[\s\S]*?openExerciseTransition\(progress, completed\.painLevel\)[\s\S]*?openSessionSummary/,
  "an unfinished multi-exercise day should show the continuation screen before the report",
);
assert.match(
  mainSource,
  /function continueToNextExercise\(\)[\s\S]*?exSelect\.value = nextExerciseId[\s\S]*?dispatchEvent\(new Event\("change"[\s\S]*?openCalibrationFlow\(\{ currentTarget: openCalibrationPrimary \}\)/,
  "continuing should select the next exercise and open its camera setup automatically",
);
assert.match(
  mainSource,
  /function finalizeExerciseTransition[\s\S]*?exerciseTransitionContinueEl\.disabled = false;[\s\S]*?promptForExerciseTransitionVoice\(\{ checkinSaveIncomplete \}\)/,
  "the voice continuation question should start only after the result has saved",
);
assert.match(
  mainSource,
  /function listenForExerciseTransitionVoice[\s\S]*?parseConfirmationResponse\(transcript\)[\s\S]*?response === "confirm"[\s\S]*?continueToNextExercise\(\)/,
  "a spoken yes should continue to the next planned exercise",
);
assert.match(
  mainSource,
  /function openExerciseTransition\(progress, painLevel\)[\s\S]*?painBaselineForNextExercise\([\s\S]*?nextExerciseId:\s*progress\.nextExerciseId[\s\S]*?painLevel/,
  "the intermediate check-in should be carried into the next planned exercise",
);
assert.match(
  mainSource,
  /exSelect\.addEventListener\("change"[\s\S]*?carriedPainBaseline[\s\S]*?preExerciseCheckinCompleted = Boolean\(carriedPainBaseline\)[\s\S]*?timing:\s*"before"/,
  "the next exercise should reuse the intermediate answer instead of asking for pain again",
);
assert.match(
  dashboardSource,
  /completedExerciseIdsForPlannedSession\([\s\S]*?nextIncompleteExerciseId\(/,
  "the dashboard should resume the first unfinished exercise",
);
assert.match(
  htmlSource,
  /id="exercise-transition-modal"[\s\S]*?id="exerciseTransitionContinue"[\s\S]*?Finish for now/,
  "the intermediate completion screen should offer continue and finish-for-now actions",
);

console.log("planned session progress tests passed");
