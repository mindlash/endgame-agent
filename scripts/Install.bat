@echo off
:: EndGame Agent Installer for Windows
::
:: Right-click this file -> "Run as administrator"
::
:: This runs the local install.ps1 from the same folder.
:: No internet needed except to install Node.js (if you don't have it).

echo.
echo  =================================
echo   EndGame Agent Installer
echo  =================================
echo.

:: Check admin
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo  ERROR: Please right-click Install.bat and select "Run as administrator"
    echo.
    pause
    exit /b 1
)

:: Find install.ps1 next to this .bat
if not exist "%~dp0install.ps1" (
    echo  ERROR: install.ps1 not found next to Install.bat
    echo  Make sure you extracted the full zip file.
    echo.
    pause
    exit /b 1
)

echo  Running installer...
echo.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"

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
