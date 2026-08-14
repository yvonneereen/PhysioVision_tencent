from django.db import transaction
from django.utils import timezone
from rest_framework import status
from rest_framework.decorators import action
from rest_framework.exceptions import PermissionDenied, ValidationError
from rest_framework.response import Response
from rest_framework.viewsets import ModelViewSet, ReadOnlyModelViewSet

from api.core.models import UserRole

from .models import Calibration, Exercise, Prescription
from .serializers import (
    AssignDraftProgrammeSerializer,
    CalibrationSerializer,
    ExerciseSerializer,
    PrescriptionSerializer,
    PROGRAMME_STAGE_CHOICES,
)
from .services import (
    active_prescriptions_for,
    sync_patient_care_path,
)


class ExerciseViewSet(ReadOnlyModelViewSet):
    serializer_class = ExerciseSerializer
    queryset         = Exercise.objects.filter(is_active=True).order_by('sort_order', 'name')
    pagination_class = None


class PrescriptionViewSet(ModelViewSet):
    serializer_class = PrescriptionSerializer
    pagination_class = None

    def get_queryset(self):
        user = self.request.user
        base = Prescription.objects.select_related(
            'exercise', 'patient__user', 'clinician__user'
        ).prefetch_related('sessions')
        if user.role == UserRole.PATIENT and hasattr(user, 'patient_profile'):
            return active_prescriptions_for(user.patient_profile).select_related(
                'exercise', 'patient__user', 'clinician__user'
            ).order_by('exercise__name')
        if user.role == UserRole.CLINICIAN and hasattr(user, 'clinician_profile'):
            clinician = user.clinician_profile
            return base.filter(
                clinician=clinician,
                patient__primary_clinician=clinician,
                patient__user__role=UserRole.PATIENT,
            ).order_by('-valid_from', 'patient__user__last_name')
        return base.none()

    def perform_create(self, serializer):
        if (
            self.request.user.role != UserRole.CLINICIAN
            or not hasattr(self.request.user, 'clinician_profile')
        ):
            raise PermissionDenied('Only a clinician can create prescriptions.')

        clinician = self.request.user.clinician_profile
        patient = serializer.validated_data['patient']
        exercise = serializer.validated_data['exercise']
        with transaction.atomic():
            Prescription.objects.filter(
                patient=patient,
                exercise=exercise,
                is_active=True,
            ).update(is_active=False)
            serializer.save(clinician=clinician)
            sync_patient_care_path(patient)

    @action(detail=False, methods=['post'], url_path='assign-draft')
    def assign_draft(self, request):
        """Publish a clinician-reviewed subset of a saved AI draft.

        The saved draft is the server-owned allow-list. The browser may change
        dose values and omit suggestions, but it cannot add an exercise that
        the reviewed draft did not contain. Publishing replaces the patient's
        current active programme while retaining those rows as history.
        """
        if (
            request.user.role != UserRole.CLINICIAN
            or not hasattr(request.user, 'clinician_profile')
        ):
            raise PermissionDenied('Only a clinician can publish a programme.')

        input_serializer = AssignDraftProgrammeSerializer(data=request.data)
        input_serializer.is_valid(raise_exception=True)
        payload = input_serializer.validated_data
        clinician = request.user.clinician_profile

        from api.consultations.models import CareMessage, MessageSender
        from api.core.models import ClinicianAiMessage, SlackPlanDraft

        with transaction.atomic():
            draft = (
                SlackPlanDraft.objects.select_for_update()
                .select_related('patient__user')
                .filter(
                    id=payload['draft'],
                    clinician=clinician,
                    patient__primary_clinician=clinician,
                    patient__user__role=UserRole.PATIENT,
                )
                .first()
            )
            if draft is None:
                raise ValidationError({
                    'draft': (
                        'This AI draft is no longer available. Build or revise '
                        'the plan again before assigning it.'
                    )
                })

            suggested_ids = []
            for day in draft.plan.get('days', []):
                for exercise_id in day.get(
                    'exercise_ids', day.get('exerciseIds', [])
                ):
                    if exercise_id not in suggested_ids:
                        suggested_ids.append(exercise_id)

            selected_ids = [row['exercise'] for row in payload['exercises']]
            outside_draft = sorted(set(selected_ids) - set(suggested_ids))
            if outside_draft:
                raise ValidationError({
                    'exercises': (
                        'Choose activities from the saved AI draft only. '
                        f'Not in draft: {", ".join(outside_draft)}.'
                    )
                })

            exercise_map = {
                exercise.id: exercise
                for exercise in Exercise.objects.filter(
                    id__in=selected_ids,
                    is_active=True,
                )
            }
            unavailable = [
                exercise_id for exercise_id in selected_ids
                if exercise_id not in exercise_map
            ]
            if unavailable:
                raise ValidationError({
                    'exercises': (
                        'One or more selected activities are no longer in the '
                        'active reviewed catalogue.'
                    )
                })

            patient = draft.patient
            stage_labels = dict(PROGRAMME_STAGE_CHOICES)
            stage_label = stage_labels[payload['stage']]

            # A newly published plan becomes the single active prescription
            # source. Previous rows remain available to clinicians as history.
            Prescription.objects.filter(
                patient=patient,
                is_active=True,
            ).update(is_active=False)

            created = []
            for row in payload['exercises']:
                exercise = exercise_map[row['exercise']]
                created.append(Prescription.objects.create(
                    patient=patient,
                    clinician=clinician,
                    exercise=exercise,
                    sets=row['sets'],
                    reps=row['reps'],
                    hold_seconds=row.get('hold_seconds'),
                    days_per_week=str(row['days_per_week']),
                    notes=(
                        f'{stage_label}. Clinician-reviewed AI programme draft.'
                    ),
                    valid_from=timezone.localdate(),
                    is_active=True,
                ))

            exercise_summary = ', '.join(
                f'{item.exercise.name} ({item.sets} sets × {item.reps} reps)'
                for item in created
            )
            CareMessage.objects.create(
                patient=patient,
                clinician=clinician,
                sender=MessageSender.CLINICIAN,
                body=(
                    f'Your physiotherapist has assigned a new programme for '
                    f'{stage_label}: {exercise_summary}. It is ready on your home page.'
                ),
            )
            sync_patient_care_path(patient)

            assigned_data = {
                'stage': payload['stage'],
                'stage_label': stage_label,
                'exercise_count': len(created),
                'assigned_at': timezone.now().isoformat(),
            }
            message_id = payload.get('message_id')
            if message_id:
                message = ClinicianAiMessage.objects.filter(
                    id=message_id,
                    session__clinician=clinician,
                    command__in=['build_plan', 'revise_plan'],
                ).first()
                if message and str(message.data.get('draft_id')) == str(draft.id):
                    message.data = {**message.data, 'assigned': assigned_data}
                    message.save(update_fields=['data', 'updated_at'])

            draft.delete()

        output = PrescriptionSerializer(
            created,
            many=True,
            context={'request': request},
        )
        return Response(
            {
                'detail': (
                    f'Programme assigned and sent to '
                    f'{patient.user.get_full_name().strip() or patient.user.email}.'
                ),
                'assigned': assigned_data,
                'prescriptions': output.data,
            },
            status=status.HTTP_201_CREATED,
        )

    def perform_update(self, serializer):
        if (
            self.request.user.role != UserRole.CLINICIAN
            or not hasattr(self.request.user, 'clinician_profile')
        ):
            raise PermissionDenied('Only a clinician can change prescriptions.')

        previous_patient = serializer.instance.patient
        patient = serializer.validated_data.get('patient', previous_patient)
        exercise = serializer.validated_data.get(
            'exercise', serializer.instance.exercise
        )
        with transaction.atomic():
            Prescription.objects.filter(
                patient=patient,
                exercise=exercise,
                is_active=True,
            ).exclude(pk=serializer.instance.pk).update(is_active=False)
            serializer.save(clinician=self.request.user.clinician_profile)
            sync_patient_care_path(previous_patient)
            if patient.pk != previous_patient.pk:
                sync_patient_care_path(patient)

    def perform_destroy(self, instance):
        if (
            self.request.user.role != UserRole.CLINICIAN
            or not hasattr(self.request.user, 'clinician_profile')
        ):
            raise PermissionDenied('Only a clinician can remove prescriptions.')
        patient = instance.patient
        instance.delete()
        sync_patient_care_path(patient)


class CalibrationViewSet(ModelViewSet):
    serializer_class = CalibrationSerializer

    def get_queryset(self):
        return Calibration.objects.filter(
            patient=self.request.user.patient_profile
        ).select_related('exercise').order_by('-captured_at')

    def perform_create(self, serializer):
        patient  = self.request.user.patient_profile
        exercise = serializer.validated_data['exercise']
        affected_side = serializer.validated_data['affected_side']

        # Left and right movement baselines are stored independently.
        Calibration.objects.filter(
            patient=patient,
            exercise=exercise,
            affected_side=affected_side,
            is_active=True,
        ).update(is_active=False)

        version = Calibration.objects.filter(
            patient=patient,
            exercise=exercise,
            affected_side=affected_side,
        ).count() + 1
        serializer.save(patient=patient, version=version)
