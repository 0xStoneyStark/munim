#!/usr/bin/env bash
# Copy .env, the agent wallets and data/ from this laptop to the Munim box, then restart pm2 apps.
#
#   ./deploy/sync-from-laptop.sh                      # defaults below
#   HOST=46.62.219.71 ./deploy/sync-from-laptop.sh
#   ./deploy/sync-from-laptop.sh --force              # overwrite state that already exists on the server
#
# Env: HOST (or first arg; default 46.62.219.71), SSH_USER (default root),
#      SSH_KEY (default D:\fomo-copytrade\secrets\hetzner_ed25519, used if the file exists),
#      SSH_OPTS (extra ssh flags), DOMAIN (default munim.heneryshop.com), FORCE=1.
# Key-based ssh only; uses scp (ships with OpenSSH / Git Bash).
#
# !! SECURITY: .env holds LIVE keys (Anthropic, Bitrefill = real money/credit, Telegram).
# !! wallets/agent-identity.txt + wallets/agent hold the purse SPEND key (testnet ZEC today).
# !! Only the agent wallets are copied: wallets/funder* never leaves the laptop.
#
# Safe by default: if the server already has a .env or ledger, nothing is overwritten
# (the server's ledger is the source of truth for the spending cap). Use --force to replace it.
set -euo pipefail

HOST_ARG=""
FORCE="${FORCE:-0}"
for a in "$@"; do
  case "$a" in
    --force|-f) FORCE=1 ;;
    -*) echo "unknown option $a" >&2; exit 2 ;;
    *) HOST_ARG="$a" ;;
  esac
done
HOST="${HOST_ARG:-${HOST:-46.62.219.71}}"
SSH_USER="${SSH_USER:-root}"
DOMAIN="${DOMAIN:-munim.heneryshop.com}"
REMOTE="$SSH_USER@$HOST"
APP=/opt/munim/app

KEY="${SSH_KEY:-}"
if [ -z "$KEY" ]; then
  for k in "/d/fomo-copytrade/secrets/hetzner_ed25519" "D:/fomo-copytrade/secrets/hetzner_ed25519"; do
    [ -f "$k" ] && { KEY="$k"; break; }
  done
fi
# shellcheck disable=SC2206
SSH_OPTS_ARR=(-o StrictHostKeyChecking=accept-new -o BatchMode=yes -o IdentitiesOnly=yes ${SSH_OPTS:-})
[ -z "$KEY" ] || SSH_OPTS_ARR+=(-i "$KEY")
rssh() { ssh "${SSH_OPTS_ARR[@]}" "$REMOTE" "$@"; }
rscp() { scp -q "${SSH_OPTS_ARR[@]}" "$@"; }

cd "$(dirname "${BASH_SOURCE[0]}")/.."
for f in .env wallets/agent wallets/agent-view wallets/agent-identity.txt data; do
  [ -e "$f" ] || { echo "missing $PWD/$f" >&2; exit 1; }
done

has_state=$(rssh "test -e $APP/.env -o -e $APP/data/ledger.json && echo yes || echo no")
if [ "$has_state" = yes ] && [ "$FORCE" != 1 ]; then
  echo "Server already has .env / ledger: NOT overwriting (re-run with --force to replace). Restarting apps only."
  COPIED=0
else
  COPIED=1
  echo "Stopping pm2 apps and copying .env, wallets/agent*, data/ to $REMOTE ..."
  rssh "pm2 stop munim-telegram munim-dashboard munim-agent >/dev/null 2>&1 || true;
        mkdir -p $APP/data $APP/wallets;
        [ ! -f $APP/.env ] || install -m 600 $APP/.env /opt/munim/backups/env.prev"
  rscp .env "$REMOTE:$APP/.env"
  rscp -r wallets/agent wallets/agent-view wallets/agent-identity.txt "$REMOTE:$APP/wallets/"
  rscp -r data "$REMOTE:$APP/"
  # The server keeps its rules in data/rules.json (RULES_FILE) so git pull never conflicts.
  if [ ! -f data/rules.json ] && [ -f apps/munim/rules.json ]; then
    rscp apps/munim/rules.json "$REMOTE:$APP/data/rules.json"
  fi
fi

rssh "COPIED=$COPIED DOMAIN=$DOMAIN APP=$APP bash -s" <<'REMOTE_SCRIPT'
set -eu
ENVF="$APP/.env"
PREV=/opt/munim/backups/env.prev
if [ "$COPIED" = 1 ]; then
  set_env() {
    if grep -q "^$1=" "$ENVF"; then sed -i "s|^$1=.*|$1=$2|" "$ENVF"; else printf '%s=%s\n' "$1" "$2" >> "$ENVF"; fi
  }
  # Keep the server's login password / session secret across a --force re-sync.
  for k in DASHBOARD_PASSWORD DASHBOARD_SESSION_SECRET; do
    if [ -f "$PREV" ] && ! grep -Eq "^$k=.+" "$ENVF"; then grep -E "^$k=.+" "$PREV" >> "$ENVF" || true; fi
  done
  set_env ZCASH_DEVTOOL /opt/munim/tools/zcash-devtool/target/release/zcash-devtool
  set_env PURSE_WALLET_DIR ./wallets/agent
  set_env PURSE_IDENTITY ./wallets/agent-identity.txt
  set_env PURSE_VIEW_WALLET_DIR ./wallets/agent-view
  set_env DASHBOARD_HOST 127.0.0.1
  set_env DASHBOARD_PORT 8788
  set_env DASHBOARD_SECURE_COOKIES 1
  set_env PUBLIC_BASE_URL "https://$DOMAIN"
  set_env RULES_FILE "$APP/data/rules.json"
  rm -f "$PREV"
fi
chmod 700 "$APP/data" "$APP/wallets"
chmod 600 "$ENVF"
PW=1
if ! grep -Eq '^DASHBOARD_PASSWORD=.+' "$ENVF"; then
  PW=0
  echo
  echo "!! DASHBOARD_PASSWORD is not set in $ENVF - the dashboard is left stopped (fail closed)."
  echo "!! On the server:  echo \"DASHBOARD_PASSWORD=\$(openssl rand -base64 24)\" >> $ENVF"
  echo "!! then:           bash /root/munim-deploy/setup.sh   (or pm2 restart munim-dashboard)"
fi
if ! command -v pm2 >/dev/null 2>&1 || ! pm2 describe munim-agent >/dev/null 2>&1; then
  echo "pm2 apps not defined yet: run deploy/setup.sh on the server to create and start them."
else
  pm2 restart munim-agent
  if [ "$PW" = 1 ]; then pm2 restart munim-dashboard || pm2 start /opt/munim/ecosystem.config.cjs --only munim-dashboard; fi
  pm2 save >/dev/null
  pm2 list | grep -E 'munim|name' || true
fi
REMOTE_SCRIPT

echo "Done. Logs: ssh $REMOTE 'pm2 logs munim-agent'   (files in /opt/munim/logs/)"
