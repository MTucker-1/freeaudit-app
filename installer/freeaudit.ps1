# freeaudit.ps1 — launches an installed copy of FreeAudit (runs locally on this PC).
# 1) self-updates the app code from the update channel (fail-safe),
# 2) starts the local engine hidden (if not already running),
# 3) opens FreeAudit in its own app window — only once the engine ANSWERS.
#
# Interactive launches show a small "Starting FreeAudit..." window while 1 and 2
# run. Opening the app window on a fixed timer was what new users hit: a first
# launch (update download, antivirus scanning ~250 MB of fresh files) easily
# takes longer than the old 10 s wait, and the app window then sat on
# "localhost refused to connect" and never retried. If the engine never comes
# up, the window says so and points at the engine log instead.
#
# -EngineOnly does 1 and 2 with no UI. The Startup shortcut uses it so the engine
# is back after a reboot without a window appearing at every login.
param([switch]$EngineOnly)
$ErrorActionPreference = 'SilentlyContinue'
$dir = Split-Path -Parent $MyInvocation.MyCommand.Definition
Set-Location $dir
$env:PLAYWRIGHT_BROWSERS_PATH = Join-Path $dir 'browsers'
# Port comes from config.json like the server's, so the two can never disagree.
$port = 4477
try { $cp = (Get-Content (Join-Path $dir 'config.json') -Raw | ConvertFrom-Json).webPort; if ($cp) { $port = [int]$cp } } catch { }
$url = "http://localhost:$port/"
$node = Join-Path $dir 'node.exe'
$pidFile = Join-Path $dir 'server.pid'
$logDir = Join-Path $dir 'logs'
$script:engineLog = $null

# Our engine is up when it answers HTTP on loopback. Checking for a listening
# port was not enough: anything else bound to 4477 on another address (a
# Tailscale serve proxy, say) looked like "already running". Any HTTP response
# counts — the login page or a 401 still means the engine is serving.
function Engine-Up {
  try {
    $req = [System.Net.WebRequest]::Create("http://127.0.0.1:$port/")
    $req.Timeout = 1500
    $req.Proxy = $null
    $resp = $req.GetResponse(); $resp.Close(); return $true
  } catch [System.Net.WebException] {
    if ($_.Exception.Response) { $_.Exception.Response.Close(); return $true }
    return $false
  } catch { return $false }
}
function Engine-ProcessAlive {
  if (-not (Test-Path $pidFile)) { return $false }
  $sp = Get-Content $pidFile -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $sp) { return $false }
  $p = Get-Process -Id ([int]$sp) -ErrorAction SilentlyContinue
  return [bool]($p -and $p.ProcessName -eq 'node')
}
function Stop-Server {
  if (Test-Path $pidFile) {
    $sp = Get-Content $pidFile -ErrorAction SilentlyContinue
    if ($sp) { & taskkill /PID $sp /T /F 2>$null | Out-Null }
    Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
  }
}
# Starts the engine with its output captured to logs\ — a crash on someone
# else's PC used to vanish without a trace. Guarded by a mutex so the login
# shortcut and a desktop click at the same moment can't start two engines.
function Start-Server {
  $m = New-Object System.Threading.Mutex($false, 'Local\FreeAuditEngineStart')
  try { [void]$m.WaitOne(15000) } catch { }
  try {
    if ((Engine-Up) -or (Engine-ProcessAlive)) { return }
    New-Item -ItemType Directory -Path $logDir -Force | Out-Null
    Get-ChildItem $logDir -Filter 'engine-*.log' | Sort-Object LastWriteTime -Descending |
      Select-Object -Skip 10 | Remove-Item -Force -ErrorAction SilentlyContinue
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $script:engineLog = Join-Path $logDir "engine-$stamp.log"
    $errLog = Join-Path $logDir "engine-$stamp-errors.log"
    $p = Start-Process -WindowStyle Hidden -FilePath $node -ArgumentList 'watch-server.js' `
      -WorkingDirectory $dir -PassThru -RedirectStandardOutput $script:engineLog -RedirectStandardError $errLog
    if (-not $p) {
      # Redirection can fail on a locked/odd folder; an engine without a log
      # beats no engine.
      $p = Start-Process -WindowStyle Hidden -FilePath $node -ArgumentList 'watch-server.js' -WorkingDirectory $dir -PassThru
    }
    if ($p) { $p.Id | Set-Content $pidFile }
  } finally { try { $m.ReleaseMutex() } catch { } }
}
function Ensure-StartupShortcut {
  # The installer writes this shortcut, but update.ps1 only syncs FILES — so an
  # already-installed copy would never get it. Creating it here means existing
  # installs heal themselves on the next launch instead of waiting for a reinstall.
  $startupLnk = Join-Path ([Environment]::GetFolderPath('Startup')) 'FreeAudit Engine.lnk'
  if (-not (Test-Path $startupLnk) -and (Test-Path (Join-Path $dir 'engine-launcher.vbs'))) {
    try {
      $ws = New-Object -ComObject WScript.Shell
      $sc = $ws.CreateShortcut($startupLnk)
      $sc.TargetPath       = Join-Path $env:SystemRoot 'System32\wscript.exe'
      $sc.Arguments        = '"' + (Join-Path $dir 'engine-launcher.vbs') + '"'
      $sc.WorkingDirectory = $dir
      $sc.IconLocation     = Join-Path $dir 'logo.ico'
      $sc.Description      = 'Starts the FreeAudit engine at login (no window)'
      $sc.Save()
    } catch { }  # a missing startup shortcut must never stop FreeAudit opening
  }
}
function Open-AppWindow {
  # No address bar — looks like a desktop app. Newer Edge installs live under
  # Program Files, not (x86); Chrome can be per-user under LocalAppData.
  $candidates = @(
    (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe'),
    (Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe'),
    (Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe'),
    (Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe')
  )
  $browser = $candidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
  if ($browser) { Start-Process $browser "--app=$url --window-size=1320,880" }
  else { Start-Process $url }
}
function Last-LogLines {
  $files = @()
  if ($script:engineLog) { $files += $script:engineLog; $files += ($script:engineLog -replace '\.log$', '-errors.log') }
  else {
    $files = Get-ChildItem $logDir -Filter 'engine-*.log' -ErrorAction SilentlyContinue |
      Sort-Object LastWriteTime -Descending | Select-Object -First 2 | ForEach-Object { $_.FullName }
  }
  $lines = foreach ($f in $files) {
    try {
      $fs = New-Object System.IO.FileStream($f, 'Open', 'Read', 'ReadWrite')
      $sr = New-Object System.IO.StreamReader($fs); $t = $sr.ReadToEnd(); $sr.Close()
      ($t -split "`r?`n") | Where-Object { $_.Trim() }
    } catch { }
  }
  ($lines | Select-Object -Last 8) -join "`r`n"
}

# ---- Engine-only (Startup shortcut): no UI ----------------------------------
if ($EngineOnly) {
  $updated = & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $dir 'update.ps1') -Dir $dir
  if ($updated -eq 'updated') { Stop-Server }
  if (-not (Engine-Up)) { Start-Server }
  Ensure-StartupShortcut
  return
}

# ---- Interactive launch ------------------------------------------------------
# One splash at a time — a second click while starting just leaves the first.
$uiMutex = New-Object System.Threading.Mutex($false, 'Local\FreeAuditLauncherUI')
if (-not $uiMutex.WaitOne(0)) { return }

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$form = New-Object System.Windows.Forms.Form
$form.Text = 'FreeAudit'
$form.StartPosition = 'CenterScreen'
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false; $form.MinimizeBox = $true
$form.ClientSize = New-Object System.Drawing.Size(460, 150)
$form.TopMost = $true
try { $form.Icon = New-Object System.Drawing.Icon (Join-Path $dir 'logo.ico') } catch { }

$label = New-Object System.Windows.Forms.Label
$label.Location = New-Object System.Drawing.Point(18, 16)
$label.Size = New-Object System.Drawing.Size(424, 70)
$label.Font = New-Object System.Drawing.Font('Segoe UI', 10)
$label.Text = 'Starting FreeAudit...'
$form.Controls.Add($label)

$bar = New-Object System.Windows.Forms.ProgressBar
$bar.Location = New-Object System.Drawing.Point(18, 94)
$bar.Size = New-Object System.Drawing.Size(424, 16)
$bar.Style = 'Marquee'; $bar.MarqueeAnimationSpeed = 30
$form.Controls.Add($bar)

$retry = New-Object System.Windows.Forms.Button
$retry.Text = 'Try again'; $retry.Location = New-Object System.Drawing.Point(18, 112); $retry.Size = New-Object System.Drawing.Size(100, 28)
$retry.Visible = $false
$form.Controls.Add($retry)
$openLogs = New-Object System.Windows.Forms.Button
$openLogs.Text = 'Open log folder'; $openLogs.Location = New-Object System.Drawing.Point(126, 112); $openLogs.Size = New-Object System.Drawing.Size(130, 28)
$openLogs.Visible = $false
$form.Controls.Add($openLogs)

# Steps run from a timer so the window stays responsive: update -> engine -> open.
$script:step = 'update'
$script:stepStarted = Get-Date
$script:updProc = $null
$script:engineStarted = $false
$script:updOut = Join-Path $env:TEMP ('fa-upd-' + [guid]::NewGuid().ToString('N') + '.txt')
$UPDATE_LIMIT_S = 150   # update.ps1's own download timeout is 90 s
$ENGINE_LIMIT_S = 120

function Show-Failure($why) {
  $script:step = 'failed'
  $bar.Visible = $false
  $form.TopMost = $false
  $form.ClientSize = New-Object System.Drawing.Size(560, 290)
  $label.Size = New-Object System.Drawing.Size(524, 200)
  $label.Font = New-Object System.Drawing.Font('Segoe UI', 9)
  $tail = Last-LogLines
  $label.Text = "FreeAudit's engine didn't start ($why).`r`n`r`n" +
    "Try again, or restart the PC. If it keeps happening, send the newest file in the log folder to your FreeAudit admin.`r`n`r`n" +
    $(if ($tail) { "Last engine output:`r`n$tail" } else { 'The engine wrote no output. Antivirus may be blocking node.exe in the FreeAudit folder.' })
  $retry.Location = New-Object System.Drawing.Point(18, 250); $openLogs.Location = New-Object System.Drawing.Point(126, 250)
  $retry.Visible = $true; $openLogs.Visible = $true
}

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 500
$timer.Add_Tick({
  $elapsed = ((Get-Date) - $script:stepStarted).TotalSeconds
  switch ($script:step) {
    'update' {
      if (-not $script:updProc) {
        $label.Text = 'Starting FreeAudit...  checking for updates'
        $script:updProc = Start-Process powershell -WindowStyle Hidden -PassThru -RedirectStandardOutput $script:updOut `
          -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"' + (Join-Path $dir 'update.ps1') + '"'), '-Dir', ('"' + $dir + '"'))
        if (-not $script:updProc) { $script:step = 'engine'; $script:stepStarted = Get-Date }
        return
      }
      if ($script:updProc.HasExited -or $elapsed -gt $UPDATE_LIMIT_S) {
        if (-not $script:updProc.HasExited) { try { $script:updProc.Kill() } catch { } }
        $out = Get-Content $script:updOut -Raw -ErrorAction SilentlyContinue
        Remove-Item $script:updOut -Force -ErrorAction SilentlyContinue
        # New code on disk: restart the engine so it actually runs.
        if ($out -match 'updated') { Stop-Server }
        $script:step = 'engine'; $script:stepStarted = Get-Date
      } elseif ($elapsed -gt 8) {
        $label.Text = "Starting FreeAudit...  downloading the latest version`r`n(first launch can take a minute)"
      }
    }
    'engine' {
      if (Engine-Up) { $script:step = 'open'; return }
      if (-not $script:engineStarted) { $script:engineStarted = $true; Start-Server; Ensure-StartupShortcut; return }
      # The watcher restarts a crashed server, so a dead watcher means it
      # couldn't even get that far — start it once more before giving up.
      if (-not (Engine-ProcessAlive) -and $elapsed -gt 3) { Start-Server }
      $label.Text = 'Starting FreeAudit...  starting the engine' +
        $(if ($elapsed -gt 15) { "`r`n(the first start on a new PC can take a minute while Windows scans the files)" } else { '' })
      if ($elapsed -gt $ENGINE_LIMIT_S) { Show-Failure "no answer after $ENGINE_LIMIT_S seconds" }
    }
    'open' {
      $timer.Stop()
      Open-AppWindow
      $form.Close()
    }
  }
})

$retry.Add_Click({
  $retry.Visible = $false; $openLogs.Visible = $false
  $form.ClientSize = New-Object System.Drawing.Size(460, 150)
  $label.Size = New-Object System.Drawing.Size(424, 70)
  $label.Font = New-Object System.Drawing.Font('Segoe UI', 10)
  $bar.Visible = $true
  Stop-Server
  $script:step = 'engine'; $script:stepStarted = Get-Date
})
$openLogs.Add_Click({
  New-Item -ItemType Directory -Path $logDir -Force | Out-Null
  Start-Process explorer.exe $logDir
})
$form.Add_Shown({ $form.Activate(); $timer.Start() })
[void]$form.ShowDialog()
$timer.Stop()
try { $uiMutex.ReleaseMutex() } catch { }
