// Generate one ElevenLabs voiceover clip per scene from scenes.json.
// Key comes from env (ELEVENLABS_API_KEY) — never stored on disk.
//   ELEVENLABS_API_KEY=... node gen-vo.cjs            (all scenes)
//   ELEVENLABS_API_KEY=... node gen-vo.cjs 5 7        (only scenes 5 and 7)
const fs = require('fs');
const cfg = require('./_config.cjs').load();
const ROOT = cfg.dir;
const KEY = process.env.ELEVENLABS_API_KEY;
if (!KEY) { console.error('ELEVENLABS_API_KEY not set'); process.exit(1); }
const VOICE = process.env.VOICE_ID || cfg.elevenlabs.voiceId;
if (!VOICE) { console.error('No voiceId (set config.elevenlabs.voiceId or VOICE_ID env). Run list-voices.cjs.'); process.exit(1); }

const scenes = JSON.parse(fs.readFileSync(ROOT + '/scenes.json', 'utf8'));
const only = process.argv.slice(2).map(Number);
const OUT = ROOT + '/vo';
fs.mkdirSync(OUT, { recursive: true });

async function tts(text, outPath) {
  const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${VOICE}?output_format=mp3_44100_128`, {
    method: 'POST',
    headers: { 'xi-api-key': KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, model_id: cfg.elevenlabs.model, voice_settings: cfg.elevenlabs.voiceSettings }),
  });
  if (!r.ok) throw new Error(`TTS ${r.status} ${(await r.text()).slice(0, 240)}`);
  fs.writeFileSync(outPath, Buffer.from(await r.arrayBuffer()));
}

(async () => {
  console.log('voice', VOICE, '| model', cfg.elevenlabs.model);
  for (const s of scenes) {
    if (only.length && !only.includes(s.n)) continue;
    const out = `${OUT}/s${String(s.n).padStart(2, '0')}.mp3`;
    await tts(s.text, out);
    console.log('scene', s.n, '->', out, '(' + s.text.length + ' chars)');
  }
  console.log('DONE');
})().catch(e => { console.error('ERR', String(e).slice(0, 300)); process.exit(1); });
