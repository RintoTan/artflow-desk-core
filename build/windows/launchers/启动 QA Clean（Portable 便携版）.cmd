@echo off
chcp 65001 >nul
setlocal

rem ============================================================
rem  ArtFlow Desk Core QA —— 便携版（Portable）以 clean 空白场景启动
rem
rem  怎么用：
rem    1. 把本脚本和 ArtFlowDesk-Core-Windows-*-QA-Portable.exe 放在同一个文件夹；
rem    2. 双击本脚本。
rem
rem  不运行本脚本、直接双击便携版 exe，进入的是 seeded（演示数据）场景。
rem  两个场景的数据互不影响；正式版也不受影响。
rem ============================================================

set "SCENARIO=clean"
set "FOUND="

for %%F in ("%~dp0*QA-Portable*.exe") do if not defined FOUND set "FOUND=%%~fF"
if not defined FOUND for %%F in ("%~dp0..\*QA-Portable*.exe") do if not defined FOUND set "FOUND=%%~fF"

if not defined FOUND (
  echo.
  echo [错误] 没有在本文件夹里找到 QA 便携版 exe（文件名里应包含 QA-Portable）。
  echo.
  echo 请把本脚本和 ArtFlowDesk-Core-Windows-v0.1.0-QA-Portable.exe 放在同一个文件夹。
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
