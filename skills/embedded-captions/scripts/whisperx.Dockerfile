# whisperx.Dockerfile — a self-contained WhisperX runner for boxes whose SYSTEM
# ffmpeg is too new for whisperx's pinned torchcodec.
#
# Why this exists
# ---------------
# whisperx 3.8.6 pins `torch ~=2.8` and `torchcodec >=0.6,<0.8`. That torchcodec
# supports FFmpeg majors 4–7 (libavutil.so.56–59). A host on FFmpeg 8
# (libavutil.so.60) — e.g. the bmax box — makes torchcodec fail to load its
# decoder, so whisperx dies and transcribe.cjs falls back to whisper.cpp.
#
# Debian bookworm (this base image) ships FFmpeg 5.1 → libavutil.so.57, which is
# inside torchcodec's supported range. So the container carries its OWN
# torchcodec-compatible ffmpeg; the host's ffmpeg 8 is never touched. The host
# still does the pre-decode to WAV in transcribe.cjs — any ffmpeg reads that.
#
# Models are BAKED at build time (see the warm-up RUN): build this image on a box
# with IPv4 / HF reachability (the bmax box's IPv6-blackholed HF CDN is the OTHER
# blocker on this ticket), then the image transcribes fully offline afterwards.
#
# Build (from this scripts/ dir):
#   docker build -f whisperx.Dockerfile -t hyperframes/whisperx:3.8.6 .
#   # add languages / change model:
#   docker build -f whisperx.Dockerfile \
#     --build-arg WHISPER_MODEL=small --build-arg ALIGN_LANGS=en,th \
#     -t hyperframes/whisperx:3.8.6 .
#
# Use (transcribe.cjs picks it up automatically):
#   TRANSCRIBE_WHISPERX_DOCKER=hyperframes/whisperx:3.8.6 \
#     node transcribe.cjs <project-dir>
FROM python:3.12-bookworm

# torchcodec-compatible ffmpeg (bookworm = 5.1.x, libavutil.so.57).
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*

# Model + torch-hub + nltk caches live under /opt so the baked weights ship in the
# image. NLTK_DATA must point at a writable, baked dir: whisperx's aligner calls
# nltk.download('punkt_tab') at runtime, and the container runs as a non-root
# --user (see transcribe.cjs), which cannot create nltk's default /nltk_data.
ENV HF_HOME=/opt/hf \
    TORCH_HOME=/opt/torch \
    NLTK_DATA=/opt/nltk_data \
    HF_HUB_DOWNLOAD_TIMEOUT=60

ARG WHISPERX_VERSION=3.8.6
# CPU-only torch/torchcodec wheels (extra-index) keep the image lean; whisperx +
# the rest resolve from PyPI. --extra-index-url (not --index-url) so PyPI is still
# consulted for non-torch deps.
RUN pip install --no-cache-dir \
      --extra-index-url https://download.pytorch.org/whl/cpu \
      "whisperx==${WHISPERX_VERSION}"

# ── Bake weights ────────────────────────────────────────────────────────────
# Warm the caches so the exact faster-whisper CT2 model + wav2vec2 align model(s)
# ship in the image. Needs network AT BUILD TIME. load_model / load_align_model
# are hard (fail the build if the weights can't be fetched — an image without
# them is pointless); the silence transcribe is best-effort.
ARG WHISPER_MODEL=small
ARG ALIGN_LANGS=en
RUN WHISPER_MODEL="${WHISPER_MODEL}" ALIGN_LANGS="${ALIGN_LANGS}" python - <<'PY'
import os, subprocess, nltk, whisperx

model = os.environ.get("WHISPER_MODEL", "small")
langs = [l.strip() for l in os.environ.get("ALIGN_LANGS", "en").split(",") if l.strip()]

# nltk punkt_tab — whisperx's aligner splits segments into sentences with it (hard)
nltk.download("punkt_tab", download_dir=os.environ["NLTK_DATA"])
print("[bake] cached nltk: punkt_tab")

# faster-whisper CT2 weights (hard — build fails if unfetchable)
asr = whisperx.load_model(model, "cpu", compute_type="int8")
print(f"[bake] cached whisper model: {model}")

# wav2vec2 forced-alignment weights, per language (hard)
for lang in langs:
    whisperx.load_align_model(language_code=lang, device="cpu")
    print(f"[bake] cached align model: {lang}")

# exercise the decode+transcribe path on 2s of silence (best-effort — this is
# what confirms torchcodec can load ffmpeg inside the image)
try:
    subprocess.run(
        ["ffmpeg", "-f", "lavfi", "-i", "anullsrc=r=16000:cl=mono",
         "-t", "2", "/tmp/_silent.wav", "-y"],
        check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    asr.transcribe(whisperx.load_audio("/tmp/_silent.wav"), batch_size=1)
    print("[bake] decode+transcribe smoke test OK")
except Exception as e:  # noqa: BLE001 — non-fatal, models are already cached
    print(f"[bake] WARN smoke test skipped: {e}")
PY

# Let any uid (transcribe.cjs runs the container as the host user via --user) read
# the baked caches and write HF/nltk lock files.
RUN chmod -R a+rwX /opt/hf /opt/torch /opt/nltk_data

WORKDIR /work
ENTRYPOINT ["whisperx"]
