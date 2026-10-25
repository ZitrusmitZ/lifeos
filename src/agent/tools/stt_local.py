"""Lokale Spracherkennung (faster-whisper) als Rückfall, wenn FreeLLM keinen STT-Anbieter hat.

Aufruf: python stt_local.py <audiodatei> <sprache> <modell> <modellordner>
Gibt den erkannten Text auf stdout aus. ffmpeg dekodiert selbst (PyAV in faster-whisper 1.2.1 passt nicht zu jedem av).
"""

import subprocess
import sys

import numpy as np
from faster_whisper import WhisperModel


def main() -> None:
    audio_path, lang, model, root = sys.argv[1:5]
    pcm = subprocess.run(
        ["ffmpeg", "-loglevel", "error", "-i", audio_path, "-f", "s16le", "-ac", "1", "-ar", "16000", "-"],
        check=True,
        capture_output=True,
    ).stdout
    audio = np.frombuffer(pcm, np.int16).astype(np.float32) / 32768.0
    # erst nur lokal (install_agent.sh lädt vor) – kein Netz pro Sprachnachricht; fehlt das Modell, einmal laden
    try:
        whisper = WhisperModel(model, device="cpu", compute_type="int8", cpu_threads=4, download_root=root, local_files_only=True)
    except Exception:
        whisper = WhisperModel(model, device="cpu", compute_type="int8", cpu_threads=4, download_root=root)
    segments, _ = whisper.transcribe(audio, language=lang, beam_size=1, vad_filter=True)
    print(" ".join(s.text.strip() for s in segments).strip())


if __name__ == "__main__":
    main()
