#!/bin/bash
# rebuild.sh — re-pace to the current VO clips, re-stitch, re-render the stage, mix audio, upload.
set -e
cd "$(dirname "$0")"
python -I - <<'PY'
import json, subprocess
tl=json.load(open("timeline.json",encoding="utf-8"))
def dur(f): return float(subprocess.check_output(["ffprobe","-v","error","-show_entries","format=duration","-of","csv=p=0",f]).decode().strip())
speed={}
for s in tl["scenes"]:
    n=s["scene"]; win=(s["end"]-s["start"])/1000; vo=dur(f"vo/s{n:02d}.mp3")
    target=vo+0.9 if n!=1 else 6.5
    speed[str(n)]=round(max(0.3,min(win/target,8.0)),3)
c=json.load(open("config.json",encoding="utf-8")); c["speed"]=speed; json.dump(c,open("config.json","w",encoding="utf-8"),indent=2)
print("speeds set")
PY
node merge-timeline.cjs > /dev/null
node stitch.cjs | grep FINAL
node director.cjs | tail -1
node finalize-audio.cjs
scp -q -i /d/fomo-copytrade/secrets/hetzner_ed25519 munim-demo-final.mp4 root@46.62.219.71:/var/www/munim-demo/munim-demo.mp4
curl -s -o /dev/null -w "public %{http_code} %{size_download}\n" "https://munim.heneryshop.com/demo.mp4?v=$(date +%s)"
echo REBUILD_DONE
