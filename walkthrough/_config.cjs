// Shared config loader. Reads <workdir>/config.json. The workdir is
// process.env.WV_DIR, or the current working directory (scripts are meant to be
// run from inside the workdir).
const fs = require('fs');
const path = require('path');

function load() {
  const dir = process.env.WV_DIR || process.cwd();
  const cfgPath = path.join(dir, 'config.json');
  const cfg = fs.existsSync(cfgPath) ? JSON.parse(fs.readFileSync(cfgPath, 'utf8')) : {};
  cfg.dir = dir;
  cfg.name = cfg.name || 'walkthrough';
  cfg.frontend = cfg.frontend || process.env.WV_FRONTEND || 'http://127.0.0.1:5173';
  cfg.view = cfg.view || { width: 1920, height: 1080 };
  // Where to require @playwright/test from. Point at an existing project install
  // (e.g. ".../frontend/node_modules/@playwright/test") or install in the workdir.
  cfg.playwright = cfg.playwright || process.env.WV_PLAYWRIGHT || '@playwright/test';
  cfg.cleanupCss = cfg.cleanupCss || '';     // recording-time CSS (hide dev banners etc.)
  cfg.speed = cfg.speed || {};               // { "<sceneNum>": speedFactor }
  cfg.voLeadMs = cfg.voLeadMs == null ? 250 : cfg.voLeadMs;
  cfg.accent = cfg.accent || '#D7284B';      // cursor + caption accent colour
  cfg.elevenlabs = cfg.elevenlabs || {};
  cfg.elevenlabs.model = cfg.elevenlabs.model || 'eleven_multilingual_v2';
  cfg.elevenlabs.voiceSettings = cfg.elevenlabs.voiceSettings ||
    { stability: 0.55, similarity_boost: 0.8, style: 0.15, use_speaker_boost: true };
  cfg.music = cfg.music || {};
  return cfg;
}

module.exports = { load };
