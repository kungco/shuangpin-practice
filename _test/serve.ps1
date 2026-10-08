# ============================================================
#  双拼练习 — 便携静态服务器（PowerShell 版）
# ------------------------------------------------------------
#  为什么需要这个文件：
#    启动脚本以前只认 Python（python -m http.server）。但 Python 不是
#    Windows 自带的，很多人没装 —— 于是「双击启动」直接失败。
#    PowerShell 则是每台 Windows 都有的，用它起一个等价的静态服务，
#    就能做到「零额外安装」。
#
#  为什么要有这个文件而不是在 .bat 里内联：
#    HttpListener 的用法太长，塞进 .bat 的转义地狱里没法维护。
#    独立成 .ps1 也便于单独测语法。
#
#  编码要求（重要）：
#    本文件必须是 **UTF-8 with BOM + CRLF**。
#    PowerShell 5.1 在没有 BOM 时会按 ANSI（本机即 GBK）解码，
#    下面这些中文注释会被解成乱码，而乱码字节里可能出现 0x0A/0x22，
#    把行结构和字符串引号一起吃掉 —— 报错却指向完全不相干的行，
#    极难排查。用 git 时靠 .gitattributes 里的 working-tree-encoding 保住。
#
#  用法：
#    powershell -NoProfile -ExecutionPolicy Bypass -File serve.ps1 -Port 8781 -Root "D:\path\to\repo"
# ============================================================

param(
  [int]$Port = 8781,
  [string]$Root = (Split-Path -Parent $PSScriptRoot),
  # -SelfTest：只跑路径解析与穿越防护的断言，不起监听、不占端口。
  # 给「验证这个脚本本身还能用」的场景，不参与正常启动流程。
  [switch]$SelfTest
)

$ErrorActionPreference = 'Stop'

# ---- 把根目录规范成绝对路径 + 结尾分隔符 ----
# 结尾分隔符不能少：否则 "C:\repo-other" 会被误判为在 "C:\repo" 之内
$RootFull = [System.IO.Path]::GetFullPath($Root)
if (-not $RootFull.EndsWith([System.IO.Path]::DirectorySeparatorChar)) {
  $RootFull += [System.IO.Path]::DirectorySeparatorChar
}

# ---- MIME 表。默认 application/octet-stream，浏览器会下载而不是渲染 ----
$mime = @{
  '.html' = 'text/html; charset=utf-8'
  '.htm'  = 'text/html; charset=utf-8'
  '.js'   = 'text/javascript; charset=utf-8'
  '.mjs'  = 'text/javascript; charset=utf-8'
  '.css'  = 'text/css; charset=utf-8'
  '.json' = 'application/json; charset=utf-8'
  '.svg'  = 'image/svg+xml'
  '.png'  = 'image/png'
  '.jpg'  = 'image/jpeg'
  '.jpeg' = 'image/jpeg'
  '.gif'  = 'image/gif'
  '.ico'  = 'image/x-icon'
  '.woff' = 'font/woff'
  '.woff2' = 'font/woff2'
  '.txt'  = 'text/plain; charset=utf-8'
  '.map'  = 'application/json; charset=utf-8'
}

# ============================================================
#  纯函数区：路径解析与安全检查
# ------------------------------------------------------------
#  刻意从请求处理里拆出来单独成函数，原因有两条：
#    1. 这两个是**安全相关**的逻辑（目录穿越防护），必须能单独验证；
#    2. 拆开之后 -SelfTest 才能在不起监听、不真正收请求的情况下跑通它们。
#  处理请求的 Send-OneRequest 直接调用这两个函数，不存在两套实现。
# ============================================================

function Resolve-RelPath {
  <#
    把 HTTP 请求里的路径解析成本机绝对路径。
    只做「URL 解码 + 补默认页 + 拼到根目录」，**不做**安全判断 ——
    安全判断交给 Test-InsideRoot，职责分开才好各自验证。
  #>
  param(
    [string]$RelativePath,
    [string]$RootPath
  )
  $rel = [System.Uri]::UnescapeDataString($RelativePath)
  if ($rel -eq '/' -or $rel.EndsWith('/')) { $rel += 'index.html' }
  $rel = $rel.TrimStart('/') -replace '/', [System.IO.Path]::DirectorySeparatorChar
  return [System.IO.Path]::GetFullPath([System.IO.Path]::Combine($RootPath, $rel))
}

function Test-InsideRoot {
  <#
    判断规范化后的完整路径是否落在根目录内。
    必须比对完整路径而不是「请求里有没有 ..」—— URL 编码（%2e%2e）、
    大小写、混合斜杠都能绕过字符串检查，但绕不过真的规范化一遍。
  #>
  param(
    [string]$FullPath,
    [string]$RootPath
  )
  return $FullPath.StartsWith($RootPath, [System.StringComparison]::OrdinalIgnoreCase)
}

# ---- 自检：不起服务、不占端口，只验路径解析与穿越防护 ----
if ($SelfTest) {
  Write-Host "serve.ps1 自检（Root=$RootFull）"
  $failed = 0
  function Check {
    param([string]$Label, [bool]$Cond)
    if ($Cond) { Write-Host "  ✓ $Label" }
    else { Write-Host "  x $Label"; $script:failed++ }
  }

  # 正常路径必须放行
  foreach ($p in @('/', '/index.html', '/src/ui/a11y.js', '/assets/style.css')) {
    $full = Resolve-RelPath -RelativePath $p -RootPath $RootFull
    Check "放行 $p" (Test-InsideRoot -FullPath $full -RootPath $RootFull)
  }

  # 穿越尝试必须全部拦下（含 URL 编码变体）
  foreach ($p in @('/../secret.txt', '/../../Windows/win.ini',
                   '/..%2f..%2fWindows/win.ini', '/%2e%2e/%2e%2e/Windows/win.ini',
                   '/src/../../../etc/passwd')) {
    $full = Resolve-RelPath -RelativePath $p -RootPath $RootFull
    Check "拦截 $p" (-not (Test-InsideRoot -FullPath $full -RootPath $RootFull))
  }

  # 前缀相似的兄弟目录不能被误判为「根内」
  $sibling = [System.IO.Path]::GetFullPath($RootFull.TrimEnd('\') + '-other\x.txt')
  Check "拦截相似前缀目录" (-not (Test-InsideRoot -FullPath $sibling -RootPath $RootFull))

  # 根目录请求要落到 index.html
  $rootPath = Resolve-RelPath -RelativePath '/' -RootPath $RootFull
  Check "根路径补 index.html" ($rootPath.EndsWith('index.html'))

  # MIME 表覆盖应用真正用到的资源类型
  foreach ($ext in @('.html', '.js', '.css', '.mjs', '.svg', '.png', '.woff2')) {
    Check "MIME 覆盖 $ext" ($null -ne $mime[$ext])
  }

  if ($failed -eq 0) { Write-Host "自检通过"; exit 0 }
  Write-Host "自检失败 $failed 项"; exit 1
}

$listener = New-Object System.Net.HttpListener
# 只绑 127.0.0.1：练习数据都在浏览器本地，没有对外暴露的理由
$listener.Prefixes.Add("http://127.0.0.1:$Port/")

try {
  $listener.Start()
} catch {
  Write-Host ""
  Write-Host "  [错误] 无法监听 127.0.0.1:$Port" -ForegroundColor Red
  Write-Host "         $($_.Exception.Message)"
  Write-Host "         可能端口被占用，或需要管理员权限。"
  Write-Host ""
  exit 1
}

Write-Host "  双拼练习服务已启动"
Write-Host "  地址：http://127.0.0.1:$Port/index.html"
Write-Host "  目录：$RootFull"
Write-Host "  按 Ctrl+C 或直接关闭本窗口即可停止。"
Write-Host ""

# ---- 单请求处理抽成函数 ----
# 关键：PowerShell 5.1 **不允许在 try 块里用 continue**（这是个很反直觉的
# 语法限制，只报「意外的标记」，看不出是 continue 的问题）。
# 把每个请求的处理收进独立函数，用 return 提前退出，就绕开了这个坑。
function Send-OneRequest {
  param([System.Net.HttpListenerContext]$Ctx)

  $req = $Ctx.Request
  $res = $Ctx.Response

  # 只支持 GET / HEAD。这是个静态文件服务，其它方法没有意义。
  if ($req.HttpMethod -ne 'GET' -and $req.HttpMethod -ne 'HEAD') {
    $res.StatusCode = 405
    $res.Headers.Add('Allow', 'GET, HEAD')
    $res.Close()
    return
  }

  # ---- 解析路径 ----
  $full = Resolve-RelPath -RelativePath $req.Url.AbsolutePath -RootPath $RootFull

  # ---- 目录穿越防护 ----
  if (-not (Test-InsideRoot -FullPath $full -RootPath $RootFull)) {
    $res.StatusCode = 403
    $res.Close()
    return
  }

  if (-not (Test-Path -LiteralPath $full -PathType Leaf)) {
    $res.StatusCode = 404
    $res.Close()
    return
  }

  $ext = [System.IO.Path]::GetExtension($full).ToLowerInvariant()
  $type = $mime[$ext]
  if (-not $type) { $type = 'application/octet-stream' }

  try {
    $bytes = [System.IO.File]::ReadAllBytes($full)
  } catch {
    $res.StatusCode = 500
    $res.Close()
    return
  }

  $res.StatusCode = 200
  $res.ContentType = $type
  $res.ContentLength64 = $bytes.Length
  # 练习时改了代码要立刻看到效果，绝不能被缓存挡住
  $res.Headers.Add('Cache-Control', 'no-store')
  $res.Headers.Add('X-Content-Type-Options', 'nosniff')

  if ($req.HttpMethod -eq 'GET' -and $bytes.Length -gt 0) {
    $res.OutputStream.Write($bytes, 0, $bytes.Length)
  }
  $res.Close()
}

try {
  while ($listener.IsListening) {
    $ctx = $listener.GetContext()
    try {
      Send-OneRequest -Ctx $ctx
    } catch {
      # 单个请求出错不能让整个服务挂掉
      try { $ctx.Response.StatusCode = 500; $ctx.Response.Close() } catch { }
    }
  }
} finally {
  $listener.Stop()
  $listener.Close()
}
