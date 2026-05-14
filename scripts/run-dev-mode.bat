@echo off
REM ===========================================================
REM Sales Claw — dev mode launcher (no reinstall on UI tweaks)
REM
REM This batch sets two env vars and launches the installed
REM Sales Claw. While these env vars are set, the installed
REM Electron loads the dashboard from C:\bp-outreach\src
REM (your local working tree) instead of the bundled
REM resources/app/src, AND each browser refresh re-reads
REM ./ui/* from disk. So you can edit anything under
REM src/ui/client-scripts/*.cjs and just reload the browser
REM (Ctrl+R) to see the change — no installer cycle.
REM
REM Production users should NOT use this launcher; double-click
REM the normal Sales Claw shortcut to keep the bundled UI.
REM ===========================================================

set "SALES_CLAW_DEV_DASHBOARD_SRC=C:\bp-outreach\src"
set "SALES_CLAW_DEV_HOT_RELOAD=1"

set "EXE_PROGRAMFILES=%ProgramFiles%\Sales Claw\Sales Claw.exe"
set "EXE_PERUSER=%LOCALAPPDATA%\Programs\Sales Claw\Sales Claw.exe"

if exist "%EXE_PROGRAMFILES%" (
  echo [dev] launching %EXE_PROGRAMFILES%
  echo [dev]   SALES_CLAW_DEV_DASHBOARD_SRC=%SALES_CLAW_DEV_DASHBOARD_SRC%
  echo [dev]   SALES_CLAW_DEV_HOT_RELOAD=%SALES_CLAW_DEV_HOT_RELOAD%
  start "" "%EXE_PROGRAMFILES%"
) else if exist "%EXE_PERUSER%" (
  echo [dev] launching %EXE_PERUSER%
  echo [dev]   SALES_CLAW_DEV_DASHBOARD_SRC=%SALES_CLAW_DEV_DASHBOARD_SRC%
  echo [dev]   SALES_CLAW_DEV_HOT_RELOAD=%SALES_CLAW_DEV_HOT_RELOAD%
  start "" "%EXE_PERUSER%"
) else (
  echo [dev] Sales Claw is not installed.
  echo [dev]   Looked at:
  echo [dev]     %EXE_PROGRAMFILES%
  echo [dev]     %EXE_PERUSER%
  pause
  exit /b 1
)
