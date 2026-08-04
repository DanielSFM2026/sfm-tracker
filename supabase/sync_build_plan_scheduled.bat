@echo off
REM Runs the build plan sync unattended (Task Scheduler) and logs output.
REM No "pause" here on purpose — this must not block waiting for a keypress.
REM %date% format varies by Windows locale, so build the log name from
REM PowerShell's locale-independent date instead of parsing %date%.
set SCRIPT_DIR=%~dp0
for /f %%i in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd"') do set LOGDATE=%%i
set LOG_FILE=%SCRIPT_DIR%sync_logs\sync_%LOGDATE%.log

echo [%date% %time%] Starting sync... >> "%LOG_FILE%"
"C:\Users\daniel\AppData\Local\Programs\Python\Python313\python.exe" "%SCRIPT_DIR%sync_build_plan.py" >> "%LOG_FILE%" 2>&1
echo [%date% %time%] Exit code %ERRORLEVEL% >> "%LOG_FILE%"
echo. >> "%LOG_FILE%"
