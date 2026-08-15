import { symmetry, VISIBILITY_THRESHOLD } from "./geometry.js?v=2";
import { selectTrackedHand, summarizeHandResult } from "./hand-geometry.js";
import {
  TRACKING_MODES,
  exerciseUsesHand,
  measureCombinedExerciseFrame,
  measureHandExerciseFrame,
  measurePoseExerciseFrame,
} from "./exercise-tracking.js?v=3";
import { FeedbackEngine, EXERCISES } from "./feedback/engine.js?v=54";
import { POSES } from "./poses.js";
import {
  calibrationFrameMatchesPhase,
  createCalibration,
  extractCalibrationFrame,
  getCalibration,
  hasSavedProfile,
  inspectCalibrationFrame,
  loadProfile,
  saveCalibration,
  validateCalibrationCapture,
} from "./personalization.js?v=14";
import {
  buildCalibrationSafetyContext,
  evaluateCalibrationReuse,
} from "./calibration-policy.js?v=2";
import {
  buildSessionAssessmentSummary,
  CoachingQualitySession,
} from "./movement-quality.js?v=4";
import {
  createEmergencyAlert,
  getPainCheckins,
  getSessions,
  interpretSafetyLanguage,
  isLoggedIn,
  postCalibration,
  postPainCheckin,
  postSession,
  respondEmergencyAlert,
  sendAgentMessage,
  updatePainCheckin,
} from "./api.js?v=36";
import { analysePatientTrend } from "./patient-dashboard-state.js?v=16";
import { DRAFT_EXERCISES } from "./exercises/catalog.js?v=3";
import { getSpeechLocale, translateText } from "./i18n.js?v=47";
import { preloadPreparedGuidanceSpeech } from "./guide-audio.js?v=5";
import {
  isMovementRestRequest,
  isMovementResumeRequest,
  parseConfirmationResponse,
  parseEarlyStopReason,
  parsePainLevel,
  parsePainSafetyResponse,
  parseRecoveryStatus,
  describeMicrophoneAccessFailure,
  isSafariBrowser,
  readMicrophonePermissionState,
  voiceGuidance,
} from "./voice-guidance.js?v=54";
import {
  PRACTICE_VIEWS,
  acceptedWellnessPlan,
  hasAuthenticatedPracticeAccount,
  resolvePatientCarePath,
  resolvePracticeAccess,
  wellnessPlanDoseForExercise,
  wellnessPlanExerciseIds,
  wellnessPlanIncludesExercise,
  wellnessPlanSessionExerciseIds,
} from "./practice-access.js?v=7";
import {
  FallMonitor,
  fallMonitoringReadiness,
  parseWellbeingClarificationResponse,
  parseWellbeingResponse,
} from "./fall-monitoring.js?v=4";
import {
  minimumRepetitionsPerSet,
  painBaselineForNextExercise,
  sessionReachedTarget,
  serializePlannedSessionNote,
  sessionsForPlannedSession,
} from "./planned-session-progress.js?v=3";

let PoseLandmarker;
let HandLandmarker;
let FilesetResolver;
let DrawingUtils;

// ── EMA smoother ─────────────────────────────────────────────────────────────

const EMA_ALPHA = 0.3;
// Rep recognition should follow deliberate movement more quickly than the
// softly animated/debug angle display. The engine still requires several
// consecutive phase frames, so this faster EMA removes visible lag without
// letting one noisy landmark frame earn a repetition.
const REP_TRACKING_EMA_ALPHA = 0.65;

class AngleSmoother {
  constructor(alpha = EMA_ALPHA) {
    this.alpha = alpha;
    this.state = {};
  }

  smooth(name, raw) {
    if (raw.lowConfidence) {
      delete this.state[name];
      return raw;
    }
    // Categorical phase measurements (for example palm direction and hand
    // shape) must pass through unchanged; arithmetic smoothing only applies
    // to finite numeric measurements.
    if (typeof raw.value !== "number" || !Number.isFinite(raw.value)) {
      delete this.state[name];
      return raw;
    }
    const prev = this.state[name];
    const next =
      prev === undefined ? raw.value : prev + this.alpha * (raw.value - prev);
    this.state[name] = next;
    return { value: next, lowConfidence: false, weakPoints: [] };
  }
}

const smoother = new AngleSmoother();
const repTrackingSmoother = new AngleSmoother(REP_TRACKING_EMA_ALPHA);

// ── DOM refs ──────────────────────────────────────────────────────────────────

const video       = document.getElementById("webcam");
const canvas      = document.getElementById("overlay");
const ctx         = canvas.getContext("2d");
const synchronizedFrame = document.createElement("canvas");
const synchronizedFrameContext = synchronizedFrame.getContext("2d", {
  alpha: false,
});
const statusEl    = document.getElementById("status");
const toggleBtn   = document.getElementById("toggle");
const finishExerciseBtn = document.getElementById("finishExercise");
const exerciseCompletionPromptEl = document.getElementById(
  "exerciseCompletionPrompt"
);
const exerciseCompletionPromptTitleEl = document.getElementById(
  "exerciseCompletionPromptTitle"
);
const exerciseCompletionPromptTextEl = document.getElementById(
  "exerciseCompletionPromptText"
);
const exerciseCompletionConfirmBtn = document.getElementById(
  "exerciseCompletionConfirm"
);
const exerciseCompletionNotYetBtn = document.getElementById(
  "exerciseCompletionNotYet"
);
const earlyStopPromptEl = document.getElementById("earlyStopPrompt");
const earlyStopQuestionEl = document.getElementById("earlyStopQuestion");
const earlyStopPromptTextEl = document.getElementById("earlyStopPromptText");
const earlyStopReasonChoicesEl = document.getElementById(
  "earlyStopReasonChoices"
);
const earlyStopSkipBtn = document.getElementById("earlyStopSkip");
const earlyStopSafetyEl = document.getElementById("earlyStopSafety");
const earlyStopSafetyTitleEl = document.getElementById("earlyStopSafetyTitle");
const earlyStopSafetyMessageEl = document.getElementById(
  "earlyStopSafetyMessage"
);
const earlyStopSafetyHelpEl = document.getElementById("earlyStopSafetyHelp");
const earlyStopContinueBtn = document.getElementById("earlyStopContinue");
const earlyStopVoiceStatusEl = document.getElementById(
  "earlyStopVoiceStatus"
);
const cameraSessionHintEl = document.getElementById("cameraSessionHint");
const liveSessionDayEl = document.getElementById("liveSessionDay");
const liveSessionProgressEl = document.getElementById("liveSessionProgress");
const liveSessionFocusEl = document.getElementById("liveSessionFocus");
const movementAiStatusEl = document.getElementById("movementAiStatus");
const guideAudioSourceEl = document.getElementById("guideAudioSource");
const guideAudioSourceValueEl = document.getElementById(
  "guideAudioSourceValue"
);
const fpsEl       = document.getElementById("fps");
const exSelect    = document.getElementById("exerciseSelect");
const sideSelect  = document.getElementById("sideSelect");
const poseStripEl        = document.getElementById("poseStrip");
const repCountEl         = document.getElementById("repCount");
const cameraRepProgressEl = document.getElementById("cameraRepProgress");
const phaseFlowEl        = document.getElementById("phaseFlow");
const progressEl         = document.getElementById("progressFill");
const progressLbl        = document.getElementById("progressLabel");
const progressSection    = document.getElementById("progressSection");
const holdTimerSection   = document.getElementById("holdTimerSection");
const holdProgressEl     = document.getElementById("holdProgressFill");
const holdInlineEl       = document.getElementById("holdInline");
const holdInlineCountEl  = document.getElementById("holdInlineCountdown");
const cueListEl          = document.getElementById("cueList");
const symWarnEl          = document.getElementById("symWarning");
const trackWarnEl        = document.getElementById("trackingWarning");
const prescEl            = document.getElementById("prescription");
const repTargetEl        = document.getElementById("repTarget");
const repLabelEl         = document.getElementById("repLabel");
const setCompleteBadgeEl = document.getElementById("setCompleteBadge");
const feedbackEl         = document.getElementById("feedbackBanner");
const cameraStage        = document.getElementById("cameraStage");
const personalizationTitle  = document.getElementById("personalizationTitle");
const personalizationDetail = document.getElementById("personalizationDetail");
const exerciseImageWrap     = document.getElementById("exerciseImageWrap");
const exerciseImageEl       = document.getElementById("exerciseImage");

const EXERCISE_IMAGES = {
  "heel-cord-stretch":     "img/exercises/heel-cord-stretch.jpg",
  "standing-quad-stretch": "img/exercises/standing-quad-stretch.jpg",
  "half-squats":               "img/exercises/half-squats.jpg",
  "supine-hamstring-stretch":  "img/exercises/supine-hamstring-stretch.jpg",
  "hamstring-curls":           "img/exercises/standing-quad-stretch.jpg",
  "calf-raises":               "img/exercises/calf-raises.jpg",
  "leg-extensions":            "img/exercises/leg-extensions.jpg",
  "supine-leg-raise":              "img/exercises/supine-leg-raise.jpg",
  "straight-leg-raises-supine":    "img/exercises/straight-leg-raises-supine.jpg",
  "straight-leg-raises-prone":     "img/exercises/straight-leg-raises-prone.jpg",
  "hip-abduction":             "img/exercises/hip-abduction.jpg",
  "leg-presses":               "img/exercises/leg-presses.jpg",
  "hip-adduction":             "img/exercises/hip-adduction.jpg",
  "wrist_extension_stretch":   "img/exercises/wrist_extension_stretch.jpg",
  "wrist_flexion_stretch":     "img/exercises/wrist_flexion_stretch.jpg",
  "ankle_pumps":               "img/exercises/ankle_pumps.jpg",
  "heel_slides":               "img/exercises/heel_slides.jpg",
  "hip_bridge":                "img/exercises/hip_bridge.jpg",
  "forearm_supination_pronation_strengthening": "img/exercises/forearm_supination_pronation_strengthening.jpg",
  "supported_single_leg_balance": "img/exercises/supported_single_leg_balance.jpg",
  "clamshell":                 "img/exercises/clamshell.jpg",
  "supported_forward_step_up": "img/exercises/supported_forward_step_up.jpg",
  "hip_flexor_stretch":        "img/exercises/hip_flexor_stretch.jpg",
  "single_knee_to_chest_stretch": "img/exercises/single_knee_to_chest_stretch.jpg",
  "pendulum":                  "img/exercises/pendulum.jpg",
  "crossover_arm_stretch":     "img/exercises/crossover_arm_stretch.jpg",
  "shoulder_forward_elevation_assisted": "img/exercises/shoulder_forward_elevation_assisted.jpg",
};

function renderExerciseImage(exercise) {
  const src = EXERCISE_IMAGES[exercise.id];
  if (!exerciseImageWrap) return;
  if (src && exerciseImageEl) {
    exerciseImageEl.onload  = () => { exerciseImageWrap.style.display = ""; };
    exerciseImageEl.onerror = () => { exerciseImageWrap.style.display = "none"; };
    exerciseImageEl.alt = exercise.name;
    exerciseImageEl.src = src;
    exerciseImageWrap.style.display = "";
  } else {
    exerciseImageWrap.style.display = "none";
  }
}
const calibrationBadge      = document.getElementById("calibrationBadge");
const calibrationDetail     = document.getElementById("calibrationDetail");
const openCalibrationBtn    = document.getElementById("openCalibration");
const openCalibrationPrimary =
  document.getElementById("openCalibrationPrimary");
const primaryCalibrationLabel =
  document.getElementById("primaryCalibrationLabel");
const primaryCameraInstruction =
  document.getElementById("primaryCameraInstruction");
const cameraSetupStatus =
  document.getElementById("cameraSetupStatus");
const calibrationOverlay    = document.getElementById("calibrationOverlay");
const calibrationStepLabel  = document.getElementById("calibrationStepLabel");
const calibrationTitle      = document.getElementById("calibrationTitle");
const calibrationInstructions = document.getElementById("calibrationInstructions");
const calibrationStatus     = document.getElementById("calibrationStatus");
const calibrationCancel     = document.getElementById("calibrationCancel");
const setupTip              = document.getElementById("setupTip");
const handFrameGuide        = document.getElementById("handFrameGuide");
const handTrackingToggle    = document.getElementById("handTrackingToggle");
const handTrackingReadout   = document.getElementById("handTrackingReadout");
const handModelStatus       = document.getElementById("handModelStatus");
const handGuideText         = handFrameGuide?.querySelector(":scope > span");
const soundToggle           = document.getElementById("soundToggle");
const voiceSpeedSelect      = document.getElementById("voiceSpeedSelect");
const voiceSetupSpeedSelect = document.getElementById("voiceSetupSpeedSelect");
const voiceSetupOverlay     = document.getElementById("voiceSetupOverlay");
const voiceSetupHandsFree   = document.getElementById("voiceSetupHandsFree");
const voiceSetupButtons     = document.getElementById("voiceSetupButtons");
const voiceSetupStatus      = document.getElementById("voiceSetupStatus");
const voiceSetupRecovery    = document.getElementById("voiceSetupRecovery");
const voiceSetupRetry       = document.getElementById("voiceSetupRetry");
const publicPracticePreview = document.getElementById("publicPracticePreview");
const patientPracticeGate   = document.getElementById("patientPracticeGate");
const patientPracticeGateTitle =
  document.getElementById("patientPracticeGateTitle");
const patientPracticeGateMessage =
  document.getElementById("patientPracticeGateMessage");
const patientPracticeGateAction =
  document.getElementById("patientPracticeGateAction");
const patientPracticeWorkspace =
  document.getElementById("patientPracticeWorkspace");
const clinicianPracticeGate =
  document.getElementById("clinicianPracticeGate");
const fallReadinessEl = document.getElementById("fallReadiness");
const fallReadinessTitleEl = document.getElementById("fallReadinessTitle");
const fallReadinessDetailEl = document.getElementById("fallReadinessDetail");
const fallSafetyOverlay = document.getElementById("fallSafetyOverlay");
const fallSafetyQuestion = document.getElementById("fallSafetyQuestion");
const fallSafetyResult = document.getElementById("fallSafetyResult");
const fallSafetyCountdown = document.getElementById("fallSafetyCountdown");
const fallSafetyOkay = document.getElementById("fallSafetyOkay");
const fallSafetyHelp = document.getElementById("fallSafetyHelp");
const fallSafetyVoice = document.getElementById("fallSafetyVoice");
const fallSafetyVoiceStatus = document.getElementById("fallSafetyVoiceStatus");
const fallSafetyResultTitle = document.getElementById("fallSafetyResultTitle");
const fallSafetyResultMessage = document.getElementById("fallSafetyResultMessage");
const fallSafetyResultIcon = document.getElementById("fallSafetyResultIcon");
const fallSafetyContactNotice = document.getElementById("fallSafetyContactNotice");
const fallSafetyCountdownLabel = document.getElementById("fallSafetyCountdownLabel");
const fallSafetyAlertStatus = document.getElementById("fallSafetyAlertStatus");
const fallSafetyAlertStatusTitle = document.getElementById(
  "fallSafetyAlertStatusTitle"
);
const fallSafetyAlertStatusMessage = document.getElementById(
  "fallSafetyAlertStatusMessage"
);
const fallSafetyCall995 = document.getElementById("fallSafetyCall995");
const fallSafetyClose = document.getElementById("fallSafetyClose");

// Keep the full-screen wellbeing dialog outside the camera grid so ancestor
// overflow rules cannot crop its viewport-sized accessible controls.
document.body.appendChild(fallSafetyOverlay);

let profile = loadProfile();
let poseLandmarker = null;
let handLandmarker = null;
let sessionStartedAt = null;
let exerciseSessionActive = false;
let activePrescriptions = loadActivePrescriptions();
const initialAuthState = window.physioVisionAuthState ?? null;
let authenticatedRole = initialAuthState?.role ?? null;
let authenticatedPatientProfile =
  authenticatedRole === "patient"
    ? initialAuthState?.user?.profile ?? null
    : null;
let practiceIdentityOverride = null;
let activeSessionExerciseIds = [];
let activeSessionDay = "";
let activeSessionTitle = "";
let activeSessionKey = "";
let activeSessionCompletedExerciseIds = new Set();
let prescriptionsLoaded =
  authenticatedRole !== "patient" ||
  window.sessionStorage.getItem("physiovision.prescriptions.v1") !== null;

function currentPracticeIdentity() {
  const authState = window.physioVisionAuthState ?? null;
  const role =
    practiceIdentityOverride?.role ??
    authState?.role ??
    authenticatedRole ??
    null;
  const mergedPatientProfile =
    role === "patient"
      ? {
          ...(authenticatedPatientProfile ?? {}),
          ...(authState?.user?.profile ?? {}),
          ...(practiceIdentityOverride?.profile ?? {}),
        }
      : null;
  const patientProfile =
    mergedPatientProfile && Object.keys(mergedPatientProfile).length
      ? mergedPatientProfile
      : null;
  const loggedIn = hasAuthenticatedPracticeAccount({
    loggedIn: Boolean(authState?.user) || isLoggedIn(),
    role,
  });

  return { loggedIn, role, patientProfile };
}

function isPracticeAccountAuthenticated() {
  return currentPracticeIdentity().loggedIn;
}

const initialPracticeIdentity = currentPracticeIdentity();
let practiceDecision = resolvePracticeAccess({
  loggedIn: initialPracticeIdentity.loggedIn,
  role: initialPracticeIdentity.role,
  patientProfile: initialPracticeIdentity.patientProfile,
  activePrescriptionCount: activePrescriptions.size,
  prescriptionsLoaded,
});
let visionRuntimePromise = null;
let poseModelPromise = null;
let handModelPromise = null;
const fallMonitor = new FallMonitor();
let safetyCheckActive = false;
let fallSafetyTimer = null;
const FALL_SAFETY_COUNTDOWN_SECONDS = 60;
let fallSafetySecondsRemaining = FALL_SAFETY_COUNTDOWN_SECONDS;
let fallSafetyPreviousFocus = null;
let activeFallEvent = null;
let activeFallAlertPromise = null;
let fallSafetyClarificationMode = "";
let fallSafetyAiAttempts = 0;
let handsFreeVoiceEnabled = false;
let voiceModeChosenThisSession = false;
let voiceModeChoicePromise = null;
let resolveVoiceModeChoice = null;
let preExerciseCheckinCompleted = false;
let confirmedPreExercisePain = null;
let activePreExerciseCheckinPromise = null;
let completedExerciseSessionPromise = null;
let completedExerciseSessionSnapshot = null;
let completedExerciseSessionError = null;
let completedExerciseCheckinLinkError = false;
let exerciseTransitionPainBaseline = null;
let cameraSetupCountdown = null;
let movementAiState = "off";
let movementCoachingGeneration = 0;
let movementAiGeneration = 0;
let movementAiRestartTimer = null;
let restResumeVoiceGeneration = 0;
let restResumeVoiceTimer = null;
let exerciseTransitionVoiceGeneration = 0;
let exerciseTransitionVoiceTimer = null;
let movementTrackingPausedForInstruction = false;
const exerciseContent = new Map(
  DRAFT_EXERCISES.map((exercise) => [exercise.id, exercise])
);

voiceGuidance.attachToggle(soundToggle);
voiceGuidance.attachRateControl(voiceSpeedSelect);
voiceGuidance.attachRateControl(voiceSetupSpeedSelect);

function armVoiceListening(callback) {
  callback();
}

function finishVoiceModeChoice(handsFree) {
  handsFreeVoiceEnabled = Boolean(handsFree);
  voiceModeChosenThisSession = true;
  voiceGuidance.setEnabled(handsFreeVoiceEnabled);
  voiceSetupOverlay.classList.add("hidden");
  voiceSetupHandsFree.disabled = false;
  voiceSetupButtons.disabled = false;
  voiceSetupRetry.disabled = false;
  voiceSetupStatus.textContent = "";
  voiceSetupRecovery.classList.add("hidden");
  const resolve = resolveVoiceModeChoice;
  resolveVoiceModeChoice = null;
  voiceModeChoicePromise = null;
  resolve?.(true);
}

function resetVoiceModeChoice() {
  stopMovementAiGuide();
  voiceGuidance.cancel();
  handsFreeVoiceEnabled = false;
  voiceModeChosenThisSession = false;
  voiceGuidance.setEnabled(false);
  voiceSetupOverlay.classList.add("hidden");
  voiceSetupHandsFree.disabled = false;
  voiceSetupButtons.disabled = false;
  voiceSetupRetry.disabled = false;
  voiceSetupStatus.textContent = "";
  voiceSetupRecovery.classList.add("hidden");

  const resolve = resolveVoiceModeChoice;
  resolveVoiceModeChoice = null;
  voiceModeChoicePromise = null;
  resolve?.(false);
}

function ensureVoiceModeChosen() {
  if (voiceModeChosenThisSession) return Promise.resolve(true);
  if (voiceModeChoicePromise) return voiceModeChoicePromise;

  voiceSetupOverlay.classList.remove("hidden");
  voiceSetupOverlay.scrollTop = 0;
  voiceSetupRecovery.classList.add("hidden");
  voiceSetupHandsFree.disabled =
    !voiceGuidance.canSpeak || !voiceGuidance.canListen;
  voiceSetupStatus.textContent = voiceSetupHandsFree.disabled
    ? (
      "Hands-free voice is unavailable in this browser. "
      + "Choose on-screen buttons to continue."
    )
    : (
      "Choose once before setup. No AI speech or microphone listening "
      + "starts until you select an option."
    );
  (voiceSetupHandsFree.disabled
    ? voiceSetupButtons
    : voiceSetupHandsFree
  ).focus({ preventScroll: true });

  voiceModeChoicePromise = new Promise((resolve) => {
    resolveVoiceModeChoice = resolve;
  });
  return voiceModeChoicePromise;
}

async function requestHandsFreeMicrophone() {
  if (!voiceGuidance.canSpeak || !voiceGuidance.canListen) return;

  voiceSetupHandsFree.disabled = true;
  voiceSetupButtons.disabled = true;
  voiceSetupRetry.disabled = true;
  voiceSetupRecovery.classList.add("hidden");
  voiceSetupStatus.textContent = "Checking microphone permission…";

  try {
    if (isSafariBrowser(navigator.userAgent)) {
      voiceSetupStatus.textContent =
        "Waiting for Safari to confirm microphone access…";
      // WebKit manages SpeechRecognition permission separately. Starting a
      // short readiness check from this click opens Safari's native prompt
      // while the site remains set to Ask and verifies the exact input API
      // that hands-free questions will use.
      await voiceGuidance.verifyListeningAccess();
    } else {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error("Microphone preflight is unavailable in this browser.");
      }

      // Other browsers share this permission with their speech recognizer.
      // Keep the request directly inside the selection click so their native
      // prompt retains the required user activation.
      const microphoneRequest = navigator.mediaDevices.getUserMedia({
        audio: true,
      });

      // Never replace this check with a stored permission hint: a stored hint
      // can survive a refresh even when the browser or operating system can no
      // longer provide microphone access.
      const permissionStream = await microphoneRequest;
      permissionStream.getTracks().forEach((track) => track.stop());
    }

    // Do not touch the audio-output session until the browser has completed
    // its microphone decision; WebKit can otherwise lose the native prompt.
    await voiceGuidance.unlockNeuralAudio();
    voiceSetupStatus.textContent = "Preparing consistent voice guidance…";
    await preloadPreparedGuidanceSpeech(getSpeechLocale());
    // Safari can keep speaker output in its quiet microphone-capture mode for
    // a moment after the permission stream stops. Let that audio session settle
    // before the first prompt so its full sentence has one consistent volume.
    try {
      await voiceGuidance.prepareSpeechAfterMicrophoneRelease();
    } catch (error) {
      console.warn("Voice-output preparation could not complete.", error);
    }
    finishVoiceModeChoice(true);
  } catch (error) {
    console.error("Hands-free microphone setup failed.", {
      name: error?.name,
      message: error?.message,
    });
    const permissionState = await readMicrophonePermissionState(navigator);
    // Never claim hands-free mode is active unless the browser confirmed real
    // microphone capture. Safari's readiness check waits for `audiostart` so a
    // failed or dismissed prompt cannot leave the user at a question that is
    // not listening.
    voiceSetupHandsFree.disabled = false;
    voiceSetupButtons.disabled = false;
    voiceSetupRetry.disabled = false;
    voiceSetupStatus.textContent = describeMicrophoneAccessFailure(error, {
      userAgent: navigator.userAgent,
      permissionState,
    });
    voiceSetupRecovery.classList.remove("hidden");
    voiceSetupRetry.focus({ preventScroll: true });
  }
}

voiceSetupHandsFree.addEventListener("click", requestHandsFreeMicrophone);
voiceSetupRetry.addEventListener("click", requestHandsFreeMicrophone);

voiceSetupButtons.addEventListener("click", () => {
  finishVoiceModeChoice(false);
});

soundToggle?.addEventListener("click", () => {
  if (!voiceGuidance.enabled) {
    handsFreeVoiceEnabled = false;
    stopMovementAiGuide({ hide: !running });
    if (running) {
      setMovementAiStatus(
        "off",
        "AI voice questions stopped because spoken guidance is off."
      );
    }
    if (painCheckinState) updatePainCheckinPresentation();
  }
});

function loadActivePrescriptions() {
  try {
    const stored = JSON.parse(
      window.sessionStorage.getItem("physiovision.prescriptions.v1") ?? "[]"
    );
    const today = new Date().toISOString().slice(0, 10);
    return new Map(
      (Array.isArray(stored) ? stored : [])
        .filter((prescription) => (
          prescription.is_active &&
          prescription.valid_from <= today &&
          (!prescription.valid_until || prescription.valid_until >= today)
        ))
        .map((prescription) => [prescription.exercise, prescription])
    );
  } catch (_) {
    return new Map();
  }
}

function renderFallReadiness(exercise = engine?.exercise) {
  const readiness = fallMonitoringReadiness(exercise);
  fallReadinessEl.dataset.state = readiness.state;
  fallReadinessTitleEl.textContent = readiness.title;
  fallReadinessDetailEl.textContent = (
    readiness.state === "ready" && !profile.emergencyContactAlertsReady
      ? "The camera check is available. Verify an emergency contact in My profile before automatic alerts can be sent."
      : readiness.detail
  );
  const icon = fallReadinessEl.querySelector(".fall-readiness-icon");
  if (icon) {
    icon.textContent = readiness.state === "ready"
      ? "✓"
      : readiness.state === "limited"
        ? "!"
        : "—";
  }
}

function configureFallMonitoring(exercise = engine?.exercise) {
  fallMonitor.configure(exercise);
  renderFallReadiness(exercise);
}

function recordLocalSafetyIncident(response, event = {}) {
  const storageKey = "physiovision.local-safety-incidents.v1";
  try {
    const previous = JSON.parse(window.sessionStorage.getItem(storageKey) ?? "[]");
    const incidents = Array.isArray(previous) ? previous : [];
    incidents.push({
      recordedAt: new Date().toISOString(),
      exerciseId: engine?.exercise?.id ?? null,
      monitoringMode: event.mode ?? fallMonitor.mode,
      response,
      signals: Array.isArray(event.signals) ? event.signals : [],
    });
    window.sessionStorage.setItem(
      storageKey,
      JSON.stringify(incidents.slice(-20))
    );
  } catch (_) {
    // A private-browsing storage failure must not block the on-screen check.
  }
}

function clearFallSafetyTimer() {
  window.clearInterval(fallSafetyTimer);
  fallSafetyTimer = null;
}

function createFallClientEventId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, "0"));
  return [
    hex.slice(0, 4).join(""),
    hex.slice(4, 6).join(""),
    hex.slice(6, 8).join(""),
    hex.slice(8, 10).join(""),
    hex.slice(10).join(""),
  ].join("-");
}

function setFallAlertStatus(state, title, message) {
  fallSafetyAlertStatus.classList.remove("hidden");
  fallSafetyAlertStatus.dataset.state = state;
  fallSafetyAlertStatusTitle.textContent = title;
  fallSafetyAlertStatusMessage.textContent = message;
}

function updateFallContactNotice(alert) {
  if (!alert) {
    fallSafetyContactNotice.textContent =
      "The server could not register this alert. No automatic contact notification is available.";
    fallSafetyCountdownLabel.textContent =
      "seconds to answer before help instructions appear";
    return;
  }
  if (alert.contact_ready && alert.status === "pending") {
    const who = alert.contact_name || "your verified emergency contact";
    fallSafetyContactNotice.textContent =
      `If you do not respond, PhysioVision will request an automated call to ${who}. It will not call 995.`;
    fallSafetyCountdownLabel.textContent =
      `seconds to answer before ${who} is alerted`;
    return;
  }
  fallSafetyContactNotice.textContent =
    "No verified automatic contact alert is available. Use Call 995 or ask someone nearby for urgent help.";
  fallSafetyCountdownLabel.textContent =
    "seconds to answer before help instructions appear";
}

function registerFallAlert(event) {
  if (!isLoggedIn()) {
    updateFallContactNotice(null);
    return Promise.resolve(null);
  }
  const clientEventId = createFallClientEventId();
  const promise = createEmergencyAlert({
    clientEventId,
    exerciseId: engine?.exercise?.id ?? "",
    monitoringMode: event.mode ?? fallMonitor.mode ?? "",
    signals: Array.isArray(event.signals) ? event.signals : [],
  })
    .then((alert) => {
      if (activeFallEvent === event) {
        updateFallContactNotice(alert);
        if (Number.isInteger(alert.countdown_seconds)) {
          fallSafetySecondsRemaining = Math.min(
            fallSafetySecondsRemaining,
            alert.countdown_seconds
          );
          fallSafetyCountdown.textContent = String(
            Math.max(fallSafetySecondsRemaining, 0)
          );
        }
      }
      return alert;
    })
    .catch((error) => {
      if (activeFallEvent === event) {
        updateFallContactNotice(null);
        fallSafetyVoiceStatus.textContent =
          `${error.message || "The automatic alert could not be registered."} Use Call 995 or ask someone nearby if you need urgent help.`;
      }
      return null;
    });
  return promise;
}

function renderFallAlertDelivery(alert) {
  if (!alert) {
    setFallAlertStatus(
      "error",
      "No automatic contact alert was sent",
      "The alert could not reach the server. Use Call 995 or contact someone nearby."
    );
    return;
  }
  const who = alert.contact_name || "your emergency contact";
  if (alert.status === "notified") {
    setFallAlertStatus(
      "sent",
      `Call requested for ${who}`,
      "Vonage accepted the call request. This does not mean the contact answered, and no ambulance was dispatched."
    );
  } else if (alert.status === "partial") {
    setFallAlertStatus(
      "error",
      `The automatic call to ${who} was not confirmed`,
      "Use Call 995 or another phone if urgent."
    );
  } else if (["pending", "notifying"].includes(alert.status)) {
    setFallAlertStatus(
      "pending",
      `Contacting ${who}…`,
      "An automated call is being requested. No ambulance has been dispatched."
    );
  } else {
    setFallAlertStatus(
      "error",
      "No automatic contact alert was sent",
      alert.status === "not_configured"
        ? "A verified contact and notification provider are not both active. Use Call 995 or ask someone nearby."
        : "The notification provider failed. Use Call 995 or another phone if urgent."
    );
  }
}

async function submitFallEmergencyResponse(response) {
  const alertPromise = activeFallAlertPromise;
  const alert = alertPromise ? await alertPromise : null;
  if (!alert) {
    if (response !== "okay") renderFallAlertDelivery(null);
    return;
  }
  try {
    const updated = await respondEmergencyAlert(alert.id, response);
    if (response !== "okay") {
      renderFallAlertDelivery(updated);
      if (["notified", "partial"].includes(updated.status)) {
        speakMovementGuide(
          "An alert request was sent to your emergency contact. This does not mean they answered. No ambulance was dispatched.",
          { key: `fall-contact-alert:${updated.id}` }
        );
      }
    }
  } catch (error) {
    if (response !== "okay") {
      setFallAlertStatus(
        "error",
        "Automatic contact alert failed",
        `${error.message || "The server could not send the alert."} Use Call 995 or another phone if urgent.`
      );
    }
  }
}

function showFallSafetyResult(response, event = {}) {
  clearFallSafetyTimer();
  fallSafetyClarificationMode = "";
  recordLocalSafetyIncident(response, event);
  deactivateCameraGuide({
    statusMessage: "Exercise stopped for a safety check",
  });

  fallSafetyQuestion.classList.add("hidden");
  fallSafetyResult.classList.remove("hidden");
  fallSafetyResult.classList.toggle(
    "fall-safety-result-safe",
    response === "okay"
  );
  fallSafetyAlertStatus.classList.toggle("hidden", response === "okay");
  fallSafetyAlertStatus.removeAttribute("data-state");
  fallSafetyCall995.classList.toggle("hidden", response === "okay");

  if (response === "okay") {
    fallSafetyResultIcon.textContent = "✓";
    fallSafetyResultTitle.textContent = "Thank you. The exercise has stopped.";
    fallSafetyResultMessage.textContent =
      "The possible fall was marked as a false alarm. Take a moment before deciding whether to exercise again.";
  } else if (response === "help") {
    fallSafetyResultIcon.textContent = "!";
    fallSafetyResultTitle.textContent = "You said that you need help.";
    fallSafetyResultMessage.textContent =
      "Stay where you are if moving may be unsafe. Call 995 now for urgent help, or call out to someone nearby.";
  } else {
    fallSafetyResultIcon.textContent = "!";
    fallSafetyResultTitle.textContent = "We did not receive a response.";
    fallSafetyResultMessage.textContent =
      "The exercise and camera have stopped. Anyone nearby should check on you and call 995 if urgent.";
  }

  if (response !== "okay") {
    setFallAlertStatus(
      "pending",
      "Checking your emergency-contact alert…",
      "PhysioVision never calls 995 automatically. Use Call 995 now if you can."
    );
  }
  void submitFallEmergencyResponse(response);

  speakMovementGuide(
    `${fallSafetyResultTitle.textContent} ${fallSafetyResultMessage.textContent}` +
      (response === "okay"
        ? ""
        : " PhysioVision is checking whether your verified emergency contact can be alerted. It will not call 995 automatically."),
    {
      key: `fall-safety-result:${response}`,
      interrupt: true,
    }
  );
  (response === "okay" ? fallSafetyClose : fallSafetyCall995)
    .focus({ preventScroll: true });
}

function requestFallSafetyOkayClarification() {
  fallSafetyClarificationMode = "confirm-okay";
  const clarification =
    "I heard that you may not need help. To make sure, are you okay and able "
    + "to move safely? Say yes, I’m okay, or say no, I need help.";
  fallSafetyVoiceStatus.textContent = clarification;
  const listenAfterQuestion = () => {
    if (
      safetyCheckActive &&
      fallSafetyClarificationMode === "confirm-okay" &&
      !fallSafetyQuestion.classList.contains("hidden")
    ) {
      startFallSafetyVoiceListening();
    }
  };
  const spoken = speakMovementGuide(clarification, {
    key: "possible-fall-clarify-okay",
    interrupt: true,
    onEnd: () => armVoiceListening(listenAfterQuestion),
  });
  if (!spoken) listenAfterQuestion();
}

function requestFallSafetyUnknownClarification(transcript) {
  fallSafetyVoiceStatus.textContent =
    `I heard: “${transcript}”, but I could not tell whether you are safe. `
    + "Tell me what happened, whether you can stand or move, and how much pain you feel.";
  const listenAfterQuestion = () => {
    if (
      safetyCheckActive &&
      !fallSafetyQuestion.classList.contains("hidden")
    ) {
      startFallSafetyVoiceListening();
    }
  };
  const spoken = speakMovementGuide(
    "I could not tell whether you are safe. Tell me what happened, whether you "
    + "can stand or move, and how much pain you feel. You can also use one of "
    + "the large buttons.",
    {
      key: "possible-fall-clarify-unknown",
      interrupt: true,
      onEnd: () => armVoiceListening(listenAfterQuestion),
    }
  );
  if (!spoken) listenAfterQuestion();
}

function requestFallSafetyAiClarification(prompt) {
  const fixedPrompt = String(prompt || "").trim();
  if (!fixedPrompt) {
    fallSafetyVoiceStatus.textContent =
      "I could not determine what you meant. Please use one of the two large buttons.";
    return;
  }
  fallSafetyVoiceStatus.textContent = fixedPrompt;
  const listenAfterQuestion = () => {
    if (
      safetyCheckActive
      && !fallSafetyQuestion.classList.contains("hidden")
    ) {
      startFallSafetyVoiceListening();
    }
  };
  const spoken = speakMovementGuide(fixedPrompt, {
    key: `possible-fall:ai-clarification:${fallSafetyAiAttempts}`,
    interrupt: true,
    rate: 0.97,
    onEnd: () => armVoiceListening(listenAfterQuestion),
  });
  if (!spoken) listenAfterQuestion();
}

async function interpretFallSafetyTranscript(transcript) {
  if (fallSafetyAiAttempts >= 1) {
    fallSafetyVoiceStatus.textContent =
      "I still could not determine what you meant. Please use I’m okay or I need help.";
    return;
  }
  fallSafetyAiAttempts += 1;
  const expectedEvent = activeFallEvent;
  const expectedMode = fallSafetyClarificationMode;
  const stage = expectedMode === "confirm-okay"
    ? "fall-confirm-okay"
    : "fall-wellbeing";
  fallSafetyVoiceStatus.textContent =
    `I heard: “${transcript}” Checking what you meant…`;
  try {
    const interpretation = await interpretSafetyLanguage({
      stage,
      transcript,
    });
    if (
      !safetyCheckActive
      || activeFallEvent !== expectedEvent
      || fallSafetyClarificationMode !== expectedMode
      || fallSafetyQuestion.classList.contains("hidden")
    ) {
      return;
    }
    const response = interpretation?.matched
      ? interpretation.response
      : "";
    if (response === "okay" || response === "help") {
      showFallSafetyResult(response, activeFallEvent ?? {});
    } else if (response === "confirm-okay") {
      requestFallSafetyOkayClarification();
    } else {
      requestFallSafetyAiClarification(interpretation?.retry_prompt);
    }
  } catch (_) {
    if (safetyCheckActive && activeFallEvent === expectedEvent) {
      fallSafetyVoiceStatus.textContent =
        "The language helper is unavailable. Please use I’m okay or I need help.";
    }
  }
}

function startFallSafetyVoiceListening() {
  if (!safetyCheckActive || fallSafetyQuestion.classList.contains("hidden")) {
    return false;
  }
  return voiceGuidance.listen({
    onStatus: (status) => {
      fallSafetyVoiceStatus.textContent = status;
    },
    onError: (message) => {
      fallSafetyVoiceStatus.textContent =
        `${message} You can also use one of the two large buttons.`;
    },
    onResult: (transcript) => {
      const response = fallSafetyClarificationMode === "confirm-okay"
        ? parseWellbeingClarificationResponse(transcript)
        : parseWellbeingResponse(transcript);
      fallSafetyVoiceStatus.textContent = `I heard: “${transcript}”`;
      if (response === "okay" || response === "help") {
        showFallSafetyResult(response, activeFallEvent ?? {});
      } else if (response === "confirm-okay") {
        requestFallSafetyOkayClarification();
      } else {
        void interpretFallSafetyTranscript(transcript);
      }
    },
  });
}

function beginFallSafetyCheck(event) {
  if (safetyCheckActive) return;
  stopMovementAiGuide();
  safetyCheckActive = true;
  fallSafetyClarificationMode = "";
  fallSafetyAiAttempts = 0;
  activeFallEvent = event;
  fallSafetyPreviousFocus = document.activeElement;
  clearHoldTimer(activeDose(engine.exercise).holdSeconds);
  resetSpokenCoaching();
  voiceGuidance.cancel();
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  fallSafetyQuestion.classList.remove("hidden");
  fallSafetyResult.classList.add("hidden");
  fallSafetyResult.classList.remove("fall-safety-result-safe");
  fallSafetyAlertStatus.classList.add("hidden");
  fallSafetyCall995.classList.add("hidden");
  fallSafetyContactNotice.textContent =
    "Registering the safety countdown with the server…";
  fallSafetyCountdownLabel.textContent =
    "seconds to answer before the safety check escalates";
  fallSafetyVoiceStatus.textContent = handsFreeVoiceEnabled
    ? "Hands-free voice is on. Answer naturally after the question."
    : voiceGuidance.canListen
      ? "You can answer naturally by voice, or use a large button."
    : "Voice input is unavailable in this browser. Use a large button.";
  fallSafetyVoice.disabled = !voiceGuidance.canListen;
  fallSafetySecondsRemaining = FALL_SAFETY_COUNTDOWN_SECONDS;
  fallSafetyCountdown.textContent = String(fallSafetySecondsRemaining);
  activeFallAlertPromise = registerFallAlert(event);
  fallSafetyOverlay.classList.remove("hidden");
  document.body.classList.add("fall-safety-open");
  fallSafetyOkay.focus({ preventScroll: true });

  const spoken = speakMovementGuide(
    "We noticed a possible fall and stopped the exercise. Are you okay? Tell me how you feel, or use one of the large buttons.",
    {
      key: "possible-fall-check",
      interrupt: true,
      onEnd: () => {
        armVoiceListening(() => {
          if (handsFreeVoiceEnabled && safetyCheckActive) {
            startFallSafetyVoiceListening();
          }
        });
      },
    }
  );
  if (!spoken && handsFreeVoiceEnabled) {
    if (safetyCheckActive) startFallSafetyVoiceListening();
  }

  clearFallSafetyTimer();
  fallSafetyTimer = window.setInterval(() => {
    fallSafetySecondsRemaining -= 1;
    fallSafetyCountdown.textContent = String(
      Math.max(fallSafetySecondsRemaining, 0)
    );
    if (fallSafetySecondsRemaining === 30) {
      speakMovementGuide("Thirty seconds left to answer.", {
        key: "possible-fall-countdown-30",
      });
    } else if (fallSafetySecondsRemaining === 10) {
      speakMovementGuide("Ten seconds left to answer.", {
        key: "possible-fall-countdown-10",
      });
    } else if (fallSafetySecondsRemaining === 5) {
      speakMovementGuide("Five seconds left to answer.", {
        key: "possible-fall-countdown-5",
      });
    } else if (fallSafetySecondsRemaining <= 0) {
      showFallSafetyResult("no_response", event);
    }
  }, 1000);
}

function closeFallSafetyCheck() {
  clearFallSafetyTimer();
  voiceGuidance.cancel();
  safetyCheckActive = false;
  fallMonitor.resumeAfterCheck();
  fallSafetyOverlay.classList.add("hidden");
  document.body.classList.remove("fall-safety-open");
  const homeButton = document.querySelector("[data-patient-dashboard]");
  if (homeButton instanceof HTMLElement) {
    homeButton.click();
  } else if (fallSafetyPreviousFocus instanceof HTMLElement) {
    fallSafetyPreviousFocus.focus({ preventScroll: true });
  }
  fallSafetyPreviousFocus = null;
  activeFallEvent = null;
  activeFallAlertPromise = null;
  fallSafetyClarificationMode = "";
}

function processFallMonitoring(landmarks, timestampMs) {
  if (safetyCheckActive || calibrationSession || handPreviewMode) return null;
  const event = fallMonitor.update({ landmarks, timestampMs });
  if (event.type === "candidate") {
    statusEl.textContent = "Checking an unexpected movement…";
  } else if (event.type === "possible_fall" && !event.repeated) {
    beginFallSafetyCheck(event);
  }
  return event;
}

const PRACTICE_GATE_COPY = Object.freeze({
  checking_account: {
    title: "Checking your account…",
    message: "We’re confirming your role and exercise pathway.",
  },
  checking_patient_profile: {
    title: "Checking your patient profile…",
    message: "Your live guide will open when your profile is available.",
  },
  loading_prescriptions: {
    title: "Loading your prescribed movements…",
    message: "Only exercises in your current clinician plan will be available.",
  },
  plan_required: {
    title: "Create your exercise plan first.",
    message:
      "Return to My home and create your plan before opening the live guide.",
    actionLabel: "Create exercise plan",
  },
  awaiting_prescription: {
    title: "Your clinician-guided programme is not ready yet.",
    message:
      "You are linked for rehabilitation, but the live guide will remain locked until an active exercise prescription is assigned.",
    actionLabel: "View clinician connection",
  },
});

async function ensureMovementModels(
  exercise = engine.exercise,
  { handPreview = false } = {},
) {
  const trackingMode = handPreview
    ? TRACKING_MODES.HAND
    : exercise?.trackingMode ?? TRACKING_MODES.POSE;
  const needsPose = trackingMode !== TRACKING_MODES.HAND;
  const needsHand = [TRACKING_MODES.HAND, TRACKING_MODES.POSE_AND_HAND]
    .includes(trackingMode);
  const loaders = [];
  if (needsPose && !poseLandmarker) loaders.push(createPoseLandmarker());
  if (needsHand && !handLandmarker) loaders.push(createHandLandmarker());
  if (!loaders.length) return true;

  statusEl.textContent = needsHand
    ? "Preparing the required movement models…"
    : "Preparing the pose movement model…";
  if (!needsHand && !handLandmarker) {
    handModelStatus.textContent = "Loads only when needed";
    handModelStatus.classList.remove("is-ready", "is-error");
  }
  try {
    await Promise.all(loaders);
  } catch (error) {
    statusEl.textContent = "Movement model unavailable — check your connection";
    console.error("Movement model initialization failed", error);
  }
  const ready = (!needsPose || Boolean(poseLandmarker))
    && (!needsHand || Boolean(handLandmarker));
  if (ready) statusEl.textContent = "Movement guide ready";
  toggleBtn.disabled = !ready;
  renderPersonalization();
  return ready;
}

function syncPracticeAccess() {
  const identity = currentPracticeIdentity();
  authenticatedRole = identity.role;
  if (identity.role === "patient" && identity.patientProfile) {
    authenticatedPatientProfile = identity.patientProfile;
  }

  practiceDecision = resolvePracticeAccess({
    loggedIn: identity.loggedIn,
    role: identity.role,
    patientProfile: identity.patientProfile,
    activePrescriptionCount: activePrescriptions.size,
    prescriptionsLoaded,
  });

  const showPublic = practiceDecision.view === PRACTICE_VIEWS.PUBLIC;
  const showPatient =
    practiceDecision.view === PRACTICE_VIEWS.PATIENT_WORKSPACE;
  const showClinician = practiceDecision.view === PRACTICE_VIEWS.CLINICIAN;
  const showPatientGate =
    practiceDecision.view === PRACTICE_VIEWS.PATIENT_GATE ||
    practiceDecision.view === PRACTICE_VIEWS.LOADING;

  publicPracticePreview?.classList.toggle("hidden", !showPublic);
  patientPracticeWorkspace?.classList.toggle("hidden", !showPatient);
  clinicianPracticeGate?.classList.toggle("hidden", !showClinician);
  patientPracticeGate?.classList.toggle("hidden", !showPatientGate);

  exSelect.disabled = !showPatient;
  sideSelect.disabled = !showPatient;
  if (!showPatient) {
    toggleBtn.disabled = true;
    openCalibrationBtn.disabled = true;
    handTrackingToggle.disabled = true;
  }

  if (showPatientGate) {
    const copy =
      PRACTICE_GATE_COPY[practiceDecision.reason] ??
      PRACTICE_GATE_COPY.checking_account;
    patientPracticeGateTitle.textContent = copy.title;
    patientPracticeGateMessage.textContent = copy.message;
    patientPracticeGateAction.classList.toggle(
      "hidden",
      !copy.actionLabel || !practiceDecision.action
    );
    if (copy.actionLabel && practiceDecision.action) {
      patientPracticeGateAction.innerHTML =
        `${copy.actionLabel} <span aria-hidden="true">→</span>`;
      patientPracticeGateAction.dataset.open = practiceDecision.action;
    }
  }

  if (showPatient) {
    refreshExerciseAccess();
    // Loading MediaPipe here made every signed-in dashboard tab allocate a
    // second pose/hand model before the user opened the live guide. Besides
    // wasting battery, multiple Safari tabs could overwhelm the graphics
    // process and leave a tab only partially painted. Keep the dashboard
    // lightweight and load the models from the explicit camera action.
    renderPersonalization();
  } else {
    if (running) deactivateCameraGuide();
    discardExerciseSession();
    hidePainCheckin();
  }
}

function hasLivePracticeAccess() {
  const identity = currentPracticeIdentity();
  if (
    !identity.loggedIn ||
    identity.role !== "patient" ||
    practiceDecision.view !== PRACTICE_VIEWS.PATIENT_WORKSPACE
  ) {
    statusEl.textContent = !identity.loggedIn
      ? "Sign in with a patient account to use the camera guide"
      : "The camera guide is not available for this account or pathway";
    return false;
  }
  return true;
}

// Hold-based exercises (stretches, balance holds) are measured in seconds held,
// not repetitions. Rep-based exercises count repetitions. Both cap at their goal.
function isHoldExercise(exercise) {
  return exercise?.category === "stretch" || exercise?.category === "balance";
}

function goalMetric(exercise = engine?.exercise) {
  const dose = activeDose(exercise);
  const reps = Number(dose.reps);
  const hold = dose.holdSeconds ?? exercise?.trackingHoldSeconds ?? 0;
  const isHold = isHoldExercise(exercise);
  const hasReps = Number.isFinite(reps) && reps > 0;
  if (isHold && hold > 0) {
    return { isHold: true, unit: "sec held", perHold: hold, goal: hasReps ? reps * hold : null };
  }
  return { isHold: false, unit: "reps", perHold: 0, goal: hasReps ? reps : null };
}

function currentAcceptedWellnessPlan() {
  const identity = currentPracticeIdentity();
  if (identity.role !== "patient") return null;
  return acceptedWellnessPlan(identity.patientProfile)
    ?? acceptedWellnessPlan(profile);
}

function currentPatientCarePath() {
  return resolvePatientCarePath(
    currentPracticeIdentity().patientProfile,
    profile,
  );
}

function activeDose(exercise = engine?.exercise) {
  if (currentPatientCarePath() === "clinician") {
    const prescription = activePrescriptions.get(exercise?.id);
    if (!prescription) return {};
    return {
      id: prescription.id,
      sets: prescription.sets,
      reps: prescription.reps,
      holdSeconds: prescription.hold_seconds ?? 0,
      daysPerWeek: prescription.days_per_week,
      notes: prescription.notes,
      clinicianName: prescription.clinician_name,
      updatedAt: prescription.updated_at ?? prescription.updatedAt ?? null,
    };
  }

  const wellnessPlan = currentAcceptedWellnessPlan();
  if (wellnessPlan) {
    return wellnessPlanDoseForExercise(wellnessPlan, exercise?.id) ?? {};
  }
  return exercise?.prescription ?? {};
}

function renderCameraRepProgress(
  exercise = engine?.exercise,
  count = null,
  { complete = false } = {}
) {
  if (!cameraRepProgressEl || !exercise) return;
  const metric = goalMetric(exercise);
  if (metric.goal === null) {
    cameraRepProgressEl.classList.add("hidden");
    return;
  }
  const measured = count === null
    ? metric.isHold
      ? Number(engine?.repCount ?? 0) * metric.perHold
      : Number(engine?.repCount ?? 0)
    : Number(count);
  const shown = Math.min(
    metric.goal,
    Math.max(0, Number.isFinite(measured) ? measured : 0)
  );
  cameraRepProgressEl.textContent = metric.isHold
    ? `${shown} of ${metric.goal} seconds`
    : `${shown} of ${metric.goal} repetitions`;
  cameraRepProgressEl.classList.remove("hidden");
  cameraRepProgressEl.classList.toggle("is-complete", complete);
}

// Accumulated per-session stats (reset on each camera start)
const sessionCoachingQuality = new CoachingQualitySession();
const sessionAngleStats = {}; // {angleName: {min, max, sum, count}}
const sessionTrackingStats = {
  totalFrames: 0,
  assessableFrames: 0,
  limitedTrackingFrames: 0,
  missingMeasurements: {},
};
let spokenCoachingCandidate = null;
let activeSpokenMovementCue = null;
let recoveredTrackingSince = null;
let spokenRepCount = 0;
let queuedSpokenRepCount = 0;
const pendingRepAnnouncements = [];
let repAnnouncementActive = false;
let completedSetCount = 0;
let completedSessionReps = 0;
let pendingSetStartCheck = null;
let sessionAllSetsComplete = false;
let lastFeedbackResult = null;
let pendingExerciseCompletionAnnouncement = null;
let exerciseCompletionConfirmationActive = false;
let exerciseCompletionConfirmationGeneration = 0;
let earlyStopPromptActive = false;
let earlyStopPromptGeneration = 0;
let pendingEarlyStopReason = "";
let finalRepReturnPromptedSetKey = "";
let finalRepReturnPendingSetKey = "";

const EARLY_STOP_QUESTION =
  "Can you tell me what made you stop? Is it say pain, tired, dizzy or breathless or exercise difficulty.";
const EARLY_STOP_REASONS = new Set([
  "pain",
  "tired",
  "dizzy",
  "breathless",
  "exercise_difficulty",
  "skipped",
]);

const MOVEMENT_AI_TRANSIENT_LISTENING_ERRORS = new Set([
  "no-match",
  "no-speech",
  "start-failed",
]);
const MOVEMENT_GUIDE_VOICE_GROUP = "movement-guide";
const MOVEMENT_GUIDE_VOLUME = 1;
const MOVEMENT_GUIDE_RATE = 0.98;
const MOVEMENT_GUIDE_PITCH = 1.03;
const MOVEMENT_AI_WAKE_PATTERN =
  /\b(?:(?:hey|hi|okay|ok)\s+)?(?:physio\s+)?(?:guide|guy|guys)\b[\s,:-]*(.*)$/i;

function speakMovementGuide(message, options = {}) {
  const {
    rate = MOVEMENT_GUIDE_RATE,
    pitch = MOVEMENT_GUIDE_PITCH,
    allowGeneratedSpeech = true,
    cacheScope = "generic",
    onUnavailable = () => setMovementAiStatus(
      "error",
      "Natural guide audio is unavailable. Follow the on-screen guidance; movement tracking remains active.",
    ),
    ...speechOptions
  } = options;
  return voiceGuidance.speak(message, {
    ...speechOptions,
    // Keep the guide on one Gemini voice: use prepared audio first, reuse a
    // Gemini clip cached on this device second, and generate it live only when
    // neither exists. Never switch the movement guide to a browser voice.
    preferPrepared: true,
    allowGeneratedSpeech,
    cacheScope,
    textOnlyOnUnavailable: true,
    onUnavailable,
    voiceGroup: MOVEMENT_GUIDE_VOICE_GROUP,
    volume: MOVEMENT_GUIDE_VOLUME,
    rate,
    pitch,
  });
}

function localizedGuidanceParts(parts) {
  return parts
    .map((part) => String(part ?? "").trim())
    .filter(Boolean)
    .map((part) => translateText(part))
    .join(" ");
}

function setTranslatableTextParts(element, parts) {
  const textParts = parts
    .map((part) => String(part ?? "").trim())
    .filter(Boolean);
  element.replaceChildren(
    ...textParts.map((part, index) =>
      document.createTextNode(`${index ? " " : ""}${part}`)
    )
  );
}

function movementAiConversationActive() {
  return ["question", "thinking", "speaking"].includes(movementAiState);
}

function setMovementAiStatus(state, message, { hide = false } = {}) {
  if (!movementAiStatusEl) return;
  movementAiStatusEl.dataset.state = state;
  movementAiStatusEl.textContent = message;
  movementAiStatusEl.classList.toggle("hidden", hide);
}

const GUIDE_AUDIO_SOURCE_LABELS = Object.freeze({
  prepared_guide_audio: "Prepared audio",
  device_audio_cache: "Device cache",
  live_gemini: "Live Gemini",
  gemini_tts: "Live Gemini",
  browser_speech: "Device voice",
  text_only: "Text only",
});

window.addEventListener("physiovision:guide-audio-source", (event) => {
  if (!guideAudioSourceEl || !guideAudioSourceValueEl) return;
  const source = String(event.detail?.source ?? "text_only");
  guideAudioSourceEl.dataset.source = source;
  guideAudioSourceValueEl.textContent =
    translateText(GUIDE_AUDIO_SOURCE_LABELS[source] ?? "Text only");
});

function clearMovementAiRestartTimer() {
  if (movementAiRestartTimer === null) return;
  window.clearTimeout(movementAiRestartTimer);
  movementAiRestartTimer = null;
}

function movementAiCanListen(generation = movementAiGeneration) {
  return Boolean(
    generation === movementAiGeneration
    && running
    && handsFreeVoiceEnabled
    && voiceGuidance.enabled
    && voiceGuidance.canListen
    && !safetyCheckActive
    && !calibrationSession
    && !painCheckinState
  );
}

function stopMovementAiGuide({ hide = true } = {}) {
  movementAiGeneration += 1;
  movementCoachingGeneration += 1;
  movementAiState = "off";
  clearMovementAiRestartTimer();
  voiceGuidance.cancelListening();
  setMovementAiStatus(
    "off",
    "AI voice questions start with the camera guide.",
    { hide }
  );
}

function parseMovementAiWakePhrase(transcript, alternatives = []) {
  const candidates = [transcript, ...alternatives]
    .map((value) => String(value ?? "").trim())
    .filter(Boolean);
  let wakeOnlyMatch = null;
  for (const candidate of candidates) {
    const match = candidate.match(MOVEMENT_AI_WAKE_PATTERN);
    if (match) {
      const result = {
        matched: true,
        question: String(match[1] ?? "").trim(),
      };
      if (result.question) return result;
      wakeOnlyMatch = result;
    }
  }
  return wakeOnlyMatch ?? { matched: false, question: "" };
}

function currentMovementAiContext() {
  const feedback = lastFeedbackResult;
  const currentReps = Number(feedback?.repCount ?? engine.repCount ?? 0);
  return {
    source: "camera_guide",
    exercise_id: String(engine.exercise?.id ?? ""),
    exercise_name: String(engine.exercise?.name ?? ""),
    selected_side: String(sideSelect.value ?? ""),
    phase: String(feedback?.phase ?? engine.phase ?? ""),
    rep_count: completedSessionReps + (Number.isFinite(currentReps) ? currentReps : 0),
    set_number: completedSetCount + 1,
    tracking_ready: Boolean(feedback?.trackingReady),
    current_cues: Array.isArray(feedback?.cueDetails)
      ? feedback.cueDetails
        .filter((cue) => cue.scoringEligible === true)
        .slice(0, 3)
        .map((cue) => cue.message)
      : [],
    session_active: Boolean(exerciseSessionActive),
    camera_running: Boolean(running),
  };
}

function scheduleMovementAiWakeListening(
  delayMs = 100,
  generation = movementAiGeneration
) {
  clearMovementAiRestartTimer();
  if (!movementAiCanListen(generation)) return;
  movementAiState = "wake";
  setMovementAiStatus(
    "wake",
    "AI guide ready — say “Hey Guide” followed by your question."
  );
  movementAiRestartTimer = window.setTimeout(() => {
    movementAiRestartTimer = null;
    startMovementAiWakeListening(generation);
  }, Math.max(0, Number(delayMs) || 0));
}

function resumeMovementAiAfterSpeech(generation) {
  if (!movementAiCanListen(generation)) return;
  // Resuming wake-phrase listening must not erase the last announced rep.
  // Pose history and smoothing also remain intact because camera tracking
  // continues while the user asks a question and hears the answer.
  spokenCoachingCandidate = null;
  scheduleMovementAiWakeListening(100, generation);
}

function speakMovementAiMessage(
  message,
  generation,
  { key, generated = false } = {}
) {
  if (!movementAiCanListen(generation)) return false;
  movementAiState = "speaking";
  const spoken = speakMovementGuide(message, {
    key: key || `movement-ai:${generation}:${Date.now()}`,
    interrupt: true,
    allowGeneratedSpeech: generated,
    cacheScope: generated ? "personal" : "generic",
    onEnd: () => resumeMovementAiAfterSpeech(generation),
  });
  if (!spoken) resumeMovementAiAfterSpeech(generation);
  return spoken;
}

function captureMovementAiQuestion(generation) {
  if (!movementAiCanListen(generation)) return;
  movementAiState = "question";
  setMovementAiStatus("question", "AI guide is listening to your question…");
  const started = voiceGuidance.listen({
    maxNoSpeechRetries: 1,
    interimSilenceMs: 400,
    onStatus: (message) => {
      if (generation === movementAiGeneration && movementAiState === "question") {
        setMovementAiStatus("question", message);
      }
    },
    onResult: (transcript) => {
      void answerMovementAiQuestion(transcript, generation);
    },
    onError: (message) => {
      if (!movementAiCanListen(generation)) return;
      setMovementAiStatus("error", message);
      speakMovementAiMessage(
        "I did not hear a question. Movement guidance will continue.",
        generation,
        {
          key: `movement-ai:no-question:${generation}`,
        }
      );
    },
  });
  if (!started) {
    setMovementAiStatus(
      "error",
      "AI voice questions are unavailable in this browser."
    );
  }
}

function beginMovementAiQuestion(question, generation) {
  if (!movementAiCanListen(generation)) return;
  movementAiState = "question";
  if (question) {
    void answerMovementAiQuestion(question, generation);
    return;
  }

  setMovementAiStatus("question", "Wake phrase heard — preparing to listen…");
  const spoken = speakMovementGuide("I’m listening. What would you like to ask?", {
    key: `movement-ai:prompt:${generation}`,
    interrupt: true,
    onEnd: () => captureMovementAiQuestion(generation),
  });
  if (!spoken) captureMovementAiQuestion(generation);
}

function clearRestResumeVoiceTimer() {
  if (restResumeVoiceTimer === null) return;
  window.clearTimeout(restResumeVoiceTimer);
  restResumeVoiceTimer = null;
}

function stopRestResumeVoiceListening({ cancelListening = true } = {}) {
  restResumeVoiceGeneration += 1;
  clearRestResumeVoiceTimer();
  if (cancelListening) voiceGuidance.cancelListening();
}

function restResumeVoiceCanListen(generation) {
  return Boolean(
    generation === restResumeVoiceGeneration
    && !running
    && exerciseSessionActive
    && handsFreeVoiceEnabled
    && voiceGuidance.enabled
    && voiceGuidance.canListen
    && !safetyCheckActive
    && !calibrationSession
    && !painCheckinState
  );
}

function scheduleRestResumeVoiceListening(
  delayMs = 250,
  generation = restResumeVoiceGeneration
) {
  clearRestResumeVoiceTimer();
  if (!restResumeVoiceCanListen(generation)) return;
  restResumeVoiceTimer = window.setTimeout(() => {
    restResumeVoiceTimer = null;
    startRestResumeVoiceListening(generation);
  }, Math.max(0, Number(delayMs) || 0));
}

function resumeMovementGuideAfterRest(generation) {
  if (!restResumeVoiceCanListen(generation)) return;
  voiceGuidance.cancelListening();
  clearRestResumeVoiceTimer();

  let resumeStarted = false;
  const resumeGuide = () => {
    if (
      resumeStarted
      || generation !== restResumeVoiceGeneration
      || running
      || !exerciseSessionActive
    ) {
      return;
    }
    resumeStarted = true;
    void activateCameraGuide({ announceInstruction: false }).then((started) => {
      if (!started && exerciseSessionActive) {
        cameraSessionHintEl.textContent = translateText(
          "The camera could not resume. Select Resume camera guide to try again."
        );
      }
    });
  };
  const spoken = speakMovementGuide(
    "Okay. Resuming your camera guide. Your repetitions are still saved.",
    {
      key: `movement-rest:resume:${engine.exercise?.id ?? "exercise"}`,
      interrupt: true,
      onEnd: resumeGuide,
    }
  );
  if (!spoken) resumeGuide();
  else {
    window.setTimeout(() => {
      if (!voiceGuidance.isSpeaking) resumeGuide();
    }, 8000);
  }
}

function startRestResumeVoiceListening(generation) {
  if (!restResumeVoiceCanListen(generation)) return;
  setMovementAiStatus(
    "wake",
    "Resting — say “Hey Guide, continue” when you are ready."
  );
  const started = voiceGuidance.listen({
    maxNoSpeechRetries: 1,
    interimSilenceMs: 400,
    onStatus: () => {
      if (restResumeVoiceCanListen(generation)) {
        setMovementAiStatus(
          "wake",
          "Resting — say “Hey Guide, continue” when you are ready."
        );
      }
    },
    onResult: (transcript, alternatives = []) => {
      if (!restResumeVoiceCanListen(generation)) return;
      const wake = parseMovementAiWakePhrase(transcript, alternatives);
      if (wake.matched && isMovementResumeRequest(wake.question)) {
        resumeMovementGuideAfterRest(generation);
        return;
      }
      scheduleRestResumeVoiceListening(250, generation);
    },
    onError: (_message, errorCode) => {
      if (!restResumeVoiceCanListen(generation)) return;
      if (MOVEMENT_AI_TRANSIENT_LISTENING_ERRORS.has(errorCode)) {
        scheduleRestResumeVoiceListening(500, generation);
        return;
      }
      setMovementAiStatus(
        "error",
        "Voice resume is unavailable. Select Resume camera guide when you are ready."
      );
    },
  });
  if (!started && restResumeVoiceCanListen(generation)) {
    setMovementAiStatus(
      "error",
      "Voice resume is unavailable. Select Resume camera guide when you are ready."
    );
  }
}

async function pauseMovementGuideForRest() {
  if (!running || !exerciseSessionActive) return false;

  // Use the exact same pause path as the on-screen Pause camera guide control.
  // That path stops camera processing without resetting the active session or
  // its recognized repetition count.
  deactivateCameraGuide();
  await voiceGuidance.prepareSpeechAfterMicrophoneRelease();
  if (running || !exerciseSessionActive) return true;

  stopRestResumeVoiceListening({ cancelListening: true });
  const generation = restResumeVoiceGeneration;
  const prompt =
    "Your camera guide is paused for a rest. Your recognized repetitions are kept. When you are ready, say Hey Guide, continue, or select Resume camera guide.";
  cameraSessionHintEl.textContent = translateText(prompt);
  let listeningStarted = false;
  const beginListening = () => {
    if (listeningStarted) return;
    listeningStarted = true;
    scheduleRestResumeVoiceListening(100, generation);
  };
  const spoken = speakMovementGuide(
    prompt,
    {
      key: `movement-rest:paused:${engine.exercise?.id ?? "exercise"}`,
      interrupt: true,
      onEnd: beginListening,
    }
  );
  if (!spoken) beginListening();
  else {
    window.setTimeout(() => {
      if (!voiceGuidance.isSpeaking) beginListening();
    }, 12000);
  }
  return true;
}

async function answerMovementAiQuestion(question, generation) {
  const cleanedQuestion = String(question ?? "").trim();
  if (!cleanedQuestion || !movementAiCanListen(generation)) {
    scheduleMovementAiWakeListening(100, generation);
    return;
  }
  if (isMovementRestRequest(cleanedQuestion)) {
    await pauseMovementGuideForRest();
    return;
  }

  movementAiState = "thinking";
  setMovementAiStatus(
    "thinking",
    `AI guide heard: “${cleanedQuestion}” — preparing an answer…`
  );
  const context = currentMovementAiContext();
  const acknowledgement = new Promise((resolve) => {
    const spoken = speakMovementGuide(
      "Let me check.",
      {
        key: `movement-ai:acknowledged:${generation}:${cleanedQuestion}`,
        interrupt: true,
        onEnd: resolve,
      }
    );
    if (!spoken) resolve();
  });
  try {
    const result = await sendAgentMessage(cleanedQuestion, context);
    await acknowledgement;
    if (!movementAiCanListen(generation) || movementAiState !== "thinking") return;
    const reply = String(result?.reply ?? "").trim();
    if (!reply) throw new Error("The AI guide returned an empty answer.");
    setMovementAiStatus("speaking", `AI guide: ${reply}`);
    speakMovementAiMessage(reply, generation, {
      key: `movement-ai:answer:${generation}:${cleanedQuestion}`,
      generated: true,
    });
  } catch (_) {
    await acknowledgement;
    if (!movementAiCanListen(generation)) return;
    setMovementAiStatus(
      "error",
      "The AI guide is temporarily unavailable. Movement coaching will continue."
    );
    speakMovementAiMessage(
      "The AI guide is temporarily unavailable. Movement coaching will continue.",
      generation,
      {
        key: `movement-ai:error:${generation}`,
      }
    );
  }
}

function startMovementAiWakeListening(generation = movementAiGeneration) {
  if (!movementAiCanListen(generation)) return;
  movementAiState = "wake";
  setMovementAiStatus(
    "wake",
    "AI guide ready — say “Hey Guide” followed by your question."
  );
  const started = voiceGuidance.listen({
    maxNoSpeechRetries: 0,
    interimSilenceMs: 350,
    onResult: (transcript, alternatives) => {
      if (!movementAiCanListen(generation)) return;
      const wake = parseMovementAiWakePhrase(transcript, alternatives);
      if (!wake.matched) {
        if (/^\s*(?:hey|hi|okay|ok)\b/i.test(String(transcript ?? ""))) {
          speakMovementAiMessage(
            "I heard you. Say Hey Guide, then ask your question.",
            generation,
            { key: `movement-ai:wake-help:${generation}` }
          );
          return;
        }
        scheduleMovementAiWakeListening(60, generation);
        return;
      }
      beginMovementAiQuestion(wake.question, generation);
    },
    onError: (message, errorCode) => {
      if (!movementAiCanListen(generation)) return;
      if (MOVEMENT_AI_TRANSIENT_LISTENING_ERRORS.has(errorCode)) {
        scheduleMovementAiWakeListening(180, generation);
        return;
      }
      movementAiState = "error";
      setMovementAiStatus("error", `${message} AI questions have stopped.`);
    },
  });
  if (!started) {
    movementAiState = "error";
    setMovementAiStatus(
      "error",
      "AI voice questions are unavailable in this browser."
    );
  }
}

function startMovementAiGuide() {
  stopMovementAiGuide({ hide: false });
  if (!running) return;
  if (!handsFreeVoiceEnabled || !voiceGuidance.enabled) {
    setMovementAiStatus(
      "off",
      "AI voice questions are off in on-screen-button mode."
    );
    return;
  }
  if (!voiceGuidance.canListen) {
    setMovementAiStatus(
      "error",
      "AI voice questions are unavailable in this browser."
    );
    return;
  }
  const generation = ++movementAiGeneration;
  scheduleMovementAiWakeListening(100, generation);
}

function speakCameraCoaching(message, options = {}) {
  const priority = Boolean(options.priority);
  if (
    movementAiConversationActive()
    || (movementAiState === "coaching" && !priority)
  ) {
    return false;
  }
  const speechOptions = { ...options };
  delete speechOptions.priority;
  const onUnavailable = speechOptions.onUnavailable;
  delete speechOptions.onUnavailable;
  let speechUnavailable = false;
  const generation = movementAiGeneration;
  const coachingGeneration = ++movementCoachingGeneration;
  const resumeWakeListener = ["wake", "coaching"].includes(movementAiState)
    && movementAiCanListen(generation);
  if (resumeWakeListener) {
    clearMovementAiRestartTimer();
    movementAiState = "coaching";
    voiceGuidance.cancelListening();
    setMovementAiStatus(
      "coaching",
      "Movement cue speaking — “Hey Guide” listening will resume afterward."
    );
  }

  const originalOnEnd = speechOptions.onEnd;
  const finish = () => {
    if (coachingGeneration !== movementCoachingGeneration) return;
    if (!speechUnavailable) originalOnEnd?.();
    if (resumeWakeListener) resumeMovementAiAfterSpeech(generation);
  };
  const handleUnavailable = () => {
    speechUnavailable = true;
    onUnavailable?.();
    setMovementAiStatus(
      "error",
      "Natural guide audio is unavailable. Follow the on-screen guidance; movement tracking remains active.",
    );
  };
  const speakAtFullVolume = () => {
    if (
      coachingGeneration !== movementCoachingGeneration
      || (resumeWakeListener && (
        generation !== movementAiGeneration
        || !running
        || movementAiState !== "coaching"
      ))
    ) {
      return;
    }
    const spoken = speakMovementGuide(message, {
      ...speechOptions,
      onEnd: finish,
      onUnavailable: handleUnavailable,
    });
    if (!spoken) {
      onUnavailable?.();
      if (resumeWakeListener) resumeMovementAiAfterSpeech(generation);
    }
  };
  if (resumeWakeListener) {
    // The wake listener places Safari in a quieter play-and-record session.
    // Wait for it to release, then force playback mode before every coaching
    // sentence so its first word is as loud as its last.
    void voiceGuidance.prepareSpeechAfterMicrophoneRelease().then(
      speakAtFullVolume,
      speakAtFullVolume
    );
    return true;
  }
  return speakMovementGuide(message, {
    ...speechOptions,
    onEnd: finish,
    onUnavailable: handleUnavailable,
  });
}

function exerciseSpokenInstruction(exercise) {
  const reviewedContent = exerciseContent.get(exercise.id);
  if (reviewedContent?.instruction) {
    return `${exercise.name}. ${reviewedContent.instruction}`;
  }

  const phases = (exercise.stages ?? [])
    .map((stage) => stage.replaceAll("_", " "))
    .join(", then ");
  return [
    `${exercise.name}.`,
    phases ? `Move slowly through ${phases}.` : "",
    exercise.trackingWarning ?? cameraSetupTip(exercise),
  ].filter(Boolean).join(" ");
}

function exerciseStartGuidance(exercise = engine?.exercise) {
  if (exercise?.id === "half-squats") {
    return (
      "Keep both feet flat and keep the chair beside you. Bend both knees and hips slowly "
      + "as if sitting back toward the chair, only as far as comfortable, "
      + "then stand tall to complete one repetition."
    );
  }
  return exerciseSpokenInstruction(exercise);
}

function exerciseTargetGuidance(exercise = engine?.exercise) {
  const metric = goalMetric(exercise);
  if (metric.goal === null) return "";
  if (metric.isHold) {
    return (
      `Your target is ${metric.goal} seconds of tracked hold time. `
      + "I will say when the target has been counted. Keep every required joint visible until then."
    );
  }
  return (
    `Your target is ${metric.goal} repetitions. `
    + `I will say when all ${metric.goal} have been counted. `
    + "Keep your full body visible until then."
  );
}

function resetSpokenCoaching({ preserveRepAnnouncements = false } = {}) {
  spokenCoachingCandidate = null;
  activeSpokenMovementCue = null;
  recoveredTrackingSince = null;
  spokenRepCount = 0;
  queuedSpokenRepCount = 0;
  if (!preserveRepAnnouncements) {
    pendingRepAnnouncements.length = 0;
    repAnnouncementActive = false;
  }
}

function cancelRecoveredTrackingCue(feedback, timestampMs) {
  const recoverableStates = new Set(["tracking", "visibility"]);
  if (!feedback?.trackingReady) {
    recoveredTrackingSince = null;
    return;
  }

  if (recoverableStates.has(spokenCoachingCandidate?.state)) {
    spokenCoachingCandidate = null;
  }
  if (!recoverableStates.has(activeSpokenMovementCue?.state)) {
    recoveredTrackingSince = null;
    return;
  }
  if (recoveredTrackingSince === null) {
    recoveredTrackingSince = timestampMs;
    return;
  }
  // Confirm recovery for several frames so one flickering heel landmark does
  // not repeatedly cut speech in and out.
  if (timestampMs - recoveredTrackingSince < 250) return;

  const generation = activeSpokenMovementCue.movementAiGeneration;
  activeSpokenMovementCue = null;
  recoveredTrackingSince = null;
  movementCoachingGeneration += 1;
  voiceGuidance.cancelSpokenOutput();
  if (movementAiState === "coaching") {
    resumeMovementAiAfterSpeech(generation);
  }
}

function queueSpokenMovementCue(state, cue, timestampMs) {
  if (
    !running
    || calibrationSession
    || movementAiConversationActive()
    || movementAiState === "coaching"
    || !cue
  ) {
    spokenCoachingCandidate = null;
    return;
  }
  if (!["adjust", "range", "tracking", "visibility", "position", "ready"].includes(state)) {
    spokenCoachingCandidate = null;
    return;
  }

  const identity = `${state}:${cue}`;
  if (spokenCoachingCandidate?.identity !== identity) {
    spokenCoachingCandidate = {
      identity,
      state,
      firstSeenAt: timestampMs,
      lastRequestedAt: -Infinity,
    };
    return;
  }

  // A person can pass through the bottom of a squat quickly. Confirm the
  // measured depth over several camera frames, then coach it soon enough for
  // the next repetition rather than waiting for a long static hold.
  const stableForMs = state === "ready"
    ? 2500
    : state === "range"
      ? 250
      : ["tracking", "visibility"].includes(state)
        ? 350
        : 800;
  const repeatAfterMs = state === "adjust" ? 8000 : 8000;
  if (
    timestampMs - spokenCoachingCandidate.firstSeenAt < stableForMs ||
    timestampMs - spokenCoachingCandidate.lastRequestedAt < repeatAfterMs
  ) {
    return;
  }

  const movementAiGenerationAtRequest = movementAiGeneration;
  const spoken = speakCameraCoaching(cue, {
    key: `movement:${engine.exercise.id}:${identity}`,
    cooldownMs: repeatAfterMs,
    onEnd: () => {
      if (activeSpokenMovementCue?.identity === identity) {
        activeSpokenMovementCue = null;
        recoveredTrackingSince = null;
      }
    },
  });
  // Do not start the repeat cooldown while another sentence is occupying
  // Safari's single speech channel. That previously delayed a visibility
  // reminder by another eight seconds after the opening instruction ended.
  if (!spoken) return;
  spokenCoachingCandidate.lastRequestedAt = timestampMs;
  activeSpokenMovementCue = {
    identity,
    state,
    movementAiGeneration: movementAiGenerationAtRequest,
  };
}

function currentCoachingRepetitionNumber(feedback = lastFeedbackResult) {
  const currentSetReps = Number(feedback?.repCount ?? engine?.repCount ?? 0);
  return Math.max(
    1,
    completedSessionReps + (Number.isFinite(currentSetReps) ? currentSetReps : 0) + 1,
  );
}

function deliverPendingQualityReminder(spokenText, feedback) {
  const reminder = sessionCoachingQuality.pending;
  if (!reminder) return false;
  sessionCoachingQuality.markDisplayed(reminder.id);

  const repetitionNumber = currentCoachingRepetitionNumber(feedback);
  const voiceRequired = handsFreeVoiceEnabled && voiceGuidance.enabled;
  if (!voiceRequired) {
    sessionCoachingQuality.confirmDelivery(reminder.id, {
      repetitionNumber,
      spoken: false,
      voiceRequired: false,
    });
    return true;
  }

  // Keep the reminder pending while a rep count, user question, or another
  // sentence owns the audio channel. It cannot affect the score until the
  // reminder has actually finished speaking.
  if (
    repAnnouncementActive
    || pendingRepAnnouncements.length
    || movementAiConversationActive()
    || movementAiState === "coaching"
  ) {
    return false;
  }
  if (!sessionCoachingQuality.markSpeechQueued(reminder.id)) return false;

  const spoken = speakCameraCoaching(spokenText || reminder.cue_text, {
    key: `quality-reminder:${engine.exercise.id}:${reminder.id}`,
    cooldownMs: 0,
    onEnd: () => {
      sessionCoachingQuality.confirmDelivery(reminder.id, {
        repetitionNumber: currentCoachingRepetitionNumber(),
        spoken: true,
        voiceRequired: true,
      });
    },
    onUnavailable: () => sessionCoachingQuality.releaseSpeech(reminder.id),
  });
  if (!spoken) sessionCoachingQuality.releaseSpeech(reminder.id);
  return spoken;
}

function currentPlannedSessionExerciseIds(exerciseId = engine?.exercise?.id) {
  const normalizedExerciseId = String(exerciseId ?? "");
  if (
    normalizedExerciseId
    && activeSessionExerciseIds.includes(normalizedExerciseId)
  ) {
    return activeSessionExerciseIds;
  }
  return wellnessPlanSessionExerciseIds(
    currentAcceptedWellnessPlan(),
    normalizedExerciseId
  );
}

function exerciseCompletionGuidance(exercise = engine?.exercise) {
  const exerciseName = exercise?.name ?? "This exercise";
  const sessionExerciseIds = currentPlannedSessionExerciseIds(exercise?.id);
  const currentIndex = sessionExerciseIds.indexOf(String(exercise?.id ?? ""));
  const nextExercise = currentIndex >= 0
    ? sessionExerciseIds
      .slice(currentIndex + 1)
      .map((exerciseId) => EXERCISES.find((item) => item.id === exerciseId))
      .find(Boolean)
    : null;

  if (nextExercise) {
    return {
      nextExerciseId: nextExercise.id,
      spokenMessage:
        `You’re done with ${exerciseName}. Move on to the next exercise shown on screen.`,
      message: (
        `You’re done with ${exerciseName}. Your next exercise is ${nextExercise.name}. `
        + `Choose Finish exercise and check in, then select ${nextExercise.name}.`
      ),
    };
  }
  return {
    nextExerciseId: null,
    spokenMessage:
      `You’re done with ${exerciseName}. Today’s exercise session is done.`,
    message: (
      `You’re done with ${exerciseName}. There are no more exercises in this `
      + "planned session. Choose Finish exercise and check in. Today’s exercise session is done."
    ),
  };
}

function repAnnouncementMessage({
  repNumber,
  setNumber,
  setGoal,
  isHold,
  isLastPlannedSet,
  completionMessage,
}) {
  if (!setGoal) return `Rep ${repNumber}.`;
  if (isHold) {
    return isLastPlannedSet
      ? `${setGoal} seconds complete. ${completionMessage}`
      : `${setGoal} seconds complete for set ${setNumber}. Return to a comfortable position and rest.`;
  }
  return isLastPlannedSet
    ? `Rep ${repNumber}. ${completionMessage}`
    : `Rep ${repNumber}. Set ${setNumber} is complete. Stand tall and rest before the next set.`;
}

function clearExerciseCompletionConfirmation({
  cancelListening = false,
  hide = true,
} = {}) {
  exerciseCompletionConfirmationGeneration += 1;
  exerciseCompletionConfirmationActive = false;
  if (cancelListening) voiceGuidance.cancelListening();
  if (hide) exerciseCompletionPromptEl?.classList.add("hidden");
}

function declineExerciseCompletionConfirmation() {
  if (!exerciseCompletionConfirmationActive) return;
  clearExerciseCompletionConfirmation({ cancelListening: true });
  const message =
    "Okay. I will leave the exercise open. Choose Finish exercise and check in when you are ready.";
  cameraSessionHintEl.textContent = message;
  statusEl.textContent = "Exercise target reached";
  setMovementAiStatus("off", message, { hide: true });
  speakMovementGuide(message, {
    key: `completion-declined:${engine.exercise.id}`,
    interrupt: true,
  });
}

function listenForExerciseCompletionConfirmation(generation) {
  if (
    !exerciseCompletionConfirmationActive
    || generation !== exerciseCompletionConfirmationGeneration
    || !handsFreeVoiceEnabled
    || !voiceGuidance.canListen
  ) {
    return;
  }
  setMovementAiStatus(
    "question",
    "Waiting for your answer. Say yes or no, or use a button."
  );
  const started = voiceGuidance.listen({
    maxNoSpeechRetries: 1,
    interimSilenceMs: 400,
    onStatus: () => {
      if (
        exerciseCompletionConfirmationActive
        && generation === exerciseCompletionConfirmationGeneration
      ) {
        setMovementAiStatus(
          "question",
          "Waiting for your answer. Say yes or no, or use a button."
        );
      }
    },
    onResult: (transcript) => {
      if (
        !exerciseCompletionConfirmationActive
        || generation !== exerciseCompletionConfirmationGeneration
      ) {
        return;
      }
      const response = parseConfirmationResponse(transcript);
      if (response === "confirm") {
        finishExerciseAndCheckIn({ source: "voice" });
        return;
      }
      if (response === "change") {
        declineExerciseCompletionConfirmation();
        return;
      }
      const retry =
        "Please say yes to finish and start your check-in, or no to leave the exercise open.";
      exerciseCompletionPromptTextEl.textContent = retry;
      setMovementAiStatus("question", retry);
      const spoken = speakMovementGuide(retry, {
        key: `completion-confirmation:retry:${generation}`,
        interrupt: true,
        onEnd: () => listenForExerciseCompletionConfirmation(generation),
      });
      if (!spoken) listenForExerciseCompletionConfirmation(generation);
    },
    onError: () => {
      if (
        !exerciseCompletionConfirmationActive
        || generation !== exerciseCompletionConfirmationGeneration
      ) {
        return;
      }
      const fallback =
        "I could not hear your answer. Say yes or no, or use one of the buttons.";
      exerciseCompletionPromptTextEl.textContent = fallback;
      setMovementAiStatus("error", fallback);
    },
  });
  if (!started) {
    const fallback =
      "Voice input is unavailable. Use a button to finish the exercise or leave it open.";
    exerciseCompletionPromptTextEl.textContent = fallback;
    setMovementAiStatus("error", fallback);
  }
}

function beginExerciseCompletionConfirmation(feedback, completion) {
  clearExerciseCompletionConfirmation({ cancelListening: true, hide: false });
  exerciseCompletionConfirmationActive = true;
  const generation = exerciseCompletionConfirmationGeneration;
  const question = handsFreeVoiceEnabled && voiceGuidance.canListen
    ? "Would you like me to finish this exercise and start your check-in? Say yes or no."
    : "Would you like to finish this exercise and start your check-in? Choose an option below.";
  exerciseCompletionPromptTitleEl.textContent = "Exercise target reached";
  exerciseCompletionPromptTextEl.textContent = question;
  exerciseCompletionPromptEl.classList.remove("hidden");
  cameraSessionHintEl.textContent = question;

  let questionStarted = false;
  const askQuestion = ({ questionAlreadySpoken = false } = {}) => {
    if (
      questionStarted
      || !exerciseCompletionConfirmationActive
      || generation !== exerciseCompletionConfirmationGeneration
      || !handsFreeVoiceEnabled
      || !voiceGuidance.canListen
    ) {
      return;
    }
    questionStarted = true;
    let listeningStarted = false;
    const beginListening = () => {
      if (listeningStarted) return;
      listeningStarted = true;
      listenForExerciseCompletionConfirmation(generation);
    };
    if (questionAlreadySpoken) {
      beginListening();
      return;
    }
    const spoken = speakMovementGuide(question, {
      key: `completion-confirmation:question:${feedback.exercise.id}`,
      interrupt: true,
      onEnd: beginListening,
    });
    if (!spoken) beginListening();
    else {
      // Safari can occasionally omit SpeechSynthesis's end event. Do not let
      // that leave the confirmation visibly waiting but unable to hear "yes".
      window.setTimeout(() => {
        if (!voiceGuidance.isSpeaking) beginListening();
      }, 9000);
    }
  };
  const metric = goalMetric(feedback.exercise);
  const finalCountAnnouncement = metric.isHold
    ? `${metric.goal} seconds complete.`
    : `Rep ${feedback.repCount}.`;
  if (
    !completion.nextExerciseId
    && handsFreeVoiceEnabled
    && voiceGuidance.canListen
  ) {
    // A one-exercise session uses one prepared clip for the final count,
    // completion notice and hands-free finish question. This keeps the full
    // presentation journey inside the free TTS request allowance without
    // removing any information the user needs.
    const combinedAnnouncement = localizedGuidanceParts([
      finalCountAnnouncement,
      completion.spokenMessage,
      question,
    ]);
    const finishCombinedAnnouncement = () => {
      spokenRepCount = Math.max(spokenRepCount, feedback.repCount);
      askQuestion({ questionAlreadySpoken: true });
    };
    const spoken = speakMovementGuide(combinedAnnouncement, {
      key: `completion:${feedback.exercise.id}:done-and-checkin`,
      interrupt: true,
      onEnd: finishCombinedAnnouncement,
    });
    if (!spoken) finishCombinedAnnouncement();
    else {
      window.setTimeout(() => {
        if (!voiceGuidance.isSpeaking) finishCombinedAnnouncement();
      }, 15000);
    }
    return;
  }
  const finishCompletionAnnouncement = () => {
    spokenRepCount = Math.max(spokenRepCount, feedback.repCount);
    askQuestion();
  };
  let completionAnnouncementStarted = false;
  const announceExerciseComplete = () => {
    if (completionAnnouncementStarted) return;
    completionAnnouncementStarted = true;
    const spoken = speakMovementGuide(completion.spokenMessage, {
      key: `completion:${feedback.exercise.id}:${completion.nextExerciseId ? "next" : "done"}`,
      interrupt: true,
      onEnd: finishCompletionAnnouncement,
    });
    if (!spoken) finishCompletionAnnouncement();
    else {
      window.setTimeout(() => {
        if (!voiceGuidance.isSpeaking) finishCompletionAnnouncement();
      }, 10000);
    }
  };
  const spoken = speakMovementGuide(finalCountAnnouncement, {
    key: `completion-count:${feedback.exercise.id}:${feedback.repCount}`,
    interrupt: true,
    onEnd: announceExerciseComplete,
  });
  if (!spoken) announceExerciseComplete();
  else {
    window.setTimeout(() => {
      if (!voiceGuidance.isSpeaking) announceExerciseComplete();
    }, 6000);
  }
}

function currentSessionDoseProgress(exercise = engine?.exercise) {
  const dose = activeDose(exercise);
  const repetitionsMinimum = minimumRepetitionsPerSet(dose);
  const currentSetReps = sessionAllSetsComplete
    ? 0
    : Math.max(0, Math.floor(Number(engine?.repCount) || 0));
  const currentSetReachedMinimum = Boolean(
    repetitionsMinimum && currentSetReps >= repetitionsMinimum
  );
  const setsTarget = plannedSetCount(exercise);
  const setsCompleted = Math.min(
    setsTarget,
    completedSetCount + (currentSetReachedMinimum ? 1 : 0),
  );
  return {
    currentSetReps,
    repetitionsCompleted: completedSessionReps + currentSetReps,
    repetitionsMinimum,
    setsCompleted,
    setsTarget,
    reachedMinimum: Boolean(
      !repetitionsMinimum
      || sessionAllSetsComplete
      || setsCompleted >= setsTarget
    ),
  };
}

function shouldAskEarlyStopReason() {
  if (!exerciseSessionActive || goalMetric(engine.exercise).isHold) return false;
  const progress = currentSessionDoseProgress();
  return Boolean(progress.repetitionsMinimum && !progress.reachedMinimum);
}

function clearEarlyStopPrompt({ cancelListening = false } = {}) {
  earlyStopPromptGeneration += 1;
  earlyStopPromptActive = false;
  if (cancelListening) voiceGuidance.cancelListening();
  earlyStopPromptEl?.classList.add("hidden");
  earlyStopQuestionEl?.classList.remove("hidden");
  earlyStopSafetyEl?.classList.add("hidden");
  if (earlyStopPromptTextEl) earlyStopPromptTextEl.textContent = EARLY_STOP_QUESTION;
  if (earlyStopVoiceStatusEl) earlyStopVoiceStatusEl.textContent = "";
}

function listenForEarlyStopReason(generation) {
  if (
    !earlyStopPromptActive
    || generation !== earlyStopPromptGeneration
    || !handsFreeVoiceEnabled
    || !voiceGuidance.canListen
  ) {
    return;
  }
  earlyStopVoiceStatusEl.textContent =
    "Listening for pain, tired, dizzy, breathless, or exercise difficulty.";
  const started = voiceGuidance.listen({
    maxNoSpeechRetries: 1,
    interimSilenceMs: 400,
    onStatus: (message) => {
      if (
        earlyStopPromptActive
        && generation === earlyStopPromptGeneration
      ) {
        earlyStopVoiceStatusEl.textContent = message;
      }
    },
    onResult: (transcript) => {
      if (
        !earlyStopPromptActive
        || generation !== earlyStopPromptGeneration
      ) {
        return;
      }
      const reason = parseEarlyStopReason(transcript);
      if (reason) {
        acceptEarlyStopReason(reason);
        return;
      }
      const retry =
        "I could not match that answer. Say pain, tired, dizzy, breathless, or exercise difficulty, or use a button.";
      earlyStopVoiceStatusEl.textContent = retry;
      const spoken = speakMovementGuide(retry, {
        key: `early-stop:retry:${generation}`,
        interrupt: true,
        onEnd: () => listenForEarlyStopReason(generation),
      });
      if (!spoken) listenForEarlyStopReason(generation);
    },
    onError: () => {
      if (
        earlyStopPromptActive
        && generation === earlyStopPromptGeneration
      ) {
        earlyStopVoiceStatusEl.textContent =
          "I could not hear an answer. Please use one of the buttons, or skip this question.";
      }
    },
  });
  if (!started) {
    earlyStopVoiceStatusEl.textContent =
      "Voice input is unavailable. Please use one of the buttons, or skip this question.";
  }
}

function beginEarlyStopReasonPrompt() {
  if (!exerciseSessionActive || earlyStopPromptActive) return false;
  clearExerciseCompletionConfirmation({ cancelListening: true });
  if (running) {
    deactivateCameraGuide({
      statusMessage: "Exercise stopped before the minimum repetitions",
    });
  }
  earlyStopPromptGeneration += 1;
  const generation = earlyStopPromptGeneration;
  earlyStopPromptActive = true;
  pendingEarlyStopReason = "";
  earlyStopQuestionEl.classList.remove("hidden");
  earlyStopSafetyEl.classList.add("hidden");
  earlyStopPromptTextEl.textContent = EARLY_STOP_QUESTION;
  earlyStopPromptEl.classList.remove("hidden");
  finishExerciseBtn.disabled = true;
  statusEl.textContent = "Exercise stopped before the minimum repetitions";
  cameraSessionHintEl.textContent =
    "The camera is off and your recognized repetitions are kept. Choose a reason or skip this question.";
  setFeedbackBanner("tracking", "Exercise stopped. The guide will not resume automatically.");

  const firstReasonButton = earlyStopReasonChoicesEl?.querySelector("button");
  window.requestAnimationFrame(() => {
    earlyStopPromptEl?.scrollIntoView({ behavior: "auto", block: "nearest" });
    if (!handsFreeVoiceEnabled) firstReasonButton?.focus({ preventScroll: true });
  });

  if (handsFreeVoiceEnabled && voiceGuidance.canListen) {
    earlyStopVoiceStatusEl.textContent =
      "Listening will start after the question.";
    const spoken = speakMovementGuide(EARLY_STOP_QUESTION, {
      key: `early-stop:question:${engine.exercise?.id ?? "exercise"}`,
      interrupt: true,
      onEnd: () => listenForEarlyStopReason(generation),
    });
    if (!spoken) listenForEarlyStopReason(generation);
  } else {
    earlyStopVoiceStatusEl.textContent =
      "Choose the answer that best fits, or skip this question.";
  }
  return true;
}

function renderEarlyStopSafetyOutcome(reason) {
  const isBreathless = reason === "breathless";
  const heading = isBreathless
    ? "Stop exercising and rest somewhere safe"
    : "Stop exercising and sit or lie somewhere safe";
  const message = isBreathless
    ? (
      "Do not continue this exercise. If the breathing difficulty is unusual, severe, worsening, or not improving with rest, get urgent help."
    )
    : (
      "Do not continue this exercise. If the dizziness is severe, worsening, causes fainting, or does not improve with rest, get urgent help."
    );
  const help =
    "Call 995 now for severe breathing difficulty, chest pressure or pain, fainting, sudden weakness or numbness, or if you cannot get to a safe position.";
  earlyStopQuestionEl.classList.add("hidden");
  earlyStopSafetyEl.classList.remove("hidden");
  earlyStopPromptEl.classList.remove("hidden");
  earlyStopSafetyTitleEl.textContent = heading;
  earlyStopSafetyMessageEl.textContent = message;
  earlyStopSafetyHelpEl.textContent = help;
  earlyStopVoiceStatusEl.textContent =
    "The stopped session is saved and flagged for clinician review. This is not real-time monitoring.";
  statusEl.textContent = "Exercise stopped — follow the safety instructions";
  cameraSessionHintEl.textContent =
    "The exercise will not restart. Follow the safety instructions before continuing to the check-in.";
  speakMovementGuide(`${heading}. ${message} ${help}`, {
    key: `early-stop:safety:${reason}`,
    interrupt: true,
  });
  window.requestAnimationFrame(() => {
    earlyStopSafetyEl?.scrollIntoView({ behavior: "auto", block: "nearest" });
    earlyStopContinueBtn?.focus({ preventScroll: true });
  });
}

function acceptEarlyStopReason(reason) {
  if (!earlyStopPromptActive || !EARLY_STOP_REASONS.has(reason)) return false;
  earlyStopPromptActive = false;
  earlyStopPromptGeneration += 1;
  voiceGuidance.cancelListening();
  pendingEarlyStopReason = reason;

  if (reason === "dizzy" || reason === "breathless") {
    const finished = finishExerciseAndCheckIn({
      source: "early-stop",
      stopReason: reason,
      deferCheckin: true,
    });
    if (finished) {
      pendingEarlyStopReason = reason;
      renderEarlyStopSafetyOutcome(reason);
    }
    return finished;
  }

  return finishExerciseAndCheckIn({
    source: "early-stop",
    stopReason: reason,
  });
}

function processPendingRepAnnouncements() {
  if (
    repAnnouncementActive
    || movementTrackingPausedForInstruction
    || movementAiConversationActive()
  ) {
    return;
  }
  if (!pendingRepAnnouncements.length) {
    announcePendingExerciseCompletion();
    return;
  }
  const announcement = pendingRepAnnouncements[0];
  // A rep number has priority. If it interrupts a queued form reminder, return
  // that reminder to the queue; its grace window still has not started.
  if (sessionCoachingQuality.pending?.speech_queued) {
    sessionCoachingQuality.releaseSpeech(sessionCoachingQuality.pending.id);
  }
  const spoken = speakCameraCoaching(
    repAnnouncementMessage(announcement),
    {
      key: `rep:${announcement.exerciseId}:${announcement.setNumber}:${announcement.repNumber}`,
      // Rep numbers take precedence over ordinary form/position coaching. A
      // count spoken during the next movement feels one repetition behind even
      // when the camera recognized it correctly.
      priority: true,
      interrupt: true,
      onEnd: () => {
        const completed = pendingRepAnnouncements.shift();
        if (completed) {
          spokenRepCount = Math.max(spokenRepCount, completed.repNumber);
        }
        repAnnouncementActive = false;
        window.setTimeout(processPendingRepAnnouncements, 100);
      },
    }
  );
  repAnnouncementActive = spoken;
  if (!spoken) {
    pendingRepAnnouncements.shift();
    repAnnouncementActive = false;
    window.setTimeout(processPendingRepAnnouncements, 0);
  }
}

function announcePendingExerciseCompletion() {
  if (!pendingExerciseCompletionAnnouncement) return false;
  const { feedback, completion } = pendingExerciseCompletionAnnouncement;
  pendingExerciseCompletionAnnouncement = null;
  stopMovementAiGuide();
  beginExerciseCompletionConfirmation(feedback, completion);
  return true;
}

function queueRepAnnouncements(feedback, metric) {
  const detectedReps = Number(feedback?.repCount ?? 0);
  if (!Number.isFinite(detectedReps) || detectedReps < 0) return;
  const setNumber = completedSetCount + 1;
  const plannedSets = plannedSetCount(feedback.exercise);

  if (detectedReps <= queuedSpokenRepCount) {
    processPendingRepAnnouncements();
    return;
  }

  const firstNewRep = queuedSpokenRepCount + 1;
  const isLastPlannedSet = setNumber >= plannedSets;
  for (let repNumber = firstNewRep; repNumber <= detectedReps; repNumber += 1) {
    const measured = metric.isHold
      ? repNumber * metric.perHold
      : repNumber;
    const reachesGoal = metric.goal !== null && measured >= metric.goal;
    if (reachesGoal && isLastPlannedSet) {
      // The final number is part of the completion announcement. Earlier
      // numbers stay queued, so the guide can never jump from 8 straight to 10.
      break;
    }
    pendingRepAnnouncements.push({
      exerciseId: feedback.exercise.id,
      repNumber,
      setNumber,
      setGoal: reachesGoal ? metric.goal : null,
      isHold: metric.isHold,
      isLastPlannedSet,
      completionMessage: "",
    });
  }
  queuedSpokenRepCount = detectedReps;
  processPendingRepAnnouncements();
}

function promptForFinalHalfSquatReturn(feedback, metric) {
  const setNumber = completedSetCount + 1;
  const setKey = `${feedback?.exercise?.id}:${setNumber}`;
  const reachedFinalSquatPosition = Boolean(
    feedback?.exercise?.id === "half-squats"
    && !metric.isHold
    && metric.goal !== null
    && feedback.repCount === metric.goal - 1
    && feedback.phase === feedback.exercise.adaptivePhaseTracking?.targetPhase
    && feedback.expectedNextPhase
      === feedback.exercise.adaptivePhaseTracking?.fromPhase
  );
  if (reachedFinalSquatPosition) finalRepReturnPendingSetKey = setKey;

  if (
    feedback?.exercise?.id !== "half-squats"
    || metric.isHold
    || metric.goal === null
    || feedback.repCount !== metric.goal - 1
    || finalRepReturnPendingSetKey !== setKey
  ) {
    return false;
  }

  const message =
    "Final repetition. Stand tall and hold still until I say the exercise is complete.";
  if (finalRepReturnPromptedSetKey !== setKey) {
    statusEl.textContent = "Final repetition — stand tall and hold still";
    cameraSessionHintEl.textContent = message;
    const spoken = speakCameraCoaching(message, {
      key: `final-return:${setKey}`,
      interrupt: true,
    });
    // A previous rep announcement or AI answer may still be speaking when the
    // final squat is recognized. Keep this cue pending and retry after that
    // speech ends instead of silently losing the reminder.
    if (spoken || !voiceGuidance.enabled) {
      finalRepReturnPromptedSetKey = setKey;
    }
  }
  return true;
}

// ── Hold timer state ──────────────────────────────────────────────────────────
let holdInterval  = null;
let holdRemaining = 0;
let holdTotal     = 0;

// ── Personal calibration state ───────────────────────────────────────────────
const CALIBRATION_CAPTURE_MS = 1200;
const CALIBRATION_POSITION_STABLE_MS = 500;
const CALIBRATION_TARGET_MOVEMENTS = 1;
const CALIBRATION_RETURN_STABLE_MS = 350;
const CALIBRATION_STALL_REMINDER_MS = 5000;
const CALIBRATION_STALL_REPEAT_MS = 12000;
const CALIBRATION_VOICE_GROUP = MOVEMENT_GUIDE_VOICE_GROUP;
// Calibration is a deliberate hold, so accept lower-confidence landmarks than
// live tracking (0.5). This lets occluded side-lying/floor poses (e.g. clamshell,
// where one knee/hip overlaps the other) still measure and cache a personal range.
const CALIBRATION_VISIBILITY_THRESHOLD = 0.3;
const SESSION_POSITION_CAPTURE_MS = 1700;
const SET_POSITION_STABLE_MS = 750;
let calibrationSession = null;
let calibrationDraft = null;

function speakCalibrationGuidance(message, options = {}) {
  return speakMovementGuide(message, {
    ...options,
    voiceGroup: CALIBRATION_VOICE_GROUP,
  });
}

function startHoldTimer(seconds) {
  if (holdInterval) return; // already running
  holdTotal     = seconds;
  holdRemaining = seconds;
  holdInlineEl.classList.add("active");
  holdInlineCountEl.textContent = holdRemaining;
  holdProgressEl.style.width    = "0%";

  holdInterval = setInterval(() => {
    holdRemaining--;
    holdInlineCountEl.textContent = holdRemaining;
    holdProgressEl.style.width    = `${((holdTotal - holdRemaining) / holdTotal) * 100}%`;
    if (holdRemaining <= 0) {
      clearHoldTimer();
      engine.completeHold();
    }
  }, 1000);
}

function clearHoldTimer(resetSeconds) {
  clearInterval(holdInterval);
  holdInterval  = null;
  holdRemaining = 0;
  holdInlineEl.classList.remove("active");
  if (Number.isFinite(resetSeconds)) {
    holdTotal = resetSeconds;
    holdInlineCountEl.textContent = resetSeconds;
    holdProgressEl.style.width = "0%";
  }
}

// ── Exercise selector ─────────────────────────────────────────────────────────

EXERCISES.forEach((ex) => {
  const opt = document.createElement("option");
  opt.value = ex.id;
  opt.textContent = ex.comingSoon
    ? `${ex.name} · coming soon`
    : ex.requiresClinicianPlan
      ? `${ex.name} · clinician plan`
      : ex.name;
  if (ex.comingSoon) opt.disabled = true;
  exSelect.appendChild(opt);
});

function refreshExerciseAccess() {
  const wellnessPlan = currentAcceptedWellnessPlan();
  const plannedWellnessExercises = new Set(
    wellnessPlanExerciseIds(wellnessPlan)
  );
  EXERCISES.forEach((exercise) => {
    const option = [...exSelect.options].find((item) => item.value === exercise.id);
    if (!option) return;
    if (currentPatientCarePath() === "clinician") {
      option.disabled = !activePrescriptions.has(exercise.id);
    } else if (currentPatientCarePath() === "needs_review") {
      option.disabled = true;
    } else {
      option.disabled = Boolean(
        exercise.comingSoon
        || exercise.requiresClinicianPlan
        || (wellnessPlan && !plannedWellnessExercises.has(exercise.id))
      );
    }
  });
}

function firstAccessibleExercise() {
  return EXERCISES.find((exercise) => {
    const option = [...exSelect.options].find(
      (candidate) => candidate.value === exercise.id
    );
    return option && !option.disabled;
  });
}

function renderLiveSessionContext(exerciseId = engine?.exercise?.id) {
  const normalizedExerciseId = String(exerciseId ?? "");
  const sessionExerciseIds = activeSessionExerciseIds.length
    ? activeSessionExerciseIds
    : normalizedExerciseId
      ? [normalizedExerciseId]
      : [];
  const selectedIndex = sessionExerciseIds.indexOf(normalizedExerciseId);
  const currentPosition = selectedIndex >= 0 ? selectedIndex + 1 : 1;
  const totalExercises = Math.max(1, sessionExerciseIds.length);

  if (liveSessionDayEl) {
    liveSessionDayEl.textContent = activeSessionDay
      ? `${translateText(activeSessionDay)} ${translateText("session")}`
      : translateText("Current session");
  }
  if (liveSessionProgressEl) {
    liveSessionProgressEl.textContent = translateText(
      `Exercise ${currentPosition} of ${totalExercises}`
    );
  }
  if (liveSessionFocusEl) {
    liveSessionFocusEl.textContent = activeSessionTitle
      ? `${translateText("Session focus")}: ${translateText(activeSessionTitle)}`
      : "";
    liveSessionFocusEl.classList.toggle("hidden", !activeSessionTitle);
  }
}

refreshExerciseAccess();

sideSelect.value = profile.focusSide;
const initialExercise = firstAccessibleExercise() ?? EXERCISES[0];
exSelect.value = initialExercise.id;
let engine = new FeedbackEngine(
  initialExercise.id,
  profile.focusSide,
  getCalibration(initialExercise.id, profile.focusSide)
);
renderPrescription(engine.exercise);
renderTrackingWarning(engine.exercise);
renderPoseStrip(engine.exercise, engine.stages[0]);
renderStaticPhaseFlow(engine);
renderPersonalization();
renderExerciseImage(engine.exercise);
configureFallMonitoring(engine.exercise);
renderLiveSessionContext(engine.exercise.id);

exSelect.addEventListener("change", () => {
  const carriedPainBaseline = (
    exerciseTransitionPainBaseline?.exerciseId === String(exSelect.value)
  )
    ? exerciseTransitionPainBaseline
    : null;
  exerciseTransitionPainBaseline = null;
  cancelCameraSetupCountdown({ announce: false });
  if (running) {
    deactivateCameraGuide({
      statusMessage: "Camera paused because the exercise changed",
    });
  }
  preExerciseCheckinCompleted = Boolean(carriedPainBaseline);
  confirmedPreExercisePain = carriedPainBaseline?.painLevel ?? null;
  if (carriedPainBaseline) {
    activePreExerciseCheckinPromise = postPainCheckin({
      pain_level: carriedPainBaseline.painLevel,
      timing: "before",
      recovery_status: "",
      checked_at: new Date().toISOString(),
    }).catch(() => null);
    completedExerciseSessionPromise = null;
    completedExerciseSessionSnapshot = null;
    completedExerciseSessionError = null;
    completedExerciseCheckinLinkError = false;
  }
  clearRecordedPain();
  discardExerciseSession();
  cancelCalibration();
  engine.changeExercise(
    exSelect.value,
    sideSelect.value,
    getCalibration(exSelect.value, sideSelect.value)
  );
  smoother.state = {};
  repTrackingSmoother.state = {};
  combinedPoseHistory = [];
  clearHoldTimer(activeDose(engine.exercise).holdSeconds);
  holdTimerSection.classList.add("hidden");
  progressSection.classList.remove("hidden");
  renderPrescription(engine.exercise);
  renderTrackingWarning(engine.exercise);
  renderPoseStrip(engine.exercise, engine.stages[0]);
  renderStaticPhaseFlow(engine);
  renderExerciseImage(engine.exercise);
  repCountEl.textContent = "0";
  renderCameraRepProgress(engine.exercise, 0);
  resetSpokenCoaching();
  cueListEl.innerHTML = "";
  symWarnEl.classList.add("hidden");
  progressEl.style.width = "0%";
  progressLbl.textContent = "Position yourself to start";
  setFeedbackBanner("ready");
  renderPersonalization();
  configureFallMonitoring(engine.exercise);
  renderLiveSessionContext(engine.exercise.id);
});

sideSelect.addEventListener("change", () => {
  cancelCameraSetupCountdown({ announce: false });
  if (running) {
    deactivateCameraGuide({
      statusMessage: "Camera paused because the focus side changed",
    });
  }
  preExerciseCheckinCompleted = false;
  confirmedPreExercisePain = null;
  clearRecordedPain();
  discardExerciseSession();
  cancelCalibration();
  engine.changeExercise(
    exSelect.value,
    sideSelect.value,
    getCalibration(exSelect.value, sideSelect.value)
  );
  smoother.state = {};
  repTrackingSmoother.state = {};
  combinedPoseHistory = [];
  repCountEl.textContent = "0";
  renderCameraRepProgress(engine.exercise, 0);
  resetSpokenCoaching();
  progressEl.style.width = "0%";
  setFeedbackBanner("ready");
  renderPersonalization();
  configureFallMonitoring(engine.exercise);
});

window.addEventListener("physiovision:profile-updated", (event) => {
  cancelCalibration();
  preExerciseCheckinCompleted = false;
  confirmedPreExercisePain = null;
  clearRecordedPain();
  profile = event.detail;
  if (authenticatedRole === "patient") {
    authenticatedPatientProfile = event.detail;
  }
  if (practiceIdentityOverride?.role === "patient") {
    practiceIdentityOverride = {
      ...practiceIdentityOverride,
      profile: {
        ...(practiceIdentityOverride.profile ?? {}),
        ...event.detail,
      },
    };
  }
  refreshExerciseAccess();
  syncPracticeAccess();
  if (exSelect.selectedOptions[0]?.disabled) {
    const accessible = firstAccessibleExercise();
    if (accessible) {
      exSelect.value = accessible.id;
      exSelect.dispatchEvent(new Event("change", { bubbles: true }));
    }
    return;
  }
  sideSelect.value = profile.focusSide;
  engine.changeExercise(
    exSelect.value,
    sideSelect.value,
    getCalibration(exSelect.value, sideSelect.value)
  );
  smoother.state = {};
  repTrackingSmoother.state = {};
  repCountEl.textContent = "0";
  renderCameraRepProgress(engine.exercise, 0);
  renderPrescription(engine.exercise);
  resetSpokenCoaching();
  progressEl.style.width = "0%";
  setFeedbackBanner("ready");
  renderPersonalization();
  configureFallMonitoring(engine.exercise);
});

function handlePracticeRequest(detail = {}) {
  const authState = window.physioVisionAuthState ?? null;
  const requestedRole =
    detail.role ?? authState?.role ?? authenticatedRole ?? null;
  const requestedProfile =
    detail.profile ??
    (requestedRole === "patient"
      ? authState?.user?.profile ?? authenticatedPatientProfile ?? null
      : null);
  activeSessionExerciseIds = [...new Set(
    (Array.isArray(detail.plannedExerciseIds)
      ? detail.plannedExerciseIds
      : [])
      .map((item) => String(item))
      .filter(Boolean)
  )];
  activeSessionDay = String(detail.sessionDay ?? "").trim();
  activeSessionTitle = String(detail.sessionTitle ?? "").trim();
  activeSessionKey = String(detail.sessionKey ?? "").trim();
  activeSessionCompletedExerciseIds = new Set(
    (Array.isArray(detail.completedExerciseIds)
      ? detail.completedExerciseIds
      : [])
      .map((item) => String(item))
      .filter(Boolean)
  );
  exerciseTransitionPainBaseline = null;

  practiceIdentityOverride = requestedRole
    ? {
        role: requestedRole,
        profile: requestedRole === "patient" ? requestedProfile : null,
      }
    : null;

  if (requestedRole) {
    authenticatedRole = requestedRole;
  }

  if (requestedRole === "patient" && requestedProfile) {
    profile = { ...profile, ...requestedProfile };
    authenticatedPatientProfile = profile;
  }

  if (window.physioVisionPendingPracticeRequest === detail) {
    window.physioVisionPendingPracticeRequest = null;
  }

  syncPracticeAccess();
  renderLiveSessionContext(detail.exerciseId ?? engine?.exercise?.id);
}

window.physioVisionOpenPractice = handlePracticeRequest;

window.addEventListener("physiovision:practice-requested", (event) => {
  handlePracticeRequest(event.detail);
});

const pendingPracticeRequest = window.physioVisionPendingPracticeRequest;
if (pendingPracticeRequest) {
  handlePracticeRequest(pendingPracticeRequest);
}

window.addEventListener("physiovision:language-change", () => {
  renderLiveSessionContext(engine?.exercise?.id);
});

window.addEventListener("physiovision:prescriptions-updated", (event) => {
  preExerciseCheckinCompleted = false;
  confirmedPreExercisePain = null;
  clearRecordedPain();
  const prescriptions = Array.isArray(event.detail) ? event.detail : [];
  window.sessionStorage.setItem(
    "physiovision.prescriptions.v1",
    JSON.stringify(prescriptions)
  );
  activePrescriptions = loadActivePrescriptions();
  prescriptionsLoaded = true;
  refreshExerciseAccess();
  syncPracticeAccess();

  const selectedOption = exSelect.selectedOptions[0];
  const accessible = firstAccessibleExercise();
  if ((!selectedOption || selectedOption.disabled) && accessible) {
    exSelect.value = accessible.id;
    exSelect.dispatchEvent(new Event("change", { bubbles: true }));
  } else {
    renderPrescription(engine.exercise);
  }
});

window.addEventListener("physiovision:auth-role", (event) => {
  // Signing out and back in happens inside this single page. Clear the prior
  // exercise-session preference so each authenticated session chooses voice
  // or on-screen answers for itself.
  resetVoiceModeChoice();
  preExerciseCheckinCompleted = false;
  confirmedPreExercisePain = null;
  exerciseTransitionPainBaseline = null;
  if (painCheckinState) hidePainCheckin();
  if (running) {
    deactivateCameraGuide({
      statusMessage: "Camera paused because the signed-in account changed",
    });
  }

  const nextRole = event.detail?.role ?? null;
  const stillLoggedIn = Boolean(event.detail?.user) || isLoggedIn();

  // Auth initialization can briefly publish an empty role while the saved
  // session is still being restored. Do not let that temporary event replace
  // the patient identity supplied by the dashboard practice handoff.
  if (nextRole) {
    authenticatedRole = nextRole;
  } else if (!stillLoggedIn) {
    authenticatedRole = null;
  }

  authenticatedPatientProfile =
    authenticatedRole === "patient"
      ? event.detail?.user?.profile ??
        practiceIdentityOverride?.profile ??
        authenticatedPatientProfile ??
        window.physioVisionAuthState?.user?.profile ??
        null
      : null;
  if (
    !stillLoggedIn ||
    (nextRole &&
      practiceIdentityOverride &&
      practiceIdentityOverride.role !== nextRole)
  ) {
    practiceIdentityOverride = null;
  }
  prescriptionsLoaded =
    authenticatedRole !== "patient" ||
    window.sessionStorage.getItem("physiovision.prescriptions.v1") !== null;
  syncPracticeAccess();
});

// ── MediaPipe setup ───────────────────────────────────────────────────────────

async function loadVisionRuntime() {
  if (visionRuntimePromise) return visionRuntimePromise;
  visionRuntimePromise = (async () => {
    const visionTasks = await import(
      "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14"
    );
    ({
      PoseLandmarker,
      HandLandmarker,
      FilesetResolver,
      DrawingUtils,
    } = visionTasks);
    if (!drawingUtils) drawingUtils = new DrawingUtils(ctx);
    return FilesetResolver.forVisionTasks(
      "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm"
    );
  })().catch((error) => {
    visionRuntimePromise = null;
    throw error;
  });
  return visionRuntimePromise;
}

async function createPoseLandmarker() {
  if (poseLandmarker) return poseLandmarker;
  if (poseModelPromise) return poseModelPromise;
  poseModelPromise = (async () => {
    const vision = await loadVisionRuntime();
    const poseOptions = {
      baseOptions: {
        modelAssetPath:
          "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task",
      },
      runningMode: "VIDEO",
      numPoses: 1,
      minPoseDetectionConfidence: 0.5,
      minPosePresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    };
    try {
      poseLandmarker = await PoseLandmarker.createFromOptions(vision, {
        ...poseOptions,
        baseOptions: { ...poseOptions.baseOptions, delegate: "GPU" },
      });
    } catch (gpuError) {
      console.info("GPU pose tracking unavailable; using CPU", gpuError);
      poseLandmarker = await PoseLandmarker.createFromOptions(vision, poseOptions);
    }
    return poseLandmarker;
  })().catch((error) => {
    poseModelPromise = null;
    throw error;
  });
  return poseModelPromise;
}

async function createHandLandmarker() {
  if (handLandmarker) return handLandmarker;
  if (handModelPromise) return handModelPromise;
  handModelStatus.textContent = "Loading required hand model…";
  handModelStatus.classList.remove("is-ready", "is-error");
  handModelPromise = (async () => {
    const vision = await loadVisionRuntime();
    const handOptions = {
      baseOptions: {
        modelAssetPath:
          "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task",
      },
      runningMode: "VIDEO",
      numHands: 2,
      minHandDetectionConfidence: 0.6,
      minHandPresenceConfidence: 0.6,
      minTrackingConfidence: 0.6,
    };
    try {
      handLandmarker = await HandLandmarker.createFromOptions(vision, {
        ...handOptions,
        baseOptions: { ...handOptions.baseOptions, delegate: "GPU" },
      });
    } catch (gpuError) {
      console.info("GPU hand tracking unavailable; using CPU", gpuError);
      handLandmarker = await HandLandmarker.createFromOptions(vision, handOptions);
    }
    handModelStatus.textContent = "Ready";
    handModelStatus.classList.add("is-ready");
    return handLandmarker;
  })().catch((error) => {
    handModelPromise = null;
    console.warn("Hand Landmarker could not be loaded", error);
    handModelStatus.textContent = "Unavailable";
    handModelStatus.classList.add("is-error");
    throw error;
  });
  return handModelPromise;
}

// ── Camera ────────────────────────────────────────────────────────────────────

async function startCamera() {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: {
      width: { ideal: 640, max: 640 },
      height: { ideal: 480, max: 480 },
      frameRate: { ideal: 15, max: 20 },
      // "none" requests raw sensor output — prevents OS-level crop/pan (Center Stage)
      resizeMode: "none",
    },
    audio: false,
  });

  // Try to lock zoom to minimum so Center Stage auto-zoom can't fire
  const track = stream.getVideoTracks()[0];
  const capabilities = track.getCapabilities?.() ?? {};
  if (capabilities.zoom) {
    try {
      await track.applyConstraints({
        advanced: [{ zoom: capabilities.zoom.min }],
      });
    } catch (_) {
      // Device doesn't support zoom constraint — silently ignore
    }
  }

  video.srcObject = stream;
  await video.play();
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
}

function stopCamera() {
  video.srcObject?.getTracks().forEach((t) => t.stop());
  video.srcObject = null;
}

function captureSynchronizedFrame() {
  if (
    synchronizedFrame.width !== video.videoWidth
    || synchronizedFrame.height !== video.videoHeight
  ) {
    synchronizedFrame.width = video.videoWidth;
    synchronizedFrame.height = video.videoHeight;
  }
  synchronizedFrameContext.drawImage(
    video,
    0,
    0,
    synchronizedFrame.width,
    synchronizedFrame.height
  );
  return synchronizedFrame;
}

// ── Render loop ───────────────────────────────────────────────────────────────

let drawingUtils;
let running = false;
let rafId;
let lastVideoTime = -1;
let lastFrameStamp = performance.now();
let lastInferenceStamp = -Infinity;
const CAMERA_INFERENCE_FPS = 15;
const CAMERA_INFERENCE_INTERVAL_MS = 1000 / CAMERA_INFERENCE_FPS;
let handPreviewMode = false;
let combinedPoseHistory = [];

function resetCameraInferenceClock() {
  lastVideoTime = -1;
  lastInferenceStamp = -Infinity;
  lastFrameStamp = performance.now();
}

function handMetric(name) {
  return handTrackingReadout?.querySelector(`[data-hand-metric="${name}"]`);
}

function formatFlexion(joints, names) {
  if (!joints) return "—";
  return names
    .map((name) => {
      const measurement = joints[name];
      return measurement
        && !measurement.lowConfidence
        && Number.isFinite(measurement.value)
        ? `${Math.round(measurement.value)}°`
        : "—";
    })
    .join(" / ");
}

function resetHandReadout() {
  handTrackingReadout?.querySelectorAll("[data-hand-metric]")
    .forEach((element) => { element.textContent = "—"; });
}

function drawHandResult(result) {
  (result?.landmarks ?? []).forEach((landmarks) => {
    drawingUtils.drawConnectors(landmarks, HandLandmarker.HAND_CONNECTIONS, {
      color: "#dff2e6",
      lineWidth: 3,
    });
    drawingUtils.drawLandmarks(landmarks, {
      color: "#76d89b",
      fillColor: "#173f40",
      radius: 4,
    });
  });
}

function drawPoseResult(result) {
  const landmarks = result?.landmarks?.[0];
  if (!landmarks) return;
  drawingUtils.drawLandmarks(landmarks, {
    radius: 4,
    color: (data) =>
      (data?.from?.visibility ?? 1) < VISIBILITY_THRESHOLD
        ? "#f3d77d"
        : "#76d89b",
  });
  drawingUtils.drawConnectors(landmarks, PoseLandmarker.POSE_CONNECTIONS, {
    color: "#dff2e6",
    lineWidth: 3,
  });
}

function rememberCombinedPose(result, timestampMs) {
  const landmarks = result?.landmarks?.[0];
  if (!landmarks) {
    combinedPoseHistory = [];
    return;
  }
  combinedPoseHistory.push({ timestampMs, landmarks });
  combinedPoseHistory = combinedPoseHistory.filter(
    // Long enough for an ankle circle, pendulum swing, gait step, or mobility
    // aid movement while still discarding stale motion from an earlier rep.
    (frame) => timestampMs - frame.timestampMs <= 2500
  );
}

function renderHandPreview(result) {
  drawHandResult(result);

  const hands = summarizeHandResult(result, {
    width: video.videoWidth,
    height: video.videoHeight,
  });
  const hand = selectTrackedHand(hands, profile.focusSide);
  if (!hand) {
    resetHandReadout();
    statusEl.textContent = "Show one complete hand to the camera";
    setFeedbackBanner("position", "Place one open hand inside the close-up guide");
    return;
  }

  const score = hand.handedness.score;
  handMetric("handedness").textContent = score === null
    ? hand.handedness.label
    : `${hand.handedness.label} · ${Math.round(score * 100)}%`;
  handMetric("coverage").textContent = Number.isFinite(hand.framing.pixelSpan)
    ? `${Math.round(hand.framing.normalizedSpan * 100)}% · ${Math.round(hand.framing.pixelSpan)} px`
    : `${Math.round(hand.framing.normalizedSpan * 100)}%`;

  if (hand.framing.ready) {
    const palmDirection = hand.palm?.value?.direction?.replaceAll("_", " ") ?? "—";
    handMetric("palm").textContent = palmDirection;
    handMetric("thumb").textContent = formatFlexion(
      hand.fingerFlexion?.value?.thumb,
      ["cmc", "mcp", "ip"]
    );
    for (const finger of ["index", "middle", "ring", "pinky"]) {
      handMetric(finger).textContent = formatFlexion(
        hand.fingerFlexion?.value?.[finger],
        ["mcp", "pip", "dip"]
      );
    }
    statusEl.textContent = "Hand landmarks are clear";
    setFeedbackBanner("hand-ready");
  } else {
    handMetric("palm").textContent = "Waiting for clear framing";
    ["thumb", "index", "middle", "ring", "pinky"].forEach((finger) => {
      handMetric(finger).textContent = "—";
    });
    const needsCentre = hand.framing.reason === "move_to_centre";
    statusEl.textContent = needsCentre
      ? "Move your whole hand toward the centre"
      : "Move your hand closer to the camera";
    setFeedbackBanner(
      "position",
      needsCentre
        ? "Keep the wrist and every fingertip inside the guide"
        : "Move closer until your hand fills more of the guide"
    );
  }
}

function presentInstructionTrackingPause(measurements, timestampMs) {
  // Repetition exercises use a complete, confirmed phase sequence, so they can
  // safely count while the concise opening instruction is still playing. Hold
  // exercises retain the baseline-only gate because their setup can resemble
  // the target position. Spoken counts wait until the instruction finishes.
  if (!goalMetric(engine.exercise).isHold && measurements) {
    const feedback = updateFeedbackPanel(measurements, timestampMs);
    if (!feedback.trackingReady) {
      // Keep the specific visibility banner produced by updateFeedbackPanel.
      // Replacing it with a generic "counting is active" message hid the
      // missing-heel warning for the entire opening instruction.
      statusEl.textContent = movementTrackingGuidance(feedback);
      return;
    }
    statusEl.textContent =
      "Begin when ready — completed repetitions are already being counted";
    setFeedbackBanner(
      "ready",
      "Move while you listen if you are ready. Camera counting is already active."
    );
    return;
  }

  // Other movements may include setup actions that resemble one of their
  // phases, so retain the baseline-only gate for them.
  if (!engine.startConfirmed && measurements) {
    engine.update(measurements, timestampMs);
  }
  statusEl.textContent = "Listen first — rep counting starts after this instruction";
  setFeedbackBanner("ready", "Stay in your starting position. I will tell you when rep counting begins.");
}

function renderFrame() {
  if (!running) return;
  if (safetyCheckActive) {
    rafId = requestAnimationFrame(renderFrame);
    return;
  }

  const frameTimestamp = performance.now();
  const inferenceDue =
    frameTimestamp - lastInferenceStamp >= CAMERA_INFERENCE_INTERVAL_MS;
  if (video.currentTime !== lastVideoTime && inferenceDue) {
    lastVideoTime = video.currentTime;
    lastInferenceStamp = frameTimestamp;

    ctx.save();
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (handPreviewMode) {
      const result = handLandmarker.detectForVideo(video, frameTimestamp);
      renderHandPreview(result);
    } else {
      const trackingMode = engine.exercise.trackingMode ?? TRACKING_MODES.POSE;
      if (trackingMode === TRACKING_MODES.HAND) {
        const handResult = handLandmarker.detectForVideo(video, frameTimestamp);
        drawHandResult(handResult);
        const measurements = measureHandExerciseFrame({
          handResult,
          exercise: engine.exercise,
          side: sideSelect.value,
          frame: { width: video.videoWidth, height: video.videoHeight },
        });
        if (calibrationSession) {
          updateCalibrationCapture(measurements, frameTimestamp);
          statusEl.textContent = "Personal calibration in progress";
        } else if (movementTrackingPausedForInstruction) {
          presentInstructionTrackingPause(measurements, frameTimestamp);
        } else if (pendingSetStartCheck) {
          updateSetStartingPositionCheck(measurements, frameTimestamp);
        } else {
          const feedback = updateFeedbackPanel(measurements, frameTimestamp);
          statusEl.textContent = feedback.trackingReady
            ? "Tracking the hand-shape sequence"
            : "Keep one complete hand close and fully visible";
        }
      } else if (trackingMode === TRACKING_MODES.POSE_AND_HAND) {
        // Freeze one image so both models receive identical pixels and the same
        // timestamp. Do not combine their world landmarks: cross-model wrist
        // geometry uses normalized image coordinates.
        const frame = captureSynchronizedFrame();
        const poseResult = poseLandmarker.detectForVideo(frame, frameTimestamp);
        const handResult = handLandmarker.detectForVideo(frame, frameTimestamp);
        drawPoseResult(poseResult);
        drawHandResult(handResult);
        rememberCombinedPose(poseResult, frameTimestamp);
        const measurements = measureCombinedExerciseFrame({
          poseResult,
          handResult,
          exercise: engine.exercise,
          side: sideSelect.value,
          frame: { width: video.videoWidth, height: video.videoHeight },
          poseHistory: combinedPoseHistory,
        });
        updateDebugPanel(measurements);
        if (calibrationSession) {
          updateCalibrationCapture(measurements, frameTimestamp);
          statusEl.textContent = "Personal calibration in progress";
        } else if (movementTrackingPausedForInstruction) {
          presentInstructionTrackingPause(measurements, frameTimestamp);
        } else if (pendingSetStartCheck) {
          updateSetStartingPositionCheck(measurements, frameTimestamp);
        } else {
          const feedback = updateFeedbackPanel(measurements, frameTimestamp);
          statusEl.textContent = feedback.trackingReady
            ? "Tracking your elbow, wrist and hand together"
            : "Keep the working elbow and complete hand visible";
        }
      } else {
        const result = poseLandmarker.detectForVideo(video, frameTimestamp);
        if (result.landmarks.length > 0) {
          const landmarks = result.landmarks[0];
          drawPoseResult(result);
          rememberCombinedPose(result, frameTimestamp);

          // Standard angles plus the selected exercise's body-normalised and
          // temporal features. Visibility gates still use image landmarks.
          const raw = measurePoseExerciseFrame({
            poseResult: result,
            exercise: engine.exercise,
            side: sideSelect.value,
            poseHistory: combinedPoseHistory,
            visibilityThreshold: calibrationSession
              ? CALIBRATION_VISIBILITY_THRESHOLD
              : engine.exercise.trackingVisibilityThreshold
                ?? VISIBILITY_THRESHOLD,
          });
          const displayAngles = Object.fromEntries(
            Object.entries(raw).map(([k, a]) => [k, smoother.smooth(k, a)])
          );
          const angles = Object.fromEntries(
            Object.entries(raw).map(([k, a]) => [
              k,
              repTrackingSmoother.smooth(k, a),
            ])
          );

          updateDebugPanel(displayAngles);
          if (calibrationSession) {
            updateCalibrationCapture(displayAngles, frameTimestamp);
            statusEl.textContent = "Personal calibration in progress";
          } else if (movementTrackingPausedForInstruction) {
            presentInstructionTrackingPause(angles, frameTimestamp);
          } else if (pendingSetStartCheck) {
            updateSetStartingPositionCheck(angles, frameTimestamp);
            processFallMonitoring(landmarks, frameTimestamp);
          } else {
            const feedback = updateFeedbackPanel(angles, frameTimestamp);
            statusEl.textContent = !feedback.trackingReady
              ? movementTrackingGuidance(feedback)
              : feedback.limitedTracking
                ? `Tracking reps from your ${feedback.trackingSide} side`
                : "Tracking your movement";
            processFallMonitoring(landmarks, frameTimestamp);
          }
        } else {
          if (
            !calibrationSession
            && !pendingSetStartCheck
            && !movementTrackingPausedForInstruction
          ) {
            // An absent pose is an unassessable movement frame. Feed it to the
            // engine so phase confirmation pauses and an out-of-frame partial
            // movement cannot be completed as a repetition after reappearing.
            updateFeedbackPanel({}, frameTimestamp);
          } else {
            engine.update({}, frameTimestamp);
          }
          const fallEvent = fallMonitor.notePoseUnavailable(frameTimestamp);
          combinedPoseHistory = [];
          updateCalibrationCapture(null, frameTimestamp);
          updateSetStartingPositionCheck(null, frameTimestamp);
          const interruptedHold = engine.inHold;
          if (holdInterval) {
            clearHoldTimer(activeDose(engine.exercise).holdSeconds);
          }
          statusEl.textContent = fallEvent.type === "visibility_lost"
            ? "Movement paused — I can’t see you. Return to the marked area"
            : "Movement paused — step back so your full body is visible";
          setFeedbackBanner(
            "visibility",
            interruptedHold
              ? "Pause your movement. Your hold was reset because the required joints were no longer visible. Reposition, then restart the hold."
              : "Pause your movement. Step back until your full body and required joints are visible."
          );
          queueSpokenMovementCue(
            "visibility",
            interruptedHold
              ? "Pause your movement. Your hold was reset because tracking was lost. Reposition until your full body is visible, then restart the hold."
              : fallEvent.type === "visibility_lost"
                ? "Pause your movement. I can’t see you. Please return to the marked area."
                : "Pause your movement. Step back and keep your full body and required joints visible.",
            frameTimestamp
          );
        }
      }
    }

    ctx.restore();

    fpsEl.textContent = (1000 / (frameTimestamp - lastFrameStamp)).toFixed(0);
    lastFrameStamp = frameTimestamp;
  }

  rafId = requestAnimationFrame(renderFrame);
}

// ── Panel updates ─────────────────────────────────────────────────────────────

const angleDebugEl = document.getElementById("angleDebug");

function plannedSetCount(exercise = engine?.exercise) {
  const sets = Number(activeDose(exercise).sets);
  return Number.isFinite(sets) && sets > 0 ? Math.floor(sets) : 1;
}

function updateSetStartingPositionCheck(measurements, timestampMs) {
  if (!pendingSetStartCheck) return false;
  const frame = measurements
    ? extractCalibrationFrame(engine.exercise, measurements, sideSelect.value)
    : null;
  const matchesStart = frame && calibrationFrameMatchesPhase(
    engine.exercise,
    frame,
    "start"
  );

  if (
    !matchesStart ||
    !calibrationFrameIsStable(pendingSetStartCheck.previousFrame, frame)
  ) {
    pendingSetStartCheck.stableSince = null;
    pendingSetStartCheck.previousFrame = frame;
    statusEl.textContent = `Return to the starting position for set ${pendingSetStartCheck.setNumber}`;
    setFeedbackBanner(
      "position",
      `Hold the starting position so set ${pendingSetStartCheck.setNumber} can begin automatically`
    );
    return false;
  }

  pendingSetStartCheck.previousFrame = frame;
  if (pendingSetStartCheck.stableSince === null) {
    pendingSetStartCheck.stableSince = timestampMs;
  }
  if (
    timestampMs - pendingSetStartCheck.stableSince < SET_POSITION_STABLE_MS
  ) {
    statusEl.textContent = "Starting position found — hold still";
    setFeedbackBanner("position", "Hold still for a moment");
    return false;
  }

  const setNumber = pendingSetStartCheck.setNumber;
  pendingSetStartCheck = null;
  statusEl.textContent = `Set ${setNumber} starting position confirmed — begin`;
  setFeedbackBanner("good", `Set ${setNumber} is ready. Begin when comfortable.`);
  speakCameraCoaching(
    `Starting position confirmed. Begin set ${setNumber} when you are comfortable.`,
    {
      key: `set:${engine.exercise.id}:${setNumber}:ready`,
      interrupt: true,
    }
  );
  return true;
}

function handleCompletedSet(feedback) {
  const setNumber = completedSetCount + 1;
  completedSessionReps += feedback.repCount;
  completedSetCount = setNumber;

  if (setNumber >= plannedSetCount(feedback.exercise)) {
    const completion = exerciseCompletionGuidance(feedback.exercise);
    sessionAllSetsComplete = true;
    lastFeedbackResult = feedback;
    queuedSpokenRepCount = Math.max(queuedSpokenRepCount, feedback.repCount);
    renderCameraRepProgress(feedback.exercise, feedback.repCount, {
      complete: true,
    });
    statusEl.textContent = `${feedback.exercise.name} complete`;
    setFeedbackBanner("good", completion.message);
    cameraSessionHintEl.textContent = completion.message;
    // Keep every earlier number in order. The final completion announcement
    // begins as soon as the queued count immediately before it has finished.
    pendingExerciseCompletionAnnouncement = { feedback, completion };
    processPendingRepAnnouncements();
    return;
  }

  engine.changeExercise(
    exSelect.value,
    sideSelect.value,
    getCalibration(exSelect.value, sideSelect.value)
  );
  smoother.state = {};
  repTrackingSmoother.state = {};
  combinedPoseHistory = [];
  if (holdInterval) {
    clearHoldTimer(activeDose(engine.exercise).holdSeconds);
  }
  lastFeedbackResult = null;
  pendingSetStartCheck = {
    setNumber: setNumber + 1,
    stableSince: null,
    previousFrame: null,
  };
  repCountEl.textContent = "0";
  renderCameraRepProgress(feedback.exercise, 0);
  setCompleteBadgeEl?.classList.add("hidden");
  progressEl.style.width = "0%";
  progressLbl.textContent = "Return to your starting position";
  renderPoseStrip(engine.exercise, engine.stages[0]);
  renderStaticPhaseFlow(engine);
  resetSpokenCoaching({ preserveRepAnnouncements: true });
  statusEl.textContent = `Set ${setNumber} complete — checking the next starting position`;
  setFeedbackBanner(
    "position",
    `Return to the starting position for set ${setNumber + 1}`
  );
}

function updateFeedbackPanel(angles, timestampMs) {
  if (sessionAllSetsComplete && lastFeedbackResult) {
    processPendingRepAnnouncements();
    return lastFeedbackResult;
  }
  const fb = engine.update(angles, timestampMs);
  cancelRecoveredTrackingCue(fb, timestampMs);
  if (exerciseSessionActive) {
    sessionTrackingStats.totalFrames += 1;
    if (fb.trackingReady) sessionTrackingStats.assessableFrames += 1;
    if (fb.limitedTracking) sessionTrackingStats.limitedTrackingFrames += 1;
    for (const measurement of fb.missingMeasurements ?? []) {
      sessionTrackingStats.missingMeasurements[measurement] =
        (sessionTrackingStats.missingMeasurements[measurement] ?? 0) + 1;
    }
  }

  // ── Debug logging (remove before release) ────────────────────────────────
  if (window._pvDebug) {
    const relevantKeys = ["kneeSeparation", "ankleSeparation", "workingFootClearance",
      "ankle", "knee", "hip", "torsoLean", "standingKnee"];
    const vals = {};
    for (const k of relevantKeys) {
      const m = angles[k] ?? angles[`${engine.side}${k[0].toUpperCase()}${k.slice(1)}`];
      if (m) vals[k] = m.lowConfidence ? "low-conf" : +m.value.toFixed(3);
    }
    console.log("[PV]", engine.exercise.id,
      "| phase:", fb.phase,
      "| detected:", fb.detectedPhase,
      "| startConfirmed:", fb.startConfirmed,
      "| stageIdx:", fb.stageIndex,
      "| progress:", fb.progress.toFixed(2),
      "| reps:", fb.repCount,
      "| measurements:", vals
    );
  }
  // ─────────────────────────────────────────────────────────────────────────

  // Live angle debug overlay
  if (angleDebugEl) {
    const tracked = Object.entries(engine.exercise.trackedAngles ?? {});
    const lines = tracked.map(([key]) => {
      const side = engine.side;
      const sideKey = `${side}${key[0].toUpperCase()}${key.slice(1)}`;
      const a = angles[key] ?? angles[sideKey];
      if (!a) return `${key}: —`;
      return `${key}: ${a.lowConfidence ? "hidden" : a.value.toFixed(0) + "°"}`;
    });
    angleDebugEl.textContent = lines.join(" | ") + ` | phase: ${fb.phase}`;
  }
  const holdSeconds = fb.exercise.trackingHoldSeconds
    ?? activeDose(fb.exercise).holdSeconds
    ?? 3;

  // Quality is assessed later from the patient's response to a delivered
  // coaching reminder. Raw frame cues and symmetry warnings never lower the
  // score here, which prevents silent, unreliable, and duplicate deductions.
  Object.entries(angles).forEach(([key, a]) => {
    if (a.lowConfidence || !Number.isFinite(a.value)) return;
    const s = sessionAngleStats[key] ?? (sessionAngleStats[key] = { min: Infinity, max: -Infinity, sum: 0, count: 0 });
    s.min = Math.min(s.min, a.value);
    s.max = Math.max(s.max, a.value);
    s.sum += a.value;
    s.count++;
  });

  // Rep / hold-seconds counter — hold exercises show seconds held, and both
  // cap at their goal with a "Set complete" badge once reached.
  const metric = goalMetric(fb.exercise);
  let shown = metric.isHold ? fb.repCount * metric.perHold : fb.repCount;
  const setComplete = metric.goal !== null && shown >= metric.goal;
  if (metric.goal !== null) shown = Math.min(shown, metric.goal);
  repCountEl.textContent = shown;
  renderCameraRepProgress(fb.exercise, shown, { complete: setComplete });
  if (repLabelEl) repLabelEl.textContent = metric.unit;
  if (setCompleteBadgeEl) setCompleteBadgeEl.classList.toggle("hidden", !setComplete);
  queueRepAnnouncements(fb, metric);
  const awaitingFinalHalfSquatReturn = promptForFinalHalfSquatReturn(fb, metric);

  // Highlight active pose card without re-rendering the whole strip
  poseStripEl.querySelectorAll(".pose-card").forEach((card, i) => {
    card.classList.toggle("active", i === fb.stageIndex);
  });

  // Phase flow chips
  phaseFlowEl.innerHTML = fb.stages
    .map((s, i) => {
      // Sequence stages may repeat (for example open hand between every tendon
      // glide shape), so phase name alone cannot identify the active chip.
      const active = i === fb.stageIndex ? " active" : "";
      const arrow =
        i < fb.stages.length - 1
          ? '<span class="phase-arrow">→</span>'
          : "";
      return `<span class="phase-chip${active}">${s}</span>${arrow}`;
    })
    .join("");

  // Hold timer vs progress bar — mutually exclusive
  if (fb.inHold) {
    // Switch to hold timer view
    progressSection.classList.add("hidden");
    holdTimerSection.classList.remove("hidden");
    if (fb.trackingReady && fb.holdPositionMaintained) {
      startHoldTimer(holdSeconds);
    } else if (holdInterval) {
      // Fail safely: an uncertain pose cannot earn hold time. Reset so the
      // complete prescribed duration must be tracked after visibility returns.
      clearHoldTimer(holdSeconds);
    }
  } else {
    // Cancel timer if user broke position — reset inline display to full hold seconds
    if (holdInterval) clearHoldTimer(holdSeconds);
    progressSection.classList.remove("hidden");
    holdTimerSection.classList.add("hidden");

    // Progress bar
    const pct = Math.round(fb.progress * 100);
    progressEl.style.width = `${pct}%`;
    const nextIdx = fb.stageIndex + 1;
    const nextPhase = fb.stages[nextIdx] ?? fb.stages[0];
    progressLbl.textContent =
      pct >= 100
        ? `Get into ${fb.phase} position`
        : `Moving to ${nextPhase}… ${pct}%`;
  }

  // Coaching-first quality: wait for one reliable issue to remain stable before
  // showing it as a scored correction. The two-repetition response window only
  // starts after the reminder is actually delivered below.
  const primaryCueDetail = fb.cueDetails?.[0]
    ?? (fb.cues[0]
      ? { id: fb.cues[0], message: fb.cues[0], qualityReliable: true }
      : null);
  // Validated feedback wording is versioned evidence and must be delivered
  // exactly as approved. Prototype rules are recorded for review, but are not
  // converted into personalized movement instructions.
  const personalizedCueDetail = primaryCueDetail
    ? { ...primaryCueDetail }
    : null;
  const qualityObservation = sessionCoachingQuality.observe({
    cue: personalizedCueDetail,
    timestampMs,
    repetitionNumber: currentCoachingRepetitionNumber(fb),
  });
  const primaryCueIsScoreable = personalizedCueDetail?.scoringEligible === true;
  const primaryCueIsCoachingOnly = Boolean(
    personalizedCueDetail?.guidanceAllowed === true
    && !primaryCueIsScoreable
  );
  const visiblePrimaryCue = personalizedCueDetail && (
    !primaryCueIsScoreable || qualityObservation.stable
  )
    ? primaryCueIsScoreable
      ? personalizedCueDetail.message
      : primaryCueIsCoachingOnly
        ? personalizedCueDetail.message
        : "Prototype camera observation recorded for clinician review. Continue only with your approved exercise instructions."
    : null;
  const personalizedCues = visiblePrimaryCue ? [visiblePrimaryCue] : [];
  cueListEl.innerHTML = personalizedCues
    .map((c) => `<li>${escapeHtml(c)}</li>`)
    .join("");
  let bannerState;
  let bannerCue;
  if (awaitingFinalHalfSquatReturn && fb.trackingReady) {
    bannerState = "position";
    bannerCue =
      "Final repetition: stand tall, stay fully visible, and hold still until it is counted.";
  } else if (fb.inHold && !fb.holdPositionMaintained) {
    bannerState = fb.trackingReady ? "adjust" : "visibility";
    bannerCue = fb.trackingReady
      ? "Hold reset — return to the target position to restart"
      : "Pause your movement. The hold has stopped. Reposition until the required joints are visible, then restart the hold.";
  } else if (!fb.trackingReady) {
    bannerState = "visibility";
    bannerCue = movementTrackingGuidance(fb);
  } else if (
    fb.exercise.id === "half-squats"
    && fb.repCount === 0
    && fb.phase === "standing"
    && fb.expectedNextPhase === "squat"
    && !personalizedCues.length
  ) {
    // Keep this as an on-screen-only confirmation. "good" is intentionally
    // excluded from automatic speech, leaving rep announcements unobstructed.
    bannerState = "good";
    // The full setup has already been spoken. Reusing it here made Safari say
    // the entire "Before you begin" instruction a second time while the first
    // repetitions were underway.
    bannerCue = "Starting position confirmed. Begin when you are comfortable.";
  } else if (!fb.sequenceOnTrack && fb.positionRecognized) {
    bannerState = "adjust";
    bannerCue =
      `Follow the order — move to ${fb.expectedNextPhase.replaceAll("_", " ")} next`;
  } else if (!fb.positionRecognized && !personalizedCues.length) {
    bannerState = "adjust";
    bannerCue = movementPhaseGuidance(fb);
  } else if (fb.limitedTracking && !personalizedCues.length) {
    bannerState = "good";
    bannerCue =
      `Rep tracking is working from your ${fb.trackingSide} side. Keep moving slowly and follow the phase prompt.`;
  } else {
    bannerState = personalizedCues.length ? "adjust" : "good";
    bannerCue = fb.exercise.id === "half-squats" && personalizedCues.length
      ? `${movementPhaseGuidance(fb)} ${personalizedCues[0]}`
      : personalizedCues[0] ?? "";
  }
  if (
    (qualityObservation.reminder || qualityObservation.adjusting)
    && bannerState === "adjust"
  ) {
    bannerCue = `${bannerCue} Try this for the next two repetitions; no points are deducted yet.`;
  }
  setFeedbackBanner(bannerState, bannerCue);
  const qualityReminderHandled = Boolean(
    primaryCueIsScoreable && qualityObservation.handled
  );
  if (qualityObservation.reminder) {
    deliverPendingQualityReminder(
      `${qualityObservation.reminder.cue_text}. Try this for the next two repetitions.`,
      fb,
    );
  } else if (sessionCoachingQuality.pending && qualityReminderHandled) {
    deliverPendingQualityReminder(
      `${sessionCoachingQuality.pending.cue_text}. Try this for the next two repetitions.`,
      fb,
    );
  }
  if (
    !qualityReminderHandled
    && (!qualityObservation.observationOnly || primaryCueIsCoachingOnly)
  ) {
    queueSpokenMovementCue(
      primaryCueIsCoachingOnly ? "range" : bannerState,
      bannerCue,
      timestampMs
    );
  }

  // Symmetry warning
  if (fb.symmetryWarning && fb.exercise.id !== "half-squats") {
    symWarnEl.textContent = fb.symmetryWarning;
    symWarnEl.classList.remove("hidden");
  } else {
    symWarnEl.classList.add("hidden");
  }

  lastFeedbackResult = fb;
  if (setComplete && !sessionAllSetsComplete) {
    handleCompletedSet(fb);
  }
  return fb;
}

function updateDebugPanel(angles) {
  for (const [name, a] of Object.entries(angles)) {
    const el = document.querySelector(`[data-angle="${name}"]`);
    if (!el) continue;
    if (a.lowConfidence) {
      el.textContent = "hidden";
      el.classList.add("low-conf");
      el.title = `Low visibility: ${a.weakPoints.join(", ")}`;
    } else {
      el.textContent = `${a.value.toFixed(0)}°`;
      el.classList.remove("low-conf");
      el.title = "";
    }
  }

  setSymRow("knee",  angles.leftKnee,  angles.rightKnee);
  setSymRow("elbow", angles.leftElbow, angles.rightElbow);
}

function setSymRow(key, left, right) {
  const el = document.querySelector(`[data-sym="${key}"]`);
  if (!el) return;
  if (!left || !right || left.lowConfidence || right.lowConfidence) {
    el.textContent = "—";
    el.classList.add("low-conf");
    el.title = "Needs both sides visible";
    return;
  }
  el.textContent = `${symmetry(left.value, right.value).toFixed(0)}°`;
  el.classList.remove("low-conf");
  el.title = "";
}

// ── Personal profile and calibration ─────────────────────────────────────────

function calibrationUsesJointAngles(config = engine?.exercise?.calibration) {
  return (config?.personalizedKeys ?? []).some((key) =>
    /(knee|hip|ankle|shoulder|elbow|wrist|inclination)/i.test(key)
  );
}

function calibrationPurposeMessage(config = engine?.exercise?.calibration) {
  return calibrationUsesJointAngles(config)
    ? (
      "Your measured joint angles are saved automatically and will help the "
      + "guide recognize your comfortable movement range. Safety limits are unchanged."
    )
    : (
      "Your movement baseline is saved automatically and will help the guide "
      + "recognize your movement. Safety limits are unchanged."
    );
}

function renderPersonalization() {
  const savedProfile = hasSavedProfile();
  const calibration = getCalibration(exSelect.value, sideSelect.value);
  const supportsCalibration = Boolean(engine.exercise.calibration);

  personalizationTitle.textContent = savedProfile
    ? `Guidance for ${profile.name || "you"}`
    : "Set up your profile";
  personalizationDetail.textContent = savedProfile
    ? `${profile.goal} · ${cueStyleLabel(profile.cueStyle)} coaching`
    : "Save your goals, preferences, and comfortable range.";

  if (calibration) {
    const personalRange = engine.exercise.calibration?.personalizedKeys?.length;
    calibrationBadge.textContent = personalRange
      ? "Personal range active"
      : "Personal tracking baseline active";
    calibrationDetail.textContent = `${calibrationSummary(
      calibration,
      engine.exercise.calibration
    )} · ${calibrationUsesJointAngles(engine.exercise.calibration)
      ? "used to recognize your comfortable movement angles"
      : "used to recognize your comfortable movement"} · safety limits unchanged`;
    openCalibrationBtn.textContent = "Recalibrate";
  } else if (supportsCalibration) {
    calibrationBadge.textContent = "Standard range";
    calibrationDetail.textContent = calibrationUsesJointAngles(
      engine.exercise.calibration
    )
      ? "Measures your comfortable joint angles so the guide can better recognize your movement."
      : "Measures your comfortable movement so the guide can better recognize it.";
    openCalibrationBtn.textContent = "Calibrate";
  } else {
    calibrationBadge.textContent = "Standard range";
    calibrationDetail.textContent = "Personal calibration is unavailable for this exercise.";
    openCalibrationBtn.textContent = "Unavailable";
  }

  renderPrimaryCameraAction({ supportsCalibration });

  const cameraActionAvailable =
    practiceDecision.view === PRACTICE_VIEWS.PATIENT_WORKSPACE
    && supportsCalibration;
  openCalibrationBtn.disabled = !cameraActionAvailable;
  openCalibrationPrimary.disabled = !cameraActionAvailable;
  handTrackingToggle.disabled = !(
    cameraActionAvailable && exerciseUsesHand(engine.exercise)
  );
}

function renderPrimaryCameraAction({
  supportsCalibration = Boolean(engine.exercise.calibration),
} = {}) {
  if (cameraSetupCountdown) {
    const seconds = cameraSetupCountdown.secondsRemaining;
    primaryCalibrationLabel.textContent = "Cancel camera setup";
    primaryCameraInstruction.innerHTML =
      `<strong>Camera setup starts in ${seconds}</strong>`
      + "Stay near your device so you can choose Allow if the browser asks "
      + "for camera access. Choose Cancel camera setup if you are not ready.";
    return;
  }

  if (!supportsCalibration) {
    primaryCalibrationLabel.textContent = "Camera guide unavailable";
    primaryCameraInstruction.innerHTML =
      "<strong>Camera guide unavailable</strong>"
      + "Choose another exercise to use camera guidance.";
    return;
  }

  if (exerciseSessionActive && !running) {
    primaryCalibrationLabel.textContent = "Resume camera guide";
    primaryCameraInstruction.innerHTML =
      "<strong>Your camera guide is paused</strong>"
      + "Press Resume camera guide when you are ready to continue.";
    return;
  }

  primaryCalibrationLabel.textContent = "Start camera guide";
  primaryCameraInstruction.innerHTML =
    "<strong>Start near your device</strong>"
    + "Press Start camera guide below. We’ll ask about your pain level "
    + "and camera permission before telling you when to step back.";
}

function calibrationSummary(calibration, config) {
  const keys = config?.personalizedKeys ?? [];
  const summaries = keys
    .map((key) => {
      const legacySideKey = `${calibration.affectedSide ?? "right"}${key[0].toUpperCase()}${key.slice(1)}`;
      const value = calibration.target?.[key]?.median
        ?? calibration.target?.[legacySideKey]?.median;
      if (!Number.isFinite(value)) return null;
      const angleLike = /(knee|hip|ankle|shoulder|elbow|wrist|inclination)/i
        .test(key);
      return `${friendlyMeasurement(key)} ${angleLike
        ? `${Math.round(value)}°`
        : value.toFixed(2)}`;
    })
    .filter(Boolean);
  return summaries.slice(0, 2).join(" · ") || "personal tracking baseline saved";
}

function friendlyMeasurement(key) {
  return key
    .replace(/([A-Z])/g, " $1")
    .replace(/^./, (letter) => letter.toUpperCase());
}

function movementTrackingGuidance(feedback) {
  const hiddenJoints = (feedback.missingLandmarks ?? [])
    .slice(0, 4)
    .map((key) => friendlyMeasurement(key).toLowerCase());
  const hiddenJointMessage = hiddenJoints.length
    ? `I cannot clearly see your ${joinGuidanceLabels(hiddenJoints)}. `
    : "I cannot clearly see all of the joints needed to measure this movement. ";
  if (feedback.exercise.id === "half-squats") {
    const missing = (feedback.missingMeasurements ?? [])
      .slice(0, 2)
      .map((key) => friendlyMeasurement(key).toLowerCase());
    const measurement = missing.length
      ? `I cannot measure your ${missing.join(" and ")} angle${missing.length > 1 ? "s" : ""}. `
      : "I cannot measure a complete leg angle. ";
    return (
      "Pause your movement. "
      + hiddenJointMessage
      + measurement
      + "Step farther back or turn slightly until one complete hip, knee, and "
      + "ankle line is visible. Keep the chair beside you, not in "
      + "front of the visible leg."
    );
  }
  const labels = (feedback.missingMeasurements ?? [])
    .slice(0, 2)
    .map((key) => friendlyMeasurement(key).toLowerCase());
  return labels.length
    ? (
      `Pause your movement. ${hiddenJointMessage}`
      + `Reposition so I can see and measure your ${labels.join(" and ")}. `
      + "I will resume measuring when the required joints are visible."
    )
    : (
      `Pause your movement. ${hiddenJointMessage}`
      + "Reposition until the required joints are visible. I will resume measuring then."
    );
}

function joinGuidanceLabels(labels) {
  if (labels.length < 2) return labels[0] ?? "";
  if (labels.length === 2) return labels.join(" and ");
  return `${labels.slice(0, -1).join(", ")}, and ${labels.at(-1)}`;
}

function movementPhaseGuidance(feedback) {
  const nextPhase = feedback.expectedNextPhase?.replaceAll("_", " ")
    ?? "next";
  if (feedback.exercise.id === "half-squats") {
    return nextPhase === "squat"
      ? "Bend your knees slowly and move your hips back as if starting to sit. Lower only a little and keep your heels flat."
      : "Press through your whole feet and slowly stand tall. Use the chair only for balance.";
  }
  return `Move slowly toward the ${nextPhase} position`;
}

function cueStyleLabel(style) {
  if (style === "direct") return "short, direct";
  if (style === "detailed") return "detailed";
  return "gentle";
}

function personalizeCue(cue) {
  if (!cue) return cue;
  if (profile.cueStyle === "direct") return cue;
  if (profile.cueStyle === "detailed") {
    return `${cue}. Move slowly, then use the guide to check your position again.`;
  }
  return `When you’re ready, ${cue[0].toLowerCase()}${cue.slice(1)}`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

let calibrationReturnFocus = openCalibrationBtn;

async function openCalibrationFlow(event) {
  const trigger = event.currentTarget;
  if (trigger === openCalibrationPrimary && cameraSetupCountdown) {
    cancelCameraSetupCountdown();
    return;
  }
  // Resolve account and prescription access before asking for a pain score,
  // so a patient cannot finish the check-in only to be blocked afterwards.
  syncPracticeAccess();
  if (!hasPathwayAccess()) return;
  if (!(await ensureVoiceModeChosen())) return;
  if (trigger === openCalibrationPrimary && exerciseSessionActive) {
    await activateCameraGuide();
    return;
  }
  if (
    isPracticeAccountAuthenticated() &&
    !exerciseSessionActive &&
    !preExerciseCheckinCompleted
  ) {
    showPainCheckin("before", {
      continuation: "calibration",
      calibrationTrigger: trigger,
    });
    return;
  }
  await startCalibrationFlow(trigger);
}

async function startCalibrationFlow(
  trigger,
  { forceFull = trigger === openCalibrationBtn } = {}
) {
  cameraSetupStatus.hidden = true;
  cameraSetupStatus.textContent = "";
  if (!engine.exercise.calibration) {
    cameraSetupStatus.textContent =
      "Camera setup is unavailable for this exercise.";
    cameraSetupStatus.hidden = false;
    return;
  }

  const safetyContext = buildCalibrationSafetyContext({
    profile,
    dose: activeDose(engine.exercise),
    painLevel: confirmedPreExercisePain,
  });
  const savedCalibration = getCalibration(
    engine.exercise.id,
    sideSelect.value
  );
  const reuseDecision = evaluateCalibrationReuse(
    savedCalibration,
    safetyContext
  );
  if (reuseDecision.action === "professional-review") {
    const message =
      "Your safety information has changed. Please get professional review before using this saved movement setup.";
    cameraSetupStatus.textContent = message;
    cameraSetupStatus.hidden = false;
    statusEl.textContent = "Professional review recommended before exercise";
    setFeedbackBanner("tracking", message);
    speakCalibrationGuidance(message, {
      key: `calibration:${engine.exercise.id}:professional-review`,
      interrupt: true,
    });
    return;
  }

  const calibrationMode = forceFull
    ? "full-calibration"
    : reuseDecision.action;
  if (!running && !(await activateCameraGuide({ announceInstruction: false }))) {
    cameraSetupStatus.textContent = engine.exercise.requiresClinicianPlan
      && currentPatientCarePath() !== "clinician"
      ? (
        "This movement requires a physiotherapist-approved care plan. "
        + "Return to My home and create a new general-wellness AI plan."
      )
      : (
        statusEl.textContent
        || "Camera setup could not start. Check the message above and try again."
      );
    cameraSetupStatus.hidden = false;
    return;
  }

  calibrationReturnFocus = trigger;
  calibrationDraft = null;
  calibrationSession = {
    exerciseId: engine.exercise.id,
    mode: calibrationMode,
    savedCalibration,
    safetyContext,
    step: "start",
    startFrames: null,
    targetCaptures: [],
    capture: null,
  };
  stopMovementAiGuide({ hide: false });
  setMovementAiStatus(
    "paused",
    "AI questions will be ready after camera setup is complete."
  );
  calibrationOverlay.classList.remove("hidden");
  renderCalibrationStep();
  calibrationStatus.textContent =
    "Listen to the complete instruction, then hold your starting position.";
  announceCalibrationStage("start", {
    onEnd: () => {
      if (!calibrationSession) return;
      beginCalibrationCapture("start", {
        durationMs: calibrationMode === "position-check"
          ? SESSION_POSITION_CAPTURE_MS
          : CALIBRATION_CAPTURE_MS,
      });
    },
  });
  calibrationCancel.focus();
}

openCalibrationBtn.addEventListener("click", openCalibrationFlow);
openCalibrationPrimary.addEventListener("click", openCalibrationFlow);

calibrationCancel.addEventListener("click", () => {
  const setupWasActive = Boolean(calibrationSession);
  cancelCalibration();
  if (setupWasActive && running) {
    deactivateCameraGuide({
      statusMessage: "Camera setup cancelled — exercise not started",
    });
    discardExerciseSession();
  }
});

function saveCompletedCalibration(draft) {
  const hasPersonalRange = Boolean(
    engine.exercise.calibration.personalizedKeys.length
  );
  saveCalibration(draft);
  if (isPracticeAccountAuthenticated()) {
    postCalibration({
      exercise: draft.exerciseId,
      affected_side: draft.affectedSide,
      captured_at: draft.capturedAt,
      start_measurements: draft.start,
      target_measurements: draft.target,
      phase_ranges: draft.phaseRanges,
      natural_knee_difference: draft.naturalKneeDifference,
    }).catch(() => {});
  }
  engine.changeExercise(exSelect.value, sideSelect.value, draft);
  smoother.state = {};
  repTrackingSmoother.state = {};
  combinedPoseHistory = [];
  renderPersonalization();
  cancelCalibration();
  statusEl.textContent = hasPersonalRange
    ? "Personal range saved automatically — movement guide ready"
    : "Personal tracking baseline saved automatically — movement guide ready";
  setFeedbackBanner("ready", exerciseStartGuidance(engine.exercise));
  announceExerciseInstruction(
    hasPersonalRange
      ? "Personalized movement recognition is ready."
      : "Personal movement tracking is ready.",
    { onEnd: startMovementAiGuide }
  );
}

function renderCalibrationStep() {
  if (!calibrationSession) return;
  const dots = [...calibrationOverlay.querySelectorAll(".calibration-dots span")];
  const stepIndex = { start: 0, target: 1 }[
    calibrationSession.step
  ];
  dots.forEach((dot, index) => dot.classList.toggle("active", index <= stepIndex));
  calibrationStatus.textContent = "";

  if (calibrationSession.step === "start") {
    const isPositionCheck = calibrationSession.mode === "position-check";
    calibrationStepLabel.textContent = isPositionCheck
      ? "Automatic session position check"
      : "Step 1 · Automatic starting-position check";
    calibrationTitle.textContent = isPositionCheck
      ? "Confirm your starting position"
      : `Personalize ${engine.exercise.name} detection`;
    const startInstruction = engine.exercise.calibration.startInstruction
      ?? `Hold ${engine.exercise.calibration.startPhase.replaceAll("_", " ")} with every required joint visible.`;
    setTranslatableTextParts(
      calibrationInstructions,
      isPositionCheck
        ? [
          "Your saved personalized movement range will be reused. This quick 2–3 second check confirms that you are visible and in the correct starting position.",
          startInstruction,
          "Measurement starts automatically.",
        ]
        : [
          "This short spoken setup measures your comfortable positions so PhysioVision can recognize your movement more accurately. It does not change safety limits.",
          startInstruction,
          "No extra button is needed—measurement starts automatically when you hold the position.",
        ]
    );
  } else {
    calibrationStepLabel.textContent = "Step 2 · One comfortable movement";
    calibrationTitle.textContent = engine.exercise.calibration.targetTitle
      ?? `Move to ${engine.exercise.calibration.targetPhase.replaceAll("_", " ")}`;
    setTranslatableTextParts(calibrationInstructions, [
      engine.exercise.calibration.targetInstruction
        ?? "Move only as far as is comfortable, then hold the position.",
      "Spoken guidance will lead you, and measurement starts automatically.",
    ]);
  }
}

function beginCalibrationCapture(
  type,
  {
    awaitingReturn = false,
    retryAfter = 0,
    durationMs = CALIBRATION_CAPTURE_MS,
  } = {}
) {
  calibrationSession.capture = {
    type,
    durationMs,
    frames: [],
    awaitingReturn,
    phaseDetectedAt: null,
    measuringStartedAt: null,
    previousFrame: null,
    retryAfter,
    guidanceKey: "",
    guidanceFirstSeenAt: null,
    lastGuidanceAt: -Infinity,
  };
  calibrationStatus.textContent = awaitingReturn
    ? "Sample saved. Return to your starting position; the next sample will begin automatically."
    : calibrationWaitingMessage(type);
}

function updateCalibrationCapture(angles, timestampMs) {
  const capture = calibrationSession?.capture;
  if (!capture) return;

  if (capture.retryAfter && timestampMs < capture.retryAfter) return;
  capture.retryAfter = 0;

  const inspection = inspectCalibrationFrame(
    engine.exercise,
    angles,
    sideSelect.value
  );
  const frame = inspection.frame;
  if (!frame) {
    resetCalibrationPositionTimer(capture);
    presentCalibrationIssue(
      capture,
      `visibility:${inspection.missingMeasurements.join(",")}`,
      calibrationVisibilityGuidance(inspection),
      timestampMs,
      "position"
    );
    return;
  }

  if (capture.awaitingReturn) {
    if (!calibrationFrameMatchesPhase(engine.exercise, frame, "start")) {
      capture.phaseDetectedAt = null;
      capture.previousFrame = frame;
      presentCalibrationIssue(
        capture,
        "return-to-start",
        "I can see the required joints. Return to your comfortable starting position and hold still; I will tell you when to move again.",
        timestampMs,
        "adjust"
      );
      return;
    }
    if (!calibrationFrameIsStable(capture.previousFrame, frame)) {
      capture.phaseDetectedAt = timestampMs;
      capture.previousFrame = frame;
      presentCalibrationIssue(
        capture,
        "return-hold-still",
        "Starting position found—finish moving and hold still for a moment.",
        timestampMs,
        "adjust"
      );
      return;
    }
    capture.previousFrame = frame;
    capture.phaseDetectedAt ??= timestampMs;
    if (
      timestampMs - capture.phaseDetectedAt
      < CALIBRATION_RETURN_STABLE_MS
    ) {
      clearCalibrationIssue(capture);
      calibrationStatus.textContent =
        "Starting position found—hold still for a moment.";
      return;
    }

    capture.awaitingReturn = false;
    calibrationSession.capture = null;
    calibrationStatus.textContent = calibrationWaitingMessage("target");
    announceCalibrationStage("target", {
      afterReturn: true,
      onEnd: () => {
        if (!calibrationSession) return;
        beginCalibrationCapture("target");
      },
    });
    return;
  }

  if (!calibrationFrameMatchesPhase(engine.exercise, frame, capture.type)) {
    resetCalibrationPositionTimer(capture);
    presentCalibrationIssue(
      capture,
      `phase:${capture.type}`,
      calibrationPhaseGuidance(capture.type),
      timestampMs,
      "adjust"
    );
    return;
  }

  if (!calibrationFrameIsStable(capture.previousFrame, frame)) {
    capture.frames = [];
    capture.phaseDetectedAt = timestampMs;
    capture.measuringStartedAt = null;
    capture.previousFrame = frame;
    presentCalibrationIssue(
      capture,
      `unstable:${capture.type}`,
      "I can see the required joints and the position. Finish moving, then hold still so I can record the measurement.",
      timestampMs,
      "adjust"
    );
    return;
  }

  capture.previousFrame = frame;
  capture.phaseDetectedAt ??= timestampMs;
  if (capture.measuringStartedAt === null) {
    if (
      timestampMs - capture.phaseDetectedAt
      < CALIBRATION_POSITION_STABLE_MS
    ) {
      clearCalibrationIssue(capture);
      calibrationStatus.textContent =
        "Position found—hold still. Automatic measurement is about to begin.";
      return;
    }
    clearCalibrationIssue(capture);
    capture.measuringStartedAt = timestampMs;
    capture.frames = [frame];
    calibrationStatus.textContent =
      "Measuring automatically… keep holding this comfortable position.";
    setFeedbackBanner(
      "good",
      "Required joints found. Hold still while the personal measurement is recorded."
    );
    return;
  }

  capture.frames.push(frame);
  const elapsed = timestampMs - capture.measuringStartedAt;
  const captureDurationMs = capture.durationMs ?? CALIBRATION_CAPTURE_MS;
  const remaining = Math.max(
    0,
    Math.ceil((captureDurationMs - elapsed) / 1000)
  );
  calibrationStatus.textContent =
    `Measuring automatically… ${remaining || "almost done"}`;
  if (elapsed < captureDurationMs) return;
  finishCalibrationCapture(capture);
}

function calibrationVisibilityGuidance({ missingMeasurements, weakPoints }) {
  const missing = new Set(missingMeasurements);
  const missingKnees = [...missing].filter((key) => /knee/i.test(key));
  if (missingKnees.length) {
    if (engine.exercise.id === "half-squats") {
      return (
        "I cannot measure a complete knee angle. Step farther back or turn "
        + "slightly until one hip, knee, and ankle line is visible. "
        + "Keep the chair beside you, not in front of the visible leg."
      );
    }
    const bothKnees = missingKnees.some((key) => /^left/i.test(key))
      && missingKnees.some((key) => /^right/i.test(key));
    return bothKnees
      ? (
        "I cannot measure either knee angle. Step farther back and adjust the "
        + "device until both hips, knees, ankles, and feet are visible."
      )
      : (
        `I cannot measure your ${friendlyMeasurement(missingKnees[0]).toLowerCase()} angle. `
        + "Reposition so that hip, knee, ankle, and foot are all visible."
      );
  }

  const missingHips = [...missing].filter((key) => /hip/i.test(key));
  if (missingHips.length) {
    if (engine.exercise.id === "half-squats") {
      return (
        "I cannot measure a complete hip angle. Reposition until one shoulder, "
        + "hip, knee, and ankle line is visible from head to foot."
      );
    }
    return (
      "I cannot measure the required hip angle. Step farther back and keep "
      + "your shoulders, hips, and knees visible."
    );
  }

  if ([...missing].some((key) => /(ankle|heel|foot)/i.test(key))) {
    return (
      "I cannot measure the required ankle or foot movement. Reposition the "
      + "device so your knee, ankle, heel, and toes are visible."
    );
  }

  if ([...missing].some((key) => /(shoulder|elbow|wrist|hand)/i.test(key))) {
    return (
      "I cannot measure the required arm or hand position. Reposition so the "
      + "working shoulder, elbow, wrist, and complete hand are visible."
    );
  }

  const labels = missingMeasurements
    .slice(0, 2)
    .map((key) => friendlyMeasurement(key).toLowerCase());
  const hiddenLandmarks = weakPoints
    .slice(0, 3)
    .map((key) => friendlyMeasurement(key.replaceAll("_", " ")).toLowerCase());
  const requirement = labels.length
    ? labels.join(" and ")
    : "required movement";
  const detail = hiddenLandmarks.length
    ? ` Keep ${hiddenLandmarks.join(", ")} visible.`
    : " Keep your full body and every required joint visible.";
  return `I cannot measure the ${requirement}.${detail}`;
}

function calibrationPhaseGuidance(type) {
  const config = engine.exercise.calibration;
  const phase = type === "start" ? config.startPhase : config.targetPhase;
  const capturesLegAngles = config.captureKeys.some((key) =>
    /(knee|hip|ankle)/i.test(key)
  );
  if (type === "target" && capturesLegAngles) {
    return (
      `I can see the required joints, but I have not detected the ${phase.replaceAll("_", " ")} position. `
      + "Move only as far as is comfortable, then hold still so I can record your knee angle."
    );
  }
  return (
    `I can see the required joints. Move into your comfortable ${phase.replaceAll("_", " ")} `
    + "position, then hold still so I can record it."
  );
}

function presentCalibrationIssue(
  capture,
  key,
  message,
  timestampMs,
  bannerState = "position"
) {
  if (calibrationStatus.textContent !== message) {
    calibrationStatus.textContent = message;
  }
  setFeedbackBanner(bannerState, message);

  if (capture.guidanceKey !== key) {
    capture.guidanceKey = key;
    capture.guidanceFirstSeenAt = timestampMs;
    capture.lastGuidanceAt = -Infinity;
    return;
  }
  if (
    timestampMs - capture.guidanceFirstSeenAt < CALIBRATION_STALL_REMINDER_MS
    || timestampMs - capture.lastGuidanceAt < CALIBRATION_STALL_REPEAT_MS
  ) {
    return;
  }

  const spoken = speakCalibrationGuidance(message, {
    key: `calibration:${engine.exercise.id}:stalled:${capture.type}:${key}`,
    cooldownMs: CALIBRATION_STALL_REPEAT_MS,
  });
  if (spoken) capture.lastGuidanceAt = timestampMs;
}

function clearCalibrationIssue(capture) {
  capture.guidanceKey = "";
  capture.guidanceFirstSeenAt = null;
  capture.lastGuidanceAt = -Infinity;
}

function finishCalibrationCapture(capture) {
  calibrationSession.capture = null;
  try {
    validateCalibrationCapture(
      engine.exercise,
      capture.frames,
      capture.type
    );

    if (capture.type === "start") {
      if (calibrationSession.mode === "position-check") {
        const checkedCalibration = {
          ...calibrationSession.savedCalibration,
          safetyContext: calibrationSession.safetyContext,
          lastPositionCheckedAt: new Date().toISOString(),
        };
        saveCalibration(checkedCalibration);
        engine.changeExercise(
          exSelect.value,
          sideSelect.value,
          checkedCalibration
        );
        smoother.state = {};
        repTrackingSmoother.state = {};
        combinedPoseHistory = [];
        cancelCalibration();
        statusEl.textContent =
          "Starting position confirmed — movement guide ready";
        setFeedbackBanner(
          "ready",
          exerciseStartGuidance(engine.exercise)
        );
        announceExerciseInstruction(
          "Starting position confirmed.",
          { onEnd: startMovementAiGuide }
        );
        return;
      }
      calibrationSession.startFrames = capture.frames;
      calibrationSession.step = "target";
      renderCalibrationStep();
      calibrationStatus.textContent =
        "Starting position saved. Listen before making the calibration movement.";
      announceCalibrationStage("target", {
        onEnd: () => {
          if (!calibrationSession) return;
          beginCalibrationCapture("target");
        },
      });
    } else {
      calibrationSession.targetCaptures.push(capture.frames);
      if (
        calibrationSession.targetCaptures.length
        >= CALIBRATION_TARGET_MOVEMENTS
      ) {
        calibrationDraft = createCalibration(engine.exercise, {
          affectedSide: sideSelect.value,
          startFrames: calibrationSession.startFrames,
          targetCaptures: calibrationSession.targetCaptures,
        });
        calibrationDraft.safetyContext = calibrationSession.safetyContext;
        calibrationDraft.lastPositionCheckedAt = new Date().toISOString();
        saveCompletedCalibration(calibrationDraft);
      } else {
        renderCalibrationStep();
        beginCalibrationCapture("target", { awaitingReturn: true });
        const completed = calibrationSession.targetCaptures.length;
        speakCalibrationGuidance(
          `Sample ${completed} saved. Return to your starting position. I will tell you when to move again.`,
          {
            key: `calibration:${engine.exercise.id}:return:${completed}`,
            interrupt: true,
          }
        );
      }
    }
  } catch (error) {
    const retryAfter = performance.now() + 1800;
    beginCalibrationCapture(capture.type, {
      retryAfter,
      durationMs: capture.durationMs,
    });
    calibrationStatus.textContent =
      `${error.message} I will retry automatically—reposition comfortably and hold still.`;
    speakCalibrationGuidance(
      `${error.message} Reposition comfortably. I will retry automatically.`,
      {
        key: `calibration:${engine.exercise.id}:${capture.type}:retry`,
        interrupt: true,
        cooldownMs: 3000,
      }
    );
  }
}

function resetCalibrationPositionTimer(capture) {
  capture.frames = [];
  capture.phaseDetectedAt = null;
  capture.measuringStartedAt = null;
  capture.previousFrame = null;
}

function calibrationFrameIsStable(previousFrame, frame) {
  if (!previousFrame || !frame) return true;
  return Object.keys(frame).every((key) => {
    const previous = previousFrame[key];
    const current = frame[key];
    if (typeof previous === "string" || typeof current === "string") {
      return previous === current;
    }
    if (!Number.isFinite(previous) || !Number.isFinite(current)) return false;
    const tolerance = Math.max(
      Math.abs(previous) <= 2 && Math.abs(current) <= 2 ? 0.025 : 2.5,
      Math.abs(previous) * 0.015
    );
    return Math.abs(current - previous) <= tolerance;
  });
}

function calibrationWaitingMessage(type) {
  const config = engine.exercise.calibration;
  const phase = type === "start" ? config.startPhase : config.targetPhase;
  return type === "start"
    ? `Move into your comfortable ${phase.replaceAll("_", " ")} position and hold still. Measurement starts automatically.`
    : `Move into a comfortable ${phase.replaceAll("_", " ")} position and hold it. Measurement starts automatically.`;
}

function announceCalibrationStage(
  type,
  { afterReturn = false, onEnd = null } = {}
) {
  const config = engine.exercise.calibration;
  const finish = () => {
    if (calibrationSession) onEnd?.();
  };
  if (type === "start") {
    const startInstruction = config.startInstruction
      ?? `Hold your ${config.startPhase.replaceAll("_", " ")} position with your full body visible.`;
    const cameraReadyPositioning = exerciseUsesHand(engine.exercise)
      ? "Camera is ready. Now place the required hand and arm inside the guide."
      : "Camera is ready. Now step back until your required joints are visible.";
    const introduction = calibrationSession.mode === "position-check"
      ? "I will quickly confirm your starting position using your saved personal range."
      : "Let’s personalize movement recognition before you begin.";
    const spoken = speakCalibrationGuidance(
      localizedGuidanceParts([
        cameraReadyPositioning,
        introduction,
        startInstruction,
        "Hold still after this instruction. I will measure automatically and tell you when to move.",
      ]),
      {
        key: `calibration:${engine.exercise.id}:start`,
        interrupt: true,
        onEnd: finish,
      }
    );
    if (!spoken) finish();
    return;
  }

  const targetInstruction = config.targetInstruction
    ?? `Move into a comfortable ${config.targetPhase.replaceAll("_", " ")} position.`;
  const spoken = speakCalibrationGuidance(
    localizedGuidanceParts([
      afterReturn ? "Starting position found." : "Starting position saved.",
      targetInstruction,
      "This is your only calibration movement. Hold the position; I will measure automatically.",
    ]),
    {
      key: `calibration:${engine.exercise.id}:target:${calibrationSession.targetCaptures.length + 1}:${afterReturn ? "return" : "first"}`,
      interrupt: true,
      onEnd: finish,
    }
  );
  if (!spoken) finish();
}

function cancelCalibration() {
  const wasActive = Boolean(calibrationSession);
  calibrationSession = null;
  calibrationDraft = null;
  voiceGuidance.cancel();
  calibrationOverlay?.classList.add("hidden");
  if (wasActive) calibrationReturnFocus?.focus();
}

// ── Static panel renders ──────────────────────────────────────────────────────

function renderPoseStrip(exercise, activePhase) {
  const stages = engine.stages;
  if (!stages.length) { poseStripEl.innerHTML = ""; return; }

  poseStripEl.innerHTML = stages.map((stage, i) => {
    const isActive = stage === activePhase;
    const arrow = i < stages.length - 1
      ? `<span class="pose-arrow-sep">→</span>`
      : "";
    return `
      <div class="pose-card${isActive ? " active" : ""}">
        <span class="pose-step">${i + 1}</span>
        <span class="pose-label">${stage}</span>
      </div>
      ${arrow}`;
  }).join("");
}

function renderPrescription(ex) {
  const p = activeDose(ex);
  const repetitions = p.repetitionLabel ?? p.reps;
  const setUnit = Number(p.sets) === 1 ? "set" : "sets";
  const hasStructuredDose = Number.isFinite(Number(p.sets))
    && Number(p.sets) > 0
    && Number.isFinite(Number(p.reps))
    && Number(p.reps) > 0;
  if (currentPatientCarePath() === "clinician" && !p.id) {
    prescEl.textContent = "This movement is not in your active prescription";
    if (repTargetEl) repTargetEl.textContent = "—";
  } else if (currentPatientCarePath() === "clinician") {
    prescEl.textContent =
      `${p.sets} ${setUnit} × ${repetitions} reps` +
      (p.holdSeconds ? ` · hold ${p.holdSeconds}s` : "") +
      ` · ${p.daysPerWeek} days/week` +
      (p.clinicianName ? ` · prescribed by ${p.clinicianName}` : "");
    if (repTargetEl) repTargetEl.textContent = p.reps;
  } else if (
    practiceDecision.reason === "wellness_plan"
    && p.mode !== "wellness_plan"
  ) {
    prescEl.textContent = "This movement is not in your accepted AI plan";
    if (repTargetEl) repTargetEl.textContent = "—";
  } else if (p.mode === "clinician_plan") {
    prescEl.textContent = "A clinician prescription is required";
    if (repTargetEl) repTargetEl.textContent = "—";
  } else if (p.mode === "wellness_plan" && !hasStructuredDose) {
    prescEl.textContent = p.dosage || "Follow the dosage in your accepted AI plan";
    if (repTargetEl) repTargetEl.textContent = "—";
  } else {
    prescEl.textContent =
      `${p.sets} ${setUnit} × ${repetitions} reps` +
      (p.holdSeconds ? ` · hold ${p.holdSeconds}s` : "") +
      ` · ${p.daysPerWeek} days/week`;
    if (repTargetEl) repTargetEl.textContent = p.reps;
  }

  // For hold exercises the goal is expressed in seconds held, not reps.
  const metric = goalMetric(ex);
  if (repLabelEl) repLabelEl.textContent = metric.unit;
  if (repTargetEl && metric.goal !== null && repTargetEl.textContent !== "—") {
    repTargetEl.textContent = metric.isHold ? `${metric.goal}s` : metric.goal;
  }
  if (setCompleteBadgeEl) setCompleteBadgeEl.classList.add("hidden");
  renderCameraRepProgress(ex, 0);

  // Show inline hold timer only for stretch exercises
  if (ex.category === "stretch" && p.holdSeconds) {
    holdInlineEl.classList.remove("hidden");
    holdInlineEl.classList.remove("active");
    holdInlineCountEl.textContent = p.holdSeconds;
  } else {
    holdInlineEl.classList.add("hidden");
  }
}

function renderTrackingWarning(ex) {
  const clinicianNote = activeDose(ex).notes;
  if (ex.safetyNote || ex.trackingWarning || clinicianNote) {
    const trackingInstruction = ex.trackingWarning
      ? video.srcObject
        ? ex.trackingWarning
        : `After camera access is allowed: ${ex.trackingWarning}`
      : "";
    trackWarnEl.textContent = [
      ex.safetyNote ? `⚠ Safety: ${ex.safetyNote}` : "",
      clinicianNote ? `Clinician instruction: ${clinicianNote}` : "",
      trackingInstruction,
    ].filter(Boolean).join(" ");
    trackWarnEl.classList.remove("hidden");
  } else {
    trackWarnEl.classList.add("hidden");
  }
  if (!video.srcObject && !exerciseUsesHand(ex)) {
    setupTip.textContent = cameraSetupTip(ex);
  }
}

function cameraSetupTip(exercise) {
  const camera = exercise.camera ?? "front";
  if (camera.includes("close")) {
    return "Close view · Upright phone · Keep every required joint visible";
  }
  if (camera.includes("side") || camera.includes("oblique")) {
    return "Side/oblique view · Keep the complete moving limb visible";
  }
  return "Front view · Phone at chest height · Keep required joints visible";
}

function renderStaticPhaseFlow(activeEngine) {
  phaseFlowEl.innerHTML = activeEngine.stages
    .map((stage, index) => {
      const active = index === 0 ? " active" : "";
      const arrow =
        index < activeEngine.stages.length - 1
          ? '<span class="phase-arrow">→</span>'
          : "";
      return `<span class="phase-chip${active}">${stage}</span>${arrow}`;
    })
    .join("");
}

function setFeedbackBanner(state, cue = "") {
  if (!feedbackEl) return;
  const symbol = feedbackEl.querySelector(".feedback-symbol");
  const title = feedbackEl.querySelector(".feedback-title");
  const detail = feedbackEl.querySelector(".feedback-detail");
  feedbackEl.classList.toggle("needs-adjustment", state === "adjust");
  feedbackEl.classList.toggle(
    "tracking-uncertain",
    state === "tracking" || state === "visibility" || state === "position"
  );

  if (state === "adjust") {
    symbol.textContent = "!";
    title.textContent = "Small adjustment";
    detail.textContent = cue || "Follow the coaching cue below";
  } else if (state === "good") {
    symbol.textContent = "✓";
    title.textContent = "Movement looks good";
    detail.textContent = cue || "Keep this pace and breathe naturally";
  } else if (state === "ready") {
    symbol.textContent = "→";
    title.textContent = "Start your movement";
    detail.textContent = cue || "Begin now and follow the movement prompt";
  } else if (state === "tracking") {
    symbol.textContent = "?";
    title.textContent = "Tracking uncertain";
    detail.textContent =
      cue || "Make sure your required joints are clearly visible";
  } else if (state === "visibility") {
    symbol.textContent = "↔";
    title.textContent = "Movement paused — adjust your position";
    detail.textContent = cue || "Reposition until every required joint is visible";
  } else if (state === "position") {
    symbol.textContent = "↔";
    title.textContent = "Let’s get you in frame";
    detail.textContent = cue || "Make sure your full body is visible";
  } else if (state === "hand-ready") {
    symbol.textContent = "✓";
    title.textContent = "Hand tracking ready";
    detail.textContent = "All 21 hand landmarks are visible at a usable size";
  } else if (state === "finished") {
    symbol.textContent = "✓";
    title.textContent = "Exercise finished by you";
    detail.textContent = "You can now complete or skip the optional check-in";
  } else {
    symbol.textContent = "●";
    title.textContent = "Get into position";
    detail.textContent = "Live guidance appears here";
  }
}

// ── Controls ──────────────────────────────────────────────────────────────────

function hasPathwayAccess() {
  if (!hasLivePracticeAccess()) {
    setFeedbackBanner(
      "tracking",
      "Sign in with an eligible patient pathway before starting"
    );
    return false;
  }
  const usesClinicianPath = practiceDecision.reason === "active_prescription";
  if (
    usesClinicianPath &&
    !activePrescriptions.has(engine.exercise.id)
  ) {
    statusEl.textContent = "This exercise is not in your active prescription";
    setFeedbackBanner(
      "tracking",
      "Choose one of the movements assigned by your physiotherapist"
    );
    return false;
  }
  if (
    practiceDecision.reason === "wellness_plan"
    && !wellnessPlanIncludesExercise(
      currentAcceptedWellnessPlan(),
      engine.exercise.id
    )
  ) {
    statusEl.textContent = "This exercise is not in your accepted AI plan";
    setFeedbackBanner(
      "tracking",
      "Choose one of the movements in your accepted AI wellness plan"
    );
    return false;
  }
  if (engine.exercise.requiresClinicianPlan && !usesClinicianPath) {
    statusEl.textContent = "This exercise requires a clinician-approved care plan";
    setFeedbackBanner(
      "tracking",
      "Choose an exercise available for your care path or update your clinician plan"
    );
    return false;
  }
  return true;
}

function announceExerciseInstruction(prefix = "", { onEnd = null } = {}) {
  const clinicianNote = activeDose(engine.exercise).notes;
  const spokenInstruction = localizedGuidanceParts([
    prefix,
    goalMetric(engine.exercise).isHold
      ? "Hold measurement starts after this instruction."
      : "Camera repetition counting is active now, including while I give this instruction.",
    exerciseStartGuidance(engine.exercise),
    exerciseTargetGuidance(engine.exercise),
    clinicianNote ? `Your clinician's instruction is: ${clinicianNote}` : "",
    handsFreeVoiceEnabled
      ? "Say Hey Guide for help, or Hey Guide, I need a rest."
      : "",
  ]);
  setMovementAiStatus(
    "coaching",
    goalMetric(engine.exercise).isHold
      ? "Listen to the complete start instruction."
      : "Listen while you begin. Camera repetition counting is already active."
  );
  movementTrackingPausedForInstruction = true;
  const finishInstruction = () => {
    movementTrackingPausedForInstruction = false;
    spokenCoachingCandidate = null;
    const alreadyCounting = !goalMetric(engine.exercise).isHold
      && engine.repCount > 0;
    statusEl.textContent = alreadyCounting
      ? "Instruction complete — keep going"
      : "Instruction complete — begin your first repetition";
    setFeedbackBanner(
      "ready",
      alreadyCounting
        ? "Keep going. Rep counting is active."
        : "Begin now. Rep counting is active."
    );
    onEnd?.();
    // Start the wake-listener lifecycle first, then let the latest queued rep
    // temporarily take priority. Reversing this order invalidates the rep's
    // completion callback and can leave subsequent counts permanently queued.
    processPendingRepAnnouncements();
  };
  const spoken = speakMovementGuide(spokenInstruction, {
    key: `instruction:${engine.exercise.id}`,
    cooldownMs: 3000,
    interrupt: true,
    onEnd: finishInstruction,
  });
  if (!spoken) finishInstruction();
  return spoken;
}

function setIntegratedCameraGuideActive(active) {
  document.body?.classList.toggle("camera-guide-ai-active", active);
  if (!active) return;

  const standalonePanel = document.getElementById("agentChatPanel");
  const standaloneLauncher = document.getElementById("agentChatLauncher");
  if (standalonePanel) standalonePanel.hidden = true;
  standaloneLauncher?.setAttribute("aria-expanded", "false");
}

async function activateCameraGuide({ announceInstruction = true } = {}) {
  if (running) return true;
  stopRestResumeVoiceListening({ cancelListening: true });
  if (!(await ensureVoiceModeChosen())) return false;
  if (!hasPathwayAccess()) return false;
  const trackingMode = engine.exercise.trackingMode ?? TRACKING_MODES.POSE;
  const needsPose = trackingMode !== TRACKING_MODES.HAND;
  await ensureMovementModels(engine.exercise);
  if (needsPose && !poseLandmarker) {
    statusEl.textContent = "The movement-tracking model is unavailable";
    setFeedbackBanner(
      "tracking",
      "Check your internet connection, then try Start camera guide again"
    );
    return false;
  }
  if (exerciseUsesHand(engine.exercise) && !handLandmarker) {
    statusEl.textContent = "The hand-tracking model is unavailable";
    setFeedbackBanner(
      "tracking",
      "Reload with an internet connection or choose a Pose-only exercise"
    );
    return false;
  }
  try {
    toggleBtn.disabled = true;
    handTrackingToggle.disabled = true;
    statusEl.textContent = "Starting camera…";
    await startCamera();
    renderTrackingWarning(engine.exercise);
    running = true;
    resetCameraInferenceClock();
    combinedPoseHistory = [];
    beginExerciseSession();
    resetSpokenCoaching();
    configureFallMonitoring(engine.exercise);
    if (fallReadinessEl.dataset.state === "ready") {
      fallReadinessTitleEl.textContent = "Local possible-fall check ready";
      fallReadinessDetailEl.textContent =
        profile.emergencyContactAlertsReady
          ? "The camera check is active. No response can alert your verified emergency contact after one minute."
          : "The camera check is active, but automatic alerts require a verified emergency contact.";
    }
    cameraStage?.classList.add("camera-active");
    setIntegratedCameraGuideActive(true);
    if (exerciseUsesHand(engine.exercise)) {
      const combined = engine.exercise.trackingMode === TRACKING_MODES.POSE_AND_HAND;
      handFrameGuide.classList.remove("hidden");
      handFrameGuide.classList.toggle("is-arm-mode", combined);
      handGuideText.textContent = combined
        ? "Keep the working elbow, wrist and complete hand visible"
        : "Keep one complete hand inside this area";
      setupTip.textContent = combined
        ? "Combined mode · Upright phone · Working elbow and complete hand visible"
        : "Hand mode · One complete hand close to the camera";
    } else {
      setupTip.textContent = cameraSetupTip(engine.exercise);
    }
    toggleBtn.classList.remove("hidden");
    toggleBtn.innerHTML = 'Pause camera guide <span aria-hidden="true">Ⅱ</span>';
    toggleBtn.disabled = false;
    finishExerciseBtn.disabled = false;
    cameraSessionHintEl.textContent = handsFreeVoiceEnabled
      ? (
        "Camera tracking and AI questions are active together. Say “Hey Guide” "
        + "to ask something, or say “Hey Guide, I need a rest” to pause. "
        + "Choose Finish exercise and check in when done."
      )
      : (
        "Pausing only stops the camera. Choose “Finish exercise and check in” "
        + "when you decide you are done."
      );
    if (announceInstruction) {
      // Set the gate before the first rendered camera frame. Otherwise that
      // frame can be mistaken for a repetition while the user is still
      // repositioning and listening to the start instruction.
      movementTrackingPausedForInstruction = true;
      announceExerciseInstruction("", { onEnd: startMovementAiGuide });
    } else {
      startMovementAiGuide();
    }
    renderFrame();
    return true;
  } catch (err) {
    statusEl.textContent = `Camera error: ${err.message}`;
    toggleBtn.classList.add("hidden");
    toggleBtn.disabled = false;
    handTrackingToggle.disabled = !handLandmarker;
    return false;
  }
}

function deactivateCameraGuide({
  statusMessage = "Camera paused — exercise not marked finished",
} = {}) {
  stopRestResumeVoiceListening({ cancelListening: true });
  const defaultPause = statusMessage
    === "Camera paused — exercise not marked finished";
  const pauseMetric = goalMetric(engine.exercise);
  const pauseCount = pauseMetric.isHold
    ? Number(engine.repCount ?? 0) * pauseMetric.perHold
    : Number(engine.repCount ?? 0);
  const pauseProgressMessage = pauseMetric.goal === null
    ? "Your exercise is paused and has not been marked finished. Resume the camera or finish when you are ready."
    : pauseMetric.isHold
      ? (
        `I counted ${Math.min(pauseCount, pauseMetric.goal)} of ${pauseMetric.goal} seconds. `
        + "The exercise is paused and has not been marked finished. Keep every required joint visible and resume for any hold time that was not counted."
      )
      : (
        `I counted ${Math.min(pauseCount, pauseMetric.goal)} of ${pauseMetric.goal} repetitions. `
        + "The exercise is paused and has not been marked finished. Keep your full body visible and resume for any repetitions that were not counted."
      );
  running = false;
  movementTrackingPausedForInstruction = false;
  stopMovementAiGuide();
  clearExerciseCompletionConfirmation({ cancelListening: true });
  voiceGuidance.cancel();
  resetSpokenCoaching();
  cancelAnimationFrame(rafId);
  cancelCalibration();
  if (holdInterval) {
    clearHoldTimer(activeDose(engine.exercise).holdSeconds);
  }
  stopCamera();
  renderTrackingWarning(engine.exercise);
  combinedPoseHistory = [];
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  cameraStage?.classList.remove("camera-active");
  setIntegratedCameraGuideActive(false);
  handFrameGuide.classList.add("hidden");
  handFrameGuide.classList.remove("is-arm-mode");
  setupTip.textContent = cameraSetupTip(engine.exercise);
  toggleBtn.innerHTML = 'Pause camera guide <span aria-hidden="true">Ⅱ</span>';
  toggleBtn.classList.add("hidden");
  renderPrimaryCameraAction();
  finishExerciseBtn.disabled = !exerciseSessionActive;
  cameraSessionHintEl.textContent = exerciseSessionActive
    ? defaultPause
      ? pauseProgressMessage
      : "Your exercise is paused and has not been marked finished. Resume the camera or finish when you are ready."
    : "Stopping the camera does not mark an exercise as finished.";
  handTrackingToggle.disabled = !handLandmarker;
  statusEl.textContent = statusMessage;
  setFeedbackBanner("ready");
  renderFallReadiness(engine.exercise);

}

async function startHandPreview() {
  if (!hasLivePracticeAccess()) return false;
  if (running) return false;
  await ensureMovementModels(null, { handPreview: true });
  if (!handLandmarker) {
    statusEl.textContent = "The hand-tracking model is unavailable";
    setFeedbackBanner(
      "tracking",
      "Check your internet connection, then try the hand check again"
    );
    return false;
  }
  handPreviewMode = true;
  handTrackingToggle.disabled = true;
  toggleBtn.disabled = true;
  handTrackingReadout.classList.remove("hidden");
  handFrameGuide.classList.remove("hidden");
  handFrameGuide.classList.remove("is-arm-mode");
  handGuideText.textContent = "Keep one complete hand inside this area";
  setupTip.textContent = "Close-up mode · One full hand visible · Keep wrist and fingertips in frame";
  statusEl.textContent = "Starting close-up hand camera…";
  setFeedbackBanner("position", "Place one open hand inside the close-up guide");

  try {
    await startCamera();
    running = true;
    resetCameraInferenceClock();
    cameraStage?.classList.add("camera-active");
    handTrackingToggle.textContent = "Stop hand check";
    handTrackingToggle.disabled = false;
    renderFrame();
    return true;
  } catch (error) {
    handPreviewMode = false;
    handFrameGuide.classList.add("hidden");
    handTrackingReadout.classList.add("hidden");
    setupTip.textContent = "Phone at chest height · 2–3 m away · Full body visible";
    statusEl.textContent = `Camera error: ${error.message}`;
    handTrackingToggle.disabled = false;
    toggleBtn.disabled = false;
    return false;
  }
}

function stopHandPreview() {
  running = false;
  handPreviewMode = false;
  cancelAnimationFrame(rafId);
  stopCamera();
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  cameraStage?.classList.remove("camera-active");
  handFrameGuide.classList.add("hidden");
  handFrameGuide.classList.remove("is-arm-mode");
  handTrackingReadout.classList.add("hidden");
  resetHandReadout();
  setupTip.textContent = "Phone at chest height · 2–3 m away · Full body visible";
  handTrackingToggle.textContent = "Check hand tracking";
  handTrackingToggle.disabled = false;
  toggleBtn.classList.add("hidden");
  toggleBtn.disabled = false;
  statusEl.textContent = "Movement guide ready";
  setFeedbackBanner("ready");
}

// A camera and MediaPipe render loop should never keep running in a tab that
// the patient can no longer see. This also prevents duplicated Safari tabs
// from competing for the camera/GPU and making the browser or laptop hot.
document.addEventListener("visibilitychange", () => {
  if (!document.hidden || !running) return;
  if (handPreviewMode) {
    stopHandPreview();
    return;
  }
  deactivateCameraGuide({
    statusMessage: "Camera paused because this tab is no longer active",
  });
});

// Safari can restore a page from its back-forward cache without rebuilding the
// JavaScript context. Treat that restoration like a fresh page so the patient
// is offered the response-mode choice again on the next camera-guide start.
window.addEventListener("pagehide", resetVoiceModeChoice);
window.addEventListener("pageshow", (event) => {
  if (event.persisted) resetVoiceModeChoice();
});

function clearSessionMeasurements() {
  Object.keys(sessionAngleStats).forEach(k => delete sessionAngleStats[k]);
  sessionCoachingQuality.reset();
  sessionCoachingQuality.configureRules(engine?.exercise?.cues ?? {});
  sessionTrackingStats.totalFrames = 0;
  sessionTrackingStats.assessableFrames = 0;
  sessionTrackingStats.limitedTrackingFrames = 0;
  sessionTrackingStats.missingMeasurements = {};
}

function resetSetProgress() {
  clearEarlyStopPrompt({ cancelListening: true });
  pendingEarlyStopReason = "";
  completedSetCount = 0;
  completedSessionReps = 0;
  pendingSetStartCheck = null;
  sessionAllSetsComplete = false;
  lastFeedbackResult = null;
  pendingExerciseCompletionAnnouncement = null;
  finalRepReturnPromptedSetKey = "";
  finalRepReturnPendingSetKey = "";
}

function resetExerciseProgressForNewSession() {
  clearExerciseCompletionConfirmation({ cancelListening: true });
  resetSetProgress();
  engine.changeExercise(
    exSelect.value,
    sideSelect.value,
    getCalibration(exSelect.value, sideSelect.value)
  );
  smoother.state = {};
  repTrackingSmoother.state = {};
  combinedPoseHistory = [];
  if (holdInterval) {
    clearHoldTimer(activeDose(engine.exercise).holdSeconds);
  }
  holdTimerSection.classList.add("hidden");
  progressSection.classList.remove("hidden");
  repCountEl.textContent = "0";
  renderCameraRepProgress(engine.exercise, 0);
  setCompleteBadgeEl?.classList.add("hidden");
  cueListEl.innerHTML = "";
  symWarnEl.classList.add("hidden");
  progressEl.style.width = "0%";
  progressLbl.textContent = "Position yourself to start";
  renderPoseStrip(engine.exercise, engine.stages[0]);
  renderStaticPhaseFlow(engine);
  resetSpokenCoaching();
  setFeedbackBanner("ready");
}

function beginExerciseSession() {
  if (exerciseSessionActive) return;
  resetExerciseProgressForNewSession();
  exerciseSessionActive = true;
  sessionStartedAt = new Date().toISOString();
  clearSessionMeasurements();
}

function discardExerciseSession() {
  cancelCameraSetupCountdown({ announce: false });
  clearExerciseCompletionConfirmation({ cancelListening: true });
  stopRestResumeVoiceListening({ cancelListening: true });
  exerciseSessionActive = false;
  sessionStartedAt = null;
  resetSetProgress();
  clearSessionMeasurements();
  finishExerciseBtn.disabled = true;
  cameraSessionHintEl.textContent =
    "Stopping the camera does not mark an exercise as finished.";
  renderPrimaryCameraAction();
}

function completeExerciseSession({ stopReason = pendingEarlyStopReason } = {}) {
  const progress = currentSessionDoseProgress();
  const totalRepsCompleted = progress.repetitionsCompleted;
  const totalSetsCompleted = progress.setsCompleted;
  const shouldRecord =
    exerciseSessionActive &&
    isPracticeAccountAuthenticated() &&
    Boolean(sessionStartedAt);

  if (!shouldRecord) {
    discardExerciseSession();
    completedExerciseSessionPromise = Promise.resolve(null);
    return completedExerciseSessionPromise;
  }

  const endedAt = new Date().toISOString();
  const ex = engine.exercise;
  const dose = activeDose(ex);
  sessionCoachingQuality.finish(totalRepsCompleted);
  const cuesTriggered = sessionCoachingQuality.cuesForPersistence();
  const assessmentSummary = buildSessionAssessmentSummary({
    cuesTriggered,
    repetitionsCompleted: totalRepsCompleted,
    repetitionsMinimum: progress.repetitionsMinimum ?? dose.reps ?? 0,
    repetitionsTarget: dose.reps ?? totalRepsCompleted,
    setsCompleted: totalSetsCompleted,
    setsTarget: progress.setsTarget ?? dose.sets ?? 1,
    tracking: sessionTrackingStats,
    stopReason: EARLY_STOP_REASONS.has(stopReason) ? stopReason : "",
  });
  const angleSummaries = {};
  Object.entries(sessionAngleStats).forEach(([key, s]) => {
    if (s.count > 0) {
      angleSummaries[key] = {
        min:  Math.round(s.min * 10) / 10,
        max:  Math.round(s.max * 10) / 10,
        mean: Math.round((s.sum / s.count) * 10) / 10,
      };
    }
  });

  const sessionPayload = {
    exercise:                ex.id,
    prescription:            dose.id ?? null,
    started_at:              sessionStartedAt,
    ended_at:                endedAt,
    sets_completed:          totalSetsCompleted,
    reps_completed:          totalRepsCompleted,
    reps_target:             dose.reps ?? totalRepsCompleted,
    reps_minimum:            progress.repetitionsMinimum ?? dose.reps ?? null,
    sets_target:             dose.sets ?? 1,
    stop_reason:             EARLY_STOP_REASONS.has(stopReason) ? stopReason : "",
    affected_side:           sideSelect.value || profile.focusSide || "right",
    cues_triggered:          cuesTriggered,
    // Symmetry is coached through the same reminder flow when it is reliable;
    // it is not a second, hidden deduction path.
    symmetry_warnings_count: 0,
    low_confidence_frames_pct:
      assessmentSummary.tracking_validity.low_confidence_frames_pct,
    angle_summaries:         angleSummaries,
    assessment_summary:      assessmentSummary,
    notes:                   serializePlannedSessionNote({
      sessionKey: activeSessionKey,
      sessionDay: activeSessionDay,
      sessionTitle: activeSessionTitle,
    }),
  };
  completedExerciseSessionSnapshot = {
    ...sessionPayload,
    exercise_name: ex.name,
    stop_requires_review: ["dizzy", "breathless"].includes(
      sessionPayload.stop_reason,
    ),
  };
  completedExerciseSessionError = null;
  completedExerciseCheckinLinkError = false;
  const beforeCheckinPromise = activePreExerciseCheckinPromise;
  completedExerciseSessionPromise = postSession(sessionPayload)
    .then(async (createdSession) => {
      if (beforeCheckinPromise) {
        const beforeCheckin = await beforeCheckinPromise;
        const linkedCheckin = beforeCheckin?.id
          ? await updatePainCheckin(beforeCheckin.id, {
            session: createdSession.id,
          }).catch(() => null)
          : null;
        completedExerciseCheckinLinkError = !linkedCheckin;
      }
      return createdSession;
    })
    .catch((error) => {
      completedExerciseSessionError = error;
      return null;
    });

  discardExerciseSession();
  return completedExerciseSessionPromise;
}

// ── Pain check-in ─────────────────────────────────────────────────────────────
const painCheckinEl = document.getElementById("painCheckin");
const painSkipBtn   = document.getElementById("painSkip");
const painCheckinContextEl = document.getElementById("painCheckinContext");
const painCheckinTitleEl = document.getElementById("painCheckinTitle");
const painLevelChoicesEl = document.getElementById("painLevelChoices");
const painConfirmationEl = document.getElementById("painConfirmation");
const painConfirmationSummaryEl = document.getElementById("painConfirmationSummary");
const recoveryChoicesEl = document.getElementById("recoveryChoices");
const painSafetyInterviewEl = document.getElementById("painSafetyInterview");
const painSafetyReassuranceEl = document.getElementById("painSafetyReassurance");
const painSafetyHeadingEl = document.getElementById("painSafetyHeading");
const painSafetyMessageEl = document.getElementById("painSafetyMessage");
const painSafetyQuestionEl = document.getElementById("painSafetyQuestion");
const painSafetyHelpEl = document.getElementById("painSafetyHelp");
const painSafetyChoicesEl = document.getElementById("painSafetyChoices");
const voiceCheckinStatusEl = document.getElementById("voiceCheckinStatus");
const painVoiceInputBtn = document.getElementById("painVoiceInput");
const recordedPainEl = document.getElementById("recordedPain");
const recordedPainContextEl = document.getElementById("recordedPainContext");
const recordedPainMessageEl = document.getElementById("recordedPainMessage");
const recordedPainValueEl = document.getElementById("recordedPainValue");
const exerciseTransitionModalEl = document.getElementById("exercise-transition-modal");
const exerciseTransitionContextEl = document.getElementById("exerciseTransitionContext");
const exerciseTransitionTitleEl = document.getElementById("exerciseTransitionTitle");
const exerciseTransitionMessageEl = document.getElementById("exerciseTransitionMessage");
const exerciseTransitionStatusEl = document.getElementById("exerciseTransitionStatus");
const exerciseTransitionContinueEl = document.getElementById("exerciseTransitionContinue");
const exerciseTransitionHomeEl = document.getElementById("exerciseTransitionHome");
const sessionSummaryModalEl = document.getElementById("session-summary-modal");
const sessionSummaryTitleEl = document.getElementById("sessionSummaryTitle");
const sessionSummaryScopeEl = document.getElementById("sessionSummaryScope");
const sessionSummaryCompletedEl = document.getElementById("sessionSummaryCompleted");
const sessionSummaryTrackingEl = document.getElementById("sessionSummaryTracking");
const sessionSummaryQualityEl = document.getElementById("sessionSummaryQuality");
const sessionSummaryPainEl = document.getElementById("sessionSummaryPain");
const sessionSummaryRecoveryEl = document.getElementById("sessionSummaryRecovery");
const sessionSummaryTrendEl = document.getElementById("sessionSummaryTrend");
const sessionSummaryCueEl = document.getElementById("sessionSummaryCue");
const sessionSummaryStatusEl = document.getElementById("sessionSummaryStatus");
let exerciseTransitionNextExerciseId = null;
let painCheckinState = null;
let painSafetyRestTimer = null;
let painVoiceFallbackNeeded = false;
const PAIN_PROMPT_VOICE_GROUP = MOVEMENT_GUIDE_VOICE_GROUP;
const PAIN_PROMPT_RATE = MOVEMENT_GUIDE_RATE;
const PAIN_PROMPT_PITCH = MOVEMENT_GUIDE_PITCH;

function painQuestion(context, stopReason = painCheckinState?.stopReason) {
  return context === "before"
    ? "Before we begin, how is your pain right now? Please give me a number from zero to ten."
    : stopReason
      ? "You stopped the exercise. How is your pain now? Please give me a number from zero to ten."
    : "You’ve finished the exercise. How is your pain now? Please give me a number from zero to ten.";
}

function recoveryQuestion(context) {
  return context === "before"
    ? "Compared with your previous session, is your recovery better, about the same, worse, or are you not sure?"
    : "Compared with before this exercise, do you feel better, about the same, worse, or are you not sure?";
}

function painConfirmationQuestion(level) {
  if (
    painCheckinState?.context === "after" &&
    Number.isInteger(confirmedPreExercisePain)
  ) {
    return `I heard that your pain is now ${level} out of 10. Before it was ${confirmedPreExercisePain}. Is that correct?`;
  }
  return `I heard that your pain is ${level} out of 10. Is that correct?`;
}

function spokenPainConfirmationQuestion(level) {
  if (
    painCheckinState?.context === "after"
    && Number.isInteger(confirmedPreExercisePain)
  ) {
    // The exact before/after numbers remain visible. A fixed spoken prompt
    // avoids 121 audio variants and keeps the response immediate.
    return "Please confirm the pain levels shown on screen. Say yes or change.";
  }
  return painConfirmationQuestion(level);
}

const PAIN_SAFETY_REASSURANCE =
  "Thank you. I will ask a few short questions to help check whether it is safe "
  + "for you to proceed. Please stop moving and rest somewhere safe.";

const PAIN_SAFETY_STEPS = Object.freeze({
  urgent: {
    question:
      "Are you experiencing chest pressure, unusual shortness of breath, "
      + "dizziness, faintness, sudden weakness or numbness, or have you fallen?",
    help:
      "Choose Yes if any one of these applies. Choose Yes or Not sure and I "
      + "will ask about each warning sign separately so the reason is recorded.",
    choices: [
      ["no", "No, none of these"],
      ["yes", "Yes"],
      ["unsure", "Not sure"],
    ],
    field: "urgentCombined",
    next: "location",
  },
  "urgent-chest": {
    question:
      "Right now, do you have chest pressure, squeezing, tightness, heaviness, "
      + "or chest pain?",
    help: "Answer only about what you feel now. Choose Not sure if it is unclear.",
    choices: [
      ["no", "No"],
      ["yes", "Yes"],
      ["unsure", "Not sure"],
    ],
    field: "urgentChest",
    next: "urgent-breathing",
  },
  "urgent-breathing": {
    question:
      "Are you unusually short of breath or having difficulty breathing right now?",
    help: "Compare this with the breathing you normally expect from this activity.",
    choices: [
      ["no", "No"],
      ["yes", "Yes"],
      ["unsure", "Not sure"],
    ],
    field: "urgentBreathing",
    next: "urgent-neurologic",
  },
  "urgent-neurologic": {
    question:
      "Do you feel dizzy or faint, or have sudden weakness or numbness right now?",
    help: "Choose Yes if any one of these applies.",
    choices: [
      ["no", "No"],
      ["yes", "Yes"],
      ["unsure", "Not sure"],
    ],
    field: "urgentNeurologic",
    next: "urgent-fall",
  },
  "urgent-fall": {
    question: "Did you fall just before or during this exercise?",
    help: "Choose Yes even if you stood up again without help.",
    choices: [
      ["no", "No"],
      ["yes", "Yes"],
      ["unsure", "Not sure"],
    ],
    field: "urgentFall",
    next: "location",
  },
  location: {
    question: "Where are you feeling the pain?",
    help: "Choose the area that best matches what you feel now.",
    choices: [
      ["knee", "Knee"],
      ["hip", "Hip"],
      ["ankle", "Ankle or foot"],
      ["back", "Back"],
      ["shoulder", "Shoulder or arm"],
      ["other", "Other area"],
    ],
    field: "painLocation",
    next: "side",
  },
  side: {
    question: "Which side is affected?",
    help: "Choose Not sure if the pain is central or difficult to locate.",
    choices: [
      ["left", "Left side"],
      ["right", "Right side"],
      ["both", "Both sides"],
      ["unsure", "Not sure"],
    ],
    field: "painSide",
    next: "familiarity",
  },
  familiarity: {
    question:
      "Is this new pain, your usual pain becoming stronger, or something different "
      + "from what you normally feel?",
    help: "This does not diagnose the pain. It helps record what changed.",
    choices: [
      ["new", "New pain"],
      ["usual-stronger", "Usual pain, but stronger"],
      ["different", "Something different"],
      ["unsure", "Not sure"],
    ],
    field: "painFamiliarity",
    next: "timing",
  },
  timing: {
    question: "When did the pain increase?",
    help:
      "PhysioVision will record the current exercise, set, and repetition automatically.",
    choices: [
      ["before", "Before I started"],
      ["during", "During this exercise"],
      ["after", "Immediately after"],
      ["unsure", "Not sure"],
    ],
    field: "onsetTiming",
    next: "rest",
  },
  rest: {
    question:
      "Now that you have stopped and rested briefly, is the pain getting better, "
      + "staying the same, or getting worse?",
    help: "Stay resting while you answer.",
    choices: [
      ["better", "Getting better"],
      ["same", "Staying the same"],
      ["worse", "Getting worse"],
      ["unsure", "Not sure"],
    ],
    field: "restTrend",
    next: "mobility",
  },
  mobility: {
    question: "Can you sit, stand, or move to a safe position without assistance?",
    help: "Do not test a movement that feels unsafe just to answer this question.",
    choices: [
      ["safe", "Yes, safely"],
      ["nearby", "I need someone nearby"],
      ["help", "No, I need help"],
    ],
    field: "safeMovement",
    next: "outcome",
  },
});

function isPainSafetyStage(stage = painCheckinState?.stage) {
  return typeof stage === "string" && stage.startsWith("safety-");
}

function updatePainCheckinPresentation() {
  const safetyActive = isPainSafetyStage();
  const safetyOutcome = painCheckinState?.stage === "safety-outcome";
  const safetyRestPause = painCheckinState?.stage === "safety-rest-pause";
  painCheckinEl.classList.toggle(
    "hands-free-checkin",
    handsFreeVoiceEnabled && !painVoiceFallbackNeeded && !safetyActive
  );
  painCheckinEl.classList.toggle("safety-interview-active", safetyActive);
  painVoiceInputBtn.classList.toggle(
    "hidden",
    (handsFreeVoiceEnabled && !painVoiceFallbackNeeded)
      || safetyOutcome
      || safetyRestPause
  );
  painVoiceInputBtn.disabled = !voiceGuidance.canListen || safetyRestPause;
}

function showPainVoiceFallback() {
  painVoiceFallbackNeeded = true;
  updatePainCheckinPresentation();
}

function cancelCameraSetupCountdown({ announce = true } = {}) {
  if (!cameraSetupCountdown) return false;
  window.clearInterval(cameraSetupCountdown.timer);
  cameraSetupCountdown = null;
  voiceGuidance.cancel();
  cameraSetupStatus.hidden = true;
  cameraSetupStatus.textContent = "";
  statusEl.textContent = "Camera setup cancelled";
  setFeedbackBanner("ready", "Camera setup cancelled. Start again when you are ready.");
  renderPrimaryCameraAction();
  if (announce) {
    speakMovementGuide("Camera setup cancelled. Start again when you are ready.", {
      key: "camera-setup:countdown:cancelled",
      interrupt: true,
    });
  }
  return true;
}

function startCameraSetupAfterCountdown(completed) {
  if (completed.continuation === "calibration") {
    void startCalibrationFlow(completed.calibrationTrigger);
  } else if (completed.continuation === "camera" || completed.startAfter) {
    void activateCameraGuide();
  }
}

function continueAfterPainCheckin(completed) {
  if (!(completed?.continuation || completed?.startAfter)) return;
  if (!Number.isInteger(completed.painLevel)) {
    startCameraSetupAfterCountdown(completed);
    return;
  }
  cancelCameraSetupCountdown({ announce: false });
  cameraSetupCountdown = {
    completed,
    secondsRemaining: 3,
    timer: null,
  };
  cameraSetupStatus.hidden = false;
  cameraSetupStatus.textContent =
    "Camera setup will begin automatically in 3 seconds. You can cancel below.";
  statusEl.textContent = "Pain level confirmed — camera setup starts in 3 seconds";
  setFeedbackBanner(
    "position",
    "Pain level confirmed. Stay near your device so you can allow camera access if asked."
  );
  renderPrimaryCameraAction();
  const beginVisibleCountdown = () => {
    if (!cameraSetupCountdown || cameraSetupCountdown.timer) return;
    cameraSetupCountdown.timer = window.setInterval(() => {
      if (!cameraSetupCountdown) return;
      cameraSetupCountdown.secondsRemaining -= 1;
      if (cameraSetupCountdown.secondsRemaining > 0) {
        cameraSetupStatus.textContent =
          `Camera setup will begin automatically in ${cameraSetupCountdown.secondsRemaining} seconds. You can cancel below.`;
        renderPrimaryCameraAction();
        return;
      }
      const pending = cameraSetupCountdown.completed;
      window.clearInterval(cameraSetupCountdown.timer);
      cameraSetupCountdown = null;
      cameraSetupStatus.hidden = true;
      cameraSetupStatus.textContent = "";
      renderPrimaryCameraAction();
      // A delayed or unusually long audio clip must not start speaking across
      // the browser's camera permission prompt.
      voiceGuidance.cancel();
      startCameraSetupAfterCountdown(pending);
    }, 1000);
  };
  // The visible countdown begins now. Speech playback is supplementary and
  // can never hold camera setup in the three-second state.
  beginVisibleCountdown();
  const heardPainLevel = Number.isInteger(completed.painLevel)
    ? `I heard pain level ${completed.painLevel} out of 10.`
    : "";
  const cameraStartAnnouncement = localizedGuidanceParts([
    heardPainLevel,
    "Camera setup is starting now. Stay near your device.",
  ]);
  speakMovementGuide(
    cameraStartAnnouncement,
    {
      key: `camera-setup:countdown:${completed.context}`,
      interrupt: true,
      allowGeneratedSpeech: true,
      voiceGroup: PAIN_PROMPT_VOICE_GROUP,
      rate: PAIN_PROMPT_RATE,
      pitch: PAIN_PROMPT_PITCH,
      onUnavailable: () => {},
    }
  );
}

function renderRecordedPain({ painLevel, context }) {
  if (!Number.isInteger(painLevel) || painLevel < 0 || painLevel > 10) return;

  recordedPainEl.classList.remove("hidden", "is-moderate", "is-high");
  if (painLevel >= 7) recordedPainEl.classList.add("is-high");
  else if (painLevel >= 4) recordedPainEl.classList.add("is-moderate");

  recordedPainContextEl.textContent =
    context === "after" ? "After exercise pain" : "Before exercise pain";
  recordedPainMessageEl.textContent = `Pain level ${painLevel} recorded`;
  recordedPainValueEl.textContent = String(painLevel);
  recordedPainEl.setAttribute(
    "aria-label",
    `${recordedPainContextEl.textContent}: pain level ${painLevel} out of 10 recorded`
  );
}

function clearRecordedPain() {
  recordedPainEl.classList.add("hidden");
  recordedPainEl.classList.remove("is-moderate", "is-high");
  recordedPainEl.removeAttribute("aria-label");
}

function acknowledgeRecordedPain(completed) {
  const level = completed.painLevel;
  const acknowledgement =
    `Thank you. I have recorded your pain level as ${level} out of 10.`;
  speakMovementGuide(acknowledgement, {
    key: `checkin:${completed.context}:recorded:${level}`,
    interrupt: true,
  });
}

function recordPainLanguageInterpretation(stage, interpretation) {
  const answers = painCheckinState?.safetyAnswers;
  if (!answers || !interpretation?.matched) return;
  answers.languageInterpretations.push({
    stage,
    response: interpretation.response,
    facts: Array.isArray(interpretation.facts)
      ? interpretation.facts.slice(0, 8)
      : [],
    summary: String(interpretation.summary || "").slice(0, 180),
    source: "gemini_constrained_language",
  });
}

async function interpretPainSafetyTranscript(stage, transcript) {
  const expectedState = painCheckinState;
  const expectedStage = `safety-${stage}`;
  if (!expectedState || expectedState.stage !== expectedStage) return;
  const attempts = expectedState.languageInterpretationAttempts;
  if ((attempts[stage] ?? 0) >= 1) {
    showPainVoiceFallback();
    voiceCheckinStatusEl.textContent =
      "I still could not match that answer. Please use one of the large choices.";
    return;
  }
  attempts[stage] = (attempts[stage] ?? 0) + 1;
  voiceCheckinStatusEl.textContent =
    `I heard: “${transcript}” Checking what you meant…`;
  try {
    const interpretation = await interpretSafetyLanguage({
      stage,
      transcript,
    });
    if (
      painCheckinState !== expectedState
      || expectedState.stage !== expectedStage
    ) {
      return;
    }
    if (interpretation?.matched && interpretation.response) {
      recordPainLanguageInterpretation(stage, interpretation);
      voiceCheckinStatusEl.textContent =
        "Your answer was matched to one of the safety choices.";
      acceptPainSafetyResponse(interpretation.response);
      return;
    }
    showPainVoiceFallback();
    const retryPrompt = String(interpretation?.retry_prompt || "").trim();
    voiceCheckinStatusEl.textContent = retryPrompt
      || "I could not match that answer. Please use a large choice.";
    if (handsFreeVoiceEnabled && retryPrompt) {
      speakPainPrompt(
        retryPrompt,
        `checkin:${expectedState.context}:safety:${stage}:simpler`,
        expectedStage,
        { rate: 0.97 }
      );
    }
  } catch (_) {
    if (
      painCheckinState === expectedState
      && expectedState.stage === expectedStage
    ) {
      showPainVoiceFallback();
      voiceCheckinStatusEl.textContent =
        "The language helper is unavailable. Please use one of the large choices.";
    }
  }
}

function startPainVoiceListening({ expectedStage = null } = {}) {
  if (
    !painCheckinState ||
    (expectedStage && painCheckinState.stage !== expectedStage)
  ) {
    return false;
  }

  painVoiceFallbackNeeded = false;
  updatePainCheckinPresentation();
  return voiceGuidance.listen({
    onStatus: (status) => {
      voiceCheckinStatusEl.textContent = status;
    },
    onError: (message) => {
      showPainVoiceFallback();
      voiceCheckinStatusEl.textContent =
        `${message} You can also use the large on-screen choices.`;
    },
    onResult: (transcript) => {
      voiceCheckinStatusEl.textContent = `I heard: “${transcript}”`;
      if (painCheckinState?.stage === "pain") {
        const level = parsePainLevel(transcript);
        if (!Number.isInteger(level)) showPainVoiceFallback();
        acceptPainLevel(level);
      } else if (painCheckinState?.stage === "confirm-pain") {
        const confirmation = parseConfirmationResponse(transcript);
        if (!confirmation) showPainVoiceFallback();
        acceptPainConfirmation(confirmation);
      } else if (isPainSafetyStage()) {
        const stage = painCheckinState.stage.replace("safety-", "");
        if (stage !== "outcome") {
          const parsedResponse = parsePainSafetyResponse(stage, transcript);
          if (stage === "location" && transcript.trim()) {
            painCheckinState.safetyAnswers.painLocationDescription =
              transcript.trim().slice(0, 200);
          }
          if (parsedResponse) {
            acceptPainSafetyResponse(parsedResponse);
          } else {
            void interpretPainSafetyTranscript(stage, transcript);
          }
        }
      } else {
        const recovery = parseRecoveryStatus(transcript);
        if (!recovery) showPainVoiceFallback();
        acceptRecoveryStatus(recovery);
      }
    },
  });
}

function speakPainPrompt(
  question,
  key,
  expectedStage,
  { rate = PAIN_PROMPT_RATE, pitch = PAIN_PROMPT_PITCH } = {}
) {
  const beginListening = () => {
    if (
      handsFreeVoiceEnabled &&
      painCheckinState?.stage === expectedStage
    ) {
      startPainVoiceListening({ expectedStage });
    }
  };
  const spoken = speakMovementGuide(question, {
    key,
    interrupt: true,
    // Keep the initial question and every follow-up on the same Gemini voice.
    voiceGroup: PAIN_PROMPT_VOICE_GROUP,
    allowGeneratedSpeech: true,
    rate: Number.isFinite(rate) ? rate : PAIN_PROMPT_RATE,
    pitch: Number.isFinite(pitch) ? pitch : PAIN_PROMPT_PITCH,
    onUnavailable: () => {
      if (painCheckinState?.stage === expectedStage) {
        voiceCheckinStatusEl.textContent =
          "Voice audio did not load. Listening is starting now; you can also use the on-screen choices.";
      }
    },
    onEnd: () => armVoiceListening(beginListening),
  });
  if (!spoken && handsFreeVoiceEnabled) {
    beginListening();
  }
}

function showPainCheckin(context = "after", {
  startAfter = false,
  continuation = "",
  calibrationTrigger = null,
  forceSafetyInterview = false,
  stopReason = "",
} = {}) {
  if (!isPracticeAccountAuthenticated()) {
    continueAfterPainCheckin({
      startAfter,
      continuation,
      calibrationTrigger,
    });
    return;
  }

  // Every new page/account session must make an explicit response-mode choice
  // before any pain question appears, including less-common restored flows.
  if (!voiceModeChosenThisSession) {
    void ensureVoiceModeChosen().then((chosen) => {
      if (chosen) {
        showPainCheckin(context, {
          startAfter,
          continuation,
          calibrationTrigger,
          forceSafetyInterview,
          stopReason,
        });
      }
    });
    return;
  }

  if (context === "before") {
    clearRecordedPain();
    activePreExerciseCheckinPromise = null;
    completedExerciseSessionPromise = null;
    completedExerciseSessionSnapshot = null;
    completedExerciseSessionError = null;
    completedExerciseCheckinLinkError = false;
  }

  painCheckinState = {
    context,
    startAfter,
    continuation,
    calibrationTrigger,
    forceSafetyInterview: Boolean(forceSafetyInterview),
    stopReason: EARLY_STOP_REASONS.has(stopReason) ? stopReason : "",
    stage: "pain",
    painLevel: null,
    recoveryStatus: "",
    safetyAnswers: null,
    languageInterpretationAttempts: {},
  };
  painVoiceFallbackNeeded = false;
  painCheckinContextEl.textContent = context === "before"
    ? "Before exercise"
    : stopReason
      ? "After stopping"
      : "After exercise";
  painCheckinTitleEl.innerHTML =
    `${escapeHtml(painQuestion(context, stopReason))} <span>(0 = none, 10 = severe)</span>`;
  painLevelChoicesEl.classList.remove("hidden");
  painConfirmationEl.classList.add("hidden");
  recoveryChoicesEl.classList.add("hidden");
  painSafetyInterviewEl.classList.add("hidden");
  painSkipBtn.classList.remove("hidden");
  voiceCheckinStatusEl.textContent = handsFreeVoiceEnabled
    ? (
      "Hands-free voice is on. Listen to the question, then say "
      + "a number from zero to ten."
    )
    : voiceGuidance.canListen
      ? "Choose a number, or use Answer by voice as a fallback."
    : "Voice input is unavailable in this browser. Choose a button.";
  updatePainCheckinPresentation();
  painCheckinEl.classList.remove("hidden");
  statusEl.textContent = context === "before"
    ? "Pain check ready — please answer"
    : "Check-in ready — please answer";
  if (startAfter || continuation) toggleBtn.disabled = true;

  if (context === "before" && (startAfter || continuation)) {
    cameraSetupStatus.textContent = handsFreeVoiceEnabled
      ? "Pain question ready. Answer aloud or choose a number to continue."
      : "Choose your pain level in the exercise panel to continue.";
    cameraSetupStatus.hidden = false;
  }

  // Reveal the question before speech synthesis or model loading can delay it.
  window.requestAnimationFrame(() => {
    painCheckinEl.scrollIntoView({ behavior: "auto", block: "start" });
    if (!handsFreeVoiceEnabled) {
      painLevelChoicesEl
        .querySelector("button:not([disabled])")
        ?.focus({ preventScroll: true });
    }
  });

  speakPainPrompt(
    painQuestion(context, stopReason),
    `checkin:${context}:pain`,
    "pain"
  );
}

function hidePainCheckin() {
  clearPainSafetyRestPause();
  voiceGuidance.cancel();
  painCheckinEl.classList.add("hidden");
  painCheckinEl.classList.remove(
    "hands-free-checkin",
    "safety-interview-active"
  );
  painSafetyInterviewEl.classList.add("hidden");
  voiceCheckinStatusEl.textContent = "";
  painVoiceFallbackNeeded = false;
  painCheckinState = null;
  toggleBtn.disabled = false;
}

function shouldAskRecovery() {
  return painCheckinState?.context === "after";
}

function beginRecoveryQuestion() {
  if (!painCheckinState) return;
  voiceGuidance.cancel();
  painCheckinState.stage = "recovery";
  painLevelChoicesEl.classList.add("hidden");
  painConfirmationEl.classList.add("hidden");
  recoveryChoicesEl.classList.remove("hidden");
  painSafetyInterviewEl.classList.add("hidden");
  painSkipBtn.classList.remove("hidden");
  updatePainCheckinPresentation();
  painCheckinTitleEl.textContent = recoveryQuestion(painCheckinState.context);
  voiceCheckinStatusEl.textContent = handsFreeVoiceEnabled
    ? "Listening will start after the question. Say better, same, worse, or not sure."
    : voiceGuidance.canListen
      ? "Choose an answer, or use Answer by voice as a fallback."
    : "Choose the answer that fits best.";
  speakPainPrompt(
    recoveryQuestion(painCheckinState.context),
    `checkin:${painCheckinState.context}:recovery`,
    "recovery"
  );
}

function painCheckinPayload(completed, sessionId = null) {
  return {
    ...(sessionId ? { session: sessionId } : {}),
    pain_level: completed.painLevel,
    timing: completed.context,
    recovery_status: completed.recoveryStatus,
    checked_at: new Date().toISOString(),
  };
}

function apiResults(data) {
  return data?.results ?? data ?? [];
}

function recoveryLabel(status) {
  return {
    better: "Better",
    same: "About the same",
    worse: "Worse",
    unsure: "Not sure",
  }[status] ?? "Not recorded";
}

function painResponseLabel(beforePain, afterPain) {
  if (!Number.isInteger(beforePain) || !Number.isInteger(afterPain)) {
    return "Not enough information";
  }
  const change = afterPain - beforePain;
  if (change === 0) return `No change · ${afterPain}/10`;
  return change > 0
    ? `${change} point increase · ${afterPain}/10`
    : `${Math.abs(change)} point decrease · ${afterPain}/10`;
}

function exerciseDisplayName(exerciseId) {
  const normalizedId = String(exerciseId ?? "");
  if (
    normalizedId
    && normalizedId === String(completedExerciseSessionSnapshot?.exercise ?? "")
  ) {
    return completedExerciseSessionSnapshot?.exercise_name ?? normalizedId;
  }
  return EXERCISES.find((exercise) => exercise.id === normalizedId)?.name
    ?? normalizedId
    ?? "Exercise";
}

function plannedSessionProgressAfterCurrent() {
  const exerciseIds = [...new Set(
    activeSessionExerciseIds.map((exerciseId) => String(exerciseId)).filter(Boolean)
  )];
  const currentExerciseId = String(
    completedExerciseSessionSnapshot?.exercise ?? engine?.exercise?.id ?? ""
  );
  const completedExerciseIds = new Set(activeSessionCompletedExerciseIds);
  if (
    currentExerciseId
    && exerciseIds.includes(currentExerciseId)
    && sessionReachedTarget(completedExerciseSessionSnapshot)
  ) {
    completedExerciseIds.add(currentExerciseId);
  }
  const nextExerciseId = exerciseIds.find(
    (exerciseId) => !completedExerciseIds.has(exerciseId)
  ) ?? null;
  const completedCount = exerciseIds.filter(
    (exerciseId) => completedExerciseIds.has(exerciseId)
  ).length;
  return {
    enabled: Boolean(activeSessionKey && exerciseIds.length > 1),
    exerciseIds,
    completedExerciseIds,
    completedCount,
    totalExercises: exerciseIds.length,
    currentExerciseId,
    nextExerciseId,
  };
}

function openExerciseTransition(progress, painLevel) {
  stopExerciseTransitionVoiceListening({ cancelListening: true });
  const currentExerciseName = exerciseDisplayName(progress.currentExerciseId);
  const nextExerciseName = exerciseDisplayName(progress.nextExerciseId);
  exerciseTransitionNextExerciseId = progress.nextExerciseId;
  exerciseTransitionPainBaseline = painBaselineForNextExercise({
    nextExerciseId: progress.nextExerciseId,
    painLevel,
  });
  exerciseTransitionContextEl.textContent = activeSessionDay
    ? `${translateText(activeSessionDay)} ${translateText("session")}`
    : translateText("Today’s session");
  exerciseTransitionTitleEl.textContent = (
    `${translateText(currentExerciseName)} ${translateText("complete")} — `
    + `${progress.completedCount} ${translateText("of")} ${progress.totalExercises} `
    + translateText("exercises")
  );
  exerciseTransitionMessageEl.textContent = (
    `${translateText(currentExerciseName)} ${translateText("is being saved.")} `
    + `${translateText("Continue with")} ${translateText(nextExerciseName)} `
    + translateText("when you are ready.")
  );
  exerciseTransitionStatusEl.textContent = translateText("Saving result…");
  exerciseTransitionStatusEl.classList.remove("is-error");
  exerciseTransitionContinueEl.disabled = true;
  exerciseTransitionContinueEl.replaceChildren(document.createTextNode(
    `${translateText("Continue to")} ${translateText(nextExerciseName)} `
  ));
  const arrow = document.createElement("span");
  arrow.setAttribute("aria-hidden", "true");
  arrow.textContent = "→";
  exerciseTransitionContinueEl.appendChild(arrow);
  exerciseTransitionHomeEl.disabled = true;
  exerciseTransitionModalEl?.classList.add("is-open");
  exerciseTransitionModalEl?.setAttribute("aria-hidden", "false");
  document.body.classList.add("modal-open");
  exerciseTransitionTitleEl?.focus({ preventScroll: true });
}

function closeExerciseTransition({ retainPainBaseline = false } = {}) {
  stopExerciseTransitionVoiceListening({
    cancelListening: true,
    cancelSpeech: true,
  });
  exerciseTransitionModalEl?.classList.remove("is-open");
  exerciseTransitionModalEl?.setAttribute("aria-hidden", "true");
  document.body.classList.remove("modal-open");
  if (!retainPainBaseline) exerciseTransitionPainBaseline = null;
}

function clearExerciseTransitionVoiceTimer() {
  if (exerciseTransitionVoiceTimer === null) return;
  window.clearTimeout(exerciseTransitionVoiceTimer);
  exerciseTransitionVoiceTimer = null;
}

function stopExerciseTransitionVoiceListening({
  cancelListening = true,
  cancelSpeech = false,
} = {}) {
  exerciseTransitionVoiceGeneration += 1;
  clearExerciseTransitionVoiceTimer();
  if (cancelListening) voiceGuidance.cancelListening();
  if (cancelSpeech) voiceGuidance.cancelSpokenOutput();
}

function exerciseTransitionVoiceCanListen(generation) {
  return Boolean(
    generation === exerciseTransitionVoiceGeneration
    && exerciseTransitionModalEl?.classList.contains("is-open")
    && exerciseTransitionNextExerciseId
    && !exerciseTransitionContinueEl.disabled
    && handsFreeVoiceEnabled
    && voiceGuidance.enabled
    && voiceGuidance.canListen
    && !painCheckinState
  );
}

function continueToNextExercise() {
  if (
    !exerciseTransitionNextExerciseId
    || exerciseTransitionContinueEl.disabled
  ) {
    return false;
  }
  const nextExerciseId = exerciseTransitionNextExerciseId;
  closeExerciseTransition({ retainPainBaseline: true });
  exSelect.value = nextExerciseId;
  exSelect.dispatchEvent(new Event("change", { bubbles: true }));
  document.getElementById("practice")?.scrollIntoView({
    behavior: "smooth",
    block: "start",
  });
  statusEl.textContent = "Preparing the next exercise camera guide…";
  setFeedbackBanner(
    "position",
    "Stay near your device. The camera guide for the next exercise is opening automatically."
  );
  // Keep this inside the Continue action so Safari can reuse the user's
  // gesture when camera permission has to be requested again.
  void openCalibrationFlow({ currentTarget: openCalibrationPrimary });
  return true;
}

function listenForExerciseTransitionVoice(generation, retriesRemaining = 1) {
  if (!exerciseTransitionVoiceCanListen(generation)) return;
  exerciseTransitionStatusEl.textContent = translateText(
    "Exercise saved · waiting for your answer"
  );
  const started = voiceGuidance.listen({
    maxNoSpeechRetries: 1,
    interimSilenceMs: 400,
    onStatus: () => {
      if (exerciseTransitionVoiceCanListen(generation)) {
        exerciseTransitionStatusEl.textContent = translateText(
          "Exercise saved · waiting for your answer"
        );
      }
    },
    onResult: (transcript) => {
      if (!exerciseTransitionVoiceCanListen(generation)) return;
      const response = parseConfirmationResponse(transcript);
      if (response === "confirm") {
        continueToNextExercise();
        return;
      }
      if (response === "change") {
        stopExerciseTransitionVoiceListening({ cancelListening: true });
        exerciseTransitionStatusEl.textContent = translateText("Exercise saved");
        speakMovementGuide(
          "Okay. Your exercise is saved. You can finish for now or use Continue to next exercise when you are ready.",
          {
            key: `exercise-transition:declined:${exerciseTransitionNextExerciseId}`,
            interrupt: true,
          }
        );
        return;
      }
      if (retriesRemaining <= 0) {
        exerciseTransitionStatusEl.textContent = translateText(
          "Exercise saved · use a button to continue or finish for now"
        );
        return;
      }
      const retry = translateText(
        "Please say yes to continue to the next exercise, or no to finish for now."
      );
      let listeningStarted = false;
      const listenAgain = () => {
        if (listeningStarted) return;
        listeningStarted = true;
        listenForExerciseTransitionVoice(generation, retriesRemaining - 1);
      };
      const spoken = speakMovementGuide(retry, {
        key: `exercise-transition:retry:${generation}:${retriesRemaining}`,
        interrupt: true,
        onEnd: listenAgain,
      });
      if (!spoken) listenAgain();
      else {
        window.setTimeout(() => {
          if (!voiceGuidance.isSpeaking) listenAgain();
        }, 9000);
      }
    },
    onError: () => {
      if (!exerciseTransitionVoiceCanListen(generation)) return;
      exerciseTransitionStatusEl.textContent = translateText(
        "Exercise saved · use a button to continue or finish for now"
      );
    },
  });
  if (!started && exerciseTransitionVoiceCanListen(generation)) {
    exerciseTransitionStatusEl.textContent = translateText(
      "Exercise saved · use a button to continue or finish for now"
    );
  }
}

function promptForExerciseTransitionVoice({ checkinSaveIncomplete = false } = {}) {
  if (
    !exerciseTransitionNextExerciseId
    || !exerciseTransitionModalEl?.classList.contains("is-open")
    || exerciseTransitionContinueEl.disabled
    || !handsFreeVoiceEnabled
    || !voiceGuidance.enabled
    || !voiceGuidance.canListen
  ) {
    return false;
  }
  stopExerciseTransitionVoiceListening({ cancelListening: true });
  const generation = exerciseTransitionVoiceGeneration;
  const nextExerciseName = translateText(
    exerciseDisplayName(exerciseTransitionNextExerciseId)
  );
  const question = [
    checkinSaveIncomplete
      ? `${translateText("Exercise saved")}.`
      : translateText("Your exercise and check-in are saved."),
    `${translateText("Would you like to continue to")} ${nextExerciseName}?`,
    translateText("Say yes or no."),
  ].join(" ");
  exerciseTransitionMessageEl.textContent = question;

  let listeningStarted = false;
  const beginListening = () => {
    if (listeningStarted) return;
    listeningStarted = true;
    listenForExerciseTransitionVoice(generation);
  };
  const spoken = speakMovementGuide(question, {
    key: `exercise-transition:question:${exerciseTransitionNextExerciseId}`,
    interrupt: true,
    onEnd: beginListening,
  });
  if (!spoken) beginListening();
  else {
    window.setTimeout(() => {
      if (!voiceGuidance.isSpeaking) beginListening();
    }, 12000);
  }
  return true;
}

function announceSavedExerciseSession(session) {
  if (!session) return;
  const completedExerciseId = String(
    completedExerciseSessionSnapshot?.exercise ?? session.exercise ?? ""
  );
  if (completedExerciseId && sessionReachedTarget(completedExerciseSessionSnapshot)) {
    activeSessionCompletedExerciseIds.add(completedExerciseId);
  }
  window.dispatchEvent(new CustomEvent(
    "physiovision:session-completed",
    { detail: { sessionId: session.id } },
  ));
}

async function finalizeExerciseTransition(painSavePromise) {
  const session = await (completedExerciseSessionPromise ?? Promise.resolve(null));
  const savedAfterCheckin = await painSavePromise;
  if (!session) {
    exerciseTransitionStatusEl.textContent =
      "Your result could not be saved. Check your connection before continuing.";
    exerciseTransitionStatusEl.classList.add("is-error");
    exerciseTransitionHomeEl.disabled = false;
    return;
  }

  announceSavedExerciseSession(session);
  const checkinSaveIncomplete = Boolean(
    !savedAfterCheckin || completedExerciseCheckinLinkError
  );
  exerciseTransitionStatusEl.textContent = checkinSaveIncomplete
    ? translateText("Exercise saved · check-in save incomplete")
    : translateText("Exercise saved");
  exerciseTransitionContinueEl.disabled = false;
  exerciseTransitionHomeEl.disabled = false;
  promptForExerciseTransitionVoice({ checkinSaveIncomplete });
}

function showPostExerciseDestination(completed, beforePain, painSavePromise) {
  const progress = plannedSessionProgressAfterCurrent();
  if (
    progress.enabled
    && progress.nextExerciseId
    && sessionReachedTarget(completedExerciseSessionSnapshot)
  ) {
    openExerciseTransition(progress, completed.painLevel);
    void finalizeExerciseTransition(painSavePromise);
    return;
  }
  openSessionSummary(completed, beforePain);
  void finalizeSessionSummary(completed, beforePain, painSavePromise);
}

function openSessionSummary(completed, beforePain) {
  const snapshot = completedExerciseSessionSnapshot ?? {};
  const exerciseName = snapshot.exercise_name ?? "Exercise";
  const stoppedEarly = Boolean(snapshot.stop_reason);
  const repetitionsCompleted = Number(snapshot.reps_completed ?? 0);
  const repetitionsTarget = Number(snapshot.reps_target ?? 0);
  const repetitionsMinimum = Number(
    snapshot.reps_minimum ?? repetitionsTarget,
  );
  const assignedRepetitionLabel = (
    repetitionsMinimum > 0
    && repetitionsTarget > repetitionsMinimum
  )
    ? `${repetitionsMinimum}–${repetitionsTarget}`
    : String(repetitionsTarget || repetitionsMinimum || 0);
  const side = snapshot.affected_side
    ? `${snapshot.affected_side} side`
    : "selected side";
  const progress = plannedSessionProgressAfterCurrent();
  const completedPlannedSession = Boolean(
    progress.enabled
    && !progress.nextExerciseId
    && progress.completedCount === progress.totalExercises
  );
  sessionSummaryTitleEl.textContent = completedPlannedSession
    ? `${activeSessionDay || "Today’s"} session complete`
    : stoppedEarly
      ? `${exerciseName} stopped`
    : `${exerciseName} session complete`;
  sessionSummaryScopeEl.textContent = completedPlannedSession
    ? (
      `All ${progress.totalExercises} exercises for this day are complete. `
      + `Pain, recovery, and the same-exercise trend below use ${exerciseName} on the ${side}.`
    )
    : `Results and trends compare ${exerciseName} on the ${side} only.`;
  sessionSummaryCompletedEl.textContent = completedPlannedSession
    ? `${progress.completedCount} of ${progress.totalExercises} exercises`
    : stoppedEarly
      ? `${repetitionsCompleted} repetitions · minimum ${repetitionsMinimum}`
      : repetitionsMinimum < repetitionsTarget
        ? `${repetitionsCompleted} repetitions · assigned ${assignedRepetitionLabel}`
        : `${repetitionsCompleted} of ${repetitionsTarget} repetitions`;
  const trackingAssessment = snapshot.assessment_summary?.tracking_validity;
  const movementAssessment = snapshot.assessment_summary?.movement_execution;
  sessionSummaryTrackingEl.textContent = {
    assessable: "Assessable",
    partially_assessable: "Partly assessable",
    unable_to_assess: "Unable to assess",
  }[trackingAssessment?.status] ?? "Not recorded";
  sessionSummaryQualityEl.textContent = movementAssessment?.status === "assessed"
    && Number.isFinite(Number(movementAssessment.score))
    ? `${Math.round(Number(movementAssessment.score))}/100 coaching response`
    : movementAssessment?.status === "not_clinically_scored"
      ? "Not clinically scored"
      : "Unable to assess";
  sessionSummaryPainEl.textContent = painResponseLabel(
    beforePain,
    completed.painLevel,
  );
  sessionSummaryRecoveryEl.textContent = recoveryLabel(
    completed.recoveryStatus,
  );
  sessionSummaryTrendEl.textContent =
    "Saving this check-in and calculating your same-exercise trend…";
  sessionSummaryCueEl.textContent = "Reviewing movement guidance…";
  sessionSummaryStatusEl.textContent = stoppedEarly
    ? snapshot.stop_requires_review
      ? "Review recorded stop"
      : "Stopped early"
    : "Preparing your results";
  sessionSummaryModalEl?.classList.add("is-open");
  sessionSummaryModalEl?.setAttribute("aria-hidden", "false");
  document.body.classList.add("modal-open");
  sessionSummaryTitleEl?.focus({ preventScroll: true });
}

function closeSessionSummary() {
  sessionSummaryModalEl?.classList.remove("is-open");
  sessionSummaryModalEl?.setAttribute("aria-hidden", "true");
  document.body.classList.remove("modal-open");
}

function mostFrequentSessionCue(snapshot = {}) {
  return [...(snapshot.cues_triggered ?? [])]
    .filter((cue) => Number(cue.trigger_count) > 0)
    .sort((a, b) => Number(b.trigger_count) - Number(a.trigger_count))[0] ?? null;
}

function renderCoachingScoreExplanation(snapshot = {}) {
  const movementAssessment = snapshot.assessment_summary?.movement_execution;
  const observations = (snapshot.cues_triggered ?? []).filter(
    (cue) => cue?.kind === "movement_observation",
  );
  const records = (snapshot.cues_triggered ?? []).filter(
    (cue) => cue?.kind === "coaching_reminder" && cue?.delivered,
  );
  if (movementAssessment?.status === "not_clinically_scored") {
    const observedItems = observations.map((observation) => {
      const description = escapeHtml(
        observation.cue_text || observation.rule_id || "Prototype observation",
      );
      const repetitions = Math.max(
        1,
        Math.round(Number(observation.trigger_count) || 1),
      );
      return `<li>${description} (${repetitions} observed repetition${repetitions === 1 ? "" : "s"}).</li>`;
    });
    sessionSummaryCueEl.innerHTML = (
      "<strong>Movement execution was not clinically scored</strong>"
      + "<p>The camera rules for this exercise have not yet completed technical validation, clinical validation, and recorded physiotherapist approval. Prototype observations did not deduct points.</p>"
      + (observedItems.length
        ? `<ul>${observedItems.join("")}</ul>`
        : "<p>No prototype movement observation was recorded.</p>")
    );
    return;
  }
  if (!records.length) {
    sessionSummaryCueEl.innerHTML = snapshot.reps_completed > 0
      ? "<strong>Movement execution</strong><p>No validation-gated correction required a reminder.</p>"
      : "<strong>Movement execution</strong><p>No assessable repetitions were captured. Check the tracking-validity result before trying again.</p>";
    return;
  }

  const items = records.map((record) => {
    const cue = escapeHtml(record.cue_text || "Movement correction");
    const reminderRep = Math.max(1, Math.round(Number(record.reminder_rep) || 1));
    const grace = Math.max(1, Math.round(Number(record.adjustment_reps) || 2));
    const finalGraceRep = reminderRep + grace;
    const delivery = record.delivery_mode === "shown_and_spoken"
      ? "shown and spoken"
      : "shown on screen";
    if (record.outcome === "persisted" && Number(record.deduction) > 0) {
      return (
        `<li><strong>−${Math.round(Number(record.deduction))} points:</strong> `
        + `“${cue}” was ${delivery} at repetition ${reminderRep}. `
        + `The same stable issue continued through repetitions ${reminderRep + 1}–${finalGraceRep}.</li>`
      );
    }
    if (record.outcome === "improved") {
      return (
        `<li><strong>No deduction:</strong> “${cue}” was ${delivery} at repetition ${reminderRep}, `
        + `and the same issue did not persist through both adjustment repetitions.</li>`
      );
    }
    return (
      `<li><strong>No deduction:</strong> “${cue}” was ${delivery} at repetition ${reminderRep}, `
      + "but there were not enough later repetitions to assess your response.</li>"
    );
  });
  sessionSummaryCueEl.innerHTML = (
    "<strong>How validation-gated coaching affected the score</strong>"
    + `<ul>${items.join("")}</ul>`
  );
}

async function finalizeSessionSummary(completed, beforePain, painSavePromise) {
  const session = await (completedExerciseSessionPromise ?? Promise.resolve(null));
  const savedAfterCheckin = await painSavePromise;
  const checkinSaveIncomplete = Boolean(
    session && (!savedAfterCheckin || completedExerciseCheckinLinkError)
  );

  let trend = null;
  if (session) {
    try {
      const [sessionsResponse, painResponse] = await Promise.all([
        getSessions(),
        getPainCheckins(),
      ]);
      const savedSessions = apiResults(sessionsResponse);
      trend = analysePatientTrend({
        sessions: savedSessions,
        painCheckins: apiResults(painResponse),
        focusSessionId: session.id,
      });
      const progress = plannedSessionProgressAfterCurrent();
      if (
        progress.enabled
        && !progress.nextExerciseId
        && progress.completedCount === progress.totalExercises
      ) {
        const plannedSessions = sessionsForPlannedSession(
          savedSessions,
          activeSessionKey,
        );
        const completedExercises = new Set(
          plannedSessions.map((item) => String(item.exercise ?? "")).filter(Boolean)
        );
        const qualityScores = plannedSessions
          .filter((item) => (
            item.assessment_summary?.movement_execution?.status === "assessed"
          ))
          .map((item) => Number(item.assessment_summary.movement_execution.score))
          .filter((score) => Number.isFinite(score));
        sessionSummaryCompletedEl.textContent =
          `${completedExercises.size} of ${progress.totalExercises} exercises`;
        if (qualityScores.length) {
          const averageQuality = qualityScores.reduce(
            (total, score) => total + score,
            0,
          ) / qualityScores.length;
          sessionSummaryQualityEl.textContent =
            `${Math.round(averageQuality)}/100 day average`;
        }
      }
    } catch (_) {
      trend = null;
    }
  }

  const snapshot = completedExerciseSessionSnapshot ?? {};
  const usesCoachingFirstScore = (snapshot.cues_triggered ?? []).some(
    (cue) => Number(cue?.scoring_version) >= 2,
  );
  if (usesCoachingFirstScore) {
    renderCoachingScoreExplanation(snapshot);
  } else {
    const cue = mostFrequentSessionCue(snapshot);
    sessionSummaryCueEl.textContent = cue
      ? `Most frequent correction: ${cue.cue_text} (${cue.trigger_count} times).`
      : snapshot.reps_completed > 0
        ? "No repeated movement correction was measured in this session."
        : "No repetitions were measured. Check your camera position before trying again.";
  }

  if (trend) {
    sessionSummaryTrendEl.textContent = `${trend.title}. ${trend.message}`;
    sessionSummaryStatusEl.textContent = {
      review_suggested: "Review suggested",
      improving: "Improving",
      stable: "Steady",
      preliminary: "Preliminary",
      first_measurement: "First measurement",
      building_baseline: "Building baseline",
    }[trend.status] ?? "Building baseline";
    if (checkinSaveIncomplete) {
      sessionSummaryTrendEl.textContent +=
        " One or more pain check-ins could not be attached to this session.";
      sessionSummaryStatusEl.textContent = "Check-in save incomplete";
    }
  } else {
    sessionSummaryTrendEl.textContent = completedExerciseSessionError
      ? "Your results are shown, but the session could not be saved. Check your connection and try again."
      : "Your session was saved, but the longer-term trend could not be loaded right now.";
    sessionSummaryStatusEl.textContent = completedExerciseSessionError
      ? "Save incomplete"
      : "Trend unavailable";
  }

  if (snapshot.stop_reason) {
    sessionSummaryStatusEl.textContent = snapshot.stop_requires_review
      ? "Review recorded stop"
      : "Stopped early";
  }

  announceSavedExerciseSession(session);
  speakMovementGuide(
    "Your session summary is ready. Review tracking validity, movement execution, pain response, and recovery before continuing.",
    { key: `session-summary:${session?.id ?? "unsaved"}`, interrupt: true },
  );
}

function finishPainCheckin() {
  if (!painCheckinState) return;
  const completed = { ...painCheckinState };

  if (completed.context === "before") {
    activePreExerciseCheckinPromise = postPainCheckin(
      painCheckinPayload(completed),
    ).catch(() => null);
    preExerciseCheckinCompleted = true;
    confirmedPreExercisePain = completed.painLevel;
  } else {
    const beforePain = confirmedPreExercisePain;
    const painSavePromise = (async () => {
      const session = await (
        completedExerciseSessionPromise ?? Promise.resolve(null)
      );
      return postPainCheckin(
        painCheckinPayload(completed, session?.id),
      ).catch(() => null);
    })();
    showPostExerciseDestination(completed, beforePain, painSavePromise);
    confirmedPreExercisePain = null;
  }
  hidePainCheckin();
  renderRecordedPain(completed);
  if (completed.continuation || completed.startAfter) {
    statusEl.textContent = "Pain level confirmed — starting camera setup";
    setFeedbackBanner(
      "position",
      "Pain level recorded. Camera setup is continuing automatically."
    );
    continueAfterPainCheckin(completed);
  } else {
    acknowledgeRecordedPain(completed);
  }
}

function requiresPainSafetyInterview() {
  const level = painCheckinState?.painLevel;
  const increase =
    painCheckinState?.context === "after" &&
    Number.isInteger(confirmedPreExercisePain)
      ? level - confirmedPreExercisePain
      : 0;
  return Number.isInteger(level) && (level >= 7 || increase >= 2);
}

function createPainSafetyAnswers() {
  return {
    urgentCombined: "",
    urgentSymptoms: "",
    urgentChest: "",
    urgentBreathing: "",
    urgentNeurologic: "",
    urgentFall: "",
    painLocation: "",
    painLocationDescription: "",
    painSide: "",
    painFamiliarity: "",
    onsetTiming: "",
    restTrend: "",
    safeMovement: "",
    languageInterpretations: [],
    outcome: "",
    stopReason: painCheckinState?.stopReason ?? "",
    reportForPhysiotherapist: false,
    exerciseId: engine.exercise?.id ?? "",
    exerciseName: engine.exercise?.name ?? "",
    repsCompleted: Number(
      completedExerciseSessionSnapshot?.reps_completed
        ?? completedSessionReps + (engine.repCount ?? 0),
    ),
    setNumber: Math.min(
      Number(completedExerciseSessionSnapshot?.sets_target ?? plannedSetCount()),
      Number(completedExerciseSessionSnapshot?.sets_completed ?? completedSetCount) + 1,
    ),
  };
}

function painSafetyStageName() {
  return isPainSafetyStage()
    ? painCheckinState.stage.replace("safety-", "")
    : "";
}

function painSafetyStageHelp(stageName, step) {
  if (
    stageName === "rest" &&
    painCheckinState?.safetyAnswers?.onsetTiming === "during"
  ) {
    const answers = painCheckinState.safetyAnswers;
    const movement = answers.exerciseName || "the current exercise";
    return (
      `Recorded during ${movement}, set ${answers.setNumber}, after ${answers.repsCompleted} completed repetitions. `
      + "You do not need to repeat those details. Stay resting while you answer."
    );
  }
  return step.help;
}

function clearPainSafetyRestPause() {
  if (painSafetyRestTimer === null) return;
  window.clearInterval(painSafetyRestTimer);
  painSafetyRestTimer = null;
}

function beginPainSafetyRestPause() {
  if (!painCheckinState?.safetyAnswers) return;
  clearPainSafetyRestPause();
  voiceGuidance.cancel();
  painCheckinState.stage = "safety-rest-pause";
  painSafetyInterviewEl.classList.remove("hidden", "is-urgent", "is-outcome");
  painSafetyHeadingEl.textContent = "Please stay resting";
  painSafetyMessageEl.textContent = PAIN_SAFETY_REASSURANCE;
  painSafetyQuestionEl.textContent = "Rest for a few seconds before the next question.";
  painSafetyHelpEl.textContent =
    "The current exercise, set, and repetition have already been recorded.";
  painSafetyChoicesEl.replaceChildren();
  painSafetyChoicesEl.classList.remove("is-body-map");
  let secondsRemaining = 5;
  voiceCheckinStatusEl.textContent =
    `I’ll ask how the pain is changing in ${secondsRemaining} seconds.`;
  updatePainCheckinPresentation();
  speakMovementGuide(
    "Please stay resting for five seconds. I will then ask how the pain is changing.",
    {
      key: `checkin:${painCheckinState.context}:safety:rest-pause`,
      interrupt: true,
    }
  );
  painSafetyRestTimer = window.setInterval(() => {
    secondsRemaining -= 1;
    if (secondsRemaining > 0) {
      voiceCheckinStatusEl.textContent =
        `I’ll ask how the pain is changing in ${secondsRemaining} seconds.`;
      return;
    }
    clearPainSafetyRestPause();
    renderPainSafetyStage("rest");
  }, 1000);
}

function appendPainBodyDiagram() {
  const diagram = document.createElement("div");
  diagram.className = "pain-body-diagram";
  diagram.setAttribute("aria-hidden", "true");
  diagram.innerHTML = [
    '<span class="pain-body-head"></span>',
    '<span class="pain-body-torso"></span>',
    '<span class="pain-body-arm pain-body-arm-left"></span>',
    '<span class="pain-body-arm pain-body-arm-right"></span>',
    '<span class="pain-body-leg pain-body-leg-left"></span>',
    '<span class="pain-body-leg pain-body-leg-right"></span>',
  ].join("");
  painSafetyChoicesEl.appendChild(diagram);
}

function renderPainSafetyStage(stageName, { announceReassurance = false } = {}) {
  if (!painCheckinState || !PAIN_SAFETY_STEPS[stageName]) return;
  const step = PAIN_SAFETY_STEPS[stageName];
  painCheckinState.stage = `safety-${stageName}`;
  painLevelChoicesEl.classList.add("hidden");
  painConfirmationEl.classList.add("hidden");
  recoveryChoicesEl.classList.add("hidden");
  painSafetyInterviewEl.classList.remove("hidden", "is-urgent", "is-outcome");
  painSkipBtn.classList.add("hidden");
  painCheckinTitleEl.textContent = "Let’s check that you are safe";
  painSafetyHeadingEl.textContent = "Please stay resting";
  painSafetyMessageEl.textContent = PAIN_SAFETY_REASSURANCE;
  painSafetyQuestionEl.textContent = step.question;
  painSafetyHelpEl.textContent = painSafetyStageHelp(stageName, step);
  painSafetyChoicesEl.replaceChildren();
  painSafetyChoicesEl.classList.toggle("is-body-map", stageName === "location");
  if (stageName === "location") appendPainBodyDiagram();
  step.choices.forEach(([value, label]) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "pain-safety-choice";
    button.dataset.painSafetyResponse = value;
    button.textContent = label;
    painSafetyChoicesEl.appendChild(button);
  });
  voiceCheckinStatusEl.textContent = voiceGuidance.canListen
    ? handsFreeVoiceEnabled
      ? "Answer aloud after the question. You do not need to press a button."
      : "Choose Answer by voice, or use a large button."
    : "Choose the answer that fits best.";
  updatePainCheckinPresentation();
  const spokenPrompt = announceReassurance
    ? `${PAIN_SAFETY_REASSURANCE} ${step.question}`
    : step.question;
  speakPainPrompt(
    spokenPrompt,
    `checkin:${painCheckinState.context}:safety:${stageName}`,
    `safety-${stageName}`
  );
}

function beginPainSafetyInterview() {
  if (!painCheckinState) return;
  cancelCameraSetupCountdown({ announce: false });
  clearPainSafetyRestPause();
  voiceGuidance.cancel();
  if (running) {
    deactivateCameraGuide({
      statusMessage: "Camera paused for a pain safety check",
    });
  }
  painCheckinState.startAfter = false;
  painCheckinState.continuation = "";
  painCheckinState.calibrationTrigger = null;
  painCheckinState.safetyAnswers = createPainSafetyAnswers();
  // Persist the confirmed pain report before asking any follow-up questions.
  // A patient may need to leave the flow to seek help, and a pre-exercise
  // report must not depend on an exercise Session row that will never exist.
  void ensureConfirmedPainSafetyCheckin(painCheckinState);
  renderPainSafetyStage("urgent", { announceReassurance: true });
}

function determinePainSafetyOutcome() {
  const answers = painCheckinState?.safetyAnswers ?? {};
  if (answers.urgentSymptoms === "yes" || answers.safeMovement === "help") {
    return "urgent";
  }
  if (
    answers.urgentSymptoms === "unsure" ||
    painCheckinState.painLevel >= 7 ||
    answers.restTrend !== "better" ||
    answers.safeMovement !== "safe"
  ) {
    return "professional";
  }
  return "monitor";
}

function physiotherapistConnectionForSafetyCheck() {
  const patientProfile = currentPracticeIdentity().patientProfile ?? {};
  const carePath =
    patientProfile.care_path ?? patientProfile.carePath ?? profile.carePath;
  const clinicianId =
    patientProfile.primary_clinician
    ?? patientProfile.primaryClinician
    ?? profile.primary_clinician
    ?? profile.primaryClinician
    ?? null;
  const recordedClinicianName =
    patientProfile.primary_clinician_name
    ?? patientProfile.primaryClinicianName
    ?? profile.primary_clinician_name
    ?? profile.primaryClinicianName
    ?? activeDose(engine.exercise).clinicianName
    ?? "";
  return {
    linked:
      carePath === "clinician"
      && Boolean(clinicianId || recordedClinicianName),
    name: recordedClinicianName || "your physiotherapist",
  };
}

function painSafetyCheckinPayload(state, reportForPhysiotherapist) {
  const answers = state.safetyAnswers;
  return {
    pain_level: state.painLevel,
    timing: state.context,
    recovery_status: answers.restTrend || state.recoveryStatus,
    location_notes: [answers.painSide, answers.painLocation]
      .filter(Boolean)
      .join(" "),
    safety_follow_up: {
      urgent_combined_response: answers.urgentCombined,
      urgent_symptoms: answers.urgentSymptoms,
      urgent_symptom_details: {
        chest: answers.urgentChest,
        breathing: answers.urgentBreathing,
        neurologic: answers.urgentNeurologic,
        fall: answers.urgentFall,
      },
      pain_location: answers.painLocation,
      pain_location_description: answers.painLocationDescription,
      pain_side: answers.painSide,
      pain_familiarity: answers.painFamiliarity,
      onset_timing: answers.onsetTiming,
      rest_trend: answers.restTrend,
      safe_movement: answers.safeMovement,
      language_interpretations: answers.languageInterpretations,
      outcome: answers.outcome,
      report_for_physiotherapist: reportForPhysiotherapist,
      exercise_id: answers.exerciseId,
      exercise_name: answers.exerciseName,
      reps_completed: answers.repsCompleted,
      set_number: answers.setNumber,
      stop_reason: answers.stopReason,
    },
    requires_review:
      answers.outcome !== "monitor" || reportForPhysiotherapist,
    checked_at: state.confirmedPainCheckedAt || new Date().toISOString(),
  };
}

function confirmedPainSafetyPayload(state) {
  const answers = state.safetyAnswers ?? createPainSafetyAnswers();
  state.confirmedPainCheckedAt ||= new Date().toISOString();
  return {
    pain_level: state.painLevel,
    timing: state.context,
    recovery_status: state.recoveryStatus,
    safety_follow_up: {
      status: "incomplete",
      exercise_id: answers.exerciseId,
      exercise_name: answers.exerciseName,
      reps_completed: answers.repsCompleted,
      set_number: answers.setNumber,
      stop_reason: answers.stopReason,
    },
    // A confirmed score that opened this safety flow must be visible for
    // clinical review even if the patient cannot finish the questionnaire.
    requires_review: true,
    checked_at: state.confirmedPainCheckedAt,
  };
}

function ensureConfirmedPainSafetyCheckin(state = painCheckinState) {
  if (!state || !Number.isInteger(state.painLevel)) {
    return Promise.resolve(null);
  }
  if (state.confirmedPainSavePromise) return state.confirmedPainSavePromise;

  state.confirmedPainSavePromise = (async () => {
    const session = state.context === "after"
      ? await (completedExerciseSessionPromise ?? Promise.resolve(null))
      : null;
    return postPainCheckin({
      ...confirmedPainSafetyPayload(state),
      ...(session?.id ? { session: session.id } : {}),
    });
  })()
    .then((savedCheckin) => {
      state.confirmedPainCheckin = savedCheckin;
      state.confirmedPainSaved = true;
      return savedCheckin;
    })
    .catch(() => {
      state.confirmedPainSaveFailed = true;
      return null;
    });
  return state.confirmedPainSavePromise;
}

function persistPainSafetyInterview({
  reportForPhysiotherapist = false,
} = {}) {
  const state = painCheckinState;
  if (!state?.safetyAnswers) return Promise.resolve(false);

  const connection = physiotherapistConnectionForSafetyCheck();
  const effectiveReport = Boolean(
    reportForPhysiotherapist
    || (connection.linked && state.safetyAnswers.outcome !== "monitor")
  );
  if (state.safetySavePromise) return state.safetySavePromise;

  state.safetyAnswers.reportForPhysiotherapist = effectiveReport;
  state.safetySavePromise = (async () => {
    const session = state.context === "after"
      ? await (completedExerciseSessionPromise ?? Promise.resolve(null))
      : null;
    const completedPayload = {
      ...painSafetyCheckinPayload(state, effectiveReport),
      ...(session?.id ? { session: session.id } : {}),
    };
    const confirmedCheckin = await ensureConfirmedPainSafetyCheckin(state);
    return confirmedCheckin?.id
      ? updatePainCheckin(confirmedCheckin.id, completedPayload)
      : postPainCheckin(completedPayload);
  })()
    .then((savedCheckin) => {
      state.safetySaved = true;
      return savedCheckin;
    })
    .catch(() => {
      state.safetySavePromise = null;
      state.safetySaveFailed = true;
      return false;
    });
  return state.safetySavePromise;
}

function renderPainSafetyOutcome(forcedOutcome = "") {
  if (!painCheckinState?.safetyAnswers) return;
  clearPainSafetyRestPause();
  voiceGuidance.cancel();
  const outcome = forcedOutcome || determinePainSafetyOutcome();
  painCheckinState.safetyAnswers.outcome = outcome;
  painCheckinState.stage = "safety-outcome";
  painSafetyInterviewEl.classList.remove("hidden");
  painSafetyInterviewEl.classList.add("is-outcome");
  painSafetyInterviewEl.classList.toggle("is-urgent", outcome === "urgent");
  painSafetyChoicesEl.replaceChildren();
  painSafetyChoicesEl.classList.remove("is-body-map");

  const connection = physiotherapistConnectionForSafetyCheck();
  let heading = "End this exercise for today";
  let message =
    "Your pain increase has been recorded. I recommend ending this exercise for today and monitoring how you feel.";
  let help =
    "Do not restart this exercise today. This guidance is not a diagnosis.";
  if (outcome === "urgent") {
    heading = "Stop exercising and get help now";
    message =
      "Do not continue exercising. If you have severe or worsening symptoms, difficulty breathing, fainting, sudden weakness or numbness, or cannot get up safely, call 995 now.";
    help =
      "PhysioVision has not called 995 or your saved emergency contact. If you can do so safely, ask your emergency contact or someone nearby to help you call 995. Do not use an emergency contact instead of 995 for urgent symptoms.";
  } else if (outcome === "professional") {
    if (painCheckinState.safetyAnswers.urgentSymptoms === "unsure") {
      heading = "Pause today’s programme and seek prompt advice";
      message =
        "Your follow-up answers did not confirm an emergency warning sign, but one or more signs could not be ruled out.";
      help = connection.linked
        ? `Do not continue exercising today. Consider booking a session with ${connection.name} promptly. If you develop chest pressure, difficulty breathing, fainting, sudden weakness or numbness, or cannot get up safely, call 995 now.`
        : "Do not continue exercising today. Consider booking a session with a qualified healthcare professional promptly. If you develop chest pressure, difficulty breathing, fainting, sudden weakness or numbness, or cannot get up safely, call 995 now.";
    } else {
      heading = "Pause today’s programme and seek professional advice";
      message =
        "The pain has not improved after stopping, is substantial, or you may need help moving safely.";
      help = connection.linked
        ? `Please pause today’s programme and consider booking a session with ${connection.name}. This is not a diagnosis.`
        : "Please pause today’s programme and consider booking a session with a qualified healthcare professional. This is not a diagnosis.";
    }
  }

  const needsProfessionalReview = outcome !== "monitor";
  let pathwayAdvice = "";
  if (needsProfessionalReview && connection.linked) {
    pathwayAdvice =
      `Your pain level and safety answers are being saved and flagged for ${connection.name} to review. `
      + "Your physiotherapist is not monitoring this in real time, so do not wait for a reply before seeking urgent help. Your prescribed plan will not be changed automatically.";
  } else if (needsProfessionalReview) {
    pathwayAdvice =
      "You are not currently linked to a physiotherapist. Do not continue this programme. Arrange an assessment with a qualified physiotherapist or another appropriate healthcare professional before exercising again.";
  }
  const completeHelp = [help, pathwayAdvice].filter(Boolean).join(" ");

  painCheckinTitleEl.textContent = "Your safety check is complete";
  painSafetyHeadingEl.textContent = heading;
  painSafetyMessageEl.textContent = message;
  painSafetyQuestionEl.textContent = needsProfessionalReview && connection.linked
    ? `Saving pain level ${painCheckinState.painLevel}/10 and this safety check for physiotherapist review`
    : connection.linked
      ? "Would you like me to prepare this report for your physiotherapist?"
      : needsProfessionalReview
        ? "Before you exercise again"
        : "What happens next";
  painSafetyHelpEl.textContent = completeHelp;

  if (connection.linked && !needsProfessionalReview) {
    const reportButton = document.createElement("button");
    reportButton.type = "button";
    reportButton.className = "pain-safety-choice is-primary";
    reportButton.dataset.painSafetyAction = "save-report";
    reportButton.textContent = "Prepare report for my physiotherapist";
    painSafetyChoicesEl.appendChild(reportButton);
  }
  const finishButton = document.createElement("button");
  finishButton.type = "button";
  finishButton.className = "pain-safety-choice";
  finishButton.dataset.painSafetyAction = "finish";
  finishButton.textContent = "Finish safety check";
  painSafetyChoicesEl.appendChild(finishButton);

  voiceCheckinStatusEl.textContent = needsProfessionalReview
    ? "Saving this safety check. The camera remains paused."
    : "The camera remains paused. Choose an option below when you are ready.";
  updatePainCheckinPresentation();
  speakMovementGuide(`${heading}. ${message} ${completeHelp}`, {
    key: `checkin:${painCheckinState.context}:safety-outcome:${outcome}`,
    interrupt: true,
  });

  if (needsProfessionalReview) {
    const outcomeState = painCheckinState;
    void persistPainSafetyInterview({
      reportForPhysiotherapist: connection.linked,
    }).then((saved) => {
      if (painCheckinState !== outcomeState || !isPainSafetyStage()) return;
      if (saved) {
        renderRecordedPain(outcomeState);
        painSafetyQuestionEl.textContent = connection.linked
          ? `Pain level ${outcomeState.painLevel}/10 saved and flagged for ${connection.name} to review`
          : `Pain level ${outcomeState.painLevel}/10 and safety check saved`;
        const savedPathwayAdvice = connection.linked
          ? `Your pain level and safety answers have been saved and flagged for ${connection.name} to review. Your physiotherapist is not monitoring this in real time, so do not wait for a reply before seeking urgent help. Your prescribed plan will not be changed automatically.`
          : "Your pain level and safety answers have been saved. Seek professional advice before exercising again.";
        painSafetyHelpEl.textContent = [help, savedPathwayAdvice]
          .filter(Boolean)
          .join(" ");
        voiceCheckinStatusEl.textContent = connection.linked
          ? "Saved and flagged for physiotherapist review. This is not real-time monitoring."
          : "Pain level and safety check saved. Seek professional advice before exercising again.";
      } else {
        if (outcomeState.confirmedPainSaved) {
          renderRecordedPain(outcomeState);
          painCheckinTitleEl.textContent =
            "Your pain level is saved — safety answers need another save attempt";
          painSafetyQuestionEl.textContent = connection.linked
            ? `Pain level ${outcomeState.painLevel}/10 saved and flagged for ${connection.name}; the completed answers were not confirmed`
            : `Pain level ${outcomeState.painLevel}/10 saved; the completed safety answers were not confirmed`;
          voiceCheckinStatusEl.textContent =
            "Your pain level is saved. Choose Finish safety check to retry saving the completed answers.";
        } else {
          painCheckinTitleEl.textContent =
            "Your safety check is complete — save not confirmed";
          painSafetyQuestionEl.textContent =
            `Pain level ${outcomeState.painLevel}/10 could not be saved or flagged`;
          voiceCheckinStatusEl.textContent =
            "The safety check could not be saved. Follow the safety advice and choose Finish to try again.";
        }
      }
    });
  }
}

function acceptPainSafetyResponse(response) {
  const stageName = painSafetyStageName();
  const step = PAIN_SAFETY_STEPS[stageName];
  if (!painCheckinState?.safetyAnswers || !step) return;
  const allowed = step.choices.map(([value]) => value);
  if (!allowed.includes(response)) {
    voiceCheckinStatusEl.textContent =
      "I could not match that answer. Please try again or choose a large button.";
    return;
  }
  painCheckinState.safetyAnswers[step.field] = response;
  if (stageName === "urgent") {
    if (response === "yes" || response === "unsure") {
      renderPainSafetyStage("urgent-chest");
    } else {
      painCheckinState.safetyAnswers.urgentSymptoms = "no";
      renderPainSafetyStage(step.next);
    }
    return;
  }
  if (stageName.startsWith("urgent-")) {
    if (response === "yes") {
      painCheckinState.safetyAnswers.urgentSymptoms = "yes";
      renderPainSafetyOutcome("urgent");
      return;
    }
    if (step.next === "location") {
      const clarificationAnswers = [
        "urgentChest",
        "urgentBreathing",
        "urgentNeurologic",
        "urgentFall",
      ].map((field) => painCheckinState.safetyAnswers[field]);
      painCheckinState.safetyAnswers.urgentSymptoms =
        clarificationAnswers.every((answer) => answer === "no")
          ? painCheckinState.safetyAnswers.urgentCombined === "yes"
            ? "unsure"
            : "no"
          : "unsure";
    }
    renderPainSafetyStage(step.next);
    return;
  }
  if (
    stageName === "familiarity"
    && painCheckinState.context === "before"
  ) {
    // This check-in happens before movement begins, so the onset is already
    // known. Record it without asking about timing or whether five seconds of
    // rest changed the pain.
    painCheckinState.safetyAnswers.onsetTiming = "before";
    renderPainSafetyStage("mobility");
    return;
  }
  if (step.next === "outcome") {
    renderPainSafetyOutcome();
    return;
  }
  if (stageName === "timing") {
    beginPainSafetyRestPause();
    return;
  }
  renderPainSafetyStage(step.next);
}

function finishPainSafetyInterview({ reportForPhysiotherapist = false } = {}) {
  if (!painCheckinState?.safetyAnswers) return;
  const safetyState = painCheckinState;
  const connection = physiotherapistConnectionForSafetyCheck();
  const effectiveReport = Boolean(
    reportForPhysiotherapist
    || (
      connection.linked
      && painCheckinState.safetyAnswers.outcome !== "monitor"
    )
  );
  const safetySavePromise = persistPainSafetyInterview({
    reportForPhysiotherapist: effectiveReport,
  });
  const completed = {
    ...painCheckinState,
    safetyAnswers: {
      ...painCheckinState.safetyAnswers,
      reportForPhysiotherapist: effectiveReport,
    },
  };
  const answers = completed.safetyAnswers;
  const beforePain = confirmedPreExercisePain;

  preExerciseCheckinCompleted = false;
  confirmedPreExercisePain = null;
  hidePainCheckin();
  statusEl.textContent = "Exercise paused after pain safety check";
  cameraSessionHintEl.textContent =
    "The exercise was not marked finished, but it should not be restarted today.";
  setFeedbackBanner("tracking", "Rest and follow the safety guidance recorded in your check-in");
  const savedMessage = effectiveReport
    ? "Your pain and safety answers are being saved and flagged for your physiotherapist to review. This does not confirm that they have seen it, so do not wait for a reply if you need urgent help."
    : "Your pain and safety answers are being recorded. The camera remains paused.";
  speakMovementGuide(savedMessage, {
    key: `checkin:${completed.context}:safety-saved:${effectiveReport}`,
    interrupt: true,
  });
  void safetySavePromise.then((saved) => {
    if (saved) {
      renderRecordedPain(completed);
      setFeedbackBanner(
        "tracking",
        effectiveReport
          ? `Pain level ${completed.painLevel}/10 saved and flagged for physiotherapist review`
          : `Pain level ${completed.painLevel}/10 and safety check saved`,
      );
    } else if (safetyState.confirmedPainSaved) {
      renderRecordedPain(completed);
      setFeedbackBanner(
        "tracking",
        `Pain level ${completed.painLevel}/10 was saved, but the completed safety answers need another save attempt.`,
      );
    } else {
      setFeedbackBanner(
        "tracking",
        `Pain level ${completed.painLevel}/10 could not be saved. Check your connection and try again.`,
      );
    }
  });
  if (completed.context === "after") {
    completed.recoveryStatus = answers.restTrend || completed.recoveryStatus;
    openSessionSummary(completed, beforePain);
    void finalizeSessionSummary(completed, beforePain, safetySavePromise);
  }
}

function acceptPainLevel(level) {
  if (!painCheckinState || !Number.isInteger(level) || level < 0 || level > 10) {
    voiceCheckinStatusEl.textContent =
      "Please choose or say one number from zero to ten.";
    return;
  }
  painCheckinState.painLevel = level;
  const canContinueWithoutSpokenConfirmation = Boolean(
    handsFreeVoiceEnabled
    && painCheckinState.context === "before"
    && (painCheckinState.startAfter || painCheckinState.continuation)
    && !painCheckinState.forceSafetyInterview
    && !requiresPainSafetyInterview()
  );
  if (canContinueWithoutSpokenConfirmation) {
    // The camera handoff repeats the recognized number in the same utterance,
    // so a routine pre-exercise answer does not spend a second TTS request on
    // a separate yes/no exchange. Concerning scores still require explicit
    // confirmation before the safety interview begins.
    finishPainCheckin();
    return;
  }
  beginPainConfirmation();
}

function beginPainConfirmation() {
  if (!painCheckinState || !Number.isInteger(painCheckinState.painLevel)) return;
  voiceGuidance.cancel();
  painCheckinState.stage = "confirm-pain";
  painLevelChoicesEl.classList.add("hidden");
  recoveryChoicesEl.classList.add("hidden");
  painSafetyInterviewEl.classList.add("hidden");
  painConfirmationEl.classList.remove("hidden");
  painSkipBtn.classList.add("hidden");
  updatePainCheckinPresentation();

  const level = painCheckinState.painLevel;
  const question = painConfirmationQuestion(level);
  const spokenQuestion = spokenPainConfirmationQuestion(level);
  painCheckinTitleEl.textContent = "Please confirm your pain level";
  painConfirmationSummaryEl.textContent = question;
  voiceCheckinStatusEl.textContent = handsFreeVoiceEnabled
    ? "Listening will start after the confirmation question. Say yes or change."
    : voiceGuidance.canListen
      ? "Select Yes, that’s correct or Change my answer. Voice input is also available."
      : "Select Yes, that’s correct or Change my answer.";
  speakPainPrompt(
    spokenQuestion,
    `checkin:${painCheckinState.context}:pain-confirmation:${level}`,
    "confirm-pain"
  );
}

function returnToPainQuestion() {
  if (!painCheckinState) return;
  voiceGuidance.cancel();
  painCheckinState.stage = "pain";
  painCheckinState.painLevel = null;
  painCheckinTitleEl.innerHTML =
    `${escapeHtml(painQuestion(painCheckinState.context))} <span>(0 = none, 10 = severe)</span>`;
  painLevelChoicesEl.classList.remove("hidden");
  painConfirmationEl.classList.add("hidden");
  recoveryChoicesEl.classList.add("hidden");
  painSafetyInterviewEl.classList.add("hidden");
  painSkipBtn.classList.remove("hidden");
  updatePainCheckinPresentation();
  voiceCheckinStatusEl.textContent = handsFreeVoiceEnabled
    ? "Please say your pain level again, from zero to ten."
    : "Choose a different number.";
  speakPainPrompt(
    painQuestion(painCheckinState.context),
    `checkin:${painCheckinState.context}:pain:retry`,
    "pain"
  );
}

function acceptPainConfirmation(response) {
  if (!painCheckinState || painCheckinState.stage !== "confirm-pain") return;
  if (response === "change") {
    returnToPainQuestion();
    return;
  }
  if (response !== "confirm") {
    voiceCheckinStatusEl.textContent =
      "Please say yes or change, or use one of the confirmation buttons.";
    return;
  }
  if (painCheckinState.forceSafetyInterview) {
    beginPainSafetyInterview();
    return;
  }
  if (requiresPainSafetyInterview()) beginPainSafetyInterview();
  else if (shouldAskRecovery()) beginRecoveryQuestion();
  else finishPainCheckin();
}

function acceptRecoveryStatus(status) {
  if (
    !painCheckinState ||
    !["better", "same", "worse", "unsure"].includes(status)
  ) {
    voiceCheckinStatusEl.textContent =
      "Please say better, same, worse, or not sure.";
    return;
  }
  painCheckinState.recoveryStatus = status;
  finishPainCheckin();
}

painCheckinEl.querySelectorAll("[data-pain]").forEach(btn => {
  btn.addEventListener("click", () => {
    acceptPainLevel(parseInt(btn.dataset.pain, 10));
  });
});

painCheckinEl.querySelectorAll("[data-recovery]").forEach((btn) => {
  btn.addEventListener("click", () => {
    acceptRecoveryStatus(btn.dataset.recovery);
  });
});

painCheckinEl.querySelectorAll("[data-pain-confirmation]").forEach((btn) => {
  btn.addEventListener("click", () => {
    acceptPainConfirmation(btn.dataset.painConfirmation);
  });
});

painSafetyChoicesEl.addEventListener("click", (event) => {
  const responseButton = event.target.closest("[data-pain-safety-response]");
  if (responseButton) {
    acceptPainSafetyResponse(responseButton.dataset.painSafetyResponse);
    return;
  }
  const actionButton = event.target.closest("[data-pain-safety-action]");
  if (actionButton?.dataset.painSafetyAction === "save-report") {
    finishPainSafetyInterview({ reportForPhysiotherapist: true });
  } else if (actionButton?.dataset.painSafetyAction === "finish") {
    finishPainSafetyInterview();
  }
});

painVoiceInputBtn.addEventListener("click", () => {
  startPainVoiceListening();
});

exerciseTransitionModalEl
  ?.querySelectorAll("[data-exercise-transition-close]")
  .forEach((element) => {
    element.addEventListener("click", closeExerciseTransition);
  });

exerciseTransitionContinueEl?.addEventListener("click", () => {
  continueToNextExercise();
});

exerciseTransitionHomeEl?.addEventListener("click", () => {
  closeExerciseTransition();
  window.pvShowPatientDashboard?.();
});

sessionSummaryModalEl
  ?.querySelectorAll("[data-session-summary-close]")
  .forEach((element) => {
    element.addEventListener("click", closeSessionSummary);
  });

document.getElementById("sessionSummaryHome")?.addEventListener("click", () => {
  closeSessionSummary();
  window.pvShowPatientDashboard?.();
});

document.addEventListener("keydown", (event) => {
  if (
    event.key === "Escape"
    && exerciseTransitionModalEl?.classList.contains("is-open")
  ) {
    closeExerciseTransition();
    return;
  }
  if (event.key === "Escape" && sessionSummaryModalEl?.classList.contains("is-open")) {
    closeSessionSummary();
  }
});

painSkipBtn.addEventListener("click", () => {
  if (isPainSafetyStage()) return;
  const completed = painCheckinState ? { ...painCheckinState } : null;
  if (completed?.context === "before") {
    preExerciseCheckinCompleted = true;
    confirmedPreExercisePain = null;
  } else if (completed?.context === "after") {
    const beforePain = confirmedPreExercisePain;
    confirmedPreExercisePain = null;
    completed.painLevel = null;
    completed.recoveryStatus = null;
    showPostExerciseDestination(
      completed,
      beforePain,
      Promise.resolve({ skipped: true }),
    );
  }
  hidePainCheckin();
  if (completed) continueAfterPainCheckin(completed);
});

function finishExerciseAndCheckIn({
  source = "button",
  stopReason = "",
  deferCheckin = false,
} = {}) {
  if (!exerciseSessionActive) return false;
  if (!stopReason && shouldAskEarlyStopReason()) {
    return beginEarlyStopReasonPrompt();
  }
  clearExerciseCompletionConfirmation({ cancelListening: true });
  clearEarlyStopPrompt({ cancelListening: true });
  if (running) {
    deactivateCameraGuide({
      statusMessage: "Camera stopped — finishing exercise",
    });
  }
  pendingEarlyStopReason = stopReason;
  completeExerciseSession();
  toggleBtn.classList.add("hidden");
  toggleBtn.innerHTML = 'Pause camera guide <span aria-hidden="true">Ⅱ</span>';
  finishExerciseBtn.disabled = true;
  preExerciseCheckinCompleted = false;
  renderPrimaryCameraAction();
  const stoppedEarly = Boolean(stopReason);
  cameraSessionHintEl.textContent = stoppedEarly
    ? "Your stopped session is saved. The exercise will not restart automatically."
    : source === "voice"
      ? "You said yes. The exercise is marked finished and your check-in is ready."
      : "Exercise marked finished. Complete the optional check-in, or skip it.";
  statusEl.textContent = stoppedEarly
    ? "Exercise stopped and saved"
    : "Exercise marked finished";
  setFeedbackBanner("finished");
  if (!deferCheckin) {
    if (stopReason) {
      showPainCheckin("after", {
        forceSafetyInterview: stopReason === "pain",
        stopReason,
      });
    } else {
      showPainCheckin("after");
    }
  }
  return true;
}

toggleBtn.addEventListener("click", () => {
  if (running) deactivateCameraGuide();
});

finishExerciseBtn.addEventListener("click", () => {
  finishExerciseAndCheckIn();
});

exerciseCompletionConfirmBtn?.addEventListener("click", () => {
  finishExerciseAndCheckIn();
});

exerciseCompletionNotYetBtn?.addEventListener("click", () => {
  declineExerciseCompletionConfirmation();
});

earlyStopReasonChoicesEl?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-stop-reason]");
  if (button) acceptEarlyStopReason(button.dataset.stopReason);
});

earlyStopSkipBtn?.addEventListener("click", () => {
  acceptEarlyStopReason("skipped");
});

earlyStopContinueBtn?.addEventListener("click", () => {
  const stopReason = pendingEarlyStopReason;
  clearEarlyStopPrompt({ cancelListening: true });
  showPainCheckin("after", { stopReason });
});

handTrackingToggle.addEventListener("click", async () => {
  if (handPreviewMode) stopHandPreview();
  else await startHandPreview();
});

fallSafetyOkay.addEventListener("click", () => {
  showFallSafetyResult("okay", activeFallEvent ?? {});
});

fallSafetyHelp.addEventListener("click", () => {
  showFallSafetyResult("help", activeFallEvent ?? {});
});

fallSafetyVoice.addEventListener("click", () => {
  startFallSafetyVoiceListening();
});

fallSafetyClose.addEventListener("click", closeFallSafetyCheck);

syncPracticeAccess();
