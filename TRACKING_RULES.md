# How prototype movement-tracking rules are produced

Human exercise instructions describe intent. A camera engine needs a separate,
measurable specification: visible landmarks, calculated features, movement
phases, confidence gates and a cue for each detectable error.

The engineering specifications are in `exercises/tracking-specs.js`. They cover
every exercise in `exercises/catalog.js`; all now have executable prototype
rules in `exercises/registry.js`. Prototype availability is not clinical
validation.

## Translation process

1. Break each instruction into observable statements. For example, “keep the
   elbow straight” is observable; pain and the amount of force are not.
2. Select landmarks that can represent each statement. MediaPipe Pose returns
   33 body landmarks, including shoulders, elbows, wrists, hips, knees, ankles,
   heels and foot indices. MediaPipe Hand Landmarker returns 21 landmarks for
   the wrist and finger joints.
3. Turn landmark coordinates into features. Typical features are a three-point
   joint angle, movement relative to a personal baseline, distance normalised
   by limb length, displacement over time, or a sequence of classified shapes.
4. Define movement phases and their order. A repetition is counted only after
   the required phases are observed for a stable period.
5. List non-observable conditions. A single RGB camera cannot measure pain,
   grip force, resistance-band tension, weight bearing or support stability.
   These require a question, clinician restriction, another sensor or manual
   review.
6. Add tracking gates. If a required landmark is missing or uncertain, the
   timer pauses and positive feedback is hidden.

MediaPipe documentation:

- [Pose Landmarker](https://developers.google.com/edge/mediapipe/solutions/vision/pose_landmarker/)
- [21 hand landmarks](https://developers.google.com/edge/api/mediapipe/java/com/google/mediapipe/tasks/vision/handlandmarker/HandLandmark)
- [MediaPipe Hands paper](https://arxiv.org/abs/2006.10214)

## Measurement implementation and confidence contract

Reusable temporal and spatial measurements are implemented in
`movement-measurements.js`; hand-specific measurements and hand-shape rules are
in `hand-geometry.js`. Every public measurement returns this shape:

```js
{
  value, // number, classification, trajectory summary or sequence
  confidence: {
    status: "usable" | "low" | "unavailable",
    score: 0.0,
    reason: null,
  },
  lowConfidence: false,
  weakPoints: [],
}
```

Implemented features include wrist/finger angles, palm-plane orientation,
normalised distances, displacement, velocity, body/limb stillness, circular
trajectory descriptors, tendon-glide hand-shape estimates and gait-event
sequences. A low-confidence result may be displayed for diagnostics, but it
must not count a repetition, advance a hold timer or show positive coaching.

The gait sequence uses prototype kinematic extrema and remains unsuitable for
clinical conclusions without target-population validation. Marker-free gait
research likewise treats heel-strike and toe-off extraction as a separately
validated algorithm rather than a direct landmark output:
[marker-free gait analysis study](https://pmc.ncbi.nlm.nih.gov/articles/PMC10384445/).

## Where numerical thresholds come from

The values currently marked `engineering_seed` are hypotheses for prototype
data collection, not clinical limits. Online instructions alone cannot validate
them. A defensible threshold is obtained as follows:

1. A physiotherapist records several correct repetitions and the specific
   mistakes the product should recognise.
2. The same camera protocol is used across participants, while deliberately
   varying body size, comfortable range, clothing and lighting.
3. Landmarks and features are extracted from every labelled frame.
4. Data is divided by participant, not by random frame, so one person's frames
   cannot appear in both training and testing.
5. Candidate thresholds are fitted on training participants and selected on a
   validation group. The false-positive “movement looks good” rate is treated
   as a primary safety metric.
6. Performance is reported on untouched participants for every movement phase
   and correction cue. Failed visibility must be reported separately from an
   incorrect movement.
7. Personal calibration measures each user's starting position and comfortable
   target. Relative change is used where possible instead of assuming everyone
   has the same range.
8. A physiotherapist approves the final range, wording and escalation behaviour
   before the specification can move into `exercises/registry.js`.

Every executable exercise now exposes the same two-stage calibration contract:
one starting-position capture and three comfortable target captures. Only
measurements listed in that exercise's `personalizedKeys` are changed. The
personal range is clamped between the exercise's existing start and endpoint
limits. Posture checks, confidence gates, categorical phases and stated safety
limits are never loosened. For categorical hand sequences, calibration records
the user's framing and classification baseline but keeps the required shapes
unchanged.

Published rehabilitation-pose research also shows why exercise- and
camera-specific validation matters: reported joint-angle error varies with pose
and viewpoint rather than producing one universally accurate angle.
[UCO rehabilitation dataset study](https://pmc.ncbi.nlm.nih.gov/articles/PMC10648737/)

## Example: wrist extension stretch

The human instruction is decomposed into four candidate features:

```text
“elbow straight”       -> angle(shoulder, elbow, wrist)
“wrist upward”         -> angle(elbow, hand wrist, middle-finger MCP)
“palm downward”        -> orientation of the wrist/index-MCP/pinky-MCP plane
“forearm still”        -> elbow/wrist displacement divided by shoulder width
```

The initial `160–180°` elbow band is only an engineering seed. During
calibration, the user extends the arm comfortably while the system measures
their baseline and camera noise. Clinician-labelled videos then determine how
much deviation reliably separates a bent elbow from natural asymmetry or
tracking error.

Wrist exercises cannot be activated using the current pose tracker alone. They
require the hand tracker, close camera framing and tests for self-occlusion by
the assisting hand.

## Prototype and validation rule

An exercise may be exposed as a clearly labelled engineering prototype once
its measurements, phase state machine, confidence gates, tests and camera
limitations are implemented. It must not be presented as validated or relied
on for clinical safety until all of the following exist:

- implemented feature calculations;
- clinician-approved rules and cues;
- personal calibration where required;
- tracking-loss tests;
- clinician-labelled video validation;
- acceptable per-cue false-positive and false-negative results;
- a documented list of conditions the camera cannot assess.

All 23 supplied exercises are selectable prototypes. Wrist and forearm
exercises use synchronized Pose + Hand frames where needed; hand sequences use
classified finger shapes; trajectory exercises use body-normalised time
windows. Exercises involving a ball, resistance band, support, step, gait or
mobility aid remain partial-observation or proxy trackers because the camera
cannot measure force, weight bearing, equipment stability or pain. Every
prototype requires clinician review and clinician-labelled real-video
validation before its thresholds can be considered reliable.

## Validation-gated movement execution

The runtime now keeps four outputs separate in every newly saved session:

- `tracking_validity`: whether the required landmarks could be assessed;
- `prescription_completion`: repetitions and sets completed against the
  prescribed minimum and target;
- `movement_execution`: only rules that pass the validation gate can produce a
  camera-based coaching-response score;
- `symptoms_and_safety`: patient-reported stop reasons only. The camera does not
  infer pain, dizziness, breathlessness, or fatigue.

Every correction is converted to a rule card at runtime. A rule is scoreable
only when all of the following are explicitly recorded:

```js
{
  scoringEligible: true,
  ruleCard: {
    clinicalClaim,
    intendedPopulation,
    measuredSignal,
    cameraView,
    thresholdSource,
    feedback,
    unableToAssessConditions,
    contraindicationsContext,
    technicalValidationStatus: "validated",
    validationStatus: "clinically_validated",
    clinicianApproval: {
      approved: true,
      approvedBy,
      approvedAt,
      version,
    },
  },
}
```

Missing evidence fails closed: the camera event is saved as an unvalidated
observation, it cannot trigger a deduction, and the session displays “Not
clinically scored.” Current registry thresholds remain `engineering_seed`
prototypes, so none are validation-gated scoring rules yet.

The half-squat implementation also no longer treats knee flexion below 90° or
torso lean above 40° as universal errors. The front-camera knee-forward proxy
and left/right knee-flexion difference remain visible observations only, and
the symmetry observation explicitly does not claim knee-to-toe alignment.
