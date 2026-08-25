@echo off
setlocal
chcp 65001 >nul
title LogAlacrity Dev

rem ============================================================
rem  LogAlacrity - dev mode (hot reload)
rem  Go backend lives in backend\ ; wails dev must run there.
rem  Uncomment the two lines below to route downloads through a
rem  local proxy (default port 7890) in offline environments:
rem  set HTTP_PROXY=http://127.0.0.1:7890
rem  set HTTPS_PROXY=http://127.0.0.1:7890
rem ============================================================

cd /d "%~dp0backend"

echo.
echo  [LogAlacrity] 进入开发模式（Ctrl+C 退出）...
echo.
call wails dev