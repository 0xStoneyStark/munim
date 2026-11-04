// walk-deposit.cjs — records the funder's shielded deposit: a real zcash-devtool
// send, its live output rendered in a browser "terminal", then the txid.
//   node walk-deposit.cjs   (writes timeline-deposit.json, clips/deposit/*.webm)
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const L = require('./lib.cjs');
const cfg = L.cfg;
const ROOT = cfg.dir;
const REPO = path.resolve(ROOT, '..');
const NL = String.fromCharCode(10);
const BS = String.fromCharCode(92);
const env = Object.fromEntries(fs.readFileSync(REPO + '/.env', 'utf8').split(/\r?\n/).filter(l => /^[A-Z_]+=/.test(l)).map(l => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).replace(/^"|"$/g, '')]; }));
const DEVTOOL = env.ZCASH_DEVTOOL;
const PURSE = JSON.parse(fs.readFileSync(REPO + '/data/ledger.json', 'utf8')).address;
const FUNDER_REPLY = fs.readFileSync(ROOT + '/funder-address.txt', 'utf8').trim();
const CAP = 300, ZATS = 5000000;
const MEMO = `fund cap=${CAP} INR reply=${FUNDER_REPLY}`;
const OUT = ROOT + '/clips/deposit';

const TERM_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;height:100%;background:#0b0b0d;color:#e6e6e6;font:22px/1.5 "Cascadia Mono","Consolas",monospace}
#wrap{padding:48px 64px;white-space:pre-wrap;word-break:break-all}
.p{color:#f4b728}.d{color:#8a8a94}.ok{color:#5ad17a}.h{color:#fff;font-weight:700}
</style></head><body><div id="wrap"></div></body></html>`;

(async () => {
  const { chromium } = require(cfg.playwright);
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  const ctx = await browser.newContext({ viewport: cfg.view, recordVideo: { dir: OUT, size: cfg.view }, deviceScaleFactor: 1 });
  const page = await ctx.newPage(); const t0 = Date.now();
  const timeline = [];
  const tfile = ROOT + '/term.html';
  fs.writeFileSync(tfile, TERM_HTML);
  await page.goto('file:///' + tfile.split(path.sep).join('/'));
  await L.injectOverlay(page);
  const line = (html) => page.evaluate((h) => { const w = document.getElementById('wrap'); w.insertAdjacentHTML('beforeend', h + String.fromCharCode(10)); window.scrollTo(0, document.body.scrollHeight); }, html);
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

  const start = Date.now() - t0;
  await L.caption(page, 'Funder wallet', 'A shielded deposit with the cap in the memo.');
  await line(`<span class="d"># funder wallet (testnet): send TAZ to the purse with the cap in the encrypted memo</span>`);
  await L.hold(page, 1200);
  const cmd = [
    `<span class="p">$</span> zcash-devtool wallet -w wallets/funder send ${BS}`,
    `    --address ${esc(PURSE.slice(0, 28))}…${esc(PURSE.slice(-6))} ${BS}`,
    `    --value ${ZATS}  <span class="d"># 0.05 TAZ</span> ${BS}`,
    `    --memo "<span class="h">fund cap=${CAP} INR</span> reply=${esc(FUNDER_REPLY.slice(0, 20))}…"`,
  ].join(NL);
  await line(cmd);
  await L.hold(page, 1500);
  const args = ['wallet', '-w', REPO + '/wallets/funder', 'send', '-i', REPO + '/wallets/funder-identity.txt', '--address', PURSE, '--value', String(ZATS), '-s', 'zecrocks', '--memo', MEMO];
  const txid = await new Promise((resolve) => {
    const child = spawn(DEVTOOL, args, { env: { ...process.env, RUST_LOG: 'warn' } });
    let buf = ''; let found = null; let chain = Promise.resolve();
    const onData = (d) => {
      const s = d.toString(); buf += s;
      for (const l of s.split(/\r?\n/)) {
        if (!l.trim()) continue;
        const m = /^\s*([0-9a-f]{64})\s*$/.exec(l);
        if (m) found = m[1];
        const html = `<span class="${m ? 'ok' : 'd'}">${esc(l.slice(0, 160))}</span>`;
        chain = chain.then(() => line(html)).catch(() => {});
      }
    };
    child.stdout.on('data', onData); child.stderr.on('data', onData);
    child.on('close', () => { fs.writeFileSync(ROOT + '/deposit-send.log', buf); chain.then(() => resolve(found)); });
  });
  if (txid) {
    await line(`${NL}<span class="ok">✓ sent.</span> txid <span class="h">${txid}</span>${NL}<span class="d">memo and amount are encrypted on-chain; only the purse can read "fund cap=${CAP} INR".</span>`);
    fs.writeFileSync(ROOT + '/deposit-txid.txt', txid);
  } else {
    await line(`<span style="color:#ff6b6b">send failed — see deposit-send.log</span>`);
  }
  await L.hold(page, 4000);
  const end = Date.now() - t0;
  timeline.push({ scene: 2, ctx: 'deposit', start, end, caption: 'A shielded deposit with the cap in the memo.' });
  await ctx.close();
  const vid = fs.readdirSync(OUT).filter(f => f.endsWith('.webm')).map(f => OUT + '/' + f).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
  fs.writeFileSync(ROOT + '/timeline-deposit.json', JSON.stringify({ videos: { deposit: vid }, scenes: timeline }, null, 2));
  console.log('txid:', txid, '| scene', ((end - start) / 1000).toFixed(1) + 's', '|', vid);
  await browser.close();
})();
