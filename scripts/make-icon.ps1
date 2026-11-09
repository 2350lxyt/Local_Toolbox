# 生成应用图标 packaging\icon\toolbox.ico（docs/OFFLINE-PACKAGING.md §4.C）
# ------------------------------------------------------------------
# 图形与站点 favicon 同源（index.html 的内联 SVG）：#c2410c 圆角方块 + 白色「三线汇入 → 箭头输出」线性图。
# 一次生成、结果入库 —— 构建脚本只引用，不在每次构建时重画（图标不该随构建漂移）。
# 用法：在仓库根目录执行  powershell -File scripts\make-icon.ps1
# 注意：本文件含中文，必须保存为 UTF-8 with BOM（Windows PowerShell 5.1 无 BOM 会按 ANSI 解析）。

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$outDir = Join-Path $root "packaging\icon"
$outIco = Join-Path $outDir "toolbox.ico"

# 覆盖 Windows 全部常用缩放（100% / 125% / 150% / 200% / 大图标 / 超大图标）
$sizes = @(16, 20, 24, 32, 40, 48, 64, 128, 256)

$background = [System.Drawing.ColorTranslator]::FromHtml("#c2410c")
$foreground = [System.Drawing.Color]::White

# 与 SVG 一致：viewBox 32x32，内层 translate(6 6) scale(.8333)
$origin = 6.0
$scale = 0.8333

function New-RoundedPath([single]$size, [single]$radius) {
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $d = $radius * 2
    $path.AddArc(0, 0, $d, $d, 180, 90)
    $path.AddArc($size - $d, 0, $d, $d, 270, 90)
    $path.AddArc($size - $d, $size - $d, $d, $d, 0, 90)
    $path.AddArc(0, $size - $d, $d, $d, 90, 90)
    $path.CloseFigure()
    return $path
}

function Get-IconPngBytes([int]$px) {
    $bitmap = New-Object System.Drawing.Bitmap($px, $px, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $graphics.Clear([System.Drawing.Color]::Transparent)
    $graphics.ScaleTransform($px / 32.0, $px / 32.0)   # 之后一律按 32 单位坐标画

    # 底板：圆角方块
    $plate = New-RoundedPath 32 7
    $brush = New-Object System.Drawing.SolidBrush($background)
    $graphics.FillPath($brush, $plate)

    # 线条：小尺寸需补偿，否则 16px 下不到 1px、抗锯齿会把白线摊成半透明
    # 56/px 换算 = 32 单位坐标系下的笔宽，使物理线宽 ≈ 1.5px（>=32px 时仍取设计值 2）
    $penWidth = [single][Math]::Max(2.0, 56.0 / $px)
    $pen = New-Object System.Drawing.Pen($foreground, $penWidth)
    $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
    $pen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round

    $x = { param($v) [single]($origin + $scale * $v) }
    $y = { param($v) [single]($origin + $scale * $v) }

    # 三条输入线
    foreach ($row in @(6, 12, 18)) {
        $graphics.DrawLine($pen, (& $x 3), (& $y $row), (& $x 9), (& $y $row))
    }
    # 上、下两条汇入曲线
    $upper = New-Object System.Drawing.Drawing2D.GraphicsPath
    $upper.AddBezier((& $x 10), (& $y 6), (& $x 13.5), (& $y 6), (& $x 13.5), (& $y 12), (& $x 17), (& $y 12))
    $graphics.DrawPath($pen, $upper)
    $lower = New-Object System.Drawing.Drawing2D.GraphicsPath
    $lower.AddBezier((& $x 10), (& $y 18), (& $x 13.5), (& $y 18), (& $x 13.5), (& $y 12), (& $x 17), (& $y 12))
    $graphics.DrawPath($pen, $lower)
    # 输出线 + 箭头
    $graphics.DrawLine($pen, (& $x 17), (& $y 12), (& $x 21), (& $y 12))
    $graphics.DrawLines($pen, [System.Drawing.PointF[]]@(
        (New-Object System.Drawing.PointF((& $x 18.5), (& $y 9.5))),
        (New-Object System.Drawing.PointF((& $x 21), (& $y 12))),
        (New-Object System.Drawing.PointF((& $x 18.5), (& $y 14.5)))
    ))

    $stream = New-Object System.IO.MemoryStream
    $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
    $bytes = $stream.ToArray()

    $stream.Dispose()
    $pen.Dispose()
    $brush.Dispose()
    $plate.Dispose()
    $upper.Dispose()
    $lower.Dispose()
    $graphics.Dispose()
    $bitmap.Dispose()
    return $bytes
}

New-Item -ItemType Directory -Path $outDir -Force | Out-Null

Write-Host "[1/2] 栅格化 $($sizes.Count) 个尺寸"
$frames = @()
foreach ($px in $sizes) {
    $frames += , @{ Size = $px; Data = (Get-IconPngBytes $px) }
    Write-Host ("      {0}x{0}  {1:N0} 字节" -f $px, $frames[-1].Data.Length)
}

Write-Host "[2/2] 写入 ICO 容器（PNG 内嵌，Vista+ 原生支持）"
$offset = 6 + 16 * $frames.Count
$file = [System.IO.File]::Create($outIco)
$writer = New-Object System.IO.BinaryWriter($file)
$writer.Write([UInt16]0)                     # reserved
$writer.Write([UInt16]1)                     # type: icon
$writer.Write([UInt16]$frames.Count)
foreach ($frame in $frames) {
    $dimension = if ($frame.Size -ge 256) { 0 } else { $frame.Size }   # 0 表示 256
    $writer.Write([byte]$dimension)
    $writer.Write([byte]$dimension)
    $writer.Write([byte]0)                   # 调色板颜色数（真彩为 0）
    $writer.Write([byte]0)                   # reserved
    $writer.Write([UInt16]1)                 # color planes
    $writer.Write([UInt16]32)                # bits per pixel
    $writer.Write([UInt32]$frame.Data.Length)
    $writer.Write([UInt32]$offset)
    $offset += $frame.Data.Length
}
foreach ($frame in $frames) {
    $data = [byte[]]$frame.Data
    $writer.Write($data, 0, $data.Length)   # 显式三参重载：单参 Write 在 PS 5.1 下会选错重载
}
$writer.Flush()
$writer.Dispose()
$file.Dispose()

$size = "{0:N0} 字节" -f (Get-Item $outIco).Length
Write-Host "完成：$outIco（$size）"
