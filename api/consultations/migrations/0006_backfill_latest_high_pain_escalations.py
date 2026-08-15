from django.db import migrations


PAIN_THRESHOLD = 7


def backfill_latest_high_pain_escalations(apps, schema_editor):
    """Surface current high-pain records saved before signal delivery was fixed."""
    PatientProfile = apps.get_model("core", "PatientProfile")
    PainCheckin = apps.get_model("physio_sessions", "PainCheckin")
    Escalation = apps.get_model("consultations", "Escalation")

    for patient in PatientProfile.objects.all().iterator():
        latest = (
            PainCheckin.objects.filter(patient_id=patient.pk)
            .order_by("-checked_at")
            .first()
        )
        if latest is None or latest.pain_level < PAIN_THRESHOLD:
            continue
        if Escalation.objects.filter(
            patient_id=patient.pk,
            trigger_type="pain_increase",
            status="open",
        ).exists():
            continue
        Escalation.objects.create(
            patient_id=patient.pk,
            clinician_id=patient.primary_clinician_id,
            trigger_type="pain_increase",
            description=(
                f"Reported pain reached {latest.pain_level}/10 "
                f"(threshold {PAIN_THRESHOLD})."
            ),
            session_id=latest.session_id,
            status="open",
        )


class Migration(migrations.Migration):
    dependencies = [
        ("consultations", "0005_consultation_scheduled_at_nullable"),
        ("physio_sessions", "0006_session_assessment_summary"),
    ]

    operations = [
        migrations.RunPython(
            backfill_latest_high_pain_escalations,
            migrations.RunPython.noop,
        ),
    ]
