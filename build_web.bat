@echo off
setlocal
chcp 65001 >nul
title LogAnalysis Web Build

rem ============================================================
rem  LogAnalysis - build & run web (Cloudflare) bundle
rem  Runs in frontend\ ; emits to frontend\dist via vite --mode web.
rem  Encoding: UTF-8 (no BOM) + chcp 65001. Keep Chinese ONLY in
rem  echo lines; 'rem' comments must stay ASCII to avoid cmd quirks.
rem ============================================================

cd /d "%~dp0frontend"

echo.
echo  [LogAnalysis] Web 构建开始 ...
echo.

echo  [1/3] 检查前端依赖 ...
if not exist "node_modules" (
    echo   - 未找到 node_modules，正在安装依赖（首次较慢）...
    call npm install
    if errorlevel 1 goto :fail
) else (
    echo   - 前端依赖已存在，跳过安装
)

echo.
echo  [2/3] 构建 Web 产物（vite --mode web）...
call npm run build:web
if errorlevel 1 goto :fail

echo.
echo  [3/3] 启动本地静态预览服务 ...
echo   - 若未安装 serve，将尝试用 npx 临时下载
call npx --yes serve dist
if errorlevel 1 goto :fail

echo.
echo  ============================================================
echo   构建成功：frontend\dist
echo   预览地址见上方 serve 输出（默认 http://localhost:3000）
echo  ============================================================
echo.
pause
exit /b 0

:fail
echo.
echo  [错误] Web 构建失败，请查看上方日志。
echo.
pause
exit /b 1
