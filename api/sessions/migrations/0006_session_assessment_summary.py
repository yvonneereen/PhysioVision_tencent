from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("physio_sessions", "0005_session_early_stop_fields"),
    ]

    operations = [
        migrations.AddField(
            model_name="session",
            name="assessment_summary",
            field=models.JSONField(
                blank=True,
                default=dict,
                help_text=(
                    "Separate tracking validity, prescription completion, "
                    "validation-gated movement execution, and patient-reported "
                    "symptoms/safety outputs."
                ),
            ),
        ),
    ]
