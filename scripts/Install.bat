@echo off
:: EndGame Agent Installer for Windows
::
:: Double-click this file to install. It handles PowerShell execution
:: policy automatically so you don't have to.

echo.
echo  =================================
echo   EndGame Agent Installer
echo  =================================
echo.

:: Check if running as admin (not required, but inform the user)
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo  Note: Running without admin rights. This is fine for most setups.
    echo.
)

:: Run the PowerShell installer with execution policy bypass.
:: -Bypass is per-process only and does not change the system setting.
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "irm https://endgame.cash/install.ps1 | iex"

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
