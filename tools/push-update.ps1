# 一次「更新包」：把当前所有改动提交并推到 GitHub。
#
#   pwsh tools/push-update.ps1 "feat: 视频参数按比例/分辨率分开"
#
# 不带参数时用时间戳做提交信息（也能跑，但建议写清楚改了什么）。
param(
    [string]$Message = ""
)

$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath (Split-Path -Parent $PSScriptRoot)

if (-not $Message) {
    $Message = "chore: update " + (Get-Date -Format "yyyy-MM-dd HH:mm")
}

git add -A
$staged = (git diff --cached --name-only | Measure-Object).Count
if ($staged -eq 0) {
    Write-Host "没有改动，跳过提交。"
    exit 0
}

git commit -m $Message
git push
Write-Host "已推送更新包：$Message"
