@echo off
:: EndGame Agent Installer for Windows
::
:: Double-click this file to install. It handles PowerShell execution
:: policy automatically so you don't have to.
::
:: Works two ways:
::   1. Downloaded zip — runs the local install.ps1 next to this file
::   2. Standalone — downloads install.ps1 from GitHub

echo.
echo  =================================
echo   EndGame Agent Installer
echo  =================================
echo.

:: Try local install.ps1 first (zip download case)
if exist "%~dp0install.ps1" (
    echo  Found local installer, running...
    echo.
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
) else (
    echo  Downloading installer from GitHub...
    echo.
    powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/mindlash/endgame-agent/main/scripts/install.ps1 | iex"
)

if %errorlevel% neq 0 (
    echo.
    echo  Installation encountered an error. See above for details.
    echo.
    pause
    exit /b 1
)

echo.
echo  Installation complete! You can close this window.
echo  Open a new Command Prompt or PowerShell and type: endgame-agent status
echo.
pause
