from datetime import timedelta

from django.utils import timezone
from rest_framework.test import APITestCase

from api.core.models import (
    CarePath,
    ClinicianAiMessage,
    ClinicianAiSession,
    ClinicianProfile,
    PatientProfile,
    SlackPlanDraft,
    User,
    UserRole,
)
from api.consultations.models import CareMessage, MessageSender

from .models import Exercise, Prescription
from api.sessions.models import Session


class PrescriptionAccessTests(APITestCase):
    endpoint = '/api/prescriptions/'

    def setUp(self):
        self.clinician_user = User.objects.create_user(
            username='pt@example.com',
            email='pt@example.com',
            password='test-password',
            role=UserRole.CLINICIAN,
        )
        self.clinician = ClinicianProfile.objects.create(
            user=self.clinician_user,
            license_number='DEMO-ONLY',
        )
        self.patient_user = User.objects.create_user(
            username='patient@example.com',
            email='patient@example.com',
            password='test-password',
            role=UserRole.PATIENT,
        )
        self.patient = PatientProfile.objects.create(
            user=self.patient_user,
            primary_clinician=self.clinician,
            care_path=CarePath.NEEDS_REVIEW,
        )
        self.exercise = Exercise.objects.create(
            id='test-movement',
            name='Test Movement',
            category='mobility',
            camera_direction='front',
            rep_rule='start → finish → start',
            tracked_angles_config={},
            phases_config=[],
            cues_config={},
        )

    def payload(self, patient=None):
        return {
            'patient': str((patient or self.patient).id),
            'exercise': self.exercise.id,
            'sets': 2,
            'reps': 8,
            'hold_seconds': 0,
            'days_per_week': '3',
            'notes': 'Stay inside the approved range.',
            'is_active': True,
            'valid_from': timezone.localdate().isoformat(),
        }

    def test_clinician_assigns_and_patient_receives_active_prescription(self):
        self.client.force_authenticate(self.clinician_user)
        created = self.client.post(
            self.endpoint,
            self.payload(),
            format='json',
        )
        self.assertEqual(created.status_code, 201, created.data)
        self.assertEqual(created.data['patient_name'], 'patient@example.com')
        self.patient.refresh_from_db()
        self.assertEqual(self.patient.care_path, CarePath.CLINICIAN)

        self.client.force_authenticate(self.patient_user)
        patient_list = self.client.get(self.endpoint)
        self.assertEqual(patient_list.status_code, 200)
        prescriptions = patient_list.data
        self.assertEqual(len(prescriptions), 1)
        self.assertEqual(prescriptions[0]['exercise'], self.exercise.id)
        self.assertEqual(prescriptions[0]['reps'], 8)
        self.assertEqual(prescriptions[0]['patient_email'], 'patient@example.com')

    def test_prescription_reports_completion_from_finished_target_session(self):
        self.client.force_authenticate(self.clinician_user)
        created = self.client.post(self.endpoint, self.payload(), format='json')
        self.assertEqual(created.status_code, 201, created.data)

        prescription = self.patient.prescriptions.get(pk=created.data['id'])
        now = timezone.now()
        Session.objects.create(
            patient=self.patient,
            exercise=self.exercise,
            prescription=prescription,
            started_at=now - timedelta(minutes=5),
            ended_at=now,
            sets_completed=2,
            reps_completed=8,
            sets_target=2,
            reps_target=8,
            affected_side='left',
        )

        response = self.client.get(self.endpoint)
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.data[0]['exercise_completed'])
        self.assertIsNotNone(response.data[0]['last_completed_at'])

    def test_patient_cannot_create_or_change_prescription(self):
        self.client.force_authenticate(self.patient_user)
        response = self.client.post(
            self.endpoint,
            self.payload(),
            format='json',
        )
        self.assertIn(response.status_code, (400, 403))

    def test_clinician_cannot_prescribe_to_unlinked_patient(self):
        other_user = User.objects.create_user(
            username='other-patient@example.com',
            email='other-patient@example.com',
            password='test-password',
            role=UserRole.PATIENT,
        )
        other = PatientProfile.objects.create(user=other_user)
        self.client.force_authenticate(self.clinician_user)

        response = self.client.post(
            self.endpoint,
            self.payload(other),
            format='json',
        )

        self.assertEqual(response.status_code, 400)
        self.assertIn('patient', response.data)

    def test_clinician_cannot_prescribe_to_stale_clinician_patient_profile(self):
        stale_profile = PatientProfile.objects.create(
            user=self.clinician_user,
            primary_clinician=self.clinician,
            care_path=CarePath.CLINICIAN,
        )
        self.client.force_authenticate(self.clinician_user)

        response = self.client.post(
            self.endpoint,
            self.payload(stale_profile),
            format='json',
        )

        self.assertEqual(response.status_code, 400)
        self.assertIn('patient', response.data)
        self.assertIn('registered as a patient', str(response.data['patient']))
        self.assertFalse(stale_profile.prescriptions.exists())

        roster = self.client.get('/api/patients/')
        self.assertEqual(roster.status_code, 200)
        self.assertNotIn(
            str(stale_profile.id),
            {str(item['id']) for item in roster.data},
        )

    def test_expired_prescription_is_visible_to_clinician_but_hidden_from_patient(self):
        self.client.force_authenticate(self.clinician_user)
        payload = self.payload()
        payload['valid_from'] = (
            timezone.localdate() - timedelta(days=10)
        ).isoformat()
        payload['valid_until'] = (
            timezone.localdate() - timedelta(days=1)
        ).isoformat()
        created = self.client.post(self.endpoint, payload, format='json')
        self.assertEqual(created.status_code, 201, created.data)

        clinician_list = self.client.get(self.endpoint)
        self.assertEqual(clinician_list.status_code, 200)
        self.assertEqual(len(clinician_list.data), 1)
        self.assertEqual(clinician_list.data[0]['id'], created.data['id'])

        roster = self.client.get('/api/patients/')
        self.assertEqual(roster.status_code, 200)
        roster_rows = (
            roster.data.get('results', roster.data)
            if isinstance(roster.data, dict)
            else roster.data
        )
        self.assertIsNone(roster_rows[0]['active_prescription'])

        self.client.force_authenticate(self.patient_user)
        patient_list = self.client.get(self.endpoint)
        self.assertEqual(patient_list.status_code, 200)
        self.assertEqual(patient_list.data, [])

    def test_reviewed_ai_draft_is_edited_assigned_and_sent_to_patient(self):
        draft = SlackPlanDraft.objects.create(
            patient=self.patient,
            clinician=self.clinician,
            plan={
                'summary': 'A gradual draft.',
                'days': [{'exercise_ids': [self.exercise.id]}],
                'constraints': {'days_per_week': 3},
            },
            preferences={'days_per_week': 3},
        )
        session = ClinicianAiSession.objects.create(
            clinician=self.clinician,
            title='Draft a programme',
        )
        message = ClinicianAiMessage.objects.create(
            session=session,
            role='assistant',
            command='build_plan',
            body='Draft programme',
            data={'draft_id': str(draft.id)},
        )
        previous = Prescription.objects.create(
            patient=self.patient,
            clinician=self.clinician,
            exercise=self.exercise,
            sets=1,
            reps=5,
            days_per_week='2',
            valid_from=timezone.localdate(),
        )
        self.client.force_authenticate(self.clinician_user)

        response = self.client.post(
            f'{self.endpoint}assign-draft/',
            {
                'draft': str(draft.id),
                'message_id': str(message.id),
                'stage': 'strength_control',
                'exercises': [{
                    'exercise': self.exercise.id,
                    'sets': 3,
                    'reps': 9,
                    'hold_seconds': 2,
                    'days_per_week': 4,
                }],
            },
            format='json',
        )

        self.assertEqual(response.status_code, 201, response.data)
        previous.refresh_from_db()
        self.assertFalse(previous.is_active)
        assigned = Prescription.objects.get(
            patient=self.patient,
            exercise=self.exercise,
            is_active=True,
        )
        self.assertEqual((assigned.sets, assigned.reps), (3, 9))
        self.assertEqual(assigned.days_per_week, '4')
        self.assertIn('Stage 2', assigned.notes)
        self.assertFalse(SlackPlanDraft.objects.filter(pk=draft.id).exists())
        notification = CareMessage.objects.get(
            patient=self.patient,
            sender=MessageSender.CLINICIAN,
        )
        self.assertIn('ready on your home page', notification.body)
        message.refresh_from_db()
        self.assertEqual(
            message.data['assigned']['stage'],
            'strength_control',
        )

    def test_ai_draft_publish_rejects_activity_not_in_saved_draft(self):
        other_exercise = Exercise.objects.create(
            id='not-suggested',
            name='Not Suggested',
            category='mobility',
            camera_direction='front',
            rep_rule='start → finish → start',
            tracked_angles_config={},
            phases_config=[],
            cues_config={},
        )
        draft = SlackPlanDraft.objects.create(
            patient=self.patient,
            clinician=self.clinician,
            plan={'days': [{'exercise_ids': [self.exercise.id]}]},
            preferences={},
        )
        self.client.force_authenticate(self.clinician_user)

        response = self.client.post(
            f'{self.endpoint}assign-draft/',
            {
                'draft': str(draft.id),
                'stage': 'early_activation',
                'exercises': [{
                    'exercise': other_exercise.id,
                    'sets': 1,
                    'reps': 6,
                    'days_per_week': 3,
                }],
            },
            format='json',
        )

        self.assertEqual(response.status_code, 400)
        self.assertIn('exercises', response.data)
        self.assertTrue(SlackPlanDraft.objects.filter(pk=draft.id).exists())
        self.assertFalse(Prescription.objects.filter(
            patient=self.patient,
            exercise=other_exercise,
        ).exists())
