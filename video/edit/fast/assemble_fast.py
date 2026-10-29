#!/usr/bin/env python3
"""Fast cut of the demo video, driven by the voiceover.

usage: assemble_fast.py --lang en|zh [--no-3x4]

Inputs: vo.json (shot list, sources, animatic ranges), lines_fast.json (en + zh lines),
ai/vo_fast_<lang>/ (silence trimmed wav lines + durations.json, made by tts_fast.py),
music_fast.py (FluidSynth bed rendered to the exact cut length).

Timing: every shot lasts lead + voiceover + tail + crossfade, so consecutive lines are
separated by only lead + tail (about 0.5 s). Title is 3 s, the end card holds 3 s after
its line. Visuals that are too long are sped up (GFX up to 1.6x, screens up to 1.4x) and
then trimmed from the end (the animatic animations are front loaded); film footage is
trimmed at normal speed. Visuals that are too short are slowed (down to 1/1.5) and held.

Audio: voiceover stem at -16 LUFS, music bed ducked under it with sidechaincompress,
raised on the title and end card, then gain to -14 LUFS and a limiter (true peak under -1.5 dBTP after AAC).
Captions are split into short chunks and snapped to the pauses in each voiceover line.
"""
import argparse, json, re, subprocess, sys
from pathlib import Path

ap = argparse.ArgumentParser()
ap.add_argument("--lang", choices=["en", "zh"], default="en")
ap.add_argument("--no-3x4", action="store_true")
args = ap.parse_args()
LANG = args.lang

ROOT = Path("/home/claude/vid2")
ANIMATIC = Path("/home/claude/video/animatic.mp4")
OUT = ROOT / "out"
WORK = OUT / f"fast_{LANG}"
SEG = WORK / "seg"
SEG.mkdir(parents=True, exist_ok=True)
VO_DIR = ROOT / f"ai/vo_fast_{LANG}"
W, H, FPS = 1920, 1080, 30
XF, LEAD, TAIL = 0.3, 0.2, 0.3
TITLE_DUR, END_HOLD = 3.0, 3.0
GFX_SKIP = 0.35  # animatic segments open with the tail of the previous crossfade
MAXSPEED = {"GFX": 1.6, "SCREEN": 1.4, "FILM": 1.15, "TITLE": 1.6}
FINAL = OUT / ("hhil-demo-fast.mp4" if LANG == "en" else "hhil-demo-zh.mp4")
FINAL34 = OUT / "hhil-demo-zh-3x4.mp4"

INTER_BLACK = "/usr/share/fonts/opentype/inter/Inter-Black.otf"
INTER_MED = "/usr/share/fonts/opentype/inter/Inter-Medium.otf"
CJK_MED = "/usr/share/fonts/opentype/noto/NotoSansCJK-Medium.ttc"
TAGLINE_ZH = "筛选人群，让每一次打招呼都更有价值"

shots = json.load(open(ROOT / "vo.json"))
lines = json.load(open(ROOT / "lines_fast.json"))
vo_dur = {int(k): float(v) for k, v in json.load(open(VO_DIR / "durations.json")).items()}


def run(cmd, quiet=True):
    r = subprocess.run([str(c) for c in cmd], capture_output=True, text=True)
    if r.returncode != 0:
        print(" ".join(map(str, cmd))[:3000]); print(r.stderr[-3000:]); sys.exit(1)
    return r.stdout + r.stderr


def probe_dur(p):
    return float(run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", p]).split()[0])


def find(folder, n, names):
    for name in names:
        p = ROOT / folder / name.format(n=n)
        if p.exists() and p.stat().st_size > 10000:
            return p
    return None


NORM = f"scale={W}:{H}:force_original_aspect_ratio=increase,crop={W}:{H},fps={FPS},format=yuv420p,setsar=1"


def fit(src, start, avail, dur, out, maxspeed, from_end=False, extra_vf=""):
    """Make exactly `dur` seconds from src[start : start+avail].
    Too long: speed up to maxspeed, then trim (from the end, or from the start if from_end).
    Too short: slow down to 1/1.5 and hold the last frame."""
    speed = avail / dur
    if speed > maxspeed:
        use = dur * maxspeed
        if from_end:
            start += avail - use
        avail, speed = use, maxspeed
    speed = max(speed, 1 / 1.5)
    hold = max(0.0, dur - avail / speed)
    vf = f"{NORM},setpts=PTS/{speed:.4f}-STARTPTS/{speed:.4f}"
    if hold > 0.01:
        vf += f",tpad=stop_mode=clone:stop_duration={hold + 0.1:.3f}"
    if extra_vf:
        vf += "," + extra_vf
    run(["ffmpeg", "-y", "-v", "error", "-ss", f"{start:.3f}", "-t", f"{avail:.3f}", "-i", src,
         "-vf", vf, "-t", f"{dur:.3f}", "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "17", out])
    return speed


def join_two(a, b, out):
    run(["ffmpeg", "-y", "-v", "error", "-i", a, "-i", b, "-filter_complex",
         f"[0:v][1:v]xfade=transition=fade:duration=0.4:offset={probe_dur(a) - 0.4:.3f},format=yuv420p[v]",
         "-map", "[v]", "-c:v", "libx264", "-preset", "veryfast", "-crf", "17", out])


def esc(s):
    return s.replace("\\", "\\\\").replace(":", "\\:").replace("'", "\u2019").replace(",", "\\,")


# ---------- 1. shot plan and visuals ----------
segments, timeline, t = [], [], 0.0
for i, s in enumerate(shots):
    n = s["shot"]; a0, a1 = s["animatic"]; src = s["source"]
    vd = vo_dur.get(n, 0.0)
    last = i == len(shots) - 1
    if src == "TITLE":
        dur = TITLE_DUR
    elif last:
        dur = LEAD + vd + END_HOLD
    else:
        dur = LEAD + vd + TAIL + XF
    out = SEG / f"shot{n:02d}.mp4"
    film = find("ai/1080p", n, ["shot{n:02d}c.mp4", "shot{n:02d}b.mp4", "shot{n:02d}.mp4"])
    screen = find("screens", n, ["shot{n:02d}.mp4", "shot{n:02d}_screen.mp4"])
    used, note = "animatic", ""
    if src == "TITLE":
        title = find("screens", n, ["shot{n:02d}_phones.mp4"])
        y_title, y_tag = (96, 212) if LANG == "en" else (64, 176)
        draw = (f"drawtext=fontfile={INTER_BLACK}:text='Human Human Interaction Lab':fontsize=92:fontcolor=0x1d1b19:"
                f"x=(w-text_w)/2:y={y_title}:alpha='min(1,max(0,(t-0.1)/0.45))',"
                f"drawtext=fontfile={INTER_MED}:text='Filtering the crowd so every hello counts':fontsize=40:"
                f"fontcolor=0x5a554f:x=(w-text_w)/2:y={y_tag}:alpha='min(1,max(0,(t-0.45)/0.45))'")
        if LANG == "zh":
            draw += (f",drawtext=fontfile={CJK_MED}:text='{esc(TAGLINE_ZH)}':fontsize=44:fontcolor=0x1d1b19:"
                     f"x=(w-text_w)/2:y=232:alpha='min(1,max(0,(t-0.7)/0.45))'")
        sp = fit(title, 0, probe_dur(title), dur, out, MAXSPEED["TITLE"], from_end=True, extra_vf=draw)
        used = f"{title.name} + title"; note = f"x{sp:.2f}"
    elif src == "FILM" and film:
        sp = fit(film, 0, probe_dur(film), dur, out, MAXSPEED["FILM"]); used = film.name; note = f"x{sp:.2f}"
    elif src == "SCREEN" and screen:
        length = min(probe_dur(screen), 6.6) if n == 8 else probe_dur(screen)
        sp = fit(screen, 0, length, dur, out, MAXSPEED["SCREEN"]); used = screen.name; note = f"x{sp:.2f}"
    elif src == "FILM+SCREEN" and film and screen:
        half = dur / 2 + 0.2
        q0, q1 = SEG / f"shot{n:02d}_0.mp4", SEG / f"shot{n:02d}_1.mp4"
        # shot 12: the handshake happens late in the clip, so keep the end
        s0 = fit(film, 0, probe_dur(film), half, q0, MAXSPEED["FILM"], from_end=(n == 12))
        s1 = fit(screen, 0, probe_dur(screen), half, q1, MAXSPEED["SCREEN"])
        join_two(q0, q1, out); used = f"{film.name}+{screen.name}"; note = f"x{s0:.2f}/x{s1:.2f}"
    else:
        sp = fit(ANIMATIC, a0 + GFX_SKIP, (a1 - a0) - GFX_SKIP, dur, out, MAXSPEED["GFX"])
        note = f"x{sp:.2f}"
    d = probe_dur(out)
    segments.append((n, out, d))
    timeline.append({"shot": n, "start": round(t, 3), "dur": round(d, 3), "visual": used, "speed": note,
                     "vo": vd, "vo_start": round(t + LEAD, 3) if vd else None})
    print(f"shot {n:2d}  {d:5.2f}s  vo {vd:5.2f}  {used} {note}")
    t += d - XF
TOTAL = t + XF
print(f"total {TOTAL:.2f}s")

# ---------- 2. video crossfade chain ----------
inputs, filt, lastlab, off = [], [], "0:v", 0.0
for _, p, _ in segments:
    inputs += ["-i", p]
for i in range(1, len(segments)):
    off += segments[i - 1][2] - XF
    filt.append(f"[{lastlab}][{i}:v]xfade=transition=fade:duration={XF}:offset={off:.3f}[v{i}]")
    lastlab = f"v{i}"
VIDEO = WORK / "video_only.mp4"
run(["ffmpeg", "-y", "-v", "error", *inputs, "-filter_complex", ";".join(filt), "-map", f"[{lastlab}]",
     "-c:v", "libx264", "-preset", "veryfast", "-crf", "17", "-pix_fmt", "yuv420p", VIDEO])

# ---------- 3. captions, chunked and snapped to pauses ----------
MAXC = 64 if LANG == "en" else 22


def pauses(wav):
    """Midpoints of internal pauses in a voiceover line (seconds)."""
    txt = run(["ffmpeg", "-v", "info", "-i", wav, "-af", "silencedetect=noise=-38dB:d=0.09", "-f", "null", "-"])
    st = [float(x) for x in re.findall(r"silence_start: ([\d.]+)", txt)]
    en = [float(x) for x in re.findall(r"silence_end: ([\d.]+)", txt)]
    return [(a + b) / 2 for a, b in zip(st, en)]


def chunks(text):
    if LANG == "en":
        parts = re.findall(r"[^,.?!]+[,.?!]?", text)
    else:
        parts = re.findall(r"[^，。？！、]+[，。？！、]?", text)
    parts = [p.strip() for p in parts if p.strip()]
    out, cur = [], ""
    for p in parts:
        sep = " " if (LANG == "en" and cur) else ""
        if cur and len(cur) + len(sep) + len(p) > MAXC:
            out.append(cur); cur = p
        else:
            cur = cur + sep + p
    if cur:
        out.append(cur)
    # avoid a tiny orphan at the end
    if len(out) > 1 and len(out[-1]) < MAXC * 0.25 and len(out[-2]) + len(out[-1]) <= MAXC * 1.25:
        out[-2] = out[-2] + (" " if LANG == "en" else "") + out[-1]; out.pop()
    return out


def disp(c):
    if LANG == "zh":
        c = re.sub(r"[，。、]$", "", c)
        c = c.replace("，", "  ").replace("。", "  ")
    return c


cues = []
for s, tl in zip(shots, timeline):
    if not tl["vo"]:
        continue
    text = lines[str(s["shot"])][LANG]
    cs = chunks(text)
    vd = tl["vo"]; v0 = tl["vo_start"]
    ps = pauses(VO_DIR / f"shot{s['shot']:02d}.wav")
    total_c = sum(len(c) for c in cs)
    bounds, acc = [0.0], 0
    for c in cs[:-1]:
        acc += len(c)
        guess = vd * acc / total_c
        near = [p for p in ps if abs(p - guess) < 0.9 and p > bounds[-1] + 0.4]
        bounds.append(min(near, key=lambda p: abs(p - guess)) if near else guess)
    bounds.append(vd)
    for k, c in enumerate(cs):
        a = v0 + bounds[k] - 0.05
        b = v0 + bounds[k + 1] + (0.25 if k == len(cs) - 1 else -0.05)
        cues.append((a, b, disp(c)))
# close tiny gaps between consecutive cues so captions do not flicker
for i in range(len(cues) - 1):
    if 0 < cues[i + 1][0] - cues[i][1] < 0.6:
        cues[i] = (cues[i][0], cues[i + 1][0] - 0.02, cues[i][2])


def ass_t(x):
    x = max(0, x)
    return f"{int(x // 3600)}:{int(x % 3600 // 60):02d}:{x % 60:05.2f}"


def write_ass(path, resx, resy, font, size, marginv, wrap=True):
    hdr = f"""[Script Info]
ScriptType: v4.00+
PlayResX: {resx}
PlayResY: {resy}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Cap,{font},{size},&H00FFFFFF,&H00FFFFFF,&H78201C19,&H78201C19,0,0,0,0,100,100,0,0,3,{max(8, size // 4)},0,2,90,90,{marginv},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
    ev = [f"Dialogue: 0,{ass_t(a)},{ass_t(b)},Cap,,0,0,0,,{c}" for a, b, c in cues]
    Path(path).write_text(hdr + "\n".join(ev) + "\n", encoding="utf-8")


capfont = "Inter SemiBold" if LANG == "en" else "Noto Sans CJK SC Medium"
ASS = WORK / "captions.ass"
write_ass(ASS, W, H, capfont, 48 if LANG == "en" else 52, 46)
srt = []
for i, (a, b, c) in enumerate(cues, 1):
    f = lambda x: f"{int(x // 3600):02d}:{int(x % 3600 // 60):02d}:{x % 60:06.3f}".replace(".", ",")
    srt.append(f"{i}\n{f(a)} --> {f(b)}\n{c}\n")
(WORK / "captions.srt").write_text("\n".join(srt), encoding="utf-8")

# ---------- 4. audio ----------
def lufs(path):
    txt = run(["ffmpeg", "-v", "info", "-i", path, "-af", "ebur128=peak=true", "-f", "null", "-"])
    tail = txt[txt.rfind("Summary:"):]
    return float(re.search(r"I:\s+(-?[\d.]+) LUFS", tail).group(1))


# voiceover stem
ain, parts, labs = [], [], []
k = 0
for s, tl in zip(shots, timeline):
    if tl["vo"]:
        ain += ["-i", VO_DIR / f"shot{s['shot']:02d}.wav"]
        ms = int(round(tl["vo_start"] * 1000))
        parts.append(f"[{k}:a]aresample=48000,adelay={ms}|{ms}[a{k}]"); labs.append(f"[a{k}]"); k += 1
parts.append(f"{''.join(labs)}amix=inputs={k}:normalize=0,apad,atrim=0:{TOTAL:.3f},"
             f"highpass=f=70,acompressor=threshold=0.18:ratio=2.5:attack=8:release=120[vo]")
VO_RAW = WORK / "vo_raw.wav"
run(["ffmpeg", "-y", "-v", "error", *ain, "-filter_complex", ";".join(parts), "-map", "[vo]", "-ac", "1", VO_RAW])
VO = WORK / "vo.wav"
g = -16.0 - lufs(VO_RAW)
run(["ffmpeg", "-y", "-v", "error", "-i", VO_RAW, "-af", f"volume={g:.2f}dB", "-ac", "2", VO])

# music bed, rendered to the cut length; end card starts at the last shot
end_start = timeline[-1]["start"]
MUSIC_RAW = WORK / "music.wav"
run([sys.executable, ROOT / "music_fast.py", MUSIC_RAW, f"{TOTAL:.3f}", f"{end_start:.3f}"])
m_l = lufs(MUSIC_RAW)
T1 = TITLE_DUR - XF  # title ends
T2 = end_start + LEAD + vo_dur[shots[-1]["shot"]]  # end card line finished
lift = 1.8  # about +5 dB on title and end card
env = (f"1+{lift - 1}*(clip(({T1:.2f}+0.3-t)/0.6,0,1)+clip((t-{T2:.2f})/0.8,0,1))")


def mix(music_gain_db, out, music_only=None):
    fc = (f"[1:a]volume={music_gain_db:.2f}dB,volume='{env}':eval=frame[mu];"
          f"[0:a]asplit=2[vk][vm];"
          f"[mu][vk]sidechaincompress=threshold=0.02:ratio=4:attack=25:release=400:knee=4[md];")
    if music_only:
        fc += "[md]anull[o];[vm]anullsink"
    else:
        fc += "[vm][md]amix=inputs=2:normalize=0[o]"
    run(["ffmpeg", "-y", "-v", "error", "-i", VO, "-i", MUSIC_RAW, "-filter_complex", fc, "-map", "[o]",
         "-ar", "48000", "-ac", "2", out])


# pick the music gain so the ducked bed lands near -21 LUFS after the final -14 normalisation
MIX = WORK / "mix.wav"; MONLY = WORK / "music_ducked.wav"
mg = -19.0 - m_l
for _ in range(3):
    mix(mg, MIX); mix(mg, MONLY, music_only=True)
    shift = -14.0 - lufs(MIX)
    bed = lufs(MONLY) + shift
    print(f"music gain {mg:.1f} dB -> bed {bed:.1f} LUFS in final")
    if abs(bed + 21.0) < 0.5:
        break
    mg += -21.0 - bed

# loudness: gain to -14 LUFS, then a limiter with headroom so the AAC encode stays under -1.5 dBTP
AUDIO = WORK / "audio.wav"
gain = -14.0 - lufs(MIX)
for _ in range(3):
    AF = (f"volume={gain:.2f}dB,alimiter=limit=0.75:level=false:attack=4:release=60,"
          f"afade=t=in:d=0.2,afade=t=out:st={TOTAL - 1.5:.3f}:d=1.5")
    run(["ffmpeg", "-y", "-v", "error", "-i", MIX, "-af", AF, "-ar", "48000", AUDIO])
    got = lufs(AUDIO)
    print(f"final loudness {got:.2f} LUFS")
    if abs(got + 14.0) < 0.15:
        break
    gain += -14.0 - got

# ---------- 5. final encodes ----------
run(["ffmpeg", "-y", "-v", "error", "-i", VIDEO, "-i", AUDIO,
     "-vf", f"subtitles={ASS}:fontsdir=/usr/share/fonts/opentype",
     "-c:v", "libx264", "-preset", "veryfast", "-crf", "19", "-pix_fmt", "yuv420p", "-r", str(FPS),
     "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-shortest", "-movflags", "+faststart", FINAL])
print("done", FINAL, f"{probe_dur(FINAL):.2f}s")

if LANG == "zh" and not args.no_3x4:
    # 1080x1440: cream ground, header text on top, video band, captions below the video
    VW, VH, VY = 1080, 608, 330
    ASS34 = WORK / "captions_3x4.ass"
    write_ass(ASS34, 1080, 1440, capfont, 50, 1440 - (VY + VH) - 150)
    vf = (f"[0:v]scale={VW}:{VH},setsar=1[v];"
          f"color=c=0xFEF3D4:s=1080x1440:r={FPS}:d={TOTAL:.3f}[bg];"
          f"[bg][v]overlay=0:{VY}:shortest=1,"
          f"drawtext=fontfile={INTER_BLACK}:text='Human Human Interaction Lab':fontsize=64:fontcolor=0x1d1b19:x=(w-text_w)/2:y=120,"
          f"drawtext=fontfile={CJK_MED}:text='{esc(TAGLINE_ZH)}':fontsize=40:fontcolor=0x5a554f:x=(w-text_w)/2:y=212,"
          f"drawtext=fontfile={INTER_MED}:text='Cal Hacks 13.0':fontsize=30:fontcolor=0x8a837a:x=(w-text_w)/2:y=1330,"
          f"subtitles={ASS34}:fontsdir=/usr/share/fonts/opentype[o]")
    run(["ffmpeg", "-y", "-v", "error", "-i", VIDEO, "-i", AUDIO, "-filter_complex", vf, "-map", "[o]", "-map", "1:a",
         "-c:v", "libx264", "-preset", "veryfast", "-crf", "19", "-pix_fmt", "yuv420p", "-r", str(FPS),
         "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-shortest", "-movflags", "+faststart", FINAL34])
    print("done", FINAL34, f"{probe_dur(FINAL34):.2f}s")

json.dump({"total": round(TOTAL, 3), "music_gain_db": round(mg, 2), "timeline": timeline,
           "cues": [[round(a, 3), round(b, 3), c] for a, b, c in cues]},
          open(WORK / "timeline.json", "w"), indent=1, ensure_ascii=False)
