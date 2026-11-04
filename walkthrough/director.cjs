// director.cjs — composes the whole film in one animated HTML stage (gradient
// motion, phone / browser frames, kinetic captions, transitions), plays the
// already-cut segments inside it, and records the stage once via cast.cjs.
// Writes clips/stage.mp4 and stage-schedule.json (scene start offsets) so the
// voice-over and music can be laid in by schedule.
//   node director.cjs
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const L = require('./lib.cjs');
const { startCast } = require('./cast.cjs');
const cfg = L.cfg;
const ROOT = cfg.dir;
const fileUrl = (p) => 'file:///' + p.split(path.sep).join('/');
const durs = Object.fromEntries(JSON.parse(fs.readFileSync(ROOT + '/scene-durs.json', 'utf8')).map(x => [x.scene, x.dur]));

// kind: title | lap | phone | wide | end
const META = [
  { n: 1,  kind: 'title' },
  { n: 2,  kind: 'lap',   eyebrow: 'FUNDER WALLET',      head: 'ONE SHIELDED DEPOSIT',          sub: 'the spending cap rides inside the encrypted memo' },
  { n: 3,  kind: 'lap',   eyebrow: 'PUBLIC EXPLORER',    head: 'NOTHING TO READ',               sub: 'amount and memo are shielded on-chain' },
  { n: 4,  kind: 'phone', eyebrow: 'ON THE PHONE',       head: 'INSTALLS LIKE AN APP',          sub: 'Chrome → Install. That’s it.' },
  { n: 5,  kind: 'phone', eyebrow: 'NO APP STORE',       head: 'NO TERMINAL',                   sub: 'the household runs it from the home screen' },
  { n: 6,  kind: 'phone', eyebrow: 'TIMELINE',           head: 'CAP ₹300 · ₹389 LEFT',          sub: 'the deposit, decrypted by the purse' },
  { n: 7,  kind: 'phone', eyebrow: 'RULES',              head: 'WHAT TO BUY, AND WHEN',         sub: 'schedule · signal · calendar · clock' },
  { n: 8,  kind: 'phone', eyebrow: 'TOPUP RULE',         head: 'FIRE NOW →',                    sub: '₹250 Swiggy Money, when I say so' },
  { n: 9,  kind: 'phone', eyebrow: '30 SECONDS LATER',   head: 'BOUGHT. DELIVERED.',            sub: 'Bitrefill invoice · ₹139 left under the cap' },
  { n: 10, kind: 'lap',   eyebrow: 'RECEIPTS',           head: 'ENCRYPTED MEMO → VERIFIED',     sub: 'a hash of the code, never the code' },
  { n: 11, kind: 'lap',   eyebrow: 'PRIVACY NOTE',       head: 'WHO SEES WHAT',                 sub: 'and what nobody can' },
  { n: 12, kind: 'phone', eyebrow: 'CALENDAR → PROPOSAL', head: 'DUBAI eSIM, BY ITSELF',        sub: 'buys only after approval, only inside the cap' },
  { n: 13, kind: 'phone', eyebrow: 'WALLETS',            head: 'SWIGGY MONEY, AUTO-REDEEMED',   sub: 'the same balance paid last night’s Instamart order' },
  { n: 14, kind: 'phone', eyebrow: 'CONNECTIONS',        head: 'EVERY LINK, LIVE',              sub: 'Swiggy MCP · Bitrefill · Calendar · wallets' },
  { n: 15, kind: 'phone', eyebrow: 'PUSH',               head: 'ALLOW ONCE',                    sub: '' },
  { n: 16, kind: 'phone', eyebrow: 'PUSH',               head: 'ONE TAP',                       sub: '' },
  { n: 17, kind: 'wide',  eyebrow: 'DELIVERED',          head: 'NEXT TO SWIGGY’S OWN SMS',      sub: 'the ₹250 credit, confirmed by Swiggy' },
  { n: 18, kind: 'end' },
];

const HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
:root{--gold:#f4b728;--bg:#0a0a0c;--ink:#f3f3f5;--mute:#9a9aa6}
html,body{margin:0;width:1920px;height:1080px;overflow:hidden;background:var(--bg);color:var(--ink);font-family:"Bahnschrift","Segoe UI Black","Segoe UI",system-ui,sans-serif}
#bg{position:absolute;inset:0;overflow:hidden}
.blob{position:absolute;border-radius:50%;filter:blur(90px);opacity:.55;will-change:transform}
.b1{width:900px;height:900px;left:-250px;top:-300px;background:radial-gradient(circle,#f4b728 0%,rgba(244,183,40,0) 70%);animation:drift1 18s ease-in-out infinite alternate}
.b2{width:800px;height:800px;right:-200px;bottom:-350px;background:radial-gradient(circle,#b8860b 0%,rgba(184,134,11,0) 70%);animation:drift2 22s ease-in-out infinite alternate}
.b3{width:600px;height:600px;left:40%;top:30%;background:radial-gradient(circle,#2a2a35 0%,rgba(42,42,53,0) 70%);animation:drift3 15s ease-in-out infinite alternate}
@keyframes drift1{from{transform:translate(0,0) scale(1)}to{transform:translate(220px,160px) scale(1.15)}}
@keyframes drift2{from{transform:translate(0,0) scale(1.1)}to{transform:translate(-200px,-140px) scale(.95)}}
@keyframes drift3{from{transform:translate(0,0)}to{transform:translate(-160px,120px)}}
#grid{position:absolute;inset:0;background-image:linear-gradient(rgba(255,255,255,.035) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.035) 1px,transparent 1px);background-size:64px 64px;mask-image:radial-gradient(circle at 50% 50%,#000 30%,transparent 80%)}
#grain{position:absolute;inset:0;opacity:.07;background-image:url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='200' height='200'><filter id='n'><feTurbulence baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/></filter><rect width='200' height='200' filter='url(%23n)' opacity='0.6'/></svg>");mix-blend-mode:overlay}
.scene{position:absolute;inset:0;opacity:0;transform:translateY(28px) scale(.985);transition:opacity .38s ease,transform .45s cubic-bezier(.16,1,.3,1)}
.scene.on{opacity:1;transform:none}
.scene.out{opacity:0;transform:translateY(-22px) scale(1.01);transition:opacity .3s ease,transform .3s ease}
.copy{position:absolute;left:120px;top:0;height:1080px;width:760px;display:flex;flex-direction:column;justify-content:center;gap:22px}
.eyebrow{font:600 22px/1 "Cascadia Mono","Consolas",monospace;letter-spacing:6px;color:var(--gold);opacity:0;transform:translateY(16px);animation:rise .5s .05s cubic-bezier(.16,1,.3,1) forwards}
.head{font-weight:800;font-size:84px;line-height:.98;letter-spacing:-1.5px;text-transform:uppercase;overflow:hidden}
.head span{display:inline-block;opacity:0;transform:translateY(110%);animation:rise .6s cubic-bezier(.16,1,.3,1) forwards}
.sub{font-size:30px;line-height:1.3;color:var(--mute);max-width:640px;opacity:0;transform:translateY(16px);animation:rise .5s .45s cubic-bezier(.16,1,.3,1) forwards}
.bar{width:120px;height:6px;background:var(--gold);border-radius:3px;transform-origin:left;transform:scaleX(0);animation:grow .6s .25s cubic-bezier(.16,1,.3,1) forwards}
@keyframes rise{to{opacity:1;transform:none}}
@keyframes grow{to{transform:scaleX(1)}}
.phone{position:absolute;right:170px;top:50%;transform:translateY(-50%) rotate(0deg);width:440px;height:952px;border-radius:52px;background:#000;box-shadow:0 40px 120px rgba(0,0,0,.7),0 0 0 2px #2a2a30,0 0 0 10px #0f0f12,0 0 80px rgba(244,183,40,.12);overflow:hidden;opacity:0;animation:pop .6s .1s cubic-bezier(.16,1,.3,1) forwards}
.phone video{width:100%;height:100%;object-fit:cover;display:block}
@keyframes pop{from{opacity:0;transform:translateY(-50%) translateX(60px) scale(.96)}to{opacity:1;transform:translateY(-50%)}}
.win{position:absolute;left:50%;top:44px;transform:translateX(-50%);width:1400px;border-radius:18px;overflow:hidden;background:#121216;box-shadow:0 40px 120px rgba(0,0,0,.7),0 0 0 1px #2a2a30;opacity:0;animation:popc .6s .05s cubic-bezier(.16,1,.3,1) forwards}
.win .chrome{height:40px;background:#1a1a1f;display:flex;align-items:center;gap:8px;padding:0 16px}
.win .chrome i{width:12px;height:12px;border-radius:50%;background:#3a3a42;display:block}
.win .chrome i:first-child{background:#f4b728}
.win video{width:100%;display:block}
@keyframes popc{from{opacity:0;transform:translate(-50%,0) translateY(24px) scale(.985)}to{opacity:1;transform:translate(-50%,0)}}
.lapcopy{position:absolute;left:120px;right:120px;bottom:44px;display:flex;align-items:flex-end;justify-content:space-between;gap:40px}
.lapcopy .l{display:flex;flex-direction:column;gap:8px}
.lapcopy .head{font-size:54px;line-height:1}
.lapcopy .sub{font-size:24px;max-width:700px;text-align:right}
.lapcopy .eyebrow{font-size:18px;letter-spacing:5px}
.wide{position:absolute;left:50%;top:50%;transform:translate(-50%,0);margin-top:-250px;width:1100px;border-radius:28px;overflow:hidden;box-shadow:0 40px 120px rgba(0,0,0,.7),0 0 0 2px #2a2a30;opacity:0;animation:popc .6s .05s cubic-bezier(.16,1,.3,1) forwards}
.wide video{width:100%;display:block}
.widecopy{position:absolute;left:0;right:0;top:110px;text-align:center}
.widecopy .head{font-size:64px}
.widecopy .copyin{display:inline-flex;flex-direction:column;align-items:center;gap:14px}
.center{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:26px;text-align:center}
.logo{width:150px;height:150px;border-radius:36px;background:var(--gold);color:#111;font-weight:800;font-size:96px;display:flex;align-items:center;justify-content:center;opacity:0;animation:pop2 .7s cubic-bezier(.16,1,.3,1) forwards;box-shadow:0 30px 80px rgba(244,183,40,.25)}
@keyframes pop2{from{opacity:0;transform:scale(.6) rotate(-8deg)}to{opacity:1;transform:none}}
.big{font-weight:800;font-size:150px;line-height:1;letter-spacing:-4px;overflow:hidden}
.big span{display:inline-block;opacity:0;transform:translateY(110%);animation:rise .7s .25s cubic-bezier(.16,1,.3,1) forwards}
.tag{font-size:40px;color:var(--ink);opacity:0;animation:rise .6s .7s cubic-bezier(.16,1,.3,1) forwards}
.tag b{color:var(--gold)}
.tiny{font:600 20px/1 "Cascadia Mono","Consolas",monospace;letter-spacing:5px;color:var(--mute);opacity:0;animation:rise .6s 1s forwards}
.pill{position:absolute;right:120px;top:70px;font:600 20px/1 "Cascadia Mono","Consolas",monospace;letter-spacing:4px;color:var(--gold);border:1px solid rgba(244,183,40,.4);padding:14px 20px;border-radius:999px;background:rgba(0,0,0,.35)}
.endwin{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%) scale(.72);width:1560px;border-radius:18px;overflow:hidden;opacity:.35;filter:saturate(.6)}
.endwin video{width:100%;display:block}
</style></head><body>
<div id="bg"><div class="blob b1"></div><div class="blob b2"></div><div class="blob b3"></div><div id="grid"></div><div id="grain"></div></div>
<div id="stage"></div>
</body></html>`;

const words = (t) => t.split(' ').map((w, i) => `<span style="animation-delay:${(0.12 + i * 0.07).toFixed(2)}s">${w}</span>`).join(' ');

function sceneHtml(m, src) {
  const vid = (cls) => `<video class="${cls}" src="${src}" muted playsinline preload="auto"></video>`;
  if (m.kind === 'title') return `<div class="center"><div class="logo">M</div><div class="big">${words('MUNIM')}</div><div class="tag">Fund it <b>privately</b>. It shops while you sleep.</div><div class="tiny">SHIELDED ZCASH PURSE · BITREFILL · SWIGGY MCP</div></div>`;
  if (m.kind === 'end') return `<div class="endwin">${vid('')}</div><div class="center"><div class="big" style="font-size:118px">${words('FUND IT PRIVATELY.')}</div><div class="big" style="font-size:118px">${words('IT SHOPS WHILE YOU SLEEP.')}</div><div class="tag" style="animation-delay:1.2s">github.com/0xStoneyStark/munim · <b>open source, MIT</b></div><div class="tiny" style="animation-delay:1.5s">FREE SOCIETY HACK · MUMBAI · 4 NOV 2026</div></div>`;
  const copy = `<div class="eyebrow">${m.eyebrow}</div><div class="bar"></div><div class="head">${words(m.head)}</div>${m.sub ? `<div class="sub">${m.sub}</div>` : ''}`;
  if (m.kind === 'phone') return `<div class="copy">${copy}</div><div class="phone">${vid('')}</div><div class="pill">LIVE · munim.heneryshop.com</div>`;
  if (m.kind === 'wide') return `<div class="widecopy"><div class="copyin">${copy}</div></div><div class="wide" style="top:60%">${vid('')}</div>`;
  return `<div class="win"><div class="chrome"><i></i><i></i><i></i></div>${vid('')}</div><div class="lapcopy"><div class="l"><div class="eyebrow">${m.eyebrow}</div><div class="bar"></div><div class="head">${words(m.head)}</div></div>${m.sub ? `<div class="sub">${m.sub}</div>` : ''}</div>`;
}

// portrait cuts for the phone scenes (the stitched segs are pillarboxed)
const tl = JSON.parse(fs.readFileSync(ROOT + '/timeline.json', 'utf8'));
const SPEED = cfg.speed || {}; const CROP = cfg.crop || {};
fs.mkdirSync(ROOT + '/segs-raw', { recursive: true });
for (const m of META) if (m.kind === 'phone' || m.kind === 'wide') {
  const s = tl.scenes.find(x => x.scene === m.n); const vid = tl.videos[s.ctx];
  const sp = Number(SPEED[m.n]) || 1; const out = `${ROOT}/segs-raw/seg${String(m.n).padStart(2, '0')}.mp4`;
  const vf = (CROP[m.n] ? `crop=${CROP[m.n]},` : '') + (sp !== 1 ? `setpts=PTS/${sp.toFixed(4)},` : '') + 'fps=30,format=yuv420p';
  execSync(`ffmpeg -y -loglevel error -ss ${(s.start / 1000).toFixed(3)} -t ${((s.end - s.start) / 1000).toFixed(3)} -i "${vid}" -vf "${vf}" -an -c:v libx264 -crf 18 -preset veryfast "${out}"`, { stdio: 'pipe' });
}

(async () => {
  const { chromium } = require(cfg.playwright);
  const browser = await chromium.launch({ headless: true, channel: 'chrome', args: ['--autoplay-policy=no-user-gesture-required'] });
  const ctx = await browser.newContext({ viewport: cfg.view, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const stageFile = ROOT + '/stage.html'; fs.writeFileSync(stageFile, HTML);
  await page.goto(fileUrl(stageFile));
  // mount every scene hidden once so the videos preload
  const segs = META.map(m => ({ ...m, src: fileUrl(`${ROOT}/${(m.kind === 'phone' || m.kind === 'wide') ? 'segs-raw' : 'segs'}/seg${String(m.n).padStart(2, '0')}.mp4`), dur: durs[m.n] }));
  await page.evaluate((list) => {
    const st = document.getElementById('stage');
    for (const m of list) { const d = document.createElement('div'); d.className = 'scene'; d.id = 's' + m.n; d.innerHTML = m.html; st.appendChild(d); }
    return Promise.all([...document.querySelectorAll('video')].map(v => new Promise(res => { if (v.readyState >= 3) res(); else { v.oncanplaythrough = () => res(); v.onerror = () => res(); } })));
  }, segs.map(m => ({ n: m.n, html: sceneHtml(m, m.src) })));
  await page.waitForTimeout(500);
  const rec = await startCast(page, ROOT + '/clips/stageframes', { width: cfg.view.width, height: cfg.view.height, quality: 88 });
  const schedule = [];
  const T = 0.32; // transition seconds
  for (const m of segs) {
    const start = (Date.now() - rec.t0) / 1000;
    await page.evaluate((n) => {
      const prev = document.querySelector('.scene.on'); if (prev) { prev.classList.remove('on'); prev.classList.add('out'); }
      const el = document.getElementById('s' + n);
      // restart the CSS animations by re-inserting the content
      el.innerHTML = el.innerHTML;
      const v = el.querySelector('video'); if (v) { v.currentTime = 0; v.play().catch(() => {}); }
      el.classList.add('on');
    }, m.n);
    const hold = Math.max(1.2, m.dur - T);
    await page.waitForTimeout(hold * 1000);
    schedule.push({ scene: m.n, start, dur: m.dur });
    console.log(`scene ${m.n} ${m.kind} @${start.toFixed(2)}s +${m.dur.toFixed(2)}s`);
  }
  await page.waitForTimeout(600);
  const out = await rec.finish(ROOT + '/clips/stage.mp4');
  fs.writeFileSync(ROOT + '/stage-schedule.json', JSON.stringify({ schedule, total: (out.tEnd - out.t0) / 1000 }, null, 2));
  console.log('stage:', out.mp4, out.frames, 'frames', ((out.tEnd - out.t0) / 1000).toFixed(1) + 's');
  await browser.close();
})();
