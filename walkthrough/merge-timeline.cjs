// merge-timeline.cjs — combine the laptop timeline (renumbered) with hand-picked
// windows from the phone recording, write timeline.json, dump check frames.
const fs = require('fs'); const { execSync } = require('child_process');
const ROOT = __dirname;
const lap = JSON.parse(fs.readFileSync(ROOT + '/timeline-lap.json', 'utf8'));
const LAP_MAP = { 1: 1, 2: 2, 3: 3, 12: 12, 17: 17, 18: 18, 19: 19, 20: 20, 21: 21 };
const marks = Object.fromEntries(fs.readFileSync(ROOT + '/phone-marks.txt', 'utf8').trim().split(/\r?\n/).map(l => l.split(' ')).map(([k, v]) => [k, Number(v)]));
const T0 = marks.rec_start - 200;          // scrcpy's first frame landed ~0.2 s before the mark
const P = (k, off = 0) => marks[k] - T0 + off * 1000;
const PHONE = ROOT + '/clips/phone/phone-take1.mp4';
const phoneScenes = [
  { scene: 4,  start: P('install_tapped', -2),      end: P('install_confirm_shown', 2.5), caption: 'Install it like any app.' },
  { scene: 5,  start: P('install_confirmed', -1),   end: P('s_app_open', 7.5),            caption: 'No app store, no terminal.' },
  { scene: 6,  start: P('s_app_open', 7.5),         end: P('s_rules_start', 0),           caption: 'The deposit is on the timeline, decrypted by the purse.' },
  { scene: 8,  start: P('fire_topup', -14),         end: P('fire_topup', 6),              caption: 'Fire now. The agent goes to work.' },
  { scene: 9,  start: P('s_timeline_wait', 5.0),    end: P('pass_done', 5.5),             caption: 'Bought on Bitrefill, delivered.' },
  { scene: 11, start: P('s_wallets', 0.2),            end: P('s_more', -0.5),               caption: 'Swiggy Money: redeemed automatically into the household balance.' },
  { scene: 13, start: P('s_connections', -0.3),     end: P('enable_push', 5),             caption: 'Every connection, and push notifications.' },
  { scene: 14, start: P('enable_push', 16.5), end: P('enable_push', 23), caption: 'Allow it once.' },
  { scene: 15, start: P('send_test', -1),           end: P('send_test', 6),               caption: 'Send a test.' },
  { scene: 16, start: P('shade_open', 2.0),         end: P('shade_open', 4.1),         caption: 'Delivered — next to Swiggy’s own credit message.' },
];
const scenes = [...lap.scenes.map(s => ({ ...s, scene: LAP_MAP[s.scene] })), ...phoneScenes.map(s => ({ ...s, ctx: 'phone' }))].sort((a, b) => a.scene - b.scene);
const NEW_ID = {"1": 1, "2": 2, "3": 3, "4": 4, "5": 5, "6": 6, "19": 7, "20": 8, "8": 9, "9": 10, "12": 11, "17": 12, "21": 13, "11": 14, "13": 15, "14": 16, "15": 17, "16": 18, "18": 19};
scenes.forEach(s => { s.scene = NEW_ID[String(s.scene)]; }); scenes.sort((a, b) => a.scene - b.scene);
fs.writeFileSync(ROOT + '/timeline.json', JSON.stringify({ videos: { lap: lap.videos.lap, phone: PHONE }, scenes }, null, 2));
fs.mkdirSync(ROOT + '/verify', { recursive: true });
for (const s of scenes) {
  const vid = s.ctx === 'lap' ? lap.videos.lap : PHONE;
  for (const [tag, t] of [['a', s.start / 1000 + 0.4], ['b', s.end / 1000 - 0.4]]) {
    execSync(`ffmpeg -y -loglevel error -ss ${t.toFixed(2)} -i "${vid}" -frames:v 1 -vf scale=-2:540 "${ROOT}/verify/s${String(s.scene).padStart(2, '0')}${tag}.jpg"`);
  }
  console.log(`scene ${String(s.scene).padStart(2)} [${s.ctx}] ${(s.start / 1000).toFixed(1)} → ${(s.end / 1000).toFixed(1)}  (${((s.end - s.start) / 1000).toFixed(1)}s)`);
}
