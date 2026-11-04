// walk-lap.cjs — the laptop scenes: title card, the funder deposit (real output
// replayed from deposit-send.log), the explorer view of the shielded tx, the
// receipt verifier, the privacy page and the README. Recorded via cast.cjs.
//   node walk-lap.cjs   → clips/lap.mp4 + timeline-lap.json
const fs = require('fs');
const path = require('path');
const L = require('./lib.cjs');
const { startCast } = require('./cast.cjs');
const cfg = L.cfg;
const ROOT = cfg.dir;
const REPO = path.resolve(ROOT, '..');
const NL = String.fromCharCode(10);
const BS = String.fromCharCode(92);
const PASSWORD = fs.readFileSync(REPO + '/data/server-dashboard-password.txt', 'utf8').trim();
const TXID = fs.readFileSync(ROOT + '/deposit-txid.txt', 'utf8').trim();
const SEND_LOG = fs.readFileSync(ROOT + '/deposit-send.log', 'utf8');
const PURSE = JSON.parse(fs.readFileSync(REPO + '/data/ledger.json', 'utf8')).address;
const FUNDER_REPLY = fs.readFileSync(ROOT + '/funder-address.txt', 'utf8').trim();
const RECEIPT = 'munim receipt inv=599b5c2f-aba9-4774-8d2d-676d2e64b373 item=Swiggy Money India inr=50 cost=0.55 USD rule=treat-for-mom code_sha256=62e54b8bfd8062a1';
const fileUrl = (p) => 'file:///' + p.split(path.sep).join('/');

const TITLE_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;height:100%;background:#0b0b0d;color:#fff;font-family:"Bahnschrift","Segoe UI",system-ui,sans-serif;overflow:hidden}
.wrap{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:28px}
.logo{width:120px;height:120px;border-radius:30px;background:#f4b728;color:#111;font-weight:800;font-size:76px;display:flex;align-items:center;justify-content:center}
h1{font-size:92px;margin:0;letter-spacing:-1px}
p{font-size:34px;margin:0;color:#c9c9cf}
.tag{margin-top:20px;font-size:22px;color:#8a8a94;letter-spacing:3px;text-transform:uppercase}
</style></head><body><div class="wrap"><div class="logo">M</div><h1>Munim</h1><p>Fund it privately. It shops while you sleep.</p><div class="tag">shielded Zcash purse · Bitrefill · Swiggy MCP</div></div></body></html>`;

const TERM_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;height:100%;background:#0b0b0d;color:#e6e6e6;font:22px/1.5 "Cascadia Mono","Consolas",monospace}
#wrap{padding:48px 64px;white-space:pre-wrap;word-break:break-all}
.p{color:#f4b728}.d{color:#8a8a94}.ok{color:#5ad17a}.h{color:#fff;font-weight:700}
</style></head><body><div id="wrap"></div></body></html>`;

(async () => {
  const { chromium } = require(cfg.playwright);
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  const ctx = await browser.newContext({ viewport: cfg.view, deviceScaleFactor: 1, userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36' });
  const page = await ctx.newPage();
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const line = (html) => page.evaluate((h) => { const w = document.getElementById('wrap'); w.insertAdjacentHTML('beforeend', h + String.fromCharCode(10)); window.scrollTo(0, document.body.scrollHeight); }, html);

  const titleFile = ROOT + '/title.html'; fs.writeFileSync(titleFile, TITLE_HTML);
  const termFile = ROOT + '/term.html'; fs.writeFileSync(termFile, TERM_HTML);
  await page.goto(fileUrl(titleFile));
  const rec = await startCast(page, ROOT + '/clips/lapframes', { width: cfg.view.width, height: cfg.view.height });
  const timeline = [];
  async function scene(num, captionTx, fn) {
    const start = Date.now() - rec.t0;
    try { await fn(); } catch (e) { console.error('scene', num, 'FAIL:', String(e.message).slice(0, 200)); try { await page.screenshot({ path: `${ROOT}/_fail-lap-s${num}.png` }); } catch {} }
    const end = Date.now() - rec.t0;
    timeline.push({ scene: num, ctx: 'lap', start, end, caption: captionTx });
    console.log(`scene ${num} ${((end - start) / 1000).toFixed(1)}s`);
  }

  // 1 · title
  await scene(1, 'Munim', async () => { await L.hold(page, 6000); });

  // 2 · the deposit (real send output, replayed)
  await scene(2, 'A shielded deposit with the cap in the memo.', async () => {
    await page.goto(fileUrl(termFile)); await L.injectOverlay(page);
    await (async()=>{})(0, 'Funder wallet', 'A shielded deposit with the cap in the memo.');
    await line(`<span class="d"># funder wallet (testnet): send TAZ to the purse with the cap in the encrypted memo</span>`);
    await L.hold(page, 1000);
    await line([
      `<span class="p">$</span> zcash-devtool wallet -w wallets/funder send ${BS}`,
      `    --address ${esc(PURSE.slice(0, 28))}…${esc(PURSE.slice(-6))} ${BS}`,
      `    --value 5000000  <span class="d"># 0.05 TAZ</span> ${BS}`,
      `    --memo "<span class="h">fund cap=300 INR</span> reply=${esc(FUNDER_REPLY.slice(0, 20))}…"`,
    ].join(NL));
    await L.hold(page, 1500);
    for (const l of SEND_LOG.split(/\r?\n/)) {
      if (!l.trim()) continue;
      const isTx = /^\s*[0-9a-f]{64}\s*$/.test(l);
      await line(`<span class="${isTx ? 'ok' : 'd'}">${esc(l.slice(0, 160))}</span>`);
      await L.hold(page, isTx ? 600 : 120);
    }
    await line(`${NL}<span class="ok">✓ sent.</span> txid <span class="h">${TXID}</span>${NL}<span class="d">amount and memo are encrypted on-chain; only the purse can read "fund cap=300 INR".</span>`);
    await L.hold(page, 3500);
  });

  // 3 · the explorer sees nothing readable
  await scene(3, 'On the public explorer: a shielded transaction, nothing readable.', async () => {
    await page.goto(`https://testnet.zcashexplorer.app/transactions/${TXID}`, { waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => {});
    await L.hold(page, 1500);
    await L.injectOverlay(page);
    await (async()=>{})(0, 'Public explorer', 'Shielded: the amount and the memo are not visible.');
    await L.hold(page, 3000);
    await page.mouse.wheel(0, 500); await L.hold(page, 3500);
  });

  // 10 · receipt verifier
  await scene(12, 'Receipts come back as encrypted memos. Anyone holding one can verify it.', async () => {
    await page.goto(L.FRONTEND + '/login', { waitUntil: 'domcontentloaded' });
    await page.fill('#password', PASSWORD); await page.keyboard.press('Enter');
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.goto(L.FRONTEND + '/verify', { waitUntil: 'networkidle' }).catch(() => {});
    await L.injectOverlay(page);
    await (async()=>{})(0, 'Receipt memo', 'Decrypted in the funder wallet, checked against Bitrefill.');
    await L.hold(page, 800);
    await L.typeInto(page, '#memo', RECEIPT);
    await L.hold(page, 400);
    await L.clickEl(page, '#go', { settle: 600 });
    await page.waitForSelector('#out:not([hidden])', { timeout: 20000 }).catch(() => {});
    await L.hold(page, 5000);
  });

  // 12 · privacy page
  await scene(17, 'What it reveals, to whom.', async () => {
    await page.goto(L.FRONTEND + '/privacy', { waitUntil: 'networkidle' }).catch(() => {});
    await L.injectOverlay(page);
    await (async()=>{})(0, 'Privacy', 'What each party can see.');
    await L.hold(page, 2500);
    await page.mouse.wheel(0, 450); await L.hold(page, 3000);
  });

  // 13 · close on the README
  await scene(18, 'github.com/0xStoneyStark/munim', async () => {
    await page.goto('https://github.com/0xStoneyStark/munim', { waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => {});
    await L.hold(page, 1500);
    await L.injectOverlay(page);
    await (async()=>{})(0, 'Open source · MIT', 'github.com/0xStoneyStark/munim');
    await L.hold(page, 2500);
    await page.mouse.wheel(0, 700); await L.hold(page, 3500);
  });

  const out = await rec.finish(ROOT + '/clips/lap.mp4');
  fs.writeFileSync(ROOT + '/timeline-lap.json', JSON.stringify({ videos: { lap: out.mp4 }, scenes: timeline }, null, 2));
  console.log('lap video:', out.mp4, out.frames, 'frames');
  await browser.close();
})();
