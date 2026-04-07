#!/usr/bin/env python3

from __future__ import annotations

import contextlib
import hashlib
import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np


@dataclass
class WorkerState:
    model_name: str | None = None
    model: Any | None = None
    espeak_runtime: EspeakRuntime | None = None


@dataclass(frozen=True)
class EspeakRuntime:
    library_path: str
    data_path: str


STATE = WorkerState()


def send(message: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(message) + "\n")
    sys.stdout.flush()


def ensure_model(model_name: str):
    if STATE.model is not None and STATE.model_name == model_name:
        apply_espeak_runtime(STATE.espeak_runtime)
        return STATE.model

    runtime = verify_kokoro_runtime(model_name)
    from mlx_audio.tts.utils import load_model

    apply_espeak_runtime(runtime)
    with contextlib.redirect_stdout(sys.stderr):
        STATE.model = load_model(model_name)
    STATE.model_name = model_name
    STATE.espeak_runtime = runtime
    apply_espeak_runtime(runtime)
    return STATE.model


def first_existing_path(candidates: list[Path], *, kind: str) -> str | None:
    seen: set[Path] = set()
    for candidate in candidates:
        resolved = candidate.expanduser().resolve()
        if resolved in seen:
            continue

        seen.add(resolved)
        if kind == "file" and resolved.is_file():
            return str(resolved)
        if kind == "dir" and resolved.is_dir():
            return str(resolved)

    return None


def parse_espeak_data_path(version_output: str) -> str | None:
    match = re.search(r"Data at:\s*(.+)", version_output)
    if not match:
        return None

    return match.group(1).strip()


def extension_root() -> Path:
    return Path(__file__).resolve().parent.parent


def bundled_espeak_root() -> Path:
    return extension_root() / "vendor" / "espeak-ng" / "darwin-arm64"


def stage_bundled_espeak_runtime(source_root: Path) -> EspeakRuntime | None:
    library_source = source_root / "lib" / "libespeak-ng.1.dylib"
    data_source = source_root / "share" / "espeak-ng-data"
    if not library_source.is_file() or not data_source.is_dir():
        return None

    runtime_key = hashlib.sha256(str(source_root.resolve()).encode("utf-8")).hexdigest()[:12]
    runtime_root = Path(tempfile.gettempdir()) / "md-audio-espeak" / runtime_key
    library_target = runtime_root / "libespeak-ng.1.dylib"
    data_target = runtime_root / "espeak-ng-data"
    ready_marker = runtime_root / ".ready"

    runtime_root.mkdir(parents=True, exist_ok=True)
    if not ready_marker.is_file():
        shutil.copy2(library_source, library_target)
        shutil.copytree(data_source, data_target, dirs_exist_ok=True)
        ready_marker.write_text("ready\n", encoding="utf-8")

    return EspeakRuntime(
        library_path=str(library_target),
        data_path=str(data_target),
    )


def resolve_macos_system_espeak_runtime() -> EspeakRuntime | None:
    executable_candidates: list[Path] = []
    for executable_name in ("espeak-ng", "espeak"):
        executable_path = shutil.which(executable_name)
        if executable_path:
            executable_candidates.append(Path(executable_path))

    prefix_candidates: list[Path] = []
    data_candidates: list[Path] = []

    def push_prefix(candidate: Path) -> None:
        if candidate not in prefix_candidates:
            prefix_candidates.append(candidate)

    def push_data(candidate: Path) -> None:
        if candidate not in data_candidates:
            data_candidates.append(candidate)

    for executable_path in executable_candidates:
        push_prefix(executable_path.parent.parent)
        with contextlib.suppress(OSError, subprocess.SubprocessError):
            push_prefix(executable_path.resolve().parent.parent)

        with contextlib.suppress(OSError, subprocess.SubprocessError):
            version_result = subprocess.run(
                [str(executable_path), "--version"],
                capture_output=True,
                text=True,
                check=False,
            )
            data_path = parse_espeak_data_path(
                "\n".join(part for part in (version_result.stdout, version_result.stderr) if part)
            )
            if data_path:
                push_data(Path(data_path))
                push_prefix(Path(data_path).parent.parent)

    brew_path = shutil.which("brew")
    if brew_path:
        with contextlib.suppress(OSError, subprocess.SubprocessError):
            brew_result = subprocess.run(
                [brew_path, "--prefix", "espeak-ng"],
                capture_output=True,
                text=True,
                check=False,
            )
            prefix = brew_result.stdout.strip()
            if prefix:
                push_prefix(Path(prefix))

    library_candidates: list[Path] = []
    for prefix in prefix_candidates:
        library_candidates.extend(
            [
                prefix / "lib" / "libespeak-ng.1.dylib",
                prefix / "lib" / "libespeak-ng.dylib",
            ]
        )
        push_data(prefix / "share" / "espeak-ng-data")

    library_path = first_existing_path(library_candidates, kind="file")
    data_path = first_existing_path(data_candidates, kind="dir")
    if not library_path or not data_path:
        return None

    return EspeakRuntime(library_path=library_path, data_path=data_path)


def resolve_espeak_runtime() -> EspeakRuntime:
    if sys.platform == "darwin":
        runtime = stage_bundled_espeak_runtime(bundled_espeak_root())
        if runtime is not None:
            return runtime

        runtime = resolve_macos_system_espeak_runtime()
        if runtime is not None:
            return runtime

    if shutil.which("espeak-ng") is None and shutil.which("espeak") is None:
        raise RuntimeError(
            "Kokoro requires espeak-ng or espeak on this machine. Install it with Homebrew, for example: brew install espeak-ng"
        )

    import espeakng_loader

    return EspeakRuntime(
        library_path=espeakng_loader.get_library_path(),
        data_path=espeakng_loader.get_data_path(),
    )


def apply_espeak_runtime(runtime: EspeakRuntime | None) -> None:
    if runtime is None:
        return

    from phonemizer.backend.espeak.wrapper import EspeakWrapper

    os.environ["PHONEMIZER_ESPEAK_LIBRARY"] = runtime.library_path
    os.environ["PHONEMIZER_ESPEAK_DATA_PATH"] = runtime.data_path
    EspeakWrapper.set_library(runtime.library_path)
    EspeakWrapper.set_data_path(runtime.data_path)


def verify_kokoro_runtime(model_name: str) -> EspeakRuntime | None:
    if "kokoro" not in model_name.lower():
        return None

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

    runtime = resolve_espeak_runtime()
    # misaki imports espeakng_loader at module load time and resets the wrapper.
    # Import it once here so our bundled runtime can win after that side effect.
    import misaki.espeak  # noqa: F401

    apply_espeak_runtime(runtime)
    return runtime


def synthesize(request: dict[str, Any]) -> str:
    model_name = str(request["model"])
    text = str(request["text"])
    voice = str(request["voice"])
    lang_code = str(request["lang_code"])
    speed = float(request["speed"])
    output_path = str(request["output_path"])

    model = ensure_model(model_name)
    from mlx_audio.audio_io import write as audio_write
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    apply_espeak_runtime(STATE.espeak_runtime)

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
