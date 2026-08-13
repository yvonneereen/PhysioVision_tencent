# PhysioVision — Implemented Features

## Patient — exercise & tracking
- Camera-guided exercises with MediaPipe pose detection (joint-angle tracking)
- Real-time rep counting and movement-phase detection
- Validation-gated live coaching; unvalidated camera rules are recorded as
  prototype observations and are not spoken as corrections
- Personal calibration — measures each patient's comfortable range instead of fixed thresholds
- Calibration tolerates lower landmark visibility (works for occluded floor/side-lying poses e.g. clamshell)
- Separate per-session tracking validity, prescription completion,
  movement-execution, and patient-reported symptom/safety outputs
- A nullable 0–100 camera coaching-response score only when the contributing
  rule version has technical validation, clinical validation, and recorded
  physiotherapist approval
- Movement-trend chart with approved coaching-response/pain sparklines
- Fall / visibility monitoring for floor exercises
- 12 tracked exercises + a larger draft exercise library (informational cards)

## Patient — plans, pain & pathways
- Two care pathways: general Wellness vs. Physiotherapist-assigned
- Wellness safety screening that gates self-guided exercise access
- AI-assisted wellness plan creation
- Clinician-prescribed programmes (exercises, sets/reps, days/week, notes, restrictions)
- Before/after pain check-ins (pain diary)
- "Recent movement trend" panel: sessions this week, validated coaching response, latest pain
- Auto trend status (building baseline / steady / improving / review suggested)

## Patient — care connection
- Self-referral: "Request a physiotherapist" from the pathway modal or wellness dashboard → triage queue
- Join a specific clinician via invitation code
- Book video consultations; accept/respond to clinician-suggested times
- In-app messaging with assigned physiotherapist (floating "Ask therapist" chat widget)
- AI movement companion ("Ask your AI") — Gemini-powered guidance

## Physiotherapist — dashboard
- Patient roster with computed trend, adherence %, last session, open flags
- Overview tab: patients needing attention + upcoming consultations
- Stats: active patients, needs-review count, average adherence
- Per-patient detail: session history, pain diary, quality/pain sparklines, active programme
- Programme builder: assign exercises + doses; AI-drafted full programmes
- Consultations tab: confirm, cancel, and Resolve (mark completed)
- Messaging inbox tab: per-patient conversations, unread badges, physio can initiate threads
- Auto-escalations: declining quality, rising pain, missed sessions

## Slack care-team integration
- Clinician account linking (`@Physio Assistant link <code>`) + disconnect
- Configurable Slack workspace invite link surfaced in the connect flow
- Private per-clinician DM routing for alerts (no shared channel)
- Escalation alerts DM'd to the patient's own clinician
- Per-clinician daily digest (roster-scoped)
- Patient in-app messages ping the clinician in Slack DM
- DM-based bot commands (my patients, who needs review, today, pain/adherence/sessions, send message, confirm, assign, build/revise/accept plan, summary)
- Triage channel for unassigned/self-referred patients with a "Claim patient" button (disables after claim)
- App-mention commands in channels (same command set)

## Accounts, safety & platform
- Verified email/password auth with rotating 12-hour tokens; 6-digit email codes
- Role-based accounts (patient / clinician / admin) with companion profiles
- Password recovery via email
- "Not a diagnosis" / "not monitored 24-7 / emergency services" safety framing throughout
- Honest tracking-maturity labels on prototype exercises
- Django + DRF backend (SQLite local, Neon Postgres on Render); vanilla-JS frontend on Cloudflare
- Gemini AI and Gmail API integrations
