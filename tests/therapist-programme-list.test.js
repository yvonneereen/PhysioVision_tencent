import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const therapist = readFileSync(
  new URL("../therapist.js", import.meta.url),
  "utf8",
);

assert.match(
  therapist,
  /Array\.isArray\(patient\?\.active_prescriptions\)/,
  "the clinician dashboard should prefer the complete active programme list",
);
assert.match(
  therapist,
  /function patientProgrammeCell[\s\S]*?programmes\.map/,
  "the patient roster should render every assigned programme",
);
assert.match(
  therapist,
  /function patientProgrammeDetail[\s\S]*?programmes\.map/,
  "the expanded patient detail should render every assigned programme",
);
assert.match(
  therapist,
  /Programme · \$\{programmes\.length\} assigned/,
  "the detail metric should state how many programmes are assigned",
);

console.log("therapist programme-list tests passed");
