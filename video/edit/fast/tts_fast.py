#!/usr/bin/env python3
"""Generate fast voiceover lines with MiniMax t2a_v2.
usage: tts_fast.py LANG [SHOT ...] [--voice ID] [--speed S] [--out DIR] [--force]
Writes ai/vo_fast_<lang>/shotNN.mp3 and durations.json (silence trimmed WAV next to it)."""
import os, sys, json, subprocess, argparse, requests
from pathlib import Path

ROOT = Path("/home/claude/vid2")
ap = argparse.ArgumentParser()
ap.add_argument("lang", choices=["en", "zh"])
ap.add_argument("shots", nargs="*", type=int)
ap.add_argument("--voice")
ap.add_argument("--speed", type=float)
ap.add_argument("--out")
ap.add_argument("--force", action="store_true")
a = ap.parse_args()
VOICE = a.voice or {"en": "English_Trustworth_Man", "zh": "male-qn-jingying"}[a.lang]
SPEED = a.speed or {"en": 1.18, "zh": 1.15}[a.lang]
BOOST = {"en": "English", "zh": "Chinese"}[a.lang]
OUT = Path(a.out) if a.out else ROOT / f"ai/vo_fast_{a.lang}"
OUT.mkdir(parents=True, exist_ok=True)
KEY = os.environ["MINIMAX_API_KEY"]
H = {"Authorization": f"Bearer {KEY}", "Content-Type": "application/json"}
lines = json.load(open(ROOT / "lines_fast.json"))


def tts(text, path):
    r = requests.post("https://api.minimaxi.com/v1/t2a_v2", headers=H, json={
        "model": "speech-2.8-hd", "text": text, "stream": False, "language_boost": BOOST,
        "voice_setting": {"voice_id": VOICE, "speed": SPEED, "vol": 1, "pitch": 0},
        "audio_setting": {"sample_rate": 44100, "bitrate": 128000, "format": "mp3", "channel": 1}}, timeout=180)
    j = r.json()
    if (j.get("base_resp") or {}).get("status_code") != 0:
        print("TTS ERR", j.get("base_resp")); return False
    path.write_bytes(bytes.fromhex(j["data"]["audio"])); return True


def trimmed(mp3, wav):
    """Trim leading and trailing silence, keep 40 ms, 48 kHz mono wav."""
    f = ("silenceremove=start_periods=1:start_threshold=-48dB:start_silence=0.04,"
         "areverse,silenceremove=start_periods=1:start_threshold=-48dB:start_silence=0.06,areverse")
    subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", str(mp3), "-af", f, "-ar", "48000", "-ac", "1", str(wav)], check=True)
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(wav)],
                         capture_output=True, text=True).stdout
    return float(out)


dfile = OUT / "durations.json"
durs = json.load(open(dfile)) if dfile.exists() else {}
todo = a.shots or [int(k) for k in lines]
for n in todo:
    mp3, wav = OUT / f"shot{n:02d}.mp3", OUT / f"shot{n:02d}.wav"
    if a.force or not mp3.exists():
        ok = tts(lines[str(n)][a.lang], mp3)
        if not ok:
            sys.exit(1)
    durs[str(n)] = round(trimmed(mp3, wav), 3)
    print(n, durs[str(n)], VOICE, SPEED)
meta = {"voice": VOICE, "speed": SPEED, "model": "speech-2.8-hd", "language_boost": BOOST}
json.dump(durs, open(dfile, "w"), indent=1)
json.dump(meta, open(OUT / "meta.json", "w"), indent=1)
