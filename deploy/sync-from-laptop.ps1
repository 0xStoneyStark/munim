<#
.SYNOPSIS
  Copy .env, the agent wallets and data/ from this laptop to the Munim box, then restart pm2 apps.

.EXAMPLE
  .\deploy\sync-from-laptop.ps1                       # defaults: root@46.62.219.71, key D:\fomo-copytrade\secrets\hetzner_ed25519
  .\deploy\sync-from-laptop.ps1 -HostName 203.0.113.7 -SshKey C:\keys\other
  .\deploy\sync-from-laptop.ps1 -Force                # overwrite state already on the server

.NOTES
  Needs the Windows OpenSSH client (ssh, scp) and key-based access.
  Params (env fallbacks in brackets): -HostName [HOST], -SshUser [SSH_USER], -SshKey [SSH_KEY],
          -Domain [DOMAIN], -Force.

  !! SECURITY: .env holds LIVE keys (Anthropic, Bitrefill = real money/credit, Telegram).
  !! wallets\agent-identity.txt + wallets\agent hold the purse SPEND key (testnet ZEC today).
  !! Only the agent wallets are copied: wallets\funder* never leaves the laptop.

  Safe by default: if the server already has a .env or ledger nothing is overwritten (the
  server's ledger is the source of truth for the spending cap); use -Force to replace it.
#>
param(
  [string]$HostName = $(if ($env:HOST) { $env:HOST } else { '46.62.219.71' }),
  [string]$SshUser = $(if ($env:SSH_USER) { $env:SSH_USER } else { 'root' }),
  [string]$SshKey = $(if ($env:SSH_KEY) { $env:SSH_KEY } else { 'D:\fomo-copytrade\secrets\hetzner_ed25519' }),
  [string]$Domain = $(if ($env:DOMAIN) { $env:DOMAIN } else { 'munim.heneryshop.com' }),
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
$remote = "$SshUser@$HostName"
$app = '/opt/munim/app'
$sshOpts = @('-o', 'StrictHostKeyChecking=accept-new', '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes')
if ($SshKey) {
  if (-not (Test-Path $SshKey)) { throw "ssh key not found: $SshKey (pass -SshKey)" }
  $sshOpts += @('-i', $SshKey)
}

function Invoke-Native([string]$exe, [string[]]$argList) {
  $out = & $exe @argList
  if ($LASTEXITCODE -ne 0) { throw "$exe failed (exit $LASTEXITCODE)" }
  $out
}
function Invoke-Remote([string]$cmd) { Invoke-Native 'ssh' ($sshOpts + @($remote, $cmd)) }

Set-Location (Join-Path $PSScriptRoot '..')
foreach ($f in '.env', 'wallets/agent', 'wallets/agent-view', 'wallets/agent-identity.txt', 'data') {
  if (-not (Test-Path $f)) { throw "missing $((Get-Location).Path)\$f" }
}

$hasState = (Invoke-Remote "test -e $app/.env -o -e $app/data/ledger.json && echo yes || echo no" | Out-String).Trim()
$copied = 1
if ($hasState -eq 'yes' -and -not $Force) {
  Write-Host 'Server already has .env / ledger: NOT overwriting (use -Force to replace). Restarting apps only.'
  $copied = 0
} else {
  Write-Host "Stopping pm2 apps and copying .env, wallets/agent*, data/ to $remote ..."
  Invoke-Remote "pm2 stop munim-telegram munim-dashboard munim-agent >/dev/null 2>&1 || true; mkdir -p $app/data $app/wallets; [ ! -f $app/.env ] || install -m 600 $app/.env /opt/munim/backups/env.prev" | Out-Null
  Invoke-Native 'scp' ($sshOpts + @('-q', '.env', "${remote}:$app/.env")) | Out-Null
  Invoke-Native 'scp' ($sshOpts + @('-q', '-r', 'wallets/agent', 'wallets/agent-view', 'wallets/agent-identity.txt', "${remote}:$app/wallets/")) | Out-Null
  Invoke-Native 'scp' ($sshOpts + @('-q', '-r', 'data', "${remote}:$app/")) | Out-Null
  # The server keeps its rules in data/rules.json (RULES_FILE) so git pull never conflicts.
  if (-not (Test-Path 'data/rules.json') -and (Test-Path 'apps/munim/rules.json')) {
    Invoke-Native 'scp' ($sshOpts + @('-q', 'apps/munim/rules.json', "${remote}:$app/data/rules.json")) | Out-Null
  }
}

# Same remote finalize step as sync-from-laptop.sh (kept identical; LF endings matter for remote bash).
$remoteScript = @'
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
'@ -replace "`r`n", "`n"

# Sent base64-encoded so no stdin/CRLF quirks of Windows PowerShell can corrupt the script.
$b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($remoteScript))
Invoke-Native 'ssh' ($sshOpts + @($remote, "COPIED=$copied DOMAIN=$Domain APP=$app bash -c 'echo $b64 | base64 -d | bash'")) | Write-Host
Write-Host "Done. Logs: ssh $remote 'pm2 logs munim-agent'   (files in /opt/munim/logs/)"
