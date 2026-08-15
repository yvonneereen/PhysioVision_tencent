import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync(new URL("../main.js", import.meta.url), "utf8");
const markup = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
const styles = fs.readFileSync(new URL("../style.css", import.meta.url), "utf8");
const therapistSource = fs.readFileSync(
  new URL("../therapist.js", import.meta.url),
  "utf8"
);

assert.match(
  markup,
  /class="feedback-symbol" aria-hidden="true">●<\/span>[\s\S]*?class="feedback-title">Get into position<\/strong>[\s\S]*?class="feedback-detail">Live guidance appears here<\/span>/,
  "live guidance should use separately styled icon, title and detail elements"
);
assert.match(
  source,
  /querySelector\("\.feedback-title"\)[\s\S]*?querySelector\("\.feedback-detail"\)/,
  "live guidance updates should target the explicit copy elements"
);
assert.match(
  styles,
  /\.feedback-banner\s*\{[\s\S]*?display: grid;[\s\S]*?grid-template-columns: 38px minmax\(0, 1fr\);[\s\S]*?overflow: hidden;/,
  "the guidance banner should isolate its badge from wrapping copy"
);
assert.match(
  styles,
  /\.feedback-detail\s*\{[\s\S]*?color: #3d6d53;[\s\S]*?overflow-wrap: break-word;/,
  "guidance detail should use readable dark text and safe word wrapping"
);
assert.match(
  styles,
  /\.patient-practice-active #practice > \.practice-guide-heading\s*\{[\s\S]*?grid-template-columns: minmax\(0, 1\.56fr\) minmax\(320px, 0\.6fr\);[\s\S]*?\.practice-guide-heading > span:last-child\s*\{[\s\S]*?grid-column: 1;[\s\S]*?justify-self: center;/,
  "the live-guide heading should be centered over the camera column"
);
assert.doesNotMatch(
  markup,
  /patientBackToDashboard|Back to my home/,
  "the exercise workspace should not render a redundant back-to-home control"
);
assert.match(
  styles,
  /\.modal-shell\s*\{[\s\S]*?visibility: hidden;[\s\S]*?pointer-events: none;/,
  "closed full-screen modal shells must not intercept page clicks"
);
assert.match(
  styles,
  /\.modal-shell\.is-open\s*\{[\s\S]*?visibility: visible;[\s\S]*?pointer-events: auto;/,
  "only an open modal shell should accept pointer input"
);
assert.match(
  styles,
  /\.voice-setup-overlay\s*\{[\s\S]*?display: flex;[\s\S]*?align-items: flex-start;[\s\S]*?overflow-y: auto;[\s\S]*?overscroll-behavior: contain;/,
  "the response-mode dialog should remain vertically scrollable at enlarged text sizes"
);
assert.match(
  styles,
  /\.voice-setup-dialog\s*\{[\s\S]*?flex: 0 0 auto;[\s\S]*?margin: auto 0;[\s\S]*?overflow-wrap: anywhere;/,
  "the response-mode dialog should safely center without clipping oversized content"
);
assert.match(
  styles,
  /\.stage:not\(\.camera-active\) > \.setup-tip\s*\{[\s\S]*?visibility: hidden;[\s\S]*?opacity: 0;/,
  "the live camera tip must not cover setup instructions before the camera starts"
);
assert.match(
  markup,
  /id="cameraRepProgress"[\s\S]*?role="status"[\s\S]*?aria-atomic="true"[\s\S]*?>0 of 10 repetitions<\/div>/,
  "the recognized repetition count and target should remain inside the camera view"
);
assert.match(
  styles,
  /\.camera-rep-progress\s*\{[\s\S]*?position: absolute;[\s\S]*?z-index: 3;[\s\S]*?\.camera-rep-progress\.is-complete/,
  "the camera count should be an always-visible overlay with a clear completed state"
);
assert.match(
  markup,
  /id="exerciseCompletionPrompt"[\s\S]*?id="exerciseCompletionConfirm"[\s\S]*?Yes, finish and check in[\s\S]*?id="exerciseCompletionNotYet"[\s\S]*?Not yet/,
  "a recognized target should offer explicit finish and not-yet choices"
);
assert.match(
  markup,
  /id="earlyStopPrompt"[\s\S]*?Can you tell me what made you stop\?[\s\S]*?data-stop-reason="pain"[\s\S]*?data-stop-reason="tired"[\s\S]*?data-stop-reason="dizzy"[\s\S]*?data-stop-reason="breathless"[\s\S]*?data-stop-reason="exercise_difficulty"/,
  "an early finish should offer the fixed stop-reason choices"
);
assert.match(
  source,
  /function shouldAskEarlyStopReason\([\s\S]*?!exerciseSessionActive \|\| goalMetric\(engine\.exercise\)\.isHold[\s\S]*?progress\.repetitionsMinimum[\s\S]*?!progress\.reachedMinimum/,
  "the stop-reason question should apply only to unfinished repetition doses"
);
assert.match(
  source,
  /function finishExerciseAndCheckIn\([\s\S]*?if \(!stopReason && shouldAskEarlyStopReason\(\)\)[\s\S]*?beginEarlyStopReasonPrompt\(\)[\s\S]*?pendingEarlyStopReason = stopReason;[\s\S]*?completeExerciseSession\(\)/,
  "finishing below the minimum should stop before saving and ask for a reason"
);
assert.match(
  source,
  /function currentSessionDoseProgress\([\s\S]*?minimumRepetitionsPerSet\(dose\)[\s\S]*?currentSetReps >= repetitionsMinimum/,
  "a ranged prescription should use its lower repetition bound for completion"
);
assert.match(
  source,
  /reason === "dizzy" \|\| reason === "breathless"[\s\S]*?deferCheckin: true[\s\S]*?renderEarlyStopSafetyOutcome/,
  "dizziness and breathlessness should enter fixed safety instructions before the optional check-in"
);
assert.match(
  styles,
  /\.exercise-completion-prompt\s*\{[\s\S]*?\.exercise-completion-choices\s*\{[\s\S]*?grid-template-columns/,
  "the completion question should remain prominent and provide large choices"
);
assert.match(
  styles,
  /\.early-stop-prompt\s*\{[\s\S]*?\.early-stop-reason-choices\s*\{[\s\S]*?grid-template-columns/,
  "the early-stop question should use prominent, large reason controls"
);
assert.match(
  styles,
  /@media \(max-width: 900px\)[\s\S]*?\.patient-practice-workspace \.camera-column\s*\{[\s\S]*?min-height: 0;[\s\S]*?overflow: visible;[\s\S]*?\.patient-practice-workspace \.stage\s*\{[\s\S]*?flex: 0 0 auto;[\s\S]*?min-height: 680px;[\s\S]*?\.patient-practice-workspace \.camera-placeholder\s*\{[\s\S]*?overflow-y: auto;/,
  "the mobile camera stage should expand and remain scrollable instead of clipping its primary action"
);
assert.match(
  styles,
  /@media \(max-width: 640px\)[\s\S]*?\.patient-practice-workspace \.camera-placeholder\s*\{[\s\S]*?padding: 104px 16px 44px;[\s\S]*?\.patient-practice-workspace \.position-guide\s*\{[\s\S]*?transform: scale\(0\.62\);/,
  "the portrait phone setup should compact its guide while retaining the camera action"
);
assert.match(
  styles,
  /@media \(max-width: 900px\) and \(max-height: 600px\) and \(orientation: landscape\)[\s\S]*?grid-template-columns: minmax\(150px, 0\.65fr\) minmax\(280px, 1fr\);/,
  "the landscape phone setup should place its guide and primary action side by side"
);
assert.match(
  styles,
  /\.patient-practice-active \.agent-chat-launcher\s*\{[\s\S]*?width: 56px;[\s\S]*?height: 56px;[\s\S]*?font-size: 0;/,
  "the mobile AI launcher should collapse to an icon so it cannot cover camera controls"
);
assert.match(
  source,
  /voiceSetupOverlay\.classList\.remove\("hidden"\);\s*voiceSetupOverlay\.scrollTop = 0;/,
  "each response-mode choice should open at the start of its scrollable content"
);

function functionSource(name, nextName) {
  const start = source.indexOf(`function ${name}(`);
  const end = source.indexOf(`function ${nextName}(`, start + 1);
  assert.notEqual(start, -1, `${name} should exist`);
  assert.notEqual(end, -1, `${nextName} should follow ${name}`);
  return source.slice(start, end);
}

const deactivateSource = functionSource(
  "deactivateCameraGuide",
  "startHandPreview"
);

const practiceAccessSource = functionSource(
  "syncPracticeAccess",
  "hasLivePracticeAccess"
);
assert.doesNotMatch(
  practiceAccessSource,
  /ensureMovementModels\(\)/,
  "opening an eligible dashboard must not initialize the movement models"
);

const activateGuideSource = functionSource(
  "activateCameraGuide",
  "deactivateCameraGuide"
);
assert.match(
  activateGuideSource,
  /await ensureMovementModels\(engine\.exercise\)/,
  "only the current exercise's movement models should load from the explicit camera action"
);
const modelLoaderSource = functionSource(
  "ensureMovementModels",
  "syncPracticeAccess"
);
assert.match(
  modelLoaderSource,
  /const needsPose = trackingMode !== TRACKING_MODES\.HAND[\s\S]*?const needsHand = \[TRACKING_MODES\.HAND, TRACKING_MODES\.POSE_AND_HAND\][\s\S]*?if \(needsPose && !poseLandmarker\) loaders\.push\(createPoseLandmarker\(\)\)[\s\S]*?if \(needsHand && !handLandmarker\) loaders\.push\(createHandLandmarker\(\)\)/,
  "pose and hand models should load independently according to the exercise tracking mode"
);
const poseModelSource = functionSource(
  "createPoseLandmarker",
  "createHandLandmarker"
);
assert.doesNotMatch(
  poseModelSource,
  /HandLandmarker\.createFromOptions/,
  "a pose-only exercise must not initialize the hand model"
);
const handPreviewSource = functionSource(
  "startHandPreview",
  "stopHandPreview"
);
assert.match(
  handPreviewSource,
  /ensureMovementModels\(null, \{ handPreview: true \}\)/,
  "the optional close-up hand check should request only the hand model"
);
const startCameraSource = functionSource("startCamera", "stopCamera");
assert.match(
  startCameraSource,
  /width: \{ ideal: 640, max: 640 \}[\s\S]*?height: \{ ideal: 480, max: 480 \}[\s\S]*?frameRate: \{ ideal: 15, max: 20 \}/,
  "camera capture should be bounded to a practical resolution and frame rate"
);
assert.match(
  source,
  /const CAMERA_INFERENCE_FPS = 15;[\s\S]*?const CAMERA_INFERENCE_INTERVAL_MS = 1000 \/ CAMERA_INFERENCE_FPS;/,
  "movement inference should have an explicit 15 FPS processing budget"
);
const renderFrameSource = functionSource("renderFrame", "plannedSetCount");
assert.match(
  renderFrameSource,
  /frameTimestamp - lastInferenceStamp >= CAMERA_INFERENCE_INTERVAL_MS[\s\S]*?video\.currentTime !== lastVideoTime && inferenceDue/,
  "animation frames should skip MediaPipe inference until the processing interval is due"
);
assert.match(
  activateGuideSource,
  /resetCameraInferenceClock\(\)/,
  "each new camera session should reset the throttled inference clock"
);
assert.match(
  source,
  /visibilitychange[\s\S]*?document\.hidden[\s\S]*?deactivateCameraGuide/,
  "an active camera guide should pause when its browser tab becomes hidden"
);
assert.match(
  markup,
  /id="movementAiStatus"[\s\S]*?AI voice questions start with the camera guide/,
  "AI question status should be part of the camera session rather than a separate action"
);
assert.match(
  markup,
  /id="guideAudioSource"[\s\S]*?id="guideAudioSourceValue"[\s\S]*?Text only/,
  "the camera guide should disclose whether audio is prepared, cached, live, or text only"
);
assert.doesNotMatch(
  markup,
  /id="askMovementGuide"/,
  "the integrated camera guide should not require a separate Ask AI button"
);
assert.match(
  activateGuideSource,
  /setIntegratedCameraGuideActive\(true\)/,
  "the camera guide should take ownership of the AI interface when it starts"
);
assert.match(
  source,
  /function deactivateCameraGuide[\s\S]*?setIntegratedCameraGuideActive\(false\)/,
  "pausing the camera should restore the standalone AI interface"
);
assert.match(
  styles,
  /\.camera-guide-ai-active \.agent-chat-launcher,[\s\S]*?\.camera-guide-ai-active \.agent-chat-panel/,
  "the separate chat launcher and panel should be hidden during integrated guidance"
);
assert.match(
  source,
  /function startMovementAiGuide\([\s\S]*?scheduleMovementAiWakeListening/,
  "starting the camera guide should start its wake-phrase listener"
);
assert.match(
  source,
  /function scheduleMovementAiWakeListening\(\s*delayMs = 100[\s\S]*?interimSilenceMs: 350/,
  "Hey Guide should restart quickly and act on a completed phrase after a short silence"
);
assert.match(
  activateGuideSource,
  /announceExerciseInstruction\("", \{ onEnd: startMovementAiGuide \}\)[\s\S]*?startMovementAiGuide\(\)/,
  "AI listening should begin from the same successful camera-start flow after its spoken introduction"
);
assert.match(
  source,
  /MOVEMENT_AI_WAKE_PATTERN[\s\S]*?Hey Guide[\s\S]*?parseMovementAiWakePhrase/,
  "the integrated guide should require a clear wake phrase before sending a question"
);
assert.match(
  source,
  /sendAgentMessage\(cleanedQuestion, context\)/,
  "uncoded guide questions should use the authenticated AI endpoint with movement context"
);
assert.match(
  source,
  /Let me check\.[\s\S]*?sendAgentMessage\(cleanedQuestion, context\)[\s\S]*?await acknowledgement/,
  "Hey Guide should acknowledge a recognized question before waiting for the AI answer"
);
assert.match(
  source,
  /\(\?:guide\|guy\|guys\)/,
  "the wake phrase should tolerate common speech-recognition variants of Guide"
);
const feedbackPanelSource = functionSource(
  "updateFeedbackPanel",
  "updateDebugPanel"
);
assert.match(
  feedbackPanelSource,
  /const fb = engine\.update\(angles, timestampMs\)/,
  "camera measurements should continue advancing the movement engine"
);
assert.doesNotMatch(
  feedbackPanelSource,
  /movementAiConversationActive\(\)/,
  "asking Hey Guide must not freeze repetition or phase progression"
);
const resumeMovementAiSource = functionSource(
  "resumeMovementAiAfterSpeech",
  "speakMovementAiMessage"
);
assert.match(
  resumeMovementAiSource,
  /spokenCoachingCandidate = null/,
  "resuming the wake listener should discard only stale movement-cue timing"
);
assert.doesNotMatch(
  resumeMovementAiSource,
  /resetSpokenCoaching\(\)|spokenRepCount\s*=\s*0|combinedPoseHistory\s*=|smoother\.state\s*=/,
  "resuming the wake listener must preserve rep and continuous tracking state"
);
assert.doesNotMatch(
  functionSource("beginMovementAiQuestion", "answerMovementAiQuestion"),
  /clearHoldTimer\(/,
  "asking the AI must not stop a valid tracked hold"
);
const voiceRestSource = functionSource(
  "pauseMovementGuideForRest",
  "answerMovementAiQuestion"
);
assert.match(
  voiceRestSource,
  /deactivateCameraGuide\(\)/,
  "a vocal rest request should use the existing camera pause path"
);
assert.doesNotMatch(
  voiceRestSource,
  /resetExerciseProgressForNewSession|discardExerciseSession|completeExerciseSession/,
  "a vocal rest must preserve recognized repetitions and leave the exercise unfinished"
);
assert.match(
  voiceRestSource,
  /say Hey Guide, continue[\s\S]*?scheduleRestResumeVoiceListening/,
  "a vocal rest should tell the user how to resume without returning to the device"
);
const voiceRestResumeSource = functionSource(
  "startRestResumeVoiceListening",
  "pauseMovementGuideForRest"
);
assert.match(
  voiceRestResumeSource,
  /parseMovementAiWakePhrase\(transcript, alternatives\)[\s\S]*?isMovementResumeRequest\(wake\.question\)[\s\S]*?resumeMovementGuideAfterRest\(generation\)/,
  "Hey Guide continue should resume only from the dedicated rest listener"
);
const resumeAfterRestSource = functionSource(
  "resumeMovementGuideAfterRest",
  "startRestResumeVoiceListening"
);
assert.match(
  resumeAfterRestSource,
  /activateCameraGuide\(\{ announceInstruction: false \}\)/,
  "voice resume should reopen the existing camera session without replaying movement instructions"
);
assert.doesNotMatch(
  resumeAfterRestSource,
  /resetExerciseProgressForNewSession|discardExerciseSession|completeExerciseSession/,
  "voice resume must not clear repetitions or complete the exercise"
);
const answerMovementAiSource = functionSource(
  "answerMovementAiQuestion",
  "startMovementAiWakeListening"
);
assert.match(
  answerMovementAiSource,
  /isMovementRestRequest\(cleanedQuestion\)[\s\S]*?pauseMovementGuideForRest\(\)[\s\S]*?return;/,
  "Hey Guide rest requests should be handled locally and stop before the AI call"
);
assert.ok(
  answerMovementAiSource.indexOf("isMovementRestRequest(cleanedQuestion)")
    < answerMovementAiSource.indexOf("sendAgentMessage(cleanedQuestion, context)"),
  "the deterministic rest command must run before any request is sent to the AI"
);
assert.doesNotMatch(
  functionSource("renderFrame", "plannedSetCount"),
  /pendingSetStartCheck\)[\s\S]{0,120}!movementAiConversationActive\(\)/,
  "next-set position tracking should continue during an AI conversation"
);
assert.match(
  source,
  /function beginFallSafetyCheck\([\s\S]*?stopMovementAiGuide\(\)[\s\S]*?safetyCheckActive = true/,
  "a possible-fall safety check should preempt the conversational AI listener"
);
assert.match(
  styles,
  /\.movement-ai-status\s*\{[\s\S]*?\.movement-ai-status\[data-state="wake"\]::before/,
  "the camera panel should visibly disclose when wake-phrase listening is active"
);
assert.match(
  styles,
  /\.guide-audio-source\s*\{[\s\S]*?data-source="live_gemini"[\s\S]*?data-source="text_only"/,
  "audio-source diagnostics should visually distinguish live quota use from text-only guidance"
);
assert.match(
  functionSource("speakMovementGuide", "localizedGuidanceParts"),
  /useGeminiVoice = false[\s\S]*?allowGeneratedSpeech = useGeminiVoice[\s\S]*?preferImmediate: !shouldUseGemini[\s\S]*?preferPrepared: shouldUseGemini[\s\S]*?textOnlyOnUnavailable: shouldUseGemini/,
  "fixed movement guidance should use browser speech while preserving an explicit Gemini route"
);
assert.match(
  functionSource("speakMovementAiMessage", "captureMovementAiQuestion"),
  /useGeminiVoice: generated[\s\S]*?allowGeneratedSpeech: generated[\s\S]*?cacheScope: generated \? "personal" : "generic"/,
  "only an unpredictable Hey Guide answer should opt into private live TTS"
);
assert.match(
  source,
  /function exerciseStartGuidance[\s\S]*?Keep both feet flat[\s\S]*?keep the chair[\s\S]*?Bend both knees and hips slowly[\s\S]*?only as far as comfortable/,
  "the automatic squat guide should use clear chair, foot, and knee instructions before movement"
);
assert.match(
  functionSource("exerciseStartGuidance", "resetSpokenCoaching"),
  /Keep both feet flat[\s\S]*?stand tall to complete one repetition\./,
  "the concise squat instruction should explain one complete repetition"
);
assert.match(
  functionSource("exerciseTargetGuidance", "resetSpokenCoaching"),
  /Your target is \$\{metric\.goal\} repetitions[\s\S]*?I will say when all \$\{metric\.goal\} have been counted[\s\S]*?Keep your full body visible/,
  "the start instruction should state the exact recognized-repetition target"
);
assert.match(
  functionSource("announceExerciseInstruction", "setIntegratedCameraGuideActive"),
  /exerciseTargetGuidance\(engine\.exercise\)[\s\S]*?After this instruction, say Hey Guide followed by your question whenever you need help\.[\s\S]*?exerciseStartGuidance\(engine\.exercise\)[\s\S]*?Begin now\.[\s\S]*?movementTrackingPausedForInstruction = true[\s\S]*?movementTrackingPausedForInstruction = false/,
  "the browser guide should restore the August 9 target, help, movement, and start sequence"
);
assert.match(
  functionSource("announceExerciseInstruction", "setIntegratedCameraGuideActive"),
  /handsFreeVoiceEnabled[\s\S]*?say Hey Guide followed by your question whenever you need help/,
  "hands-free startup guidance should use the original Hey Guide introduction"
);
assert.doesNotMatch(
  markup,
  />\s*Take a rest\s*</i,
  "the vocal rest option should not add a duplicate rest button"
);
assert.match(
  functionSource("renderFrame", "plannedSetCount"),
  /movementTrackingPausedForInstruction[\s\S]*?presentInstructionTrackingPause\((?:measurements|angles), frameTimestamp\)[\s\S]*?updateFeedbackPanel/,
  "camera frames should prepare the starting baseline while the start instruction prevents false repetitions"
);
assert.match(
  functionSource("presentInstructionTrackingPause", "renderFrame"),
  /!goalMetric\(engine\.exercise\)\.isHold[\s\S]*?updateFeedbackPanel\(measurements, timestampMs\)/,
  "every repetition exercise should count complete movements during its opening instruction"
);
assert.match(
  functionSource("presentInstructionTrackingPause", "renderFrame"),
  /const feedback = updateFeedbackPanel[\s\S]*?!feedback\.trackingReady[\s\S]*?movementTrackingGuidance\(feedback\)[\s\S]*?return;/,
  "a missing heel or joint should remain visible instead of being hidden by the opening-instruction banner"
);
assert.match(
  functionSource("presentInstructionTrackingPause", "renderFrame"),
  /if \(!engine\.startConfirmed[\s\S]*?engine\.update\(measurements, timestampMs\)/,
  "hold exercises should establish only their starting baseline during setup"
);
assert.match(
  functionSource("queueSpokenMovementCue", "currentCoachingRepetitionNumber"),
  /\["tracking", "visibility"\][\s\S]*?350[\s\S]*?if \(!spoken\) return;[\s\S]*?lastRequestedAt = timestampMs/,
  "a blocked speech channel must not add another long delay before a visibility reminder"
);
assert.match(
  functionSource("cancelRecoveredTrackingCue", "queueSpokenMovementCue"),
  /feedback\?\.trackingReady[\s\S]*?250[\s\S]*?cancelSpokenOutput\(\)/,
  "a recovered heel or joint should cancel an outdated visibility message"
);
assert.match(
  functionSource("announceExerciseInstruction", "setIntegratedCameraGuideActive"),
  /onEnd\?\.\(\);[\s\S]*?processPendingRepAnnouncements\(\)/,
  "wake listening should initialize before a queued early-rep announcement takes priority"
);
assert.match(
  functionSource("processPendingRepAnnouncements", "queueRepAnnouncements"),
  /movementTrackingPausedForInstruction[\s\S]*?priority: true[\s\S]*?interrupt: true/,
  "rep speech should wait for the opening instruction, then interrupt ordinary coaching"
);
assert.match(
  functionSource("speakCameraCoaching", "exerciseSpokenInstruction"),
  /const priority = Boolean\(options\.priority\)[\s\S]*?movementCoachingGeneration[\s\S]*?coachingGeneration !== movementCoachingGeneration/,
  "priority rep speech should invalidate the interrupted coaching callback"
);
assert.match(
  functionSource("renderFrame", "plannedSetCount"),
  /displayAngles[\s\S]*?repTrackingSmoother\.smooth[\s\S]*?updateFeedbackPanel\(angles, frameTimestamp\)/,
  "rep recognition should use its faster movement smoother while display angles stay gentle"
);
assert.match(
  feedbackPanelSource,
  /bannerState = "good";[\s\S]*?bannerCue = "Starting position confirmed\. Begin when you are comfortable\."/,
  "the first-rep reminder should remain short and on-screen instead of repeating spoken instructions"
);
assert.doesNotMatch(
  feedbackPanelSource,
  /bannerCue = exerciseStartGuidance/,
  "live coaching must not repeat the full startup instruction"
);
assert.match(
  functionSource("queueRepAnnouncements", "startHoldTimer"),
  /for \(let repNumber = firstNewRep; repNumber <= detectedReps; repNumber \+= 1\)[\s\S]*?pendingRepAnnouncements\.push/,
  "every newly detected repetition should be queued in numerical order"
);
assert.doesNotMatch(
  functionSource("queueRepAnnouncements", "startHoldTimer"),
  /splice\(1, Infinity/,
  "a later count must never replace an earlier unspoken repetition"
);
assert.match(
  source,
  /function processPendingRepAnnouncements[\s\S]*?pendingRepAnnouncements\[0\][\s\S]*?onEnd:[\s\S]*?pendingRepAnnouncements\.shift/,
  "queued repetition numbers should be spoken in order"
);
assert.match(
  source,
  /function exerciseCompletionGuidance[\s\S]*?Move on to the next exercise shown on screen[\s\S]*?Your next exercise is \$\{nextExercise\.name\}[\s\S]*?Today’s exercise session is done/,
  "exercise completion should name the next planned movement or end today's session"
);
assert.match(
  functionSource("queueRepAnnouncements", "startHoldTimer"),
  /reachesGoal && isLastPlannedSet[\s\S]*?break;[\s\S]*?pendingRepAnnouncements\.push/,
  "the final number should be reserved for completion speech without deleting earlier queued counts"
);
assert.match(
  functionSource("handleCompletedSet", "updateFeedbackPanel"),
  /exerciseCompletionGuidance\(feedback\.exercise\)[\s\S]*?setFeedbackBanner\("good", completion\.message\)[\s\S]*?cameraSessionHintEl\.textContent = completion\.message/,
  "the final spoken instruction should also remain visible in the camera guide"
);
assert.match(
  functionSource("handleCompletedSet", "updateFeedbackPanel"),
  /renderCameraRepProgress\(feedback\.exercise, feedback\.repCount[\s\S]*?pendingExerciseCompletionAnnouncement = \{ feedback, completion \};[\s\S]*?processPendingRepAnnouncements\(\)/,
  "the recognized target should wait for any earlier rep number before completion speech"
);
assert.match(
  functionSource("announcePendingExerciseCompletion", "queueRepAnnouncements"),
  /stopMovementAiGuide\(\)[\s\S]*?beginExerciseCompletionConfirmation\(feedback, completion\)/,
  "completion confirmation should open as soon as the ordered rep queue is empty"
);
assert.doesNotMatch(
  functionSource("handleCompletedSet", "updateFeedbackPanel"),
  /completeExerciseSession\(\)|showPainCheckin\("after"\)/,
  "reaching the target must not finish the session without the user's consent"
);
assert.match(
  functionSource("beginExerciseCompletionConfirmation", "processPendingRepAnnouncements"),
  /Would you like me to finish this exercise[\s\S]*?finalCountAnnouncement[\s\S]*?!completion\.nextExerciseId[\s\S]*?combinedAnnouncement[\s\S]*?completion\.spokenMessage[\s\S]*?question[\s\S]*?done-and-checkin/,
  "a one-exercise session should combine its final count, completion notice, and hands-free question"
);
assert.match(
  functionSource("beginExerciseCompletionConfirmation", "processPendingRepAnnouncements"),
  /finishCombinedAnnouncement[\s\S]*?spokenRepCount = Math\.max\(spokenRepCount, feedback\.repCount\)[\s\S]*?askQuestion\(\{ questionAlreadySpoken: true \}\)/,
  "the combined completion clip should begin listening without repeating the question"
);
assert.match(
  functionSource("listenForExerciseCompletionConfirmation", "beginExerciseCompletionConfirmation"),
  /parseConfirmationResponse\(transcript\)[\s\S]*?response === "confirm"[\s\S]*?finishExerciseAndCheckIn\(\{ source: "voice" \}\)[\s\S]*?response === "change"[\s\S]*?declineExerciseCompletionConfirmation/,
  "yes should finish and open check-in while no should leave the session open"
);
assert.match(
  functionSource("updateFeedbackPanel", "renderPoseStrip"),
  /renderCameraRepProgress\(fb\.exercise, shown, \{ complete: setComplete \}\)/,
  "every recognized repetition should update the camera overlay"
);
assert.match(
  functionSource("promptForFinalHalfSquatReturn", "startHoldTimer"),
  /feedback\.repCount === metric\.goal - 1[\s\S]*?finalRepReturnPendingSetKey = setKey[\s\S]*?Final repetition\. Stand tall and hold still[\s\S]*?interrupt: true/,
  "the tenth squat attempt should tell a distant user to remain visible until its return is counted"
);
assert.match(
  functionSource("promptForFinalHalfSquatReturn", "startHoldTimer"),
  /if \(spoken \|\| !voiceGuidance\.enabled\)[\s\S]*?finalRepReturnPromptedSetKey = setKey/,
  "a final-repetition cue blocked by older speech should remain pending and retry"
);
assert.match(
  functionSource("updateFeedbackPanel", "renderPoseStrip"),
  /promptForFinalHalfSquatReturn\(fb, metric\)[\s\S]*?Final repetition: stand tall, stay fully visible/,
  "the final-return instruction should remain visible while the tracker waits"
);
assert.doesNotMatch(
  source,
  /Move your (?:left|right) knee back so it stays over your foot/,
  "squat corrections should avoid unclear knee-back wording"
);
assert.match(
  source,
  /fb\.exercise\.id !== "half-squats"/,
  "half squats should not show a second raw symmetry-warning card"
);
assert.doesNotMatch(
  source,
  /difference between knees/,
  "the live session should not display raw knee-angle differences"
);

assert.doesNotMatch(
  deactivateSource,
  /showPainCheckin\("after"\)/,
  "pausing the camera must not show the after-exercise check-in"
);
assert.doesNotMatch(
  deactivateSource,
  /completeExerciseSession\(\)/,
  "pausing the camera must not complete or record the exercise"
);
assert.match(
  deactivateSource,
  /I counted \$\{Math\.min\(pauseCount, pauseMetric\.goal\)\} of \$\{pauseMetric\.goal\} repetitions[\s\S]*?not been marked finished[\s\S]*?repetitions that were not counted/,
  "the paused state should report the recognized count and clearly say the exercise is unfinished"
);

const finishActionStart = source.indexOf("function finishExerciseAndCheckIn(");
const finishActionEnd = source.indexOf(
  'toggleBtn.addEventListener("click"',
  finishActionStart
);
assert.notEqual(finishActionStart, -1, "confirmed finish action should exist");
assert.notEqual(finishActionEnd, -1, "confirmed finish action should have an end");
const finishActionSource = source.slice(finishActionStart, finishActionEnd);

assert.match(
  finishActionSource,
  /completeExerciseSession\(\)/,
  "a confirmed finish should complete the exercise session"
);
assert.match(
  finishActionSource,
  /showPainCheckin\("after"\)/,
  "the after-exercise check-in should follow confirmed completion"
);
assert.doesNotMatch(
  finishActionSource,
  /confirmedPreExercisePain = null/,
  "the pre-exercise score must remain available for the after-exercise confirmation"
);
assert.match(
  source,
  /finishExerciseBtn\.addEventListener\("click",[\s\S]*?finishExerciseAndCheckIn\(\)[\s\S]*?exerciseCompletionConfirmBtn\?\.addEventListener\("click",[\s\S]*?finishExerciseAndCheckIn\(\)/,
  "both the existing finish button and the completion yes button should use the same finish path"
);

const voiceChoiceStart = source.indexOf(
  "async function requestHandsFreeMicrophone()"
);
const voiceChoiceEnd = source.indexOf(
  'voiceSetupButtons.addEventListener("click"',
  voiceChoiceStart
);
assert.notEqual(
  voiceChoiceStart,
  -1,
  "the exercise flow should offer hands-free voice before setup"
);
const voiceChoiceSource = source.slice(voiceChoiceStart, voiceChoiceEnd);
assert.match(
  voiceChoiceSource,
  /getUserMedia\(\{\s*audio:\s*true,\s*\}\)/,
  "non-Safari hands-free mode should request microphone permission while the user is near the device"
);
assert.match(
  voiceChoiceSource,
  /isSafariBrowser\(navigator\.userAgent\)[\s\S]*?await voiceGuidance\.verifyListeningAccess\(\)/,
  "Safari should verify the SpeechRecognition microphone directly so Ask can open its native prompt"
);
assert.doesNotMatch(
  voiceChoiceSource,
  /sessionStorage|hasConfirmedMicrophoneAccess|canReuseConfirmedAccess/,
  "a refresh must perform a real microphone check instead of trusting a stored hint"
);
assert.ok(
  voiceChoiceSource.indexOf("navigator.mediaDevices.getUserMedia")
    < voiceChoiceSource.indexOf("voiceGuidance.unlockNeuralAudio"),
  "the microphone permission request should be issued before unlocking audio output"
);
assert.ok(
  voiceChoiceSource.indexOf("await microphoneRequest")
    < voiceChoiceSource.indexOf("await voiceGuidance.unlockNeuralAudio"),
  "Safari must finish its native microphone decision before audio output is initialized"
);
assert.ok(
  voiceChoiceSource.indexOf("await microphoneRequest")
    < voiceChoiceSource.indexOf("await readMicrophonePermissionState(navigator)"),
  "the browser permission request should start before any awaited permission query"
);
const microphoneFailureBranch = voiceChoiceSource.slice(
  voiceChoiceSource.lastIndexOf("  } catch (error) {")
);
assert.doesNotMatch(
  microphoneFailureBranch,
  /finishVoiceModeChoice\(true\)/,
  "a failed microphone request must never enable hands-free mode"
);
assert.doesNotMatch(
  voiceChoiceSource,
  /if \(!isExplicitDenial && voiceGuidance\.canListen\)/,
  "the Safari fallback must not bypass known denial or hardware failures"
);
assert.match(
  voiceChoiceSource,
  /finishVoiceModeChoice\(true\)/,
  "successful microphone setup should enable hands-free responses"
);
assert.match(
  voiceChoiceSource,
  /permissionStream\.getTracks\(\)\.forEach\(\(track\) => track\.stop\(\)\)[\s\S]*?prepareSpeechAfterMicrophoneRelease\(\)[\s\S]*?finishVoiceModeChoice\(true\)/,
  "the first spoken prompt should wait for Safari to leave microphone-capture mode"
);
assert.match(
  voiceChoiceSource,
  /describeMicrophoneAccessFailure\(error/,
  "microphone failures should show an accurate browser-specific recovery path"
);
assert.match(
  voiceChoiceSource,
  /voiceSetupRetry\.addEventListener\("click", requestHandsFreeMicrophone\)/,
  "a denied permission should provide a direct user-triggered retry"
);
assert.match(
  source,
  /function resetVoiceModeChoice\(\)[\s\S]*?handsFreeVoiceEnabled = false[\s\S]*?voiceModeChosenThisSession = false[\s\S]*?voiceGuidance\.setEnabled\(false\)/,
  "a new page or account session should clear the previous response-mode choice"
);
assert.match(
  source,
  /addEventListener\("physiovision:auth-role"[\s\S]*?resetVoiceModeChoice\(\)[\s\S]*?if \(painCheckinState\) hidePainCheckin\(\)/,
  "sign-out and subsequent sign-in should close stale check-ins and offer the mode choice again"
);
assert.match(
  source,
  /addEventListener\("pagehide", resetVoiceModeChoice\)[\s\S]*?event\.persisted[\s\S]*?resetVoiceModeChoice\(\)/,
  "Safari page restoration should require a fresh response-mode choice"
);
assert.match(
  source,
  /function showPainCheckin[\s\S]*?if \(!voiceModeChosenThisSession\)[\s\S]*?ensureVoiceModeChosen\(\)[\s\S]*?showPainCheckin\(context/,
  "a pain question must not appear before the response-mode choice"
);

const showPainCheckinSource = functionSource(
  "showPainCheckin",
  "hidePainCheckin"
);
assert.ok(
  showPainCheckinSource.indexOf('painCheckinEl.classList.remove("hidden")')
    < showPainCheckinSource.indexOf("speakPainPrompt("),
  "the pain question should be visible before spoken guidance begins"
);
assert.match(
  showPainCheckinSource,
  /statusEl\.textContent = context === "before"[\s\S]*?Pain check ready/,
  "the status indicator should immediately confirm that the pain check is ready"
);
assert.match(
  showPainCheckinSource,
  /painCheckinEl\.scrollIntoView\(\{ behavior: "auto", block: "start" \}\)/,
  "the pain question should appear without waiting for a scroll animation"
);
assert.doesNotMatch(
  styles,
  /\.pain-checkin\.hands-free-checkin:not\(\.safety-interview-active\)\s*\{\s*display:\s*none/,
  "hands-free mode must not hide the visible pain question while audio starts"
);
const movementGuideSpeechSource = functionSource(
  "speakMovementGuide",
  "movementAiConversationActive"
);
assert.match(
  movementGuideSpeechSource,
  /useGeminiVoice\s*=\s*false[\s\S]*?preferImmediate:\s*!shouldUseGemini[\s\S]*?preferPrepared:\s*shouldUseGemini[\s\S]*?allowGeneratedSpeech:\s*shouldUseGemini\s*&&\s*allowGeneratedSpeech[\s\S]*?voiceGroup:\s*MOVEMENT_GUIDE_VOICE_GROUP[\s\S]*?volume:\s*MOVEMENT_GUIDE_VOLUME/,
  "fixed live guidance should use the browser voice and reserve Gemini for explicit AI answers"
);
assert.match(
  functionSource("speakCameraCoaching", "exerciseSpokenInstruction"),
  /cancelListening\(\)[\s\S]*?prepareSpeechAfterMicrophoneRelease\(\)[\s\S]*?speakAtFullVolume/,
  "automatic coaching should wait for Safari's microphone session to release before speaking"
);
assert.match(
  source,
  /function speakPainPrompt[\s\S]*?speakMovementGuide\(question[\s\S]*?voiceGroup:\s*PAIN_PROMPT_VOICE_GROUP[\s\S]*?rate:[\s\S]*?pitch:/,
  "pain prompts should retain one grouped browser voice"
);
assert.doesNotMatch(
  functionSource("speakPainPrompt", "showPainCheckin"),
  /allowGeneratedSpeech:\s*true/,
  "pain prompts must not spend Gemini TTS quota"
);

const calibrationFlowStart = source.indexOf(
  "async function openCalibrationFlow("
);
const calibrationFlowEnd = source.indexOf(
  "async function startCalibrationFlow(",
  calibrationFlowStart
);
assert.notEqual(
  calibrationFlowStart,
  -1,
  "the camera setup entry point should exist"
);
const calibrationFlowSource = source.slice(
  calibrationFlowStart,
  calibrationFlowEnd
);
const pathwayAccessPosition = calibrationFlowSource.indexOf(
  "hasPathwayAccess()"
);
const voiceChoicePosition = calibrationFlowSource.indexOf(
  "ensureVoiceModeChosen()"
);
const preCheckPosition = calibrationFlowSource.indexOf(
  'showPainCheckin("before"'
);
const calibrationPosition = calibrationFlowSource.indexOf(
  "startCalibrationFlow(trigger)"
);
assert.ok(
  pathwayAccessPosition >= 0 &&
    voiceChoicePosition > pathwayAccessPosition &&
    preCheckPosition > voiceChoicePosition &&
    calibrationPosition > preCheckPosition,
  "pathway access, voice choice, and the pain check should be resolved before calibration"
);

const pathwayAccessSource = functionSource(
  "hasPathwayAccess",
  "announceExerciseInstruction"
);
const activeDoseSource = functionSource(
  "activeDose",
  "movementAiConversationActive"
);
assert.match(
  source,
  /function currentPatientCarePath\(\)[\s\S]*?resolvePatientCarePath\([\s\S]*?currentPracticeIdentity\(\)\.patientProfile,[\s\S]*?profile/,
  "live exercise doses should resolve the authenticated pathway before the cached profile",
);
assert.match(
  activeDoseSource,
  /currentPatientCarePath\(\) === "clinician"/,
  "dose selection must use the normalized authenticated pathway",
);
assert.doesNotMatch(
  activeDoseSource,
  /profile\.carePath === "clinician"/,
  "a stale cached pathway must not erase an accepted AI-plan target",
);
assert.match(
  activeDoseSource,
  /currentAcceptedWellnessPlan\(\)[\s\S]*?wellnessPlanDoseForExercise\(wellnessPlan, exercise\?\.id\)/,
  "wellness camera targets should resolve from the accepted AI plan"
);
assert.ok(
  activeDoseSource.indexOf("wellnessPlanDoseForExercise")
    < activeDoseSource.indexOf("exercise?.prescription"),
  "catalogue defaults should be used only when no accepted wellness plan exists"
);
assert.match(
  functionSource("plannedSetCount", "updateSetStartingPositionCheck"),
  /Number\(activeDose\(exercise\)\.sets\)/,
  "set completion should use the accepted plan dose resolved by activeDose"
);
assert.match(
  source,
  /function refreshExerciseAccess\([\s\S]*?wellnessPlanExerciseIds\(wellnessPlan\)[\s\S]*?!plannedWellnessExercises\.has\(exercise\.id\)/,
  "the wellness exercise selector should be limited to the accepted plan"
);
assert.match(
  pathwayAccessSource,
  /practiceDecision\.reason === "wellness_plan"[\s\S]*?!wellnessPlanIncludesExercise\([\s\S]*?currentAcceptedWellnessPlan\(\)[\s\S]*?engine\.exercise\.id/,
  "the camera should authorize an accepted exercise by plan membership, independently of dosage parsing"
);
assert.match(
  pathwayAccessSource,
  /practiceDecision\.reason === "active_prescription"/,
  "camera access should use the authenticated practice decision"
);
assert.doesNotMatch(
  pathwayAccessSource,
  /isWellnessEligible|Complete the general wellness safety screen first|profile\.carePath/,
  "camera access must not re-check a stale browser screening profile after admission"
);
assert.doesNotMatch(
  source,
  /wellness safety screen|Complete safety screening|Review screening|screening_required/,
  "the live guide must not contain or display the AI plan's screening gate"
);
assert.match(
  source,
  /const CALIBRATION_TARGET_MOVEMENTS = 1/,
  "personal calibration should require only one comfortable movement"
);
assert.match(
  source,
  /const CALIBRATION_STALL_REMINDER_MS = 5000;[\s\S]*?const CALIBRATION_STALL_REPEAT_MS = 12000;/,
  "a stalled calibration should prompt after a short delay without repeating continuously"
);
const calibrationSpeechSource = functionSource(
  "speakCalibrationGuidance",
  "startHoldTimer"
);
assert.match(
  calibrationSpeechSource,
  /speakMovementGuide\(message[\s\S]*?voiceGroup:\s*CALIBRATION_VOICE_GROUP/,
  "calibration speech should start immediately and keep one consistent voice"
);
assert.match(
  functionSource("announceCalibrationStage", "cancelCalibration"),
  /localizedGuidanceParts\(\[[\s\S]*?cameraReadyPositioning[\s\S]*?introduction[\s\S]*?startInstruction[\s\S]*?Hold still after this instruction/,
  "calibration should translate every spoken segment without shortening the instruction"
);
assert.match(
  functionSource("renderCalibrationStep", "beginCalibrationCapture"),
  /setTranslatableTextParts\([\s\S]*?Your saved personalized movement range will be reused[\s\S]*?startInstruction[\s\S]*?Measurement starts automatically/,
  "the visible calibration explanation should preserve and translate the same instruction parts"
);
assert.match(
  source,
  /announceCalibrationStage\("start", \{[\s\S]*?onEnd:[\s\S]*?beginCalibrationCapture\("start"/,
  "calibration measurement should wait until the complete opening instruction finishes"
);
const finishCalibrationSource = functionSource(
  "finishCalibrationCapture",
  "resetCalibrationPositionTimer"
);
assert.match(
  finishCalibrationSource,
  /createCalibration\([\s\S]*?saveCompletedCalibration\(calibrationDraft\)/,
  "a completed personal range should save automatically without another action"
);
assert.doesNotMatch(
  finishCalibrationSource,
  /step = "result"|Review and save|calibrationAction/,
  "calibration completion must not pause on a manual review-and-save step"
);
const saveCalibrationSource = functionSource(
  "saveCompletedCalibration",
  "renderCalibrationStep"
);
assert.match(
  saveCalibrationSource,
  /saveCalibration\(draft\)[\s\S]*?engine\.changeExercise[\s\S]*?cancelCalibration\(\)[\s\S]*?announceExerciseInstruction[\s\S]*?onEnd:\s*startMovementAiGuide/,
  "automatic saving should activate the range, announce the movement, and restart Hey Guide"
);
assert.match(
  finishCalibrationSource,
  /Starting position confirmed\.[\s\S]*?onEnd:\s*startMovementAiGuide/,
  "the quick position check should restart Hey Guide after its start instruction"
);
assert.match(
  finishCalibrationSource,
  /Starting position saved\. Listen before making the calibration movement\.[\s\S]*?announceCalibrationStage\("target", \{[\s\S]*?onEnd:/,
  "the target capture should not start before its spoken movement instruction finishes"
);
assert.doesNotMatch(
  markup,
  /id="calibrationAction"|Save personal range|Save tracking baseline/,
  "the calibration dialog should not require a save button"
);
assert.match(
  source,
  /inspectCalibrationFrame\([\s\S]*?calibrationVisibilityGuidance\(inspection\)[\s\S]*?presentCalibrationIssue/,
  "calibration should turn missing measurement diagnostics into visible and spoken positioning guidance"
);
assert.match(
  source,
  /!fb\.trackingReady[\s\S]*?bannerState = "visibility"[\s\S]*?movementTrackingGuidance\(fb\)/,
  "missing required joints should pause the movement and show positioning guidance"
);
assert.match(
  source,
  /function movementTrackingGuidance[\s\S]*?missingLandmarks[\s\S]*?Pause your movement\.[\s\S]*?required joints are visible/,
  "visibility guidance should name hidden joints and explain when measurement resumes"
);
assert.match(
  source,
  /updateFeedbackPanel\(\{\}, frameTimestamp\)[\s\S]*?Movement paused — I can’t see you/,
  "a fully lost pose should pause engine progress instead of completing a partial repetition"
);
assert.match(
  source,
  /I cannot measure either knee angle\.[\s\S]*?both hips, knees, ankles, and feet are visible/,
  "a blocked squat measurement should name the missing knee angles and required landmarks"
);
assert.match(
  source,
  /Choose your pain level in the exercise panel to continue\.[\s\S]*?painCheckinEl\.scrollIntoView[\s\S]*?if \(!handsFreeVoiceEnabled\)[\s\S]*?focus\(\{ preventScroll: true \}\)/,
  "the pain question should be revealed immediately and focused in on-screen mode"
);
assert.doesNotMatch(
  source,
  /sample \$\{[^}]+\} of 3|Comfortable sample \$\{[^}]+\} of 3/,
  "calibration instructions should not ask an elderly patient for three movements"
);

assert.match(
  markup,
  /id="primaryCalibrationLabel">Start camera guide<\/span>/,
  "the central camera action should be labelled Start camera guide"
);
const secondaryCameraButtonStart = markup.lastIndexOf(
  "<button",
  markup.indexOf('id="toggle"')
);
const secondaryCameraButtonEnd =
  markup.indexOf("</button>", secondaryCameraButtonStart) +
  "</button>".length;
const secondaryCameraButton = markup.slice(
  secondaryCameraButtonStart,
  secondaryCameraButtonEnd
);
assert.match(
  secondaryCameraButton,
  /class="[^"]*\bhidden\b[^"]*"/,
  "the secondary camera control should be hidden before the camera starts"
);
assert.doesNotMatch(
  secondaryCameraButton,
  />\s*Start camera guide/,
  "the secondary camera control must not duplicate the central start action"
);
assert.match(
  source,
  /toggleBtn\.classList\.remove\("hidden"\)[\s\S]*?Pause camera guide/,
  "the secondary control should appear only as a pause action while the camera is running"
);

const toggleHandlerStart = source.indexOf(
  'toggleBtn.addEventListener("click"'
);
const toggleHandlerEnd = source.indexOf(
  'finishExerciseBtn.addEventListener("click"',
  toggleHandlerStart
);
assert.notEqual(toggleHandlerStart, -1, "the pause handler should exist");
const toggleHandlerSource = source.slice(toggleHandlerStart, toggleHandlerEnd);
assert.match(
  toggleHandlerSource,
  /if \(running\) deactivateCameraGuide\(\)/,
  "the secondary camera control should pause an active guide"
);
assert.doesNotMatch(
  toggleHandlerSource,
  /showPainCheckin|(?:^|[^\w])activateCameraGuide/,
  "the secondary camera control must not provide another way to start the guide"
);

const speakPainSource = functionSource(
  "speakPainPrompt",
  "showPainCheckin"
);
assert.match(
  speakPainSource,
  /onEnd:\s*\(\)\s*=>\s*armVoiceListening\(beginListening\)/,
  "hands-free listening should arm automatically after the spoken question"
);
const armListeningSource = functionSource(
  "armVoiceListening",
  "finishVoiceModeChoice"
);
assert.match(
  armListeningSource,
  /callback\(\)/,
  "recognition should start immediately when spoken guidance ends"
);
assert.doesNotMatch(
  armListeningSource,
  /setTimeout/,
  "hands-free answers should not be delayed after a question"
);
assert.match(
  speakPainSource,
  /handsFreeVoiceEnabled/,
  "automatic listening should only run when the user selected hands-free mode"
);

assert.match(
  source,
  /painVoiceInputBtn\.addEventListener\("click",[\s\S]*?startPainVoiceListening/,
  "the manual voice button should remain available as a fallback"
);

assert.match(
  markup,
  /id="painConfirmation"[\s\S]*?data-pain-confirmation="confirm"[\s\S]*?data-pain-confirmation="change"/,
  "the pain check-in should show explicit confirm and change actions"
);
assert.match(
  markup,
  /data-pain-confirmation="confirm">\s*Yes, that’s correct[\s\S]*?data-pain-confirmation="change">\s*Change my answer/,
  "pain confirmation should use the requested unambiguous actions"
);

assert.match(
  markup,
  /id="recordedPain"[\s\S]*?id="recordedPainMessage"[\s\S]*?id="recordedPainValue"/,
  "the right-side exercise panel should show the confirmed pain level"
);
assert.match(
  markup,
  /id="painSafetyInterview"[\s\S]*?id="painSafetyQuestion"[\s\S]*?id="painSafetyChoices"/,
  "the pain check-in should provide a step-by-step safety follow-up"
);
assert.match(
  source,
  /"urgent-chest"[\s\S]*?"urgent-breathing"[\s\S]*?"urgent-neurologic"[\s\S]*?"urgent-fall"/,
  "a combined warning-sign answer should be clarified symptom by symptom"
);
assert.doesNotMatch(
  source,
  /Have you fallen, fainted, or become unable to get up safely\?/,
  "the removed fall follow-up question should not be shown or spoken"
);
assert.match(
  source,
  /stageName === "urgent"[\s\S]*?response === "yes" \|\| response === "unsure"[\s\S]*?renderPainSafetyStage\("urgent-chest"\)/,
  "yes and not sure must open focused questions so the urgent reason is recorded"
);
assert.match(
  source,
  /parsePainSafetyResponse\(stage, transcript\)[\s\S]*?if \(parsedResponse\)[\s\S]*?acceptPainSafetyResponse\(parsedResponse\)[\s\S]*?interpretPainSafetyTranscript\(stage, transcript\)/,
  "fixed safety-language rules should run before the constrained AI fallback"
);
assert.match(
  source,
  /interpretSafetyLanguage\(\{[\s\S]*?stage,[\s\S]*?transcript,[\s\S]*?interpretation\?\.matched[\s\S]*?acceptPainSafetyResponse\(interpretation\.response\)/,
  "AI language output should be validated before entering the fixed safety pathway"
);
assert.match(
  source,
  /language_interpretations: answers\.languageInterpretations/,
  "constrained AI language notes should be recorded with the safety check"
);
assert.match(
  source,
  /urgent_combined_response: answers\.urgentCombined[\s\S]*?urgent_symptom_details:[\s\S]*?chest: answers\.urgentChest[\s\S]*?breathing: answers\.urgentBreathing[\s\S]*?neurologic: answers\.urgentNeurologic[\s\S]*?fall: answers\.urgentFall/,
  "the combined answer and focused symptom answers should all be saved for clinician review"
);
assert.match(
  source,
  /stageName === "familiarity"[\s\S]*?painCheckinState\.context === "before"[\s\S]*?onsetTiming = "before"[\s\S]*?renderPainSafetyStage\("mobility"\)/,
  "a pre-exercise safety check should skip redundant timing and five-second rest questions"
);
assert.match(
  source,
  /answers\.urgentSymptoms === "yes" \|\| answers\.safeMovement === "help"/,
  "only a confirmed warning sign or inability to move safely should force the urgent outcome"
);

const acceptPainSource = functionSource(
  "acceptPainLevel",
  "beginPainConfirmation"
);
assert.match(
  acceptPainSource,
  /beginPainConfirmation\(\)/,
  "manual, after-exercise, and safety-sensitive pain answers should still open confirmation"
);

const acceptConfirmationSource = functionSource(
  "acceptPainConfirmation",
  "acceptRecoveryStatus"
);
assert.match(
  acceptConfirmationSource,
  /response === "change"[\s\S]*?returnToPainQuestion/,
  "patients should be able to correct a pain level"
);
assert.match(
  acceptConfirmationSource,
  /response !== "confirm"[\s\S]*?return/,
  "an unclear spoken answer must not advance the check-in"
);
assert.match(
  acceptConfirmationSource,
  /if \(requiresPainSafetyInterview\(\)\) beginPainSafetyInterview\(\);[\s\S]*?else if \(shouldAskRecovery\(\)\) beginRecoveryQuestion\(\);[\s\S]*?else finishPainCheckin\(\)/,
  "a confirmed concerning pain level should enter the safety interview"
);

const finishPainSource = functionSource(
  "finishPainCheckin",
  "requiresPainSafetyInterview"
);
assert.match(
  finishPainSource,
  /hidePainCheckin\(\);[\s\S]*?renderRecordedPain\(completed\)[\s\S]*?completed\.continuation \|\| completed\.startAfter[\s\S]*?continueAfterPainCheckin\(completed\)/,
  "a pre-exercise pain confirmation should immediately continue camera setup"
);
assert.match(
  finishPainSource,
  /else \{\s*acknowledgeRecordedPain\(completed\);\s*\}/,
  "a completed check-in with no pending camera action may still be acknowledged"
);

const acknowledgementSource = functionSource(
  "acknowledgeRecordedPain",
  "startPainVoiceListening"
);
assert.match(
  acknowledgementSource,
  /recorded your pain level as \$\{level\} out of 10/,
  "the acknowledgement should repeat the recorded pain level"
);

const painConfirmationQuestionSource = functionSource(
  "painConfirmationQuestion",
  "isPainSafetyStage"
);
assert.match(
  painConfirmationQuestionSource,
  /context === "after"[\s\S]*?Before it was \$\{confirmedPreExercisePain\}/,
  "after-exercise confirmation should compare the new score with the confirmed pre-exercise score"
);

const countdownSource = functionSource(
  "continueAfterPainCheckin",
  "renderRecordedPain"
);
assert.match(
  countdownSource,
  /secondsRemaining: 3[\s\S]*?setInterval[\s\S]*?startCameraSetupAfterCountdown/,
  "a safe confirmed score should start camera setup automatically after a visible three-second countdown"
);
assert.match(
  countdownSource,
  /Pain level confirmed\. Camera setup will begin in three seconds\. Stay near your device\. If your browser asks for camera access, choose Allow\. I will tell you when to step back after the camera starts\.[\s\S]*?voiceGroup:\s*PAIN_PROMPT_VOICE_GROUP[\s\S]*?onEnd:\s*beginVisibleCountdown/,
  "the guide should finish the complete permission instruction before starting the countdown"
);
assert.doesNotMatch(
  countdownSource,
  /three seconds\. Step back/,
  "the guide must not ask the patient to step back before camera permission"
);
assert.match(
  functionSource("renderTrackingWarning", "cameraSetupTip"),
  /video\.srcObject[\s\S]*?After camera access is allowed/,
  "pre-camera framing text should make clear that stepping back happens after permission"
);
assert.match(
  countdownSource,
  /speakMovementGuide\([\s\S]*?voiceGroup:\s*PAIN_PROMPT_VOICE_GROUP/,
  "the post-confirmation handoff should speak immediately in the same voice"
);
assert.match(
  countdownSource,
  /onEnd:\s*beginVisibleCountdown|beginCountdownWhenSpeechIsIdle|voiceGuidance\.isSpeaking/,
  "the camera handoff should wait for browser speech to finish, including Safari's missing-end-event fallback"
);
assert.doesNotMatch(
  countdownSource,
  /voiceGuidance\.cancel\(\);[\s\S]*?startCameraSetupAfterCountdown\(pending\)/,
  "camera setup must not cancel the permission instruction mid-sentence"
);
assert.match(
  functionSource("spokenPainConfirmationQuestion", "isPainSafetyStage"),
  /return painConfirmationQuestion\(level\)/,
  "browser speech should read the exact recognized pain level in the confirmation question"
);
const acceptPainLevelSource = functionSource(
  "acceptPainLevel",
  "beginPainConfirmation"
);
assert.match(
  acceptPainLevelSource,
  /painCheckinState\.painLevel = level;[\s\S]*?beginPainConfirmation\(\)/,
  "every recognized pain level should be confirmed before camera setup continues"
);
assert.doesNotMatch(
  acceptPainLevelSource,
  /finishPainCheckin\(\)/,
  "no pain score should bypass the explicit confirmation and safety flow"
);
const cancelCountdownSource = functionSource(
  "cancelCameraSetupCountdown",
  "startCameraSetupAfterCountdown"
);
assert.match(
  cancelCountdownSource,
  /clearInterval[\s\S]*?Camera setup cancelled/,
  "patients should be able to cancel pending automatic camera setup"
);

const recoveryRuleSource = functionSource(
  "shouldAskRecovery",
  "beginRecoveryQuestion"
);
assert.match(
  recoveryRuleSource,
  /context === "after"/,
  "a safe pre-exercise confirmation should not stall on an extra recovery question"
);
assert.doesNotMatch(
  recoveryRuleSource,
  /carePath|clinician/,
  "both clinician and wellness pathways should receive the post-session recovery question"
);
const recoveryChoicesMarkup = markup.slice(
  markup.indexOf('id="recoveryChoices"'),
  markup.indexOf('id="painSafetyInterview"'),
);
assert.doesNotMatch(
  recoveryChoicesMarkup,
  /<p[\s>]/,
  "the recovery question should appear once in the shared check-in heading"
);
const recoveryQuestionSource = functionSource(
  "beginRecoveryQuestion",
  "painCheckinPayload"
);
assert.match(
  recoveryQuestionSource,
  /painCheckinTitleEl\.textContent = recoveryQuestion/,
  "the single visible recovery question should remain in the check-in heading"
);
assert.doesNotMatch(
  recoveryQuestionSource,
  /recoveryChoicesEl\.querySelector\("p"\)/,
  "the recovery question should not be copied into the answer container"
);

const completeSessionSource = functionSource(
  "completeExerciseSession",
  "painQuestion"
);
assert.match(
  completeSessionSource,
  /updatePainCheckin\(beforeCheckin\.id,[\s\S]*?session: createdSession\.id/,
  "the before-exercise pain check-in should be attached to the completed session"
);
assert.match(
  finishPainSource,
  /painCheckinPayload\(completed, session\?\.id\)/,
  "the after-exercise pain and recovery check-in should use the completed session id"
);
assert.match(
  markup,
  /id="session-summary-modal"[\s\S]*?id="sessionSummaryQuality"[\s\S]*?id="sessionSummaryPain"[\s\S]*?id="sessionSummaryRecovery"[\s\S]*?id="sessionSummaryTrend"/,
  "completed sessions should show immediate movement, pain, recovery, and trend results"
);
assert.doesNotMatch(
  acknowledgementSource,
  /onEnd|setTimeout|continueAfterPainCheckin/,
  "camera setup must not depend on Safari completing a speech callback"
);

const voiceVisibilitySource = functionSource(
  "updatePainCheckinPresentation",
  "continueAfterPainCheckin"
);
assert.match(
  voiceVisibilitySource,
  /classList\.toggle\([\s\S]*?"hands-free-checkin"[\s\S]*?handsFreeVoiceEnabled/,
  "hands-free mode should hide the repeated on-screen pain card"
);
assert.match(
  voiceVisibilitySource,
  /classList\.toggle\([\s\S]*?"hidden"[\s\S]*?handsFreeVoiceEnabled && !painVoiceFallbackNeeded[\s\S]*?safetyOutcome/,
  "hands-free mode should hide the redundant Answer by voice button during every automatically listened question"
);
assert.match(
  source,
  /Answer aloud after the question\. You do not need to press a button\./,
  "the safety interview should clearly explain that hands-free answers require no button press"
);

const safetyThresholdSource = functionSource(
  "requiresPainSafetyInterview",
  "createPainSafetyAnswers"
);
assert.match(
  safetyThresholdSource,
  /level >= 7/,
  "a severe pain score should trigger the safety follow-up"
);
assert.match(
  safetyThresholdSource,
  /level - confirmedPreExercisePain[\s\S]*?increase >= 2/,
  "a two-point increase from the pre-exercise score should trigger the safety follow-up"
);

const beginSafetySource = functionSource(
  "beginPainSafetyInterview",
  "determinePainSafetyOutcome"
);
assert.match(
  beginSafetySource,
  /deactivateCameraGuide\(\{/,
  "the camera guide should pause before asking safety questions"
);
assert.match(
  beginSafetySource,
  /startAfter = false[\s\S]*?continuation = ""/,
  "a concerning pain report must cancel automatic exercise continuation"
);
assert.match(
  beginSafetySource,
  /cancelCameraSetupCountdown/,
  "the high-pain branch should clear any pending camera countdown"
);
assert.match(
  beginSafetySource,
  /ensureConfirmedPainSafetyCheckin/,
  "a confirmed concerning pain score should be saved before the safety questions are completed",
);

const confirmedSafetyPainSource = functionSource(
  "confirmedPainSafetyPayload",
  "persistPainSafetyInterview"
);
assert.match(
  confirmedSafetyPainSource,
  /status: "incomplete"[\s\S]*?requires_review: true/,
  "an unfinished pain safety check should remain visible for clinician review",
);
assert.match(
  confirmedSafetyPainSource,
  /postPainCheckin\([\s\S]*?confirmedPainSafetyPayload/,
  "the confirmed pain score should create a standalone pain check-in",
);

const persistSafetySource = functionSource(
  "persistPainSafetyInterview",
  "renderPainSafetyOutcome"
);
assert.match(
  persistSafetySource,
  /ensureConfirmedPainSafetyCheckin[\s\S]*?confirmedCheckin\?\.id[\s\S]*?updatePainCheckin/,
  "completed safety answers should update the original pain record instead of creating a duplicate",
);

assert.match(
  source,
  /classList\.toggle\("is-body-map", stageName === "location"\)[\s\S]*?appendPainBodyDiagram/,
  "the pain-location step should include a simple body diagram with selectable regions"
);
assert.match(
  styles,
  /\.pain-body-diagram\s*\{[\s\S]*?\.pain-body-head[\s\S]*?\.pain-body-torso/,
  "the body-location selector should render a clear figure"
);
assert.match(
  source,
  /stage === "location" && transcript\.trim\(\)[\s\S]*?painLocationDescription[\s\S]*?if \(parsedResponse\)[\s\S]*?acceptPainSafetyResponse\(parsedResponse\)[\s\S]*?interpretPainSafetyTranscript\(stage, transcript\)/,
  "an unmatched spoken body-area description should be preserved and interpreted before advancing"
);
assert.match(
  source,
  /Recorded during \$\{movement\}, set \$\{answers\.setNumber\}, after \$\{answers\.repsCompleted\} completed repetitions/,
  "the safety interview should record known exercise, set and repetition details without asking again"
);
const restPauseSource = functionSource(
  "beginPainSafetyRestPause",
  "appendPainBodyDiagram"
);
assert.match(
  restPauseSource,
  /secondsRemaining = 5[\s\S]*?setInterval[\s\S]*?renderPainSafetyStage\("rest"\)/,
  "the pain-trend question should follow a short visible rest pause"
);

const outcomeSource = functionSource(
  "renderPainSafetyOutcome",
  "acceptPainSafetyResponse"
);
assert.match(
  outcomeSource,
  /Do not continue exercising[\s\S]*?call 995 now/,
  "urgent warning signs should end the exercise and show emergency instructions"
);
assert.match(
  outcomeSource,
  /recommend ending this exercise for today and monitoring how you feel/,
  "improving pain should still end the current exercise for the day"
);
assert.match(
  outcomeSource,
  /being saved and flagged for \$\{connection\.name\} to review[\s\S]*?not monitoring this in real time[\s\S]*?will not be changed automatically/,
  "a linked patient should be told that a severe report is flagged without implying real-time monitoring or plan changes"
);
assert.match(
  outcomeSource,
  /connection\.linked[\s\S]*?consider booking a session with \$\{connection\.name\}/,
  "a patient linked by physiotherapist code should be invited to book with their care professional",
);
assert.match(
  outcomeSource,
  /Pain level \$\{outcomeState\.painLevel\}\/10 saved and flagged for \$\{connection\.name\} to review/,
  "the safety outcome should confirm the exact saved pain level after persistence succeeds",
);
assert.match(
  outcomeSource,
  /save not confirmed[\s\S]*?could not be saved or flagged/,
  "the safety outcome must not claim a failed save was recorded or flagged",
);
assert.match(
  outcomeSource,
  /not currently linked to a physiotherapist[\s\S]*?Do not continue this programme[\s\S]*?qualified physiotherapist/,
  "a wellness patient should be told to stop and obtain professional advice before restarting"
);
assert.match(
  outcomeSource,
  /call 995 now[\s\S]*?emergency contact[\s\S]*?Do not use an emergency contact instead of 995/,
  "urgent guidance should distinguish emergency help from contact-person support"
);
assert.match(
  outcomeSource,
  /needsProfessionalReview[\s\S]*?persistPainSafetyInterview/,
  "a concerning safety outcome should be saved even if the patient leaves to seek help"
);
assert.doesNotMatch(
  outcomeSource,
  /continue exercise|resume exercise|activateCameraGuide/,
  "the safety outcome must never offer or trigger continued exercise"
);

const finishSafetySource = functionSource(
  "finishPainSafetyInterview",
  "acceptPainLevel"
);
assert.match(
  finishSafetySource,
  /persistPainSafetyInterview/,
  "finishing the safety interview should retry or complete persistence"
);
assert.doesNotMatch(
  finishSafetySource,
  /activateCameraGuide|continueAfterPainCheckin/,
  "finishing a safety interview must not resume the exercise automatically"
);

assert.match(
  therapistSource,
  /function painSafetyReview\([\s\S]*?safety_follow_up[\s\S]*?requires_review/,
  "the physiotherapist view should identify safety check-ins requiring review"
);
assert.match(
  therapistSource,
  /painSafetyReview\(p\)/,
  "the physiotherapist pain diary should show the recorded safety outcome"
);
assert.match(
  therapistSource,
  /function patientAccountLabel[\s\S]*?patient\.email[\s\S]*?state\.patients\.map\(p => `<option value="\$\{p\.id\}">\$\{escapeHtml\(patientAccountLabel\(p\)\)\}/,
  "patient selectors should show account email so same-name patients cannot be confused"
);
assert.match(
  therapistSource,
  /class="programme-patient"[\s\S]*?p\.patient_email/,
  "assigned programme rows should retain the selected patient account email"
);
assert.match(
  finishSafetySource,
  /does not confirm that they have seen it[\s\S]*?do not wait for a reply/,
  "a therapist report must not imply real-time review or a response"
);

assert.match(
  source,
  /onError:[\s\S]*?showPainVoiceFallback\(\)[\s\S]*?large on-screen choices/,
  "the manual voice fallback should reappear if hands-free recognition fails"
);

assert.match(
  source,
  /sessionCoachingQuality\.observe\([\s\S]*?deliverPendingQualityReminder\([\s\S]*?Try this for the next two repetitions/,
  "stable movement issues should enter a visible two-repetition coaching window",
);
assert.match(
  source,
  /markDisplayed\(reminder\.id\)[\s\S]*?onEnd:[\s\S]*?confirmDelivery\(reminder\.id/,
  "voice-mode quality coaching must be displayed and finish speaking before it is scoreable",
);
assert.doesNotMatch(
  source,
  /sessionCueCounts|sessionSymmetryRepEvents/,
  "raw cue frames and a duplicate symmetry path must not lower the new score",
);
assert.match(
  source,
  /No deduction:[\s\S]*?How validation-gated coaching affected the score/,
  "the session summary should explain why a reminder caused no deduction",
);
assert.match(
  source,
  /−\$\{Math\.round\(Number\(record\.deduction\)\)\} points:[\s\S]*?The same stable issue continued/,
  "the session summary should explain every persisted-issue deduction",
);

console.log("exercise session control tests passed");
