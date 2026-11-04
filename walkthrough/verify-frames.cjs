// Extract one frame per scene (scene midpoint, from the featured context video)
// into verify/, so you can READ them and confirm the right thing was on screen.
// If a panel's text is small, crop it before reading:
//   ffmpeg -i verify/s05_trainer.png -vf crop=600:1080:1320:0 crop.png
const { execSync } = require('child_process');
const fs = require('fs');
const cfg = require('./_config.cjs').load();
const ROOT = cfg.dir;
const m = JSON.parse(fs.readFileSync(ROOT + '/timeline.json', 'utf8'));
const OUT = ROOT + '/verify';
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

// optional 0-1 position within each scene window (default 0.5 = midpoint).
const pos = process.argv[2] != null ? Number(process.argv[2]) : 0.5;
for (const s of m.scenes) {
  const vid = m.videos[s.ctx];
  const t = Math.max(0.1, ((s.start + (s.end - s.start) * pos) / 1000)).toFixed(2);
  const out = `${OUT}/s${String(s.scene).padStart(2, '0')}_${s.ctx}.png`;
  try { execSync(`ffmpeg -y -loglevel error -ss ${t} -i "${vid}" -frames:v 1 "${out}"`, { stdio: 'pipe' }); console.log('scene', s.scene, '->', out); }
  catch (e) { console.log('scene', s.scene, 'FAIL', String(e.message).slice(0, 100)); }
}
console.log('frames in', OUT);
