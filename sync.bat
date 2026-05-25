@echo off
title Antigravity Sync v3
echo.
echo   Please close both Antigravity and Antigravity IDE before syncing.
echo   Press any key to start...
pause > nul
echo.
node --experimental-sqlite "%~dp0sync.js"
echo.
pause
