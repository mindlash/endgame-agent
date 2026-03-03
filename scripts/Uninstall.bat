@echo off
echo.
echo  EndGame Agent Uninstall
echo  =======================
echo.
echo  This will remove the EndGame Agent background service.
echo  Your config and keyfile will NOT be deleted.
echo.
set /p confirm=Are you sure? (y/n):
if /i not "%confirm%"=="y" (
    echo  Cancelled.
    pause
    exit /b 0
)
echo.
endgame-agent uninstall
echo.
pause
