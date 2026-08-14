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
    parser.add_argument("--delay-seconds", type=float, default=21.0)
    parser.add_argument("--output-root", type=Path, default=DEFAULT_OUTPUT)
    return parser.parse_args()


def load_catalog(exercise=""):
    command = [
        "node",
        str(PROJECT_ROOT / "scripts" / "export-guide-audio-catalog.mjs"),
    ]
    if exercise:
        command.extend(["--exercise", exercise])
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
    interaction = client.interactions.create(
        model=model,
        input=prompt,
        response_format={"type": "audio"},
        generation_config={"speech_config": [{"voice": voice}]},
    )
    encoded = getattr(getattr(interaction, "output_audio", None), "data", None)
    if not encoded:
        raise RuntimeError("Gemini returned no audio")
    return pcm_to_wav(base64.b64decode(encoded, validate=True))


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
    catalog = load_catalog(args.exercise.strip())
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
                f"Stopped after {generated} clip(s): {type(exc).__name__}. "
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


if __name__ == "__main__":
    main()
