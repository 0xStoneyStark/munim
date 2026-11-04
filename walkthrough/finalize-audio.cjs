// finalize-audio.cjs — VO clips at their scheduled starts + music bed under them, muxed onto the stage video.
const fs = require('fs'); const { execSync } = require('child_process');
const ROOT = __dirname;
const sch = JSON.parse(fs.readFileSync(ROOT + '/stage-schedule.json', 'utf8'));
const total = sch.total; const LEAD = 0.35;
const inputs = [`-i "${ROOT}/clips/stage.mp4"`]; const parts = []; const tags = [];
sch.schedule.forEach((s, i) => {
  inputs.push(`-i "${ROOT}/vo/s${String(s.scene).padStart(2, '0')}.mp3"`);
  const ms = Math.round((s.start + LEAD) * 1000);
  parts.push(`[${i + 1}:a]aformat=sample_rates=44100:channel_layouts=stereo,adelay=${ms}|${ms}[v${i}]`); tags.push(`[v${i}]`);
});
const bedIdx = inputs.length; inputs.push(`-i "${ROOT}/music/bed.mp3"`);
const vol = Number(process.env.BED_VOL || 0.16);
parts.push(`${tags.join('')}amix=inputs=${tags.length}:normalize=0:dropout_transition=0[vo]`);
parts.push(`[${bedIdx}:a]aformat=sample_rates=44100:channel_layouts=stereo,atrim=0:${total.toFixed(2)},afade=t=in:st=0:d=1.5,afade=t=out:st=${(total - 3).toFixed(2)}:d=3,volume=${vol}[bed]`);
parts.push(`[vo][bed]amix=inputs=2:normalize=0:dropout_transition=0,alimiter=limit=0.95[a]`);
const out = `${ROOT}/munim-demo-final.mp4`;
execSync(`ffmpeg -y -loglevel error ${inputs.join(' ')} -filter_complex "${parts.join(';')}" -map 0:v:0 -map "[a]" -c:v copy -c:a aac -b:a 192k -shortest "${out}"`, { stdio: 'inherit' });
console.log('FINAL:', out, execSync(`ffprobe -v error -show_entries format=duration -of csv=p=0 "${out}"`).toString().trim() + 's');
