import assert from "node:assert/strict";

import { jointAngles } from "../geometry.js";

const world = Array.from({ length: 33 }, () => ({ x: 0, y: 0, z: 0 }));
const visible = Array.from({ length: 33 }, () => ({ visibility: 1 }));

world[0] = { x: 0, y: -1.3, z: -0.2 }; // nose points towards negative z
world[11] = { x: -0.2, y: -1, z: 0 };
world[12] = { x: 0.2, y: -1, z: 0 };
world[23] = { x: -0.15, y: 0, z: 0 };
world[24] = { x: 0.15, y: 0, z: 0 };
world[25] = { x: -0.1, y: 1, z: -0.2 };
world[26] = { x: 0.1, y: 1, z: 0 };
world[27] = { x: -0.1, y: 2, z: 0 };
world[28] = { x: 0.1, y: 2, z: 0 };
world[31] = { x: -0.1, y: 2, z: 0 };
world[32] = { x: 0.1, y: 2, z: 0 };

{
  const result = jointAngles(world, visible);

  assert.ok(Math.abs(result.torsoLean.value) < 0.001);
  assert.ok(result.leftKneeForwardRatio.value > 0.15);
  assert.ok(Math.abs(result.rightKneeForwardRatio.value) < 0.001);
}

{
  const lowConfidence = visible.map((landmark) => ({ ...landmark }));
  lowConfidence[25].visibility = 0.1;
  const result = jointAngles(world, lowConfidence);

  assert.equal(result.leftKneeForwardRatio.lowConfidence, true);
  assert.ok(result.leftKneeForwardRatio.weakPoints.includes("leftKnee"));
}

{
  const flatWorld = world.map((landmark) => ({ ...landmark }));
  flatWorld[29] = { x: -0.1, y: 2, z: 0 };
  flatWorld[31] = { x: -0.3, y: 2, z: 0 };
  flatWorld[30] = { x: 0.1, y: 2, z: 0 };
  flatWorld[32] = { x: 0.3, y: 2, z: 0 };
  const flat = jointAngles(flatWorld, visible);
  assert.ok(Math.abs(flat.rightFootInclination.value) < 0.001);

  const raisedWorld = flatWorld.map((landmark) => ({ ...landmark }));
  // MediaPipe Y grows down the image: a raised heel has a smaller Y than toe.
  raisedWorld[30].y = 1.9;
  const raised = jointAngles(raisedWorld, visible);
  assert.ok(raised.rightFootInclination.value > 20);
  assert.ok(raised.rightFootInclination.value < 35);
}

console.log("geometry half-squat tests passed");
