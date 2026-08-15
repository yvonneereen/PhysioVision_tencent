import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  GuidanceAudioStore,
  guidanceAudioHash,
  normalizeGuidanceTranscript,
} from "../guide-audio.js";

assert.equal(
  normalizeGuidanceTranscript("  Rep   four. \n"),
  "Rep four.",
);

const catalog = JSON.parse(execFileSync(
  process.execPath,
  [fileURLToPath(new URL("../scripts/export-guide-audio-catalog.mjs", import.meta.url))],
  { encoding: "utf8" },
));
const halfSquatCatalog = JSON.parse(execFileSync(
  process.execPath,
  [
    fileURLToPath(new URL("../scripts/export-guide-audio-catalog.mjs", import.meta.url)),
    "--exercise",
    "half-squats",
  ],
  { encoding: "utf8" },
));
const halfSquatPresentationPack = JSON.parse(execFileSync(
  process.execPath,
  [
    fileURLToPath(new URL("../scripts/export-guide-audio-catalog.mjs", import.meta.url)),
    "--exercise",
    "half-squats",
    "--pack",
    "half-squats-one-exercise",
  ],
  { encoding: "utf8" },
));
assert.equal(halfSquatCatalog.target_exercise, "half-squats");
assert.match(halfSquatCatalog.phrases[0], /Camera repetition counting is active/);
assert.deepEqual(
  halfSquatCatalog.phrases.slice(1, 11),
  Array.from({ length: 10 }, (_, index) => `Rep ${index + 1}.`),
  "the targeted workflow must prepare all half-squat counts before unrelated audio",
);
assert.ok(
  halfSquatCatalog.all_phrases.some(phrase => phrase.startsWith("Calf Raises.")),
  "targeting half squats must preserve every other exercise in the master catalogue",
);
assert.equal(halfSquatPresentationPack.pack, "half-squats-one-exercise");
assert.equal(
  halfSquatPresentationPack.phrases.length,
  19,
  "the presentation pack should contain ten existing clips and exactly nine missing clips",
);
assert.match(
  halfSquatPresentationPack.phrases[12],
  /^Starting position confirmed\. Camera repetition counting is active/,
);
assert.equal(
  halfSquatPresentationPack.phrases[14],
  "Rep 10. You’re done with Half Squats. Today’s exercise session is done. Would you like me to finish this exercise and start your check-in? Say yes or no.",
);
assert.equal(
  halfSquatPresentationPack.phrases.at(-1),
  "Your session summary is ready. Review tracking validity, movement execution, pain response, and recovery before continuing.",
);
const firstPreparedBatch = catalog.phrases.slice(0, 26);
for (const prompt of [
  "Before we begin, how is your pain right now? Please give me a number from zero to ten.",
  "Pain confirmed. Stay near your device.",
  "Please confirm the pain levels shown on screen. Say yes or change.",
  ...Array.from(
    { length: 11 },
    (_, level) => `I heard that your pain is ${level} out of 10. Is that correct?`,
  ),
  ...Array.from({ length: 10 }, (_, index) => `Rep ${index + 1}.`),
]) {
  assert.ok(
    firstPreparedBatch.includes(prompt),
    `the first prepared batch should contain: ${prompt}`,
  );
}

class MemoryCache {
  constructor() {
    this.responses = new Map();
  }

  key(request) {
    return typeof request === "string" ? request : request.url;
  }

  async match(request) {
    return this.responses.get(this.key(request))?.clone() ?? null;
  }

  async put(request, response) {
    this.responses.set(this.key(request), response.clone());
  }

  async keys() {
    return [...this.responses.keys()].map(url => new Request(url));
  }

  async delete(request) {
    return this.responses.delete(this.key(request));
  }
}

const namedCaches = new Map();
const cacheStorage = {
  open: async (name) => {
    if (!namedCaches.has(name)) namedCaches.set(name, new MemoryCache());
    return namedCaches.get(name);
  },
  delete: async (name) => {
    const existed = namedCaches.has(name);
    namedCaches.delete(name);
    return existed;
  },
};
const browserWindow = {
  location: { origin: "https://physiovision.example" },
  caches: cacheStorage,
  crypto: globalThis.crypto,
  atob: globalThis.atob,
  btoa: globalThis.btoa,
};

const preparedText = "Rep 4.";
const preparedHash = await guidanceAudioHash(preparedText, "en-SG", browserWindow);
assert.equal(preparedHash.length, 64);

let generatedRequests = 0;
const preparedStore = new GuidanceAudioStore(browserWindow, {
  fetchImpl: async (url) => {
    if (String(url).endsWith("manifest.json")) {
      return new Response(JSON.stringify({
        entries: { [preparedHash]: `${preparedHash}.wav` },
      }), { headers: { "Content-Type": "application/json" } });
    }
    return new Response(new Uint8Array([0, 1, 2, 3]), {
      headers: { "Content-Type": "audio/wav" },
    });
  },
  generateSpeech: async () => {
    generatedRequests += 1;
    return { audio: "CQk=", mime_type: "audio/wav" };
  },
});

const prepared = await preparedStore.getSpeech({
  text: preparedText,
  locale: "en-SG",
  allowGeneration: false,
});
assert.equal(prepared.provider, "prepared_guide_audio");
assert.equal(prepared.audio, "AAECAw==");
assert.equal(generatedRequests, 0);

const dynamicStore = new GuidanceAudioStore(browserWindow, {
  fetchImpl: async () => new Response("not found", { status: 404 }),
  generateSpeech: async ({ text, locale }) => {
    generatedRequests += 1;
    assert.equal(text, "Keep your knee comfortable.");
    assert.equal(locale, "en-SG");
    return { audio: "CQk=", mime_type: "audio/wav" };
  },
});

const generated = await dynamicStore.getSpeech({
  text: "Keep your knee comfortable.",
  locale: "en-SG",
  allowGeneration: true,
});
assert.equal(generated.audio, "CQk=");
assert.equal(generatedRequests, 1);

let fullSessionRequests = 0;
const fullSessionStore = new GuidanceAudioStore({
  ...browserWindow,
  caches: null,
}, {
  fetchImpl: async () => new Response("not found", { status: 404 }),
  generateSpeech: async () => {
    fullSessionRequests += 1;
    return { audio: "BgY=", mime_type: "audio/wav" };
  },
});
for (let repetition = 1; repetition <= 10; repetition += 1) {
  const spokenCount = await fullSessionStore.getSpeech({
    text: `Uncached session rep ${repetition}.`,
    locale: "en-SG",
    allowGeneration: true,
  });
  assert.equal(spokenCount?.provider, "live_gemini");
}
assert.equal(
  fullSessionRequests,
  10,
  "one Gemini voice must remain available for all ten unique repetition announcements",
);

const reloadedStore = new GuidanceAudioStore(browserWindow, {
  fetchImpl: async () => new Response("not found", { status: 404 }),
  generateSpeech: async () => {
    generatedRequests += 1;
    return { audio: "AQE=" };
  },
});
const cached = await reloadedStore.getSpeech({
  text: "Keep your knee comfortable.",
  locale: "en-SG",
  allowGeneration: true,
});
assert.equal(cached.provider, "device_audio_cache");
assert.equal(cached.audio, "CQk=");
assert.equal(generatedRequests, 1, "a refreshed page should reuse the device cache");

const unavailable = await dynamicStore.getSpeech({
  text: "This fixed phrase has not been generated.",
  locale: "en-SG",
  allowGeneration: false,
});
assert.equal(unavailable, null, "fixed guidance must not consume live TTS quota");

assert.equal(await dynamicStore.clearGenerated(), true);
assert.equal(namedCaches.size, 0);

let personalRequests = 0;
const personalStore = new GuidanceAudioStore(browserWindow, {
  fetchImpl: async () => new Response("not found", { status: 404 }),
  generateSpeech: async () => {
    personalRequests += 1;
    return { audio: "AgI=", mime_type: "audio/wav" };
  },
});
await personalStore.getSpeech({
  text: "A personalised answer for this session.",
  locale: "en-SG",
  allowGeneration: true,
  cacheScope: "personal",
});
const reloadedPersonalStore = new GuidanceAudioStore(browserWindow, {
  fetchImpl: async () => new Response("not found", { status: 404 }),
  generateSpeech: async () => {
    personalRequests += 1;
    return { audio: "AgI=", mime_type: "audio/wav" };
  },
});
await reloadedPersonalStore.getSpeech({
  text: "A personalised answer for this session.",
  locale: "en-SG",
  allowGeneration: true,
  cacheScope: "personal",
});
assert.equal(
  personalRequests,
  2,
  "personal Hey Guide answers must not persist between page sessions",
);

let genericRequests = 0;
const genericStore = new GuidanceAudioStore(browserWindow, {
  fetchImpl: async () => new Response("not found", { status: 404 }),
  generateSpeech: async () => {
    genericRequests += 1;
    return { audio: "BAQ=", mime_type: "audio/wav" };
  },
});
await genericStore.getSpeech({
  text: "A previously cached generic instruction.",
  allowGeneration: true,
});
await genericStore.clearPersonal();
const signedInAgainStore = new GuidanceAudioStore(browserWindow, {
  fetchImpl: async () => new Response("not found", { status: 404 }),
  generateSpeech: async () => {
    genericRequests += 1;
    return { audio: "BQU=", mime_type: "audio/wav" };
  },
});
const afterSignOut = await signedInAgainStore.getSpeech({
  text: "A previously cached generic instruction.",
  allowGeneration: false,
});
assert.equal(afterSignOut?.provider, "device_audio_cache");
assert.equal(genericRequests, 1, "sign-out must preserve generic guidance audio");

let sharedRequests = 0;
let releaseSharedRequest;
const sharedStore = new GuidanceAudioStore({
  ...browserWindow,
  caches: null,
}, {
  fetchImpl: async () => new Response("not found", { status: 404 }),
  generateSpeech: async () => {
    sharedRequests += 1;
    return new Promise((resolve) => {
      releaseSharedRequest = () => resolve({ audio: "AwM=", mime_type: "audio/wav" });
    });
  },
});
const sharedOne = sharedStore.getSpeech({
  text: "This answer was requested twice.",
  allowGeneration: true,
  cacheScope: "personal",
});
const sharedTwo = sharedStore.getSpeech({
  text: "This answer was requested twice.",
  allowGeneration: true,
  cacheScope: "personal",
});
while (!releaseSharedRequest) {
  await new Promise(resolve => setTimeout(resolve, 0));
}
assert.equal(sharedRequests, 1, "simultaneous identical speech must share one request");
releaseSharedRequest();
await Promise.all([sharedOne, sharedTwo]);

let limitedGenerationRequests = 0;
const limitedStore = new GuidanceAudioStore({
  ...browserWindow,
  caches: null,
}, {
  fetchImpl: async () => new Response("not found", { status: 404 }),
  generateSpeech: async () => {
    limitedGenerationRequests += 1;
    return { audio: "AQ==", mime_type: "audio/wav" };
  },
});
for (let number = 1; number <= 65; number += 1) {
  await limitedStore.getSpeech({
    text: `Uncached live answer ${number}`,
    locale: "en-SG",
    allowGeneration: true,
  });
}
assert.equal(
  limitedGenerationRequests,
  64,
  "one page session must not generate unlimited live voice requests",
);

const preparedTimeoutStore = new GuidanceAudioStore({
  ...browserWindow,
  caches: null,
}, {
  fetchImpl: async () => new Promise(() => {}),
  generateSpeech: async () => ({ audio: "AQ==" }),
  preparedFetchTimeoutMs: 5,
});
const preparedTimeoutStarted = Date.now();
assert.equal(await preparedTimeoutStore.getSpeech({
  text: "A prepared prompt must not freeze the interface.",
  locale: "en-SG",
  allowGeneration: false,
}), null);
assert.ok(
  Date.now() - preparedTimeoutStarted < 100,
  "a stalled prepared-audio request should release the interface quickly",
);

let timedOutGenerationRequests = 0;
const generationTimeoutStore = new GuidanceAudioStore({
  ...browserWindow,
  caches: null,
}, {
  fetchImpl: async () => new Response("not found", { status: 404 }),
  generateSpeech: async () => {
    timedOutGenerationRequests += 1;
    return new Promise(() => {});
  },
  generatedSpeechTimeoutMs: 5,
});
const generationTimeoutStarted = Date.now();
assert.equal(await generationTimeoutStore.getSpeech({
  text: "A live answer must not freeze the interface.",
  locale: "en-SG",
  allowGeneration: true,
}), null);
assert.equal(timedOutGenerationRequests, 1);
assert.ok(
  Date.now() - generationTimeoutStarted < 100,
  "a stalled live TTS request should stop blocking after its deadline",
);

console.log("guide audio tests passed");
