"""AI-assisted consultation drafts built from authenticated patient records."""

import json
import re
from collections import Counter

from django.conf import settings
from django.utils import timezone

class ConsultationDraftUnavailable(RuntimeError):
    """Raised when a safe editable draft cannot be produced."""


LOCALE_NAMES = {
    'en-SG': 'English',
    'zh-SG': 'Simplified Chinese',
    'ms-SG': 'Malay',
    'ta-SG': 'Tamil',
}


def build_consultation_facts(patient):
    """Return a small factual record set scoped to one authenticated patient."""
    sessions = list(
        patient.sessions
        .select_related('exercise')
        .order_by('-started_at')[:7]
    )
    checkins = list(patient.pain_checkins.order_by('-checked_at')[:7])
    escalations = list(
        patient.escalations
        .filter(status='open')
        .order_by('-created_at')[:3]
    )

    cue_counts = Counter()
    for session in sessions:
        for cue in session.cues_triggered or []:
            cue_data = cue if isinstance(cue, dict) else {}
            text = ' '.join(str(cue_data.get('cue_text', cue)).split())
            if text:
                try:
                    count = max(1, int(cue_data.get('trigger_count') or 1))
                except (TypeError, ValueError):
                    count = 1
                cue_counts[text[:180]] += count

    return {
        'generated_at': timezone.now().isoformat(),
        'recent_sessions': [
            {
                'date': session.started_at.date().isoformat(),
                'exercise': session.exercise.name,
                'sets_completed': session.sets_completed,
                'sets_target': session.sets_target,
                'reps_completed': session.reps_completed,
                'reps_target': session.reps_target,
                'pain_level': session.pain_level,
                'quality_score': (
                    float(session.quality_score)
                    if (
                        session.quality_score is not None
                        and session.assessment_summary.get(
                            'movement_execution', {}
                        ).get('status') == 'assessed'
                    ) else None
                ),
                'movement_assessment': session.assessment_summary or None,
                'low_confidence_frames_pct': (
                    float(session.low_confidence_frames_pct)
                    if session.low_confidence_frames_pct is not None else None
                ),
                'symmetry_warnings': session.symmetry_warnings_count,
            }
            for session in sessions
        ],
        'recent_pain_checkins': [
            {
                'date': checkin.checked_at.date().isoformat(),
                'pain_level': checkin.pain_level,
                'timing': checkin.timing,
                'recovery_status': checkin.recovery_status or None,
                'location_notes': checkin.location_notes or None,
                'requires_review': checkin.requires_review,
            }
            for checkin in checkins
        ],
        'recurring_tracking_cues': [
            {'cue': cue, 'count': count}
            for cue, count in cue_counts.most_common(3)
        ],
        'open_review_flags': [
            {
                'type': escalation.trigger_type,
                'description': escalation.description,
                'created_at': escalation.created_at.date().isoformat(),
            }
            for escalation in escalations
        ],
    }


def _normalize_draft(text):
    draft = ' '.join(str(text or '').split()).strip(' \t\r\n"“”')
    draft = re.sub(
        r'\s*Please review (?:these|my|the) recent PhysioVision records'
        r'(?: when you are able)?[.!?]?\s*$',
        '',
        draft,
        flags=re.IGNORECASE,
    ).rstrip()
    if not draft:
        raise ConsultationDraftUnavailable('The provider returned an empty draft.')
    if len(draft) > 1000:
        draft = draft[:1000].rsplit(' ', 1)[0].rstrip(' ,;:')
        if draft and draft[-1] not in '.!?。！？':
            draft += '.'
    return draft


def generate_consultation_draft(patient, locale='en-SG'):
    """Generate a patient-editable, non-diagnostic consultation message."""
    if not settings.GEMINI_API_KEY:
        raise ConsultationDraftUnavailable('The AI provider is not configured.')

    safe_locale = locale if locale in LOCALE_NAMES else 'en-SG'
    facts = build_consultation_facts(patient)
    prompt = (
        'Draft a consultation request in the patient\'s first-person voice using '
        f'{LOCALE_NAMES[safe_locale]}. Use only the recorded facts in the JSON. '
        'Write 2 to 4 short sentences and no more than 900 characters. Start '
        'directly with the concrete reason a physiotherapist should review the '
        'request. Prioritise open review flags, pain check-ins requiring review, '
        'the latest recorded pain level and location, recovery response, and then '
        'useful dated session evidence. The physiotherapist assigned the exercise '
        'programme, so do not describe an exercise or a stored wellness profile '
        'goal as the patient\'s goal. Do not add a broad overall movement-quality '
        'label such as "stable" as filler. Do not add a generic request to review '
        'recent PhysioVision records, including "Please review these recent '
        'PhysioVision records when you are able." End after the last concrete '
        'recorded concern or relevant detail. If records are sparse, ask to arrange '
        'a consultation without inventing a reason. Do not '
        'diagnose, infer a cause, claim urgency, recommend treatment, change an '
        'exercise plan, or invent symptoms. Do not include a heading, bullets, '
        'quotation marks, or commentary. '
        'The patient will review and edit the message before sending.\n\n'
        f'Recorded facts:\n{json.dumps(facts, ensure_ascii=False, default=str)}'
    )

    try:
        from google import genai

        client = genai.Client(api_key=settings.GEMINI_API_KEY)
        interaction = client.interactions.create(
            model=settings.GEMINI_MODEL,
            system_instruction=(
                'You prepare editable patient-to-physiotherapist drafts. Preserve '
                'measured facts, lead with the concrete reason for review, and use '
                'cautious language. Never present a stored wellness goal as the '
                'reason for a clinician-assigned programme, and never provide '
                'diagnosis or treatment advice.'
            ),
            input=prompt,
        )
        return _normalize_draft(interaction.output_text)
    except ConsultationDraftUnavailable:
        raise
    except Exception as exc:
        raise ConsultationDraftUnavailable(
            'Consultation draft generation failed.'
        ) from exc
