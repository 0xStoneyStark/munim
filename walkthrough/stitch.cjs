// Cut each scene's window from its context video, optionally speed it up,
// concat → <name>.mp4, and record the EXACT resulting per-scene durations to
// scene-durs.json so the VO can be aligned precisely.
//
// Reads:  timeline.json  { videos:{ctx:path}, scenes:[{scene,ctx,start,end}] }
//         config.json    speed:{ "<scene>": factor }
// Writes: segs/, scene-durs.json, <name>.mp4
const { execSync } = require('child_process');
const fs = require('fs');
const cfg = require('./_config.cjs').load();
const ROOT = cfg.dir;
const m = JSON.parse(fs.readFileSync(ROOT + '/timeline.json', 'utf8'));
const SPEED = cfg.speed || {};
const CROP = cfg.crop || {};
const W = cfg.view.width, H = cfg.view.height;

const SEG = ROOT + '/segs';
fs.rmSync(SEG, { recursive: true, force: true });
fs.mkdirSync(SEG, { recursive: true });

const BASE = `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,fps=30,format=yuv420p`;
const ordered = m.scenes.slice().sort((a, b) => a.scene - b.scene);
const segFiles = [];
const sceneDurs = [];
for (const s of ordered) {
  const vid = m.videos[s.ctx];
  if (!vid) throw new Error(`no video for ctx "${s.ctx}" in timeline.videos`);
  // Input-side trim (-ss/-t before -i) so setpts actually compresses the clip.
  const ss = (s.start / 1000).toFixed(3);
  const dur = ((s.end - s.start) / 1000).toFixed(3);
  const sp = Number(SPEED[s.scene]) || 1;
  const vf = (CROP[s.scene] ? `crop=${CROP[s.scene]},` : '') + (sp !== 1 ? `setpts=PTS/${sp.toFixed(4)},` : '') + BASE;
  const out = `${SEG}/seg${String(s.scene).padStart(2, '0')}.mp4`;
  execSync(`ffmpeg -y -loglevel error -ss ${ss} -t ${dur} -i "${vid}" -vf "${vf}" -an -c:v libx264 -crf 20 -preset veryfast "${out}"`, { stdio: 'pipe' });
  const d = Number(execSync(`ffprobe -v error -show_entries format=duration -of default=nk=1:nw=1 "${out}"`).toString().trim());
  segFiles.push(out);
  sceneDurs.push({ scene: s.scene, dur: d });
  console.log(`scene ${s.scene} [${s.ctx}] @${ss}s +${dur}s  speed ${sp}x  -> ${d.toFixed(2)}s`);
}

fs.writeFileSync(ROOT + '/scene-durs.json', JSON.stringify(sceneDurs, null, 2));
const listFile = `${SEG}/list.txt`;
fs.writeFileSync(listFile, segFiles.map(f => `file '${f}'`).join('\n'));
const FINAL = `${ROOT}/${cfg.name}.mp4`;
execSync(`ffmpeg -y -loglevel error -f concat -safe 0 -i "${listFile}" -c:v libx264 -crf 20 -preset veryfast -pix_fmt yuv420p "${FINAL}"`, { stdio: 'pipe' });
const dur = execSync(`ffprobe -v error -show_entries format=duration -of default=nk=1:nw=1 "${FINAL}"`).toString().trim();
console.log('\nFINAL (silent):', FINAL, '|', Number(dur).toFixed(1) + 's');
