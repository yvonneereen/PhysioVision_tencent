import assert from "node:assert/strict";
import fs from "node:fs";

const markup = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
const styles = fs.readFileSync(new URL("../style.css", import.meta.url), "utf8");
const main = fs.readFileSync(new URL("../main.js", import.meta.url), "utf8");
const ui = fs.readFileSync(new URL("../ui.js", import.meta.url), "utf8");
const api = fs.readFileSync(new URL("../api.js", import.meta.url), "utf8");

assert.match(markup, /id="emergencyContactSendCode"/);
assert.match(markup, /id="emergencyContactCode"/);
assert.match(markup, /id="emergencyContactVerifyCode"/);
assert.match(markup, /href="tel:995"/);
assert.match(markup, /It never calls 995/i);
assert.match(markup, /id="fallSafetyCountdown">60</);

assert.match(ui, /startEmergencyContactVerification\(\)/);
assert.match(ui, /confirmEmergencyContactVerification\(code\)/);
assert.match(ui, /code spoken during the verification call/);
assert.match(main, /request an automated call/);
assert.doesNotMatch(main, /call and text/i);
assert.match(main, /Fall check ready · emergency contact calls off/);
assert.match(main, /Verify your emergency contact in My profile/);
assert.match(api, /export async function createEmergencyAlert/);
assert.match(api, /export async function respondEmergencyAlert/);

assert.match(
  main,
  /activeFallAlertPromise = registerFallAlert\(event\)/,
  "the backend countdown must be registered as soon as the fall dialog opens"
);
assert.match(main, /respondEmergencyAlert\(alert\.id, response\)/);
assert.match(main, /response !== "okay"[\s\S]*renderFallAlertDelivery/);
assert.match(main, /It will not call 995 automatically/);
assert.match(main, /FALL_SAFETY_COUNTDOWN_SECONDS = 60/);
assert.match(main, /fallSafetySecondsRemaining === 30/);
assert.match(main, /Thirty seconds left to answer/);
assert.match(
  main,
  /fallMonitor\.notePoseUnavailable\(frameTimestamp\)[\s\S]*fallEvent\.type === "possible_fall"[\s\S]*beginFallSafetyCheck\(fallEvent\)/,
  "a fall candidate that disappears from view must still open the safety check"
);
assert.match(
  main,
  /presentInstructionTrackingPause\(angles, frameTimestamp\);\s*processFallMonitoring\(landmarks, frameTimestamp\);/,
  "fall monitoring must stay active while the opening movement instruction plays"
);
assert.match(main, /response === "confirm-okay"/);
assert.match(main, /requestFallSafetyOkayClarification\(\)/);
assert.match(main, /requestFallSafetyUnknownClarification\(transcript\)/);
assert.match(main, /are you okay and able [\s\S]*to move safely/);
assert.doesNotMatch(
  main,
  /respondEmergencyAlert\([^)]*,\s*"995"/,
  "the application must never send 995 to the automatic contact endpoint"
);
assert.match(styles, /\.fall-safety-call\s*\{/);
assert.match(styles, /\.emergency-contact-verification\s*\{/);

console.log("emergency alert workflow tests passed");
