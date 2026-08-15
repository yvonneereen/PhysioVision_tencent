const COACHING_SCORING_VERSION = 3;
const DEFAULT_GRACE_REPETITIONS = 2;
const DEFAULT_DEDUCTION = 5;
const DEFAULT_MAX_DEDUCTION = 30;
const PROTOTYPE_POINTS_PER_OBSERVED_REPETITION = 1;
const PROTOTYPE_MAX_DEDUCTION_PER_OBSERVATION = 10;

const REQUIRED_RULE_CARD_FIELDS = Object.freeze([
  "clinicalClaim",
  "intendedPopulation",
  "measuredSignal",
  "cameraView",
  "thresholdSource",
  "feedback",
  "unableToAssessConditions",
  "contraindicationsContext",
]);

function nonNegativeNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function normalizedCue(cue) {
  const text = String(cue?.message ?? cue?.cue_text ?? cue ?? "").trim();
  if (!text) return null;
  const ruleCard = cue?.ruleCard ?? null;
  return {
    id: String(cue?.ruleId ?? cue?.id ?? text),
    text,
    reliable: cue?.qualityReliable !== false && cue?.reliable !== false,
    scoreable: isClinicalRuleScoreable(cue),
    condition: String(cue?.condition ?? ""),
    ruleCard,
    ruleVersion: String(ruleCard?.clinicianApproval?.version ?? ""),
  };
}

function coachingRecords(cuesTriggered = [], version = COACHING_SCORING_VERSION) {
  return (Array.isArray(cuesTriggered) ? cuesTriggered : []).filter(
    (cue) => Number(cue?.scoring_version) === version,
  );
}

function prototypeObservationRecords(cuesTriggered = []) {
  return (Array.isArray(cuesTriggered) ? cuesTriggered : []).filter(
    (cue) => cue?.kind === "movement_observation"
      && (nonNegativeNumber(cue?.trigger_count) ?? 0) > 0,
  );
}

/**
 * A transparent engineering/demo score for rules that have not passed the
 * clinical validation gate. It is deliberately kept separate from the
 * validation-gated coaching-response score used by longitudinal trends.
 */
export function calculatePrototypeMovementScore({
  cuesTriggered = [],
  repetitions = 0,
} = {}) {
  const reps = Math.max(0, Math.round(nonNegativeNumber(repetitions) ?? 0));
  if (reps < 1) return null;

  const deductions = prototypeObservationRecords(cuesTriggered).map((cue) => {
    const observedRepetitions = Math.min(
      reps,
      Math.max(1, Math.round(nonNegativeNumber(cue.trigger_count) ?? 1)),
    );
    const deduction = Math.min(
      PROTOTYPE_MAX_DEDUCTION_PER_OBSERVATION,
      observedRepetitions * PROTOTYPE_POINTS_PER_OBSERVED_REPETITION,
    );
    return {
      rule_id: String(cue.rule_id ?? "prototype-observation"),
      cue_text: String(cue.cue_text ?? cue.rule_id ?? "Prototype observation"),
      observed_repetitions: observedRepetitions,
      deduction,
    };
  });
  const totalDeduction = Math.min(
    DEFAULT_MAX_DEDUCTION,
    deductions.reduce((total, item) => total + item.deduction, 0),
  );
  return {
    score: Math.round(100 - totalDeduction),
    total_deduction: totalDeduction,
    deductions,
  };
}

export function isClinicalRuleScoreable(cue = {}) {
  const card = cue.ruleCard ?? {};
  const hasCompleteCard = REQUIRED_RULE_CARD_FIELDS.every((field) => {
    const value = card[field];
    return Array.isArray(value) ? value.length > 0 : Boolean(String(value ?? "").trim());
  });
  return Boolean(
    cue.scoringEligible === true
    && hasCompleteCard
    && card.validationStatus === "clinically_validated"
    && card.technicalValidationStatus === "validated"
    && card.clinicianApproval?.approved === true
    && card.clinicianApproval?.approvedBy
    && card.clinicianApproval?.approvedAt
    && card.clinicianApproval?.version
  );
}

/**
 * Tracks whether a patient had a fair opportunity to respond to a correction.
 * A correction is scoreable only after it was stable, displayed, and either
 * spoken successfully or intentionally delivered in on-screen-only mode.
 */
export class CoachingQualitySession {
  constructor({
    stableForMs = 800,
    graceRepetitions = DEFAULT_GRACE_REPETITIONS,
    deductionPerIssue = DEFAULT_DEDUCTION,
    maxDeduction = DEFAULT_MAX_DEDUCTION,
  } = {}) {
    this.stableForMs = stableForMs;
    this.graceRepetitions = graceRepetitions;
    this.deductionPerIssue = deductionPerIssue;
    this.maxDeduction = maxDeduction;
    this.reset();
  }

  reset() {
    this.candidate = null;
    this.pending = null;
    this.active = null;
    this.records = [];
    this.observations = new Map();
    this.assessedCueIds = new Set();
    this.nextReminderId = 1;
    this.activeObservationCandidate = null;
    if (!Array.isArray(this.ruleInventory)) this.ruleInventory = [];
  }

  configureRules(cues = {}) {
    this.ruleInventory = Object.entries(cues ?? {}).map(
      ([condition, configuredCue]) => normalizedCue(
        typeof configuredCue === "string"
          ? { id: condition, condition, message: configuredCue }
          : { ...configuredCue, id: configuredCue.id ?? condition, condition },
      ),
    ).filter(Boolean);
  }

  observe({ cue = null, timestampMs = Date.now(), repetitionNumber = 1 } = {}) {
    const now = Number.isFinite(Number(timestampMs))
      ? Number(timestampMs)
      : Date.now();
    const repetition = Math.max(1, Math.round(Number(repetitionNumber) || 1));
    const issue = normalizedCue(cue);

    this._assessActiveIfWindowComplete(repetition);

    // Prototype observations remain visible and auditable, but cannot enter
    // the reminder/deduction path until their rule card passes the explicit
    // technical, clinical, and clinician-approval gate.
    if (issue && !issue.scoreable) {
      this._recordUnscoredObservation(issue, repetition);
      this.candidate = null;
      this.activeObservationCandidate = null;
      return {
        handled: true,
        stable: true,
        adjusting: false,
        observationOnly: true,
        reminder: null,
      };
    }

    if (this.active && repetition > this.active.reminder_rep) {
      if (issue?.reliable && issue.id === this.active.cue_id) {
        if (
          this.activeObservationCandidate?.cue_id !== issue.id
          || this.activeObservationCandidate?.repetition !== repetition
        ) {
          this.activeObservationCandidate = {
            cue_id: issue.id,
            repetition,
            first_seen_at: now,
          };
        } else if (
          now - this.activeObservationCandidate.first_seen_at >= this.stableForMs
        ) {
          this.active.observed_repetitions.add(repetition);
        }
      } else {
        this.activeObservationCandidate = null;
      }
    }

    // Only one clear correction is coached at a time. While its response
    // window is active, other measurements cannot silently affect the score.
    if (this.active) {
      return {
        handled: issue?.id === this.active.cue_id,
        stable: issue?.id === this.active.cue_id,
        adjusting: true,
        reminder: null,
      };
    }

    if (this.pending) {
      if (issue?.reliable && issue.id === this.pending.cue_id) {
        this.pending.last_seen_at = now;
        return { handled: true, stable: true, reminder: this.pending };
      }
      // Do not play a correction that has already disappeared while it was
      // waiting for another audio message to finish.
      if (now - this.pending.last_seen_at > 500) this.pending = null;
      else return { handled: false, stable: false, reminder: null };
    }

    if (!issue?.reliable) {
      this.candidate = null;
      return { handled: false, stable: false, reminder: null };
    }

    if (this.assessedCueIds.has(issue.id)) {
      return { handled: true, stable: true, reminder: null };
    }

    if (this.candidate?.cue_id !== issue.id) {
      this.candidate = {
        cue_id: issue.id,
        cue_text: issue.text,
        rule_version: issue.ruleVersion,
        condition: issue.condition,
        measured_signal: issue.ruleCard?.measuredSignal ?? "",
        threshold_source: issue.ruleCard?.thresholdSource ?? "",
        first_seen_at: now,
      };
      return { handled: true, stable: false, reminder: null };
    }

    if (now - this.candidate.first_seen_at < this.stableForMs) {
      return { handled: true, stable: false, reminder: null };
    }

    this.pending = {
      id: this.nextReminderId++,
      cue_id: issue.id,
      cue_text: issue.text,
      rule_version: issue.ruleVersion,
      condition: issue.condition,
      measured_signal: issue.ruleCard?.measuredSignal ?? "",
      threshold_source: issue.ruleCard?.thresholdSource ?? "",
      detected_rep: repetition,
      last_seen_at: now,
      displayed: false,
      speech_queued: false,
    };
    this.candidate = null;
    return { handled: true, stable: true, reminder: this.pending };
  }

  markDisplayed(reminderId) {
    if (this.pending?.id !== reminderId) return false;
    this.pending.displayed = true;
    return true;
  }

  markSpeechQueued(reminderId) {
    if (this.pending?.id !== reminderId || this.pending.speech_queued) {
      return false;
    }
    this.pending.speech_queued = true;
    return true;
  }

  releaseSpeech(reminderId) {
    if (this.pending?.id !== reminderId) return;
    this.pending.speech_queued = false;
  }

  confirmDelivery(reminderId, {
    repetitionNumber = 1,
    spoken = false,
    voiceRequired = true,
  } = {}) {
    if (this.pending?.id !== reminderId || !this.pending.displayed) return false;
    if (voiceRequired && !spoken) return false;

    const reminderRep = Math.max(
      1,
      Math.round(Number(repetitionNumber) || this.pending.detected_rep || 1),
    );
    const record = {
      kind: "coaching_reminder",
      scoring_version: COACHING_SCORING_VERSION,
      cue_id: this.pending.cue_id,
      cue_text: this.pending.cue_text,
      rule_version: this.pending.rule_version,
      condition: this.pending.condition,
      measured_signal: this.pending.measured_signal,
      threshold_source: this.pending.threshold_source,
      scoring_eligible: true,
      trigger_count: 1,
      reminder_rep: reminderRep,
      adjustment_reps: this.graceRepetitions,
      delivered: true,
      delivery_mode: spoken ? "shown_and_spoken" : "shown_on_screen",
      outcome: "adjusting",
      deduction: 0,
    };
    this.records.push(record);
    this.active = {
      ...record,
      record,
      observed_repetitions: new Set(),
    };
    this.activeObservationCandidate = null;
    this.pending = null;
    return true;
  }

  finish(totalRepetitions = 0) {
    const total = Math.max(0, Math.round(Number(totalRepetitions) || 0));
    this.pending = null;
    this.candidate = null;
    if (!this.active) return;

    const finalGraceRep = this.active.reminder_rep + this.graceRepetitions;
    if (total >= finalGraceRep) this._completeActiveAssessment();
    else {
      this.active.record.outcome = "not_assessed";
      this.active.record.deduction = 0;
      this.assessedCueIds.add(this.active.cue_id);
      this.active = null;
      this.activeObservationCandidate = null;
    }
  }

  cuesForPersistence() {
    const validatedRuleCount = this.ruleInventory.filter(
      (rule) => rule.scoreable,
    ).length;
    const validatedRuleVersions = [...new Set(
      this.ruleInventory
        .filter((rule) => rule.scoreable && rule.ruleVersion)
        .map((rule) => rule.ruleVersion),
    )];
    return [
      {
        kind: "coaching_quality",
        scoring_version: COACHING_SCORING_VERSION,
        assessment_label: "camera_based_coaching_response",
        validated_rule_count: validatedRuleCount,
        validated_rule_versions: validatedRuleVersions,
        configured_rule_count: this.ruleInventory.length,
        cue_text: "",
        trigger_count: 0,
        deduction: 0,
      },
      ...Array.from(this.observations.values()).map(({ record }) => ({
        ...record,
      })),
      ...this.records.map((record) => ({ ...record })),
    ];
  }

  _recordUnscoredObservation(issue, repetition) {
    const existing = this.observations.get(issue.id);
    if (existing) {
      if (!existing.repetitions.has(repetition)) {
        existing.repetitions.add(repetition);
        existing.record.trigger_count += 1;
        existing.record.observed_repetitions = [...existing.repetitions];
      }
      return;
    }
    const repetitions = new Set([repetition]);
    this.observations.set(issue.id, {
      repetitions,
      record: {
        kind: "movement_observation",
        scoring_version: COACHING_SCORING_VERSION,
        rule_id: issue.id,
        condition: issue.condition,
        cue_text: issue.text,
        trigger_count: 1,
        observed_repetitions: [repetition],
        scoring_eligible: false,
        validation_status: issue.ruleCard?.validationStatus ?? "unvalidated",
        technical_validation_status:
          issue.ruleCard?.technicalValidationStatus ?? "unvalidated",
        reason_not_scored:
          "Rule has not passed technical validation, clinical validation, and recorded physiotherapist approval.",
      },
    });
  }

  _assessActiveIfWindowComplete(currentRepetition) {
    if (
      this.active
      && currentRepetition > (
        this.active.reminder_rep + this.graceRepetitions
      )
    ) {
      this._completeActiveAssessment();
    }
  }

  _completeActiveAssessment() {
    if (!this.active) return;
    const requiredRepetitions = Array.from(
      { length: this.graceRepetitions },
      (_, index) => this.active.reminder_rep + index + 1,
    );
    // A deduction requires the same reliable issue in every grace repetition.
    // A single uncertain or corrected repetition therefore cannot lower score.
    const persisted = requiredRepetitions.every(
      (rep) => this.active.observed_repetitions.has(rep),
    );
    const usedDeduction = this.records.reduce(
      (sum, record) => sum + (nonNegativeNumber(record.deduction) ?? 0),
      0,
    );
    const availableDeduction = Math.max(0, this.maxDeduction - usedDeduction);
    this.active.record.outcome = persisted ? "persisted" : "improved";
    this.active.record.deduction = persisted
      ? Math.min(this.deductionPerIssue, availableDeduction)
      : 0;
    this.assessedCueIds.add(this.active.cue_id);
    this.active = null;
    this.activeObservationCandidate = null;
  }
}

/**
 * Produce a 0–100 coaching-response indicator. In version 3, only documented
 * deductions after delivered reminders affect the score. Saved version-2
 * coaching-response records remain readable for historical continuity; raw
 * unversioned frame detections never create a score.
 */
export function calculateMovementQuality({
  cuesTriggered = [],
  symmetryWarnings = 0,
  repetitions = 0,
} = {}) {
  const reps = Math.round(nonNegativeNumber(repetitions) ?? 0);
  if (reps < 1) return null;

  const versionedRecords = coachingRecords(cuesTriggered);
  if (versionedRecords.length) {
    const metadata = versionedRecords.find(
      (cue) => cue?.kind === "coaching_quality",
    );
    const validatedRuleVersions = Array.isArray(
      metadata?.validated_rule_versions,
    )
      ? metadata.validated_rule_versions.map(String).filter(Boolean)
      : [];
    if (
      (nonNegativeNumber(metadata?.validated_rule_count) ?? 0) < 1
      || validatedRuleVersions.length < 1
    ) {
      return null;
    }
    const validVersions = new Set(validatedRuleVersions);
    const deduction = versionedRecords
      .filter((cue) => (
        cue?.scoring_eligible === true
        && validVersions.has(String(cue?.rule_version ?? ""))
      ))
      .reduce(
      (sum, cue) => sum + (nonNegativeNumber(cue?.deduction) ?? 0),
      0,
    );
    return Math.round(Math.max(
      100 - DEFAULT_MAX_DEDUCTION,
      100 - Math.min(DEFAULT_MAX_DEDUCTION, deduction),
    ));
  }

  // Preserve already-saved version-2 coaching-response scores. Version 3 is
  // deliberately stricter and will not create a new score without validation.
  const versionTwoRecords = coachingRecords(cuesTriggered, 2);
  if (versionTwoRecords.length) {
    const deduction = versionTwoRecords.reduce(
      (sum, cue) => sum + (nonNegativeNumber(cue?.deduction) ?? 0),
      0,
    );
    return Math.round(Math.max(
      100 - DEFAULT_MAX_DEDUCTION,
      100 - Math.min(DEFAULT_MAX_DEDUCTION, deduction),
    ));
  }

  // Raw frame counts and symmetry events do not prove that a correction is
  // clinically meaningful or that the patient received a fair response
  // window. Unversioned detections therefore cannot create a score.
  return null;
}

export function movementQualityFromSession(session = {}) {
  const execution = session.assessment_summary?.movement_execution;
  if (execution?.status && execution.status !== "assessed") return null;
  if (execution?.status === "assessed") {
    return nonNegativeNumber(execution.score);
  }
  const reps = Math.round(nonNegativeNumber(session.reps_completed) ?? 0);
  const cues = Array.isArray(session.cues_triggered)
    ? session.cues_triggered
    : [];
  const symmetryWarnings = nonNegativeNumber(
    session.symmetry_warnings_count,
  ) ?? 0;
  const hasCorrectionEvidence = cues.some(
    (cue) => (nonNegativeNumber(cue?.trigger_count) ?? 0) > 0,
  ) || symmetryWarnings > 0;

  if (
    reps > 0
    && (coachingRecords(cues).length || coachingRecords(cues, 2).length)
  ) {
    return calculateMovementQuality({
      cuesTriggered: cues,
      symmetryWarnings,
      repetitions: reps,
    });
  }

  if (reps > 0 && hasCorrectionEvidence) {
    // Legacy sessions recorded camera detections, sometimes once per frame,
    // but did not record whether the user saw or heard a reminder or received
    // two repetitions to respond. Under the coaching-first rubric none of
    // those old detections is a justified deduction. The underlying cues and
    // angles remain saved; only their displayed coaching-response score is
    // reassessed.
    return null;
  }

  return nonNegativeNumber(session.quality_score);
}

export function buildSessionAssessmentSummary({
  cuesTriggered = [],
  repetitionsCompleted = 0,
  repetitionsMinimum = 0,
  repetitionsTarget = 0,
  setsCompleted = 0,
  setsTarget = 0,
  tracking = {},
  stopReason = "",
} = {}) {
  const totalFrames = Math.max(0, Math.round(Number(tracking.totalFrames) || 0));
  const assessableFrames = Math.min(
    totalFrames,
    Math.max(0, Math.round(Number(tracking.assessableFrames) || 0)),
  );
  const lowConfidenceFrames = Math.max(0, totalFrames - assessableFrames);
  const lowConfidenceFramesPct = totalFrames
    ? Math.round((lowConfidenceFrames / totalFrames) * 1000) / 10
    : null;
  const trackingStatus = totalFrames < 1 || assessableFrames < 1
    ? "unable_to_assess"
    : assessableFrames === totalFrames
      ? "assessable"
      : "partially_assessable";
  const metadata = coachingRecords(cuesTriggered).find(
    (cue) => cue?.kind === "coaching_quality",
  );
  const validatedRuleCount = Math.round(
    nonNegativeNumber(metadata?.validated_rule_count) ?? 0,
  );
  const validatedRuleVersions = Array.isArray(metadata?.validated_rule_versions)
    ? metadata.validated_rule_versions.map(String).filter(Boolean)
    : [];
  const observedRuleIds = [...new Set(
    (Array.isArray(cuesTriggered) ? cuesTriggered : [])
      .filter((cue) => cue?.kind === "movement_observation")
      .map((cue) => String(cue.rule_id ?? "").trim())
      .filter(Boolean),
  )];
  const score = trackingStatus === "unable_to_assess"
    ? null
    : calculateMovementQuality({
      cuesTriggered,
      repetitions: repetitionsCompleted,
    });
  const prototypeScore = trackingStatus === "unable_to_assess"
    ? null
    : calculatePrototypeMovementScore({
      cuesTriggered,
      repetitions: repetitionsCompleted,
    });
  const movementStatus = Number(repetitionsCompleted) < 1
    || trackingStatus === "unable_to_assess"
      ? "unable_to_assess"
      : validatedRuleCount < 1 || validatedRuleVersions.length < 1
        ? "prototype_scored"
        : "assessed";
  const targetSets = Math.max(0, Math.round(Number(setsTarget) || 0));
  const completedSets = Math.max(0, Math.round(Number(setsCompleted) || 0));
  const completionStatus = targetSets > 0 && completedSets >= targetSets
    ? "complete"
    : "incomplete";

  return {
    version: 1,
    tracking_validity: {
      status: trackingStatus,
      total_frames: totalFrames,
      assessable_frames: assessableFrames,
      low_confidence_frames_pct: lowConfidenceFramesPct,
      limited_tracking_frames: Math.max(
        0,
        Math.round(Number(tracking.limitedTrackingFrames) || 0),
      ),
      missing_measurements: tracking.missingMeasurements ?? {},
    },
    prescription_completion: {
      status: completionStatus,
      repetitions_completed: Math.max(
        0,
        Math.round(Number(repetitionsCompleted) || 0),
      ),
      repetitions_minimum: Math.max(
        0,
        Math.round(Number(repetitionsMinimum) || 0),
      ),
      repetitions_target: Math.max(
        0,
        Math.round(Number(repetitionsTarget) || 0),
      ),
      sets_completed: completedSets,
      sets_target: targetSets,
    },
    movement_execution: {
      status: movementStatus,
      label: movementStatus === "prototype_scored"
        ? "prototype_camera_movement_score"
        : "camera_based_coaching_response",
      score: movementStatus === "assessed"
        ? score
        : movementStatus === "prototype_scored"
          ? prototypeScore?.score ?? 100
          : null,
      prototype_deductions: movementStatus === "prototype_scored"
        ? prototypeScore?.deductions ?? []
        : [],
      validated_rule_count: validatedRuleCount,
      rule_versions: validatedRuleVersions,
      symmetry_rule_validated: false,
      observed_unvalidated_rule_ids: observedRuleIds,
      reason: movementStatus === "prototype_scored"
        ? "Engineering observations produced a transparent prototype score. This is not a clinical score, diagnosis, or substitute for physiotherapist assessment."
        : movementStatus === "unable_to_assess"
          ? "No assessable repetition was captured."
          : "Only validation-gated rules contributed to this coaching-response score.",
    },
    symptoms_and_safety: {
      status: stopReason ? "patient_reported" : "not_reported_during_movement",
      source: "patient_report",
      stop_reason: String(stopReason || ""),
      camera_inference_used: false,
    },
  };
}
