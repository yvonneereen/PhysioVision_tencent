from rest_framework import serializers

from .models import PainCheckin, Session


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
            'angle_summaries',
            'created_at', 'updated_at',
        ]
        read_only_fields = [
            'id', 'duration_seconds', 'stop_requires_review',
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
        return attrs


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
