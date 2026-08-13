from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("physio_sessions", "0004_paincheckin_safety_follow_up_requires_review"),
    ]

    operations = [
        migrations.AddField(
            model_name="session",
            name="reps_minimum",
            field=models.PositiveSmallIntegerField(
                blank=True,
                help_text=(
                    "Minimum repetitions per set that count as completion. "
                    "Falls back to reps_target for older sessions."
                ),
                null=True,
            ),
        ),
        migrations.AddField(
            model_name="session",
            name="stop_reason",
            field=models.CharField(
                blank=True,
                choices=[
                    ("pain", "Pain"),
                    ("tired", "Tired"),
                    ("dizzy", "Dizzy"),
                    ("breathless", "Breathless"),
                    ("exercise_difficulty", "Exercise difficulty"),
                    ("skipped", "Skipped question"),
                ],
                help_text="Patient-selected reason for ending below the minimum dose.",
                max_length=24,
            ),
        ),
        migrations.AddField(
            model_name="session",
            name="stop_requires_review",
            field=models.BooleanField(
                default=False,
                editable=False,
                help_text=(
                    "True for an early stop involving dizziness or breathlessness. "
                    "This is not real-time monitoring."
                ),
            ),
        ),
    ]
