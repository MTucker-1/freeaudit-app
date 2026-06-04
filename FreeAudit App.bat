@echo off
title FreeAudit
cd /d "%~dp0"

REM --- Start the FreeAudit engine (back end) only if it isn't already running ---
powershell -NoProfile -Command "if(-not(Get-NetTCPConnection -LocalPort 80 -State Listen -ErrorAction SilentlyContinue)){Start-Process -WindowStyle Minimized -FilePath 'C:\Program Files\nodejs\node.exe' -ArgumentList 'watch-server.js' -WorkingDirectory '%CD%'}"

REM --- Give it a moment to come up ---
powershell -NoProfile -Command "Start-Sleep -Milliseconds 1800"

REM --- Open FreeAudit in its own app window (no address bar, looks like a desktop app) ---
set "EDGE=C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
set "CHROME=C:\Program Files\Google\Chrome\Application\chrome.exe"
if exist "%EDGE%" (
  start "" "%EDGE%" --app=http://localhost/ --window-size=1320,880
) else if exist "%CHROME%" (
  start "" "%CHROME%" --app=http://localhost/ --window-size=1320,880
) else (
  start "" "http://localhost/"
)
exit
