@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

rem ============================================================
rem  双拼练习 — 一键启动
rem
rem  为什么需要这个脚本：
rem    浏览器禁止在 file:// 协议下加载 ES 模块（CORS 限制），
rem    所以不能直接双击 index.html。必须经由本地 HTTP 服务打开。
rem
rem  用法：双击即可。会在后台起一个静态服务并自动打开浏览器。
rem        用完关掉那个最小的服务窗口即可停止。
rem ============================================================

title 双拼练习 - 启动器

set "APPDIR=%~dp0"
rem 去掉结尾反斜杠，避免 Join-Path 之类拼接出双斜杠
if "%APPDIR:~-1%"=="\" set "APPDIR=%APPDIR:~0,-1%"

if not exist "%APPDIR%\index.html" (
  echo.
  echo   [错误] 没找到 index.html
  echo   预期位置：%APPDIR%\index.html
  echo.
  pause
  exit /b 1
)

rem ---------- 1. 找一个空闲端口 ----------
set "PORT=8781"
:findport
for /f "tokens=*" %%L in ('netstat -ano ^| findstr /r /c:"LISTENING" ^| findstr /c:":!PORT! "') do (
  set /a PORT+=1
  if !PORT! GTR 8800 (
    echo   [错误] 8781-8800 端口全被占用，请先关掉占用的程序。
    pause
    exit /b 1
  )
  goto findport
)

rem ---------- 2. 找一个可用的 Python ----------
set "PY="
for %%C in (python py python3) do (
  if not defined PY (
    where %%C >nul 2>&1 && set "PY=%%C"
  )
)

if not defined PY (
  echo.
  echo   [错误] 没找到 Python，无法启动本地服务。
  echo.
  echo   请任选其一：
  echo     1. 安装 Python（python.org）后重试
  echo     2. 用 VS Code 打开本目录，右键 index.html -^> Open with Live Server
  echo.
  pause
  exit /b 1
)

rem ---------- 3. 启动服务 ----------
echo.
echo   ╭──────────────────────────────────────╮
echo   │   双拼练习 · 小鹤方案                │
echo   ╰──────────────────────────────────────╯
echo.
echo   服务地址：http://127.0.0.1:!PORT!/index.html
echo   解析器：  !PY!
echo.
echo   提示：稍等片刻会自动打开浏览器。
echo         用完后关闭那个标题为「双拼练习 - 服务」的窗口即可停止。
echo.

start "双拼练习 - 服务" /min cmd /c "cd /d "%APPDIR%" && !PY! -m http.server !PORT! --bind 127.0.0.1"

rem ---------- 4. 等服务就绪再打开浏览器 ----------
set /a TRIES=0
:waitloop
set /a TRIES+=1
timeout /t 1 /nobreak >nul
netstat -ano | findstr /r /c:"LISTENING" | findstr /c:":!PORT! " >nul 2>&1
if errorlevel 1 (
  if !TRIES! LSS 15 goto waitloop
  echo   [警告] 服务启动较慢，仍尝试打开浏览器……
)

start "" "http://127.0.0.1:!PORT!/index.html"

echo   已在浏览器中打开。本窗口 5 秒后自动关闭。
timeout /t 5 /nobreak >nul
exit /b 0
