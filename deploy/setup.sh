#!/usr/bin/env bash
# Munim deploy for THE EXISTING Hetzner box (Ubuntu 24.04, root, nginx + certbot + pm2,
# Node 20 which must NOT be upgraded). Idempotent: safe to re-run after every `git push`.
#
#   scp -r deploy root@46.62.219.71:/root/munim-deploy
#   ssh root@46.62.219.71 'bash /root/munim-deploy/setup.sh'
#   (or, once deploy/ is pushed:  ssh root@46.62.219.71 'bash -s' < deploy/setup.sh)
#
# What it does: creates /opt/munim/{app,tools,logs,backups}; git pull + npm install;
# builds zcash-devtool only if its binary is missing; installs the nginx site and reloads
# nginx; runs certbot if there is no certificate yet and DNS already points here; starts
# munim-dashboard + munim-agent under pm2 and `pm2 save`s.
# It never creates users, touches other sites, upgrades Node, or edits .env / data / wallets.
#
# Env overrides: DOMAIN, REPO_URL, DEVTOOL_REF, CERTBOT_EMAIL, SKIP_CERTBOT=1, SKIP_PM2=1.

main() {
  exec </dev/null   # keep children from eating the script when run as `bash -s`
  set -euo pipefail

  local BASE=/opt/munim
  local APP="$BASE/app"
  local DEVTOOL_DIR="$BASE/tools/zcash-devtool"
  local DEVTOOL_BIN="$DEVTOOL_DIR/target/release/zcash-devtool"
  local DOMAIN="${DOMAIN:-munim.heneryshop.com}"
  local REPO_URL="${REPO_URL:-https://github.com/0xStoneyStark/munim}"
  # Commit the laptop wallet was created/built with; only used when cloning devtool fresh.
  local DEVTOOL_REF="${DEVTOOL_REF:-0b3436bb8d235c67cd36b800cb45a7b1b489c415}"
  local SITE=munim
  local SRC_SELF="${BASH_SOURCE[0]:-}"

  say() { printf '\n==> %s\n' "$*"; }
  warn() { printf 'WARNING: %s\n' "$*" >&2; }
  die() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }

  [ "$(id -u)" -eq 0 ] || die "run as root"
  for t in git npm node nginx certbot pm2; do
    command -v "$t" >/dev/null 2>&1 || die "$t not found in PATH (expected on this box)"
  done

  # ---- Node: verify, never upgrade ------------------------------------------
  local nodev; nodev="$(node -v)"
  say "node $nodev, npm $(npm -v), pm2 $(pm2 -v 2>/dev/null | tail -1)"
  [ "${nodev#v}" ] && [ "$(echo "${nodev#v}" | cut -d. -f1)" -ge 20 ] \
    || die "Node >= 20 required (found $nodev). Do not upgrade the system Node; use another approach."

  # ---- Directories ----------------------------------------------------------
  say "directories"
  mkdir -p "$BASE/app" "$BASE/tools" "$BASE/logs" "$BASE/backups"
  chmod 700 "$BASE/backups"

  # ---- App checkout ---------------------------------------------------------
  if [ -d "$APP/.git" ]; then
    say "git pull (fast-forward only)"
    git -C "$APP" pull --ff-only || warn "git pull --ff-only failed (local changes or diverged); continuing with the current checkout"
  else
    [ -z "$(ls -A "$APP" 2>/dev/null || true)" ] || die "$APP is not a git checkout and is not empty"
    say "cloning $REPO_URL"
    GIT_TERMINAL_PROMPT=0 git clone "$REPO_URL" "$APP" || die "git clone failed (private repo? add a deploy key)"
  fi
  mkdir -p "$APP/data" "$APP/wallets"
  chmod 700 "$APP/data" "$APP/wallets"
  [ ! -e "$APP/.env" ] || chmod 600 "$APP/.env"
  # Rules live in data/ on the server (RULES_FILE) so `git pull` never conflicts with dashboard edits.
  if [ ! -e "$APP/data/rules.json" ] && [ -e "$APP/apps/munim/rules.json" ]; then
    cp "$APP/apps/munim/rules.json" "$APP/data/rules.json"
  fi

  say "npm install (dev dependencies stay: the app runs through tsx)"
  ( cd "$APP" && npm install --no-audit --no-fund )

  # ---- zcash-devtool (only if the binary is missing) -------------------------
  if [ -x "$DEVTOOL_BIN" ]; then
    say "zcash-devtool binary present ($DEVTOOL_BIN)"
  elif pgrep -f 'cargo build' >/dev/null 2>&1; then
    warn "a cargo build is running; NOT starting a second one. Watch: tail -f $BASE/devtool-build.log"
    warn "re-run this script when it has finished."
  else
    say "building zcash-devtool (6+ minutes; 3.7 GB RAM box: if it OOMs re-run with CARGO_BUILD_JOBS=1)"
    export PATH="$HOME/.cargo/bin:$PATH"
    if ! command -v cargo >/dev/null 2>&1; then
      curl -fsSL https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain stable
      export PATH="$HOME/.cargo/bin:$PATH"
    fi
    if [ ! -d "$DEVTOOL_DIR/.git" ]; then
      git clone https://github.com/zcash/zcash-devtool "$DEVTOOL_DIR"
      git -C "$DEVTOOL_DIR" checkout --quiet "$DEVTOOL_REF"
    fi
    ( cd "$DEVTOOL_DIR" && cargo build --release 2>&1 | tee -a "$BASE/devtool-build.log" )
  fi
  if [ -x "$DEVTOOL_BIN" ]; then
    echo "devtool commit: $(git -C "$DEVTOOL_DIR" rev-parse --short HEAD 2>/dev/null || echo unknown) (laptop wallet was built with ${DEVTOOL_REF:0:7})"
  fi

  # ---- Locate the deploy files (next to this script, or inside the checkout) ---
  local SRC="" cand
  for cand in "$(dirname "${SRC_SELF:-/nonexistent/x}")" "$APP/deploy"; do
    if [ -f "$cand/nginx-munim.conf" ] && [ -f "$cand/ecosystem.config.cjs" ]; then SRC="$cand"; break; fi
  done
  [ -n "$SRC" ] || die "nginx-munim.conf / ecosystem.config.cjs not found next to this script or in $APP/deploy (scp -r deploy first)"
  install -m 644 "$SRC/ecosystem.config.cjs" "$BASE/ecosystem.config.cjs"

  # ---- nginx ------------------------------------------------------------------
  local AVAIL="/etc/nginx/sites-available/$SITE" ENABLED="/etc/nginx/sites-enabled/$SITE"
  if [ -f "$AVAIL" ] && grep -q ssl_certificate "$AVAIL"; then
    say "nginx site already has TLS (certbot edited it); leaving $AVAIL untouched"
  else
    say "installing nginx site $AVAIL"
    install -m 644 "$SRC/nginx-munim.conf" "$AVAIL"
    [ "$DOMAIN" = munim.heneryshop.com ] || sed -i "s/munim\.heneryshop\.com/$DOMAIN/g" "$AVAIL"
  fi
  ln -sfn "$AVAIL" "$ENABLED"
  nginx -t
  systemctl reload nginx

  # ---- certbot (HTTP-01) --------------------------------------------------------
  if [ -d "/etc/letsencrypt/live/$DOMAIN" ]; then
    say "certificate for $DOMAIN already exists"
  elif [ "${SKIP_CERTBOT:-0}" = 1 ]; then
    say "SKIP_CERTBOT=1: not requesting a certificate"
  else
    local resolved; resolved="$(getent ahostsv4 "$DOMAIN" 2>/dev/null | awk '{print $1; exit}' || true)"
    if [ -z "$resolved" ]; then
      warn "$DOMAIN does not resolve yet; add the DNS record, then re-run (certbot skipped)"
    elif ! hostname -I | tr ' ' '\n' | grep -qx "$resolved"; then
      warn "$DOMAIN resolves to $resolved, which is not an address of this box (Cloudflare proxy on? must be DNS only). certbot skipped"
    else
      say "certbot --nginx -d $DOMAIN --redirect"
      local acct=()
      if [ -n "${CERTBOT_EMAIL:-}" ]; then acct=(-m "$CERTBOT_EMAIL")
      elif [ -z "$(ls -A /etc/letsencrypt/accounts 2>/dev/null || true)" ]; then acct=(--register-unsafely-without-email)
      fi
      certbot --nginx -d "$DOMAIN" --redirect --non-interactive --agree-tos "${acct[@]}"
      nginx -t && systemctl reload nginx
    fi
  fi

  # ---- pm2 ------------------------------------------------------------------------
  local ONLY=""
  if [ "${SKIP_PM2:-0}" = 1 ]; then
    say "SKIP_PM2=1: not touching pm2"
  elif [ ! -f "$APP/.env" ] || [ ! -e "$APP/wallets/agent-identity.txt" ]; then
    warn ".env and/or wallets/agent-identity.txt missing: not starting pm2 apps yet (run the sync script, then re-run this)"
  else
    local pw host
    pw="$(grep -E '^DASHBOARD_PASSWORD=.+' "$APP/.env" || true)"
    host="$(grep -E '^DASHBOARD_HOST=' "$APP/.env" | tail -1 | cut -d= -f2- | tr -d '\r"'"'"' ' || true)"
    ONLY="munim-agent"
    if [ -n "$pw" ] && { [ -z "$host" ] || [ "$host" = 127.0.0.1 ] || [ "$host" = localhost ]; }; then
      ONLY="munim-dashboard,munim-agent"
    else
      warn "DASHBOARD_PASSWORD unset or DASHBOARD_HOST not loopback: dashboard NOT started (fail closed)"
    fi
    say "pm2 startOrReload --only $ONLY"
    pm2 startOrReload "$BASE/ecosystem.config.cjs" --only "$ONLY" --update-env
    pm2 save
  fi

  cat <<EOF

================================ DONE ================================
App:      $APP        Logs: $BASE/logs/*.log  (pm2 logs munim-agent)
nginx:    $AVAIL  ->  http://127.0.0.1:8788
URL:      https://$DOMAIN     pm2 apps started: ${ONLY:-none}

If anything printed WARNING above, fix it and re-run this script. Typical order:
 1. DNS (Cloudflare, DNS only): A munim -> this server's IPv4
 2. from the laptop: deploy/sync-from-laptop.ps1 (or .sh)
 3. on the server, set DASHBOARD_PASSWORD in $APP/.env (see deploy/README-deploy.md)
 4. rm -f $APP/data/swiggy-client.json $APP/data/swiggy-tokens.json, then re-run this script
 5. Optional bot:  pm2 start $BASE/ecosystem.config.cjs --only munim-telegram && pm2 save
======================================================================
EOF
}

main "$@"
