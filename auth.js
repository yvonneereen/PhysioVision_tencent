import {
  getCalibrations,
  getMe,
  getPrescriptions,
  isLoggedIn,
  login,
  logout,
  register,
  requestPasswordReset,
  resendLoginVerification,
  resetPassword,
  resendEmailVerification,
  verifyEmail,
  verifyLogin,
  verifyPasswordResetCode,
  warmApi,
} from "./api.js?v=36";
import { getRoleNavigationState } from "./role-ui.js?v=17";
import { clearGeneratedGuidanceSpeechCache } from "./guide-audio.js?v=1";

const shell        = document.getElementById("auth-modal");
const loginForm    = document.getElementById("loginForm");
const registerForm = document.getElementById("registerForm");
const verificationForm = document.getElementById("verificationForm");
const passwordResetRequestForm = document.getElementById("passwordResetRequestForm");
const passwordResetVerifyForm = document.getElementById("passwordResetVerifyForm");
const passwordResetConfirmForm = document.getElementById("passwordResetConfirmForm");
const authTabs      = document.getElementById("authTabs");
const tabLogin     = document.getElementById("authTabLogin");
const tabRegister  = document.getElementById("authTabRegister");
const loginError   = document.getElementById("loginError");
const loginStatus  = document.getElementById("loginStatus");
const registerError = document.getElementById("registerError");
const verificationError = document.getElementById("verificationError");
const verificationStatus = document.getElementById("verificationStatus");
const verificationEmail = document.getElementById("verificationEmail");
const resendVerification = document.getElementById("resendVerification");
const forgotPasswordButton = document.getElementById("forgotPasswordButton");
const passwordResetRequestError = document.getElementById("passwordResetRequestError");
const passwordResetVerifyError = document.getElementById("passwordResetVerifyError");
const passwordResetConfirmError = document.getElementById("passwordResetConfirmError");
const passwordResetEmail = document.getElementById("passwordResetEmail");

const headerSignIn  = document.getElementById("headerSignIn");
const headerSignOut = document.getElementById("headerSignOut");
const headerPatientDashboard = document.getElementById("headerPatientDashboard");
const headerProfile = document.getElementById("headerProfile");
const headerTherapistView = document.getElementById("headerTherapistView");
const mobileSignIn  = document.getElementById("mobileSignIn");
const mobileSignOut = document.getElementById("mobileSignOut");
const mobilePatientDashboard = document.getElementById("mobilePatientDashboard");
const mobileProfile = document.getElementById("mobileProfile");
const mobileTherapistView = document.getElementById("mobileTherapistView");
const therapistSignOut = document.getElementById("therapistSignOut");
const profileAccountInitials = document.getElementById("profileAccountInitials");
const profileAccountName = document.getElementById("profileAccountName");
const profileAccountEmail = document.getElementById("profileAccountEmail");
const profileAccountRole = document.getElementById("profileAccountRole");
const USER_CACHE_KEYS = [
  "physiovision.profile.v1",
  "physiovision.calibrations.v1",
  "physiovision.prescriptions.v1",
];

let pendingVerificationEmail = "";
let pendingVerificationPurpose = "account";
let pendingLoginChallengeId = "";
let pendingPasswordResetEmail = "";
let pendingPasswordResetToken = "";
let loginRequestInProgress = false;
let logoutRequestInProgress = false;

// Start waking the hosted API while the visitor reads the landing page so a
// free-tier cold start is less likely to delay the first sign-in attempt.
warmApi();

function publishAuthState(role, user = null) {
  const detail = { role, user };
  window.physioVisionAuthState = detail;
  window.dispatchEvent(new CustomEvent(
    "physiovision:auth-role",
    { detail },
  ));
}

const authForms = [
  loginForm,
  registerForm,
  verificationForm,
  passwordResetRequestForm,
  passwordResetVerifyForm,
  passwordResetConfirmForm,
];

function hideAuthForms() {
  authForms.forEach((form) => {
    form.style.display = "none";
  });
}

function clearUserCachedData() {
  USER_CACHE_KEYS.forEach((key) => {
    sessionStorage.removeItem(key);
    localStorage.removeItem(key);
  });
}

function setControlVisible(control, visible) {
  if (!control) return;
  control.hidden = !visible;
  control.style.display = visible ? "" : "none";
}

function initials(user) {
  const parts = [user?.first_name, user?.last_name].filter(Boolean);
  if (!parts.length && user?.email) parts.push(user.email);
  return parts.map((part) => part[0]).join("").slice(0, 2).toUpperCase();
}

function renderAccountIdentity(user) {
  if (!user) return;
  const fullName = `${user.first_name ?? ""} ${user.last_name ?? ""}`.trim();
  profileAccountInitials.textContent = initials(user) || "PV";
  profileAccountName.textContent = fullName || "PhysioVision user";
  profileAccountEmail.textContent = user.email ?? "";
  profileAccountRole.textContent =
    user.role === "clinician" ? "Clinician account" : "Patient account";
}

function updateAuthButtons(loggedIn, user = null) {
  const state = getRoleNavigationState(loggedIn, user?.role);
  document.body.dataset.authRole = loggedIn ? (user?.role ?? "") : "";
  setControlVisible(headerSignIn, state.showSignIn);
  setControlVisible(mobileSignIn, state.showSignIn);
  setControlVisible(headerSignOut, state.showSignOut);
  setControlVisible(mobileSignOut, state.showSignOut);
  setControlVisible(headerPatientDashboard, state.showPatientDashboard);
  setControlVisible(mobilePatientDashboard, state.showPatientDashboard);
  setControlVisible(headerProfile, state.showPatientProfile);
  setControlVisible(mobileProfile, state.showPatientProfile);
  setControlVisible(headerTherapistView, state.showTherapistView);
  setControlVisible(mobileTherapistView, state.showTherapistView);
  if (loggedIn && user) renderAccountIdentity(user);
}

function showModal() {
  shell.classList.add("is-open");
  shell.setAttribute("aria-hidden", "false");
  document.body.classList.add("modal-open");
}

function hideModal() {
  shell.classList.remove("is-open");
  shell.setAttribute("aria-hidden", "true");
  document.body.classList.remove("modal-open");
}

function showError(el, msg) {
  el.textContent = msg;
  el.style.display = "block";
}

function clearError(el) {
  el.textContent = "";
  el.style.display = "none";
}

async function routeAfterAuthentication(user) {
  try {
    await window.pvLoadAuthenticatedApp?.(user?.role);
  } catch (error) {
    console.error("The signed-in workspace could not be loaded", error);
    return;
  }
  if (user?.role === "clinician") {
    document
      .querySelector("[data-open='therapist-view']")
      ?.click();
    return;
  }
  if (typeof window.pvShowPatientDashboard === "function") {
    void window.pvShowPatientDashboard(user);
    return;
  }
  window.dispatchEvent(new CustomEvent(
    "physiovision:patient-dashboard-requested",
    { detail: { user } },
  ));
}

function selectLoginTab() {
  pendingVerificationPurpose = "account";
  pendingLoginChallengeId = "";
  hideAuthForms();
  loginForm.style.display = "";
  authTabs.style.display = "flex";
  tabLogin.className = "button button-coral";
  tabRegister.className = "button button-light";
  clearError(loginError);
  clearError(loginStatus);
}

function selectRegisterTab(role = "patient") {
  hideAuthForms();
  registerForm.style.display = "";
  authTabs.style.display = "flex";
  tabLogin.className = "button button-light";
  tabRegister.className = "button button-coral";
  registerForm.elements.role.value = role;
  clearError(registerError);
}

function selectVerification(
  email,
  message = "We sent a 6-digit code to",
  { purpose = "account", challengeId = "" } = {}
) {
  pendingVerificationEmail = String(email ?? "").trim().toLowerCase();
  pendingVerificationPurpose = purpose;
  pendingLoginChallengeId = String(challengeId ?? "");
  hideAuthForms();
  verificationForm.style.display = "";
  authTabs.style.display = "none";
  verificationEmail.textContent = pendingVerificationEmail;
  verificationStatus.textContent = message;
  verificationForm.reset();
  clearError(verificationError);
  verificationForm.elements.code.focus();
}

function selectPasswordResetRequest(email = "") {
  hideAuthForms();
  authTabs.style.display = "none";
  passwordResetRequestForm.reset();
  passwordResetRequestForm.style.display = "";
  passwordResetRequestForm.elements.email.value = String(email).trim();
  clearError(passwordResetRequestError);
  passwordResetRequestForm.elements.email.focus();
}

function selectPasswordResetVerify(email) {
  pendingPasswordResetEmail = String(email ?? "").trim().toLowerCase();
  hideAuthForms();
  authTabs.style.display = "none";
  passwordResetVerifyForm.reset();
  passwordResetVerifyForm.style.display = "";
  passwordResetEmail.textContent = pendingPasswordResetEmail;
  clearError(passwordResetVerifyError);
  passwordResetVerifyForm.elements.code.focus();
}

function selectPasswordResetConfirm(resetToken) {
  pendingPasswordResetToken = resetToken;
  hideAuthForms();
  authTabs.style.display = "none";
  passwordResetConfirmForm.reset();
  passwordResetConfirmForm.style.display = "";
  clearError(passwordResetConfirmError);
  passwordResetConfirmForm.elements.newPassword.focus();
}

// Account buttons can open the normal sign-in form or a role-specific
// registration form. The backend still decides the user's role after login.
document.querySelectorAll("[data-open='auth-modal']").forEach((button) => {
  button.addEventListener("click", () => {
    warmApi();
    if (button.dataset.authMode === "register") {
      selectRegisterTab(button.dataset.authRole || "patient");
    } else {
      selectLoginTab();
    }
    showModal();
  });
});

// Tab switching
tabLogin.addEventListener("click", selectLoginTab);
tabRegister.addEventListener("click", () => selectRegisterTab());

// Login
loginForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (loginRequestInProgress) return;

  loginRequestInProgress = true;
  const submitButton = loginForm.querySelector("[type='submit']");
  submitButton.disabled = true;
  submitButton.textContent = "Checking details…";
  clearError(loginError);
  clearError(loginStatus);
  loginStatus.textContent = "Connecting securely…";
  loginStatus.style.display = "block";
  const preparingCodeTimer = window.setTimeout(() => {
    submitButton.textContent = "Preparing code…";
    loginStatus.textContent = "Your password is confirmed. Preparing your sign-in code…";
  }, 1200);
  const slowServiceTimer = window.setTimeout(() => {
    loginStatus.textContent =
      "The secure email service is taking longer than usual. Please keep this window open.";
  }, 7000);
  const data = new FormData(loginForm);
  try {
    const result = await login({
      email: data.get("email"),
      password: data.get("password"),
    });
    if (
      result.verification_required
      && result.verification_purpose === "login"
      && result.challenge_id
    ) {
      selectVerification(
        result.email ?? data.get("email"),
        "Enter the 6-digit sign-in code sent to",
        {
          purpose: "login",
          challengeId: result.challenge_id,
        }
      );
      return;
    }
    const user = await completeAuthentication();
    hideModal();
    updateAuthButtons(true, user);
    void routeAfterAuthentication(user);
  } catch (err) {
    clearError(loginStatus);
    if (err.data?.code === "email_not_verified") {
      selectVerification(err.data.email ?? data.get("email"));
      return;
    }
    showError(loginError, err.data?.non_field_errors?.[0] ?? err.message ?? "Login failed.");
  } finally {
    window.clearTimeout(preparingCodeTimer);
    window.clearTimeout(slowServiceTimer);
    loginRequestInProgress = false;
    submitButton.disabled = false;
    submitButton.textContent = "Sign in →";
  }
});

forgotPasswordButton.addEventListener("click", () => {
  selectPasswordResetRequest(loginForm.elements.email.value);
});

document.querySelectorAll("[data-password-reset-back]").forEach((button) => {
  button.addEventListener("click", selectLoginTab);
});

passwordResetRequestForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  clearError(passwordResetRequestError);
  const data = new FormData(passwordResetRequestForm);
  const email = String(data.get("email") ?? "").trim().toLowerCase();
  try {
    await requestPasswordReset(email);
    selectPasswordResetVerify(email);
  } catch (err) {
    showError(
      passwordResetRequestError,
      err.data?.detail ?? err.message ?? "Could not request a reset code."
    );
  }
});

passwordResetVerifyForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  clearError(passwordResetVerifyError);
  const data = new FormData(passwordResetVerifyForm);
  try {
    const result = await verifyPasswordResetCode({
      email: pendingPasswordResetEmail,
      code: String(data.get("code") ?? "").trim(),
    });
    selectPasswordResetConfirm(result.reset_token);
  } catch (err) {
    showError(
      passwordResetVerifyError,
      err.data?.detail ?? err.message ?? "The reset code is invalid."
    );
  }
});

passwordResetConfirmForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  clearError(passwordResetConfirmError);
  const data = new FormData(passwordResetConfirmForm);
  const newPassword = String(data.get("newPassword") ?? "");
  const confirmPassword = String(data.get("confirmPassword") ?? "");
  if (newPassword !== confirmPassword) {
    showError(passwordResetConfirmError, "The two passwords do not match.");
    return;
  }

  try {
    const result = await resetPassword({
      email: pendingPasswordResetEmail,
      resetToken: pendingPasswordResetToken,
      newPassword,
    });
    loginForm.reset();
    loginForm.elements.email.value = pendingPasswordResetEmail;
    pendingPasswordResetToken = "";
    selectLoginTab();
    loginStatus.textContent = result.detail;
    loginStatus.style.display = "block";
    loginForm.elements.password.focus();
  } catch (err) {
    const detail = err.data?.new_password?.[0]
      ?? err.data?.detail
      ?? err.message
      ?? "Could not change the password.";
    showError(passwordResetConfirmError, detail);
  }
});

// Register
registerForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  clearError(registerError);
  const data = new FormData(registerForm);
  try {
    const result = await register({
      email:     data.get("email"),
      password:  data.get("password"),
      firstName: data.get("firstName"),
      lastName:  data.get("lastName"),
      role:      data.get("role"),
    });
    selectVerification(result.email ?? data.get("email"));
  } catch (err) {
    if (err.data?.verification_required) {
      selectVerification(
        err.data.email ?? data.get("email"),
        "Your account was created. Request a new code below."
      );
      showError(verificationError, err.data.detail ?? err.message);
      return;
    }
    const detail = err.data?.email?.[0] ?? err.data?.non_field_errors?.[0] ?? err.message ?? "Registration failed.";
    showError(registerError, detail);
  }
});

verificationForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  clearError(verificationError);
  const data = new FormData(verificationForm);
  try {
    const code = String(data.get("code") ?? "").trim();
    if (pendingVerificationPurpose === "login") {
      await verifyLogin({
        challengeId: pendingLoginChallengeId,
        code,
      });
    } else {
      await verifyEmail({
        email: pendingVerificationEmail,
        code,
      });
    }
    const user = await completeAuthentication();
    hideModal();
    updateAuthButtons(true, user);
    void routeAfterAuthentication(user);
  } catch (err) {
    showError(
      verificationError,
      err.data?.detail ?? err.message ?? "Verification failed."
    );
  }
});

resendVerification.addEventListener("click", async () => {
  clearError(verificationError);
  resendVerification.disabled = true;
  try {
    const result = pendingVerificationPurpose === "login"
      ? await resendLoginVerification(pendingLoginChallengeId)
      : await resendEmailVerification(pendingVerificationEmail);
    if (result.challenge_id) {
      pendingLoginChallengeId = String(result.challenge_id);
    }
    verificationStatus.textContent = result.detail;
  } catch (err) {
    showError(
      verificationError,
      err.data?.detail ?? err.message ?? "Could not resend the code."
    );
  } finally {
    resendVerification.disabled = false;
  }
});

// Pull calibrations from the private API into this tab's short-lived cache.
async function seedCalibrationsFromApi() {
  try {
    const data = await getCalibrations();
    const results = data.results ?? data;
    const calibrations = {};
    results.forEach(cal => {
      if (cal.is_active) {
        calibrations[cal.exercise] = {
          version:              cal.version,
          exerciseId:           cal.exercise,
          affectedSide:         cal.affected_side,
          capturedAt:           cal.captured_at,
          start:                cal.start_measurements,
          target:               cal.target_measurements,
          phaseRanges:          cal.phase_ranges,
          naturalKneeDifference: cal.natural_knee_difference,
        };
      }
    });
    sessionStorage.setItem("physiovision.calibrations.v1", JSON.stringify(calibrations));
  } catch (_) {
    // Non-fatal
  }
}

async function seedPrescriptionsFromApi() {
  try {
    const data = await getPrescriptions();
    const prescriptions = data.results ?? data;
    sessionStorage.setItem(
      "physiovision.prescriptions.v1",
      JSON.stringify(prescriptions)
    );
    window.dispatchEvent(new CustomEvent(
      "physiovision:prescriptions-updated",
      { detail: prescriptions }
    ));
  } catch (_) {
    // A missing backend connection must not create fake prescriptions.
    sessionStorage.setItem("physiovision.prescriptions.v1", "[]");
    window.dispatchEvent(new CustomEvent(
      "physiovision:prescriptions-updated",
      { detail: [] }
    ));
  }
}

// Pull the profile from the private API into this tab's short-lived cache.
async function seedProfileFromApi() {
  const me = await getMe();
  publishAuthState(me.role, me);
  if (me.role === "patient" && me.profile) {
    const p = me.profile;
    const goalLabels = {
      stronger_knees: "Stronger knees",
      better_balance: "Better balance",
      less_stiffness: "Move with less stiffness",
      stay_active: "Stay active",
      stronger_hips: "Stronger hips",
      shoulder_mobility: "Better shoulder movement",
      ankle_mobility: "Better ankle movement",
      walking_confidence: "Walk with confidence",
      other: "Other",
    };
    const activityLabels = {
      lightly_active: "Lightly active",
      mostly_seated: "Mostly seated",
      active_most_days: "Active most days",
    };
    const mobilityLabels = {
      independent: "Independent",
      walking_aid: "Use a walking aid",
      needs_person: "Need another person nearby",
    };
    const wellnessPlan = p.wellness_plan ?? null;
    const planConstraints = wellnessPlan?.constraints ?? {};
    const mapped = {
      name:      `${me.first_name} ${me.last_name}`.trim(),
      goal:      goalLabels[p.goal]             ?? p.goal ?? "",
      customGoal: p.custom_goal                  ?? "",
      activity:  activityLabels[p.activity_level] ?? p.activity_level ?? "",
      mobility:  mobilityLabels[p.mobility_status] ?? p.mobility_status ?? "",
      focusSide: p.focus_side       ?? "right",
      cueStyle:  p.cue_style        ?? "gentle",
      emergencyContactName: p.emergency_contact_name ?? "",
      emergencyContactRelationship:
        p.emergency_contact_relationship ?? "",
      emergencyContactPhone: p.emergency_contact_phone ?? "",
      emergencyContactConsent: p.emergency_contact_consent === true,
      emergencyContactVerifiedAt:
        p.emergency_contact_verified_at ?? null,
      emergencyContactAlertsReady:
        p.emergency_contact_alerts_ready === true,
      carePath:  p.care_path        ?? "wellness",
      pathwayChoice: p.pathway_choice ?? "unselected",
      wellnessPlan,
      wellnessPlanAcceptedAt: p.wellness_plan_accepted_at ?? null,
      daysPerWeek: planConstraints.days_per_week,
      equipment: planConstraints.equipment,
      hasRelevantHistory: Boolean(p.medical_history),
      medicalHistory: p.medical_history ?? "",
      wellnessScreening: {
        version: 1,
        status: p.wellness_screening_status ?? "pending",
        answers: {
          notTreatingCondition:
            p.wellness_screening_answers?.not_treating_condition === true,
          noClinicianRestrictions:
            p.wellness_screening_answers?.no_clinician_restrictions === true,
          generalWellnessGoal:
            p.wellness_screening_answers?.general_wellness_goal === true,
          noConcerningSymptoms:
            p.wellness_screening_answers?.no_concerning_symptoms === true,
        },
        reviewReasons: [],
        screenedAt: p.wellness_screened_at ?? null,
      },
    };
    sessionStorage.setItem("physiovision.profile.v1", JSON.stringify(mapped));
    window.dispatchEvent(new CustomEvent("physiovision:profile-updated", { detail: mapped }));
  }
  return me;
}

async function seedSignedInData() {
  const me = await seedProfileFromApi();
  if (me?.role === "patient") {
    await Promise.all([
      seedCalibrationsFromApi(),
      seedPrescriptionsFromApi(),
    ]);
  }
  return me;
}

async function completeAuthentication() {
  clearUserCachedData();
  try {
    return await seedSignedInData();
  } catch (err) {
    await logout();
    clearUserCachedData();
    publishAuthState(null);
    throw err;
  }
}

// Signed-out visitors can view the read-only landing-page demonstration.
// Authentication opens only when they choose a sign-in or protected action.
updateAuthButtons(false);
if (isLoggedIn()) {
  completeAuthentication()
    .then((user) => updateAuthButtons(true, user))
    .catch(() => updateAuthButtons(false));
} else {
  clearUserCachedData();
  publishAuthState(null);
}

async function performLogout() {
  if (logoutRequestInProgress) return;
  logoutRequestInProgress = true;

  const revokeToken = logout();
  void clearGeneratedGuidanceSpeechCache();
  clearUserCachedData();
  updateAuthButtons(false);
  publishAuthState(null);
  hideModal();
  window.scrollTo({ top: 0, behavior: "smooth" });

  try {
    await revokeToken;
  } finally {
    logoutRequestInProgress = false;
  }
}

headerSignOut?.addEventListener("click", performLogout);
mobileSignOut?.addEventListener("click", performLogout);
therapistSignOut?.addEventListener("click", performLogout);

// Retain the public helper for any older controls or external integrations.
window.pvLogout = performLogout;
