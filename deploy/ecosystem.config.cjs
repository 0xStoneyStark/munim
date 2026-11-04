// pm2 process file for Munim on the shared Hetzner box (pm2 runs as root there).
//   pm2 start /opt/munim/ecosystem.config.cjs --only munim-dashboard,munim-agent && pm2 save
//   pm2 start /opt/munim/ecosystem.config.cjs --only munim-telegram     # optional bot
//
// pm2 has no env_file support. The app loads /opt/munim/app/.env itself (dotenv/config),
// and cwd is what makes that work, so cwd is the only thing set here.
//
// Fail closed: the public URL must never serve an unauthenticated dashboard, so the
// dashboard entry is left out unless .env has DASHBOARD_PASSWORD and does not move
// DASHBOARD_HOST off loopback.

const fs = require("node:fs");

const APP = process.env.MUNIM_APP || "/opt/munim/app"; // override only for local testing
const LOGS = process.env.MUNIM_LOGS || "/opt/munim/logs";

let env = "";
try {
  env = fs.readFileSync(`${APP}/.env`, "utf8");
} catch {
  throw new Error(`${APP}/.env is missing: copy it first (deploy/sync-from-laptop.sh)`);
}
const get = (key) => {
  const m = env.match(new RegExp(`^${key}=(.*)$`, "m"));
  return m ? m[1].trim().replace(/^["']|["']$/g, "") : "";
};
const dashboardSafe =
  get("DASHBOARD_PASSWORD") !== "" && ["", "127.0.0.1", "localhost", "::1"].includes(get("DASHBOARD_HOST"));
if (!dashboardSafe) {
  console.error("munim: DASHBOARD_PASSWORD unset or DASHBOARD_HOST not loopback; munim-dashboard NOT defined");
}

const base = (name, script, extra = {}) => ({
  name,
  cwd: APP,
  script: "npm",
  args: `run ${script}`,
  interpreter: "none",
  autorestart: true,
  restart_delay: 5000,
  max_restarts: 50,
  min_uptime: "10s",
  time: true,
  merge_logs: true,
  out_file: `${LOGS}/${name}.out.log`,
  error_file: `${LOGS}/${name}.err.log`,
  ...extra,
});

module.exports = {
  apps: [
    ...(dashboardSafe ? [base("munim-dashboard", "dashboard")] : []),
    base("munim-agent", "agent"),
    // Optional bot: restarts if it crashes, but is not started by a plain `pm2 start`.
    base("munim-telegram", "telegram", { autostart: false }),
  ],
};
