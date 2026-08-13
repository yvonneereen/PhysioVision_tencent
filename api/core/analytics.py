"""
Shared patient-analytics helpers.

These were originally inlined in PatientListSerializer. They are factored out here
so the escalation rule engine (api/consultations/escalation_service.py) and the
Slack digest can reuse the exact same trend/adherence definitions the dashboard shows.
"""
import re
from datetime import timedelta

from django.utils import timezone

# How much a validation-gated coaching-response score must move between the
# oldest and newest comparable sessions before it is labelled a trend.
TREND_DELTA = 5
ADHERENCE_LOOKBACK_DAYS = 7


def parse_days_per_week(value):
    """Parse '4–5' or '4-5' or '4' → int lower bound (defaults to 1)."""
    try:
        return int(re.split(r'[–\-]', str(value))[0])
    except (ValueError, TypeError):
        return 1


def session_quality_trend(patient):
    """
    Return a same-exercise/side trend from the last three validation-gated
    camera coaching-response scores. Raw angle means are not comparable across
    exercises and unvalidated observations must not influence care planning.
    """
    sessions = [
        session
        for session in patient.sessions.order_by('-started_at')[:20]
        if (
            session.quality_score is not None
            and session.assessment_summary.get(
                'movement_execution', {}
            ).get('status') == 'assessed'
        )
    ]
    if not sessions:
        return 'stable'
    focus = sessions[0]
    comparable = [
        session for session in sessions
        if (
            session.exercise_id == focus.exercise_id
            and session.affected_side == focus.affected_side
        )
    ][:3]
    if len(comparable) < 2:
        return 'stable'
    scores = [float(session.quality_score) for session in reversed(comparable)]
    delta = scores[-1] - scores[0]
    if delta > TREND_DELTA:
        return 'improving'
    if delta < -TREND_DELTA:
        return 'declining'
    return 'stable'


def adherence_pct(patient):
    """
    Sessions in the last 7 days vs the highest prescribed days/week, capped at 100.
    Returns None when the patient has no active prescription.
    """
    prescriptions = [p for p in patient.prescriptions.all() if p.is_active]
    if not prescriptions:
        return None
    week_ago = timezone.now() - timedelta(days=ADHERENCE_LOOKBACK_DAYS)
    sessions_last_7d = patient.sessions.filter(started_at__gte=week_ago).count()
    target = max(parse_days_per_week(p.days_per_week) for p in prescriptions)
    return min(100, round(sessions_last_7d / target * 100)) if target else None
