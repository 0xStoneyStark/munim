# Deploying Munim to https://munim.heneryshop.com

Target: the **existing** Hetzner CX23 (Ubuntu 24.04, 2 vCPU, 3.7 GB RAM, `root@46.62.219.71`) that already serves other sites. Munim is added alongside them; nothing else on the box is touched.

```
Internet --443--> nginx (certbot cert) --> 127.0.0.1:8788  munim-dashboard  (pm2)
                                           munim-agent (pm2, no port)
                                           munim-telegram (pm2, optional, not started)
```

| File | What it does |
|---|---|
| `setup.sh` | Idempotent deploy for this box: dirs, git pull, `npm install`, devtool build if missing, nginx site, certbot, pm2 start + save |
| `nginx-munim.conf` | `sites-available` server block for munim.heneryshop.com -> `127.0.0.1:8788` with security headers |
| `ecosystem.config.cjs` | pm2 apps `munim-dashboard`, `munim-agent`, `munim-telegram` (installed to `/opt/munim/ecosystem.config.cjs`) |
| `sync-from-laptop.ps1` / `.sh` | Copy `.env`, agent wallets, `data/` to the server and restart the pm2 apps |

Paths on the server: `/opt/munim/{app,tools,logs,backups}`; app logs are `/opt/munim/logs/<app>.out.log` and `.err.log`.

## State of the box (already done by the coordinator)

- `/opt/munim/app` is a git clone with `npm install` done.
- `/opt/munim/tools/zcash-devtool` is building (`tail -f /opt/munim/devtool-build.log`). `setup.sh` will not start a second build while one runs and skips it when the binary exists.
- Check the devtool commit matches the laptop wallet's build: `git -C /opt/munim/tools/zcash-devtool rev-parse --short HEAD` should be `0b3436b`. A different commit usually still opens the wallet (migrations only move forward), but then do not go back to an older one.
- Memory: 3.7 GB shared with other apps. If the build is OOM-killed (`dmesg | grep -i kill`), add swap (`fallocate -l 4G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile`) and re-run with `CARGO_BUILD_JOBS=1`.

## Node 20 compatibility (system Node stays at v20.20.2; do not upgrade it)

Checked on the laptop with the real Node v20.20.2 binary (npm package `node@20.20.2`) and this repo's `tsx`:

- Dependency engines: `tsx` >=18, `@modelcontextprotocol/sdk` >=18, `dotenv` >=12; `@anthropic-ai/sdk`, `zod`, `@noir-wallet/sdk` declare none.
- A search of `apps/` and `packages/` for post-Node-20 APIs (`Promise.withResolvers`, `Array.fromAsync`, `fs.glob`, `node:sqlite`, `Set` union/intersection, `Object.groupBy`, `import.meta.dirname`, iterator helpers) found none. The only newer-looking one is `AbortSignal.any` in `telegram.ts`, which needs Node 20.3+, so v20.20.2 is fine. `fetch` and `crypto` are core in 20.
- 12 modules (`swiggy-oauth`, `rules`, `api`, `api-views`, `bitrefill`, `fx`, `travel`, `rule-builder`, `mcp-client`, `google-mcp`, `swiggy-money`, `instamart`) import cleanly under Node 20 via `tsx`; `telegram.ts` starts and stops with its normal "TELEGRAM_BOT_TOKEN is not set" message; `dashboard.ts` boots on Node 20 and answers `GET /` and `GET /api` with 200.
- With `PUBLIC_BASE_URL=https://munim.heneryshop.com` the Swiggy `REDIRECT_URI` evaluates to `https://munim.heneryshop.com/oauth/swiggy/callback`.
- Not exercised: the agent loop against live APIs (needs keys) and the Rust/devtool path on the server. Confirm on the box after sync with `node -v` and `cd /opt/munim/app && npm run check`.

## 1. DNS in Cloudflare (domain heneryshop.com, with the "e")

1. Cloudflare dashboard -> select `heneryshop.com` -> **DNS** -> **Records** -> **Add record**.
2. Type `A`, Name `munim`, IPv4 address `46.62.219.71`, **Proxy status: DNS only** (grey cloud), TTL Auto. Save.
3. Keep it grey: certbot's HTTP-01 check and the direct `X-Forwarded-For` client IP both rely on traffic reaching nginx directly. (`setup.sh` skips certbot with a warning if the name resolves to anything other than this box.)
4. Verify: `nslookup munim.heneryshop.com` shows 46.62.219.71 (it may take a minute).

## 2. Deploy the app side

From the repo root on the laptop. `deploy/` is a new, uncommitted folder, so copy it rather than relying on git:

```powershell
$k = 'D:\fomo-copytrade\secrets\hetzner_ed25519'
scp -i $k -r deploy root@46.62.219.71:/root/munim-deploy
ssh -i $k root@46.62.219.71 'bash /root/munim-deploy/setup.sh'
```

(Once `deploy/` is pushed to GitHub, `ssh ... 'bash -s' < deploy/setup.sh` also works.) On this first run `.env` is not there yet, so the script installs nginx, requests the certificate if DNS is ready, and **does not start pm2 apps**; it says so. nginx install is HTTP-only on purpose: certbot adds the 443 block and the redirect to the same file, and later runs of `setup.sh` leave a certbot-edited file alone. The equivalent manual command is:

```bash
certbot --nginx -d munim.heneryshop.com --redirect
```

Renewal uses the box's existing certbot timer (`systemctl list-timers | grep certbot`).

## 3. Copy secrets and state from the laptop

```powershell
.\deploy\sync-from-laptop.ps1            # defaults: root@46.62.219.71 with D:\fomo-copytrade\secrets\hetzner_ed25519
.\deploy\sync-from-laptop.ps1 -HostName <ip> -SshKey <path>   # override
```

```bash
./deploy/sync-from-laptop.sh             # Git Bash / WSL; HOST, SSH_KEY, SSH_USER env also work
```

It copies `.env`, `wallets/agent`, `wallets/agent-view`, `wallets/agent-identity.txt` and `data/` to `/opt/munim/app`. `wallets/funder*` is deliberately **not** copied: the funder key stays on the laptop. Then it pins the server `.env` values, sets modes (`.env` 600, `data/` and `wallets/` 700), and restarts the pm2 apps.

If the server already has a `.env` or `data/ledger.json`, a re-run overwrites nothing and only restarts; the server's ledger is the source of truth for the spending cap. `--force` / `-Force` replaces it (the old `.env` is kept at `/opt/munim/backups/env.prev` during the run, and the server's `DASHBOARD_PASSWORD` is carried over).

### Server `.env` values

The sync script writes these on the first copy (the laptop `.env` has `ZCASH_DEVTOOL=D:/...exe`, which is why it must). Check with `grep -E '^(ZCASH|PURSE|DASHBOARD|PUBLIC|RULES)' /opt/munim/app/.env`:

```
ZCASH_DEVTOOL=/opt/munim/tools/zcash-devtool/target/release/zcash-devtool
PURSE_WALLET_DIR=./wallets/agent
PURSE_IDENTITY=./wallets/agent-identity.txt
PURSE_VIEW_WALLET_DIR=./wallets/agent-view
DASHBOARD_HOST=127.0.0.1
DASHBOARD_PORT=8788
DASHBOARD_SECURE_COOKIES=1
PUBLIC_BASE_URL=https://munim.heneryshop.com
RULES_FILE=/opt/munim/app/data/rules.json
DASHBOARD_PASSWORD=<you set this, see below>
```

`RULES_FILE` is an addition to the list: it keeps dashboard-edited rules in `data/` so `git pull` never conflicts with the tracked `apps/munim/rules.json` (setup seeds it from that file).

**You set the password** (the scripts never generate or print one):

```bash
ssh -i D:\fomo-copytrade\secrets\hetzner_ed25519 root@46.62.219.71
echo "DASHBOARD_PASSWORD=$(openssl rand -base64 24)" >> /opt/munim/app/.env
grep '^DASHBOARD_PASSWORD' /opt/munim/app/.env     # copy it into your password manager
```

Optional: `DASHBOARD_SESSION_SECRET=<openssl rand -hex 32>` keeps logins valid across restarts (without it every restart logs everyone out).

**Fail closed.** The dashboard has to be public, and with no `DASHBOARD_PASSWORD` it runs with auth off. So the pm2 file leaves `munim-dashboard` out unless `.env` has a password and `DASHBOARD_HOST` is loopback, and `setup.sh` / the sync script start it only under the same condition (they print a `!!` warning otherwise).

### Swiggy OAuth for the public URL

`apps/munim/src/swiggy-oauth.ts` now honours `PUBLIC_BASE_URL` (the `localhost:<port>` form is only the fallback), so the registered redirect is `https://munim.heneryshop.com/oauth/swiggy/callback`. The code change has to be on the server: push it (the box does `git pull`). `data/swiggy-client.json` holds the *localhost* registration and the copied tokens are tied to that client, so remove both and sign in again from the public site:

```bash
rm -f /opt/munim/app/data/swiggy-client.json /opt/munim/app/data/swiggy-tokens.json
bash /root/munim-deploy/setup.sh      # pulls, restarts apps with the new code
```

Then open `https://munim.heneryshop.com`, log in, and visit `https://munim.heneryshop.com/swiggy/login` (Swiggy OTP).

## 4. Start and check

After the password is set, re-run `bash /root/munim-deploy/setup.sh` (or the sync script, which restarts). It runs `pm2 startOrReload /opt/munim/ecosystem.config.cjs --only munim-dashboard,munim-agent` and `pm2 save`.

```bash
pm2 list
pm2 logs munim-agent               # or: tail -f /opt/munim/logs/munim-agent.out.log
pm2 logs munim-dashboard --lines 50
curl -sI http://127.0.0.1:8788/ | head -1        # 200 locally
curl -sI https://munim.heneryshop.com | head -5  # headers via nginx
pm2 start /opt/munim/ecosystem.config.cjs --only munim-telegram && pm2 save   # optional bot
```

Then open https://munim.heneryshop.com, log in, and on Android Chrome use the three-dot menu -> **Install app**.

`pm2 save` stores the whole pm2 list (the box's other apps included), and pm2 must already be set to resurrect on boot: `systemctl is-enabled pm2-root` should say `enabled`; if not, run `pm2 startup` once. Log growth: if `pm2 ls` shows `pm2-logrotate` is not installed, `pm2 install pm2-logrotate` keeps `/opt/munim/logs` bounded.

Troubleshooting: `nginx -t` fails on a duplicate `map`/variable -> the conf uses `$munim_connection_upgrade` to avoid that, so look at the named file in the error. Certbot refused -> DNS record missing, still orange-cloud, or another server answers port 80 for that name. 502 -> dashboard not running (`pm2 list`, usually the missing password). `/export.csv` can take up to 5 minutes; nginx allows 330 s.

## 5. Security notes

**Known weaknesses of this setup (accepted for now)**

- **Everything runs as root.** pm2 here runs as root and so do the Munim apps, with no sandbox. Any bug or dependency compromise in Munim (or in another app on the box) is root on the machine, and every other site and secret on it. The previous plan used a dedicated `munim` user and a systemd sandbox; moving to one later is the first hardening step.
- **Shared box.** Munim's `.env` and wallets sit on a server that also hosts `test.cttpl.com` and `combatgpt.cttpl.com`; anyone who can get shell on those apps can read them.
- **System Node 20 is past upstream end-of-life** (April 2026). It works (see above) but no longer gets upstream security fixes; if the box policy is to keep it, treat the dashboard's login and nginx as the front line and plan a separate Node for Munim only.
- Keep SSH key-only; nothing here changes `sshd` or `ufw`. Check `ufw status`/the Hetzner firewall: only 22/80/443 should be reachable. The dashboard binds `127.0.0.1` so port 8788 is not reachable from outside even if the firewall is open.

**What lives on the box**

| Item | Where | Impact if leaked |
|---|---|---|
| Purse spend key (agent wallet + identity) | `wallets/agent`, `wallets/agent-identity.txt` | Testnet ZEC today, so no real money; would be real funds on mainnet |
| Bitrefill API key | `.env` | Real money: it can buy gift cards from your Bitrefill balance |
| Anthropic API key | `.env` | Real credit: burns your API spend |
| Swiggy session / OAuth tokens | `data/swiggy-*.json` | Orders and Swiggy Money on your account |
| Google tokens (Gmail, Calendar) | `data/google-*.json`, `data/gmail-credentials.json` | Read access to your mail and calendar |
| Telegram bot token | `.env` | Someone can drive the bot (only allowed chat ids are served) |
| Ledger | `data/ledger.json` | Spending history and the cap state |

**Who can reach what**

- The internet reaches nginx (80/443). The dashboard and agent have no public port; the dashboard is only reachable through nginx on `127.0.0.1:8788`, which is why it binds loopback.
- The dashboard has its own password login and session cookie (`DASHBOARD_SECURE_COOKIES=1` marks it Secure; login attempts are rate limited in the app). For a second layer add `auth_basic` to the nginx location (example in `nginx-munim.conf`).
- `.env`, `data/` and `wallets/` are modes 600/700 (root only) and are git-ignored; never commit them.

**Rotating**

- Anthropic / Bitrefill: new key in their consoles, revoke the old, edit `.env`, `pm2 restart munim-agent munim-dashboard --update-env`.
- Dashboard password: new `openssl rand -base64 24` in `.env`, `pm2 restart munim-dashboard`.
- Swiggy: delete `data/swiggy-tokens.json`, restart, sign in again at `/swiggy/login`.
- Google: revoke at https://myaccount.google.com/permissions, re-authorise, re-copy the tokens.
- Telegram: `/revoke` in BotFather, update `TELEGRAM_BOT_TOKEN`.
- Purse: create a new wallet with `zcash-devtool` on the laptop, fund it, copy with `--force`, sweep the old. Never regenerate the existing wallet in place.

**Backups**: `data/` and `wallets/` exist only on the laptop and this server; copy them somewhere encrypted occasionally (`/opt/munim/backups` is mode 700 for that, but it is on the same disk). Losing `wallets/agent*` loses the purse.

## 6. Updating

```bash
ssh -i D:\fomo-copytrade\secrets\hetzner_ed25519 root@46.62.219.71 'bash /root/munim-deploy/setup.sh'
```

That does `git pull --ff-only`, `npm install`, reinstalls the nginx site (unless certbot already edited it) and the pm2 file, and restarts the apps; it never touches `.env`, `data/` or `wallets/`. By hand:

```bash
cd /opt/munim/app && git pull --ff-only && npm install --no-audit --no-fund
pm2 restart munim-dashboard munim-agent && pm2 save
```
