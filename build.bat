@echo off
setlocal
chcp 65001 >nul
title LogAnalysis Build

rem ============================================================
rem  LogAnalysis - one-click build script
rem  Go backend lives in backend\ ; wails build must run there.
rem  Encoding: UTF-8 (no BOM) + chcp 65001. Keep Chinese ONLY in
rem  echo lines; 'rem' comments must stay ASCII to avoid cmd quirks.
rem  Uncomment the two lines below to route downloads through a
rem  local proxy (default port 7890) in offline environments:
rem  set HTTP_PROXY=http://127.0.0.1:7890
rem  set HTTPS_PROXY=http://127.0.0.1:7890
rem ============================================================

cd /d "%~dp0backend"

echo.
echo  [LogAnalysis] 开始构建 ...
echo.

echo  [1/3] 检查前端依赖 ...
if not exist "..\frontend\node_modules" (
    echo   - 未找到 node_modules，正在安装依赖（首次较慢）...
    call npm install --prefix ..\frontend
    if errorlevel 1 goto :fail
) else (
    echo   - 前端依赖已存在，跳过安装
)

echo.
echo  [2/3] 生成应用图标（favicon.svg 生成 png / ico）...
call npm --prefix ..\frontend run icons
if errorlevel 1 goto :fail

echo.
echo  [3/3] 编译 Windows 应用 ...
call wails build
if errorlevel 1 goto :fail

echo.
echo  ============================================================
echo   构建成功：..\build\bin\loganalysis.exe
echo  ============================================================
echo.
pause
exit /b 0

:fail
echo.
echo  [错误] 构建失败，请查看上方日志。
echo.
pause
exit /b 1