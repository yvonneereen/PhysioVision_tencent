import base64
import io
from pathlib import Path
import sys
import types as python_types
import unittest
import wave


sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


settings = python_types.SimpleNamespace(
    GEMINI_API_KEY="test-key",
    GEMINI_TTS_MODEL="gemini-3.1-flash-tts-preview",
    GEMINI_TTS_VOICE="Sulafat",
)
django_module = python_types.ModuleType("django")
django_conf_module = python_types.ModuleType("django.conf")
django_conf_module.settings = settings
django_module.conf = django_conf_module
sys.modules.setdefault("django", django_module)
sys.modules.setdefault("django.conf", django_conf_module)


class ConfigValue:
    def __init__(self, **values):
        self.values = values


google_module = python_types.ModuleType("google")
google_module.__path__ = []
genai_module = python_types.ModuleType("google.genai")
genai_module.__path__ = []
genai_types_module = python_types.ModuleType("google.genai.types")
for name in [
    "GenerateContentConfig",
    "SpeechConfig",
    "VoiceConfig",
    "PrebuiltVoiceConfig",
]:
    setattr(genai_types_module, name, ConfigValue)
genai_module.types = genai_types_module
google_module.genai = genai_module
sys.modules.setdefault("google", google_module)
sys.modules.setdefault("google.genai", genai_module)
sys.modules.setdefault("google.genai.types", genai_types_module)

from api.core.speech import GuidanceSpeechUnavailable, generate_guidance_speech


def nested_audio(pcm_audio):
    inline_data = python_types.SimpleNamespace(data=pcm_audio)
    part = python_types.SimpleNamespace(inline_data=inline_data)
    content = python_types.SimpleNamespace(parts=[part])
    candidate = python_types.SimpleNamespace(content=content)
    return python_types.SimpleNamespace(candidates=[candidate])


def wav_frames(encoded_audio):
    with wave.open(io.BytesIO(base64.b64decode(encoded_audio)), "rb") as wav_file:
        return wav_file.readframes(wav_file.getnframes())


class SpeechClient:
    def __init__(self, *, generated=None, generate_error=None, interaction=None):
        self.generated = generated
        self.generate_error = generate_error
        self.interaction = interaction
        self.generate_calls = []
        self.interaction_calls = []
        self.models = self
        self.interactions = self

    def generate_content(self, **request):
        self.generate_calls.append(request)
        if self.generate_error:
            raise self.generate_error
        return self.generated

    def create(self, **request):
        self.interaction_calls.append(request)
        if isinstance(self.interaction, Exception):
            raise self.interaction
        return self.interaction


class GuidanceSpeechTests(unittest.TestCase):
    def set_client(self, client):
        genai_module.Client = lambda **_: client

    def test_generate_content_uses_sulafat_and_returns_wav(self):
        client = SpeechClient(generated=nested_audio(b"\x01\x02"))
        self.set_client(client)

        result = generate_guidance_speech("Stand tall.", "en-SG")

        self.assertEqual(wav_frames(result["audio"]), b"\x01\x02")
        self.assertEqual(result["provider"], "gemini_tts")
        self.assertEqual(len(client.generate_calls), 1)
        config = client.generate_calls[0]["config"]
        voice = (
            config.values["speech_config"]
            .values["voice_config"]
            .values["prebuilt_voice_config"]
            .values["voice_name"]
        )
        self.assertEqual(voice, "Sulafat")
        self.assertEqual(client.interaction_calls, [])

    def test_interactions_is_same_voice_fallback(self):
        output_audio = python_types.SimpleNamespace(
            data=base64.b64encode(b"\x03\x04").decode("ascii")
        )
        client = SpeechClient(
            generate_error=RuntimeError("first route unavailable"),
            interaction=python_types.SimpleNamespace(output_audio=output_audio),
        )
        self.set_client(client)

        result = generate_guidance_speech("Stand tall.", "en-SG")

        self.assertEqual(wav_frames(result["audio"]), b"\x03\x04")
        self.assertEqual(
            client.interaction_calls[0]["generation_config"]["speech_config"],
            [{"voice": "Sulafat"}],
        )

    def test_both_failed_routes_are_safely_unavailable(self):
        client = SpeechClient(
            generate_error=RuntimeError("first route unavailable"),
            interaction=RuntimeError("second route unavailable"),
        )
        self.set_client(client)

        with self.assertRaises(GuidanceSpeechUnavailable):
            generate_guidance_speech("Stand tall.", "en-SG")


if __name__ == "__main__":
    unittest.main()
