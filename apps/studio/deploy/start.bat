@echo off
REM ---------------------------------------------------------------------------------------------
REM   Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
REM   Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
REM ---------------------------------------------------------------------------------------------

REM Launch snoutdata in dev mode (Vite HMR renderer + Electron + the spawned SQL
REM server). Double-click, or run from a terminal: deploy\start.bat

REM The app is built on Node 22, not 24: use the project-local Node 22 whenever it is installed,
REM whatever else is on PATH, and fall back to PATH only when it is not.
set "SNOUT_NODE22=%LOCALAPPDATA%\positron-node\node-v22.22.1-win-x64"
if exist "%SNOUT_NODE22%\node.exe" set "PATH=%SNOUT_NODE22%;%PATH%"
where node >nul 2>nul || goto nonode

REM The Db2 driver hosts ibm_db in a stock-Node sidecar (it cannot load under Electron's ABI).
REM ibm_db's prebuilt binary is keyed to Node 22 (ABI 127), so point the sidecar at the project
REM Node 22, NOT the global Node 24, whose ABI would fail to load it. (Ship will bundle a Node.)
if not defined SNOUTDATA_DB2_NODE set "SNOUTDATA_DB2_NODE=%SNOUT_NODE22%\node.exe"

cd /d "%~dp0.."

REM Electron writes path.txt once its binary is downloaded; without it the dev server stops with
REM "Electron uninstall". Since Electron 42 the npm package no longer downloads the binary at
REM install, only on first use, and electron-vite reads path.txt without ever triggering that use.
REM So: install the dependencies once when they are missing (a fresh clone, an interrupted install,
REM the app folder moved; node_modules is not tracked), then fetch the binary ourselves.
if exist "node_modules\electron\path.txt" goto run
if exist "node_modules\electron\install.js" goto electron
echo The dependencies are not installed in this folder yet. Installing them once with npm ci...
call npm ci
if errorlevel 1 goto installfailed

:electron
echo Downloading the Electron binary once...
call node node_modules\electron\install.js
if errorlevel 1 goto downloadfailed

:run
call npm run dev %*
exit /b %errorlevel%

:installfailed
echo The install failed. If SnoutData is running, quit it from the tray, then run deploy\start.bat again.
exit /b 1

:downloadfailed
echo The Electron download failed. Check the network, then run deploy\start.bat again.
exit /b 1

:nonode
echo Node.js was not found. Install Node 22 and run deploy\start.bat again.
exit /b 1
