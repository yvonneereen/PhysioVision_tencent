from types import SimpleNamespace
from unittest.mock import patch

from rest_framework.test import APITestCase

from api.catalogue.models import Exercise, Prescription
from api.core.models import ClinicianProfile, PatientProfile, User, UserRole


class ClinicianAssistantWebsiteTests(APITestCase):
    endpoint = "/api/auth/agent/chat/"

    def setUp(self):
        self.user = User.objects.create_user(
            username="clinician@example.com",
            email="clinician@example.com",
            password="test-password",
            role=UserRole.CLINICIAN,
            first_name="Casey",
        )
        self.clinician = ClinicianProfile.objects.create(
            user=self.user,
            license_number="TEST-CLINICIAN",
        )
        patient_user = User.objects.create_user(
            username="sarah@example.com",
            email="sarah@example.com",
            password="test-password",
            role=UserRole.PATIENT,
            first_name="Sarah",
            last_name="Lee",
        )
        self.patient = PatientProfile.objects.create(
            user=patient_user,
            primary_clinician=self.clinician,
        )

        other_user = User.objects.create_user(
            username="other-clinician@example.com",
            email="other-clinician@example.com",
            password="test-password",
            role=UserRole.CLINICIAN,
        )
        other_clinician = ClinicianProfile.objects.create(
            user=other_user,
            license_number="OTHER-CLINICIAN",
        )
        other_patient_user = User.objects.create_user(
            username="private@example.com",
            email="private@example.com",
            password="test-password",
            role=UserRole.PATIENT,
            first_name="Private",
            last_name="Patient",
        )
        PatientProfile.objects.create(
            user=other_patient_user,
            primary_clinician=other_clinician,
        )

        self.exercise = Exercise.objects.create(
            id="assistant-half-squats",
            name="Assistant Half Squats",
            category="strengthening",
            camera_direction="front",
            rep_rule="start → finish → start",
            tracked_angles_config={},
            phases_config=[],
            cues_config={},
        )
        self.client.force_authenticate(self.user)

    def ask(self, message):
        return self.client.post(self.endpoint, {"message": message}, format="json")

    def test_help_lists_website_commands(self):
        response = self.ask("help")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data["command"], "help")
        self.assertIn("my patients", response.data["reply"])
        self.assertIn("build a plan", response.data["reply"])

    def test_roster_and_summary_are_scoped_to_authenticated_clinician(self):
        roster = self.ask("my patients")
        summary = self.ask("summary")

        self.assertIn("1 patient(s)", roster.data["reply"])
        self.assertIn("1 patient(s)", summary.data["reply"])
        self.assertNotIn("Private Patient", roster.data["reply"])

    def test_lookup_cannot_access_another_clinicians_patient(self):
        response = self.ask("pain Private")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data["command"], "pain")
        self.assertIn("in your roster", response.data["reply"])

    @patch("api.core.views.generate_agent_reply", return_value="Natural-language reply")
    def test_condition_name_containing_pain_is_not_misread_as_lookup(self, generate_reply):
        message = (
            "Rosanne Lee is the patient; Patellofemoral Pain Syndrome is the condition."
        )

        response = self.ask(message)

        self.assertEqual(response.status_code, 200)
        self.assertNotIn("command", response.data)
        self.assertEqual(response.data["reply"], "Natural-language reply")
        generate_reply.assert_called_once_with(
            self.user,
            message,
            movement_context={},
            history=[],
        )

    def test_assign_creates_prescription_for_own_patient(self):
        response = self.ask("assign Assistant Half Squats to Sarah")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data["command"], "assign")
        self.assertTrue(response.data["changed"])
        self.assertTrue(Prescription.objects.filter(
            patient=self.patient,
            clinician=self.clinician,
            exercise=self.exercise,
            is_active=True,
        ).exists())

    def test_typed_plan_acceptance_requires_structured_editor(self):
        response = self.ask("accept plan for Sarah")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data["command"], "accept_plan")
        self.assertFalse(response.data["changed"])
        self.assertIn("editable programme card", response.data["reply"])
        self.assertFalse(Prescription.objects.filter(patient=self.patient).exists())

    @patch("api.slack_bot.services.generate_patient_message", return_value="Draft encouragement")
    def test_draft_message_uses_scoped_patient(self, generate_message):
        response = self.ask("draft message for Sarah")

        self.assertEqual(response.data["command"], "draft_message")
        self.assertEqual(response.data["reply"], "Draft encouragement")
        generate_message.assert_called_once_with(self.patient)

    @patch("api.slack_bot.services.build_plan_draft_blocks")
    @patch("api.slack_bot.services.build_plan_draft")
    def test_plan_builder_routes_to_existing_service(self, build_plan, build_blocks):
        draft = SimpleNamespace(
            id="91fd0e22-d00d-4db4-bbe8-c47bb0d76b93",
            patient=self.patient,
            plan={
                "summary": "A gentle plan.",
                "days": [{"exercise_ids": [self.exercise.id]}],
                "constraints": {"days_per_week": 4},
            },
            preferences={
                "days_per_week": 4,
                "clinical_summary": "adherence 70%",
                "dose": {self.exercise.id: {"sets": 2, "reps": 8}},
            },
        )
        build_plan.return_value = (self.patient, draft, None)
        build_blocks.return_value = [{
            "type": "section",
            "text": {"type": "mrkdwn", "text": "*Draft programme — Sarah Lee*"},
        }]

        response = self.ask("build a plan for Sarah 4 days with a band")

        self.assertEqual(response.data["command"], "build_plan")
        self.assertTrue(response.data["changed"])
        self.assertIn("Draft programme", response.data["reply"])
        self.assertEqual(response.data["data"]["patient_name"], "Sarah Lee")
        self.assertEqual(
            response.data["data"]["patient_id"],
            str(self.patient.id),
        )
        self.assertEqual(
            response.data["data"]["draft_id"],
            "91fd0e22-d00d-4db4-bbe8-c47bb0d76b93",
        )
        self.assertEqual(len(response.data["data"]["stages"]), 3)
        self.assertEqual(response.data["data"]["exercises"][0]["sets"], 2)
        build_plan.assert_called_once_with(
            self.clinician,
            "sarah",
            days_per_week=4,
            equipment="chair_band",
        )

    @patch("api.slack_bot.services.build_plan_draft_blocks")
    @patch("api.slack_bot.services.build_plan_draft")
    def test_create_plan_alias_preserves_numbered_patient_name(self, build_plan, build_blocks):
        numbered_user = User.objects.create_user(
            username="test2@example.com",
            email="test2@example.com",
            password="test-password",
            role=UserRole.PATIENT,
            first_name="test",
            last_name="2",
        )
        numbered = PatientProfile.objects.create(
            user=numbered_user,
            primary_clinician=self.clinician,
        )
        draft = SimpleNamespace(
            id="2cab0724-8de0-4bdb-8016-2a2cf5dd303e",
            patient=numbered,
            plan={"days": [], "constraints": {"days_per_week": 3}},
            preferences={"days_per_week": 3, "dose": {}},
        )
        build_plan.return_value = (numbered, draft, None)
        build_blocks.return_value = [{
            "type": "section",
            "text": {"type": "mrkdwn", "text": "*Draft programme — test 2*"},
        }]

        response = self.ask("create a plan for test 2")

        self.assertEqual(response.data["command"], "build_plan")
        self.assertEqual(response.data["data"]["patient_name"], "test 2")
        build_plan.assert_called_once_with(
            self.clinician,
            "test 2",
            days_per_week=3,
            equipment="chair",
        )

    @patch("api.slack_bot.services.build_plan_draft_blocks")
    @patch("api.slack_bot.services.build_plan_draft")
    def test_natural_exercise_plan_request_opens_structured_editor(
        self,
        build_plan,
        build_blocks,
    ):
        draft = SimpleNamespace(
            id="27dfa6c8-ac05-498b-876d-c7e20d526563",
            patient=self.patient,
            plan={
                "summary": "PFPS exercise draft.",
                "days": [{"exercise_ids": [self.exercise.id]}],
                "constraints": {"days_per_week": 3},
            },
            preferences={
                "days_per_week": 3,
                "dose": {self.exercise.id: {"sets": 2, "reps": 8}},
            },
        )
        build_plan.return_value = (self.patient, draft, None)
        build_blocks.return_value = [{
            "type": "section",
            "text": {"type": "mrkdwn", "text": "*Draft programme — Sarah Lee*"},
        }]

        response = self.ask(
            "create an exercise plan for Sarah Lee who has "
            "Patellofemoral Pain Syndrome"
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data["command"], "build_plan")
        self.assertEqual(response.data["data"]["patient_name"], "Sarah Lee")
        self.assertEqual(
            response.data["data"]["draft_id"],
            "27dfa6c8-ac05-498b-876d-c7e20d526563",
        )
        build_plan.assert_called_once_with(
            self.clinician,
            "sarah lee",
            days_per_week=3,
            equipment="chair",
        )
