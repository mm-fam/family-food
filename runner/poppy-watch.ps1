# Poppy cart watcher. Windows Task Scheduler runs this every minute.
# It asks the backend "any cart jobs?" (no Claude, no cost). Only when a job is waiting
# does it start Claude Code to build or check the cart in this computer's Chrome.
# Setup: runner/README.md. Settings: poppy-runner.json next to this script (not in the repo).

$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$repo = Split-Path $here -Parent
$logDir = Join-Path $here 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$log = Join-Path $logDir ((Get-Date -Format 'yyyy-MM-dd') + '.log')
function Log($msg) { Add-Content -Path $log -Value ((Get-Date -Format 'HH:mm:ss') + '  ' + $msg) }

$cfg = Get-Content (Join-Path $here 'poppy-runner.json') -Raw | ConvertFrom-Json
$api = $cfg.apiUrl
$pass = [uri]::EscapeDataString($cfg.pass)

# One Claude run at a time. A lock older than 90 minutes is from a run that died.
$lock = Join-Path $here 'runner.lock'
if (Test-Path $lock) {
  if (((Get-Date) - (Get-Item $lock).LastWriteTime).TotalMinutes -lt 90) {
    # Claude is busy: still check in, so the app doesn't say the computer is asleep mid-run.
    $c = if (Get-Process -Name chrome -ErrorAction SilentlyContinue) { '1' } else { '0' }
    try { Invoke-RestMethod -Uri "$api`?action=cartJobsOpen&chrome=$c&pass=$pass" -TimeoutSec 30 | Out-Null } catch { }
    exit 0
  }
  Remove-Item $lock -Force
  Log 'Removed a stale lock'
}

# Friday rule: from 6 pm Friday, queue one Giant Eagle cart check (the backend skips it if one is open).
$now = Get-Date
$fri = Join-Path $here ('friday-' + $now.ToString('yyyy-MM-dd') + '.done')
if ($now.DayOfWeek -eq 'Friday' -and $now.Hour -ge 18 -and -not (Test-Path $fri)) {
  try {
    Invoke-RestMethod -Uri "$api`?action=cartJob&store=GE&kind=check&by=Cart%20runner&pass=$pass" -TimeoutSec 60 | Out-Null
    New-Item -ItemType File -Path $fri | Out-Null
    Log 'Friday: queued a Giant Eagle cart check'
  } catch { Log ('Friday check failed: ' + $_.Exception.Message) }
}

# Any open jobs? (The call is also the heartbeat the app shows on Carts: "on, Chrome open" or "on, Chrome closed".)
$chromeOpen = if (Get-Process -Name chrome -ErrorAction SilentlyContinue) { '1' } else { '0' }
try {
  $r = Invoke-RestMethod -Uri "$api`?action=cartJobsOpen&chrome=$chromeOpen&pass=$pass" -TimeoutSec 60
} catch { Log ('Backend unreachable: ' + $_.Exception.Message); exit 0 }
if (-not $r.ok) { Log ('Backend said: ' + $r.error); exit 0 }
$jobs = @($r.result.jobs)
$queued = @($jobs | Where-Object { $_.status -eq 'queued' })
$waiting = @($jobs | Where-Object { $_.status -eq 'waiting' })
$stuck = @($jobs | Where-Object { $_.status -eq 'running' -and $_.started_at -and ((Get-Date) - [datetime]$_.started_at).TotalHours -gt 2 })

# Waiting jobs (Chrome was off) are retried every 15 minutes, not every minute.
$retry = Join-Path $here 'last-retry.txt'
$retryDue = $waiting.Count -gt 0 -and (-not (Test-Path $retry) -or ((Get-Date) - (Get-Item $retry).LastWriteTime).TotalMinutes -ge 15)
# Once a day (from 9 am) start Claude even with no jobs, for the daily price pass (runbook §13 step 9).
$priceMark = Join-Path $here ('prices-' + $now.ToString('yyyy-MM-dd') + '.done')
$priceDue = $now.Hour -ge 9 -and -not (Test-Path $priceMark)
# Once a day (from 6 am, as soon as Chrome is open) start Claude for the store sign-in check (runner step 3b, api 42).
$signinMark = Join-Path $here ('signin-' + $now.ToString('yyyy-MM-dd') + '.done')
$signinDue = $now.Hour -ge 6 -and -not (Test-Path $signinMark)
if ($queued.Count -eq 0 -and -not $retryDue -and $stuck.Count -eq 0 -and -not $priceDue -and -not $signinDue) { exit 0 }

# No Chrome open: don't spend a Claude run. Queued jobs wait (the app shows "waiting" after the next try).
if (-not (Get-Process -Name chrome -ErrorAction SilentlyContinue)) {
  if (-not (Test-Path $retry) -or ((Get-Date) - (Get-Item $retry).LastWriteTime).TotalMinutes -ge 15) {
    Log 'Jobs waiting but Chrome is closed'
    Set-Content -Path $retry -Value (Get-Date -Format s)
  }
  exit 0
}

Set-Content -Path $lock -Value $PID
try {
  if ($waiting.Count -gt 0) { Set-Content -Path $retry -Value (Get-Date -Format s) }
  Log ('Starting Claude for ' + (($jobs | ForEach-Object { "$($_.id) $($_.store) $($_.kind) ($($_.status))" }) -join ', '))
  Push-Location $repo
  try { git pull -q 2>&1 | Out-Null } catch { Log 'git pull failed; using the copy on disk' }
  $prompt = (Get-Content (Join-Path $here 'cart-runner-prompt.md') -Raw).Replace('{{SHEET_ID}}', $cfg.sheetId).Replace('{{NOW}}', (Get-Date -Format 'yyyy-MM-ddTHH:mm:ss'))
  $claude = if ($cfg.claudePath) { $cfg.claudePath } else { 'claude' }
  # Bash(date) lets the run read the local clock (Nov 6: a run guessed and wrote UTC times).
  $tools = (@($cfg.allowedTools) + @('Bash(date:*)')) -join ','
  $out = $prompt | & $claude -p --chrome --allowedTools $tools --max-turns 400 2>&1
  Add-Content -Path $log -Value ($out | Out-String)
  Log 'Claude finished'
  if ($priceDue) { New-Item -ItemType File -Force -Path $priceMark | Out-Null }
  if ($signinDue) { New-Item -ItemType File -Force -Path $signinMark | Out-Null }
} catch {
  Log ('Run failed: ' + $_.Exception.Message)
} finally {
  Pop-Location -ErrorAction SilentlyContinue
  Remove-Item $lock -Force -ErrorAction SilentlyContinue
}

# Keep two weeks of logs.
Get-ChildItem $here -Filter *.done | Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-14) } | Remove-Item -Force
Get-ChildItem $logDir -Filter *.log | Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-14) } | Remove-Item -Force
