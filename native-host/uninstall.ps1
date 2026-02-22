# =============================================
# Motrix Native Messaging Host - 卸载脚本
# =============================================

$hostName = "com.nicedoc.motrix"

$chromeRegPath = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$hostName"
$edgeRegPath = "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$hostName"

if (Test-Path $chromeRegPath) {
    Remove-Item -Path $chromeRegPath -Force
    Write-Host "[OK] 已移除 Chrome 注册表项" -ForegroundColor Green
}
if (Test-Path $edgeRegPath) {
    Remove-Item -Path $edgeRegPath -Force
    Write-Host "[OK] 已移除 Edge 注册表项" -ForegroundColor Green
}

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$manifestPath = Join-Path $scriptDir "$hostName.json"
if (Test-Path $manifestPath) {
    Remove-Item -Path $manifestPath -Force
    Write-Host "[OK] 已删除 manifest 文件" -ForegroundColor Green
}

Write-Host ""
Write-Host "卸载完成。" -ForegroundColor Green
Read-Host "按回车键退出"
