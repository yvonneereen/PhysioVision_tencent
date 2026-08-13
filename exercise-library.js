import { DRAFT_EXERCISES, requiresClinicianPlan } from "./exercises/catalog.js?v=3";
import { EXERCISES, EXERCISE_MAP } from "./exercises/registry.js?v=62";

// Source of truth for "wired": the exercise exists in the executable registry
// and is not flagged `comingSoon`. The camera/feedback loop only scores these.
const isWired = (exercise) => {
  const registryEntry = EXERCISE_MAP[exercise.id];
  return Boolean(registryEntry) && !registryEntry.comingSoon;
};

// Some wired exercises live only in the executable registry and were never
// authored into the educational catalog. Synthesize minimal cards for them so
// the library reflects everything the camera can actually track.
const REGION_KEYWORDS = [
  [/wrist|hand|finger|tendon|grip|stress ball|forearm/i, "Hand & wrist"],
  [/ankle|heel cord|heel slide|calf|foot|toe/i, "Foot & ankle"],
  [/knee|quad|hamstring|squat|leg press|leg extension|straight-leg/i, "Knee & thigh"],
  [/hip|glute|clamshell|bridge|abduction|adduction/i, "Hip & pelvis"],
  [/shoulder|pendulum|row|external rotation|crossover|elevation/i, "Shoulder & arm"],
  [/walk|balance|step/i, "Balance & gait"],
];
const inferRegion = (name) =>
  (REGION_KEYWORDS.find(([re]) => re.test(name)) ?? [null, "General mobility"])[1];
const titleCase = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : "—");

const catalogIds = new Set(DRAFT_EXERCISES.map((exercise) => exercise.id));
const registryOnlyLive = EXERCISES
  .filter((exercise) => !exercise.comingSoon && !catalogIds.has(exercise.id))
  .map((exercise) => ({
    id: exercise.id,
    name: exercise.name,
    region: inferRegion(exercise.name),
    category: titleCase(exercise.category),
    tags: exercise.requiresClinicianPlan ? ["CLINICIAN_GUIDED"] : [],
    typicalUse: [],
    instruction:
      exercise.trackingNotes ||
      "Follow your clinician's guidance and the on-screen coaching cues for this movement.",
    trackingRequirement: "pose_primary_motion_prototype",
    liveTracking: true,
  }));

const LIBRARY_EXERCISES = [...DRAFT_EXERCISES, ...registryOnlyLive];

const TRACKING_LABELS = {
  pose_primary_motion_prototype: "Prototype camera tracking active",
  pose_and_hand_sequence_prototype: "Pose + hand sequence prototype active",
  hand_sequence_prototype: "Hand-shape sequence prototype active",
  hand_landmarks: "Hand tracking required",
  pose_limited: "Camera tracking limited",
  pose_rules_not_validated: "Live rules pending",
};

const humanizeTag = (tag) =>
  tag
    .toLowerCase()
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");

const searchableText = (exercise) =>
  [
    exercise.name,
    exercise.region,
    exercise.category,
    exercise.instruction,
    ...exercise.typicalUse,
    ...exercise.tags,
  ]
    .join(" ")
    .toLowerCase();

function createExerciseCard(exercise) {
  const wired = isWired(exercise);

  const card = document.createElement("article");
  card.className = "exercise-library-card";
  card.classList.toggle("is-live", wired);
  card.classList.toggle("is-coming-soon", !wired);

  const badge = document.createElement("span");
  badge.className = wired ? "exercise-card-badge is-live" : "exercise-card-badge is-coming-soon";
  badge.textContent = wired ? "● Live tracking" : "◌ Coming soon";

  const metadata = document.createElement("p");
  metadata.className = "exercise-card-metadata";
  metadata.textContent = `${exercise.region} · ${exercise.category}`;

  const title = document.createElement("h4");
  title.textContent = exercise.name;

  const status = document.createElement("p");
  status.className = "exercise-card-status";
  status.classList.toggle("is-live", wired);
  status.textContent = wired
    ? TRACKING_LABELS[exercise.trackingRequirement]
    : `Coming soon · camera tracking not wired yet`;

  const tags = document.createElement("div");
  tags.className = "exercise-card-tags";
  exercise.tags.forEach((tag) => {
    const badge = document.createElement("span");
    badge.textContent = humanizeTag(tag);
    tags.append(badge);
  });

  const hasUses = Array.isArray(exercise.typicalUse) && exercise.typicalUse.length > 0;
  const usesTitle = document.createElement("p");
  usesTitle.className = "exercise-card-label";
  usesTitle.textContent = "Typical use";

  const uses = document.createElement("p");
  uses.className = "exercise-card-uses";
  uses.textContent = hasUses ? exercise.typicalUse.join(" · ") : "";

  const details = document.createElement("details");
  details.className = "exercise-card-details";
  const summary = document.createElement("summary");
  summary.textContent = "Read instructions";
  const instruction = document.createElement("p");
  instruction.textContent = exercise.instruction;
  details.append(summary, instruction);

  const safety = document.createElement("p");
  safety.className = "exercise-card-safety";
  safety.textContent = requiresClinicianPlan(exercise)
    ? "Use only when included in a clinician-approved plan."
    : "Review suitability and support needs before starting.";

  card.append(badge, metadata, title, status, tags);
  if (hasUses) card.append(usesTitle, uses);
  card.append(details, safety);
  return card;
}

function initialiseExerciseLibrary() {
  const grid = document.getElementById("exerciseLibraryGrid");
  const search = document.getElementById("exerciseLibrarySearch");
  const region = document.getElementById("exerciseLibraryRegion");
  const count = document.getElementById("exerciseLibraryCount");
  const libraryStatus = document.getElementById("exerciseLibraryStatus");
  const noticeTitle = document.getElementById("exerciseLibraryNoticeTitle");
  const noticeDetail = document.getElementById("exerciseLibraryNoticeDetail");

  if (!grid || !search || !region || !count) return;

  const liveCount = LIBRARY_EXERCISES.filter(isWired).length;
  const pendingCount = LIBRARY_EXERCISES.length - liveCount;
  if (libraryStatus) libraryStatus.textContent = `${liveCount} live · ${pendingCount} coming soon`;
  if (noticeTitle) {
    noticeTitle.textContent = `${liveCount} exercises have live camera tracking, ${pendingCount} coming soon.`;
  }
  if (noticeDetail) {
    noticeDetail.textContent =
      pendingCount
        ? `Live exercises are wired to the camera/feedback engine and score your movement in real time. The ${pendingCount} “coming soon” exercises are documented here but do not yet have camera tracking. All still require clinician-approved use and real-video validation.`
        : "Every exercise is wired to the camera/feedback engine. Each still requires clinician review and real-video validation.";
  }

  [...new Set(LIBRARY_EXERCISES.map((exercise) => exercise.region))]
    .sort()
    .forEach((regionName) => {
      const option = document.createElement("option");
      option.value = regionName;
      option.textContent = regionName;
      region.append(option);
    });

  const render = () => {
    const query = search.value.trim().toLowerCase();
    const selectedRegion = region.value;
    const matches = LIBRARY_EXERCISES.filter(
      (exercise) =>
        (selectedRegion === "all" || exercise.region === selectedRegion) &&
        (!query || searchableText(exercise).includes(query))
    );

    // Show wired ("Live tracking") exercises first, coming-soon ones after.
    const sorted = [...matches].sort((a, b) => Number(isWired(b)) - Number(isWired(a)));

    grid.replaceChildren(...sorted.map(createExerciseCard));
    const shownLive = matches.filter(isWired).length;
    count.textContent = `${matches.length} of ${LIBRARY_EXERCISES.length} shown · ${shownLive} live · ${matches.length - shownLive} coming soon`;

    if (!matches.length) {
      const empty = document.createElement("p");
      empty.className = "exercise-library-empty";
      empty.textContent = "No exercises match that search.";
      grid.append(empty);
    }
  };

  search.addEventListener("input", render);
  region.addEventListener("change", render);
  render();
}

initialiseExerciseLibrary();
