import assert from "node:assert/strict";

import {
  browserSpeechWatchdogMs,
  describeMicrophoneAccessFailure,
  isMovementRestRequest,
  isSafariBrowser,
  parseConfirmationResponse,
  parseEarlyStopReason,
  parsePainLevel,
  parsePainSafetyResponse,
  parseRecoveryStatus,
  conversationalProsody,
  normalizedNeuralSpeechGain,
  prepareGentleSpeech,
  readMicrophonePermissionState,
  requiresSingleVoiceEngine,
  selectGentleVoice,
  VoiceGuidance,
} from "../voice-guidance.js";

assert.equal(
  await readMicrophonePermissionState({
    permissions: { query: async () => ({ state: "denied" }) },
  }),
  "denied"
);
assert.equal(
  isSafariBrowser("Mozilla/5.0 Version/18.0 Safari/605.1.15"),
  true
);
assert.equal(
  isSafariBrowser("Mozilla/5.0 Chrome/128.0 Safari/537.36"),
  false
);
assert.equal(
  requiresSingleVoiceEngine("Mozilla/5.0 Version/18.3 Safari/605.1.15"),
  true,
  "Safari should keep one speech engine to prevent volume changes"
);
assert.equal(
  requiresSingleVoiceEngine("Mozilla/5.0 (iPhone) CriOS/140.0 Mobile/15E148 Safari/604.1"),
  true,
  "all iOS browsers should keep one WebKit speech output path"
);
assert.equal(
  requiresSingleVoiceEngine("Mozilla/5.0 Chrome/140.0 Safari/537.36"),
  false
);
assert.equal(
  await readMicrophonePermissionState({
    permissions: { query: async () => { throw new TypeError("unsupported"); } },
  }),
  "unknown",
  "Safari without microphone Permissions API support should remain usable"
);
assert.match(
  describeMicrophoneAccessFailure(
    { name: "NotAllowedError" },
    { userAgent: "Mozilla/5.0 Version/18.0 Safari/605.1.15" }
  ),
  /Safari > Settings > Websites > Microphone/,
  "Safari denial should explain why no prompt appeared and how to recover"
);
assert.match(
  describeMicrophoneAccessFailure(
    { name: "NotAllowedError" },
    { userAgent: "Mozilla/5.0 Chrome/128.0 Safari/537.36" }
  ),
  /browser settings/,
  "non-Safari denial should use browser-neutral recovery guidance"
);
assert.match(
  describeMicrophoneAccessFailure({ name: "NotFoundError" }),
  /No microphone was found/,
  "a missing input device should not be misreported as permission denial"
);
assert.match(
  describeMicrophoneAccessFailure(
    { name: "InvalidStateError" },
    {
      userAgent: "Mozilla/5.0 Version/18.0 Safari/605.1.15",
      permissionState: "unknown",
    }
  ),
  /can remain set to Ask/,
  "Safari failures without a denial signal should preserve the normal Ask flow"
);

assert.equal(parsePainLevel("My pain is 7 out of 10"), 7);
assert.equal(parsePainLevel("I would say ten"), 10);
assert.equal(parsePainLevel("pain level four"), 4);
assert.equal(parsePainLevel("I feel fine"), null);
assert.equal(parsePainLevel("17"), null);
assert.equal(parsePainLevel("我的疼痛是七分"), 7);
assert.equal(parsePainLevel("tahap sakit saya lapan"), 8);
assert.equal(parsePainLevel("என் வலி ஏழு"), 7);

assert.equal(parseRecoveryStatus("I feel better this week"), "better");
assert.equal(parseRecoveryStatus("About the same"), "same");
assert.equal(parseRecoveryStatus("It feels worse today"), "worse");
assert.equal(parseRecoveryStatus("I am not sure"), "unsure");
assert.equal(parseRecoveryStatus("fine"), null);
assert.equal(parseRecoveryStatus("越来越好"), "better");
assert.equal(parseRecoveryStatus("semakin teruk"), "worse");
assert.equal(parseRecoveryStatus("மாற்றமில்லை"), "same");

assert.equal(parseConfirmationResponse("Yes, that is correct"), "confirm");
assert.equal(parseConfirmationResponse("Continue"), "confirm");
assert.equal(parseConfirmationResponse("No, change my answer"), "change");
assert.equal(parseConfirmationResponse("That is wrong"), "change");
assert.equal(parseConfirmationResponse("maybe"), null);
assert.equal(parseConfirmationResponse("是的，正确"), "confirm");
assert.equal(parseConfirmationResponse("Ya, betul"), "confirm");
assert.equal(parseConfirmationResponse("இல்லை, மாற்று"), "change");

assert.equal(isMovementRestRequest("I need a rest"), true);
assert.equal(isMovementRestRequest("Can I take a break please?"), true);
assert.equal(isMovementRestRequest("Pause the camera guide"), true);
assert.equal(isMovementRestRequest("我需要休息"), true);
assert.equal(isMovementRestRequest("Saya perlu rehat"), true);
assert.equal(isMovementRestRequest("எனக்கு ஓய்வு வேண்டும்"), true);
assert.equal(
  isMovementRestRequest("How long should I rest between exercises?"),
  false,
  "a question about rest should still go to the AI instead of pausing"
);

assert.equal(parseEarlyStopReason("I stopped because of pain"), "pain");
assert.equal(parseEarlyStopReason("I feel very tired"), "tired");
assert.equal(parseEarlyStopReason("I am dizzy and lightheaded"), "dizzy");
assert.equal(parseEarlyStopReason("I am short of breath"), "breathless");
assert.equal(
  parseEarlyStopReason("The exercise is too difficult"),
  "exercise_difficulty",
);
assert.equal(parseEarlyStopReason("I prefer not to say"), "skipped");
assert.equal(parseEarlyStopReason("I need some water"), "");

assert.equal(parsePainSafetyResponse("urgent", "No symptoms"), "no");
assert.equal(parsePainSafetyResponse("urgent", "None"), "no");
assert.equal(parsePainSafetyResponse("urgent", "I am not sure"), "unsure");
assert.equal(parsePainSafetyResponse("urgent", "I feel numb"), "yes");
assert.equal(
  parsePainSafetyResponse("urgent", "I don't have any of those"),
  "no"
);
assert.equal(parsePainSafetyResponse("urgent", "not really"), "");
assert.equal(parsePainSafetyResponse("urgent", "没有以上情况"), "no");
assert.equal(parsePainSafetyResponse("urgent", "Ya"), "yes");
assert.equal(parsePainSafetyResponse("urgent", "உறுதியாக தெரியவில்லை"), "unsure");
assert.equal(
  parsePainSafetyResponse("urgent-chest", "I have chest tightness"),
  "yes"
);
assert.equal(
  parsePainSafetyResponse("urgent-chest", "I don't have chest pressure"),
  "no"
);
assert.equal(
  parsePainSafetyResponse("urgent-breathing", "It is hard to breathe"),
  "yes"
);
assert.equal(
  parsePainSafetyResponse("urgent-neurologic", "My arm feels numb"),
  "yes"
);
assert.equal(
  parsePainSafetyResponse("urgent-fall", "I fell during the exercise"),
  "yes"
);
assert.equal(
  parsePainSafetyResponse("urgent-fall", "No, I did not fall"),
  "no"
);
assert.equal(parsePainSafetyResponse("location", "My right knee"), "knee");
assert.equal(parsePainSafetyResponse("location", "我的膝盖"), "knee");
assert.equal(parsePainSafetyResponse("location", "sakit di buku lali"), "ankle");
assert.equal(parsePainSafetyResponse("location", "முதுகு வலி"), "back");
assert.equal(parsePainSafetyResponse("side", "Both sides"), "both");
assert.equal(
  parsePainSafetyResponse("familiarity", "My usual pain is stronger"),
  "usual-stronger"
);
assert.equal(
  parsePainSafetyResponse("timing", "It started during this exercise"),
  "during"
);
assert.equal(parsePainSafetyResponse("rest", "It is getting worse"), "worse");
assert.equal(
  parsePainSafetyResponse("mobility", "I need someone nearby"),
  "nearby"
);
assert.equal(
  parsePainSafetyResponse("mobility", "It is too painful to stand"),
  "help"
);
assert.equal(
  parsePainSafetyResponse("mobility", "我不能站，需要帮助"),
  "help"
);

const noveltyVoice = {
  name: "Zarvox",
  lang: "en-US",
  default: true,
  localService: true,
};
const grandpaVoice = {
  name: "Grandpa (English (US))",
  lang: "en-US",
  default: true,
  localService: true,
};
const standardVoice = {
  name: "Standard English",
  lang: "en-US",
  default: false,
  localService: true,
};
const gentleVoice = {
  name: "Samantha (Enhanced)",
  lang: "en-US",
  default: false,
  localService: true,
};
assert.equal(
  selectGentleVoice([
    noveltyVoice,
    grandpaVoice,
    standardVoice,
    gentleVoice,
  ]),
  gentleVoice
);
assert.equal(
  prepareGentleSpeech("Set one complete — please rest; begin when ready."),
  "Set one complete, please rest; begin when ready."
);
assert.deepEqual(
  conversationalProsody("How is your pain right now?"),
  { rate: 0.98, pitch: 1.04 }
);
assert.deepEqual(
  conversationalProsody("Stop exercising and call 995 now."),
  { rate: 0.95, pitch: 1.02 }
);
assert.ok(
  browserSpeechWatchdogMs("Rep ten. Your exercise is complete.", 1) >= 5000,
  "browser speech recovery should allow a normal short sentence to finish",
);
assert.equal(
  browserSpeechWatchdogMs(Array(200).fill("guidance").join(" "), 0.5),
  30000,
  "browser speech recovery should remain bounded even for unusually long text",
);
assert.ok(
  Math.abs(normalizedNeuralSpeechGain({
    numberOfChannels: 1,
    getChannelData: () => new Float32Array([0.1, -0.1, 0.1, -0.1]),
  }) - 1.6) < 0.001,
  "quiet generated speech should be raised to the shared target level"
);

class MockUtterance {
  constructor(text) {
    this.text = text;
    this.listeners = {};
  }

  addEventListener(event, callback) {
    this.listeners[event] = callback;
  }
}

const spoken = [];
const mockWindow = {
  document: { documentElement: { lang: "en-US" } },
  localStorage: {
    getItem: () => null,
    setItem: () => {},
  },
  SpeechSynthesisUtterance: MockUtterance,
  speechSynthesis: {
    speaking: false,
    getVoices: () => [standardVoice, gentleVoice],
    addEventListener: () => {},
    speak: (utterance) => spoken.push(utterance),
    cancel: () => {},
  },
};
const guidance = new VoiceGuidance(mockWindow);
assert.equal(guidance.speak("You are ready — take your time."), true);
assert.equal(spoken[0].voice, gentleVoice);
assert.equal(spoken[0].text, "You are ready, take your time.");
assert.equal(spoken[0].rate, 1);
assert.equal(spoken[0].pitch, 1.04);
assert.equal(spoken[0].volume, 1);

guidance.speak("How is your pain right now?", {
  key: "conversational-question",
  interrupt: true,
});
assert.equal(spoken[1].rate, 0.98);
assert.equal(spoken[1].pitch, 1.04);

guidance.speak("Custom pace", {
  key: "custom-prosody",
  interrupt: true,
  rate: 1.05,
  pitch: 0.95,
});
assert.equal(spoken[2].rate, 1.05);
assert.equal(spoken[2].pitch, 0.95);

guidance.speak("Before we begin, how is your pain right now?", {
  key: "pain-question",
  interrupt: true,
  preferImmediate: true,
  voiceGroup: "pain-checkin",
  rate: 0.98,
  pitch: 1.04,
});
const painQuestionUtterance = spoken[3];
guidance.preferredVoice = standardVoice;
guidance.speak("I heard that your pain is seven out of ten. Is that correct?", {
  key: "pain-confirmation",
  interrupt: true,
  preferImmediate: true,
  voiceGroup: "pain-checkin",
  rate: 0.98,
  pitch: 1.04,
});
const painConfirmationUtterance = spoken[4];
assert.equal(
  painConfirmationUtterance.voice,
  painQuestionUtterance.voice,
  "pain confirmation must keep the exact voice used for the first question"
);
assert.equal(painConfirmationUtterance.rate, painQuestionUtterance.rate);
assert.equal(painConfirmationUtterance.pitch, painQuestionUtterance.pitch);

let browserCompletionCount = 0;
guidance.speak("Continue after speech", {
  key: "browser-completion-fallback",
  interrupt: true,
  preferImmediate: true,
  onEnd: () => { browserCompletionCount += 1; },
});
const completionUtterance = spoken.at(-1);
completionUtterance.listeners.error?.();
completionUtterance.listeners.end?.();
assert.equal(
  browserCompletionCount,
  1,
  "a browser speech error should release the guided flow exactly once"
);

let stalledSpeechWatchdog = null;
let stalledSpeechWatchdogDelay = null;
let stalledSpeechCancelCount = 0;
let stalledSpeechCompletionCount = 0;
const stalledSpeech = [];
const stalledSpeechGuidance = new VoiceGuidance({
  ...mockWindow,
  setTimeout: (callback, delay) => {
    stalledSpeechWatchdog = callback;
    stalledSpeechWatchdogDelay = delay;
    return 91;
  },
  clearTimeout: () => {},
  speechSynthesis: {
    ...mockWindow.speechSynthesis,
    speak: (utterance) => stalledSpeech.push(utterance),
    cancel: () => { stalledSpeechCancelCount += 1; },
  },
});
stalledSpeechGuidance.speak(
  "Your movement cue has finished and Hey Guide can listen again.",
  { onEnd: () => { stalledSpeechCompletionCount += 1; } },
);
assert.equal(stalledSpeech.length, 1);
assert.equal(typeof stalledSpeechWatchdog, "function");
assert.equal(
  stalledSpeechWatchdogDelay,
  browserSpeechWatchdogMs(stalledSpeech[0].text, stalledSpeech[0].rate),
);
stalledSpeechWatchdog();
assert.equal(
  stalledSpeechCancelCount,
  1,
  "a Safari utterance with no end event should be cancelled after its bounded recovery time",
);
assert.equal(
  stalledSpeechCompletionCount,
  1,
  "a missing Safari end event should still release the guided flow",
);
stalledSpeech[0].listeners.end?.();
assert.equal(
  stalledSpeechCompletionCount,
  1,
  "a late Safari end event must not release the guided flow twice",
);

let delayedVoiceList = [];
let delayedVoicesChanged = null;
const delayedSpoken = [];
const delayedVoiceWindow = {
  ...mockWindow,
  speechSynthesis: {
    speaking: false,
    getVoices: () => delayedVoiceList,
    addEventListener: (event, callback) => {
      if (event === "voiceschanged") delayedVoicesChanged = callback;
    },
    speak: (utterance) => delayedSpoken.push(utterance),
    cancel: () => {},
  },
};
const preparedGuidance = new VoiceGuidance(delayedVoiceWindow);
globalThis.setTimeout(() => {
  delayedVoiceList = [gentleVoice];
}, 10);
assert.equal(
  await preparedGuidance.preparePreferredVoice({ timeoutMs: 100, pollMs: 5 }),
  gentleVoice
);
preparedGuidance.speak("First prompt", { interrupt: true });
assert.equal(delayedSpoken[0].voice, gentleVoice);
assert.equal(delayedSpoken[0].volume, 1);
delayedVoiceList = [standardVoice];
delayedVoicesChanged?.();
preparedGuidance.speak("Second prompt", { interrupt: true });
assert.equal(delayedSpoken[1].voice, gentleVoice);
assert.equal(delayedSpoken[1].volume, 1);

let microphoneReleaseDelay = null;
const safariAudioSession = { type: "play-and-record" };
const settlingWindow = {
  ...mockWindow,
  navigator: { audioSession: safariAudioSession },
  setTimeout: (callback, delay) => {
    microphoneReleaseDelay = delay;
    // Model Safari switching back to microphone mode while recognition ends.
    safariAudioSession.type = "play-and-record";
    callback();
    return 1;
  },
};
const settlingGuidance = new VoiceGuidance(settlingWindow);
assert.equal(
  await settlingGuidance.prepareSpeechAfterMicrophoneRelease(),
  gentleVoice
);
assert.equal(
  microphoneReleaseDelay,
  2000,
  "the first prompt should wait until Safari's speaker level stabilizes after microphone release"
);
assert.equal(
  safariAudioSession.type,
  "playback",
  "spoken guidance should restore Safari's full-volume playback audio mode"
);
safariAudioSession.type = "play-and-record";
settlingGuidance.speak("Please give me a number from zero to ten.", {
  interrupt: true,
});
assert.equal(
  safariAudioSession.type,
  "playback",
  "every prompt should restore playback mode after Safari microphone use"
);

const rateSelections = [];
const rateControl = {
  value: "",
  addEventListener: (event, callback) => {
    if (event === "change") rateSelections.push(callback);
  },
};
const slowerSpoken = [];
const rateGuidance = new VoiceGuidance({
  ...mockWindow,
  speechSynthesis: {
    ...mockWindow.speechSynthesis,
    speak: (utterance) => slowerSpoken.push(utterance),
  },
});
rateGuidance.attachRateControl(rateControl);
assert.equal(rateControl.value, "normal");
rateControl.value = "slower";
rateSelections[0]();
rateGuidance.speak("Use the selected guide speed.", {
  rate: 1,
  interrupt: true,
});
assert.equal(
  slowerSpoken[0].rate,
  0.86,
  "the user-selected slower pace should apply to spoken guidance"
);

const neuralSources = [];
const neuralGains = [];
const neuralCompressors = [];
class MockAudioContext {
  constructor() {
    this.state = "suspended";
    this.destination = {};
  }

  resume() {
    this.state = "running";
    return Promise.resolve();
  }

  createBuffer() {
    return {};
  }

  createBufferSource() {
    const source = {
      listeners: {},
      connect: () => {},
      start: () => { source.started = true; },
      stop: () => {},
      addEventListener: (event, callback) => {
        source.listeners[event] = callback;
      },
    };
    neuralSources.push(source);
    return source;
  }

  createGain() {
    const gain = { gain: { value: 0 }, connect: (target) => { gain.target = target; } };
    neuralGains.push(gain);
    return gain;
  }

  createDynamicsCompressor() {
    const compressor = {
      threshold: { value: 0 },
      knee: { value: 0 },
      ratio: { value: 0 },
      attack: { value: 0 },
      release: { value: 0 },
      connect: (target) => { compressor.target = target; },
    };
    neuralCompressors.push(compressor);
    return compressor;
  }

  decodeAudioData() {
    return Promise.resolve({
      decoded: true,
      numberOfChannels: 1,
      getChannelData: () => new Float32Array([0.1, -0.1, 0.1, -0.1]),
    });
  }
}

const neuralWindow = {
  ...mockWindow,
  AudioContext: MockAudioContext,
};
const neuralGuidance = new VoiceGuidance(neuralWindow);
let neuralRequest = null;
let neuralEnded = false;
neuralGuidance.setNeuralSpeechProvider(async (request) => {
  neuralRequest = request;
  return { audio: "AA==", mime_type: "audio/wav" };
});
assert.equal(await neuralGuidance.unlockNeuralAudio(), true);
assert.equal(
  neuralGuidance.speak("Before we begin, how is your pain right now?", {
    onEnd: () => { neuralEnded = true; },
  }),
  true
);
await new Promise((resolve) => setTimeout(resolve, 0));
assert.deepEqual(neuralRequest, {
  text: "Before we begin, how is your pain right now?",
  locale: "en-SG",
});
assert.equal(neuralSources[1].started, true);
assert.ok(
  Math.abs(neuralGains[0].gain.value - 1.6) < 0.001,
  "generated guidance should be normalized before playback"
);
assert.equal(neuralCompressors[0].ratio.value, 6);
assert.equal(neuralGains[0].target, neuralCompressors[0]);
neuralSources[1].listeners.ended();
assert.equal(neuralEnded, true);

const safariSpokenBefore = spoken.length;
let safariNeuralRequests = 0;
const safariOutputGuidance = new VoiceGuidance({
  ...neuralWindow,
  navigator: {
    userAgent: "Mozilla/5.0 Version/18.3 Safari/605.1.15",
  },
});
safariOutputGuidance.setNeuralSpeechProvider(async () => {
  safariNeuralRequests += 1;
  return { audio: "AA==" };
});
safariOutputGuidance.speak(
  "This longer guidance sentence must stay on one steady Safari output path.",
  { interrupt: true }
);
await Promise.resolve();
assert.equal(safariNeuralRequests, 0);
assert.equal(spoken.length, safariSpokenBefore + 1);
assert.equal(spoken.at(-1).volume, 1);
assert.equal(
  spoken.at(-1).text,
  "This longer guidance sentence must stay on one steady Safari output path.",
  "Safari speech should begin directly with the guidance and no spoken pre-roll"
);

const safariWarmupStart = spoken.length;
await safariOutputGuidance.prepareSpeechAfterMicrophoneRelease({ settleMs: 0 });
safariOutputGuidance.speak(
  "The first audible word should already be at full volume.",
  { interrupt: true }
);
assert.equal(spoken.length, safariWarmupStart + 1);
const mutedWarmup = spoken.at(-1);
assert.equal(mutedWarmup.text, "Audio playback is ready.");
assert.equal(mutedWarmup.volume, 0);
mutedWarmup.listeners.end?.();
assert.equal(spoken.length, safariWarmupStart + 2);
assert.equal(
  spoken.at(-1).text,
  "The first audible word should already be at full volume."
);
assert.equal(spoken.at(-1).volume, 1);

neuralRequest = null;
const spokenBeforeImmediatePrompt = spoken.length;
assert.equal(
  neuralGuidance.speak("Please tell me your pain level from zero to ten.", {
    interrupt: true,
    preferImmediate: true,
  }),
  true
);
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(
  neuralRequest,
  null,
  "an immediate safety prompt must not wait for the neural speech service"
);
assert.equal(
  spoken.length,
  spokenBeforeImmediatePrompt + 1,
  "an immediate safety prompt should use the ready browser voice"
);

let activeRecognitionInstance = null;
const recognitionInstances = [];
class MockRecognition {
  constructor() {
    this.listeners = {};
    this.stopCalled = false;
    this.abortCalled = false;
    activeRecognitionInstance = this;
    recognitionInstances.push(this);
  }

  addEventListener(event, callback) {
    this.listeners[event] = callback;
  }

  start() {
    this.listeners.start?.();
  }

  stop() {
    this.stopCalled = true;
    this.listeners.end?.();
  }

  abort() {
    this.abortCalled = true;
  }

  emitResult(transcript) {
    this.listeners.result?.({
      results: [[{ transcript }]],
    });
  }

  emitAudioStart() {
    this.listeners.audiostart?.();
  }

  emitAudioEnd() {
    this.listeners.audioend?.();
  }

  emitInterimResult(transcript) {
    const result = [{ transcript }];
    result.isFinal = false;
    this.listeners.result?.({ results: [result] });
  }

  emitError(error) {
    this.listeners.error?.({ error });
  }
}

const listeningWindow = {
  ...mockWindow,
  navigator: { language: "en-SG" },
  SpeechRecognition: MockRecognition,
};
const listeningGuidance = new VoiceGuidance(listeningWindow);
const microphoneCheck = listeningGuidance.verifyListeningAccess({
  timeoutMs: 50,
});
const microphoneCheckRecognition = activeRecognitionInstance;
let microphoneCheckResolved = false;
microphoneCheck.then(() => { microphoneCheckResolved = true; });
microphoneCheckRecognition.emitAudioStart();
assert.equal(
  microphoneCheckRecognition.abortCalled,
  true,
  "the Safari readiness check should release the microphone immediately"
);
await Promise.resolve();
assert.equal(
  microphoneCheckResolved,
  false,
  "the first prompt must wait until Safari confirms microphone audio has ended"
);
microphoneCheckRecognition.emitAudioEnd();
assert.equal(await microphoneCheck, true);

const deniedMicrophoneCheck = listeningGuidance.verifyListeningAccess({
  timeoutMs: 50,
});
activeRecognitionInstance.emitError("not-allowed");
await assert.rejects(
  deniedMicrophoneCheck,
  { name: "NotAllowedError" },
  "a rejected Safari prompt should remain a real permission failure"
);

let deliveredTranscript = "";
let recognitionAtDelivery = undefined;
assert.equal(
  listeningGuidance.listen({
    onResult: (transcript) => {
      deliveredTranscript = transcript;
      recognitionAtDelivery = listeningGuidance.activeRecognition;
      listeningGuidance.speak("Where are you feeling the pain?", {
        interrupt: true,
      });
    },
  }),
  true
);
assert.equal(activeRecognitionInstance.interimResults, true);
assert.equal(activeRecognitionInstance.maxAlternatives, 3);
assert.equal(activeRecognitionInstance.lang, "en-SG");
activeRecognitionInstance.emitResult("None");
assert.equal(activeRecognitionInstance.stopCalled, true);
assert.equal(deliveredTranscript, "None");
assert.equal(recognitionAtDelivery, null);
assert.equal(spoken.at(-1).text, "Where are you feeling the pain?");

const safariListeningDelays = [];
const safariListeningTimers = new Map();
let safariListeningTimerId = 0;
const safariListeningSession = { type: "play-and-record" };
const safariListeningGuidance = new VoiceGuidance({
  ...listeningWindow,
  navigator: {
    ...listeningWindow.navigator,
    userAgent: "Mozilla/5.0 Version/18.3 Safari/605.1.15",
    audioSession: safariListeningSession,
  },
  setTimeout: (callback, delay) => {
    safariListeningDelays.push(delay);
    safariListeningTimerId += 1;
    if (delay === 1800) {
      safariListeningTimers.set(safariListeningTimerId, callback);
    } else {
      callback();
    }
    return safariListeningTimerId;
  },
  clearTimeout: (timerId) => safariListeningTimers.delete(timerId),
});
let safariDeliveredTranscript = "";
safariListeningGuidance.listen({
  onResult: (transcript) => {
    safariDeliveredTranscript = transcript;
  },
});
activeRecognitionInstance.emitResult("five");
assert.equal(
  activeRecognitionInstance.abortCalled,
  true,
  "Safari should abort recognition after capturing the final answer so the microphone releases promptly"
);
assert.equal(
  safariDeliveredTranscript,
  "",
  "Safari should not deliver a result while its output can still be ducked"
);
activeRecognitionInstance.emitAudioEnd();
await new Promise((resolve) => globalThis.setTimeout(resolve, 0));
await Promise.resolve();
assert.equal(safariDeliveredTranscript, "five");
assert.equal(safariListeningSession.type, "playback");
assert.ok(safariListeningDelays.includes(1800));
assert.ok(safariListeningDelays.includes(2000));
assert.equal(
  safariListeningTimers.size,
  0,
  "the release timeout should be cancelled when Safari emits audioend"
);

let interimTranscript = "";
listeningGuidance.listen({
  onResult: (transcript) => {
    interimTranscript = transcript;
  },
});
activeRecognitionInstance.emitInterimResult("seven");
assert.equal(interimTranscript, "");
activeRecognitionInstance.listeners.end?.();
assert.equal(interimTranscript, "seven");

let fastInterimTranscript = "";
listeningGuidance.listen({
  interimSilenceMs: 1,
  onResult: (transcript) => {
    fastInterimTranscript = transcript;
  },
});
activeRecognitionInstance.emitInterimResult("hey guide how many repetitions");
await new Promise((resolve) => globalThis.setTimeout(resolve, 10));
assert.equal(
  fastInterimTranscript,
  "hey guide how many repetitions",
  "a completed interim phrase should be delivered promptly after brief silence"
);

const retryStatuses = [];
let retryError = "";
let retryTranscript = "";
const instancesBeforeRetry = recognitionInstances.length;
listeningGuidance.listen({
  retryDelayMs: 0,
  onStatus: (status) => retryStatuses.push(status),
  onError: (message) => {
    retryError = message;
  },
  onResult: (transcript) => {
    retryTranscript = transcript;
  },
});
const firstRetryAttempt = activeRecognitionInstance;
firstRetryAttempt.emitError("no-speech");
await new Promise((resolve) => globalThis.setTimeout(resolve, 5));
assert.equal(recognitionInstances.length, instancesBeforeRetry + 2);
assert.match(retryStatuses.join(" "), /Listening again/i);
assert.equal(retryError, "");
activeRecognitionInstance.emitResult("four");
assert.equal(retryTranscript, "four");

let terminalListeningErrorCode = "";
listeningGuidance.listen({
  maxNoSpeechRetries: 0,
  onError: (_message, errorCode) => {
    terminalListeningErrorCode = errorCode;
  },
});
activeRecognitionInstance.emitError("no-speech");
assert.equal(
  terminalListeningErrorCode,
  "no-speech",
  "continuous command listeners should be able to distinguish an idle timeout"
);

listeningGuidance.listen();
const recognitionBeforeListeningCancel = activeRecognitionInstance;
listeningGuidance.cancelListening();
assert.equal(
  recognitionBeforeListeningCancel.abortCalled,
  true,
  "coaching audio should be able to release the microphone without cancelling speech output"
);

const pageLifecycleListeners = {};
const lifecycleGuidance = new VoiceGuidance({
  ...listeningWindow,
  addEventListener: (event, callback) => {
    pageLifecycleListeners[event] = callback;
  },
});
lifecycleGuidance.listen();
const recognitionBeforeRefresh = activeRecognitionInstance;
pageLifecycleListeners.pagehide();
assert.equal(
  recognitionBeforeRefresh.abortCalled,
  true,
  "refreshing should explicitly release the active speech-recognition microphone"
);

console.log("voice-guidance tests passed");
