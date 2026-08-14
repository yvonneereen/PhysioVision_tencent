import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const markup = read("../index.html");
const dashboard = read("../patient-dashboard.js");
const workflow = read("../care-workflow.js");

assert.match(
  markup,
  /id="patientCareLink"[\s\S]*?id="careInviteCode"[\s\S]*?id="acceptCareInvite"/,
  "an unlinked patient should be able to accept a direct clinician invitation",
);
assert.match(
  markup,
  /Invite a patient[\s\S]*?id="createCareInvite"[\s\S]*?Generate invitation code/,
  "the clinician overview should retain direct patient invitations",
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
assert.match(
  workflow,
  /acceptCareInvitation[\s\S]*?createCareInvitation/,
  "the shared account interface should support both direct invitations and triage requests",
);

console.log("Patient physiotherapist-request lifecycle tests passed");
