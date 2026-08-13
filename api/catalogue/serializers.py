from rest_framework import serializers

from api.core.models import UserRole

from .models import Calibration, Exercise, Prescription


class ExerciseSerializer(serializers.ModelSerializer):
    class Meta:
        model  = Exercise
        fields = [
            'id', 'name', 'category', 'camera_direction', 'rep_rule',
            'default_sets', 'default_reps', 'default_hold_seconds', 'default_days_per_week',
            'phase_confirmation_ms', 'max_cues',
            'tracking_notes', 'tracking_warning',
            'tracked_angles_config', 'phases_config', 'cues_config',
            'calibration_config', 'symmetry_config', 'stage_images',
            'is_active', 'sort_order',
        ]


class PrescriptionSerializer(serializers.ModelSerializer):
    exercise_name = serializers.CharField(source='exercise.name', read_only=True)
    patient_name = serializers.SerializerMethodField()
    patient_email = serializers.EmailField(source='patient.user.email', read_only=True)
    clinician_name = serializers.SerializerMethodField()
    exercise_completed = serializers.SerializerMethodField()
    last_completed_at = serializers.SerializerMethodField()

    class Meta:
        model  = Prescription
        fields = [
            'id', 'patient', 'patient_name', 'patient_email', 'exercise', 'exercise_name',
            'clinician', 'clinician_name',
            'sets', 'reps', 'hold_seconds', 'days_per_week', 'notes',
            'is_active', 'valid_from', 'valid_until',
            'exercise_completed', 'last_completed_at',
            'created_at', 'updated_at',
        ]
        read_only_fields = ['id', 'clinician', 'created_at', 'updated_at']

    def get_patient_name(self, obj):
        return obj.patient.user.get_full_name().strip() or obj.patient.user.email

    def get_clinician_name(self, obj):
        if not obj.clinician_id:
            return None
        return (
            obj.clinician.user.get_full_name().strip()
            or obj.clinician.user.email
        )

    def _completed_sessions(self, obj):
        sessions = getattr(obj, '_prefetched_objects_cache', {}).get('sessions')
        if sessions is None:
            sessions = obj.sessions.all()
        return [
            session for session in sessions
            if session.ended_at
            and session.sets_completed >= session.sets_target
            and session.reps_completed >= (
                session.reps_minimum or session.reps_target
            )
        ]

    def get_exercise_completed(self, obj):
        return bool(self._completed_sessions(obj))

    def get_last_completed_at(self, obj):
        completed = self._completed_sessions(obj)
        return max((session.ended_at for session in completed), default=None)

    def validate(self, attrs):
        valid_from = attrs.get('valid_from', getattr(self.instance, 'valid_from', None))
        valid_until = attrs.get('valid_until', getattr(self.instance, 'valid_until', None))
        if valid_until and valid_from and valid_until < valid_from:
            raise serializers.ValidationError({
                'valid_until': 'The end date cannot be before the start date.'
            })

        exercise = attrs.get('exercise', getattr(self.instance, 'exercise', None))
        if exercise and not exercise.is_active:
            raise serializers.ValidationError({
                'exercise': 'This exercise is not active.'
            })

        request = self.context.get('request')
        if request and request.method not in ('GET', 'HEAD', 'OPTIONS'):
            if not getattr(request.user, 'is_clinician', False):
                raise serializers.ValidationError(
                    'Only a clinician can create or change a prescription.'
                )
            patient = attrs.get('patient', getattr(self.instance, 'patient', None))
            clinician = getattr(request.user, 'clinician_profile', None)
            if patient and patient.user.role != UserRole.PATIENT:
                raise serializers.ValidationError({
                    'patient': 'Select an account registered as a patient.'
                })
            if not patient or patient.primary_clinician_id != getattr(clinician, 'id', None):
                raise serializers.ValidationError({
                    'patient': 'Select a patient linked to your clinician account.'
                })
        return attrs


class CalibrationSerializer(serializers.ModelSerializer):
    exercise_name = serializers.CharField(source='exercise.name', read_only=True)

    class Meta:
        model  = Calibration
        fields = [
            'id', 'exercise', 'exercise_name', 'version', 'affected_side',
            'captured_at', 'start_measurements', 'target_measurements',
            'phase_ranges', 'natural_knee_difference', 'is_active',
            'created_at', 'updated_at',
        ]
        read_only_fields = ['id', 'version', 'created_at', 'updated_at']
