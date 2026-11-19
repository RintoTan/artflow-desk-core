@echo off
chcp 65001 >nul
setlocal

rem ============================================================
rem  ArtFlow Desk Core QA — 以 clean（空白数据）场景启动
rem
rem  作用和双击 QA 图标有什么区别：
rem    双击图标        -> 进入 seeded（预置演示数据）场景
rem    运行这个脚本    -> 进入 clean（空白）场景，数据单独存放
rem
rem  两个场景的数据互不影响，正式版（ArtFlow Desk Core）也不受影响。
rem ============================================================

set "SCENARIO=clean"
set "FOUND="

rem 依次尝试 NSIS 的常见安装位置（按用户安装 / 按机器安装）
for %%P in (
  "%LOCALAPPDATA%\ArtFlow Desk Core QA\artflow-minidesk.exe"
  "%LOCALAPPDATA%\ArtFlow Desk Core QA\ArtFlow Desk Core QA.exe"
  "%LOCALAPPDATA%\Programs\ArtFlow Desk Core QA\artflow-minidesk.exe"
  "%LOCALAPPDATA%\Programs\ArtFlow Desk Core QA\ArtFlow Desk Core QA.exe"
  "%ProgramFiles%\ArtFlow Desk Core QA\artflow-minidesk.exe"
  "%ProgramFiles%\ArtFlow Desk Core QA\ArtFlow Desk Core QA.exe"
) do (
  if exist %%P if not defined FOUND set "FOUND=%%~P"
)

if not defined FOUND (
  echo.
  echo [错误] 没有找到 ArtFlow Desk Core QA 的安装位置。
  echo.
  echo 请先安装 QA 版，或把本脚本里的路径改成实际的安装目录。
  echo 常见位置：%%LOCALAPPDATA%%\ArtFlow Desk Core QA
  echo.
  pause
  exit /b 1
)

echo 启动：%FOUND%
echo 场景：clean（空白数据，与 seeded 场景隔离）
echo.

set "AF_MINIDESK_QA_SCENARIO=%SCENARIO%"
start "" "%FOUND%"

rem 变量只对本次启动有效，不写入系统环境变量
endlocal
