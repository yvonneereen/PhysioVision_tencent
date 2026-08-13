# PhysioVision — Product Overview

## One-liner
**PhysioVision turns any webcam into a personalized physiotherapy coach, and keeps patients connected to a real care team.** Patients do rehab exercises at home while AI pose-tracking counts reps and coaches form in real time; physiotherapists monitor progress, get alerted to problems, and communicate — all without hours of video review.

## The problem it solves
Home rehab has two failure modes: patients do exercises **wrong** (or stop doing them) with no feedback, and clinicians have **no visibility** between appointments. PhysioVision closes both loops — real-time guidance for the patient, and trend/alerting/messaging for the clinician.

---

## Two experiences

### Patient app
- **Camera-guided exercises** — MediaPipe pose detection tracks joint angles,
  counts reps, and detects movement phases. Corrections are delivered only by
  validation-gated rule versions; prototype detections are observations only.
- **Personal calibration** — instead of one-size-fits-all thresholds, it measures each person's *comfortable* range so tracking adapts to them.
- **Separate session evidence** — tracking validity, prescription completion,
  movement execution, and patient-reported symptoms/safety are stored
  separately. A 0–100 camera coaching-response score is nullable and requires
  technical validation, clinical validation, and recorded physiotherapist
  approval for every contributing rule.
- **Pain check-ins** — quick before/after pain diary; a safety screen gates self-guided wellness.
- **Two care pathways:**
  - **Wellness** — self-guided, AI-assisted general movement for lower-risk users.
  - **Physiotherapist-assigned** — a clinician prescribes exercises, doses, and restrictions.
- **Self-referral** — a wellness patient can "Request a physiotherapist" anytime, landing in the care team's triage queue.
- **In-app messaging** — a floating "Ask therapist" chat to message their assigned physio (async, not for emergencies).

### Physiotherapist dashboard
- **Patient roster** with computed trend (improving / stable / declining), adherence %, last session, and open flags.
- **Escalations** — the system auto-flags declining quality, rising pain, or missed sessions.
- **Programme builder** — assign exercises and doses; AI can draft a full programme.
- **Consultations** — video-consult booking, confirm/resolve flow.
- **Messaging inbox** — a dedicated tab with per-patient conversations, unread badges, and the ability to initiate a thread with any patient.

---

## The differentiator: a Slack "care-team" layer
Instead of forcing clinicians into yet another dashboard, PhysioVision meets them in **Slack**:
- Clinicians link their account (join workspace, then `@Physio Assistant link <code>`).
- **Private per-clinician DMs** — escalations, daily digests, and patient-message pings go to each physio's own Slack DM (not a shared channel), scoped to their roster.
- **DM commands** — `my patients`, `who needs review`, `today`, `build a plan for Sarah`, `assign … to …`, etc. — a conversational assistant over their caseload.
- **Triage channel** — patients with no assigned clinician (self-referrals) post to a shared triage queue with a Claim button; any physio claims them and future alerts route to that physio's DM.

---

## Safety & clinical framing
Deliberately conservative for a health context: "not a diagnosis" language throughout, safety screens before self-guided exercise, restrictions preserved on clinician-managed plans, and "not monitored 24/7 / contact emergency services" notices on messaging. Tracking limitations are labeled honestly (e.g., "partial-observation prototype" on hard-to-track exercises).

---

## Tech stack
- **Frontend:** vanilla JS (ES modules), MediaPipe Tasks-Vision for pose/hand tracking, Gemini for AI guidance. Static build deployed on Cloudflare.
- **Backend:** Django + DRF, token auth with verified email. Deployed on Render with Neon Postgres; SQLite for local dev.
- **Integrations:** Slack (bot + events + interactivity), Gemini AI, Gmail API for transactional email.

---

## Recent additions
Per-clinician Slack DM routing; DM-based bot commands; triage self-referral queue + Claim; consultation Resolve; movement-quality scoring; calibration reliability fix; patient-to-physio in-app messaging (floating widget + therapist inbox with unread badges + physio-initiated threads); Slack disconnect + workspace invite link; numerous UI fixes.
