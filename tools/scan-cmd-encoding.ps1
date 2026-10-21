# Scan .cmd / .bat files for non-ASCII bytes.
# cmd.exe reads .cmd as GBK: UTF-8 non-ASCII comments (e.g. Chinese) become
# garbage and cmd reports "not recognized as an internal or external command"
# in a popup window on every login / restart.
#
#   pwsh tools/scan-cmd-encoding.ps1
#
# Exit code 0 = clean, 1 = found files that need fixing (keep them ASCII-only).
$dirs = @(
    (Join-Path $env:USERPROFILE '.dsh'),
    (Join-Path $env:USERPROFILE 'Desktop'),
    (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup'),
    (Join-Path $env:PROGRAMDATA 'Microsoft\Windows\Start Menu\Programs\StartUp')
)

$bad = @()
foreach ($dir in $dirs) {
    if (-not (Test-Path -LiteralPath $dir)) { continue }
    Get-ChildItem -LiteralPath $dir -Include '*.cmd', '*.bat' -Recurse -Depth 1 -File -ErrorAction SilentlyContinue |
        ForEach-Object {
            $bytes = [System.IO.File]::ReadAllBytes($_.FullName)
            $nonAscii = 0
            foreach ($b in $bytes) { if ($b -gt 127) { $nonAscii++ } }
            if ($nonAscii -gt 0) {
                $bad += [pscustomobject]@{ File = $_.FullName; NonAsciiBytes = $nonAscii; Size = $bytes.Length }
            }
        }
}

if ($bad.Count -eq 0) {
    Write-Host 'OK: no non-ASCII .cmd/.bat found.'
    exit 0
}

Write-Host 'These .cmd/.bat files contain non-ASCII bytes (cmd.exe will garble them):'
$bad | Format-Table -AutoSize
Write-Host 'Fix: rewrite comments in ASCII, or save the file as UTF-8 with BOM and add "chcp 65001" as the first line.'
exit 1
