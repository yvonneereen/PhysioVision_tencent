"""
Escalation rule engine.

Detects concerning patient trends and creates `Escalation` rows. Creating an OPEN
escalation is the single event that lights up BOTH surfaces:
  • Slack   — via the `on_escalation_created` post_save signal (slack_bot/services.py)
  • Dashboard — via `open_escalations_count` (core/serializers.py)

Each rule is deduplicated: it will not raise a second OPEN escalation of the same
trigger_type while an earlier one is still awaiting review.
"""
import logging
from datetime import timedelta

from django.utils import timezone

from api.core.analytics import adherence_pct, session_quality_trend
from api.sessions.models import PainCheckin, Session

from .models import Escalation, EscalationStatus, EscalationTrigger

logger = logging.getLogger(__name__)

# Tunable thresholds.
PAIN_THRESHOLD = 7                 # a pain report at or above this flags the patient
SYMMETRY_WARNINGS_THRESHOLD = 3    # symmetry warnings in the latest session
MISSED_LOOKBACK_DAYS = 7           # window with an active prescription but no sessions


def _has_open(patient, trigger_type):
    return patient.escalations.filter(
        status=EscalationStatus.OPEN, trigger_type=trigger_type
    ).exists()


def _raise(patient, trigger_type, description, session=None):
    escalation = Escalation.objects.create(
        patient=patient,
        clinician=patient.primary_clinician,
        trigger_type=trigger_type,
        description=description,
        session=session,
        status=EscalationStatus.OPEN,
    )
    logger.info("Auto-escalation %s raised for patient %s", trigger_type, patient.id)
    return escalation


def _latest_pain_level(patient, session=None):
    """Highest of the latest pain check-in and the triggering session's pain."""
    values = []
    checkin = patient.pain_checkins.order_by('-checked_at').first()
    if checkin and checkin.pain_level is not None:
        values.append(checkin.pain_level)
    if session is not None and session.pain_level is not None:
        values.append(session.pain_level)
    return max(values) if values else None


def evaluate_patient_escalations(patient, *, session=None):
    """
    Run every rule for one patient and create any missing OPEN escalations.
    Returns the list of newly created Escalation rows. Never raises — a failure
    here must not break the session/check-in save that triggered it.
    """
    created = []
    try:
        # 1. Pain increase
        pain = _latest_pain_level(patient, session=session)
        if pain is not None and pain >= PAIN_THRESHOLD and not _has_open(
            patient, EscalationTrigger.PAIN_INCREASE
        ):
            created.append(_raise(
                patient, EscalationTrigger.PAIN_INCREASE,
                f"Reported pain reached {pain}/10 (threshold {PAIN_THRESHOLD}).",
                session=session,
            ))

        # 2. Validation-gated coaching-response decline
        if session_quality_trend(patient) == 'declining' and not _has_open(
            patient, EscalationTrigger.QUALITY_DECLINE
        ):
            created.append(_raise(
                patient, EscalationTrigger.QUALITY_DECLINE,
                "A validated same-exercise camera coaching-response trend is declining.",
                session=session,
            ))

        # 3. Symmetry concern
        latest = session or patient.sessions.order_by('-started_at').first()
        latest_execution = (
            latest.assessment_summary.get("movement_execution", {})
            if latest is not None else {}
        )
        if (
            latest is not None
            and latest_execution.get("status") == "assessed"
            and latest_execution.get("symmetry_rule_validated") is True
            and latest.symmetry_warnings_count >= SYMMETRY_WARNINGS_THRESHOLD
            and not _has_open(patient, EscalationTrigger.SYMMETRY_CONCERN)
        ):
            created.append(_raise(
                patient, EscalationTrigger.SYMMETRY_CONCERN,
                f"{latest.symmetry_warnings_count} validation-gated symmetry warnings in the latest session.",
                session=latest,
            ))

        # 4. Missed sessions — active prescription but nothing logged this week.
        if _is_missing_sessions(patient) and not _has_open(
            patient, EscalationTrigger.MISSED_SESSIONS
        ):
            created.append(_raise(
                patient, EscalationTrigger.MISSED_SESSIONS,
                f"No sessions logged in the last {MISSED_LOOKBACK_DAYS} days "
                "despite an active prescription.",
            ))
    except Exception:  # pragma: no cover - defensive; must never break the caller
        logger.exception("Escalation evaluation failed for patient %s", patient.id)

    return created


def _is_missing_sessions(patient):
    has_active_rx = any(p.is_active for p in patient.prescriptions.all())
    if not has_active_rx:
        return False
    window_start = timezone.now() - timedelta(days=MISSED_LOOKBACK_DAYS)
    return not patient.sessions.filter(started_at__gte=window_start).exists()
