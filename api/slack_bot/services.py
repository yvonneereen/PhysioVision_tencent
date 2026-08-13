import hashlib
import logging
from datetime import timedelta

from django.conf import settings
from django.db.models import Q
from django.utils import timezone

logger = logging.getLogger(__name__)


# ── Slack account linking ─────────────────────────────────────

def slack_link_code_digest(code):
    """SHA-256 of a link code. Shared by the issuing view and the redeemer so
    both sides normalise identically (strip whitespace only — codes are digits)."""
    return hashlib.sha256(code.strip().encode("utf-8")).hexdigest()


def link_slack_user(code, slack_user_id):
    """
    Redeem a dashboard-issued link code from Slack. Attaches the Slack user id to
    the owning clinician's profile and burns the code. Returns (clinician, error).
    """
    from api.core.models import SlackLinkCode

    if not slack_user_id:
        return None, "Could not read your Slack user id. Please try again."

    try:
        link = (
            SlackLinkCode.objects.select_related("clinician__user")
            .get(code_digest=slack_link_code_digest(code))
        )
    except SlackLinkCode.DoesNotExist:
        return None, "That code isn't valid. Generate a fresh one from your dashboard."

    if link.used_at is not None:
        return None, "That code has already been used. Generate a fresh one from your dashboard."
    if link.expires_at < timezone.now():
        return None, "That code has expired. Generate a fresh one from your dashboard."

    clinician = link.clinician
    clinician.slack_user_id = slack_user_id
    clinician.save(update_fields=["slack_user_id", "updated_at"])
    link.used_at = timezone.now()
    link.save(update_fields=["used_at", "updated_at"])
    return clinician, None


def _get_slack_client():
    from slack_sdk import WebClient
    return WebClient(token=settings.SLACK_BOT_TOKEN)


def _gemini_generate(prompt):
    """Single Gemini call using the configured model (shared with core/ai.py)."""
    from google import genai
    client = genai.Client(api_key=settings.GEMINI_API_KEY)
    interaction = client.interactions.create(
        model=settings.GEMINI_MODEL,
        input=prompt,
    )
    return interaction.output_text


# Unicode blocks for compact inline trend sparklines (renders natively in Slack).
_SPARK_TICKS = "▁▂▃▄▅▆▇█"


def _sparkline(values, lo=0, hi=100):
    """Render a list of numbers as a unicode sparkline over a fixed [lo, hi] range."""
    nums = [float(v) for v in values if v is not None]
    if not nums:
        return "—"
    span = (hi - lo) or 1
    ticks = []
    for n in nums:
        idx = int((max(lo, min(hi, n)) - lo) / span * (len(_SPARK_TICKS) - 1))
        ticks.append(_SPARK_TICKS[idx])
    return "".join(ticks)


TRIGGER_LABELS = {
    'quality_decline':   'Quality decline',
    'symmetry_concern':  'Symmetry concern',
    'missed_sessions':   'Missed sessions',
    'pain_increase':     'Pain increase',
    'manual':            'Manual flag',
}


# ── Proactive alerts ──────────────────────────────────────────

def on_escalation_created(sender, instance, created, **kwargs):
    if not created or instance.status != 'open':
        return
    try:
        _post_escalation_alert(instance)
    except Exception:
        logger.exception("Slack alert failed for escalation %s", instance.id)


def _dm_channel(clinician):
    """
    Open (or reuse) a direct-message channel with a linked clinician and return
    its channel id. Returns None if the clinician hasn't linked Slack.
    """
    if not clinician or not getattr(clinician, "slack_user_id", ""):
        return None
    client = _get_slack_client()
    resp = client.conversations_open(users=clinician.slack_user_id)
    return resp["channel"]["id"]


def _patient_name(patient):
    return f"{patient.user.first_name} {patient.user.last_name}".strip() or patient.user.email


def post_in_patient_thread(patient, *, text=None, blocks=None):
    """
    DM the patient's own physiotherapist a message in a dedicated per-patient
    thread. There is no shared channel — every clinician gets their own private
    DM thread. Skips silently if Slack isn't configured or the patient's
    clinician hasn't linked their Slack account. Lazily creates the parent
    thread message and re-creates it if the stored timestamp is stale (e.g. the
    patient was reassigned to a different clinician).
    """
    if not getattr(settings, 'SLACK_BOT_TOKEN', ''):
        return None

    from slack_sdk.errors import SlackApiError

    channel = _dm_channel(patient.primary_clinician)
    if not channel:
        logger.info(
            "No linked clinician for %s — skipping Slack alert.",
            _patient_name(patient),
        )
        return None

    client = _get_slack_client()

    def _create_parent():
        parent = client.chat_postMessage(
            channel=channel,
            text=f":thread: Patient thread — {_patient_name(patient)}",
        )
        patient.slack_thread_ts = parent.get("ts", "")
        patient.save(update_fields=["slack_thread_ts", "updated_at"])

    if not patient.slack_thread_ts:
        _create_parent()

    try:
        return client.chat_postMessage(
            channel=channel,
            thread_ts=patient.slack_thread_ts or None,
            text=text,
            blocks=blocks,
        )
    except SlackApiError:
        # Stored thread ts is from another channel — start a fresh thread here.
        _create_parent()
        return client.chat_postMessage(
            channel=channel,
            thread_ts=patient.slack_thread_ts or None,
            text=text,
            blocks=blocks,
        )


def _triage_channel():
    return getattr(settings, 'SLACK_TRIAGE_CHANNEL_ID', '')


def _post_to_triage(patient, *, text=None, blocks=None):
    """
    Post a standalone alert to the shared triage channel for patients with no
    linked clinician to DM, so any physio can pick them up. Skips if no triage
    channel is configured.
    """
    channel = _triage_channel()
    if not channel:
        logger.info(
            "No linked clinician and no triage channel — skipping alert for %s.",
            _patient_name(patient),
        )
        return None
    return _get_slack_client().chat_postMessage(channel=channel, text=text, blocks=blocks)


def claim_patient(clinician, patient_id):
    """
    Assign an unclaimed patient to the clinician who clicked *Claim* in triage.
    Resets the Slack thread so future activity starts fresh in the new
    clinician's DM. Returns (patient, error).
    """
    from django.core.exceptions import ValidationError

    from api.core.models import PatientProfile, UserRole

    try:
        patient = PatientProfile.objects.select_related('user', 'primary_clinician').get(id=patient_id)
    except (PatientProfile.DoesNotExist, ValidationError, ValueError, TypeError):
        return None, "That patient no longer exists."

    if patient.user.role != UserRole.PATIENT:
        return None, "Only patient accounts can be claimed from triage."

    if patient.primary_clinician_id and patient.primary_clinician_id != clinician.id:
        already = patient.primary_clinician.user.get_full_name() or "another clinician"
        return None, f"{patient.user.first_name} is already assigned to {already}."

    patient.primary_clinician = clinician
    patient.slack_thread_ts = ""  # start a fresh thread in the claiming clinician's DM
    patient.save(update_fields=["primary_clinician", "slack_thread_ts", "updated_at"])
    return patient, None


def _claim_button(patient):
    return {
        "type": "button",
        "text": {"type": "plain_text", "text": "Claim patient"},
        "action_id": "claim_patient",
        "value": str(patient.id),
        "style": "primary",
    }


def _open_dashboard_button(*, primary=False):
    button = {
        "type": "button",
        "text": {"type": "plain_text", "text": "Open dashboard"},
        "url": getattr(settings, 'FRONTEND_URL', 'http://localhost:3000'),
    }
    if primary:
        button["style"] = "primary"
    return button


def _wants_therapist(patient):
    """True if the patient has opted in to seeking physiotherapist help."""
    from api.core.models import PatientPathwayChoice, UserRole
    return bool(
        patient.user.role == UserRole.PATIENT
        and (
            patient.pathway_choice == PatientPathwayChoice.PHYSIOTHERAPIST
            or patient.physiotherapist_requested_at
        )
    )


def _post_escalation_alert(escalation):
    if not getattr(settings, 'SLACK_BOT_TOKEN', ''):
        return

    patient = escalation.patient
    name    = _patient_name(patient)
    trigger = TRIGGER_LABELS.get(escalation.trigger_type, escalation.trigger_type)

    section = {
        "type": "section",
        "text": {
            "type": "mrkdwn",
            "text": f":rotating_light: *New escalation — {name}*\n*Trigger:* {trigger}\n{escalation.description}",
        },
    }
    text = f"New escalation for {name}: {trigger}"

    clinician = patient.primary_clinician
    if clinician and clinician.slack_user_id:
        # The patient has a linked physiotherapist — DM them privately.
        post_in_patient_thread(
            patient,
            blocks=[section, {"type": "actions", "elements": [_open_dashboard_button(primary=True)]}],
            text=text,
        )
    elif _wants_therapist(patient):
        # No assigned clinician, but the patient asked to be seen — surface it in
        # triage with a Claim button so any physio can take them on.
        _post_to_triage(
            patient,
            blocks=[section, {"type": "actions", "elements": [_claim_button(patient), _open_dashboard_button()]}],
            text=f"Unclaimed — {text}",
        )
    else:
        # Patient hasn't opted in to physiotherapist help — respect that choice
        # and don't surface their log anywhere.
        logger.info("Escalation for %s not surfaced (no clinician, no opt-in).", name)


def notify_clinician_of_message(message):
    """
    Ping the clinician in their private per-patient Slack DM thread when a
    patient sends them an in-app message. No-op if Slack isn't configured or the
    clinician hasn't linked Slack.
    """
    patient = message.patient
    body = (message.body or "").strip()
    preview = body if len(body) <= 300 else body[:297] + "…"
    blocks = [
        {
            "type": "section",
            "text": {
                "type": "mrkdwn",
                "text": (
                    f":speech_balloon: *{_patient_name(patient)}* sent you a message:\n"
                    f">{preview}"
                ),
            },
        },
        {"type": "actions", "elements": [_open_dashboard_button(primary=True)]},
    ]
    return post_in_patient_thread(
        patient,
        blocks=blocks,
        text=f"New message from {_patient_name(patient)}",
    )


def post_self_referral_to_triage(patient):
    """
    A patient has asked to be seen by a physiotherapist (chose the
    physiotherapist pathway). Post their log to the shared triage channel with a
    Claim button so any physio can take them on. No-op if they already have a
    clinician, or Slack/triage isn't configured.
    """
    from api.core.models import UserRole

    if not getattr(settings, 'SLACK_BOT_TOKEN', ''):
        return None
    if patient.user.role != UserRole.PATIENT:
        return None
    if patient.primary_clinician_id:
        return None

    header = {
        "type": "section",
        "text": {
            "type": "mrkdwn",
            "text": (
                f":raising_hand: *New request for a physiotherapist — {_patient_name(patient)}*\n"
                "_Patient opted in to seek professional help._"
            ),
        },
    }
    actions = {
        "type": "actions",
        "elements": [_claim_button(patient), _open_dashboard_button()],
    }
    blocks = [header] + build_patient_summary_blocks(patient) + [actions]
    return _post_to_triage(
        patient,
        blocks=blocks,
        text=f"{_patient_name(patient)} requested a physiotherapist",
    )


# ── Daily digest ──────────────────────────────────────────────

def refresh_all_escalations():
    """
    Re-run the escalation rules for every patient. Catches the time-based rules
    (missed sessions) that have no save event to hang a signal off. Returns the
    count of newly created escalations.
    """
    from api.consultations.escalation_service import evaluate_patient_escalations
    from api.core.models import PatientProfile

    total = 0
    for patient in PatientProfile.objects.select_related('user').prefetch_related(
        'sessions', 'prescriptions', 'escalations', 'pain_checkins'
    ):
        total += len(evaluate_patient_escalations(patient))
    return total


def _digest_lines_for(clinician):
    """Build the digest text for a single clinician's own roster."""
    from api.consultations.models import Escalation
    from api.core.analytics import adherence_pct
    from api.core.models import PatientProfile
    from api.sessions.models import PainCheckin, Session

    yesterday = timezone.now() - timedelta(hours=24)
    roster = {"patient__primary_clinician": clinician}

    open_escalations   = Escalation.objects.filter(status='open', **roster).select_related('patient__user')
    sessions_yesterday = Session.objects.filter(started_at__gte=yesterday, **roster).select_related('patient__user', 'exercise')
    high_pain          = PainCheckin.objects.filter(checked_at__gte=yesterday, pain_level__gte=7, **roster).select_related('patient__user')

    flagged_ids = set(open_escalations.values_list('patient_id', flat=True))
    my_patients = list(
        PatientProfile.objects.filter(primary_clinician=clinician).prefetch_related('sessions', 'prescriptions')
    )
    on_track = [p for p in my_patients if p.id not in flagged_ids]

    lines = [f":sun_with_face: *PhysioVision daily digest — {timezone.now().strftime('%A, %d %B')}*\n"]

    lines.append(f"*Open escalations:* {open_escalations.count()}")
    for esc in open_escalations[:5]:
        name = _patient_name(esc.patient)
        lines.append(f"  • {name} — {TRIGGER_LABELS.get(esc.trigger_type, esc.trigger_type)}")

    lines.append(f"\n*Sessions in last 24h:* {sessions_yesterday.count()}")
    for s in sessions_yesterday[:5]:
        name = _patient_name(s.patient)
        lines.append(f"  • {name} — {s.exercise.name} ({s.reps_completed}/{s.reps_target} reps)")

    if high_pain.exists():
        lines.append(f"\n*:warning: High pain reports (≥7):*")
        for pc in high_pain[:5]:
            name = _patient_name(pc.patient)
            lines.append(f"  • {name} — {pc.pain_level}/10{(' · ' + pc.location_notes) if pc.location_notes else ''}")

    # Adherence laggards (below 50%, excluding those already flagged).
    laggards = [
        (p, adherence_pct(p)) for p in on_track
        if (a := adherence_pct(p)) is not None and a < 50
    ]
    if laggards:
        lines.append("\n*:chart_with_downwards_trend: Adherence laggards:*")
        for p, a in laggards[:5]:
            lines.append(f"  • {_patient_name(p)} — {a}% of prescribed sessions")

    lines.append(f"\n:white_check_mark: *{len(on_track)} patient(s) on track* (no open flags).")
    return "\n".join(lines)


def send_daily_digest():
    from api.core.models import ClinicianProfile

    # Detect time-based escalations (missed sessions) before summarising.
    refresh_all_escalations()

    if not getattr(settings, 'SLACK_BOT_TOKEN', ''):
        logger.warning("SLACK_BOT_TOKEN not configured — skipping digest")
        return

    client = _get_slack_client()
    linked = ClinicianProfile.objects.exclude(slack_user_id="")
    sent = 0
    for clinician in linked:
        dm = _dm_channel(clinician)
        if not dm:
            continue
        client.chat_postMessage(channel=dm, text=_digest_lines_for(clinician))
        sent += 1
    logger.info("Daily digest sent to %d clinician(s)", sent)


# ── On-demand patient summary blocks ─────────────────────────

def build_patient_summary_blocks(patient):
    from api.core.analytics import adherence_pct
    from api.sessions.models import Session

    name       = _patient_name(patient)
    last_7d    = timezone.now() - timedelta(days=7)
    sessions   = Session.objects.filter(patient=patient, started_at__gte=last_7d).order_by('-started_at')[:5]
    pain_log   = patient.pain_checkins.order_by('-checked_at').first()

    # Trend sparklines over the last ~8 sessions (oldest → newest).
    recent = list(
        Session.objects.filter(patient=patient).order_by('-started_at')[:8]
    )[::-1]
    quality_spark = _sparkline([s.quality_score for s in recent], lo=0, hi=100)
    pain_spark    = _sparkline([s.pain_level for s in recent], lo=0, hi=10)
    adherence     = adherence_pct(patient)

    lines = [f"*Patient summary: {name}*"]
    lines.append(f"Goal: {patient.goal or '—'} | Care path: {patient.care_path or '—'}")
    lines.append(
        f"Quality `{quality_spark}` · Pain `{pain_spark}` · "
        f"Adherence {adherence if adherence is not None else '—'}%"
    )

    if sessions:
        lines.append(f"\n*Last {sessions.count()} session(s) this week:*")
        for s in sessions:
            lines.append(f"  • {s.exercise.name}: {s.reps_completed}/{s.reps_target} reps, quality {s.quality_score or '—'}/100")
    else:
        lines.append("\nNo sessions in the last 7 days.")

    if pain_log:
        lines.append(f"\n*Latest pain check-in:* {pain_log.pain_level}/10 ({pain_log.checked_at.strftime('%d %b')})")

    open_escs = patient.escalations.filter(status='open')
    if open_escs.exists():
        lines.append(f"\n:rotating_light: *{open_escs.count()} open escalation(s)*")

    return [{"type": "section", "text": {"type": "mrkdwn", "text": "\n".join(lines)}}]


def build_roster_summary_blocks(clinician=None):
    """
    Roster scan — the 'check everyone at once' view. When `clinician` is given the
    scan is scoped to that clinician's own patients (the `my patients` command);
    without it, it covers the whole DB (the global `summary` command).
    """
    from api.core.analytics import adherence_pct, session_quality_trend
    from api.core.models import PatientProfile

    qs = PatientProfile.objects.select_related('user').prefetch_related(
        'sessions', 'prescriptions', 'escalations'
    )
    if clinician is not None:
        qs = qs.filter(primary_clinician=clinician)
    patients = list(qs)
    if not patients:
        empty = "You have no linked patients yet." if clinician else "No patients on record."
        return [{"type": "section", "text": {"type": "mrkdwn", "text": empty}}]

    needs_attention = []
    on_track = 0
    adherences = []
    for p in patients:
        a = adherence_pct(p)
        if a is not None:
            adherences.append(a)
        open_count = p.escalations.filter(status='open').count()
        declining = session_quality_trend(p) == 'declining'
        if open_count or declining:
            reason = "open flag" if open_count else "declining trend"
            needs_attention.append(f"  • {_patient_name(p)} — {reason}")
        else:
            on_track += 1

    avg_adherence = round(sum(adherences) / len(adherences)) if adherences else None

    header = "Your roster" if clinician else "Roster summary"
    lines = [f":clipboard: *{header} — {len(patients)} patient(s)*"]
    lines.append(
        f"Needs attention: *{len(needs_attention)}* · On track: *{on_track}* · "
        f"Avg adherence: {avg_adherence if avg_adherence is not None else '—'}%"
    )
    if needs_attention:
        lines.append("\n*Needs attention:*")
        lines.extend(needs_attention[:10])
    else:
        lines.append("\n:white_check_mark: Everyone is on track.")

    return [{"type": "section", "text": {"type": "mrkdwn", "text": "\n".join(lines)}}]


def find_patient_by_name(name_query, clinician=None):
    """Find a patient by (partial) name. When `clinician` is given, only their
    own patients are searched — so a linked clinician can't reach another's."""
    from api.core.models import PatientProfile

    normalized_query = " ".join(name_query.casefold().strip().split())
    parts = normalized_query.split()
    if not parts:
        return None
    name_filter = Q()
    for part in parts:
        name_filter |= Q(user__first_name__icontains=part) | Q(user__last_name__icontains=part)
    qs = (
        PatientProfile.objects
        .select_related('user')
        .prefetch_related('sessions', 'pain_checkins', 'escalations')
    )
    if clinician is not None:
        qs = qs.filter(primary_clinician=clinician)
    # Prefer an exact full-name match. This matters for short or numbered demo
    # names such as "test 2" when the same roster also contains "test test".
    candidates = list(qs)
    for patient in candidates:
        full_name = " ".join(patient.user.get_full_name().casefold().split())
        if full_name == normalized_query:
            return patient
    return qs.filter(name_filter).first()


def roster_names(clinician):
    """Full names of the clinician's patients, for the 'pick a patient' hint."""
    from api.core.models import PatientProfile

    return [
        _patient_name(p)
        for p in PatientProfile.objects.filter(primary_clinician=clinician)
        .select_related("user")
    ]


def find_clinician_by_slack_user(slack_user_id):
    """Resolve the linked clinician for a Slack user id (set via the link flow)."""
    from api.core.models import ClinicianProfile

    if not slack_user_id:
        return None
    return (
        ClinicianProfile.objects.select_related('user')
        .filter(slack_user_id=slack_user_id)
        .first()
    )


def _section(text):
    return [{"type": "section", "text": {"type": "mrkdwn", "text": text}}]


# ── Tier 1: triage scoped to the linked clinician ─────────────

def build_needs_review_blocks(clinician):
    """Open escalations across the clinician's own patients."""
    from api.consultations.models import Escalation

    escs = (
        Escalation.objects.filter(status='open', patient__primary_clinician=clinician)
        .select_related('patient__user')
        .order_by('-created_at')
    )
    if not escs:
        return _section(":white_check_mark: No open escalations — your roster is clear.")

    lines = [f":rotating_light: *Open escalations — {escs.count()}*"]
    for e in escs[:15]:
        label = TRIGGER_LABELS.get(e.trigger_type, e.trigger_type)
        lines.append(f"  • *{_patient_name(e.patient)}* — {label}: {e.description}")
    lines.append("\n_Resolve one with_ `@Physio Assistant resolve [name]`")
    return _section("\n".join(lines))


def resolve_patient_escalations(clinician, name_query):
    """
    Mark all OPEN escalations for the named patient as action-taken, attributed to
    this clinician. Returns (patient, count_resolved, error).
    """
    from api.consultations.models import EscalationStatus

    patient = find_patient_by_name(name_query, clinician=clinician)
    if not patient:
        return None, 0, f"No patient matching '{name_query}' in your roster."

    open_escs = patient.escalations.filter(status=EscalationStatus.OPEN)
    count = open_escs.count()
    if count:
        open_escs.update(
            status=EscalationStatus.ACTION_TAKEN,
            reviewed_by=clinician,
            reviewed_at=timezone.now(),
            updated_at=timezone.now(),
        )
    return patient, count, None


def build_today_blocks(clinician):
    """Today's consultations + flags raised in the last 24h, for this clinician."""
    from api.consultations.models import Consultation, Escalation

    now = timezone.localtime()
    day_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    day_end = day_start + timedelta(days=1)

    consults = (
        Consultation.objects.filter(
            clinician=clinician, scheduled_at__gte=day_start, scheduled_at__lt=day_end
        )
        .select_related('patient__user')
        .order_by('scheduled_at')
    )
    new_escs = (
        Escalation.objects.filter(
            patient__primary_clinician=clinician, status='open',
            created_at__gte=now - timedelta(hours=24),
        )
        .select_related('patient__user')
    )

    lines = [f":calendar: *Today — {now:%A, %d %b}*"]
    lines.append(f"\n*Consultations ({consults.count()}):*")
    if consults:
        for c in consults:
            lines.append(f"  • {c.scheduled_at:%H:%M} — {_patient_name(c.patient)} ({c.status})")
    else:
        lines.append("  • None scheduled")

    lines.append(f"\n*New flags (last 24h): {new_escs.count()}*")
    for e in new_escs[:5]:
        lines.append(f"  • {_patient_name(e.patient)} — {TRIGGER_LABELS.get(e.trigger_type, e.trigger_type)}")
    return _section("\n".join(lines))


# ── Tier 2: quick per-patient lookups ─────────────────────────

def build_pain_blocks(patient):
    name = _patient_name(patient)
    pains = patient.pain_checkins.order_by('-checked_at')[:7]
    if not pains:
        return _section(f"No pain check-ins on record for {name}.")
    lines = [f"*Pain diary — {name}*"]
    for p in pains:
        note = f" · {p.location_notes}" if p.location_notes else ""
        lines.append(f"  • {p.checked_at:%d %b}: {p.pain_level}/10{note}")
    return _section("\n".join(lines))


def build_adherence_blocks(patient):
    from api.core.analytics import adherence_pct, session_quality_trend
    from api.sessions.models import Session

    name = _patient_name(patient)
    adherence = adherence_pct(patient)
    trend = session_quality_trend(patient)
    last_7d = timezone.now() - timedelta(days=7)
    recent_count = Session.objects.filter(patient=patient, started_at__gte=last_7d).count()
    return _section(
        f"*{name}*\n"
        f"Adherence: *{adherence if adherence is not None else '—'}%* · "
        f"Quality trend: *{trend}* · "
        f"{recent_count} session(s) in the last 7 days"
    )


def build_sessions_blocks(patient):
    from api.sessions.models import Session

    name = _patient_name(patient)
    sessions = Session.objects.filter(patient=patient).select_related('exercise').order_by('-started_at')[:6]
    if not sessions:
        return _section(f"No sessions logged for {name}.")
    lines = [f"*Recent sessions — {name}*"]
    for s in sessions:
        lines.append(
            f"  • {s.started_at:%d %b} · {s.exercise.name}: "
            f"{s.reps_completed}/{s.reps_target} reps, quality {s.quality_score or '—'}/100"
            f"{f', pain {s.pain_level}/10' if s.pain_level is not None else ''}"
        )
    return _section("\n".join(lines))


# ── Tier 3: write-back actions that close a loop ──────────────

def send_patient_message(clinician, name_query):
    """
    Draft an encouraging message and actually email it to the patient.
    Returns (patient, sent_body, error).
    """
    from api.core.email_delivery import EmailDeliveryError, deliver_email

    patient = find_patient_by_name(name_query, clinician=clinician)
    if not patient:
        return None, None, f"No patient matching '{name_query}' in your roster."
    recipient = patient.user.email
    if not recipient:
        return patient, None, f"{patient.user.first_name} has no email address on file."

    body = generate_patient_message(patient)
    if body.startswith("GEMINI_API_KEY not configured"):
        return patient, None, body

    try:
        deliver_email(
            subject="A note from your physiotherapy team",
            message=body,
            recipient=recipient,
        )
    except EmailDeliveryError as exc:
        return patient, None, f"Drafted, but the email could not be sent: {exc}"
    return patient, body, None


def confirm_consultation(clinician, name_query):
    """Confirm the patient's soonest pending (requested) consultation. Returns
    (consultation, error)."""
    from api.consultations.models import Consultation, ConsultationStatus

    patient = find_patient_by_name(name_query, clinician=clinician)
    if not patient:
        return None, f"No patient matching '{name_query}' in your roster."

    consult = (
        Consultation.objects.filter(
            patient=patient, clinician=clinician, status=ConsultationStatus.REQUESTED,
        )
        .order_by('scheduled_at')
        .first()
    )
    if not consult:
        return None, f"{patient.user.first_name} has no pending consultation to confirm."

    consult.status = ConsultationStatus.CONFIRMED
    consult.save(update_fields=['status', 'updated_at'])
    return consult, None


def assign_exercise(clinician, exercise_query, name_query):
    """
    Create an active prescription (sensible defaults), retiring any earlier active
    one for the same exercise. Returns (patient, (exercise, prescription), error).
    """
    from api.catalogue.models import Exercise, Prescription

    patient = find_patient_by_name(name_query, clinician=clinician)
    if not patient:
        return None, None, f"No patient matching '{name_query}' in your roster."

    exercise = Exercise.objects.filter(
        is_active=True, name__icontains=exercise_query,
    ).first()
    if not exercise:
        return patient, None, f"No active exercise matching '{exercise_query}'."

    # Honour the one-active-prescription-per-(patient, exercise) constraint.
    Prescription.objects.filter(
        patient=patient, exercise=exercise, is_active=True,
    ).update(is_active=False)

    prescription = Prescription.objects.create(
        patient=patient, clinician=clinician, exercise=exercise,
        sets=3, reps=10, days_per_week="3",
        valid_from=timezone.localdate(), is_active=True,
    )
    return patient, (exercise, prescription), None


# ── Conversational AI programme builder ───────────────────────

HIGH_PAIN = 7  # peak pain at/above this pulls the dose down and warns the planner


def _patient_age(patient):
    dob = getattr(patient.user, "date_of_birth", None)
    if not dob:
        return None
    today = timezone.localdate()
    return today.year - dob.year - ((today.month, today.day) < (dob.month, dob.day))


def _clinical_context(patient):
    """Snapshot of how the patient is actually doing — feeds the planner prompt
    and the dose decision. Never raises; missing data just means fewer signals."""
    from api.core.analytics import adherence_pct, session_quality_trend
    from api.sessions.models import Session

    recent = list(Session.objects.filter(patient=patient).order_by("-started_at")[:5])
    pains = [s.pain_level for s in recent if s.pain_level is not None]
    latest_pain = patient.pain_checkins.order_by("-checked_at").first()
    pain_loc = ""
    if latest_pain and latest_pain.pain_level is not None:
        pains.append(latest_pain.pain_level)
        pain_loc = latest_pain.location_notes or ""
    qualities = [s.quality_score for s in recent if s.quality_score is not None]

    return {
        "age": _patient_age(patient),
        "max_pain": max(pains) if pains else None,
        "pain_loc": pain_loc,
        "avg_quality": round(sum(qualities) / len(qualities)) if qualities else None,
        "trend": session_quality_trend(patient),
        "symmetry": sum(s.symmetry_warnings_count for s in recent),
        "adherence": adherence_pct(patient),
        "open_flags": list(dict.fromkeys(
            TRIGGER_LABELS.get(e.trigger_type, e.trigger_type)
            for e in patient.escalations.filter(status="open")
        )),
        "current_rx": [
            f"{p.exercise.name} {p.sets}×{p.reps}"
            for p in patient.prescriptions.filter(is_active=True).select_related("exercise")
        ],
    }


def _clinical_summary_line(ctx):
    """Short human-readable 'what I looked at' line for the Slack draft."""
    bits = []
    if ctx["age"] is not None:
        bits.append(f"age {ctx['age']}")
    if ctx["max_pain"] is not None:
        bits.append(f"peak pain {ctx['max_pain']}/10")
    if ctx["avg_quality"] is not None:
        bits.append(f"quality {ctx['avg_quality']}/100 ({ctx['trend']})")
    if ctx["symmetry"]:
        bits.append(f"{ctx['symmetry']} symmetry warnings")
    if ctx["adherence"] is not None:
        bits.append(f"adherence {ctx['adherence']}%")
    if ctx["open_flags"]:
        bits.append("flags: " + ", ".join(ctx["open_flags"]))
    if ctx["current_rx"]:
        bits.append("current: " + ", ".join(ctx["current_rx"]))
    return "; ".join(bits) if bits else "no recent activity on record"


def _clinical_notes_text(ctx):
    """Directive planning notes injected into the agent prompt (user_notes)."""
    notes = [f"Clinical context — {_clinical_summary_line(ctx)}."]
    if ctx["max_pain"] is not None and ctx["max_pain"] >= HIGH_PAIN:
        where = f" around {ctx['pain_loc']}" if ctx["pain_loc"] else ""
        notes.append(
            f"Pain is elevated{where}: avoid exercises that heavily load the painful "
            "area, prefer gentle mobility/stretching, and keep intensity low."
        )
    if ctx["trend"] == "declining":
        notes.append("Movement quality is declining: keep the plan simple and easy to perform well.")
    if ctx["current_rx"]:
        notes.append("Complement (do not exactly duplicate) the current programme where sensible.")
    return " ".join(notes)


def _suggested_dose(exercise, ctx):
    """Adapt sets/reps to the clinical picture; conservative when pain is high or
    quality is declining, otherwise the exercise's reviewed defaults."""
    sets = exercise.default_sets or 3
    reps = exercise.default_reps or 10
    conservative = (
        (ctx["max_pain"] is not None and ctx["max_pain"] >= HIGH_PAIN)
        or ctx["trend"] == "declining"
    )
    if conservative:
        sets = max(1, sets - 1)
        reps = max(5, round(reps * 0.7))
    return sets, reps


def _plan_preferences(patient, ctx, *, days_per_week=3, equipment="chair"):
    """Seed the wellness agent from the patient's profile, knobs, and clinical context."""
    return {
        "goal": patient.goal or "stay_active",
        "custom_goal": patient.custom_goal or "",
        "activity_level": patient.activity_level or "",
        "focus_side": patient.focus_side or "",
        "cue_style": patient.cue_style or "",
        "height_cm": patient.height_cm,
        "weight_kg": patient.weight_kg,
        "age": ctx["age"],
        "days_per_week": days_per_week,
        "equipment": equipment,
        "planning_notes": _clinical_notes_text(ctx),
    }


def _unique_exercise_ids(plan):
    ids = []
    for day in plan.get("days", []):
        for eid in day.get("exercise_ids", day.get("exerciseIds", [])):
            if eid not in ids:
                ids.append(eid)
    return ids


def _dose_map(plan, ctx):
    """Per-exercise {sets, reps} for the plan's exercises, given the clinical context."""
    from api.catalogue.models import Exercise

    ids = _unique_exercise_ids(plan)
    ex_map = {e.id: e for e in Exercise.objects.filter(id__in=ids)}
    dose = {}
    for eid in ids:
        ex = ex_map.get(eid)
        if ex:
            sets, reps = _suggested_dose(ex, ctx)
            dose[eid] = {"sets": sets, "reps": reps}
    return dose


def _stage_draft(patient, clinician, plan, prefs, ctx):
    from api.core.models import SlackPlanDraft

    prefs = dict(prefs)
    prefs["dose"] = _dose_map(plan, ctx)
    prefs["clinical_summary"] = _clinical_summary_line(ctx)
    draft, _ = SlackPlanDraft.objects.update_or_create(
        patient=patient,
        defaults={"clinician": clinician, "plan": plan, "preferences": prefs},
    )
    return draft


def build_plan_draft(clinician, name_query, *, days_per_week=3, equipment="chair"):
    """Generate a clinically-informed AI programme draft and stage it.
    Returns (patient, draft, error)."""
    from api.core.wellness_agent import generate_wellness_plan

    patient = find_patient_by_name(name_query, clinician=clinician)
    if not patient:
        return None, None, f"No patient matching '{name_query}' in your roster."

    ctx = _clinical_context(patient)
    prefs = _plan_preferences(patient, ctx, days_per_week=days_per_week, equipment=equipment)
    try:
        plan = generate_wellness_plan(patient.user, prefs)
    except Exception:
        logger.exception("Slack plan builder failed for patient %s", patient.id)
        return patient, None, "The AI planner is unavailable right now — no draft saved."

    draft = _stage_draft(patient, clinician, plan, prefs, ctx)
    return patient, draft, None


def revise_plan_draft(clinician, name_query, instruction):
    """Regenerate the staged draft with a revision, refreshing clinical context.
    Returns (patient, draft, error)."""
    from api.core.models import SlackPlanDraft
    from api.core.wellness_agent import generate_wellness_plan

    patient = find_patient_by_name(name_query, clinician=clinician)
    if not patient:
        return None, None, f"No patient matching '{name_query}' in your roster."

    draft = SlackPlanDraft.objects.filter(patient=patient).first()
    if not draft:
        return patient, None, f"No draft for {patient.user.first_name} — start with `build a plan for {patient.user.first_name}`."

    ctx = _clinical_context(patient)
    prefs = dict(draft.preferences)
    prefs["planning_notes"] = _clinical_notes_text(ctx)
    prefs["age"] = ctx["age"]
    try:
        plan = generate_wellness_plan(
            patient.user, prefs, previous_plan=draft.plan, revision=instruction,
        )
    except Exception:
        logger.exception("Slack plan revision failed for patient %s", patient.id)
        return patient, None, "The AI planner is unavailable right now — the draft is unchanged."

    draft = _stage_draft(patient, clinician, plan, prefs, ctx)
    return patient, draft, None


def accept_plan_draft(clinician, name_query):
    """Turn the staged draft into active Prescriptions (clinically-adapted dose)
    and clear it. Returns (patient, created_count, error)."""
    from api.catalogue.models import Exercise, Prescription
    from api.core.models import SlackPlanDraft

    patient = find_patient_by_name(name_query, clinician=clinician)
    if not patient:
        return None, 0, f"No patient matching '{name_query}' in your roster."

    draft = SlackPlanDraft.objects.filter(patient=patient).first()
    if not draft:
        return patient, 0, f"No draft for {patient.user.first_name} — build one first with `build a plan for {patient.user.first_name}`."

    ids = _unique_exercise_ids(draft.plan)
    exercises = {e.id: e for e in Exercise.objects.filter(id__in=ids, is_active=True)}
    dose = draft.preferences.get("dose", {})
    days_per_week = str(draft.preferences.get("days_per_week", 3))

    created = 0
    for eid in ids:
        ex = exercises.get(eid)
        if not ex:
            continue
        d = dose.get(eid, {})
        Prescription.objects.filter(
            patient=patient, exercise=ex, is_active=True,
        ).update(is_active=False)
        Prescription.objects.create(
            patient=patient, clinician=clinician, exercise=ex,
            sets=d.get("sets", ex.default_sets), reps=d.get("reps", ex.default_reps),
            hold_seconds=ex.default_hold_seconds,
            days_per_week=days_per_week,
            valid_from=timezone.localdate(), is_active=True,
            notes="Drafted via Physio Assistant (AI).",
        )
        created += 1

    draft.delete()
    return patient, created, None


def build_plan_draft_blocks(draft):
    """Render a staged draft: what informed it + exercises with adapted dose."""
    from api.catalogue.models import Exercise

    patient = draft.patient
    plan = draft.plan
    dose = draft.preferences.get("dose", {})
    name = _patient_name(patient)
    ids = _unique_exercise_ids(plan)
    ex_map = {e.id: e for e in Exercise.objects.filter(id__in=ids)}
    dpw = plan.get("constraints", {}).get("days_per_week", 3)

    lines = [f":clipboard: *Draft programme — {name}*"]
    if draft.preferences.get("clinical_summary"):
        lines.append(f":microscope: _Considered: {draft.preferences['clinical_summary']}_")
    if plan.get("summary"):
        lines.append(f"_{plan['summary']}_")
    lines.append("")
    for eid in ids:
        ex = ex_map.get(eid)
        if ex:
            d = dose.get(eid, {})
            sets = d.get("sets", ex.default_sets)
            reps = d.get("reps", ex.default_reps)
            lines.append(f"  • *{ex.name}* — {sets}×{reps}, {dpw}×/wk")
        else:
            lines.append(f"  • {eid} — _not in your exercise library, will be skipped_")
    first = patient.user.first_name
    lines.append(
        f"\n_Reply_ `revise {first} [change]` _or_ `accept plan for {first}`"
    )
    return _section("\n".join(lines))


# ── Draft a patient-facing message (draft-only for now) ───────

def generate_patient_message(patient):
    """
    Draft a short, warm message to the patient (e.g. an encouragement / adherence
    nudge). Draft-only: the therapist copies it out. A future version will email it.
    """
    if not getattr(settings, 'GEMINI_API_KEY', ''):
        return "GEMINI_API_KEY not configured — cannot draft a message."

    from api.core.analytics import adherence_pct, session_quality_trend

    name = patient.user.first_name or "there"
    trend = session_quality_trend(patient)
    adherence = adherence_pct(patient)
    prompt = (
        "You are a physiotherapist's assistant drafting a short, warm, encouraging "
        "message to an older-adult rehab patient. 2-4 sentences, plain language, no "
        "medical advice or prescription changes. Acknowledge their effort and gently "
        "encourage consistency.\n\n"
        f"Patient first name: {name}\n"
        f"Recent movement-quality trend: {trend}\n"
        f"Adherence to prescribed sessions: "
        f"{adherence if adherence is not None else 'unknown'}%\n"
    )
    return _gemini_generate(prompt)


# ── Schedule a consultation from Slack ────────────────────────

def schedule_consultation(patient, when_text):
    """
    Create a Consultation for the patient with their primary clinician.
    Runs server-side, so the patient-only API restriction does not apply.
    Returns (consultation, error_message).
    """
    from api.consultations.models import (
        Consultation,
        ConsultationInitiator,
        ConsultationStatus,
    )

    if patient.primary_clinician is None:
        return None, "This patient has no linked clinician to book with."

    scheduled_at = _parse_when(when_text)
    if scheduled_at is None:
        return None, f"Could not understand the time '{when_text}'. Try e.g. 'Thursday 3pm'."

    # Clinician suggests the time; it awaits the patient's acceptance.
    consultation = Consultation.objects.create(
        patient=patient,
        clinician=patient.primary_clinician,
        scheduled_at=scheduled_at,
        status=ConsultationStatus.REQUESTED,
        initiated_by=ConsultationInitiator.CLINICIAN,
    )
    return consultation, None


def _parse_when(when_text):
    """Best-effort natural-time parsing; returns an aware datetime or None."""
    try:
        from dateutil import parser as date_parser
    except ImportError:
        return None
    try:
        dt = date_parser.parse(when_text, fuzzy=True, default=timezone.localtime())
    except (ValueError, OverflowError):
        return None
    if timezone.is_naive(dt):
        dt = timezone.make_aware(dt, timezone.get_current_timezone())
    return dt


# ── Draft clinical note via Gemini ────────────────────────────

def generate_clinical_note(session):
    if not getattr(settings, 'GEMINI_API_KEY', ''):
        return "GEMINI_API_KEY not configured — cannot generate note."

    prompt = f"""Draft a structured physiotherapy session note from this data.

Exercise: {session.exercise.name}
Date: {session.started_at.strftime('%Y-%m-%d')}
Sets completed: {session.sets_completed}/{session.sets_target}
Reps completed: {session.reps_completed}/{session.reps_target}
Minimum repetitions for completion: {session.reps_minimum or session.reps_target}
Early stop reason: {session.stop_reason or 'Not recorded'}
Early stop review flag: {session.stop_requires_review}
Quality score: {session.quality_score}/100
Pain level reported: {session.pain_level}/10
Movement angle summaries: {session.angle_summaries}
Coaching cues triggered: {session.cues_triggered}
Symmetry warnings: {session.symmetry_warnings_count}

Write a concise SOAP-format note (Subjective, Objective, Assessment, Plan) \
suitable for a clinical record. Be specific about angles and quality metrics. \
Keep it under 200 words."""

    return _gemini_generate(prompt)
