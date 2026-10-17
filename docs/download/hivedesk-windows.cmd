@echo off
rem hivedesk launcher for Windows. It checks for Node.js 20 or newer, then runs
rem the latest hivedesk with npx. It installs nothing else by itself.
rem Source: https://github.com/kwy404/hivedesk (MIT)
setlocal
title hivedesk
set "NODE_URL=https://nodejs.org/en/download"

where node >nul 2>nul
if errorlevel 1 goto nonode
where npx >nul 2>nul
if errorlevel 1 goto nonode

set "MAJOR="
for /f "delims=" %%v in ('node -p "process.versions.node.split('.')[0]"') do set "MAJOR=%%v"
if not defined MAJOR goto nonode
if %MAJOR% LSS 20 goto oldnode

for /f "delims=" %%v in ('node -v') do echo Node.js %%v found. Starting hivedesk...
call npx --yes hivedesk@latest %*
if errorlevel 1 (
  echo.
  echo hivedesk stopped with an error. Run "npx hivedesk --doctor" to check your setup.
  pause
)
exit /b

:oldnode
echo.
echo hivedesk needs Node.js 20 or newer: it runs the crew and the local server.
for /f "delims=" %%v in ('node -v') do echo This computer has Node.js %%v, which is too old.
goto opennode

:nonode
echo.
echo hivedesk needs Node.js 20 or newer: it runs the crew and the local server.
echo Node.js was not found on this computer.

:opennode
echo Opening the official download page: %NODE_URL%
echo Install Node.js (the LTS version is fine), then run this launcher again.
start "" "%NODE_URL%"
echo.
pause
exit /b 1
