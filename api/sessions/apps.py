from django.apps import AppConfig


class SessionsConfig(AppConfig):
    name = 'api.sessions'
    label = 'physio_sessions'

    def ready(self):
        from django.db.models.signals import post_save
        from .models import PainCheckin, Session

        def _evaluate(patient, session):
            from api.consultations.escalation_service import (
                evaluate_patient_escalations,
            )
            evaluate_patient_escalations(patient, session=session)

        def on_session_saved(sender, instance, **kwargs):
            _evaluate(instance.patient, instance)

        def on_paincheckin_saved(sender, instance, **kwargs):
            _evaluate(instance.patient, instance.session)

        post_save.connect(
            on_session_saved,
            sender=Session,
            dispatch_uid='escalation_check_on_session',
            # These receivers are defined inside ready(), so the signal must
            # retain a strong reference to them. Otherwise Python can collect
            # them after startup and no clinician review flag is created.
            weak=False,
        )
        post_save.connect(
            on_paincheckin_saved,
            sender=PainCheckin,
            dispatch_uid='escalation_check_on_paincheckin',
            weak=False,
        )
