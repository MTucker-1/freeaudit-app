@echo off
REM Runs FreeAudit from SOURCE on this machine (developer launcher).
REM Teammates don't use this — they install FreeAudit-Setup.exe (see TEAM-INSTALL.md).
title FreeAudit (dev)
cd /d "%~dp0"

REM watch-server.js restarts the app automatically when server.js changes.
node watch-server.js
pause
