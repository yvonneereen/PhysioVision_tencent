# PhysioVision — Project Context for Claude

## What this project is
PhysioVision is a physiotherapy exercise guidance app using MediaPipe pose detection. Patients do exercises in front of their camera; the app tracks joint angles and gives real-time coaching cues. Therapists can monitor patient progress via a dashboard.

Built for a hackathon. Stack: vanilla JS frontend + Django REST backend.

## First-time setup (new developer / friend)

```bash
# 1. Clone
git clone https://github.com/yvonneereen/PhysioVision_tencent.git
cd PhysioVision

# 2. Environment — copy the example and fill in your own secret key
cp .env.example .env
# The defaults in .env.example work out of the box for local dev

# 3. Install Python dependencies
pip3 install -r requirements.txt

# 4. Create your own local database
python3 manage.py migrate

# 5. Seed the 12 exercises into the DB
python3 manage.py seed_exercises

# 6. Create a superuser (optional — for /admin/ access)
python3 manage.py createsuperuser
```

Then run both servers (two terminal tabs):

**Terminal 1 — Django backend:**
```bash
python3 manage.py runserver 8000
```

**Terminal 2 — Frontend:**
```bash
python3 -m http.server 3000
```

Open `http://localhost:3000` in your browser.

> **Note:** `db.sqlite3` is gitignored — every developer gets their own clean local database. Never commit `db.sqlite3` or `.env`.

---

## How to run (if already set up)

## Architecture

### Frontend (vanilla JS, ES modules)
| File | Purpose |
|---|---|
| `index.html` | Main UI — exercise guide, therapist dashboard, auth modal |
| `main.js` | MediaPipe pose loop, rep tracking, session logging |
| `api.js` | Central API client — token auth, all fetch calls |
| `auth.js` | Login/register modal, seeds profile + calibrations on login |
| `personalization.js` | Profile + calibration (localStorage + API sync) |
| `feedback/engine.js` | Rep counter, phase detection, cue evaluation |
| `exercises/registry.js` | 12 live exercises with angle ranges (source of truth for seed command) |
| `exercises/catalog.js` | 23 draft exercises (informational UI cards, no camera tracking) |
| `ui.js` | Modal open/close, booking form |
| `exercise-library.js` | Renders the draft exercise library grid |

### Backend (Django 6, DRF, SQLite)
```
backend/          → Django project settings (settings.py reads from .env)
api/
  core/           → User, PatientProfile, ClinicianProfile + auth endpoints
  catalogue/      → Exercise, Prescription, Calibration + seed command
  sessions/       → Session (angle summaries, cues, symmetry), PainCheckin
  consultations/  → Consultation, Escalation
```

**Auth**: Verified email/password accounts with rotating, 12-hour DRF tokens
(`Authorization: Token <token>`). Registration sends a 6-digit code; unverified
accounts remain inactive. The frontend keeps the token and private caches in
`sessionStorage`. Single `User` model with `role` field (patient / clinician /
admin). Each role has a companion profile (1:1).

**Key design decisions**:
- Exercise slug PKs match JS registry IDs (`"half-squats"`) — zero translation layer
- Partial unique constraints on active Calibration and Prescription per (patient, exercise)
- Sessions store `angle_summaries` JSON: `{angleName: {min, max, mean}}` for trend tracking
- `CorsMiddleware` must be FIRST in MIDDLEWARE (before SecurityMiddleware)
- Sessions app label is `physio_sessions` (avoids collision with Django's built-in `sessions`)

## API endpoints

| Method | URL | Description |
|---|---|---|
| POST | `/api/auth/register/` | Create account + profile |
| POST | `/api/auth/verify-email/` | Verify email + get token |
| POST | `/api/auth/resend-verification/` | Send a replacement code |
| POST | `/api/auth/login/` | Get token |
| POST | `/api/auth/logout/` | Delete token |
| GET/PATCH | `/api/auth/me/` | Current user + profile |
| GET | `/api/exercises/` | List all active exercises |
| GET/POST | `/api/prescriptions/` | Patient's prescriptions |
| GET/POST | `/api/calibrations/` | Patient's calibrations |
| GET/POST | `/api/sessions/` | Workout sessions (angle summaries, cues) |
| GET/POST | `/api/pain-checkins/` | Pain diary |
| GET/POST | `/api/consultations/` | Video bookings |
| GET/PATCH | `/api/escalations/` | Escalation flags |

## What's wired (frontend → backend)
- ✅ Auth (register / login / logout)
- ✅ Profile sync (save → PATCH /me, load on login)
- ✅ Sessions — auto-POSTed when exercise changes or camera stops (if ≥1 rep)
- ✅ Angle summaries stored per session per exercise
- ✅ Pain check-in shown once after camera stops
- ✅ Calibration POSTed when wizard completes; pulled from API on login
- ✅ Exercise catalogue seeded (12 exercises, run `seed_exercises`)
- ✅ CORS configured (`CORS_ALLOW_ALL_ORIGINS = True` for dev)

## What's NOT done yet
- ❌ Clinician endpoints (`GET /api/patients/` — see plan below)
- ❌ Therapist dashboard wired to real data (currently mock HTML)
- ❌ AI assistant endpoints (patient dashboard, draft message, weekly report)
- ❌ Deployment (Railway/Render — needs Procfile, prod settings, PostgreSQL)
- ❌ Toast notification instead of `alert()` on login success

## Next planned work — Therapist Dashboard

### Backend needed
1. `PatientViewSet` in `api/core/views.py` — `GET /api/patients/`
   - Returns clinician's patients with computed: `last_session_at`, `open_escalations`, `trend` (improving/stable/declining from last 3 sessions' angle_summaries), `adherence_pct`
2. Clinician branch in `SessionViewSet` — supports `?patient={id}` query param
3. Clinician branch in `PainCheckinViewSet`

### Frontend needed
- `therapist.js` (new file) — `loadDashboard()`, `renderStats()`, `renderPatientTable()`
- `api.js` — add `getPatients()`
- `index.html` — add IDs to stats elements and patient table body

### Dashboard data mapping
| Dashboard element | Data source |
|---|---|
| Active patients count | `patients.count` |
| Need review count | open escalations |
| Adherence % | avg sessions completed vs prescribed |
| Patient trend ↗/—/⌁ | slope of last 3 sessions' angle mean |
| Status pill | open escalation → "Review now", declining → "Monitor", else "On track" |

## Common gotchas
- Always run `python3 manage.py runserver 8000` from the project root (`/Users/brandon06/PhysioVision`)
- If CORS errors appear, check nothing else is running on port 8000 (`lsof -i :8000`)
- `db.sqlite3` is gitignored — each dev runs `migrate` to get their own DB
- Token becomes invalid after `logout` — frontend clears it from localStorage
- `flushSession()` only posts if `engine.repCount > 0` and user is logged in — no ghost records
