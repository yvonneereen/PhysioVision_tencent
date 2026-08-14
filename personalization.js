import {
  isLoggedIn,
  patchMe,
  postWellnessScreening,
} from "./api.js?v=36";

const PROFILE_KEY = "physiovision.profile.v1";
const CALIBRATION_KEY = "physiovision.calibrations.v1";
const GOAL_API_VALUES = Object.freeze({
  "Stronger knees": "stronger_knees",
  "Better balance": "better_balance",
  "Move with less stiffness": "less_stiffness",
  "Stay active": "stay_active",
  "Stronger hips": "stronger_hips",
  "Better shoulder movement": "shoulder_mobility",
  "Better ankle movement": "ankle_mobility",
  "Walk with confidence": "walking_confidence",
  "Other": "other",
});
const ACTIVITY_API_VALUES = Object.freeze({
  "Lightly active": "lightly_active",
  "Mostly seated": "mostly_seated",
  "Active most days": "active_most_days",
});
const MOBILITY_API_VALUES = Object.freeze({
  Independent: "independent",
  "Use a walking aid": "walking_aid",
  "Need another person nearby": "needs_person",
});

const DEFAULT_PROFILE = Object.freeze({
  name: "",
  age: "",
  goal: "Stronger knees",
  customGoal: "",
  activity: "Lightly active",
  mobility: "Independent",
  focusSide: "right",
  cueStyle: "gentle",
  emergencyContactName: "",
  emergencyContactRelationship: "",
  emergencyContactPhone: "",
  emergencyContactConsent: false,
  emergencyContactVerifiedAt: null,
  emergencyContactAlertsReady: false,
  carePath: "wellness",
  pathwayChoice: "unselected",
  wellnessPlan: null,
  wellnessPlanAcceptedAt: null,
  wellnessScreening: {
    version: 1,
    status: "pending",
    answers: {},
    reviewReasons: [],
    screenedAt: null,
  },
});

function readJson(key, fallback) {
  try {
    const value = window.sessionStorage.getItem(key);
    return value ? JSON.parse(value) : fallback;
  } catch (_) {
    return fallback;
  }
}

function writeJson(key, value) {
  window.sessionStorage.setItem(key, JSON.stringify(value));
}

export function loadProfile() {
  return { ...DEFAULT_PROFILE, ...readJson(PROFILE_KEY, {}) };
}

export function hasSavedProfile() {
  try {
    return window.sessionStorage.getItem(PROFILE_KEY) !== null;
  } catch (_) {
    return false;
  }
}

export function saveProfile(
  profile,
  { syncBackend = true, syncScreening = true } = {}
) {
  const previous = loadProfile();
  const next = {
    ...previous,
    ...profile,
    name: String(profile.name ?? previous.name).trim().slice(0, 60),
    age: normaliseAge(profile.age ?? previous.age),
    customGoal: String(
      (profile.goal ?? previous.goal) === "Other"
        ? profile.customGoal ?? previous.customGoal
        : ""
    ).trim().slice(0, 120),
    updatedAt: new Date().toISOString(),
  };
  next.emergencyContactName = String(
    profile.emergencyContactName ?? previous.emergencyContactName ?? ""
  ).trim().slice(0, 60);
  next.emergencyContactRelationship = String(
    profile.emergencyContactRelationship
      ?? previous.emergencyContactRelationship
      ?? ""
  ).trim().slice(0, 30);
  next.emergencyContactPhone = String(
    profile.emergencyContactPhone ?? previous.emergencyContactPhone ?? ""
  ).trim().slice(0, 24);
  next.emergencyContactConsent = Boolean(
    profile.emergencyContactConsent ?? previous.emergencyContactConsent
  );
  next.emergencyContactVerifiedAt = Object.hasOwn(
    profile,
    "emergencyContactVerifiedAt"
  )
    ? profile.emergencyContactVerifiedAt
    : previous.emergencyContactVerifiedAt ?? null;
  next.emergencyContactAlertsReady = Boolean(
    profile.emergencyContactAlertsReady
    ?? previous.emergencyContactAlertsReady
  );
  if (
    next.emergencyContactPhone !== previous.emergencyContactPhone
    || !next.emergencyContactConsent
  ) {
    next.emergencyContactVerifiedAt = null;
    next.emergencyContactAlertsReady = false;
  }
  const hasEmergencyContact = Boolean(
    next.emergencyContactName
    || next.emergencyContactRelationship
    || next.emergencyContactPhone
  );
  if (!hasEmergencyContact) {
    next.emergencyContactName = "";
    next.emergencyContactRelationship = "";
    next.emergencyContactPhone = "";
    next.emergencyContactConsent = false;
    next.emergencyContactVerifiedAt = null;
    next.emergencyContactAlertsReady = false;
  }
  const planInputsChanged = (
    (
      Object.hasOwn(profile, "goal")
      && next.goal !== previous.goal
    )
    || (
      Object.hasOwn(profile, "customGoal")
      && next.customGoal !== previous.customGoal
    )
    || (
      Object.hasOwn(profile, "activity")
      && next.activity !== previous.activity
    )
    || (
      Object.hasOwn(profile, "focusSide")
      && next.focusSide !== previous.focusSide
    )
    || (
      Object.hasOwn(profile, "cueStyle")
      && next.cueStyle !== previous.cueStyle
    )
  );
  if (
    planInputsChanged
    && !Object.hasOwn(profile, "wellnessPlan")
  ) {
    next.wellnessPlan = null;
    next.wellnessPlanAcceptedAt = null;
  }
  writeJson(PROFILE_KEY, next);
  window.dispatchEvent(
    new CustomEvent("physiovision:profile-updated", { detail: next })
  );

  // Sync to the authenticated backend; session storage is only a tab cache.
  if (isLoggedIn() && syncBackend) {
    patchMe({
      goal:            GOAL_API_VALUES[next.goal] ?? next.goal,
      custom_goal:     next.goal === "Other" ? next.customGoal : "",
      activity_level:  ACTIVITY_API_VALUES[next.activity] ?? next.activity,
      mobility_status: MOBILITY_API_VALUES[next.mobility] ?? next.mobility,
      focus_side:      next.focusSide,
      cue_style:       next.cueStyle,
      care_path:       next.carePath,
      emergency_contact_name: next.emergencyContactName,
      emergency_contact_relationship: next.emergencyContactRelationship,
      emergency_contact_phone: next.emergencyContactPhone,
      emergency_contact_consent: next.emergencyContactConsent,
    }).catch(() => {});

    if (
      syncScreening
      && Object.hasOwn(profile, "wellnessScreening")
    ) {
      const answers = next.wellnessScreening?.answers ?? {};
      postWellnessScreening({
        not_treating_condition: answers.notTreatingCondition === true,
        no_clinician_restrictions: answers.noClinicianRestrictions === true,
        general_wellness_goal: answers.generalWellnessGoal === true,
        no_concerning_symptoms: answers.noConcerningSymptoms === true,
      }).catch(() => {});
    }
  }

  return next;
}

function normaliseAge(value) {
  if (value === "" || value === null || value === undefined) return "";
  const age = Math.round(Number(value));
  return Number.isFinite(age) ? Math.min(110, Math.max(18, age)) : "";
}

export function loadCalibrations() {
  return readJson(CALIBRATION_KEY, {});
}

function calibrationStorageKey(exerciseId, affectedSide) {
  return affectedSide ? `${exerciseId}:${affectedSide}` : exerciseId;
}

export function getCalibration(exerciseId, affectedSide = null) {
  const calibrations = loadCalibrations();
  const exact = calibrations[calibrationStorageKey(exerciseId, affectedSide)];
  if (exact) return exact;
  // Read pre-side-specific v1 data only when it belongs to the requested side.
  const legacy = calibrations[exerciseId];
  return legacy
    && (!affectedSide || legacy.affectedSide === affectedSide)
    ? legacy
    : null;
}

export function saveCalibration(calibration) {
  if (!calibration?.exerciseId) throw new Error("Calibration needs an exercise ID.");
  const calibrations = loadCalibrations();
  calibrations[calibrationStorageKey(
    calibration.exerciseId,
    calibration.affectedSide
  )] = calibration;
  writeJson(CALIBRATION_KEY, calibrations);
  window.dispatchEvent(
    new CustomEvent("physiovision:calibration-updated", {
      detail: calibration,
    })
  );
  return calibration;
}

export function clearCalibration(exerciseId, affectedSide = null) {
  const calibrations = loadCalibrations();
  if (affectedSide) {
    delete calibrations[calibrationStorageKey(exerciseId, affectedSide)];
  } else {
    Object.keys(calibrations)
      .filter((key) => key === exerciseId || key.startsWith(`${exerciseId}:`))
      .forEach((key) => delete calibrations[key]);
  }
  writeJson(CALIBRATION_KEY, calibrations);
  window.dispatchEvent(
    new CustomEvent("physiovision:calibration-updated", {
      detail: { exerciseId, affectedSide, removed: true },
    })
  );
}

export function resolveMeasurement(key, angles, affectedSide = "right") {
  if (key in angles) return angles[key];
  const sideKey = `${affectedSide}${key[0].toUpperCase()}${key.slice(1)}`;
  return angles[sideKey] ?? null;
}

export function inspectCalibrationFrame(exercise, angles, affectedSide) {
  const calibration = exercise?.calibration;
  if (!calibration) {
    return {
      frame: null,
      missingMeasurements: [],
      weakPoints: [],
    };
  }

  const availableAngles = angles ?? {};
  const oppositeSide = affectedSide === "left" ? "right" : "left";
  const candidateSides = exercise.allowOppositeSideFallback
    ? [affectedSide, oppositeSide]
    : [affectedSide];
  const candidates = candidateSides.map((side) => {
    const frame = {};
    const missingMeasurements = [];
    const weakPoints = [];
    for (const key of calibration.captureKeys) {
      const measurement = resolveMeasurement(key, availableAngles, side);
      if (
        !measurement
        || measurement.lowConfidence
        || !isCalibrationValue(measurement.value)
      ) {
        missingMeasurements.push(key);
        weakPoints.push(...(measurement?.weakPoints ?? []));
        continue;
      }
      frame[key] = measurement.value;
    }
    return { frame, missingMeasurements, weakPoints, trackingSide: side };
  });
  const candidate = candidates.find(({ missingMeasurements }) =>
    missingMeasurements.length === 0
  ) ?? candidates.reduce((best, current) =>
    current.missingMeasurements.length < best.missingMeasurements.length
      ? current
      : best
  );

  return {
    frame: candidate.missingMeasurements.length ? null : candidate.frame,
    missingMeasurements: candidate.missingMeasurements,
    weakPoints: [...new Set(candidate.weakPoints.filter(Boolean))],
    trackingSide: candidate.trackingSide,
  };
}

export function extractCalibrationFrame(exercise, angles, affectedSide) {
  return inspectCalibrationFrame(exercise, angles, affectedSide).frame;
}

/**
 * Returns true when a complete calibration frame is inside the configured
 * starting or target position. The live calibration flow uses this to wait
 * for the person instead of asking them to press another button.
 */
export function calibrationFrameMatchesPhase(exercise, frame, captureType) {
  const config = exercise.calibration;
  if (!config || !frame || !["start", "target"].includes(captureType)) {
    return false;
  }

  const ranges = config.safeRanges?.[captureType] ?? {};
  for (const [key, range] of Object.entries(ranges)) {
    if (!conditionMatches(frame[key], range)) return false;
  }

  const conditions = config.safeConditions?.[captureType] ?? {};
  for (const [key, condition] of Object.entries(conditions)) {
    if (!conditionMatches(frame[key], condition)) return false;
  }

  return true;
}

export function summariseFrames(frames, keys) {
  if (!frames?.length) throw new Error("No visible movement samples were captured.");
  const summary = {};

  for (const key of keys) {
    const values = frames
      .map((frame) => frame[key])
      .filter(isCalibrationValue);
    if (values.length < 5) {
      throw new Error("Keep all required joints visible for the full measurement.");
    }
    if (values.every(Number.isFinite)) {
      values.sort((a, b) => a - b);
      const centre = median(values);
      const deviations = values.map((value) => Math.abs(value - centre));
      summary[key] = {
        median: round(centre),
        variability: round(median(deviations)),
        sampleCount: values.length,
      };
    } else if (values.every((value) => typeof value === "string")) {
      const value = mode(values);
      summary[key] = {
        value,
        consistency: round(
          values.filter((candidate) => candidate === value).length / values.length
        ),
        sampleCount: values.length,
      };
    } else {
      throw new Error("The movement measurement changed type during calibration.");
    }
  }
  return summary;
}

export function validateCalibrationCapture(exercise, frames, captureType) {
  const config = exercise.calibration;
  if (!config) throw new Error("This exercise does not support calibration yet.");
  const summary = summariseFrames(frames, config.captureKeys);
  const safeRanges = config.safeRanges?.[captureType] ?? {};

  for (const [key, range] of Object.entries(safeRanges)) {
    const value = summary[key]?.median;
    if (!Number.isFinite(value) || value < range[0] || value > range[1]) {
      const message = config.captureErrors?.[key];
      throw new Error(
        message ?? `Your ${friendlyMeasurement(key)} was outside the safe calibration range.`
      );
    }
  }
  const safeConditions = config.safeConditions?.[captureType] ?? {};
  for (const [key, condition] of Object.entries(safeConditions)) {
    const result = summary[key];
    const value = result?.value ?? result?.median;
    if (!conditionMatches(value, condition) || (result.consistency ?? 1) < 0.8) {
      const message = config.captureErrors?.[key];
      throw new Error(
        message ?? `Hold the ${friendlyMeasurement(key)} consistently and try again.`
      );
    }
  }
  return summary;
}

export function createCalibration(
  exercise,
  { affectedSide, startFrames, targetCaptures }
) {
  const config = exercise.calibration;
  if (!config) throw new Error("This exercise does not support calibration yet.");
  if (!Array.isArray(targetCaptures) || targetCaptures.length < 1) {
    throw new Error("One comfortable movement sample is required.");
  }

  const start = validateCalibrationCapture(exercise, startFrames, "start");
  const targetSummaries = targetCaptures.map((frames) =>
    validateCalibrationCapture(exercise, frames, "target")
  );
  const target = {};

  for (const key of config.captureKeys) {
    const numericValues = targetSummaries
      .map((summary) => summary[key]?.median)
      .filter(Number.isFinite);
    if (numericValues.length === targetSummaries.length) {
      const centre = median(numericValues);
      const captureVariability = targetSummaries
        .map((summary) => summary[key]?.variability)
        .filter(Number.isFinite);
      const withinCaptureVariability = captureVariability.length
        ? median(captureVariability)
        : 0;
      target[key] = {
        median: round(centre),
        variability: round(Math.max(
          withinCaptureVariability,
          median(numericValues.map((value) => Math.abs(value - centre))) ?? 0
        )),
        repetitions: numericValues.length,
      };
      continue;
    }
    const categoricalValues = targetSummaries
      .map((summary) => summary[key]?.value)
      .filter((value) => typeof value === "string");
    if (categoricalValues.length === targetSummaries.length) {
      const value = mode(categoricalValues);
      target[key] = {
        value,
        consistency: round(
          categoricalValues.filter((candidate) => candidate === value).length
            / categoricalValues.length
        ),
        repetitions: categoricalValues.length,
      };
    }
  }

  const phaseRanges = {
    [config.startPhase]: makePersonalRanges(
      config.personalizedKeys,
      start,
      config.safeRanges.start,
      config.tolerances ?? config.toleranceDegrees
    ),
    [config.targetPhase]: makePersonalRanges(
      config.personalizedKeys,
      target,
      config.safeRanges.target,
      config.tolerances ?? config.toleranceDegrees
    ),
  };

  const leftKnee = target.leftKnee?.median;
  const rightKnee = target.rightKnee?.median;
  const naturalKneeDifference =
    Number.isFinite(leftKnee) && Number.isFinite(rightKnee)
      ? Math.round(Math.abs(leftKnee - rightKnee) * 10) / 10
      : null;

  return {
    version: 1,
    exerciseId: exercise.id,
    exerciseName: exercise.name,
    affectedSide,
    capturedAt: new Date().toISOString(),
    start,
    target,
    phaseRanges,
    naturalKneeDifference,
  };
}

function makePersonalRanges(keys, summary, safetyRanges, tolerances = 8) {
  const ranges = {};
  for (const key of keys) {
    const centre = summary[key]?.median;
    const safe = safetyRanges[key];
    if (!Number.isFinite(centre) || !safe) continue;
    const variability = summary[key]?.variability ?? 0;
    const configuredTolerance = typeof tolerances === "number"
      ? tolerances
      : tolerances?.[key] ?? 8;
    const radius = Math.max(configuredTolerance, variability * 3);
    ranges[key] = [
      round(Math.max(safe[0], centre - radius)),
      round(Math.min(safe[1], centre + radius)),
    ];
  }
  return ranges;
}

export function applyCalibration(exercise, calibration) {
  const copy = {
    ...exercise,
    prescription: { ...exercise.prescription },
    phases: exercise.phases.map((phase) => ({ ...phase })),
    symmetry: exercise.symmetry ? { ...exercise.symmetry } : undefined,
  };

  if (
    !calibration ||
    calibration.version !== 1 ||
    calibration.exerciseId !== exercise.id
  ) {
    return copy;
  }

  const config = exercise.calibration;
  const safeByPhase = {
    [config?.startPhase]: config?.safeRanges?.start ?? {},
    [config?.targetPhase]: config?.safeRanges?.target ?? {},
  };
  const allowedKeys = new Set(config?.personalizedKeys ?? []);
  copy.phases = copy.phases.map((phase) => {
    const safeRanges = safeByPhase[phase.name] ?? {};
    const storedRanges = calibration.phaseRanges?.[phase.name] ?? {};
    const acceptedRanges = {};
    for (const key of allowedKeys) {
      const safe = safeRanges[key];
      const legacySideKey = `${calibration.affectedSide ?? "right"}${key[0].toUpperCase()}${key.slice(1)}`;
      const stored = storedRanges[key] ?? storedRanges[legacySideKey];
      if (!isNumericRange(stored) || !isNumericRange(safe)) {
        continue;
      }
      const clamped = [
        Math.max(stored[0], safe[0]),
        Math.min(stored[1], safe[1]),
      ];
      if (clamped[0] <= clamped[1]) acceptedRanges[key] = clamped;
    }
    return { ...phase, ...acceptedRanges };
  });
  copy.activeCalibration = calibration;

  // Natural asymmetry is recorded for trend comparisons, but calibration is
  // never allowed to loosen the exercise's existing safety limit.
  if (copy.symmetry && Number.isFinite(calibration.naturalKneeDifference)) {
    copy.symmetry.maxDiffDeg = Math.min(
      copy.symmetry.maxDiffDeg,
      Math.max(8, calibration.naturalKneeDifference + 5)
    );
  }
  return copy;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function mode(values) {
  const counts = new Map();
  values.forEach((value) => counts.set(value, (counts.get(value) ?? 0) + 1));
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1])[0]?.[0];
}

function isCalibrationValue(value) {
  return Number.isFinite(value)
    || (typeof value === "string" && value.length > 0);
}

function conditionMatches(value, condition) {
  if (Array.isArray(condition)) {
    return Number.isFinite(value)
      && value >= condition[0]
      && value <= condition[1];
  }
  if (condition && Object.hasOwn(condition, "equals")) {
    return value === condition.equals;
  }
  if (condition && Array.isArray(condition.oneOf)) {
    return condition.oneOf.includes(value);
  }
  return false;
}

function isNumericRange(value) {
  return Array.isArray(value)
    && value.length === 2
    && Number.isFinite(value[0])
    && Number.isFinite(value[1])
    && value[0] <= value[1];
}

function round(value) {
  // Ratios such as foot clearance and trajectory size need more precision
  // than degree measurements; two decimals still keeps stored profiles small.
  return Math.round(value * 100) / 100;
}

function friendlyMeasurement(key) {
  return key
    .replace(/([A-Z])/g, " $1")
    .replace(/^./, (letter) => letter.toUpperCase());
}
