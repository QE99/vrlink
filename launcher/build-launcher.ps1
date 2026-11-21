$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$out = Join-Path $root "dist"
New-Item -ItemType Directory -Force -Path $out | Out-Null

$csc = @(
  "C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe",
  "C:\Windows\Microsoft.NET\Framework\v4.0.30319\csc.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $csc) { throw "找不到 .NET Framework 4.x 的 csc.exe" }

$refs = @(
  "System.dll",
  "System.Core.dll",
  "System.Windows.Forms.dll",
  "System.Drawing.dll",
  "System.Management.dll",
  "System.Web.Extensions.dll",
  (Join-Path $root "lib\Microsoft.Web.WebView2.Core.dll"),
  (Join-Path $root "lib\Microsoft.Web.WebView2.WinForms.dll")
)
$args = @("/nologo", "/target:winexe", "/platform:x64", "/optimize+", "/out:$out\VRlink.exe")
foreach ($r in $refs) { $args += "/r:$r" }
$args += (Join-Path $root "VRlink.cs")

& $csc @args
if ($LASTEXITCODE -ne 0) { throw "csc failed: $LASTEXITCODE" }
Copy-Item (Join-Path $root "lib\*.dll") $out -Force
Write-Host "built: $out\VRlink.exe"
