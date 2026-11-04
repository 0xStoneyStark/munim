// Recorder harness: launches a Playwright context that records video, injects a
// visible cursor (with click pulse) + a lower-third caption banner INTO the page
// (so recordVideo captures them), and exposes smooth move/click/type helpers
// that drive the real app like a live demo.
//
// Required by the per-project drive script (walk.cjs). Reads ./config.json.
const path = require('path');
const fs = require('fs');
const cfg = require('./_config.cjs').load();
const { chromium } = require(cfg.playwright);

const FRONTEND = cfg.frontend;
const VIEW = cfg.view;

// Runs in the page via page.evaluate(INIT, opts). Idempotent; persists through
// SPA client-side routing (only a full navigation wipes it — re-inject then).
const INIT = (opts) => {
  if (window.__overlayReady) return;
  window.__overlayReady = true;
  const accent = (opts && opts.accent) || '#D7284B';
  const css = `
    #__cur{position:fixed;left:0;top:0;width:24px;height:24px;z-index:2147483646;pointer-events:none;
      transform:translate(-120px,-120px);transition:transform .05s linear;}
    #__cur.__press::after{content:"";position:absolute;left:-10px;top:-10px;width:44px;height:44px;border-radius:50%;
      border:2px solid ${accent};animation:__pulse .5s ease-out forwards;}
    @keyframes __pulse{from{transform:scale(.2);opacity:.95}to{transform:scale(1.05);opacity:0}}
    #__cap{position:fixed;left:0;right:0;bottom:0;z-index:2147483645;pointer-events:none;
      padding:26px 52px 32px;background:linear-gradient(0deg,rgba(5,8,13,.94),rgba(5,8,13,0));
      display:flex;align-items:center;gap:18px;opacity:0;transition:opacity .3s ease;
      font-family:'Manrope','Helvetica Neue',Arial,sans-serif;}
    #__cap.__on{opacity:1;}
    #__cap .__tick{width:5px;height:42px;background:${accent};box-shadow:0 0 14px ${accent}88;flex:0 0 auto;}
    #__cap .__eb{font:700 12px/1 'JetBrains Mono','SF Mono',monospace;letter-spacing:.2em;color:${accent};
      margin-bottom:7px;text-transform:uppercase;}
    #__cap .__tx{font-size:32px;font-weight:600;letter-spacing:-.01em;color:#EEF1F6;line-height:1.15;
      text-shadow:0 1px 8px rgba(0,0,0,.6);}
  `;
  // Recording-time cleanups (no app code changed): caller-supplied CSS that
  // hides dev banners, branding to omit, etc.
  const clean = (opts && opts.cleanupCss) || '';
  const st = document.createElement('style'); st.textContent = css + clean;
  document.documentElement.appendChild(st);
  const cur = document.createElement('div');
  cur.id = '__cur';
  cur.innerHTML = '<svg width="24" height="24" viewBox="0 0 24 24"><path d="M3 2 L3 19 L7.5 14.5 L11 22 L14 20.5 L10.5 13.5 L17 13 Z" fill="#fff" stroke="#0A0F17" stroke-width="1.3" stroke-linejoin="round"/></svg>';
  const cap = document.createElement('div');
  cap.id = '__cap';
  cap.innerHTML = '<div class="__tick"></div><div><div class="__eb" id="__cap_eb"></div><div class="__tx" id="__cap_tx"></div></div>';
  const mount = () => {
    if (document.body) { document.body.appendChild(cur); document.body.appendChild(cap); }
    else { requestAnimationFrame(mount); }
  };
  mount();
  window.addEventListener('mousemove', (e) => { cur.style.transform = `translate(${e.clientX}px,${e.clientY}px)`; }, true);
  window.addEventListener('mousedown', () => { cur.classList.remove('__press'); void cur.offsetWidth; cur.classList.add('__press'); }, true);
  window.__setCap = (eb, tx) => {
    const c = document.getElementById('__cap');
    if (!c) return;
    if (tx == null) { c.classList.remove('__on'); return; }
    const e1 = document.getElementById('__cap_eb'); const t1 = document.getElementById('__cap_tx');
    if (e1) e1.textContent = eb || ''; if (t1) t1.textContent = tx;
    c.classList.add('__on');
  };
};

async function launch(outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  // deviceScaleFactor:1 — Playwright video records at CSS-pixel size regardless,
  // so a >viewport DPR buys nothing but breaks dense UIs. See gotchas.
  const ctx = await browser.newContext({ viewport: VIEW, recordVideo: { dir: outDir, size: VIEW }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  return { browser, ctx, page };
}

// Inject (or re-inject) the cursor + caption overlay. Call after every full load.
async function injectOverlay(page) {
  await page.evaluate(INIT, { cleanupCss: cfg.cleanupCss, accent: cfg.accent });
}

async function caption(page, eb, tx) {
  await page.evaluate(([a, b]) => window.__setCap && window.__setCap(a, b), [eb, tx]);
}

async function moveTo(page, target) {
  const loc = typeof target === 'string' ? page.locator(target).first() : target;
  await loc.scrollIntoViewIfNeeded().catch(() => {});
  const box = await loc.boundingBox();
  if (!box) throw new Error('no boundingBox for target');
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  await page.mouse.move(x, y, { steps: 30 });
  return { x, y };
}

async function clickEl(page, target, { settle = 350 } = {}) {
  const { x, y } = await moveTo(page, target);
  await page.waitForTimeout(200);
  await page.mouse.click(x, y);
  await page.waitForTimeout(settle);
}

async function typeInto(page, target, text) {
  const loc = typeof target === 'string' ? page.locator(target).first() : target;
  await moveTo(page, loc);
  await loc.click();
  await page.waitForTimeout(120);
  await loc.fill('');
  await page.keyboard.type(text, { delay: 60 });
}

const hold = (page, ms) => page.waitForTimeout(ms);

module.exports = { cfg, FRONTEND, VIEW, launch, injectOverlay, caption, moveTo, clickEl, typeInto, hold };
