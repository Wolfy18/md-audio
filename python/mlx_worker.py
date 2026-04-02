#!/usr/bin/env python3

from __future__ import annotations

import contextlib
import importlib.util
import json
import os
import shutil
import sys
from dataclasses import dataclass
from typing import Any

import numpy as np
from mlx_audio.audio_io import write as audio_write
from mlx_audio.tts.utils import load_model


@dataclass
class WorkerState:
    model_name: str | None = None
    model: Any | None = None


STATE = WorkerState()


def send(message: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(message) + "\n")
    sys.stdout.flush()


def ensure_model(model_name: str):
    if STATE.model is not None and STATE.model_name == model_name:
        return STATE.model

    verify_kokoro_runtime(model_name)

    with contextlib.redirect_stdout(sys.stderr):
        STATE.model = load_model(model_name)
    STATE.model_name = model_name
    return STATE.model


def verify_kokoro_runtime(model_name: str) -> None:
    if "kokoro" not in model_name.lower():
        return

    required_modules = {
        "misaki": "pip install misaki",
        "num2words": "pip install num2words",
        "spacy": "pip install spacy",
        "phonemizer": "pip install phonemizer-fork",
        "espeakng_loader": "pip install espeakng-loader",
        "en_core_web_sm": "python -m spacy download en_core_web_sm",
    }

    for module_name, install_hint in required_modules.items():
        if importlib.util.find_spec(module_name) is None:
            raise RuntimeError(
                f"Kokoro is missing the Python dependency '{module_name}'. Install it with: {install_hint}"
            )

    from phonemizer.backend.espeak.wrapper import EspeakWrapper

    if not hasattr(EspeakWrapper, "set_data_path"):
        raise RuntimeError(
            "Kokoro needs the phonemizer-fork backend. Rebuild the managed environment or install it with: pip install phonemizer-fork"
        )

    if shutil.which("espeak-ng") is None and shutil.which("espeak") is None:
        raise RuntimeError(
            "Kokoro requires espeak-ng or espeak on this machine. Install it with Homebrew, for example: brew install espeak-ng"
        )


def synthesize(request: dict[str, Any]) -> str:
    model_name = str(request["model"])
    text = str(request["text"])
    voice = str(request["voice"])
    lang_code = str(request["lang_code"])
    speed = float(request["speed"])
    output_path = str(request["output_path"])

    model = ensure_model(model_name)
    os.makedirs(os.path.dirname(output_path), exist_ok=True)

    audio_chunks: list[np.ndarray] = []
    sample_rate: int | None = None

    with contextlib.redirect_stdout(sys.stderr):
        for result in model.generate(
            text,
            voice=voice,
            speed=speed,
            lang_code=lang_code,
            stream=False,
        ):
            audio_chunks.append(np.asarray(result.audio))
            if sample_rate is None:
                sample_rate = int(result.sample_rate)

    if not audio_chunks or sample_rate is None:
        raise RuntimeError("mlx-audio returned no speech samples")

    joined = np.concatenate(audio_chunks) if len(audio_chunks) > 1 else audio_chunks[0]
    audio_write(output_path, joined, sample_rate, format="wav")
    return output_path
def handle(request: dict[str, Any]) -> dict[str, Any]:
    request_id = str(request["id"])
    request_type = str(request["type"])

    if request_type == "ping":
        return {
            "id": request_id,
            "type": "pong",
        }

    if request_type == "ensure_model":
        ensure_model(str(request["model"]))
        return {
            "id": request_id,
            "type": "model_ready",
        }

    if request_type == "synthesize":
        output_path = synthesize(request)
        return {
            "id": request_id,
            "type": "synthesize_result",
            "output_path": output_path,
        }

    raise ValueError(f"unsupported request type: {request_type}")


def main() -> int:
    for raw_line in sys.stdin:
        line = raw_line.strip()
        if not line:
            continue

        try:
            request = json.loads(line)
            send(handle(request))
        except Exception as error:
            request_id = None
            try:
                parsed = json.loads(line)
                request_id = str(parsed.get("id", "unknown"))
            except Exception:
                request_id = "unknown"

            send(
                {
                    "id": request_id,
                    "type": "error",
                    "message": str(error),
                }
            )

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
