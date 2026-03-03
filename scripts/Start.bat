@echo off
echo.
echo  Starting EndGame Agent...
echo.
endgame-agent start 2>nul
if %errorlevel% neq 0 (
    echo  Service not installed. Running in foreground instead...
    echo  Press Ctrl+C to stop.
    echo.
    endgame-agent run
)
pause
