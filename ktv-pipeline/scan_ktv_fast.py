import os, subprocess, struct, wave, tempfile, sys
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, as_completed
from collections import Counter

BASE = "/ktv-data/processed"
THRESHOLD_WARN = 0.30
THRESHOLD_FAIL = 1.00

def scan_one(mp4_path):
    name = mp4_path.name
    result = {"name": name, "audio_leading_silence_s": None,
              "video_first_change_s": None, "delay_estimate_s": None,
              "verdict": "UNKNOWN", "error": None}
    try:
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            wav = tmp / "audio.wav"
            r = subprocess.run(
                ["ffmpeg", "-y", "-i", str(mp4_path), "-vn", "-ac", "1", "-ar", "44100", "-f", "wav", str(wav)],
                capture_output=True, timeout=60)
            if r.returncode != 0:
                result["error"] = "ffmpeg_fail:" + r.stderr.decode(errors="ignore")[-100:]
                return result

            audio_leading = scan_wav(str(wav))
            video_change = detect_video(str(mp4_path))

            result["audio_leading_silence_s"] = round(audio_leading, 3)
            result["video_first_change_s"] = round(video_change, 3) if video_change is not None else None

            if video_change is not None and audio_leading is not None:
                delay = audio_leading - video_change
                result["delay_estimate_s"] = round(delay, 3)
                if delay > THRESHOLD_FAIL:   result["verdict"] = "FAIL_DELAY"
                elif delay > THRESHOLD_WARN:  result["verdict"] = "WARN_DELAY"
                elif audio_leading > THRESHOLD_FAIL:  result["verdict"] = "FAIL_SILENCE"
                elif audio_leading > THRESHOLD_WARN:  result["verdict"] = "WARN_SILENCE"
                else: result["verdict"] = "OK"
            else:
                if audio_leading > THRESHOLD_FAIL:   result["verdict"] = "FAIL_SILENCE"
                elif audio_leading > THRESHOLD_WARN:  result["verdict"] = "WARN_SILENCE"
                else: result["verdict"] = "OK"
    except subprocess.TimeoutExpired:
        result["error"] = "timeout"
    except Exception as e:
        result["error"] = str(e)
    return result

def scan_wav(wav_path, max_s=1.5):
    RMS_DB, PEAK_DB, SR = -45.0, -30.0, 44100
    WINDOW_MS, HOP_MS = 40, 20
    rms_thr_sq = (10**(RMS_DB/20)*32768)**2
    peak_thr_abs = 10**(PEAK_DB/20)*32768
    with wave.open(wav_path, "rb") as w:
        nframes = min(w.getnframes(), int(max_s*SR))
        win, hop = int(SR*WINDOW_MS/1000), int(SR*HOP_MS/1000)
        for i in range(0, nframes-win+1, hop):
            w.setpos(i)
            raw = w.readframes(win)
            if len(raw) < win*2: break
            vals = struct.unpack(f"<{win}h", raw)
            rms_sq = sum(v*v for v in vals)/win
            peak = max(abs(v) for v in vals)
            if rms_sq > rms_thr_sq or peak > peak_thr_abs:
                return i/SR
        return nframes/SR

def detect_video(mp4_path):
    try:
        proc = subprocess.run(
            ["ffmpeg", "-i", mp4_path, "-vf", "select='gt(scene,0.05)',showinfo", "-f", "null", "-"],
            capture_output=True, timeout=60)
        for line in proc.stderr.decode(errors="ignore").splitlines():
            if "pts_time:" in line and "Parsed_showinfo" in line:
                idx = line.find("pts_time:") + len("pts_time:")
                ts = line[idx:].split()[0]
                return float(ts)
        return 0.0
    except:
        return None

# MAIN
files = sorted([Path(BASE)/f for f in os.listdir(BASE) if f.endswith("_ktv.mp4")])
print(f"Scanning {len(files)} files...", flush=True)
results = []
with ThreadPoolExecutor(max_workers=4) as ex:
    futs = {ex.submit(scan_one, f): f for f in files}
    for i, fut in enumerate(as_completed(futs)):
        r = fut.result()
        results.append(r)
        sys.stdout.write(f"[{i+1}/{len(files)}] {r['verdict']:15s} {r['name'][:50]}\n")
        sys.stdout.flush()

order = {"FAIL_DELAY":0,"FAIL_SILENCE":1,"WARN_DELAY":2,"WARN_SILENCE":3,"OK":4,"UNKNOWN":5}
results.sort(key=lambda r:(order.get(r["verdict"],5), r["name"]))
print("\n=== TSV ===", flush=True)
print("VERDICT\tNAME\tAUDIO_LEADING\tDELAY_EST\tVIDEO_FIRST\tERROR", flush=True)
for r in results:
    print(f"{r['verdict']}\t{r['name']}\t{r['audio_leading_silence_s']}\t{r['delay_estimate_s']}\t{r['video_first_change_s']}\t{r['error'] or ''}", flush=True)

c = Counter(r["verdict"] for r in results)
print(f"\n=== STATS: {len(results)} total ===", flush=True)
for k in ["FAIL_DELAY","FAIL_SILENCE","WARN_DELAY","WARN_SILENCE","OK","UNKNOWN"]:
    if c.get(k): print(f"  {k}: {c[k]}", flush=True)