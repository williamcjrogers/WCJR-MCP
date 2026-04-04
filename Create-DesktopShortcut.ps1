# Creates a desktop shortcut for WCJR Assistant.
# Run from the repo root after building: .\Create-DesktopShortcut.ps1
# Or pass the path to the exe: .\Create-DesktopShortcut.ps1 -ExePath "C:\Path\To\WCJR-Assistant-0.1.0.exe"

param(
    [string]$ExePath
)

$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

if (-not $ExePath) {
    $version = (Get-Content (Join-Path $scriptDir "package.json") | ConvertFrom-Json).version
    $ExePath = Join-Path $scriptDir "release\WCJR-Assistant-$version.exe"
}

if (-not (Test-Path $ExePath)) {
    Write-Host "Executable not found: $ExePath" -ForegroundColor Red
    Write-Host "Build the app first with: npm run dist:win" -ForegroundColor Yellow
    exit 1
}

$desktop = [Environment]::GetFolderPath("Desktop")
$shortcutPath = Join-Path $desktop "WCJR Assistant.lnk"

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $ExePath
$shortcut.WorkingDirectory = Split-Path $ExePath
$shortcut.Description = "WCJR Assistant - Full operations assistant"
$shortcut.Save()
[System.Runtime.Interopservices.Marshal]::ReleaseComObject($shell) | Out-Null

Write-Host "Desktop shortcut created: $shortcutPath" -ForegroundColor Green
Write-Host "Double-click 'WCJR Assistant' on your desktop to open the app." -ForegroundColor Cyan
