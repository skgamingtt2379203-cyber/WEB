@echo off
title D4Hz Voice Amplifier Launcher
echo ========================================================
echo   D4Hz WEB - Discord Voice Amplifier ^& VC Chat Suite
echo ========================================================
echo.

if exist "D4Hz.exe" (
    echo Starting D4Hz Standalone Desktop Application...
    start "" "D4Hz.exe"
    exit /b 0
)

echo D4Hz.exe not found in current directory. Starting direct relay...
node relay.js
pause
