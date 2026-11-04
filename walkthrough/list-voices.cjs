// List ElevenLabs voices + plan tier so you can pick a voiceId for config.json.
//   ELEVENLABS_API_KEY=... node list-voices.cjs
// NOTE: free plans can only use voices with category "premade" via the API;
// "professional"/library voices and the Music API return 402 (paid only).
const KEY = process.env.ELEVENLABS_API_KEY;
if (!KEY) { console.error('ELEVENLABS_API_KEY not set'); process.exit(1); }
(async () => {
  const sub = await fetch('https://api.elevenlabs.io/v1/user/subscription', { headers: { 'xi-api-key': KEY } });
  if (sub.ok) { const s = await sub.json(); console.log(`plan: ${s.tier} | chars ${s.character_count}/${s.character_limit}\n`); }
  const r = await fetch('https://api.elevenlabs.io/v1/voices', { headers: { 'xi-api-key': KEY } });
  if (!r.ok) { console.error('voices', r.status, (await r.text()).slice(0, 200)); process.exit(1); }
  const { voices } = await r.json();
  for (const v of voices) {
    const l = v.labels || {};
    console.log(`${v.voice_id} | ${v.name} | ${l.gender || '?'}/${l.accent || '?'} | ${v.category || ''}`);
  }
})().catch(e => { console.error('ERR', String(e).slice(0, 200)); process.exit(1); });
