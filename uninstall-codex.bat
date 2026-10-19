@echo off
setlocal
cd /d "%~dp0"
"%~dp0runtime\node.exe" "%~dp0scripts\patch-codex-zh-cn.mjs" uninstall
if errorlevel 1 pause
exit /b %errorlevel%
