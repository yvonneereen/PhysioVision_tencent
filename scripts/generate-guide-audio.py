#!/usr/bin/env python3
"""Generate missing static movement-guide WAV files with one Gemini voice."""

import argparse
import base64
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import time
import wave


PROJECT_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_OUTPUT = PROJECT_ROOT / "assets" / "audio" / "movement-guide"


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--locale", default="en-SG")
    parser.add_argument("--limit", type=int, default=20)
    parser.add_argument(
        "--exercise",
        default="",
        help="Prioritize one exercise without removing any other catalogue entries",
    )
    parser.add_argument(
        "--pack",
        default="",
        help="Generate only the named prepared-audio pack",
    )
    parser.add_argument("--delay-seconds", type=float, default=65.0)
    parser.add_argument("--output-root", type=Path, default=DEFAULT_OUTPUT)
    return parser.parse_args()


def load_catalog(exercise="", pack=""):
    command = [
        "node",
        str(PROJECT_ROOT / "scripts" / "export-guide-audio-catalog.mjs"),
    ]
    if exercise:
        command.extend(["--exercise", exercise])
    if pack:
        command.extend(["--pack", pack])
    result = subprocess.run(
        command,
        cwd=PROJECT_ROOT,
        check=True,
        capture_output=True,
        text=True,
    )
    return json.loads(result.stdout)


def speech_hash(transcript, locale):
    normalized = " ".join(str(transcript).split())
    return hashlib.sha256(f"{locale}\n{normalized}".encode("utf-8")).hexdigest()


def pcm_to_wav(pcm_audio):
    output = io.BytesIO()
    with wave.open(output, "wb") as wav_file:
        wav_file.setnchannels(1)
        wav_file.setsampwidth(2)
        wav_file.setframerate(24000)
        wav_file.writeframes(pcm_audio)
    return output.getvalue()


def is_rate_limit_error(error):
    """Return True when another Gemini request would only spend more quota."""
    status_code = getattr(error, "status_code", None)
    if status_code is None:
        status_code = getattr(error, "code", None)
    if status_code == 429 or str(status_code) == "429":
        return True
    detail = str(error).lower()
    return any(marker in detail for marker in (
        "429",
        "resource_exhausted",
        "rate limit",
        "quota exceeded",
    ))


def generate_audio(client, transcript, *, locale, model, voice):
    language = {
        "en": "English",
        "zh": "Mandarin Chinese",
        "ms": "Malay",
        "ta": "Tamil",
    }.get(locale.split("-", 1)[0].lower(), "English")
    prompt = (
        f"Recite the transcript below exactly in {language}. "
        "Use a warm, clear, natural adult female voice. Speak conversationally "
        "at a moderate pace with steady, audible volume and gentle phrasing. "
        "Do not sound theatrical, elderly, breathy, raspy, robotic or monotone. "
        "Do not add, remove, paraphrase or explain any words.\n\n"
        f"Transcript: {transcript}"
    )
    from google.genai import types

    try:
        response = client.models.generate_content(
            model=model,
            contents=prompt,
            config=types.GenerateContentConfig(
                response_modalities=["AUDIO"],
                speech_config=types.SpeechConfig(
                    voice_config=types.VoiceConfig(
                        prebuilt_voice_config=types.PrebuiltVoiceConfig(
                            voice_name=voice,
                        ),
                    ),
                ),
            ),
        )
        pcm_audio = response.candidates[0].content.parts[0].inline_data.data
        if not pcm_audio:
            raise RuntimeError("GenerateContent returned no audio")
        if isinstance(pcm_audio, str):
            pcm_audio = base64.b64decode(pcm_audio, validate=True)
    except Exception as generate_content_error:
        # A second API route cannot bypass a project-level RPM/RPD limit. Do
        # not spend another request when the primary route is already telling
        # us to wait; keep every completed WAV and let a later run resume only
        # the files that are still absent.
        if is_rate_limit_error(generate_content_error):
            raise RuntimeError(
                "Gemini TTS rate limit reached; stopped without making a "
                "fallback request"
            ) from generate_content_error
        try:
            interaction = client.interactions.create(
                model=model,
                input=prompt,
                response_format={"type": "audio"},
                generation_config={"speech_config": [{"voice": voice}]},
            )
            encoded = getattr(
                getattr(interaction, "output_audio", None),
                "data",
                None,
            )
            if not encoded:
                raise RuntimeError("Interactions returned no audio")
            pcm_audio = base64.b64decode(encoded, validate=True)
        except Exception as interactions_error:
            raise RuntimeError(
                "Both Gemini speech routes failed: "
                f"GenerateContent={type(generate_content_error).__name__}; "
                f"Interactions={type(interactions_error).__name__}"
            ) from interactions_error
    return pcm_to_wav(bytes(pcm_audio))


def write_manifest(output_directory, phrases, locale, voice):
    entries = {}
    for transcript in phrases:
        digest = speech_hash(transcript, locale)
        filename = f"{digest}.wav"
        if (output_directory / filename).is_file():
            entries[digest] = filename
    manifest = {
        "version": 1,
        "locale": locale,
        "voice": voice,
        "entries": dict(sorted(entries.items())),
    }
    (output_directory / "manifest.json").write_text(
        json.dumps(manifest, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    return len(entries)


def main():
    args = parse_args()
    if args.limit < 1 or args.limit > 50:
        raise SystemExit("--limit must be between 1 and 50")
    api_key = os.environ.get("GEMINI_API_KEY", "").strip()
    if not api_key:
        raise SystemExit("GEMINI_API_KEY is required")

    from google import genai

    model = os.environ.get("GEMINI_TTS_MODEL", "gemini-3.1-flash-tts-preview")
    voice = os.environ.get("GEMINI_TTS_VOICE", "Sulafat")
    catalog = load_catalog(args.exercise.strip(), args.pack.strip())
    phrases = catalog["phrases"]
    all_phrases = catalog.get("all_phrases", phrases)
    output_directory = args.output_root / args.locale
    output_directory.mkdir(parents=True, exist_ok=True)
    missing = [
        phrase for phrase in phrases
        if not (output_directory / f"{speech_hash(phrase, args.locale)}.wav").is_file()
    ]
    selected = missing[: args.limit]
    client = genai.Client(api_key=api_key)
    generated = 0

    for index, transcript in enumerate(selected):
        digest = speech_hash(transcript, args.locale)
        try:
            wav_audio = generate_audio(
                client,
                transcript,
                locale=args.locale,
                model=model,
                voice=voice,
            )
        except Exception as exc:
            print(
                f"Stopped after {generated} clip(s): "
                f"{type(exc).__name__}: {exc}. "
                "Completed clips will still be saved."
            )
            break
        (output_directory / f"{digest}.wav").write_bytes(wav_audio)
        generated += 1
        print(f"Generated clip {generated} of {len(selected)}")
        if index < len(selected) - 1 and args.delay_seconds > 0:
            time.sleep(args.delay_seconds)

    available = write_manifest(
        output_directory,
        all_phrases,
        args.locale,
        voice,
    )
    print(
        f"Manifest contains {available} of {len(all_phrases)} prepared clips; "
        f"{len(all_phrases) - available} remain."
    )
    if generated == 0 and selected:
        raise SystemExit(
            "No Gemini audio was generated; refusing to report a successful run."
        )


if __name__ == "__main__":
    main()
