import {
  getSpeechLocale,
  translateText,
} from "./i18n.js?v=46";
import { getCachedOrGeneratedGuidanceSpeech } from "./guide-audio.js?v=5";

const VOICE_PREFERENCE_KEY = "physiovision.voice.enabled.v1";
const VOICE_RATE_PREFERENCE_KEY = "physiovision.voice.rate.v1";
const DEFAULT_SPEECH_VOLUME = 1;
// Safari's `audioend` fires before its speaker has always finished recovering
// from the quiet play-and-record route. The supplied recordings show the
// recovery can still fade the first word after a shorter wait, so no utterance
// may begin until this longer post-release stabilization window has elapsed.
const MICROPHONE_RELEASE_SETTLE_MS = 2000;
const MICROPHONE_RELEASE_TIMEOUT_MS = 1800;
const MUTED_BROWSER_SPEECH_WARMUP = "Audio playback is ready.";
const NEURAL_SPEECH_MIN_LENGTH = 18;
const NEURAL_SPEECH_CACHE_LIMIT = 24;
const NEURAL_TARGET_RMS = 0.16;
const NEURAL_PEAK_CEILING = 0.86;
const BROWSER_SPEECH_WATCHDOG_MIN_MS = 5000;
const BROWSER_SPEECH_WATCHDOG_MAX_MS = 30000;
const BROWSER_SPEECH_WORDS_PER_MINUTE = 165;

export const SPEECH_RATE_PRESETS = Object.freeze({
  normal: 1,
  slower: 0.86,
  slowest: 0.72,
});

const GENTLE_VOICE_NAME =
  /\b(samantha|ava|jenny|aria|sonia|allison|susan|serena|karen|moira|tessa|fiona|zoe|kathy|amira|yasmin|tingting|meijia|sinji|xiaoxiao|vani|pallavi)\b|google (us|uk) english/i;
const NATURAL_VOICE_NAME =
  /\b(natural|neural|enhanced|premium|siri|personal voice)\b/i;
const SYNTHETIC_VOICE_NAME =
  /\b(compact|eloquence|espeak|festival|robot|classic)\b/i;
const NOVELTY_VOICE_NAME =
  /\b(albert|bad news|bahh|bells|boing|bubbles|cellos|deranged|eddy|fred|good news|grandma|grandpa|jester|junior|organ|ralph|reed|rocko|superstar|trinoids|whisper|wobble|zarvox)\b/i;

// Prefer familiar, clearly articulated voices before considering a browser or
// operating-system default. A user's default can be a novelty accessibility
// voice (including Apple's Grandpa voice), which is unsuitable for calm health
// guidance. Earlier entries receive the strongest preference.
const CLEAR_VOICE_PREFERENCES = Object.freeze({
  en: Object.freeze([
    /\bsamantha\b/i,
    /\bava\b/i,
    /\bjenny\b/i,
    /\baria\b/i,
    /\bsonia\b/i,
    /\ballison\b/i,
    /\bsusan\b/i,
    /\bserena\b/i,
    /\bkaren\b/i,
    /\bmoira\b/i,
    /\btessa\b/i,
    /\bfiona\b/i,
    /google uk english female/i,
    /google us english/i,
  ]),
  zh: Object.freeze([
    /\btingting\b/i,
    /\bxiaoxiao\b/i,
    /\bmeijia\b/i,
    /\bsinji\b/i,
  ]),
  ms: Object.freeze([/\bamira\b/i, /\byasmin\b/i]),
  ta: Object.freeze([/\bvani\b/i, /\bpallavi\b/i]),
});

const NUMBER_WORDS = Object.freeze({
  zero: 0,
  oh: 0,
  one: 1,
  two: 2,
  to: 2,
  too: 2,
  three: 3,
  four: 4,
  for: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  ate: 8,
  nine: 9,
  ten: 10,
});

const LOCALIZED_NUMBER_WORDS = Object.freeze({
  "零": 0,
  "〇": 0,
  "一": 1,
  "二": 2,
  "两": 2,
  "三": 3,
  "四": 4,
  "五": 5,
  "六": 6,
  "七": 7,
  "八": 8,
  "九": 9,
  "十": 10,
  kosong: 0,
  sifar: 0,
  satu: 1,
  dua: 2,
  tiga: 3,
  empat: 4,
  lima: 5,
  enam: 6,
  tujuh: 7,
  lapan: 8,
  sembilan: 9,
  sepuluh: 10,
  "பூஜ்ஜியம்": 0,
  "சுழியம்": 0,
  "ஒன்று": 1,
  "இரண்டு": 2,
  "மூன்று": 3,
  "நான்கு": 4,
  "ஐந்து": 5,
  "ஆறு": 6,
  "ஏழு": 7,
  "எட்டு": 8,
  "ஒன்பது": 9,
  "பத்து": 10,
});

function normalizeSpeech(transcript) {
  return String(transcript ?? "")
    .trim()
    .toLowerCase()
    .replace(/[’]/g, "'")
    .replace(/[^\p{L}\p{M}\p{N}'\s]/gu, " ")
    .replace(/\s+/g, " ");
}

export function isSafariBrowser(userAgent) {
  const value = String(userAgent ?? "");
  return /safari/i.test(value)
    && !/(chrome|chromium|crios|android|edg|opr|firefox|fxios)/i.test(value);
}

export function requiresSingleVoiceEngine(userAgent) {
  const value = String(userAgent ?? "");
  // Safari changes between playback and play-and-record audio sessions when
  // speech recognition is used. Mixing SpeechSynthesis and Web Audio across
  // that transition produces an audible level jump even when both are set to
  // volume 1. Every iOS browser uses WebKit, so keep one output path there too.
  return isSafariBrowser(value)
    || /\b(iPhone|iPad|iPod)\b|Macintosh.*Mobile/i.test(value);
}

export function normalizedNeuralSpeechGain(
  audioBuffer,
  requestedVolume = DEFAULT_SPEECH_VOLUME
) {
  const volume = Math.min(
    Math.max(Number(requestedVolume) || DEFAULT_SPEECH_VOLUME, 0.2),
    1
  );
  if (
    !audioBuffer
    || !Number.isInteger(audioBuffer.numberOfChannels)
    || audioBuffer.numberOfChannels < 1
    || typeof audioBuffer.getChannelData !== "function"
  ) {
    return volume;
  }

  let peak = 0;
  let squareTotal = 0;
  let sampleCount = 0;
  for (let channel = 0; channel < audioBuffer.numberOfChannels; channel += 1) {
    const samples = audioBuffer.getChannelData(channel);
    for (let index = 0; index < samples.length; index += 1) {
      const sample = Number(samples[index]) || 0;
      const magnitude = Math.abs(sample);
      if (magnitude > peak) peak = magnitude;
      squareTotal += sample * sample;
      sampleCount += 1;
    }
  }
  if (!sampleCount || peak < 0.0001) return volume;

  const rms = Math.sqrt(squareTotal / sampleCount);
  const rmsGain = rms > 0 ? NEURAL_TARGET_RMS / rms : 1;
  const peakGain = NEURAL_PEAK_CEILING / peak;
  const normalization = Math.min(
    Math.max(Math.min(rmsGain, peakGain), 0.65),
    2.5
  );
  return volume * normalization;
}

export async function readMicrophonePermissionState(browserNavigator) {
  try {
    const status = await browserNavigator?.permissions?.query?.({
      name: "microphone",
    });
    return ["granted", "prompt", "denied"].includes(status?.state)
      ? status.state
      : "unknown";
  } catch (_) {
    // Safari versions that do not expose microphone through Permissions API
    // should still continue to the browser's real audio-capture request.
    return "unknown";
  }
}

export function describeMicrophoneAccessFailure(error, {
  userAgent = "",
  permissionState = "unknown",
} = {}) {
  const errorName = String(error?.name ?? "");
  const permissionBlocked = permissionState === "denied"
    || ["NotAllowedError", "PermissionDeniedError", "SecurityError"]
      .includes(errorName);

  if (permissionBlocked && isSafariBrowser(userAgent)) {
    return (
      "Safari blocked microphone access for this website. Open Safari > "
      + "Settings > Websites > Microphone, change this website from Deny to "
      + "Ask or Allow, then select Try microphone again. If needed, also "
      + "turn on Safari in System Settings > Privacy & Security > Microphone."
    );
  }
  if (permissionBlocked) {
    return (
      "Microphone access is blocked for this website. Allow microphone access "
      + "in your browser settings, then select Try microphone again."
    );
  }
  if (["NotFoundError", "DevicesNotFoundError"].includes(errorName)) {
    return (
      "No microphone was found. Connect or enable a microphone, then select "
      + "Try microphone again."
    );
  }
  if (["NotReadableError", "TrackStartError", "AbortError"].includes(errorName)) {
    return (
      "The microphone is unavailable or being used by another application. "
      + "Close the other application, then select Try microphone again."
    );
  }
  if (isSafariBrowser(userAgent)) {
    return (
      "Safari could not start voice input. Keep this tab active and select "
      + "Try microphone again; the website can remain set to Ask, and Safari "
      + "should open its permission prompt. If it still fails, close any other "
      + "tab or application using the microphone and reload this tab."
    );
  }
  return (
    "The microphone could not start. Check your browser and system microphone "
    + "settings, then select Try microphone again."
  );
}

export function parsePainLevel(transcript) {
  const text = String(transcript ?? "").normalize("NFKC").trim().toLowerCase();
  const digitMatch = text.match(/(?:^|\D)(10|[0-9])(?:\D|$)/);
  if (digitMatch) return Number(digitMatch[1]);

  const words = text.replace(/[^\p{L}\p{M}\p{N}\s]/gu, " ").split(/\s+/);
  for (const word of words) {
    if (Object.hasOwn(NUMBER_WORDS, word)) return NUMBER_WORDS[word];
    if (Object.hasOwn(LOCALIZED_NUMBER_WORDS, word)) {
      return LOCALIZED_NUMBER_WORDS[word];
    }
  }
  const chineseNumber = text.match(/[零〇一二两三四五六七八九十]/)?.[0];
  if (chineseNumber && Object.hasOwn(LOCALIZED_NUMBER_WORDS, chineseNumber)) {
    return LOCALIZED_NUMBER_WORDS[chineseNumber];
  }
  return null;
}

export function parseRecoveryStatus(transcript) {
  const text = String(transcript ?? "").trim().toLowerCase();
  if (
    /\b(better|improving|improved|stronger|recovering well)\b/.test(text)
    || /(好转|好多了|改善|越来越好|semakin baik|lebih baik|pulih|மேம்பட்ட|நன்றாக)/u.test(text)
  ) {
    return "better";
  }
  if (
    /\b(worse|declining|more painful|not as good)\b/.test(text)
    || /(更糟|更痛|恶化|semakin teruk|lebih teruk|lebih sakit|மோச|அதிக வலி)/u.test(text)
  ) {
    return "worse";
  }
  if (
    /\b(same|similar|unchanged|no change|about the same)\b/.test(text)
    || /(一样|差不多|没变化|没有变化|sama|tiada perubahan|அதே|மாற்றமில்லை)/u.test(text)
  ) {
    return "same";
  }
  if (
    /\b(unsure|not sure|don't know|do not know)\b/.test(text)
    || /(不确定|不知道|tidak pasti|tak pasti|tidak tahu|tak tahu|தெரியவில்லை|உறுதியாகத் தெரியவில்லை)/u.test(text)
  ) {
    return "unsure";
  }
  return null;
}

export function parseConfirmationResponse(transcript) {
  const text = String(transcript ?? "").trim().toLowerCase();
  if (
    /\b(change|incorrect|wrong|try again|start again|go back)\b/.test(text) ||
    /^(no|nope)\b/.test(text) ||
    /(更改|修改|不对|错误|重来|不是|tukar|ubah|salah|tidak betul|cuba lagi|மாற்று|தவறு|மீண்டும்|இல்லை)/u.test(text)
  ) {
    return "change";
  }
  if (
    /\b(yes|correct|confirm|continue|that's right|that is right|right answer)\b/.test(text)
    || /(是的|正确|对的|没错|确认|ya|betul|tepat|sahkan|teruskan|ஆம்|சரி|உறுதி)/u.test(text)
  ) {
    return "confirm";
  }
  return null;
}

export function isMovementRestRequest(transcript) {
  const normalized = normalizeSpeech(transcript).trim();
  if (!normalized) return false;

  const englishRequest = /^(?:please\s+)?(?:(?:(?:i\s+(?:need|want|have)|i\s+would\s+like|i'd\s+like|can\s+i|could\s+i|may\s+i|let\s+me)\s+(?:to\s+)?(?:have\s+|take\s+)?)(?:a\s+)?(?:short\s+|quick\s+|little\s+)?(?:rest|break)|(?:take|have)\s+(?:a\s+)?(?:short\s+|quick\s+)?(?:rest|break)|(?:rest|break))(?:\s+(?:now|please))?$/;
  const englishPause = /^(?:please\s+)?(?:pause|stop)(?:\s+(?:the|this|my))?(?:\s+(?:camera|movement|exercise))?(?:\s+guide)?(?:\s+(?:for|so\s+i\s+can\s+take)\s+(?:a\s+)?(?:rest|break))?(?:\s+(?:now|please))?$/;
  const chineseRequest = /^(?:我(?:需要|想要|要|想)\s*休息|让我\s*休息|休息(?:一下)?|暂停(?:一下)?|停一下)$/u;
  const malayRequest = /^(?:saya\s+(?:perlu|mahu|nak)\s+(?:berehat|rehat)|boleh\s+saya\s+(?:berehat|rehat)|(?:berehat|rehat|berhenti)\s+(?:sebentar|sekejap))$/u;
  const tamilRequest = /^(?:எனக்கு\s+(?:ஓய்வு|இடைவேளை)\s+வேண்டும்|நான்\s+ஓய்வெடுக்க\s+வேண்டும்|(?:சிறிது\s+)?ஓய்வு\s+எடுக்க|சிறிது\s+நிறுத்து)$/u;

  return englishRequest.test(normalized)
    || englishPause.test(normalized)
    || chineseRequest.test(normalized)
    || malayRequest.test(normalized)
    || tamilRequest.test(normalized);
}

export function isMovementResumeRequest(transcript) {
  const normalized = normalizeSpeech(transcript).trim();
  if (!normalized) return false;

  const englishRequest = /^(?:please\s+)?(?:(?:continue|resume)(?:\s+(?:the|this|my))?(?:\s+(?:camera|movement|exercise))?(?:\s+guide)?|start(?:\s+(?:the|this|my))?(?:\s+(?:camera|movement|exercise))?(?:\s+guide)?\s+again|i(?:'m|\s+am)\s+ready(?:\s+to\s+(?:continue|resume))?)(?:\s+(?:now|please))?$/;
  const chineseRequest = /^(?:继续(?:运动|锻炼|摄像头指导)?|恢复(?:运动|锻炼|摄像头指导)?|我准备好了|可以继续了)$/u;
  const malayRequest = /^(?:teruskan|sambung(?:\s+(?:panduan\s+kamera|senaman))?|saya\s+(?:sudah|dah)\s+bersedia)$/u;
  const tamilRequest = /^(?:தொடரவும்|மீண்டும்\s+தொடங்கவும்|கேமரா\s+வழிகாட்டியைத்\s+தொடரவும்|நான்\s+தயார்)$/u;

  return englishRequest.test(normalized)
    || chineseRequest.test(normalized)
    || malayRequest.test(normalized)
    || tamilRequest.test(normalized);
}

export function parseEarlyStopReason(transcript) {
  const normalized = normalizeSpeech(transcript);
  if (!normalized) return "";

  if (
    /\b(breathless|short of breath|out of breath|cannot breathe|can't breathe|hard to breathe|difficulty breathing)\b/.test(normalized)
  ) {
    return "breathless";
  }
  if (/\b(dizzy|dizziness|faint|faintness|lightheaded|light headed)\b/.test(normalized)) {
    return "dizzy";
  }
  if (/\b(pain|painful|hurts?|aching|ache|sore)\b/.test(normalized)) {
    return "pain";
  }
  if (/\b(tired|tiring|fatigue|fatigued|exhausted|no energy)\b/.test(normalized)) {
    return "tired";
  }
  if (
    /\b(exercise (?:is |was )?(?:too )?(?:difficult|hard|challenging|unclear)|too difficult|too hard|cannot do (?:it|this)|can't do (?:it|this)|instructions? (?:are |were )?unclear)\b/.test(normalized)
  ) {
    return "exercise_difficulty";
  }
  if (/\b(skip|prefer not to say|do not want to say|don't want to say)\b/.test(normalized)) {
    return "skipped";
  }
  return "";
}

export function parsePainSafetyResponse(stage, transcript) {
  const normalized = normalizeSpeech(transcript);
  if (!normalized) return "";

  const includesAny = (...phrases) =>
    phrases.some((phrase) => normalized.includes(phrase));

  if (stage === "urgent" || stage.startsWith("urgent-")) {
    if (
      includesAny(
        "not sure",
        "unsure",
        "i don't know",
        "i do not know",
        "maybe",
        "不确定",
        "不知道",
        "也许",
        "tidak pasti",
        "tak pasti",
        "tidak tahu",
        "mungkin",
        "தெரியவில்லை",
        "உறுதியாக தெரியவில்லை"
      )
    ) {
      return "unsure";
    }

    if (stage !== "urgent") {
      const focusedNegative =
        /^(no|none|nope|not at all)(\b|$)/.test(normalized)
        || includesAny(
          "i do not have",
          "i don't have",
          "i am not experiencing",
          "i'm not experiencing",
          "breathing is normal",
          "没有",
          "不是",
          "tiada",
          "tidak",
          "இல்லை"
        );
      if (focusedNegative) return "no";

      const focusedTerms = {
        "urgent-chest": [
          "yes",
          "chest pressure",
          "chest pain",
          "chest tightness",
          "tight chest",
          "squeezing",
          "heaviness",
          "胸口受压",
          "胸痛",
          "胸闷",
          "tekanan dada",
          "sakit dada",
          "மார்பு அழுத்தம்",
          "மார்பு வலி",
        ],
        "urgent-breathing": [
          "yes",
          "shortness of breath",
          "short of breath",
          "breathless",
          "cannot breathe",
          "can't breathe",
          "hard to breathe",
          "difficulty breathing",
          "呼吸困难",
          "呼吸急促",
          "sesak nafas",
          "sukar bernafas",
          "மூச்சுத்திணறல்",
          "சுவாசிக்க சிரமம்",
        ],
        "urgent-neurologic": [
          "yes",
          "dizzy",
          "dizziness",
          "faint",
          "lightheaded",
          "light headed",
          "weakness",
          "weak",
          "numb",
          "numbness",
          "头晕",
          "晕眩",
          "无力",
          "麻木",
          "pening",
          "hendak pitam",
          "lemah",
          "kebas",
          "தலைச்சுற்றல்",
          "மயக்கம்",
          "பலவீனம்",
          "உணர்வின்மை",
        ],
        "urgent-fall": [
          "yes",
          "fell",
          "fallen",
          "fall",
          "跌倒",
          "摔倒",
          "jatuh",
          "விழுந்த",
        ],
      };
      if (includesAny("是", "有", "ya", "ஆம்")) return "yes";
      if (includesAny(...(focusedTerms[stage] ?? []))) return "yes";
      return "";
    }

    if (
      /^(no|none|nope)(\b|$)/.test(normalized) ||
      includesAny(
        "none of these",
        "none of those",
        "i don't have any of these",
        "i do not have any of these",
        "i don't have any of those",
        "i do not have any of those",
        "i am okay",
        "i'm okay",
        "i feel okay",
        "no symptoms",
        "没有",
        "没有以上情况",
        "都没有",
        "没有这些症状",
        "tiada satu pun",
        "tiada gejala",
        "tiada",
        "tidak",
        "எதுவுமில்லை",
        "இந்த அறிகுறிகள் இல்லை",
        "இல்லை"
      )
    ) {
      return "no";
    }
    if (
      includesAny(
        "yes",
        "是",
        "有",
        "ya",
        "ஆம்",
        "chest",
        "shortness of breath",
        "cannot breathe",
        "can't breathe",
        "dizzy",
        "dizziness",
        "faint",
        "weakness",
        "numb",
        "fell",
        "fallen",
        "fall",
        "胸口",
        "胸痛",
        "呼吸困难",
        "头晕",
        "麻木",
        "跌倒",
        "tekanan dada",
        "sesak nafas",
        "pening",
        "kebas",
        "jatuh",
        "மார்பு",
        "மூச்சுத்திணறல்",
        "தலைச்சுற்றல்",
        "உணர்வின்மை",
        "விழுந்த"
      )
    ) {
      return "yes";
    }
    return "";
  }

  if (stage === "location") {
    if (includesAny("knee", "knees", "膝盖", "lutut", "முழங்கால்")) return "knee";
    if (includesAny("hip", "hips", "髋部", "pinggul", "இடுப்பு")) return "hip";
    if (includesAny("ankle", "ankles", "foot", "feet", "脚踝", "脚", "buku lali", "kaki", "கணுக்கால்", "பாதம்")) return "ankle";
    if (includesAny("back", "spine", "背部", "belakang", "முதுகு")) return "back";
    if (includesAny("shoulder", "shoulders", "arm", "arms", "肩膀", "手臂", "bahu", "lengan", "தோள்", "கை")) return "shoulder";
    if (includesAny("other", "somewhere else", "其他", "lain", "வேறு")) return "other";
    return "";
  }

  if (stage === "side") {
    if (includesAny("both", "either side", "both sides", "两侧", "两边", "kedua-dua", "இரு பக்க")) return "both";
    if (includesAny("left", "左", "kiri", "இடது")) return "left";
    if (includesAny("right", "右", "kanan", "வலது")) return "right";
    if (includesAny("not sure", "unsure", "i don't know", "i do not know", "不确定", "tidak pasti", "தெரியவில்லை")) {
      return "unsure";
    }
    return "";
  }

  if (stage === "familiarity") {
    if (includesAny("usual", "familiar", "same pain", "stronger", "平时", "更强", "biasa", "lebih kuat", "வழக்கமான", "அதிக")) {
      return "usual-stronger";
    }
    if (includesAny("different", "not the same", "不同", "berbeza", "வேறுபட்ட")) return "different";
    if (includesAny("new", "never felt", "新的", "baharu", "புதிய")) return "new";
    if (includesAny("not sure", "unsure", "i don't know", "i do not know", "不确定", "tidak pasti", "தெரியவில்லை")) {
      return "unsure";
    }
    return "";
  }

  if (stage === "timing") {
    if (includesAny("before", "already hurting", "开始前", "sebelum", "முன்")) return "before";
    if (includesAny("during", "while exercising", "while moving", "运动时", "semasa", "போது")) return "during";
    if (includesAny("after", "when i finished", "when I finished", "结束后", "selepas", "பிறகு")) return "after";
    if (includesAny("not sure", "unsure", "i don't know", "i do not know", "不确定", "tidak pasti", "தெரியவில்லை")) {
      return "unsure";
    }
    return "";
  }

  if (stage === "rest") {
    return parseRecoveryStatus(normalized);
  }

  if (stage === "mobility") {
    if (
      includesAny(
        "no i need help",
        "cannot move",
        "can't move",
        "cannot stand",
        "can't stand",
        "cannot get up",
        "can't get up",
        "too painful",
        "so painful",
        "need help",
        "unable",
        "不能站",
        "无法移动",
        "需要帮助",
        "太痛",
        "tidak boleh berdiri",
        "tidak boleh bergerak",
        "perlukan bantuan",
        "terlalu sakit",
        "நிற்க முடியாது",
        "நகர முடியாது",
        "உதவி தேவை",
        "மிகவும் வலி"
      )
    ) {
      return "help";
    }
    if (includesAny("someone nearby", "need someone", "with assistance", "有人在旁边", "seseorang berdekatan", "அருகில் ஒருவர்")) {
      return "nearby";
    }
    if (includesAny("yes", "safely", "i can move", "i am safe", "可以", "安全", "ya", "selamat", "boleh bergerak", "ஆம்", "பாதுகாப்பாக", "நகர முடியும்")) return "safe";
    return "";
  }

  return "";
}

function voiceScore(voice, requestedLanguage) {
  const language = String(voice?.lang ?? "").toLowerCase();
  const requested = String(requestedLanguage ?? "en-US").toLowerCase();
  const requestedBase = requested.split("-")[0];
  const name = `${voice?.name ?? ""} ${voice?.voiceURI ?? ""}`;

  if (language && !language.startsWith(requestedBase)) return -Infinity;
  if (NOVELTY_VOICE_NAME.test(name)) return -Infinity;

  let score = 0;
  const clearPreferences = CLEAR_VOICE_PREFERENCES[requestedBase] ?? [];
  const clearPreferenceIndex = clearPreferences.findIndex((pattern) =>
    pattern.test(name)
  );
  if (clearPreferenceIndex >= 0) {
    score += 320 - clearPreferenceIndex * 10;
  }
  if (language === requested) score += 80;
  else if (language.startsWith(requestedBase)) score += 55;
  if (NATURAL_VOICE_NAME.test(name)) score += 75;
  if (GENTLE_VOICE_NAME.test(name)) score += 40;
  if (voice?.default) score += 8;
  if (voice?.localService) score += 4;
  if (SYNTHETIC_VOICE_NAME.test(name)) score -= 80;
  return score;
}

function isConversationalVoice(voice) {
  const name = `${voice?.name ?? ""} ${voice?.voiceURI ?? ""}`;
  return (
    (NATURAL_VOICE_NAME.test(name) || GENTLE_VOICE_NAME.test(name))
    && !SYNTHETIC_VOICE_NAME.test(name)
    && !NOVELTY_VOICE_NAME.test(name)
  );
}

export function selectGentleVoice(voices, requestedLanguage = "en-US") {
  const available = Array.from(voices ?? []);
  let selected = null;
  let selectedScore = -Infinity;

  available.forEach((voice) => {
    const score = voiceScore(voice, requestedLanguage);
    if (score > selectedScore) {
      selected = voice;
      selectedScore = score;
    }
  });

  return selectedScore === -Infinity ? null : selected;
}

export function prepareGentleSpeech(text) {
  return String(text ?? "")
    .replace(/\s*[—–]\s*/g, ", ")
    .replace(/\s*;\s*/g, "; ")
    .replace(/\s+/g, " ")
    .trim();
}

export function conversationalProsody(text) {
  const message = String(text ?? "").trim();
  const wordCount = message ? message.split(/\s+/).length : 0;
  const isQuestion = /\?/.test(message);
  const isUrgent =
    /\b(stop exercising|get help now|call 995|emergency|cannot get up)\b/i
      .test(message);

  // Stay close to normal conversational speed. Rates below about 0.9 made the
  // browser voices sound old, drawn out and harder to understand. A slight
  // lift in pitch avoids a dull monotone without creating a cartoon voice.
  if (isUrgent) return { rate: 0.95, pitch: 1.02 };
  if (isQuestion) return { rate: 0.98, pitch: 1.04 };
  if (wordCount > 34) return { rate: 0.96, pitch: 1.02 };
  if (wordCount <= 8) return { rate: 1, pitch: 1.04 };
  return { rate: 0.98, pitch: 1.03 };
}

export function browserSpeechWatchdogMs(text, rate = 1) {
  const message = String(text ?? "").trim();
  const wordCount = Math.max(1, message ? message.split(/\s+/).length : 0);
  const effectiveRate = Math.min(Math.max(Number(rate) || 1, 0.5), 1.25);
  const estimatedSpeechMs = (
    wordCount / BROWSER_SPEECH_WORDS_PER_MINUTE
  ) * 60000 / effectiveRate;
  return Math.min(
    BROWSER_SPEECH_WATCHDOG_MAX_MS,
    Math.max(
      BROWSER_SPEECH_WATCHDOG_MIN_MS,
      Math.ceil(estimatedSpeechMs + 3500),
    ),
  );
}

function readStoredPreference(browserWindow) {
  try {
    return browserWindow.localStorage.getItem(VOICE_PREFERENCE_KEY) !== "false";
  } catch (_) {
    return true;
  }
}

function readStoredRatePreference(browserWindow) {
  try {
    const stored = browserWindow.localStorage.getItem(VOICE_RATE_PREFERENCE_KEY);
    return Object.hasOwn(SPEECH_RATE_PRESETS, stored) ? stored : "normal";
  } catch (_) {
    return "normal";
  }
}

export class VoiceGuidance {
  constructor(browserWindow = typeof window === "undefined" ? null : window) {
    this.window = browserWindow;
    this.synthesis = browserWindow?.speechSynthesis ?? null;
    this.Recognition =
      browserWindow?.SpeechRecognition ??
      browserWindow?.webkitSpeechRecognition ??
      null;
    this.enabled = browserWindow ? readStoredPreference(browserWindow) : false;
    this.ratePreference = browserWindow
      ? readStoredRatePreference(browserWindow)
      : "normal";
    this.rateControls = new Set();
    this.lastSpoken = new Map();
    this.activeRecognition = null;
    this.pendingMicrophoneRelease = null;
    this.listeningGeneration = 0;
    this.preferredVoice = null;
    this.voiceSelectionLocked = false;
    this.browserVoiceGroups = new Map();
    this.neuralSpeechProvider = null;
    this.singleVoiceEngine = requiresSingleVoiceEngine(
      browserWindow?.navigator?.userAgent
    );
    this.audioContext = null;
    this.activeAudioSource = null;
    this.neuralSpeaking = false;
    this.browserSpeechWarmupPending = false;
    this.browserSpeechWatchdog = null;
    this.speechGeneration = 0;
    this.neuralAudioCache = new Map();
    this.refreshPreferredVoice = () => {
      if (this.voiceSelectionLocked) return this.preferredVoice;
      const language = getSpeechLocale();
      this.preferredVoice = selectGentleVoice(
        this.synthesis?.getVoices?.() ?? [],
        language
      );
      return this.preferredVoice;
    };
    this.refreshPreferredVoice();
    this.synthesis?.addEventListener?.(
      "voiceschanged",
      this.refreshPreferredVoice
    );
    this.window?.addEventListener?.("physiovision:language-change", (event) => {
      this.voiceSelectionLocked = false;
      this.browserVoiceGroups.clear();
      this.preferredVoice = selectGentleVoice(
        this.synthesis?.getVoices?.() ?? [],
        event.detail?.speechLocale || getSpeechLocale()
      );
    });
    this.window?.addEventListener?.(
      "physiovision:clear-personal-guidance-audio",
      () => {
        for (const [key, cached] of this.neuralAudioCache.entries()) {
          if (cached?.cacheScope === "personal") {
            this.neuralAudioCache.delete(key);
          }
        }
      }
    );
    this.window?.addEventListener?.("pagehide", () => {
      // Explicitly release Safari's speech-recognition capture before a
      // refresh or history navigation so the next page can use the microphone.
      this.cancel();
    });
  }

  get canSpeak() {
    return Boolean(this.synthesis && this.window?.SpeechSynthesisUtterance);
  }

  get canListen() {
    return Boolean(this.Recognition);
  }

  get isSpeaking() {
    return Boolean(this.synthesis?.speaking || this.neuralSpeaking);
  }

  setNeuralSpeechProvider(provider) {
    this.neuralSpeechProvider = typeof provider === "function" ? provider : null;
  }

  reportGuidanceAudioSource(source, cacheScope = "generic") {
    const EventConstructor = this.window?.CustomEvent ?? globalThis.CustomEvent;
    if (!this.window?.dispatchEvent || !EventConstructor) return;
    this.window.dispatchEvent(new EventConstructor(
      "physiovision:guide-audio-source",
      {
        detail: {
          source,
          cacheScope: cacheScope === "personal" ? "personal" : "generic",
        },
      }
    ));
  }

  async unlockNeuralAudio() {
    const AudioContext =
      this.window?.AudioContext ?? this.window?.webkitAudioContext;
    if (!AudioContext) return false;
    try {
      if (!this.audioContext) this.audioContext = new AudioContext();
      const resumePromise = this.audioContext.state === "suspended"
        ? this.audioContext.resume()
        : Promise.resolve();
      // Start a silent one-frame buffer while the selection click still has
      // user activation. Safari then permits the generated guidance returned
      // by the asynchronous backend request to play through this context.
      const source = this.audioContext.createBufferSource();
      source.buffer = this.audioContext.createBuffer(1, 1, 24000);
      source.connect(this.audioContext.destination);
      source.start(0);
      await resumePromise;
      return true;
    } catch (_) {
      return false;
    }
  }

  async verifyListeningAccess({ timeoutMs = 20000 } = {}) {
    if (!this.canListen) {
      const error = new Error(
        "Speech recognition is unavailable in this browser."
      );
      error.name = "NotSupportedError";
      throw error;
    }

    // Safari has a dedicated SpeechRecognition permission flow. Checking the
    // API that hands-free mode actually uses avoids rejecting a valid `Ask`
    // setting because a separate getUserMedia preflight failed first.
    this.listeningGeneration += 1;
    this.activeRecognition?.abort();
    this.cancelSpokenOutput();

    const recognition = new this.Recognition();
    const markMicrophoneReleased = this.beginMicrophoneSession();
    recognition.lang = getSpeechLocale();
    recognition.interimResults = false;
    recognition.continuous = false;
    const schedule = this.window?.setTimeout?.bind(this.window)
      ?? globalThis.setTimeout;
    const unschedule = this.window?.clearTimeout?.bind(this.window)
      ?? globalThis.clearTimeout;
    this.activeRecognition = recognition;

    return new Promise((resolve, reject) => {
      let settled = false;
      let timeout = null;
      let microphoneStarted = false;
      let releaseRequested = false;

      const cleanup = () => {
        if (timeout !== null) unschedule(timeout);
        if (this.activeRecognition === recognition) {
          this.activeRecognition = null;
        }
      };
      const succeed = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(true);
      };
      const fail = (name, message) => {
        if (settled) return;
        settled = true;
        cleanup();
        try {
          recognition.abort();
        } catch (_) {
          // The failed recognizer may already be inactive.
        }
        const error = new Error(message);
        error.name = name;
        reject(error);
      };

      // `audiostart` confirms permission, but Safari may keep its output in a
      // quiet play-and-record session until the recognizer emits `audioend` or
      // `end`. Resolving here made the first question start while the red
      // microphone indicator was still active, so its volume rose mid-sentence.
      recognition.addEventListener("audiostart", () => {
        if (settled || microphoneStarted) return;
        microphoneStarted = true;
        releaseRequested = true;
        try {
          recognition.abort();
        } catch (_) {
          fail(
            "UnknownError",
            "Safari could not release microphone audio after the permission check."
          );
        }
      });
      recognition.addEventListener("audioend", () => {
        markMicrophoneReleased();
        if (microphoneStarted) succeed();
      });
      recognition.addEventListener("error", (event) => {
        if (releaseRequested && event?.error === "aborted") return;
        markMicrophoneReleased();
        const errorName = event?.error === "not-allowed"
          ? "NotAllowedError"
          : event?.error === "audio-capture"
            ? "NotReadableError"
            : event?.error === "service-not-allowed"
              ? "NotSupportedError"
              : "UnknownError";
        fail(
          errorName,
          `Speech recognition could not capture audio (${event?.error ?? "unknown"}).`
        );
      });
      recognition.addEventListener("end", () => {
        markMicrophoneReleased();
        if (microphoneStarted) {
          succeed();
          return;
        }
        fail(
          "UnknownError",
          "Speech recognition ended before microphone audio started."
        );
      });

      timeout = schedule(() => {
        fail(
          "UnknownError",
          microphoneStarted
            ? "Safari did not release microphone audio after the permission check."
            : "Safari did not start microphone audio before the permission check timed out."
        );
      }, Math.max(1000, Number(timeoutMs) || 20000));

      try {
        recognition.start();
      } catch (error) {
        fail(
          String(error?.name || "UnknownError"),
          String(error?.message || "Speech recognition could not start.")
        );
      }
    });
  }

  preparePreferredVoice({ timeoutMs = 1200, pollMs = 50 } = {}) {
    if (!this.canSpeak || this.voiceSelectionLocked) {
      return Promise.resolve(this.preferredVoice);
    }
    const selected = this.refreshPreferredVoice();
    if (selected && isConversationalVoice(selected)) {
      return Promise.resolve(selected);
    }

    const schedule = this.window?.setTimeout?.bind(this.window)
      ?? globalThis.setTimeout;
    const startedAt = Date.now();
    return new Promise((resolve) => {
      const checkVoices = () => {
        const voice = this.refreshPreferredVoice();
        if (
          isConversationalVoice(voice)
          || Date.now() - startedAt >= timeoutMs
        ) {
          resolve(voice);
          return;
        }
        schedule(checkVoices, pollMs);
      };
      schedule(checkVoices, pollMs);
    });
  }

  usePlaybackAudioSession() {
    const audioSession = this.window?.navigator?.audioSession;
    if (!audioSession || !("type" in audioSession)) return false;
    try {
      // Safari can leave output ducked after microphone permission or speech
      // recognition. Explicit playback mode prevents the volume from changing
      // part-way through the following utterance.
      audioSession.type = "playback";
      return audioSession.type === "playback";
    } catch (_) {
      return false;
    }
  }

  beginMicrophoneSession() {
    let released = false;
    let resolveRelease;
    const releasePromise = new Promise((resolve) => {
      resolveRelease = resolve;
    });
    this.pendingMicrophoneRelease = releasePromise;
    return () => {
      if (released) return;
      released = true;
      resolveRelease();
      if (this.pendingMicrophoneRelease === releasePromise) {
        this.pendingMicrophoneRelease = null;
      }
    };
  }

  waitForMicrophoneRelease({
    timeoutMs = MICROPHONE_RELEASE_TIMEOUT_MS,
  } = {}) {
    const pendingRelease = this.pendingMicrophoneRelease;
    if (!pendingRelease) return Promise.resolve(true);
    const schedule = this.window?.setTimeout?.bind(this.window)
      ?? globalThis.setTimeout;
    const unschedule = this.window?.clearTimeout?.bind(this.window)
      ?? globalThis.clearTimeout;
    const safeTimeoutMs = Math.max(0, Number(timeoutMs) || 0);
    return new Promise((resolve) => {
      let settled = false;
      let timeout = null;
      const finish = (released) => {
        if (settled) return;
        settled = true;
        if (timeout !== null) unschedule(timeout);
        resolve(released);
      };
      pendingRelease.then(
        () => finish(true),
        () => finish(false)
      );
      timeout = schedule(() => finish(false), safeTimeoutMs);
    });
  }

  async prepareSpeechAfterMicrophoneRelease({
    settleMs = MICROPHONE_RELEASE_SETTLE_MS,
  } = {}) {
    const schedule = this.window?.setTimeout?.bind(this.window)
      ?? globalThis.setTimeout;
    const safeSettleMs = Math.max(0, Number(settleMs) || 0);
    // SpeechRecognition can return a transcript before Safari has emitted
    // `audioend`. A fixed delay therefore lets the next sentence begin in the
    // quiet recording session and jump louder halfway through. Wait for the
    // actual release signal first; use a bounded timeout only for browsers
    // that omit it entirely.
    await this.waitForMicrophoneRelease();
    this.usePlaybackAudioSession();
    const [voice] = await Promise.all([
      this.preparePreferredVoice(),
      new Promise((resolve) => schedule(resolve, safeSettleMs)),
    ]);
    // Safari can switch itself back to play-and-record while the recognizer is
    // shutting down. Set playback again after the settling interval so the
    // next sentence starts at its full level instead of growing louder midway.
    this.usePlaybackAudioSession();
    // Waiting alone does not warm WebKit's SpeechSynthesis output path. The
    // next browser utterance first renders one normal-length phrase at volume
    // zero, allowing the route to reach full level without speaking anything.
    this.browserSpeechWarmupPending = this.singleVoiceEngine;
    return voice;
  }

  get speechRateMultiplier() {
    return SPEECH_RATE_PRESETS[this.ratePreference]
      ?? SPEECH_RATE_PRESETS.normal;
  }

  setRatePreference(preference) {
    this.ratePreference = Object.hasOwn(SPEECH_RATE_PRESETS, preference)
      ? preference
      : "normal";
    try {
      this.window?.localStorage.setItem(
        VOICE_RATE_PREFERENCE_KEY,
        this.ratePreference
      );
    } catch (_) {
      // Keep the choice for this page even if browser storage is unavailable.
    }
    this.renderRateControls();
    return this.ratePreference;
  }

  renderRateControls() {
    this.rateControls.forEach((control) => {
      control.value = this.ratePreference;
    });
  }

  attachRateControl(control) {
    if (!control) return;
    this.rateControls.add(control);
    control.value = this.ratePreference;
    control.addEventListener("change", () => {
      this.setRatePreference(control.value);
    });
  }

  setEnabled(enabled) {
    this.enabled = Boolean(enabled);
    if (!this.enabled) {
      this.cancel();
      this.voiceSelectionLocked = false;
    }
    try {
      this.window?.localStorage.setItem(
        VOICE_PREFERENCE_KEY,
        String(this.enabled)
      );
    } catch (_) {
      // Voice still works when storage is blocked.
    }
    this.renderToggle();
    return this.enabled;
  }

  renderToggle() {
    const button = this.toggleButton;
    if (!button) return;

    const active = this.enabled && this.canSpeak;
    button.setAttribute("aria-pressed", String(active));
    button.innerHTML = active
      ? '<span aria-hidden="true">◖))</span> Voice on'
      : '<span aria-hidden="true">◖×</span> Voice off';
    button.title = this.canSpeak
      ? "Turn spoken guidance on or off"
      : "Spoken guidance is unavailable in this browser";
    button.disabled = !this.canSpeak;
  }

  attachToggle(button) {
    if (!button) return;
    this.toggleButton = button;
    this.renderToggle();
    button.addEventListener("click", () => {
      this.setEnabled(!this.enabled);
    });
  }

  speak(text, {
    key = String(text),
    cooldownMs = 0,
    interrupt = false,
    preferImmediate = false,
    preferPrepared = false,
    allowGeneratedSpeech = true,
    cacheScope = "generic",
    textOnlyOnUnavailable = false,
    onUnavailable = null,
    voiceGroup = "",
    onEnd = null,
    rate = null,
    pitch = null,
    volume = DEFAULT_SPEECH_VOLUME,
  } = {}) {
    const message = prepareGentleSpeech(translateText(text));
    if (!message || !this.enabled || !this.canSpeak) return false;

    const now = Date.now();
    if (now - (this.lastSpoken.get(key) ?? 0) < cooldownMs) return false;
    if ((this.synthesis.speaking || this.neuralSpeaking) && !interrupt) {
      return false;
    }

    this.usePlaybackAudioSession();
    if (interrupt) this.cancelSpokenOutput();
    this.lastSpoken.set(key, now);

    const useNeuralSpeech = Boolean(
      this.neuralSpeechProvider
      && (
        preferPrepared
        || (
          !preferImmediate
          && !this.singleVoiceEngine
          && message.length >= NEURAL_SPEECH_MIN_LENGTH
          && !/^Rep\s+\d+[.!]?$/i.test(message)
        )
      )
    );
    if (useNeuralSpeech) {
      const generation = ++this.speechGeneration;
      this.neuralSpeaking = true;
      this.speakNeural(message, {
        generation,
        onEnd,
        rate,
        pitch,
        volume,
        voiceGroup,
        allowGeneratedSpeech,
        cacheScope,
        textOnlyOnUnavailable,
        onUnavailable,
      });
      return true;
    }

    return this.speakBrowser(message, {
      onEnd,
      rate,
      pitch,
      volume,
      voiceGroup,
    });
  }

  speakBrowser(message, {
    onEnd = null,
    rate = null,
    pitch = null,
    volume = DEFAULT_SPEECH_VOLUME,
    voiceGroup = "",
  } = {}) {
    const utterance = new this.window.SpeechSynthesisUtterance(message);
    const normalizedVoiceGroup = String(voiceGroup ?? "").trim();
    const hasGroupedVoice = Boolean(
      normalizedVoiceGroup
      && this.browserVoiceGroups.has(normalizedVoiceGroup)
    );
    let selectedVoice = hasGroupedVoice
      ? this.browserVoiceGroups.get(normalizedVoiceGroup)
      : null;
    if (!hasGroupedVoice) {
      if (!this.preferredVoice) this.refreshPreferredVoice();
      selectedVoice = this.preferredVoice;
    }
    if (normalizedVoiceGroup && !hasGroupedVoice) {
      // Keep multi-step conversations on one exact system voice, even if the
      // browser publishes or reorders its voice list between utterances.
      this.browserVoiceGroups.set(normalizedVoiceGroup, selectedVoice ?? null);
    }
    if (selectedVoice) utterance.voice = selectedVoice;
    this.voiceSelectionLocked = true;
    utterance.lang =
      selectedVoice?.lang ||
      getSpeechLocale();
    const naturalProsody = conversationalProsody(message);
    const requestedRate = rate === null || rate === undefined
      ? naturalProsody.rate
      : Number(rate);
    const requestedPitch = pitch === null || pitch === undefined
      ? naturalProsody.pitch
      : Number(pitch);
    const preferredRate = (
      Number.isFinite(requestedRate) ? requestedRate : naturalProsody.rate
    ) * this.speechRateMultiplier;
    utterance.rate = Math.min(
      Math.max(preferredRate, 0.5),
      1.25
    );
    utterance.pitch = Math.min(
      Math.max(Number.isFinite(requestedPitch) ? requestedPitch : naturalProsody.pitch, 0.75),
      1.3
    );
    utterance.volume = Math.min(
      Math.max(Number(volume) || DEFAULT_SPEECH_VOLUME, 0.2),
      1
    );
    let armSpeechWatchdog = () => {};
    if (typeof onEnd === "function") {
      let finished = false;
      let watchdog = null;
      const schedule = this.window?.setTimeout?.bind(this.window)
        ?? globalThis.setTimeout;
      const unschedule = this.window?.clearTimeout?.bind(this.window)
        ?? globalThis.clearTimeout;
      const finishOnce = () => {
        if (finished) return;
        finished = true;
        if (watchdog !== null) unschedule(watchdog);
        if (this.browserSpeechWatchdog === watchdog) {
          this.browserSpeechWatchdog = null;
        }
        onEnd();
      };
      utterance.addEventListener("end", finishOnce);
      // Treat a browser synthesis failure as completion so a guided flow does
      // not remain stuck waiting for an end event that will never arrive.
      utterance.addEventListener("error", finishOnce);
      armSpeechWatchdog = () => {
        const generation = this.speechGeneration;
        watchdog = schedule(() => {
          if (finished || generation !== this.speechGeneration) return;
          // Safari occasionally remains in `speaking` forever without emitting
          // either end or error. Cancel that stale utterance before releasing the
          // flow so microphone listening (including Hey Guide) can resume.
          this.synthesis?.cancel();
          finishOnce();
        }, browserSpeechWatchdogMs(message, utterance.rate));
        this.browserSpeechWatchdog = watchdog;
      };
    }
    const shouldWarmUp = Boolean(
      this.singleVoiceEngine && this.browserSpeechWarmupPending
    );
    this.browserSpeechWarmupPending = false;
    if (!shouldWarmUp) {
      armSpeechWatchdog();
      this.synthesis.speak(utterance);
      return true;
    }

    const generation = this.speechGeneration;
    const warmup = new this.window.SpeechSynthesisUtterance(
      MUTED_BROWSER_SPEECH_WARMUP
    );
    warmup.voice = utterance.voice;
    warmup.lang = utterance.lang;
    warmup.rate = utterance.rate;
    warmup.pitch = utterance.pitch;
    warmup.volume = 0;
    let warmupFinished = false;
    const schedule = this.window?.setTimeout?.bind(this.window)
      ?? globalThis.setTimeout;
    const unschedule = this.window?.clearTimeout?.bind(this.window)
      ?? globalThis.clearTimeout;
    let warmupWatchdog = null;
    const speakRealSentence = () => {
      if (warmupFinished) return;
      warmupFinished = true;
      if (warmupWatchdog !== null) unschedule(warmupWatchdog);
      if (this.browserSpeechWatchdog === warmupWatchdog) {
        this.browserSpeechWatchdog = null;
      }
      if (generation !== this.speechGeneration || !this.enabled) return;
      this.usePlaybackAudioSession();
      armSpeechWatchdog();
      this.synthesis.speak(utterance);
    };
    warmup.addEventListener("end", speakRealSentence);
    warmup.addEventListener("error", speakRealSentence);
    warmupWatchdog = schedule(() => {
      if (warmupFinished || generation !== this.speechGeneration) return;
      this.synthesis?.cancel();
      speakRealSentence();
    }, 2500);
    this.browserSpeechWatchdog = warmupWatchdog;
    this.synthesis.speak(warmup);
    return true;
  }

  async decodeNeuralAudio(base64Audio) {
    const binary = this.window?.atob
      ? this.window.atob(base64Audio)
      : globalThis.atob(base64Audio);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const context = this.audioContext;
    if (!context) throw new Error("Audio context has not been unlocked.");
    return context.decodeAudioData(bytes.buffer.slice(0));
  }

  async speakNeural(message, {
    generation,
    onEnd,
    rate,
    pitch,
    volume,
    voiceGroup,
    allowGeneratedSpeech,
    cacheScope,
    textOnlyOnUnavailable,
    onUnavailable,
  }) {
    try {
      if (!this.audioContext) await this.unlockNeuralAudio();
      if (!this.audioContext) throw new Error("Generated-audio playback unavailable.");
      if (this.audioContext.state === "suspended") await this.audioContext.resume();

      const locale = getSpeechLocale();
      const normalizedCacheScope = cacheScope === "personal"
        ? "personal"
        : "generic";
      const cacheKey = `${normalizedCacheScope}:${locale}:${message}`;
      const cachedSpeech = this.neuralAudioCache.get(cacheKey);
      let base64Audio = cachedSpeech?.audio;
      if (!base64Audio) {
        const response = await this.neuralSpeechProvider({
          text: message,
          locale,
          allowGeneration: allowGeneratedSpeech,
          cacheScope: normalizedCacheScope,
        });
        base64Audio = response?.audio;
        if (!base64Audio) throw new Error("Generated guidance contained no audio.");
        this.neuralAudioCache.set(cacheKey, {
          audio: base64Audio,
          cacheScope: normalizedCacheScope,
        });
        this.reportGuidanceAudioSource(
          response?.provider || "device_audio_cache",
          normalizedCacheScope,
        );
        if (this.neuralAudioCache.size > NEURAL_SPEECH_CACHE_LIMIT) {
          this.neuralAudioCache.delete(this.neuralAudioCache.keys().next().value);
        }
      } else {
        this.reportGuidanceAudioSource(
          "device_audio_cache",
          normalizedCacheScope,
        );
      }
      const audioBuffer = await this.decodeNeuralAudio(base64Audio);
      if (generation !== this.speechGeneration || !this.enabled) return;

      const source = this.audioContext.createBufferSource();
      const gain = this.audioContext.createGain();
      const compressor = this.audioContext.createDynamicsCompressor?.() ?? null;
      gain.gain.value = normalizedNeuralSpeechGain(audioBuffer, volume);
      source.buffer = audioBuffer;
      if (source.playbackRate) {
        source.playbackRate.value = this.speechRateMultiplier;
      }
      source.connect(gain);
      if (compressor) {
        compressor.threshold.value = -20;
        compressor.knee.value = 12;
        compressor.ratio.value = 6;
        compressor.attack.value = 0.01;
        compressor.release.value = 0.18;
        gain.connect(compressor);
        compressor.connect(this.audioContext.destination);
      } else {
        gain.connect(this.audioContext.destination);
      }
      this.activeAudioSource = source;
      source.addEventListener?.("ended", () => {
        if (generation !== this.speechGeneration) return;
        this.activeAudioSource = null;
        this.neuralSpeaking = false;
        onEnd?.();
      });
      // Older WebKit exposes onended but not addEventListener on audio sources.
      if (!source.addEventListener) {
        source.onended = () => {
          if (generation !== this.speechGeneration) return;
          this.activeAudioSource = null;
          this.neuralSpeaking = false;
          onEnd?.();
        };
      }
      source.start(0);
    } catch (error) {
      if (generation !== this.speechGeneration || !this.enabled) return;
      console.warn("Natural guidance audio unavailable.", error);
      this.neuralSpeaking = false;
      if (textOnlyOnUnavailable) {
        this.reportGuidanceAudioSource("text_only", cacheScope);
        onUnavailable?.();
        onEnd?.();
        return;
      }
      this.reportGuidanceAudioSource("browser_speech", cacheScope);
      this.speakBrowser(message, {
        onEnd,
        rate,
        pitch,
        volume,
        voiceGroup,
      });
    }
  }

  cancelSpokenOutput() {
    this.speechGeneration += 1;
    this.neuralSpeaking = false;
    if (this.browserSpeechWatchdog !== null) {
      const unschedule = this.window?.clearTimeout?.bind(this.window)
        ?? globalThis.clearTimeout;
      unschedule(this.browserSpeechWatchdog);
      this.browserSpeechWatchdog = null;
    }
    const activeSource = this.activeAudioSource;
    this.activeAudioSource = null;
    try {
      activeSource?.stop?.(0);
    } catch (_) {
      // The source may already have ended.
    }
    this.synthesis?.cancel();
  }

  cancelListening() {
    this.listeningGeneration += 1;
    if (this.activeRecognition) {
      this.activeRecognition.abort();
      this.activeRecognition = null;
    }
  }

  cancel() {
    this.cancelListening();
    this.cancelSpokenOutput();
  }

  listen({
    onResult,
    onError,
    onStatus,
    maxNoSpeechRetries = 1,
    retryDelayMs = 350,
    interimSilenceMs = 0,
  } = {}) {
    if (!this.canListen) {
      onError?.(
        "Speech input is not supported in this browser. Use the buttons instead.",
        "unsupported"
      );
      return false;
    }

    this.listeningGeneration += 1;
    const listeningGeneration = this.listeningGeneration;
    this.activeRecognition?.abort();
    this.cancelSpokenOutput();
    const schedule = this.window?.setTimeout?.bind(this.window)
      ?? globalThis.setTimeout;
    const unschedule = this.window?.clearTimeout?.bind(this.window)
      ?? globalThis.clearTimeout;
    const recognitionLanguage = getSpeechLocale();
    const allowedRetries = Math.max(0, Number(maxNoSpeechRetries) || 0);
    let retryCount = 0;
    let sessionComplete = false;

    const isCurrentSession = () =>
      !sessionComplete && this.listeningGeneration === listeningGeneration;

    const startAttempt = () => {
      if (!isCurrentSession()) return;

      const recognition = new this.Recognition();
      const markMicrophoneReleased = this.beginMicrophoneSession();
      recognition.lang = recognitionLanguage;
      recognition.interimResults = true;
      recognition.maxAlternatives = 3;
      recognition.continuous = false;
      this.activeRecognition = recognition;

      let pendingTranscript = "";
      let pendingAlternatives = [];
      let resultDelivered = false;
      let retryScheduled = false;
      let recognizerStoppedForResult = false;
      let interimTimer = null;

      const clearInterimTimer = () => {
        if (interimTimer === null) return;
        unschedule(interimTimer);
        interimTimer = null;
      };

      const extractResult = (event) => {
        const results = event?.results;
        if (!results?.length) {
          return { transcript: "", alternatives: [], isFinal: false };
        }

        const parts = [];
        const alternatives = [];
        let isFinal = false;
        for (let index = 0; index < results.length; index += 1) {
          const result = results[index];
          const primary = result?.[0]?.transcript?.trim() ?? "";
          if (primary) parts.push(primary);
          isFinal ||= result?.isFinal !== false;
          for (let choice = 0; choice < (result?.length ?? 0); choice += 1) {
            const alternative = result[choice]?.transcript?.trim() ?? "";
            if (alternative && !alternatives.includes(alternative)) {
              alternatives.push(alternative);
            }
          }
        }
        const transcript = parts.join(" ").trim();
        if (transcript && !alternatives.includes(transcript)) {
          alternatives.unshift(transcript);
        }
        return { transcript, alternatives, isFinal };
      };

      const deliverRecognizedResult = () => {
        if (
          resultDelivered ||
          !pendingTranscript ||
          this.listeningGeneration !== listeningGeneration
        ) {
          return;
        }
        resultDelivered = true;
        sessionComplete = true;
        clearInterimTimer();
        if (this.activeRecognition === recognition) {
          this.activeRecognition = null;
        }
        const finishDelivery = () => {
          if (this.listeningGeneration !== listeningGeneration) return;
          onResult?.(pendingTranscript, pendingAlternatives);
        };
        if (this.singleVoiceEngine) {
          // WebKit's `end` event means recognition has stopped, but its output
          // can remain ducked briefly. Do not let the next prompt start until
          // the device has returned to a stable playback session.
          this.prepareSpeechAfterMicrophoneRelease().then(
            finishDelivery,
            finishDelivery
          );
        } else {
          finishDelivery();
        }
      };

      const retryOrFail = (message, errorCode = "unknown") => {
        if (!isCurrentSession() || retryScheduled || resultDelivered) return;
        clearInterimTimer();
        if (pendingTranscript) {
          deliverRecognizedResult();
          return;
        }
        if (retryCount < allowedRetries) {
          retryCount += 1;
          retryScheduled = true;
          if (this.activeRecognition === recognition) {
            this.activeRecognition = null;
          }
          onStatus?.(
            translateText(
              "I didn’t hear an answer. Listening again — speak normally near your device."
            )
          );
          schedule(startAttempt, Math.max(0, Number(retryDelayMs) || 0));
          return;
        }
        sessionComplete = true;
        if (this.activeRecognition === recognition) {
          this.activeRecognition = null;
        }
        onError?.(message, errorCode);
      };

      recognition.addEventListener("start", () => {
        if (!isCurrentSession()) return;
        onStatus?.(
          translateText(retryCount > 0
            ? "Listening again… Speak normally near your device."
            : "Listening… Speak normally near your device.")
        );
      });
      recognition.addEventListener("result", (event) => {
        if (!isCurrentSession()) return;
        const result = extractResult(event);
        if (result.transcript) {
          pendingTranscript = result.transcript;
          pendingAlternatives = result.alternatives;
        }
        if (!result.isFinal) {
          onStatus?.(
            pendingTranscript
              ? translateText(
                `I can hear you: “${pendingTranscript}” — keep speaking.`
              )
              : translateText("Listening… Speak normally near your device.")
          );
          const silenceMs = Math.max(0, Number(interimSilenceMs) || 0);
          if (pendingTranscript && silenceMs > 0) {
            clearInterimTimer();
            interimTimer = schedule(() => {
              interimTimer = null;
              if (!isCurrentSession() || !pendingTranscript) return;
              recognizerStoppedForResult = true;
              try {
                if (this.singleVoiceEngine) recognition.abort();
                else recognition.stop();
              } catch (_) {
                deliverRecognizedResult();
              }
              deliverRecognizedResult();
            }, silenceMs);
          }
          return;
        }

        clearInterimTimer();
        recognizerStoppedForResult = true;
        try {
          if (this.singleVoiceEngine) recognition.abort();
          else recognition.stop();
        } catch (_) {
          deliverRecognizedResult();
        }
        // Deliver immediately. Safari's path now waits on the recognizer's
        // real `audioend`/`end` signal before it lets the next prompt speak.
        deliverRecognizedResult();
      });
      recognition.addEventListener("audioend", () => {
        markMicrophoneReleased();
      });
      recognition.addEventListener("nomatch", () => {
        retryOrFail(
          "I did not understand that. Please try again or use the buttons.",
          "no-match"
        );
      });
      recognition.addEventListener("error", (event) => {
        if (
          this.listeningGeneration !== listeningGeneration ||
          (recognizerStoppedForResult && event.error === "aborted")
        ) {
          return;
        }
        markMicrophoneReleased();
        clearInterimTimer();
        if (event.error === "no-speech") {
          retryOrFail(
            "I could not hear an answer. Please try again or use the buttons.",
            "no-speech"
          );
          return;
        }
        sessionComplete = true;
        if (this.activeRecognition === recognition) {
          this.activeRecognition = null;
        }
        const message = event.error === "not-allowed"
          ? "Microphone access was not allowed. Use the buttons or allow microphone access."
          : event.error === "audio-capture"
            ? "No working microphone was found. Check your microphone or use the buttons."
            : "Speech recognition stopped. Please try again or use the buttons.";
        onError?.(message, event.error || "unknown");
      });
      recognition.addEventListener("end", () => {
        markMicrophoneReleased();
        if (this.listeningGeneration !== listeningGeneration) return;
        if (this.activeRecognition === recognition) {
          this.activeRecognition = null;
        }
        clearInterimTimer();
        if (pendingTranscript) {
          deliverRecognizedResult();
        } else if (!retryScheduled && !sessionComplete) {
          retryOrFail(
            "I could not hear an answer. Please try again or use the buttons.",
            "no-speech"
          );
        }
      });

      try {
        recognition.start();
      } catch (_) {
        retryOrFail(
          "Speech recognition could not start. Please try again or use the buttons.",
          "start-failed"
        );
      }
    };

    startAttempt();
    return true;
  }
}

export const voiceGuidance = new VoiceGuidance();
voiceGuidance.setNeuralSpeechProvider(getCachedOrGeneratedGuidanceSpeech);
