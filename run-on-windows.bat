@echo off
REM ===========================================================================
REM  The Big Drone Detector - one-click launcher (run from source)
REM  Double-click this file. On first run it installs dependencies, then it
REM  starts the app every time after that. Requires Node.js (https://nodejs.org).
REM ===========================================================================
cd /d "%~dp0"
title The Big Drone Detector

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  Node.js was not found.
  echo  Please install it from https://nodejs.org/ ^(LTS^), then run this again.
  echo.
  pause
  exit /b 1
)

if not exist node_modules (
  echo Installing dependencies ^(first run only^)...
  call npm install
  if errorlevel 1 (
    echo.
    echo  npm install failed. Check your internet connection and try again.
    pause
    exit /b 1
  )
)

echo Starting The Big Drone Detector...
call npm start
