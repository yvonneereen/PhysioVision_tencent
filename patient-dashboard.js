import {
  acceptCareInvitation,
  acceptConsultation,
  cancelConsultation,
  createConsultation,
  generateConsultationDraft,
  getCareMessages,
  getConsultations,
  getEscalations,
  getMe,
  getPainCheckins,
  getPrescriptions,
  getSessions,
  isLoggedIn,
  selectPatientPathway,
  sendCareMessage,
} from "./api.js?v=36";
import {
  analysePatientTrend,
  effectivePatientPathway,
  findUpcomingConsultation,
  isClinicianGuidedProfile,
  isCurrentPrescription,
  isPhysiotherapistRequestPending,
  mergeConsultationTranscript,
  shouldShowPhysiotherapistRequest,
  walkingConfidencePlanNeedsRefresh,
} from "./patient-dashboard-state.js?v=17";
import { saveProfile } from "./personalization.js?v=13";
import { getLocale, translateText } from "./i18n.js?v=46";
import { voiceGuidance } from "./voice-guidance.js?v=53";
import { EXERCISE_MAP } from "./exercises/registry.js?v=62";
import {
  buildPlannedSessionKey,
  completedExerciseIdsForPlannedSession,
  nextIncompleteExerciseId,
} from "./planned-session-progress.js?v=3";

const WELLNESS_DOSAGE_LABEL = "1 set of 6–10 repetitions";

const dashboard = document.getElementById("patientDashboard");
const publicMain = document.getElementById("main-content");
const skipLink = document.querySelector(".skip-link");
const patientName = document.getElementById("patientDashboardName");
const intro = document.getElementById("patientDashboardIntro");
const dashboardFeatures = document.getElementById("patientDashboardFeatures");
const primaryActions = document.getElementById(
  "patientDashboardPrimaryActions",
);
const planStatus = document.getElementById("patientPlanStatus");
const planTitle = document.getElementById("patientPlanTitle");
const planIntro = document.getElementById("patientPlanIntro");
const planScheduleHelp = document.getElementById("patientPlanScheduleHelp");
const planList = document.getElementById("patientPlanList");
const planStart = document.getElementById("patientPlanStart");
const planChange = document.getElementById("patientPlanChange");
const primaryStart = document.getElementById("patientStartPrimary");
const demoNotice = document.getElementById("patientDemoNotice");
const dashboardSide = document.getElementById("patientDashboardSide");
const pathwayModal = document.getElementById("patientPathwayModal");
const pathwayStatus = document.getElementById("patientPathwayStatus");
const pathwayInviteForm = document.getElementById(
  "patientPathwayInviteForm",
);
const pathwayInviteCode = document.getElementById(
  "patientPathwayInviteCode",
);
const pathwayInviteSubmit = document.getElementById(
  "patientPathwayInviteSubmit",
);
const pathwayInviteStatus = document.getElementById(
  "patientPathwayInviteStatus",
);
const pathwaySelfRefer = document.getElementById(
  "patientPathwaySelfRefer",
);
const careAcceptedNotice = document.getElementById("patientCareAcceptedNotice");
const careAcceptedMessage = document.getElementById("patientCareAcceptedMessage");
const careAcceptedDismiss = document.getElementById("patientCareAcceptedDismiss");
const referPhysio = document.getElementById("patientReferPhysio");
const referPhysioButton = document.getElementById("patientReferPhysioButton");
const referPhysioStatus = document.getElementById("patientReferPhysioStatus");
const referPhysioTitle = document.getElementById("patientReferPhysioTitle");
const referPhysioCopy = document.getElementById("patientReferPhysioCopy");
const messagesLauncher = document.getElementById("patientMessagesLauncher");
const messagesPanel = document.getElementById("patientMessagesPanel");
const messagesClose = document.getElementById("patientMessagesClose");
const messagesClinician = document.getElementById("patientMessagesClinician");
const messagesThread = document.getElementById("patientMessagesThread");
const messagesForm = document.getElementById("patientMessagesForm");
const messagesInput = document.getElementById("patientMessagesInput");
const trendStatus = document.getElementById("patientTrendStatus");
const trendMessage = document.getElementById("patientTrendMessage");
const trendScope = document.getElementById("patientTrendScope");
const trendChart = document.getElementById("patientTrendChart");
const sessionsMetric = document.getElementById("patientSessionsMetric");
const qualityMetric = document.getElementById("patientQualityMetric");
const painMetric = document.getElementById("patientPainMetric");
const trendAlert = document.getElementById("patientTrendAlert");
const trendAlertTitle = document.getElementById("patientTrendAlertTitle");
const trendAlertMessage = document.getElementById("patientTrendAlertMessage");
const trendAlertGuidance = document.getElementById("patientTrendAlertGuidance");
const trendRequestButton = document.getElementById(
  "patientTrendRequestPhysiotherapist",
);
const trendRequestStatus = document.getElementById(
  "patientTrendRequestStatus",
);
const consultationCard = document.getElementById("patientConsultationCard");
const upcomingConsultation = document.getElementById("patientUpcomingConsultation");
const pendingConsultsEl = document.getElementById("patientPendingConsults");
const bookingForm = document.getElementById("bookingForm");
const bookingStatus = document.getElementById("bookingStatus");
const bookingClinicianName = document.getElementById("bookingClinicianName");
const bookingClinicianAvatar = document.getElementById("bookingClinicianAvatar");
const bookingNotes = document.getElementById("bookingNotes");
const generateBookingDraft = document.getElementById("generateBookingDraft");
const bookingDraftStatus = document.getElementById("bookingDraftStatus");
const bookingVoiceInput = document.getElementById("bookingVoiceInput");
const bookingVoiceStatus = document.getElementById("bookingVoiceStatus");
const toast = document.getElementById("toast");
const toastMessage = document.getElementById("toastMessage");

const TREND_STATUS_LABELS = Object.freeze({
  building_baseline: "Building baseline",
  first_measurement: "First measurement",
  preliminary: "Preliminary",
  stable: "Steady",
  improving: "Improving",
  review_suggested: "Review suggested",
});

const GOAL_BROWSER_LABELS = Object.freeze({
  stronger_knees: "Stronger knees",
  better_balance: "Better balance",
  less_stiffness: "Move with less stiffness",
  stay_active: "Stay active",
  stronger_hips: "Stronger hips",
  shoulder_mobility: "Better shoulder movement",
  ankle_mobility: "Better ankle movement",
  walking_confidence: "Walk with confidence",
  other: "Other",
});

const ACTIVITY_BROWSER_LABELS = Object.freeze({
  lightly_active: "Lightly active",
  mostly_seated: "Mostly seated",
  active_most_days: "Active most days",
});

let currentUser = null;
let currentData = null;
let firstExerciseId = null;
let firstSessionExerciseIds = [];
let firstSessionDay = "";
let firstSessionTitle = "";
let firstSessionKey = "";
let firstSessionCompletedExerciseIds = [];
let pendingPhysiotherapistRefresh = null;
let pendingPhysiotherapistPollTimer = null;
let primaryAction = "plan";
let toastTimer = null;
let bookingEditVersion = 0;
let bookingDraftRequestId = 0;
let bookingVoiceActive = false;
let dashboardActivationPromise = null;
let dashboardActivationUserId = null;

function results(data) {
  return data?.results ?? data ?? [];
}

function initials(name) {
  return String(name ?? "")
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase() || "PV";
}

function formatDate(value, options = {}) {
  if (!value) return "—";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "—";
  return new Intl.DateTimeFormat(getLocale(), {
    day: "numeric",
    month: "short",
    year: "numeric",
    ...options,
  }).format(parsed);
}

function localizableAiPlanSource(value, fallback) {
  const source = String(value ?? "").trim();
  const fallbackText = String(fallback ?? "").trim();
  if (!source) return fallbackText;
  if (getLocale() === "en-SG" || translateText(source) !== source) return source;
  return fallbackText;
}

const WEEKDAY_NAMES = Object.freeze({
  mon: "Monday",
  tue: "Tuesday",
  wed: "Wednesday",
  thu: "Thursday",
  fri: "Friday",
  sat: "Saturday",
  sun: "Sunday",
});

function fullWeekdayName(value, fallback = "") {
  const day = String(value ?? "").trim();
  return WEEKDAY_NAMES[day.slice(0, 3).toLowerCase()] ?? (day || fallback);
}

function setView(mode) {
  const isPatientDashboard = mode === "dashboard";
  dashboard.hidden = !isPatientDashboard;
  publicMain.hidden = isPatientDashboard;
  document.body.classList.toggle("patient-app-active", isPatientDashboard);
  document.body.classList.toggle("patient-practice-active", !isPatientDashboard);
  if (skipLink) {
    skipLink.href = isPatientDashboard ? "#patientDashboard" : "#practice";
  }
}

async function showDashboard(requestedUser = null) {
  const requestedPatient = requestedUser?.role === "patient"
    ? requestedUser
    : null;
  const publishedPatient = window.physioVisionAuthState?.role === "patient"
    ? window.physioVisionAuthState.user
    : null;
  const knownPatient = requestedPatient ?? currentUser ?? publishedPatient;
  if (knownPatient?.role === "patient") {
    if (knownPatient !== currentUser) {
      await activatePatientDashboard(knownPatient);
      return true;
    }
    setView("dashboard");
    window.scrollTo({ top: 0, behavior: "smooth" });
    dashboard.focus({ preventScroll: true });
    return true;
  }
  if (!isLoggedIn()) return false;

  try {
    const user = await getMe();
    if (user?.role !== "patient") return false;
    await activatePatientDashboard(user);
    return true;
  } catch (_) {
    // Keep the authenticated navigation intact and let a later My home click
    // retry the private profile request instead of changing account state.
    return false;
  }
}

function openPlanModal() {
  document.querySelector("[data-open='plan-modal']")?.click();
}

function openAiCompanion() {
  document.getElementById("agentChatLauncher")?.click();
}

function unavailableWellnessExercises(plan) {
  const exerciseIds = (plan?.days ?? []).flatMap(
    (day) => day.exercise_ids ?? day.exerciseIds ?? [],
  );
  return [...new Set(exerciseIds)].filter((exerciseId) => {
    const exercise = EXERCISE_MAP[exerciseId];
    return (
      !exercise
      || exercise.comingSoon
      || exercise.requiresClinicianPlan
    );
  });
}

function startExercise(
  exerciseId = firstExerciseId,
  plannedExerciseIds = [],
  sessionDay = "",
  sessionTitle = "",
  sessionKey = "",
  completedExerciseIds = [],
) {
  if (!exerciseId) {
    if (primaryAction === "ai") {
      openAiCompanion();
    } else if (primaryAction === "request_status") {
      refreshPendingPhysiotherapistRequest();
    } else if (primaryAction === "reload") {
      loadDashboardData();
    } else {
      openPlanModal();
    }
    return;
  }

  const authState = window.physioVisionAuthState ?? null;
  const authProfile =
    authState?.role === "patient" ? authState?.user?.profile ?? null : null;
  const patientProfile = {
    ...(authProfile ?? {}),
    ...(currentUser?.profile ?? {}),
  };
  const sessionExerciseIds = [...new Set(
    (Array.isArray(plannedExerciseIds) ? plannedExerciseIds : [])
      .map((item) => String(item))
      .filter(Boolean)
  )];
  if (!sessionExerciseIds.includes(String(exerciseId))) {
    sessionExerciseIds.unshift(String(exerciseId));
  }
  const practiceRequest = {
    role: "patient",
    profile: Object.keys(patientProfile).length ? patientProfile : null,
    exerciseId,
    plannedExerciseIds: sessionExerciseIds,
    ...(sessionDay ? { sessionDay } : {}),
    ...(sessionTitle ? { sessionTitle } : {}),
    ...(sessionKey ? { sessionKey } : {}),
    completedExerciseIds: [...new Set(
      (Array.isArray(completedExerciseIds) ? completedExerciseIds : [])
        .map((item) => String(item))
        .filter(Boolean)
    )],
  };

  // The camera and tracking engine is deliberately absent from initial page
  // startup. Begin fetching it only when the patient actually starts an
  // exercise; main.js consumes the pending request once it has loaded.
  void window.pvLoadMovementApp?.().catch((error) => {
    console.error("Movement guide could not be loaded", error);
  });
  window.physioVisionPendingPracticeRequest = practiceRequest;

  if (typeof window.physioVisionOpenPractice === "function") {
    window.physioVisionOpenPractice(practiceRequest);
  } else {
    window.dispatchEvent(
      new CustomEvent("physiovision:practice-requested", {
        detail: practiceRequest,
      }),
    );
  }

  setView("practice");
  const exerciseSelect = document.getElementById("exerciseSelect");
  if (exerciseSelect) {
    exerciseSelect.value = exerciseId;
    exerciseSelect.dispatchEvent(new Event("change", { bubbles: true }));
  }
  document.getElementById("practice")?.scrollIntoView({ behavior: "smooth" });
}

function planRow({
  label,
  title,
  detail,
  exerciseId = null,
  plannedExerciseIds = [],
  exerciseNames = [],
  sessionFocus = "",
  dose = "",
  startLabel = "Start",
  sessionDay = "",
  sessionTitle = "",
  sessionKey = "",
  completedExerciseIds = [],
  statusLabel = "",
  note = "",
}) {
  const row = document.createElement("article");
  row.className = "patient-plan-row";

  const marker = document.createElement("span");
  marker.className = "patient-plan-marker";
  marker.textContent = label;

  const copy = document.createElement("div");
  const heading = document.createElement("strong");
  heading.textContent = title;
  const description = document.createElement("span");
  description.textContent = detail;
  copy.appendChild(heading);
  if (detail) copy.appendChild(description);
  if (exerciseNames.length) {
    const exerciseHeading = document.createElement("span");
    exerciseHeading.className = "patient-plan-exercise-heading";
    exerciseHeading.textContent = translateText("Exercises for this day");
    const exerciseList = document.createElement("ol");
    exerciseList.className = "patient-plan-exercise-list";
    const completed = new Set(
      completedExerciseIds.map((exerciseId) => String(exerciseId))
    );
    exerciseNames.forEach((exerciseName, index) => {
      const item = document.createElement("li");
      const exerciseIdForItem = String(plannedExerciseIds[index] ?? "");
      item.textContent = translateText(exerciseName);
      if (completed.has(exerciseIdForItem)) {
        item.classList.add("is-complete");
        const badge = document.createElement("span");
        badge.className = "patient-plan-exercise-complete";
        badge.textContent = `✓ ${translateText("Completed")}`;
        item.append(" ", badge);
      }
      exerciseList.appendChild(item);
    });
    copy.append(exerciseHeading, exerciseList);
  }
  if (sessionFocus) {
    const focus = document.createElement("small");
    focus.className = "patient-plan-session-focus";
    focus.textContent = `${translateText("Session focus")}: ${translateText(sessionFocus)}`;
    copy.appendChild(focus);
  }
  if (dose) {
    const dosage = document.createElement("small");
    dosage.className = "patient-plan-dose";
    dosage.textContent = `${translateText("Dose for each exercise")}: ${translateText(dose)}`;
    copy.appendChild(dosage);
  }
  if (note) {
    const notes = document.createElement("small");
    notes.textContent = note;
    copy.appendChild(notes);
  }

  row.append(marker, copy);
  if (exerciseId) {
    const start = document.createElement("button");
    start.className = "text-link";
    start.type = "button";
    start.textContent = startLabel;
    start.addEventListener("click", () => (
      startExercise(
        exerciseId,
        plannedExerciseIds,
        sessionDay,
        sessionTitle,
        sessionKey,
        completedExerciseIds,
      )
    ));
    row.appendChild(start);
  } else if (statusLabel) {
    const status = document.createElement("span");
    status.className = "patient-plan-row-status";
    status.textContent = statusLabel;
    row.appendChild(status);
  }
  return row;
}

function setPhysiotherapistRequestVisibility(visible) {
  if (!referPhysio) return;
  referPhysio.hidden = !visible;
  referPhysio.classList.toggle("is-hidden", !visible);
  referPhysio.setAttribute("aria-hidden", String(!visible));
  referPhysio.style.display = visible ? "" : "none";
}

function setPhysiotherapistRequestButtonLabel(label, showArrow = false) {
  if (!referPhysioButton) return;
  referPhysioButton.replaceChildren(document.createTextNode(translateText(label)));
  if (showArrow) {
    const arrow = document.createElement("span");
    arrow.setAttribute("aria-hidden", "true");
    arrow.textContent = "→";
    referPhysioButton.append(" ", arrow);
  }
}

function renderPhysiotherapistRequest(profile) {
  const pending = isPhysiotherapistRequestPending(profile);
  const visible = pending || shouldShowPhysiotherapistRequest(profile);
  setPhysiotherapistRequestVisibility(visible);
  if (!visible) return;

  if (pending) {
    referPhysioTitle.textContent = translateText(
      "Physiotherapist request pending",
    );
    referPhysioCopy.textContent = translateText(
      "Your wellness plan stays active while a physiotherapist reviews your request.",
    );
    setPhysiotherapistRequestButtonLabel("Request pending");
    referPhysioButton.disabled = true;
    referPhysioStatus.textContent = translateText(
      "Waiting for a physiotherapist to accept your request.",
    );
    return;
  }

  referPhysioTitle.textContent = translateText(
    "Want a physiotherapist to guide you?",
  );
  referPhysioCopy.textContent = translateText(
    "Send your recent movement and pain history to the care team. A physiotherapist will pick up your case and take over your plan.",
  );
  setPhysiotherapistRequestButtonLabel("Request a physiotherapist", true);
  referPhysioButton.disabled = false;
  referPhysioStatus.textContent = "";
}

function renderClinicianPlan(prescriptions) {
  const active = prescriptions.filter((item) => isCurrentPrescription(item));
  const activeExerciseIds = active.map((item) => String(item.exercise));
  firstExerciseId = active[0]?.exercise ?? null;
  firstSessionExerciseIds = activeExerciseIds;
  firstSessionDay = "";
  firstSessionTitle = "";
  firstSessionKey = "";
  firstSessionCompletedExerciseIds = [];
  planStart.disabled = false;
  planTitle.textContent = translateText("Specialist-assigned programme");
  planScheduleHelp.hidden = true;
  dashboard.classList.remove("wellness-dashboard");
  primaryActions.hidden = false;
  dashboardSide.hidden = false;
  consultationCard.hidden = false;
  // Entering this renderer already proves that this is a clinician-guided
  // patient. They can use the consultation card for their existing care team
  // and must never see the self-referral action.
  setPhysiotherapistRequestVisibility(false);
  setupPatientMessaging(currentUser?.profile);
  const isDemo = active.some((item) => item.is_demo);
  demoNotice.hidden = !isDemo;

  if (!active.length) {
    primaryAction = "reload";
    planStatus.textContent = "Awaiting assignment";
    planStatus.className = "status-pill status-pill-review";
    planIntro.textContent =
      "You are on a physiotherapist-guided pathway, but no current exercise has been assigned yet.";
    planList.appendChild(planRow({
      label: "i",
      title: "Your specialist is preparing the detailed plan",
      detail:
        "Exercises stay locked until your physiotherapist assigns the movement, dose and restrictions.",
      note: "Use the single Consultation card if you need to contact a physiotherapist.",
    }));
    planStart.textContent = "Check for my assigned plan";
    primaryStart.textContent = "Check for assigned exercises";
    return;
  }

  primaryAction = "exercise";
  const clinicianName = isDemo
    ? "the prototype display"
    : (
      active.find((item) => item.clinician_name)?.clinician_name ??
      "your physiotherapist"
    );
  planStatus.textContent = isDemo ? "Prototype sample" : "Specialist assigned";
  planStatus.className = "status-pill";
  planIntro.textContent =
    isDemo
      ? (
        "Example: early rehabilitation after total knee replacement. These "
        + "sample doses are interface data, not instructions for a real patient."
      )
      : `Detailed plan assigned by ${clinicianName}. Follow these doses and notes exactly.`;
  active.forEach((prescription, index) => {
    const hold = prescription.hold_seconds
      ? ` · hold ${prescription.hold_seconds}s`
      : "";
    planList.appendChild(planRow({
      label: String(index + 1),
      title: prescription.exercise_name,
      detail:
        `${prescription.sets} sets × ${prescription.reps} reps${hold} · ${prescription.days_per_week} days/week`,
      exerciseId: prescription.exercise,
      plannedExerciseIds: activeExerciseIds,
      note: prescription.notes || "No additional specialist note.",
    }));
  });
  planStart.innerHTML = 'Start assigned exercises <span aria-hidden="true">→</span>';
  primaryStart.innerHTML = 'Start today’s exercises <span aria-hidden="true">→</span>';
}

function renderPendingPhysiotherapistPlan() {
  firstExerciseId = null;
  firstSessionExerciseIds = [];
  firstSessionDay = "";
  firstSessionTitle = "";
  firstSessionKey = "";
  firstSessionCompletedExerciseIds = [];
  primaryAction = "request_status";
  dashboard.classList.add("wellness-dashboard");
  primaryActions.hidden = true;
  dashboardSide.hidden = true;
  consultationCard.hidden = true;
  demoNotice.hidden = true;
  setPhysiotherapistRequestVisibility(false);
  if (messagesLauncher) messagesLauncher.hidden = true;
  closeMessagesPanel();

  planTitle.textContent = translateText("Physiotherapist request pending");
  planStatus.textContent = translateText("Request pending");
  planStatus.className = "status-pill status-pill-review";
  planIntro.textContent = translateText(
    "Waiting for a physiotherapist to accept your request.",
  );
  planList.appendChild(planRow({
    label: "i",
    title: "Your request has been sent",
    detail:
      "A physiotherapist must review and accept it before this account changes to clinician-guided care.",
    note:
      "Approved exercises will appear only after acceptance and assignment by your physiotherapist.",
  }));
  planStart.textContent = "Check request status";
  primaryStart.textContent = "Check request status";
}

function renderWellnessPlan(profile) {
  firstExerciseId = null;
  firstSessionExerciseIds = [];
  firstSessionDay = "";
  firstSessionTitle = "";
  firstSessionKey = "";
  firstSessionCompletedExerciseIds = [];
  planStart.disabled = false;
  planTitle.textContent = translateText("Your weekly programme");
  planScheduleHelp.hidden = true;
  const screeningStatus =
    profile?.wellness_screening_status ??
    profile?.wellnessScreening?.status;
  const eligible = screeningStatus === "eligible";
  dashboard.classList.add("wellness-dashboard");
  primaryActions.hidden = true;
  dashboardSide.hidden = true;
  consultationCard.hidden = true;
  demoNotice.hidden = true;
  renderPhysiotherapistRequest(profile);
  if (messagesLauncher) messagesLauncher.hidden = true;
  closeMessagesPanel();

  if (!eligible) {
    firstExerciseId = null;
    const needsReview =
      screeningStatus === "needs_review" ||
      (profile?.care_path ?? profile?.carePath) === "needs_review";
    primaryAction = "plan";
    planStatus.textContent = needsReview ? "Review needed" : "No plan yet";
    planStatus.className = needsReview
      ? "status-pill status-pill-review"
      : "status-pill";
    planIntro.textContent = needsReview
      ? (
        "No self-guided plan has been created. Review your safety-screen "
        + "answers before using general-wellness exercises."
      )
      : (
        "No plan has been created yet. Ask the AI movement companion to help "
        + "you begin a personalized general-wellness plan."
      );
    planList.appendChild(planRow({
      label: needsReview ? "!" : "1",
      title: needsReview
        ? "Review the wellness safety screen"
        : "Start with your AI movement companion",
      detail: needsReview
        ? (
          "This is not a diagnosis. Self-guided exercises remain locked while "
          + "an answer indicates that professional guidance may be safer."
        )
        : (
          "The AI can help clarify your goal. Exercise access is created only "
          + "after the short general-wellness safety screen is eligible."
        ),
    }));
    planStart.textContent = needsReview
      ? "Review my safety screen"
      : "Ask AI to create my plan";
    return;
  }

  const plan = profile.wellness_plan ?? profile.wellnessPlan;
  if (!plan?.days?.length) {
    firstExerciseId = null;
    primaryAction = "plan";
    planStatus.textContent = "Ready for an AI draft";
    planStatus.className = "status-pill";
    planIntro.textContent =
      "Your safety screen is eligible, but no AI plan has been accepted yet.";
    planList.appendChild(planRow({
      label: "✦",
      title: "Create and review your AI plan",
      detail:
        "Answer the short planning interview, review why each session was chosen, and accept the draft before exercises unlock.",
      note:
        "Passing the safety screen alone never assigns exercises.",
    }));
    planStart.textContent = "Create my plan with AI";
    return;
  }

  const unavailableExercises = unavailableWellnessExercises(plan);
  const needsBalanceRefresh = walkingConfidencePlanNeedsRefresh(plan);
  if (unavailableExercises.length || needsBalanceRefresh) {
    firstExerciseId = null;
    primaryAction = "plan";
    planStatus.textContent = "Plan refresh needed";
    planStatus.className = "status-pill status-pill-review";
    planIntro.textContent = needsBalanceRefresh
      ? "Your saved walking-confidence plan needs more direct balance practice."
      : "Your saved AI plan contains an exercise that now requires physiotherapist approval.";
    planList.appendChild(planRow({
      label: "!",
      title: needsBalanceRefresh
        ? "Create an updated AI plan"
        : "Create a new AI wellness plan",
      detail: needsBalanceRefresh
        ? (
          "This plan was created before walking-confidence drafts were required "
          + "to include supported balance. Create a new draft to apply the updated selection rules."
        )
        : (
          "The camera remains locked for clinician-only movements. A new draft "
          + "will use only exercises available to your general-wellness pathway."
        ),
      note: needsBalanceRefresh
        ? "Your accepted plan is unchanged until you review and accept the replacement."
        : "Your safety-screen result is unchanged; only the incompatible saved plan needs replacing.",
    }));
    planStart.textContent = needsBalanceRefresh
      ? "Create an updated AI plan"
      : "Create a new AI plan";
    return;
  }

  primaryAction = "exercise";
  const acceptedAt = (
    profile.wellness_plan_accepted_at
    ?? profile.wellnessPlanAcceptedAt
    ?? plan.accepted_at
    ?? "accepted-plan"
  );
  const completedSessions = currentData?.sessions ?? [];
  planStatus.textContent = "AI plan accepted";
  planStatus.className = "status-pill";
  planScheduleHelp.hidden = false;
  planIntro.textContent = localizableAiPlanSource(
    plan.summary,
    `A gradual plan focused on ${plan.goal ?? "Stay active"}.`,
  );
  plan.days.forEach((day, index) => {
    const exerciseIds = (day.exercise_ids ?? day.exerciseIds ?? [])
      .map((exerciseId) => String(exerciseId));
    const exerciseNames = exerciseIds
      .map((exerciseId) => EXERCISE_MAP[exerciseId]?.name)
      .filter(Boolean);
    const dayName = fullWeekdayName(day.day, `Session ${index + 1}`);
    const sessionFallback = day.exercises
      || exerciseNames.join(" · ")
      || `Session ${index + 1}`;
    const sessionTitle = localizableAiPlanSource(day.title, sessionFallback);
    const sessionKey = buildPlannedSessionKey({
      acceptedAt,
      day: dayName,
      dayIndex: index,
      exerciseIds,
    });
    const completedExerciseIds = completedExerciseIdsForPlannedSession(
      completedSessions,
      sessionKey,
    );
    const nextExerciseId = nextIncompleteExerciseId(
      exerciseIds,
      completedExerciseIds,
    );
    const nextExerciseName = nextExerciseId
      ? EXERCISE_MAP[nextExerciseId]?.name ?? nextExerciseId
      : "";

    if (!firstExerciseId && nextExerciseId) {
      firstExerciseId = nextExerciseId;
      firstSessionExerciseIds = exerciseIds;
      firstSessionDay = dayName;
      firstSessionTitle = sessionTitle;
      firstSessionKey = sessionKey;
      firstSessionCompletedExerciseIds = completedExerciseIds;
    }

    planList.appendChild(planRow({
      label: translateText(day.day),
      title: `${translateText(dayName)} ${translateText("session")}`,
      detail: "",
      exerciseId: nextExerciseId,
      plannedExerciseIds: exerciseIds,
      exerciseNames,
      sessionFocus: sessionTitle,
      dose: day.dosage || WELLNESS_DOSAGE_LABEL,
      startLabel: completedExerciseIds.length
        ? `${translateText("Resume with")} ${translateText(nextExerciseName)}`
        : `${translateText("Start")} ${translateText(dayName)}`,
      sessionDay: dayName,
      sessionTitle,
      sessionKey,
      completedExerciseIds,
      statusLabel: nextExerciseId ? "" : translateText("Session complete"),
      note:
        "AI draft accepted by you. Stop if you feel unwell or develop new or concerning symptoms.",
    }));
  });
  if (firstExerciseId) {
    const hasStartedSession = firstSessionCompletedExerciseIds.length > 0;
    const nextExerciseName = EXERCISE_MAP[firstExerciseId]?.name ?? firstExerciseId;
    planStart.replaceChildren(document.createTextNode(
      hasStartedSession
        ? `${translateText("Resume with")} ${translateText(nextExerciseName)} `
        : `${translateText("Start wellness exercises")} `,
    ));
    const arrow = document.createElement("span");
    arrow.setAttribute("aria-hidden", "true");
    arrow.textContent = "→";
    planStart.appendChild(arrow);
  } else {
    planStart.textContent = translateText("Weekly programme complete");
    planStart.disabled = true;
  }
  if (planChange) planChange.hidden = false;
  primaryStart.innerHTML = 'Start today’s exercises <span aria-hidden="true">→</span>';
}

function renderPlan(user, prescriptions) {
  planList.innerHTML = "";
  planScheduleHelp.hidden = true;
  if (planChange) planChange.hidden = true;
  const profile = user.profile ?? {};
  if (isPhysiotherapistRequestPending(profile) && (
    profile.pathway_choice ?? profile.pathwayChoice ?? "unselected"
  ) === "unselected") {
    renderPendingPhysiotherapistPlan();
  } else if (isClinicianGuidedProfile(profile)) {
    renderClinicianPlan(prescriptions);
  } else {
    renderWellnessPlan(profile);
  }
}

function renderTrendChart(series) {
  trendChart.innerHTML = "";
  if (!series.length) {
    const empty = document.createElement("p");
    empty.textContent = "No validation-gated coaching-response scores yet.";
    trendChart.appendChild(empty);
    trendChart.setAttribute(
      "aria-label",
      "No validated coaching-response trend is available yet",
    );
    return;
  }

  series.forEach((value, index) => {
    const bar = document.createElement("span");
    bar.style.height = `${Math.max(8, Math.min(100, value))}%`;
    bar.title = `Session ${index + 1}: ${Math.round(value)} out of 100`;
    trendChart.appendChild(bar);
  });
  trendChart.setAttribute(
    "aria-label",
    `Validated coaching-response scores from oldest to newest: ${series
      .map((value) => Math.round(value))
      .join(", ")}`,
  );
}

function renderTrend(data) {
  const trend = analysePatientTrend(data);
  const profile = currentUser?.profile ?? {};
  const isPhysiotherapistPath = isClinicianGuidedProfile(profile);
  trendStatus.textContent = TREND_STATUS_LABELS[trend.status];
  trendStatus.className =
    trend.status === "review_suggested"
      ? "status-pill status-pill-review"
      : "status-pill";
  trendMessage.textContent = `${trend.title}. ${trend.message}`;
  if (trend.focusExercise) {
    const exerciseName = trend.focusExerciseName || trend.focusExercise;
    const side = trend.focusSide ? `${trend.focusSide} side` : "selected side";
    const measurementLabel = trend.movementMeasurementCount === 1
      ? "1 real camera measurement"
      : `${trend.movementMeasurementCount} real camera measurements`;
    trendScope.textContent =
      `Comparing ${exerciseName} on the ${side} only · ${measurementLabel}`;
    trendScope.hidden = false;
  } else {
    trendScope.textContent = "";
    trendScope.hidden = true;
  }
  sessionsMetric.textContent = String(trend.sessionsThisWeek);
  qualityMetric.textContent =
    trend.averageQuality === null ? "—" : `${Math.round(trend.averageQuality)}/100`;
  painMetric.textContent =
    trend.latestPain === null ? "—" : `${Math.round(trend.latestPain)}/10`;
  renderTrendChart(trend.qualitySeries);

  const shouldShowAlert = trend.status === "review_suggested";
  trendAlert.classList.toggle("hidden", !shouldShowAlert);
  if (shouldShowAlert) {
    const isPainWarning = ["high_pain", "pain_increase"].includes(trend.reason);
    trendAlertTitle.textContent = isPainWarning
      ? trend.title
      : isPhysiotherapistPath
        ? trend.title
        : "Pause your wellness plan and seek professional advice";
    trendAlertMessage.textContent = trend.message;
    trendAlertGuidance.textContent = isPainWarning && isPhysiotherapistPath
      ? (
        "Book a consultation with your physiotherapist before continuing. "
        + "For severe, new, or worsening pain—or chest pain, breathing "
        + "difficulty, fainting, sudden weakness, or numbness—seek urgent help."
      )
      : isPainWarning
        ? (
          "Request a physiotherapist before continuing. For severe, new, or "
          + "worsening pain—or chest pain, breathing difficulty, fainting, "
          + "sudden weakness, or numbness—seek urgent help."
        )
        : isPhysiotherapistPath
      ? (
        "This is a trend prompt, not a diagnosis. Send a consultation "
        + "request if you want your physiotherapist to review this pattern."
      )
      : (
        "This is a trend prompt, not a diagnosis. You can request an "
        + "available PhysioVision physiotherapist; the request is not "
        + "confirmed until it is accepted."
      );
    renderTrendConsultationAction(
      data.consultations,
      isPhysiotherapistPath,
      isPainWarning,
    );
  }
}

function describeConsultation(consultation) {
  if (!consultation.scheduled_at) {
    const clinicianName = consultation.clinician_name
      || translateText("Your physiotherapist");
    return `${translateText("Request pending")}: ${clinicianName} ${translateText("will propose an appointment time.")}`;
  }
  const status = consultation.status === "confirmed"
    ? "Confirmed"
    : "Requested";
  return `${status}: ${formatDate(consultation.scheduled_at, {
    hour: "numeric",
    minute: "2-digit",
  })} with ${consultation.clinician_name || "the PhysioVision care team"}.`;
}

function renderTrendConsultationAction(
  consultations,
  isPhysiotherapistPath = false,
  isPainWarning = false,
) {
  if (!trendRequestButton || !trendRequestStatus) return;
  const next = findUpcomingConsultation(consultations);

  if (next) {
    trendRequestButton.disabled = true;
    trendRequestButton.textContent = next.status === "confirmed"
      ? "Physiotherapist confirmed"
      : "Review already requested";
    trendRequestStatus.textContent = describeConsultation(next);
    return;
  }

  trendRequestButton.disabled = false;
  trendRequestButton.innerHTML = isPainWarning && isPhysiotherapistPath
    ? 'Book a consultation <span aria-hidden="true">→</span>'
    : isPhysiotherapistPath
      ? 'Ask my physiotherapist to review <span aria-hidden="true">→</span>'
    : 'Request a physiotherapist <span aria-hidden="true">→</span>';
  trendRequestStatus.textContent = isPainWarning && isPhysiotherapistPath
    ? "Choose a preferred time and tell your physiotherapist about the pain you reported."
    : isPhysiotherapistPath
      ? "Tell your physiotherapist what you would like reviewed. They will propose the appointment time."
    : "Tell a physiotherapist what you would like reviewed. They will propose the appointment time.";
}

function renderUpcomingConsultation(consultations) {
  const next = findUpcomingConsultation(consultations);

  if (!next) {
    upcomingConsultation.textContent = "No consultation currently scheduled.";
    return;
  }
  upcomingConsultation.textContent = describeConsultation(next);
}

// Consultations the clinician suggested, awaiting this patient's response.
function renderPendingConsults(consultations) {
  if (!pendingConsultsEl) return;
  const now = new Date();
  const pending = consultations.filter((c) =>
    c.status === "requested" &&
    c.initiated_by === "clinician" &&
    Boolean(c.scheduled_at) &&
    new Date(c.scheduled_at) >= now
  );

  if (!pending.length) {
    pendingConsultsEl.innerHTML = "";
    return;
  }

  pendingConsultsEl.innerHTML = pending.map((c) => {
    const when = formatDate(c.scheduled_at, { hour: "numeric", minute: "2-digit" });
    return `
      <div class="pending-consult" data-consult-id="${c.id}" data-consult-when="${c.scheduled_at}">
        <p class="pending-consult-title">Your physiotherapist suggested a consultation</p>
        <p class="pending-consult-time">${when} with ${c.clinician_name || "your care team"}</p>
        <div class="pending-consult-actions">
          <button class="button button-coral button-small" data-consult-accept="${c.id}">Accept</button>
          <button class="button button-light button-small" data-consult-decline="${c.id}">Decline</button>
        </div>
        <p class="pending-consult-status" id="pendingStatus-${c.id}"></p>
      </div>`;
  }).join("");
}

async function handlePendingConsultClick(event) {
  const acceptId  = event.target.getAttribute("data-consult-accept");
  const declineId = event.target.getAttribute("data-consult-decline");
  const id = acceptId || declineId;
  if (!id) return;

  const statusEl = document.getElementById(`pendingStatus-${id}`);
  try {
    if (acceptId) {
      await acceptConsultation(acceptId);
    } else if (declineId) {
      await cancelConsultation(declineId);
    }
    await loadDashboardData();
  } catch (err) {
    if (statusEl) statusEl.textContent = err.message || "Something went wrong.";
  }
}

pendingConsultsEl?.addEventListener("click", handlePendingConsultClick);

function setBookingClinician(prescriptions) {
  const clinicianName =
    prescriptions.find(
      (item) => item.clinician_name && !item.is_demo
    )?.clinician_name;
  if (!clinicianName) return;
  bookingClinicianName.textContent = clinicianName;
  bookingClinicianAvatar.textContent = initials(clinicianName);
}

async function loadDashboardData() {
  if (!currentUser || currentUser.role !== "patient") return;
  planStart.disabled = false;
  planStatus.textContent = "Loading plan…";
  planIntro.textContent =
    "We are loading the exercises available for your care pathway.";
  planList.innerHTML = "";

  const requests = await Promise.allSettled([
    getPrescriptions(),
    getSessions(),
    getPainCheckins(),
    getEscalations(),
    getConsultations(),
  ]);
  const read = (index) =>
    requests[index].status === "fulfilled" ? results(requests[index].value) : [];

  currentData = {
    prescriptions: read(0),
    sessions: read(1),
    painCheckins: read(2),
    escalations: read(3),
    consultations: read(4),
  };
  window.sessionStorage.setItem(
    "physiovision.prescriptions.v1",
    JSON.stringify(currentData.prescriptions),
  );
  window.dispatchEvent(new CustomEvent(
    "physiovision:prescriptions-updated",
    { detail: currentData.prescriptions },
  ));
  if (requests[0].status === "rejected") {
    firstExerciseId = null;
    primaryAction = "reload";
    planStatus.textContent = "Plan unavailable";
    planStatus.className = "status-pill status-pill-review";
    planIntro.textContent =
      "Your plan could not be loaded. No exercise access has been changed.";
    planList.appendChild(planRow({
      label: "!",
      title: "We could not reach your private plan",
      detail: "Check your connection and try again.",
    }));
    planStart.textContent = "Try loading again";
    primaryStart.textContent = "Try loading plan again";
  } else {
    renderPlan(currentUser, currentData.prescriptions);
  }

  if (
    requests[1].status === "rejected" &&
    requests[2].status === "rejected"
  ) {
    trendStatus.textContent = "Unavailable";
    trendStatus.className = "status-pill status-pill-review";
    trendMessage.textContent =
      "Your private session and pain history could not be loaded.";
    sessionsMetric.textContent = "—";
    qualityMetric.textContent = "—";
    painMetric.textContent = "—";
    renderTrendChart([]);
    trendAlert.classList.add("hidden");
  } else {
    renderTrend(currentData);
  }
  renderUpcomingConsultation(currentData.consultations);
  renderPendingConsults(currentData.consultations);
  setBookingClinician(currentData.prescriptions);
}

async function activatePatientDashboard(user) {
  if (user?.role !== "patient") return false;
  const userId = String(user.id ?? user.email ?? "patient");
  if (
    dashboardActivationPromise
    && dashboardActivationUserId === userId
  ) {
    return dashboardActivationPromise;
  }

  currentUser = user;
  patientName.textContent = user.first_name || "there";
  // Route first. Failure of the optional browser cache must never leave an
  // authenticated patient looking at the public landing page.
  setView("dashboard");
  dashboardActivationUserId = userId;
  dashboardActivationPromise = (async () => {
    try {
      saveProfile({
        ...browserProfileFromApi(user.profile ?? {}),
        name: user.first_name ?? "",
      }, {
        syncBackend: false,
        syncScreening: false,
      });
    } catch (_) {
      // Session storage is only a cache. The backend profile remains the
      // source of truth for authentication and clinician linkage.
    }

    const choice = effectivePatientPathway(user.profile ?? {});
    if (choice === "unselected") {
      intro.textContent =
        "Choose your exercise pathway to open the correct patient functions.";
      showPathwayChoice();
      return true;
    }
    hidePathwayChoice();
    updateDashboardIntro(choice);
    await loadDashboardData();
    schedulePendingPhysiotherapistRefresh();
    return true;
  })().finally(() => {
    if (dashboardActivationUserId === userId) {
      dashboardActivationPromise = null;
      dashboardActivationUserId = null;
    }
  });
  return dashboardActivationPromise;
}

function updateDashboardIntro(choice) {
  const waitingForPhysiotherapist = choice === "physiotherapist_pending";
  const usesPhysiotherapist = choice === "physiotherapist";
  intro.textContent = waitingForPhysiotherapist
    ? (
      "Your physiotherapist request is being reviewed. This home will switch "
      + "automatically after a physiotherapist accepts you."
    )
    : usesPhysiotherapist
    ? (
      "Review your physiotherapist-assigned plan, start approved exercises "
      + "and follow your progress."
    )
    : (
      "For older adults without a diagnosed condition or clinician "
      + "restrictions. Use AI support to create a conservative wellness plan, "
      + "complete camera-guided exercises, record pain check-ins and follow "
      + "your movement progress over time."
    );

  const features = waitingForPhysiotherapist
    ? [
      "Request sent",
      "Awaiting physiotherapist acceptance",
      "Automatic account update",
    ]
    : usesPhysiotherapist
    ? [
      "Specialist-assigned programme",
      "Approved movement guidance",
      "Progress and pain trends",
    ]
    : [
      "AI-assisted wellness plan",
      "Camera-guided exercises",
      "Pain check-ins",
      "Movement progress trends",
    ];
  dashboardFeatures.replaceChildren(
    ...features.map((label) => {
      const item = document.createElement("li");
      item.textContent = label;
      return item;
    }),
  );
}

function showPathwayChoice() {
  pathwayModal.classList.add("is-open");
  pathwayModal.setAttribute("aria-hidden", "false");
  document.body.classList.add("modal-open");
  window.setTimeout(() => {
    pathwayModal.querySelector("[data-pathway-choice]")?.focus();
  }, 50);
}

function hidePathwayChoice() {
  pathwayModal.classList.remove("is-open");
  pathwayModal.setAttribute("aria-hidden", "true");
  document.body.classList.remove("modal-open");
}

function setPathwayButtonsDisabled(disabled) {
  pathwayModal
    ?.querySelectorAll("[data-pathway-choice]")
    .forEach((button) => { button.disabled = disabled; });
}

function showPathwayInviteEntry() {
  pathwayInviteForm.hidden = false;
  pathwayStatus.textContent = "";
  pathwayModal
    ?.querySelectorAll("[data-pathway-choice]")
    .forEach((button) => {
      const selected =
        button.dataset.pathwayChoice === "physiotherapist";
      button.classList.toggle("is-selected", selected);
      button.setAttribute("aria-pressed", String(selected));
    });
  window.setTimeout(() => pathwayInviteCode?.focus(), 50);
}

async function finishPathwaySetup(profile, user = currentUser) {
  currentUser = { ...user, profile };
  const browserProfile = browserProfileFromApi(profile);
  window.dispatchEvent(new CustomEvent(
    "physiovision:profile-updated",
    { detail: browserProfile },
  ));
  hidePathwayChoice();
  updateDashboardIntro(effectivePatientPathway(profile));
  pathwayStatus.textContent = "";
  await loadDashboardData();
  schedulePendingPhysiotherapistRefresh();
}

function clearPendingPhysiotherapistRefresh() {
  window.clearTimeout(pendingPhysiotherapistPollTimer);
  pendingPhysiotherapistPollTimer = null;
}

function schedulePendingPhysiotherapistRefresh() {
  clearPendingPhysiotherapistRefresh();
  if (
    document.hidden
    || !isPhysiotherapistRequestPending(currentUser?.profile)
  ) {
    return;
  }
  pendingPhysiotherapistPollTimer = window.setTimeout(
    () => { void refreshPendingPhysiotherapistRequest(); },
    15_000,
  );
}

function showCareAcceptance(profile) {
  const clinicianName =
    profile?.primary_clinician_name
    || translateText("Your physiotherapist");
  if (careAcceptedMessage) {
    careAcceptedMessage.textContent =
      `${clinicianName} accepted your request. Your patient home has switched `
      + "to the physiotherapist-guided version.";
  }
  if (careAcceptedNotice) {
    careAcceptedNotice.hidden = false;
  }
  document
    .querySelector(".modal-shell.is-open [data-close-modal]")
    ?.click();
  showToast(
    `${clinicianName} accepted your request. Your patient home has been updated.`,
    "Physiotherapist request accepted",
  );
  careAcceptedNotice?.scrollIntoView({ behavior: "smooth", block: "center" });
}

async function refreshPendingPhysiotherapistRequest() {
  if (
    !isPhysiotherapistRequestPending(currentUser?.profile)
    || pendingPhysiotherapistRefresh
  ) {
    return;
  }

  pendingPhysiotherapistRefresh = getMe()
    .then(async (user) => {
      if (user?.role !== "patient") return;

      if (isClinicianGuidedProfile(user.profile)) {
        clearPendingPhysiotherapistRefresh();
        await activatePatientDashboard(user);
        showCareAcceptance(user.profile);
        return;
      }

      if (!isPhysiotherapistRequestPending(user.profile)) {
        await activatePatientDashboard(user);
        return;
      }

      currentUser = user;
      updateDashboardIntro(effectivePatientPathway(user.profile));
      renderPlan(currentUser, currentData?.prescriptions ?? []);
    })
    .catch(() => {})
    .finally(() => {
      pendingPhysiotherapistRefresh = null;
      schedulePendingPhysiotherapistRefresh();
    });

  await pendingPhysiotherapistRefresh;
}

// ── Messaging with the assigned physiotherapist ──────────────

function setupPatientMessaging(profile) {
  if (!messagesLauncher) return;
  const hasClinician = Boolean(profile?.primary_clinician);
  messagesLauncher.hidden = !hasClinician;
  if (!hasClinician) {
    closeMessagesPanel();
    return;
  }
  if (messagesClinician) {
    messagesClinician.textContent =
      profile.primary_clinician_name || "your physiotherapist";
  }
}

function openMessagesPanel() {
  if (!messagesPanel) return;
  messagesPanel.hidden = false;
  messagesLauncher?.setAttribute("aria-expanded", "true");
  loadCareMessages();
  messagesInput?.focus();
}

function closeMessagesPanel() {
  if (!messagesPanel) return;
  messagesPanel.hidden = true;
  messagesLauncher?.setAttribute("aria-expanded", "false");
}

messagesLauncher?.addEventListener("click", () => {
  if (messagesPanel?.hidden) openMessagesPanel();
  else closeMessagesPanel();
});
messagesClose?.addEventListener("click", closeMessagesPanel);

async function loadCareMessages() {
  if (!messagesThread) return;
  try {
    const data = await getCareMessages();
    renderCareMessages(results(data));
  } catch (_) {
    messagesThread.innerHTML =
      '<p class="patient-messages-empty">Could not load messages.</p>';
  }
}

function renderCareMessages(messages) {
  messagesThread.innerHTML = "";
  if (!messages.length) {
    const empty = document.createElement("p");
    empty.className = "patient-messages-empty";
    empty.textContent = "No messages yet. Say hello or ask a question.";
    messagesThread.appendChild(empty);
    return;
  }
  for (const message of messages) {
    const mine = message.sender === "patient";
    const bubble = document.createElement("div");
    bubble.className = `care-message ${mine ? "care-message-mine" : "care-message-theirs"}`;
    const body = document.createElement("p");
    body.className = "care-message-body";
    body.textContent = message.body;
    const meta = document.createElement("span");
    meta.className = "care-message-meta";
    const who = mine ? "You" : (message.sender_name || "Physiotherapist");
    meta.textContent =
      `${who} · ${formatDate(message.created_at, { hour: "numeric", minute: "2-digit" })}`;
    bubble.append(body, meta);
    messagesThread.appendChild(bubble);
  }
  messagesThread.scrollTop = messagesThread.scrollHeight;
}

messagesForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const body = messagesInput.value.trim();
  if (!body) return;
  const sendButton = document.getElementById("patientMessagesSend");
  if (sendButton) sendButton.disabled = true;
  try {
    await sendCareMessage(body);
    messagesInput.value = "";
    await loadCareMessages();
  } catch (error) {
    showToast(error.message || "Your message could not be sent.");
  } finally {
    if (sendButton) sendButton.disabled = false;
  }
});

function browserProfileFromApi(profile) {
  const wellnessPlan = profile.wellness_plan ?? null;
  const planConstraints = wellnessPlan?.constraints ?? {};
  return {
    ...(currentUser?.profile ?? {}),
    carePath: profile.care_path,
    pathwayChoice: profile.pathway_choice,
    physiotherapistRequestedAt:
      profile.physiotherapist_requested_at ?? null,
    primaryClinician: profile.primary_clinician ?? null,
    primaryClinicianName: profile.primary_clinician_name ?? "",
    goal: GOAL_BROWSER_LABELS[profile.goal] ?? profile.goal,
    customGoal: profile.custom_goal ?? "",
    activity:
      ACTIVITY_BROWSER_LABELS[profile.activity_level]
      ?? profile.activity_level,
    focusSide: profile.focus_side,
    cueStyle: profile.cue_style,
    emergencyContactName: profile.emergency_contact_name ?? "",
    emergencyContactRelationship:
      profile.emergency_contact_relationship ?? "",
    emergencyContactPhone: profile.emergency_contact_phone ?? "",
    emergencyContactConsent:
      profile.emergency_contact_consent === true,
    emergencyContactVerifiedAt:
      profile.emergency_contact_verified_at ?? null,
    emergencyContactAlertsReady:
      profile.emergency_contact_alerts_ready === true,
    wellnessScreening: {
      ...(currentUser?.profile?.wellnessScreening ?? {}),
      status: profile.wellness_screening_status,
    },
    wellnessPlan,
    wellnessPlanAcceptedAt: profile.wellness_plan_accepted_at ?? null,
    daysPerWeek:
      planConstraints.days_per_week
      ?? planConstraints.daysPerWeek,
    equipment: planConstraints.equipment,
    hasRelevantHistory: Boolean(profile.medical_history),
    medicalHistory: profile.medical_history ?? "",
  };
}

function showToast(message, title = "Consultation requested") {
  toastMessage.innerHTML = "";
  const heading = document.createElement("strong");
  heading.textContent = title;
  toastMessage.append(heading, document.createTextNode(message));
  window.clearTimeout(toastTimer);
  toast.classList.add("show");
  toastTimer = window.setTimeout(() => toast.classList.remove("show"), 4500);
}

careAcceptedDismiss?.addEventListener("click", () => {
  if (careAcceptedNotice) careAcceptedNotice.hidden = true;
});

function setBookingVoiceActive(active) {
  bookingVoiceActive = Boolean(active);
  if (!bookingVoiceInput) return;
  bookingVoiceInput.setAttribute("aria-pressed", String(bookingVoiceActive));
  bookingVoiceInput.innerHTML = bookingVoiceActive
    ? '<span aria-hidden="true">■</span> Stop listening'
    : '<span aria-hidden="true">🎙</span> Speak to add text';
}

function stopBookingVoice(message = "") {
  if (bookingVoiceActive) voiceGuidance.cancel();
  setBookingVoiceActive(false);
  if (message && bookingVoiceStatus) bookingVoiceStatus.textContent = message;
}

async function prepareConsultationDraft({ force = false } = {}) {
  if (!bookingNotes || !generateBookingDraft || !bookingDraftStatus) return;
  if (currentUser?.role !== "patient") return;
  if (!force && bookingNotes.value.trim()) {
    bookingDraftStatus.textContent =
      "Your existing message is preserved. Select Generate draft to replace it.";
    return;
  }

  const requestId = ++bookingDraftRequestId;
  const editVersionAtStart = bookingEditVersion;
  generateBookingDraft.disabled = true;
  generateBookingDraft.textContent = "Preparing…";
  bookingDraftStatus.textContent =
    "Reviewing your recorded trends and preparing an editable draft…";

  try {
    const response = await generateConsultationDraft(getLocale());
    if (requestId !== bookingDraftRequestId) return;
    if (bookingEditVersion !== editVersionAtStart) {
      bookingDraftStatus.textContent =
        "Your typing was preserved. Select Generate draft if you want to replace it.";
      return;
    }

    const draft = String(response?.draft ?? "").trim();
    if (!draft) throw new Error("The AI draft was empty. You can still speak or type your message.");
    bookingNotes.value = draft.slice(0, Number(bookingNotes.maxLength) || 1000);
    bookingNotes.dataset.aiDraft = "true";
    bookingEditVersion += 1;
    bookingDraftStatus.textContent =
      "AI draft added. Review and edit it before sending.";
    generateBookingDraft.textContent = "Generate new draft";
    bookingNotes.focus({ preventScroll: true });
  } catch (error) {
    if (requestId !== bookingDraftRequestId) return;
    bookingDraftStatus.textContent = error.message
      || "The AI draft is unavailable. You can still speak or type your message.";
  } finally {
    if (requestId === bookingDraftRequestId) {
      generateBookingDraft.disabled = false;
      if (generateBookingDraft.textContent === "Preparing…") {
        generateBookingDraft.textContent = "Generate draft";
      }
    }
  }
}

bookingNotes?.addEventListener("input", () => {
  bookingEditVersion += 1;
  if (bookingNotes.dataset.aiDraft) {
    delete bookingNotes.dataset.aiDraft;
    if (bookingDraftStatus) {
      bookingDraftStatus.textContent =
        "Your edits are kept. Nothing is sent until you request the consultation.";
    }
  }
});

generateBookingDraft?.addEventListener("click", () => {
  prepareConsultationDraft({ force: true });
});

bookingVoiceInput?.addEventListener("click", () => {
  if (bookingVoiceActive) {
    stopBookingVoice("Listening stopped. Your message was not sent.");
    return;
  }

  setBookingVoiceActive(true);
  const started = voiceGuidance.listen({
    maxNoSpeechRetries: 0,
    onStatus: (message) => {
      if (bookingVoiceStatus) bookingVoiceStatus.textContent = message;
    },
    onResult: (transcript) => {
      if (bookingNotes) {
        bookingNotes.value = mergeConsultationTranscript(
          bookingNotes.value,
          transcript,
          Number(bookingNotes.maxLength) || 1000,
        );
        delete bookingNotes.dataset.aiDraft;
        bookingEditVersion += 1;
        bookingNotes.focus({ preventScroll: true });
      }
      setBookingVoiceActive(false);
      if (bookingVoiceStatus) {
        bookingVoiceStatus.textContent =
          "Speech added as editable text. Review it before sending.";
      }
    },
    onError: (message) => {
      setBookingVoiceActive(false);
      if (bookingVoiceStatus) bookingVoiceStatus.textContent = message;
    },
  });

  if (!started) setBookingVoiceActive(false);
});

window.addEventListener("physiovision:booking-opened", () => {
  if (bookingStatus) bookingStatus.textContent = "";
  if (bookingVoiceStatus) {
    bookingVoiceStatus.textContent =
      "Speak in the language selected at the top of the page.";
  }
  if (bookingNotes?.value.trim()) {
    if (bookingDraftStatus) {
      bookingDraftStatus.textContent =
        "Your existing message is preserved. Select Generate draft to replace it.";
    }
    return;
  }
  prepareConsultationDraft();
});

window.addEventListener("physiovision:booking-closed", () => {
  bookingDraftRequestId += 1;
  if (generateBookingDraft) {
    generateBookingDraft.disabled = false;
    if (generateBookingDraft.textContent === "Preparing…") {
      generateBookingDraft.textContent = "Generate draft";
    }
  }
  stopBookingVoice();
});

bookingForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!bookingForm.reportValidity()) return;
  stopBookingVoice();
  bookingStatus.textContent = "Sending your request…";
  const submit = bookingForm.querySelector("[type='submit']");
  submit.disabled = true;

  const formData = new FormData(bookingForm);
  try {
    const consultation = await createConsultation({
      patient_notes: String(formData.get("notes") ?? "").trim(),
    });
    bookingForm.reset();
    bookingEditVersion += 1;
    delete bookingNotes?.dataset.aiDraft;
    if (bookingDraftStatus) bookingDraftStatus.textContent = "";
    if (generateBookingDraft) generateBookingDraft.textContent = "Generate draft";
    bookingStatus.textContent =
      "Request sent. Your physiotherapist will propose an appointment time.";
    document
      .querySelector("#booking-modal [data-close-modal]")
      ?.click();
    const clinicianName = consultation.clinician_name
      || translateText("Your physiotherapist");
    showToast(`${clinicianName} ${translateText("will propose an appointment time.")}`);
    await loadDashboardData();
  } catch (error) {
    bookingStatus.textContent =
      error.message || "The consultation request could not be sent.";
  } finally {
    submit.disabled = false;
  }
});

trendRequestButton?.addEventListener("click", () => {
  if (bookingStatus) {
    bookingStatus.textContent =
      "Review or edit your message, then send the request when you are ready.";
  }
});

document
  .querySelectorAll("[data-patient-dashboard]")
  .forEach((button) => button.addEventListener("click", () => {
    void showDashboard();
  }));
document
  .querySelectorAll("[data-patient-start]")
  .forEach((button) => button.addEventListener("click", () => (
    startExercise(
      firstExerciseId,
      firstSessionExerciseIds,
      firstSessionDay,
      firstSessionTitle,
      firstSessionKey,
      firstSessionCompletedExerciseIds,
    )
  )));

pathwayModal
  ?.querySelectorAll("[data-pathway-choice]")
  .forEach((button) => {
    button.addEventListener("click", async () => {
      const pathway = button.dataset.pathwayChoice;
      if (pathway === "physiotherapist") {
        showPathwayInviteEntry();
        return;
      }

      pathwayInviteForm.hidden = true;
      pathwayModal
        ?.querySelectorAll("[data-pathway-choice]")
        .forEach((choiceButton) => {
          const selected = choiceButton === button;
          choiceButton.classList.toggle("is-selected", selected);
          choiceButton.setAttribute("aria-pressed", String(selected));
        });
      setPathwayButtonsDisabled(true);
      pathwayStatus.textContent = "Saving your pathway…";
      try {
        const profile = await selectPatientPathway(pathway);
        await finishPathwaySetup(profile);
      } catch (error) {
        pathwayStatus.textContent =
          error.message || "Your pathway could not be saved. Please try again.";
        setPathwayButtonsDisabled(false);
      }
    });
  });

pathwayInviteForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const code = pathwayInviteCode.value.trim().toUpperCase();
  pathwayInviteCode.value = code;

  if (!/^[A-Z2-9]{8}$/.test(code)) {
    pathwayInviteStatus.textContent = translateText(
      "Enter the complete 8-character invitation code.",
    );
    pathwayInviteCode.focus();
    return;
  }

  setPathwayButtonsDisabled(true);
  pathwayInviteCode.disabled = true;
  pathwayInviteSubmit.disabled = true;
  pathwaySelfRefer.disabled = true;
  pathwayInviteStatus.textContent = translateText("Checking invitation…");

  try {
    await acceptCareInvitation(code);
    const refreshedUser = await getMe();
    pathwayInviteStatus.textContent = translateText(
      "Connected successfully. Your physiotherapist can now assign your programme.",
    );
    await finishPathwaySetup(refreshedUser.profile, refreshedUser);
    pathwayInviteCode.value = "";
  } catch (error) {
    pathwayInviteStatus.textContent =
      error.message || translateText("The invitation could not be accepted.");
    setPathwayButtonsDisabled(false);
    pathwayInviteCode.disabled = false;
    pathwayInviteSubmit.disabled = false;
    pathwaySelfRefer.disabled = false;
    pathwayInviteCode.focus();
  }
});

// A patient without a code can still explicitly request an available
// physiotherapist. Merely choosing the clinician-guided option never sends
// this triage request.
pathwaySelfRefer?.addEventListener("click", async () => {
  setPathwayButtonsDisabled(true);
  pathwayInviteCode.disabled = true;
  pathwayInviteSubmit.disabled = true;
  pathwaySelfRefer.disabled = true;
  pathwayInviteStatus.textContent = translateText(
    "Adding you to the triage queue…",
  );
  try {
    const profile = await selectPatientPathway("physiotherapist");
    pathwayInviteStatus.textContent = translateText(
      "Request received. A physiotherapist will pick up your case soon.",
    );
    await finishPathwaySetup(profile);
  } catch (error) {
    pathwayInviteStatus.textContent =
      error.message || "Your request could not be sent. Please try again.";
    setPathwayButtonsDisabled(false);
    pathwayInviteCode.disabled = false;
    pathwayInviteSubmit.disabled = false;
    pathwaySelfRefer.disabled = false;
  }
});

// A wellness patient can ask for physiotherapist support without losing their
// current plan. The pathway changes only after a clinician accepts the request.
referPhysioButton?.addEventListener("click", async () => {
  if (isPhysiotherapistRequestPending(currentUser?.profile)) {
    renderPhysiotherapistRequest(currentUser.profile);
    return;
  }
  if (!shouldShowPhysiotherapistRequest(currentUser?.profile)) {
    setPhysiotherapistRequestVisibility(false);
    return;
  }
  const confirmed = window.confirm(translateText(
    "Request a physiotherapist? Your wellness plan will stay active while "
    + "the care team reviews your request.",
  ));
  if (!confirmed) return;
  referPhysioButton.disabled = true;
  referPhysioStatus.textContent = "Sending your request…";
  try {
    const profile = await selectPatientPathway("physiotherapist");
    referPhysioStatus.textContent =
      translateText("Waiting for a physiotherapist to accept your request.");
    await finishPathwaySetup(profile);
  } catch (error) {
    referPhysioStatus.textContent =
      error.message || "Your request could not be sent. Please try again.";
    referPhysioButton.disabled = false;
  }
});

window.addEventListener("physiovision:auth-role", (event) => {
  const user = event.detail?.user;
  if (event.detail?.role === "patient") {
    void activatePatientDashboard(user);
  } else {
    clearPendingPhysiotherapistRefresh();
    currentUser = null;
    dashboard.hidden = true;
    publicMain.hidden = false;
    document.body.classList.remove(
      "patient-app-active",
      "patient-practice-active",
    );
  }
});

// auth.js can finish before this module has registered its role listener.
// This explicit request provides a lossless handoff instead of optional,
// timing-dependent access to a global function.
window.addEventListener("physiovision:patient-dashboard-requested", (event) => {
  void showDashboard(event.detail?.user ?? null);
});

window.addEventListener("physiovision:profile-updated", (event) => {
  if (currentUser?.role !== "patient") return;
  const browserProfile = event.detail ?? {};
  currentUser = {
    ...currentUser,
    profile: {
      ...(currentUser.profile ?? {}),
      ...browserProfile,
      care_path:
        browserProfile.carePath ?? currentUser.profile?.care_path,
      wellness_screening_status:
        browserProfile.wellnessScreening?.status ??
        currentUser.profile?.wellness_screening_status,
      pathway_choice:
        browserProfile.pathwayChoice ??
        browserProfile.pathway_choice ??
        currentUser.profile?.pathway_choice,
      physiotherapist_requested_at:
        browserProfile.physiotherapistRequestedAt ??
        browserProfile.physiotherapist_requested_at ??
        currentUser.profile?.physiotherapist_requested_at,
      primary_clinician:
        browserProfile.primaryClinician ??
        browserProfile.primary_clinician ??
        currentUser.profile?.primary_clinician,
      primary_clinician_name:
        browserProfile.primaryClinicianName ??
        browserProfile.primary_clinician_name ??
        currentUser.profile?.primary_clinician_name,
      wellness_plan:
        browserProfile.wellnessPlan ??
        browserProfile.wellness_plan ??
        currentUser.profile?.wellness_plan,
      wellness_plan_accepted_at:
        browserProfile.wellnessPlanAcceptedAt ??
        browserProfile.wellness_plan_accepted_at ??
        currentUser.profile?.wellness_plan_accepted_at,
    },
  };
  renderPlan(currentUser, currentData?.prescriptions ?? []);
  schedulePendingPhysiotherapistRefresh();
});

window.addEventListener("physiovision:language-change", () => {
  if (currentUser?.role !== "patient") return;
  renderPlan(currentUser, currentData?.prescriptions ?? []);
  if (!currentData) return;
  renderTrend(currentData);
  renderUpcomingConsultation(currentData.consultations);
  renderPendingConsults(currentData.consultations);
});

window.addEventListener("physiovision:session-completed", () => {
  if (currentUser?.role === "patient") void loadDashboardData();
});

window.addEventListener("focus", () => {
  void refreshPendingPhysiotherapistRequest();
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    clearPendingPhysiotherapistRefresh();
    return;
  }
  void refreshPendingPhysiotherapistRequest();
});

window.pvShowPatientDashboard = (user = null) => showDashboard(user);
window.pvStartPatientExercise = startExercise;

const initialAuthState = window.physioVisionAuthState ?? null;
if (initialAuthState?.role === "patient" && initialAuthState.user) {
  void activatePatientDashboard(initialAuthState.user);
} else if (isLoggedIn()) {
  // Handles refreshes where auth.js and this module finish in either order.
  void showDashboard();
}
