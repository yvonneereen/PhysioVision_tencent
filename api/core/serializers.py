import re
from datetime import timedelta

from django.contrib.auth.password_validation import validate_password
from django.utils import timezone
from rest_framework import serializers

from .analytics import adherence_pct, parse_days_per_week, session_quality_trend
from .models import (
    ActivityLevel,
    CareInvitation,
    ClinicianAiMessage,
    ClinicianAiSession,
    ClinicianProfile,
    CueStyle,
    EmergencyAlert,
    EmergencyAlertResponse,
    FocusSide,
    GoalChoice,
    PatientPathwayChoice,
    PatientProfile,
    User,
    UserRole,
)


# Backwards-compatible alias; canonical implementation now lives in analytics.py.
_parse_days_per_week = parse_days_per_week


class UserSerializer(serializers.ModelSerializer):
    class Meta:
        model = User
        fields = ['id', 'email', 'first_name', 'last_name', 'role', 'date_of_birth', 'phone']
        read_only_fields = ['id', 'role']


class RegisterSerializer(serializers.Serializer):
    email      = serializers.EmailField()
    password   = serializers.CharField(
        write_only=True,
        validators=[validate_password],
    )
    first_name = serializers.CharField(max_length=150)
    last_name  = serializers.CharField(max_length=150)
    role       = serializers.ChoiceField(choices=[UserRole.PATIENT, UserRole.CLINICIAN])

    # Patient-only optional fields
    goal            = serializers.ChoiceField(choices=PatientProfile.goal.field.choices, required=False)  # type: ignore[attr-defined]
    custom_goal     = serializers.CharField(max_length=120, required=False, allow_blank=True)
    activity_level  = serializers.ChoiceField(choices=PatientProfile.activity_level.field.choices, required=False)  # type: ignore[attr-defined]
    mobility_status = serializers.ChoiceField(choices=PatientProfile.mobility_status.field.choices, required=False)  # type: ignore[attr-defined]
    focus_side      = serializers.ChoiceField(choices=PatientProfile.focus_side.field.choices, required=False)  # type: ignore[attr-defined]
    cue_style       = serializers.ChoiceField(choices=PatientProfile.cue_style.field.choices, required=False)  # type: ignore[attr-defined]

    # Clinician-only optional fields
    license_number = serializers.CharField(max_length=50, required=False, allow_blank=True)
    specialty      = serializers.CharField(max_length=100, required=False, allow_blank=True)

    def validate_email(self, value):
        return value.strip().lower()

    def validate(self, data):
        if data.get('role') != UserRole.PATIENT:
            data['custom_goal'] = ''
            return data

        goal = data.get('goal', GoalChoice.STRONGER_KNEES)
        custom_goal = data.get('custom_goal', '').strip()
        if goal == GoalChoice.OTHER and not custom_goal:
            raise serializers.ValidationError({
                'custom_goal': 'Describe what you would like to improve.',
            })
        data['custom_goal'] = custom_goal if goal == GoalChoice.OTHER else ''
        return data

    def create(self, validated_data):
        role     = validated_data['role']
        password = validated_data.pop('password')

        # Pull out profile-specific fields before creating the User
        patient_fields   = {k: validated_data.pop(k) for k in ['goal', 'custom_goal', 'activity_level', 'mobility_status', 'focus_side', 'cue_style'] if k in validated_data}
        clinician_fields = {k: validated_data.pop(k) for k in ['license_number', 'specialty'] if k in validated_data}

        user = User.objects.create_user(
            username=validated_data['email'],
            email=validated_data['email'],
            password=password,
            first_name=validated_data['first_name'],
            last_name=validated_data['last_name'],
            role=role,
            is_active=False,
            email_verified_at=None,
        )

        if role == UserRole.PATIENT:
            PatientProfile.objects.create(user=user, **patient_fields)
        elif role == UserRole.CLINICIAN:
            ClinicianProfile.objects.create(user=user, **clinician_fields)

        return user


class LoginSerializer(serializers.Serializer):
    email    = serializers.EmailField()
    password = serializers.CharField(write_only=True)

    def validate_email(self, value):
        return value.strip().lower()

    def validate(self, data):
        user = User.objects.filter(email__iexact=data['email']).first()
        if not user or not user.check_password(data['password']):
            raise serializers.ValidationError("Invalid email or password.")
        if not user.email_verified_at:
            data['user'] = user
            data['requires_email_verification'] = True
            return data
        if not user.is_active:
            raise serializers.ValidationError("This account is disabled.")
        data['user'] = user
        return data


class VerifyEmailSerializer(serializers.Serializer):
    email = serializers.EmailField()
    code = serializers.RegexField(r"^\d{6}$")

    def validate_email(self, value):
        return value.strip().lower()


class VerifyLoginSerializer(serializers.Serializer):
    challenge_id = serializers.UUIDField()
    code = serializers.RegexField(r"^\d{6}$")


class ResendLoginVerificationSerializer(serializers.Serializer):
    challenge_id = serializers.UUIDField()


class ResendEmailVerificationSerializer(serializers.Serializer):
    email = serializers.EmailField()

    def validate_email(self, value):
        return value.strip().lower()


class ForgotPasswordSerializer(serializers.Serializer):
    email = serializers.EmailField()

    def validate_email(self, value):
        return value.strip().lower()


class VerifyPasswordResetCodeSerializer(serializers.Serializer):
    email = serializers.EmailField()
    code = serializers.RegexField(r"^\d{6}$")

    def validate_email(self, value):
        return value.strip().lower()


class ResetPasswordSerializer(serializers.Serializer):
    email = serializers.EmailField()
    reset_token = serializers.CharField(min_length=32, max_length=256)
    new_password = serializers.CharField(write_only=True, min_length=8)

    def validate_email(self, value):
        return value.strip().lower()


class PatientProfileSerializer(serializers.ModelSerializer):
    user = UserSerializer(read_only=True)
    primary_clinician_name = serializers.SerializerMethodField()
    emergency_contact_alerts_ready = serializers.SerializerMethodField()

    class Meta:
        model  = PatientProfile
        fields = [
            'id', 'user', 'goal', 'custom_goal', 'activity_level', 'mobility_status',
            'focus_side', 'cue_style', 'care_path',
            'emergency_contact_name', 'emergency_contact_relationship',
            'emergency_contact_phone', 'emergency_contact_consent',
            'emergency_contact_verified_at', 'emergency_contact_alerts_ready',
            'pathway_choice', 'pathway_selected_at',
            'physiotherapist_requested_at',
            'height_cm', 'weight_kg', 'medical_history', 'low_risk_acknowledged',
            'wellness_screening_status', 'wellness_screening_answers',
            'wellness_screened_at',
            'wellness_plan', 'wellness_plan_accepted_at',
            'primary_clinician', 'primary_clinician_name', 'created_at', 'updated_at',
        ]
        read_only_fields = [
            'id', 'user', 'care_path', 'pathway_choice',
            'pathway_selected_at', 'physiotherapist_requested_at',
            'wellness_screening_status',
            'wellness_screening_answers', 'wellness_screened_at',
            'wellness_plan', 'wellness_plan_accepted_at',
            'emergency_contact_verified_at', 'emergency_contact_alerts_ready',
            'primary_clinician', 'primary_clinician_name',
            'created_at', 'updated_at',
        ]

    def get_primary_clinician_name(self, obj):
        clinician = obj.primary_clinician
        if not clinician:
            return None
        return clinician.user.get_full_name().strip() or clinician.user.email

    def get_emergency_contact_alerts_ready(self, obj):
        from .emergency_alerts import emergency_contact_ready
        return emergency_contact_ready(obj)

    def validate(self, attrs):
        current_goal = getattr(
            self.instance,
            'goal',
            GoalChoice.STRONGER_KNEES,
        )
        current_custom_goal = getattr(self.instance, 'custom_goal', '')
        goal = attrs.get('goal', current_goal)
        custom_goal = attrs.get('custom_goal', current_custom_goal).strip()

        if goal == GoalChoice.OTHER and not custom_goal:
            raise serializers.ValidationError({
                'custom_goal': 'Describe what you would like to improve.',
            })

        attrs['custom_goal'] = (
            custom_goal if goal == GoalChoice.OTHER else ''
        )

        contact_name = attrs.get(
            'emergency_contact_name',
            getattr(self.instance, 'emergency_contact_name', ''),
        ).strip()
        contact_relationship = attrs.get(
            'emergency_contact_relationship',
            getattr(self.instance, 'emergency_contact_relationship', ''),
        ).strip()
        contact_phone = attrs.get(
            'emergency_contact_phone',
            getattr(self.instance, 'emergency_contact_phone', ''),
        ).strip()
        contact_consent = attrs.get(
            'emergency_contact_consent',
            getattr(self.instance, 'emergency_contact_consent', False),
        )
        has_contact = bool(contact_name or contact_relationship or contact_phone)
        contact_errors = {}
        if has_contact:
            if not contact_name:
                contact_errors['emergency_contact_name'] = (
                    'Enter the emergency contact’s full name.'
                )
            if not contact_relationship:
                contact_errors['emergency_contact_relationship'] = (
                    'Choose your relationship to the emergency contact.'
                )
            digits = re.sub(r'\D', '', contact_phone)
            if not contact_phone:
                contact_errors['emergency_contact_phone'] = (
                    'Enter the emergency contact’s phone number.'
                )
            elif not re.fullmatch(r'[+0-9() .-]+', contact_phone):
                contact_errors['emergency_contact_phone'] = (
                    'Use only numbers and common phone-number symbols.'
                )
            elif not contact_phone.startswith('+'):
                contact_errors['emergency_contact_phone'] = (
                    'Include the country code, for example +65 9123 4567.'
                )
            elif not 8 <= len(digits) <= 15:
                contact_errors['emergency_contact_phone'] = (
                    'Enter a phone number containing 8 to 15 digits.'
                )
            if contact_consent is not True:
                contact_errors['emergency_contact_consent'] = (
                    'Confirm that this person agreed to be listed.'
                )
        else:
            contact_name = ''
            contact_relationship = ''
            contact_phone = ''
            contact_consent = False
        if contact_errors:
            raise serializers.ValidationError(contact_errors)
        attrs['emergency_contact_name'] = contact_name
        attrs['emergency_contact_relationship'] = contact_relationship
        attrs['emergency_contact_phone'] = contact_phone
        attrs['emergency_contact_consent'] = contact_consent
        return attrs


class EmergencyContactVerificationCodeSerializer(serializers.Serializer):
    code = serializers.RegexField(r"^\d{6}$")


class EmergencyAlertCreateSerializer(serializers.Serializer):
    client_event_id = serializers.UUIDField()
    exercise_id = serializers.CharField(
        max_length=80,
        required=False,
        allow_blank=True,
    )
    monitoring_mode = serializers.CharField(
        max_length=30,
        required=False,
        allow_blank=True,
    )
    signals = serializers.ListField(
        child=serializers.CharField(max_length=80),
        max_length=12,
        required=False,
        default=list,
    )


class EmergencyAlertResponseSerializer(serializers.Serializer):
    response = serializers.ChoiceField(
        choices=EmergencyAlertResponse.choices,
    )


class EmergencyAlertSerializer(serializers.ModelSerializer):
    contact_ready = serializers.SerializerMethodField()
    countdown_seconds = serializers.SerializerMethodField()

    class Meta:
        model = EmergencyAlert
        fields = [
            'id', 'client_event_id', 'source', 'status', 'response',
            'exercise_id', 'monitoring_mode', 'signals', 'notify_after',
            'responded_at', 'notification_attempted_at', 'contact_name',
            'sms_message_id', 'voice_call_id', 'delivery_error',
            'contact_ready', 'countdown_seconds', 'created_at', 'updated_at',
        ]
        read_only_fields = fields

    def get_contact_ready(self, obj):
        return bool(obj.contact_phone)

    def get_countdown_seconds(self, obj):
        return max(
            0,
            int((obj.notify_after - timezone.now()).total_seconds() + 0.999),
        )



class PatientPathwayChoiceSerializer(serializers.Serializer):
    pathway = serializers.ChoiceField(
        choices=[
            PatientPathwayChoice.PHYSIOTHERAPIST,
            PatientPathwayChoice.WELLNESS,
        ],
    )


class WellnessScreeningSerializer(serializers.Serializer):
    not_treating_condition = serializers.BooleanField()
    no_clinician_restrictions = serializers.BooleanField()
    general_wellness_goal = serializers.BooleanField()
    no_concerning_symptoms = serializers.BooleanField()


class WellnessPlanPreferencesSerializer(serializers.Serializer):
    goal = serializers.ChoiceField(choices=GoalChoice.choices)
    custom_goal = serializers.CharField(
        max_length=120,
        required=False,
        allow_blank=True,
    )
    activity_level = serializers.ChoiceField(choices=ActivityLevel.choices)
    focus_side = serializers.ChoiceField(choices=FocusSide.choices)
    cue_style = serializers.ChoiceField(choices=CueStyle.choices)
    days_per_week = serializers.IntegerField(min_value=1, max_value=7)
    # Kept optional while older deployed clients move to the fixed single-set
    # dosage used by the current wellness planner.
    minutes_per_session = serializers.IntegerField(
        min_value=5,
        max_value=30,
        required=False,
    )
    equipment = serializers.ChoiceField(
        choices=["none", "chair", "chair_band"],
    )
    planning_notes = serializers.CharField(
        max_length=500,
        required=False,
        allow_blank=True,
    )
    has_relevant_history = serializers.BooleanField(
        required=False,
        default=False,
    )
    medical_history = serializers.CharField(
        max_length=1000,
        required=False,
        allow_blank=True,
    )
    age = serializers.IntegerField(
        min_value=50,
        max_value=100,
        required=False,
        allow_null=True,
    )
    height_cm = serializers.IntegerField(
        min_value=120,
        max_value=220,
        required=False,
        allow_null=True,
    )
    weight_kg = serializers.DecimalField(
        max_digits=5,
        decimal_places=1,
        min_value=30,
        max_value=250,
        required=False,
        allow_null=True,
    )

    def validate(self, attrs):
        custom_goal = attrs.get("custom_goal", "").strip()
        if attrs["goal"] == GoalChoice.OTHER and not custom_goal:
            raise serializers.ValidationError({
                "custom_goal": "Describe your general-wellness goal.",
            })
        attrs["custom_goal"] = (
            custom_goal if attrs["goal"] == GoalChoice.OTHER else ""
        )
        attrs["planning_notes"] = attrs.get("planning_notes", "").strip()
        medical_history = attrs.get("medical_history", "").strip()
        if attrs["has_relevant_history"] and not medical_history:
            raise serializers.ValidationError({
                "medical_history": (
                    "Describe the recovered medical, injury, or surgery "
                    "history the planner should consider."
                ),
            })
        attrs["medical_history"] = (
            medical_history if attrs["has_relevant_history"] else ""
        )
        return attrs


class WellnessPlanDraftSerializer(WellnessPlanPreferencesSerializer):
    previous_plan = serializers.JSONField(required=False, allow_null=True)
    revision = serializers.CharField(
        max_length=240,
        required=False,
        allow_blank=True,
    )


class WellnessPlanAcceptSerializer(serializers.Serializer):
    draft_token = serializers.CharField(max_length=12000)


class CareInvitationSerializer(serializers.ModelSerializer):
    clinician_name = serializers.CharField(
        source="clinician.user.get_full_name",
        read_only=True,
    )

    class Meta:
        model = CareInvitation
        fields = [
            "id", "clinician_name", "code_hint", "expires_at",
            "accepted_at", "is_active", "created_at",
        ]
        read_only_fields = fields


class CareInvitationAcceptSerializer(serializers.Serializer):
    code = serializers.CharField(min_length=8, max_length=8, trim_whitespace=True)


class ClinicianProfileSerializer(serializers.ModelSerializer):
    user = UserSerializer(read_only=True)

    class Meta:
        model  = ClinicianProfile
        fields = [
            'id', 'user', 'license_number', 'specialty',
            'years_experience', 'bio', 'is_accepting_patients',
            'slack_linked', 'created_at', 'updated_at',
        ]
        read_only_fields = ['id', 'user', 'slack_linked', 'created_at', 'updated_at']

    slack_linked = serializers.SerializerMethodField()

    def get_slack_linked(self, obj):
        return bool(obj.slack_user_id)


class ClinicianAiMessageSerializer(serializers.ModelSerializer):
    class Meta:
        model = ClinicianAiMessage
        fields = [
            'id', 'role', 'body', 'command', 'data',
            'created_at', 'updated_at',
        ]
        read_only_fields = fields


class ClinicianAiSessionSerializer(serializers.ModelSerializer):
    message_count = serializers.SerializerMethodField()
    preview = serializers.SerializerMethodField()
    contains_plan = serializers.SerializerMethodField()

    class Meta:
        model = ClinicianAiSession
        fields = [
            'id', 'title', 'preview', 'message_count', 'contains_plan',
            'created_at', 'updated_at',
        ]
        read_only_fields = fields

    def _messages(self, obj):
        prefetched = getattr(obj, '_prefetched_objects_cache', {}).get('messages')
        if prefetched is not None:
            return list(prefetched)
        return list(obj.messages.all())

    def get_message_count(self, obj):
        return len(self._messages(obj))

    def get_preview(self, obj):
        messages = self._messages(obj)
        if not messages:
            return ''
        body = ' '.join(messages[-1].body.split())
        return f'{body[:117]}…' if len(body) > 120 else body

    def get_contains_plan(self, obj):
        return any(
            message.command in {'build_plan', 'revise_plan'}
            and bool(message.data)
            for message in self._messages(obj)
        )


class ClinicianAiSessionDetailSerializer(ClinicianAiSessionSerializer):
    messages = ClinicianAiMessageSerializer(many=True, read_only=True)

    class Meta(ClinicianAiSessionSerializer.Meta):
        fields = ClinicianAiSessionSerializer.Meta.fields + ['messages']


class PatientListSerializer(serializers.ModelSerializer):
    full_name             = serializers.SerializerMethodField()
    email                 = serializers.EmailField(source='user.email', read_only=True)
    age                   = serializers.SerializerMethodField()
    last_session_at       = serializers.SerializerMethodField()
    open_escalations_count = serializers.SerializerMethodField()
    trend                 = serializers.SerializerMethodField()
    adherence_pct         = serializers.SerializerMethodField()
    latest_pain_level     = serializers.SerializerMethodField()
    active_prescription   = serializers.SerializerMethodField()
    active_prescriptions  = serializers.SerializerMethodField()

    class Meta:
        model  = PatientProfile
        fields = [
            'id', 'full_name', 'email', 'age', 'goal', 'activity_level', 'mobility_status',
            'focus_side', 'care_path', 'last_session_at', 'open_escalations_count',
            'trend', 'adherence_pct', 'latest_pain_level', 'active_prescription',
            'active_prescriptions',
        ]

    def get_full_name(self, obj):
        return (
            f"{obj.user.first_name} {obj.user.last_name}".strip()
            or obj.user.email
        )

    def get_age(self, obj):
        if not obj.user.date_of_birth:
            return None
        today = timezone.now().date()
        dob   = obj.user.date_of_birth
        return today.year - dob.year - ((today.month, today.day) < (dob.month, dob.day))

    def get_last_session_at(self, obj):
        return obj.sessions.order_by('-started_at').values_list('started_at', flat=True).first()

    def get_open_escalations_count(self, obj):
        return obj.escalations.filter(status='open').count()

    def get_trend(self, obj):
        return session_quality_trend(obj)

    def get_adherence_pct(self, obj):
        return adherence_pct(obj)

    def get_latest_pain_level(self, obj):
        checkin = obj.pain_checkins.order_by('-checked_at').first()
        return checkin.pain_level if checkin else None

    def _active_prescription_rows(self, obj):
        # Keep the roster summary consistent with the patient programme API:
        # current clinician, active flag, and validity dates must all match.
        from api.catalogue.services import active_prescriptions_for

        cached = getattr(obj, '_serialized_active_prescriptions', None)
        if cached is not None:
            return cached
        prescriptions = (
            active_prescriptions_for(obj)
            .select_related('exercise')
            .order_by('exercise__sort_order', 'exercise__name', 'created_at')
        )
        rows = [
            {
                'prescription_id': str(rx.id),
                'exercise_id': rx.exercise_id,
                'exercise_name': rx.exercise.name,
                'sets': rx.sets,
                'reps': rx.reps,
                'hold_seconds': rx.hold_seconds,
                'days_per_week': rx.days_per_week,
                'notes': rx.notes,
            }
            for rx in prescriptions
        ]
        obj._serialized_active_prescriptions = rows
        return rows

    def get_active_prescriptions(self, obj):
        return self._active_prescription_rows(obj)

    def get_active_prescription(self, obj):
        # Retain the original field for older frontend deployments while the
        # clinician dashboard migrates to the complete programme list.
        rows = self._active_prescription_rows(obj)
        return rows[0] if rows else None


class PatientDischargeSerializer(serializers.Serializer):
    confirmed = serializers.BooleanField()
    note = serializers.CharField(
        required=False,
        allow_blank=True,
        trim_whitespace=True,
        max_length=500,
    )

    def validate_confirmed(self, value):
        if value is not True:
            raise serializers.ValidationError(
                'Confirm that you intend to discharge this patient.'
            )
        return value
