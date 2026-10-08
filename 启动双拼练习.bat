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
rem  为什么有三级回退：
rem    以前只认 Python，而 Python 不是 Windows 自带的 —— 没装就是
rem    「双击没反应」。现在按 Python → Node.js → PowerShell 依次尝试，
rem    三者中任意一个可用即可启动，其中 PowerShell 是系统自带的，
rem    所以**任何一台 Windows 都能跑起来，无需额外安装**。
rem
rem  用法：双击即可。会在后台起一个静态服务并自动打开浏览器。
rem        用完关掉那个最小的服务窗口即可停止。
rem ============================================================

title 双拼练习 - 启动器

set "APPDIR=%~dp0"
rem 去掉结尾反斜杠，避免拼接出双斜杠
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

rem ---------- 2. 挑一个可用的解析器 ----------
set "MODE="
set "PYPATH="

rem 2a. Python 优先。
rem     用 findstr /v 排掉 WindowsApps 下的占位符 —— 那是应用商店的
rem     转发壳，直接调用会弹商店页面而不是真的运行 Python。
rem     这里刻意写成三条**单行**语句而不是一个 for 循环套 if：
rem     cmd 里「for 套 for 套管道 + errorlevel」在括号块内会踩到
rem     延迟展开的坑，单行写法没有这层风险，多两行换来确定性是值得的。
if not defined PYPATH for /f "delims=" %%P in ('where python 2^>nul ^| findstr /i /v "WindowsApps"') do if not defined PYPATH set "PYPATH=%%P"
if not defined PYPATH for /f "delims=" %%P in ('where py 2^>nul ^| findstr /i /v "WindowsApps"') do if not defined PYPATH set "PYPATH=%%P"
if not defined PYPATH for /f "delims=" %%P in ('where python3 2^>nul ^| findstr /i /v "WindowsApps"') do if not defined PYPATH set "PYPATH=%%P"
if defined PYPATH set "MODE=py"

rem 2b. Node.js（仓库自带 _test/serve.mjs，零依赖）
if not defined MODE (
  where node >nul 2>&1
  if not errorlevel 1 if exist "%APPDIR%\_test\serve.mjs" set "MODE=node"
)

rem 2c. PowerShell（Windows 自带，最后的兜底）
if not defined MODE (
  if exist "%APPDIR%\_test\serve.ps1" set "MODE=ps"
)

if not defined MODE (
  echo.
  echo   [错误] 没找到可用的本地服务方式。
  echo.
  echo   理论上不该出现 —— PowerShell 是 Windows 自带的。
  echo   如果 _test\serve.ps1 被删了，请重新获取仓库文件。
  echo.
  echo   临时替代方案：
  echo     用 VS Code 打开本目录，右键 index.html -^> Open with Live Server
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

if "!MODE!"=="py" (
  echo   解析器：  Python ^(!PYPATH!^)
  start "双拼练习 - 服务" /min cmd /c "cd /d "%APPDIR%" && "!PYPATH!" -m http.server !PORT! --bind 127.0.0.1"
)
if "!MODE!"=="node" (
  echo   解析器：  Node.js
  start "双拼练习 - 服务" /min cmd /c "cd /d "%APPDIR%" && node "_test\serve.mjs" !PORT!"
)
if "!MODE!"=="ps" (
  echo   解析器：  PowerShell ^(系统自带^)
  start "双拼练习 - 服务" /min powershell -NoProfile -ExecutionPolicy Bypass -File "%APPDIR%\_test\serve.ps1" -Port !PORT! -Root "%APPDIR%"
)

echo.
echo   提示：稍等片刻会自动打开浏览器。
echo         用完后关闭那个标题为「双拼练习 - 服务」的窗口即可停止。
echo.

rem ---------- 4. 等服务就绪再打开浏览器 ----------
set /a TRIES=0
:waitloop
set /a TRIES+=1
timeout /t 1 /nobreak >nul
netstat -ano | findstr /r /c:"LISTENING" | findstr /c:":!PORT! " >nul 2>&1
if errorlevel 1 (
  if !TRIES! LSS 20 goto waitloop
  echo.
  echo   [警告] 服务似乎没有起来（等了 20 秒）。
  echo         可能被防火墙拦了 —— 首次运行时 Windows 会弹窗询问，
  echo         请选「允许访问」。然后手动访问：
  echo         http://127.0.0.1:!PORT!/index.html
  echo.
  pause
  exit /b 1
)

start "" "http://127.0.0.1:!PORT!/index.html"

echo   已在浏览器中打开。本窗口 5 秒后自动关闭。
timeout /t 5 /nobreak >nul
exit /b 0
