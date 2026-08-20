<#
.SYNOPSIS
    打包 BetterGI Web Cloud Bridge Chrome 扩展为 zip，排除 demo/ 等无关内容。

.DESCRIPTION
    将扩展源码（manifest.json + src/）打包为
    better-genshin-impact-web-control.zip，自动排除：
      - demo/             （Node 测试台，非扩展发布内容）
      - script/           （打包脚本自身）
      - .git/             （版本控制元数据）
      - *.code-workspace  （编辑器工作区文件）
      - README.md / CONTRIBUTING.md（可选，默认排除文档，见 -IncludeDocs）

.PARAMETER OutputDir
    输出目录，默认为仓库根目录下的 dist/。

.PARAMETER IncludeDocs
    若指定，则将 README.md / CONTRIBUTING.md 一并打包（默认排除）。

.EXAMPLE
    pwsh ./script/package-extension.ps1
    pwsh ./script/package-extension.ps1 -IncludeDocs -OutputDir ./out
#>
[CmdletBinding()]
param(
    [string]$OutputDir = "",
    [switch]$IncludeDocs
)

$ErrorActionPreference = 'Stop'

# 仓库根目录：本脚本位于 <root>/script/package-extension.ps1
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$RepoRoot  = Split-Path -Parent $ScriptDir

if (-not (Test-Path (Join-Path $RepoRoot 'manifest.json'))) {
    throw "未在预期位置找到 manifest.json，请确认脚本位于 <root>/script/ 下。"
}

# 输出目录
if ([string]::IsNullOrWhiteSpace($OutputDir)) {
    $OutputDir = Join-Path $RepoRoot 'dist'
}
if (-not (Test-Path $OutputDir)) {
    New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null
}

$ZipName = 'better-genshin-impact-web-control.zip'
$ZipPath = Join-Path $OutputDir $ZipName

# 需要排除的项（相对仓库根目录）
$ExcludeDirs = @('demo', 'script', '.git')
$ExcludeFiles = @('*.code-workspace')
if (-not $IncludeDocs) {
    $ExcludeFiles += @('README.md', 'CONTRIBUTING.md')
}

# 收集需要打包的顶层条目
$ItemsToPack = @()
foreach ($item in Get-ChildItem -Path $RepoRoot) {
    $name = $item.Name
    $skip = $false
    if ($item.PSIsContainer) {
        foreach ($d in $ExcludeDirs) { if ($name -eq $d) { $skip = $true; break } }
    } else {
        foreach ($f in $ExcludeFiles) {
            if ($name -like $f) { $skip = $true; break }
        }
    }
    if (-not $skip) { $ItemsToPack += $item.FullName }
}

if ($ItemsToPack.Count -eq 0) {
    throw "没有可打包的内容，请检查仓库结构。"
}

# 重新生成 zip（避免追加旧内容）
if (Test-Path $ZipPath) { Remove-Item $ZipPath -Force }

# 为排除子目录中的嵌套项，先打包顶层条目，再对 demo/ 等做二次过滤
$tmpRoot = Join-Path $env:TEMP ("bgi-web-bridge-pack-" + [guid]::NewGuid().ToString('N'))
try {
    New-Item -ItemType Directory -Path $tmpRoot -Force | Out-Null

    foreach ($src in $ItemsToPack) {
        $leaf = Split-Path -Leaf $src
        $dest = Join-Path $tmpRoot $leaf
        if ((Get-Item $src) -is [System.IO.DirectoryInfo]) {
            # 目录：拷贝后用 Compress-Archive 对整目录打包时无法排除子项，
            # 因此对已知需排除的顶层目录（已是 src 等）整体拷贝即可。
            Copy-Item -Path $src -Destination $dest -Recurse -Force
        } else {
            Copy-Item -Path $src -Destination $dest -Force
        }
    }

    Compress-Archive -Path (Join-Path $tmpRoot '*') -DestinationPath $ZipPath -Force
    Write-Host "已打包扩展 -> $ZipPath"
    Write-Host ("包含条目数: " + (Get-ChildItem -Path $tmpRoot | Measure-Object).Count)
    Write-Host "已排除: demo/, script/, .git/, *.code-workspace" + $(if (-not $IncludeDocs) { ", README.md, CONTRIBUTING.md" } else { " (含文档)" })
}
finally {
    if (Test-Path $tmpRoot) { Remove-Item -Path $tmpRoot -Recurse -Force -ErrorAction SilentlyContinue }
}
