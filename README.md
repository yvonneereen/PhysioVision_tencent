# PhysioVision

[Live demo](https://physiovision.edgeone.dev) · [API health](https://physiovision.onrender.com/api/health/) · [Tracking specifications](TRACKING_RULES.md)

PhysioVision is an AI-supported home exercise and physiotherapy-care prototype
built for the Tencent Age Well Hackathon. It combines on-device camera tracking,
hands-free guidance, personalised wellness planning, progress reporting and a
physiotherapist dashboard in one patient-to-clinician workflow.

The public frontend is deployed on **Tencent Cloud EdgeOne Pages**. The Django
API runs on Render and stores authenticated account data in PostgreSQL.

## What is implemented

### Patient experience

- Email-verified patient and physiotherapist accounts, password recovery and a
  fresh six-digit verification code for each password sign-in
- Two distinct care pathways: an accepted AI-drafted general-wellness plan or a
  programme assigned by a linked physiotherapist
- Three-step intake and safety screening before Gemini drafts a structured
  wellness plan from the patient's goal, mobility, activity level and focus side
- Complete assigned-programme display, multi-exercise session progression,
  consultation booking and asynchronous patient–physiotherapist messaging
- Physiotherapist invitation-code entry for direct care-team linking, with a
  separate triage request for patients who do not have a code
- Personal profile settings for goals, coaching style, focus side, mobility,
  language, text size and a consented emergency contact

### Camera movement guide

- MediaPipe Pose and Hand tracking performed in the browser; the camera feed is
  not uploaded or recorded by the normal live guide
- Personal calibration from the patient's starting position and comfortable
  movement range without relaxing fixed form, visibility or safety rules
- Phase recognition, repetition counting, live visibility prompts and
  exercise-specific movement observations
- A library of **35 exercises**: **23 live camera-tracking prototypes** and **12
  clearly labelled coming-soon exercises**
- Pose tracking for lower-limb, balance, gait, spine and shoulder movements, plus
  combined pose-and-hand tracking for wrist, forearm and hand-shape sequences
- Repetitions retained when the guide is paused for a rest or briefly loses
  tracking, with completed exercises retained while moving through a daily plan
- Pre-exercise pain capture, post-exercise pain/recovery check-in and a session
  summary with completion, tracking validity and movement observations
- A transparent engineering prototype movement score. Observation deductions
  are shown to the user, while clinically validated trend scoring remains a
  separate, approval-gated pathway

### Hands-free and inclusive guidance

- English, Chinese, Malay and Tamil interface and movement-guidance support
- Browser speech output for fixed exercise, check-in and possible-fall
  instructions so the core guide does not depend on Gemini TTS quota
- Browser speech recognition for pain answers, check-ins and movement-guide
  commands
- “Hey Guide” questions during tracking, with Gemini used for the unpredictable
  answer rather than for the fixed instruction sequence
- Hands-free rest and resume commands, spoken repetition-completion reminders,
  verbal check-in choices and voice-controlled continuation to the next exercise
- Standard, large and extra-large text settings

### Safety workflow

- Exercise access gates and conservative warnings that do not diagnose, prescribe
  or override clinician restrictions
- Possible-fall monitoring on supported exercises, followed by a 60-second
  wellbeing check that stops the exercise and asks whether the patient is okay
- Optional Vonage call to a consented, verified emergency contact when the
  patient requests help or does not respond and the background worker is active
- A separate manual **Call 995 now** action; PhysioVision never automatically
  calls emergency services or claims that an ambulance was dispatched

See [EMERGENCY_ALERT_SETUP.md](EMERGENCY_ALERT_SETUP.md) for the provider,
verification, worker and safe-testing setup.

### Physiotherapist workspace

- Overview of active patients, review signals, adherence and consultations
- Searchable patient roster with all active programmes, sessions, pain check-ins,
  messages and validation-gated movement trends
- Patient invitation-code generation and triage claim/decline workflow that
  excludes patients who are already on the clinician's roster
- Individual or AI-drafted programme assignment with exercise, sets,
  repetitions, frequency and clinician notes
- Consultation proposals and scheduling, patient messaging and clinician-side
  AI assistance
- Patient discharge that ends active programmes and pending appointments while
  preserving account and care history
- Optional Slack Physio Assistant integration for account linking, scoped
  clinician summaries, triage notifications and daily digests

## Architecture

| Layer | Current implementation |
| --- | --- |
| Frontend | Vanilla HTML, CSS and ES modules |
| Movement tracking | MediaPipe Pose Landmarker and Hand Landmarker in the browser |
| Production frontend | Tencent Cloud EdgeOne Pages |
| API | Django 5 + Django REST Framework on Render |
| Data | PostgreSQL in production; SQLite for local development |
| AI | Gemini for wellness-plan drafting, assistant responses and bounded language interpretation |
| Email | Gmail API for verification and password-recovery messages |
| Care integrations | Slack bot and Vonage Voice API |

Account tokens are kept in per-tab `sessionStorage`, cleared at sign-out and not
persisted to `localStorage`. Database, email, Gemini, Slack and Vonage secrets
belong only in the backend environment.

## Run locally

### 1. Start the Django API

```bash
cp .env.example .env
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
python manage.py migrate
python manage.py seed_exercises
python manage.py runserver
```

The example environment uses SQLite and permits the local frontend origin. Email,
Gemini, Slack and Vonage features require their corresponding credentials, but
the core local pages and camera-tracking guide do not require all integrations.

### 2. Start the frontend

In a second terminal:

```bash
python3 -m http.server 4173
```

Open `http://localhost:4173`. Camera access requires a web server rather than
opening `index.html` directly. The MediaPipe models and web fonts load from
external CDNs, so the complete guide also needs an internet connection.

### 3. Run the automated checks

```bash
npm test
```

The suite covers tracking geometry, repetition state, calibration, session
continuity, voice guidance, localisation, fall alerts, authentication, wellness
planning and clinician workflows.

## Production deployment

### Frontend: Tencent Cloud EdgeOne Pages

Connect the repository and use:

```text
Production branch: main
Build command: npm run build
Build output directory: dist
PHYSIOVISION_API_BASE=https://physiovision.onrender.com/api
```

`scripts/build-static.mjs` copies the browser application into `dist/`, verifies
local ES-module imports and writes the public API base into the built
`runtime-config.js`. Do not place private keys or API secrets in EdgeOne.

### Backend: Render

`render.yaml`, `build.sh` and `gunicorn.conf.py` define the Django web service.
The build installs dependencies, collects static files, applies migrations and
seeds the exercise catalogue. Configure a persistent `DATABASE_URL` and use the
exact EdgeOne origin, without a trailing slash, for:

```text
CORS_ALLOWED_ORIGINS=https://physiovision.edgeone.dev
CSRF_TRUSTED_ORIGINS=https://physiovision.edgeone.dev
FRONTEND_URL=https://physiovision.edgeone.dev
```

Copy `.env.example` values into Render as private environment variables where
required. At minimum, production accounts need the Django and database values;
email verification needs Gmail API credentials; AI features need
`GEMINI_API_KEY`; Slack and emergency-contact calls need their respective bot
and Vonage credentials.

The no-response fall-alert path additionally requires a continuously running
worker connected to the same database:

```bash
python manage.py process_emergency_alerts --watch --interval 2
```

## Prototype boundaries

- PhysioVision is a hackathon prototype, not a medical device, diagnostic tool
  or substitute for a qualified healthcare professional.
- Camera-derived angles, repetitions, cues and engineering scores require
  technical testing, real-video validation and physiotherapist approval before
  clinical use.
- A single RGB camera cannot assess pain, exertion, support-surface stability,
  resistance, load, mobility-aid fit or every three-dimensional alignment.
- Possible-fall monitoring is an additional safeguard, not guaranteed unattended
  monitoring. It cannot work after the page closes, camera access ends, the
  device loses power or network access, or the patient is outside the frame.
- A provider request means an alert was submitted; it does not by itself prove
  that the contact answered.

Detailed landmark, phase, visibility and measurement rules are documented in
[TRACKING_RULES.md](TRACKING_RULES.md).
