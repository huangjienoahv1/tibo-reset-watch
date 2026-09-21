@echo off
setlocal
title Tibo Reset Watch - Deploy to 208

where pwsh.exe >nul 2>nul
if errorlevel 1 (
    echo [ERROR] PowerShell 7 ^(pwsh.exe^) was not found in PATH.
    echo.
    pause
    exit /b 1
)

echo Starting deployment to server 208...
echo.
pwsh.exe -NoLogo -NoProfile -File "%~dp0scripts\deploy-208.ps1" %*
set "DEPLOY_EXIT_CODE=%ERRORLEVEL%"

echo.
if "%DEPLOY_EXIT_CODE%"=="0" (
    echo [SUCCESS] Deployment script completed.
) else (
    echo [ERROR] Deployment script exited with code %DEPLOY_EXIT_CODE%.
    echo Keep the error messages above for troubleshooting.
)

echo.
pause
exit /b %DEPLOY_EXIT_CODE%
