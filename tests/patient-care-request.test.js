import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const markup = read("../index.html");
const dashboard = read("../patient-dashboard.js");
const workflow = read("../care-workflow.js");

assert.doesNotMatch(
  markup,
  /id="patientCareLink"|id="patientPathwayInviteForm"|id="createCareInvite"/,
  "the active interface should use requests and acceptance instead of invitation codes",
);
assert.match(
  markup,
  /id="patientCareAcceptedNotice"[\s\S]*?Physiotherapist request accepted/,
  "the patient home should include a clear acceptance notice",
);
assert.match(
  dashboard,
  /selectPatientPathway\(pathway\)[\s\S]*?Waiting for a physiotherapist to accept you/,
  "choosing physiotherapist support should send a request",
);
assert.match(
  dashboard,
  /refreshPendingPhysiotherapistRequest\(\); \},[\s\S]*?15_000/,
  "the patient home should check pending requests without a manual reload",
);
assert.match(
  dashboard,
  /isClinicianGuidedProfile\(user\.profile\)[\s\S]*?activatePatientDashboard\(user\)[\s\S]*?showCareAcceptance/,
  "acceptance should switch the dashboard before informing the patient",
);
assert.doesNotMatch(
  workflow,
  /acceptCareInvitation|createCareInvitation/,
  "the shared account interface should not expose the legacy invitation flow",
);

console.log("Patient physiotherapist-request lifecycle tests passed");
