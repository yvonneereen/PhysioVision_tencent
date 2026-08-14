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

const cache = new MemoryCache();
const cacheStorage = {
  open: async () => cache,
  delete: async () => {
    cache.responses.clear();
    return true;
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
assert.equal(cache.responses.size, 0);

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
for (let number = 1; number <= 9; number += 1) {
  await limitedStore.getSpeech({
    text: `Uncached live answer ${number}`,
    locale: "en-SG",
    allowGeneration: true,
  });
}
assert.equal(
  limitedGenerationRequests,
  8,
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
