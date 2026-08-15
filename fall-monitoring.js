export const FALL_MONITORING_MODES = Object.freeze({
  STANDING: "standing",
  SEATED: "seated",
  FLOOR: "floor",
  UNAVAILABLE: "unavailable",
});

const FLOOR_EXERCISES = new Set([
  "supine-hamstring-stretch",
  "straight-leg-raises-supine",
  "straight-leg-raises-prone",
  "hip-abduction",
  "hip-adduction",
  "leg-presses",
  "ankle_pumps",
  "heel_slides",
  "hip_bridge",
  "clamshell",
  "single_knee_to_chest_stretch",
  "hip_flexor_stretch",
]);

const SEATED_EXERCISES = new Set([
  "leg-extensions",
]);

const UNAVAILABLE_EXERCISES = new Set([
  "wrist_extension_stretch",
  "wrist_flexion_stretch",
  "tendon_glides",
  "forearm_supination_pronation_strengthening",
  "stress_ball_squeeze",
  "ankle_rotations",
  "ankle_range_of_motion",
  "ankle_dorsiflexion_plantar_flexion",
  "pendulum",
]);

const LANDMARKS = Object.freeze({
  NOSE: 0,
  LEFT_SHOULDER: 11,
  RIGHT_SHOULDER: 12,
  LEFT_HIP: 23,
  RIGHT_HIP: 24,
  LEFT_KNEE: 25,
  RIGHT_KNEE: 26,
  LEFT_ANKLE: 27,
  RIGHT_ANKLE: 28,
});

const DEFAULTS = Object.freeze({
  minimumVisibility: 0.55,
  partialMinimumVisibility: 0.2,
  warmupMs: 1200,
  minimumWarmupFrames: 8,
  historyWindowMs: 1000,
  candidateHoldMs: 5000,
  visibilityLossCandidateHoldMs: 2500,
  partialDescentRecencyMs: 1400,
  partialShoulderDropRatio: 0.32,
  partialShoulderFloorGapRatio: 0.48,
  lostVisibilityMs: 1200,
  rapidDescentRatio: 0.18,
  torsoChangeDegrees: 38,
  lyingTorsoDegrees: 55,
  recoveredTorsoDegrees: 35,
  hipFloorGapRatio: 0.3,
  headFloorGapRatio: 0.44,
  stillMovementRatio: 0.028,
  requiredSignals: 3,
});

function finitePoint(point, minimumVisibility) {
  return Boolean(
    point &&
    Number.isFinite(point.x) &&
    Number.isFinite(point.y) &&
    (point.visibility ?? 1) >= minimumVisibility
  );
}

function visibleCentre(points, minimumVisibility) {
  const visible = points.filter((point) => (
    finitePoint(point, minimumVisibility)
  ));
  if (!visible.length) return null;
  return {
    x: average(visible.map((point) => point.x)),
    y: average(visible.map((point) => point.y)),
  };
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function torsoAngleFromVertical(shoulders, hips) {
  const dx = Math.abs(shoulders.x - hips.x);
  const dy = Math.abs(shoulders.y - hips.y);
  return Math.atan2(dx, Math.max(dy, 0.0001)) * (180 / Math.PI);
}

function average(values) {
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function fallMonitoringModeForExercise(exerciseOrId) {
  const id = typeof exerciseOrId === "string"
    ? exerciseOrId
    : exerciseOrId?.id;
  const trackingMode = typeof exerciseOrId === "object"
    ? exerciseOrId?.trackingMode
    : null;

  if (!id || trackingMode === "hand" || trackingMode === "pose_and_hand") {
    return FALL_MONITORING_MODES.UNAVAILABLE;
  }
  if (UNAVAILABLE_EXERCISES.has(id)) {
    return FALL_MONITORING_MODES.UNAVAILABLE;
  }
  if (FLOOR_EXERCISES.has(id)) {
    return FALL_MONITORING_MODES.FLOOR;
  }
  if (SEATED_EXERCISES.has(id)) {
    return FALL_MONITORING_MODES.SEATED;
  }
  return FALL_MONITORING_MODES.STANDING;
}

export function fallMonitoringReadiness(exerciseOrId) {
  const mode = fallMonitoringModeForExercise(exerciseOrId);
  if (mode === FALL_MONITORING_MODES.FLOOR) {
    return {
      mode,
      state: "limited",
      title: "Floor exercise: visibility check active",
      detail:
        "Possible-fall detection is limited because lying down is expected. Automatic contact alerts cannot start from this mode.",
    };
  }
  if (mode === FALL_MONITORING_MODES.UNAVAILABLE) {
    return {
      mode,
      state: "unavailable",
      title: "Possible-fall check unavailable for this movement",
      detail:
        "Close-up or supported-lean tracking cannot reliably identify a fall, so automatic contact alerts are unavailable.",
    };
  }
  return {
    mode,
    state: "ready",
    title: "Local possible-fall check available",
    detail:
      "It starts with the camera and can begin a verified-contact alert after a one-minute no-response check.",
  };
}

export function summarizeFallPose(landmarks, minimumVisibility = 0.55) {
  if (!Array.isArray(landmarks)) return null;
  // A side-on or collapsing person often occludes one half of their body.
  // Requiring both landmarks in every pair made the safety monitor stop at the
  // exact moment it was most needed. One visible side is enough to keep a
  // conservative body summary; the warm-up below still requires a stable,
  // upright torso baseline.
  const noseLandmark = landmarks[LANDMARKS.NOSE];
  const nose = finitePoint(noseLandmark, minimumVisibility)
    ? { x: noseLandmark.x, y: noseLandmark.y }
    : visibleCentre([landmarks[7], landmarks[8]], minimumVisibility);
  const shoulders = visibleCentre(
    [
      landmarks[LANDMARKS.LEFT_SHOULDER],
      landmarks[LANDMARKS.RIGHT_SHOULDER],
    ],
    minimumVisibility
  );
  const hips = visibleCentre(
    [landmarks[LANDMARKS.LEFT_HIP], landmarks[LANDMARKS.RIGHT_HIP]],
    minimumVisibility
  );
  const knees = visibleCentre(
    [landmarks[LANDMARKS.LEFT_KNEE], landmarks[LANDMARKS.RIGHT_KNEE]],
    minimumVisibility
  );
  const visibleAnkles = [
    landmarks[LANDMARKS.LEFT_ANKLE],
    landmarks[LANDMARKS.RIGHT_ANKLE],
  ].filter((point) => finitePoint(point, minimumVisibility));
  const ankles = visibleCentre(visibleAnkles, minimumVisibility);

  // Feet are frequently just outside a phone's portrait crop. Torso tracking
  // is still sufficient to establish an upright baseline; use the image's
  // lower edge as a conservative floor estimate until an ankle is visible.
  if (!shoulders || !hips) return null;

  return {
    nose,
    shoulders,
    hips,
    knees,
    ankles,
    floorY: visibleAnkles.length
      ? Math.max(...visibleAnkles.map((point) => point.y))
      : 1,
    torsoAngle: torsoAngleFromVertical(shoulders, hips),
  };
}

function summarizePartialFallFragment(landmarks, minimumVisibility) {
  if (!Array.isArray(landmarks)) return null;
  const shoulderPoints = [
    landmarks[LANDMARKS.LEFT_SHOULDER],
    landmarks[LANDMARKS.RIGHT_SHOULDER],
  ].filter((point) => finitePoint(point, minimumVisibility));
  if (!shoulderPoints.length) return null;

  const supportingPoints = [
    landmarks[LANDMARKS.NOSE],
    landmarks[7],
    landmarks[8],
    ...shoulderPoints,
    landmarks[13],
    landmarks[14],
    landmarks[LANDMARKS.LEFT_HIP],
    landmarks[LANDMARKS.RIGHT_HIP],
  ].filter((point) => finitePoint(point, minimumVisibility));
  if (supportingPoints.length < 2) return null;

  return {
    shoulders: visibleCentre(shoulderPoints, minimumVisibility),
  };
}

function poseMovement(previous, current) {
  if (!previous || !current) return Infinity;
  const points = ["nose", "shoulders", "hips", "knees", "ankles"]
    .filter((key) => previous[key] && current[key]);
  return average(points.map((key) => distance(previous[key], current[key])));
}

function normalizeWellbeingSpeech(transcript) {
  return String(transcript ?? "")
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^\p{L}\p{M}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function parseWellbeingResponse(transcript) {
  const normalized = normalizeWellbeingSpeech(transcript);
  if (!normalized) return null;

  if (
    /(不能站|无法站|不能起来|无法移动|需要帮助|非常痛|太痛|呼吸困难|胸痛|头晕|麻木|跌倒了|tidak boleh berdiri|tidak boleh bangun|tidak boleh bergerak|perlukan bantuan|terlalu sakit|sukar bernafas|sakit dada|pening|kebas|saya jatuh|நிற்க முடியாது|எழுந்திருக்க முடியாது|நகர முடியாது|உதவி தேவை|மிகவும் வலி|சுவாசிக்க சிரமம்|மார்பு வலி|தலைச்சுற்றல்|உணர்வின்மை|விழுந்துவிட்டேன்)/u.test(normalized)
  ) {
    return "help";
  }

  if (
    /(不用帮助|不需要帮助|不要叫人|tidak perlu bantuan|tak perlu bantuan|jangan hubungi sesiapa|உதவி வேண்டாம்|யாரையும் அழைக்க வேண்டாம்)/u.test(normalized)
  ) {
    return "confirm-okay";
  }

  if (
    /(我没事|我很好|我可以站|我可以移动|saya okay|saya okey|saya baik|saya boleh berdiri|saya boleh bergerak|நான் நலமாக இருக்கிறேன்|நான் சரியாக இருக்கிறேன்|நான் நிற்க முடியும்|நான் நகர முடியும்)/u.test(normalized)
  ) {
    return "okay";
  }

  const strongDistress = [
    /\b(cannot|cant|unable to|struggling to) (stand|stand up|get up|move|walk|breathe|catch my breath)\b/,
    /\b(so|very|really|too|extremely|unbearably|severely) (painful|sore|hurt|hurting)\b/,
    /\b(severe|terrible|unbearable|excruciating|intense) pain\b/,
    /\b(hurts|hurting) (a lot|bad|badly|so much)\b/,
    /\b(chest pressure|chest pain|short of breath|breathless|difficulty breathing)\b/,
    /\b(dizzy|dizziness|faint|fainting|weakness|numb|numbness|confused|bleeding)\b/,
    /\b(i fell|ive fallen|on the floor|im stuck|something is wrong)\b/,
    /\b(call|contact|get|send|bring|fetch) (an ambulance|someone|somebody|my family|my daughter|my son|my contact|a doctor|help)\b/,
  ].some((pattern) => pattern.test(normalized));
  if (strongDistress) return "help";

  if (
    /\b(no need|dont need help|do not need help|no help needed|leave me alone|dont call anyone|do not call anyone)\b/.test(
      normalized
    )
  ) {
    return "confirm-okay";
  }

  const explicitlyUnhurt =
    /\b(im not hurt|i am not hurt|im not injured|i am not injured|no pain|nothing hurts)\b/.test(
      normalized
    );
  const clearlyOkay =
    /\b(im okay|i am okay|im ok|i am ok|okay|ok|im fine|i am fine|fine|im alright|i am alright|all right|all good|no problem|nothing happened|false alarm|i can get up|i can stand|i can move|not hurt|not injured|no pain)\b/.test(
      normalized
    ) || /^(yes|yeah|yep|correct)\b/.test(normalized);
  const bareNegative =
    /^(no|nope|definitely not)\b/.test(normalized)
    && !/^(no problem|no pain)\b/.test(normalized);
  const clearlyNeedsHelp =
    (
      !explicitlyUnhurt
      && /\b(help|need help|hurt|hurting|injured|pain|painful|cannot move|cant move|not okay|not ok|not fine|not alright)\b/.test(
        normalized
      )
    ) || bareNegative;

  // When a response contains reassuring and concerning language, use the
  // safer interpretation. Example: “I’m okay, but I cannot stand.”
  if (clearlyNeedsHelp) return "help";
  if (clearlyOkay) return "okay";
  return null;
}

export function parseWellbeingClarificationResponse(transcript) {
  const response = parseWellbeingResponse(transcript);
  if (response === "okay" || response === "help") return response;
  if (
    response === "confirm-okay"
    && /^(yes|yeah|yep|correct)\b/.test(normalizeWellbeingSpeech(transcript))
  ) {
    return "okay";
  }
  return null;
}

export class FallMonitor {
  constructor(options = {}) {
    this.options = { ...DEFAULTS, ...options };
    this.configure(null);
  }

  configure(exerciseOrId) {
    this.exerciseId = typeof exerciseOrId === "string"
      ? exerciseOrId
      : exerciseOrId?.id ?? null;
    this.mode = fallMonitoringModeForExercise(exerciseOrId);
    this.reset();
    return fallMonitoringReadiness(exerciseOrId);
  }

  reset() {
    this.baseline = null;
    this.warmupStartedAt = null;
    this.warmupFrames = [];
    this.history = [];
    this.previousPose = null;
    this.lastVisibleAt = null;
    this.candidate = null;
    this.triggered = false;
  }

  resumeAfterCheck() {
    this.reset();
  }

  notePoseUnavailable(timestampMs) {
    if (
      this.mode === FALL_MONITORING_MODES.FLOOR ||
      this.mode === FALL_MONITORING_MODES.UNAVAILABLE
    ) {
      return { type: "visibility_lost", mode: this.mode };
    }
    if (this.candidate) {
      if (this.candidate.visibilityLostAt === null) {
        this.candidate.visibilityLostAt = timestampMs;
      }
      const visibilityLostForMs =
        timestampMs - this.candidate.visibilityLostAt;
      const signals = [
        ...new Set([
          ...this.candidate.signals,
          "pose_lost_after_fall_signals",
        ]),
      ];
      if (
        visibilityLostForMs >= this.options.visibilityLossCandidateHoldMs
      ) {
        this.triggered = true;
        return {
          type: "possible_fall",
          mode: this.mode,
          signals,
          visibilityLostForMs,
        };
      }
      return {
        type: "candidate",
        mode: this.mode,
        signals,
        visibilityLostForMs,
      };
    }
    if (
      this.lastVisibleAt !== null &&
      timestampMs - this.lastVisibleAt >= this.options.lostVisibilityMs
    ) {
      this.candidate = null;
      this.history = [];
      return { type: "visibility_lost", mode: this.mode };
    }
    return { type: "waiting_for_pose", mode: this.mode };
  }

  update({ landmarks, timestampMs }) {
    if (this.mode === FALL_MONITORING_MODES.FLOOR) {
      return { type: "limited", mode: this.mode };
    }
    if (this.mode === FALL_MONITORING_MODES.UNAVAILABLE) {
      return { type: "unavailable", mode: this.mode };
    }
    if (this.triggered) {
      return { type: "possible_fall", mode: this.mode, repeated: true };
    }

    let pose = summarizeFallPose(
      landmarks,
      this.options.minimumVisibility
    );
    let partialVisibility = false;
    if (!pose && this.baseline) {
      pose = summarizeFallPose(
        landmarks,
        this.options.partialMinimumVisibility
      );
      partialVisibility = Boolean(pose);
    }
    if (!pose) {
      if (!this.candidate) {
        this.#startCandidateFromPartialPose(landmarks, timestampMs);
      }
      return this.notePoseUnavailable(timestampMs);
    }

    const previousVisibleAt = this.lastVisibleAt;
    this.lastVisibleAt = timestampMs;
    if (!this.baseline) {
      return this.#warmUp(pose, timestampMs);
    }

    this.history.push({ ...pose, timestampMs });
    this.history = this.history.filter(
      (frame) => timestampMs - frame.timestampMs <= this.options.historyWindowMs
    );
    const earlier = this.history[0] ?? pose;
    const height = Math.max(this.baseline.personHeight, 0.12);
    const movementRatio = poseMovement(this.previousPose, pose) / height;
    this.previousPose = pose;

    if (this.candidate) {
      return this.#updateCandidate(pose, timestampMs, movementRatio);
    }

    const signals = this.#fallSignals(earlier, pose, height);
    if (signals.count >= this.options.requiredSignals) {
      const candidateSignals = partialVisibility
        ? [...signals.active, "limited_pose_visibility"]
        : signals.active;
      this.candidate = {
        startedAt: timestampMs,
        stillSince: movementRatio <= this.options.stillMovementRatio
          ? timestampMs
          : null,
        visibilityLostAt: null,
        signals: candidateSignals,
      };
      return {
        type: "candidate",
        mode: this.mode,
        signals: candidateSignals,
      };
    }

    if (
      this.#startCandidateFromPartialPose(
        landmarks,
        timestampMs,
        previousVisibleAt
      )
    ) {
      return {
        type: "candidate",
        mode: this.mode,
        signals: this.candidate.signals,
      };
    }

    return { type: "monitoring", mode: this.mode };
  }

  #warmUp(pose, timestampMs) {
    if (this.warmupStartedAt === null) this.warmupStartedAt = timestampMs;
    const plausibleStart = this.mode === FALL_MONITORING_MODES.SEATED
      ? pose.torsoAngle < 42
      : pose.torsoAngle < 32;

    if (!plausibleStart) {
      this.warmupStartedAt = timestampMs;
      this.warmupFrames = [];
      return { type: "position_for_baseline", mode: this.mode };
    }

    this.warmupFrames.push(pose);
    if (
      timestampMs - this.warmupStartedAt < this.options.warmupMs ||
      this.warmupFrames.length < this.options.minimumWarmupFrames
    ) {
      return { type: "warming_up", mode: this.mode };
    }

    const floorY = average(this.warmupFrames.map((frame) => frame.floorY));
    const shoulderY = average(
      this.warmupFrames.map((frame) => frame.shoulders.y)
    );
    const visibleNoseYs = this.warmupFrames
      .map((frame) => frame.nose?.y)
      .filter(Number.isFinite);
    const topY = visibleNoseYs.length >= this.warmupFrames.length / 2
      ? average(visibleNoseYs)
      : shoulderY;
    this.baseline = {
      floorY,
      hipY: average(this.warmupFrames.map((frame) => frame.hips.y)),
      shoulderY,
      torsoAngle: average(
        this.warmupFrames.map((frame) => frame.torsoAngle)
      ),
      personHeight: Math.max(floorY - topY, 0.12),
    };
    this.history = [{ ...pose, timestampMs }];
    this.previousPose = pose;
    return { type: "ready", mode: this.mode };
  }

  #startCandidateFromPartialPose(
    landmarks,
    timestampMs,
    previousVisibleAt = this.lastVisibleAt
  ) {
    if (!this.baseline || previousVisibleAt === null) return false;
    if (
      timestampMs - previousVisibleAt > this.options.partialDescentRecencyMs
    ) {
      return false;
    }
    const fragment = summarizePartialFallFragment(
      landmarks,
      this.options.partialMinimumVisibility
    );
    if (!fragment) return false;

    const height = Math.max(this.baseline.personHeight, 0.12);
    const shoulderDrop =
      (fragment.shoulders.y - this.baseline.shoulderY) / height;
    const shoulderFloorGap =
      (this.baseline.floorY - fragment.shoulders.y) / height;
    if (
      shoulderDrop < this.options.partialShoulderDropRatio
      || shoulderFloorGap > this.options.partialShoulderFloorGapRatio
    ) {
      return false;
    }

    this.candidate = {
      startedAt: timestampMs,
      stillSince: null,
      visibilityLostAt: null,
      signals: [
        "large_downward_position_change",
        "upper_body_near_floor",
        "partial_pose_during_descent",
      ],
    };
    this.lastVisibleAt = timestampMs;
    return true;
  }

  #fallSignals(earlier, pose, height) {
    const descentRatio = (pose.hips.y - earlier.hips.y) / height;
    const torsoChange = pose.torsoAngle - this.baseline.torsoAngle;
    const hipFloorGap = (this.baseline.floorY - pose.hips.y) / height;
    const upperBodyY = pose.nose?.y ?? pose.shoulders.y;
    const headFloorGap = (this.baseline.floorY - upperBodyY) / height;
    const active = [];

    if (descentRatio >= this.options.rapidDescentRatio) {
      active.push("rapid_downward_movement");
    }
    if (torsoChange >= this.options.torsoChangeDegrees) {
      active.push("large_torso_angle_change");
    }
    if (
      earlier.torsoAngle < this.options.recoveredTorsoDegrees &&
      pose.torsoAngle >= this.options.lyingTorsoDegrees
    ) {
      active.push("upright_to_lying_transition");
    }
    if (
      hipFloorGap <= this.options.hipFloorGapRatio &&
      headFloorGap <= this.options.headFloorGapRatio
    ) {
      active.push("head_and_hips_near_floor");
    }

    return { count: active.length, active };
  }

  #updateCandidate(pose, timestampMs, movementRatio) {
    this.candidate.visibilityLostAt = null;
    const height = Math.max(this.baseline.personHeight, 0.12);
    const hipFloorGap = (this.baseline.floorY - pose.hips.y) / height;
    const recovered =
      pose.torsoAngle <= this.options.recoveredTorsoDegrees &&
      hipFloorGap > this.options.hipFloorGapRatio;

    if (recovered) {
      this.candidate = null;
      return { type: "candidate_cleared", mode: this.mode };
    }

    if (movementRatio <= this.options.stillMovementRatio) {
      if (this.candidate.stillSince === null) {
        this.candidate.stillSince = timestampMs;
      }
    } else {
      this.candidate.stillSince = null;
    }

    const stillFor = this.candidate.stillSince === null
      ? 0
      : timestampMs - this.candidate.stillSince;
    if (stillFor >= this.options.candidateHoldMs) {
      this.triggered = true;
      return {
        type: "possible_fall",
        mode: this.mode,
        signals: this.candidate.signals,
        stillForMs: stillFor,
      };
    }

    return {
      type: "candidate",
      mode: this.mode,
      signals: this.candidate.signals,
      stillForMs: stillFor,
    };
  }
}
