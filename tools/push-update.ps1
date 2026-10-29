# 一次「更新包」：把当前所有改动提交并推到 GitHub。
#
#   pwsh tools/push-update.ps1 "feat: 视频参数按比例/分辨率分开"
#
# 不带参数时用时间戳做提交信息（也能跑，但建议写清楚改了什么）。
# 本机 git 配了 http://127.0.0.1:7897 代理；代理没开时 push 会连不上，
# 所以这里失败会先尝试绕过代理直连，仍失败就明确报错（不再假报「已推送」）。
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
if ($LASTEXITCODE -ne 0) {
    Write-Host "提交失败（git commit exit $LASTEXITCODE）"
    exit 1
}

$sha = (git rev-parse --short HEAD)

git push 2>&1 | Out-Host
if ($LASTEXITCODE -ne 0) {
    Write-Host "代理推送失败，尝试绕过代理直连…"
    git -c http.proxy= -c https.proxy= push 2>&1 | Out-Host
}

if ($LASTEXITCODE -ne 0) {
    Write-Host "⚠ 推送失败：本地提交 $sha 已创建，但没到远端。检查网络后运行：git -c http.proxy= -c https.proxy= push origin main"
    exit 1
}

Write-Host "已推送更新包：$Message（$sha）"
