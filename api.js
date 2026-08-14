// Central API client — all backend calls go through here.
// The token is limited to this browser tab/session and is not persisted on disk.

const runtimeWindow = typeof window === "undefined" ? {} : window;
const runtimeHostname = runtimeWindow.location?.hostname ?? "localhost";
const BASE = runtimeWindow.PHYSIOVISION_API_BASE ?? (
  ["localhost", "127.0.0.1"].includes(runtimeHostname)
    ? "http://localhost:8000/api"
    : "/api"
);
const TOKEN_KEY = "physiovision.token";
let apiWarmupPromise = null;

function getToken() {
  return runtimeWindow.sessionStorage?.getItem(TOKEN_KEY) ?? null;
}

function setToken(token) {
  runtimeWindow.sessionStorage?.setItem(TOKEN_KEY, token);
}

function clearToken() {
  runtimeWindow.sessionStorage?.removeItem(TOKEN_KEY);
  // Remove tokens created by older versions of the site.
  runtimeWindow.localStorage?.removeItem(TOKEN_KEY);
}

runtimeWindow.localStorage?.removeItem(TOKEN_KEY);

export function isLoggedIn() {
  return Boolean(getToken());
}

async function request(method, path, body, { skipAuth = false } = {}) {
  const token = getToken();
  const headers = { "Content-Type": "application/json" };
  if (token && !skipAuth) headers["Authorization"] = `Token ${token}`;

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const fieldError = Object.entries(err).find(
      ([key, value]) => key !== "detail" && Array.isArray(value) && value.length
    );
    const fieldMessage = fieldError
      ? `${fieldError[0].replaceAll("_", " ")}: ${fieldError[1][0]}`
      : "";
    const productionApiMissing = (
      res.status === 404
      && !runtimeWindow.PHYSIOVISION_API_BASE
      && !["localhost", "127.0.0.1"].includes(runtimeHostname)
    );
    const message = productionApiMissing
      ? "The online account service has not been connected yet."
      : err.detail || fieldMessage || `Request failed (${res.status}).`;

    throw Object.assign(new Error(message), {
      status: res.status,
      data: err,
    });
  }

  return res.status === 204 ? null : res.json();
}

export function warmApi() {
  if (apiWarmupPromise) return apiWarmupPromise;

  apiWarmupPromise = fetch(`${BASE}/health/`, {
    method: "GET",
    headers: { Accept: "application/json" },
    cache: "no-store",
  })
    .then((response) => {
      if (!response.ok) apiWarmupPromise = null;
      return response.ok;
    })
    .catch(() => {
      apiWarmupPromise = null;
      return false;
    });
  return apiWarmupPromise;
}

// ── Auth ──────────────────────────────────────────────────────

export async function register({ email, password, firstName, lastName, role = "patient", ...profileFields }) {
  return request("POST", "/auth/register/", {
    email, password,
    first_name: firstName,
    last_name: lastName,
    role,
    ...profileFields,
  });
}

export async function login({ email, password }) {
  const data = await request("POST", "/auth/login/", { email, password }, { skipAuth: true });
  if (data.token) setToken(data.token);
  return data;
}

export async function verifyLogin({ challengeId, code }) {
  const data = await request(
    "POST",
    "/auth/verify-login/",
    { challenge_id: challengeId, code },
    { skipAuth: true }
  );
  setToken(data.token);
  return data;
}

export async function resendLoginVerification(challengeId) {
  return request(
    "POST",
    "/auth/resend-login-verification/",
    { challenge_id: challengeId },
    { skipAuth: true }
  );
}

export async function verifyEmail({ email, code }) {
  const data = await request("POST", "/auth/verify-email/", { email, code });
  setToken(data.token);
  return data;
}

export async function resendEmailVerification(email) {
  return request("POST", "/auth/resend-verification/", { email });
}

export async function requestPasswordReset(email) {
  return request(
    "POST",
    "/auth/forgot-password/",
    { email },
    { skipAuth: true }
  );
}

export async function verifyPasswordResetCode({ email, code }) {
  return request(
    "POST",
    "/auth/verify-reset-code/",
    { email, code },
    { skipAuth: true }
  );
}

export async function resetPassword({ email, resetToken, newPassword }) {
  return request(
    "POST",
    "/auth/reset-password/",
    {
      email,
      reset_token: resetToken,
      new_password: newPassword,
    },
    { skipAuth: true }
  );
}

export async function logout() {
  // Start server-side token revocation while the token is still available for
  // the Authorization header, then clear the browser session immediately.
  // This keeps sign-out responsive even when the hosted API is waking up.
  const revokeToken = request("POST", "/auth/logout/").catch(() => {});
  clearToken();
  await revokeToken;
}

// ── Profile ───────────────────────────────────────────────────

export async function getMe() {
  return request("GET", "/auth/me/");
}

export async function patchMe(fields) {
  return request("PATCH", "/auth/me/", fields);
}

export async function startEmergencyContactVerification() {
  return request(
    "POST",
    "/auth/emergency-contact/verification/start/",
    {}
  );
}

export async function confirmEmergencyContactVerification(code) {
  return request(
    "POST",
    "/auth/emergency-contact/verification/confirm/",
    { code }
  );
}

export async function createEmergencyAlert({
  clientEventId,
  exerciseId = "",
  monitoringMode = "",
  signals = [],
}) {
  return request("POST", "/auth/emergency-alerts/", {
    client_event_id: clientEventId,
    exercise_id: exerciseId,
    monitoring_mode: monitoringMode,
    signals,
  });
}

export async function respondEmergencyAlert(alertId, response) {
  return request(
    "POST",
    `/auth/emergency-alerts/${encodeURIComponent(alertId)}/`,
    { response }
  );
}

export async function getEmergencyAlert(alertId) {
  return request(
    "GET",
    `/auth/emergency-alerts/${encodeURIComponent(alertId)}/`
  );
}

export async function selectPatientPathway(pathway) {
  return request("POST", "/auth/patient-pathway/", { pathway });
}

export async function postWellnessScreening(answers) {
  return request("POST", "/auth/wellness-screening/", answers);
}

export async function generateWellnessPlan(preferences) {
  return request("POST", "/auth/agent/plan/", preferences);
}

export async function interpretSafetyLanguage({ stage, transcript }) {
  return request("POST", "/auth/agent/safety-language/", {
    stage,
    transcript,
    locale: runtimeWindow.document?.documentElement?.lang || "en-SG",
  });
}

export async function generateGuidanceSpeech({ text, locale }) {
  return request("POST", "/auth/agent/speech/", {
    text,
    locale: locale || runtimeWindow.document?.documentElement?.lang || "en-SG",
  });
}

export async function acceptWellnessPlan(draftToken) {
  return request("POST", "/auth/agent/plan/accept/", {
    draft_token: draftToken,
  });
}

export async function createCareInvitation() {
  return request("POST", "/auth/care-invitations/", {});
}

export async function acceptCareInvitation(code) {
  return request("POST", "/auth/care-invitations/accept/", { code });
}

export async function getClinicianPatients() {
  return request("GET", "/auth/clinician/patients/");
}

// ── Sessions ──────────────────────────────────────────────────

export async function postSession(session) {
  return request("POST", "/sessions/", session);
}

export async function postPainCheckin(checkin) {
  return request("POST", "/pain-checkins/", checkin);
}

export async function updatePainCheckin(id, fields) {
  return request(
    "PATCH",
    `/pain-checkins/${encodeURIComponent(id)}/`,
    fields,
  );
}

export async function getSessions() {
  return request("GET", "/sessions/");
}

export async function getPainCheckins() {
  return request("GET", "/pain-checkins/");
}

// ── Calibrations ──────────────────────────────────────────────

export async function postCalibration(calibration) {
  return request("POST", "/calibrations/", calibration);
}

export async function getCalibrations() {
  return request("GET", "/calibrations/");
}

// ── Exercises ─────────────────────────────────────────────────

export async function getExercises() {
  return request("GET", "/exercises/");
}

// ── Therapist ─────────────────────────────────────────────────

export async function getPatients() {
  return request("GET", "/patients/");
}

export async function getTriageQueue() {
  return request("GET", "/auth/clinician/triage/");
}

export async function claimTriagePatient(patientId) {
  return request("POST", `/auth/clinician/triage/${patientId}/claim/`, {});
}

export async function declineTriagePatient(patientId) {
  return request("POST", `/auth/clinician/triage/${patientId}/decline/`, {});
}

export async function dischargePatient(patientId, note = "") {
  return request("POST", `/patients/${encodeURIComponent(patientId)}/discharge/`, {
    confirmed: true,
    note,
  });
}

export async function getPatientSessions(patientId) {
  return request("GET", `/sessions/?patient=${patientId}`);
}

export async function getPatientPainCheckins(patientId) {
  return request("GET", `/pain-checkins/?patient=${patientId}`);
}

export async function getPrescriptions() {
  return request("GET", "/prescriptions/");
}

export async function createPrescription(prescription) {
  return request("POST", "/prescriptions/", prescription);
}

export async function assignAiDraftProgramme(programme) {
  return request("POST", "/prescriptions/assign-draft/", programme);
}

// ── Consultations and trend alerts ───────────────────────────

export async function getConsultations() {
  return request("GET", "/consultations/");
}

export async function createConsultation(consultation) {
  return request("POST", "/consultations/", consultation);
}

export async function initiateConsultation(consultation) {
  return request("POST", "/consultations/initiate/", consultation);
}

export async function generateConsultationDraft(locale = "en-SG") {
  return request("POST", "/consultations/draft/", { locale });
}

export async function confirmConsultation(id) {
  return request("POST", `/consultations/${id}/confirm/`);
}

export async function cancelConsultation(id) {
  return request("POST", `/consultations/${id}/cancel/`);
}

export async function completeConsultation(id) {
  return request("POST", `/consultations/${id}/complete/`);
}

export async function acceptConsultation(id) {
  return request("POST", `/consultations/${id}/accept/`);
}

export async function updateConsultation(id, data) {
  return request("PATCH", `/consultations/${id}/`, data);
}

export async function getEscalations() {
  return request("GET", "/escalations/");
}

// ── Care messaging (patient ↔ physiotherapist) ───────────────

export async function getCareMessages(patientId = null) {
  const query = patientId ? `?patient=${encodeURIComponent(patientId)}` : "";
  return request("GET", `/care-messages/${query}`);
}

export async function getCareMessageThreads() {
  return request("GET", "/care-messages/threads/");
}

export async function sendCareMessage(body, patientId = null) {
  const payload = patientId ? { body, patient: patientId } : { body };
  return request("POST", "/care-messages/", payload);
}

// ── Role-specific AI assistant ───────────────────────────────

export async function getClinicianAiSessions() {
  return request("GET", "/auth/agent/sessions/");
}

export async function getClinicianAiSession(sessionId) {
  return request("GET", `/auth/agent/sessions/${encodeURIComponent(sessionId)}/`);
}

export async function sendAgentMessage(message, context = {}, history = [], sessionId = null) {
  const payload = { message, context };
  if (history.length) payload.history = history;
  if (sessionId) payload.session_id = sessionId;
  return request("POST", "/auth/agent/chat/", payload);
}
