from unittest.mock import patch
from datetime import timedelta

from django.utils import timezone
from rest_framework.test import APITestCase

from api.catalogue.models import (
    AffectedSide,
    CameraDirection,
    Exercise,
    ExerciseCategory,
)
from api.consultations.models import (
    CareMessage,
    Escalation,
    EscalationTrigger,
    MessageSender,
)
from api.core.email_delivery import EmailDeliveryError

from api.core.models import (
    CarePath,
    ClinicianProfile,
    PatientPathwayChoice,
    PatientProfile,
    User,
    UserRole,
)
from api.sessions.models import (
    PainCheckin,
    PainCheckinTiming,
    RecoveryStatus,
    Session,
)


def validated_movement_assessment(score):
    return {
        "version": 1,
        "tracking_validity": {"status": "assessable"},
        "prescription_completion": {"status": "complete"},
        "movement_execution": {
            "status": "assessed",
            "score": score,
            "rule_versions": ["test-approved-rule"],
        },
        "symptoms_and_safety": {
            "status": "not_reported_during_movement",
            "source": "patient_report",
            "camera_inference_used": False,
        },
    }


class ClinicianTriageTests(APITestCase):
    queue_url = "/api/auth/clinician/triage/"

    def setUp(self):
        self.clinician_user = User.objects.create_user(
            username="triage-clinician@example.com",
            email="triage-clinician@example.com",
            password="test-password",
            role=UserRole.CLINICIAN,
        )
        self.clinician = ClinicianProfile.objects.create(
            user=self.clinician_user,
            license_number="TRIAGE-TEST",
        )
        waiting_user = User.objects.create_user(
            username="waiting@example.com",
            email="waiting@example.com",
            password="test-password",
            role=UserRole.PATIENT,
            first_name="Waiting",
            last_name="Patient",
        )
        self.waiting = PatientProfile.objects.create(
            user=waiting_user,
            pathway_choice=PatientPathwayChoice.PHYSIOTHERAPIST,
            care_path=CarePath.CLINICIAN,
            goal="mobility",
        )
        wellness_user = User.objects.create_user(
            username="wellness@example.com",
            email="wellness@example.com",
            password="test-password",
            role=UserRole.PATIENT,
            first_name="Wellness",
        )
        self.wellness = PatientProfile.objects.create(
            user=wellness_user,
            pathway_choice=PatientPathwayChoice.WELLNESS,
            care_path=CarePath.WELLNESS,
        )

    def claim_url(self, patient):
        return f"/api/auth/clinician/triage/{patient.id}/claim/"

    def decline_url(self, patient):
        return f"/api/auth/clinician/triage/{patient.id}/decline/"

    def test_queue_contains_only_unassigned_physio_requests(self):
        self.client.force_authenticate(self.clinician_user)

        response = self.client.get(self.queue_url)

        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(response.data), 1)
        self.assertEqual(response.data[0]["id"], str(self.waiting.id))
        self.assertEqual(response.data[0]["name"], "Waiting Patient")
        self.assertEqual(response.data[0]["email"], "waiting@example.com")
        self.assertEqual(response.data[0]["request_kind"], "initial_pathway")

    def test_clinician_account_with_stale_patient_profile_is_never_triaged(self):
        stale_profile = PatientProfile.objects.create(
            user=self.clinician_user,
            pathway_choice=PatientPathwayChoice.PHYSIOTHERAPIST,
            care_path=CarePath.CLINICIAN,
            physiotherapist_requested_at=timezone.now(),
        )
        self.client.force_authenticate(self.clinician_user)

        queue = self.client.get(self.queue_url)
        claim = self.client.post(
            self.claim_url(stale_profile),
            {},
            format="json",
        )
        decline = self.client.post(
            self.decline_url(stale_profile),
            {},
            format="json",
        )

        queue_ids = {item["id"] for item in queue.data}
        self.assertNotIn(str(stale_profile.id), queue_ids)
        self.assertEqual(claim.status_code, 409)
        self.assertEqual(decline.status_code, 409)
        self.assertIn("Only patient accounts", claim.data["detail"])
        self.assertIn("Only patient accounts", decline.data["detail"])

    def test_queue_contains_pending_wellness_request_without_switching_path(self):
        self.wellness.physiotherapist_requested_at = timezone.now()
        self.wellness.save(update_fields=["physiotherapist_requested_at"])
        self.client.force_authenticate(self.clinician_user)

        response = self.client.get(self.queue_url)

        self.assertEqual(response.status_code, 200)
        ids = {item["id"] for item in response.data}
        self.assertEqual(ids, {str(self.waiting.id), str(self.wellness.id)})
        queue_by_id = {item["id"]: item for item in response.data}
        self.assertEqual(
            queue_by_id[str(self.wellness.id)]["request_kind"],
            "wellness_self_referral",
        )
        self.wellness.refresh_from_db()
        self.assertEqual(
            self.wellness.pathway_choice,
            PatientPathwayChoice.WELLNESS,
        )
        self.assertEqual(self.wellness.care_path, CarePath.WELLNESS)

    def test_queue_includes_recorded_patient_problem_signals(self):
        now = timezone.now()
        self.wellness.physiotherapist_requested_at = now
        self.wellness.medical_history = "Recovered right knee injury."
        self.wellness.wellness_screening_status = "needs_review"
        self.wellness.wellness_screening_answers = {
            "not_treating_condition": True,
            "no_clinician_restrictions": True,
            "general_wellness_goal": True,
            "no_concerning_symptoms": False,
        }
        self.wellness.wellness_screened_at = now - timedelta(days=6)
        self.wellness.save(update_fields=[
            "physiotherapist_requested_at",
            "medical_history",
            "wellness_screening_status",
            "wellness_screening_answers",
            "wellness_screened_at",
        ])
        exercise = Exercise.objects.create(
            id="triage-half-squats",
            name="Half Squats",
            category=ExerciseCategory.STRENGTHENING,
            camera_direction=CameraDirection.SIDE,
            rep_rule="standing to squat to standing",
            tracked_angles_config={},
            phases_config=[],
            cues_config={},
        )
        newer_exercise = Exercise.objects.create(
            id="triage-calf-raises",
            name="Calf Raises",
            category=ExerciseCategory.STRENGTHENING,
            camera_direction=CameraDirection.SIDE,
            rep_rule="standing to raised heels to standing",
            tracked_angles_config={},
            phases_config=[],
            cues_config={},
        )
        earlier_session = Session.objects.create(
            patient=self.wellness,
            exercise=exercise,
            started_at=now - timedelta(days=5),
            ended_at=now - timedelta(days=5) + timedelta(minutes=2),
            reps_completed=10,
            reps_target=10,
            sets_completed=1,
            sets_target=1,
            affected_side=AffectedSide.RIGHT,
            quality_score=76,
            assessment_summary=validated_movement_assessment(76),
        )
        latest_session = Session.objects.create(
            patient=self.wellness,
            exercise=exercise,
            started_at=now - timedelta(days=1),
            ended_at=now - timedelta(days=1) + timedelta(minutes=2),
            reps_completed=10,
            reps_target=10,
            sets_completed=1,
            sets_target=1,
            affected_side=AffectedSide.RIGHT,
            quality_score=45,
            assessment_summary=validated_movement_assessment(45),
        )
        Session.objects.create(
            patient=self.wellness,
            exercise=newer_exercise,
            started_at=now - timedelta(hours=12),
            ended_at=now - timedelta(hours=12) + timedelta(minutes=2),
            reps_completed=10,
            reps_target=10,
            sets_completed=1,
            sets_target=1,
            affected_side=AffectedSide.RIGHT,
            quality_score=90,
            assessment_summary=validated_movement_assessment(90),
        )
        PainCheckin.objects.create(
            patient=self.wellness,
            session=earlier_session,
            pain_level=3,
            timing=PainCheckinTiming.AFTER,
            recovery_status=RecoveryStatus.WORSE,
            location_notes="Right knee",
            checked_at=now - timedelta(days=5),
        )
        PainCheckin.objects.create(
            patient=self.wellness,
            session=latest_session,
            pain_level=8,
            timing=PainCheckinTiming.AFTER,
            recovery_status=RecoveryStatus.WORSE,
            location_notes="Right knee",
            safety_follow_up={"outcome": "professional"},
            requires_review=True,
            checked_at=now - timedelta(days=1),
        )
        Escalation.objects.create(
            patient=self.wellness,
            trigger_type=EscalationTrigger.SYMMETRY_CONCERN,
            description="Repeated right-left movement difference needs review.",
            session=latest_session,
        )
        self.client.force_authenticate(self.clinician_user)

        response = self.client.get(self.queue_url)

        self.assertEqual(response.status_code, 200)
        wellness_item = next(
            item for item in response.data
            if item["id"] == str(self.wellness.id)
        )
        summary = wellness_item["review_summary"]
        self.assertEqual(summary["evidence_status"], "recorded_concerns")
        self.assertEqual(summary["pain"]["value"], 8)
        self.assertEqual(summary["pain"]["previous_value"], 3)
        self.assertEqual(summary["pain"]["change"], 5)
        self.assertEqual(summary["pain"]["trend"], "rising")
        self.assertEqual(summary["recovery"]["worse_count"], 2)
        self.assertEqual(summary["movement_quality"]["value"], 45)
        self.assertEqual(summary["movement_quality"]["exercise"], "Half Squats")
        self.assertEqual(summary["movement_quality"]["previous_value"], 76)
        self.assertEqual(summary["movement_quality"]["trend"], "declining")
        self.assertEqual(summary["movement_quality"]["comparable_sessions"], 2)
        self.assertEqual(
            summary["patient_reported_background"],
            "Recovered right knee injury.",
        )
        signal_kinds = {signal["kind"] for signal in summary["signals"]}
        self.assertEqual(
            signal_kinds,
            {"screening", "safety", "pain", "recovery", "quality", "symmetry"},
        )
        self.assertGreaterEqual(summary["high_concern_count"], 3)
        self.assertEqual(response.data[0]["id"], str(self.wellness.id))

    def test_queue_reports_limited_data_instead_of_inventing_a_problem(self):
        self.client.force_authenticate(self.clinician_user)

        response = self.client.get(self.queue_url)

        self.assertEqual(response.status_code, 200)
        summary = response.data[0]["review_summary"]
        self.assertEqual(summary["evidence_status"], "limited_data")
        self.assertEqual(summary["concern_count"], 0)
        self.assertEqual(summary["signals"], [])
        self.assertIsNone(summary["pain"])
        self.assertIsNone(summary["movement_quality"])
        self.assertIn("requested physiotherapist-guided support", summary["request_reason"])

    def _queue_safety_signal(self, safety_follow_up, *, pain_level=5):
        now = timezone.now()
        self.wellness.physiotherapist_requested_at = now
        self.wellness.save(update_fields=["physiotherapist_requested_at"])
        PainCheckin.objects.create(
            patient=self.wellness,
            pain_level=pain_level,
            timing=PainCheckinTiming.AFTER,
            recovery_status=RecoveryStatus.SAME,
            safety_follow_up=safety_follow_up,
            requires_review=True,
            checked_at=now - timedelta(days=1),
        )
        self.client.force_authenticate(self.clinician_user)
        response = self.client.get(self.queue_url)
        self.assertEqual(response.status_code, 200)
        item = next(
            row for row in response.data
            if row["id"] == str(self.wellness.id)
        )
        return next(
            signal for signal in item["review_summary"]["signals"]
            if signal["kind"] == "safety"
        )

    def test_urgent_safety_signal_explains_the_recorded_breathing_answer(self):
        signal = self._queue_safety_signal({
            "outcome": "urgent",
            "urgent_combined_response": "yes",
            "urgent_symptoms": "yes",
            "urgent_symptom_details": {
                "chest": "no",
                "breathing": "yes",
                "neurologic": "",
                "fall": "",
            },
        })

        self.assertEqual(signal["event_scope"], "historical_safety_check")
        self.assertEqual(signal["label"], "Historical safety check — urgent advice")
        self.assertTrue(signal["specific_reason_recorded"])
        self.assertIn("shortness of breath", signal["detail"])
        self.assertIn("does not show whether the symptom is still present", signal["detail"])
        self.assertEqual(
            signal["recorded_reasons"],
            ["unusual shortness of breath or difficulty breathing"],
        )

    def test_legacy_combined_urgent_answer_does_not_invent_a_symptom(self):
        signal = self._queue_safety_signal({
            "outcome": "urgent",
            "urgent_symptoms": "yes",
        })

        self.assertFalse(signal["specific_reason_recorded"])
        self.assertEqual(signal["recorded_reasons"], [])
        self.assertIn("answered Yes", signal["detail"])
        self.assertIn("did not capture which specific warning sign", signal["detail"])
        self.assertNotIn("reported unusual shortness of breath", signal["detail"])

    def test_professional_review_signal_explains_each_saved_answer(self):
        signal = self._queue_safety_signal({
            "outcome": "professional",
            "urgent_symptoms": "no",
            "rest_trend": "worse",
            "safe_movement": "nearby",
        }, pain_level=7)

        self.assertTrue(signal["specific_reason_recorded"])
        self.assertIn("pain of 7/10", signal["detail"])
        self.assertIn("pain getting worse after rest", signal["detail"])
        self.assertIn("another person nearby", signal["detail"])

    @patch("api.core.views.deliver_email")
    def test_claim_is_the_event_that_switches_pending_wellness_patient(
        self,
        deliver_email,
    ):
        self.wellness.physiotherapist_requested_at = timezone.now()
        self.wellness.low_risk_acknowledged = True
        self.wellness.wellness_plan = {"summary": "Temporary wellness plan"}
        self.wellness.wellness_plan_accepted_at = timezone.now()
        self.wellness.save()
        self.client.force_authenticate(self.clinician_user)

        response = self.client.post(
            self.claim_url(self.wellness),
            {},
            format="json",
        )

        self.assertEqual(response.status_code, 200)
        self.wellness.refresh_from_db()
        self.assertEqual(self.wellness.primary_clinician, self.clinician)
        self.assertEqual(
            self.wellness.pathway_choice,
            PatientPathwayChoice.PHYSIOTHERAPIST,
        )
        self.assertEqual(self.wellness.care_path, CarePath.NEEDS_REVIEW)
        self.assertIsNone(self.wellness.physiotherapist_requested_at)
        self.assertFalse(self.wellness.low_risk_acknowledged)
        self.assertEqual(self.wellness.wellness_plan, {})
        self.assertIsNone(self.wellness.wellness_plan_accepted_at)

    def test_patient_cannot_view_claim_or_decline_triage(self):
        self.client.force_authenticate(self.waiting.user)

        queue = self.client.get(self.queue_url)
        claim = self.client.post(self.claim_url(self.waiting), {}, format="json")
        decline = self.client.post(self.decline_url(self.waiting), {}, format="json")

        self.assertEqual(queue.status_code, 403)
        self.assertEqual(claim.status_code, 403)
        self.assertEqual(decline.status_code, 403)

    def test_decline_keeps_pending_wellness_patient_on_existing_plan(self):
        requested_at = timezone.now()
        accepted_at = timezone.now()
        existing_plan = {"summary": "Keep this wellness plan"}
        self.wellness.physiotherapist_requested_at = requested_at
        self.wellness.low_risk_acknowledged = True
        self.wellness.wellness_plan = existing_plan
        self.wellness.wellness_plan_accepted_at = accepted_at
        self.wellness.save()
        self.client.force_authenticate(self.clinician_user)

        response = self.client.post(
            self.decline_url(self.wellness),
            {},
            format="json",
        )

        self.assertEqual(response.status_code, 200)
        self.wellness.refresh_from_db()
        self.assertIsNone(self.wellness.physiotherapist_requested_at)
        self.assertEqual(self.wellness.pathway_choice, PatientPathwayChoice.WELLNESS)
        self.assertEqual(self.wellness.care_path, CarePath.WELLNESS)
        self.assertTrue(self.wellness.low_risk_acknowledged)
        self.assertEqual(self.wellness.wellness_plan, existing_plan)
        self.assertEqual(self.wellness.wellness_plan_accepted_at, accepted_at)
        ids = {item["id"] for item in self.client.get(self.queue_url).data}
        self.assertNotIn(str(self.wellness.id), ids)

    def test_decline_initial_physio_request_returns_to_pathway_selection(self):
        self.client.force_authenticate(self.clinician_user)

        response = self.client.post(
            self.decline_url(self.waiting),
            {},
            format="json",
        )

        self.assertEqual(response.status_code, 200)
        self.waiting.refresh_from_db()
        self.assertIsNone(self.waiting.primary_clinician)
        self.assertEqual(
            self.waiting.pathway_choice,
            PatientPathwayChoice.UNSELECTED,
        )
        self.assertIsNone(self.waiting.pathway_selected_at)
        self.assertEqual(self.waiting.care_path, CarePath.WELLNESS)
        self.assertEqual(self.client.get(self.queue_url).data, [])

    @patch("api.core.views.deliver_email")
    def test_claim_adds_patient_to_roster_and_notifies_them(self, deliver_email):
        self.client.force_authenticate(self.clinician_user)

        response = self.client.post(self.claim_url(self.waiting), {}, format="json")

        self.assertEqual(response.status_code, 200)
        self.waiting.refresh_from_db()
        self.assertEqual(self.waiting.primary_clinician, self.clinician)
        self.assertEqual(self.waiting.care_path, CarePath.NEEDS_REVIEW)
        self.assertEqual(self.client.get(self.queue_url).data, [])
        message = CareMessage.objects.get(patient=self.waiting)
        self.assertEqual(message.clinician, self.clinician)
        self.assertEqual(message.sender, MessageSender.CLINICIAN)
        self.assertIn("accepted your request", message.body)
        deliver_email.assert_called_once_with(
            subject="A physiotherapist has accepted your PhysioVision request",
            message=(
                "Hello Waiting,\n\n"
                "triage-clinician@example.com has accepted your request for "
                "physiotherapist support and is now linked to your PhysioVision "
                "account. They will review your information before recommending or "
                "changing any programme.\n\n"
                "Sign in to PhysioVision to view your care-team messages."
            ),
            recipient="waiting@example.com",
        )
        self.assertEqual(response.data["notification"], {
            "in_app": True,
            "email_sent": True,
        })

    @patch("api.core.views.deliver_email", side_effect=EmailDeliveryError)
    def test_email_failure_does_not_undo_claim_or_in_app_message(self, deliver_email):
        self.client.force_authenticate(self.clinician_user)

        response = self.client.post(self.claim_url(self.waiting), {}, format="json")

        self.assertEqual(response.status_code, 200)
        self.waiting.refresh_from_db()
        self.assertEqual(self.waiting.primary_clinician, self.clinician)
        self.assertTrue(CareMessage.objects.filter(patient=self.waiting).exists())
        self.assertFalse(response.data["notification"]["email_sent"])

    def test_claim_rejects_patient_already_claimed_by_another_clinician(self):
        other_user = User.objects.create_user(
            username="other-triage@example.com",
            email="other-triage@example.com",
            password="test-password",
            role=UserRole.CLINICIAN,
        )
        other = ClinicianProfile.objects.create(
            user=other_user,
            license_number="OTHER-TRIAGE",
        )
        self.waiting.primary_clinician = other
        self.waiting.save(update_fields=["primary_clinician"])
        self.client.force_authenticate(self.clinician_user)

        response = self.client.post(self.claim_url(self.waiting), {}, format="json")

        self.assertEqual(response.status_code, 409)
        self.assertIn("already been claimed", response.data["detail"])
