from rest_framework import serializers

from .models import PainCheckin, Session


# A rule version must be reviewed and deployed server-side before an API client
# may save a validation-gated movement-execution score. The current prototype
# has no approved clinical rule versions.
APPROVED_MOVEMENT_RULE_VERSIONS = frozenset()


class SessionSerializer(serializers.ModelSerializer):
    exercise_name = serializers.CharField(source='exercise.name', read_only=True)

    class Meta:
        model  = Session
        fields = [
            'id', 'exercise', 'exercise_name', 'prescription', 'calibration',
            'started_at', 'ended_at', 'duration_seconds',
            'sets_completed', 'reps_completed', 'reps_target', 'reps_minimum',
            'sets_target', 'stop_reason', 'stop_requires_review',
            'affected_side', 'quality_score', 'pain_level', 'notes',
            'cues_triggered', 'symmetry_warnings_count', 'low_confidence_frames_pct',
            'angle_summaries', 'assessment_summary',
            'created_at', 'updated_at',
        ]
        read_only_fields = [
            'id', 'duration_seconds', 'stop_requires_review', 'quality_score',
            'created_at', 'updated_at',
        ]

    def validate(self, attrs):
        prescription = attrs.get(
            'prescription',
            getattr(self.instance, 'prescription', None),
        )
        exercise = attrs.get(
            'exercise',
            getattr(self.instance, 'exercise', None),
        )
        calibration = attrs.get(
            'calibration',
            getattr(self.instance, 'calibration', None),
        )
        request = self.context.get('request')
        patient = getattr(getattr(request, 'user', None), 'patient_profile', None)
        if prescription:
            if not patient or prescription.patient_id != patient.id:
                raise serializers.ValidationError({
                    'prescription': 'This prescription does not belong to the patient.'
                })
            if exercise and prescription.exercise_id != exercise.id:
                raise serializers.ValidationError({
                    'prescription': 'The prescription does not match the exercise.'
                })
        if calibration and (
            not patient or calibration.patient_id != patient.id
        ):
            raise serializers.ValidationError({
                'calibration': 'This calibration does not belong to the patient.'
            })
        assessment = attrs.get(
            'assessment_summary',
            getattr(self.instance, 'assessment_summary', {}),
        ) or {}
        movement = assessment.get('movement_execution', {})
        quality_score = attrs.get(
            'quality_score',
            getattr(self.instance, 'quality_score', None),
        )
        assessment_fields_changed = (
            'quality_score' in attrs or 'assessment_summary' in attrs
        )
        if (
            assessment_fields_changed
            and quality_score is not None
            and movement.get('status') != 'assessed'
        ):
            raise serializers.ValidationError({
                'quality_score': (
                    'A score may only be saved with an approved, '
                    'validation-gated movement assessment.'
                )
            })
        return attrs

    def validate_assessment_summary(self, value):
        if not isinstance(value, dict):
            raise serializers.ValidationError('Must be an object.')
        if value.get('version') != 1:
            raise serializers.ValidationError(
                'Assessment summary version must be 1.'
            )
        required_sections = {
            'tracking_validity',
            'prescription_completion',
            'movement_execution',
            'symptoms_and_safety',
        }
        missing = sorted(required_sections.difference(value))
        if missing:
            raise serializers.ValidationError(
                f"Missing assessment sections: {', '.join(missing)}."
            )

        for section in required_sections:
            if not isinstance(value.get(section), dict):
                raise serializers.ValidationError(
                    f"{section} must be an object."
                )

        tracking = value.get('tracking_validity', {})
        if tracking.get('status') not in {
            'assessable', 'partially_assessable', 'unable_to_assess'
        }:
            raise serializers.ValidationError(
                'Tracking validity has an unsupported status.'
            )
        completion = value.get('prescription_completion', {})
        if completion.get('status') not in {'complete', 'incomplete'}:
            raise serializers.ValidationError(
                'Prescription completion has an unsupported status.'
            )
        movement = value.get('movement_execution', {})
        if movement.get('status') not in {
            'assessed', 'not_clinically_scored', 'unable_to_assess'
        }:
            raise serializers.ValidationError(
                'Movement execution has an unsupported status.'
            )
        if movement.get('status') == 'assessed':
            rule_versions = movement.get('rule_versions')
            if (
                not isinstance(rule_versions, list)
                or not rule_versions
                or not all(
                    isinstance(version, str) and version
                    for version in rule_versions
                )
                or not set(rule_versions).issubset(
                    APPROVED_MOVEMENT_RULE_VERSIONS
                )
            ):
                raise serializers.ValidationError(
                    'This clinical movement-rule version is not approved by the server.'
                )
            score = movement.get('score')
            if (
                isinstance(score, bool)
                or not isinstance(score, (int, float))
                or not 0 <= score <= 100
            ):
                raise serializers.ValidationError(
                    'An assessed movement score must be between 0 and 100.'
                )
        elif movement.get('score') is not None:
            raise serializers.ValidationError(
                'An unassessed movement execution must not include a score.'
            )

        symptoms = value.get('symptoms_and_safety', {})
        if symptoms.get('source') != 'patient_report':
            raise serializers.ValidationError(
                'Symptoms and safety must be identified as patient-reported.'
            )
        if symptoms.get('camera_inference_used') is not False:
            raise serializers.ValidationError(
                'The camera must not be represented as inferring symptoms.'
            )
        return value


class PainCheckinSerializer(serializers.ModelSerializer):
    class Meta:
        model  = PainCheckin
        fields = [
            'id', 'session', 'pain_level', 'timing', 'recovery_status',
            'location_notes', 'safety_follow_up', 'requires_review', 'checked_at',
            'created_at', 'updated_at',
        ]
        read_only_fields = ['id', 'created_at', 'updated_at']

    def validate(self, attrs):
        session = attrs.get(
            'session',
            getattr(self.instance, 'session', None),
        )
        request = self.context.get('request')
        patient = getattr(getattr(request, 'user', None), 'patient_profile', None)
        if session and (
            not patient or session.patient_id != patient.id
        ):
            raise serializers.ValidationError({
                'session': 'This session does not belong to the patient.'
            })
        return attrs
