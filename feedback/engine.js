import { EXERCISES, EXERCISE_MAP } from "../exercises/registry.js?v=62";
import { applyCalibration } from "../personalization.js";
import { isClinicalRuleScoreable } from "../movement-quality.js?v=4";

export { EXERCISES };

export class FeedbackEngine {
  constructor(
    exerciseId = "half-squats",
    affectedSide = "right",
    calibration = null
  ) {
    this._init(exerciseId, affectedSide, calibration);
  }

  _init(exerciseId, affectedSide, calibration = null) {
    const sideCalibration = calibration?.affectedSide
      && calibration.affectedSide !== affectedSide
      ? null
      : calibration;
    this.exercise = applyCalibration(EXERCISE_MAP[exerciseId], sideCalibration);
    this.side = affectedSide;
    this.frameTrackingSide = affectedSide;
    // Parse "standing → squat → standing"; drop "hold" (handled by UI timer)
    this.stages = this.exercise.repRule
      .split("→")
      .map((s) => s.trim())
      .filter((s) => s !== "hold");
    this.stageIdx = 0;
    this.currentPhase = this.stages[0];
    this.repCount = 0;
    this.inHold = false; // true while user is holding a stretch position
    this.phaseCandidate = null;
    this.phaseCandidateSince = 0;
    this.phaseCandidateInterruptedAt = null;
    this.trackingLostSince = null;
    this.adaptiveBaselines = {};
    this.adaptiveTargets = {};
    this.startConfirmed = !this.exercise.phaseConfirmationMs;
  }

  changeExercise(exerciseId, affectedSide, calibration = null) {
    this._init(exerciseId, affectedSide ?? this.side, calibration);
  }

  update(angles, timestampMs = Date.now()) {
    const tracking = this._trackingStatus(angles);
    this.frameTrackingSide = tracking.trackingSide ?? this.side;
    const detected = tracking.ready ? this._detectPhase(angles) : null;
    let canAdvance = tracking.ready;

    if (!tracking.ready) {
      if (this.trackingLostSince === null) {
        this.trackingLostSince = timestampMs;
      }
      this._interruptPhaseCandidate(timestampMs);
      const trackingLossGraceMs = this.exercise.trackingLossGraceMs ?? 0;
      if (timestampMs - this.trackingLostSince >= trackingLossGraceMs) {
        this._resetPhaseCandidate();
        this.startConfirmed = !this.exercise.phaseConfirmationMs;
        this.adaptiveBaselines = {};
        this.adaptiveTargets = {};
      }
    } else if (!this.startConfirmed) {
      this.trackingLostSince = null;
      canAdvance = false;
      if (
        detected === this.stages[0] &&
        this._phaseConfirmed(`start:${detected}`, timestampMs)
      ) {
        this.startConfirmed = true;
        this._captureAdaptiveBaseline(angles);
        this._resetPhaseCandidate();
      } else if (detected !== this.stages[0]) {
        this._interruptPhaseCandidate(timestampMs);
      }
    } else {
      this.trackingLostSince = null;
    }

    if (!canAdvance) {
      // Start-position confirmation and tracking-loss handling above own the
      // phase candidate until it is safe to advance the exercise sequence.
    } else if (this.inHold) {
      // Only cancel if clearly in a different named phase — ignore null (low-confidence / mid-transition)
      if (detected !== null && detected !== this.currentPhase) {
        this.inHold = false;
        this.stageIdx = 0;
        this.currentPhase = this.stages[0];
      }
    } else if (detected !== null && detected !== this.currentPhase) {
      const nextStage = this.stages[this.stageIdx + 1];
      if (detected === nextStage) {
        if (this._phaseConfirmed(detected, timestampMs)) {
          this._advanceToPhase(detected, angles);
        }
      } else {
        this._interruptPhaseCandidate(timestampMs);
      }
    } else {
      this._interruptPhaseCandidate(timestampMs);
    }

    const expectedNextPhase = this.stages[this.stageIdx + 1] ?? this.stages[0];
    const cueDetails = tracking.ready ? this._evaluateCueDetails(angles) : [];
    return {
      exercise: this.exercise,
      stages: this.stages,
      stageIndex: this.stageIdx,
      phase: this.currentPhase,
      detectedPhase: detected,
      positionRecognized: detected !== null,
      expectedNextPhase,
      sequenceOnTrack:
        detected === null
          ? false
          : detected === this.currentPhase || detected === expectedNextPhase,
      repCount: this.repCount,
      inHold: this.inHold,
      holdPositionMaintained:
        this.inHold && tracking.ready && detected === this.currentPhase,
      trackingReady: tracking.ready,
      missingMeasurements: tracking.missingMeasurements,
      missingLandmarks: tracking.missingLandmarks,
      trackingSide: tracking.trackingSide,
      limitedTracking: tracking.limitedTracking,
      symmetryAvailable: tracking.symmetryAvailable,
      startConfirmed: this.startConfirmed,
      progress: tracking.ready ? this._progressToNext(angles) : 0,
      cues: cueDetails.map((cue) => cue.message),
      cueDetails,
      symmetryWarning: tracking.ready ? this._checkSymmetry(angles) : null,
    };
  }

  // Called by main.js when the hold countdown reaches zero
  completeHold() {
    this.repCount++;
    this.inHold = false;
    this.stageIdx = 0;
    this.currentPhase = this.stages[0];
    if (this.exercise.requiresReturnAfterHold) {
      // A second hold cannot be earned by remaining in the target position.
      // The stable starting phase must be observed again first.
      this.startConfirmed = false;
      this._resetPhaseCandidate();
    }
  }

  // ── Private ──────────────────────────────────────────────────────────────

  _detectPhase(angles) {
    const current = this.stages[this.stageIdx];
    const expected = this.stages[this.stageIdx + 1] ?? this.stages[0];
    const preferredNames = this.exercise.preferExpectedPhase
      ? this.startConfirmed
        ? [expected, current]
        : [this.stages[0]]
      : [];
    const orderedPhases = [
      ...preferredNames
        .map((name) => this.exercise.phases.find((phase) => phase.name === name))
        .filter(Boolean),
      ...this.exercise.phases,
    ].filter((phase, index, phases) =>
      phases.findIndex((candidate) => candidate.name === phase.name) === index
    );

    for (const phase of orderedPhases) {
      if (this._phaseMatches(phase, angles)) return phase.name;
    }
    return null;
  }

  _phaseMatches(phase, angles) {
    const adaptiveMatch = this._adaptivePhaseMatches(phase, angles);
    if (adaptiveMatch !== null) return adaptiveMatch;

    // Phase ranges stay strict unless an individual exercise explicitly opts
    // into tolerant matching. A global tolerance makes transition positions
    // look like completed phases and can count false repetitions.
    const threshold = this.exercise.matchThreshold ?? 1;
    for (const [key, condition] of Object.entries(phase)) {
      if (key === "name") continue;
      const measurement = this._resolve(key, angles);
      if (!measurement || measurement.lowConfidence) return false;
      if (_conditionCloseness(measurement.value, condition) < threshold) return false;
    }
    return true;
  }

  // Map generic key "knee" → "rightKnee" using affected side.
  _resolve(key, angles, side = this.frameTrackingSide ?? this.side) {
    if (key in angles) return angles[key];
    const sideKey = `${side}${key[0].toUpperCase()}${key.slice(1)}`;
    return angles[sideKey] ?? null;
  }

  _trackingStatus(angles) {
    const configuredRequiredKeys = this.exercise.trackingRequiredMeasurements;
    const requiredKeys = new Set(
      configuredRequiredKeys?.length
        ? configuredRequiredKeys
        : this.exercise.phases.flatMap((phase) =>
            Object.keys(phase).filter((key) => key !== "name")
          )
    );
    const oppositeSide = this.side === "left" ? "right" : "left";
    const candidateSides = this.exercise.allowOppositeSideFallback
      ? [...new Set([this.frameTrackingSide, this.side, oppositeSide])]
      : [this.side];
    const candidates = candidateSides.map((side) => {
      const missingMeasurements = new Set();
      const missingLandmarks = new Set();
      for (const key of requiredKeys) {
        const measurement = this._resolve(key, angles, side);
        if (
          !measurement
          || measurement.lowConfidence
          || !_hasUsableValue(measurement.value)
        ) {
          const resolvedKey = this._resolvedKeyName(key, angles, side);
          missingMeasurements.add(resolvedKey);
          const weakPoints = measurement?.weakPoints ?? [];
          if (weakPoints.length) {
            weakPoints.forEach((point) => missingLandmarks.add(point));
          } else {
            missingLandmarks.add(resolvedKey);
          }
        }
      }
      return { side, missingMeasurements, missingLandmarks };
    });
    const candidate = candidates.find(({ missingMeasurements }) =>
      missingMeasurements.size === 0
    ) ?? candidates.reduce((best, current) =>
      current.missingMeasurements.size < best.missingMeasurements.size
        ? current
        : best
    );

    let symmetryAvailable = true;
    if (this.exercise.symmetry) {
      const joint = this.exercise.symmetry.joint;
      const cap = joint[0].toUpperCase() + joint.slice(1);
      symmetryAvailable = ["left", "right"].every((side) => {
        const measurement = angles[`${side}${cap}`];
        return measurement
          && !measurement.lowConfidence
          && Number.isFinite(measurement.value);
      });
      if (
        !symmetryAvailable
        && this.exercise.symmetry.requiredForTracking !== false
      ) {
        for (const side of ["left", "right"]) {
          const key = `${side}${cap}`;
          const measurement = angles[key];
          if (
            !measurement
            || measurement.lowConfidence
            || !Number.isFinite(measurement.value)
          ) {
            candidate.missingMeasurements.add(key);
            const weakPoints = measurement?.weakPoints ?? [];
            if (weakPoints.length) {
              weakPoints.forEach((point) => candidate.missingLandmarks.add(point));
            } else {
              candidate.missingLandmarks.add(key);
            }
          }
        }
      }
    }

    const ready = candidate.missingMeasurements.size === 0;

    return {
      ready,
      missingMeasurements: [...candidate.missingMeasurements],
      missingLandmarks: [...candidate.missingLandmarks],
      trackingSide: candidate.side,
      symmetryAvailable,
      limitedTracking: ready && (
        candidate.side !== this.side
        || (Boolean(this.exercise.symmetry) && !symmetryAvailable)
      ),
    };
  }

  _resolvedKeyName(key, angles, side = this.frameTrackingSide ?? this.side) {
    if (key in angles) return key;
    return `${side}${key[0].toUpperCase()}${key.slice(1)}`;
  }

  _phaseConfirmed(phase, timestampMs) {
    const adaptiveTracking = this.exercise.adaptivePhaseTracking;
    const isAdaptiveReturn = Boolean(
      adaptiveTracking
      && this.startConfirmed
      && this.stageIdx > 0
      && phase === adaptiveTracking.fromPhase
    );
    const isAdaptiveTarget = Boolean(
      adaptiveTracking
      && this.startConfirmed
      && phase === adaptiveTracking.targetPhase
      && this.stages[this.stageIdx + 1] === phase
    );
    // A rep is still required to reach and hold its target phase for the full
    // confirmation period. The return only needs a few consecutive visible
    // frames: requiring another long hold after standing made the last rep
    // disappear when someone naturally started walking back to the laptop.
    const confirmationMs = isAdaptiveReturn
      ? this.exercise.returnPhaseConfirmationMs
        ?? this.exercise.phaseConfirmationMs
        ?? 0
      : isAdaptiveTarget
        ? this.exercise.targetPhaseConfirmationMs
          ?? this.exercise.phaseConfirmationMs
          ?? 0
      : this.exercise.phaseConfirmationMs ?? 0;
    if (confirmationMs <= 0) return true;

    const interruptionGraceMs = this.exercise.phaseInterruptionGraceMs ?? 0;
    const interruptedTooLong = this.phaseCandidateInterruptedAt !== null
      && timestampMs - this.phaseCandidateInterruptedAt > interruptionGraceMs;
    if (this.phaseCandidate !== phase || interruptedTooLong) {
      this.phaseCandidate = phase;
      this.phaseCandidateSince = timestampMs;
      this.phaseCandidateInterruptedAt = null;
      return false;
    }

    this.phaseCandidateInterruptedAt = null;
    return timestampMs - this.phaseCandidateSince >= confirmationMs;
  }

  _interruptPhaseCandidate(timestampMs) {
    if (!this.phaseCandidate) return;
    const interruptionGraceMs = this.exercise.phaseInterruptionGraceMs ?? 0;
    if (interruptionGraceMs <= 0) {
      this._resetPhaseCandidate();
      return;
    }
    if (this.phaseCandidateInterruptedAt === null) {
      this.phaseCandidateInterruptedAt = timestampMs;
      return;
    }
    if (timestampMs - this.phaseCandidateInterruptedAt > interruptionGraceMs) {
      this._resetPhaseCandidate();
    }
  }

  _resetPhaseCandidate() {
    this.phaseCandidate = null;
    this.phaseCandidateSince = 0;
    this.phaseCandidateInterruptedAt = null;
  }

  _advanceToPhase(phase, angles) {
    this._resetPhaseCandidate();
    if (phase === this.exercise.adaptivePhaseTracking?.targetPhase) {
      this._captureAdaptiveTarget(angles);
    }
    this.stageIdx++;
    this.currentPhase = phase;

    if (this.stageIdx < this.stages.length - 1) return;

    if (this.exercise.category === "stretch" || this.exercise.category === "balance") {
      // Don't count yet — wait for the UI hold timer to complete.
      this.inHold = true;
    } else {
      this.repCount++;
      this.stageIdx = 0;
      this.currentPhase = this.stages[0];
      this.adaptiveTargets = {};
      this._captureAdaptiveBaseline(angles);
    }
  }

  _adaptivePhaseMatches(phase, angles) {
    const config = this.exercise.adaptivePhaseTracking;
    if (!config || !config.measurement) return null;

    const measurement = this._resolve(config.measurement, angles);
    if (
      !measurement
      || measurement.lowConfidence
      || !Number.isFinite(measurement.value)
    ) {
      return false;
    }

    const baseline = this._adaptiveBaseline(config.measurement);
    if (phase.name === config.fromPhase) {
      if (
        this.startConfirmed
        && this.stageIdx > 0
        && Number.isFinite(baseline)
      ) {
        return measurement.value >= this._adaptiveReturnThreshold(
          config,
          config.measurement,
          baseline
        );
      }
      const condition = phase[config.measurement];
      if (this.exercise.activeCalibration && condition) {
        return _conditionMatches(measurement.value, condition);
      }
      return condition
        ? _conditionCloseness(measurement.value, condition)
          >= (this.exercise.matchThreshold ?? 1)
        : null;
    }

    if (phase.name !== config.targetPhase || !Number.isFinite(baseline)) {
      return null;
    }
    const targetRange = this.exercise.activeCalibration
      ? phase[config.measurement]
      : config.targetRange ?? phase[config.measurement];
    return baseline - measurement.value >= (config.minimumChange ?? 0)
      && _conditionMatches(measurement.value, targetRange);
  }

  _captureAdaptiveBaseline(angles) {
    const config = this.exercise.adaptivePhaseTracking;
    if (!config?.measurement) return;

    for (const side of ["left", "right"]) {
      const measurement = this._resolve(config.measurement, angles, side);
      if (
        !measurement
        || measurement.lowConfidence
        || !Number.isFinite(measurement.value)
      ) {
        continue;
      }
      const key = `${side}:${config.measurement}`;
      this.adaptiveBaselines[key] = Number.isFinite(this.adaptiveBaselines[key])
        ? Math.max(this.adaptiveBaselines[key], measurement.value)
        : measurement.value;
    }
  }

  _captureAdaptiveTarget(angles) {
    const config = this.exercise.adaptivePhaseTracking;
    if (!config?.measurement) return;

    for (const side of ["left", "right"]) {
      const measurement = this._resolve(config.measurement, angles, side);
      if (
        !measurement
        || measurement.lowConfidence
        || !Number.isFinite(measurement.value)
      ) {
        continue;
      }
      this.adaptiveTargets[`${side}:${config.measurement}`] = measurement.value;
    }
  }

  _adaptiveBaseline(measurementName) {
    const direct = this.adaptiveBaselines[
      `${this.frameTrackingSide}:${measurementName}`
    ];
    if (Number.isFinite(direct)) return direct;

    const available = Object.entries(this.adaptiveBaselines)
      .filter(([key, value]) =>
        key.endsWith(`:${measurementName}`) && Number.isFinite(value)
      )
      .map(([, value]) => value);
    return available.length ? Math.max(...available) : null;
  }

  _adaptiveTarget(measurementName) {
    const direct = this.adaptiveTargets[
      `${this.frameTrackingSide}:${measurementName}`
    ];
    if (Number.isFinite(direct)) return direct;

    const available = Object.entries(this.adaptiveTargets)
      .filter(([key, value]) =>
        key.endsWith(`:${measurementName}`) && Number.isFinite(value)
      )
      .map(([, value]) => value);
    return available.length ? Math.min(...available) : null;
  }

  _adaptiveReturnThreshold(config, measurementName, baseline) {
    const target = this._adaptiveTarget(measurementName);
    if (Number.isFinite(target) && target < baseline) {
      const recoveryFraction = Math.min(
        0.95,
        Math.max(0.5, config.returnRecoveryFraction ?? 0.75)
      );
      return target + (baseline - target) * recoveryFraction;
    }
    return baseline - (config.returnTolerance ?? 6);
  }

  // scoring from 0 - 1, base on how well the stage is done, if 1 then can move on to the next stage
  _progressToNext(angles) {
    // if at the final stage of this distance and 
    if (this.stageIdx >= this.stages.length - 1) return 1;
    const nextName = this.stages[this.stageIdx + 1];
    const nextPhase = this.exercise.phases.find((p) => p.name === nextName);
    if (!nextPhase) return 0;
    const adaptiveProgress = this._adaptiveProgress(nextName, angles);
    if (adaptiveProgress !== null) return adaptiveProgress;
    // Use the weakest (minimum) condition, not the average — a phase only
    // matches when EVERY condition is inside range, so an averaged bar can sit
    // near 100% while one out-of-range angle blocks the rep from counting.
    let total = 0, weakest = 1;
    for (const [key, condition] of Object.entries(nextPhase)) {
      if (key === "name") continue;
      total++;
      const a = this._resolve(key, angles);
      const closeness = (!a || a.lowConfidence)
        ? 0
        : _conditionCloseness(a.value, condition);
      weakest = Math.min(weakest, closeness);
    }
    return total === 0 ? 0 : weakest;
  }

  _adaptiveProgress(nextName, angles) {
    const config = this.exercise.adaptivePhaseTracking;
    if (!config) return null;
    const measurement = this._resolve(config.measurement, angles);
    const baseline = this._adaptiveBaseline(config.measurement);
    if (
      !measurement
      || measurement.lowConfidence
      || !Number.isFinite(measurement.value)
      || !Number.isFinite(baseline)
    ) {
      return 0;
    }
    if (
      nextName === config.fromPhase
      && this.startConfirmed
      && this.stageIdx > 0
    ) {
      const target = this._adaptiveTarget(config.measurement);
      if (!Number.isFinite(target) || target >= baseline) return 0;
      const returnThreshold = this._adaptiveReturnThreshold(
        config,
        config.measurement,
        baseline
      );
      const returnTravel = Math.max(1, returnThreshold - target);
      return Math.min(
        1,
        Math.max(0, (measurement.value - target) / returnTravel)
      );
    }
    if (nextName !== config.targetPhase) return null;
    const targetPhase = this.exercise.phases.find(
      (phase) => phase.name === config.targetPhase,
    );
    const targetRange = this.exercise.activeCalibration
      ? targetPhase?.[config.measurement]
      : config.targetRange ?? targetPhase?.[config.measurement];
    const rangeChange = Array.isArray(targetRange)
      ? Math.max(0, baseline - targetRange[1])
      : 0;
    const minimumChange = Math.max(1, config.minimumChange ?? 1, rangeChange);
    return Math.min(1, Math.max(0, (baseline - measurement.value) / minimumChange));
  }

  _evaluateCueDetails(angles) {
    if (!this.exercise.cues) return [];
    const details = [];
    Object.entries(this.exercise.cues)
      .filter(([condition]) => this._evalCondition(condition, angles))
      .forEach(([condition, configuredCue]) => {
        const cue = typeof configuredCue === "string"
          ? { message: configuredCue }
          : configuredCue;
        const message = String(cue?.message ?? "").trim();
        if (!message || details.some((item) => item.message === message)) return;
        const ruleId = String(
          cue.ruleId ?? `${this.exercise.id}:${condition}`,
        );
        const ruleCard = {
          clinicalClaim:
            "Prototype camera observation; clinical importance has not been established.",
          intendedPopulation:
            "Not established for this prototype.",
          measuredSignal: condition,
          cameraView: this.exercise.camera ?? "unspecified",
          thresholdSource: "engineering_seed",
          feedback: message,
          unableToAssessConditions: [
            "Required landmark missing",
            "Low landmark confidence",
            "Wrong or unsupported camera view",
          ],
          contraindicationsContext:
            "Follow the individual's clinician-defined restrictions and stop rules.",
          validationStatus: "unvalidated",
          technicalValidationStatus: "unvalidated",
          clinicianApproval: {
            approved: false,
            approvedBy: "",
            approvedAt: "",
            version: "",
          },
          ...(cue.ruleCard ?? {}),
        };
        // Validate only the explicitly configured card. The descriptive
        // prototype defaults above make observations auditable, but must never
        // fill missing clinical evidence on behalf of a scoring rule.
        const scoringEligible = isClinicalRuleScoreable(cue);
        details.push({
          id: ruleId,
          ruleId,
          condition,
          message,
          qualityReliable: cue?.qualityReliable !== false,
          scoringEligible,
          ruleCard,
        });
      });
    return details.slice(0, this.exercise.maxCues ?? details.length);
  }

  _evalCondition(cond, angles) {
    const m = cond.match(/^(\w+)([<>])(\d+(?:\.\d+)?)$/);
    if (!m) return false;
    const [, key, op, val] = m;
    const threshold = parseFloat(val);

    // "kneeDiff>15" → compare left vs right
    if (key.endsWith("Diff")) {
      const joint = key.slice(0, -4);
      const cap = joint[0].toUpperCase() + joint.slice(1);
      const l = angles[`left${cap}`], r = angles[`right${cap}`];
      if (!l || !r || l.lowConfidence || r.lowConfidence) return false;
      const diff = Math.abs(l.value - r.value);
      return op === "<" ? diff < threshold : diff > threshold;
    }

    const a = this._resolve(key, angles);
    if (!a || a.lowConfidence) return false;
    return op === "<" ? a.value < threshold : a.value > threshold;
  } // helper function used on evaluate cues to check if the cue is done well

  // check symmetry for bilateral exercises,
  _checkSymmetry(angles) {
    if (!this.exercise.symmetry) return null;
    const { joint, maxDiffDeg } = this.exercise.symmetry;
    const cap = joint[0].toUpperCase() + joint.slice(1);
    const l = angles[`left${cap}`], r = angles[`right${cap}`];
    if (!l || !r || l.lowConfidence || r.lowConfidence) return null;
    const diff = Math.abs(l.value - r.value);
    return diff > maxDiffDeg
      ? "Keep both sides moving together through a comfortable range"
      : null;
  }
}

// How close is `value` to landing inside [min, max]? 0–1, which is defined in registry
function _angleCloseness(value, [min, max]) {
  if (value >= min && value <= max) return 1;
  const mid = (min + max) / 2;
  const halfWidth = (max - min) / 2;
  const outside = Math.abs(value - mid) - halfWidth;
  return Math.max(0, 1 - outside / 70); // 70° as normalising travel distance
}

function _hasUsableValue(value) {
  if (value === null || value === undefined) return false;
  return typeof value !== "number" || Number.isFinite(value);
}

function _conditionMatches(value, condition) {
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

function _conditionCloseness(value, condition) {
  if (Array.isArray(condition)) {
    return Number.isFinite(value) ? _angleCloseness(value, condition) : 0;
  }
  return _conditionMatches(value, condition) ? 1 : 0;
}
