@echo off
setlocal
rem 控制台本身不需要管理员权限；仅服务安装/启停由 WSL root 边界执行。
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0console.ps1" %*
if errorlevel 1 exit /b 1
