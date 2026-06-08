@echo off
title Antigravity Sync 2.2
echo.
echo ==========================================
echo       Antigravity Sync Engine 2.2
echo ==========================================
echo.
echo   Please close both Antigravity and Antigravity IDE before syncing.
echo   Press any key to start...
pause > nul
echo.
node --experimental-sqlite "%~dp0sync.js"
echo.
echo   Press any key to exit...
pause > nul
