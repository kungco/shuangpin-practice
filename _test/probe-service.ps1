param([int]$Port = 8781, [string]$Root = (Split-Path $PSScriptRoot -Parent))

# Only reuse a service serving the current checkout's index.html.
try {
    $request = [System.Net.HttpWebRequest]::Create("http://127.0.0.1:$Port/index.html")
    $request.Proxy = $null
    $request.Timeout = 2000
    $request.ReadWriteTimeout = 2000
    $response = $request.GetResponse()
    try {
        $buffer = New-Object System.IO.MemoryStream
        try {
            $response.GetResponseStream().CopyTo($buffer)
            $actual = $buffer.ToArray()
        } finally { $buffer.Dispose() }
    } finally { $response.Dispose() }
    $expected = [System.IO.File]::ReadAllBytes((Join-Path $Root 'index.html'))
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $a = [Convert]::ToBase64String($sha.ComputeHash($actual))
        $b = [Convert]::ToBase64String($sha.ComputeHash($expected))
    } finally { $sha.Dispose() }
    if ($a -eq $b) { exit 0 }
} catch { }
exit 1
