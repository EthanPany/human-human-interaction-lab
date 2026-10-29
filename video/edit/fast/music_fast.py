#!/usr/bin/env python3
"""Upbeat, warm indie electronic bed (about 110 BPM) rendered with FluidSynth + FluidR3 GM.
usage: music_fast.py OUT.wav DURATION [END_CARD_START]
Kalimba hook, marimba plucks, electric piano offbeats, fingered bass, warm pad, soft drums.
Ends on a held tonic chord that rings out under the end card."""
import sys, random, subprocess
from pathlib import Path
import mido

out = Path(sys.argv[1]); DUR = float(sys.argv[2])
END = float(sys.argv[3]) if len(sys.argv) > 3 else DUR - 6
SF2 = "/usr/share/sounds/sf2/FluidR3_GM.sf2"
BPM = 110; TPB = 480; BAR = 4 * 60 / BPM
random.seed(7)

mid = mido.MidiFile(ticks_per_beat=TPB)
ev = []  # (tick, msg)


def note(ch, n, beat, length, vel):
    t0 = int(beat * TPB); t1 = int((beat + length) * TPB)
    vel = max(1, min(127, int(vel + random.randint(-6, 6))))
    ev.append((t0, mido.Message("note_on", channel=ch, note=n, velocity=vel)))
    ev.append((t1, mido.Message("note_off", channel=ch, note=n, velocity=0)))


programs = {0: 4, 1: 12, 2: 33, 3: 89, 4: 108}  # EP, marimba, finger bass, warm pad, kalimba
vols = {0: 70, 1: 74, 2: 92, 3: 52, 4: 88, 9: 84}
for ch, p in programs.items():
    ev.append((0, mido.Message("program_change", channel=ch, program=p)))
for ch, v in vols.items():
    ev.append((0, mido.Message("control_change", channel=ch, control=7, value=v)))
    ev.append((0, mido.Message("control_change", channel=ch, control=91, value=50)))  # reverb

# F  C  Dm  Bb  (I V vi IV), voiced around middle C
CH = [(53, [60, 65, 69]), (48, [60, 64, 67]), (50, [60, 62, 65, 69]), (46, [58, 62, 65])]
HOOK = [(0, 72), (0.5, 77), (1, 76), (1.5, 72), (2.5, 69), (3, 72)]  # one bar motif, shifts per chord
HOOK2 = [(0, 74), (0.5, 72), (1, 69), (2, 67), (2.5, 69), (3.5, 72)]

end_bar = int(END / BAR)  # bar where the end card starts
nbars = int(DUR / BAR) + 1
break_at = int(nbars * 0.58)  # short 2 bar breakdown for variety
for b in range(nbars):
    if b * BAR > DUR - 0.5:
        break
    beat0 = b * 4
    root, chord = CH[b % 4]
    final = b >= end_bar + 1
    if final:
        # held tonic, let it ring under the end card
        for n in [53, 60, 65, 69, 72]:
            note(3, n, beat0, 12, 70); note(0, n + 12 if n < 60 else n, beat0, 6, 60)
        note(2, 41, beat0, 4, 80); note(4, 77, beat0, 3, 85); note(4, 81, beat0 + 0.5, 3, 75)
        note(9, 49, beat0, 2, 55); note(9, 36, beat0, 1, 80)
        break
    intro = b == 0
    brk = break_at <= b < break_at + 2
    # pad, every bar
    for n in chord:
        note(3, n, beat0, 4, 55)
    # electric piano offbeat stabs
    if not intro:
        for k in (0.5, 1.5, 2.5, 3.5):
            for n in chord:
                note(0, n + 12, beat0 + k, 0.3, 50 if brk else 58)
    # bass: root on 1, octave pops, fifth
    if not intro and not brk:
        pat = [(0, 0, 0.75), (1, 12, 0.4), (1.5, 0, 0.4), (2, 7, 0.75), (3, 12, 0.4), (3.5, 0, 0.4)]
        for k, iv, ln in pat:
            note(2, root - 12 + iv if root > 47 else root + iv, beat0 + k, ln, 88)
    # marimba 8th note arpeggio
    if not intro:
        arp = (chord + [chord[0] + 12])
        for i in range(8):
            note(1, arp[(i * 2 + b) % len(arp)] + 12, beat0 + i * 0.5, 0.45, 52 if i % 2 else 64)
    # kalimba hook: intro, every other 4 bar phrase, end card lead in
    if intro or (b // 4) % 2 == 0 or b >= end_bar - 1:
        motif = HOOK if b % 2 == 0 else HOOK2
        shift = {53: 0, 48: -1, 50: 0, 46: -2}[root]
        for k, n in motif:
            note(4, n + shift, beat0 + k, 0.5, 80 if not intro else 92)
    # drums
    if intro:
        note(9, 36, beat0, 0.5, 70); note(9, 49, beat0, 2, 45)
        continue
    if brk:
        for i in range(8):
            note(9, 70, beat0 + i * 0.5, 0.2, 50)
        continue
    for k in (0, 2.5) if b % 2 else (0, 1.75, 2.5):
        note(9, 36, beat0 + k, 0.3, 92)
    for k in (1, 3):
        note(9, 39, beat0 + k, 0.3, 62); note(9, 37, beat0 + k, 0.2, 55)
    hat_step = 0.25 if (b // 8) % 2 else 0.5
    i = 0
    while i * hat_step < 4:
        note(9, 42, beat0 + i * hat_step, 0.1, 58 if (i * hat_step) % 1 else 70)
        i += 1
    if b % 8 == 7:
        for k in (3, 3.25, 3.5, 3.75):
            note(9, 38, beat0 + k, 0.2, 48 + int(k * 8))
    if b % 8 == 0:
        note(9, 49, beat0, 2, 50)

ev.sort(key=lambda x: (x[0], x[1].type == "note_on"))
tr = mido.MidiTrack(); mid.tracks.append(tr)
tr.append(mido.MetaMessage("set_tempo", tempo=mido.bpm2tempo(BPM)))
last = 0
for t, m in ev:
    tr.append(m.copy(time=t - last)); last = t
mpath = out.with_suffix(".mid"); mid.save(mpath)
raw = out.with_name(out.stem + "_raw.wav")
subprocess.run(["fluidsynth", "-ni", "-q", "-g", "0.6", "-r", "48000", "-F", str(raw), SF2, str(mpath)], check=True)
# trim to length, gentle EQ and glue, short fade in, fade out
subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", str(raw), "-af",
                f"atrim=0:{DUR:.3f},highpass=f=35,equalizer=f=3000:t=q:w=1:g=1.5,"
                f"acompressor=threshold=0.25:ratio=2:attack=20:release=200,"
                f"afade=t=in:d=0.15,afade=t=out:st={DUR - 2.0:.3f}:d=2.0",
                "-ar", "48000", "-ac", "2", str(out)], check=True)
print("music", out, DUR)
