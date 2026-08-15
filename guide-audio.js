import { generateGuidanceSpeech } from "./api.js?v=36";

const PREPARED_AUDIO_ROOT = "/assets/audio/movement-guide";
const GENERATED_GENERIC_AUDIO_CACHE =
  "physiovision-generated-guide-audio-generic-v2";
const LEGACY_GENERATED_AUDIO_CACHE = "physiovision-generated-guide-audio-v1";
const GENERATED_AUDIO_CACHE_LIMIT = 96;
// The backend remains the authoritative hourly throttle. This client-side cap
// only prevents runaway loops while allowing a complete exercise session,
// including ten distinct repetition announcements, to keep one Gemini voice.
const GENERATED_AUDIO_SESSION_LIMIT = 64;
const PREPARED_AUDIO_FETCH_TIMEOUT_MS = 2000;
const GENERATED_AUDIO_REQUEST_TIMEOUT_MS = 8000;

export function normalizeGuidanceTranscript(text) {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

function normalizedLocale(locale) {
  const value = String(locale || "en-SG").trim();
  return /^[a-z]{2}(?:-[A-Z]{2})?$/.test(value) ? value : "en-SG";
}

function bytesToBase64(bytes, browserWindow = globalThis) {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  const encode = browserWindow?.btoa ?? globalThis.btoa;
  return encode(binary);
}

function base64ToBytes(base64Audio, browserWindow = globalThis) {
  const decode = browserWindow?.atob ?? globalThis.atob;
  const binary = decode(base64Audio);
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

export async function guidanceAudioHash(text, locale = "en-SG", browserWindow = globalThis) {
  const transcript = normalizeGuidanceTranscript(text);
  if (!transcript) return "";
  const cryptoObject = browserWindow?.crypto ?? globalThis.crypto;
  if (!cryptoObject?.subtle) return "";
  const encoder = new TextEncoder();
  const input = encoder.encode(`${normalizedLocale(locale)}\n${transcript}`);
  const digest = await cryptoObject.subtle.digest("SHA-256", input);
  return [...new Uint8Array(digest)]
    .map(byte => byte.toString(16).padStart(2, "0"))
    .join("");
}

export class GuidanceAudioStore {
  constructor(
    browserWindow = typeof window === "undefined" ? null : window,
    {
      fetchImpl = browserWindow?.fetch?.bind(browserWindow) ?? globalThis.fetch,
      generateSpeech = generateGuidanceSpeech,
      preparedFetchTimeoutMs = PREPARED_AUDIO_FETCH_TIMEOUT_MS,
      generatedSpeechTimeoutMs = GENERATED_AUDIO_REQUEST_TIMEOUT_MS,
    } = {},
  ) {
    this.window = browserWindow;
    this.fetch = fetchImpl;
    this.generateSpeech = generateSpeech;
    this.preparedFetchTimeoutMs = preparedFetchTimeoutMs;
    this.generatedSpeechTimeoutMs = generatedSpeechTimeoutMs;
    this.manifestPromises = new Map();
    this.inFlightGenerations = new Map();
    this.generatedThisSession = 0;
  }

  settleWithin(promise, timeoutMs, fallback = null) {
    const delay = Number(timeoutMs);
    if (!Number.isFinite(delay) || delay <= 0) {
      return Promise.resolve(promise).catch(() => fallback);
    }
    const schedule = this.window?.setTimeout?.bind(this.window)
      ?? globalThis.setTimeout;
    const unschedule = this.window?.clearTimeout?.bind(this.window)
      ?? globalThis.clearTimeout;
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        unschedule(timer);
        resolve(value);
      };
      const timer = schedule(() => finish(fallback), delay);
      Promise.resolve(promise).then(finish, () => finish(fallback));
    });
  }

  origin() {
    return this.window?.location?.origin || "http://localhost";
  }

  manifestUrl(locale) {
    return new URL(
      `${PREPARED_AUDIO_ROOT}/${normalizedLocale(locale)}/manifest.json`,
      this.origin(),
    ).toString();
  }

  async loadManifest(locale = "en-SG") {
    const speechLocale = normalizedLocale(locale);
    if (!this.manifestPromises.has(speechLocale)) {
      this.manifestPromises.set(speechLocale, (async () => {
        if (typeof this.fetch !== "function") return { entries: {} };
        try {
          const response = await this.settleWithin(
            this.fetch(this.manifestUrl(speechLocale), {
              // Revalidate the small manifest after a deployment so a browser
              // that previously saw an empty library discovers new clips.
              // Hashed WAV files themselves remain safely force-cached.
              cache: "no-cache",
              headers: { Accept: "application/json" },
            }),
            this.preparedFetchTimeoutMs,
          );
          if (!response.ok) return { entries: {} };
          const manifest = await this.settleWithin(
            response.json(),
            this.preparedFetchTimeoutMs,
          );
          return manifest && typeof manifest.entries === "object"
            ? manifest
            : { entries: {} };
        } catch (_) {
          return { entries: {} };
        }
      })());
    }
    return this.manifestPromises.get(speechLocale);
  }

  async preload(locale = "en-SG") {
    await this.loadManifest(locale);
  }

  async preparedSpeech(transcript, locale, hash) {
    if (!hash || typeof this.fetch !== "function") return null;
    const manifest = await this.loadManifest(locale);
    const filename = manifest.entries?.[hash];
    if (!filename) return null;
    try {
      const audioUrl = new URL(filename, this.manifestUrl(locale)).toString();
      const response = await this.settleWithin(
        this.fetch(audioUrl, { cache: "force-cache" }),
        this.preparedFetchTimeoutMs,
      );
      if (!response.ok) return null;
      const audioBytes = await this.settleWithin(
        response.arrayBuffer(),
        this.preparedFetchTimeoutMs,
      );
      if (!audioBytes) return null;
      const audio = bytesToBase64(
        new Uint8Array(audioBytes),
        this.window,
      );
      return {
        audio,
        mime_type: response.headers.get("Content-Type") || "audio/wav",
        provider: "prepared_guide_audio",
      };
    } catch (_) {
      return null;
    }
  }

  generatedCacheUrl(locale, hash) {
    return new URL(
      `/.physiovision/generated-guide-audio/${normalizedLocale(locale)}/${hash}.wav`,
      this.origin(),
    ).toString();
  }

  async generatedCache() {
    try {
      return await this.window?.caches?.open(GENERATED_GENERIC_AUDIO_CACHE);
    } catch (_) {
      return null;
    }
  }

  async cachedGeneratedSpeech(locale, hash) {
    if (!hash) return null;
    const cache = await this.generatedCache();
    if (!cache) return null;
    try {
      const response = await cache.match(this.generatedCacheUrl(locale, hash));
      if (!response) return null;
      return {
        audio: bytesToBase64(
          new Uint8Array(await response.arrayBuffer()),
          this.window,
        ),
        mime_type: response.headers.get("Content-Type") || "audio/wav",
        provider: "device_audio_cache",
      };
    } catch (_) {
      return null;
    }
  }

  async saveGeneratedSpeech(locale, hash, speech) {
    const cache = await this.generatedCache();
    if (!cache || !hash || !speech?.audio) return;
    try {
      const body = base64ToBytes(speech.audio, this.window);
      await cache.put(
        this.generatedCacheUrl(locale, hash),
        new Response(body, {
          headers: {
            "Content-Type": speech.mime_type || "audio/wav",
            "X-PhysioVision-Cached-At": new Date().toISOString(),
          },
        }),
      );
      const keys = await cache.keys();
      const excess = keys.length - GENERATED_AUDIO_CACHE_LIMIT;
      for (let index = 0; index < excess; index += 1) {
        await cache.delete(keys[index]);
      }
    } catch (_) {
      // Private browsing and storage policies may reject Cache Storage. The
      // current answer can still play without becoming persistent.
    }
  }

  async getSpeech({
    text,
    locale = "en-SG",
    allowGeneration = true,
    cacheScope = "generic",
  } = {}) {
    const transcript = normalizeGuidanceTranscript(text);
    if (!transcript) return null;
    const speechLocale = normalizedLocale(locale);
    const speechScope = cacheScope === "personal" ? "personal" : "generic";
    const hash = await guidanceAudioHash(transcript, speechLocale, this.window);

    const prepared = await this.preparedSpeech(transcript, speechLocale, hash);
    if (prepared) return prepared;

    const cached = await this.cachedGeneratedSpeech(speechLocale, hash);
    if (cached) return cached;

    if (!allowGeneration || typeof this.generateSpeech !== "function") {
      return null;
    }

    // A repeated cue can be requested by more than one camera frame before the
    // first network response returns. Share that request so one phrase can
    // never spend two TTS requests merely because rendering is concurrent.
    const flightKey = `${speechScope}:${speechLocale}:${hash}`;
    let generation = this.inFlightGenerations.get(flightKey);
    if (!generation) {
      if (this.generatedThisSession >= GENERATED_AUDIO_SESSION_LIMIT) {
        return null;
      }
      this.generatedThisSession += 1;
      generation = Promise.resolve(this.generateSpeech({
        text: transcript,
        locale: speechLocale,
      })).then(async (generated) => {
        if (!generated?.audio) return null;
        const speech = {
          ...generated,
          provider: "live_gemini",
          cache_scope: speechScope,
        };
        // Personalised Hey Guide answers may contain patient context. They are
        // deliberately kept out of persistent Cache Storage. Deterministic
        // generic guidance can still reuse an older device-cached clip.
        if (speechScope === "generic") {
          await this.saveGeneratedSpeech(speechLocale, hash, speech);
        }
        return speech;
      }).catch(() => null).finally(() => {
        this.inFlightGenerations.delete(flightKey);
      });
      this.inFlightGenerations.set(flightKey, generation);
    }
    // Never hold the visible guidance flow indefinitely for a live TTS call.
    // A late response may still finish and populate the device cache, but it
    // will not suddenly begin speaking after the user has already moved on.
    return this.settleWithin(
      generation,
      this.generatedSpeechTimeoutMs,
    );
  }

  async clearGenerated() {
    try {
      const results = await Promise.all([
        this.window?.caches?.delete(GENERATED_GENERIC_AUDIO_CACHE),
        this.window?.caches?.delete(LEGACY_GENERATED_AUDIO_CACHE),
      ]);
      return results.some(Boolean);
    } catch (_) {
      return false;
    }
  }

  async clearPersonal() {
    // Version 1 mixed generic clips with potentially personalised replies.
    // Delete that legacy cache once, while preserving the new generic cache.
    try {
      await this.window?.caches?.delete(LEGACY_GENERATED_AUDIO_CACHE);
    } catch (_) {
      // In-memory clearing below still protects the current browser session.
    }
    this.window?.dispatchEvent?.(new CustomEvent(
      "physiovision:clear-personal-guidance-audio"
    ));
    return true;
  }
}

export const guidanceAudioStore = new GuidanceAudioStore();

export function getCachedOrGeneratedGuidanceSpeech(request) {
  return guidanceAudioStore.getSpeech(request);
}

export function preloadPreparedGuidanceSpeech(locale) {
  return guidanceAudioStore.preload(locale);
}

export function clearGeneratedGuidanceSpeechCache() {
  return guidanceAudioStore.clearGenerated();
}

export function clearPersonalGuidanceSpeechCache() {
  return guidanceAudioStore.clearPersonal();
}
