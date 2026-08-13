import uuid

from django.core.validators import MaxValueValidator, MinValueValidator
from django.db import models
from django.utils.translation import gettext_lazy as _

from api.core.models import TimestampedModel, PatientProfile
from api.catalogue.models import AffectedSide, Calibration, Exercise, Prescription


class Session(TimestampedModel):
    """
    Records a single completed (or in-progress) exercise block.
    One session = one patient performing one exercise in one sitting.

    duration_seconds is derived from ended_at - started_at and stored for fast aggregation.
    quality_score is nullable and may only be populated by a server-approved,
    validation-gated coaching rule set after the session ends.
    cues_triggered stores [{cue_text, trigger_count}] matching FeedbackEngine output.
    """
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)

    patient      = models.ForeignKey(PatientProfile, on_delete=models.CASCADE, related_name="sessions")
    exercise     = models.ForeignKey(Exercise, on_delete=models.CASCADE, related_name="sessions")
    prescription = models.ForeignKey(
        Prescription,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="sessions",
        help_text="Snapshot FK; may be null if prescription was later deleted",
    )
    calibration = models.ForeignKey(
        Calibration,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="sessions",
        help_text="Which calibration was active during this session, if any",
    )

    started_at       = models.DateTimeField()
    ended_at         = models.DateTimeField(null=True, blank=True)
    duration_seconds = models.PositiveIntegerField(
        null=True, blank=True,
        help_text="Derived from ended_at - started_at; stored for fast aggregation",
    )

    sets_completed = models.PositiveSmallIntegerField(default=0)
    reps_completed = models.PositiveSmallIntegerField(default=0)
    reps_target    = models.PositiveSmallIntegerField()
    reps_minimum   = models.PositiveSmallIntegerField(
        null=True,
        blank=True,
        help_text=(
            "Minimum repetitions per set that count as completion. "
            "Falls back to reps_target for older sessions."
        ),
    )
    sets_target    = models.PositiveSmallIntegerField()
    affected_side  = models.CharField(max_length=5, choices=AffectedSide.choices)

    stop_reason = models.CharField(
        max_length=24,
        blank=True,
        choices=[
            ("pain", _("Pain")),
            ("tired", _("Tired")),
            ("dizzy", _("Dizzy")),
            ("breathless", _("Breathless")),
            ("exercise_difficulty", _("Exercise difficulty")),
            ("skipped", _("Skipped question")),
        ],
        help_text="Patient-selected reason for ending below the minimum dose.",
    )
    stop_requires_review = models.BooleanField(
        default=False,
        editable=False,
        help_text=(
            "True for an early stop involving dizziness or breathlessness. "
            "This is not real-time monitoring."
        ),
    )

    quality_score = models.DecimalField(
        max_digits=5, decimal_places=1,
        null=True, blank=True,
        validators=[MinValueValidator(0), MaxValueValidator(100)],
    )
    pain_level = models.PositiveSmallIntegerField(
        null=True, blank=True,
        validators=[MinValueValidator(0), MaxValueValidator(10)],
    )
    notes = models.TextField(blank=True)

    cues_triggered = models.JSONField(
        default=list,
        help_text="[{cue_text: str, trigger_count: int}]",
    )
    angle_summaries = models.JSONField(
        default=dict,
        blank=True,
        help_text="{angleName: {min: float, max: float, mean: float}} — per-session angle stats for trend tracking",
    )
    assessment_summary = models.JSONField(
        default=dict,
        blank=True,
        help_text=(
            "Separate tracking validity, prescription completion, "
            "validation-gated movement execution, and patient-reported "
            "symptoms/safety outputs."
        ),
    )
    symmetry_warnings_count   = models.PositiveSmallIntegerField(default=0)
    low_confidence_frames_pct = models.DecimalField(
        max_digits=5, decimal_places=1,
        null=True, blank=True,
        validators=[MinValueValidator(0), MaxValueValidator(100)],
        help_text="Percentage of frames where required joints were low-confidence",
    )

    class Meta:
        db_table  = "sessions_session"
        ordering  = ["-started_at"]
        indexes   = [
            models.Index(fields=["patient", "-started_at"]),
            models.Index(fields=["exercise"]),
            models.Index(fields=["prescription"]),
        ]
        verbose_name        = _("session")
        verbose_name_plural = _("sessions")

    def __str__(self) -> str:
        return f"{self.patient.user} — {self.exercise.name} @ {self.started_at:%Y-%m-%d %H:%M}"

    def save(self, *args, **kwargs):
        if self.started_at and self.ended_at and self.duration_seconds is None:
            delta = self.ended_at - self.started_at
            self.duration_seconds = max(0, int(delta.total_seconds()))
        self.stop_requires_review = self.stop_reason in {"dizzy", "breathless"}
        super().save(*args, **kwargs)


class PainCheckinTiming(models.TextChoices):
    BEFORE = "before", _("Before exercise")
    AFTER = "after", _("After exercise")
    GENERAL = "general", _("General check-in")


class RecoveryStatus(models.TextChoices):
    BETTER = "better", _("Better")
    SAME = "same", _("About the same")
    WORSE = "worse", _("Worse")
    UNSURE = "unsure", _("Not sure")


class PainCheckin(TimestampedModel):
    """
    Discrete pain self-report, optionally linked to a session.
    Standalone check-ins can be submitted outside of an exercise session (e.g. morning diary).
    """
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)

    patient = models.ForeignKey(PatientProfile, on_delete=models.CASCADE, related_name="pain_checkins")
    session = models.ForeignKey(
        Session,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="pain_checkins",
    )

    pain_level     = models.PositiveSmallIntegerField(
        validators=[MinValueValidator(0), MaxValueValidator(10)],
    )
    timing         = models.CharField(
        max_length=10,
        choices=PainCheckinTiming.choices,
        default=PainCheckinTiming.GENERAL,
        help_text="Whether this report was collected before or after exercise.",
    )
    recovery_status = models.CharField(
        max_length=10,
        choices=RecoveryStatus.choices,
        blank=True,
        help_text="Patient-reported change compared with the relevant prior point.",
    )
    location_notes = models.CharField(max_length=100, blank=True)
    safety_follow_up = models.JSONField(
        default=dict,
        blank=True,
        help_text="Structured answers and outcome from a pain safety follow-up.",
    )
    requires_review = models.BooleanField(
        default=False,
        help_text="Whether this check-in should be reviewed before more exercise.",
    )
    checked_at     = models.DateTimeField()

    class Meta:
        db_table  = "sessions_paincheckin"
        ordering  = ["-checked_at"]
        indexes   = [
            models.Index(fields=["patient", "-checked_at"]),
        ]
        verbose_name        = _("pain check-in")
        verbose_name_plural = _("pain check-ins")

    def __str__(self) -> str:
        return f"{self.patient.user} pain={self.pain_level}/10 @ {self.checked_at:%Y-%m-%d}"
