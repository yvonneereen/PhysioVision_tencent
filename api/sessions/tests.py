from django.test import SimpleTestCase
from django.utils import timezone
from rest_framework.test import APITestCase

from api.catalogue.models import Calibration, Exercise
from api.consultations.models import (
    Escalation,
    EscalationStatus,
    EscalationTrigger,
)
from api.core.models import PatientProfile, User, UserRole

from .models import Session
from .serializers import PainCheckinSerializer, SessionSerializer


class PainCheckinSerializerTests(SimpleTestCase):
    def test_accepts_structured_pre_exercise_checkin(self):
        serializer = PainCheckinSerializer(data={
            "pain_level": 4,
            "timing": "before",
            "recovery_status": "better",
            "checked_at": "2026-07-23T10:00:00Z",
        })

        self.assertTrue(serializer.is_valid(), serializer.errors)

    def test_rejects_invalid_spoken_checkin_values(self):
        serializer = PainCheckinSerializer(data={
            "pain_level": 11,
            "timing": "during",
            "recovery_status": "excellent",
            "checked_at": "2026-07-23T10:00:00Z",
        })

        self.assertFalse(serializer.is_valid())
        self.assertIn("pain_level", serializer.errors)
        self.assertIn("timing", serializer.errors)
        self.assertIn("recovery_status", serializer.errors)


class SessionAssessmentSerializerTests(SimpleTestCase):
    def prototype_assessment(self):
        return {
            "version": 1,
            "tracking_validity": {"status": "partially_assessable"},
            "prescription_completion": {"status": "complete"},
            "movement_execution": {
                "status": "not_clinically_scored",
                "score": None,
            },
            "symptoms_and_safety": {
                "status": "not_reported_during_movement",
                "source": "patient_report",
                "camera_inference_used": False,
            },
        }

    def test_accepts_separate_unscored_assessment_outputs(self):
        serializer = SessionSerializer(
            data={"assessment_summary": self.prototype_assessment()},
            partial=True,
        )

        self.assertTrue(serializer.is_valid(), serializer.errors)

    def test_rejects_client_claim_of_unapproved_clinical_score(self):
        assessment = self.prototype_assessment()
        assessment["movement_execution"] = {
            "status": "assessed",
            "score": 85,
            "rule_versions": ["client-claimed-rule"],
        }
        serializer = SessionSerializer(
            data={
                "assessment_summary": assessment,
                "quality_score": 85,
            },
            partial=True,
        )

        self.assertFalse(serializer.is_valid())
        self.assertIn("assessment_summary", serializer.errors)

    def test_rejects_camera_inferred_symptoms(self):
        assessment = self.prototype_assessment()
        assessment["symptoms_and_safety"]["camera_inference_used"] = True
        serializer = SessionSerializer(
            data={"assessment_summary": assessment},
            partial=True,
        )

        self.assertFalse(serializer.is_valid())
        self.assertIn("assessment_summary", serializer.errors)


class PatientDataIsolationTests(APITestCase):
    def setUp(self):
        self.user_a = User.objects.create_user(
            username='patient-a@example.com',
            email='patient-a@example.com',
            password='test-password',
            role=UserRole.PATIENT,
        )
        self.patient_a = PatientProfile.objects.create(user=self.user_a)
        self.user_b = User.objects.create_user(
            username='patient-b@example.com',
            email='patient-b@example.com',
            password='test-password',
            role=UserRole.PATIENT,
        )
        self.patient_b = PatientProfile.objects.create(user=self.user_b)
        self.exercise = Exercise.objects.create(
            id='privacy-test',
            name='Privacy Test',
            category='mobility',
            camera_direction='front',
            rep_rule='start → finish → start',
            tracked_angles_config={},
            phases_config=[],
            cues_config={},
        )
        self.session_b = Session.objects.create(
            patient=self.patient_b,
            exercise=self.exercise,
            started_at=timezone.now(),
            reps_completed=3,
            reps_target=5,
            sets_completed=1,
            sets_target=2,
            affected_side='right',
        )
        self.calibration_b = Calibration.objects.create(
            patient=self.patient_b,
            exercise=self.exercise,
            affected_side='right',
            captured_at=timezone.now(),
            start_measurements={},
            target_measurements={},
            phase_ranges={},
        )

    def test_patient_session_list_excludes_other_users(self):
        Session.objects.create(
            patient=self.patient_a,
            exercise=self.exercise,
            started_at=timezone.now(),
            reps_completed=2,
            reps_target=5,
            sets_completed=1,
            sets_target=2,
            affected_side='right',
        )
        self.client.force_authenticate(self.user_a)

        response = self.client.get('/api/sessions/')

        self.assertEqual(response.status_code, 200)
        ids = {str(item['id']) for item in response.data['results']}
        self.assertEqual(len(ids), 1)
        self.assertNotIn(str(self.session_b.id), ids)

    def test_patient_cannot_attach_another_users_calibration(self):
        self.client.force_authenticate(self.user_a)

        response = self.client.post(
            '/api/sessions/',
            {
                'exercise': self.exercise.id,
                'calibration': str(self.calibration_b.id),
                'started_at': timezone.now().isoformat(),
                'sets_completed': 1,
                'reps_completed': 2,
                'reps_target': 5,
                'sets_target': 2,
                'affected_side': 'right',
            },
            format='json',
        )

        self.assertEqual(response.status_code, 400)
        self.assertIn('calibration', response.data)

    def test_patient_cannot_attach_checkin_to_another_users_session(self):
        self.client.force_authenticate(self.user_a)

        response = self.client.post(
            '/api/pain-checkins/',
            {
                'session': str(self.session_b.id),
                'pain_level': 3,
                'timing': 'after',
                'recovery_status': 'same',
                'checked_at': timezone.now().isoformat(),
            },
            format='json',
        )

        self.assertEqual(response.status_code, 400)
        self.assertIn('session', response.data)

    def test_patient_can_attach_before_and_after_checkins_to_own_session(self):
        session = Session.objects.create(
            patient=self.patient_a,
            exercise=self.exercise,
            started_at=timezone.now(),
            reps_completed=3,
            reps_target=5,
            sets_completed=1,
            sets_target=1,
            affected_side='right',
        )
        self.client.force_authenticate(self.user_a)

        before = self.client.post(
            '/api/pain-checkins/',
            {
                'pain_level': 3,
                'timing': 'before',
                'checked_at': timezone.now().isoformat(),
            },
            format='json',
        )
        linked_before = self.client.patch(
            f"/api/pain-checkins/{before.data['id']}/",
            {'session': str(session.id)},
            format='json',
        )
        after = self.client.post(
            '/api/pain-checkins/',
            {
                'session': str(session.id),
                'pain_level': 4,
                'timing': 'after',
                'recovery_status': 'worse',
                'checked_at': timezone.now().isoformat(),
            },
            format='json',
        )

        self.assertEqual(before.status_code, 201)
        self.assertEqual(linked_before.status_code, 200)
        self.assertEqual(after.status_code, 201)
        self.assertEqual(str(linked_before.data['session']), str(session.id))
        self.assertEqual(str(after.data['session']), str(session.id))

    def test_high_pain_checkin_creates_open_clinician_review_flag(self):
        self.client.force_authenticate(self.user_a)

        response = self.client.post(
            '/api/pain-checkins/',
            {
                'pain_level': 8,
                'timing': 'before',
                'checked_at': timezone.now().isoformat(),
            },
            format='json',
        )

        self.assertEqual(response.status_code, 201)
        escalation = Escalation.objects.get(
            patient=self.patient_a,
            trigger_type=EscalationTrigger.PAIN_INCREASE,
            status=EscalationStatus.OPEN,
        )
        self.assertIn('8/10', escalation.description)

    def test_early_stop_reason_and_minimum_repetitions_are_persisted(self):
        self.client.force_authenticate(self.user_a)

        response = self.client.post(
            '/api/sessions/',
            {
                'exercise': self.exercise.id,
                'started_at': timezone.now().isoformat(),
                'ended_at': timezone.now().isoformat(),
                'sets_completed': 0,
                'reps_completed': 5,
                'reps_target': 10,
                'reps_minimum': 6,
                'sets_target': 1,
                'affected_side': 'right',
                'stop_reason': 'dizzy',
            },
            format='json',
        )

        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.data['reps_minimum'], 6)
        self.assertEqual(response.data['stop_reason'], 'dizzy')
        self.assertTrue(response.data['stop_requires_review'])

    def test_non_urgent_early_stop_does_not_create_urgent_review_flag(self):
        session = Session.objects.create(
            patient=self.patient_a,
            exercise=self.exercise,
            started_at=timezone.now(),
            ended_at=timezone.now(),
            reps_completed=5,
            reps_target=10,
            reps_minimum=6,
            sets_completed=0,
            sets_target=1,
            affected_side='right',
            stop_reason='tired',
        )

        self.assertFalse(session.stop_requires_review)
