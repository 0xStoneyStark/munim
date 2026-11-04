// cast.cjs — record a Playwright page through Chrome's screencast (CDP) instead of
// Playwright's recordVideo (whose ffmpeg sidecar is unavailable here). Frames are
// written as JPEGs with wall-clock timestamps; finish() assembles an mp4 with
// exact per-frame durations, so scene windows measured with Date.now() line up.
//   const rec = await startCast(page, dir); ... const mp4 = await rec.finish();
const fs = require('fs');
const { execSync } = require('child_process');

async function startCast(page, dir, { width = 1920, height = 1080, quality = 85 } = {}) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const cdp = await page.context().newCDPSession(page);
  const frames = []; // { file, t }  t = ms since epoch
  let n = 0;
  cdp.on('Page.screencastFrame', async (ev) => {
    const file = `${dir}/f${String(n++).padStart(6, '0')}.jpg`;
    fs.writeFileSync(file, Buffer.from(ev.data, 'base64'));
    frames.push({ file, t: Date.now() });
    try { await cdp.send('Page.screencastFrameAck', { sessionId: ev.sessionId }); } catch {}
  });
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality, maxWidth: width, maxHeight: height, everyNthFrame: 1 });
  const t0 = Date.now();
  return {
    t0,
    async finish(outMp4) {
      // one last frame so the final hold is represented, then stop
      await page.waitForTimeout(150);
      try { await cdp.send('Page.stopScreencast'); } catch {}
      await page.waitForTimeout(200);
      const tEnd = Date.now();
      if (frames.length === 0) throw new Error('screencast produced no frames');
      // concat demuxer with per-frame durations; the first frame is held from t0
      const lines = [];
      for (let i = 0; i < frames.length; i++) {
        const start = i === 0 ? t0 : frames[i].t;
        const next = i + 1 < frames.length ? frames[i + 1].t : tEnd;
        const d = Math.max(0.01, (next - start) / 1000);
        lines.push(`file '${frames[i].file.replace(/\\/g, '/')}'`, `duration ${d.toFixed(3)}`);
      }
      lines.push(`file '${frames[frames.length - 1].file.replace(/\\/g, '/')}'`);
      const list = `${dir}/list.txt`;
      fs.writeFileSync(list, lines.join('\n'));
      execSync(`ffmpeg -y -loglevel error -f concat -safe 0 -i "${list}" -vf "scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,fps=30,format=yuv420p" -c:v libx264 -crf 18 -preset veryfast "${outMp4}"`, { stdio: 'pipe' });
      return { mp4: outMp4, frames: frames.length, t0, tEnd };
    },
  };
}

module.exports = { startCast };
