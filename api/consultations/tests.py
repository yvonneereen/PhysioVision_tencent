from datetime import timedelta
from unittest.mock import patch

from django.utils import timezone
from rest_framework.test import APITestCase

from api.core.models import (
    ClinicianProfile,
    PatientProfile,
    User,
    UserRole,
)
from api.consultations.models import ConsultationInitiator, ConsultationStatus
from api.consultations.drafting import (
    ConsultationDraftUnavailable,
    build_consultation_facts,
)


class PatientConsultationBookingTests(APITestCase):
    def setUp(self):
        self.patient_user = User.objects.create_user(
            username='patient@example.com',
            email='patient@example.com',
            password='safe-password',
            role=UserRole.PATIENT,
        )
        self.patient = PatientProfile.objects.create(user=self.patient_user)
        self.clinician_user = User.objects.create_user(
            username='physio@example.com',
            email='physio@example.com',
            password='safe-password',
            first_name='Mei',
            last_name='Lin',
            role=UserRole.CLINICIAN,
        )
        self.clinician = ClinicianProfile.objects.create(
            user=self.clinician_user,
            license_number='PT-100',
            is_accepting_patients=True,
        )

    def request_payload(self):
        return {
            'patient_notes': 'I would like to review my recent knee pain.',
        }

    def test_linked_patient_books_with_primary_clinician(self):
        self.patient.primary_clinician = self.clinician
        self.patient.save(update_fields=['primary_clinician', 'updated_at'])
        self.client.force_authenticate(self.patient_user)

        response = self.client.post(
            '/api/consultations/',
            self.request_payload(),
            format='json',
        )

        self.assertEqual(response.status_code, 201)
        self.assertEqual(str(response.data['clinician']), str(self.clinician.id))
        self.assertEqual(response.data['clinician_name'], 'Mei Lin')
        self.assertIsNone(response.data['scheduled_at'])
        self.assertEqual(response.data['duration_minutes'], 30)
        self.assertEqual(response.data['status'], ConsultationStatus.REQUESTED)
        self.assertEqual(response.data['initiated_by'], ConsultationInitiator.PATIENT)

    def test_unlinked_patient_is_matched_to_accepting_clinician(self):
        self.client.force_authenticate(self.patient_user)

        response = self.client.post(
            '/api/consultations/',
            self.request_payload(),
            format='json',
        )

        self.assertEqual(response.status_code, 201)
        self.assertEqual(str(response.data['clinician']), str(self.clinician.id))

    def test_clinician_cannot_create_patient_consultation(self):
        self.client.force_authenticate(self.clinician_user)

        response = self.client.post(
            '/api/consultations/',
            self.request_payload(),
            format='json',
        )

        self.assertEqual(response.status_code, 403)

    def test_clinician_can_initiate_consultation_for_linked_patient(self):
        self.patient.primary_clinician = self.clinician
        self.patient.save(update_fields=['primary_clinician', 'updated_at'])
        self.client.force_authenticate(self.clinician_user)
        proposed_time = timezone.now() + timedelta(days=2)

        response = self.client.post(
            '/api/consultations/initiate/',
            {
                'patient': str(self.patient.id),
                'scheduled_at': proposed_time.isoformat(),
                'duration_minutes': 45,
                'clinician_notes': 'Review the recent knee pain trend.',
            },
            format='json',
        )

        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.data['status'], ConsultationStatus.REQUESTED)
        self.assertEqual(
            response.data['initiated_by'], ConsultationInitiator.CLINICIAN,
        )
        self.assertEqual(response.data['duration_minutes'], 45)
        self.assertEqual(
            response.data['clinician_notes'],
            'Review the recent knee pain trend.',
        )

        self.client.force_authenticate(self.patient_user)
        accepted = self.client.post(
            f"/api/consultations/{response.data['id']}/accept/",
            {},
            format='json',
        )
        self.assertEqual(accepted.status_code, 200)
        self.assertEqual(accepted.data['status'], ConsultationStatus.CONFIRMED)

    def test_clinician_cannot_initiate_for_unlinked_patient(self):
        self.client.force_authenticate(self.clinician_user)

        response = self.client.post(
            '/api/consultations/initiate/',
            {
                'patient': str(self.patient.id),
                'scheduled_at': (timezone.now() + timedelta(days=2)).isoformat(),
            },
            format='json',
        )

        self.assertEqual(response.status_code, 400)
        self.assertIn('patient', response.data)

    def test_patient_cannot_initiate_clinician_consultation(self):
        self.client.force_authenticate(self.patient_user)

        response = self.client.post(
            '/api/consultations/initiate/',
            {
                'patient': str(self.patient.id),
                'scheduled_at': (timezone.now() + timedelta(days=2)).isoformat(),
            },
            format='json',
        )

        self.assertEqual(response.status_code, 403)

    def test_clinician_cannot_initiate_consultation_in_the_past(self):
        self.patient.primary_clinician = self.clinician
        self.patient.save(update_fields=['primary_clinician', 'updated_at'])
        self.client.force_authenticate(self.clinician_user)

        response = self.client.post(
            '/api/consultations/initiate/',
            {
                'patient': str(self.patient.id),
                'scheduled_at': (timezone.now() - timedelta(minutes=5)).isoformat(),
            },
            format='json',
        )

        self.assertEqual(response.status_code, 400)
        self.assertIn('scheduled_at', response.data)

    def test_patient_cannot_choose_the_appointment_time(self):
        self.client.force_authenticate(self.patient_user)
        payload = self.request_payload() | {
            'scheduled_at': (timezone.now() + timedelta(days=2)).isoformat(),
            'duration_minutes': 60,
        }

        response = self.client.post('/api/consultations/', payload, format='json')

        self.assertEqual(response.status_code, 201)
        self.assertIsNone(response.data['scheduled_at'])
        self.assertEqual(response.data['duration_minutes'], 30)

    def test_clinician_proposes_time_and_patient_accepts_it(self):
        self.patient.primary_clinician = self.clinician
        self.patient.save(update_fields=['primary_clinician', 'updated_at'])
        self.client.force_authenticate(self.patient_user)
        created = self.client.post(
            '/api/consultations/', self.request_payload(), format='json',
        )
        consultation_id = created.data['id']
        proposed_time = timezone.now() + timedelta(days=2)

        self.client.force_authenticate(self.clinician_user)
        scheduled = self.client.patch(
            f'/api/consultations/{consultation_id}/',
            {
                'scheduled_at': proposed_time.isoformat(),
                'duration_minutes': 45,
            },
            format='json',
        )
        self.assertEqual(scheduled.status_code, 200)
        self.assertEqual(scheduled.data['duration_minutes'], 45)
        self.assertEqual(
            scheduled.data['initiated_by'], ConsultationInitiator.CLINICIAN,
        )
        self.assertEqual(scheduled.data['status'], ConsultationStatus.REQUESTED)

        self.client.force_authenticate(self.patient_user)
        accepted = self.client.post(
            f'/api/consultations/{consultation_id}/accept/', {}, format='json',
        )
        self.assertEqual(accepted.status_code, 200)
        self.assertEqual(accepted.data['status'], ConsultationStatus.CONFIRMED)

    def test_patient_cannot_schedule_pending_request(self):
        self.client.force_authenticate(self.patient_user)
        created = self.client.post(
            '/api/consultations/', self.request_payload(), format='json',
        )
        consultation_id = created.data['id']

        response = self.client.patch(
            f'/api/consultations/{consultation_id}/',
            {'scheduled_at': (timezone.now() + timedelta(days=2)).isoformat()},
            format='json',
        )

        self.assertEqual(response.status_code, 403)

    def test_patient_cannot_accept_unscheduled_request(self):
        self.client.force_authenticate(self.patient_user)
        created = self.client.post(
            '/api/consultations/', self.request_payload(), format='json',
        )

        response = self.client.post(
            f"/api/consultations/{created.data['id']}/accept/", {}, format='json',
        )

        self.assertEqual(response.status_code, 400)

    @patch(
        'api.consultations.views.generate_consultation_draft',
        return_value=(
            'My recent knee pain increased while my movement scores decreased. '
            'I would like these recorded trends reviewed.'
        ),
    )
    def test_patient_can_generate_editable_ai_draft(self, generate_draft):
        self.client.force_authenticate(self.patient_user)

        response = self.client.post(
            '/api/consultations/draft/',
            {'locale': 'en-SG'},
            format='json',
        )

        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.data['requires_review'])
        self.assertEqual(response.data['source'], 'ai_record_summary')
        self.assertIn('recorded trends', response.data['draft'])
        generate_draft.assert_called_once_with(self.patient, 'en-SG')

    @patch('api.consultations.views.generate_consultation_draft')
    def test_clinician_cannot_generate_patient_draft(self, generate_draft):
        self.client.force_authenticate(self.clinician_user)

        response = self.client.post(
            '/api/consultations/draft/',
            {'locale': 'en-SG'},
            format='json',
        )

        self.assertEqual(response.status_code, 403)
        generate_draft.assert_not_called()

    @patch(
        'api.consultations.views.generate_consultation_draft',
        side_effect=ConsultationDraftUnavailable('private provider detail'),
    )
    def test_ai_failure_keeps_manual_and_speech_options(self, _generate_draft):
        self.client.force_authenticate(self.patient_user)

        response = self.client.post(
            '/api/consultations/draft/',
            {'locale': 'en-SG'},
            format='json',
        )

        self.assertEqual(response.status_code, 503)
        self.assertIn('speak or type', response.data['detail'])
        self.assertNotIn('private provider detail', response.data['detail'])

    def test_ai_facts_are_scoped_to_the_authenticated_patient(self):
        facts = build_consultation_facts(self.patient)

        self.assertNotIn('patient_goal', facts)
        self.assertNotIn('focus_side', facts)
        self.assertNotIn('movement_quality_trend', facts)
        self.assertEqual(facts['recent_sessions'], [])
        self.assertEqual(facts['recent_pain_checkins'], [])
        self.assertEqual(facts['open_review_flags'], [])


class CareMessageTests(APITestCase):
    def setUp(self):
        self.patient_user = User.objects.create_user(
            username='pat@ex.com', email='pat@ex.com', password='pw',
            role=UserRole.PATIENT, first_name='Sam', last_name='Lee',
        )
        self.clinician_user = User.objects.create_user(
            username='doc@ex.com', email='doc@ex.com', password='pw',
            role=UserRole.CLINICIAN, first_name='Mei', last_name='Lin',
        )
        self.clinician = ClinicianProfile.objects.create(
            user=self.clinician_user, license_number='PT-1',
        )
        self.patient = PatientProfile.objects.create(
            user=self.patient_user, primary_clinician=self.clinician,
        )

    def test_patient_with_clinician_can_send(self):
        self.client.force_authenticate(self.patient_user)
        response = self.client.post(
            '/api/care-messages/', {'body': 'Is soreness normal?'}, format='json',
        )
        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.data['sender'], 'patient')
        self.assertEqual(response.data['sender_name'], 'Sam Lee')

    def test_patient_without_clinician_cannot_send(self):
        self.patient.primary_clinician = None
        self.patient.save(update_fields=['primary_clinician'])
        self.client.force_authenticate(self.patient_user)
        response = self.client.post(
            '/api/care-messages/', {'body': 'Hello?'}, format='json',
        )
        self.assertEqual(response.status_code, 400)

    def test_clinician_replies_and_thread_is_scoped(self):
        # Patient sends, clinician sees it scoped by ?patient= and replies.
        self.client.force_authenticate(self.patient_user)
        self.client.post('/api/care-messages/', {'body': 'Question'}, format='json')

        self.client.force_authenticate(self.clinician_user)
        listed = self.client.get(f'/api/care-messages/?patient={self.patient.id}')
        self.assertEqual(listed.status_code, 200)
        self.assertEqual(len(listed.data['results']
                             if isinstance(listed.data, dict) else listed.data), 1)

        reply = self.client.post(
            '/api/care-messages/',
            {'body': 'That can be normal early on.', 'patient': str(self.patient.id)},
            format='json',
        )
        self.assertEqual(reply.status_code, 201)
        self.assertEqual(reply.data['sender'], 'clinician')

    def test_threads_lists_conversation_with_unread_count(self):
        self.client.force_authenticate(self.patient_user)
        self.client.post('/api/care-messages/', {'body': 'Q1'}, format='json')
        self.client.post('/api/care-messages/', {'body': 'Q2'}, format='json')

        self.client.force_authenticate(self.clinician_user)
        response = self.client.get('/api/care-messages/threads/')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(response.data), 1)
        thread = response.data[0]
        self.assertEqual(thread['patient'], str(self.patient.id))
        self.assertEqual(thread['unread'], 2)
        self.assertEqual(thread['last_body'], 'Q2')

    def test_clinician_cannot_message_other_roster_patient(self):
        other = PatientProfile.objects.create(
            user=User.objects.create_user(
                username='other@ex.com', email='other@ex.com', password='pw',
                role=UserRole.PATIENT,
            ),
        )
        self.client.force_authenticate(self.clinician_user)
        response = self.client.post(
            '/api/care-messages/',
            {'body': 'hi', 'patient': str(other.id)},
            format='json',
        )
        self.assertEqual(response.status_code, 400)
