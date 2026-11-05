@echo off
setlocal
rem 一键入口只负责请求 UAC；系统功能、WSL 重启仍由安装器逐项明确确认。
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath 'powershell.exe' -Verb RunAs -Wait -ArgumentList '-NoProfile -ExecutionPolicy Bypass -NoExit -File ""%~dp0install.ps1""'"
if errorlevel 1 (
  echo 无法请求管理员授权，安装未执行。
  exit /b 1
)
