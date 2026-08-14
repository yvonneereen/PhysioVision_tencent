/**
 * Executable exercise rule specifications.
 *
 * The original entries use the AAOS Knee Conditioning Programme:
 * https://www.orthoinfo.org/recovery/knee-conditioning-program
 * Newly promoted catalog entries are explicitly labelled as prototype
 * primary-motion tracking and remain subject to clinician/video validation.
 *
 * Each entry defines:
 *   - Which joint angles to measure (using the landmark triples from geometry.js)
 *   - Target angle ranges per phase (degrees)
 *   - Which angles constitute a completed rep (repRule state machine)
 *   - Symmetry constraints where both sides are in frame
 *   - Coaching cues triggered by out-of-range angles
 *
 * Camera setup: fixed frontal camera, chest height, 2–3 m from user, full body in frame.
 * Angles use MediaPipe worldLandmarks (3D metric, hip-centred) so they are computed in
 * true 3D space and remain valid from a frontal viewpoint — depth is inferred by the model.
 *
 * Angle convention (all from geometry.js `angle(A, B, C)`):
 *   knee  = angle(hip,      knee,   ankle)     — 180° = fully extended
 *   hip   = angle(shoulder, hip,    knee)      — 180° = fully extended / lying flat
 *   ankle = angle(knee,     ankle,  footIndex) — ~90° = neutral standing
 *
 * For side-lying exercises the hip angle (shoulder→hip→knee) still works:
 *   leg in line with trunk ≈ 170–180°, leg lifted 45° ≈ 125–135°.
 */

export const EXERCISES = [
  // ── Stretches ─────────────────────────────────────────────────────────────

  {
    id: "heel-cord-stretch",
    name: "Heel Cord Stretch",
    category: "stretch",
    prescription: { sets: 2, reps: 4, holdSeconds: 30, daysPerWeek: "6–7" },
    camera: "front",
    // Ankle dorsiflexion — wide ranges for demo/illustration tracking.
    trackedAngles: {
      ankle: { points: ["knee", "ankle", "footIndex"], side: "affected" },
    },
    phases: [
      { name: "neutral", ankle: [150, 180] },
      { name: "stretch",  ankle: [30, 120] },
    ],
    repRule: "neutral → stretch → hold",
    phaseConfirmationMs: 0,
    startConfirmed: true,
    matchThreshold: 0.7,
    stageImages: ["standing", "calf-stretch"],
    cues: {
      "ankle>115": "Lean forward more to feel the stretch in the calf",
    },
    trackingNotes: "Side camera; back leg ankle/footIndex landmarks must be visible.",
  },

  {
    id: "standing-quad-stretch",
    name: "Standing Quadriceps Stretch",
    category: "stretch",
    prescription: { sets: 1, reps: 3, holdSeconds: 45, daysPerWeek: "4–5" },
    camera: "front",
    // Affected knee flexes deeply — heel drawn toward buttock.
    trackedAngles: {
      knee: { points: ["hip", "knee", "ankle"], side: "affected" },
    },
    phases: [
      { name: "standing", knee: [140, 180] },
      { name: "stretch",  knee: [30, 105] },   // widened — older adults may not flex past 90
    ],
    repRule: "standing → stretch → hold",
    stageImages: ["standing", "quad-stretch"],
    cues: {
      "knee>110": "Try to pull your heel a little closer to your buttock",
    },
    trackingNotes: "Side camera. Ankle landmark may be partially occluded when heel is raised; flag low-confidence.",
  },

  {
    id: "supine-hamstring-stretch",
    name: "Supine Hamstring Stretch",
    category: "stretch",
    prescription: { sets: 1, reps: 3, holdSeconds: 45, daysPerWeek: "4–5" },
    camera: "front",
    // Hip flexes (leg pulled toward chest), knee should stay as extended as possible.
    trackedAngles: {
      hip:  { points: ["shoulder", "hip",  "knee"],  side: "affected" },
      knee: { points: ["hip",      "knee", "ankle"], side: "affected" },
    },
    phases: [
      { name: "flat",    hip: [155, 180], knee: [155, 180] },
      { name: "stretch", hip: [60, 110],  knee: [130, 180] }, // hip flexed, knee as straight as possible
    ],
    repRule: "flat → stretch → hold",
    stageImages: ["lying-flat", "lying-leg-raised"],
    cues: {
      "knee<120": "Try to straighten your knee more while holding the stretch",
    },
    trackingNotes: "Supine (lying) — side camera. Keep leg in sagittal plane for clean angle reads.",
  },

  // ── Strengthening ─────────────────────────────────────────────────────────

  {
    id: "half-squats",
    name: "Half Squats",
    category: "strengthening",
    // The general-wellness guide uses a single 10-repetition target. A linked
    // clinician prescription or accepted AI plan can still override this dose.
    prescription: { sets: 1, reps: 10, holdSeconds: 5, daysPerWeek: "4–5" },
    camera: "front", // required for bilateral symmetry and facing-direction checks
    trackingWarning:
      "Face the camera and step back until one complete hip, knee, and ankle line is visible. Keep the chair beside you and both feet in view.",
    trackedAngles: {
      leftKnee:  { points: ["leftHip",  "leftKnee",  "leftAnkle"]  },
      rightKnee: { points: ["rightHip", "rightKnee", "rightAnkle"] },
      leftHip:   { points: ["leftShoulder",  "leftHip",  "leftKnee"]  },
      rightHip:  { points: ["rightShoulder", "rightHip", "rightKnee"] },
      torsoLean: {
        points: ["leftShoulder", "rightShoulder", "leftHip", "rightHip"],
      },
      leftKneeForwardRatio: {
        points: ["nose", "leftKnee", "leftAnkle", "leftFootIndex"],
      },
      rightKneeForwardRatio: {
        points: ["nose", "rightKnee", "rightAnkle", "rightFootIndex"],
      },
    },
    // Home cameras often give the farther leg a weaker confidence score. One
    // complete kinetic chain is enough to recognize the movement; the second
    // leg remains useful for optional symmetry coaching.
    allowOppositeSideFallback: true,
    trackingVisibilityThreshold: 0.3,
    matchThreshold: 0.85,
    // A knee angle only needs the hip, knee and ankle landmarks. Treating the
    // shoulder-dependent hip angle as mandatory made otherwise visible squats
    // fail, especially when an older adult was close to the camera.
    trackingRequiredMeasurements: ["knee"],
    // Recognize a comfortable change from the person's own standing angle, so
    // a safe shallow squat is not rejected by a one-size-fits-all depth.
    adaptivePhaseTracking: {
      measurement: "knee",
      fromPhase: "standing",
      targetPhase: "squat",
      minimumChange: 10,
      // Broad technical bounds prevent impossible landmark geometry from
      // entering the phase detector. They are not a clinical depth limit.
      targetRange: [45, 165],
      returnTolerance: 15,
      // Count the return after most of the observed knee-angle excursion has
      // recovered. Requiring the exact first-frame standing angle caused the
      // count to arrive during the following squat.
      returnRecoveryFraction: 0.75,
    },
    // This is coaching for the named half-squat task, not a clinical limit and
    // never affects movement quality. A saved personal target takes priority.
    depthGuidance: {
      fallbackMinimumKneeAngle: 85,
      personalizedMarginDegrees: 4,
    },
    preferExpectedPhase: true,
    // Brief landmark flicker is common while knees bend. Preserve a nearly
    // confirmed phase across a few missed frames, but reset after sustained
    // tracking loss so stale poses cannot earn a repetition.
    // Confirm standing promptly enough that a user who begins during the
    // spoken instruction does not lose their first repetition.
    phaseConfirmationMs: 220,
    // A continuous squat should not require a long pause at the bottom. The
    // faster recognition EMA and this short multi-frame confirmation keep the
    // movement responsive while rejecting one-frame pose jitter.
    targetPhaseConfirmationMs: 180,
    // Once the squat itself has been held and recognized, a short run of
    // standing frames completes the rep. This gives the guide time to count
    // the final return before the user walks back toward their device.
    returnPhaseConfirmationMs: 140,
    phaseInterruptionGraceMs: 250,
    trackingLossGraceMs: 450,
    maxCues: 1,
    calibration: {
      startPhase: "standing",
      targetPhase: "squat",
      captureKeys: ["knee"],
      // Knee-forward depth is retained as an optional coaching measurement,
      // but it must not block calibration or repetition recognition. Its
      // camera-depth estimate is unreliable from a front-facing camera.
      personalizedKeys: ["knee"],
      toleranceDegrees: 12,
      safeRanges: {
        start: {
          knee: [145, 180],
        },
        target: {
          // This is a broad capture-validity range, not a clinically prescribed
          // depth. The person's comfortable target is stored by calibration.
          knee: [45, 165],
        },
      },
      captureErrors: {
        knee: "Use the comfortable half-squat depth prescribed or approved for you.",
      },
    },
    phases: [
      {
        name: "standing",
        knee: [160, 180],
        hip: [155, 180],
      },
      {
        name: "squat",
        knee: [45, 155],
        hip: [90, 135],
      },
    ],
    repRule: "standing → squat → standing",
    stageImages: ["standing", "squat", "standing"],
    symmetry: { joint: "knee", maxDiffDeg: 15, requiredForTracking: false },
    cues: {
      // Front-camera depth makes this ratio useful as optional live guidance,
      // but it is not a validated knee-position or clinical-correctness test.
      "leftKneeForwardRatio>0.15": {
        ruleId: "half-squat:knee-forward-proxy",
        message: "The camera observed forward knee movement relative to the foot. This is an observation only; follow your prescribed technique.",
        qualityReliable: false,
        scoringEligible: false,
        ruleCard: {
          clinicalClaim: "The front-camera knee-to-foot proxy exceeded the engineering threshold.",
          intendedPopulation: "Not established; prototype observation only.",
          measuredSignal: "Horizontal knee position relative to ankle-to-foot length.",
          cameraView: "front",
          thresholdSource: "engineering_seed",
          feedback: "Report the observation without prescribing a universal knee position.",
          unableToAssessConditions: ["Foot occluded", "Knee occluded", "Camera depth ambiguity", "Low landmark confidence"],
          contraindicationsContext: "Clinician-defined restrictions and individual squat strategy take precedence.",
          validationStatus: "unvalidated",
          technicalValidationStatus: "unvalidated",
          clinicianApproval: { approved: false, approvedBy: "", approvedAt: "", version: "" },
        },
      },
      "rightKneeForwardRatio>0.15": {
        ruleId: "half-squat:knee-forward-proxy",
        message: "The camera observed forward knee movement relative to the foot. This is an observation only; follow your prescribed technique.",
        qualityReliable: false,
        scoringEligible: false,
        ruleCard: {
          clinicalClaim: "The front-camera knee-to-foot proxy exceeded the engineering threshold.",
          intendedPopulation: "Not established; prototype observation only.",
          measuredSignal: "Horizontal knee position relative to ankle-to-foot length.",
          cameraView: "front",
          thresholdSource: "engineering_seed",
          feedback: "Report the observation without prescribing a universal knee position.",
          unableToAssessConditions: ["Foot occluded", "Knee occluded", "Camera depth ambiguity", "Low landmark confidence"],
          contraindicationsContext: "Clinician-defined restrictions and individual squat strategy take precedence.",
          validationStatus: "unvalidated",
          technicalValidationStatus: "unvalidated",
          clinicianApproval: { approved: false, approvedBy: "", approvedAt: "", version: "" },
        },
      },
      "kneeDiff>15": {
        ruleId: "half-squat:knee-flexion-difference",
        message: "The camera observed different knee-bending angles. This does not assess knee-to-toe alignment.",
        scoringEligible: false,
        ruleCard: {
          clinicalClaim: "The measured left/right knee-flexion difference exceeded 15 degrees.",
          intendedPopulation: "Not established; prototype observation only.",
          measuredSignal: "Absolute difference between left and right sagittal knee-flexion estimates.",
          cameraView: "front",
          thresholdSource: "engineering_seed",
          feedback: "Report unequal measured bending without claiming frontal-plane knee alignment.",
          unableToAssessConditions: ["Either leg occluded", "Low landmark confidence", "Camera not level"],
          contraindicationsContext: "Natural asymmetry, prescribed unloading, and side-specific restrictions require clinician interpretation.",
          validationStatus: "unvalidated",
          technicalValidationStatus: "unvalidated",
          clinicianApproval: { approved: false, approvedBy: "", approvedAt: "", version: "" },
        },
      },
    },
  },

  {
    id: "hamstring-curls",
    name: "Hamstring Curls",
    category: "strengthening",
    prescription: { sets: 3, reps: 10, holdSeconds: 5, daysPerWeek: "4–5" },
    camera: "front",
    trackingWarning: "Ankle moves behind the body — depth inference is less accurate at peak curl. Angle readings are approximate.",
    // Standing; affected knee flexes, heel rises toward ceiling.
    trackedAngles: {
      knee: { points: ["hip", "knee", "ankle"], side: "affected" },
    },
    phases: [
      { name: "standing", knee: [160, 180] },
      { name: "curled",   knee: [30, 70]   }, // heel toward ceiling
    ],
    repRule: "standing → curled → standing",
    stageImages: ["standing", "knee-curled", "standing"],
    cues: {
      "knee>90": "Curl higher — bring your heel up toward the ceiling",
    },
  },

  {
    id: "calf-raises",
    name: "Calf Raises",
    category: "strengthening",
    prescription: { sets: 2, reps: 10, holdSeconds: 0, daysPerWeek: "6–7" },
    camera: "front",
    // This is a bilateral movement. If one heel is briefly obscured, counting
    // can safely continue from the other complete heel-to-toe line instead of
    // incorrectly telling the person that no calf raise can be measured.
    allowOppositeSideFallback: true,
    // Heel and toe landmarks are small at full-body distance. A task-specific
    // visibility floor avoids rejecting a clearly drawn heel while the global
    // threshold remains stricter for larger joints and form checks.
    trackingVisibilityThreshold: 0.3,
    trackingLossGraceMs: 350,
    phaseConfirmationMs: 120,
    phaseInterruptionGraceMs: 100,
    calibrationVersion: 2,
    calibrationMinimumTargetChange: { footInclination: 12 },
    // Foot inclination: degrees the foot rises above horizontal (floor), 0° when flat.
    // ~0–10° standing flat; ~20–45° on tiptoe. Directly captures heel elevation.
    trackedAngles: {
      footInclination: { points: ["heel", "footIndex"], side: "affected" },
    },
    phases: [
      { name: "flat",   footInclination: [0, 12]  },
      { name: "raised", footInclination: [18, 50] },
    ],
    repRule: "flat → raised → flat",
    stageImages: ["standing", "calf-raised", "standing"],
    cues: {
      "footInclination<18": "Rise higher onto your toes",
    },
  },

  {
    id: "leg-extensions",
    name: "Leg Extensions (Seated)",
    category: "strengthening",
    prescription: { sets: 3, reps: 10, holdSeconds: 5, daysPerWeek: "4–5" },
    camera: "front",
    // Seated on chair; knee extends from ~90° to full extension.
    trackedAngles: {
      knee: { points: ["hip", "knee", "ankle"], side: "affected" },
    },
    phases: [
      { name: "seated",   knee: [80, 105]  }, // at rest on chair
      { name: "extended", knee: [155, 180] }, // leg straightened out
    ],
    repRule: "seated → extended → seated",
    stageImages: ["seated", "seated-leg-extended", "seated"],
    cues: {
      "knee<150": "Try to straighten your leg fully at the top",
    },
  },

  {
    id: "straight-leg-raises-supine",
    name: "Straight-Leg Raises (Supine)",
    category: "strengthening",
    prescription: { sets: 3, reps: 10, holdSeconds: 5, daysPerWeek: "4–5" },
    camera: "front",
    // Lying on back; affected leg lifts 6–10 inches with knee kept straight.
    trackedAngles: {
      hip:  { points: ["shoulder", "hip",  "knee"],  side: "affected" },
      knee: { points: ["hip",      "knee", "ankle"], side: "affected" },
    },
    phases: [
      { name: "flat",   hip: [155, 180], knee: [155, 180] },
      { name: "raised", hip: [125, 155], knee: [155, 180] }, // 6–10 inch lift ≈ 25–35° hip flexion
    ],
    repRule: "flat → raised → flat",
    stageImages: ["lying-flat", "lying-leg-raised", "lying-flat"],
    cues: {
      "knee<150":  "Keep your leg straight — don't bend the knee",
      "hip<120":   "Lower leg slightly — 6 to 10 inches off the floor is enough",
    },
  },

  {
    id: "straight-leg-raises-prone",
    name: "Straight-Leg Raises (Prone)",
    category: "strengthening",
    prescription: { sets: 3, reps: 10, holdSeconds: 5, daysPerWeek: "4–5" },
    camera: "front",
    // Lying face-down; hip extends (leg lifts toward ceiling).
    // Hip extension beyond neutral: angle(shoulder, hip, knee) increases past 180° is
    // not directly computable, so we track relative change: start ≈ 170–180°,
    // raised ≈ 185–200° (landmark coords allow >180° in world space).
    trackedAngles: {
      hip:  { points: ["shoulder", "hip",  "knee"],  side: "affected" },
      knee: { points: ["hip",      "knee", "ankle"], side: "affected" },
    },
    phases: [
      { name: "flat",   hip: [165, 185], knee: [155, 180] },
      { name: "raised", hip: [185, 210], knee: [155, 180] }, // hip extension past neutral
    ],
    repRule: "flat → raised → flat",
    stageImages: ["prone-flat", "prone-leg-raised", "prone-flat"],
    cues: {
      "knee<150": "Keep your knee straight while lifting",
    },
    trackingNotes: "Prone position — face down. Landmark visibility will be low on many joints. Flag liberally.",
    trackingWarning: "High occlusion risk in prone position; side camera essential.",
  },

  {
    id: "hip-abduction",
    name: "Hip Abduction",
    category: "strengthening",
    prescription: { sets: 3, reps: 20, holdSeconds: 5, daysPerWeek: "4–5" },
    camera: "front",
    // Side-lying; top (affected) leg lifts to ~45°.
    // Measured as angle(shoulder, hip, knee) on the top side:
    //   leg in line with trunk ≈ 170–180°; abducted 45° ≈ 125–135°.
    trackedAngles: {
      hip: { points: ["shoulder", "hip", "knee"], side: "affected" },
    },
    phases: [
      { name: "rest",     hip: [160, 180] },
      { name: "abducted", hip: [125, 145] }, // 45° abduction
    ],
    repRule: "rest → abducted → rest",
    stageImages: ["side-lying", "side-lying-abducted", "side-lying"],
    cues: {
      "hip>150": "Lift the leg higher — aim for a 45° angle from your body",
    },
    trackingNotes: "Side-lying; front camera shows frontal-plane motion. Top-side hip/knee landmarks may partially occlude. Flag aggressively.",
    trackingWarning: "Side-lying position: expect frequent low-confidence flags on affected-side landmarks.",
  },

  {
    id: "hip-adduction",
    name: "Hip Adduction",
    category: "strengthening",
    prescription: { sets: 3, reps: 20, holdSeconds: 5, daysPerWeek: "4–5" },
    camera: "front",
    // Side-lying on injured side; bottom (injured) leg lifts 6–8 inches.
    // Same angle definition — angle(shoulder, hip, knee) — but on the bottom side.
    trackedAngles: {
      hip: { points: ["shoulder", "hip", "knee"], side: "affected" },
    },
    phases: [
      { name: "rest",     hip: [160, 180] },
      { name: "adducted", hip: [145, 159] }, // top at 159 to avoid overlap with rest (160+)
    ],
    repRule: "rest → adducted → rest",
    stageImages: ["side-lying", "side-lying-abducted", "side-lying"],
    cues: {
      "hip>163": "Lift the bottom leg off the floor — 6 to 8 inches is the target",
    },
    trackingNotes: "Side-lying on injured side. Bottom leg likely partially occluded by upper body. Expect very high low-confidence rate.",
    trackingWarning: "Most reliable when patient is visible from a 45° elevated front angle.",
  },

  {
    id: "leg-presses",
    name: "Leg Presses (Elastic Band)",
    category: "strengthening",
    prescription: { sets: 3, reps: 10, holdSeconds: 2, daysPerWeek: "4–5" },
    camera: "front",
    // Supine; elastic band around foot arch; knee and hip extend against resistance.
    trackedAngles: {
      hip:  { points: ["shoulder", "hip",  "knee"],  side: "affected" },
      knee: { points: ["hip",      "knee", "ankle"], side: "affected" },
    },
    phases: [
      { name: "bent",     hip: [70, 110],  knee: [70, 105]  }, // start — knees pulled in
      { name: "extended", hip: [140, 180], knee: [150, 180] }, // legs pressed out straight
    ],
    repRule: "bent → extended → bent",
    stageImages: ["lying-knees-bent", "lying-legs-extended", "lying-knees-bent"],
    cues: {
      "knee<150": "Press fully against the band — straighten your leg completely",
    },
    trackingNotes: "Supine. Side camera gives cleanest sagittal-plane read.",
  },

  {
    id: "wrist_extension_stretch", comingSoon: true,
    name: "Wrist Extension Stretch",
    category: "stretch",
    trackingMode: "pose_and_hand",
    trackingMaturity: "engineering_prototype_requires_validation",
    requiresClinicianPlan: true,
    requiresReturnAfterHold: true,
    trackingHoldSeconds: 3,
    prescription: {
      mode: "clinician_plan",
      sets: null,
      reps: null,
      holdSeconds: null,
      daysPerWeek: "as prescribed",
    },
    camera: "close_side_oblique",
    phaseConfirmationMs: 350,
    maxCues: 1,
    trackingWarning:
      "Engineering prototype: use an upright phone and a close side-oblique view containing the working shoulder, elbow and complete hand. The 3-second timer confirms a trackable position; it is not your prescribed stretch duration. Stop if pain, numbness or tingling increases. The thresholds still require clinician-labelled video validation.",
    phases: [
      { name: "neutral", elbow: [150, 180], wristBend: [-12, 12], palmDown: [0.35, 1], forearmHorizontal: [0.45, 1], forearmVelocity: [0, 0.3], wristMatch: [0, 0.14] },
      { name: "wrist_extended", elbow: [150, 180], wristBend: [-70, -15], palmDown: [0.35, 1], forearmHorizontal: [0.45, 1], forearmVelocity: [0, 0.3], wristMatch: [0, 0.14] },
    ],
    repRule: "neutral → wrist_extended → hold",
    stageImages: [],
    cues: {
      "elbow<150": "Straighten your working elbow gently",
      "palmDown<0.35": "Turn the working palm downward",
      "forearmHorizontal<0.45": "Hold your working forearm more horizontally",
      "forearmVelocity>0.3": "Keep your forearm still and move only at the wrist",
      "wristMatch>0.14": "Keep the complete working hand near the tracked wrist",
    },
  },

  {
    id: "wrist_flexion_stretch", comingSoon: true,
    name: "Wrist Flexion Stretch",
    category: "stretch",
    trackingMode: "pose_and_hand",
    trackingMaturity: "engineering_prototype_requires_validation",
    requiresClinicianPlan: true,
    requiresReturnAfterHold: true,
    trackingHoldSeconds: 3,
    prescription: {
      mode: "clinician_plan",
      sets: null,
      reps: null,
      holdSeconds: null,
      daysPerWeek: "as prescribed",
    },
    camera: "close_side_oblique",
    phaseConfirmationMs: 350,
    maxCues: 1,
    trackingWarning:
      "Engineering prototype: use an upright phone and a close side-oblique view containing the working shoulder, elbow and complete hand. The 3-second timer confirms a trackable position; it is not your prescribed stretch duration. Stop if pain increases and do not force the wrist. The thresholds still require clinician-labelled video validation.",
    phases: [
      { name: "neutral", elbow: [150, 180], wristBend: [-12, 12], palmDown: [0.35, 1], forearmHorizontal: [0.45, 1], forearmVelocity: [0, 0.3], wristMatch: [0, 0.14] },
      { name: "wrist_flexed", elbow: [150, 180], wristBend: [15, 70], palmDown: [0.35, 1], forearmHorizontal: [0.45, 1], forearmVelocity: [0, 0.3], wristMatch: [0, 0.14] },
    ],
    repRule: "neutral → wrist_flexed → hold",
    stageImages: [],
    cues: {
      "elbow<150": "Straighten your working elbow gently",
      "palmDown<0.35": "Turn the working palm downward",
      "forearmHorizontal<0.45": "Hold your working forearm more horizontally",
      "forearmVelocity>0.3": "Keep your forearm still and move only at the wrist",
      "wristMatch>0.14": "Keep the complete working hand near the tracked wrist",
    },
  },

  {
    id: "tendon_glides", comingSoon: true,
    name: "Tendon Glides",
    category: "mobility",
    trackingMode: "hand",
    trackingMaturity: "engineering_prototype_requires_validation",
    requiresClinicianPlan: true,
    prescription: {
      mode: "clinician_plan",
      sets: null,
      reps: null,
      holdSeconds: 0,
      daysPerWeek: "as prescribed",
    },
    camera: "hand_close_up",
    phaseConfirmationMs: 350,
    trackingWarning:
      "Engineering prototype: support your forearm and keep one complete hand close to the camera. The guide checks the ordered hand-shape sequence only; it cannot assess tendon loading, force, pain or whether the wrist is clinically neutral. The rule-based shapes still require clinician-labelled video validation.",
    phases: [
      { name: "open_hand", handShape: { equals: "open_hand" }, handShapeScore: [0.7, 1], handFrameReady: [1, 1] },
      { name: "hook_fist", handShape: { equals: "hook_fist" }, handShapeScore: [0.7, 1], handFrameReady: [1, 1] },
      { name: "full_fist", handShape: { equals: "full_fist" }, handShapeScore: [0.7, 1], handFrameReady: [1, 1] },
      { name: "tabletop", handShape: { equals: "tabletop" }, handShapeScore: [0.7, 1], handFrameReady: [1, 1] },
      { name: "straight_fist", handShape: { equals: "straight_fist" }, handShapeScore: [0.7, 1], handFrameReady: [1, 1] },
    ],
    repRule: "open_hand → hook_fist → open_hand → full_fist → open_hand → tabletop → open_hand → straight_fist → open_hand",
    stageImages: [],
    maxCues: 1,
    cues: {
      "handFrameReady<1": "Move your complete working hand into the centre of the camera view",
      "handShapeScore<0.7": "Slow down and make each finger shape clearly before moving to the next one",
    },
  },

  {
    id: "ankle_pumps",
    name: "Ankle Pumps",
    category: "mobility",
    trackingMaturity: "prototype_primary_motion_only",
    requiresClinicianPlan: true,
    prescription: {
      mode: "clinician_plan",
      sets: null,
      reps: null,
      holdSeconds: 0,
      daysPerWeek: "as prescribed",
    },
    camera: "side",
    phaseConfirmationMs: 300,
    maxCues: 1,
    trackingWarning:
      "Prototype tracking: lie with the working leg supported and use a close side view that includes the knee, ankle and complete foot. The guide checks ankle direction and whether the knee stays nearly straight; it cannot assess pain, swelling, circulation or post-operative restrictions. Use only if included in your clinician-approved plan.",
    trackedAngles: {
      ankle: { points: ["knee", "ankle", "footIndex"], side: "affected" },
      knee: { points: ["hip", "knee", "ankle"], side: "affected" },
    },
    phases: [
      { name: "toes_up", ankle: [45, 88], knee: [145, 180] },
      { name: "toes_down", ankle: [98, 150], knee: [145, 180] },
    ],
    repRule: "toes_up → toes_down → toes_up",
    stageImages: ["ankle-toes-up", "ankle-toes-down", "ankle-toes-up"],
    cues: {
      "knee<145": "Keep your knee and upper leg still while moving your ankle",
      "ankle>150": "Use a smaller, comfortable ankle movement",
    },
    trackingNotes:
      "Only the supported, nearly straight-leg variant is enabled. The seated bent-knee variant needs a separate calibration and phase definition.",
  },

  {
    id: "heel_slides",
    name: "Heel Slides",
    category: "mobility",
    trackingMaturity: "prototype_primary_motion_only",
    requiresClinicianPlan: true,
    prescription: {
      mode: "clinician_plan",
      sets: null,
      reps: null,
      holdSeconds: 0,
      daysPerWeek: "as prescribed",
    },
    camera: "side",
    phaseConfirmationMs: 300,
    trackingWarning:
      "Prototype tracking: use an elevated side view with the working hip, knee and ankle visible. The guide counts knee bending and straightening only; it cannot confirm heel contact, pelvic stability, trunk bracing or pain. Use only if included in your clinician-approved plan.",
    trackedAngles: {
      knee: { points: ["hip", "knee", "ankle"], side: "affected" },
    },
    phases: [
      { name: "knee_bent", knee: [60, 120] },
      { name: "leg_extended", knee: [150, 180] },
    ],
    repRule: "knee_bent → leg_extended → knee_bent",
    stageImages: ["heel-slide-bent", "heel-slide-extended", "heel-slide-bent"],
    maxCues: 1,
    cues: {
      "knee<60": "Use a smaller knee bend and keep the movement within your comfortable range",
    },
    trackingNotes:
      "Primary knee motion only. Pelvic displacement and surface contact require additional features before full-form feedback can be enabled.",
  },

  {
    id: "hip_bridge",
    name: "Hip Bridge",
    category: "strengthening",
    trackingMaturity: "prototype_primary_motion_only",
    requiresClinicianPlan: true,
    prescription: {
      mode: "clinician_plan",
      sets: null,
      reps: null,
      holdSeconds: 0,
      daysPerWeek: "as prescribed",
    },
    camera: "side",
    phaseConfirmationMs: 300,
    maxCues: 1,
    trackingWarning:
      "Prototype tracking: use a full side view at bed or floor height with the working shoulder, hip, knee and ankle visible. The guide checks primary hip alignment and knee position; it cannot assess abdominal activation, buttock activation, lower-back arching or pain. Use only if included in your clinician-approved plan.",
    trackedAngles: {
      hip: { points: ["shoulder", "hip", "knee"], side: "affected" },
      knee: { points: ["hip", "knee", "ankle"], side: "affected" },
    },
    phases: [
      { name: "pelvis_down", hip: [105, 148], knee: [55, 125] },
      { name: "bridge", hip: [155, 180], knee: [55, 125] },
    ],
    repRule: "pelvis_down → bridge → pelvis_down",
    stageImages: ["bridge-down", "bridge-up", "bridge-down"],
    cues: {
      "knee<55": "Move your foot slightly farther away to keep the knee comfortable",
      "knee>125": "Move your foot slightly closer before lifting again",
    },
    trackingNotes:
      "Primary shoulder-hip-knee alignment only. Lumbar curvature is not represented by the current landmark model.",
  },

  // ── Additional supplied exercise-recognition prototypes ────────────────

  {
    id: "forearm_supination_pronation_strengthening", comingSoon: true,
    name: "Forearm Supination and Pronation",
    category: "strengthening",
    trackingMode: "pose_and_hand",
    trackingMaturity: "engineering_prototype_requires_validation",
    requiresClinicianPlan: true,
    prescription: { mode: "clinician_plan", sets: null, reps: null, holdSeconds: 0, daysPerWeek: "as prescribed" },
    camera: "close_front_oblique",
    phaseConfirmationMs: 350,
    maxCues: 1,
    trackingWarning:
      "Engineering prototype: keep the working shoulder, elbow and complete hand visible in an upright close frontal-oblique view. It recognises camera-relative palm rotation and elbow position, but cannot verify object weight, grip security, resistance or pain.",
    phases: [
      { name: "neutral", elbow: [70, 110], palmDirection: { oneOf: ["left", "right", "toward_camera", "away_from_camera"] }, handFrameReady: [1, 1], wristMatch: [0, 0.14], upperArmMotion: [0, 0.25] },
      { name: "palm_up", elbow: [70, 110], palmDirection: { equals: "upward" }, handFrameReady: [1, 1], wristMatch: [0, 0.14], upperArmMotion: [0, 0.25] },
      { name: "palm_down", elbow: [70, 110], palmDirection: { equals: "downward" }, handFrameReady: [1, 1], wristMatch: [0, 0.14], upperArmMotion: [0, 0.25] },
    ],
    repRule: "neutral → palm_up → neutral → palm_down → neutral",
    stageImages: [],
    cues: {
      "elbow<70": "Keep your elbow bent near a right angle",
      "elbow>110": "Keep your elbow bent near a right angle",
      "upperArmMotion>0.25": "Keep your upper arm and elbow still while rotating your forearm",
      "wristMatch>0.14": "Keep the complete working hand aligned with the tracked wrist",
    },
  },

  {
    id: "stress_ball_squeeze", comingSoon: true,
    name: "Stress Ball Squeeze",
    category: "strengthening",
    trackingMode: "hand",
    trackingMaturity: "engineering_prototype_partial_observation",
    requiresClinicianPlan: true,
    prescription: {
      mode: "clinician_plan",
      sets: null,
      reps: null,
      holdSeconds: 0,
      daysPerWeek: "as prescribed",
    },
    camera: "hand_close_up",
    phaseConfirmationMs: 350,
    maxCues: 1,
    trackingWarning:
      "Partial-observation prototype: the camera counts a visible open-hand → closed-hand → open-hand sequence only. A ball can hide finger landmarks, and the guide cannot measure grip force, maximum effort, ball softness or pain.",
    phases: [
      {
        name: "open_hand",
        handShape: { equals: "open_hand" },
        handShapeScore: [0.7, 1],
        handFrameReady: [1, 1],
      },
      {
        name: "closed_hand",
        handShape: { oneOf: ["full_fist", "straight_fist"] },
        handShapeScore: [0.7, 1],
        handFrameReady: [1, 1],
      },
    ],
    repRule: "open_hand → closed_hand → open_hand",
    stageImages: [],
    cues: {
      "handFrameReady<1": "Move your complete working hand and the ball into the centre of the camera view",
      "handShapeScore<0.7": "Squeeze slowly so the camera can see your fingers close, then open your hand fully",
    },
  },

  {
    id: "ankle_rotations", comingSoon: true,
    name: "Ankle Rotations",
    category: "mobility",
    trackingMaturity: "engineering_prototype_partial_observation",
    requiresClinicianPlan: true,
    prescription: { mode: "clinician_plan", sets: null, reps: null, holdSeconds: 0, daysPerWeek: "as prescribed" },
    camera: "close_front_oblique",
    phaseConfirmationMs: 350,
    maxCues: 1,
    trackingWarning:
      "Partial-observation prototype: use a close view of the working knee, ankle and complete foot. It recognises small toe trajectories relative to the ankle; a single foot-tip landmark cannot fully measure ankle inversion, eversion or pain.",
    phases: [
      { name: "neutral", toeMotion: [0, 0.06], legMotion: [0, 0.12], circleDirection: { equals: "none" }, circleScore: [0, 0.45] },
      { name: "clockwise_circle", toeMotion: [0.08, 1.5], legMotion: [0, 0.12], circleDirection: { equals: "clockwise" }, circleScore: [0.35, 1] },
      { name: "counterclockwise_circle", toeMotion: [0.08, 1.5], legMotion: [0, 0.12], circleDirection: { equals: "counterclockwise" }, circleScore: [0.35, 1] },
    ],
    repRule: "neutral → clockwise_circle → neutral → counterclockwise_circle → neutral",
    stageImages: [],
    cues: {
      "legMotion>0.12": "Keep your knee and lower leg still while moving from the ankle",
    },
  },

  {
    id: "ankle_range_of_motion", comingSoon: true,
    name: "Ankle Range of Motion",
    category: "mobility",
    trackingMaturity: "engineering_prototype_partial_observation",
    requiresClinicianPlan: true,
    prescription: { mode: "clinician_plan", sets: null, reps: null, holdSeconds: 0, daysPerWeek: "as prescribed" },
    camera: "close_front_oblique",
    phaseConfirmationMs: 350,
    maxCues: 1,
    trackingWarning:
      "Partial-observation prototype: keep the knee, ankle and entire foot close and visible. It recognises a deliberate ankle-relative toe trajectory, but does not identify individual alphabet letters or assess pain.",
    phases: [
      { name: "foot_ready", toeMotion: [0, 0.06], legMotion: [0, 0.12] },
      { name: "letter_motion", toeMotion: [0.12, 1.8], legMotion: [0, 0.12] },
    ],
    repRule: "foot_ready → letter_motion → foot_ready",
    stageImages: [],
    cues: {
      "legMotion>0.12": "Keep your knee and hip still and make the movement from your ankle",
    },
  },

  {
    id: "ankle_dorsiflexion_plantar_flexion", comingSoon: true,
    name: "Ankle Dorsiflexion and Plantar Flexion",
    category: "strengthening",
    trackingMaturity: "prototype_primary_motion_only",
    requiresClinicianPlan: true,
    prescription: { mode: "clinician_plan", sets: null, reps: null, holdSeconds: 0, daysPerWeek: "as prescribed" },
    camera: "side",
    phaseConfirmationMs: 300,
    maxCues: 1,
    trackingWarning:
      "Prototype tracking: use a close side view containing the working knee, ankle and complete foot. The guide recognises ankle direction only; it cannot see band resistance, anchor security, loading or pain.",
    phases: [
      { name: "toes_up", ankle: [45, 88], knee: [60, 130] },
      { name: "toes_down", ankle: [98, 150], knee: [60, 130] },
    ],
    repRule: "toes_up → toes_down → toes_up",
    stageImages: [],
    cues: {
      "knee<60": "Keep the supported knee in a comfortable, steady position",
      "knee>130": "Keep the supported knee in a comfortable, steady position",
    },
  },

  {
    id: "supported_single_leg_balance",
    name: "Supported Single-Leg Balance",
    category: "balance",
    trackingMaturity: "engineering_prototype_partial_observation",
    requiresClinicianPlan: false,
    requiresReturnAfterHold: true,
    trackingHoldSeconds: 5,
    prescription: { sets: 1, reps: 6, holdSeconds: 5, daysPerWeek: "2–3" },
    camera: "front",
    phaseConfirmationMs: 350,
    maxCues: 1,
    safetyNote: "Keep both hands on a sturdy chair, fixed counter or rail throughout. Lift one foot only slightly and lower it immediately if you feel unsteady.",
    trackingWarning:
      "Safety-limited prototype: use a full-body frontal view beside a sturdy fixed support. It recognises a small foot lift and upright posture, but cannot verify your grip, support stability or imminent fall risk.",
    phases: [
      { name: "both_feet_down", workingFootClearance: [-0.05, 0.1], torsoLean: [0, 35] },
      { name: "supported_single_leg", workingFootClearance: [0.13, 1.0], torsoLean: [0, 35] },
    ],
    repRule: "both_feet_down → supported_single_leg → hold",
    stageImages: [],
    cues: {
      "torsoLean>35": "Stand upright and use your fixed support",
    },
  },

  {
    id: "clamshell",
    name: "Clamshell",
    category: "strengthening",
    trackingMaturity: "engineering_prototype_partial_observation",
    requiresClinicianPlan: true,
    prescription: { mode: "clinician_plan", sets: null, reps: null, holdSeconds: 0, daysPerWeek: "as prescribed" },
    camera: "elevated_front_oblique",
    phaseConfirmationMs: 350,
    maxCues: 1,
    trackingWarning:
      "Partial-observation prototype: use an elevated oblique view with both knees and ankles visible. It recognises knee separation while the feet remain together; overlapping side-lying hip landmarks can make pelvic rotation unreliable.",
    phases: [
      { name: "knees_together", kneeSeparation: [0, 0.5] },
      { name: "upper_knee_raised", kneeSeparation: [0.55, 1.5] },
    ],
    repRule: "knees_together → upper_knee_raised → knees_together",
    stageImages: [],
    cues: {
      "ankleSeparation>0.4": "Keep your feet together as the upper knee opens",
    },
  },

  {
    id: "supported_forward_step_up",
    name: "Supported Forward Step-Up",
    category: "strengthening",
    trackingMaturity: "engineering_prototype_partial_observation",
    requiresClinicianPlan: true,
    prescription: { mode: "clinician_plan", sets: null, reps: null, holdSeconds: 0, daysPerWeek: "as prescribed" },
    camera: "side_oblique",
    phaseConfirmationMs: 300,
    maxCues: 1,
    trackingWarning:
      "Safety-limited prototype: include the whole body, step and fixed support in a 45-degree side view. It recognises foot lift and knee extension only; it cannot verify step stability, full-foot placement, rail grip or loading.",
    phases: [
      { name: "floor", workingFootClearance: [-0.05, 0.15], torsoLean: [0, 35] },
      { name: "foot_on_step", workingFootClearance: [0.18, 1.0], torsoLean: [0, 35] },
    ],
    repRule: "floor → foot_on_step → floor",
    stageImages: [],
    cues: {
      "torsoLean>35": "Keep your trunk upright over the step",
    },
  },

  {
    id: "walking_progression", comingSoon: true,
    name: "Walking Progression",
    category: "gait",
    trackingMaturity: "engineering_prototype_partial_observation",
    requiresClinicianPlan: true,
    prescription: { mode: "clinician_plan", sets: null, reps: null, holdSeconds: 0, daysPerWeek: "as prescribed" },
    camera: "side",
    phaseConfirmationMs: 250,
    maxCues: 1,
    trackingWarning:
      "Gait prototype: use a wide full-body side view with several clear steps. It recognises alternating foot lead and upright posture; it cannot assess endurance, floor hazards, pain or clinically validate heel strike and toe-off.",
    phases: [
      { name: "feet_aligned", footLead: [-0.15, 0.15], torsoLean: [0, 25] },
      { name: "working_foot_forward", footLead: [0.2, 1.5], torsoLean: [0, 25] },
      { name: "other_foot_forward", footLead: [-1.5, -0.2], torsoLean: [0, 25] },
    ],
    repRule: "feet_aligned → working_foot_forward → other_foot_forward → feet_aligned",
    stageImages: [],
    cues: {
      "torsoLean>25": "Walk upright without leaning",
    },
  },

  {
    id: "walking_with_mobility_aid", comingSoon: true,
    name: "Walking with a Mobility Aid",
    category: "gait",
    trackingMaturity: "engineering_prototype_partial_observation",
    requiresClinicianPlan: true,
    prescription: { mode: "clinician_plan", sets: null, reps: null, holdSeconds: 0, daysPerWeek: "as prescribed" },
    camera: "side_oblique",
    phaseConfirmationMs: 300,
    maxCues: 1,
    trackingWarning:
      "Safety-limited proxy: the camera uses hand movement and foot order as a proxy for aid → recovering leg → other leg. It does not recognise or inspect the aid itself and cannot verify weight-bearing restrictions, fit, stability, grip or fall risk. Clinician supervision is required.",
    phases: [
      { name: "ready", footLead: [-0.15, 0.15], handMotion: [0, 0.08], torsoLean: [0, 30] },
      { name: "aid_forward_proxy", footLead: [-0.15, 0.15], handMotion: [0.12, 1.5], torsoLean: [0, 30] },
      { name: "recovering_leg_forward", footLead: [0.2, 1.5], torsoLean: [0, 30] },
      { name: "other_leg_through", footLead: [-1.5, -0.2], torsoLean: [0, 30] },
    ],
    repRule: "ready → aid_forward_proxy → recovering_leg_forward → other_leg_through → ready",
    stageImages: [],
    cues: {
      "torsoLean>30": "Stay inside your prescribed aid and keep your trunk upright",
    },
  },

  {
    id: "single_knee_to_chest_stretch",
    name: "Single Knee-to-Chest Stretch",
    category: "stretch",
    trackingMaturity: "prototype_primary_motion_only",
    requiresClinicianPlan: true,
    requiresReturnAfterHold: true,
    trackingHoldSeconds: 3,
    prescription: { mode: "clinician_plan", sets: null, reps: null, holdSeconds: null, daysPerWeek: "as prescribed" },
    camera: "elevated_side_oblique",
    phaseConfirmationMs: 350,
    maxCues: 1,
    trackingWarning:
      "Prototype tracking: show the full supine body from an elevated side-oblique view. The 3-second timer confirms the visible position, not a therapeutic dose. The camera cannot detect spreading pain, numbness, tingling or where pressure is applied.",
    phases: [
      { name: "leg_relaxed", hip: [110, 180] },
      { name: "knee_to_chest", hip: [10, 95] },
    ],
    repRule: "leg_relaxed → knee_to_chest → hold",
    stageImages: [],
    cues: {
      "hip>95": "Bring your knee gently toward your chest without forcing the movement",
      "hip<10": "Ease your knee slightly away and stay within your comfortable range",
    },
  },

  {
    id: "hip_flexor_stretch",
    name: "Hip Flexor Stretch",
    category: "stretch",
    trackingMaturity: "engineering_prototype_partial_observation",
    requiresClinicianPlan: true,
    requiresReturnAfterHold: true,
    trackingHoldSeconds: 3,
    prescription: { mode: "clinician_plan", sets: null, reps: null, holdSeconds: null, daysPerWeek: "as prescribed" },
    camera: "side",
    phaseConfirmationMs: 350,
    maxCues: 1,
    trackingWarning:
      "Partial-observation prototype: include the entire bed edge, trunk and both legs in a side view. The 3-second timer only confirms the visible position. The camera cannot verify bed safety, lower-back comfort, stretch force or pain.",
    phases: [
      { name: "setup", hip: [50, 138] },
      { name: "stretch", hip: [140, 180] },
    ],
    repRule: "setup → stretch → hold",
    stageImages: [],
    cues: {
      "hip<140": "Let the stretching leg lower gently without forcing it",
    },
  },

  {
    id: "pendulum",
    name: "Shoulder Pendulum",
    category: "mobility",
    trackingMaturity: "engineering_prototype_partial_observation",
    prescription: { sets: 1, reps: 8, holdSeconds: 0, daysPerWeek: "3" },
    camera: "side_oblique",
    phaseConfirmationMs: 350,
    maxCues: 1,
    trackingWarning:
      "Partial-observation prototype: show the supported lean and complete hanging arm. It recognises a small wrist trajectory with a straight elbow, but cannot determine whether the shoulder is passive, whether the support is stable or whether pain is present.",
    phases: [
      { name: "supported_lean", wristMotion: [0, 0.1] },
      { name: "gentle_swing", wristMotion: [0.13, 2] },
    ],
    repRule: "supported_lean → gentle_swing → supported_lean",
    stageImages: [],
    cues: {
      "wristMotion>1.5": "Keep the pendulum movement small and gentle",
    },
  },

  {
    id: "crossover_arm_stretch",
    name: "Crossover Arm Stretch",
    category: "stretch",
    trackingMaturity: "engineering_prototype_partial_observation",
    requiresClinicianPlan: true,
    requiresReturnAfterHold: true,
    trackingHoldSeconds: 3,
    prescription: { mode: "clinician_plan", sets: null, reps: null, holdSeconds: null, daysPerWeek: "as prescribed" },
    camera: "front",
    phaseConfirmationMs: 350,
    maxCues: 1,
    trackingWarning:
      "Partial-observation prototype: use a frontal upper-body view with both shoulders and complete arms visible. The 3-second timer confirms arm position only; it cannot detect pressure on the elbow, stretch force or pain.",
    phases: [
      { name: "arms_relaxed", wristAcrossMidline: [-2, 0.08] },
      { name: "arm_across_chest", wristAcrossMidline: [0.12, 2] },
    ],
    repRule: "arms_relaxed → arm_across_chest → hold",
    stageImages: [],
    cues: {
      "torsoLean>25": "Keep your trunk upright and facing the camera",
    },
  },

  {
    id: "standing_row", comingSoon: true,
    name: "Standing Row",
    category: "strengthening",
    trackingMaturity: "prototype_primary_motion_only",
    requiresClinicianPlan: true,
    prescription: { mode: "clinician_plan", sets: null, reps: null, holdSeconds: 0, daysPerWeek: "as prescribed" },
    camera: "front_oblique",
    phaseConfirmationMs: 300,
    maxCues: 1,
    trackingWarning:
      "Prototype tracking: show the torso and complete working arm in a 45-degree view. It recognises elbow extension and bending with trunk control; it cannot verify band resistance, anchor security, grip or scapular muscle activation.",
    phases: [
      { name: "arm_forward", elbow: [145, 180], torsoLean: [0, 25] },
      { name: "elbow_pulled_back", elbow: [60, 120], torsoLean: [0, 25] },
    ],
    repRule: "arm_forward → elbow_pulled_back → arm_forward",
    stageImages: [],
    cues: {
      "torsoLean>25": "Keep your trunk still instead of leaning to pull",
    },
  },

  {
    id: "external_rotation_with_resistance_band", comingSoon: true,
    name: "External Rotation with Resistance Band",
    category: "strengthening",
    trackingMaturity: "prototype_primary_motion_only",
    requiresClinicianPlan: true,
    prescription: { mode: "clinician_plan", sets: null, reps: null, holdSeconds: 0, daysPerWeek: "as prescribed" },
    camera: "front",
    phaseConfirmationMs: 300,
    maxCues: 1,
    trackingWarning:
      "Prototype tracking: use a frontal upper-body view with the working elbow and wrist visible. It recognises the forearm moving outward while the elbow stays bent; it cannot verify band resistance, anchor security, elbow contact force or pain.",
    phases: [
      { name: "forearm_forward", elbow: [70, 110], wristOutwardRatio: [0, 0.35], torsoLean: [0, 20] },
      { name: "forearm_rotated_out", elbow: [70, 110], wristOutwardRatio: [0.55, 1], torsoLean: [0, 20] },
    ],
    repRule: "forearm_forward → forearm_rotated_out → forearm_forward",
    stageImages: [],
    cues: {
      "elbow<70": "Keep your elbow bent near a right angle",
      "elbow>110": "Keep your elbow bent near a right angle",
      "torsoLean>20": "Keep your trunk still while the forearm rotates",
    },
  },

  {
    id: "shoulder_forward_elevation_assisted",
    name: "Assisted Shoulder Forward Elevation",
    category: "mobility",
    trackingMaturity: "engineering_prototype_requires_clinician_target",
    requiresClinicianPlan: true,
    prescription: { mode: "clinician_plan", sets: null, reps: null, holdSeconds: 0, daysPerWeek: "as prescribed" },
    camera: "front_oblique",
    phaseConfirmationMs: 350,
    maxCues: 1,
    trackingWarning:
      "Clinician-target prototype: use a frontal or 45-degree view with both complete arms visible. It recognises arms-down → elevated → arms-down and hand proximity. It cannot know which arm supplies assistance or enforce a post-operative height until the clinician target is configured.",
    phases: [
      { name: "arms_down", shoulder: [0, 40], handProximity: [0, 0.65], torsoLean: [0, 20] },
      { name: "assisted_elevation", shoulder: [70, 155], handProximity: [0, 0.65], torsoLean: [0, 20] },
    ],
    repRule: "arms_down → assisted_elevation → arms_down",
    stageImages: [],
    cues: {
      "shoulder>155": "Stop at your clinician-approved height",
      "handProximity>0.65": "Keep your hands clasped or together on the stick",
      "torsoLean>20": "Keep your body still as your arms rise",
    },
  },
];

// Measurements that describe a user's movement endpoint may be narrowed around
// their comfortable calibration. Form checks, visibility gates, equipment
// proxies and categorical phase definitions deliberately stay fixed.
const PERSONAL_CALIBRATION_KEYS = Object.freeze({
  "heel-cord-stretch": ["ankle"],
  "standing-quad-stretch": ["knee"],
  "supine-hamstring-stretch": ["hip"],
  "hamstring-curls": ["knee"],
  "calf-raises": ["footInclination"],
  "leg-extensions": ["knee"],
  "straight-leg-raises-supine": ["hip"],
  "straight-leg-raises-prone": ["hip"],
  "hip-abduction": ["hip"],
  "hip-adduction": ["hip"],
  "leg-presses": ["hip", "knee"],
  wrist_extension_stretch: ["wristBend"],
  wrist_flexion_stretch: ["wristBend"],
  tendon_glides: [],
  ankle_pumps: ["ankle"],
  heel_slides: ["knee"],
  hip_bridge: ["hip"],
  forearm_supination_pronation_strengthening: [],
  stress_ball_squeeze: [],
  ankle_rotations: ["toeMotion", "circleScore"],
  ankle_range_of_motion: ["toeMotion"],
  ankle_dorsiflexion_plantar_flexion: ["ankle"],
  supported_single_leg_balance: ["workingFootClearance"],
  clamshell: ["kneeSeparation"],
  supported_forward_step_up: ["workingFootClearance"],
  walking_progression: ["footLead"],
  walking_with_mobility_aid: ["handMotion"],
  single_knee_to_chest_stretch: ["hip"],
  hip_flexor_stretch: ["hip"],
  pendulum: ["wristMotion"],
  crossover_arm_stretch: ["wristAcrossMidline"],
  standing_row: ["elbow"],
  external_rotation_with_resistance_band: ["wristOutwardRatio"],
  shoulder_forward_elevation_assisted: ["shoulder"],
});

const RATIO_MEASUREMENTS = new Set([
  "toeMotion",
  "circleScore",
  "workingFootClearance",
  "kneeSeparation",
  "footLead",
  "handMotion",
  "wristMotion",
  "wristAcrossMidline",
  "wristOutwardRatio",
]);

function uniqueMovementStages(exercise) {
  return exercise.repRule
    .split("→")
    .map((stage) => stage.trim())
    .filter((stage) => stage !== "hold")
    .filter((stage, index, stages) => stages.indexOf(stage) === index);
}

function humanizePhase(phase) {
  return phase.replaceAll("_", " ");
}

function calibrationTolerance(key) {
  if (key === "footInclination") return 5;
  return RATIO_MEASUREMENTS.has(key) ? 0.06 : 8;
}

function conditionMap(phase, predicate) {
  return Object.fromEntries(
    Object.entries(phase)
      .filter(([key, condition]) => key !== "name" && predicate(condition))
  );
}

function attachPersonalCalibration(exercise) {
  if (exercise.calibration) return;
  const stages = uniqueMovementStages(exercise);
  const startPhase = exercise.phases.find((phase) => phase.name === stages[0]);
  const targetPhase = exercise.phases.find((phase) => phase.name === stages[1]);
  if (!startPhase || !targetPhase) return;

  const personalizedKeys = PERSONAL_CALIBRATION_KEYS[exercise.id] ?? [];
  const captureKeys = [...new Set([
    ...Object.keys(startPhase),
    ...Object.keys(targetPhase),
  ])].filter((key) => key !== "name");
  const startRanges = conditionMap(startPhase, Array.isArray);
  const targetRanges = conditionMap(targetPhase, Array.isArray);

  // A comfortable target may fall between the standard starting and endpoint
  // bands, but never beyond the outer limits already defined by the exercise.
  for (const key of personalizedKeys) {
    const start = startRanges[key];
    const target = targetRanges[key];
    if (!start || !target) continue;
    targetRanges[key] = [
      Math.min(start[0], target[0]),
      Math.max(start[1], target[1]),
    ];
  }

  const continuousTarget = [
    "ankle_rotations",
    "ankle_range_of_motion",
    "pendulum",
    "walking_progression",
    "walking_with_mobility_aid",
  ].includes(exercise.id);
  const hasPersonalRange = personalizedKeys.length > 0;

  exercise.calibration = {
    version: exercise.calibrationVersion ?? 1,
    mode: hasPersonalRange ? "personal_range" : "tracking_baseline",
    startPhase: startPhase.name,
    targetPhase: targetPhase.name,
    captureKeys,
    personalizedKeys,
    tolerances: Object.fromEntries(
      personalizedKeys.map((key) => [key, calibrationTolerance(key)])
    ),
    minimumTargetChange: exercise.calibrationMinimumTargetChange ?? {},
    safeRanges: { start: startRanges, target: targetRanges },
    safeConditions: {
      start: conditionMap(startPhase, (condition) => !Array.isArray(condition)),
      target: conditionMap(targetPhase, (condition) => !Array.isArray(condition)),
    },
    captureErrors: {},
    startTitle: `Hold the ${humanizePhase(startPhase.name)} position`,
    startInstruction:
      `Move into the ${humanizePhase(startPhase.name)} position shown by the guide and keep every required joint visible.`,
    targetTitle: continuousTarget
      ? `Perform ${humanizePhase(targetPhase.name)} slowly`
      : `Hold your comfortable ${humanizePhase(targetPhase.name)} position`,
    targetInstruction: continuousTarget
      ? `Continue the ${humanizePhase(targetPhase.name)} movement slowly throughout the measurement. Stop if it is uncomfortable.`
      : `Move only as far as is comfortable within your clinician-approved limit, then hold the position for measurement.`,
    safetyStatement: hasPersonalRange
      ? "This personalizes the movement endpoint only. Form and safety gates remain unchanged."
      : "This records your personal tracking baseline. Anatomical shape definitions and safety gates remain unchanged.",
  };
}

EXERCISES.forEach(attachPersonalCalibration);

// Quick lookup by exercise id.
// basic fildering
export const EXERCISE_MAP = Object.fromEntries(EXERCISES.map((e) => [e.id, e]));
