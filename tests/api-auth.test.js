import assert from "node:assert/strict";
import fs from "node:fs";

function createStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
}

const sessionStorage = createStorage();
const localStorage = createStorage({
  "physiovision.token": "legacy-persistent-token",
});
const responses = [];
const requests = [];

globalThis.window = {
  location: { hostname: "localhost" },
  sessionStorage,
  localStorage,
};
globalThis.fetch = async (url, options) => {
  requests.push({ url, options });
  const next = await responses.shift();
  return {
    ok: next.status >= 200 && next.status < 300,
    status: next.status,
    json: async () => next.body,
  };
};

const api = await import("../api.js?api-auth-test");

assert.equal(localStorage.getItem("physiovision.token"), null);

responses.push({
  status: 201,
  body: {
    email: "person@example.com",
    verification_required: true,
  },
});
await api.register({
  email: "person@example.com",
  password: "safe-password",
  firstName: "Test",
  lastName: "Person",
});
assert.equal(sessionStorage.getItem("physiovision.token"), null);

responses.push({
  status: 202,
  body: {
    verification_required: true,
    verification_purpose: "login",
    challenge_id: "login-challenge",
  },
});
const loginChallenge = await api.login({
  email: "person@example.com",
  password: "safe-password",
});
assert.equal(loginChallenge.challenge_id, "login-challenge");
assert.equal(sessionStorage.getItem("physiovision.token"), null);

responses.push({ status: 200, body: { token: "login-token" } });
await api.verifyLogin({
  challengeId: loginChallenge.challenge_id,
  code: "456789",
});
assert.equal(sessionStorage.getItem("physiovision.token"), "login-token");
assert.equal(localStorage.getItem("physiovision.token"), null);

responses.push({ status: 200, body: { token: "verified-token" } });
await api.verifyEmail({
  email: "person@example.com",
  code: "123456",
});
assert.equal(sessionStorage.getItem("physiovision.token"), "verified-token");

responses.push({
  status: 200,
  body: { detail: "If the account exists, a code was sent." },
});
await api.requestPasswordReset("person@example.com");

responses.push({
  status: 200,
  body: { reset_token: "one-time-reset-token" },
});
const resetVerification = await api.verifyPasswordResetCode({
  email: "person@example.com",
  code: "654321",
});
assert.equal(resetVerification.reset_token, "one-time-reset-token");

responses.push({
  status: 200,
  body: { detail: "Your password has been changed." },
});
await api.resetPassword({
  email: "person@example.com",
  resetToken: "one-time-reset-token",
  newPassword: "new-safe-password",
});

let finishLogout;
responses.push(new Promise((resolve) => {
  finishLogout = resolve;
}));
const logoutRequest = api.logout();
assert.equal(sessionStorage.getItem("physiovision.token"), null);
finishLogout({ status: 204, body: null });
await logoutRequest;

sessionStorage.setItem("physiovision.token", "planning-token");
responses.push({
  status: 200,
  body: {
    plan: {
      source: "gemini_wellness_agent",
      days: [],
    },
    draft_token: "signed-draft-token",
    accepted: false,
  },
});
await api.generateWellnessPlan({
  goal: "stay_active",
  activity_level: "lightly_active",
  focus_side: "both",
  cue_style: "gentle",
  days_per_week: 3,
  minutes_per_session: 10,
  equipment: "chair",
});

responses.push({
  status: 200,
  body: {
    wellness_plan: {
      source: "gemini_wellness_agent",
      days: [],
    },
  },
});
await api.acceptWellnessPlan("signed-draft-token");
assert.equal(
  JSON.parse(requests[9].options.body).draft_token,
  "signed-draft-token",
);

responses.push({
  status: 200,
  body: { detail: "Verification code sent." },
});
await api.startEmergencyContactVerification();

responses.push({
  status: 200,
  body: { detail: "Emergency contact verified.", profile: {} },
});
await api.confirmEmergencyContactVerification("123456");

responses.push({
  status: 201,
  body: { id: "fall-alert-id", status: "pending" },
});
await api.createEmergencyAlert({
  clientEventId: "11111111-1111-4111-8111-111111111111",
  exerciseId: "half-squats",
  monitoringMode: "standing",
  signals: ["rapid_descent"],
});

responses.push({
  status: 200,
  body: { id: "fall-alert-id", status: "notified" },
});
await api.respondEmergencyAlert("fall-alert-id", "no_response");

responses.push({
  status: 200,
  body: { id: "fall-alert-id", status: "notified" },
});
await api.getEmergencyAlert("fall-alert-id");

responses.push({
  status: 200,
  body: {
    matched: true,
    response: "help",
    confidence: "high",
    facts: ["unable_to_move_safely"],
    summary: "The speaker cannot stand without help.",
    source: "gemini_constrained_language",
  },
});
await api.interpretSafetyLanguage({
  stage: "fall-wellbeing",
  transcript: "I cannot stand anymore",
});
responses.push({
  status: 200,
  body: {
    audio: "UklGRg==",
    mime_type: "audio/wav",
    provider: "gemini_tts",
  },
});
await api.generateGuidanceSpeech({
  text: "Before we begin, how is your pain right now?",
  locale: "en-SG",
});
assert.match(requests[0].url, /\/api\/auth\/register\/$/);
assert.match(requests[2].url, /\/api\/auth\/verify-login\/$/);
assert.match(requests[4].url, /\/api\/auth\/forgot-password\/$/);
assert.match(requests[5].url, /\/api\/auth\/verify-reset-code\/$/);
assert.match(requests[6].url, /\/api\/auth\/reset-password\/$/);
assert.match(requests[8].url, /\/api\/auth\/agent\/plan\/$/);
assert.match(requests[9].url, /\/api\/auth\/agent\/plan\/accept\/$/);
assert.match(
  requests[10].url,
  /\/api\/auth\/emergency-contact\/verification\/start\/$/
);
assert.match(
  requests[11].url,
  /\/api\/auth\/emergency-contact\/verification\/confirm\/$/
);
assert.match(requests[12].url, /\/api\/auth\/emergency-alerts\/$/);
assert.match(
  requests[13].url,
  /\/api\/auth\/emergency-alerts\/fall-alert-id\/$/
);
assert.equal(
  JSON.parse(requests[13].options.body).response,
  "no_response"
);
assert.match(
  requests[15].url,
  /\/api\/auth\/agent\/safety-language\/$/
);
assert.deepEqual(
  JSON.parse(requests[15].options.body),
  {
    stage: "fall-wellbeing",
    transcript: "I cannot stand anymore",
    locale: "en-SG",
  }
);
assert.match(requests[16].url, /\/api\/auth\/agent\/speech\/$/);
assert.deepEqual(
  JSON.parse(requests[16].options.body),
  {
    text: "Before we begin, how is your pain right now?",
    locale: "en-SG",
  }
);

const movementContext = {
  source: "camera_guide",
  exercise_id: "half-squats",
  phase: "lowering",
  rep_count: 4,
};
responses.push({ status: 200, body: { reply: "Keep moving slowly.", role: "patient" } });
await api.sendAgentMessage("Why should I move slowly?", movementContext);
assert.match(requests.at(-1).url, /\/api\/auth\/agent\/chat\/$/);
assert.deepEqual(
  JSON.parse(requests.at(-1).options.body),
  {
    message: "Why should I move slowly?",
    context: movementContext,
  }
);

responses.push({ status: 200, body: { status: "ok" } });
assert.equal(await api.warmApi(), true);
assert.match(requests.at(-1).url, /\/api\/health\/$/);

const authSource = fs.readFileSync(
  new URL("../auth.js", import.meta.url),
  "utf8"
);
assert.match(authSource, /warmApi\(\)/);
assert.match(authSource, /const preparingCodeTimer = window\.setTimeout/);
assert.match(authSource, /secure email service is taking longer than usual/i);
assert.match(
  authSource,
  /clearPersonalGuidanceSpeechCache\(\)/,
  "sign-out should clear personalised replies without deleting generic exercise audio"
);
assert.doesNotMatch(
  authSource,
  /clearGeneratedGuidanceSpeechCache\(\)/,
  "sign-out must not erase reusable generic movement instructions"
);

console.log("API authentication storage tests passed");
