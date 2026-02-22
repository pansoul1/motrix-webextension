# =============================================
# Motrix Native Messaging Host - Install Script
# =============================================

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  Motrix Native Messaging Host Installer" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# Check Node.js
try {
    $nodeVersion = & node --version 2>&1
    Write-Host "[OK] Node.js found: $nodeVersion" -ForegroundColor Green
} catch {
    Write-Host "[ERROR] Node.js not found. Please install from https://nodejs.org/" -ForegroundColor Red
    Read-Host "Press Enter to exit"
    exit 1
}

# Get extension ID
Write-Host ""
Write-Host "Open your browser extensions page to find the extension ID:" -ForegroundColor Yellow
Write-Host "  Chrome:  chrome://extensions/" -ForegroundColor Gray
Write-Host "  Edge:    edge://extensions/" -ForegroundColor Gray
Write-Host "  Enable Developer Mode to see the extension ID" -ForegroundColor Gray
Write-Host ""
$extensionId = Read-Host "Enter extension ID"

if (-not $extensionId -or $extensionId.Length -lt 10) {
    Write-Host "[ERROR] Invalid extension ID" -ForegroundColor Red
    Read-Host "Press Enter to exit"
    exit 1
}

# Choose browser
Write-Host ""
Write-Host "Select browser:" -ForegroundColor Yellow
Write-Host "  1. Google Chrome" -ForegroundColor Gray
Write-Host "  2. Microsoft Edge" -ForegroundColor Gray
Write-Host "  3. Both (default)" -ForegroundColor Gray
$browserChoice = Read-Host "Enter choice (1/2/3)"
if (-not $browserChoice) { $browserChoice = "3" }

$hostName = "com.nicedoc.motrix"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$batPath = Join-Path $scriptDir "motrix_host.bat"
$manifestPath = Join-Path $scriptDir "$hostName.json"

# Generate native messaging host manifest
$manifest = @{
    name = $hostName
    description = "Motrix Download Manager Native Messaging Host"
    path = $batPath
    type = "stdio"
    allowed_origins = @("chrome-extension://$extensionId/")
} | ConvertTo-Json -Depth 3

Set-Content -Path $manifestPath -Value $manifest -Encoding UTF8
Write-Host ""
Write-Host "[OK] Manifest created: $manifestPath" -ForegroundColor Green

# Registry paths
$chromeRegPath = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$hostName"
$edgeRegPath = "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$hostName"

function Register-Host($regPath, $browserName) {
    $parent = Split-Path $regPath
    if (-not (Test-Path $parent)) {
        New-Item -Path $parent -Force | Out-Null
    }
    if (-not (Test-Path $regPath)) {
        New-Item -Path $regPath -Force | Out-Null
    }
    Set-ItemProperty -Path $regPath -Name "(Default)" -Value $manifestPath
    Write-Host "[OK] Registered $browserName Native Messaging Host" -ForegroundColor Green
}

if ($browserChoice -eq "1" -or $browserChoice -eq "3") {
    Register-Host $chromeRegPath "Chrome"
}
if ($browserChoice -eq "2" -or $browserChoice -eq "3") {
    Register-Host $edgeRegPath "Edge"
}

Write-Host ""
Write-Host "========================================" -ForegroundColor Green
Write-Host "  Done! Please restart your browser." -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Green
Write-Host ""
Read-Host "Press Enter to exit"
