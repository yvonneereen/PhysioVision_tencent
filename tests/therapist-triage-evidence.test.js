import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const therapist = read("../therapist.js");
const styles = read("../style.css");
const page = read("../index.html");

assert.match(
  therapist,
  /function renderTriageEvidence[\s\S]*?Latest pain[\s\S]*?Validated coaching response[\s\S]*?Recovery[\s\S]*?Patient-reported background/,
  "triage should expose pain, validation-gated same-exercise coaching response, and recovery evidence",
);
assert.match(
  therapist,
  /summary\.signals[\s\S]*?triage-signal-list[\s\S]*?signal\.detail/,
  "the clinician should see the recorded reason behind each concern flag",
);
assert.match(
  therapist,
  /signal\.event_scope === "historical_safety_check"[\s\S]*?recorded safety event/,
  "a dated safety answer should be separated from the current movement trend",
);
assert.match(
  therapist,
  /Limited recorded data[\s\S]*?Reason needs confirming[\s\S]*?does not rule out a problem/,
  "missing measurements must be identified honestly rather than inventing a problem",
);
assert.match(
  styles,
  /\.triage-evidence[\s\S]*?\.triage-evidence-metrics[\s\S]*?\.triage-signal-list/,
  "recorded concerns should be visually grouped inside the patient request",
);
assert.match(
  page,
  /recorded pain, recovery, validation-gated coaching-response and safety signals/,
  "the queue should explain the evidence clinicians are reviewing",
);
assert.match(
  styles,
  /\.consultation-entry\s*\{[\s\S]*?--consultation-grid-columns:[\s\S]*?\.consultation-entry > \.detail-row\s*\{[\s\S]*?grid-template-columns: var\(--consultation-grid-columns\)[\s\S]*?\.consultation-schedule-form\s*\{[\s\S]*?grid-template-columns: var\(--consultation-grid-columns\)/,
  "consultation summary text and scheduling controls should share one column grid",
);

console.log("therapist triage evidence tests passed");
