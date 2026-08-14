import { DRAFT_EXERCISES } from "../exercises/catalog.js";
import { EXERCISES } from "../exercises/registry.js";

const phrases = [];
const seen = new Set();

function gentleSpeech(text) {
  return String(text ?? "")
    .replace(/\s+[—–]\s+/g, ", ")
    .replace(/\.{3,}/g, ",")
    .replace(/\s+/g, " ")
    .trim();
}

function add(text) {
  const phrase = gentleSpeech(text);
  if (!phrase || seen.has(phrase)) return;
  seen.add(phrase);
  phrases.push(phrase);
}

// The first quota-safe batch covers the complete pre-camera exchange. These
// clips must never wait for live TTS because a patient is still beside the
// device and may need to respond to a browser permission prompt.
[
  "Before we begin, how is your pain right now? Please give me a number from zero to ten.",
  "You stopped the exercise. How is your pain now? Please give me a number from zero to ten.",
  "You’ve finished the exercise. How is your pain now? Please give me a number from zero to ten.",
  "Please confirm the pain levels shown on screen. Say yes or change.",
].forEach(add);
for (let level = 0; level <= 10; level += 1) {
  add(`I heard that your pain is ${level} out of 10. Is that correct?`);
}
add("Pain confirmed. Stay near your device.");
for (let number = 1; number <= 10; number += 1) add(`Rep ${number}.`);

[
  "I’m listening. What would you like to ask?",
  "Let me check.",
  "I did not hear a question. Movement guidance will continue.",
  "The AI guide is temporarily unavailable. Movement coaching will continue.",
  "Thirty seconds left to answer.",
  "Ten seconds left to answer.",
  "Five seconds left to answer.",
  "Camera setup cancelled. Start again when you are ready.",
  "Final repetition. Stand tall and hold still until I say the exercise is complete.",
  "Okay. I will leave the exercise open. Choose Finish exercise and check in when you are ready.",
  "Can you tell me what made you stop? Is it say pain, tired, dizzy or breathless or exercise difficulty.",
  "Your camera guide is paused for a rest. Your recognized repetitions are kept. When you are ready, say Hey Guide, continue, or select Resume camera guide.",
  "Okay. Resuming your camera guide. Your repetitions are still saved.",
].forEach(add);

for (let number = 11; number <= 50; number += 1) add(`Rep ${number}.`);
for (let level = 0; level <= 10; level += 1) {
  add(`Thank you. I have recorded your pain level as ${level} out of 10.`);
}

const reviewedContent = new Map(
  DRAFT_EXERCISES.map(exercise => [exercise.id, exercise]),
);

function exerciseInstruction(exercise) {
  const reviewed = reviewedContent.get(exercise.id);
  if (reviewed?.instruction) return `${exercise.name}. ${reviewed.instruction}`;
  const phases = String(exercise.repRule || "")
    .split("→")
    .map(stage => stage.trim().replaceAll("_", " "))
    .filter(Boolean)
    .join(", then ");
  return [
    `${exercise.name}.`,
    phases ? `Move slowly through ${phases}.` : "",
    exercise.trackingWarning || "",
  ].filter(Boolean).join(" ");
}

function startGuidance(exercise) {
  if (exercise.id === "half-squats") {
    return (
      "Keep both feet flat and keep the chair beside you. Bend both knees and hips slowly "
      + "as if sitting back toward the chair, only as far as comfortable, "
      + "then stand tall to complete one repetition."
    );
  }
  return exerciseInstruction(exercise);
}

function targetGuidance(exercise) {
  const holdSeconds = Number(exercise.prescription?.holdSeconds || 0);
  if (holdSeconds > 0 && ["stretch", "balance"].includes(exercise.category)) {
    return (
      `Your target is ${holdSeconds} seconds of tracked hold time. `
      + "I will say when the target has been counted. Keep every required joint visible until then."
    );
  }
  const repetitions = Number(exercise.prescription?.reps || 0);
  if (!repetitions) return "";
  return (
    `Your target is ${repetitions} repetitions. `
    + `I will say when all ${repetitions} have been counted. `
    + "Keep your full body visible until then."
  );
}

for (const exercise of EXERCISES) {
  const start = startGuidance(exercise);
  const target = targetGuidance(exercise);
  add(start);
  add(target);
  add(exercise.trackingWarning);
  for (const configuredCue of Object.values(exercise.cues || {})) {
    add(typeof configuredCue === "string" ? configuredCue : configuredCue?.message);
  }
  add([
    ["stretch", "balance"].includes(exercise.category)
      ? "Hold measurement starts after this instruction."
      : "Camera repetition counting is active now, including while I give this instruction.",
    start,
    target,
    "Say Hey Guide for help, or Hey Guide, I need a rest.",
  ].filter(Boolean).join(" "));
}

process.stdout.write(`${JSON.stringify({ version: 1, locale: "en-SG", phrases })}\n`);
