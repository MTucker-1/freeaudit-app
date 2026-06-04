@echo off
REM FreeAudit — starts the local web app and opens it in your browser.
title FreeAudit
cd /d "%~dp0"
echo Starting FreeAudit...
start "" "http://freeaudit.com"
"C:\Program Files\nodejs\node.exe" watch-server.js
pause
