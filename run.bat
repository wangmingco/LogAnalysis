@echo off
setlocal
chcp 65001 >nul
title LogAnalysis Run

rem ============================================================
rem  LogAnalysis - run script
rem  Runs the compiled binary; if missing, prompts to build first.
rem ============================================================

cd /d "%~dp0"

set "EXE=build\bin\loganalysis.exe"

if not exist "%EXE%" (
    echo.
    echo  [提示] 未找到编译产物 build\bin\loganalysis.exe
    echo         请先运行 build.bat 构建，或运行 dev.bat 进入开发模式。
    echo.
    pause
    exit /b 1
)

echo.
echo  [LogAnalysis] 正在启动 ...
echo.
start "" "%EXE%"
exit /b 0