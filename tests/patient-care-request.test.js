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
  /I already have a physiotherapist[\s\S]*?id="patientPathwayInviteForm"[\s\S]*?id="patientPathwayInviteCode"[\s\S]*?id="patientPathwayInviteSubmit"/,
  "initial patient setup should collect the physiotherapist invitation code",
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
  /if \(pathway === "physiotherapist"\) \{[\s\S]*?showPathwayInviteEntry\(\);[\s\S]*?return;/,
  "choosing an existing physiotherapist should reveal code entry without sending a request",
);
assert.match(
  dashboard,
  /pathwayInviteForm\?\.addEventListener\("submit"[\s\S]*?acceptCareInvitation\(code\)[\s\S]*?getMe\(\)[\s\S]*?finishPathwaySetup/,
  "submitting the invitation code should link the patient before opening their home",
);
assert.match(
  dashboard,
  /pathwaySelfRefer\?\.addEventListener\("click"[\s\S]*?selectPatientPathway\("physiotherapist"\)/,
  "triage should remain a separate explicit action for patients without a code",
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
