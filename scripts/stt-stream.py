#!/usr/bin/env python3
"""Streaming speech-to-text for SwarmEye dictation (Whisper / faster-whisper).

Reads base64-encoded chunks of 16 kHz 16-bit mono PCM, one per line, on
stdin; writes JSON lines on stdout: {"ready":true} once the model is
loaded, {"partial":"..."} for interim text, {"text":"..."} for each final
phrase. EOF on stdin flushes the last phrase and exits.

Whisper is not a word-streaming recognizer, so a reader thread buffers the
incoming PCM while the main loop segments it by trailing silence: each
voiced utterance is re-transcribed periodically for partials and finalized
(one {"text"} line) when the speaker pauses. Language is auto-detected per
utterance, so mixed German/English dictation just works.
Usage: stt-stream.py <model-dir> <sample-rate>
"""
import base64
import json
import sys
import threading
import time

import numpy as np
from faster_whisper import WhisperModel

SILENCE_RMS = 300      # int16 RMS below this counts as silence (~1% of full
                       # scale; the renderer already applies noiseSuppression)
SILENCE_SEC = 0.7      # trailing silence that finalizes an utterance
PARTIAL_SEC = 1.0      # min new audio before re-transcribing for a partial
MAX_UTTER_SEC = 25.0   # force-finalize before Whisper's 30 s window


def emit(obj):
    print(json.dumps(obj), flush=True)


def rms(pcm):
    return float(np.sqrt(np.mean(pcm.astype(np.float32) ** 2))) if len(pcm) else 0.0


def transcribe(model, pcm):
    audio = pcm.astype(np.float32) / 32768.0
    segments, _ = model.transcribe(
        audio, beam_size=1, vad_filter=True,
        condition_on_previous_text=False, without_timestamps=True)
    return " ".join(s.text.strip() for s in segments).strip()


def main():
    model_dir, rate = sys.argv[1], int(sys.argv[2])
    model = WhisperModel(model_dir, device="cpu", compute_type="int8")
    emit({"ready": True})

    inbox, lock, eof = bytearray(), threading.Lock(), threading.Event()

    def reader():
        for line in sys.stdin:
            line = line.strip()
            if line:
                data = base64.b64decode(line)
                with lock:
                    inbox.extend(data)
        eof.set()

    threading.Thread(target=reader, daemon=True).start()

    buf = np.zeros(0, np.int16)
    voiced, last_partial, partial_at = False, "", 0
    n_sil = int(SILENCE_SEC * rate)
    while True:
        with lock:
            chunk, inbox[:] = bytes(inbox), b""
        if chunk:
            new = np.frombuffer(chunk, np.int16)
            buf = np.concatenate([buf, new])
            if not voiced and rms(new) >= SILENCE_RMS:
                voiced = True
        done = eof.is_set() and not chunk
        if not voiced:
            buf = buf[-n_sil:]  # don't accumulate pre-speech silence
            if done:
                break
            time.sleep(0.05)
            continue
        tail_quiet = len(buf) >= n_sil and rms(buf[-n_sil:]) < SILENCE_RMS
        if done or tail_quiet or len(buf) >= MAX_UTTER_SEC * rate:
            text = transcribe(model, buf)
            if text:
                emit({"text": text})
            buf = np.zeros(0, np.int16)
            voiced, last_partial, partial_at = False, "", 0
            if done:
                break
        elif len(buf) - partial_at >= PARTIAL_SEC * rate:
            partial_at = len(buf)
            text = transcribe(model, buf)
            if text and text != last_partial:
                emit({"partial": text})
                last_partial = text
        else:
            time.sleep(0.05)


if __name__ == "__main__":
    main()
