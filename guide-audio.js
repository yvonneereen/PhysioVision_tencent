import { generateGuidanceSpeech } from "./api.js?v=36";

const PREPARED_AUDIO_ROOT = "/assets/audio/movement-guide";
const GENERATED_AUDIO_CACHE = "physiovision-generated-guide-audio-v1";
const GENERATED_AUDIO_CACHE_LIMIT = 96;
const GENERATED_AUDIO_SESSION_LIMIT = 8;

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
    } = {},
  ) {
    this.window = browserWindow;
    this.fetch = fetchImpl;
    this.generateSpeech = generateSpeech;
    this.manifestPromises = new Map();
    this.generatedThisSession = 0;
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
          const response = await this.fetch(this.manifestUrl(speechLocale), {
            cache: "force-cache",
            headers: { Accept: "application/json" },
          });
          if (!response.ok) return { entries: {} };
          const manifest = await response.json();
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
      const response = await this.fetch(audioUrl, { cache: "force-cache" });
      if (!response.ok) return null;
      const audio = bytesToBase64(
        new Uint8Array(await response.arrayBuffer()),
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
      return await this.window?.caches?.open(GENERATED_AUDIO_CACHE);
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

  async getSpeech({ text, locale = "en-SG", allowGeneration = true } = {}) {
    const transcript = normalizeGuidanceTranscript(text);
    if (!transcript) return null;
    const speechLocale = normalizedLocale(locale);
    const hash = await guidanceAudioHash(transcript, speechLocale, this.window);

    const prepared = await this.preparedSpeech(transcript, speechLocale, hash);
    if (prepared) return prepared;

    const cached = await this.cachedGeneratedSpeech(speechLocale, hash);
    if (cached) return cached;

    if (
      !allowGeneration
      || typeof this.generateSpeech !== "function"
      || this.generatedThisSession >= GENERATED_AUDIO_SESSION_LIMIT
    ) {
      return null;
    }
    this.generatedThisSession += 1;
    const generated = await this.generateSpeech({
      text: transcript,
      locale: speechLocale,
    });
    await this.saveGeneratedSpeech(speechLocale, hash, generated);
    return generated;
  }

  async clearGenerated() {
    try {
      return await this.window?.caches?.delete(GENERATED_AUDIO_CACHE) ?? false;
    } catch (_) {
      return false;
    }
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
