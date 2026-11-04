// Trim/fade a music file and mix it LOW under the voiceover, then mux onto the
// video. The voice stays at full level (amix normalize=0); music is a quiet bed.
//   config.music = { file, trimStart, volume(0-1), fadeIn, fadeOut }
const { execSync } = require('child_process');
const fs = require('fs');
const cfg = require('./_config.cjs').load();
const ROOT = cfg.dir;
const M = cfg.music || {};
if (!M.file) { console.error('config.music.file not set'); process.exit(1); }

const probe = (f) => Number(execSync(`ffprobe -v error -show_entries format=duration -of default=nk=1:nw=1 "${f}"`).toString().trim());
const video = `${ROOT}/${cfg.name}.mp4`;
const vo = `${ROOT}/vo/vo_full.wav`;
if (!fs.existsSync(vo)) { console.error('vo/vo_full.wav missing — run mux-vo.cjs first'); process.exit(1); }
const videoDur = probe(video);
const trimStart = M.trimStart || 0, vol = M.volume == null ? 0.2 : M.volume;
const fin = M.fadeIn == null ? 2 : M.fadeIn, fout = M.fadeOut == null ? 3 : M.fadeOut;

// Trim the head off the music, then loop if it doesn't cover the video.
const musTrim = `${ROOT}/vo/music_trim.wav`;
execSync(`ffmpeg -y -loglevel error -ss ${trimStart} -i "${M.file}" -c:a pcm_s16le "${musTrim}"`, { stdio: 'pipe' });
const musDur = probe(musTrim);
let loopArg = '';
if (musDur < videoDur) { const loops = Math.ceil(videoDur / musDur); loopArg = `-stream_loop ${loops - 1}`; }

const foutStart = Math.max(0, videoDur - fout).toFixed(3);
const out = `${ROOT}/${cfg.name}-narrated-music.mp4`;
const filt = `[2:a]asetpts=PTS-STARTPTS,volume=${vol},afade=t=in:st=0:d=${fin},afade=t=out:st=${foutStart}:d=${fout},aformat=sample_rates=44100:channel_layouts=stereo,atrim=0:${videoDur.toFixed(3)}[mus];[1:a]aformat=sample_rates=44100:channel_layouts=stereo[vo];[vo][mus]amix=inputs=2:duration=first:normalize=0[aout]`;
execSync(`ffmpeg -y -loglevel error -i "${video}" -i "${vo}" ${loopArg} -i "${musTrim}" -filter_complex "${filt}" -map 0:v:0 -map "[aout]" -c:v copy -c:a aac -b:a 192k -shortest "${out}"`, { stdio: 'pipe' });

const max = execSync(`ffmpeg -hide_banner -i "${out}" -af volumedetect -f null - 2>&1`).toString().match(/max_volume:\s*(-?[\d.]+)/);
console.log('FINAL (+music):', out, '|', Number(probe(out)).toFixed(1) + 's | music', Math.round(vol * 100) + '% | peak', max ? max[1] + 'dB' : '?');
