import { movementQualityFromSession } from "./movement-quality.js?v=4";

export const PROVISIONAL_TREND_THRESHOLDS = Object.freeze({
  qualityDeclinePoints: 8,
  painIncreasePoints: 2,
  highPainLevel: 7,
  minimumReadings: 3,
});

export function isClinicianGuidedProfile(profile = {}) {
  const pathwayChoice =
    profile.pathway_choice ?? profile.pathwayChoice ?? "unselected";
  const carePath = profile.care_path ?? profile.carePath;
  return Boolean(
    pathwayChoice === "physiotherapist"
      || carePath === "clinician"
      || profile.primary_clinician
      || profile.primaryClinician,
  );
}

export function effectivePatientPathway(profile = {}) {
  const pathwayChoice =
    profile.pathway_choice ?? profile.pathwayChoice ?? "unselected";
  if (pathwayChoice !== "unselected") return pathwayChoice;
  return isClinicianGuidedProfile(profile)
    ? "physiotherapist"
    : "unselected";
}

export function isPhysiotherapistRequestPending(profile = {}) {
  const requestedAt =
    profile.physiotherapist_requested_at
    ?? profile.physiotherapistRequestedAt;
  return Boolean(requestedAt) && !isClinicianGuidedProfile(profile);
}

export function shouldShowPhysiotherapistRequest(profile = {}) {
  const medicalHistory =
    profile.medical_history
    ?? profile.medicalHistory
    ?? "";
  const hasMedicalCondition = Boolean(
    String(medicalHistory).trim()
      || profile.has_relevant_history
      || profile.hasRelevantHistory,
  );
  return !isClinicianGuidedProfile(profile) && !hasMedicalCondition;
}

export function walkingConfidencePlanNeedsRefresh(plan = {}) {
  const goal = String(plan.goal ?? "")
    .trim()
    .toLowerCase()
    .replaceAll("_", " ");
  if (goal !== "walk with confidence" && goal !== "walking confidence") {
    return false;
  }

  const days = Array.isArray(plan.days) ? plan.days : [];
  const minimumBalanceSessions = days.length <= 3 ? 1 : 2;
  const balanceSessions = days.filter((day) => {
    const exerciseIds = day?.exercise_ids ?? day?.exerciseIds ?? [];
    return exerciseIds.includes("supported_single_leg_balance");
  }).length;
  return balanceSessions < minimumBalanceSessions;
}

function number(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function newestFirst(items, dateField) {
  return [...(Array.isArray(items) ? items : [])].sort(
    (a, b) => new Date(b?.[dateField] ?? 0) - new Date(a?.[dateField] ?? 0),
  );
}

function average(values) {
  const numeric = values.map(number).filter((value) => value !== null);
  if (!numeric.length) return null;
  return numeric.reduce((sum, value) => sum + value, 0) / numeric.length;
}

function differenceNewestToOldest(values) {
  const numeric = values.map(number).filter((value) => value !== null);
  if (numeric.length < PROVISIONAL_TREND_THRESHOLDS.minimumReadings) return null;
  return numeric[0] - numeric[numeric.length - 1];
}

function differenceNewestToPrevious(values) {
  const numeric = values.map(number).filter((value) => value !== null);
  if (numeric.length < 2) return null;
  return numeric[0] - numeric[1];
}

function recordId(value) {
  if (value && typeof value === "object") return String(value.id ?? "");
  return value === null || value === undefined ? "" : String(value);
}

function normalizedSide(value) {
  return String(value ?? "").trim().toLowerCase();
}

function sessionPainCheckins(session, painCheckins) {
  const sessionId = recordId(session?.id);
  if (!sessionId) return [];
  return newestFirst(
    painCheckins.filter((checkin) => recordId(checkin?.session) === sessionId),
    "checked_at",
  );
}

export function analysePatientTrend({
  sessions = [],
  painCheckins = [],
  escalations = [],
  now = new Date(),
  focusExercise = null,
  focusSide = null,
  focusSessionId = null,
} = {}) {
  const sortedSessions = newestFirst(sessions, "started_at");
  const sortedPainCheckins = newestFirst(painCheckins, "checked_at");
  const latestReportedPain = number(sortedPainCheckins[0]?.pain_level);
  const requestedSession = focusSessionId
    ? sortedSessions.find((session) => recordId(session.id) === recordId(focusSessionId))
    : null;
  const referenceSession = requestedSession
    ?? sortedSessions.find((session) => {
      const exerciseMatches = !focusExercise
        || recordId(session.exercise) === recordId(focusExercise);
      const sideMatches = !focusSide
        || normalizedSide(session.affected_side) === normalizedSide(focusSide);
      return exerciseMatches && sideMatches;
    })
    ?? null;
  const selectedExercise = recordId(
    focusExercise ?? referenceSession?.exercise,
  );
  const selectedSide = normalizedSide(
    focusSide ?? referenceSession?.affected_side,
  );
  const comparableSessions = sortedSessions.filter((session) => (
    (!selectedExercise || recordId(session.exercise) === selectedExercise)
    && (!selectedSide || normalizedSide(session.affected_side) === selectedSide)
  ));
  const recentSessions = comparableSessions.slice(0, 7);
  const comparableSessionIds = new Set(
    comparableSessions.map((session) => recordId(session.id)).filter(Boolean),
  );
  const qualityValues = recentSessions
    .map((session) => movementQualityFromSession(session))
    .filter((value) => value !== null);
  const sessionPainPairs = recentSessions.map((session) => {
    const checkins = sessionPainCheckins(session, painCheckins);
    return {
      session,
      before: checkins.find((checkin) => checkin.timing === "before") ?? null,
      after: checkins.find((checkin) => checkin.timing === "after") ?? null,
    };
  });
  const painValues = sessionPainPairs
    .map(({ after }) => number(after?.pain_level))
    .filter((value) => value !== null);
  const painResponseValues = sessionPainPairs
    .map(({ before, after }) => {
      const beforeValue = number(before?.pain_level);
      const afterValue = number(after?.pain_level);
      return beforeValue === null || afterValue === null
        ? null
        : afterValue - beforeValue;
    })
    .filter((value) => value !== null);
  const recoveryCheckins = sessionPainPairs
    .map(({ after }) => after)
    .filter((checkin) => checkin?.recovery_status);
  const movementMeasurementCount = qualityValues.length;
  const trendReadingCount = Math.max(
    movementMeasurementCount,
    painValues.length,
    recoveryCheckins.length,
  );
  const qualityDelta = differenceNewestToOldest(qualityValues.slice(0, 3));
  const painDelta = differenceNewestToOldest(painValues.slice(0, 3));
  const preliminaryQualityDelta = differenceNewestToPrevious(
    qualityValues.slice(0, 2),
  );
  const preliminaryPainDelta = differenceNewestToPrevious(
    painValues.slice(0, 2),
  );
  const openEscalation = newestFirst(escalations, "created_at").find((item) => (
    item.status === "open"
    && (!recordId(item.session) || comparableSessionIds.has(recordId(item.session)))
  ));
  const repeatedWorseRecovery =
    recoveryCheckins
      .slice(0, 3)
      .filter((checkin) => checkin.recovery_status === "worse").length >= 2;
  const qualityDeclining =
    qualityDelta !== null &&
    qualityDelta <= -PROVISIONAL_TREND_THRESHOLDS.qualityDeclinePoints;
  const painIncreasing =
    painDelta !== null &&
    painDelta >= PROVISIONAL_TREND_THRESHOLDS.painIncreasePoints;
  const highLatestPain =
    latestReportedPain !== null
    && latestReportedPain >= PROVISIONAL_TREND_THRESHOLDS.highPainLevel;

  const weekAgo = new Date(now);
  weekAgo.setDate(weekAgo.getDate() - 7);
  const sessionsThisWeek = sortedSessions.filter(
    (session) => new Date(session.started_at) >= weekAgo,
  ).length;

  let status = "building_baseline";
  let title = "Building your movement baseline";
  let message =
    "Complete a few guided sessions and pain check-ins to make this trend more meaningful.";
  let reason = null;
  let preliminaryDirection = null;

  if (highLatestPain) {
    // A standalone pre-exercise safety check is not an exercise trend, but a
    // high latest score still needs an immediate, visible support prompt.
    status = "review_suggested";
    title = "High pain was reported";
    message =
      `Your latest pain check-in was ${Math.round(latestReportedPain)}/10. `
      + "Pause exercise and seek professional advice before continuing.";
    reason = "high_pain";
  } else if (openEscalation) {
    status = "review_suggested";
    title = "A physiotherapist review is suggested";
    message = openEscalation.description;
    reason = openEscalation.trigger_type;
  } else if (qualityDeclining || painIncreasing || repeatedWorseRecovery) {
    status = "review_suggested";
    title = "Your recent pattern may need a review";
    if (painIncreasing || repeatedWorseRecovery) {
      message =
        "Your recent pain or recovery check-ins are moving in an unfavourable direction.";
      reason = "pain_increase";
    } else {
      message =
        "Your recent validation-gated coaching-response scores have decreased across several comparable sessions.";
      reason = "quality_decline";
    }
  } else if (trendReadingCount === 1) {
    status = "first_measurement";
    if (movementMeasurementCount === 1) {
      title = "Your first real movement measurement is recorded";
      message =
        "This camera-measured result is shown now. Repeat the same exercise on the same side to begin comparing change.";
    } else {
      title = "Your first linked session check-in is recorded";
      message =
        "Pain and recovery were saved, but no validation-gated movement-execution score was produced. Review the session tracking result and continue only with clinician-approved guidance.";
    }
  } else if (trendReadingCount === 2) {
    status = "preliminary";
    const improving = (
      preliminaryQualityDelta > 0
      || preliminaryPainDelta < 0
      || recoveryCheckins[0]?.recovery_status === "better"
    );
    const lower = (
      preliminaryQualityDelta < 0
      || preliminaryPainDelta > 0
      || recoveryCheckins[0]?.recovery_status === "worse"
    );
    preliminaryDirection = improving && !lower
      ? "improving"
      : lower && !improving
        ? "lower"
        : "steady";
    title = {
      improving: "Your preliminary direction is improving",
      lower: "Your preliminary direction is lower",
      steady: "Your preliminary direction is steady",
    }[preliminaryDirection];
    message =
      "This comparison uses two real sessions. Complete the same exercise on the same side once more to establish the three-session trend.";
  } else if (
    qualityValues.length >= PROVISIONAL_TREND_THRESHOLDS.minimumReadings ||
    painValues.length >= PROVISIONAL_TREND_THRESHOLDS.minimumReadings ||
    recoveryCheckins.length >= PROVISIONAL_TREND_THRESHOLDS.minimumReadings
  ) {
    status = (
      qualityDelta > 0
      || painDelta < 0
      || recoveryCheckins[0]?.recovery_status === "better"
    ) ? "improving" : "stable";
    title =
      status === "improving"
        ? "Your recent movement trend is improving"
        : "Your recent movement trend is steady";
    message =
      "Keep following your current plan and continue recording pain before and after exercise.";
  }

  return {
    status,
    title,
    message,
    reason,
    sessionsThisWeek,
    averageQuality: average(qualityValues),
    // The latest pain card is a pain diary value, not an exercise-completion
    // value. Include a pre-exercise safety stop even when no Session was made.
    latestPain: latestReportedPain,
    qualityDelta,
    painDelta,
    latestPainChange: painResponseValues[0] ?? null,
    latestRecovery: recoveryCheckins[0]?.recovery_status ?? "",
    painResponseSeries: [...painResponseValues].reverse(),
    qualitySeries: [...qualityValues].reverse(),
    movementMeasurementCount,
    trendReadingCount,
    preliminaryDirection,
    fullTrendEstablished:
      trendReadingCount >= PROVISIONAL_TREND_THRESHOLDS.minimumReadings,
    comparableSessionCount: comparableSessions.length,
    focusExercise: selectedExercise || null,
    focusExerciseName: referenceSession?.exercise_name ?? "",
    focusSide: selectedSide || null,
  };
}

export function isCurrentPrescription(prescription, today = new Date()) {
  const date = today.toISOString().slice(0, 10);
  return Boolean(
    prescription?.is_active &&
      prescription.valid_from <= date &&
      (!prescription.valid_until || prescription.valid_until >= date),
  );
}

export function findUpcomingConsultation(
  consultations,
  now = new Date(),
) {
  return [...(Array.isArray(consultations) ? consultations : [])]
    .filter((consultation) => {
      if (!["requested", "confirmed"].includes(consultation?.status)) {
        return false;
      }
      if (!consultation?.scheduled_at) {
        return consultation.status === "requested";
      }
      const scheduledAt = new Date(consultation.scheduled_at);
      return !Number.isNaN(scheduledAt.getTime()) && scheduledAt >= now;
    })
    .sort((a, b) => {
      const aUnscheduled = !a.scheduled_at;
      const bUnscheduled = !b.scheduled_at;
      if (aUnscheduled !== bUnscheduled) return aUnscheduled ? -1 : 1;
      if (aUnscheduled) {
        return new Date(b.created_at ?? 0) - new Date(a.created_at ?? 0);
      }
      return new Date(a.scheduled_at) - new Date(b.scheduled_at);
    })[0] ?? null;
}

export function mergeConsultationTranscript(
  existingText,
  transcript,
  maximumLength = 1000,
) {
  const existing = String(existingText ?? "").trim();
  const spoken = String(transcript ?? "").replace(/\s+/g, " ").trim();
  if (!spoken) return existing;
  const combined = existing ? `${existing} ${spoken}` : spoken;
  return combined.slice(0, Math.max(0, Number(maximumLength) || 1000)).trim();
}
