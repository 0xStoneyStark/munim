// Align each VO clip to its scene window (lead silence + clip + pad to the exact
// scene length), concat into a full track, and mux onto the silent video.
// Re-run this any time stitch.cjs changes scene-durs.json.
const { execSync } = require('child_process');
const fs = require('fs');
const cfg = require('./_config.cjs').load();
const ROOT = cfg.dir;

const durs = JSON.parse(fs.readFileSync(ROOT + '/scene-durs.json', 'utf8'))
  .sort((a, b) => a.scene - b.scene)
  .map(x => x.dur);
const lead = (cfg.voLeadMs / 1000).toFixed(3);
const SEG = ROOT + '/vo/seg';
fs.rmSync(SEG, { recursive: true, force: true });
fs.mkdirSync(SEG, { recursive: true });

const files = [];
durs.forEach((d, i) => {
  const n = String(i + 1).padStart(2, '0');
  const clip = `${ROOT}/vo/s${n}.mp3`;
  if (!fs.existsSync(clip)) throw new Error(`missing VO clip ${clip} — run gen-vo.cjs`);
  const out = `${SEG}/seg${n}.wav`;
  // lead silence, then the clip, then pad to the exact scene length.
  execSync(`ffmpeg -y -loglevel error -i "${clip}" -af "adelay=${cfg.voLeadMs}:all=1,apad,atrim=0:${d.toFixed(3)},aformat=sample_rates=44100:channel_layouts=stereo" "${out}"`, { stdio: 'pipe' });
  // Warn (don't fail) if the narration is longer than the scene — words get cut.
  const cd = Number(execSync(`ffprobe -v error -show_entries format=duration -of default=nk=1:nw=1 "${clip}"`).toString().trim());
  if (cd + cfg.voLeadMs / 1000 > d + 0.05) console.warn(`  ! scene ${n}: VO ${cd.toFixed(1)}s + lead > window ${d.toFixed(1)}s (will clip)`);
  files.push(out);
});

const list = `${SEG}/list.txt`;
fs.writeFileSync(list, files.map(f => `file '${f}'`).join('\n'));
const full = `${ROOT}/vo/vo_full.wav`;
execSync(`ffmpeg -y -loglevel error -f concat -safe 0 -i "${list}" -c:a pcm_s16le "${full}"`, { stdio: 'pipe' });

const vid = `${ROOT}/${cfg.name}.mp4`;
const outv = `${ROOT}/${cfg.name}-narrated.mp4`;
execSync(`ffmpeg -y -loglevel error -i "${vid}" -i "${full}" -map 0:v:0 -map 1:a:0 -c:v copy -c:a aac -b:a 192k -shortest "${outv}"`, { stdio: 'pipe' });
const dur = execSync(`ffprobe -v error -show_entries format=duration -of default=nk=1:nw=1 "${outv}"`).toString().trim();
console.log('NARRATED:', outv, '|', Number(dur).toFixed(1) + 's');
