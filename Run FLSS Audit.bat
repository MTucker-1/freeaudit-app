@echo off
REM FLSS Ready-to-Invoice Auditor — double-click launcher
title FLSS Audit
cd /d "%~dp0"

echo ============================================
echo   FLSS Ready-to-Invoice Auditor
echo ============================================
echo.
echo A Chrome window will open. If it shows a Fullbay
echo login, sign in once and the audit continues on its own.
echo.

"C:\Program Files\nodejs\node.exe" audit.js

echo.
echo Opening the report...
start "" "audit-report.html"
echo.
echo Done. You can close this window.
pause
