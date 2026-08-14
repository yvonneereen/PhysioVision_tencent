import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = path => readFileSync(new URL(path, import.meta.url), "utf8");
const api = read("../api.js");
const therapist = read("../therapist.js");
const styles = read("../style.css");

assert.match(
  api,
  /assignAiDraftProgramme[\s\S]*?\/prescriptions\/assign-draft\//,
  "the clinician editor should publish through the reviewed draft endpoint",
);
assert.match(
  therapist,
  /Rehabilitation stage[\s\S]*?name="included-exercise"[\s\S]*?data-dose="sets"[\s\S]*?data-dose="reps"/,
  "AI programme cards should let clinicians choose the stage, activities, sets and repetitions",
);
assert.match(
  therapist,
  /clinical-review-confirmed[\s\S]*?replaces the patient’s current active programme/,
  "publishing should require an explicit clinical review acknowledgement",
);
assert.match(
  therapist,
  /handleAssignAiProgramme[\s\S]*?assignAiDraftProgramme\(payload\)[\s\S]*?getPrescriptions/,
  "one submit action should assign the draft and refresh the clinician programme view",
);
assert.doesNotMatch(
  therapist,
  /data-ai-fill="accept plan for/,
  "the plan card should no longer ask the clinician to type an acceptance command",
);
assert.match(styles, /\.clinical-plan-stage-field[\s\S]*?\.clinical-plan-approval/);

console.log("clinician AI programme editor tests passed");
