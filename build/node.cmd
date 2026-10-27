@echo off
rem Run JavaScript as Node.
rem 1) Use a standalone node.exe when it is on PATH.
rem 2) Otherwise fall back to TRAE's bundled Electron in Node mode (ELECTRON_RUN_AS_NODE).
rem    Set TRAE_EXE if your TRAE executable is not at the default location.
rem Usage: build\node.cmd build\selftest.js
setlocal

where node >nul 2>nul
if %ERRORLEVEL%==0 (
  node %*
  exit /b %ERRORLEVEL%
)

if "%TRAE_EXE%"=="" set "TRAE_EXE=E:\Trae CN\Trae CN.exe"
if not exist "%TRAE_EXE%" (
  echo [node.cmd] Node.js was not found on PATH and TRAE_EXE is not a valid path.
  echo Install Node.js 18+ , or set TRAE_EXE to your TRAE executable, e.g.
  echo   set TRAE_EXE=C:\Program Files\TRAE\TRAE.exe
  exit /b 1
)

set ELECTRON_RUN_AS_NODE=1
"%TRAE_EXE%" %*
exit /b %ERRORLEVEL%