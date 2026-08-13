const PLAN_SESSION_NOTE_PREFIX = "physiovision-plan-session:";

function localDateKey(value) {
  const date = value instanceof Date ? new Date(value) : new Date(value);
  if (Number.isNaN(date.getTime())) return "unknown-week";
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function planWeekKey(value = new Date()) {
  const date = value instanceof Date ? new Date(value) : new Date(value);
  if (Number.isNaN(date.getTime())) return "unknown-week";
  date.setHours(0, 0, 0, 0);
  const daysSinceMonday = (date.getDay() + 6) % 7;
  date.setDate(date.getDate() - daysSinceMonday);
  return localDateKey(date);
}

export function buildPlannedSessionKey({
  acceptedAt = "accepted-plan",
  day = "session",
  dayIndex = 0,
  exerciseIds = [],
  date = new Date(),
} = {}) {
  const normalizedExercises = [...new Set(
    (Array.isArray(exerciseIds) ? exerciseIds : [])
      .map((exerciseId) => String(exerciseId).trim())
      .filter(Boolean)
  )];
  return [
    "wellness",
    planWeekKey(date),
    String(acceptedAt || "accepted-plan").trim(),
    String(dayIndex),
    String(day || "session").trim().toLowerCase(),
    normalizedExercises.join(","),
  ].join("|");
}

export function serializePlannedSessionNote({
  sessionKey,
  sessionDay = "",
  sessionTitle = "",
} = {}) {
  if (!sessionKey) return "";
  return `${PLAN_SESSION_NOTE_PREFIX}${JSON.stringify({
    version: 1,
    session_key: String(sessionKey),
    session_day: String(sessionDay),
    session_title: String(sessionTitle),
  })}`;
}

export function parsePlannedSessionNote(notes) {
  const text = String(notes ?? "").trim();
  if (!text.startsWith(PLAN_SESSION_NOTE_PREFIX)) return null;
  try {
    const parsed = JSON.parse(text.slice(PLAN_SESSION_NOTE_PREFIX.length));
    if (!parsed?.session_key) return null;
    return {
      sessionKey: String(parsed.session_key),
      sessionDay: String(parsed.session_day ?? ""),
      sessionTitle: String(parsed.session_title ?? ""),
    };
  } catch (_) {
    return null;
  }
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0
    ? Math.floor(number)
    : null;
}

export function minimumRepetitionsPerSet(dose = {}) {
  return positiveInteger(
    dose?.repsMin
      ?? dose?.reps_minimum
      ?? dose?.repsMinimum
      ?? dose?.reps_min
      ?? dose?.reps,
  );
}

export function sessionReachedTarget(session) {
  const repsCompleted = Number(session?.reps_completed ?? session?.repsCompleted);
  const repsTarget = Number(session?.reps_target ?? session?.repsTarget);
  const repsMinimum = Number(
    session?.reps_minimum
      ?? session?.repsMinimum
      ?? session?.reps_min
      ?? repsTarget,
  );
  const setsCompleted = Number(session?.sets_completed ?? session?.setsCompleted);
  const setsTarget = Number(session?.sets_target ?? session?.setsTarget);
  return (
    Number.isFinite(repsCompleted)
    && Number.isFinite(repsMinimum)
    && repsMinimum > 0
    && repsCompleted >= repsMinimum
    && (
      !Number.isFinite(setsTarget)
      || setsTarget <= 0
      || (Number.isFinite(setsCompleted) && setsCompleted >= setsTarget)
    )
  );
}

export function completedExerciseIdsForPlannedSession(
  sessions,
  sessionKey,
) {
  if (!sessionKey) return [];
  return [...new Set(
    (Array.isArray(sessions) ? sessions : [])
      .filter((session) => (
        parsePlannedSessionNote(session?.notes)?.sessionKey === sessionKey
        && sessionReachedTarget(session)
      ))
      .map((session) => String(session.exercise ?? session.exercise_id ?? ""))
      .filter(Boolean)
  )];
}

export function nextIncompleteExerciseId(exerciseIds, completedExerciseIds) {
  const completed = new Set(
    (Array.isArray(completedExerciseIds) ? completedExerciseIds : [])
      .map((exerciseId) => String(exerciseId))
  );
  return (Array.isArray(exerciseIds) ? exerciseIds : [])
    .map((exerciseId) => String(exerciseId))
    .find((exerciseId) => !completed.has(exerciseId)) ?? null;
}

export function painBaselineForNextExercise({
  nextExerciseId,
  painLevel,
} = {}) {
  const exerciseId = String(nextExerciseId ?? "").trim();
  const normalizedPainLevel = Number(painLevel);
  if (
    !exerciseId
    || painLevel === null
    || painLevel === undefined
    || painLevel === ""
    || !Number.isInteger(normalizedPainLevel)
    || normalizedPainLevel < 0
    || normalizedPainLevel > 10
  ) {
    return null;
  }
  return {
    exerciseId,
    painLevel: normalizedPainLevel,
  };
}

export function sessionsForPlannedSession(sessions, sessionKey) {
  if (!sessionKey) return [];
  return (Array.isArray(sessions) ? sessions : []).filter(
    (session) => (
      parsePlannedSessionNote(session?.notes)?.sessionKey === sessionKey
      && sessionReachedTarget(session)
    )
  );
}
