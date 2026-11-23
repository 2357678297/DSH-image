@echo off
setlocal
pushd "%~dp0" || exit /b 1
powershell.exe -NoLogo -NoProfile -STA -File "%~dp0tools\update-editor.ps1"
set "code=%ERRORLEVEL%"
popd
if not "%code%"=="0" pause
exit /b %code%
