import assert from "node:assert/strict";
import {
  FALL_MONITORING_MODES,
  FallMonitor,
  fallMonitoringModeForExercise,
  parseWellbeingClarificationResponse,
  parseWellbeingResponse,
} from "../fall-monitoring.js";

function point(x, y, visibility = 0.99) {
  return { x, y, z: 0, visibility };
}

function pose({
  nose = [0.5, 0.15],
  shoulders = [[0.43, 0.3], [0.57, 0.3]],
  hips = [[0.45, 0.55], [0.55, 0.55]],
  knees = [[0.46, 0.72], [0.54, 0.72]],
  ankles = [[0.47, 0.9], [0.53, 0.9]],
} = {}) {
  const landmarks = Array.from({ length: 33 }, () => point(0.5, 0.5));
  landmarks[0] = point(...nose);
  landmarks[11] = point(...shoulders[0]);
  landmarks[12] = point(...shoulders[1]);
  landmarks[23] = point(...hips[0]);
  landmarks[24] = point(...hips[1]);
  landmarks[25] = point(...knees[0]);
  landmarks[26] = point(...knees[1]);
  landmarks[27] = point(...ankles[0]);
  landmarks[28] = point(...ankles[1]);
  return landmarks;
}

const lyingPose = pose({
  nose: [0.25, 0.72],
  shoulders: [[0.3, 0.73], [0.42, 0.75]],
  hips: [[0.58, 0.76], [0.68, 0.78]],
  knees: [[0.7, 0.8], [0.76, 0.82]],
  ankles: [[0.82, 0.86], [0.88, 0.88]],
});

function warmedMonitor() {
  const monitor = new FallMonitor({
    warmupMs: 300,
    minimumWarmupFrames: 4,
    candidateHoldMs: 1000,
  });
  monitor.configure("half-squats");
  for (const timestampMs of [0, 100, 200, 300]) {
    monitor.update({ landmarks: pose(), timestampMs });
  }
  return monitor;
}

assert.equal(
  fallMonitoringModeForExercise("half-squats"),
  FALL_MONITORING_MODES.STANDING
);
assert.equal(
  fallMonitoringModeForExercise("leg-extensions"),
  FALL_MONITORING_MODES.SEATED
);
assert.equal(
  fallMonitoringModeForExercise("heel_slides"),
  FALL_MONITORING_MODES.FLOOR
);
assert.equal(
  fallMonitoringModeForExercise({ id: "crossover_arm_stretch", trackingMode: "pose_and_hand" }),
  FALL_MONITORING_MODES.UNAVAILABLE
);

{
  const monitor = warmedMonitor();
  for (const timestampMs of [400, 600, 800, 1000, 1200, 1400]) {
    const event = monitor.update({ landmarks: pose(), timestampMs });
    assert.notEqual(event.type, "possible_fall");
  }
}

{
  const monitor = warmedMonitor();
  const crouch = pose({
    nose: [0.5, 0.27],
    shoulders: [[0.43, 0.42], [0.57, 0.42]],
    hips: [[0.45, 0.68], [0.55, 0.68]],
    knees: [[0.43, 0.78], [0.57, 0.78]],
  });
  assert.notEqual(
    monitor.update({ landmarks: crouch, timestampMs: 500 }).type,
    "possible_fall"
  );
  assert.notEqual(
    monitor.update({ landmarks: pose(), timestampMs: 800 }).type,
    "possible_fall"
  );
}

{
  const monitor = warmedMonitor();
  assert.equal(
    monitor.update({ landmarks: lyingPose, timestampMs: 500 }).type,
    "candidate"
  );
  monitor.update({ landmarks: lyingPose, timestampMs: 700 });
  monitor.update({ landmarks: lyingPose, timestampMs: 1200 });
  const event = monitor.update({ landmarks: lyingPose, timestampMs: 1700 });
  assert.equal(event.type, "possible_fall");
  assert.ok(event.signals.length >= 3);
}

{
  const monitor = new FallMonitor({
    warmupMs: 300,
    minimumWarmupFrames: 4,
    candidateHoldMs: 5000,
    visibilityLossCandidateHoldMs: 600,
  });
  monitor.configure("half-squats");
  for (const timestampMs of [0, 100, 200, 300]) {
    monitor.update({ landmarks: pose(), timestampMs });
  }
  assert.equal(
    monitor.update({ landmarks: lyingPose, timestampMs: 500 }).type,
    "candidate"
  );
  assert.equal(monitor.notePoseUnavailable(700).type, "candidate");
  const event = monitor.notePoseUnavailable(1300);
  assert.equal(event.type, "possible_fall");
  assert.ok(event.signals.includes("pose_lost_after_fall_signals"));
}

{
  const monitor = new FallMonitor({
    warmupMs: 300,
    minimumWarmupFrames: 4,
    candidateHoldMs: 5000,
    visibilityLossCandidateHoldMs: 600,
  });
  monitor.configure("half-squats");
  for (const timestampMs of [0, 100, 200, 300]) {
    monitor.update({ landmarks: pose(), timestampMs });
  }
  const partiallyVisibleFall = lyingPose.map((landmark) => ({
    ...landmark,
    visibility: 0.35,
  }));
  const candidate = monitor.update({
    landmarks: partiallyVisibleFall,
    timestampMs: 500,
  });
  assert.equal(candidate.type, "candidate");
  assert.ok(candidate.signals.includes("limited_pose_visibility"));
  monitor.notePoseUnavailable(700);
  assert.equal(monitor.notePoseUnavailable(1300).type, "possible_fall");
}

{
  const monitor = new FallMonitor({
    warmupMs: 300,
    minimumWarmupFrames: 4,
  });
  monitor.configure("half-squats");
  const croppedStandingPose = pose();
  [0, 7, 8, 27, 28].forEach((index) => {
    croppedStandingPose[index] = {
      ...croppedStandingPose[index],
      visibility: 0.1,
    };
  });
  let event;
  for (const timestampMs of [0, 100, 200, 300]) {
    event = monitor.update({
      landmarks: croppedStandingPose,
      timestampMs,
    });
  }
  assert.equal(event.type, "ready");
  assert.ok(monitor.baseline);
}

{
  const monitor = new FallMonitor({
    warmupMs: 300,
    minimumWarmupFrames: 4,
    visibilityLossCandidateHoldMs: 600,
  });
  monitor.configure("half-squats");
  for (const timestampMs of [0, 100, 200, 300]) {
    monitor.update({ landmarks: pose(), timestampMs });
  }
  const collapsedFragment = Array.from(
    { length: 33 },
    () => point(0.5, 0.5, 0.05)
  );
  collapsedFragment[11] = point(0.42, 0.84, 0.9);
  collapsedFragment[13] = point(0.48, 0.88, 0.9);
  const candidate = monitor.update({
    landmarks: collapsedFragment,
    timestampMs: 500,
  });
  assert.equal(candidate.type, "candidate");
  assert.ok(candidate.signals.includes("upper_body_near_floor"));
  assert.equal(monitor.notePoseUnavailable(1100).type, "possible_fall");
}

{
  const monitor = new FallMonitor({
    warmupMs: 300,
    minimumWarmupFrames: 4,
    visibilityLossCandidateHoldMs: 600,
  });
  monitor.configure("half-squats");
  for (const timestampMs of [0, 100, 200, 300]) {
    monitor.update({ landmarks: pose(), timestampMs });
  }
  const verticallyCollapsedPose = Array.from(
    { length: 33 },
    () => point(0.5, 0.5, 0.05)
  );
  verticallyCollapsedPose[11] = point(0.42, 0.82, 0.9);
  verticallyCollapsedPose[13] = point(0.46, 0.87, 0.9);
  verticallyCollapsedPose[23] = point(0.43, 0.86, 0.35);
  const candidate = monitor.update({
    landmarks: verticallyCollapsedPose,
    timestampMs: 500,
  });
  assert.equal(candidate.type, "candidate");
  assert.ok(candidate.signals.includes("partial_pose_during_descent"));
}

{
  const monitor = new FallMonitor({
    warmupMs: 300,
    minimumWarmupFrames: 4,
    visibilityLossCandidateHoldMs: 200,
  });
  monitor.configure("half-squats");
  for (const timestampMs of [0, 100, 200, 300]) {
    monitor.update({ landmarks: pose(), timestampMs });
  }
  const uprightFragment = Array.from(
    { length: 33 },
    () => point(0.5, 0.5, 0.05)
  );
  uprightFragment[11] = point(0.42, 0.32, 0.9);
  uprightFragment[13] = point(0.48, 0.4, 0.9);
  assert.notEqual(
    monitor.update({ landmarks: uprightFragment, timestampMs: 500 }).type,
    "candidate"
  );
  assert.notEqual(monitor.notePoseUnavailable(900).type, "possible_fall");
}

{
  const monitor = new FallMonitor({
    warmupMs: 300,
    minimumWarmupFrames: 4,
    visibilityLossCandidateHoldMs: 200,
  });
  monitor.configure("half-squats");
  for (const timestampMs of [0, 100, 200, 300]) {
    monitor.update({ landmarks: pose(), timestampMs });
  }
  for (const timestampMs of [500, 900, 1400, 2200]) {
    assert.notEqual(
      monitor.notePoseUnavailable(timestampMs).type,
      "possible_fall"
    );
  }
}

{
  const monitor = warmedMonitor();
  for (const timestampMs of [500, 1000, 1800, 2600, 4000, 6000]) {
    const event = monitor.notePoseUnavailable(timestampMs);
    assert.notEqual(event.type, "possible_fall");
  }
}

{
  const monitor = new FallMonitor({
    warmupMs: 0,
    minimumWarmupFrames: 1,
    candidateHoldMs: 0,
  });
  monitor.configure("heel_slides");
  assert.equal(
    monitor.update({ landmarks: lyingPose, timestampMs: 0 }).type,
    "limited"
  );
  monitor.configure({ id: "pendulum", trackingMode: "pose" });
  assert.equal(
    monitor.update({ landmarks: lyingPose, timestampMs: 100 }).type,
    "unavailable"
  );
}

assert.equal(parseWellbeingResponse("I'm okay"), "okay");
assert.equal(parseWellbeingResponse("I am fine"), "okay");
assert.equal(parseWellbeingResponse("I need help"), "help");
assert.equal(parseWellbeingResponse("I can't move"), "help");
assert.equal(parseWellbeingResponse("No need"), "confirm-okay");
assert.equal(parseWellbeingResponse("I don't need help"), "confirm-okay");
assert.equal(parseWellbeingResponse("I can't stand up anymore"), "help");
assert.equal(parseWellbeingResponse("It is so painful"), "help");
assert.equal(parseWellbeingResponse("Please call my daughter"), "help");
assert.equal(parseWellbeingResponse("Something is wrong"), "help");
assert.equal(parseWellbeingResponse("I feel dizzy"), "help");
assert.equal(parseWellbeingResponse("No, I am not okay"), "help");
assert.equal(parseWellbeingResponse("I am okay but I cannot stand"), "help");
assert.equal(parseWellbeingResponse("False alarm, I can get up"), "okay");
assert.equal(parseWellbeingResponse("No problem, I am fine"), "okay");
assert.equal(parseWellbeingResponse("I am not hurt"), "okay");
assert.equal(parseWellbeingResponse("No pain"), "okay");
assert.equal(parseWellbeingResponse("我没事，我可以站"), "okay");
assert.equal(parseWellbeingResponse("saya tidak boleh berdiri"), "help");
assert.equal(parseWellbeingResponse("எனக்கு உதவி தேவை"), "help");
assert.equal(parseWellbeingResponse("不用帮助"), "confirm-okay");
assert.equal(parseWellbeingClarificationResponse("Yes, I am okay"), "okay");
assert.equal(parseWellbeingClarificationResponse("Yes, no need"), "okay");
assert.equal(parseWellbeingClarificationResponse("No, get someone"), "help");
assert.equal(parseWellbeingClarificationResponse("No need"), null);
assert.equal(parseWellbeingResponse("maybe"), null);

console.log("fall-monitoring tests passed");
