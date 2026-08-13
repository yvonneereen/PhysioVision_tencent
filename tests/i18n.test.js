import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  getSpeechLocale,
  resolveInitialLocale,
  setLocale,
  SUPPORTED_LANGUAGES,
  translateText,
} from "../i18n.js";

const browserEntrySources = [
  "../index.html",
  "../patient-dashboard.js",
  "../voice-guidance.js",
].map((path) => readFileSync(new URL(path, import.meta.url), "utf8"));
const i18nCacheVersions = browserEntrySources.flatMap((source) =>
  [...source.matchAll(/i18n\.js\?v=(\d+)/g)].map((match) => match[1])
);
assert.ok(
  i18nCacheVersions.length >= 3,
  "the browser entry points should declare their shared i18n module"
);
assert.deepEqual(
  [...new Set(i18nCacheVersions)],
  ["35"],
  "all browser entry points must use one i18n URL so only one DOM observer is created"
);

const initialLiveGuideMarkup = browserEntrySources[0].slice(
  browserEntrySources[0].indexOf('<div id="patientPracticeWorkspace"'),
  browserEntrySources[0].indexOf('class="exercise-library-section"')
);
const initialLiveGuideText = [
  ...initialLiveGuideMarkup.matchAll(/>([^<>]+)</gs),
].map((match) => match[1].replace(/\s+/g, " ").trim()).filter(
  (text) => /[A-Za-z]/.test(text) && !text.startsWith("<!--")
);
const initialLiveGuideAttributes = [
  ...initialLiveGuideMarkup.matchAll(
    /(?:aria-label|placeholder|title)="([^"]+)"/g
  ),
].map((match) => match[1]);

const initialLiveGuideSources = new Set([
  ...initialLiveGuideText,
  ...initialLiveGuideAttributes,
]);
const allowedSharedLocalizedWords = {
  "zh-SG": new Set(),
  "ms-SG": new Set(["Edit"]),
  "ta-SG": new Set(),
};
for (const locale of ["zh-SG", "ms-SG", "ta-SG"]) {
  for (const source of initialLiveGuideSources) {
    if (allowedSharedLocalizedWords[locale].has(source)) continue;
    assert.notEqual(
      translateText(source, locale),
      source,
      `${locale} is missing initial live-guide copy for: ${source}`
    );
  }
}

const voiceConsumerSources = [
  "../main.js",
  "../agent-chat.js",
  "../patient-dashboard.js",
]
  .map((path) => readFileSync(new URL(path, import.meta.url), "utf8"));
const voiceCacheVersions = voiceConsumerSources.flatMap((source) =>
  [...source.matchAll(/voice-guidance\.js\?v=(\d+)/g)].map((match) => match[1])
);
assert.deepEqual(
  [...new Set(voiceCacheVersions)],
  ["44"],
  "all voice consumers must share one voice-guidance module instance"
);

assert.equal(
  resolveInitialLocale({ browserLocale: "zh-CN" }),
  "en-SG",
  "a phone's browser language must not silently change the website language"
);
assert.equal(
  resolveInitialLocale({ storedLocale: "zh-SG", explicitlyChosen: false }),
  "en-SG",
  "legacy or automatically derived preferences must reset to English"
);
assert.equal(
  resolveInitialLocale({ storedLocale: "zh-SG", explicitlyChosen: true }),
  "zh-SG",
  "an explicit language selection should still be remembered"
);

assert.deepEqual(
  SUPPORTED_LANGUAGES.map(({ code }) => code),
  ["en-SG", "zh-SG", "ms-SG", "ta-SG"],
  "the selector should prioritize Singapore's four official languages"
);

setLocale("zh-SG", { persist: false, announce: false });
assert.equal(getSpeechLocale(), "zh-CN");
assert.equal(translateText("Text size"), "文字大小");
assert.equal(translateText("Extra large"), "特大");
assert.equal(translateText("Start camera guide"), "开始摄像头指导");
assert.equal(translateText("Guide speed"), "指导语速");
assert.equal(translateText("Slower"), "较慢");
assert.equal(translateText("Rep 3."), "第3次。");
assert.equal(
  translateText(
    "Rep 10. You’re done with Half Squats. Your next exercise is Calf Raises."
  ),
  "第10次。您已完成半蹲。下一个运动是提踵。"
);
assert.equal(translateText("7 of 10 repetitions"), "完成7次，共10次");
assert.equal(
  translateText(
    "Your target is 10 repetitions. I will say when all 10 have been counted. Keep your full body visible until then."
  ),
  "您的目标是10次。当10次全部计数后，我会告诉您。在此之前，请确保全身保持在画面内。"
);
for (const locale of ["zh-SG", "ms-SG", "ta-SG"]) {
  for (const source of [
    "7 of 10 repetitions",
    "Your target is 10 repetitions. I will say when all 10 have been counted. Keep your full body visible until then.",
    "Your target is 30 seconds of tracked hold time. I will say when the target has been counted. Keep every required joint visible until then.",
    "Final repetition. Stand tall and hold still until I say the exercise is complete.",
    "Final repetition — stand tall and hold still",
    "Final repetition: stand tall, stay fully visible, and hold still until it is counted.",
    "I counted 9 of 10 repetitions. The exercise is paused and has not been marked finished. Keep your full body visible and resume for any repetitions that were not counted.",
    "Exercise target reached",
    "Would you like me to finish this exercise and start your check-in? Say yes or no.",
    "Yes, finish and check in",
    "Not yet",
    "Waiting for your answer. Say yes or no, or use a button.",
    "Okay. I will leave the exercise open. Choose Finish exercise and check in when you are ready.",
    "You said yes. The exercise is marked finished and your check-in is ready.",
    "Rep 10. You’re done with Half Squats. Your next exercise is Calf Raises.",
    "To pause for a rest without returning to your device, say Hey Guide, I need a rest.",
    "Your camera guide is paused for a rest. Your recognized repetitions are kept. Select Resume camera guide when you are ready to continue.",
    "Camera tracking and AI questions are active together. Say “Hey Guide” to ask something, or say “Hey Guide, I need a rest” to pause. Choose Finish exercise and check in when done.",
  ]) {
    assert.notEqual(
      translateText(source, locale),
      source,
      `${locale} should translate the live camera target`,
    );
  }
}
assert.equal(
  translateText(
    "Rep 10. You reached your goal of 10 repetitions. Stop squatting now, stand tall, and rest. Choose Finish exercise when you are ready."
  ),
  "第10次。您已达到10次的目标。现在停止下蹲，站直并休息。准备好后选择“结束运动”。"
);
assert.equal(
  translateText(
    "Rep 10. You’re done with Half Squats. Your next exercise is Calf Raises. Choose Finish exercise and check in, then select Calf Raises."
  ),
  "第10次。您已完成半蹲。下一个运动是提踵。请选择“结束运动并进行检查”，然后选择提踵。"
);
for (const locale of ["zh-SG", "ms-SG", "ta-SG"]) {
  for (const completionMessage of [
    "You’re done with Half Squats. Your next exercise is Calf Raises. Choose Finish exercise and check in, then select Calf Raises.",
    "You’re done with Half Squats. There are no more exercises in this planned session. Choose Finish exercise and check in. Today’s exercise session is done.",
  ]) {
    assert.notEqual(
      translateText(completionMessage, locale),
      completionMessage,
      `${locale} should translate planned-session completion guidance`,
    );
  }
}
assert.equal(translateText("Better shoulder movement"), "改善肩部活动");
assert.equal(translateText("Shoulder pendulum"), "肩部钟摆运动");
assert.equal(translateText("First measurement"), "首次测量");
assert.equal(
  translateText(
    "Comparing Half Squats on the right side only · 2 real camera measurements"
  ),
  "仅比较半蹲的右侧 · 2次真实摄像头测量"
);
for (const locale of ["zh-SG", "ms-SG", "ta-SG"]) {
  for (const source of [
    "Your first real movement measurement is recorded",
    "This camera-measured result is shown now. Repeat the same exercise on the same side to begin comparing change.",
    "Your preliminary direction is improving",
    "This comparison uses two real sessions. Complete the same exercise on the same side once more to establish the three-session trend.",
    "Comparing Half Squats on the right side only · 2 real camera measurements",
  ]) {
    assert.notEqual(
      translateText(source, locale),
      source,
      `${locale} should translate real-session trend copy`,
    );
  }
}
for (const locale of ["zh-SG", "ms-SG", "ta-SG"]) {
  for (const source of [
    "Better shoulder movement",
    "Improve comfortable shoulder and arm mobility",
    "Shoulder mobility",
    "Shoulder pendulum",
  ]) {
    assert.notEqual(
      translateText(source, locale),
      source,
      `${source} should be translated for ${locale}`
    );
  }
}
assert.equal(
  translateText("A patient-specific note that has no bundled translation"),
  "A patient-specific note that has no bundled translation",
  "untranslated clinical or user-authored text must never disappear"
);
assert.equal(
  translateText("I heard that your pain is 7 out of 10. Is that correct?"),
  "我听到您的疼痛程度是10分中的7分。正确吗？"
);
assert.equal(
  translateText(
    "Thank you. I will ask a few short questions to help check whether it is safe for you to proceed. Please stop moving and rest somewhere safe. Where are you feeling the pain?"
  ),
  "谢谢。我会问几个简短的问题，以确认您是否适合继续。请停止动作，并在安全的地方休息。 您哪里感到疼痛？"
);

const liveGuideSources = [
  "Hands-free mode asks for microphone permission. The exact approved guidance text may be sent securely to Gemini to generate a clearer, more natural voice. Voice recognition may be processed by your browser provider. If fixed safety rules cannot match an answer, the recognized text may be sent to Gemini for constrained language interpretation. During the live camera guide, speech that begins with “Hey Guide” and the question that follows are sent to Gemini for an answer. Gemini cannot change the safety wording or decide whether exercise is safe. Use the on-screen buttons to avoid voice generation and recognition.",
  "Your camera feed is processed for movement guidance and is not recorded in this prototype.",
  "Local possible-fall check available",
  "The camera check is available. Verify an emergency contact in My profile before automatic alerts can be sent.",
  "Face the camera and step back until one complete hip, knee, and ankle line is visible. Keep the chair beside you and both feet in view.",
  "Keep both feet flat and keep the chair beside you. Bend both knees and hips slowly as if sitting back toward the chair, only as far as comfortable, then stand tall to complete one repetition. Begin now.",
  "AI questions will be ready after camera setup is complete.",
  "Let me check.",
  "Personalized movement recognition is ready.",
  "Listen to the complete start instruction. Rep counting and Hey Guide will begin afterward.",
  "Starting position confirmed.",
  "Hold your standing position with your full body visible.",
  "Move into a comfortable squat position.",
  "Tracking reps from your right side",
  "Rep tracking is working from your left side. Keep moving slowly and follow the phase prompt.",
  "I cannot measure your right knee angle. Step farther back or turn slightly until one complete hip, knee, and ankle line is visible. Keep the chair beside you, not in front of the visible leg.",
  "I cannot measure a complete leg angle. Step farther back or turn slightly until one complete hip, knee, and ankle line is visible. Keep the chair beside you, not in front of the visible leg.",
  "Bend your knees slowly and move your hips back as if starting to sit. Lower only a little and keep your heels flat.",
  "Press through your whole feet and slowly stand tall. Use the chair only for balance.",
  "I cannot measure a complete knee angle. Step farther back or turn slightly until one hip, knee, and ankle line is visible. Keep the chair beside you, not in front of the visible leg.",
  "I cannot measure a complete hip angle. Reposition until one shoulder, hip, knee, and ankle line is visible from head to foot.",
  "Keep every required joint visible so I can guide you safely.",
  "Hold reset — keep the required joints visible to restart",
  "Hold reset — return to the target position to restart",
  "Hold reset — return to the stretch to restart",
  "Your hold was reset because tracking was lost. Return to the stretch and keep your full body visible.",
  "I can’t see you. Please return to the marked area.",
  "Step back and keep your full body visible.",
  "Close-up camera check",
  "Hand and wrist tracking",
  "Loading model…",
  "Use this before a hand exercise. Bring one complete hand close to the camera; full-body framing is usually too far away.",
  "Check hand tracking",
  "Detected side",
  "Image coverage",
  "Palm direction",
  "Pause camera guide",
  "Finish exercise and check in",
  "Stopping the camera does not mark an exercise as finished.",
  "Technical movement details",
  "Left knee",
  "Knee L/R difference",
  "Ready",
  "Show one complete hand to the camera",
  "Hand landmarks are clear",
  "Starting camera…",
  "Pausing only stops the camera. Choose “Finish exercise and check in” when you decide you are done.",
  "The movement-tracking model is unavailable",
  "The hand-tracking model is unavailable",
  "Floor exercise: visibility check active",
  "Possible-fall check unavailable for this movement",
  "Checking your account…",
  "Create your exercise plan first.",
  "The camera guide is not available for this account or pathway",
  "Tracking the hand-shape sequence",
  "Camera paused because the exercise changed",
  "Automatic session position check",
  "Personal range saved automatically — movement guide ready",
  "Your measured joint angles are saved automatically and will help the guide recognize your comfortable movement range. Safety limits are unchanged.",
  "This movement is not in your active prescription",
  "This movement is not in your accepted AI plan",
  "Choose one of the movements in your accepted AI wellness plan",
  "The server could not register this alert. No automatic contact notification is available.",
  "No automatic contact alert was sent",
  "Exercise stopped for a safety check",
  "The possible fall was marked as a false alarm. Take a moment before deciding whether to exercise again.",
  "Registering the safety countdown with the server…",
  "Pain check ready — please answer",
  "Pain question ready. Answer aloud or choose a number to continue.",
  "Rest for a few seconds before the next question.",
  "Your safety check is complete",
  "Saving this safety check. The camera remains paused.",
  "Exercise paused after pain safety check",
  "Camera stopped — finishing exercise",
  "Exercise marked finished",
];

for (const locale of ["zh-SG", "ms-SG", "ta-SG"]) {
  for (const source of liveGuideSources) {
    assert.notEqual(
      translateText(source, locale),
      source,
      `${locale} is missing a live-guide translation for: ${source}`
    );
  }
}

assert.equal(
  translateText(
    "Face the camera and step back until one complete hip, knee, and ankle line is visible. Keep the chair beside you and both feet in view.",
    "zh-SG"
  ),
  "面向摄像头并后退，直到一侧髋部、膝盖和脚踝的完整轮廓可见。将椅子放在身旁，并确保双脚入镜。"
);
assert.equal(
  translateText("Hand and wrist tracking", "zh-SG"),
  "手部和手腕追踪"
);
assert.equal(
  translateText("Finish exercise and check in", "zh-SG"),
  "结束运动并进行检查"
);

const dashboardSources = [
  "Review your physiotherapist-assigned plan, start approved exercises and follow your progress.",
  "Specialist-assigned programme",
  "Approved movement guidance",
  "Progress and pain trends",
  "Prototype sample",
  "Example: early rehabilitation after total knee replacement. These sample doses are interface data, not instructions for a real patient.",
  "Prototype display programme—not a personal prescription",
  "This sample shows an early total-knee-replacement rehabilitation pathway. A real patient must follow their own surgeon and physiotherapist’s instructions.",
  "Physiotherapist support",
  "Talk to a professional whenever you choose.",
  "Booking is always available—you do not need to wait for a warning from the AI.",
  "Book a consultation",
  "Consultation",
  "Request consultation",
  "No consultation currently scheduled.",
  "We are loading the exercises available for your care pathway.",
  "Complete guided sessions and pain check-ins to begin your trend.",
  "Early indicators only. The final clinical trend criteria are still being validated and will remain separate from AI interpretation.",
  "Which type of exercise support are you using?",
  "I have a physiotherapist-assigned plan",
  "I am here for general wellness",
  "No self-guided plan has been created. Review your safety-screen answers before using general-wellness exercises.",
  "Start with your AI movement companion",
  "Ready for an AI draft",
  "Create and review your AI plan",
  "Plan refresh needed",
  "Create a new AI wellness plan",
  "Your accepted AI wellness plan uses reviewed, camera-trackable exercises.",
  "Pause your wellness plan and seek professional advice",
  "Ask my physiotherapist to review",
  "Your physiotherapist suggested a consultation",
  "No messages yet. Say hello or ask a question.",
  "Request sent. The physiotherapist will confirm the appointment.",
  "Request a physiotherapist? This pauses your self-guided wellness plan and shares your recent history with the care team.",
  "Leg Strength and Ankle Balance",
  "Leg Strength & Ankle Balance",
  "Hip Stability and Balance",
  "Hip Stability & Balance",
  "Lower Body Balance Combo",
  "Total Balance and Support",
  "Half squats",
  "Calf raises",
  "Standing hip abduction",
  "Mon",
  "Wed",
  "Sat",
  "Ask your AI",
  "A gentle 3-day wellness routine designed to support your balance using a chair for steady support.",
  "The draft uses only reviewed exercises compatible with your answers and available equipment.",
  "Every session still requires your review, and you should stop if a movement causes pain or concerning symptoms.",
  "Confirmed the general-wellness safety screen is eligible.",
  "Applied the recovered-history caution: lower-load movements, one movement per session and a fixed single-set dose.",
  "Filtered the reviewed catalogue to 7 compatible exercises.",
  "Validated every exercise and session against fixed application limits.",
];

for (const locale of ["zh-SG", "ms-SG", "ta-SG"]) {
  for (const source of dashboardSources) {
    assert.notEqual(
      translateText(source, locale),
      source,
      `${locale} is missing a patient-dashboard translation for: ${source}`
    );
  }
}

assert.equal(
  translateText(
    "A gentle 3-day wellness routine designed to support your balance using a chair for steady support.",
    "zh-SG"
  ),
  "一个温和的三天健康运动计划，旨在通过稳固椅子的辅助来支持您的平衡。"
);
assert.equal(
  translateText("Lower Body Balance Combo", "zh-SG"),
  "下肢平衡组合"
);
assert.equal(
  translateText(
    "I cannot measure your right knee angle. Step farther back or turn slightly until one complete hip, knee, and ankle line is visible. Keep the chair beside you, not in front of the visible leg.",
    "zh-SG"
  ),
  "我无法测量您的右膝角度。请向后退或稍微转身，直到一侧髋部、膝盖和脚踝的完整轮廓可见。请将椅子放在身旁，不要挡住可见的腿。"
);
assert.equal(
  translateText("2 sets × 10 reps · 3 days/week", "zh-SG"),
  "2组 × 10次 · 每周3天"
);
assert.equal(
  translateText("1 set × 6–10 reps · 3 days/week", "zh-SG"),
  "1组 × 6–10次 · 每周3天"
);
assert.equal(
  translateText(
    "2 sets × 10 reps · hold 5s · 3 days/week · prescribed by Dr Tan",
    "zh-SG"
  ),
  "2组 × 10次 · 保持5秒 · 每周3天 · 由Dr Tan开具"
);
assert.equal(
  translateText(
    "Camera setup will begin automatically in 2 seconds. You can cancel below.",
    "zh-SG"
  ),
  "摄像头设置将在2秒后自动开始。您可以在下方取消。"
);
assert.equal(
  translateText("Guidance for Mei", "zh-SG"),
  "Mei的个性化指导"
);
assert.equal(
  translateText("Camera error: permission denied", "zh-SG"),
  "摄像头错误：permission denied"
);
assert.equal(
  translateText("Half squats · Calf raises · 10 min", "zh-SG"),
  "半蹲 · 提踵 · 10分钟",
  "legacy saved plan exercise lists and durations should still translate"
);
assert.equal(
  translateText("Half squats · Calf raises · 1 set of 6–10 repetitions", "zh-SG"),
  "半蹲 · 提踵 · 1组，每组6–10次",
  "new wellness-plan dosage should translate as structured data"
);
assert.equal(
  translateText(
    "A gentle 4-day balance and lower-body stability routine designed for Mei using a chair for support.",
    "zh-SG"
  ),
  "为Mei设计的温和4天平衡与下肢稳定训练，并使用椅子辅助。",
  "personalized plan summaries should retain the user's name while translating"
);
assert.equal(
  translateText("Half squats · Calf raises · 10 min", "ms-SG"),
  "Separuh cangkung · Angkat tumit · 10 minit"
);
assert.equal(
  translateText("Half squats · Calf raises · 10 min", "ta-SG"),
  "அரை குந்துதல் · குதிகால் உயர்த்துதல் · 10 நிமிடம்"
);
assert.equal(
  translateText(
    "Detailed plan assigned by Dr Tan. Follow these doses and notes exactly.",
    "ms-SG"
  ),
  "Pelan terperinci ditetapkan oleh Dr Tan. Ikuti dos dan nota ini dengan tepat."
);

setLocale("ms-SG", { persist: false, announce: false });
assert.equal(getSpeechLocale(), "ms-MY");
assert.equal(translateText("Choose text size"), "Pilih saiz teks");
assert.equal(translateText("I need help"), "Saya perlukan bantuan");

setLocale("ta-SG", { persist: false, announce: false });
assert.equal(getSpeechLocale(), "ta-IN");
assert.equal(translateText("Large"), "பெரியது");
assert.equal(translateText("Call 995 now"), "இப்போது 995-ஐ அழைக்கவும்");

setLocale("en-SG", { persist: false, announce: false });
assert.equal(translateText("Start camera guide"), "Start camera guide");

console.log("internationalization tests passed");
