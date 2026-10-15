# 离线单文件 exe 构建脚本（docs/OFFLINE-PACKAGING.md §4.C）
# ------------------------------------------------------------------
# 产物：dist/toolbox.exe（内嵌整份静态站点，目标机零依赖）+ SHA-256 清单
# 用法：在仓库根目录执行  powershell -File scripts\build-portable.ps1
# 约束：产品代码零改动；产物不入库（dist/ 已在 .gitignore）；构建脚本入库。
# 注意：本文件包含中文，必须保存为 UTF-8 with BOM（Windows PowerShell 5.1 无 BOM 会按 ANSI 解析）。

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$stage = Join-Path $root "packaging\csharp\web"
$zip = Join-Path $root "packaging\csharp\web.zip"
$source = Join-Path $root "packaging\csharp\Server.cs"
$outDir = Join-Path $root "dist"
$outExe = Join-Path $outDir "toolbox.exe"

Write-Host "[1/4] 复制产品静态树 → $stage"
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Path $stage | Out-Null
Copy-Item (Join-Path $root "index.html") $stage
Copy-Item (Join-Path $root "assets") (Join-Path $stage "assets") -Recurse
Copy-Item (Join-Path $root "tools") (Join-Path $stage "tools") -Recurse

Write-Host "[2/4] 打包为 web.zip"
if (Test-Path $zip) { Remove-Item $zip -Force }
Compress-Archive -Path $stage -DestinationPath $zip -Force

Write-Host "[3/4] csc.exe 编译（Windows 自带，目标 .NET Framework 4.x）"
$csc = Join-Path $env:WINDIR "Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if (-not (Test-Path $csc)) { $csc = Join-Path $env:WINDIR "Microsoft.NET\Framework\v4.0.30319\csc.exe" }
if (-not (Test-Path $csc)) { throw "未找到 csc.exe（Windows 自带编译器），请核查 .NET Framework 安装。" }
foreach ($lib in @("System.IO.Compression.dll", "System.IO.Compression.FileSystem.dll")) {
    if (-not (Test-Path (Join-Path (Split-Path $csc -Parent) $lib))) {
        throw "缺少引用程序集 $lib（需要 .NET Framework 4.5+）。"
    }
}
New-Item -ItemType Directory -Path $outDir -Force | Out-Null
& $csc /nologo /codepage:65001 /target:winexe /optimize+ `
    /out:$outExe `
    "/res:$zip" `
    /r:System.IO.Compression.dll /r:System.IO.Compression.FileSystem.dll `
    $source
if ($LASTEXITCODE -ne 0) { throw "csc 编译失败（退出码 $LASTEXITCODE）。" }

Write-Host "[4/4] 输出 SHA-256 清单"
$hash = (Get-FileHash $outExe -Algorithm SHA256).Hash
$size = "{0:N0} 字节" -f (Get-Item $outExe).Length
Set-Content -Path "$outExe.sha256" -Value "$hash  toolbox.exe" -Encoding ASCII
Write-Host "完成：$outExe（$size）"
Write-Host "SHA-256：$hash"
